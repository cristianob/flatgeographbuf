# FlatGeoGraphBuf for TypeScript

## Building

### Prerequisites

You must have [`pnpm`](https://pnpm.io) installed.

### Install dependencies

```bash
pnpm install
```

### Build

To compile TypeScript and create bundles:

```bash
pnpm build
```

### Testing

```bash
pnpm test
```

### Type checking

```bash
pnpm type-check
```

### Generate API documentation

```bash
pnpm typedoc
```

See the `scripts` section in [package.json](../../package.json) for other actions.

## Project Structure

```
src/ts/
├── flatgeographbuf.ts    # Main exports
├── geojson.ts            # GeoJSON-specific API
├── generic.ts            # Generic feature API
├── graph.ts              # Graph section encoding/decoding
├── graph-types.ts        # Graph type definitions
├── constants.ts          # Magic bytes and constants
├── geojson/              # GeoJSON module implementation
├── generic/              # Generic module implementation
├── flat-geobuf/          # FlatBuffers generated code
└── *.spec.ts             # Test files
```

## Usage Example

```typescript
import { serialize, deserialize } from './geojson.js';
import type { AdjacencyList } from './graph-types.js';

// Create a simple graph
const geojson = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { name: 'B' } },
    ]
};

const adjacencyList: AdjacencyList = {
    edges: [{ from: 0, to: 1, properties: { weight: 1.5 } }]
};

// Serialize
const bytes = serialize(geojson, adjacencyList);

// Deserialize
const result = await deserialize(bytes);
console.log(result.features);
console.log(result.adjacencyList);
```
