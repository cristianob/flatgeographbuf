import { generateLevelBounds, NODE_ITEM_BYTE_LEN, type Rect } from './packedrtree.js';

const HILBERT_MAX = (1 << 16) - 1;

export interface IndexItem extends Rect {
    offset: number;
}

export function envelopeOf(items: ReadonlyArray<Rect>): Rect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const it of items) {
        if (it.minX < minX) minX = it.minX;
        if (it.minY < minY) minY = it.minY;
        if (it.maxX > maxX) maxX = it.maxX;
        if (it.maxY > maxY) maxY = it.maxY;
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Hilbert curve distance for a 2D point quantized to a 16-bit lattice.
 * Canonical implementation used by FlatGeobuf / flatbush for spatial
 * indexing; preserves locality so nearby points have close distances.
 */
export function hilbert(x: number, y: number): number {
    let a = x ^ y;
    let b = 0xffff ^ a;
    let c = 0xffff ^ (x | y);
    let d = x & (y ^ 0xffff);

    let A = a | (b >> 1);
    let B = (a >> 1) ^ a;
    let C = ((c >> 1) ^ (b & (d >> 1))) ^ c;
    let D = ((a & (c >> 1)) ^ (d >> 1)) ^ d;

    a = A;
    b = B;
    c = C;
    d = D;
    A = (a & (a >> 2)) ^ (b & (b >> 2));
    B = (a & (b >> 2)) ^ (b & ((a ^ b) >> 2));
    C ^= (a & (c >> 2)) ^ (b & (d >> 2));
    D ^= (b & (c >> 2)) ^ ((a ^ b) & (d >> 2));

    a = A;
    b = B;
    c = C;
    d = D;
    A = (a & (a >> 4)) ^ (b & (b >> 4));
    B = (a & (b >> 4)) ^ (b & ((a ^ b) >> 4));
    C ^= (a & (c >> 4)) ^ (b & (d >> 4));
    D ^= (b & (c >> 4)) ^ ((a ^ b) & (d >> 4));

    a = A;
    b = B;
    c = C;
    d = D;
    C ^= (a & (c >> 8)) ^ (b & (d >> 8));
    D ^= (b & (c >> 8)) ^ ((a ^ b) & (d >> 8));

    a = C ^ (C >> 1);
    b = D ^ (D >> 1);

    let i0 = x ^ y;
    let i1 = b | (0xffff ^ (i0 | a));

    i0 = (i0 | (i0 << 8)) & 0x00ff00ff;
    i0 = (i0 | (i0 << 4)) & 0x0f0f0f0f;
    i0 = (i0 | (i0 << 2)) & 0x33333333;
    i0 = (i0 | (i0 << 1)) & 0x55555555;

    i1 = (i1 | (i1 << 8)) & 0x00ff00ff;
    i1 = (i1 | (i1 << 4)) & 0x0f0f0f0f;
    i1 = (i1 | (i1 << 2)) & 0x33333333;
    i1 = (i1 | (i1 << 1)) & 0x55555555;

    return ((i1 << 1) | i0) >>> 0;
}

function hilbertOfRect(r: Rect, envelope: Rect): number {
    const width = envelope.maxX - envelope.minX;
    const height = envelope.maxY - envelope.minY;
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    const x = width === 0 ? 0 : Math.floor(((cx - envelope.minX) / width) * HILBERT_MAX);
    const y = height === 0 ? 0 : Math.floor(((cy - envelope.minY) / height) * HILBERT_MAX);
    return hilbert(x, y);
}

/**
 * Returns a permutation `perm` such that `perm[newIndex] = oldIndex`,
 * i.e. the item that should land at position `newIndex` was originally
 * at position `oldIndex`. Items themselves are not mutated.
 */
export function hilbertPermutation(items: ReadonlyArray<Rect>, envelope: Rect): number[] {
    const n = items.length;
    const distances = new Uint32Array(n);
    const perm: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        distances[i] = hilbertOfRect(items[i], envelope);
        perm[i] = i;
    }
    perm.sort((a, b) => distances[a] - distances[b]);
    return perm;
}

/**
 * Builds the packed Hilbert R-tree binary representation.
 *
 * `leafItems` MUST already be in Hilbert order; their `offset` field is
 * the byte offset of the corresponding feature within the features
 * section. Inner nodes are built bottom-up by grouping every `nodeSize`
 * children under a parent that covers their combined bbox; the parent's
 * `offset` field holds the *node index* of its first child.
 *
 * Encoding: levels are stored top-down (root first, leaves last). Each
 * node is `NODE_ITEM_BYTE_LEN` bytes:
 *   [minX:f64][minY:f64][maxX:f64][maxY:f64][offset:u64]
 */
export function buildPackedRTree(leafItems: ReadonlyArray<IndexItem>, nodeSize: number): Uint8Array {
    const numItems = leafItems.length;
    if (numItems === 0) return new Uint8Array(0);
    if (nodeSize < 2) throw new Error('nodeSize must be at least 2');

    const levelBounds = generateLevelBounds(numItems, nodeSize);
    // `levelBounds` is ordered leaves-first; the end of the leaf level
    // is the total node count.
    const numNodes = levelBounds[0][1];

    const minX = new Float64Array(numNodes);
    const minY = new Float64Array(numNodes);
    const maxX = new Float64Array(numNodes);
    const maxY = new Float64Array(numNodes);
    const offsets = new BigUint64Array(numNodes);

    // Place leaves at the bottom level (last entry in levelBounds is leaves)
    const [leafStart] = levelBounds[0];
    for (let i = 0; i < numItems; i++) {
        const it = leafItems[i];
        const slot = leafStart + i;
        minX[slot] = it.minX;
        minY[slot] = it.minY;
        maxX[slot] = it.maxX;
        maxY[slot] = it.maxY;
        offsets[slot] = BigInt(it.offset);
    }

    // Build inner levels bottom-up: levelBounds[0] = leaves, levelBounds[end] = root
    for (let level = 0; level < levelBounds.length - 1; level++) {
        const [childStart, childEnd] = levelBounds[level];
        const [parentStart] = levelBounds[level + 1];
        let parent = parentStart;
        let child = childStart;
        while (child < childEnd) {
            const firstChild = child;
            let pMinX = Number.POSITIVE_INFINITY;
            let pMinY = Number.POSITIVE_INFINITY;
            let pMaxX = Number.NEGATIVE_INFINITY;
            let pMaxY = Number.NEGATIVE_INFINITY;
            const limit = Math.min(child + nodeSize, childEnd);
            while (child < limit) {
                if (minX[child] < pMinX) pMinX = minX[child];
                if (minY[child] < pMinY) pMinY = minY[child];
                if (maxX[child] > pMaxX) pMaxX = maxX[child];
                if (maxY[child] > pMaxY) pMaxY = maxY[child];
                child++;
            }
            minX[parent] = pMinX;
            minY[parent] = pMinY;
            maxX[parent] = pMaxX;
            maxY[parent] = pMaxY;
            // For inner nodes the offset field stores the child node index
            offsets[parent] = BigInt(firstChild);
            parent++;
        }
    }

    const buf = new Uint8Array(numNodes * NODE_ITEM_BYTE_LEN);
    const view = new DataView(buf.buffer);
    // Storage order in the file is top-down: root first, leaves last.
    // levelBounds is bottom-up, so iterate in reverse.
    let pos = 0;
    for (let level = levelBounds.length - 1; level >= 0; level--) {
        const [start, end] = levelBounds[level];
        for (let i = start; i < end; i++) {
            view.setFloat64(pos + 0, minX[i], true);
            view.setFloat64(pos + 8, minY[i], true);
            view.setFloat64(pos + 16, maxX[i], true);
            view.setFloat64(pos + 24, maxY[i], true);
            view.setBigUint64(pos + 32, offsets[i], true);
            pos += NODE_ITEM_BYTE_LEN;
        }
    }
    return buf;
}
