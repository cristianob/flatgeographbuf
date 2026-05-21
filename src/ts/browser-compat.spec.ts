import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static checks that catch the most common ways the library would
 * break in a browser / React Native context — namely, accidentally
 * importing a Node built-in (`node:fs`, `node:path`, `node:buffer`,
 * `node:url`, etc.) from a module that ends up in the public ESM
 * bundle.
 *
 * The companion file `test/browser-smoke.html` provides a manual
 * end-to-end check: serve the repo with `npx serve .`, open the HTML
 * page, and watch all assertions go green inside a real browser.
 */

const DIST_DIR = resolve(__dirname, '..', '..', 'dist');

interface BundleSpec {
    file: string;
    /** Symbols that the minified bundle MUST contain. */
    mustExpose: string[];
}

const BUNDLES: BundleSpec[] = [
    {
        // Generic / low-level API (UMD).
        file: 'flatgeographbuf.min.js',
        mustExpose: ['deserialize', 'parseProperties'],
    },
    {
        // Generic / low-level API (ESM).
        file: 'flatgeographbuf.esm.min.js',
        mustExpose: ['deserialize', 'parseProperties'],
    },
    {
        // The headline GeoJSON-facing surface (UMD).
        file: 'flatgeographbuf-geojson.min.js',
        mustExpose: [
            'FlatGeoGraphBuf',
            'serialize',
            'deserialize',
            'byteReaderFromUint8Array',
            'byteReaderFromUrl',
        ],
    },
    {
        // The headline GeoJSON-facing surface (ESM).
        file: 'flatgeographbuf-geojson.esm.min.js',
        mustExpose: [
            'FlatGeoGraphBuf',
            'serialize',
            'deserialize',
            'byteReaderFromUint8Array',
            'byteReaderFromUrl',
        ],
    },
    {
        // OpenLayers integration.
        file: 'flatgeographbuf-ol.min.js',
        mustExpose: ['serialize', 'deserialize', 'createLoader'],
    },
];

function readBundle(name: string): string {
    return readFileSync(resolve(DIST_DIR, name), 'utf8');
}

describe('Browser compatibility — production bundles', () => {
    for (const { file, mustExpose } of BUNDLES) {
        describe(file, () => {
            it('does not import any Node built-in module', () => {
                const src = readBundle(file);
                const offending = src.match(/(?:require|import)[^"']*["']node:[^"']+["']/g);
                expect(offending, `bundle should not reference node:* modules`).toBeNull();
            });

            it('does not reference Node-only globals (Buffer/process/__dirname/…)', () => {
                const src = readBundle(file);
                const bufferUsage = /\bBuffer\.(?:from|alloc|isBuffer|byteLength|concat|of)\b/.test(src);
                const processUsage = /\bprocess\.(?:env|argv|version|platform|cwd|nextTick)\b/.test(src);
                const dirname = /\b__dirname\b/.test(src);
                const filename = /\b__filename\b/.test(src);
                expect({ bufferUsage, processUsage, dirname, filename }).toEqual({
                    bufferUsage: false,
                    processUsage: false,
                    dirname: false,
                    filename: false,
                });
            });

            it('exposes the documented top-level symbols', () => {
                const src = readBundle(file);
                for (const symbol of mustExpose) {
                    expect(src, `${file} should mention ${symbol}`).toMatch(new RegExp(`\\b${symbol}\\b`));
                }
            });
        });
    }
});
