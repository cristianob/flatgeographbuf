/**
 * Generate the FGG fixtures used by the test suite.
 *
 * Run with:
 *   pnpm tsx script/gen_fixtures.ts
 *
 * Each fixture is a small, deterministic FlatGeoGraphBuf file that
 * exercises a different combination of write-time flags (with/without
 * vertex R-tree, with/without graph indices, with/without edge
 * geometry). The output lives under `test/data/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureCollection } from 'geojson';
import { serialize } from '../src/ts/geojson.js';
import type { AdjacencyListInput } from '../src/ts/graph-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'test', 'data');
mkdirSync(OUT_DIR, { recursive: true });

// ─── Fixture 1: cities-network.fgg ────────────────────────────────────
// 5 Brazilian capitals connected by a few directed edges. All three
// indices on (the library default). Useful for round-trip + query tests.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.633, -23.55] }, properties: { iata: 'SAO', name: 'São Paulo' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.173, -22.907] }, properties: { iata: 'RIO', name: 'Rio de Janeiro' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.929, -15.78] }, properties: { iata: 'BSB', name: 'Brasília' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-38.51, -12.971] }, properties: { iata: 'SSA', name: 'Salvador' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.273, -25.428] }, properties: { iata: 'CWB', name: 'Curitiba' } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        edges: [
            { from: 0, to: 1, properties: { road: 'BR-116', km: 429 } },
            { from: 0, to: 2, properties: { road: 'BR-050', km: 1015 } },
            { from: 0, to: 4, properties: { road: 'BR-116', km: 408 } },
            { from: 1, to: 3, properties: { road: 'BR-101', km: 1649 } },
            { from: 2, to: 3, properties: { road: 'BR-242', km: 1446 } },
        ],
    };
    const bytes = serialize(geojson, adjacency);
    writeFileSync(resolve(OUT_DIR, 'cities-network.fgg'), bytes);
    console.log(`✓ cities-network.fgg  ${bytes.byteLength} bytes`);
}

// ─── Fixture 2: grid-with-paths.fgg ───────────────────────────────────
// 4×4 grid of points with bidirectional edges + LineString paths on
// some edges. Used for spatial-filter tests and shortest-path tests.
{
    const n = 4;
    const features = [] as FeatureCollection['features'];
    for (let i = 0; i < n * n; i++) {
        const x = -46.6 + (i % n) * 0.01;
        const y = -23.5 + Math.floor(i / n) * 0.01;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [x, y] },
            properties: { id: i },
        });
    }
    const edges: AdjacencyListInput['edges'] = [];
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            const here = row * n + col;
            if (col + 1 < n) {
                edges.push({ from: here, to: here + 1, properties: { dir: 'E' } });
                edges.push({ from: here + 1, to: here, properties: { dir: 'W' } });
            }
            if (row + 1 < n) {
                edges.push({ from: here, to: here + n, properties: { dir: 'N' } });
                edges.push({ from: here + n, to: here, properties: { dir: 'S' } });
            }
        }
    }
    // Add a straight diagonal edge with explicit LineString geometry
    // between two opposite corners. Two intermediate waypoints (along
    // the same line) exercise the multi-vertex LineString code path
    // while still making the diagonal the shortest path between corners.
    const a = features[0].geometry as { coordinates: number[] };
    const b = features[n * n - 1].geometry as { coordinates: number[] };
    edges.push({
        from: 0,
        to: n * n - 1,
        geometry: {
            type: 'LineString',
            coordinates: [
                a.coordinates,
                [
                    a.coordinates[0] + (b.coordinates[0] - a.coordinates[0]) / 3,
                    a.coordinates[1] + (b.coordinates[1] - a.coordinates[1]) / 3,
                ],
                [
                    a.coordinates[0] + (2 * (b.coordinates[0] - a.coordinates[0])) / 3,
                    a.coordinates[1] + (2 * (b.coordinates[1] - a.coordinates[1])) / 3,
                ],
                b.coordinates,
            ],
        },
        properties: { dir: 'diag' },
    });

    const bytes = serialize({ type: 'FeatureCollection', features }, { edges });
    writeFileSync(resolve(OUT_DIR, 'grid-with-paths.fgg'), bytes);
    console.log(`✓ grid-with-paths.fgg ${bytes.byteLength} bytes`);
}

// ─── Fixture 3: no-indices.fgg ────────────────────────────────────────
// Same cities graph but written with every index disabled. Used to
// verify lazy/no-index code paths and error messages.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.633, -23.55] }, properties: { name: 'A' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.173, -22.907] }, properties: { name: 'B' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.929, -15.78] }, properties: { name: 'C' } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        edges: [
            { from: 0, to: 1, properties: {} },
            { from: 1, to: 2, properties: {} },
        ],
    };
    const bytes = serialize(geojson, adjacency, {
        writeIndex: false,
        writeAdjacencyIndex: false,
        writeEdgeIndex: false,
    });
    writeFileSync(resolve(OUT_DIR, 'no-indices.fgg'), bytes);
    console.log(`✓ no-indices.fgg      ${bytes.byteLength} bytes`);
}

// ─── Fixture 4: minimal.fgg ───────────────────────────────────────────
// Smallest possible FGG file: a single vertex, no edges, no indices at
// all. Used to verify the absolute-minimum format handshake.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
        ],
    };
    const bytes = serialize(geojson, undefined, {
        writeIndex: false,
        writeAdjacencyIndex: false,
        writeEdgeIndex: false,
    });
    writeFileSync(resolve(OUT_DIR, 'minimal.fgg'), bytes);
    console.log(`✓ minimal.fgg         ${bytes.byteLength} bytes`);
}

// ─── Fixture 5: maximal.fgg ───────────────────────────────────────────
// Every index turned on, every property-column type represented on
// both vertices and edges. Stresses the most complex file we can
// produce.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo', icao: 'SBSP', elev_ft: 2461, intl: true } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio de Janeiro', icao: 'SBRJ', elev_ft: 11, intl: false } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília', icao: 'SBBR', elev_ft: 3497, intl: true } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.27, -16.68] }, properties: { name: 'São José do Rio Preto', icao: 'SBSR', elev_ft: 1784, intl: false } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-44.20, -22.30] }, properties: { name: 'Rio Preto', icao: 'SDRP', elev_ft: 100, intl: false } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        edges: [
            { from: 0, to: 1, properties: { road: 'BR-116', km: 429, paved: true } },
            { from: 0, to: 2, properties: { road: 'BR-050', km: 1015, paved: true } },
            { from: 0, to: 3, properties: { road: 'BR-153', km: 442, paved: true } },
            { from: 3, to: 4, properties: { road: 'BR-101', km: 770, paved: false } },
        ],
    };
    const bytes = serialize(geojson, adjacency, {
        writeIndex: true,
        writeAdjacencyIndex: true,
        writeEdgeIndex: true,
        columnIndex: {
            vertices: ['name', 'icao', 'elev_ft', 'intl'],
            edges: ['road', 'km', 'paved'],
        },
    });
    writeFileSync(resolve(OUT_DIR, 'maximal.fgg'), bytes);
    console.log(`✓ maximal.fgg         ${bytes.byteLength} bytes`);
}

console.log(`\nFixtures written to ${OUT_DIR}`);
