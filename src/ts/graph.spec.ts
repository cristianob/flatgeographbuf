import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from './geojson.js';
// Streaming helpers are not part of the public surface anymore; the tests
// exercise them directly to keep verifying the internal implementation.
import {
    deserializeGraphEdges,
    deserializeStream,
} from './geojson/featurecollection.js';
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

    describe('Edge geometry', () => {
        it('should default to null geometry when not provided', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [{ from: 0, to: 1, properties: { weight: 1.5 } }],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            expect(result.adjacencyList.edges[0].geometry).toBeNull();
            expect(result.adjacencyList.edges[0].properties?.weight).toBe(1.5);
        });

        it('should roundtrip a LineString path on an edge', async () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    {
                        from: 0,
                        to: 1,
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0, 0],
                                [0.5, 0.7],
                                [0.8, 0.9],
                                [1, 1],
                            ],
                        },
                        properties: { weight: 2.5 },
                    },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            const edge = result.adjacencyList.edges[0];
            expect(edge.geometry).not.toBeNull();
            expect(edge.geometry?.type).toBe('LineString');
            expect(edge.geometry?.coordinates).toHaveLength(4);
            expect(edge.geometry?.coordinates[0]).toEqual([0, 0]);
            expect(edge.geometry?.coordinates[1]).toEqual([0.5, 0.7]);
            expect(edge.geometry?.coordinates[3]).toEqual([1, 1]);
            expect(edge.properties?.weight).toBe(2.5);
        });

        it('should support mixed edges: some with geometry, some without', async () => {
            const geojson = makePointCollection(3);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    { from: 0, to: 1 },
                    {
                        from: 1,
                        to: 2,
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [1, 1],
                                [1.5, 1.8],
                                [2, 2],
                            ],
                        },
                    },
                    { from: 0, to: 2, geometry: null },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            // Edges may be reordered by the CSR sort; assert on semantics
            // by matching each input edge to the closest output edge with
            // the same (from, to) pair.
            expect(result.adjacencyList.edges).toHaveLength(3);
            const byEndpoints = new Map(result.adjacencyList.edges.map((e) => [`${e.from}->${e.to}`, e]));
            expect(byEndpoints.get('0->1')?.geometry).toBeNull();
            expect(byEndpoints.get('1->2')?.geometry?.coordinates).toHaveLength(3);
            expect(byEndpoints.get('0->2')?.geometry).toBeNull();
        });

        it('should stream edges with geometry', async () => {
            const geojson = makePointCollection(3);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    {
                        from: 0,
                        to: 1,
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0, 0],
                                [1, 1],
                            ],
                        },
                    },
                    { from: 1, to: 2 },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const edges = [];
            for await (const edge of deserializeGraphEdges(bytes)) {
                edges.push(edge);
            }

            expect(edges).toHaveLength(2);
            expect(edges[0].geometry?.coordinates).toEqual([
                [0, 0],
                [1, 1],
            ]);
            expect(edges[1].geometry).toBeNull();
        });

        it('should throw on non-LineString geometry', () => {
            const geojson = makePointCollection(2);
            const adjacencyList = {
                edges: [
                    {
                        from: 0,
                        to: 1,
                        geometry: { type: 'Point', coordinates: [0, 0] },
                    },
                ],
            };

            expect(() => serialize(geojson, adjacencyList as unknown as AdjacencyListInput)).toThrow(
                /Edge geometry must be LineString/,
            );
        });

        it('should throw on LineString with fewer than 2 coordinates', () => {
            const geojson = makePointCollection(2);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    {
                        from: 0,
                        to: 1,
                        geometry: { type: 'LineString', coordinates: [[0, 0]] },
                    },
                ],
            };

            expect(() => serialize(geojson, adjacencyList)).toThrow(/at least 2 coordinates/);
        });

        it('should preserve large LineString paths', async () => {
            const geojson = makePointCollection(2);
            const coordinates: number[][] = [];
            for (let i = 0; i < 500; i++) {
                coordinates.push([i * 0.01, Math.sin(i * 0.1)]);
            }
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    {
                        from: 0,
                        to: 1,
                        geometry: { type: 'LineString', coordinates },
                        properties: { length: 12.34 },
                    },
                ],
            };

            const bytes = serialize(geojson, adjacencyList);
            const result = await deserialize(bytes);

            const geom = result.adjacencyList.edges[0].geometry;
            expect(geom?.coordinates).toHaveLength(500);
            expect(geom?.coordinates[250][0]).toBeCloseTo(2.5, 10);
            expect(result.adjacencyList.edges[0].properties?.length).toBe(12.34);
        });
    });

    describe('Spatial index writing', () => {
        function scatteredPoints(count: number): GeoJsonFeatureCollection {
            // Pseudo-random but deterministic scatter so Hilbert sort
            // actually permutes the features.
            const features = [];
            let s = 1;
            for (let i = 0; i < count; i++) {
                s = (s * 1103515245 + 12345) & 0x7fffffff;
                const x = (s % 1000) / 10;
                s = (s * 1103515245 + 12345) & 0x7fffffff;
                const y = (s % 1000) / 10;
                features.push({
                    type: 'Feature' as const,
                    id: i,
                    geometry: { type: 'Point' as const, coordinates: [x, y] },
                    properties: { name: `node-${i}`, originalIndex: i },
                });
            }
            return { type: 'FeatureCollection', features };
        }

        it('should write an index when writeIndex is true and expose it in metadata', async () => {
            const geojson = scatteredPoints(20);
            const bytes = serialize(geojson, undefined, { writeIndex: true });

            let meta: import('./graph-types.js').FlatGeoGraphBufMeta | null = null;
            const result = await deserialize(bytes, (m) => {
                meta = m;
            });

            expect(meta).not.toBeNull();
            const m = meta as unknown as import('./graph-types.js').FlatGeoGraphBufMeta;
            expect(m.features.indexNodeSize).toBe(16);
            expect(m.features.envelope).not.toBeNull();
            expect(m.features.envelope?.length).toBe(4);
            expect(result.features).toHaveLength(20);
        });

        it('should disable the vertex index when writeIndex=false', async () => {
            const geojson = scatteredPoints(20);
            const bytes = serialize(geojson, undefined, { writeIndex: false });

            let meta: import('./graph-types.js').FlatGeoGraphBufMeta | null = null;
            const result = await deserialize(bytes, (m) => {
                meta = m;
            });

            expect(meta).not.toBeNull();
            const m = meta as unknown as import('./graph-types.js').FlatGeoGraphBufMeta;
            expect(m.features.indexNodeSize).toBe(0);
            // Without an index, features keep their insertion order so the
            // first scattered feature comes back at index 0.
            const firstOriginal = (result.features[0].properties as { originalIndex: number }).originalIndex;
            expect(firstOriginal).toBe(0);
        });

        it('should permute features along the Hilbert curve when indexed', async () => {
            const geojson = scatteredPoints(50);
            const bytes = serialize(geojson, undefined, { writeIndex: true });
            const result = await deserialize(bytes);

            const originalIndices = result.features.map(
                (f) => (f.properties as { originalIndex: number }).originalIndex,
            );
            // We don't assert a specific permutation, only that scattered
            // points get reordered (i.e. not strictly equal to insertion).
            expect(originalIndices).toHaveLength(50);
            expect(originalIndices).not.toEqual(Array.from({ length: 50 }, (_, i) => i));
            // All 50 features must still be present.
            expect(new Set(originalIndices).size).toBe(50);
        });

        it('should remap edges through the Hilbert permutation', async () => {
            const geojson = scatteredPoints(20);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    { from: 0, to: 5, properties: { label: 'a' } },
                    { from: 5, to: 10, properties: { label: 'b' } },
                    { from: 10, to: 15, properties: { label: 'c' } },
                ],
            };

            const bytes = serialize(geojson, adjacencyList, { writeIndex: true });
            const result = await deserialize(bytes);

            // After remapping each edge.from/edge.to points at the
            // feature whose original index matches the user's intent.
            // Edge order may also change because of the CSR sort, so
            // look them up by label rather than position.
            const originalIdx = (i: number) =>
                (result.features[i].properties as { originalIndex: number }).originalIndex;
            const byLabel = new Map(result.adjacencyList.edges.map((e) => [e.properties?.label as string, e]));

            for (const [label, expectedFrom, expectedTo] of [
                ['a', 0, 5],
                ['b', 5, 10],
                ['c', 10, 15],
            ] as const) {
                const edge = byLabel.get(label);
                expect(edge).toBeDefined();
                if (!edge) continue;
                expect(originalIdx(edge.from)).toBe(expectedFrom);
                expect(originalIdx(edge.to)).toBe(expectedTo);
            }
        });

        it('should produce a file readable by the spatial filter', async () => {
            const geojson = scatteredPoints(100);
            const bytes = serialize(geojson, undefined, { writeIndex: true });

            const hits: Array<{ x: number; y: number }> = [];
            for await (const feature of deserializeStream(bytes, {
                minX: 0,
                minY: 0,
                maxX: 25,
                maxY: 25,
            })) {
                const [x, y] = (feature.geometry as { coordinates: number[] }).coordinates;
                hits.push({ x, y });
            }

            // Every original feature falling in the bbox should be returned
            const expected = geojson.features.filter((f) => {
                const [x, y] = (f.geometry as { coordinates: number[] }).coordinates;
                return x >= 0 && x <= 25 && y >= 0 && y <= 25;
            }).length;

            expect(expected).toBeGreaterThan(0);
            expect(hits.length).toBe(expected);
            for (const h of hits) {
                expect(h.x).toBeGreaterThanOrEqual(0);
                expect(h.x).toBeLessThanOrEqual(25);
                expect(h.y).toBeGreaterThanOrEqual(0);
                expect(h.y).toBeLessThanOrEqual(25);
            }
        });

        it('should return the exact same feature identities through the bbox filter', async () => {
            const geojson = scatteredPoints(80);
            const bytes = serialize(geojson, undefined, { writeIndex: true });

            const expectedIds = new Set(
                geojson.features
                    .filter((f) => {
                        const [x, y] = (f.geometry as { coordinates: number[] }).coordinates;
                        return x >= 10 && x <= 40 && y >= 10 && y <= 40;
                    })
                    .map((f) => (f.properties as { originalIndex: number }).originalIndex),
            );

            const hitIds = new Set<number>();
            for await (const feature of deserializeStream(bytes, {
                minX: 10,
                minY: 10,
                maxX: 40,
                maxY: 40,
            })) {
                hitIds.add((feature.properties as { originalIndex: number }).originalIndex);
            }

            expect(hitIds.size).toBeGreaterThan(0);
            expect(hitIds).toEqual(expectedIds);
        });

        it('should return all features when the bbox covers the whole envelope', async () => {
            const geojson = scatteredPoints(50);
            const bytes = serialize(geojson, undefined, { writeIndex: true });

            let count = 0;
            for await (const _f of deserializeStream(bytes, {
                minX: -1,
                minY: -1,
                maxX: 200,
                maxY: 200,
            })) {
                count++;
            }
            expect(count).toBe(50);
        });

        it('should return zero features when the bbox lies outside the envelope', async () => {
            const geojson = scatteredPoints(50);
            const bytes = serialize(geojson, undefined, { writeIndex: true });

            let count = 0;
            for await (const _f of deserializeStream(bytes, {
                minX: 500,
                minY: 500,
                maxX: 600,
                maxY: 600,
            })) {
                count++;
            }
            expect(count).toBe(0);
        });

        it('should still parse the graph section when the file has both index and edges', async () => {
            const geojson = scatteredPoints(30);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    { from: 1, to: 7, properties: { tag: 'a' } },
                    { from: 7, to: 13, properties: { tag: 'b' } },
                    { from: 13, to: 21, properties: { tag: 'c' } },
                ],
            };

            const bytes = serialize(geojson, adjacencyList, { writeIndex: true });

            // 1) Full deserialize must recover the graph section even though
            //    the index sits between header and features.
            const result = await deserialize(bytes);
            expect(result.features).toHaveLength(30);
            expect(result.adjacencyList.edges).toHaveLength(3);
            const tags = result.adjacencyList.edges.map((e) => e.properties?.tag).sort();
            expect(tags).toEqual(['a', 'b', 'c']);

            // 2) Bbox-filtered streaming over the same file still works.
            let count = 0;
            for await (const _f of deserializeStream(bytes, {
                minX: -1,
                minY: -1,
                maxX: 200,
                maxY: 200,
            })) {
                count++;
            }
            expect(count).toBe(30);
        });

        it('should preserve edge geometry through remapping', async () => {
            const geojson = scatteredPoints(10);
            const adjacencyList: AdjacencyListInput = {
                edges: [
                    {
                        from: 2,
                        to: 7,
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0, 0],
                                [1, 1],
                                [2, 2],
                            ],
                        },
                        properties: { weight: 4.2 },
                    },
                ],
            };

            const bytes = serialize(geojson, adjacencyList, { writeIndex: true });
            const result = await deserialize(bytes);

            const edge = result.adjacencyList.edges[0];
            expect(edge.geometry?.coordinates).toHaveLength(3);
            expect(edge.geometry?.coordinates[2]).toEqual([2, 2]);
            expect(edge.properties?.weight).toBe(4.2);

            const originalIdx = (i: number) =>
                (result.features[i].properties as { originalIndex: number }).originalIndex;
            expect(originalIdx(edge.from)).toBe(2);
            expect(originalIdx(edge.to)).toBe(7);
        });

        it('defaults crsCode to 4326 (WGS84) when not specified', async () => {
            const geojson = scatteredPoints(5);
            const bytes = serialize(geojson);
            let meta: import('./graph-types.js').FlatGeoGraphBufMeta | null = null;
            await deserialize(bytes, (m) => {
                meta = m;
            });
            const m = meta as unknown as import('./graph-types.js').FlatGeoGraphBufMeta;
            expect(m.features.crs?.code).toBe(4326);
        });

        it('accepts a custom crsCode via options', async () => {
            const geojson = scatteredPoints(5);
            const bytes = serialize(geojson, undefined, { crsCode: 3857 });
            let meta: import('./graph-types.js').FlatGeoGraphBufMeta | null = null;
            await deserialize(bytes, (m) => {
                meta = m;
            });
            const m = meta as unknown as import('./graph-types.js').FlatGeoGraphBufMeta;
            expect(m.features.crs?.code).toBe(3857);
        });

        it('should write a single-feature index without crashing', async () => {
            const geojson: GeoJsonFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [3, 4] },
                        properties: { name: 'only' },
                    },
                ],
            };
            const bytes = serialize(geojson, undefined, { writeIndex: true });
            const result = await deserialize(bytes);
            expect(result.features).toHaveLength(1);
            expect((result.features[0].geometry as { coordinates: number[] }).coordinates).toEqual([3, 4]);
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
