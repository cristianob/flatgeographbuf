import * as flatbuffers from 'flatbuffers';
import { toByteReader, type ByteReader } from './byte-reader.js';
import { isValidMagicBytes, magicbytes, SIZE_PREFIX_LEN } from './constants.js';
import { Feature } from './flat-geobuf/feature.js';
import { fromFeature, type IGeoJsonFeature } from './geojson/feature.js';
import { parseEdge, parseGraphSectionLayout, type GraphSectionLayout } from './graph.js';
import type { Edge, FeaturesHeaderMeta } from './graph-types.js';
import { fromByteBuffer, type HeaderMeta } from './header-meta.js';
import { calcTreeSize, DEFAULT_NODE_SIZE, NODE_ITEM_BYTE_LEN, type Rect, streamSearch } from './packedrtree.js';
import {
    parsePropertyIndexBlock,
    searchBool,
    searchNumeric,
    searchText,
    type PropertyIndex,
    type TextQueryOptions,
    type ValuePredicate,
    type ValueQueryOptions,
} from './property-index.js';
import { runShortestPath, type ShortestPathOptions, type ShortestPathResult } from './shortest-path.js';

/**
 * In-memory random-access reader over an FGG file backed by an arbitrary
 * `ByteReader`. The constructor (`open`) parses only the FGG header and
 * locates the optional spatial / adjacency indices — feature payloads and
 * edge data are read lazily as you query them, so a `FlatGeoGraphBuf` is
 * safe to open on multi-gigabyte files (even remote ones) as long as the
 * `ByteReader` supports random access.
 *
 * Vertex features are cached per-index on first access; call
 * `loadFeatures()` to pre-populate the cache eagerly when the dataset
 * fits comfortably in memory.
 */
export class FlatGeoGraphBuf {
    /** Underlying byte source for all I/O performed by this instance. */
    readonly reader: ByteReader;
    readonly featureHeader: FeaturesHeaderMeta;
    readonly featureCount: number;
    readonly layout: GraphSectionLayout;
    /** Absolute byte offset of the features section start. */
    readonly featuresStart: number;
    /** Total length in bytes of the features section. */
    readonly featuresLength: number;

    private readonly featureCache = new Map<number, IGeoJsonFeature>();
    /** Outgoing edges per vertex. Populated lazily by `outgoingEdgesOf`
     *  and eagerly by `loadEdges`. */
    private readonly outgoingEdgesCache = new Map<number, Edge[]>();
    /** When set, the entire edges section is held in memory and every
     *  edge read short-circuits the underlying ByteReader. Populated by
     *  `loadEdges()` when an adjacency CSR is present. */
    private edgesSectionBytes: Uint8Array | null = null;
    /** Cached packed R-tree over vertices (only present when the file
     *  was serialized with `writeIndex: true`). Populated by
     *  `loadIndices()`. When non-null, `featuresInBbox` traverses it
     *  with zero further I/O. */
    private vertexRTreeBytes: Uint8Array | null = null;
    /** Cached packed R-tree over edges. Populated by `loadIndices()`.
     *  When non-null, `edgesInBbox` traverses it with zero further I/O. */
    private edgeRTreeBytes: Uint8Array | null = null;
    /** Cached adjacency CSR offsets table. Populated by `loadIndices()`
     *  (or implicitly by `loadEdges()` / `preload()`). When non-null,
     *  `outgoingEdgesOf` reads vertex offsets from memory instead of
     *  issuing a tiny range read per vertex. */
    private adjacencyOffsetsBytes: Uint8Array | null = null;
    /** Parsed vertex property indices, lazy-loaded on first text/value
     *  query. Drop with `releasePropertyIndices()`. */
    private vertexPropertyIndex: PropertyIndex | null = null;
    /** Parsed edge property indices, same lifecycle as the vertex one. */
    private edgePropertyIndex: PropertyIndex | null = null;

    /** Byte offset of the start of the (optional) vertex R-tree. */
    private readonly vertexRTreeStart: number;
    /** Byte offset of the vertex property index block content; `null`
     *  when the file has no vertex property index. */
    readonly vertexPropertyIndexStart: number | null;
    /** Length of the vertex property index block in bytes. */
    readonly vertexPropertyIndexBytes: number;

    private constructor(
        reader: ByteReader,
        featureHeader: FeaturesHeaderMeta,
        layout: GraphSectionLayout,
        featuresStart: number,
        featuresLength: number,
        vertexRTreeStart: number,
        vertexPropertyIndexStart: number | null,
        vertexPropertyIndexBytes: number,
    ) {
        this.reader = reader;
        this.featureHeader = featureHeader;
        this.featureCount = featureHeader.featuresCount;
        this.layout = layout;
        this.featuresStart = featuresStart;
        this.featuresLength = featuresLength;
        this.vertexRTreeStart = vertexRTreeStart;
        this.vertexPropertyIndexStart = vertexPropertyIndexStart;
        this.vertexPropertyIndexBytes = vertexPropertyIndexBytes;
    }

    /**
     * Parse an FGG file's header and locate the graph section. Lightweight
     * by design: reads only the FlatGeobuf header, one R-tree leaf (when
     * indexed) and the graph header. **Feature payloads and edge data are
     * not touched.** Safe to call on multi-gigabyte sources.
     *
     * Accepts either a fully in-memory `Uint8Array` or any `ByteReader`
     * (HTTP range, `fs.read`, memory-mapped file, custom transport, …).
     */
    static async open(source: Uint8Array | ByteReader): Promise<FlatGeoGraphBuf> {
        const reader = toByteReader(source);

        const magicAndLen = await reader.read(0, magicbytes.length + SIZE_PREFIX_LEN);
        if (!isValidMagicBytes(magicAndLen)) {
            throw new Error('Not a FlatGeoGraphBuf file (invalid magic bytes)');
        }
        const headerLength = new DataView(
            magicAndLen.buffer,
            magicAndLen.byteOffset + magicbytes.length,
        ).getUint32(0, true);

        // FlatBuffer ByteBuffer expects the size prefix as its first 4 bytes.
        const headerBytes = await reader.read(magicbytes.length, SIZE_PREFIX_LEN + headerLength);
        const headerBb = new flatbuffers.ByteBuffer(headerBytes);
        const featureHeader = fromByteBuffer(headerBb);

        const located = await locateGraphSection(reader, featureHeader);
        const layout = await readGraphLayout(reader, located.graphStart);
        const vertexRTreeStart = magicbytes.length + SIZE_PREFIX_LEN + headerLength;

        return new FlatGeoGraphBuf(
            reader,
            featureHeader,
            layout,
            located.featuresStart,
            located.featuresLength,
            vertexRTreeStart,
            located.vertexPropertyIndexStart,
            located.vertexPropertyIndexBytes,
        );
    }

    /**
     * Read a single vertex feature by its (Hilbert-ordered) index. Each
     * feature is parsed at most once per instance and cached.
     */
    async getFeature(index: number): Promise<IGeoJsonFeature> {
        if (index < 0 || index >= this.featureCount) {
            throw new Error(`Vertex index out of range: ${index} (have ${this.featureCount})`);
        }
        const cached = this.featureCache.get(index);
        if (cached) return cached;

        if (this.featureHeader.indexNodeSize === 0) {
            // No R-tree → no O(1) offset lookup; walking size-prefixes
            // for a single feature would cost the same as parsing all of
            // them, so bulk-load instead.
            await this.loadFeatures();
            const f = this.featureCache.get(index);
            if (!f) throw new Error(`Internal: getFeature(${index}) missing after loadFeatures()`);
            return f;
        }

        const offset = await this.featureOffsetViaRTree(index);
        const { bytes } = await this.readSizePrefixedRecord(
            this.featuresStart + offset,
            this.featuresLength - offset,
        );
        const feature = parseFeatureBytes(bytes, this.featureHeader);
        this.featureCache.set(index, feature);
        return feature;
    }

    /** Async iterator over all vertex features in Hilbert order. */
    async *features(): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        for (let i = 0; i < this.featureCount; i++) {
            yield await this.getFeature(i);
        }
    }

    /**
     * Async iterator yielding every vertex feature whose bounding box
     * intersects `rect`, using the packed Hilbert R-tree over vertices.
     * Requires the file to have been serialized with `writeIndex: true`.
     */
    async *featuresInBbox(rect: Rect): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        if (this.featureHeader.indexNodeSize === 0) {
            throw new Error('File has no vertex spatial index. Re-serialize with writeIndex: true.');
        }
        if (this.featureCount === 0) return;

        const treeStart = this.vertexRTreeStart;

        const cached = this.vertexRTreeBytes;
        const readNode = async (offsetIntoTree: number, size: number): Promise<ArrayBuffer> => {
            if (cached !== null) {
                return cached.buffer.slice(
                    cached.byteOffset + offsetIntoTree,
                    cached.byteOffset + offsetIntoTree + size,
                ) as ArrayBuffer;
            }
            const bytes = await this.reader.read(treeStart + offsetIntoTree, size);
            return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
        };

        for await (const [byteOffset, featureIdx] of streamSearch(
            this.featureCount,
            this.featureHeader.indexNodeSize,
            rect,
            readNode,
        )) {
            const cached = this.featureCache.get(featureIdx);
            if (cached) {
                yield cached;
                continue;
            }
            const { bytes } = await this.readSizePrefixedRecord(
                this.featuresStart + byteOffset,
                this.featuresLength - byteOffset,
            );
            const feature = parseFeatureBytes(bytes, this.featureHeader);
            this.featureCache.set(featureIdx, feature);
            yield feature;
        }
    }

    /**
     * Eagerly deserialize **every** vertex feature into an array and
     * populate the per-index cache. Uses a **single bulk range request**
     * over the entire features section — much faster than N lazy
     * `getFeature` calls when the file is remote, but downloads every
     * vertex byte. Only use this when the features fit comfortably in
     * memory and you intend to query most of them; for huge remote
     * datasets prefer the lazy `getFeature` / `features()` /
     * `featuresInBbox` APIs. Idempotent.
     */
    async loadFeatures(): Promise<IGeoJsonFeature[]> {
        const all: IGeoJsonFeature[] = new Array(this.featureCount);
        if (this.featureCount === 0) return all;

        if (this.featureCache.size === this.featureCount) {
            for (let i = 0; i < this.featureCount; i++) {
                all[i] = this.featureCache.get(i) as IGeoJsonFeature;
            }
            return all;
        }

        // Single bulk read of the entire features section.
        const sectionBytes = await this.reader.read(this.featuresStart, this.featuresLength);
        let cursor = 0;
        for (let i = 0; i < this.featureCount; i++) {
            const size = new DataView(
                sectionBytes.buffer,
                sectionBytes.byteOffset + cursor,
            ).getUint32(0, true);
            const featureBytes = sectionBytes.subarray(cursor, cursor + SIZE_PREFIX_LEN + size);
            const feature = parseFeatureBytes(featureBytes, this.featureHeader);
            all[i] = feature;
            this.featureCache.set(i, feature);
            cursor += SIZE_PREFIX_LEN + size;
        }
        return all;
    }

    /**
     * Async iterator over the outgoing edges of `vertexIdx`, using the
     * CSR adjacency index. Requires `writeAdjacencyIndex: true`.
     *
     * Edges are cached per vertex on first access. Subsequent calls on
     * the same vertex serve from cache with no further I/O. `loadEdges`
     * / `preload` populate this cache eagerly for every vertex.
     */
    async *outgoingEdgesOf(vertexIdx: number): AsyncGenerator<Edge, void, unknown> {
        if (this.layout.adjacencyOffsetsStart === null) {
            throw new Error('Graph has no adjacency index. Re-serialize with writeAdjacencyIndex: true.');
        }
        if (vertexIdx < 0 || vertexIdx >= this.featureCount) {
            throw new Error(`Vertex index out of range: ${vertexIdx} (have ${this.featureCount})`);
        }

        let edges = this.outgoingEdgesCache.get(vertexIdx);
        if (!edges) {
            edges = await this.fetchOutgoingEdges(vertexIdx);
            this.outgoingEdgesCache.set(vertexIdx, edges);
        }
        for (const e of edges) yield e;
    }

    private async fetchOutgoingEdges(vertexIdx: number): Promise<Edge[]> {
        const adjStart = this.layout.adjacencyOffsetsStart as number;
        let start: number;
        let end: number;
        if (this.adjacencyOffsetsBytes !== null) {
            const view = new DataView(
                this.adjacencyOffsetsBytes.buffer,
                this.adjacencyOffsetsBytes.byteOffset + vertexIdx * 4,
            );
            start = view.getUint32(0, true);
            end = view.getUint32(4, true);
        } else {
            const offsetsBytes = await this.reader.read(adjStart + vertexIdx * 4, 8);
            const offsetsView = new DataView(offsetsBytes.buffer, offsetsBytes.byteOffset);
            start = offsetsView.getUint32(0, true);
            end = offsetsView.getUint32(4, true);
        }

        if (start === end) return [];

        // Bulk-read every byte of `v`'s outgoing edges in a single
        // round-trip and parse locally. Without this we would issue
        // 2 reads per edge (size prefix + payload).
        const spanBytes =
            this.edgesSectionBytes !== null
                ? this.edgesSectionBytes.subarray(start, end)
                : await this.reader.read(this.layout.edgesStart + start, end - start);

        const columns = this.layout.header.edgeColumns;
        const edges: Edge[] = [];
        let cursor = 0;
        while (cursor < spanBytes.byteLength) {
            const size = new DataView(spanBytes.buffer, spanBytes.byteOffset + cursor).getUint32(
                0,
                true,
            );
            edges.push(parseEdge(spanBytes, cursor + SIZE_PREFIX_LEN, size, columns));
            cursor += SIZE_PREFIX_LEN + size;
        }
        return edges;
    }

    /** Async iterator over every edge in storage order. */
    async *allEdges(): AsyncGenerator<Edge, void, unknown> {
        const edgeCount = this.layout.header.edgeCount;
        let cursor = 0;
        for (let i = 0; i < edgeCount; i++) {
            const { edge, totalSize } = await this.readEdgeAt(cursor);
            yield edge;
            cursor += totalSize;
        }
    }

    /**
     * Async iterator yielding every edge whose bounding rectangle
     * intersects `rect`, using the packed Hilbert R-tree on edges.
     * Edges that only partially overlap the query rectangle (e.g. a
     * LineString that exits the rectangle) are returned in full — the
     * R-tree uses standard bbox-intersection semantics, so the result
     * is a superset of edges that geometrically touch the rectangle.
     * Requires `writeEdgeIndex: true`.
     */
    async *edgesInBbox(rect: Rect): AsyncGenerator<Edge, void, unknown> {
        if (this.layout.edgeRTreeStart === null) {
            throw new Error('Graph has no edge spatial index. Re-serialize with writeEdgeIndex: true.');
        }
        const rtreeStart = this.layout.edgeRTreeStart;
        const edgeCount = this.layout.header.edgeCount;
        if (edgeCount === 0) return;

        const cached = this.edgeRTreeBytes;
        const readNode = async (offsetIntoTree: number, size: number): Promise<ArrayBuffer> => {
            if (cached !== null) {
                return cached.buffer.slice(
                    cached.byteOffset + offsetIntoTree,
                    cached.byteOffset + offsetIntoTree + size,
                ) as ArrayBuffer;
            }
            const bytes = await this.reader.read(rtreeStart + offsetIntoTree, size);
            return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
        };

        for await (const [byteOffset] of streamSearch(edgeCount, DEFAULT_NODE_SIZE, rect, readNode)) {
            const { edge } = await this.readEdgeAt(byteOffset);
            yield edge;
        }
    }

    /**
     * Compute a shortest path between two vertices. Requires
     * `writeAdjacencyIndex: true`. Vertex features are fetched lazily —
     * only vertices actually visited by the search are parsed.
     */
    shortestPath(
        from: number,
        to: number,
        options?: ShortestPathOptions,
    ): Promise<ShortestPathResult | null> {
        return runShortestPath(this, from, to, options);
    }

    // ────────────────────── Property-index queries ─────────────────────

    /**
     * Find vertex features whose value of text column `column` matches
     * `query`. Tokens of `query` are AND-intersected; results are
     * ranked (tier A: consecutive in order > tier B: in order with
     * gaps > tier C: any order), then by earliest match position.
     *
     * Requires the file to have been serialized with
     * `columnIndex: { vertices: [...] }` including `column`.
     */
    async *findVerticesByText(
        column: string,
        query: string,
        options?: TextQueryOptions,
    ): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        const idx = await this.requirePropertyIndex('vertex');
        const col = idx.text.get(column);
        if (!col) throw new Error(`Vertex column "${column}" is not indexed as text`);
        const hits = searchText(col, query, options);
        for (const hit of hits) yield await this.getFeature(hit.recordId);
    }

    /**
     * Find vertex features whose numeric/boolean value of `column`
     * satisfies `predicate` (one of `{ eq, lt, lte, gt, gte }`). Number
     * columns support range predicates; boolean columns support `eq`.
     */
    async *findVerticesByValue(
        column: string,
        predicate: ValuePredicate,
        options?: ValueQueryOptions,
    ): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        const idx = await this.requirePropertyIndex('vertex');
        const num = idx.numeric.get(column);
        if (num) {
            for (const id of searchNumeric(num, predicate, options)) yield await this.getFeature(id);
            return;
        }
        const bool = idx.bool.get(column);
        if (bool) {
            for (const id of searchBool(bool, predicate, options)) yield await this.getFeature(id);
            return;
        }
        throw new Error(`Vertex column "${column}" is not indexed as number or boolean`);
    }

    /**
     * Edge equivalent of `findVerticesByText`. Yields full `Edge`
     * objects in ranked order. Requires `columnIndex: { edges: [...] }` at
     * write time.
     */
    async *findEdgesByText(
        column: string,
        query: string,
        options?: TextQueryOptions,
    ): AsyncGenerator<Edge, void, unknown> {
        const idx = await this.requirePropertyIndex('edge');
        const col = idx.text.get(column);
        if (!col) throw new Error(`Edge column "${column}" is not indexed as text`);
        const hits = searchText(col, query, options);
        for (const hit of hits) yield await this.getEdgeByStorageIndex(hit.recordId);
    }

    async *findEdgesByValue(
        column: string,
        predicate: ValuePredicate,
        options?: ValueQueryOptions,
    ): AsyncGenerator<Edge, void, unknown> {
        const idx = await this.requirePropertyIndex('edge');
        const num = idx.numeric.get(column);
        if (num) {
            for (const id of searchNumeric(num, predicate, options)) {
                yield await this.getEdgeByStorageIndex(id);
            }
            return;
        }
        const bool = idx.bool.get(column);
        if (bool) {
            for (const id of searchBool(bool, predicate, options)) {
                yield await this.getEdgeByStorageIndex(id);
            }
            return;
        }
        throw new Error(`Edge column "${column}" is not indexed as number or boolean`);
    }

    /**
     * Bulk-load both property index blocks (vertex + edge) into memory.
     * Cheap and idempotent; useful before a batch of `findBy*` queries
     * on a remote file. Released via `releasePropertyIndices()`.
     */
    async loadPropertyIndices(): Promise<void> {
        const needsVertex = this.vertexPropertyIndexStart !== null && this.vertexPropertyIndex === null;
        const needsEdge = this.layout.edgePropertyIndexStart !== null && this.edgePropertyIndex === null;
        const tasks: Promise<unknown>[] = [];
        if (needsVertex) tasks.push(this.loadVertexPropertyIndex());
        if (needsEdge) tasks.push(this.loadEdgePropertyIndex());
        await Promise.all(tasks);
    }

    /**
     * Drop both cached property index blocks. The next `findBy*` query
     * re-reads them from the underlying source.
     */
    releasePropertyIndices(): void {
        this.vertexPropertyIndex = null;
        this.edgePropertyIndex = null;
    }

    private async loadVertexPropertyIndex(): Promise<PropertyIndex> {
        if (this.vertexPropertyIndex) return this.vertexPropertyIndex;
        if (this.vertexPropertyIndexStart === null) {
            throw new Error(
                'File has no vertex property index. Re-serialize with columnIndex: { vertices: [...] }.',
            );
        }
        const bytes = await this.reader.read(this.vertexPropertyIndexStart, this.vertexPropertyIndexBytes);
        this.vertexPropertyIndex = parsePropertyIndexBlock(bytes);
        return this.vertexPropertyIndex;
    }

    private async loadEdgePropertyIndex(): Promise<PropertyIndex> {
        if (this.edgePropertyIndex) return this.edgePropertyIndex;
        if (this.layout.edgePropertyIndexStart === null) {
            throw new Error(
                'File has no edge property index. Re-serialize with columnIndex: { edges: [...] }.',
            );
        }
        const bytes = await this.reader.read(
            this.layout.edgePropertyIndexStart,
            this.layout.edgePropertyIndexBytes,
        );
        this.edgePropertyIndex = parsePropertyIndexBlock(bytes);
        return this.edgePropertyIndex;
    }

    private requirePropertyIndex(side: 'vertex' | 'edge'): Promise<PropertyIndex> {
        return side === 'vertex' ? this.loadVertexPropertyIndex() : this.loadEdgePropertyIndex();
    }

    /**
     * Random-access edge fetch by its storage index (0-based, same
     * order as `allEdges()`). Used by edge property-index queries.
     */
    private async getEdgeByStorageIndex(storageIdx: number): Promise<Edge> {
        const edgeCount = this.layout.header.edgeCount;
        if (storageIdx < 0 || storageIdx >= edgeCount) {
            throw new Error(`Edge index out of range: ${storageIdx} (have ${edgeCount})`);
        }
        // If the entire edges section is cached, walk in-memory from the
        // start. Otherwise we'd need O(N) round-trips — accept that for
        // now; users with `findEdgesBy*` usage typically call loadEdges().
        let i = 0;
        for await (const edge of this.allEdges()) {
            if (i === storageIdx) return edge;
            i++;
        }
        throw new Error(`Internal: edge ${storageIdx} not found`);
    }

    /**
     * Bulk-fetch the entire edges section into memory and populate the
     * per-vertex outgoing-edges cache. Subsequent calls to
     * `outgoingEdgesOf`, `allEdges`, `edgesInBbox` and `shortestPath`
     * serve edges from this cache with zero further I/O.
     *
     * With a CSR present, this issues **two large range requests**
     * (edges section + offsets array), so over a slow link it transfers
     * the bulk of the file. Only use when the edges fit in memory and
     * you intend to query a meaningful portion of them; for huge remote
     * datasets keep using lazy `outgoingEdgesOf` / `edgesInBbox`.
     *
     * Falls back to a streaming walk when no CSR adjacency index is
     * present in the file (the section length is unknown without CSR).
     * Idempotent — safe to call multiple times.
     */
    async loadEdges(): Promise<void> {
        if (this.edgesSectionBytes !== null) return;
        const edgeCount = this.layout.header.edgeCount;
        if (edgeCount === 0) {
            this.edgesSectionBytes = new Uint8Array(0);
            return;
        }

        if (this.layout.adjacencyOffsetsStart === null) {
            // Without CSR we cannot precompute the section length, so
            // fall back to streaming. `edgesSectionBytes` stays null;
            // only `outgoingEdgesCache` gets populated.
            const buckets = new Map<number, Edge[]>();
            for await (const edge of this.allEdges()) {
                let arr = buckets.get(edge.from);
                if (!arr) {
                    arr = [];
                    buckets.set(edge.from, arr);
                }
                arr.push(edge);
            }
            for (const [v, arr] of buckets) {
                this.outgoingEdgesCache.set(v, arr);
            }
            return;
        }

        // CSR sentinel `offsets[N]` carries the edges-section length.
        const sentinelBytes = await this.reader.read(
            this.layout.adjacencyOffsetsStart + this.featureCount * 4,
            SIZE_PREFIX_LEN,
        );
        const sectionLength = new DataView(sentinelBytes.buffer, sentinelBytes.byteOffset).getUint32(
            0,
            true,
        );

        this.edgesSectionBytes = await this.reader.read(this.layout.edgesStart, sectionLength);

        const csrBytes = await this.reader.read(
            this.layout.adjacencyOffsetsStart,
            (this.featureCount + 1) * 4,
        );
        this.adjacencyOffsetsBytes = csrBytes;
        const csrView = new DataView(csrBytes.buffer, csrBytes.byteOffset);

        for (let v = 0; v < this.featureCount; v++) {
            const start = csrView.getUint32(v * 4, true);
            const end = csrView.getUint32((v + 1) * 4, true);
            if (start === end) {
                this.outgoingEdgesCache.set(v, []);
                continue;
            }
            const edges: Edge[] = [];
            let cursor = start;
            while (cursor < end) {
                const size = new DataView(
                    this.edgesSectionBytes.buffer,
                    this.edgesSectionBytes.byteOffset + cursor,
                ).getUint32(0, true);
                const edge = parseEdge(
                    this.edgesSectionBytes,
                    cursor + SIZE_PREFIX_LEN,
                    size,
                    this.layout.header.edgeColumns,
                );
                edges.push(edge);
                cursor += SIZE_PREFIX_LEN + size;
            }
            this.outgoingEdgesCache.set(v, edges);
        }
    }

    /**
     * Cache every navigational structure present in the file (vertex
     * R-tree, edge R-tree, **adjacency CSR**) so subsequent
     * `featuresInBbox` / `edgesInBbox` / `outgoingEdgesOf` queries
     * traverse them entirely from memory. Each structure is fetched
     * with a single bulk range request. Feature and edge payloads
     * remain lazy — useful when you want fast traversal on a large
     * remote file without committing to a full `preload()`.
     *
     * Idempotent — safe to call multiple times.
     */
    async loadIndices(): Promise<void> {
        const promises: Array<Promise<unknown>> = [];

        if (
            this.featureHeader.indexNodeSize > 0 &&
            this.featureCount > 0 &&
            this.vertexRTreeBytes === null
        ) {
            const treeStart = this.vertexRTreeStart;
            const treeSize = this.featuresStart - treeStart;
            if (treeSize > 0) {
                promises.push(
                    this.reader.read(treeStart, treeSize).then((b) => {
                        this.vertexRTreeBytes = b;
                    }),
                );
            }
        }

        if (this.layout.edgeRTreeStart !== null && this.layout.edgeRTreeBytes > 0 && this.edgeRTreeBytes === null) {
            const start = this.layout.edgeRTreeStart;
            const size = this.layout.edgeRTreeBytes;
            promises.push(
                this.reader.read(start, size).then((b) => {
                    this.edgeRTreeBytes = b;
                }),
            );
        }

        if (this.layout.adjacencyOffsetsStart !== null && this.adjacencyOffsetsBytes === null) {
            const start = this.layout.adjacencyOffsetsStart;
            const size = (this.featureCount + 1) * 4;
            promises.push(
                this.reader.read(start, size).then((b) => {
                    this.adjacencyOffsetsBytes = b;
                }),
            );
        }

        await Promise.all(promises);
    }

    /**
     * Eagerly load **everything** into the in-memory caches: features,
     * edges, and both R-tree indices. After `preload()` every query
     * method serves from memory with no further I/O.
     *
     * **One-shot transfer:** when the file has the adjacency CSR (the
     * default), `preload` issues a **single contiguous read** that
     * covers magic-through-end-of-edges and then slices it into the
     * various caches with zero extra copying. On a remote source this
     * is one HTTP request instead of three or four, saving round
     * trips and letting the server stream the response in bulk.
     *
     * Falls back to per-section reads when no CSR is present (we
     * cannot know the total length without it).
     *
     * **Caveat for remote sources:** this transfers essentially the
     * entire file. Use only when:
     *   - the file fits comfortably in memory, and
     *   - you plan to query enough of it that the upfront transfer
     *     pays off relative to many small lazy reads.
     *
     * For multi-gigabyte remote files keep relying on lazy access
     * (`getFeature`, `outgoingEdgesOf`, `featuresInBbox`,
     * `edgesInBbox`, `shortestPath`) — they only touch the bytes they
     * need. A useful middle ground is `loadIndices()`, which caches
     * just the R-trees so spatial traversal is local while feature and
     * edge payloads stay lazy.
     */
    async preload(): Promise<void> {
        if (this.reader.readAll) {
            const all = await this.reader.readAll();
            this.populateAllCachesFromFullBuffer(all);
            return;
        }
        if (this.layout.adjacencyOffsetsStart === null) {
            await this.loadIndices();
            await this.loadFeatures();
            await this.loadEdges();
            await this.loadPropertyIndices();
            return;
        }
        await this.preloadSingleRequest();
        await this.loadPropertyIndices();
    }

    /**
     * Slice an in-memory full-file buffer into every cache without
     * copying. Used by `preload()` when the ByteReader provides
     * `readAll()` (single-request path).
     */
    private populateAllCachesFromFullBuffer(all: Uint8Array): void {
        if (this.featureHeader.indexNodeSize > 0 && this.featureCount > 0) {
            const headerLength = new DataView(all.buffer, all.byteOffset + magicbytes.length).getUint32(
                0,
                true,
            );
            const treeStart = magicbytes.length + SIZE_PREFIX_LEN + headerLength;
            const treeSize = this.featuresStart - treeStart;
            if (treeSize > 0) {
                this.vertexRTreeBytes = all.subarray(treeStart, treeStart + treeSize);
            }
        }

        if (this.layout.edgeRTreeStart !== null && this.layout.edgeRTreeBytes > 0) {
            this.edgeRTreeBytes = all.subarray(
                this.layout.edgeRTreeStart,
                this.layout.edgeRTreeStart + this.layout.edgeRTreeBytes,
            );
        }

        const featuresSection = all.subarray(this.featuresStart, this.featuresStart + this.featuresLength);
        let cursor = 0;
        for (let i = 0; i < this.featureCount; i++) {
            const size = new DataView(
                featuresSection.buffer,
                featuresSection.byteOffset + cursor,
            ).getUint32(0, true);
            const featureBytes = featuresSection.subarray(cursor, cursor + SIZE_PREFIX_LEN + size);
            this.featureCache.set(i, parseFeatureBytes(featureBytes, this.featureHeader));
            cursor += SIZE_PREFIX_LEN + size;
        }

        if (this.layout.header.edgeCount > 0) {
            this.edgesSectionBytes = all.subarray(this.layout.edgesStart);
            if (this.layout.adjacencyOffsetsStart !== null) {
                const adjStart = this.layout.adjacencyOffsetsStart;
                const csrSlice = all.subarray(adjStart, adjStart + (this.featureCount + 1) * 4);
                this.adjacencyOffsetsBytes = csrSlice;
                const csrView = new DataView(csrSlice.buffer, csrSlice.byteOffset);
                for (let v = 0; v < this.featureCount; v++) {
                    const start = csrView.getUint32(v * 4, true);
                    const end = csrView.getUint32((v + 1) * 4, true);
                    if (start === end) {
                        this.outgoingEdgesCache.set(v, []);
                        continue;
                    }
                    const edges: Edge[] = [];
                    let edgeCursor = start;
                    while (edgeCursor < end) {
                        const size = new DataView(
                            this.edgesSectionBytes.buffer,
                            this.edgesSectionBytes.byteOffset + edgeCursor,
                        ).getUint32(0, true);
                        const edge = parseEdge(
                            this.edgesSectionBytes,
                            edgeCursor + SIZE_PREFIX_LEN,
                            size,
                            this.layout.header.edgeColumns,
                        );
                        edges.push(edge);
                        edgeCursor += SIZE_PREFIX_LEN + size;
                    }
                    this.outgoingEdgesCache.set(v, edges);
                }
            }
        }

        // Property indices: parse from the in-memory buffer without
        // any further I/O.
        if (this.vertexPropertyIndexStart !== null) {
            const start = this.vertexPropertyIndexStart;
            this.vertexPropertyIndex = parsePropertyIndexBlock(
                all.subarray(start, start + this.vertexPropertyIndexBytes),
            );
        }
        if (this.layout.edgePropertyIndexStart !== null) {
            const start = this.layout.edgePropertyIndexStart;
            this.edgePropertyIndex = parsePropertyIndexBlock(
                all.subarray(start, start + this.layout.edgePropertyIndexBytes),
            );
        }
    }

    /**
     * Bulk-fetch and slice strategy used by `preload()` when the file
     * has an adjacency CSR. Costs exactly **one** range request.
     */
    private async preloadSingleRequest(): Promise<void> {
        const adjStart = this.layout.adjacencyOffsetsStart as number;

        // Find the edges section length via the CSR sentinel
        // `offsets[N]` (a 4-byte read). The end of that section is the
        // end of the FGG file's meaningful content.
        const sentinelBytes = await this.reader.read(adjStart + this.featureCount * 4, SIZE_PREFIX_LEN);
        const edgesSectionLength = new DataView(
            sentinelBytes.buffer,
            sentinelBytes.byteOffset,
        ).getUint32(0, true);
        const endOffset = this.layout.edgesStart + edgesSectionLength;

        const all = await this.reader.read(0, endOffset);

        // Slice into each cache without copying — Uint8Array views share
        // the underlying ArrayBuffer of `all`.
        const headerLength = new DataView(all.buffer, all.byteOffset + magicbytes.length).getUint32(
            0,
            true,
        );
        const treeStart = magicbytes.length + SIZE_PREFIX_LEN + headerLength;
        const treeSize = this.featuresStart - treeStart;
        if (this.featureHeader.indexNodeSize > 0 && treeSize > 0) {
            this.vertexRTreeBytes = all.subarray(treeStart, treeStart + treeSize);
        }
        if (this.layout.edgeRTreeStart !== null && this.layout.edgeRTreeBytes > 0) {
            this.edgeRTreeBytes = all.subarray(
                this.layout.edgeRTreeStart,
                this.layout.edgeRTreeStart + this.layout.edgeRTreeBytes,
            );
        }
        this.edgesSectionBytes = all.subarray(this.layout.edgesStart, this.layout.edgesStart + edgesSectionLength);

        const featuresSection = all.subarray(this.featuresStart, this.featuresStart + this.featuresLength);
        let cursor = 0;
        for (let i = 0; i < this.featureCount; i++) {
            const size = new DataView(
                featuresSection.buffer,
                featuresSection.byteOffset + cursor,
            ).getUint32(0, true);
            const featureBytes = featuresSection.subarray(cursor, cursor + SIZE_PREFIX_LEN + size);
            const feature = parseFeatureBytes(featureBytes, this.featureHeader);
            this.featureCache.set(i, feature);
            cursor += SIZE_PREFIX_LEN + size;
        }

        const csrSlice = all.subarray(adjStart, adjStart + (this.featureCount + 1) * 4);
        this.adjacencyOffsetsBytes = csrSlice;
        const csrView = new DataView(csrSlice.buffer, csrSlice.byteOffset);
        for (let v = 0; v < this.featureCount; v++) {
            const start = csrView.getUint32(v * 4, true);
            const end = csrView.getUint32((v + 1) * 4, true);
            if (start === end) {
                this.outgoingEdgesCache.set(v, []);
                continue;
            }
            const edges: Edge[] = [];
            let edgeCursor = start;
            while (edgeCursor < end) {
                const size = new DataView(
                    this.edgesSectionBytes.buffer,
                    this.edgesSectionBytes.byteOffset + edgeCursor,
                ).getUint32(0, true);
                const edge = parseEdge(
                    this.edgesSectionBytes,
                    edgeCursor + SIZE_PREFIX_LEN,
                    size,
                    this.layout.header.edgeColumns,
                );
                edges.push(edge);
                edgeCursor += SIZE_PREFIX_LEN + size;
            }
            this.outgoingEdgesCache.set(v, edges);
        }
    }

    /**
     * Drop **every** in-memory cache (features, outgoing edges, edges
     * section bytes, R-trees). Subsequent queries
     * fall back to lazy reads through the underlying `ByteReader` just
     * as if the instance had been freshly opened.
     *
     * Useful to reclaim memory after a batch of queries finishes, or to
     * invalidate the cache before re-reading from a source whose
     * contents may have changed.
     */
    release(): void {
        this.releaseFeatures();
        this.releaseEdges();
        this.releaseIndices();
        this.releasePropertyIndices();
    }

    /** Drop only the vertex-feature cache. */
    releaseFeatures(): void {
        this.featureCache.clear();
    }

    /** Drop only the edge caches (per-vertex outgoing edges + the edges section bytes). */
    releaseEdges(): void {
        this.outgoingEdgesCache.clear();
        this.edgesSectionBytes = null;
    }

    /** Drop the cached navigational indices (vertex R-tree, edge R-tree, adjacency CSR). */
    releaseIndices(): void {
        this.vertexRTreeBytes = null;
        this.edgeRTreeBytes = null;
        this.adjacencyOffsetsBytes = null;
    }

    // ─────────────────────── Internal helpers ─────────────────────────

    private async readEdgeAt(byteOffsetInEdges: number): Promise<{ edge: Edge; totalSize: number }> {
        if (this.edgesSectionBytes !== null) {
            const view = new DataView(
                this.edgesSectionBytes.buffer,
                this.edgesSectionBytes.byteOffset + byteOffsetInEdges,
            );
            const size = view.getUint32(0, true);
            const edge = parseEdge(
                this.edgesSectionBytes,
                byteOffsetInEdges + SIZE_PREFIX_LEN,
                size,
                this.layout.header.edgeColumns,
            );
            return { edge, totalSize: SIZE_PREFIX_LEN + size };
        }

        const absolute = this.layout.edgesStart + byteOffsetInEdges;
        const sectionLen = await this.edgesSectionLength();
        const maxAvailable = sectionLen === null ? null : sectionLen - byteOffsetInEdges;
        const { bytes, size } = await this.readSizePrefixedRecord(absolute, maxAvailable);
        const edge = parseEdge(bytes, SIZE_PREFIX_LEN, size, this.layout.header.edgeColumns);
        return { edge, totalSize: SIZE_PREFIX_LEN + size };
    }

    /** Default speculative size used by `readSizePrefixedRecord`. Covers
     *  most Point/LineString features and typical edges in one round
     *  trip; the worst case falls back to a second read. */
    private static readonly SPECULATIVE_RECORD_SIZE = 1024;

    /**
     * Fetch a size-prefixed record (`[size:4B][payload:size B]`) in **one
     * round-trip** when it fits in the speculative window, otherwise two
     * reads. `maxAvailable` upper-bounds the first read so it cannot
     * cross the section boundary (which would make the underlying
     * ByteReader throw on the last record).
     */
    private async readSizePrefixedRecord(
        absolute: number,
        maxAvailable: number | null,
    ): Promise<{ bytes: Uint8Array; size: number }> {
        // When we don't know the section bound an over-read past EOF
        // would throw — fall back to two precise reads.
        if (maxAvailable === null) {
            const sizePrefix = await this.reader.read(absolute, SIZE_PREFIX_LEN);
            const size = new DataView(sizePrefix.buffer, sizePrefix.byteOffset).getUint32(0, true);
            const bytes = await this.reader.read(absolute, SIZE_PREFIX_LEN + size);
            return { bytes, size };
        }
        const firstLen = Math.min(FlatGeoGraphBuf.SPECULATIVE_RECORD_SIZE, maxAvailable);
        const first = await this.reader.read(absolute, firstLen);
        const size = new DataView(first.buffer, first.byteOffset).getUint32(0, true);
        const total = SIZE_PREFIX_LEN + size;
        if (first.byteLength >= total) {
            return { bytes: first.subarray(0, total), size };
        }
        const remaining = total - first.byteLength;
        const rest = await this.reader.read(absolute + first.byteLength, remaining);
        const combined = new Uint8Array(total);
        combined.set(first);
        combined.set(rest, first.byteLength);
        return { bytes: combined, size };
    }

    private edgesSectionLengthCache: number | null = null;

    /**
     * Total byte length of the edges section, derived at most once per
     * instance. Returns `null` when the file has no CSR and the section
     * bytes have not been bulk-loaded — callers fall back to a precise
     * 2-read pattern in that case.
     */
    private async edgesSectionLength(): Promise<number | null> {
        if (this.edgesSectionLengthCache !== null) return this.edgesSectionLengthCache;
        if (this.edgesSectionBytes !== null) {
            this.edgesSectionLengthCache = this.edgesSectionBytes.byteLength;
            return this.edgesSectionLengthCache;
        }
        if (this.layout.adjacencyOffsetsStart === null) return null;

        const sentinelPos = this.layout.adjacencyOffsetsStart + this.featureCount * 4;
        if (this.adjacencyOffsetsBytes !== null) {
            const view = new DataView(
                this.adjacencyOffsetsBytes.buffer,
                this.adjacencyOffsetsBytes.byteOffset + this.featureCount * 4,
            );
            this.edgesSectionLengthCache = view.getUint32(0, true);
            return this.edgesSectionLengthCache;
        }
        const sentinelBytes = await this.reader.read(sentinelPos, SIZE_PREFIX_LEN);
        this.edgesSectionLengthCache = new DataView(
            sentinelBytes.buffer,
            sentinelBytes.byteOffset,
        ).getUint32(0, true);
        return this.edgesSectionLengthCache;
    }

    /**
     * O(1) byte offset of feature `index` within the features section,
     * obtained by reading the corresponding R-tree leaf node. Only valid
     * when `featureHeader.indexNodeSize > 0`.
     */
    private async featureOffsetViaRTree(index: number): Promise<number> {
        const treeSize = calcTreeSize(this.featureCount, this.featureHeader.indexNodeSize);
        const totalNodes = treeSize / NODE_ITEM_BYTE_LEN;
        const leafIdx = totalNodes - this.featureCount + index;
        const leafByteOffset = leafIdx * NODE_ITEM_BYTE_LEN + 32;
        if (this.vertexRTreeBytes !== null) {
            return Number(
                new DataView(
                    this.vertexRTreeBytes.buffer,
                    this.vertexRTreeBytes.byteOffset + leafByteOffset,
                ).getBigUint64(0, true),
            );
        }
        const leafBytes = await this.reader.read(this.vertexRTreeStart + leafByteOffset, 8);
        return Number(new DataView(leafBytes.buffer, leafBytes.byteOffset).getBigUint64(0, true));
    }
}

function parseFeatureBytes(bytes: Uint8Array, header: HeaderMeta): IGeoJsonFeature {
    // FlatBuffer ByteBuffer expects the size prefix at offset 0 of the
    // backing array, not partway through it — copy to align.
    const aligned = new Uint8Array(bytes.byteLength);
    aligned.set(bytes);
    const bb = new flatbuffers.ByteBuffer(aligned);
    const feature = Feature.getSizePrefixedRootAsFeature(bb);
    return fromFeature(0, feature, header) as IGeoJsonFeature;
}

/**
 * Discover where the graph section starts. Reads at most one R-tree leaf
 * and one size prefix, regardless of how many features the file has.
 */
interface LocatedSections {
    featuresStart: number;
    featuresLength: number;
    graphStart: number;
    vertexPropertyIndexStart: number | null;
    vertexPropertyIndexBytes: number;
}

async function locateGraphSection(reader: ByteReader, header: HeaderMeta): Promise<LocatedSections> {
    const headerLengthBytes = await reader.read(magicbytes.length, SIZE_PREFIX_LEN);
    const headerLength = new DataView(headerLengthBytes.buffer, headerLengthBytes.byteOffset).getUint32(0, true);

    const treeStart = magicbytes.length + SIZE_PREFIX_LEN + headerLength;
    let vertexExtrasStart = treeStart;
    if (header.indexNodeSize > 0 && header.featuresCount > 0) {
        vertexExtrasStart += calcTreeSize(header.featuresCount, header.indexNodeSize);
    }

    // Parse the 1-byte vertex indexFlags and any optional vertex blocks.
    const flagsBytes = await reader.read(vertexExtrasStart, 1);
    const vertexIndexFlags = flagsBytes[0];
    let cursor = vertexExtrasStart + 1;
    let vertexPropertyIndexStart: number | null = null;
    let vertexPropertyIndexBytes = 0;
    if ((vertexIndexFlags & 0x01) !== 0) {
        const sizeBytes = await reader.read(cursor, SIZE_PREFIX_LEN);
        const size = new DataView(sizeBytes.buffer, sizeBytes.byteOffset).getUint32(0, true);
        vertexPropertyIndexStart = cursor + SIZE_PREFIX_LEN;
        vertexPropertyIndexBytes = size;
        cursor += SIZE_PREFIX_LEN + size;
    }
    // Forward-compat: skip unknown vertex extras blocks
    let unknown = vertexIndexFlags & ~0x01;
    while (unknown !== 0) {
        const sizeBytes = await reader.read(cursor, SIZE_PREFIX_LEN);
        const size = new DataView(sizeBytes.buffer, sizeBytes.byteOffset).getUint32(0, true);
        cursor += SIZE_PREFIX_LEN + size;
        unknown &= unknown - 1;
    }
    // Round up to multiple of 8 for the writer's alignment padding.
    const logicalLen = cursor - vertexExtrasStart;
    cursor = vertexExtrasStart + ((logicalLen + 7) & ~7);
    const featuresStart = cursor;

    if (header.featuresCount === 0) {
        return {
            featuresStart,
            featuresLength: 0,
            graphStart: featuresStart,
            vertexPropertyIndexStart,
            vertexPropertyIndexBytes,
        };
    }

    if (header.indexNodeSize > 0) {
        const treeSize = calcTreeSize(header.featuresCount, header.indexNodeSize);
        const totalNodes = treeSize / NODE_ITEM_BYTE_LEN;
        // The writer stores features in Hilbert order, so the last leaf
        // in the R-tree is the physically last feature.
        const lastLeafBytes = await reader.read(
            treeStart + (totalNodes - 1) * NODE_ITEM_BYTE_LEN + 32,
            8,
        );
        const lastFeatureRelOffset = Number(
            new DataView(lastLeafBytes.buffer, lastLeafBytes.byteOffset).getBigUint64(0, true),
        );
        const lastSizeBytes = await reader.read(featuresStart + lastFeatureRelOffset, SIZE_PREFIX_LEN);
        const lastSize = new DataView(lastSizeBytes.buffer, lastSizeBytes.byteOffset).getUint32(0, true);
        const featuresLength = lastFeatureRelOffset + SIZE_PREFIX_LEN + lastSize;
        return {
            featuresStart,
            featuresLength,
            graphStart: featuresStart + featuresLength,
            vertexPropertyIndexStart,
            vertexPropertyIndexBytes,
        };
    }

    // No R-tree → walk size prefixes. O(N) reads, expensive over a
    // remote ByteReader.
    let walkCursor = 0;
    for (let i = 0; i < header.featuresCount; i++) {
        const sizeBytes = await reader.read(featuresStart + walkCursor, SIZE_PREFIX_LEN);
        const size = new DataView(sizeBytes.buffer, sizeBytes.byteOffset).getUint32(0, true);
        walkCursor += SIZE_PREFIX_LEN + size;
    }
    return {
        featuresStart,
        featuresLength: walkCursor,
        graphStart: featuresStart + walkCursor,
        vertexPropertyIndexStart,
        vertexPropertyIndexBytes,
    };
}

/**
 * Read just enough bytes from `reader` to compute every absolute offset
 * in the graph section (header + optional adjacency block + optional
 * edge-R-tree block). Each block's content is *not* read here — we only
 * touch the size-prefix bytes.
 */
async function readGraphLayout(reader: ByteReader, graphStart: number): Promise<GraphSectionLayout> {
    const headerSizeBytes = await reader.read(graphStart, SIZE_PREFIX_LEN);
    const headerSize = new DataView(headerSizeBytes.buffer, headerSizeBytes.byteOffset).getUint32(0, true);
    const headerBytes = await reader.read(graphStart, SIZE_PREFIX_LEN + headerSize);

    // Walk each optional block's 4-byte size prefix without reading its
    // body, building a synthetic buffer addressed at `graphStart`.
    // `parseGraphSectionLayout` then resolves offsets in absolute terms.
    const indexFlags = headerBytes[SIZE_PREFIX_LEN + headerSize - 1];
    const popcount = (x: number): number => {
        let c = 0;
        let v = x;
        while (v !== 0) {
            c += v & 1;
            v >>>= 1;
        }
        return c;
    };
    const optionalBlockCount = popcount(indexFlags);

    let cursor = graphStart + SIZE_PREFIX_LEN + headerSize;
    const sizePrefBytes: Array<{ at: number; bytes: Uint8Array }> = [];
    for (let i = 0; i < optionalBlockCount; i++) {
        const sizePref = await reader.read(cursor, SIZE_PREFIX_LEN);
        const blockSize = new DataView(sizePref.buffer, sizePref.byteOffset).getUint32(0, true);
        sizePrefBytes.push({ at: cursor, bytes: sizePref });
        cursor += SIZE_PREFIX_LEN + blockSize;
    }

    const padded = new Uint8Array(cursor);
    padded.set(headerBytes, graphStart);
    for (const { at, bytes } of sizePrefBytes) {
        padded.set(bytes, at);
    }
    return parseGraphSectionLayout(padded, graphStart);
}
