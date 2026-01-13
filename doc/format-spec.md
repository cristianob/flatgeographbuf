# FlatGeoGraphBuf Format Specification

Version 1.0.0

## Overview

FlatGeoGraphBuf is a binary format for geospatial graphs. It uses FlatGeobuf's encoding for features (vertices) and appends a graph section containing adjacency list information.

## File Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                    FGG HEADER                                   │
├─────────────────────────────────────────────────────────────────┤
│ Magic Bytes (8B)        │ 0x6667670166676700 ("fgg\x01fgg\x00") │
│ Header Size (4B)        │ uint32 little-endian                  │
│ Header (FlatBuffer)     │ FlatGeobuf-style header               │
│ R-Tree Index (optional) │ Packed Hilbert R-Tree                 │
│ Features (variable)     │ Size-prefixed feature FlatBuffers     │
├─────────────────────────────────────────────────────────────────┤
│                    GRAPH SECTION (optional)                     │
├─────────────────────────────────────────────────────────────────┤
│ Graph Header Size (4B)  │ uint32 little-endian                  │
│ Graph Header            │ Edge count + edge column schema       │
│ Edges (variable)        │ Size-prefixed edge records            │
└─────────────────────────────────────────────────────────────────┘
```

## Magic Bytes

8 bytes: `0x66 0x67 0x67 0x01 0x66 0x67 0x67 0x00`

- Bytes 0-2: ASCII "fgg"
- Byte 3: Major version (0x01)
- Bytes 4-6: ASCII "fgg"
- Byte 7: Patch version (0x00)

This identifies the file as FlatGeoGraphBuf format. The graph section follows directly after the features section without additional magic bytes.

## Graph Header

```
┌─────────────────────────────────────────────────────────────────┐
│ Edge Count (4B)         │ uint32 little-endian                  │
│ Column Count (2B)       │ uint16 little-endian                  │
│ Columns (variable)      │ Repeated column definitions           │
└─────────────────────────────────────────────────────────────────┘
```

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
│ Properties (variable)   │ Property values                       │
└─────────────────────────────────────────────────────────────────┘
```

- **Edge Size**: Size of the edge data (from index + to index + properties), NOT including this size field
- **From Index**: 0-based index of source vertex (feature in FlatGeobuf section)
- **To Index**: 0-based index of target vertex

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

A graph with 2 nodes and 1 edge with properties:

```
Features: [{Point(0,0), name:"A"}, {Point(1,1), name:"B"}]
Edges: [{from:0, to:1, weight:1.5}]
```

Binary layout (hex, simplified):

```
# FGG Header + Features
66 67 67 01 66 67 67 00    # FGG magic
[header size + header + features...]

# Graph section (directly after features)
0C 00 00 00                # Graph header size: 12 bytes
01 00 00 00                # Edge count: 1
01 00                      # Column count: 1
06 00                      # Column 0 name length: 6
77 65 69 67 68 74          # Column 0 name: "weight"
0A                         # Column 0 type: Double (10)

# Edge 0
12 00 00 00                # Edge size: 18 bytes
00 00 00 00                # From: 0
01 00 00 00                # To: 1
00 00                      # Property 0 column index: 0
00 00 00 00 00 00 F8 3F    # Property 0 value: 1.5 (double)
```
