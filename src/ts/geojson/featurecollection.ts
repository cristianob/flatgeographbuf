import * as flatbuffers from 'flatbuffers';
import type {
    FeatureCollection as GeoJsonFeatureCollection,
    Geometry as GeoJsonGeometry,
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPoint,
    MultiPolygon,
    Point,
    Polygon,
} from 'geojson';
import type { ColumnMeta } from '../column-meta.js';
import { magicbytes } from '../constants.js';
import { buildFeature, type IFeature, type IProperties } from '../generic/feature.js';
import {
    buildHeader,
    deserialize as genericDeserialize,
    deserializeFiltered as genericDeserializeFiltered,
    deserializeStream as genericDeserializeStream,
    mapColumn,
} from '../generic/featurecollection.js';
import { inferGeometryType } from '../generic/header.js';
import type { HeaderMetaFn } from '../generic.js';
import {
    buildGraphSection,
    buildVertexExtras,
    deserializeGraphStream,
    findGraphSectionStart,
    parseGraphSection,
    parseGraphSectionLayout,
} from '../graph.js';
import type {
    AdjacencyList,
    AdjacencyListInput,
    DeserializeGraphResult,
    Edge,
    EdgeInput,
    FlatGeoGraphBufMeta,
    FlatGeoGraphBufMetaFn,
} from '../graph-types.js';
import type { HeaderMeta } from '../header-meta.js';
import { fromByteBuffer } from '../header-meta.js';
import { DEFAULT_NODE_SIZE, type Rect } from '../packedrtree.js';
import { buildPackedRTree, envelopeOf, hilbertPermutation, type IndexItem } from '../packedrtree-writer.js';
import { fromFeature, type IGeoJsonFeature } from './feature.js';
import { parseGC, parseGeometry } from './geometry.js';
import { buildPropertyIndexBlock } from '../property-index.js';

export interface PropertyIndexSpec {
    /** Names of vertex feature property fields to index. Type (text /
     *  number / boolean) is inferred from the first non-null value. */
    vertices?: string[];
    /** Names of edge property fields to index. Same type-inference rule
     *  as vertices. */
    edges?: string[];
}

export interface SerializeOptions {
    /** EPSG code for the dataset CRS (default: `4326`, WGS84). */
    crsCode?: number;
    /**
     * Write a packed Hilbert R-tree spatial index over vertices between
     * the header and the features section (default: `true`). Reorders
     * features along the Hilbert curve and remaps edge `from` / `to`
     * accordingly.
     */
    writeIndex?: boolean;
    /**
     * Write a CSR adjacency index in the graph section so neighbor
     * lookup (`outgoingEdgesOf(v)`) is O(deg(v)). Required for
     * `shortestPath`. Causes edges to be physically sorted by `from`.
     * Default: `true` (ignored when there is no adjacencyList).
     */
    writeAdjacencyIndex?: boolean;
    /**
     * Write a packed Hilbert R-tree spatial index over edges in the
     * graph section so `edgesInBbox(rect)` can locate intersecting
     * edges without scanning the whole graph. Default: `true` (ignored
     * when there is no adjacencyList).
     */
    writeEdgeIndex?: boolean;
    /**
     * Per-column property indices on vertex features and/or edges.
     * Enables `findVerticesByText`, `findVerticesByValue`,
     * `findEdgesByText`, `findEdgesByValue`. Default: no property
     * indices.
     */
    columnIndex?: PropertyIndexSpec;
}

interface NormalizedOptions {
    crsCode: number;
    writeIndex: boolean;
    writeAdjacencyIndex: boolean;
    writeEdgeIndex: boolean;
    columnIndex: PropertyIndexSpec;
}

function normalizeOptions(opts: SerializeOptions | undefined): NormalizedOptions {
    return {
        crsCode: opts?.crsCode ?? 4326,
        writeIndex: opts?.writeIndex ?? true,
        writeAdjacencyIndex: opts?.writeAdjacencyIndex ?? true,
        writeEdgeIndex: opts?.writeEdgeIndex ?? true,
        columnIndex: opts?.columnIndex ?? {},
    };
}

function bboxOf(geom: GeoJsonGeometry): Rect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    const visit = (coords: unknown): void => {
        if (Array.isArray(coords)) {
            if (typeof coords[0] === 'number') {
                const x = coords[0] as number;
                const y = coords[1] as number;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            } else {
                for (const c of coords) visit(c);
            }
        }
    };

    if (geom.type === 'GeometryCollection') {
        for (const g of (geom as GeometryCollection).geometries) {
            const r = bboxOf(g);
            if (r.minX < minX) minX = r.minX;
            if (r.minY < minY) minY = r.minY;
            if (r.maxX > maxX) maxX = r.maxX;
            if (r.maxY > maxY) maxY = r.maxY;
        }
    } else {
        visit((geom as { coordinates: unknown }).coordinates);
    }

    return { minX, minY, maxX, maxY };
}

function remapEdges(adjacencyList: AdjacencyListInput, invPerm: number[]): AdjacencyListInput {
    const edges: EdgeInput[] = adjacencyList.edges.map((e) => ({
        ...e,
        from: invPerm[e.from],
        to: invPerm[e.to],
    }));
    return { edges };
}

export function serialize(
    featurecollection: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array {
    const { crsCode, writeIndex, writeAdjacencyIndex, writeEdgeIndex, columnIndex } = normalizeOptions(options);
    // Edge-related index flags only make sense with a graph section.
    const effectiveAdjacencyIndex = writeAdjacencyIndex && adjacencyList !== undefined;
    const effectiveEdgeIndex = writeEdgeIndex && adjacencyList !== undefined;

    const headerMeta = introspectHeaderMeta(featurecollection);
    const featureCount = featurecollection.features.length;
    const wantsIndex = writeIndex && featureCount > 0;
    const indexNodeSize = DEFAULT_NODE_SIZE;

    // Bboxes are needed both for the dataset envelope (always written when
    // we have features) and for the Hilbert sort + R-tree (when indexed).
    const bboxes: Rect[] = featurecollection.features.map((f) => bboxOf(f.geometry as GeoJsonGeometry));
    const envelope = featureCount > 0 ? envelopeOf(bboxes) : null;

    let orderedFeatures = featurecollection.features;
    let orderedBboxes = bboxes;
    let remappedAdjacency = adjacencyList;

    if (wantsIndex) {
        // perm[newIdx] = oldIdx; invPerm[oldIdx] = newIdx
        const perm = hilbertPermutation(bboxes, envelope as Rect);
        const isIdentity = perm.every((v, i) => v === i);
        if (!isIdentity) {
            orderedFeatures = perm.map((oldIdx) => featurecollection.features[oldIdx]);
            orderedBboxes = perm.map((oldIdx) => bboxes[oldIdx]);
            if (adjacencyList) {
                const invPerm = new Array<number>(perm.length);
                for (let i = 0; i < perm.length; i++) invPerm[perm[i]] = i;
                remappedAdjacency = remapEdges(adjacencyList, invPerm);
            }
        }
    }

    headerMeta.indexNodeSize = wantsIndex ? indexNodeSize : 0;
    headerMeta.envelope = envelope
        ? new Float64Array([envelope.minX, envelope.minY, envelope.maxX, envelope.maxY])
        : null;

    const header = buildHeader(headerMeta, crsCode);
    const featureBuffers: Uint8Array[] = orderedFeatures.map((f) =>
        buildFeature(
            f.geometry.type === 'GeometryCollection'
                ? parseGC(f.geometry as GeometryCollection)
                : parseGeometry(
                      f.geometry as Point | MultiPoint | LineString | MultiLineString | Polygon | MultiPolygon,
                  ),
            f.properties as IProperties,
            headerMeta,
        ),
    );
    const featuresLength = featureBuffers.reduce((a, b) => a + b.length, 0);

    let indexBytes: Uint8Array | null = null;
    if (wantsIndex) {
        const items: IndexItem[] = new Array(featureCount);
        let runningOffset = 0;
        for (let i = 0; i < featureCount; i++) {
            const r = orderedBboxes[i];
            items[i] = {
                minX: r.minX,
                minY: r.minY,
                maxX: r.maxX,
                maxY: r.maxY,
                offset: runningOffset,
            };
            runningOffset += featureBuffers[i].length;
        }
        indexBytes = buildPackedRTree(items, indexNodeSize);
    }

    let vertexPropertyIndex: Uint8Array | null = null;
    if (columnIndex.vertices && columnIndex.vertices.length > 0 && featureCount > 0) {
        vertexPropertyIndex = buildPropertyIndexBlock({
            columns: columnIndex.vertices,
            count: featureCount,
            valueAt: (i, col) =>
                (orderedFeatures[i].properties as Record<string, unknown> | null | undefined)?.[col],
        });
    }

    let edgePropertyIndex: Uint8Array | null = null;
    if (
        columnIndex.edges &&
        columnIndex.edges.length > 0 &&
        remappedAdjacency &&
        remappedAdjacency.edges.length > 0
    ) {
        // Edges are reordered inside buildGraphSection when the adjacency
        // index is requested; we need to mirror that ordering here.
        const orderedEdges = effectiveAdjacencyIndex
            ? [...remappedAdjacency.edges].sort((a, b) => a.from - b.from)
            : remappedAdjacency.edges;
        edgePropertyIndex = buildPropertyIndexBlock({
            columns: columnIndex.edges,
            count: orderedEdges.length,
            valueAt: (i, col) =>
                (orderedEdges[i].properties as Record<string, unknown> | null | undefined)?.[col],
        });
    }

    let graphSection: Uint8Array | null = null;
    if (remappedAdjacency !== undefined || edgePropertyIndex !== null) {
        graphSection = buildGraphSection(remappedAdjacency ?? { edges: [] }, featureCount, {
            writeAdjacencyIndex: effectiveAdjacencyIndex,
            writeEdgeIndex: effectiveEdgeIndex,
            vertexBboxes: effectiveEdgeIndex ? orderedBboxes : undefined,
            edgePropertyIndex,
        });
    }

    // Vertex extras trailer (1B indexFlags + optional length-prefixed
    // blocks) lives between the vertex R-tree and the features payload.
    // Mirrors the graph-section flag-based layout for symmetry.
    const vertexExtras = buildVertexExtras(vertexPropertyIndex);

    const totalLength =
        magicbytes.length +
        header.length +
        (indexBytes?.length ?? 0) +
        vertexExtras.length +
        featuresLength +
        (graphSection?.length ?? 0);
    const uint8 = new Uint8Array(totalLength);

    uint8.set(magicbytes);
    uint8.set(header, magicbytes.length);

    let offset = magicbytes.length + header.length;
    if (indexBytes) {
        uint8.set(indexBytes, offset);
        offset += indexBytes.length;
    }
    uint8.set(vertexExtras, offset);
    offset += vertexExtras.length;
    for (const feature of featureBuffers) {
        uint8.set(feature, offset);
        offset += feature.length;
    }

    if (graphSection) {
        uint8.set(graphSection, offset);
    }

    return uint8;
}

export async function* deserializeStream(
    input: Uint8Array | ReadableStream,
    rect?: Rect,
    headerMetaFn?: HeaderMetaFn,
): AsyncGenerator<IFeature> {
    if (input instanceof Uint8Array) {
        yield* genericDeserialize(input, fromFeature, rect, headerMetaFn);
    } else {
        yield* genericDeserializeStream(input, fromFeature, headerMetaFn);
    }
}

export function deserializeFiltered(
    url: string,
    rect: Rect,
    headerMetaFn?: HeaderMetaFn,
    nocache = false,
    headers: HeadersInit = {},
): AsyncGenerator<IFeature> {
    return genericDeserializeFiltered(url, rect, fromFeature, headerMetaFn, nocache, headers);
}

export async function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatGeoGraphBufMetaFn,
): Promise<DeserializeGraphResult<IGeoJsonFeature>> {
    const features: IGeoJsonFeature[] = [];

    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(magicbytes.length);
    const headerMeta = fromByteBuffer(bb);

    const featuresEndOffset = findGraphSectionStart(bytes, headerMeta);
    const hasGraphSection = featuresEndOffset < bytes.length;

    const graphMeta = hasGraphSection ? parseGraphSectionLayout(bytes, featuresEndOffset).header : null;

    if (metaFn) {
        const combinedMeta: FlatGeoGraphBufMeta = {
            features: headerMeta,
            graph: graphMeta,
        };
        metaFn(combinedMeta);
    }

    for await (const feature of genericDeserialize(bytes, fromFeature, undefined, undefined)) {
        features.push(feature as IGeoJsonFeature);
    }

    const adjacencyList: AdjacencyList = hasGraphSection ? parseGraphSection(bytes, featuresEndOffset) : { edges: [] };

    return { features, adjacencyList };
}

export async function* deserializeGraphEdges(bytes: Uint8Array): AsyncGenerator<Edge, void, unknown> {
    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(magicbytes.length);
    const headerMeta = fromByteBuffer(bb);

    const featuresEndOffset = findGraphSectionStart(bytes, headerMeta);

    if (featuresEndOffset >= bytes.length) return;

    yield* deserializeGraphStream(bytes, featuresEndOffset);
}

function introspectHeaderMeta(featurecollection: GeoJsonFeatureCollection): HeaderMeta {
    const feature = featurecollection.features[0];
    const properties = feature?.properties;

    let columns: ColumnMeta[] | null = null;
    if (properties) columns = Object.keys(properties).map((k) => mapColumn(properties, k));

    const geometryType = inferGeometryType(featurecollection.features);
    const headerMeta: HeaderMeta = {
        geometryType,
        columns,
        envelope: null,
        featuresCount: featurecollection.features.length,
        indexNodeSize: 0,
        crs: null,
        title: null,
        description: null,
        metadata: null,
    };

    return headerMeta;
}
