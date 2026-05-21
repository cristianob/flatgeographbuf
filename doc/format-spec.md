# FlatGeoGraphBuf Format Specification

Version 2.0.0

## Overview

FlatGeoGraphBuf is a binary format for geospatial graphs. It uses FlatGeobuf's encoding for features (vertices) and appends a graph section containing adjacency list information, optionally augmented with adjacency and spatial indices for random access.

## File Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FGG HEADER                                        │
├──────────────────────────────────────────────────────────────────────┤
│ Magic Bytes (8B)             │ 0x6667670266676700 ("fgg\x02fgg\x00") │
│ Header Size (4B)             │ uint32 little-endian                  │
│ Header (FlatBuffer)          │ FlatGeobuf-style header               │
│ Vertex R-Tree (optional)     │ Packed Hilbert R-Tree over features   │
│ Features (variable)          │ Size-prefixed feature FlatBuffers     │
├──────────────────────────────────────────────────────────────────────┤
│                    GRAPH SECTION (optional)                          │
├──────────────────────────────────────────────────────────────────────┤
│ Graph Header Size (4B)       │ uint32 little-endian                  │
│ Graph Header                 │ Edge count + columns + indexFlags     │
│ Adjacency Block (optional)   │ CSR offsets, presence via indexFlags  │
│ Edge R-Tree Block (optional) │ Packed Hilbert R-Tree over edges      │
│ Edges (variable)             │ Size-prefixed edge records            │
└──────────────────────────────────────────────────────────────────────┘
```

The vertex R-tree is signalled by `header.indexNodeSize > 0` (FlatGeobuf convention). The graph adjacency and edge R-tree blocks are signalled by bits in the new `indexFlags` byte of the Graph Header (see below).

## Magic Bytes

8 bytes: `0x66 0x67 0x67 0x02 0x66 0x67 0x67 0x00`

- Bytes 0-2: ASCII "fgg"
- Byte 3: Major version (0x02)
- Bytes 4-6: ASCII "fgg"
- Byte 7: Patch version (0x00)

This identifies the file as FlatGeoGraphBuf format. The graph section follows directly after the features section without additional magic bytes.

## Graph Header

```
┌─────────────────────────────────────────────────────────────────┐
│ Edge Count (4B)         │ uint32 little-endian                  │
│ Column Count (2B)       │ uint16 little-endian                  │
│ Columns (variable)      │ Repeated column definitions           │
│ Index Flags (1B)        │ Bit 0: adjacency, Bit 1: edge R-tree  │
└─────────────────────────────────────────────────────────────────┘
```

### Index Flags

A single byte bit field at the end of the graph header signals which optional graph indices follow it:

| Bit | Mask   | Meaning                                                |
|-----|--------|--------------------------------------------------------|
| 0   | `0x01` | Adjacency (CSR) block is present                       |
| 1   | `0x02` | Edge R-tree block is present                           |

Setting either bit obliges the writer to emit the corresponding block immediately after the header. When the adjacency bit is set, edge records MUST be physically sorted by `from` so the CSR offsets describe contiguous spans of edges.

## Adjacency (CSR) Block

Present iff bit 0 of `indexFlags` is set. Provides O(1) lookup of the byte range containing every outgoing edge of a vertex.

```
┌─────────────────────────────────────────────────────────────────┐
│ Block Size (4B)         │ uint32 little-endian, = 4*(N+1)       │
│ Offsets (variable)      │ (N+1) uint32 little-endian values     │
└─────────────────────────────────────────────────────────────────┘
```

- `N` is the dataset's feature (vertex) count, taken from the FGG file header.
- `Offsets[v]` is the byte offset, **relative to the start of the edges section**, of the first edge whose `from == v`.
- `Offsets[N]` is a sentinel equal to the total byte length of the edges section.
- Vertices with no outgoing edges satisfy `Offsets[v] == Offsets[v+1]`.
- Edges are physically stored in stable-sorted order of `from`, so each vertex's outgoing edges occupy a contiguous byte range `[Offsets[v], Offsets[v+1])`.

## Edge R-tree Block

Present iff bit 1 of `indexFlags` is set. Provides bounding-box queries over edges using the same packed Hilbert R-tree layout used for the vertex index.

```
┌─────────────────────────────────────────────────────────────────┐
│ Block Size (4B)         │ uint32 little-endian                  │
│ R-Tree Nodes (variable) │ NODE_ITEM_BYTE_LEN bytes per node     │
└─────────────────────────────────────────────────────────────────┘
```

Each leaf node's `offset` field is the byte offset of the corresponding edge **within the edges section** (i.e. the same coordinate space as the adjacency offsets). The branching factor is fixed at 16 (matching FlatGeobuf's default), and leaves are laid out in Hilbert order over the dataset envelope.

Per-edge bounding boxes are computed as the union of:
- the LineString coordinates (when `Point Count > 0`), and
- the bounding boxes of the `from` and `to` vertex geometries.

Including the endpoint vertex bboxes guarantees that queries near a vertex catch every edge incident to it even when the LineString does not exactly start/end on the vertex point.

### Column Definition

Each column in the schema:

```
┌─────────────────────────────────────────────────────────────────┐
│ Name Length (2B)        │ uint16 little-endian                  │
│ Name (variable)         │ UTF-8 encoded string                  │
│ Type (1B)               │ ColumnType enum value                 │
└─────────────────────────────────────────────────────────────────┘
```

### Column Types

Same as FlatGeobuf:

| Value | Type     | Size     |
|-------|----------|----------|
| 0     | Byte     | 1 byte   |
| 1     | UByte    | 1 byte   |
| 2     | Bool     | 1 byte   |
| 3     | Short    | 2 bytes  |
| 4     | UShort   | 2 bytes  |
| 5     | Int      | 4 bytes  |
| 6     | UInt     | 4 bytes  |
| 7     | Long     | 8 bytes  |
| 8     | ULong    | 8 bytes  |
| 9     | Float    | 4 bytes  |
| 10    | Double   | 8 bytes  |
| 11    | String   | variable |
| 12    | Json     | variable |
| 13    | DateTime | variable |
| 14    | Binary   | variable |

## Edge Record

```
┌─────────────────────────────────────────────────────────────────┐
│ Edge Size (4B)          │ uint32 little-endian                  │
│ From Index (4B)         │ uint32 little-endian                  │
│ To Index (4B)           │ uint32 little-endian                  │
│ Point Count (4B)        │ uint32 little-endian (0 = no path)    │
│ Path Coordinates (var)  │ X,Y doubles per point                 │
│ Properties (variable)   │ Property values                       │
└─────────────────────────────────────────────────────────────────┘
```

- **Edge Size**: Size of the edge data (from index + to index + path geometry + properties), NOT including this size field
- **From Index**: 0-based index of source vertex (feature in FlatGeobuf section)
- **To Index**: 0-based index of target vertex
- **Point Count**: Number of coordinate pairs in the optional LineString path. `0` means the edge has no geometry and represents an implicit straight line between the source and target vertices.
- **Path Coordinates**: When `Point Count > 0`, each point is encoded as two little-endian IEEE-754 doubles `[X: 8B][Y: 8B]`. Only 2D coordinates are supported. By convention the first point should match the source vertex and the last point should match the target vertex, but this is not enforced by the format.

### Path Geometry Constraints

1. When present, a LineString must have at least 2 coordinates.
2. Only `LineString` geometries are accepted on edges. Other geometry types (`Point`, `Polygon`, etc.) are not valid edge paths.
3. A null/absent path (`Point Count = 0`) means "straight line between vertices"; consumers MAY interpolate using the source and target vertex coordinates.

### Property Encoding

Same as FlatGeobuf feature properties:

```
[Column Index (2B)] [Value (variable)] ...
```

For each property:
1. Column index (uint16 little-endian) referencing the column schema
2. Value encoded based on column type

Variable-length types (String, Json, DateTime, Binary):
```
[Length (4B)] [Data (variable)]
```

## Constraints

1. **Directed edges**: All edges are directed from source to target
2. **No self-loops**: `from` must not equal `to`
3. **Valid indices**: Both `from` and `to` must be valid feature indices (0 to featuresCount-1)
4. **Nullable properties**: Properties with null values are omitted entirely

## Backward Compatibility

### Adding New Properties

New properties can be added to edges without breaking existing readers:
- Unknown column indices are skipped during parsing
- Readers process only columns they recognize

### Version Handling

- Major version changes (byte 3 of magic) indicate breaking changes
- Patch version changes (byte 7) are backward compatible
- Readers should accept any patch version for their supported major version

## Example

A graph with 2 nodes and 1 edge with a 3-point path and a `weight` property, no graph indices written:

```
Features: [{Point(0,0), name:"A"}, {Point(1,1), name:"B"}]
Edges: [{from:0, to:1, geometry:LineString[(0,0),(0.5,0.7),(1,1)], weight:1.5}]
```

Binary layout (hex, simplified):

```
# FGG Header + Features
66 67 67 02 66 67 67 00    # FGG magic
[header size + header + features...]

# Graph section (directly after features)
10 00 00 00                # Graph header size: 16 bytes
01 00 00 00                #   Edge count: 1
01 00                      #   Column count: 1
06 00                      #   Column 0 name length: 6
77 65 69 67 68 74          #   Column 0 name: "weight"
0A                         #   Column 0 type: Double (10)
00                         #   Index flags: 0x00 (no graph indices)

# Edge 0
46 00 00 00                # Edge size: 70 bytes (8 + 4 + 48 + 2 + 8)
00 00 00 00                # From: 0
01 00 00 00                # To: 1
03 00 00 00                # Point count: 3
00 00 00 00 00 00 00 00    # X0 = 0.0
00 00 00 00 00 00 00 00    # Y0 = 0.0
00 00 00 00 00 00 E0 3F    # X1 = 0.5
66 66 66 66 66 66 E6 3F    # Y1 = 0.7
00 00 00 00 00 00 F0 3F    # X2 = 1.0
00 00 00 00 00 00 F0 3F    # Y2 = 1.0
00 00                      # Property 0 column index: 0
00 00 00 00 00 00 F8 3F    # Property 0 value: 1.5 (double)
```

An edge without a path stores `Point Count = 0` and skips the coordinate block:

```
# Edge with no path
16 00 00 00                # Edge size: 22 bytes (8 + 4 + 2 + 8)
00 00 00 00                # From: 0
01 00 00 00                # To: 1
00 00 00 00                # Point count: 0 (no path; straight line implied)
00 00                      # Property 0 column index: 0
00 00 00 00 00 00 F8 3F    # Property 0 value: 1.5
```

### Example with adjacency CSR

Same graph header, but `indexFlags = 0x01`. Immediately after the graph header comes the CSR block:

```
01                         # Index flags: 0x01 (adjacency present)
                           # (graph header ends here)

# Adjacency block
0C 00 00 00                # Block size: 12 bytes = 4 * (N+1) for N=2 vertices
00 00 00 00                #   offsets[0] = 0   — vertex 0's outgoing edges start at byte 0
4A 00 00 00                #   offsets[1] = 74  — vertex 1 has no outgoing edges (= offsets[2])
4A 00 00 00                #   offsets[2] = 74  — sentinel: total edges length

# Edges (sorted by `from`): only the one above
[…edge 0 bytes …]
```

### Example with adjacency CSR + edge R-tree

```
03                         # Index flags: 0x03 (both blocks)

# Adjacency block
0C 00 00 00                # Block size: 12
00 00 00 00 4A 00 00 00 4A 00 00 00

# Edge R-tree block
50 00 00 00                # Block size: 80 bytes (2 nodes * 40 each, when N_edges=1)
[…leaf node + root node, 40 bytes each…]

# Edges follow
[…]
```
