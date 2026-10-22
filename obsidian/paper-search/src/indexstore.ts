import { BM25Index, type PaperMetadata, type ChunkDocument } from "./bm25.ts";
import type { LoadedIndex } from "./engine.ts";
import { compactChunkTexts } from "./textstore.ts";

export interface IndexStoreAdapter {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  exists(path: string): Promise<boolean>;
  showNotice(msg: string): void;
}

export class IndexStore {
  private adapter: IndexStoreAdapter;
  private basePath: string;
  private getClock: () => number;

  private currentIndex: LoadedIndex | null = null;
  private ready: boolean = false;
  private lastCheckTime: number = 0;
  private nextIndexId: number = 1;
  private shownNotices: Set<string> = new Set();
  private loadPromise: Promise<boolean> | null = null;
  /** content_hash of a build whose JSON failed to parse; not retried until the hash changes. */
  private failedContentHash: string | null = null;

  constructor(
    adapter: IndexStoreAdapter,
    basePath: string = ".planner/search",
    getClock: () => number = () => Date.now()
  ) {
    this.adapter = adapter;
    this.basePath = basePath.replace(/\/+$/, "");
    this.getClock = getClock;
  }

  public isReady(): boolean {
    return this.ready && this.currentIndex !== null;
  }

  public getIndex(): LoadedIndex | null {
    return this.currentIndex;
  }

  private notifyOnce(key: string, msg: string): void {
    if (!this.shownNotices.has(key)) {
      this.shownNotices.add(key);
      this.adapter.showNotice(msg);
    }
  }

  /** Number of vector rows the index refers to: highest abstract or chunk row + 1. */
  public static countRows(papers: PaperMetadata[], chunks: { row?: number }[]): number {
    let maxRow = -1;
    for (const p of papers) if (typeof p.abstractRow === "number" && p.abstractRow > maxRow) maxRow = p.abstractRow;
    for (const c of chunks) if (typeof c.row === "number" && c.row > maxRow) maxRow = c.row;
    return maxRow + 1;
  }

  /**
   * Precomputes index lookup tables in O(chunks) one pass.
   */
  public static precomputeIndex(
    manifest: any,
    papers: PaperMetadata[],
    chunks: (ChunkDocument & { row?: number })[],
    vectors: Float32Array | null,
    dims: number,
    id: string | number
  ): LoadedIndex {
    // 1. Determine total rows
    let maxRow = -1;
    for (let i = 0; i < papers.length; i++) {
      const ar = papers[i].abstractRow;
      if (ar !== undefined && ar !== null && ar > maxRow) {
        maxRow = ar;
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const r = chunks[i].row;
      if (r !== undefined && r !== null && r > maxRow) {
        maxRow = r;
      }
    }
    const totalRows = maxRow >= 0 ? maxRow + 1 : 0;

    // 2. Allocate lookup arrays
    const rowToChunk = new Int32Array(totalRows).fill(-1);
    const rowToPaper = new Int32Array(totalRows).fill(-1);
    const rowIsAbstract = new Uint8Array(totalRows);
    const paperAbstractRow = new Int32Array(papers.length).fill(-1);

    // 3. One-pass chunk counting for paperChunkRows
    const chunkCounts = new Int32Array(papers.length);
    for (let i = 0; i < chunks.length; i++) {
      const p = chunks[i].paper;
      if (p >= 0 && p < papers.length) {
        chunkCounts[p]++;
      }
    }

    const paperChunkRows: Int32Array[] = new Array(papers.length);
    for (let p = 0; p < papers.length; p++) {
      paperChunkRows[p] = new Int32Array(chunkCounts[p]);
    }
    const chunkOffsets = new Int32Array(papers.length);

    // 4. Populate paper metadata rows
    for (let p = 0; p < papers.length; p++) {
      const ar = papers[p].abstractRow;
      if (ar !== undefined && ar !== null && ar >= 0 && ar < totalRows) {
        paperAbstractRow[p] = ar;
        rowToPaper[ar] = p;
        rowIsAbstract[ar] = 1;
      }
    }

    // 5. Populate chunk rows
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const r = c.row;
      const p = c.paper;
      if (r !== undefined && r !== null && r >= 0 && r < totalRows) {
        rowToChunk[r] = i;
        rowToPaper[r] = p;
        rowIsAbstract[r] = 0;
        if (p >= 0 && p < papers.length) {
          paperChunkRows[p][chunkOffsets[p]++] = r;
        }
      }
    }

    // 6. Build BM25 index, then pack the chunk texts (only snippets read them from here on)
    const bm25 = new BM25Index(papers, chunks);
    compactChunkTexts(chunks);

    return {
      id,
      manifest,
      papers,
      chunks,
      vectors,
      dims,
      totalRows,
      rowToChunk,
      rowToPaper,
      rowIsAbstract,
      paperAbstractRow,
      paperChunkRows,
      bm25,
    };
  }

  public async load(): Promise<boolean> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.internalLoad();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async internalLoad(): Promise<boolean> {
    const manifestPath = `${this.basePath}/manifest.json`;
    const papersPath = `${this.basePath}/papers.json`;
    const chunksPath = `${this.basePath}/chunks.json`;
    const vectorsPath = `${this.basePath}/vectors.f32`;

    // 1. Missing folder or manifest
    const manifestExists = await this.adapter.exists(manifestPath);
    if (!manifestExists) {
      this.ready = false;
      return false;
    }

    let manifest: any;
    try {
      const manifestStr = await this.adapter.read(manifestPath);
      manifest = JSON.parse(manifestStr);
    } catch {
      this.ready = false;
      return false;
    }

    // 2. Read papers and chunks
    let papers: PaperMetadata[];
    let chunks: (ChunkDocument & { row?: number })[];
    try {
      const papersStr = await this.adapter.read(papersPath);
      const chunksStr = await this.adapter.read(chunksPath);
      papers = JSON.parse(papersStr);
      chunks = JSON.parse(chunksStr);
    } catch {
      this.notifyOnce("malformed_json", "Paper search: malformed index, keeping previous index");
      if (manifest.content_hash) this.failedContentHash = manifest.content_hash;
      return this.currentIndex !== null;
    }
    this.failedContentHash = null;

    // 3. Read vectors and check integrity: exactly rows x dims float32 values
    const dimsValid = Number.isInteger(manifest.dims) && manifest.dims > 0;
    const dims = dimsValid ? manifest.dims : 1024;
    let vectors: Float32Array | null = null;
    const invalidVectors = () =>
      this.notifyOnce("invalid_vectors", "Paper search: vectors file invalid, falling back to keyword-only");

    if (await this.adapter.exists(vectorsPath)) {
      try {
        const bin = await this.adapter.readBinary(vectorsPath);
        const expectedBytes = IndexStore.countRows(papers, chunks) * dims * 4;
        if (!dimsValid || bin.byteLength !== expectedBytes) {
          invalidVectors();
        } else {
          vectors = new Float32Array(bin);
        }
      } catch {
        invalidVectors();
      }
    }

    // 4. Precompute LoadedIndex
    const id = this.nextIndexId++;
    const loaded = IndexStore.precomputeIndex(manifest, papers, chunks, vectors, dims, id);

    // 5. Atomic swap
    this.currentIndex = loaded;
    this.ready = true;
    this.lastCheckTime = this.getClock();
    return true;
  }

  /**
   * Throttled check for index freshness (at most once per 10 s).
   * Reads only manifest.json when content_hash is unchanged.
   */
  public async ensureFresh(): Promise<boolean> {
    const now = this.getClock();
    if (now - this.lastCheckTime < 10000) {
      return false;
    }
    this.lastCheckTime = now;

    const manifestPath = `${this.basePath}/manifest.json`;
    if (!(await this.adapter.exists(manifestPath))) {
      return false;
    }

    let manifest: any;
    try {
      const manifestStr = await this.adapter.read(manifestPath);
      manifest = JSON.parse(manifestStr);
    } catch {
      return false;
    }

    // The last attempt at this build failed to parse; wait for a new one.
    if (manifest.content_hash && manifest.content_hash === this.failedContentHash) {
      return false;
    }

    const current = this.currentIndex;
    if (!current) {
      return await this.load();
    }

    const currentManifest = current.manifest;
    let changed = false;

    if (manifest.content_hash || currentManifest?.content_hash) {
      changed = manifest.content_hash !== currentManifest?.content_hash;
    } else {
      // Legacy fallback (X5): reload on built_at change
      changed = manifest.built_at !== currentManifest?.built_at;
    }

    if (changed) {
      return await this.load();
    }

    return false;
  }
}
