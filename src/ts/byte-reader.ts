/**
 * Platform-agnostic byte-range reader. Implementations must return
 * exactly `length` bytes starting at `offset`; if fewer are available
 * (truncated file, request past end) they should throw.
 *
 * The interface is intentionally minimal so it can be backed by:
 *   - in-memory `Uint8Array` (Node, browser, React Native)
 *   - HTTP `Range:` requests via `fetch` (Node 18+, browser, RN)
 *   - Node `fs.promises.FileHandle.read`
 *   - React Native filesystem libraries that expose byte ranges
 *   - memory-mapped files (with a thin wrapper)
 *
 * All `FlatGeoGraphBuf` queries are driven through a `ByteReader`, so
 * the library can operate on multi-gigabyte files without loading them
 * into memory as long as the underlying platform supports random
 * access.
 */
export interface ByteReader {
    read(offset: number, length: number): Promise<Uint8Array>;
    /**
     * Optional "give me everything" shortcut. When implemented, the
     * library uses this for `preload()` and similar bulk operations
     * — it avoids needing to know the total size upfront and lets the
     * underlying transport stream the whole content in a single
     * request without negotiating byte ranges.
     */
    readAll?(): Promise<Uint8Array>;
}

/**
 * Adapt a fully-in-memory `Uint8Array` to the `ByteReader` interface.
 * Returns a zero-copy `subarray` view on each read.
 */
export function byteReaderFromUint8Array(bytes: Uint8Array): ByteReader {
    return {
        async read(offset: number, length: number): Promise<Uint8Array> {
            if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
                throw new RangeError(
                    `Read [${offset}, ${offset + length}) outside buffer [0, ${bytes.byteLength})`,
                );
            }
            return bytes.subarray(offset, offset + length);
        },
        async readAll(): Promise<Uint8Array> {
            return bytes;
        },
    };
}

export interface UrlReaderOptions {
    /** Extra headers to send on every request (e.g. auth). */
    headers?: HeadersInit;
    /** When `true`, sets `Cache-Control: no-cache` on every request. */
    nocache?: boolean;
}

/**
 * `ByteReader` backed by HTTP `Range:` requests. Works in any
 * environment that exposes a global `fetch` (Node ≥ 18, browsers,
 * React Native). The remote server MUST honour byte-range requests
 * (return HTTP 206 with the requested slice).
 */
export function byteReaderFromUrl(url: string, options: UrlReaderOptions = {}): ByteReader {
    return {
        async read(offset: number, length: number): Promise<Uint8Array> {
            if (length === 0) return new Uint8Array(0);
            const headers = new Headers(options.headers);
            headers.set('Range', `bytes=${offset}-${offset + length - 1}`);
            const response = await fetch(url, {
                headers,
                cache: options.nocache ? 'no-cache' : 'default',
            });
            if (response.status !== 206 && response.status !== 200) {
                throw new Error(
                    `Range request to ${url} failed: HTTP ${response.status} ${response.statusText}`,
                );
            }
            const buf = await response.arrayBuffer();
            const bytes = new Uint8Array(buf);
            if (bytes.byteLength < length) {
                throw new Error(
                    `Range request to ${url} returned ${bytes.byteLength} bytes, expected ${length}`,
                );
            }
            // Some servers return more than requested (e.g. ignoring Range and
            // returning the full body); trim to the requested window.
            return bytes.byteLength === length ? bytes : bytes.subarray(0, length);
        },
        async readAll(): Promise<Uint8Array> {
            // Plain GET, no Range header — the server streams the whole
            // body, CDNs cache it normally, and we don't need byte-range
            // support at all.
            const response = await fetch(url, {
                headers: options.headers,
                cache: options.nocache ? 'no-cache' : 'default',
            });
            if (!response.ok) {
                throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
            }
            const buf = await response.arrayBuffer();
            return new Uint8Array(buf);
        },
    };
}

/**
 * Internal helper used by `FlatGeoGraphBuf.open()`. Accepts an explicit
 * `ByteReader` or a `Uint8Array` (which is wrapped into one).
 */
export function toByteReader(source: Uint8Array | ByteReader): ByteReader {
    return source instanceof Uint8Array ? byteReaderFromUint8Array(source) : source;
}
