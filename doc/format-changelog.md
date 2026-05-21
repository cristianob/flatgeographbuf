# Format specification changelog

## FlatGeoGraphBuf 2.1.0

Property indices on vertex features and edges. Forward-compatible
additions: 2.0.0 readers cannot open 2.1.0 files (they would land on
the new vertex `indexFlags` byte without knowing to skip it), but
2.1.0 readers can open 2.0.0 files if the writer used the new
forward-compat-aware reader. Magic bytes unchanged at `0x02`.

### Vertex section gains a length-prefixed extras trailer

After the optional vertex R-tree (or directly after the FlatBuffer
header when `indexNodeSize == 0`):

```
[vertex indexFlags: 1B]
[vertex extras blocks: variable]
[zero padding: 0–7B]    // pads the trailer to a multiple of 8 so the
                        // features section stays Float64-aligned
```

`vertex indexFlags` bits:

| Bit  | Meaning                                                  |
|------|----------------------------------------------------------|
| 0x01 | Vertex property index block follows (length-prefixed).   |

Unknown bits are honoured for forward compatibility: each set bit is
expected to have a corresponding `[size: 4B][content: size bytes]`
block, in bit order from LSB to MSB. Readers skip unknown blocks via
the size prefix.

### Graph section gains a new optional block

`graph indexFlags` adds bit `0x04` for an edge property index block,
sitting after the edge R-tree (bit `0x02`) and before the edges
payload. Same length-prefix convention as the other graph-section
blocks.

### Property index block layout

Used identically for vertices (in vertex section) and edges (in
graph section):

```
[block size: 4B]              # not counting this prefix
[text column count: 4B]
foreach text column:
    [name len: 4B][name: utf-8 bytes]
    [token pool size: 4B][token pool: \0-separated unique normalized tokens]
    [totalTokens size: 4B][totalTokens: uint16 × N]   # N = record count
    [entries size: 4B][entries: 10B × M]              # (tokenOffset:4, idx:4, position:2), sorted by token

[numeric column count: 4B]
foreach numeric column:
    [name len: 4B][name: utf-8 bytes]
    [entries size: 4B][entries: 12B × M]              # (value: f64 LE, idx: 4B), sorted by value asc

[bool column count: 4B]
foreach bool column:
    [name len: 4B][name: utf-8 bytes]
    [true list size: 4B][trueList: uint32 × T]        # sorted ascending
    [false list size: 4B][falseList: uint32 × F]
```

Normalisation for text columns ("FGG text normalization v1"): Unicode
NFKD decomposition + strip combining marks (`\p{Mn}`) + lowercase.
Tokenisation: split on `\s`, `\p{P}` (Unicode punctuation), and
`\p{S}` (Unicode symbols).

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
