# FlatGeoGraphBuf - Usage Examples

## Table of Contents

- [Installation](#installation)
- [Basic Usage](#basic-usage)
- [Working with Edges](#working-with-edges)
- [Edge Properties](#edge-properties)
- [Metadata Callback](#metadata-callback)
- [Streaming Large Graphs](#streaming-large-graphs)
- [Integration with Graph Libraries](#integration-with-graph-libraries)
- [Real-World Examples](#real-world-examples)

## Installation

```bash
npm install flatgeographbuf
# or
pnpm add flatgeographbuf
# or
yarn add flatgeographbuf
```

## Basic Usage

### Creating a Simple Graph

```typescript
import { serialize, deserialize } from 'flatgeographbuf/geojson';

// Define vertices as GeoJSON features
const geojson = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.6333, -23.5505] },
            properties: { id: 'sao-paulo', name: 'São Paulo' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-43.1729, -22.9068] },
            properties: { id: 'rio', name: 'Rio de Janeiro' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-47.9292, -15.7801] },
            properties: { id: 'brasilia', name: 'Brasília' }
        }
    ]
};

// Define edges (connections between vertices)
const adjacencyList = {
    edges: [
        { from: 0, to: 1 },  // São Paulo -> Rio de Janeiro
        { from: 0, to: 2 },  // São Paulo -> Brasília
        { from: 1, to: 2 }   // Rio de Janeiro -> Brasília
    ]
};

// Serialize to binary format
const bytes = serialize(geojson, adjacencyList);

// Save to file (Node.js)
import { writeFileSync } from 'fs';
writeFileSync('brazil-cities.fgg', bytes);
```

### Reading a Graph

```typescript
import { deserialize } from 'flatgeographbuf/geojson';
import { readFileSync } from 'fs';

const bytes = new Uint8Array(readFileSync('brazil-cities.fgg'));
const result = await deserialize(bytes);

console.log('Vertices:', result.features.length);
console.log('Edges:', result.adjacencyList.edges.length);

// Access vertex data
result.features.forEach((feature, index) => {
    console.log(`Vertex ${index}: ${feature.properties.name}`);
});

// Access edge data
result.adjacencyList.edges.forEach(edge => {
    const from = result.features[edge.from].properties.name;
    const to = result.features[edge.to].properties.name;
    console.log(`Edge: ${from} -> ${to}`);
});
```

## Working with Edges

### Directed Edges

All edges in FlatGeoGraphBuf are directed. For bidirectional connections, create two edges:

```typescript
const adjacencyList = {
    edges: [
        { from: 0, to: 1 },  // A -> B
        { from: 1, to: 0 }   // B -> A (reverse direction)
    ]
};
```

### Edge Validation

FlatGeoGraphBuf validates edges during serialization:

```typescript
// This will throw an error - self-loops are not allowed
const invalidEdges = {
    edges: [
        { from: 0, to: 0 }  // Error: Self-loops not allowed
    ]
};

// This will throw an error - invalid vertex index
const invalidIndex = {
    edges: [
        { from: 0, to: 999 }  // Error: Index out of bounds
    ]
};
```

## Edge Properties

### Adding Properties to Edges

```typescript
const adjacencyList = {
    edges: [
        {
            from: 0,
            to: 1,
            properties: {
                distance: 429.5,           // number (Double)
                road_type: 'highway',      // string
                toll: true,                // boolean
                lanes: 4                   // number
            }
        },
        {
            from: 1,
            to: 2,
            properties: {
                distance: 1148.0,
                road_type: 'highway',
                toll: true,
                lanes: 2
            }
        }
    ]
};
```

### Supported Property Types

```typescript
const edgeWithAllTypes = {
    from: 0,
    to: 1,
    properties: {
        // Numeric types
        count: 42,                    // Double (default for numbers)
        
        // String
        name: 'Main Road',
        
        // Boolean
        active: true,
        
        // DateTime (as ISO string)
        created_at: '2024-01-15T10:30:00Z',
        
        // JSON (complex objects)
        metadata: { source: 'osm', version: 2 },
        
        // Binary data
        signature: new Uint8Array([0x01, 0x02, 0x03])
    }
};
```

### Reading Edge Properties

```typescript
const result = await deserialize(bytes);

result.adjacencyList.edges.forEach(edge => {
    console.log(`Edge ${edge.from} -> ${edge.to}`);
    
    // edge.properties is always an object (never undefined)
    console.log(`  Distance: ${edge.properties.distance} km`);
    console.log(`  Road type: ${edge.properties.road_type}`);
    console.log(`  Has toll: ${edge.properties.toll}`);
});
```

## Metadata Callback

The `deserialize` function accepts an optional callback that provides metadata about both features and graph edges before the full data is parsed.

### Basic Metadata Usage

```typescript
import { deserialize } from 'flatgeographbuf/geojson';
import type { FlatGeoGraphBufMeta } from 'flatgeographbuf/geojson';

const result = await deserialize(bytes, (meta: FlatGeoGraphBufMeta) => {
    // Feature metadata (nested under 'features')
    console.log(`Features: ${meta.features.featuresCount}`);
    console.log(`Geometry type: ${meta.features.geometryType}`);
    
    // Feature property schema
    if (meta.features.columns) {
        console.log('Feature columns:');
        meta.features.columns.forEach(col => {
            console.log(`  ${col.name}: ${col.type}`);
        });
    }
    
    // Graph metadata (null if no graph section)
    if (meta.graph) {
        console.log(`Edges: ${meta.graph.edgeCount}`);
        
        // Edge property schema
        if (meta.graph.edgeColumns) {
            console.log('Edge columns:');
            meta.graph.edgeColumns.forEach(col => {
                console.log(`  ${col.name}: ${col.type}`);
            });
        }
    }
});
```

### Pre-allocating Arrays Based on Counts

```typescript
const result = await deserialize(bytes, (meta) => {
    // Pre-allocate arrays for better performance with large graphs
    const nodes = new Array(meta.features.featuresCount);
    const edges = meta.graph ? new Array(meta.graph.edgeCount) : [];
    
    console.log(`Will load ${meta.features.featuresCount} nodes and ${meta.graph?.edgeCount ?? 0} edges`);
});
```

### Validating Expected Schema

```typescript
async function loadRoadNetwork(bytes: Uint8Array) {
    return await deserialize(bytes, (meta) => {
        // Validate feature schema
        const hasName = meta.features.columns?.some(c => c.name === 'name');
        if (!hasName) {
            throw new Error('Road network must have "name" column on features');
        }
        
        // Validate graph schema
        if (!meta.graph) {
            throw new Error('Road network must have graph section');
        }
        
        const hasWeight = meta.graph.edgeColumns?.some(c => c.name === 'weight');
        if (!hasWeight) {
            throw new Error('Road network edges must have "weight" column');
        }
    });
}
```

### Progress Indication

```typescript
async function loadWithProgress(bytes: Uint8Array) {
    let totalItems = 0;
    
    const result = await deserialize(bytes, (meta) => {
        totalItems = meta.features.featuresCount + (meta.graph?.edgeCount ?? 0);
        console.log(`Loading ${totalItems} items...`);
        showProgressBar(0, totalItems);
    });
    
    showProgressBar(totalItems, totalItems);
    return result;
}
```

## Streaming Large Graphs

### Streaming Edge Deserialization

For large graphs, use streaming to avoid loading everything into memory:

```typescript
import { deserializeStream, deserializeGraphEdges } from 'flatgeographbuf/geojson';

// Stream vertices
console.log('Processing vertices...');
for await (const feature of deserializeStream(bytes)) {
    processVertex(feature);
}

// Stream edges
console.log('Processing edges...');
for await (const edge of deserializeGraphEdges(bytes)) {
    processEdge(edge);
}

function processVertex(feature) {
    // Process one vertex at a time
    console.log(`Vertex: ${feature.properties.name}`);
}

function processEdge(edge) {
    // Process one edge at a time
    console.log(`Edge: ${edge.from} -> ${edge.to}`);
}
```

### Memory-Efficient Processing

```typescript
import { deserializeGraphEdges } from 'flatgeographbuf/geojson';

// Calculate total distance without loading all edges
let totalDistance = 0;
let edgeCount = 0;

for await (const edge of deserializeGraphEdges(bytes)) {
    if (edge.properties?.distance) {
        totalDistance += edge.properties.distance;
    }
    edgeCount++;
}

console.log(`Total edges: ${edgeCount}`);
console.log(`Total distance: ${totalDistance} km`);
```

## Integration with Graph Libraries

### Graphology

```typescript
import Graph from 'graphology';
import { deserialize } from 'flatgeographbuf/geojson';

async function loadIntoGraphology(bytes: Uint8Array): Promise<Graph> {
    const { features, adjacencyList } = await deserialize(bytes);
    
    const graph = new Graph({ type: 'directed' });
    
    // Add nodes
    features.forEach((feature, index) => {
        graph.addNode(index, {
            ...feature.properties,
            coordinates: feature.geometry.coordinates
        });
    });
    
    // Add edges
    adjacencyList.edges.forEach((edge, index) => {
        graph.addEdge(edge.from, edge.to, {
            id: index,
            ...edge.properties
        });
    });
    
    return graph;
}

// Usage
const graph = await loadIntoGraphology(bytes);
console.log(`Nodes: ${graph.order}, Edges: ${graph.size}`);
```

### ngraph

```typescript
import createGraph from 'ngraph.graph';
import { deserialize } from 'flatgeographbuf/geojson';

async function loadIntoNgraph(bytes: Uint8Array) {
    const { features, adjacencyList } = await deserialize(bytes);
    
    const graph = createGraph();
    
    // Add nodes
    features.forEach((feature, index) => {
        graph.addNode(index, {
            name: feature.properties.name,
            coordinates: feature.geometry.coordinates
        });
    });
    
    // Add links
    adjacencyList.edges.forEach(edge => {
        graph.addLink(edge.from, edge.to, edge.properties);
    });
    
    return graph;
}
```

### Cytoscape.js

```typescript
import cytoscape from 'cytoscape';
import { deserialize } from 'flatgeographbuf/geojson';

async function loadIntoCytoscape(bytes: Uint8Array) {
    const { features, adjacencyList } = await deserialize(bytes);
    
    const elements = {
        nodes: features.map((feature, index) => ({
            data: {
                id: String(index),
                ...feature.properties,
                coordinates: feature.geometry.coordinates
            }
        })),
        edges: adjacencyList.edges.map((edge, index) => ({
            data: {
                id: `e${index}`,
                source: String(edge.from),
                target: String(edge.to),
                ...edge.properties
            }
        }))
    };
    
    return cytoscape({ elements });
}
```

## Real-World Examples

### Road Network

```typescript
import { serialize, deserialize } from 'flatgeographbuf/geojson';

// Intersections as vertices
const intersections = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.6388, -23.5489] },
            properties: { 
                id: 'int-001',
                type: 'traffic_light',
                name: 'Av. Paulista x Rua Augusta'
            }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.6521, -23.5613] },
            properties: { 
                id: 'int-002',
                type: 'roundabout',
                name: 'Praça da República'
            }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.6340, -23.5475] },
            properties: { 
                id: 'int-003',
                type: 'traffic_light',
                name: 'Av. Paulista x Rua Haddock Lobo'
            }
        }
    ]
};

// Road segments as edges
const roadNetwork = {
    edges: [
        {
            from: 0,
            to: 2,
            properties: {
                road_name: 'Av. Paulista',
                distance_m: 450,
                speed_limit: 50,
                lanes: 3,
                one_way: true
            }
        },
        {
            from: 0,
            to: 1,
            properties: {
                road_name: 'Rua Augusta',
                distance_m: 1200,
                speed_limit: 40,
                lanes: 2,
                one_way: false
            }
        },
        {
            from: 1,
            to: 0,
            properties: {
                road_name: 'Rua Augusta',
                distance_m: 1200,
                speed_limit: 40,
                lanes: 2,
                one_way: false
            }
        }
    ]
};

const bytes = serialize(intersections, roadNetwork);
```

### Flight Routes

```typescript
const airports = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.4730, -23.4356] },
            properties: { iata: 'GRU', name: 'Guarulhos International', city: 'São Paulo' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-43.2436, -22.8090] },
            properties: { iata: 'GIG', name: 'Galeão International', city: 'Rio de Janeiro' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-47.9136, -15.8711] },
            properties: { iata: 'BSB', name: 'Brasília International', city: 'Brasília' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-73.7781, 40.6413] },
            properties: { iata: 'JFK', name: 'John F. Kennedy', city: 'New York' }
        }
    ]
};

const flightRoutes = {
    edges: [
        {
            from: 0, to: 1,
            properties: {
                airline: 'LATAM',
                flight_number: 'LA3000',
                duration_min: 55,
                frequency: 'daily',
                aircraft: 'A320'
            }
        },
        {
            from: 0, to: 2,
            properties: {
                airline: 'GOL',
                flight_number: 'G31234',
                duration_min: 90,
                frequency: 'daily',
                aircraft: 'B737'
            }
        },
        {
            from: 0, to: 3,
            properties: {
                airline: 'LATAM',
                flight_number: 'LA8000',
                duration_min: 600,
                frequency: '3x_week',
                aircraft: 'B777'
            }
        }
    ]
};

const bytes = serialize(airports, flightRoutes);
```

### Utility Network (Power Grid)

```typescript
const powerStations = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-47.0, -23.5] },
            properties: { 
                id: 'PS001',
                type: 'generation',
                name: 'Hydroelectric Plant A',
                capacity_mw: 1500
            }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.6, -23.5] },
            properties: { 
                id: 'SS001',
                type: 'substation',
                name: 'Substation Central',
                voltage_kv: 138
            }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.5, -23.6] },
            properties: { 
                id: 'SS002',
                type: 'substation',
                name: 'Substation South',
                voltage_kv: 69
            }
        }
    ]
};

const transmissionLines = {
    edges: [
        {
            from: 0, to: 1,
            properties: {
                line_id: 'TL001',
                voltage_kv: 500,
                length_km: 45,
                capacity_mw: 1200,
                status: 'active'
            }
        },
        {
            from: 1, to: 2,
            properties: {
                line_id: 'TL002',
                voltage_kv: 138,
                length_km: 12,
                capacity_mw: 300,
                status: 'active'
            }
        }
    ]
};

const bytes = serialize(powerStations, transmissionLines);
```

### Social Network (Simplified)

```typescript
const users = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.6, -23.5] },
            properties: { id: 'user1', name: 'Alice', joined: '2020-01-15' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-43.2, -22.9] },
            properties: { id: 'user2', name: 'Bob', joined: '2020-03-20' }
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-47.9, -15.8] },
            properties: { id: 'user3', name: 'Carol', joined: '2021-06-10' }
        }
    ]
};

const connections = {
    edges: [
        {
            from: 0, to: 1,
            properties: { 
                type: 'follows',
                since: '2020-04-01',
                notifications: true
            }
        },
        {
            from: 1, to: 0,
            properties: { 
                type: 'follows',
                since: '2020-04-02',
                notifications: true
            }
        },
        {
            from: 0, to: 2,
            properties: { 
                type: 'follows',
                since: '2021-07-15',
                notifications: false
            }
        }
    ]
};

const bytes = serialize(users, connections);
```

## Browser Usage

### With ES Modules

```html
<script type="module">
import { serialize, deserialize } from 'https://unpkg.com/flatgeographbuf/dist/flatgeographbuf-geojson.min.js';

// Your code here
</script>
```

### Fetching Remote Files

```typescript
async function loadRemoteGraph(url: string) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    
    return deserialize(bytes);
}

// Usage
const graph = await loadRemoteGraph('https://example.com/network.fgg');
```

## TypeScript Types

```typescript
import type { 
    AdjacencyList,
    AdjacencyListInput, 
    Edge, 
    EdgeInput,
    DeserializeGraphResult,
    FlatGeoGraphBufMeta,
    FeaturesHeaderMeta,
    GraphHeaderMeta,
} from 'flatgeographbuf/geojson';

// EdgeInput - for serialization (properties optional)
const edgeInput: EdgeInput = {
    from: 0,
    to: 1,
    properties: { weight: 1.5 }  // optional
};

// Edge - from deserialization (properties always present)
// edge.properties is always an object, never undefined

// AdjacencyListInput - for serialization
const adjacencyListInput: AdjacencyListInput = {
    edges: [edgeInput]
};

// FlatGeoGraphBufMeta - combined metadata structure
// meta.features: FeaturesHeaderMeta - feature/vertex metadata
// meta.graph: GraphHeaderMeta | null - graph/edge metadata (null if no graph)

// Result type - properties always present as object
async function processGraph(bytes: Uint8Array): Promise<void> {
    const result: DeserializeGraphResult<IGeoJsonFeature> = await deserialize(bytes);
    
    // result.features[0].properties is always an object (never undefined)
    // result.adjacencyList.edges[0].properties is always an object (never undefined)
}
```
