# FlatGeoGraphBuf

A performant binary encoding for geospatial graphs, extending [FlatGeobuf](https://github.com/flatgeobuf/flatgeobuf) with adjacency list support.

## Features

- Full FlatGeobuf compatibility for vertex/feature data
- Efficient binary encoding for graph edges with arbitrary properties
- TypeScript implementation optimized for decode performance
- Streaming support for large graphs
- Backward compatible - new properties don't break old readers
- Compatible with NPM graph libraries (graphology, ngraph, cytoscape, etc.)

## Installation

```bash
npm install flatgeographbuf
```

## Usage

### Encoding

```typescript
import { serialize } from 'flatgeographbuf/geojson';

const geojson = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { name: 'B' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 2] }, properties: { name: 'C' } },
    ]
};

const adjacencyList = {
    edges: [
        { from: 0, to: 1, properties: { weight: 1.5, road_type: 'highway' } },
        { from: 1, to: 2, properties: { weight: 2.0, road_type: 'local' } },
    ]
};

const bytes = serialize(geojson, adjacencyList);
```

### Decoding

```typescript
import { deserialize } from 'flatgeographbuf/geojson';

const result = await deserialize(bytes);

console.log(result.features);      // GeoJSON features (vertices)
console.log(result.adjacencyList); // { edges: [...] }
```

### Streaming Edges

```typescript
import { deserializeGraphEdges } from 'flatgeographbuf/geojson';

for await (const edge of deserializeGraphEdges(bytes)) {
    console.log(`Edge from ${edge.from} to ${edge.to}`);
}
```

## API

### Types

```typescript
interface EdgeInput {
    from: number;
    to: number;
    properties?: EdgeProperties;  // Optional on input
}

interface Edge {
    from: number;
    to: number;
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
```

### Functions

#### `serialize(geojson, adjacencyList?, crsCode?): Uint8Array`

Serialize GeoJSON features and optional graph edges to FlatGeoGraphBuf format.

- `geojson` - GeoJSON FeatureCollection (vertices)
- `adjacencyList` - Optional graph edges with properties
- `crsCode` - Optional CRS code (default: 0)

#### `deserialize(bytes, headerMetaFn?): Promise<DeserializeGraphResult>`

Deserialize FlatGeoGraphBuf to features and adjacency list.

- `bytes` - FlatGeoGraphBuf binary data
- `headerMetaFn` - Optional callback for header metadata

#### `deserializeStream(input, rect?, headerMetaFn?): AsyncGenerator<Feature>`

Streaming deserialize features only.

- `input` - Uint8Array or ReadableStream
- `rect` - Optional bounding box filter
- `headerMetaFn` - Optional callback for header metadata

#### `deserializeGraphEdges(bytes): AsyncGenerator<Edge>`

Streaming deserialize graph edges only.

## Binary Format

FlatGeoGraphBuf uses FlatGeobuf's encoding for features and appends an optional graph section:

```
[FGG Magic: 8B] [Header: 4B+var] [Index?] [Features...] [Graph Section?]
```

- **FGG Magic**: `0x6667670166676700` ("fgg\x01fgg\x00")
- **Header/Features**: Same encoding as FlatGeobuf
- **Graph Section**: `[Header Size: 4B] [Graph Header] [Edges...]`
- **Graph Header**: Edge count + edge column schema
- **Edges**: Size-prefixed records with `[from: 4B][to: 4B][properties...]`

Edge properties use the same encoding as FlatGeobuf feature properties, supporting:
- Boolean, integers (8/16/32/64 bit signed/unsigned)
- Float, Double
- String, DateTime, JSON, Binary

See [doc/format-spec.md](doc/format-spec.md) for detailed specification.

## Design Decisions

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
