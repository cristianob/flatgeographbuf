# Changelog

All user-facing changes to the `flatgeographbuf` npm package. Format
follows [Keep a Changelog](https://keepachangelog.com/). Wire-format
changes are tracked separately in
[`doc/format-changelog.md`](doc/format-changelog.md).

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
