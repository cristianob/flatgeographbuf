import type { IGeoJsonFeature } from './geojson/feature.js';
import type { FlatGeoGraphBuf } from './graph-reader.js';
import type { Edge, EdgeProperties } from './graph-types.js';

/**
 * Edge weight function. Receives the precomputed haversine length of
 * the edge (in metres, on the WGS84 sphere) and the edge's properties.
 * Return a non-negative finite number — higher means "more costly".
 *
 * Default behaviour when no custom function is supplied: weight equals
 * the haversine distance itself.
 */
export type EdgeWeightFn = (distance: number, properties: EdgeProperties) => number;

/**
 * A* heuristic. Receives the current vertex and the target vertex as
 * GeoJSON features. Must be admissible (never overestimate the true
 * remaining cost). Default: haversine distance between vertex centroids.
 */
export type HeuristicFn = (vertex: IGeoJsonFeature, target: IGeoJsonFeature) => number;

export interface ShortestPathOptions {
    /**
     * Per-edge cost. Receives the precomputed haversine length of the
     * edge (metres) and the edge's properties. Default: returns the
     * distance unchanged, i.e. the weight is the geodesic length.
     */
    weight?: EdgeWeightFn;
    /**
     * A* heuristic. Defaults to `'haversine'` — straight-line haversine
     * distance between vertex points (admissible for geospatial graphs).
     * Pass a custom `(vertex, target) => number` for domain-specific
     * heuristics (must never overestimate the remaining cost), or `null`
     * to fall back to plain Dijkstra.
     */
    heuristic?: HeuristicFn | 'haversine' | null;
}

export interface ShortestPathResult {
    vertices: IGeoJsonFeature[];
    edges: Edge[];
    cost: number;
}

const EARTH_RADIUS_M = 6371008.8;

/**
 * Haversine great-circle distance between two `[lon, lat]` points in
 * degrees, returned in metres on the WGS84 mean radius (6 371 008.8 m).
 */
export function haversine(a: [number, number], b: [number, number]): number {
    const toRad = Math.PI / 180;
    const lat1 = a[1] * toRad;
    const lat2 = b[1] * toRad;
    const dLat = (b[1] - a[1]) * toRad;
    const dLon = (b[0] - a[0]) * toRad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function representativePoint(f: IGeoJsonFeature): [number, number] | null {
    const g = f.geometry as { type: string; coordinates: unknown } | undefined;
    if (!g) return null;
    if (g.type === 'Point') {
        const c = g.coordinates as number[];
        return [c[0], c[1]];
    }
    // Best-effort: pick the first coordinate (used by A* heuristic when
    // vertex geometries are not Point — admissibility may suffer).
    const c = g.coordinates as unknown;
    if (Array.isArray(c) && c.length > 0) {
        const first = c[0];
        if (typeof first === 'number' && typeof (c as number[])[1] === 'number') {
            return [(c as number[])[0], (c as number[])[1]];
        }
        if (Array.isArray(first) && typeof first[0] === 'number' && typeof first[1] === 'number') {
            return [first[0] as number, first[1] as number];
        }
    }
    return null;
}

/**
 * Total geodesic length of an edge in metres. For edges with a
 * LineString, this sums haversine over consecutive vertices. For edges
 * without geometry, it is the straight haversine distance between the
 * `from` and `to` features' representative points.
 */
function edgeHaversineLength(
    edge: Edge,
    fromFeature: IGeoJsonFeature,
    toFeature: IGeoJsonFeature,
): number {
    if (edge.geometry && edge.geometry.coordinates.length >= 2) {
        const cs = edge.geometry.coordinates;
        let total = 0;
        for (let i = 1; i < cs.length; i++) {
            total += haversine(cs[i - 1] as [number, number], cs[i] as [number, number]);
        }
        return total;
    }
    const a = representativePoint(fromFeature);
    const b = representativePoint(toFeature);
    if (!a || !b) return 0;
    return haversine(a, b);
}

function defaultHeuristic(vertex: IGeoJsonFeature, target: IGeoJsonFeature): number {
    const a = representativePoint(vertex);
    const b = representativePoint(target);
    if (!a || !b) return 0;
    return haversine(a, b);
}

class MinHeap {
    private nodes: Array<{ cost: number; v: number }> = [];
    push(cost: number, v: number): void {
        this.nodes.push({ cost, v });
        this.siftUp(this.nodes.length - 1);
    }
    pop(): { cost: number; v: number } | undefined {
        if (this.nodes.length === 0) return undefined;
        const root = this.nodes[0];
        const last = this.nodes.pop();
        if (last !== undefined && this.nodes.length > 0) {
            this.nodes[0] = last;
            this.siftDown(0);
        }
        return root;
    }
    get size(): number {
        return this.nodes.length;
    }
    private siftUp(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.nodes[parent].cost <= this.nodes[i].cost) break;
            [this.nodes[parent], this.nodes[i]] = [this.nodes[i], this.nodes[parent]];
            i = parent;
        }
    }
    private siftDown(i: number): void {
        const n = this.nodes.length;
        for (;;) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let smallest = i;
            if (l < n && this.nodes[l].cost < this.nodes[smallest].cost) smallest = l;
            if (r < n && this.nodes[r].cost < this.nodes[smallest].cost) smallest = r;
            if (smallest === i) break;
            [this.nodes[i], this.nodes[smallest]] = [this.nodes[smallest], this.nodes[i]];
            i = smallest;
        }
    }
}

interface PathPredecessor {
    prev: number;
    edge: Edge;
}

/**
 * Search state held in sparse Map/Set structures so memory usage scales
 * with **vertices actually visited**, not with the total vertex count.
 * This is what makes shortest-path queries viable on graphs with
 * billions of vertices — a dense `Float64Array(N)` would allocate
 * gigabytes before the search even begins (and outright fail above
 * V8's TypedArray size limit).
 */
async function search(
    graph: FlatGeoGraphBuf,
    from: number,
    to: number,
    weight: EdgeWeightFn,
    heuristic: HeuristicFn | null,
): Promise<{ cost: number; predecessor: Map<number, PathPredecessor> } | null> {
    const distances = new Map<number, number>();
    const predecessor = new Map<number, PathPredecessor>();
    const finalized = new Set<number>();
    distances.set(from, 0);

    // Target feature is fetched eagerly because the heuristic needs it
    // for every priority computation; others stay lazy.
    const target = await graph.getFeature(to);
    const heap = new MinHeap();
    if (heuristic) {
        const fromFeature = await graph.getFeature(from);
        heap.push(heuristic(fromFeature, target), from);
    } else {
        heap.push(0, from);
    }

    while (heap.size > 0) {
        const popped = heap.pop();
        if (!popped) break;
        const u = popped.v;
        if (finalized.has(u)) continue;
        finalized.add(u);
        if (u === to) break;

        const du = distances.get(u) ?? Number.POSITIVE_INFINITY;
        const uFeature = await graph.getFeature(u);

        for await (const edge of graph.outgoingEdgesOf(u)) {
            const v = edge.to;
            if (finalized.has(v)) continue;
            const vFeature = await graph.getFeature(v);
            const distance = edgeHaversineLength(edge, uFeature, vFeature);
            const w = weight(distance, edge.properties);
            if (!Number.isFinite(w) || w < 0) {
                throw new Error(`Edge weight must be a finite non-negative number, got ${w}`);
            }
            const newDist = du + w;
            const currentDist = distances.get(v) ?? Number.POSITIVE_INFINITY;
            if (newDist < currentDist) {
                distances.set(v, newDist);
                predecessor.set(v, { prev: u, edge });
                const priority = heuristic ? newDist + heuristic(vFeature, target) : newDist;
                heap.push(priority, v);
            }
        }
    }

    const cost = distances.get(to);
    if (cost === undefined || !Number.isFinite(cost)) return null;
    return { cost, predecessor };
}

async function reconstructPath(
    graph: FlatGeoGraphBuf,
    from: number,
    to: number,
    predecessor: Map<number, PathPredecessor>,
): Promise<{ vertices: IGeoJsonFeature[]; edges: Edge[] }> {
    const vertexIndices: number[] = [to];
    const edges: Edge[] = [];
    let cur = to;
    while (cur !== from) {
        const p = predecessor.get(cur);
        if (!p) throw new Error('Predecessor chain broken during path reconstruction');
        edges.push(p.edge);
        vertexIndices.push(p.prev);
        cur = p.prev;
    }
    vertexIndices.reverse();
    edges.reverse();
    const vertices: IGeoJsonFeature[] = new Array(vertexIndices.length);
    for (let i = 0; i < vertexIndices.length; i++) {
        vertices[i] = await graph.getFeature(vertexIndices[i]);
    }
    return { vertices, edges };
}

/**
 * Internal implementation of the `Graph#shortestPath` method.
 *
 * Coordinates are assumed to be `[longitude, latitude]` in degrees;
 * geodesic distances use the haversine formula on the WGS84 mean
 * radius. By default an edge's weight is its haversine length in
 * metres (following the LineString geometry when present, otherwise
 * the straight line between endpoints); supply
 * `options.weight(distance, properties) => weight` to shape that cost
 * (e.g. divide by speed limit for travel time).
 *
 * Search behaviour:
 *   - **Default** (no `options.heuristic`): **A*** with straight-line
 *     haversine between vertex points — optimal and admissible for
 *     geospatial graphs.
 *   - With a custom `heuristic(vertex, target) => number`: **A*** using
 *     that estimate (must be admissible).
 *   - With `heuristic: null`: classical **Dijkstra**.
 *
 * Returns `null` when there is no path from `from` to `to`; returns a
 * trivial path with one vertex and no edges when `from === to`.
 *
 * Vertex features are loaded via `graph.loadFeatures()` which caches
 * them on the instance, so repeated calls on the same `graph` are
 * cheap.
 *
 * @internal — public API surface is `Graph#shortestPath`.
 */
export async function runShortestPath(
    graph: FlatGeoGraphBuf,
    from: number,
    to: number,
    options: ShortestPathOptions = {},
): Promise<ShortestPathResult | null> {
    if (from < 0 || from >= graph.featureCount) {
        throw new Error(`'from' vertex out of range: ${from} (have ${graph.featureCount} vertices)`);
    }
    if (to < 0 || to >= graph.featureCount) {
        throw new Error(`'to' vertex out of range: ${to} (have ${graph.featureCount} vertices)`);
    }
    if (graph.layout.adjacencyOffsetsStart === null) {
        throw new Error('Adjacency index required for shortestPath. Re-serialize with writeAdjacencyIndex: true.');
    }

    if (from === to) {
        const f = await graph.getFeature(from);
        return { vertices: [f], edges: [], cost: 0 };
    }

    const weight: EdgeWeightFn = options.weight ?? ((distance) => distance);
    const heuristic: HeuristicFn | null =
        options.heuristic === null
            ? null
            : options.heuristic === undefined || options.heuristic === 'haversine'
              ? defaultHeuristic
              : options.heuristic;

    const result = await search(graph, from, to, weight, heuristic);
    if (!result) return null;

    const { vertices, edges } = await reconstructPath(graph, from, to, result.predecessor);
    return { vertices, edges, cost: result.cost };
}
