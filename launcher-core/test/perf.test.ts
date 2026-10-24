// Performance budgets on the 3x synthetic papers index (500 papers, 25,000 chunks, 1024 dims) plus a
// synthetic 2,000-note corpus. Run with SEMANTERO_PERF=1. The real cold-load budget (L1) is measured in the app.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { rowScores } from "../../obsidian/paper-search/src/engine.ts";
import { buildSyntheticIndex } from "../../obsidian/paper-search/scripts/make-synthetic-index.ts";
import { buildCorpora, type RawCorpus } from "../src/corpora.ts";
import { Engine } from "../src/query.ts";
import { readCorpus } from "../node/fsload.ts";

const DIR = path.resolve(import.meta.dirname, "fixtures");
const run = !!process.env.SEMANTERO_PERF;

function corpusAt(name: string, opts: { numPapers: number; chunksPerPaper: number; seed: number }): RawCorpus {
  const dir = path.join(DIR, name);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    console.log(`Generating ${name}...`);
    buildSyntheticIndex({ outDir: dir, dims: 1024, ...opts });
  }
  return readCorpus(dir)!;
}

function percentile(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const QUERIES = ["viscoel", "stress relaxation", "stiffness hydrogel", "organoid", "chemoresistance integrin", "neural matur", "constitutive model", "matrix degra"];

function engine(): { e: Engine; t: number } {
  const papers = corpusAt("synthetic_papers_3x", { numPapers: 500, chunksPerPaper: 50, seed: 42 });
  const notes = corpusAt("synthetic_notes_2000", { numPapers: 2000, chunksPerPaper: 3, seed: 7 });
  notes.manifest = { ...notes.manifest, model: papers.manifest.model, dims: papers.manifest.dims, query_instruction: papers.manifest.query_instruction, vault: "/v", vault_name: "v" };
  notes.papers.forEach((p, i) => { p.kind = "note"; p.path = `n${i}.md`; p.mtime = 1_700_000_000 + i; });
  const t0 = performance.now();
  const e = new Engine(buildCorpora(papers, notes));
  return { e, t: performance.now() - t0 };
}

test("R31 keyword over both corpora p95 ≤ 20 ms (L2 budget is 33 ms end to end)", { skip: !run }, () => {
  const { e } = engine();
  const times: number[] = [];
  for (let round = 0; round < 40; round++) {
    for (const q of QUERIES) for (let n = 3; n <= q.length; n += 3) {
      const t = performance.now();
      e.keyword(q.slice(0, n), "all", 15);
      times.push(performance.now() - t);
    }
  }
  const p95 = percentile(times, 95);
  console.log(`R31 keyword both corpora: p50 ${percentile(times, 50).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms (${times.length} runs)`);
  assert.ok(p95 <= 20, `p95 ${p95.toFixed(2)} ms`);
});

test("R32 hybrid scoring over both corpora (no Ollama) p95 ≤ 35 ms", { skip: !run }, () => {
  const { e } = engine();
  const dims = e.corpora.dims!;
  const rnd = (() => { let s = 99; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1; })();
  const vecs = Array.from({ length: 30 }, () => {
    const v = new Float32Array(dims);
    let n = 0;
    for (let i = 0; i < dims; i++) { v[i] = rnd(); n += v[i] * v[i]; }
    return v.map((x) => x / Math.sqrt(n));
  });
  e.hybrid("viscoelasticity", vecs[0], "all", 15); // warm-up
  const total: number[] = [];
  const scoring: number[] = [];
  for (let i = 0; i < 100; i++) {
    const v = vecs[i % vecs.length];
    const q = QUERIES[i % QUERIES.length];
    const t0 = performance.now();
    rowScores(e.corpora.papers!.ix, v);
    rowScores(e.corpora.notes!.ix, v);
    scoring.push(performance.now() - t0);
    const t1 = performance.now();
    e.hybrid(q, v, "all", 15);
    total.push(performance.now() - t1);
  }
  console.log(`R32 row scoring: p50 ${percentile(scoring, 50).toFixed(1)} ms, p95 ${percentile(scoring, 95).toFixed(1)} ms; hybrid total p95 ${percentile(total, 95).toFixed(1)} ms`);
  assert.ok(percentile(scoring, 95) <= 35, `scoring p95 ${percentile(scoring, 95).toFixed(1)} ms`);
});

test("R32b cold load of both corpora in Node ≤ 900 ms (the app's M1/L4 budget is 4 s at 3×)", { skip: !run }, () => {
  const { t } = engine();
  console.log(`R32b build engine from parsed data: ${t.toFixed(0)} ms`);
  assert.ok(t <= 900, `${t.toFixed(0)} ms`);
});
