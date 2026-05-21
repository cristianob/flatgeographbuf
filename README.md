# FlatGeoGraphBuf

A performant binary encoding for **geospatial graphs**. Built on top of [FlatGeobuf](https://github.com/flatgeobuf/flatgeobuf), it adds a typed adjacency list with optional LineString paths on edges, plus three spatial / structural indices that let readers jump straight to the part of a graph they care about — without loading the whole file into memory.

> Think of it as **GeoJSON + a graph + an index**, stored as a single file you can stream from S3, mmap from disk, or load entirely in the browser, with the same API on Node, browsers and React Native.

---

## Table of contents

- [Why FlatGeoGraphBuf?](#why-flatgeographbuf)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Guides](#guides)
  - [1. Writing your first FGG file](#1-writing-your-first-fgg-file)
  - [2. Reading: full load vs random access](#2-reading-full-load-vs-random-access)
  - [3. Walking the graph (neighbours, all edges)](#3-walking-the-graph-neighbours-all-edges)
  - [4. Spatial queries (features and edges in a bbox)](#4-spatial-queries-features-and-edges-in-a-bbox)
  - [5. Shortest path (Dijkstra / A* with haversine)](#5-shortest-path-dijkstra--a-with-haversine)
  - [6. Working with remote files](#6-working-with-remote-files)
  - [7. Performance tuning: when to preload, when to release](#7-performance-tuning-when-to-preload-when-to-release)
  - [8. Plugging in a custom byte source](#8-plugging-in-a-custom-byte-source)
  - [9. Property indices: text, number, boolean searches](#9-property-indices-text-number-boolean-searches)
- [API reference](#api-reference)
- [Binary format](#binary-format)
- [Design decisions](#design-decisions)
- [License](#license)

---

## Why FlatGeoGraphBuf?

If your dataset is a **set of geospatial points/lines/polygons connected by relationships** — road networks, power grids, pipe networks, transit graphs, river networks — you usually end up reinventing one of these:

- A big GeoJSON file with `from`/`to` fields glued on top of features. Works, but loading 1 GB just to find one route is wasteful.
- Two separate files (nodes + edges) and a hand-rolled join. Awkward to ship.
- A graph database. Overkill for read-mostly use cases.

FlatGeoGraphBuf packages all of that into a **single binary file** with the same streaming-friendly properties as FlatGeobuf, plus three optional indices that the writer builds for you:

| Index | What it unlocks |
| --- | --- |
| Vertex spatial R-tree | "Give me every feature inside this bbox" without scanning the file |
| Adjacency CSR | "Give me the outgoing edges of vertex V" in O(deg V), plus shortest-path queries |
| Edge spatial R-tree | "Give me every edge that touches this bbox" without scanning the file |

A reader that only cares about a 1 km² query downloads just the bytes it needs — header, R-tree leaves, and the matching records — even over HTTP `Range:` requests. A reader that wants the whole graph in memory makes one call (`preload()`) and pays a single round trip.

## Installation

```bash
npm install flatgeographbuf
```

The package ships ESM only and supports Node ≥ 18, modern browsers, and React Native (anywhere a global `fetch` is available — or you can plug in your own byte source, see [Guide 8](#8-plugging-in-a-custom-byte-source)).

## Quick start

```typescript
import { FlatGeoGraphBuf, serialize, deserialize } from 'flatgeographbuf/geojson';

// 1) Build a graph: three GeoJSON vertices + two directed edges.
const geojson = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio'       } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília'  } },
    ],
};
const adjacency = {
    edges: [
        { from: 0, to: 1, properties: { road: 'BR-116' } },
        { from: 0, to: 2, properties: { road: 'BR-050' } },
    ],
};

// 2) Encode to a Uint8Array (defaults: all three indices on, WGS84).
const bytes = serialize(geojson, adjacency);

// 3) Open for random-access queries.
const fgg = await FlatGeoGraphBuf.open(bytes);

// 4) Use it.
for await (const edge of fgg.outgoingEdgesOf(0)) {
    console.log(`SP → ${edge.to}`, edge.properties);
}

const path = await fgg.shortestPath(2, 1);   // Brasília → Rio
console.log(path?.cost, path?.vertices.map(v => v.properties.name));

// Alternative: if you just want everything in memory at once.
const { features, adjacencyList } = await deserialize(bytes);
```

That's the whole shape of the library. The rest of this README explains **when** and **why** to reach for each piece.

---

## Guides

### 1. Writing your first FGG file

Encoding takes two inputs: a GeoJSON `FeatureCollection` (the vertices) and an `AdjacencyListInput` (the edges referencing those vertices by index).

```typescript
import { serialize } from 'flatgeographbuf/geojson';

const bytes = serialize(geojson, {
    edges: [
        { from: 0, to: 1, properties: { weight: 1.5, road_type: 'highway' } },

        // Edges can carry a LineString that describes the actual path
        // (curved road, transmission line following terrain, …).
        // When omitted, consumers treat it as a straight segment.
        {
            from: 1,
            to: 2,
            geometry: { type: 'LineString', coordinates: [[1, 1], [1.4, 1.7], [2, 2]] },
            properties: { weight: 2.0, road_type: 'local' },
        },
    ],
});
```

**Edge constraints** (enforced at write time):
- `from` and `to` must be valid vertex indices.
- Self-loops (`from === to`) are not allowed.
- Edges are directed; for an undirected connection, emit two edges.
- If `geometry` is present, it must be a `LineString` with at least 2 coordinates.

**Defaults you'll usually keep:** `serialize(geojson, edges)` writes WGS84 (EPSG:4326) and turns on all three indices. Override only when you have a reason — see [Guide 7](#7-performance-tuning-when-to-preload-when-to-release) for the trade-offs.

### 2. Reading: full load vs random access

There are two ways to read an FGG file. Pick based on **how much of it you'll query** and **whether it fits in memory**.

#### `deserialize(bytes)` — load everything

```typescript
import { deserialize } from 'flatgeographbuf/geojson';

const { features, adjacencyList } = await deserialize(bytes);
// features: IGeoJsonFeature[]   — every vertex
// adjacencyList.edges: Edge[]   — every edge
```

Use when the file fits comfortably in memory and you're going to iterate most of it (round-trip tests, batch processing, exporting to another format).

#### `FlatGeoGraphBuf.open(source)` — random access

```typescript
import { FlatGeoGraphBuf } from 'flatgeographbuf/geojson';

const fgg = await FlatGeoGraphBuf.open(bytes);
// `open` only reads ~few KB (header + one R-tree leaf + graph header).
// Feature payloads and edge data are NOT touched yet.

const v0 = await fgg.getFeature(0);             // single feature, O(1) with R-tree
const path = await fgg.shortestPath(0, 1);      // walks the graph, fetching only as needed
```

Use when the file is huge, when you only need a subset (a bbox, a single shortest path, one vertex's neighbours), or when the file lives on a remote server (HTTP, S3) and you want to download just the relevant bytes.

`source` is either a `Uint8Array` or any object implementing the [`ByteReader` interface](#8-plugging-in-a-custom-byte-source). All methods on the resulting `fgg` are async, return `Promise`s or async generators, and cache what they read.

### 3. Walking the graph (neighbours, all edges)

```typescript
const fgg = await FlatGeoGraphBuf.open(bytes);

// Outgoing edges of vertex 42. Each call reads only that vertex's edges,
// then caches them so the second call on the same vertex is free.
for await (const edge of fgg.outgoingEdgesOf(42)) {
    console.log(edge.to, edge.properties);
}

// Every edge in storage order.
for await (const edge of fgg.allEdges()) {
    process(edge);
}
```

`outgoingEdgesOf` requires the **adjacency CSR** to be present (`writeAdjacencyIndex: true`, the default). Without it the method throws a descriptive error telling you to re-serialize.

### 4. Spatial queries (features and edges in a bbox)

```typescript
const rect = { minX: -46.65, minY: -23.55, maxX: -46.55, maxY: -23.45 };

// All vertices whose bbox intersects `rect`.
for await (const f of fgg.featuresInBbox(rect)) {
    console.log(f.properties);
}

// All edges whose bbox intersects `rect`. This includes edges that
// only PARTIALLY cross the rectangle (e.g. a LineString that exits
// it) — the R-tree returns every overlapping edge and leaves exact
// geometry filtering to you.
for await (const edge of fgg.edgesInBbox(rect)) {
    console.log(edge.from, '→', edge.to);
}
```

- `featuresInBbox` needs `writeIndex: true` (vertex R-tree).
- `edgesInBbox` needs `writeEdgeIndex: true` (edge R-tree).

Both walk the tree top-down via the same packed-Hilbert layout FlatGeobuf uses, so the I/O cost is `O(log N)` reads from your `ByteReader` per hit, not `O(N)`.

### 5. Shortest path (Dijkstra / A* with haversine)

```typescript
const fgg = await FlatGeoGraphBuf.open(bytes);

// A* with the default haversine heuristic and weight = geodesic distance in metres.
const path = await fgg.shortestPath(srcIdx, dstIdx);
if (path) {
    console.log(`${path.cost.toFixed(0)} metres, ${path.edges.length} hops`);
    for (const v of path.vertices) console.log('  ', v.properties);
}
```

The default behaviour is what you want 90 % of the time on a road / utility network: **A* with haversine**, optimising **geodesic distance in metres**. Coordinates are assumed to be `[longitude, latitude]` in degrees (WGS84).

**Custom weight.** Pass `weight(distance, properties)` to optimise something other than raw distance. `distance` is the haversine length of the edge (sum over the LineString geometry when present, straight line between endpoints otherwise) — you can multiply, divide, or ignore it.

```typescript
// Travel time at the road's speed limit
const fastest = await fgg.shortestPath(srcIdx, dstIdx, {
    weight: (d, p) => d / (Number(p.speed_kmh ?? 50) * 1000 / 3600),  // seconds
    heuristic: null,  // ⚠ see below
});
```

**Heuristic admissibility.** A* with the default haversine heuristic is only optimal when `weight(d, …) ≤ d` (the heuristic must underestimate the remaining cost). If you switch to travel time, hop count, monetary cost, etc., the heuristic can mislead A* — pass `heuristic: null` to fall back to plain Dijkstra, or supply your own admissible heuristic in the same units as `weight`.

**Memory model.** The search state is sparse (`Map`/`Set` keyed by vertex), so memory scales with **vertices actually visited** rather than total vertex count. Vertex features are fetched lazily through the same byte source as everything else — A* on a 50 GB road network only touches the bytes for vertices the search visits.

### 6. Working with remote files

`FlatGeoGraphBuf.open()` accepts any `ByteReader`, and the library ships one for HTTP:

```typescript
import { FlatGeoGraphBuf, byteReaderFromUrl } from 'flatgeographbuf/geojson';

const fgg = await FlatGeoGraphBuf.open(
    byteReaderFromUrl('https://example.com/network.fgg', {
        headers: { Authorization: 'Bearer …' },   // optional
        nocache: true,                            // optional, sets Cache-Control: no-cache
    }),
);

// From here, every method is identical to the in-memory case — they
// just emit HTTP `Range:` requests under the hood.
const path = await fgg.shortestPath(0, 9999);
```

Requirements:
- The server must honour byte-range requests (return HTTP 206 with the requested slice). Most static-file servers, S3, GCS, Cloudflare R2, etc. do this out of the box.
- For the one-shot `preload()` path (see next guide), the server must also accept a plain GET (200 with the full body). That's universal.

### 7. Performance tuning: when to preload, when to release

By default every method on `FlatGeoGraphBuf` is **lazy** — it fetches the minimum bytes needed and caches what it parsed. That's the right behaviour for huge files and sparse queries. For smaller files (and for "I'm going to hit this graph hard" workloads) you can warm caches up front:

```typescript
// One bulk transfer that fills features, edges and both R-trees.
// With `byteReaderFromUrl`, this is a SINGLE plain GET (no Range needed).
await fgg.preload();

// Every subsequent call is now zero-I/O.
for await (const _ of fgg.featuresInBbox(rect)) { /* … */ }
const path = await fgg.shortestPath(0, 9999);
```

When the file is too big to preload but you'll run many spatial queries, warm just the indices:

```typescript
await fgg.loadIndices();
// Vertex + edge R-tree traversal is now local; feature/edge payloads
// stay lazy and only the matching ones are fetched.
```

Reclaim memory after a batch finishes:

```typescript
fgg.release();              // drop everything
fgg.releaseFeatures();      // or just the feature objects
fgg.releaseEdges();         // …
fgg.releaseIndices();
```

The full breakdown (cost vs benefit per method) lives in the [API reference](#api-reference) under *Class `FlatGeoGraphBuf` → Cache lifecycle*.

### 8. Plugging in a custom byte source

`FlatGeoGraphBuf` itself never opens a socket or touches the filesystem — that's the `ByteReader`'s job. The interface is two methods, one of them optional:

```typescript
interface ByteReader {
    read(offset: number, length: number): Promise<Uint8Array>;
    readAll?(): Promise<Uint8Array>;   // optional, enables single-shot preload
}
```

The library ships two implementations:

- `byteReaderFromUint8Array(bytes)` — for an in-memory buffer (zero-copy).
- `byteReaderFromUrl(url, options?)` — for any URL whose server supports byte ranges.

For anything else — `fs.read`, `mmap`, IndexedDB, React Native's filesystem libraries, a custom HTTP/2 client — implement the interface yourself:

```typescript
import { FlatGeoGraphBuf, type ByteReader } from 'flatgeographbuf/geojson';
import { promises as fs } from 'node:fs';

const handle = await fs.open('huge.fgg', 'r');
const reader: ByteReader = {
    async read(offset, length) {
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async readAll() {
        return new Uint8Array(await fs.readFile('huge.fgg'));
    },
};
const fgg = await FlatGeoGraphBuf.open(reader);
```

Implementing `readAll()` is optional but recommended — it turns `preload()` into a single round-trip and lets the library work even with sources that don't support byte ranges.

### 9. Property indices: text, number, boolean searches

Need to find a feature by name, filter edges by length, or locate vertices in a numeric range without scanning the whole graph? Declare which columns to index at write time and use `findVerticesBy*` / `findEdgesBy*` at read time.

```typescript
import { serialize, FlatGeoGraphBuf } from 'flatgeographbuf/geojson';

const bytes = serialize(geojson, adjacency, {
    columnIndex: {
        vertices: ['name', 'icao', 'elev_ft', 'intl'],
        edges:    ['road', 'km', 'paved'],
    },
});

const fgg = await FlatGeoGraphBuf.open(bytes);

// Text — tokenises the query, AND-intersects on token prefixes.
// Each hit carries the matched feature plus a `tier` label
// ('A' | 'B' | 'C') describing how well it matched.
for await (const hit of fgg.findVerticesByText('name', 'rio preto')) {
    console.log(hit.tier, hit.feature.properties.name);
}

// Numeric ranges — return features directly (no tier ranking)
for await (const f of fgg.findVerticesByValue('elev_ft', { gte: 1000, lt: 5000 })) { … }
for await (const f of fgg.findVerticesByValue('elev_ft', { eq: 1200 })) { … }

// Booleans
for await (const f of fgg.findVerticesByValue('intl', { eq: true })) { … }

// Edges work the same way — text hits yield `{ edge, tier }`
for await (const hit of fgg.findEdgesByText('road', 'br-1')) {
    console.log(hit.tier, hit.edge.properties.road);
}
for await (const e of fgg.findEdgesByValue('km', { gt: 500 }, { limit: 10 })) { … }
```

**Type inference**: the writer inspects the first non-null value of each declared column. `string` → text index, `number` → numeric range index, `boolean` → posting list.

**Text search**:
- **Normalisation**: NFKD + diacritic strip + lowercase. `"São José"` → `"sao jose"`.
- **Tokenisation**: split on Unicode whitespace, punctuation, and symbols. `"BR-116"` → `["br", "116"]`.
- **AND-intersect**: every query token must match (in any order).
- **Three match modes** via `{ match: 'prefix' | 'token' | 'exact' }`:
  - `'prefix'` (default) — `"rio pre"` matches "São José do Rio **Pre**to".
  - `'token'` — each query token must be a full indexed token (no prefix). Use for code lookups like ICAO.
  - `'exact'` — the entire normalised query equals the entire indexed value's token sequence.
- **Ranked output**: hits come back in tier order then earliest match position. Each hit exposes its `tier`:
  - **`'A'`** — query tokens appear consecutive and in the query's order
  - **`'B'`** — in order with gaps
  - **`'C'`** — present, possibly out of order

  Pass `{ limit: 20 }` for top-K truncation.

**Composes with spatial filter**: collect results from `featuresInBbox` and `findVerticesByText` into Sets, then intersect (or use the hit's `feature` directly when joining).

**Storage**: ~1.5 MB per text column for 50 k features × 2-3 words each, ~600 KB for numeric columns. Linear in the number of records × average tokens per value.

---

## API reference

### Public surface at a glance

Everything below is importable from `flatgeographbuf/geojson` (and re-exported from the root barrel `flatgeographbuf`).

| Symbol | Kind | One-liner |
| --- | --- | --- |
| `serialize(geojson, adjacencyList?, options?)` | function | Encode a GeoJSON FeatureCollection + optional graph to FGG bytes. |
| `deserialize(bytes, metaFn?)` | async function | Decode every feature and every edge from an in-memory FGG buffer. |
| `FlatGeoGraphBuf` | class | Random-access reader for one FGG source (in-memory or remote). |
| `ByteReader` | interface | Minimal abstraction for "give me bytes at offset/length". |
| `byteReaderFromUint8Array(bytes)` | factory | Wrap an in-memory `Uint8Array` as a `ByteReader`. |
| `byteReaderFromUrl(url, opts?)` | factory | Wrap an HTTP URL as a `ByteReader` (uses `Range:` for `read`, plain GET for `readAll`). |
| `SerializeOptions` | type | `crsCode` / `writeIndex` / `writeAdjacencyIndex` / `writeEdgeIndex`. |
| `ShortestPathOptions` / `ShortestPathResult` | types | Pathfinding I/O. |
| `EdgeWeightFn` / `HeuristicFn` | types | Pluggable cost/heuristic for `shortestPath`. |
| `Edge` / `EdgeInput` / `EdgeProperties` | types | Edge value shape (`from`, `to`, optional `geometry`, `properties`). |
| `AdjacencyList` / `AdjacencyListInput` | types | `{ edges: Edge[] }`. |
| `DeserializeGraphResult<T>` | type | `{ features: T[]; adjacencyList: AdjacencyList }`. |
| `FeaturesHeaderMeta` / `GraphHeaderMeta` / `FlatGeoGraphBufMeta` / `FlatGeoGraphBufMetaFn` | types | Metadata exposed by the optional `metaFn` callback on `deserialize`. |
| `UrlReaderOptions` | type | Options accepted by `byteReaderFromUrl`. |

Nothing else is public. Anything else you find in the source tree is implementation detail and may change without notice.

### Types

```typescript
import type { LineString } from 'geojson';

interface EdgeInput {
    from: number;
    to: number;
    geometry?: LineString | null; // Optional LineString path; null/omitted = straight line
    properties?: EdgeProperties;  // Optional on input
}

interface Edge {
    from: number;
    to: number;
    geometry: LineString | null;  // Always present on output; null when no path was stored
    properties: EdgeProperties;   // Always present on output (empty {} if none)
}

interface EdgeProperties {
    [key: string]: boolean | number | string | object | Uint8Array;
}

interface AdjacencyListInput {
    edges: EdgeInput[];
}

interface AdjacencyList {
    edges: Edge[];
}

interface DeserializeGraphResult<T> {
    features: T[];
    adjacencyList: AdjacencyList;
}

interface FeaturesHeaderMeta {
    featuresCount: number;
    columns: ColumnMeta[] | null;
    geometryType: GeometryType;
    envelope: Float64Array | null;
    indexNodeSize: number;
    crs: CrsMeta | null;
    title: string | null;
    description: string | null;
    metadata: string | null;
}

interface GraphHeaderMeta {
    edgeCount: number;
    edgeColumns: ColumnMeta[] | null;
    hasAdjacencyIndex: boolean; // true when writeAdjacencyIndex was used
    hasEdgeIndex: boolean;      // true when writeEdgeIndex was used
}

interface FlatGeoGraphBufMeta {
    features: FeaturesHeaderMeta;
    graph: GraphHeaderMeta | null;
}

type FlatGeoGraphBufMetaFn = (meta: FlatGeoGraphBufMeta) => void;
```

### Top-level functions

#### `serialize`

```typescript
function serialize(
    geojson: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array;

interface SerializeOptions {
    crsCode?: number;              // EPSG code   (default: 4326 / WGS84)
    writeIndex?: boolean;          // vertex R-tree                 (default: true)
    writeAdjacencyIndex?: boolean; // edge CSR (sort edges by from) (default: true)
    writeEdgeIndex?: boolean;      // edge R-tree                   (default: true)
}
```

- **Returns:** a new `Uint8Array` containing the full FGG file.
- **Throws:** on invalid `edge.from` / `edge.to` (out of range or self-loops), on non-LineString edge geometry, on LineStrings with fewer than 2 coordinates.
- **Side effects:** none. Input collections are not mutated.
- **Index trade-offs:**

  | Option | Cost | Unlocks |
  | --- | --- | --- |
  | `writeIndex` | reorders features along the Hilbert curve; auto-remaps `edge.from` / `edge.to` so references stay correct | `fgg.featuresInBbox(rect)` and O(1) `fgg.getFeature(i)` |
  | `writeAdjacencyIndex` | sorts edges by `from` (stable); writes an `[N+1]` offsets table | `fgg.outgoingEdgesOf(v)` and `fgg.shortestPath` |
  | `writeEdgeIndex` | builds a packed Hilbert R-tree over edge bboxes | `fgg.edgesInBbox(rect)` |

  `writeAdjacencyIndex` and `writeEdgeIndex` are silently ignored when no `adjacencyList` is supplied.

#### `deserialize`

```typescript
function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatGeoGraphBufMetaFn,
): Promise<DeserializeGraphResult<IGeoJsonFeature>>;

interface DeserializeGraphResult<T> {
    features: T[];
    adjacencyList: AdjacencyList;          // { edges: Edge[] } — `edges` is `[]` when no graph section
}
```

- **Requires:** `bytes` is a complete in-memory FGG buffer.
- **Returns:** every feature parsed into a GeoJSON object and every edge as an `Edge`.
- **Throws:** when `bytes` is not a valid FGG file or is truncated.
- **Side effects:** the optional `metaFn` is invoked once before features are materialized so you can inspect header / graph metadata up-front (counts, column schemas, R-tree presence flags).
- **Use it for:** small or medium files that fit in memory. For multi-gigabyte sources or sparse queries, use `FlatGeoGraphBuf.open` instead.

```typescript
const { features, adjacencyList } = await deserialize(bytes, (meta) => {
    console.log(meta.features.featuresCount, meta.features.columns);
    if (meta.graph) console.log(meta.graph.edgeCount, meta.graph.hasAdjacencyIndex);
});
```

### Class `FlatGeoGraphBuf`

Random-access reader. Open one `FlatGeoGraphBuf` per FGG source and reuse the instance for every query — methods are async, results are cached per instance, and I/O is driven through a pluggable `ByteReader` so the same code runs on Node, browsers and React Native.

```typescript
class FlatGeoGraphBuf {
    readonly reader: ByteReader;
    readonly featureHeader: FeaturesHeaderMeta;
    readonly featureCount: number;
    readonly layout: GraphSectionLayout;
    readonly featuresStart: number;
    readonly featuresLength: number;

    static open(source: Uint8Array | ByteReader): Promise<FlatGeoGraphBuf>;

    // Feature access (vertex side of the graph)
    getFeature(index: number): Promise<IGeoJsonFeature>;
    features(): AsyncGenerator<IGeoJsonFeature>;
    featuresInBbox(rect: Rect): AsyncGenerator<IGeoJsonFeature>;

    // Edge access (graph side)
    outgoingEdgesOf(vertexIdx: number): AsyncGenerator<Edge>;
    allEdges(): AsyncGenerator<Edge>;
    edgesInBbox(rect: Rect): AsyncGenerator<Edge>;

    // Property-index queries
    findVerticesByText(column: string, query: string, options?: TextQueryOptions):
        AsyncGenerator<{ feature: IGeoJsonFeature; tier: 'A' | 'B' | 'C' }>;
    findVerticesByValue(column: string, predicate: ValuePredicate, options?: ValueQueryOptions):
        AsyncGenerator<IGeoJsonFeature>;
    findEdgesByText(column: string, query: string, options?: TextQueryOptions):
        AsyncGenerator<{ edge: Edge; tier: 'A' | 'B' | 'C' }>;
    findEdgesByValue(column: string, predicate: ValuePredicate, options?: ValueQueryOptions):
        AsyncGenerator<Edge>;

    // Whole-graph materialisation (warms caches, then returns the
    // same shape as the top-level `deserialize()` function).
    toGeoJson(): Promise<{ features: IGeoJsonFeature[]; adjacencyList: AdjacencyList }>;

    // Pathfinding
    shortestPath(
        from: number,
        to: number,
        options?: ShortestPathOptions,
    ): Promise<ShortestPathResult | null>;

    // Eager cache warmup (single bulk transfer when supported by the reader)
    loadFeatures(): Promise<IGeoJsonFeature[]>;
    loadEdges(): Promise<void>;
    loadIndices(): Promise<void>;
    loadPropertyIndices(): Promise<void>;
    preload(): Promise<void>;

    // Synchronous cache release
    release(): void;
    releaseFeatures(): void;
    releaseEdges(): void;
    releaseIndices(): void;
    releasePropertyIndices(): void;
}
```

#### `FlatGeoGraphBuf.open(source)`

- **`source`**: a `Uint8Array` (everything already in memory) or any object implementing `ByteReader` (lazy byte-range source: HTTP, `fs.read`, mmap, …).
- **I/O budget:** ~3–5 small reads totalling ~few KB regardless of file size. Reads the magic bytes, the FlatGeobuf header, and one R-tree leaf (when present) to find the graph section. **No feature payload or edge data is touched.** Safe on multi-gigabyte sources.
- **Throws:** invalid magic, truncated header, malformed graph section.
- **Returns:** a `FlatGeoGraphBuf` instance with header metadata and graph layout exposed via the readonly properties above.

```typescript
const fgg = await FlatGeoGraphBuf.open(bytes);
const fgg = await FlatGeoGraphBuf.open(byteReaderFromUrl('https://example.com/network.fgg'));
```

#### Feature methods

| Method | Returns | Requires (writer-side) | Notes |
| --- | --- | --- | --- |
| `getFeature(i)` | `Promise<IGeoJsonFeature>` | nothing | O(1) read with vertex R-tree; falls back to a one-shot bulk load otherwise. Cached per `i` for the lifetime of the instance. |
| `features()` | `AsyncGenerator<IGeoJsonFeature>` | nothing | Yields every vertex in storage order. |
| `featuresInBbox(rect)` | `AsyncGenerator<IGeoJsonFeature>` | `writeIndex: true` | Spatial filter via vertex R-tree. Returns every feature whose stored bbox intersects `rect`; do exact geometry tests downstream if needed. |

All three methods populate the per-index feature cache; subsequent calls on the same index serve from memory. They throw out-of-range errors for invalid indices and `"writeIndex: true"` errors for `featuresInBbox` when the file has no vertex R-tree.

#### Edge methods

| Method | Returns | Requires (writer-side) | Notes |
| --- | --- | --- | --- |
| `outgoingEdgesOf(v)` | `AsyncGenerator<Edge>` | `writeAdjacencyIndex: true` | Yields edges whose `from === v`, in stable-sorted storage order. Per-vertex result is cached. |
| `allEdges()` | `AsyncGenerator<Edge>` | nothing | Yields every edge in storage order. |
| `edgesInBbox(rect)` | `AsyncGenerator<Edge>` | `writeEdgeIndex: true` | Spatial filter via edge R-tree. Returns **every** edge with any bbox overlap, including LineStrings that only partially cross the query rectangle. |

All three respect the eager cache populated by `loadEdges` / `preload`: when the edges section bytes are cached, no further I/O is performed.

#### `fgg.shortestPath(from, to, options?)`

```typescript
interface ShortestPathOptions {
    weight?: EdgeWeightFn;                            // default: distance
    heuristic?: HeuristicFn | 'haversine' | null;     // default: 'haversine'
}

type EdgeWeightFn = (distance: number, properties: EdgeProperties) => number;
type HeuristicFn  = (vertex: IGeoJsonFeature, target: IGeoJsonFeature) => number;

interface ShortestPathResult {
    vertices: IGeoJsonFeature[];   // path nodes from `from` to `to` inclusive
    edges: Edge[];                 // edges[i] connects vertices[i] → vertices[i+1]
    cost: number;                  // sum of weight() over edges
}
```

- **Requires:** the file was serialized with `writeAdjacencyIndex: true` (the default).
- **Coordinates:** assumed `[longitude, latitude]` in degrees; geodesic distance uses haversine on the WGS84 mean radius (6 371 008.8 m).
- **Weight:** `distance` is the haversine length of the edge in metres — sum over LineString vertices when geometry is present, straight line between endpoints otherwise.
- **Heuristic:**
  - `'haversine'` (default) — A* with straight-line distance between vertex Points. Admissible when `weight(d, …) ≤ d`.
  - `(vertex, target) => number` — custom A* heuristic; must never overestimate the true remaining cost, or A* may return a suboptimal path.
  - `null` — disables A*, runs plain Dijkstra.
- **Returns:** the path, or `null` when no path exists. When `from === to` returns a one-vertex / zero-edge result with `cost: 0`.
- **Throws:** out-of-range indices; `"writeAdjacencyIndex"` error when the file has no CSR; `"Edge weight must be …"` when `weight` returns NaN, Infinity, or a negative value.
- **Memory model:** the search state is sparse (`Map`/`Set`), so memory scales with vertices visited rather than total vertex count — viable on graphs with billions of vertices. Vertex features are fetched lazily and cached on the instance, so repeated `shortestPath` calls on the same `fgg` reuse them.

```typescript
// A* with default haversine heuristic, weight = geodesic distance in metres
const path = await fgg.shortestPath(srcIdx, dstIdx);

// Travel time at the road's speed limit
const fast = await fgg.shortestPath(srcIdx, dstIdx, {
    weight: (distance, props) => distance / (Number(props.speed_kmh ?? 50) * 1000 / 3600),
    heuristic: null,                       // custom weight ≠ distance → disable haversine
});
```

#### Cache lifecycle: `load*` / `preload` / `release*`

All read methods populate caches on the way. The eager helpers below let you front-load that work or release the memory it occupies. Every method is idempotent.

| Method | Async? | Issues I/O? | What it touches | Use when |
| --- | --- | --- | --- | --- |
| `loadFeatures()` | yes | yes (1 bulk read) | feature cache | you plan to query most/all features |
| `loadEdges()` | yes | yes (2 bulk reads with CSR; falls back to streaming without) | per-vertex outgoing-edges cache + edges-section bytes cache | you plan to traverse a meaningful slice of the graph |
| `loadIndices()` | yes | yes (1 bulk read per R-tree present) | vertex + edge R-tree byte caches | many spatial queries on a large remote file (cheaper than full preload) |
| `preload()` | yes | yes (**1 request** via `readAll` when supported; 3–4 otherwise) | everything above | small / medium files that fit in memory and benefit from one-shot transfer |
| `release()` | no (sync) | no | every cache | reclaim memory between batches |
| `releaseFeatures()` / `releaseEdges()` / `releaseIndices()` | no | no | one cache | fine-grained eviction |

> **Caveat for remote sources.** `preload` and the individual `load*` methods transfer essentially the entire file. Use them only when the data fits in memory and you intend to query enough of it that the upfront cost pays off. For multi-gigabyte remote files keep relying on the lazy methods; `loadIndices()` is a useful middle ground (R-trees in memory, payloads still lazy).

```typescript
await fgg.preload();              // one bulk transfer when reader.readAll exists
// every subsequent call is zero-I/O
const path = await fgg.shortestPath(0, 9999);
for await (const _ of fgg.featuresInBbox(rect)) { /* … */ }

fgg.release();                    // give the memory back
```

### `ByteReader` interface

The library is transport-agnostic. `FlatGeoGraphBuf.open()` accepts any object that implements:

```typescript
interface ByteReader {
    /**
     * MUST return exactly `length` bytes starting at `offset`. Throw
     * (or reject) if fewer bytes are available.
     */
    read(offset: number, length: number): Promise<Uint8Array>;

    /**
     * Optional "give me everything" shortcut. When implemented,
     * `FlatGeoGraphBuf.preload()` uses it to download the file in one
     * request (no Range negotiation, no need to know the total size
     * upfront).
     */
    readAll?(): Promise<Uint8Array>;
}
```

Two ready-made factories are shipped:

```typescript
function byteReaderFromUint8Array(bytes: Uint8Array): ByteReader;

interface UrlReaderOptions {
    headers?: HeadersInit;
    nocache?: boolean;
}
function byteReaderFromUrl(url: string, options?: UrlReaderOptions): ByteReader;
```

- `byteReaderFromUint8Array` — zero-copy `subarray` views; `readAll` returns the original buffer.
- `byteReaderFromUrl` — uses global `fetch` (Node ≥ 18, browser, React Native). `read` issues `Range:` requests (server must reply with HTTP 206 / 200 honouring the range); `readAll` does a plain GET.

For everything else — `fs.read`, mmap, IndexedDB, React Native filesystem libs, custom HTTP/2 clients — implement the interface yourself:

```typescript
import { FlatGeoGraphBuf, type ByteReader } from 'flatgeographbuf/geojson';
import { promises as fs } from 'node:fs';

const handle = await fs.open('huge.fgg', 'r');
const reader: ByteReader = {
    async read(offset, length) {
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async readAll() {
        return new Uint8Array(await fs.readFile('huge.fgg'));
    },
};
const fgg = await FlatGeoGraphBuf.open(reader);
```

Implementing `readAll` is optional but recommended — it turns `preload()` into a single round-trip transfer.

## Binary Format

FlatGeoGraphBuf uses FlatGeobuf's encoding for features and appends an optional graph section:

```
[FGG Magic: 8B] [Header: 4B+var] [Vertex R-Tree?] [Features...]
[Graph Section?]:
    [Graph Header Size: 4B] [Graph Header]
    [Adjacency Block?] [Edge R-Tree Block?]
    [Edges...]
```

- **FGG Magic**: `0x6667670266676700` ("fgg\x02fgg\x00")
- **Header/Features/Vertex R-Tree**: Same encoding as FlatGeobuf. The
  vertex R-tree is present when `header.indexNodeSize > 0`.
- **Graph Header**: `[edgeCount: 4B][columnCount: 2B][columns...][indexFlags: 1B]`.
  Bit 0 of `indexFlags` = adjacency block present, bit 1 = edge R-tree block present.
- **Adjacency Block** (optional): `[blockSize: 4B][offsets: 4B × (N+1)]` —
  CSR byte offsets into the edges section. Requires edges to be physically
  sorted by `from`.
- **Edge R-Tree Block** (optional): `[blockSize: 4B][rtreeBytes...]` —
  packed Hilbert R-tree where each leaf's `offset` is the edge's byte
  position within the edges section.
- **Edges**: Size-prefixed records with
  `[from: 4B][to: 4B][pointCount: 4B][coords...][properties...]`.
  - `pointCount = 0` means no path geometry (implicit straight line between vertices).
  - When `pointCount > 0`, coordinates are stored as 2D `[X: 8B][Y: 8B]` pairs (only LineString supported on edges).

Edge properties use the same encoding as FlatGeobuf feature properties, supporting:
- Boolean, integers (8/16/32/64 bit signed/unsigned)
- Float, Double
- String, DateTime, JSON, Binary

See [doc/format-spec.md](doc/format-spec.md) for detailed specification.

## Design Decisions

### Optional Edge Path Geometry
Each edge may carry a `LineString` describing the actual path of the
connection between the two vertices (useful for curved roads, transmission
lines following terrain, etc.). When no geometry is stored (`geometry: null`
or omitted), consumers should treat the edge as a straight line between
the source and target vertex coordinates.

```typescript
{ from: 0, to: 1 }                                 // straight line, no path stored
{ from: 0, to: 1, geometry: null }                 // same as above
{ from: 0, to: 1, geometry: {                       // explicit path
    type: 'LineString',
    coordinates: [[0, 0], [0.4, 0.7], [1, 1]],
}}
```

Only `LineString` is accepted on edges. Vertices remain `Point` (or any
geometry supported by the underlying FlatGeobuf features section).

### Directed Edges
Edges are always directed (from -> to). For bidirectional connections, create two edges.

### No Self-Loops
Self-loops (from === to) are not allowed and will throw an error during serialization.

### Vertex References
Edges reference vertices by their index in the GeoJSON FeatureCollection (0-based).

### Backward Compatibility
New properties can be added to edges without breaking readers that don't expect them - they're simply ignored during parsing, just like FlatGeobuf feature properties.

## Performance

FlatGeoGraphBuf inherits FlatGeobuf's performance characteristics:
- Zero-copy deserialization where possible
- Size-prefixed records for efficient streaming
- No compression overhead (can be compressed externally)

The graph section is optimized for decode performance:
- Fixed-size edge header (from/to indices)
- Same property encoding as features (proven efficient)
- Sequential edge reading

## Use Cases

- Road networks with intersection/segment topology
- Utility networks (power, water, telecom)
- Transportation graphs (routes, connections)
- Any geospatial graph where features represent nodes and edges represent relationships

## License

BSD-3-Clause

## Credits

Based on [FlatGeobuf](https://github.com/flatgeobuf/flatgeobuf) by Bjorn Harrtell.
