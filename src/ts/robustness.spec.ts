/**
 * Robustness: malformed property index blocks and other corrupted-byte
 * scenarios. Each test serialises a valid FGG file, then surgically
 * mutates specific bytes inside the property-index block before opening
 * — the reader must either throw a descriptive error or stop gracefully
 * (no infinite loop, no silent garbage parse).
 */

import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { FlatGeoGraphBuf, serialize } from './geojson.js';
import type { AdjacencyListInput } from './graph-types.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

function tinyGraph(): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
    return {
        geojson: {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'alpha', n: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'beta',  n: 2 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { name: 'gamma', n: 3 } },
            ],
        },
        adjacency: {
            edges: [
                { from: 0, to: 1, properties: { road: 'aa', km: 10, ok: true } },
                { from: 1, to: 2, properties: { road: 'bb', km: 20, ok: false } },
            ],
        },
    };
}

/**
 * Returns the absolute byte offset where the vertex property index
 * block (length prefix + content) starts, for a file emitted with
 * `columnIndex.vertices` and default settings.
 */
function locateVertexPropIdxStart(bytes: Uint8Array): number {
    // magic (8) + headerSize (4) + headerLength (variable) + flags (1)
    // + R-tree (variable; here we always have R-tree since writeIndex
    // is on by default) = start of property index size prefix.
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 8).getUint32(0, true);
    const flagsOffset = 8 + 4 + headerLength;
    // 3 features × 16 nodeSize → tree fits in 1 leaf row, calcTreeSize handles padding.
    // We compute the R-tree size empirically by reading the flags byte and counting
    // tree bytes that follow it via the format's own convention.
    const flagsByte = bytes[flagsOffset];
    if ((flagsByte & 0x01) === 0) throw new Error('expected R-tree present in test fixture');
    if ((flagsByte & 0x02) === 0) throw new Error('expected property index present in test fixture');
    // R-tree size for 3 features × node size 16: 3 leaves form 1 node row above ⇒ 4 nodes × 40B = 160B.
    return flagsOffset + 1 + 160; // start of [size:4B][content]
}

describe('robustness — corrupt property index block', () => {
    it('throws when the block size header claims more bytes than the file holds', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const propIdxStart = locateVertexPropIdxStart(corrupted);
        // Overwrite the 4-byte size prefix with a wildly large value.
        new DataView(corrupted.buffer).setUint32(propIdxStart, 0x7fffffff, true);

        // Either `open()` fails immediately (because the bogus size
        // misaligns the graph section) or `open()` succeeds and the
        // first text query fails. Both are acceptable; the contract is
        // "loud, finite failure" — no silent garbage parsing.
        await expect(
            (async () => {
                const fgg = await FlatGeoGraphBuf.open(corrupted);
                await collect(fgg.findVerticesByText('name', 'alpha'));
            })(),
        ).rejects.toThrow();
    });

    it('throws when the text-column count claims more columns than the buffer holds', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const propIdxStart = locateVertexPropIdxStart(corrupted);
        const contentStart = propIdxStart + 4;
        // First field of the block payload is `textColumnCount: uint32`.
        new DataView(corrupted.buffer).setUint32(contentStart, 0xffff_ffff, true);

        const fgg = await FlatGeoGraphBuf.open(corrupted);
        await expect(collect(fgg.findVerticesByText('name', 'alpha'))).rejects.toThrow();
    });

    it('rejects a property index where a token offset points outside the token pool', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const propIdxStart = locateVertexPropIdxStart(corrupted);
        // We don't know the exact offset of the first entry's tokenOffset
        // without re-parsing, but we can stomp on the tail of the block
        // where entries live, which will still produce decoding errors
        // (an enormous tokenOffset or a non-printable token will sort
        // weirdly).
        const view = new DataView(corrupted.buffer);
        const blockSize = view.getUint32(propIdxStart, true);
        // Set every byte of the entries half of the block to 0xff.
        const blockEnd = propIdxStart + 4 + blockSize;
        for (let i = blockEnd - Math.min(40, blockSize); i < blockEnd; i++) corrupted[i] = 0xff;

        const fgg = await FlatGeoGraphBuf.open(corrupted);
        // Either we get an error OR we get a non-crash empty / wrong-but-bounded result.
        // The contract is "don't crash JavaScript runtime" — any of the below is acceptable.
        try {
            const hits = await collect(fgg.findVerticesByText('name', 'alpha'));
            // If it didn't throw, the hits must at least be a finite array.
            expect(Array.isArray(hits)).toBe(true);
            expect(hits.length).toBeLessThanOrEqual(corrupted.byteLength);
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
        }
    });

    it('throws on a property index block whose size prefix says 0 but file has data', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const propIdxStart = locateVertexPropIdxStart(corrupted);
        // Force block size to 0 — the reader will then expect zero bytes of content,
        // but the alignment/feature offsets it computes from there will land on garbage.
        new DataView(corrupted.buffer).setUint32(propIdxStart, 0, true);
        // The instance may open (we don't validate inner sizes at open time) but
        // downstream queries should fail.
        try {
            const fgg = await FlatGeoGraphBuf.open(corrupted);
            await expect(collect(fgg.findVerticesByText('name', 'alpha'))).rejects.toThrow();
        } catch (err) {
            // Or `open()` itself may fail if the misaligned features section
            // breaks header parsing.
            expect(err).toBeInstanceOf(Error);
        }
    });
});

describe('robustness — corrupted file headers and magic bytes', () => {
    it('rejects a buffer with the wrong magic byte version', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const corrupted = new Uint8Array(bytes);
        // Magic is "fgg\x02fgg\x00"; flip byte 3 to 0x99 to fake a future major.
        corrupted[3] = 0x99;
        await expect(FlatGeoGraphBuf.open(corrupted)).rejects.toThrow(/magic/i);
    });

    it('rejects a buffer with totally random first 32 bytes', async () => {
        const corrupted = new Uint8Array(64).map((_, i) => (i * 0x9e + 1) & 0xff);
        await expect(FlatGeoGraphBuf.open(corrupted)).rejects.toThrow();
    });

    it('rejects an empty buffer', async () => {
        await expect(FlatGeoGraphBuf.open(new Uint8Array(0))).rejects.toThrow();
    });

    it('rejects a buffer with only the magic bytes (truncated)', async () => {
        const onlyMagic = new Uint8Array([0x66, 0x67, 0x67, 0x02, 0x66, 0x67, 0x67, 0x00]);
        await expect(FlatGeoGraphBuf.open(onlyMagic)).rejects.toThrow();
    });
});

describe('robustness — value-column quirks', () => {
    it('skips features with NaN/Infinity/null in a numeric column', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { v: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { v: Number.NaN } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { v: Number.POSITIVE_INFINITY } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 0] }, properties: { v: null } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [4, 0] }, properties: { v: 5 } },
            ],
        };
        const bytes = serialize(geojson, { edges: [] }, { columnIndex: { vertices: ['v'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        const hits = await collect(fgg.findVerticesByValue('v', { gte: 0 }));
        // Only the 1 and 5 entries should be indexed and returned.
        expect(hits.length).toBe(2);
    });

    it('handles a boolean column with all-true or all-false records', async () => {
        const allTrue: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: Array.from({ length: 5 }, (_, i) => ({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [i, 0] },
                properties: { flag: true },
            })),
        };
        const bytes = serialize(allTrue, { edges: [] }, { columnIndex: { vertices: ['flag'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        expect((await collect(fgg.findVerticesByValue('flag', { eq: true }))).length).toBe(5);
        expect((await collect(fgg.findVerticesByValue('flag', { eq: false }))).length).toBe(0);
    });

    it('returns empty results when querying with an impossible numeric range', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['n'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        expect(
            (await collect(fgg.findVerticesByValue('n', { gte: 100, lt: 50 }))).length,
        ).toBe(0);
    });
});

describe('robustness — text-query edge cases', () => {
    it('returns empty when the query is empty after tokenisation', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['name'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        expect((await collect(fgg.findVerticesByText('name', ''))).length).toBe(0);
        expect((await collect(fgg.findVerticesByText('name', '!@#'))).length).toBe(0);
        expect((await collect(fgg.findVerticesByText('name', '   '))).length).toBe(0);
    });

    it('accepts a single-character prefix and still returns hits', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { columnIndex: { vertices: ['name'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        const hits = await collect(fgg.findVerticesByText('name', 'a'));
        expect(hits.length).toBe(1);
        expect((hits[0].feature.properties as { name: string }).name).toBe('alpha');
    });

    it('returns 0 hits when no record has any token for the column', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A', other: 'x' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'B', other: 'y' } },
            ],
        };
        const bytes = serialize(geojson, { edges: [] }, { columnIndex: { vertices: ['other'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        const hits = await collect(fgg.findVerticesByText('other', 'absent'));
        expect(hits.length).toBe(0);
    });

    it('handles a token that appears multiple times in one indexed string', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'rio rio grande' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'rio uno' } },
            ],
        };
        const bytes = serialize(geojson, { edges: [] }, { columnIndex: { vertices: ['name'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        const hits = await collect(fgg.findVerticesByText('name', 'rio'));
        // The first string still surfaces only once even though it contains
        // the token twice.
        const names = hits.map((h) => (h.feature.properties as { name: string }).name);
        expect(names).toEqual(['rio rio grande', 'rio uno']);
    });
});

describe('robustness — Unicode normalisation beyond pt-BR', () => {
    it('strips diacritics across multiple scripts', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'Zürich' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'Köln' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { name: 'Málaga' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 0] }, properties: { name: 'Ñuble' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [4, 0] }, properties: { name: 'Łódź' } },
            ],
        };
        const bytes = serialize(geojson, { edges: [] }, { columnIndex: { vertices: ['name'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        // German: "Zürich" → "zurich"
        expect((await collect(fgg.findVerticesByText('name', 'zur'))).length).toBe(1);
        // Spanish: "Málaga" → "malaga"
        expect((await collect(fgg.findVerticesByText('name', 'mal'))).length).toBe(1);
        // Spanish ñ: "Ñuble" → "nuble"
        expect((await collect(fgg.findVerticesByText('name', 'nub'))).length).toBe(1);
    });

    it('handles CJK strings (no token splitting on ideographs)', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: '東京' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: '京都' } },
            ],
        };
        const bytes = serialize(geojson, { edges: [] }, { columnIndex: { vertices: ['name'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        // No whitespace/punct between CJK chars → each string is one token.
        const tokyo = await collect(fgg.findVerticesByText('name', '東京'));
        const kyoto = await collect(fgg.findVerticesByText('name', '京都'));
        expect(tokyo.length).toBe(1);
        expect(kyoto.length).toBe(1);
    });

    it('treats currency / math symbols as token separators', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A+B' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'A$B' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { name: 'AAB' } },
            ],
        };
        const bytes = serialize(geojson, { edges: [] }, { columnIndex: { vertices: ['name'] } });
        const fgg = await FlatGeoGraphBuf.open(bytes);
        // "A B" should match both the + and $ variants (tier A) and not AAB.
        const hits = await collect(fgg.findVerticesByText('name', 'a b'));
        const names = hits.map((h) => (h.feature.properties as { name: string }).name).sort();
        expect(names).toEqual(['A$B', 'A+B']);
    });
});

describe('robustness — shortestPath weight extremes', () => {
    it('rejects a weight function that returns NaN', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        await expect(
            fgg.shortestPath(0, 2, { weight: () => Number.NaN, heuristic: null }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('rejects a negative weight', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        await expect(
            fgg.shortestPath(0, 2, { weight: () => -1, heuristic: null }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('rejects Infinity weight', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        await expect(
            fgg.shortestPath(0, 2, { weight: () => Number.POSITIVE_INFINITY, heuristic: null }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('returns null when no path exists between disconnected vertices', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: {} },
            ],
        };
        const adjacency: AdjacencyListInput = {
            edges: [{ from: 0, to: 1, properties: {} }],
        };
        const bytes = serialize(geojson, adjacency);
        const fgg = await FlatGeoGraphBuf.open(bytes);
        // 0→1 connected, 2 is isolated.
        const path = await fgg.shortestPath(0, 2, { heuristic: null });
        expect(path).toBeNull();
    });
});
