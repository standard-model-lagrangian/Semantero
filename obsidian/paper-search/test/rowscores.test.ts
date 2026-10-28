import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { semantic, semanticFromRowScores, rowScores, type LoadedIndex } from "../src/core/engine.ts";
import { IndexStore } from "../src/core/indexstore.ts";
import type { PaperMetadata, ChunkDocument } from "../src/core/bm25.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/search/index_small");

function loadSmallIndex(): LoadedIndex {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8"));
  const papers = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "papers.json"), "utf8"));
  const chunks = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "chunks.json"), "utf8"));
  const buf = fs.readFileSync(path.join(FIXTURES_DIR, "vectors.f32"));
  return IndexStore.precomputeIndex(manifest, papers, chunks, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), manifest.dims, 1);
}

function randomIndex(nPapers: number, chunksPerPaper: number, dims: number, seed: number): LoadedIndex {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const papers: PaperMetadata[] = [];
  const chunks: (ChunkDocument & { row?: number })[] = [];
  let row = 0;
  for (let p = 0; p < nPapers; p++) {
    papers.push({ key: `K${p}`, citekey: `c${p}`, title: `paper ${p}`, authors: [], year: null, journal: null, doi: null,
      tags: [], collections: [], abstract: `abstract of paper ${p}`, pdfs: [{ attachmentKey: `A${p}`, pages: 1, hasText: true }], abstractRow: row++ });
    for (let c = 0; c < chunksPerPaper; c++) chunks.push({ paper: p, attachmentKey: `A${p}`, page: c + 1, text: `chunk ${c} of paper ${p}. Another sentence.`, row: row++ });
  }
  const vectors = new Float32Array(row * dims);
  for (let r = 0; r < row; r++) {
    let n = 0;
    for (let d = 0; d < dims; d++) { const v = rnd(); vectors[r * dims + d] = v; n += v * v; }
    n = Math.sqrt(n);
    for (let d = 0; d < dims; d++) vectors[r * dims + d] /= n;
  }
  return IndexStore.precomputeIndex({}, papers, chunks, vectors, dims, 1);
}

// T2
test("T2 semantic() equals rowScores + semanticFromRowScores (goldens index and random 200x8)", () => {
  const goldens = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "goldens.json"), "utf8"));
  const small = loadSmallIndex();
  for (const g of goldens) {
    const q = new Float32Array(g.queryVec);
    const a = semantic(small, q, g.query, { limit: 10 });
    const scores = rowScores(small, q)!;
    const b = semanticFromRowScores(small, scores, g.query, { limit: 10 });
    assert.deepStrictEqual(b, a, g.query);
  }
  const rnd = randomIndex(40, 4, 8, 7); // 200 rows
  assert.strictEqual(rnd.totalRows, 200);
  for (let i = 0; i < 20; i++) {
    const q = rnd.vectors!.slice(i * 8, i * 8 + 8);
    const exclude = new Set([i % 40, (i * 3) % 40]);
    const a = semantic(rnd, q, "paper chunk", { limit: 7, exclude });
    const b = semanticFromRowScores(rnd, rowScores(rnd, q, exclude)!, "paper chunk", { limit: 7, exclude });
    assert.deepStrictEqual(b, a);
    for (const h of a) assert.ok(!exclude.has(h.paper));
  }
});

test("T2b semanticFromRowScores accepts Float32Array scores (what a native scorer returns)", () => {
  const rnd = randomIndex(40, 4, 8, 11);
  const q = rnd.vectors!.slice(0, 8);
  const f64 = rowScores(rnd, q)!;
  const f32 = Float32Array.from(f64);
  const a = semanticFromRowScores(rnd, f64, "q", { limit: 10 }).map((h) => h.paper);
  const b = semanticFromRowScores(rnd, f32, "q", { limit: 10 }).map((h) => h.paper);
  assert.deepStrictEqual(b, a);
});

test("T2c guards: no vectors, wrong dims → null / []", () => {
  const ix = loadSmallIndex();
  assert.strictEqual(rowScores(ix, new Float32Array(3)), null);
  assert.deepStrictEqual(semantic(ix, new Float32Array(3), "x"), []);
  assert.strictEqual(rowScores({ ...ix, vectors: null }, new Float32Array(ix.dims)), null);
});
