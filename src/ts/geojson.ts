import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import type { IGeoJsonFeature } from './geojson/feature.js';
import {
    deserialize as fcDeserialize,
    serialize as fcSerialize,
    type SerializeOptions,
} from './geojson/featurecollection.js';
import type { AdjacencyListInput, DeserializeGraphResult, FlatGeoGraphBufMetaFn } from './graph-types.js';

export type { SerializeOptions, PropertyIndexSpec } from './geojson/featurecollection.js';
export type {
    MatchMode,
    TextQueryOptions,
    ValuePredicate,
    ValueQueryOptions,
    TextSearchHit,
} from './property-index.js';
export type {
    AdjacencyList,
    AdjacencyListInput,
    DeserializeGraphResult,
    Edge,
    EdgeInput,
    EdgeProperties,
    FeaturesHeaderMeta,
    FlatGeoGraphBufMeta,
    FlatGeoGraphBufMetaFn,
    GraphHeaderMeta,
} from './graph-types.js';

// Random-access reader and byte-source abstraction
export { FlatGeoGraphBuf, type TextHit } from './graph-reader.js';
export { byteReaderFromUint8Array, byteReaderFromUrl, type ByteReader, type UrlReaderOptions } from './byte-reader.js';
export type { EdgeWeightFn, HeuristicFn, ShortestPathOptions, ShortestPathResult } from './shortest-path.js';

export function serialize(
    geojson: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array {
    return fcSerialize(geojson, adjacencyList, options);
}

export async function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatGeoGraphBufMetaFn,
): Promise<DeserializeGraphResult<IGeoJsonFeature>> {
    return fcDeserialize(bytes, metaFn);
}
