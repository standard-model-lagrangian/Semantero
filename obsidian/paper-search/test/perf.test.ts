import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "../src/bm25.ts";
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

  // Warm-up
  for (let i = 0; i < 20; i++) {
    index.search("stiff");
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
