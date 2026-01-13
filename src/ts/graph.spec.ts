import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { deserialize, deserializeGraphEdges, serialize } from './geojson.js';
import type { AdjacencyListInput } from './graph-types.js';

function makePointCollection(count: number): GeoJsonFeatureCollection {
    const features = [];
    for (let i = 0; i < count; i++) {
        features.push({
            type: 'Feature' as const,
            id: i,
            geometry: { type: 'Point' as const, coordinates: [i, i] },
            properties: { name: `node-${i}` },
        });
    }
    return { type: 'FeatureCollection', features };
}

describe('FlatGeoGraphBuf', () => {
    describe('Roundtrip tests', () => {
        it('should serialize and deserialize simple graph', async () => {
            const geojson = makePointCollection(3);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    { from: 0, to: 1, properties: { weight: 1.5, name: 'edge-01' } },
                    { from: 1, to: 2, properties: { weight: 2.0, name: 'edge-12' } },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.features.length).toBe(3);
            expect(result.adjacencyList.edges.length).toBe(2);
            expect(result.adjacencyList.edges[0].from).toBe(0);
            expect(result.adjacencyList.edges[0].to).toBe(1);
            expect(result.adjacencyList.edges[0].properties?.weight).toBe(1.5);
            expect(result.adjacencyList.edges[0].properties?.name).toBe('edge-01');
            expect(result.adjacencyList.edges[1].from).toBe(1);
            expect(result.adjacencyList.edges[1].to).toBe(2);
        });

        it('should be backward compatible (no graph section)', async () => {
            const geojson = makePointCollection(2);
            const bytes = serialize(geojson);
            const result = await deserialize(bytes);

            expect(result.features.length).toBe(2);
            expect(result.adjacencyList.edges).toEqual([]);
        });

        it('should handle empty adjacency list', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = { edges: [] };
            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.features.length).toBe(2);
            expect(result.adjacencyList.edges).toEqual([]);
        });

        it('should handle edges without properties', async () => {
            const geojson = makePointCollection(3);
            const adjacencyList = {
                edges: [
                    { from: 0, to: 1 },
                    { from: 1, to: 2 },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.adjacencyList.edges[0].from).toBe(0);
            expect(result.adjacencyList.edges[0].to).toBe(1);
            expect(result.adjacencyList.edges[0].properties).toEqual({});
            expect(result.adjacencyList.edges[1].properties).toEqual({});
        });

        it('should handle all property types on edges', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    {
                        from: 0,
                        to: 1,
                        properties: {
                            boolVal: true,
                            intVal: 42,
                            floatVal: 3.14159,
                            strVal: 'hello world',
                            jsonVal: { nested: 'object', arr: [1, 2, 3] },
                        },
                    },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            const props = result.adjacencyList.edges[0].properties;
            expect(props?.boolVal).toBe(true);
            expect(props?.intVal).toBe(42);
            expect(props?.floatVal).toBeCloseTo(3.14159, 4);
            expect(props?.strVal).toBe('hello world');
            expect(props?.jsonVal).toEqual({ nested: 'object', arr: [1, 2, 3] });
        });

        it('should handle bidirectional edges (user creates two edges)', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    { from: 0, to: 1, properties: { direction: 'forward' } },
                    { from: 1, to: 0, properties: { direction: 'backward' } },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.adjacencyList.edges.length).toBe(2);
            expect(result.adjacencyList.edges[0].from).toBe(0);
            expect(result.adjacencyList.edges[0].to).toBe(1);
            expect(result.adjacencyList.edges[1].from).toBe(1);
            expect(result.adjacencyList.edges[1].to).toBe(0);
        });
    });

    describe('Streaming tests', () => {
        it('should stream edges', async () => {
            const geojson = makePointCollection(4);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    { from: 0, to: 1 },
                    { from: 1, to: 2 },
                    { from: 2, to: 3 },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const edges = [];
            for await (const edge of deserializeGraphEdges(bytes)) {
                edges.push(edge);
            }

            expect(edges.length).toBe(3);
            expect(edges[0].from).toBe(0);
            expect(edges[2].to).toBe(3);
        });

        it('should handle no graph section in streaming', async () => {
            const geojson = makePointCollection(2);
            const bytes = serialize(geojson);
            const edges = [];
            for await (const edge of deserializeGraphEdges(bytes)) {
                edges.push(edge);
            }

            expect(edges.length).toBe(0);
        });
    });

    describe('Validation tests', () => {
        it('should throw on invalid from index', () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 5, to: 0 }],
            };

            expect(() => serialize(geojson, adjacencyList)).toThrow(/Invalid 'from' index/);
        });

        it('should throw on invalid to index', () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 0, to: 10 }],
            };

            expect(() => serialize(geojson, adjacencyList)).toThrow(/Invalid 'to' index/);
        });

        it('should throw on negative index', () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: -1, to: 0 }],
            };

            expect(() => serialize(geojson, adjacencyList)).toThrow();
        });

        it('should throw on self-loop', () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 0, to: 0 }],
            };

            expect(() => serialize(geojson, adjacencyList)).toThrow(/Self-loops are not allowed/);
        });
    });

    describe('Large graph tests', () => {
        it('should handle 1000 edges', async () => {
            const featureCount = 100;
            const geojson = makePointCollection(featureCount);
            const edges = [];

            for (let i = 0; i < 1000; i++) {
                const from = i % featureCount;
                const to = (i + 1) % featureCount;
                if (from !== to) {
                    edges.push({ from, to, properties: { id: i } });
                }
            }

            const adjacencyList: AdjacencyListInput = { edges };
            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.adjacencyList.edges.length).toBe(edges.length);
        });

        it('should handle many properties per edge', async () => {
            const geojson = makePointCollection(2);
            const properties: Record<string, number> = {};
            for (let i = 0; i < 50; i++) {
                properties[`prop${i}`] = i * 1.5;
            }

            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 0, to: 1, properties }],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            const resultProps = result.adjacencyList.edges[0].properties;
            expect(Object.keys(resultProps || {}).length).toBe(50);
            expect(resultProps?.prop25).toBeCloseTo(37.5, 4);
        });
    });

    describe('Feature properties preserved', () => {
        it('should preserve feature properties alongside graph', async () => {
            const geojson: GeoJsonFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        id: 0,
                        geometry: { type: 'Point', coordinates: [0, 0] },
                        properties: { name: 'Station A', capacity: 100 },
                    },
                    {
                        type: 'Feature',
                        id: 1,
                        geometry: { type: 'Point', coordinates: [1, 1] },
                        properties: { name: 'Station B', capacity: 200 },
                    },
                ],
            };

            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 0, to: 1, properties: { distance: 10.5 } }],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.features[0].properties?.name).toBe('Station A');
            expect(result.features[0].properties?.capacity).toBe(100);
            expect(result.features[1].properties?.name).toBe('Station B');
            expect(result.adjacencyList.edges[0].properties?.distance).toBe(10.5);
        });
    });

    describe('Complex geometries with graph', () => {
        it('should handle LineString features as vertices', async () => {
            const geojson: GeoJsonFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        id: 0,
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0, 0],
                                [1, 1],
                            ],
                        },
                        properties: { name: 'Road A' },
                    },
                    {
                        type: 'Feature',
                        id: 1,
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [1, 1],
                                [2, 2],
                            ],
                        },
                        properties: { name: 'Road B' },
                    },
                ],
            };

            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 0, to: 1, properties: { connection: 'sequential' } }],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.features.length).toBe(2);
            expect(result.features[0].geometry.type).toBe('LineString');
            expect(result.adjacencyList.edges[0].properties?.connection).toBe('sequential');
        });
    });

    describe('Properties always object', () => {
        it('edge properties should always be an object, never undefined', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList = {
                edges: [{ from: 0, to: 1 }],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.adjacencyList.edges[0].properties).toBeDefined();
            expect(result.adjacencyList.edges[0].properties).not.toBeNull();
            expect(typeof result.adjacencyList.edges[0].properties).toBe('object');
            expect(result.adjacencyList.edges[0].properties).toEqual({});
        });

        it('feature properties should always be an object, never undefined', async () => {
            const geojson: GeoJsonFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        id: 0,
                        geometry: { type: 'Point', coordinates: [0, 0] },
                        properties: {},
                    },
                    {
                        type: 'Feature',
                        id: 1,
                        geometry: { type: 'Point', coordinates: [1, 1] },
                        properties: null,
                    },
                ],
            };

            const bytes = serialize(geojson);
            const result = await deserialize(bytes);

            expect(result.features[0].properties).toBeDefined();
            expect(result.features[0].properties).not.toBeNull();
            expect(typeof result.features[0].properties).toBe('object');
            expect(result.features[0].properties).toEqual({});

            expect(result.features[1].properties).toBeDefined();
            expect(result.features[1].properties).not.toBeNull();
            expect(typeof result.features[1].properties).toBe('object');
            expect(result.features[1].properties).toEqual({});
        });

        it('streamed edges should have properties as object', async () => {
            const geojson = makePointCollection(3);
            const adjacencyList = {
                edges: [
                    { from: 0, to: 1 },
                    { from: 1, to: 2, properties: { weight: 1.5 } },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const edges = [];
            for await (const edge of deserializeGraphEdges(bytes)) {
                edges.push(edge);
            }

            expect(edges[0].properties).toBeDefined();
            expect(edges[0].properties).toEqual({});
            expect(edges[1].properties).toBeDefined();
            expect(edges[1].properties).toEqual({ weight: 1.5 });
        });
    });

    describe('Metadata callback', () => {
        it('should provide feature and graph metadata via callback', async () => {
            const geojson: GeoJsonFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        id: 0,
                        geometry: { type: 'Point', coordinates: [0, 0] },
                        properties: { name: 'A', value: 100 },
                    },
                    {
                        type: 'Feature',
                        id: 1,
                        geometry: { type: 'Point', coordinates: [1, 1] },
                        properties: { name: 'B', value: 200 },
                    },
                ],
            };

            const adjacencyList = {
                edges: [{ from: 0, to: 1, properties: { weight: 1.5, label: 'edge-1' } }],
            };

            const bytes = serialize(geojson, adjacencyList);

            let receivedMeta: any = null;
            await deserialize(bytes, (meta) => {
                receivedMeta = meta;
            });

            expect(receivedMeta).not.toBeNull();
            expect(receivedMeta.features.featuresCount).toBe(2);
            expect(receivedMeta.features.columns).toHaveLength(2);
            expect(receivedMeta.features.columns[0].name).toBe('name');
            expect(receivedMeta.features.columns[1].name).toBe('value');

            expect(receivedMeta.graph).not.toBeNull();
            expect(receivedMeta.graph.edgeCount).toBe(1);
            expect(receivedMeta.graph.edgeColumns).toHaveLength(2);
            expect(receivedMeta.graph.edgeColumns[0].name).toBe('weight');
            expect(receivedMeta.graph.edgeColumns[1].name).toBe('label');
        });

        it('should return null graph metadata when no graph section', async () => {
            const geojson = makePointCollection(2);
            const bytes = serialize(geojson);

            let receivedMeta: any = null;
            await deserialize(bytes, (meta) => {
                receivedMeta = meta;
            });

            expect(receivedMeta).not.toBeNull();
            expect(receivedMeta.features.featuresCount).toBe(2);
            expect(receivedMeta.graph).toBeNull();
        });

        it('should return null edgeColumns when edges have no properties', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList = {
                edges: [{ from: 0, to: 1 }],
            };

            const bytes = serialize(geojson, adjacencyList);

            let receivedMeta: any = null;
            await deserialize(bytes, (meta) => {
                receivedMeta = meta;
            });

            expect(receivedMeta.graph).not.toBeNull();
            expect(receivedMeta.graph.edgeCount).toBe(1);
            expect(receivedMeta.graph.edgeColumns).toBeNull();
        });
    });
});
