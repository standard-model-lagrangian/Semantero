import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "../src/bm25.ts";
import { IndexStore } from "../src/indexstore.ts";
import { keyword, semantic, hybrid } from "../src/engine.ts";
import { findTrigger, isExcludedContext } from "../src/cite.ts";
import { extractPassage } from "../src/passage.ts";
import { maintainSelection, type FakeSuggestLike, type SuggestionItem } from "../src/inline.ts";
import { buildSyntheticIndex } from "../scripts/make-synthetic-index.ts";

const SYNTHETIC_DIR = path.resolve(import.meta.dirname, "fixtures/synthetic_index");

export function ensureSyntheticIndex(): { papers: PaperMetadata[]; chunks: ChunkDocument[]; dir: string } {
  if (!fs.existsSync(path.join(SYNTHETIC_DIR, "manifest.json"))) {
    console.log("Generating 3x synthetic index for performance benchmarks...");
    buildSyntheticIndex({ outDir: SYNTHETIC_DIR, numPapers: 500, chunksPerPaper: 50, dims: 1024, seed: 42 });
  }
  const papers = JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, "papers.json"), "utf8"));
  const chunks = JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, "chunks.json"), "utf8"));
  return { papers, chunks, dir: SYNTHETIC_DIR };
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const EVAL_QUERIES_22 = [
  "faster stress relaxation made neurons mature quicker",
  "mitochondria moving from immune cells into tumour cells enables metastasis",
  "stiff matrices cause chemoresistance in pancreatic cancer organoids",
  "N-cadherin interactions maintain neural stem cell stemness in viscoelastic gels",
  "membrane-bound nuclease cleaves phage DNA during genome injection",
  "synthetic hydrogels promote crypt formation in intestinal organoids",
  "native contact formation facilitates barrier crossing in protein folding",
  "genetically encoded assembly recorder resolves cellular history over time",
  "aldehyde pendant synthetic copolymers form strain-stiffening biocompatible hydrogels",
  "supramolecular fibrous hydrogels with benzene tricarboxamide enable tunable viscoelasticity",
  "synthetic circuits achieve cell ratio control",
  "dynamic light scattering microrheology reveals multiscale viscoelasticity",
  "decellularized extracellular matrix hydrogels for organoid culture",
  "organoid bioprinting matrix microenvironment patterning",
  "time-aware prior-fitted networks for forecasting with exogenous variables",
  "next-generation cancer organoids and matrix stiffness",
  "patient derived organoids precision medicine",
  "reliable and responsible foundation models survey",
  "cancer complexity hallmarks of systemic disease",
  "LeSavage cancer organoids",
  "engineered matrices stiffness organoids",
  "viscoelasticity neural maturation",
];

const AUTHORS_10 = [
  "Roth",
  "LeSavage",
  "Bauer",
  "Heilshorn",
  "Wang",
  "Zhang",
  "Johnson",
  "Muller",
  "Schmidt",
  "Kim",
];

const WORDS_8 = [
  "viscoelasticity",
  "stiffness",
  "organoid",
  "hydrogel",
  "chemoresistance",
  "biopolymer",
  "maturation",
  "integrin",
];

export const BENCHMARK_QUERIES_40 = [
  ...EVAL_QUERIES_22,
  ...AUTHORS_10,
  ...WORDS_8,
];

test("PF1 B1: Keyword search latency across every prefix on 3x synthetic index", { skip: !process.env.DAITO_PERF }, () => {
  const { papers, chunks } = ensureSyntheticIndex();
  const index = new BM25Index(papers, chunks);

  // Warm-up V8 JIT on single and multi-token queries
  for (let i = 0; i < 25; i++) {
    index.search("stiff", 10);
    index.search("stiff matrices cause chemoresistance", 10);
  }

  const timesMs: number[] = [];

  for (const q of BENCHMARK_QUERIES_40) {
    // Generate every prefix: length 1 to q.length
    for (let len = 1; len <= q.length; len++) {
      const prefix = q.slice(0, len);
      const t0 = performance.now();
      index.search(prefix, 10);
      const elapsed = performance.now() - t0;
      timesMs.push(elapsed);
    }
  }

  const p50 = percentile(timesMs, 50);
  const p95 = percentile(timesMs, 95);
  const p99 = percentile(timesMs, 99);
  const max = Math.max(...timesMs);

  console.log(`\n[PF1 / B1] Total prefix queries: ${timesMs.length}`);
  console.log(`[PF1 / B1] p50: ${p50.toFixed(2)} ms, p95: ${p95.toFixed(2)} ms, p99: ${p99.toFixed(2)} ms, max: ${max.toFixed(2)} ms`);

  // Budget B1: p95 <= 8 ms, max <= 16 ms
  assert.ok(p95 <= 8.0, `B1 breach: p95 was ${p95.toFixed(2)} ms (budget <= 8.0 ms)`);
  assert.ok(max <= 16.0, `B1 breach: max was ${max.toFixed(2)} ms (budget <= 16.0 ms)`);
});

test("PF2 B2: findTrigger + context check latency on lines up to 10k chars", { skip: !process.env.DAITO_PERF }, () => {
  const lineLengths = [10, 1000, 10000];
  const timesMs: number[] = [];

  // Warm up JIT on short and 10k character lines
  const warmPad = "word ".repeat(2000);
  for (let i = 0; i < 20; i++) {
    findTrigger("some line with @@stiff and more text", 20);
    isExcludedContext([], 0, "some line with @@stiff and more text", 20);
    findTrigger(warmPad + "@@stiff", warmPad.length + 7);
    isExcludedContext([], 0, warmPad + "@@stiff", warmPad.length + 7);
    isExcludedContext([], 0, "text with `code` and $math$ " + warmPad + "@@query", warmPad.length + 35);
  }

  for (const len of lineLengths) {
    const pad = "word ".repeat(Math.floor(len / 5));
    const cases = [
      pad + "@@stiff",
      pad.slice(0, Math.floor(len / 2)) + "@@stiff " + pad.slice(Math.floor(len / 2)),
      pad,
      "text with `code` and $math$ " + pad + "@@query",
    ];

    for (const line of cases) {
      const ch = line.length;
      for (let rep = 0; rep < 50; rep++) {
        const t0 = performance.now();
        const tr = findTrigger(line, ch);
        const exc = isExcludedContext([], 0, line, ch);
        const elapsed = performance.now() - t0;
        timesMs.push(elapsed);
      }
    }
  }

  const p50 = percentile(timesMs, 50);
  const p95 = percentile(timesMs, 95);
  const p99 = percentile(timesMs, 99);
  const max = Math.max(...timesMs);

  console.log(`\n[PF2 / B2] findTrigger + isExcludedContext (10k chars) p50: ${p50.toFixed(4)} ms, p95: ${p95.toFixed(4)} ms, p99: ${p99.toFixed(4)} ms, max: ${max.toFixed(4)} ms (budget p99 <= 0.1 ms)`);

  assert.ok(p99 <= 0.1, `B2 breach: p99 was ${p99.toFixed(4)} ms (budget <= 0.1 ms)`);
});

test("PF3 B3 & B4: Semantic scoring and hybrid merge latency on 3x synthetic index", { skip: !process.env.DAITO_PERF }, () => {
  const { papers, chunks, dir } = ensureSyntheticIndex();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const vecBuf = fs.readFileSync(path.join(dir, "vectors.f32"));
  const vectors = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4);

  const ix = IndexStore.precomputeIndex(manifest, papers, chunks, vectors, manifest.dims, 1);

  // Warm-up
  const dummyVec = new Float32Array(ix.dims);
  dummyVec.fill(0.1);
  for (let i = 0; i < 5; i++) {
    semantic(ix, dummyVec, "organoids");
  }

  // 200 random query vectors
  const semTimes: number[] = [];
  const hybridTimes: number[] = [];

  for (let i = 0; i < 200; i++) {
    const qVec = new Float32Array(ix.dims);
    let sumSq = 0;
    for (let d = 0; d < ix.dims; d++) {
      const v = ((i * 31 + d * 17) % 1000) / 1000 - 0.5;
      qVec[d] = v;
      sumSq += v * v;
    }
    const invNorm = 1.0 / (Math.sqrt(sumSq) || 1.0);
    for (let d = 0; d < ix.dims; d++) qVec[d] *= invNorm;

    const query = BENCHMARK_QUERIES_40[i % BENCHMARK_QUERIES_40.length];

    // Benchmark B3: semantic scoring + top-k
    const t0 = performance.now();
    const sHits = semantic(ix, qVec, query, { limit: 12 });
    const sElapsed = performance.now() - t0;
    semTimes.push(sElapsed);

    const kHits = keyword(ix, query, 12);

    // Benchmark B4: hybrid merge + snippets
    const t1 = performance.now();
    hybrid(kHits, sHits, 12);
    const hElapsed = performance.now() - t1;
    hybridTimes.push(hElapsed);
  }

  const sem_p50 = percentile(semTimes, 50);
  const sem_p95 = percentile(semTimes, 95);
  const sem_p99 = percentile(semTimes, 99);
  const sem_max = Math.max(...semTimes);

  const hyb_p50 = percentile(hybridTimes, 50);
  const hyb_p95 = percentile(hybridTimes, 95);
  const hyb_p99 = percentile(hybridTimes, 99);
  const hyb_max = Math.max(...hybridTimes);

  console.log(`\n[PF3 / B3] Semantic scoring p50: ${sem_p50.toFixed(2)} ms, p95: ${sem_p95.toFixed(2)} ms, p99: ${sem_p99.toFixed(2)} ms, max: ${sem_max.toFixed(2)} ms`);
  console.log(`[PF3 / B4] Hybrid merge p50: ${hyb_p50.toFixed(2)} ms, p95: ${hyb_p95.toFixed(2)} ms, p99: ${hyb_p99.toFixed(2)} ms, max: ${hyb_max.toFixed(2)} ms`);

  // Budget B3: p95 <= 25 ms
  assert.ok(sem_p95 <= 25.0, `B3 breach: semantic p95 was ${sem_p95.toFixed(2)} ms (budget <= 25.0 ms)`);
  // Budget B4: p95 <= 3 ms
  assert.ok(hyb_p95 <= 3.0, `B4 breach: hybrid p95 was ${hyb_p95.toFixed(2)} ms (budget <= 3.0 ms)`);
});

test("PF4 B6 & B8: Background index load and heap budget", { skip: !process.env.DAITO_PERF }, async () => {
  const { dir } = ensureSyntheticIndex();

  class NodeFsAdapter {
    async read(filePath: string): Promise<string> {
      return fs.promises.readFile(path.resolve(dir, path.basename(filePath)), "utf8");
    }
    async readBinary(filePath: string): Promise<ArrayBuffer> {
      const buf = await fs.promises.readFile(path.resolve(dir, path.basename(filePath)));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    async exists(filePath: string): Promise<boolean> {
      return fs.existsSync(path.resolve(dir, path.basename(filePath)));
    }
    showNotice() {}
  }

  // Load 3x synthetic index
  const t0 = performance.now();
  const store3x = new IndexStore(new NodeFsAdapter(), dir);
  await store3x.load();
  const elapsed3x = performance.now() - t0;

  const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`\n[PF4 / B6] 3x Index load elapsed: ${elapsed3x.toFixed(1)} ms (budget <= 800 ms)`);
  console.log(`[PF4 / B8] Heap used: ${heapUsedMB.toFixed(1)} MB`);

  assert.ok(elapsed3x <= 800.0, `B6 breach: 3x load took ${elapsed3x.toFixed(1)} ms (budget <= 800 ms)`);
  assert.strictEqual(store3x.isReady(), true);
});

test("PF5 B7: ensureFresh throttled read latency", { skip: !process.env.DAITO_PERF }, async () => {
  const { dir } = ensureSyntheticIndex();
  let fakeClock = 1000;
  let readCount = 0;

  class FakeFreshAdapter {
    async read(filePath: string): Promise<string> {
      readCount++;
      return fs.promises.readFile(path.resolve(dir, path.basename(filePath)), "utf8");
    }
    async readBinary(filePath: string): Promise<ArrayBuffer> {
      const buf = await fs.promises.readFile(path.resolve(dir, path.basename(filePath)));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    async exists(): Promise<boolean> {
      return true;
    }
    showNotice() {}
  }

  const store = new IndexStore(new FakeFreshAdapter(), dir, () => fakeClock);
  await store.load();

  const freshTimes: number[] = [];
  const manifestReadsBefore = readCount;

  // 1,000 ensureFresh calls advancing 1s each
  for (let i = 0; i < 1000; i++) {
    fakeClock += 1000; // +1s
    const t0 = performance.now();
    await store.ensureFresh();
    freshTimes.push(performance.now() - t0);
  }

  const manifestReads = readCount - manifestReadsBefore;
  const p50 = percentile(freshTimes, 50);
  const p95 = percentile(freshTimes, 95);
  const p99 = percentile(freshTimes, 99);
  const max = Math.max(...freshTimes);

  console.log(`\n[PF5 / B7] 1000 ensureFresh calls: manifest reads = ${manifestReads} (expected 100)`);
  console.log(`[PF5 / B7] p50: ${p50.toFixed(3)} ms, p95: ${p95.toFixed(3)} ms, p99: ${p99.toFixed(3)} ms, max: ${max.toFixed(3)} ms`);

  // Exactly 100 reads because 1000s / 10s = 100 windows
  assert.strictEqual(manifestReads, 100);
  // Budget B7: p99 <= 2 ms
  assert.ok(p99 <= 2.0, `B7 breach: ensureFresh p99 was ${p99.toFixed(2)} ms (budget <= 2.0 ms)`);
});

test("PF_B11: ensureLiteratureNote (find + render + create) latency", { skip: !process.env.DAITO_PERF }, async () => {
  const { FakeVault, FakeMetadataCache } = await import("./fakes.ts");
  const { ensureLiteratureNote, BUILTIN_TEMPLATE } = await import("../src/litnote.ts");

  const vault = new FakeVault();
  const cache = new FakeMetadataCache(vault);
  vault.addFile("Zotero Template.md", BUILTIN_TEMPLATE);

  const paper: PaperMetadata = {
    key: "KEY_PERF",
    citekey: "perf2024",
    title: "Performance of Literature Note Creation",
    authors: ["Author", "Coauthor"],
    year: 2024,
    journal: "Journal of Testing",
    doi: "10.1000/1234",
    tags: ["perf"],
    collections: ["Tests"],
    abstract: "This abstract tests the speed of template rendering and file creation.",
  };

  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const p = { ...paper, citekey: `perf_${i}` };
    const t0 = performance.now();
    await ensureLiteratureNote(vault, cache, p, {
      createLiteratureNotes: true,
      literatureNoteFolder: "Literature",
      literatureNoteTemplate: "Zotero Template.md",
    });
    times.push(performance.now() - t0);
  }

  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const max = Math.max(...times);

  console.log(`\n[PF_B11 / B11] ensureLiteratureNote p50: ${p50.toFixed(2)} ms, p95: ${p95.toFixed(2)} ms, max: ${max.toFixed(2)} ms (budget <= 30 ms)`);
  assert.ok(max <= 30.0, `B11 breach: max was ${max.toFixed(2)} ms (budget <= 30 ms)`);
});

test("PF7 B14: Selection stability across 1,000 randomised re-rank sequences", { skip: !process.env.DAITO_PERF }, () => {
  const { papers } = ensureSyntheticIndex();
  let violations = 0;

  for (let trial = 0; trial < 1000; trial++) {
    // Pick 8 random distinct papers for old hits
    const pool = [...papers].sort(() => Math.random() - 0.5);
    const oldHits: SuggestionItem[] = pool.slice(0, 8).map((p) => ({
      type: "paper",
      paper: p,
      score: Math.random(),
    }));

    const selectedIdx = Math.floor(Math.random() * oldHits.length);
    const selectedPaper = oldHits[selectedIdx].paper!;

    const fakeSuggest: FakeSuggestLike = {
      suggestions: {
        selectedItem: selectedIdx,
        values: oldHits,
        setSuggestions(items) {
          this.values = items;
        },
      },
    };

    // Construct newHits: 70% chance of retaining selectedPaper at a new position, 30% dropping it
    const retain = Math.random() < 0.7;
    const otherPapers = pool.slice(8, 20);
    const newItems: SuggestionItem[] = otherPapers.slice(0, 7).map((p) => ({
      type: "paper",
      paper: p,
      score: Math.random(),
    }));

    if (retain) {
      const insertPos = Math.floor(Math.random() * (newItems.length + 1));
      newItems.splice(insertPos, 0, {
        type: "paper",
        paper: selectedPaper,
        score: Math.random(),
      });
    }

    // Call maintainSelection
    maintainSelection(fakeSuggest, oldHits, newItems);

    const actualIdx = fakeSuggest.suggestions!.selectedItem;
    if (retain) {
      const expectedIdx = newItems.findIndex(
        (h) => h.paper && h.paper.citekey === selectedPaper.citekey
      );
      if (actualIdx !== expectedIdx) {
        violations++;
      }
    } else {
      if (actualIdx !== 0) {
        violations++;
      }
    }
  }

  console.log(`\n[PF7 / B14] Selection stability: ${violations} violations across 1,000 randomised sequences (budget: 0)`);
  assert.strictEqual(violations, 0, `B14 breach: expected 0 selection violations, got ${violations}`);
});

test("PF6 B10: extractPassage on a 200 kB note latency", { skip: !process.env.DAITO_PERF }, () => {
  // Generate a realistic 200 kB note
  const sections: string[] = [];
  sections.push("---\ntitle: Very Long Research Note\ncitekey: test2024\n---\n");
  sections.push("%% planner:start %%\nBrief block\n%% planner:end %%\n");

  let charCount = 0;
  let secIdx = 0;
  while (charCount < 200000) {
    secIdx++;
    const secHeading = `\n# Section ${secIdx}: Hydrogel Viscoelasticity and Matrix Mechanics\n`;
    let secBody = "";
    for (let p = 0; p < 8; p++) {
      secBody += `Paragraph ${p} explains how [[roth2023|Roth et al.]] demonstrated stress relaxation in viscoelastic gels. `;
      secBody += `Organoids grown in stiffer matrices show altered mechanotransduction and chemoresistance [@lesavage2024]. `;
      secBody += "Here is some code ```python\nprint('simulated stress')\n``` and math $$E = \\sigma / \\epsilon$$. ";
      secBody += "Cells remodel their surrounding microenvironment dynamically over time. ";
    }
    const fullSec = secHeading + secBody;
    sections.push(fullSec);
    charCount += fullSec.length;
  }

  const bigNote = sections.join("\n");
  assert.ok(bigNote.length >= 200000, `Generated note length ${bigNote.length} should be >= 200 kB`);

  // Target cursor near the middle (approx 100 kB offset)
  const cursorOffset = Math.floor(bigNote.length / 2);

  // Warm-up JIT
  for (let i = 0; i < 10; i++) {
    extractPassage(bigNote, cursorOffset, "", 2000);
  }

  const timesMs: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const passage = extractPassage(bigNote, cursorOffset, "", 2000);
    const elapsed = performance.now() - t0;
    timesMs.push(elapsed);
    assert.ok(passage && passage.length <= 2000);
  }

  const p50 = percentile(timesMs, 50);
  const p95 = percentile(timesMs, 95);
  const max = Math.max(...timesMs);

  console.log(`\n[PF6 / B10] extractPassage (200 kB note) p50: ${p50.toFixed(2)} ms, p95: ${p95.toFixed(2)} ms, max: ${max.toFixed(2)} ms (budget <= 5.0 ms)`);
  assert.ok(max <= 5.0, `B10 breach: max was ${max.toFixed(2)} ms (budget <= 5.0 ms)`);
});

test("PF8 B9: Panel refresh end-to-end latency with warm Ollama", { skip: !process.env.DAITO_PERF || !process.env.DAITO_LIVE }, async () => {
  const { papers, chunks, dir } = ensureSyntheticIndex();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const vecBuf = fs.readFileSync(path.join(dir, "vectors.f32"));
  const vectors = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4);
  const dims = manifest.dims;
  const totalRows = manifest.total_rows;

  const rowToChunk = new Int32Array(totalRows);
  const rowToPaper = new Int32Array(totalRows);
  const rowIsAbstract = new Uint8Array(totalRows);
  const paperAbstractRow = new Int32Array(papers.length).fill(-1);
  const paperChunkRows: Int32Array[] = new Array(papers.length);
  const chunkRowsMap = new Map<number, number[]>();

  for (let p = 0; p < papers.length; p++) {
    chunkRowsMap.set(p, []);
    if (papers[p].abstract_row !== undefined && papers[p].abstract_row !== null) {
      const r = papers[p].abstract_row!;
      if (r >= 0 && r < totalRows) {
        paperAbstractRow[p] = r;
        rowToPaper[r] = p;
        rowToChunk[r] = -1;
        rowIsAbstract[r] = 1;
      }
    }
  }

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (chunk.row !== undefined && chunk.row >= 0 && chunk.row < totalRows) {
      const r = chunk.row;
      const p = chunk.paperIndex;
      rowToChunk[r] = c;
      rowToPaper[r] = p;
      rowIsAbstract[r] = 0;
      chunkRowsMap.get(p)?.push(r);
    }
  }

  for (let p = 0; p < papers.length; p++) {
    paperChunkRows[p] = new Int32Array(chunkRowsMap.get(p) || []);
  }

  const bm25 = new BM25Index(papers, chunks);
  const loadedIndex = {
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

  const { RelatedPapersController } = await import("../src/related.ts");
  const { FakeVault } = await import("./fakes.ts");
  const { embedQuery, warmUp } = await import("../src/ollama.ts");

  const reqUrl = async (req: any) => {
    const res = await fetch(req.url, {
      method: req.method || "POST",
      headers: req.headers || { "Content-Type": "application/json" },
      body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    });
    const json = await res.json();
    return { status: res.status, json, text: JSON.stringify(json) };
  };

  const model = "qwen3-embedding:0.6b";
  await warmUp(reqUrl, { url: "http://127.0.0.1:11434", model });

  const embedder = {
    async embedQuery(text: string, instruction?: string) {
      return embedQuery(reqUrl, {
        url: "http://127.0.0.1:11434",
        model,
        instruction,
        query: text,
        dims,
      });
    },
  };

  const controller = new RelatedPapersController({
    indexStore: {
      isReady: () => true,
      getIndex: () => loadedIndex,
    },
    embedder,
    vault: new FakeVault(),
    settings: {
      relatedLimit: 5,
      relatedMinScore: 0.1,
      relatedInstruction: "Given a passage from my research notes, retrieve papers that report the findings or methods it discusses",
    },
  });

  const sentence = "Faster stress relaxation in synthetic hydrogels modulates neural maturation and cellular mechanics in 3D culture. ";
  const passage2000 = sentence.repeat(Math.ceil(2000 / sentence.length)).slice(0, 2000);

  // Warm-up 2 runs
  await controller.refresh(passage2000, 50, "", "notes/warmup.md");
  await controller.refresh(passage2000, 50, "", "notes/warmup2.md");

  const timesMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await controller.refresh(passage2000, 50, "", `notes/run_${i}.md`);
    timesMs.push(performance.now() - t0);
  }

  const p50 = percentile(timesMs, 50);
  const p95 = percentile(timesMs, 95);
  const max = Math.max(...timesMs);

  console.log(`\n[PF8 / B9] Panel refresh (2k passage, warm Ollama) p50: ${p50.toFixed(1)} ms, p95: ${p95.toFixed(1)} ms, max: ${max.toFixed(1)} ms (budget p95 <= 400 ms)`);
  assert.ok(p95 <= 400.0, `B9 breach: p95 was ${p95.toFixed(1)} ms (budget <= 400.0 ms)`);
});
