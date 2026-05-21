import * as flatbuffers from 'flatbuffers';
import type { LineString } from 'geojson';
import type { ColumnMeta } from './column-meta.js';
import { magicbytes, SIZE_PREFIX_LEN } from './constants.js';
import { ColumnType } from './flat-geobuf/column-type.js';
import type {
    AdjacencyList,
    AdjacencyListInput,
    Edge,
    EdgeInput,
    EdgeProperties,
    GraphHeaderMeta,
} from './graph-types.js';
import type { HeaderMeta } from './header-meta.js';
import { calcTreeSize, DEFAULT_NODE_SIZE, NODE_ITEM_BYTE_LEN, type Rect } from './packedrtree.js';
import { buildPackedRTree, envelopeOf, hilbertPermutation, type IndexItem } from './packedrtree-writer.js';

const GRAPH_INDEX_FLAG_ADJACENCY = 0x01;
const GRAPH_INDEX_FLAG_EDGE_RTREE = 0x02;

/**
 * Locate the byte offset at which the graph section starts inside `bytes`.
 *
 * Strategy:
 * 1. If the file has a vertex R-tree (`indexNodeSize > 0`) we read **one
 *    leaf** at the end of the tree to learn the byte offset of the last
 *    feature, then one size-prefix to learn its length. That is a couple
 *    of fixed-size reads regardless of how many features the file
 *    contains — O(1). Files written by this library always store features
 *    in Hilbert order matching the R-tree leaf order, so the last leaf
 *    does describe the physical last feature.
 * 2. Otherwise, fall back to walking each feature's 4-byte size prefix
 *    (no feature payload is read, so still cheap but O(N)).
 *
 * Critically, this function never reads the feature payloads themselves.
 */
export function findGraphSectionStart(bytes: Uint8Array, header: HeaderMeta): number {
    const bb = new flatbuffers.ByteBuffer(bytes);
    const headerLength = bb.readUint32(magicbytes.length);
    let offset = magicbytes.length + SIZE_PREFIX_LEN + headerLength;

    if (header.featuresCount === 0) return offset;

    if (header.indexNodeSize > 0) {
        const treeSize = calcTreeSize(header.featuresCount, header.indexNodeSize);
        const treeStart = offset;
        const featuresStart = treeStart + treeSize;
        if (featuresStart >= bytes.length) return bytes.length;

        const totalNodes = treeSize / NODE_ITEM_BYTE_LEN;
        const lastLeafPos = treeStart + (totalNodes - 1) * NODE_ITEM_BYTE_LEN;
        if (lastLeafPos + NODE_ITEM_BYTE_LEN > bytes.length) return bytes.length;

        const leafView = new DataView(bytes.buffer, bytes.byteOffset + lastLeafPos + 32);
        const lastFeatureRelOffset = Number(leafView.getBigUint64(0, true));
        const lastFeatureAbsPos = featuresStart + lastFeatureRelOffset;
        if (lastFeatureAbsPos + SIZE_PREFIX_LEN > bytes.length) return bytes.length;

        const lastFeatureSize = new DataView(bytes.buffer, bytes.byteOffset + lastFeatureAbsPos).getUint32(
            0,
            true,
        );
        return lastFeatureAbsPos + SIZE_PREFIX_LEN + lastFeatureSize;
    }

    let read = 0;
    while (read < header.featuresCount && offset < bytes.length) {
        const featureLength = bb.readUint32(offset);
        offset += SIZE_PREFIX_LEN + featureLength;
        read++;
    }
    return offset;
}

export interface BuildGraphSectionOptions {
    writeAdjacencyIndex?: boolean;
    writeEdgeIndex?: boolean;
    /** Vertex bounding boxes, indexed by feature index. Required when
     * `writeEdgeIndex` is true so edges with null geometry can still be
     * placed in the R-tree using their endpoints' positions. */
    vertexBboxes?: Rect[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function valueToColumnType(value: unknown): ColumnType {
    if (typeof value === 'boolean') return ColumnType.Bool;
    if (typeof value === 'number') return ColumnType.Double;
    if (typeof value === 'string') return ColumnType.String;
    if (value === null) return ColumnType.String;
    if (value instanceof Uint8Array) return ColumnType.Binary;
    if (typeof value === 'object') return ColumnType.Json;
    throw new Error(`Unknown property type: ${typeof value}`);
}

function introspectEdgeColumns(edges: EdgeInput[]): ColumnMeta[] | null {
    const firstEdgeWithProps = edges.find((e) => e.properties && Object.keys(e.properties).length > 0);
    if (!firstEdgeWithProps?.properties) return null;

    return Object.keys(firstEdgeWithProps.properties).map((name) => ({
        name,
        type: valueToColumnType(firstEdgeWithProps.properties![name]),
        title: null,
        description: null,
        width: -1,
        precision: -1,
        scale: -1,
        nullable: true,
        unique: false,
        primary_key: false,
    }));
}

function buildGraphHeader(edgeCount: number, edgeColumns: ColumnMeta[] | null, indexFlags: number): Uint8Array {
    const columnCount = edgeColumns?.length ?? 0;
    let size = 4 + 2 + 1; // edgeCount + columnCount + indexFlags

    const columnBuffers: Uint8Array[] = [];
    if (edgeColumns) {
        for (const col of edgeColumns) {
            const nameBytes = textEncoder.encode(col.name);
            const colSize = 2 + nameBytes.length + 1;
            const colBuffer = new Uint8Array(colSize);
            const view = new DataView(colBuffer.buffer);
            view.setUint16(0, nameBytes.length, true);
            colBuffer.set(nameBytes, 2);
            colBuffer[2 + nameBytes.length] = col.type;
            columnBuffers.push(colBuffer);
            size += colSize;
        }
    }

    const result = new Uint8Array(size);
    const view = new DataView(result.buffer);
    let offset = 0;

    view.setUint32(offset, edgeCount, true);
    offset += 4;

    view.setUint16(offset, columnCount, true);
    offset += 2;

    for (const colBuffer of columnBuffers) {
        result.set(colBuffer, offset);
        offset += colBuffer.length;
    }

    result[offset] = indexFlags & 0xff;
    return result;
}

function encodeEdgeProperties(properties: EdgeProperties | undefined, columns: ColumnMeta[] | null): Uint8Array {
    if (!columns || columns.length === 0 || !properties) {
        return new Uint8Array(0);
    }

    let offset = 0;
    let capacity = 256;
    let bytes = new Uint8Array(capacity);
    let view = new DataView(bytes.buffer);

    const prep = (size: number) => {
        if (offset + size < capacity) return;
        capacity = Math.max(capacity + size, capacity * 2);
        const newBytes = new Uint8Array(capacity);
        newBytes.set(bytes);
        bytes = newBytes;
        view = new DataView(bytes.buffer);
    };

    for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const value = properties[column.name];
        if (value === null || value === undefined) continue;

        prep(2);
        view.setUint16(offset, i, true);
        offset += 2;

        switch (column.type) {
            case ColumnType.Bool:
                prep(1);
                view.setUint8(offset, value ? 1 : 0);
                offset += 1;
                break;
            case ColumnType.Short:
                prep(2);
                view.setInt16(offset, value as number, true);
                offset += 2;
                break;
            case ColumnType.UShort:
                prep(2);
                view.setUint16(offset, value as number, true);
                offset += 2;
                break;
            case ColumnType.Int:
                prep(4);
                view.setInt32(offset, value as number, true);
                offset += 4;
                break;
            case ColumnType.UInt:
                prep(4);
                view.setUint32(offset, value as number, true);
                offset += 4;
                break;
            case ColumnType.Long:
                prep(8);
                view.setBigInt64(offset, BigInt(value as number), true);
                offset += 8;
                break;
            case ColumnType.Float:
                prep(4);
                view.setFloat32(offset, value as number, true);
                offset += 4;
                break;
            case ColumnType.Double:
                prep(8);
                view.setFloat64(offset, value as number, true);
                offset += 8;
                break;
            case ColumnType.DateTime:
            case ColumnType.String: {
                const str = textEncoder.encode(value as string);
                prep(4 + str.length);
                view.setUint32(offset, str.length, true);
                offset += 4;
                bytes.set(str, offset);
                offset += str.length;
                break;
            }
            case ColumnType.Json: {
                const str = textEncoder.encode(JSON.stringify(value));
                prep(4 + str.length);
                view.setUint32(offset, str.length, true);
                offset += 4;
                bytes.set(str, offset);
                offset += str.length;
                break;
            }
            case ColumnType.Binary: {
                const blob = value as Uint8Array;
                prep(4 + blob.length);
                view.setUint32(offset, blob.length, true);
                offset += 4;
                bytes.set(blob, offset);
                offset += blob.length;
                break;
            }
            default:
                throw new Error(`Unknown column type: ${column.type}`);
        }
    }

    return bytes.slice(0, offset);
}

function validateEdgeGeometry(geometry: LineString | null | undefined): LineString | null {
    if (!geometry) return null;
    if (geometry.type !== 'LineString') {
        throw new Error(`Edge geometry must be LineString, got: ${(geometry as { type: string }).type}`);
    }
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
        throw new Error('Edge LineString must have at least 2 coordinates');
    }
    return geometry;
}

function encodeEdgeGeometry(geometry: LineString | null): Uint8Array {
    if (!geometry) {
        const buf = new Uint8Array(4);
        return buf;
    }
    const coords = geometry.coordinates;
    const pointCount = coords.length;
    const buf = new Uint8Array(4 + pointCount * 16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, pointCount, true);
    let offset = 4;
    for (let i = 0; i < pointCount; i++) {
        const c = coords[i];
        view.setFloat64(offset, c[0], true);
        offset += 8;
        view.setFloat64(offset, c[1], true);
        offset += 8;
    }
    return buf;
}

function buildEdgeRecord(edge: EdgeInput, columns: ColumnMeta[] | null, featureCount: number): Uint8Array {
    if (edge.from < 0 || edge.from >= featureCount) {
        throw new Error(`Invalid 'from' index: ${edge.from}. Must be between 0 and ${featureCount - 1}`);
    }
    if (edge.to < 0 || edge.to >= featureCount) {
        throw new Error(`Invalid 'to' index: ${edge.to}. Must be between 0 and ${featureCount - 1}`);
    }
    if (edge.from === edge.to) {
        throw new Error(`Self-loops are not allowed: from=${edge.from}, to=${edge.to}`);
    }

    const geometry = validateEdgeGeometry(edge.geometry);
    const geomBytes = encodeEdgeGeometry(geometry);
    const propsBytes = encodeEdgeProperties(edge.properties, columns);
    const size = 8 + geomBytes.length + propsBytes.length;
    const result = new Uint8Array(SIZE_PREFIX_LEN + size);
    const view = new DataView(result.buffer);

    view.setUint32(0, size, true);
    view.setUint32(4, edge.from, true);
    view.setUint32(8, edge.to, true);
    result.set(geomBytes, 12);
    result.set(propsBytes, 12 + geomBytes.length);

    return result;
}

function edgeBbox(edge: EdgeInput, vertexBboxes: Rect[] | undefined): Rect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    if (edge.geometry && edge.geometry.coordinates.length > 0) {
        for (const c of edge.geometry.coordinates) {
            if (c[0] < minX) minX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] > maxY) maxY = c[1];
        }
    }
    if (vertexBboxes) {
        const fb = vertexBboxes[edge.from];
        const tb = vertexBboxes[edge.to];
        if (fb.minX < minX) minX = fb.minX;
        if (fb.minY < minY) minY = fb.minY;
        if (fb.maxX > maxX) maxX = fb.maxX;
        if (fb.maxY > maxY) maxY = fb.maxY;
        if (tb.minX < minX) minX = tb.minX;
        if (tb.minY < minY) minY = tb.minY;
        if (tb.maxX > maxX) maxX = tb.maxX;
        if (tb.maxY > maxY) maxY = tb.maxY;
    }

    if (!Number.isFinite(minX)) {
        throw new Error(
            'Cannot compute edge bbox: edge has no geometry and vertex bboxes were not provided. ' +
                'Pass `vertexBboxes` when enabling writeEdgeIndex.',
        );
    }
    return { minX, minY, maxX, maxY };
}

function buildAdjacencyBlock(
    sortedEdges: EdgeInput[],
    edgeLengths: number[],
    featureCount: number,
): Uint8Array {
    const numOffsets = featureCount + 1;
    const blockBytes = 4 * numOffsets;
    const buf = new Uint8Array(SIZE_PREFIX_LEN + blockBytes);
    const view = new DataView(buf.buffer);
    view.setUint32(0, blockBytes, true);

    // Cumulative sum: offsets[v] = byte offset of v's first outgoing edge
    // in the edges section; offsets[N] = total edges length.
    const offsets = new Uint32Array(numOffsets);
    let cursor = 0;
    let edgeIdx = 0;
    for (let v = 0; v < featureCount; v++) {
        offsets[v] = cursor;
        while (edgeIdx < sortedEdges.length && sortedEdges[edgeIdx].from === v) {
            cursor += edgeLengths[edgeIdx];
            edgeIdx++;
        }
    }
    offsets[featureCount] = cursor;

    for (let v = 0; v <= featureCount; v++) {
        view.setUint32(SIZE_PREFIX_LEN + v * 4, offsets[v], true);
    }
    return buf;
}

function buildEdgeRTreeBlock(
    edges: EdgeInput[],
    edgeByteOffsets: number[],
    vertexBboxes: Rect[] | undefined,
): Uint8Array {
    const bboxes = edges.map((e) => edgeBbox(e, vertexBboxes));
    const envelope = envelopeOf(bboxes);
    const perm = hilbertPermutation(bboxes, envelope);
    const items: IndexItem[] = perm.map((oldIdx) => ({
        ...bboxes[oldIdx],
        offset: edgeByteOffsets[oldIdx],
    }));
    const rtreeBytes = buildPackedRTree(items, DEFAULT_NODE_SIZE);

    const buf = new Uint8Array(SIZE_PREFIX_LEN + rtreeBytes.length);
    new DataView(buf.buffer).setUint32(0, rtreeBytes.length, true);
    buf.set(rtreeBytes, SIZE_PREFIX_LEN);
    return buf;
}

export function buildGraphSection(
    adjacencyList: AdjacencyListInput,
    featureCount: number,
    options: BuildGraphSectionOptions = {},
): Uint8Array {
    const writeAdj = !!options.writeAdjacencyIndex;
    const writeRTree = !!options.writeEdgeIndex;

    // When the adjacency index is requested, edges MUST be physically
    // ordered by `from` so the CSR offsets describe contiguous spans.
    // Array.prototype.sort is stable in modern JS engines.
    const orderedEdges = writeAdj ? [...adjacencyList.edges].sort((a, b) => a.from - b.from) : adjacencyList.edges;

    const edgeColumns = introspectEdgeColumns(orderedEdges);

    const edgeBuffers = orderedEdges.map((edge) => buildEdgeRecord(edge, edgeColumns, featureCount));
    const edgeLengths = edgeBuffers.map((b) => b.length);
    const edgesLength = edgeLengths.reduce((sum, l) => sum + l, 0);

    let cursor = 0;
    const edgeByteOffsets: number[] = new Array(orderedEdges.length);
    for (let i = 0; i < orderedEdges.length; i++) {
        edgeByteOffsets[i] = cursor;
        cursor += edgeLengths[i];
    }

    let indexFlags = 0;
    let adjBlock: Uint8Array | null = null;
    if (writeAdj) {
        indexFlags |= GRAPH_INDEX_FLAG_ADJACENCY;
        adjBlock = buildAdjacencyBlock(orderedEdges, edgeLengths, featureCount);
    }
    let rtreeBlock: Uint8Array | null = null;
    if (writeRTree && orderedEdges.length > 0) {
        indexFlags |= GRAPH_INDEX_FLAG_EDGE_RTREE;
        rtreeBlock = buildEdgeRTreeBlock(orderedEdges, edgeByteOffsets, options.vertexBboxes);
    }

    const graphHeader = buildGraphHeader(orderedEdges.length, edgeColumns, indexFlags);

    const totalLength =
        SIZE_PREFIX_LEN +
        graphHeader.length +
        (adjBlock?.length ?? 0) +
        (rtreeBlock?.length ?? 0) +
        edgesLength;
    const result = new Uint8Array(totalLength);
    let offset = 0;

    new DataView(result.buffer).setUint32(offset, graphHeader.length, true);
    offset += SIZE_PREFIX_LEN;

    result.set(graphHeader, offset);
    offset += graphHeader.length;

    if (adjBlock) {
        result.set(adjBlock, offset);
        offset += adjBlock.length;
    }
    if (rtreeBlock) {
        result.set(rtreeBlock, offset);
        offset += rtreeBlock.length;
    }

    for (const edgeBuffer of edgeBuffers) {
        result.set(edgeBuffer, offset);
        offset += edgeBuffer.length;
    }

    return result;
}

function parseGraphHeader(bytes: Uint8Array, offset: number): GraphHeaderMeta {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    let pos = 0;

    const edgeCount = view.getUint32(pos, true);
    pos += 4;

    const columnCount = view.getUint16(pos, true);
    pos += 2;

    const edgeColumns: ColumnMeta[] = [];
    for (let i = 0; i < columnCount; i++) {
        const nameLen = view.getUint16(pos, true);
        pos += 2;

        const nameBytes = bytes.subarray(offset + pos, offset + pos + nameLen);
        const name = textDecoder.decode(nameBytes);
        pos += nameLen;

        const type = bytes[offset + pos] as ColumnType;
        pos += 1;

        edgeColumns.push({
            name,
            type,
            title: null,
            description: null,
            width: -1,
            precision: -1,
            scale: -1,
            nullable: true,
            unique: false,
            primary_key: false,
        });
    }

    const indexFlags = bytes[offset + pos];

    return {
        edgeCount,
        edgeColumns: edgeColumns.length > 0 ? edgeColumns : null,
        hasAdjacencyIndex: (indexFlags & GRAPH_INDEX_FLAG_ADJACENCY) !== 0,
        hasEdgeIndex: (indexFlags & GRAPH_INDEX_FLAG_EDGE_RTREE) !== 0,
    };
}

function parseEdgeProperties(bytes: Uint8Array, columns: ColumnMeta[] | null): EdgeProperties {
    const properties: EdgeProperties = {};
    if (!columns || columns.length === 0 || bytes.length === 0) return properties;

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    let offset = 0;

    while (offset < bytes.length) {
        const colIndex = view.getUint16(offset, true);
        offset += 2;

        if (colIndex >= columns.length) break;
        const column = columns[colIndex];

        switch (column.type) {
            case ColumnType.Bool:
                properties[column.name] = view.getUint8(offset) !== 0;
                offset += 1;
                break;
            case ColumnType.Byte:
                properties[column.name] = view.getInt8(offset);
                offset += 1;
                break;
            case ColumnType.UByte:
                properties[column.name] = view.getUint8(offset);
                offset += 1;
                break;
            case ColumnType.Short:
                properties[column.name] = view.getInt16(offset, true);
                offset += 2;
                break;
            case ColumnType.UShort:
                properties[column.name] = view.getUint16(offset, true);
                offset += 2;
                break;
            case ColumnType.Int:
                properties[column.name] = view.getInt32(offset, true);
                offset += 4;
                break;
            case ColumnType.UInt:
                properties[column.name] = view.getUint32(offset, true);
                offset += 4;
                break;
            case ColumnType.Long:
                properties[column.name] = Number(view.getBigInt64(offset, true));
                offset += 8;
                break;
            case ColumnType.ULong:
                properties[column.name] = Number(view.getBigUint64(offset, true));
                offset += 8;
                break;
            case ColumnType.Float:
                properties[column.name] = view.getFloat32(offset, true);
                offset += 4;
                break;
            case ColumnType.Double:
                properties[column.name] = view.getFloat64(offset, true);
                offset += 8;
                break;
            case ColumnType.DateTime:
            case ColumnType.String: {
                const len = view.getUint32(offset, true);
                offset += 4;
                properties[column.name] = textDecoder.decode(bytes.subarray(offset, offset + len));
                offset += len;
                break;
            }
            case ColumnType.Json: {
                const len = view.getUint32(offset, true);
                offset += 4;
                const str = textDecoder.decode(bytes.subarray(offset, offset + len));
                properties[column.name] = JSON.parse(str);
                offset += len;
                break;
            }
            case ColumnType.Binary: {
                const len = view.getUint32(offset, true);
                offset += 4;
                properties[column.name] = bytes.slice(offset, offset + len);
                offset += len;
                break;
            }
            default:
                throw new Error(`Unknown column type: ${column.type}`);
        }
    }

    return properties;
}

function parseEdgeGeometry(bytes: Uint8Array, offset: number): { geometry: LineString | null; consumed: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const pointCount = view.getUint32(0, true);
    if (pointCount === 0) {
        return { geometry: null, consumed: 4 };
    }
    const coordinates: number[][] = new Array(pointCount);
    let pos = 4;
    for (let i = 0; i < pointCount; i++) {
        const x = view.getFloat64(pos, true);
        pos += 8;
        const y = view.getFloat64(pos, true);
        pos += 8;
        coordinates[i] = [x, y];
    }
    return {
        geometry: { type: 'LineString', coordinates },
        consumed: pos,
    };
}

function parseEdge(bytes: Uint8Array, offset: number, size: number, columns: ColumnMeta[] | null): Edge {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);

    const from = view.getUint32(0, true);
    const to = view.getUint32(4, true);

    const { geometry, consumed } = parseEdgeGeometry(bytes, offset + 8);
    const propsStart = 8 + consumed;

    let properties: EdgeProperties = {};
    if (columns && columns.length > 0 && size > propsStart) {
        const propsBytes = bytes.subarray(offset + propsStart, offset + size);
        properties = parseEdgeProperties(propsBytes, columns);
    }

    return { from, to, geometry, properties };
}

/**
 * Layout of the graph section, expressed in absolute byte offsets within
 * the FGG file. Useful for random access (CSR adjacency, edge R-tree).
 */
export interface GraphSectionLayout {
    header: GraphHeaderMeta;
    adjacencyOffsetsStart: number | null;
    adjacencyOffsetsBytes: number;
    edgeRTreeStart: number | null;
    edgeRTreeBytes: number;
    edgesStart: number;
}

export function parseGraphSectionLayout(bytes: Uint8Array, offset: number): GraphSectionLayout {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const headerSize = view.getUint32(0, true);
    const header = parseGraphHeader(bytes, offset + SIZE_PREFIX_LEN);
    let cursor = offset + SIZE_PREFIX_LEN + headerSize;

    let adjacencyOffsetsStart: number | null = null;
    let adjacencyOffsetsBytes = 0;
    if (header.hasAdjacencyIndex) {
        const blockSize = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint32(0, true);
        adjacencyOffsetsStart = cursor + SIZE_PREFIX_LEN;
        adjacencyOffsetsBytes = blockSize;
        cursor += SIZE_PREFIX_LEN + blockSize;
    }

    let edgeRTreeStart: number | null = null;
    let edgeRTreeBytes = 0;
    if (header.hasEdgeIndex) {
        const blockSize = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint32(0, true);
        edgeRTreeStart = cursor + SIZE_PREFIX_LEN;
        edgeRTreeBytes = blockSize;
        cursor += SIZE_PREFIX_LEN + blockSize;
    }

    return {
        header,
        adjacencyOffsetsStart,
        adjacencyOffsetsBytes,
        edgeRTreeStart,
        edgeRTreeBytes,
        edgesStart: cursor,
    };
}

export function parseGraphSection(bytes: Uint8Array, offset: number): AdjacencyList {
    const layout = parseGraphSectionLayout(bytes, offset);
    const { edgeCount, edgeColumns } = layout.header;

    let cursor = layout.edgesStart;
    const edges: Edge[] = new Array(edgeCount);
    for (let i = 0; i < edgeCount; i++) {
        const edgeSize = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint32(0, true);
        edges[i] = parseEdge(bytes, cursor + SIZE_PREFIX_LEN, edgeSize, edgeColumns);
        cursor += SIZE_PREFIX_LEN + edgeSize;
    }

    return { edges };
}

export async function* deserializeGraphStream(
    bytes: Uint8Array,
    graphOffset: number,
): AsyncGenerator<Edge, void, unknown> {
    const layout = parseGraphSectionLayout(bytes, graphOffset);
    const { edgeCount, edgeColumns } = layout.header;
    let cursor = layout.edgesStart;
    for (let i = 0; i < edgeCount; i++) {
        const edgeSize = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint32(0, true);
        yield parseEdge(bytes, cursor + SIZE_PREFIX_LEN, edgeSize, edgeColumns);
        cursor += SIZE_PREFIX_LEN + edgeSize;
    }
}

export { parseEdge };
