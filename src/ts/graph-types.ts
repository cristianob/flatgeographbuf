import type { ColumnMeta } from './column-meta.js';

/**
 * Properties that can be attached to an edge.
 * Same types as feature properties for consistency.
 */
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

/**
 * Metadata for the graph section header.
 * Used internally during serialization/deserialization.
 */
export interface GraphHeaderMeta {
    /** Number of edges in the graph */
    edgeCount: number;
    /** Column definitions for edge properties (like feature columns) */
    edgeColumns: ColumnMeta[] | null;
}

/**
 * Result from deserializing a FlatGeoGraphBuf file with graph data.
 */
export interface DeserializeGraphResult<T> {
    /** Array of deserialized features (vertices) */
    features: T[];
    /** Adjacency list with edges */
    adjacencyList: AdjacencyList;
}
