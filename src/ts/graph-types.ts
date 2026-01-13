import type { ColumnMeta } from './column-meta.js';
import type { CrsMeta } from './crs-meta.js';
import type { GeometryType } from './flat-geobuf/geometry-type.js';

export interface EdgeProperties {
    [key: string]: boolean | number | string | Uint8Array | object | null | undefined;
}

export interface EdgeInput {
    from: number;
    to: number;
    properties?: EdgeProperties;
}

export interface Edge {
    from: number;
    to: number;
    properties: EdgeProperties;
}

export interface AdjacencyListInput {
    edges: EdgeInput[];
}

export interface AdjacencyList {
    edges: Edge[];
}

export interface FeaturesHeaderMeta {
    geometryType: GeometryType;
    columns: ColumnMeta[] | null;
    envelope: Float64Array | null;
    featuresCount: number;
    indexNodeSize: number;
    crs: CrsMeta | null;
    title: string | null;
    description: string | null;
    metadata: string | null;
}

export interface GraphHeaderMeta {
    edgeCount: number;
    edgeColumns: ColumnMeta[] | null;
}

export interface DeserializeGraphResult<T> {
    features: T[];
    adjacencyList: AdjacencyList;
}

export interface FlatGeoGraphBufMeta {
    features: FeaturesHeaderMeta;
    graph: GraphHeaderMeta | null;
}

export type FlatGeoGraphBufMetaFn = (meta: FlatGeoGraphBufMeta) => void;
