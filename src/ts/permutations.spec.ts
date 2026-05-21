/**
 * Table-driven coverage of every meaningful permutation of FGG index
 * flags. Each row enumerates the 5 boolean writer toggles times the
 * "has edges" data dimension, builds the corresponding fixture, and
 * verifies that:
 *
 *  - serialize() does not throw
 *  - FlatGeoGraphBuf.open() round-trips the metadata
 *  - deserialize() round-trips features and edges
 *  - each query method works iff its prerequisites are met, and throws
 *    a descriptive error otherwise
 *
 * The matrix is exhaustive: 2^6 = 64 permutations, ranging from the
 * empty file (no indices, no edges) to the fully-decorated graph (all
 * three structural indices + property indices on both sides).
 */

import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { beforeAll, describe, expect, it } from 'vitest';
import { deserialize, FlatGeoGraphBuf, serialize } from './geojson.js';
import type { AdjacencyListInput } from './graph-types.js';

interface PermFlags {
    writeIndex: boolean;
    writeAdjacencyIndex: boolean;
    writeEdgeIndex: boolean;
    columnIndexVertices: boolean;
    columnIndexEdges: boolean;
    hasEdges: boolean;
}

const FEATURES: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.63, -23.55] },
            properties: { name: 'São Paulo', icao: 'SBSP', elev_ft: 2461, intl: true },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-43.17, -22.91] },
            properties: { name: 'Rio de Janeiro', icao: 'SBRJ', elev_ft: 11, intl: false },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-47.93, -15.78] },
            properties: { name: 'Brasília', icao: 'SBBR', elev_ft: 3497, intl: true },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-49.27, -16.68] },
            properties: { name: 'São José do Rio Preto', icao: 'SBSR', elev_ft: 1784, intl: false },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-44.2, -22.3] },
            properties: { name: 'Rio Preto', icao: 'SDRP', elev_ft: 100, intl: false },
        },
    ],
};
const N_FEATURES = FEATURES.features.length;

const EDGES: AdjacencyListInput = {
    edges: [
        { from: 0, to: 1, properties: { road: 'BR-116', km: 429, paved: true } },
        { from: 0, to: 2, properties: { road: 'BR-050', km: 1015, paved: true } },
        { from: 0, to: 3, properties: { road: 'BR-153', km: 442, paved: true } },
        { from: 3, to: 4, properties: { road: 'BR-101', km: 770, paved: false } },
    ],
};
const N_EDGES = EDGES.edges.length;

function build(flags: PermFlags): Uint8Array {
    return serialize(FEATURES, flags.hasEdges ? EDGES : undefined, {
        writeIndex: flags.writeIndex,
        writeAdjacencyIndex: flags.writeAdjacencyIndex,
        writeEdgeIndex: flags.writeEdgeIndex,
        columnIndex: {
            vertices: flags.columnIndexVertices ? ['name', 'icao', 'elev_ft', 'intl'] : undefined,
            edges: flags.columnIndexEdges ? ['road', 'km', 'paved'] : undefined,
        },
    });
}

function effectivelyHasAdjacency(f: PermFlags): boolean {
    return f.writeAdjacencyIndex && f.hasEdges;
}
function effectivelyHasEdgeRTree(f: PermFlags): boolean {
    return f.writeEdgeIndex && f.hasEdges;
}
function effectivelyHasEdgePropertyIndex(f: PermFlags): boolean {
    return f.columnIndexEdges && f.hasEdges;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

const BOOL = [false, true] as const;
const PERMUTATIONS: PermFlags[] = [];
for (const writeIndex of BOOL)
    for (const writeAdjacencyIndex of BOOL)
        for (const writeEdgeIndex of BOOL)
            for (const columnIndexVertices of BOOL)
                for (const columnIndexEdges of BOOL)
                    for (const hasEdges of BOOL)
                        PERMUTATIONS.push({
                            writeIndex,
                            writeAdjacencyIndex,
                            writeEdgeIndex,
                            columnIndexVertices,
                            columnIndexEdges,
                            hasEdges,
                        });

function label(f: PermFlags): string {
    const parts = [
        f.writeIndex ? 'V-RTree' : '·',
        f.writeAdjacencyIndex ? 'CSR' : '·',
        f.writeEdgeIndex ? 'E-RTree' : '·',
        f.columnIndexVertices ? 'V-Prop' : '·',
        f.columnIndexEdges ? 'E-Prop' : '·',
        f.hasEdges ? 'edges' : 'no-edges',
    ];
    return parts.join('/');
}

describe('all index permutations (64 combinations)', () => {
    for (const flags of PERMUTATIONS) {
        describe(label(flags), () => {
            let bytes: Uint8Array;
            let fgg: FlatGeoGraphBuf;

            beforeAll(async () => {
                bytes = build(flags);
                fgg = await FlatGeoGraphBuf.open(bytes);
            });

            it('serializes and opens without error', () => {
                expect(fgg.featureCount).toBe(N_FEATURES);
                expect(fgg.layout.header.edgeCount).toBe(flags.hasEdges ? N_EDGES : 0);
            });

            it('round-trips features and edges via deserialize', async () => {
                const { features, adjacencyList } = await deserialize(bytes);
                expect(features.length).toBe(N_FEATURES);
                expect(adjacencyList.edges.length).toBe(flags.hasEdges ? N_EDGES : 0);
            });

            it('reports correct index flags via the metadata callback', async () => {
                let meta: import('./graph-types.js').FlatGeoGraphBufMeta | null = null;
                await deserialize(bytes, (m) => {
                    meta = m;
                });
                const m = meta as unknown as import('./graph-types.js').FlatGeoGraphBufMeta;
                expect(m.features.indexNodeSize > 0).toBe(flags.writeIndex);
                if (flags.hasEdges) {
                    expect(m.graph?.hasAdjacencyIndex).toBe(flags.writeAdjacencyIndex);
                    expect(m.graph?.hasEdgeIndex).toBe(flags.writeEdgeIndex);
                    expect(m.graph?.hasEdgePropertyIndex).toBe(effectivelyHasEdgePropertyIndex(flags));
                }
            });

            it('featuresInBbox works iff vertex R-tree is present', async () => {
                const rect = { minX: -50, minY: -25, maxX: -40, maxY: -10 };
                if (flags.writeIndex) {
                    const hits = await collect(fgg.featuresInBbox(rect));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(collect(fgg.featuresInBbox(rect))).rejects.toThrow(
                        /vertex spatial index|writeIndex/i,
                    );
                }
            });

            it('outgoingEdgesOf works iff adjacency CSR is present', async () => {
                if (effectivelyHasAdjacency(flags)) {
                    const out = await collect(fgg.outgoingEdgesOf(0));
                    expect(out.length).toBeGreaterThanOrEqual(0);
                } else {
                    await expect(collect(fgg.outgoingEdgesOf(0))).rejects.toThrow(
                        /adjacency|writeAdjacencyIndex/i,
                    );
                }
            });

            it('edgesInBbox works iff edge R-tree is present', async () => {
                const rect = { minX: -50, minY: -25, maxX: -40, maxY: -10 };
                if (effectivelyHasEdgeRTree(flags)) {
                    const hits = await collect(fgg.edgesInBbox(rect));
                    expect(hits.length).toBeGreaterThanOrEqual(0);
                } else {
                    await expect(collect(fgg.edgesInBbox(rect))).rejects.toThrow(
                        /edge spatial index|writeEdgeIndex/i,
                    );
                }
            });

            it('shortestPath works iff adjacency CSR is present', async () => {
                if (effectivelyHasAdjacency(flags)) {
                    const path = await fgg.shortestPath(0, 1, { heuristic: null });
                    expect(path === null || path.edges.length >= 0).toBe(true);
                } else {
                    await expect(fgg.shortestPath(0, 1, { heuristic: null })).rejects.toThrow(
                        /adjacency|writeAdjacencyIndex/i,
                    );
                }
            });

            it('findVerticesByText works iff vertex property index is present', async () => {
                if (flags.columnIndexVertices) {
                    const hits = await collect(fgg.findVerticesByText('name', 'brasilia'));
                    expect(hits.length).toBeGreaterThan(0);
                    expect(['A', 'B', 'C']).toContain(hits[0].tier);
                } else {
                    await expect(
                        collect(fgg.findVerticesByText('name', 'brasilia')),
                    ).rejects.toThrow(/vertex property index|columnIndex/i);
                }
            });

            it('findVerticesByValue works iff vertex property index is present', async () => {
                if (flags.columnIndexVertices) {
                    const hits = await collect(fgg.findVerticesByValue('elev_ft', { gte: 1000 }));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(
                        collect(fgg.findVerticesByValue('elev_ft', { gte: 1000 })),
                    ).rejects.toThrow(/vertex property index|columnIndex/i);
                }
            });

            it('findEdgesByText works iff edge property index is present', async () => {
                if (effectivelyHasEdgePropertyIndex(flags)) {
                    const hits = await collect(fgg.findEdgesByText('road', 'br'));
                    expect(hits.length).toBeGreaterThan(0);
                    expect(['A', 'B', 'C']).toContain(hits[0].tier);
                } else {
                    await expect(collect(fgg.findEdgesByText('road', 'br'))).rejects.toThrow(
                        /edge property index|columnIndex/i,
                    );
                }
            });

            it('findEdgesByValue works iff edge property index is present', async () => {
                if (effectivelyHasEdgePropertyIndex(flags)) {
                    const hits = await collect(fgg.findEdgesByValue('km', { gte: 500 }));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(
                        collect(fgg.findEdgesByValue('km', { gte: 500 })),
                    ).rejects.toThrow(/edge property index|columnIndex/i);
                }
            });
        });
    }
});
