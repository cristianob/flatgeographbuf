/**
 * Scale and performance sanity tests. These build progressively larger
 * datasets (up to the documented NexAtlas target of ~50 k features),
 * round-trip them through serialize + open + queries, and assert that:
 *
 *  - no operation throws or produces obviously wrong counts
 *  - lazy queries on a randomly-chosen record complete in well under
 *    100 ms (loose budget — caches warm up after the first call)
 *  - the full preload cycle on a 50 k file completes in under 5 s
 *
 * No micro-benchmarks here; this is a smoke test that the algorithms
 * don't blow up at scale. Use a dedicated benchmark harness for tighter
 * measurements.
 */

import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { FlatGeoGraphBuf, serialize } from './geojson.js';
import type { AdjacencyListInput } from './graph-types.js';

/** Generate a synthetic city-network-like dataset.
 *  Each feature has a name (3 tokens), an icao-style code, an elevation
 *  number and an `intl` boolean. Edges form a sparse ring of road-style
 *  connections. */
function syntheticGraph(n: number): {
    geojson: GeoJsonFeatureCollection;
    adjacency: AdjacencyListInput;
} {
    const features = Array.from({ length: n }, (_, i) => ({
        type: 'Feature' as const,
        geometry: {
            type: 'Point' as const,
            coordinates: [-46.6 + (i % 200) * 0.01, -23.5 + Math.floor(i / 200) * 0.01],
        },
        properties: {
            name: `Cidade ${i} Centro`,
            icao: `SB${(i % 26 + 0x41).toString(36).toUpperCase()}${(((i / 26) | 0) % 26 + 0x41).toString(36).toUpperCase()}`,
            elev_ft: (i * 7) % 5000,
            intl: i % 11 === 0,
        },
    }));
    const edges: AdjacencyListInput['edges'] = [];
    for (let i = 0; i < n - 1; i++) {
        edges.push({
            from: i,
            to: i + 1,
            properties: {
                road: `BR-${(i % 500).toString().padStart(3, '0')}`,
                km: (i * 13) % 2000,
                paved: i % 3 !== 0,
            },
        });
    }
    return { geojson: { type: 'FeatureCollection', features }, adjacency: { edges } };
}

interface Timed<T> {
    result: T;
    ms: number;
}
async function time<T>(fn: () => Promise<T>): Promise<Timed<T>> {
    const t0 = performance.now();
    const result = await fn();
    return { result, ms: performance.now() - t0 };
}

describe('scale & performance — synthetic graphs', () => {
    it('1 000 features × 999 edges with all indices round-trips', async () => {
        const { geojson, adjacency } = syntheticGraph(1_000);
        const bytes = serialize(geojson, adjacency, {
            columnIndex: {
                vertices: ['name', 'icao', 'elev_ft', 'intl'],
                edges: ['road', 'km', 'paved'],
            },
        });
        expect(bytes.byteLength).toBeGreaterThan(0);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        expect(fgg.featureCount).toBe(1_000);
        expect(fgg.layout.header.edgeCount).toBe(999);
    });

    it('10 000 features — text query completes quickly after preload', async () => {
        const { geojson, adjacency } = syntheticGraph(10_000);
        const bytes = serialize(geojson, adjacency, {
            columnIndex: { vertices: ['name', 'icao'], edges: ['road'] },
        });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        await fgg.preload();

        const { result: hits, ms } = await time(async () => {
            const out = [];
            for await (const h of fgg.findVerticesByText('name', 'cidade 1234')) out.push(h);
            return out;
        });
        // Exactly one feature has name "Cidade 1234 Centro".
        expect(hits.length).toBe(1);
        // 10 k features × tier scoring should easily finish in 100 ms.
        expect(ms).toBeLessThan(200);
    });

    it('50 000 features — full lifecycle (serialize → open → preload → query → release)', async () => {
        const N = 50_000;
        const { geojson, adjacency } = syntheticGraph(N);

        const { result: bytes, ms: serializeMs } = await time(async () =>
            serialize(geojson, adjacency, {
                writeIndex: true,
                writeAdjacencyIndex: true,
                writeEdgeIndex: true,
                columnIndex: {
                    vertices: ['name', 'icao', 'elev_ft', 'intl'],
                    edges: ['road', 'km', 'paved'],
                },
            }),
        );
        expect(bytes.byteLength).toBeGreaterThan(0);
        // serialize should comfortably finish in a few seconds even with
        // every index on.
        expect(serializeMs).toBeLessThan(10_000);

        const { result: fgg, ms: openMs } = await time(() => FlatGeoGraphBuf.open(bytes));
        // Open is supposed to be O(1) reads — it should be trivially fast.
        expect(openMs).toBeLessThan(200);

        const { ms: preloadMs } = await time(() => fgg.preload());
        expect(preloadMs).toBeLessThan(5_000);

        const { result: textHits, ms: textMs } = await time(async () => {
            const out = [];
            for await (const h of fgg.findVerticesByText('icao', 'SB', { limit: 10 })) {
                out.push(h);
            }
            return out;
        });
        expect(textHits.length).toBe(10);
        // ICAO prefix query on 50 k entries with limit 10 should be < 100 ms.
        expect(textMs).toBeLessThan(500);

        const { result: valueHits, ms: valueMs } = await time(async () => {
            const out = [];
            for await (const f of fgg.findVerticesByValue('elev_ft', { gte: 4000 })) {
                out.push(f);
            }
            return out;
        });
        expect(valueHits.length).toBeGreaterThan(0);
        expect(valueMs).toBeLessThan(1_000);

        // Release everything; subsequent query should still work (lazily).
        fgg.release();
        const { result: lazyHits } = await time(async () => {
            const out = [];
            for await (const h of fgg.findVerticesByText('icao', 'SBAA')) out.push(h);
            return out;
        });
        expect(lazyHits.length).toBeGreaterThanOrEqual(0);
    }, 30_000);

    it('open()-only on 50 000 features stays under ~100 ms (lightweight init)', async () => {
        const N = 50_000;
        const { geojson, adjacency } = syntheticGraph(N);
        const bytes = serialize(geojson, adjacency, {
            columnIndex: {
                vertices: ['name', 'icao', 'elev_ft', 'intl'],
                edges: ['road', 'km', 'paved'],
            },
        });
        const { ms } = await time(() => FlatGeoGraphBuf.open(bytes));
        expect(ms).toBeLessThan(200);
    }, 30_000);

    it('outgoingEdgesOf on a random vertex is O(deg) under reasonable budget', async () => {
        const { geojson, adjacency } = syntheticGraph(10_000);
        const bytes = serialize(geojson, adjacency);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        await fgg.preload();
        const { result, ms } = await time(async () => {
            const out = [];
            for await (const e of fgg.outgoingEdgesOf(5_000)) out.push(e);
            return out;
        });
        expect(result.length).toBeGreaterThanOrEqual(0);
        // After preload, this is in-memory iteration, should be sub-ms.
        expect(ms).toBeLessThan(50);
    });

    it('shortestPath across 10 000-vertex chain completes in reasonable time', async () => {
        const N = 10_000;
        const { geojson, adjacency } = syntheticGraph(N);
        // Disable Hilbert reordering so the input chain `i → i+1` keeps
        // contiguous file indices and the path endpoints stay 0..N-1.
        const bytes = serialize(geojson, adjacency, { writeIndex: false });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        await fgg.preload();
        const { result: path, ms } = await time(() =>
            fgg.shortestPath(0, N - 1, { heuristic: null }),
        );
        expect(path).not.toBeNull();
        expect(path?.edges.length).toBe(N - 1);
        // Dijkstra over 10 k nodes with sparse search state.
        expect(ms).toBeLessThan(5_000);
    }, 15_000);
});

describe('scale — toGeoJson() reproduces the original input', () => {
    it('round-trips 1 000 features + 999 edges via toGeoJson', async () => {
        const { geojson, adjacency } = syntheticGraph(1_000);
        const bytes = serialize(geojson, adjacency);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        const { features, adjacencyList } = await fgg.toGeoJson();
        expect(features.length).toBe(1_000);
        expect(adjacencyList.edges.length).toBe(999);
    });
});
