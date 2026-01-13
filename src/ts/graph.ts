import type { ColumnMeta } from './column-meta.js';
import { SIZE_PREFIX_LEN } from './constants.js';
import { ColumnType } from './flat-geobuf/column-type.js';
import type {
    AdjacencyList,
    AdjacencyListInput,
    Edge,
    EdgeInput,
    EdgeProperties,
    GraphHeaderMeta,
} from './graph-types.js';

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

function buildGraphHeader(edgeCount: number, edgeColumns: ColumnMeta[] | null): Uint8Array {
    const columnCount = edgeColumns?.length ?? 0;
    let size = 4 + 2;

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

    const propsBytes = encodeEdgeProperties(edge.properties, columns);
    const size = 8 + propsBytes.length;
    const result = new Uint8Array(SIZE_PREFIX_LEN + size);
    const view = new DataView(result.buffer);

    view.setUint32(0, size, true);
    view.setUint32(4, edge.from, true);
    view.setUint32(8, edge.to, true);
    result.set(propsBytes, 12);

    return result;
}

export function buildGraphSection(adjacencyList: AdjacencyListInput, featureCount: number): Uint8Array {
    const edgeColumns = introspectEdgeColumns(adjacencyList.edges);
    const graphHeader = buildGraphHeader(adjacencyList.edges.length, edgeColumns);

    const edgeBuffers = adjacencyList.edges.map((edge) => buildEdgeRecord(edge, edgeColumns, featureCount));
    const edgesLength = edgeBuffers.reduce((sum, e) => sum + e.length, 0);

    const totalLength = SIZE_PREFIX_LEN + graphHeader.length + edgesLength;
    const result = new Uint8Array(totalLength);
    let offset = 0;

    new DataView(result.buffer).setUint32(offset, graphHeader.length, true);
    offset += SIZE_PREFIX_LEN;

    result.set(graphHeader, offset);
    offset += graphHeader.length;

    for (const edgeBuffer of edgeBuffers) {
        result.set(edgeBuffer, offset);
        offset += edgeBuffer.length;
    }

    return result;
}

function parseGraphHeader(bytes: Uint8Array, offset: number, _headerSize: number): GraphHeaderMeta {
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

    return {
        edgeCount,
        edgeColumns: edgeColumns.length > 0 ? edgeColumns : null,
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

function parseEdge(bytes: Uint8Array, offset: number, size: number, columns: ColumnMeta[] | null): Edge {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);

    const from = view.getUint32(0, true);
    const to = view.getUint32(4, true);

    let properties: EdgeProperties = {};
    if (columns && columns.length > 0 && size > 8) {
        const propsBytes = bytes.subarray(offset + 8, offset + size);
        properties = parseEdgeProperties(propsBytes, columns);
    }

    return { from, to, properties };
}

export function parseGraphSectionHeader(bytes: Uint8Array, offset: number): GraphHeaderMeta {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const headerSize = view.getUint32(0, true);
    return parseGraphHeader(bytes, offset + SIZE_PREFIX_LEN, headerSize);
}

export function parseGraphSection(bytes: Uint8Array, offset: number): AdjacencyList {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const headerSize = view.getUint32(0, true);
    offset += SIZE_PREFIX_LEN;

    const { edgeCount, edgeColumns } = parseGraphHeader(bytes, offset, headerSize);
    offset += headerSize;

    const edges: Edge[] = new Array(edgeCount);
    for (let i = 0; i < edgeCount; i++) {
        const edgeSize = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0, true);
        edges[i] = parseEdge(bytes, offset + SIZE_PREFIX_LEN, edgeSize, edgeColumns);
        offset += SIZE_PREFIX_LEN + edgeSize;
    }

    return { edges };
}

export async function* deserializeGraphStream(
    bytes: Uint8Array,
    graphOffset: number,
): AsyncGenerator<Edge, void, unknown> {
    let offset = graphOffset;

    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const headerSize = view.getUint32(0, true);
    offset += SIZE_PREFIX_LEN;

    const { edgeCount, edgeColumns } = parseGraphHeader(bytes, offset, headerSize);
    offset += headerSize;

    for (let i = 0; i < edgeCount; i++) {
        const edgeSize = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0, true);
        yield parseEdge(bytes, offset + SIZE_PREFIX_LEN, edgeSize, edgeColumns);
        offset += SIZE_PREFIX_LEN + edgeSize;
    }
}
