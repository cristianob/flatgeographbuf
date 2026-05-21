# Format specification changelog

## FlatGeoGraphBuf 2.0.0

* Magic-bytes major version bumped to `0x02`
  (`fgg\x02fgg\x00` / `0x6667670266676700`). Files written by 1.x are
  not accepted; the wire layout itself is unchanged from 1.1.0 — the
  bump simply aligns with the npm package's 2.0 release and makes
  pre-release files (1.0 and 1.1) explicit format-incompatible.

## FlatGeoGraphBuf 1.1.0

Wire format additions and a complete set of graph indices. No
magic-byte bump — this is the first published evolution of the 1.0
schema.

### Edge geometry

* Edge records gain an optional LineString path geometry describing
  the shape of the connection between vertices.
* New edge record layout:
  `[size][from][to][pointCount][coords…][properties…]`.
* `pointCount = 0` means no geometry — the connection is the implicit
  straight line between the source and target vertices.
* Only `LineString` is supported on edges; LineStrings must have at
  least 2 coordinates and are encoded as 2D pairs of IEEE-754
  little-endian doubles.

### Vertex spatial index (writer)

* The packed Hilbert R-tree over features defined by upstream
  FlatGeobuf is now produced by the JS writer. Signalled by
  `header.indexNodeSize > 0` (same convention as FlatGeobuf).
* When written, features are reordered along the Hilbert curve and
  edge `from` / `to` are auto-remapped so references stay consistent.
* The dataset envelope is written into the FlatGeobuf header.

### Graph indices

* The graph header gains a trailing `indexFlags` byte signalling
  optional graph indices.
* **Adjacency CSR block** (bit 0 of `indexFlags`): an `[N+1]` array of
  `uint32` byte offsets into the edges section, enabling O(1) lookup
  of the byte span of every outgoing edge of a vertex. Requires edges
  to be physically sorted by `from` (stable sort, so input order is
  preserved within each vertex).
* **Edge R-tree block** (bit 1 of `indexFlags`): a packed Hilbert
  R-tree over edge bounding boxes for spatial queries over edges.
  Edge bboxes union the LineString coordinates with the endpoint
  vertex bboxes so queries near a vertex catch every edge incident to
  it.
* Both new blocks are length-prefixed (`uint32` size) and live between
  the graph header and the edges section.

## FlatGeoGraphBuf 1.0.0

* Initial FGG format: FlatGeobuf vertex section plus optional graph
  section with directed edges and edge properties.

---

The entries below describe upstream FlatGeobuf format versions, which
FlatGeoGraphBuf inherits for its vertex/feature section.
