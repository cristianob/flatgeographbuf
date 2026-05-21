# Changelog

All user-facing changes to the `flatgeographbuf` npm package. Format
follows [Keep a Changelog](https://keepachangelog.com/). Wire-format
changes are tracked separately in
[`doc/format-changelog.md`](doc/format-changelog.md).

## 2.1.0

Property indices on vertex features and edges — text, number, and
boolean columns. **Format change:** the binary layout grows a 1-byte
`indexFlags` trailer after the vertex R-tree (padded to 8 bytes for
alignment) and a new optional block in the graph section. 2.0.0
readers cannot open 2.1.0 files; 2.1.0 readers can open 2.0.0 files
with no property indices, because the indexFlags is just `0` there.

### Added

- **`columnIndex`** option on `serialize()`:
  ```typescript
  serialize(geojson, adjacency, {
      columnIndex: {
          vertices: ['name', 'icao', 'elev_ft', 'active'],
          edges: ['road', 'km', 'paved'],
      },
  });
  ```
  Writer infers per-column type (string → text index, number → numeric
  index, boolean → posting lists) and emits one block per side.
- **Text query**: `findVerticesByText(column, query, options?)` and
  `findEdgesByText(column, query, options?)`. The query is normalised
  (NFKD + diacritic strip + lowercase) and tokenised. AND-intersect
  across all query tokens.
- **Three match modes**:
  - `'prefix'` (default): each query token can be a prefix of an
    indexed token. `findByText('name', 'rio pre')` matches
    "São José do Rio Preto".
  - `'token'`: each query token must equal an indexed token exactly.
  - `'exact'`: the full normalised query must equal the entire
    indexed value's token sequence.
- **Ranked results** for text queries:
  - Tier A: query tokens appear consecutive and in order
  - Tier B: in order with gaps
  - Tier C: present but out of order
  Within a tier, earlier match position ranks first.
- **Value query**: `findVerticesByValue(column, predicate, options?)`
  and `findEdgesByValue(column, predicate, options?)`. `predicate`
  is `{ eq?, lt?, lte?, gt?, gte? }`. Number columns support ranges;
  boolean columns support `eq: true/false`.
- **`limit`** option on all `findBy*` methods.
- **Cache lifecycle**: `loadPropertyIndices()` warms both vertex and
  edge property index blocks; `releasePropertyIndices()` drops them.
  Both are automatically driven by `preload()` / `release()`.

### Wire format

- Vertex section gains a 1-byte `indexFlags` trailer after the
  optional vertex R-tree. Bit `0x01` signals a vertex property index
  block follows (length-prefixed). The whole trailer is padded to a
  multiple of 8 bytes so the features section stays Float64-aligned.
- Graph section gains `indexFlags` bit `0x04` for an edge property
  index block, sitting between the edge R-tree and the edges payload.
- Both layouts are forward-compatible: readers skip blocks with
  unknown `indexFlags` bits via their 4-byte size prefix, instead of
  misinterpreting bytes.

## 2.0.0

First production release. **This is a breaking change** vs. every 1.x —
the API was redesigned around an OO reader and a pluggable byte source.

### Wire format

- **Magic-bytes major version bumped to `0x02`** (`fgg\x02fgg\x00`).
  1.x files are no longer accepted. The byte layout itself is unchanged
  vs. 1.1.0 — the bump exists to make pre-release files explicitly
  format-incompatible.

### Added

- **ESM bundles in `dist/`** (`flatgeographbuf.esm.min.js`,
  `flatgeographbuf-geojson.esm.min.js`) alongside the existing UMD
  bundles, so browsers can `import` directly from the dist files
  without a bundler.

- **`FlatGeoGraphBuf` class** — random-access reader. Open once,
  reuse for many queries. Methods:
  - `static open(source)` — accepts `Uint8Array` or `ByteReader`,
    parses ~few KB of metadata regardless of file size.
  - `getFeature(i)`, `features()`, `featuresInBbox(rect)` — vertex
    access (lazy + cached).
  - `outgoingEdgesOf(v)`, `allEdges()`, `edgesInBbox(rect)` — edge
    access (lazy + cached).
  - `shortestPath(from, to, options?)` — A* / Dijkstra with sparse
    search state and lazy feature loading; viable on huge graphs.
  - `loadFeatures` / `loadEdges` / `loadIndices` / `preload` — eager
    cache warming (`preload` does a single bulk transfer when the
    reader exposes `readAll`).
  - `release` / `releaseFeatures` / `releaseEdges` / `releaseIndices`
    — synchronous cache eviction.
- **`ByteReader` interface** (platform-agnostic byte-range source) +
  `byteReaderFromUint8Array` and `byteReaderFromUrl` factories.
- **Edge `geometry`** field (optional `LineString`) describes the path
  of each connection. `null` = straight line between endpoints.
- **`writeAdjacencyIndex`** and **`writeEdgeIndex`** options on
  `serialize` — write a CSR adjacency table and/or a packed edge
  R-tree alongside the data. Both on by default.
- **`writeIndex: true`** is now the default for vertex R-tree as well.
- **`crsCode` defaults to 4326 (WGS84).**
- Sparse search state for `shortestPath` (Map/Set keyed by visited
  vertex) so memory scales with visited vertices, not total vertex
  count.

### Changed (breaking)

- `serialize` no longer accepts a plain number as its third argument
  (was a legacy `crsCode` overload). Pass `{ crsCode: ... }` instead.
- `FlatGeoGraphBuf.open` (formerly free function `openGraph`) is now
  `async` and returns a Promise. All query methods are async (return
  Promises or `AsyncGenerator`).
- `GraphHeaderMeta` gained `hasAdjacencyIndex` and `hasEdgeIndex`
  flags reflecting which indices the file actually carries.

### Removed (breaking)

- Free functions `openGraph`, `outgoingEdgesOf`, `edgesInBbox`,
  `shortestPath` are gone. Use the corresponding methods on
  `FlatGeoGraphBuf`.
- `deserializeStream`, `deserializeFiltered`, `deserializeGraphEdges`
  are no longer part of the public surface. The same use cases are
  covered by `FlatGeoGraphBuf.open(...)` + `features()` /
  `featuresInBbox(rect)` / `allEdges()` / `outgoingEdgesOf(v)`.
- `GraphContext` type — replaced by the `FlatGeoGraphBuf` class.
- `haversine` and `edgeHaversineLength` helpers — internal details of
  `shortestPath` now.

### Performance

- `FlatGeoGraphBuf.open` is O(1) in I/O: header + one R-tree leaf +
  graph header (~few KB), regardless of file size.
- `preload()` uses a single round-trip when `ByteReader.readAll` is
  available; otherwise 2 range requests via the CSR sentinel.
- `outgoingEdgesOf(v)` issues at most 2 reads (CSR offsets + vertex
  span) in the cold lazy path — was 1 + 2×degree.
- `getFeature(i)` / `readEdgeAt` use speculative 1 KB reads to fetch
  size-prefix + payload in a single round-trip when the record fits.
- `shortestPath` loads only the features it actually visits.

## 1.1.0

Wire-format additions;. See
[`doc/format-changelog.md`](doc/format-changelog.md#flatgeographbuf-110)
for the byte-level details (edge LineString geometry, vertex R-tree,
adjacency CSR, edge R-tree, `indexFlags`).

## 1.0.0

Initial FGG concept based on FlatGeobuf.
