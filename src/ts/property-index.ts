import { SIZE_PREFIX_LEN } from './constants.js';

/**
 * Per-column property indices for vertices or edges.
 *
 * Three storage shapes, chosen at write time from the runtime type of
 * each indexed column:
 *
 * - `text`  → word-tokenised, NFKD-normalised + diacritic-stripped +
 *             lowercased. Stored as a sorted (token, recordId, position)
 *             entry list plus a deduplicated token pool and a
 *             per-record total-token count.
 * - `number` → sorted (value, recordId) entry list, supports range
 *             queries.
 * - `boolean` → two posting lists of recordIds (true, false).
 *
 * Queries on text columns support three modes:
 *   - `'prefix'` (default): each query token prefix-matches an indexed
 *                            token. `findByText('name', 'rio pre')`
 *                            matches "São José do Rio Preto".
 *   - `'token'`             : each query token must exactly equal an
 *                            indexed token (still position-independent).
 *   - `'exact'`             : the query as a whole, after tokenisation,
 *                            must equal the indexed value's full token
 *                            sequence.
 *
 * Text results are returned ranked: tier-A (consecutive in query order)
 * > tier-B (in query order with gaps) > tier-C (all tokens present, any
 * order). Ties broken by earliest match position, then recordId for
 * determinism. An optional `limit` truncates the ranked output.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ─────────────────────────── normalisation ─────────────────────────────

export function normalize(s: string): string {
    return s
        .normalize('NFKD')
        .replace(/\p{Mn}/gu, '')
        .toLowerCase();
}

/** Whitespace + Unicode punctuation + Unicode symbols (S category). The
 *  S category covers things like `$`, `+`, `€` that read as separators
 *  to humans even though they aren't formally "punctuation". */
const TOKEN_SPLIT = /[\s\p{P}\p{S}]+/u;

export function tokenize(s: string): string[] {
    if (!s) return [];
    return normalize(s).split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

// ───────────────────────────── value types ─────────────────────────────

export type PropertyColumnKind = 'text' | 'number' | 'boolean';

export interface PropertyIndexInput {
    /** Names of property fields to index. The runtime type of the first
     *  non-null value found is used to pick a column kind. */
    columns: string[];
    /** Accessor: return the value of `column` for record at `idx`, or
     *  `undefined` / `null` for "no value". */
    valueAt: (idx: number, column: string) => unknown;
    /** Total number of records (featureCount or edgeCount). */
    count: number;
}

interface ColumnDescriptor {
    name: string;
    kind: PropertyColumnKind;
}

function detectKind(value: unknown): PropertyColumnKind | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return 'text';
    if (typeof value === 'number' && Number.isFinite(value)) return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return null;
}

function classifyColumns(input: PropertyIndexInput): ColumnDescriptor[] {
    const descriptors: ColumnDescriptor[] = [];
    for (const name of input.columns) {
        let kind: PropertyColumnKind | null = null;
        for (let i = 0; i < input.count; i++) {
            kind = detectKind(input.valueAt(i, name));
            if (kind) break;
        }
        if (!kind) {
            throw new Error(
                `Cannot determine type for indexed column "${name}": no non-null values found.`,
            );
        }
        descriptors.push({ name, kind });
    }
    return descriptors;
}

// ───────────────────────────── builder ─────────────────────────────────

interface TextColumnBuild {
    name: string;
    tokenPool: Uint8Array;
    totalTokens: Uint16Array;
    entries: Uint8Array; // 10B × N, sorted by token bytes
}

interface NumericColumnBuild {
    name: string;
    entries: Uint8Array; // 12B × N, sorted by value asc
}

interface BoolColumnBuild {
    name: string;
    trueList: Uint32Array;
    falseList: Uint32Array;
}

function buildTextColumn(name: string, input: PropertyIndexInput): TextColumnBuild {
    const tokenIndex = new Map<string, number>(); // token → offset in pool
    const poolParts: string[] = [];
    let poolBytes = 0;

    interface Entry {
        tokenOffset: number;
        idx: number;
        position: number;
    }
    const entries: Entry[] = [];
    const totalTokens = new Uint16Array(input.count);

    const ensureToken = (tok: string): number => {
        let off = tokenIndex.get(tok);
        if (off === undefined) {
            off = poolBytes;
            tokenIndex.set(tok, off);
            poolParts.push(tok);
            poolBytes += textEncoder.encode(tok).length + 1; // + NUL separator
        }
        return off;
    };

    for (let idx = 0; idx < input.count; idx++) {
        const value = input.valueAt(idx, name);
        if (typeof value !== 'string') continue;
        const tokens = tokenize(value);
        if (tokens.length > 0xffff) {
            throw new Error(
                `Indexed value for column "${name}" at idx ${idx} has ${tokens.length} tokens; max 65535.`,
            );
        }
        totalTokens[idx] = tokens.length;
        for (let p = 0; p < tokens.length; p++) {
            entries.push({ tokenOffset: ensureToken(tokens[p]), idx, position: p });
        }
    }

    // Build pool bytes
    const tokenPool = new Uint8Array(poolBytes);
    let cursor = 0;
    for (const tok of poolParts) {
        const enc = textEncoder.encode(tok);
        tokenPool.set(enc, cursor);
        cursor += enc.length;
        tokenPool[cursor] = 0;
        cursor += 1;
    }

    // Sort entries by their referenced token bytes (lexicographic)
    entries.sort((a, b) => {
        if (a.tokenOffset === b.tokenOffset) {
            // Same token → tiebreak by idx then position for stable order
            return a.idx - b.idx || a.position - b.position;
        }
        return compareTokenBytes(tokenPool, a.tokenOffset, b.tokenOffset);
    });

    // Serialise entries: 10B each (tokenOffset:4, idx:4, position:2)
    const entriesBuf = new Uint8Array(entries.length * 10);
    const entriesView = new DataView(entriesBuf.buffer);
    for (let i = 0; i < entries.length; i++) {
        const off = i * 10;
        entriesView.setUint32(off, entries[i].tokenOffset, true);
        entriesView.setUint32(off + 4, entries[i].idx, true);
        entriesView.setUint16(off + 8, entries[i].position, true);
    }

    return { name, tokenPool, totalTokens, entries: entriesBuf };
}

function compareTokenBytes(pool: Uint8Array, offA: number, offB: number): number {
    let i = 0;
    while (true) {
        const a = pool[offA + i];
        const b = pool[offB + i];
        if (a === 0 && b === 0) return 0;
        if (a === 0) return -1;
        if (b === 0) return 1;
        if (a !== b) return a - b;
        i++;
    }
}

function readPoolToken(pool: Uint8Array, offset: number): string {
    let end = offset;
    while (end < pool.length && pool[end] !== 0) end++;
    return textDecoder.decode(pool.subarray(offset, end));
}

function buildNumericColumn(name: string, input: PropertyIndexInput): NumericColumnBuild {
    interface Entry {
        value: number;
        idx: number;
    }
    const entries: Entry[] = [];
    for (let idx = 0; idx < input.count; idx++) {
        const value = input.valueAt(idx, name);
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        entries.push({ value, idx });
    }
    entries.sort((a, b) => a.value - b.value || a.idx - b.idx);

    const buf = new Uint8Array(entries.length * 12);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < entries.length; i++) {
        const off = i * 12;
        view.setFloat64(off, entries[i].value, true);
        view.setUint32(off + 8, entries[i].idx, true);
    }
    return { name, entries: buf };
}

function buildBoolColumn(name: string, input: PropertyIndexInput): BoolColumnBuild {
    const trues: number[] = [];
    const falses: number[] = [];
    for (let idx = 0; idx < input.count; idx++) {
        const value = input.valueAt(idx, name);
        if (value === true) trues.push(idx);
        else if (value === false) falses.push(idx);
    }
    return {
        name,
        trueList: Uint32Array.from(trues),
        falseList: Uint32Array.from(falses),
    };
}

export function buildPropertyIndexBlock(input: PropertyIndexInput): Uint8Array {
    const descriptors = classifyColumns(input);
    const textCols: TextColumnBuild[] = [];
    const numCols: NumericColumnBuild[] = [];
    const boolCols: BoolColumnBuild[] = [];
    for (const { name, kind } of descriptors) {
        if (kind === 'text') textCols.push(buildTextColumn(name, input));
        else if (kind === 'number') numCols.push(buildNumericColumn(name, input));
        else if (kind === 'boolean') boolCols.push(buildBoolColumn(name, input));
    }

    // Compute total payload size
    const colNameSize = (name: string) => 4 + textEncoder.encode(name).length;
    let payload = 4; // textColumnCount
    for (const c of textCols) {
        payload += colNameSize(c.name);
        payload += 4 + c.tokenPool.byteLength;
        payload += 4 + c.totalTokens.byteLength;
        payload += 4 + c.entries.byteLength;
    }
    payload += 4; // numericColumnCount
    for (const c of numCols) {
        payload += colNameSize(c.name);
        payload += 4 + c.entries.byteLength;
    }
    payload += 4; // boolColumnCount
    for (const c of boolCols) {
        payload += colNameSize(c.name);
        payload += 4 + c.trueList.byteLength;
        payload += 4 + c.falseList.byteLength;
    }

    // Emit with leading 4-byte size prefix; mirrors how the other
    // graph-section blocks (adjacency CSR, edge R-tree) embed
    // themselves.
    const buf = new Uint8Array(SIZE_PREFIX_LEN + payload);
    const view = new DataView(buf.buffer);
    view.setUint32(0, payload, true);
    let cursor = SIZE_PREFIX_LEN;

    const writeName = (name: string) => {
        const enc = textEncoder.encode(name);
        view.setUint32(cursor, enc.length, true);
        cursor += 4;
        buf.set(enc, cursor);
        cursor += enc.length;
    };
    const writeBytes = (data: Uint8Array) => {
        view.setUint32(cursor, data.byteLength, true);
        cursor += 4;
        buf.set(data, cursor);
        cursor += data.byteLength;
    };

    view.setUint32(cursor, textCols.length, true);
    cursor += 4;
    for (const c of textCols) {
        writeName(c.name);
        writeBytes(c.tokenPool);
        writeBytes(new Uint8Array(c.totalTokens.buffer, c.totalTokens.byteOffset, c.totalTokens.byteLength));
        writeBytes(c.entries);
    }

    view.setUint32(cursor, numCols.length, true);
    cursor += 4;
    for (const c of numCols) {
        writeName(c.name);
        writeBytes(c.entries);
    }

    view.setUint32(cursor, boolCols.length, true);
    cursor += 4;
    for (const c of boolCols) {
        writeName(c.name);
        writeBytes(new Uint8Array(c.trueList.buffer, c.trueList.byteOffset, c.trueList.byteLength));
        writeBytes(new Uint8Array(c.falseList.buffer, c.falseList.byteOffset, c.falseList.byteLength));
    }

    return buf;
}

// ───────────────────────────── parser ──────────────────────────────────

export interface TextColumn {
    name: string;
    tokenPool: Uint8Array;
    totalTokens: Uint16Array;
    /** Sorted (tokenOffset, idx, position) entries; 10 bytes each. */
    entries: Uint8Array;
}

export interface NumericColumn {
    name: string;
    /** Sorted (value: f64 LE, idx: u32 LE) entries; 12 bytes each. */
    entries: Uint8Array;
}

export interface BoolColumn {
    name: string;
    trueList: Uint32Array;
    falseList: Uint32Array;
}

export interface PropertyIndex {
    text: Map<string, TextColumn>;
    numeric: Map<string, NumericColumn>;
    bool: Map<string, BoolColumn>;
}

/**
 * Parse a property-index block. `bytes` should start at the first byte
 * AFTER the outer length prefix (i.e. the block content itself).
 */
export function parsePropertyIndexBlock(bytes: Uint8Array): PropertyIndex {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    let cursor = 0;

    const readU32 = (): number => {
        const v = view.getUint32(cursor, true);
        cursor += 4;
        return v;
    };
    const readBytes = (n: number): Uint8Array => {
        const sub = bytes.subarray(cursor, cursor + n);
        cursor += n;
        return sub;
    };
    const readName = (): string => {
        const len = readU32();
        return textDecoder.decode(readBytes(len));
    };
    const readLengthPrefixed = (): Uint8Array => readBytes(readU32());

    const text = new Map<string, TextColumn>();
    const numeric = new Map<string, NumericColumn>();
    const bool = new Map<string, BoolColumn>();

    // Typed arrays require natural alignment, which we cannot guarantee
    // on subarrays of an arbitrary byte offset — copy into fresh
    // aligned buffers.
    const copyToUint16 = (src: Uint8Array): Uint16Array => {
        const out = new Uint16Array(src.byteLength / 2);
        new Uint8Array(out.buffer).set(src);
        return out;
    };
    const copyToUint32 = (src: Uint8Array): Uint32Array => {
        const out = new Uint32Array(src.byteLength / 4);
        new Uint8Array(out.buffer).set(src);
        return out;
    };

    const textCount = readU32();
    for (let i = 0; i < textCount; i++) {
        const name = readName();
        const tokenPool = readLengthPrefixed();
        const totalTokensRaw = readLengthPrefixed();
        const totalTokens = copyToUint16(totalTokensRaw);
        const entries = readLengthPrefixed();
        text.set(name, { name, tokenPool, totalTokens, entries });
    }

    const numCount = readU32();
    for (let i = 0; i < numCount; i++) {
        const name = readName();
        const entries = readLengthPrefixed();
        numeric.set(name, { name, entries });
    }

    const boolCount = readU32();
    for (let i = 0; i < boolCount; i++) {
        const name = readName();
        const trueRaw = readLengthPrefixed();
        const falseRaw = readLengthPrefixed();
        bool.set(name, {
            name,
            trueList: copyToUint32(trueRaw),
            falseList: copyToUint32(falseRaw),
        });
    }

    return { text, numeric, bool };
}

// ─────────────────────────── text querying ─────────────────────────────

export type MatchMode = 'prefix' | 'token' | 'exact';

export interface TextQueryOptions {
    match?: MatchMode;
    limit?: number;
}

/** Binary search the entries array for the range of indices whose token
 *  starts with (mode=prefix) or equals (mode=token/exact) `term`. */
function lookupTokenRange(
    column: TextColumn,
    term: string,
    exactMatch: boolean,
): { start: number; end: number } {
    const entries = column.entries;
    const pool = column.tokenPool;
    const entryCount = entries.byteLength / 10;
    if (entryCount === 0) return { start: 0, end: 0 };
    const entryView = new DataView(entries.buffer, entries.byteOffset);
    const termBytes = textEncoder.encode(term);

    const cmpAt = (entryIdx: number, prefix: boolean): number => {
        const tokenOff = entryView.getUint32(entryIdx * 10, true);
        let i = 0;
        while (i < termBytes.length) {
            const a = pool[tokenOff + i];
            if (a === undefined || a === 0) return -1; // pool token shorter
            if (a < termBytes[i]) return -1;
            if (a > termBytes[i]) return 1;
            i++;
        }
        // Term fully matched as prefix. For exact, the next pool byte
        // must be the NUL terminator.
        if (!prefix) {
            const next = pool[tokenOff + i];
            if (next !== 0 && next !== undefined) return 1;
        }
        return 0;
    };

    // Lower bound: first entry where token >= term (prefix-aware).
    let lo = 0;
    let hi = entryCount;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpAt(mid, !exactMatch) < 0) lo = mid + 1;
        else hi = mid;
    }
    const start = lo;
    if (start === entryCount) return { start, end: start };

    // Upper bound: first entry where token > term (prefix-aware).
    hi = entryCount;
    let upperLo = start;
    while (upperLo < hi) {
        const mid = (upperLo + hi) >>> 1;
        if (cmpAt(mid, !exactMatch) <= 0) upperLo = mid + 1;
        else hi = mid;
    }
    return { start, end: upperLo };
}

interface MatchInfo {
    /** positions in the candidate's original string where each query
     *  token matched. positions[i] is sorted ascending. */
    positions: number[][];
    /** total tokens in the candidate's indexed value. */
    totalTokens: number;
}

function collectMatches(
    column: TextColumn,
    queryTokens: string[],
    mode: MatchMode,
): Map<number, MatchInfo> {
    const exactToken = mode !== 'prefix';
    const view = new DataView(column.entries.buffer, column.entries.byteOffset);
    const candidates = new Map<number, MatchInfo>();

    // Pass 1: locate ranges for each query token. Track per-record
    // positions for ranking.
    const perTokenMatches: Array<Map<number, number[]>> = [];
    for (let q = 0; q < queryTokens.length; q++) {
        const { start, end } = lookupTokenRange(column, queryTokens[q], exactToken);
        const perRecord = new Map<number, number[]>();
        for (let i = start; i < end; i++) {
            const off = i * 10;
            const recordId = view.getUint32(off + 4, true);
            const position = view.getUint16(off + 8, true);
            let arr = perRecord.get(recordId);
            if (!arr) {
                arr = [];
                perRecord.set(recordId, arr);
            }
            arr.push(position);
        }
        perTokenMatches.push(perRecord);
    }

    // Intersect candidates across all query tokens (AND semantics).
    if (perTokenMatches.length === 0) return candidates;
    const smallest = perTokenMatches.reduce(
        (acc, m) => (m.size < acc.size ? m : acc),
        perTokenMatches[0],
    );
    outer: for (const recordId of smallest.keys()) {
        const positions: number[][] = new Array(queryTokens.length);
        for (let q = 0; q < queryTokens.length; q++) {
            const arr = perTokenMatches[q].get(recordId);
            if (!arr) continue outer;
            positions[q] = arr.slice().sort((a, b) => a - b);
        }
        candidates.set(recordId, {
            positions,
            totalTokens: column.totalTokens[recordId] ?? 0,
        });
    }
    return candidates;
}

/** Returns 3 (tier A), 2 (tier B), 1 (tier C). */
function tierFor(positions: number[][]): number {
    const n = positions.length;
    if (n === 0) return 1;
    if (n === 1) return 3; // single token is trivially "in order and consecutive"

    // Tier A: there exists a starting position p such that q[i] matched
    // at p+i for all i.
    for (const start of positions[0]) {
        let ok = true;
        for (let i = 1; i < n; i++) {
            if (!positions[i].includes(start + i)) {
                ok = false;
                break;
            }
        }
        if (ok) return 3;
    }

    // Tier B: there exists a strictly-increasing assignment.
    const recurseInOrder = (qIdx: number, minExclusive: number): boolean => {
        if (qIdx === n) return true;
        for (const p of positions[qIdx]) {
            if (p > minExclusive && recurseInOrder(qIdx + 1, p)) return true;
        }
        return false;
    };
    if (recurseInOrder(0, -1)) return 2;
    return 1;
}

function firstMatchPosition(positions: number[][]): number {
    let min = Number.POSITIVE_INFINITY;
    for (const arr of positions) {
        if (arr.length > 0 && arr[0] < min) min = arr[0];
    }
    return Number.isFinite(min) ? min : 0;
}

export interface TextSearchHit {
    recordId: number;
    tier: 'A' | 'B' | 'C';
    score: number;
}

export function searchText(
    column: TextColumn,
    query: string,
    options: TextQueryOptions = {},
): TextSearchHit[] {
    const mode: MatchMode = options.match ?? 'prefix';
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const candidates = collectMatches(column, queryTokens, mode);
    if (candidates.size === 0) return [];

    const hits: TextSearchHit[] = [];
    for (const [recordId, info] of candidates) {
        if (mode === 'exact') {
            // Require: total tokens equal to query length, AND tokens
            // match exactly and consecutively starting at position 0.
            if (info.totalTokens !== queryTokens.length) continue;
            // Walk position 0..n-1 and check each q[i] matched there.
            let ok = true;
            for (let q = 0; q < queryTokens.length; q++) {
                if (!info.positions[q].includes(q)) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
            hits.push({ recordId, tier: 'A', score: 1_000_000 - recordId });
            continue;
        }

        const tierNum = tierFor(info.positions);
        const tier: 'A' | 'B' | 'C' = tierNum === 3 ? 'A' : tierNum === 2 ? 'B' : 'C';
        const fpos = firstMatchPosition(info.positions);
        // score = tier << 24 | (1<<16 - firstPos) → primary by tier desc,
        // then by earliest position. recordId tiebreak handled by sort.
        const score = (tierNum << 24) | Math.max(0, 0x10000 - fpos);
        hits.push({ recordId, tier, score });
    }

    hits.sort((a, b) => b.score - a.score || a.recordId - b.recordId);
    if (options.limit !== undefined && options.limit >= 0) {
        hits.length = Math.min(hits.length, options.limit);
    }
    return hits;
}

// ─────────────────────────── value querying ────────────────────────────

export interface ValuePredicate {
    eq?: number | boolean;
    lt?: number;
    lte?: number;
    gt?: number;
    gte?: number;
}

export interface ValueQueryOptions {
    limit?: number;
}

export function searchNumeric(
    column: NumericColumn,
    predicate: ValuePredicate,
    options: ValueQueryOptions = {},
): number[] {
    const entries = column.entries;
    const entryCount = entries.byteLength / 12;
    if (entryCount === 0) return [];
    const view = new DataView(entries.buffer, entries.byteOffset);

    const valueAt = (i: number): number => view.getFloat64(i * 12, true);
    const idAt = (i: number): number => view.getUint32(i * 12 + 8, true);

    // Determine [start, end) range that satisfies predicate.
    let lo = 0;
    let hi = entryCount;
    if (predicate.eq !== undefined) {
        if (typeof predicate.eq !== 'number') return [];
        const target = predicate.eq;
        // Lower bound
        let s = 0;
        let e = entryCount;
        while (s < e) {
            const mid = (s + e) >>> 1;
            if (valueAt(mid) < target) s = mid + 1;
            else e = mid;
        }
        lo = s;
        // Upper bound
        s = lo;
        e = entryCount;
        while (s < e) {
            const mid = (s + e) >>> 1;
            if (valueAt(mid) <= target) s = mid + 1;
            else e = mid;
        }
        hi = s;
    } else {
        if (predicate.gte !== undefined || predicate.gt !== undefined) {
            const target = predicate.gte ?? predicate.gt!;
            const strict = predicate.gt !== undefined && predicate.gte === undefined;
            let s = 0;
            let e = entryCount;
            while (s < e) {
                const mid = (s + e) >>> 1;
                const v = valueAt(mid);
                if (v < target || (strict && v === target)) s = mid + 1;
                else e = mid;
            }
            lo = s;
        }
        if (predicate.lte !== undefined || predicate.lt !== undefined) {
            const target = predicate.lte ?? predicate.lt!;
            const strict = predicate.lt !== undefined && predicate.lte === undefined;
            let s = lo;
            let e = entryCount;
            while (s < e) {
                const mid = (s + e) >>> 1;
                const v = valueAt(mid);
                if (v < target || (!strict && v === target)) s = mid + 1;
                else e = mid;
            }
            hi = s;
        }
    }

    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const out: number[] = [];
    for (let i = lo; i < hi && out.length < limit; i++) out.push(idAt(i));
    return out;
}

export function searchBool(
    column: BoolColumn,
    predicate: ValuePredicate,
    options: ValueQueryOptions = {},
): number[] {
    if (typeof predicate.eq !== 'boolean') return [];
    const list = predicate.eq ? column.trueList : column.falseList;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const len = Math.min(list.length, limit);
    return Array.from(list.subarray(0, len));
}

// Re-export helpers needed by tests
export { readPoolToken };
