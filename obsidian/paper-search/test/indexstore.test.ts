import test from "node:test";
import assert from "node:assert";
import { IndexStore, type IndexStoreAdapter } from "../src/indexstore.ts";
import { keyword, type LoadedIndex } from "../src/engine.ts";

class FakeIndexAdapter implements IndexStoreAdapter {
  files: Map<string, string | ArrayBuffer> = new Map();
  readCounts: Map<string, number> = new Map();
  notices: string[] = [];
  hangReads: Set<string> = new Set();
  hangDeferred: Map<string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();

  async read(path: string): Promise<string> {
    this.readCounts.set(path, (this.readCounts.get(path) || 0) + 1);
    if (this.hangReads.has(path)) {
      return new Promise((resolve, reject) => {
        this.hangDeferred.set(path, { resolve, reject });
      });
    }
    const val = this.files.get(path);
    if (val === undefined) throw new Error(`File not found: ${path}`);
    return typeof val === "string" ? val : Buffer.from(val).toString("utf8");
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.readCounts.set(path, (this.readCounts.get(path) || 0) + 1);
    if (this.hangReads.has(path)) {
      return new Promise((resolve, reject) => {
        this.hangDeferred.set(path, { resolve, reject });
      });
    }
    const val = this.files.get(path);
    if (val === undefined) throw new Error(`File not found: ${path}`);
    if (typeof val === "string") {
      return Buffer.from(val, "utf8").buffer;
    }
    return val;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  showNotice(msg: string): void {
    this.notices.push(msg);
  }

  getReadCount(path: string): number {
    return this.readCounts.get(path) || 0;
  }
}

function createSampleFiles(): { manifest: any; papers: any[]; chunks: any[]; vectors: ArrayBuffer } {
  const papers = [
    { key: "K0", citekey: "p0", title: "Paper 0", authors: ["A"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: "Abstract 0", abstractRow: 0 },
    { key: "K1", citekey: "p1", title: "Paper 1", authors: ["B"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: "Abstract 1", abstractRow: 2 },
  ];
  const chunks = [
    { paper: 0, attachmentKey: "ATT0", page: 1, text: "Chunk 0", row: 1 },
    { paper: 1, attachmentKey: "ATT1", page: 2, text: "Chunk 1", row: 3 },
  ];
  const manifest = {
    format: 1,
    built_at: "2026-10-20T10:00",
    model: "qwen3-embedding:0.6b",
    dims: 4,
    query_instruction: "inst",
    chunker: "pages-v1",
    papers: 2,
    chunks: 2,
    content_hash: "hash_v1",
  };
  // 4 rows * 4 dims * 4 bytes = 64 bytes
  const vecs = new Float32Array(16);
  vecs.fill(0.5);
  return { manifest, papers, chunks, vectors: vecs.buffer };
}

test("X1 load precomputes rowToChunk and paperChunkRows in one pass", async () => {
  const adapter = new FakeIndexAdapter();
  const sample = createSampleFiles();
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample.papers));
  adapter.files.set(".planner/search/chunks.json", JSON.stringify(sample.chunks));
  adapter.files.set(".planner/search/vectors.f32", sample.vectors);

  const store = new IndexStore(adapter, ".planner/search");
  const success = await store.load();
  assert.strictEqual(success, true);
  assert.strictEqual(store.isReady(), true);

  // Exactly 1 read per file
  assert.strictEqual(adapter.getReadCount(".planner/search/manifest.json"), 1);
  assert.strictEqual(adapter.getReadCount(".planner/search/papers.json"), 1);
  assert.strictEqual(adapter.getReadCount(".planner/search/chunks.json"), 1);
  assert.strictEqual(adapter.getReadCount(".planner/search/vectors.f32"), 1);

  const ix = store.getIndex()!;
  assert.strictEqual(ix.totalRows, 4);
  assert.strictEqual(ix.rowToChunk[1], 0);
  assert.strictEqual(ix.rowToChunk[3], 1);
  assert.strictEqual(ix.rowToPaper[0], 0);
  assert.strictEqual(ix.rowToPaper[2], 1);
  assert.strictEqual(ix.paperChunkRows[0].length, 1);
  assert.strictEqual(ix.paperChunkRows[0][0], 1);
});

test("X2 ensureFresh reads only the manifest when content_hash is unchanged, at most once per 10s", async () => {
  const adapter = new FakeIndexAdapter();
  const sample = createSampleFiles();
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample.papers));
  adapter.files.set(".planner/search/chunks.json", JSON.stringify(sample.chunks));
  adapter.files.set(".planner/search/vectors.f32", sample.vectors);

  let fakeClock = 100000;
  const store = new IndexStore(adapter, ".planner/search", () => fakeClock);
  await store.load();

  const manifestReadsAfterLoad = adapter.getReadCount(".planner/search/manifest.json");
  const papersReadsAfterLoad = adapter.getReadCount(".planner/search/papers.json");

  // Call ensureFresh immediately: throttled because < 10s has passed
  const r1 = await store.ensureFresh();
  assert.strictEqual(r1, false);
  assert.strictEqual(adapter.getReadCount(".planner/search/manifest.json"), manifestReadsAfterLoad);

  // Advance clock by 5s: still throttled
  fakeClock += 5000;
  const r2 = await store.ensureFresh();
  assert.strictEqual(r2, false);
  assert.strictEqual(adapter.getReadCount(".planner/search/manifest.json"), manifestReadsAfterLoad);

  // Advance clock past 10s: now it reads manifest.json only!
  fakeClock += 6000;
  const r3 = await store.ensureFresh();
  assert.strictEqual(r3, false); // no change
  assert.strictEqual(adapter.getReadCount(".planner/search/manifest.json"), manifestReadsAfterLoad + 1);
  // papers.json was NOT read
  assert.strictEqual(adapter.getReadCount(".planner/search/papers.json"), papersReadsAfterLoad);
});

test("X3 swap is atomic: searches keep using old index until swap finishes", async () => {
  const adapter = new FakeIndexAdapter();
  const sample1 = createSampleFiles();
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample1.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample1.papers));
  adapter.files.set(".planner/search/chunks.json", JSON.stringify(sample1.chunks));
  adapter.files.set(".planner/search/vectors.f32", sample1.vectors);

  let fakeClock = 1000;
  const store = new IndexStore(adapter, ".planner/search", () => fakeClock);
  await store.load();

  const index1 = store.getIndex()!;
  const id1 = index1.id;

  // Search 1 against index1
  const search1Hits = keyword(index1, "Paper");
  assert.ok(search1Hits.length > 0);

  // Update index files with version 2
  const sample2 = createSampleFiles();
  sample2.manifest.content_hash = "hash_v2";
  sample2.papers[0].title = "Updated Title V2";
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample2.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample2.papers));

  fakeClock += 11000;
  const reloaded = await store.ensureFresh();
  assert.strictEqual(reloaded, true);

  const index2 = store.getIndex()!;
  const id2 = index2.id;
  assert.notStrictEqual(id1, id2);

  // Search started on old index1 reference still sees old data
  const searchOldAgain = keyword(index1, "Paper");
  assert.strictEqual(searchOldAgain[0].paper, 0);
  assert.strictEqual(index1.papers[0].title, "Paper 0");

  // Search on new index sees updated data
  const searchNew = keyword(index2, "Updated");
  assert.strictEqual(searchNew[0].paper, 0);
  assert.strictEqual(index2.papers[0].title, "Updated Title V2");
});

test("X4 corrupt index handling", async () => {
  // 1. Missing folder/manifest -> ready = false
  const adapter = new FakeIndexAdapter();
  const store = new IndexStore(adapter, ".planner/search");
  const rMissing = await store.load();
  assert.strictEqual(rMissing, false);
  assert.strictEqual(store.isReady(), false);

  // 2. Truncated vectors.f32 -> keyword-only, one notice
  const sample = createSampleFiles();
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample.papers));
  adapter.files.set(".planner/search/chunks.json", JSON.stringify(sample.chunks));
  // Provide only 10 bytes (not multiple of dims * 4 = 16)
  adapter.files.set(".planner/search/vectors.f32", new ArrayBuffer(10));

  const rTrunc = await store.load();
  assert.strictEqual(rTrunc, true);
  assert.strictEqual(store.isReady(), true);
  const ixTrunc = store.getIndex()!;
  assert.strictEqual(ixTrunc.vectors, null);
  assert.ok(adapter.notices.some((n) => n.includes("keyword-only")));

  // 3. Malformed chunks.json -> keep previous index, one notice
  adapter.files.set(".planner/search/chunks.json", "{ malformed json ... ");
  const rMalformed = await store.load();
  assert.strictEqual(rMalformed, true); // kept previous index
  assert.ok(adapter.notices.some((n) => n.includes("malformed index, keeping previous index")));
  assert.strictEqual(store.getIndex()!.id, ixTrunc.id);
});

test("X5 legacy index without content_hash reloads on built_at change", async () => {
  const adapter = new FakeIndexAdapter();
  const sample = createSampleFiles();
  delete sample.manifest.content_hash;
  sample.manifest.built_at = "2026-10-20T04:00";

  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample.papers));
  adapter.files.set(".planner/search/chunks.json", JSON.stringify(sample.chunks));
  adapter.files.set(".planner/search/vectors.f32", sample.vectors);

  let fakeClock = 1000;
  const store = new IndexStore(adapter, ".planner/search", () => fakeClock);
  await store.load();
  assert.strictEqual(store.isReady(), true);

  // Modify built_at
  sample.manifest.built_at = "2026-10-20T05:00";
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample.manifest));

  fakeClock += 11000;
  const reloaded = await store.ensureFresh();
  assert.strictEqual(reloaded, true);
  assert.strictEqual(store.getIndex()!.manifest.built_at, "2026-10-20T05:00");
});

test("X6 onload returns before load finishes and search returns loading row", async () => {
  const adapter = new FakeIndexAdapter();
  const sample = createSampleFiles();
  adapter.files.set(".planner/search/manifest.json", JSON.stringify(sample.manifest));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample.papers));
  adapter.files.set(".planner/search/chunks.json", JSON.stringify(sample.chunks));
  adapter.files.set(".planner/search/vectors.f32", sample.vectors);

  // Hang read of papers.json
  adapter.hangReads.add(".planner/search/papers.json");

  const store = new IndexStore(adapter, ".planner/search");

  // Start load without awaiting it (as in onload)
  const loadPromise = store.load();

  // Before load resolves, store is not ready
  assert.strictEqual(store.isReady(), false);
  assert.strictEqual(store.getIndex(), null);

  // Wait a microtask tick for the load pipeline to reach papers.json
  await new Promise((r) => setImmediate(r));

  // Now resolve the hanging read
  const deferred = adapter.hangDeferred.get(".planner/search/papers.json")!;
  deferred.resolve(JSON.stringify(sample.papers));

  await loadPromise;
  assert.strictEqual(store.isReady(), true);
  assert.notStrictEqual(store.getIndex(), null);
});

// --- 20 Oct review: vectors size, dims and malformed-index retries ---

function filesWith(adapter: FakeIndexAdapter, overrides: { manifest?: any; chunks?: string; vectors?: ArrayBuffer } = {}) {
  const sample = createSampleFiles();
  adapter.files.set(".planner/search/manifest.json", JSON.stringify({ ...sample.manifest, ...overrides.manifest }));
  adapter.files.set(".planner/search/papers.json", JSON.stringify(sample.papers));
  adapter.files.set(".planner/search/chunks.json", overrides.chunks ?? JSON.stringify(sample.chunks));
  adapter.files.set(".planner/search/vectors.f32", overrides.vectors ?? sample.vectors);
}

test("X7 vectors.f32 truncated at a row boundary -> keyword-only and one notice", async () => {
  const adapter = new FakeIndexAdapter();
  filesWith(adapter, { vectors: new Float32Array(12).fill(0.5).buffer }); // 3 of 4 rows
  const store = new IndexStore(adapter, ".planner/search");
  assert.strictEqual(await store.load(), true);
  assert.strictEqual(store.getIndex()!.vectors, null);
  assert.strictEqual(adapter.notices.filter((n) => n.includes("keyword-only")).length, 1);
  await store.load();
  assert.strictEqual(adapter.notices.filter((n) => n.includes("keyword-only")).length, 1, "notice shown once");
});

test("X8 vectors.f32 with extra whole rows -> keyword-only", async () => {
  const adapter = new FakeIndexAdapter();
  filesWith(adapter, { vectors: new Float32Array(20).fill(0.5).buffer }); // 5 rows, 4 expected
  const store = new IndexStore(adapter, ".planner/search");
  await store.load();
  assert.strictEqual(store.getIndex()!.vectors, null);
});

test("X9 dims mismatch (manifest dims vs file size, or invalid dims) -> keyword-only", async () => {
  for (const dims of [8, 2, 0, -4, "4", 2.5]) {
    const adapter = new FakeIndexAdapter();
    filesWith(adapter, { manifest: { dims } }); // file holds 4 rows x 4 dims
    const store = new IndexStore(adapter, ".planner/search");
    assert.strictEqual(await store.load(), true, `dims=${dims}`);
    assert.strictEqual(store.getIndex()!.vectors, null, `dims=${dims}`);
    assert.strictEqual(adapter.notices.filter((n) => n.includes("keyword-only")).length, 1, `dims=${dims}`);
  }
});

test("X10 a correct vectors.f32 still loads", async () => {
  const adapter = new FakeIndexAdapter();
  filesWith(adapter);
  const store = new IndexStore(adapter, ".planner/search");
  await store.load();
  assert.strictEqual(store.getIndex()!.vectors!.length, 16);
  assert.deepStrictEqual(adapter.notices, []);
});

test("X11 a malformed chunks.json is not re-read every 10 s for the same content_hash", async () => {
  const adapter = new FakeIndexAdapter();
  filesWith(adapter);
  let now = 100000;
  const store = new IndexStore(adapter, ".planner/search", () => now);
  await store.load();
  const goodId = store.getIndex()!.id;

  filesWith(adapter, { manifest: { content_hash: "hash_bad" }, chunks: "{ malformed" });
  const chunks = ".planner/search/chunks.json";
  const before = adapter.getReadCount(chunks);
  now += 11000;
  await store.ensureFresh();
  assert.strictEqual(adapter.getReadCount(chunks), before + 1);
  for (let i = 0; i < 5; i++) {
    now += 11000;
    await store.ensureFresh();
  }
  assert.strictEqual(adapter.getReadCount(chunks), before + 1, "failed content_hash remembered");
  assert.strictEqual(store.getIndex()!.id, goodId, "previous index kept");
  assert.strictEqual(adapter.notices.filter((n) => n.includes("malformed")).length, 1);

  // A new build (new content_hash) is tried again and loads.
  filesWith(adapter, { manifest: { content_hash: "hash_fixed" } });
  now += 11000;
  assert.strictEqual(await store.ensureFresh(), true);
  assert.notStrictEqual(store.getIndex()!.id, goodId);
});
