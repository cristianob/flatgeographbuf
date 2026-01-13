import * as flatbuffers from 'flatbuffers';
import type {
    FeatureCollection as GeoJsonFeatureCollection,
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPoint,
    MultiPolygon,
    Point,
    Polygon,
} from 'geojson';
import type { ColumnMeta } from '../column-meta.js';
import { magicbytes, SIZE_PREFIX_LEN } from '../constants.js';
import { Feature } from '../flat-geobuf/feature.js';
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
import { buildGraphSection, deserializeGraphStream, parseGraphSection, parseGraphSectionHeader } from '../graph.js';
import type {
    AdjacencyList,
    AdjacencyListInput,
    DeserializeGraphResult,
    Edge,
    FlatGeoGraphBufMeta,
    FlatGeoGraphBufMetaFn,
} from '../graph-types.js';
import type { HeaderMeta } from '../header-meta.js';
import { fromByteBuffer } from '../header-meta.js';
import { calcTreeSize, type Rect } from '../packedrtree.js';
import { fromFeature, type IGeoJsonFeature } from './feature.js';
import { parseGC, parseGeometry } from './geometry.js';

export function serialize(
    featurecollection: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    crsCode = 0,
): Uint8Array {
    const headerMeta = introspectHeaderMeta(featurecollection);
    const header = buildHeader(headerMeta, crsCode);
    const features: Uint8Array[] = featurecollection.features.map((f) =>
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
    const featuresLength = features.map((f) => f.length).reduce((a, b) => a + b, 0);

    let graphSection: Uint8Array | null = null;
    if (adjacencyList) {
        graphSection = buildGraphSection(adjacencyList, featurecollection.features.length);
    }

    const totalLength = magicbytes.length + header.length + featuresLength + (graphSection?.length ?? 0);
    const uint8 = new Uint8Array(totalLength);

    uint8.set(magicbytes);
    uint8.set(header, magicbytes.length);

    let offset = magicbytes.length + header.length;
    for (const feature of features) {
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

function calculateFeaturesEndOffset(bytes: Uint8Array, headerMeta: HeaderMeta): number {
    const bb = new flatbuffers.ByteBuffer(bytes);
    const headerLength = bb.readUint32(magicbytes.length);
    let offset = magicbytes.length + SIZE_PREFIX_LEN + headerLength;

    if (headerMeta.indexNodeSize > 0) {
        offset += calcTreeSize(headerMeta.featuresCount, headerMeta.indexNodeSize);
    }

    let featuresRead = 0;
    while (featuresRead < headerMeta.featuresCount && offset < bytes.length) {
        const featureLength = bb.readUint32(offset);
        offset += SIZE_PREFIX_LEN + featureLength;
        featuresRead++;
    }

    return offset;
}

export async function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatGeoGraphBufMetaFn,
): Promise<DeserializeGraphResult<IGeoJsonFeature>> {
    const features: IGeoJsonFeature[] = [];

    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(magicbytes.length);
    const headerMeta = fromByteBuffer(bb);

    const featuresEndOffset = calculateFeaturesEndOffset(bytes, headerMeta);
    const hasGraphSection = featuresEndOffset < bytes.length;

    const graphMeta = hasGraphSection ? parseGraphSectionHeader(bytes, featuresEndOffset) : null;

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

    const featuresEndOffset = calculateFeaturesEndOffset(bytes, headerMeta);

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
