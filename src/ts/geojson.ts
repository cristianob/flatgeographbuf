import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import type { HeaderMetaFn } from './generic.js';
import type { IGeoJsonFeature } from './geojson/feature.js';
import {
    deserialize as fcDeserialize,
    deserializeFiltered as fcDeserializeFiltered,
    deserializeGraphEdges as fcDeserializeGraphEdges,
    deserializeStream as fcDeserializeStream,
    serialize as fcSerialize,
} from './geojson/featurecollection.js';
import type { AdjacencyListInput, DeserializeGraphResult, Edge } from './graph-types.js';
import type { Rect } from './packedrtree.js';

export type {
    AdjacencyList,
    AdjacencyListInput,
    DeserializeGraphResult,
    Edge,
    EdgeInput,
    EdgeProperties,
} from './graph-types.js';

export function serialize(
    geojson: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    crsCode = 0,
): Uint8Array {
    return fcSerialize(geojson, adjacencyList, crsCode);
}

export async function deserialize(
    bytes: Uint8Array,
    headerMetaFn?: HeaderMetaFn,
): Promise<DeserializeGraphResult<IGeoJsonFeature>> {
    return fcDeserialize(bytes, headerMetaFn);
}

export function deserializeStream(
    input: Uint8Array | ReadableStream,
    rect?: Rect,
    headerMetaFn?: HeaderMetaFn,
): AsyncGenerator<IGeoJsonFeature> {
    return fcDeserializeStream(input, rect, headerMetaFn) as AsyncGenerator<IGeoJsonFeature>;
}

export function deserializeFiltered(
    url: string,
    rect: Rect,
    headerMetaFn?: HeaderMetaFn,
    nocache = false,
    headers: HeadersInit = {},
): AsyncGenerator<IGeoJsonFeature> {
    return fcDeserializeFiltered(url, rect, headerMetaFn, nocache, headers) as AsyncGenerator<IGeoJsonFeature>;
}

export function deserializeGraphEdges(bytes: Uint8Array): AsyncGenerator<Edge, void, unknown> {
    return fcDeserializeGraphEdges(bytes);
}
