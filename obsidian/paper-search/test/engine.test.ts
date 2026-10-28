import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { keyword, semantic, hybrid, type LoadedIndex, type Hit } from "../src/core/engine.ts";
import { IndexStore } from "../src/core/indexstore.ts";
import type { PaperMetadata, ChunkDocument } from "../src/core/bm25.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/search/index_small");

function loadSmallIndex(): LoadedIndex {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8"));
  const papers: PaperMetadata[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "papers.json"), "utf8"));
  const chunks: (ChunkDocument & { row?: number })[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "chunks.json"), "utf8"));
  const vecBuf = fs.readFileSync(path.join(FIXTURES_DIR, "vectors.f32"));
  const vectors = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4);

  return IndexStore.precomputeIndex(manifest, papers, chunks, vectors, manifest.dims, 1);
}

test("E1 golden equivalence for 30 queries on index_small", () => {
  const ix = loadSmallIndex();
  const goldensPath = path.resolve(import.meta.dirname, "goldens.json");
  const goldens = JSON.parse(fs.readFileSync(goldensPath, "utf8"));

  assert.strictEqual(goldens.length, 30);

  for (let i = 0; i < goldens.length; i++) {
    const g = goldens[i];
    const qVec = new Float32Array(g.queryVec);

    // 1. Keyword hits equivalence
    const kHits = keyword(ix, g.query, 10);
    assert.strictEqual(
      kHits.length,
      g.keywordHits.length,
      `Query "${g.query}" keyword hits length: got ${kHits.length}, expected ${g.keywordHits.length}`
    );
    for (let j = 0; j < kHits.length; j++) {
      const exp = g.keywordHits[j];
      assert.strictEqual(kHits[j].paper, exp.paperIndex, `Query "${g.query}" keyword paper mismatch at rank ${j}`);
      assert.strictEqual(kHits[j].snippet, exp.snippetText, `Query "${g.query}" keyword snippet mismatch at rank ${j}`);
      assert.strictEqual(kHits[j].page, exp.snippetPage, `Query "${g.query}" keyword page mismatch at rank ${j}`);
      assert.strictEqual(kHits[j].fromAbstract, exp.isAbstract, `Query "${g.query}" keyword fromAbstract mismatch at rank ${j}`);
      assert.strictEqual(kHits[j].attachmentKey, exp.winningAttachmentKey, `Query "${g.query}" keyword attachmentKey mismatch at rank ${j}`);
      assert.ok(Math.abs(kHits[j].score - exp.score) < 1e-6, `Query "${g.query}" keyword score mismatch at rank ${j}`);
    }

    // 2. Semantic hits equivalence
    const sHits = semantic(ix, qVec, g.query, { limit: 10 });
    assert.strictEqual(
      sHits.length,
      g.semanticList.length,
      `Query "${g.query}" semantic hits length: got ${sHits.length}, expected ${g.semanticList.length}`
    );
    for (let j = 0; j < sHits.length; j++) {
      const exp = g.semanticList[j];
      assert.strictEqual(sHits[j].paper, exp.paperIndex, `Query "${g.query}" semantic paper mismatch at rank ${j}`);
      assert.strictEqual(sHits[j].fromAbstract, exp.isAbstract, `Query "${g.query}" semantic fromAbstract mismatch at rank ${j}`);
      assert.ok(Math.abs(sHits[j].score - exp.score) < 1e-6, `Query "${g.query}" semantic score mismatch at rank ${j}`);
    }

    // 3. Hybrid hits equivalence
    const hHits = hybrid(kHits, sHits, 10);
    assert.strictEqual(
      hHits.length,
      g.hybridHits.length,
      `Query "${g.query}" hybrid hits length: got ${hHits.length}, expected ${g.hybridHits.length}`
    );
    for (let j = 0; j < hHits.length; j++) {
      const exp = g.hybridHits[j];
      assert.strictEqual(hHits[j].paper, exp.paperIndex, `Query "${g.query}" hybrid paper mismatch at rank ${j}`);
      assert.strictEqual(hHits[j].snippet, exp.snippetText, `Query "${g.query}" hybrid snippet mismatch at rank ${j}`);
      assert.strictEqual(hHits[j].page, exp.snippetPage, `Query "${g.query}" hybrid page mismatch at rank ${j}`);
      assert.strictEqual(hHits[j].fromAbstract, exp.isAbstract, `Query "${g.query}" hybrid fromAbstract mismatch at rank ${j}`);
      assert.strictEqual(hHits[j].attachmentKey, exp.winningAttachmentKey, `Query "${g.query}" hybrid attachmentKey mismatch at rank ${j}`);
      assert.ok(Math.abs(hHits[j].score - exp.score) < 1e-6, `Query "${g.query}" hybrid score mismatch at rank ${j}`);
    }
  }
});

test("E2 semantic per-paper maximum without sorting rows matches reference on 200 random matrices", () => {
  const numPapers = 10;
  const chunksPerPaper = 4;
  const dims = 8;
  const totalRows = numPapers * (1 + chunksPerPaper); // 50 rows

  // Reference implementation: sort all rows, then group by paper
  function referenceSemantic(qVec: Float32Array, vecs: Float32Array, rowToPaper: Int32Array): { paper: number; score: number }[] {
    const scoredRows: { row: number; score: number; paper: number }[] = [];
    for (let r = 0; r < totalRows; r++) {
      let dot = 0;
      const off = r * dims;
      for (let d = 0; d < dims; d++) {
        dot += qVec[d] * vecs[off + d];
      }
      scoredRows.push({ row: r, score: dot, paper: rowToPaper[r] });
    }
    // Sort all rows
    scoredRows.sort((a, b) => b.score - a.score);

    // Group by paper: keep first occurrence (max score)
    const seen = new Set<number>();
    const paperScores: { paper: number; score: number }[] = [];
    for (const sr of scoredRows) {
      if (sr.score > 0 && !seen.has(sr.paper)) {
        seen.add(sr.paper);
        paperScores.push({ paper: sr.paper, score: sr.score });
      }
    }
    paperScores.sort((a, b) => b.score - a.score || a.paper - b.paper);
    return paperScores;
  }

  // Set up mock index
  const papers: PaperMetadata[] = [];
  const chunks: (ChunkDocument & { row: number })[] = [];
  let row = 0;
  for (let p = 0; p < numPapers; p++) {
    papers.push({
      key: `K${p}`,
      citekey: `cite${p}`,
      title: `Title ${p}`,
      authors: ["Author"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: `Abstract ${p}`,
      abstractRow: row++,
    });
    for (let c = 0; c < chunksPerPaper; c++) {
      chunks.push({
        paper: p,
        attachmentKey: `ATT${p}`,
        page: 1,
        text: `Chunk text ${p} ${c}`,
        row: row++,
      });
    }
  }

  // 200 random queries and vector matrices
  for (let trial = 0; trial < 200; trial++) {
    const vecs = new Float32Array(totalRows * dims);
    for (let i = 0; i < vecs.length; i++) {
      vecs[i] = ((trial * 1337 + i * 31) % 1000) / 1000;
    }
    const qVec = new Float32Array(dims);
    for (let d = 0; d < dims; d++) {
      qVec[d] = ((trial * 7919 + d * 101) % 1000) / 1000;
    }

    const ix = IndexStore.precomputeIndex({ dims, papers: numPapers, chunks: chunks.length }, papers, chunks, vecs, dims, 1);
    const actual = semantic(ix, qVec, "test query", { limit: numPapers });
    const expected = referenceSemantic(qVec, vecs, ix.rowToPaper);

    assert.strictEqual(actual.length, expected.length, `Trial ${trial}: length mismatch`);
    for (let i = 0; i < actual.length; i++) {
      assert.strictEqual(actual[i].paper, expected[i].paper, `Trial ${trial} rank ${i}: paper mismatch`);
      assert.ok(Math.abs(actual[i].score - expected[i].score) < 1e-6, `Trial ${trial} rank ${i}: score mismatch`);
    }
  }
});

test("E3 exclude removes papers and minScore drops hits below threshold", () => {
  const ix = loadSmallIndex();
  // Unit vector 0 matches paper 0 abstract (row 0 has score 1.0)
  const qVec = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);

  const allHits = semantic(ix, qVec, "neural");
  assert.ok(allHits.length > 0);
  assert.strictEqual(allHits[0].paper, 0);

  // Exclude paper 0
  const excludedHits = semantic(ix, qVec, "neural", { exclude: new Set([0]) });
  assert.ok(!excludedHits.some((h) => h.paper === 0));

  // minScore threshold
  const highMinScore = semantic(ix, qVec, "neural", { minScore: 0.99 });
  assert.strictEqual(highMinScore.length, 1);
  assert.strictEqual(highMinScore[0].paper, 0);

  const impossibleMinScore = semantic(ix, qVec, "neural", { minScore: 1.5 });
  assert.strictEqual(impossibleMinScore.length, 0);
});

test("E4 a paper with no rows never appears in semantic results and still appears in keyword results", () => {
  const papers: PaperMetadata[] = [
    {
      key: "K0",
      citekey: "empty2023",
      title: "Unique keyword title without abstract or pdf",
      authors: ["Author"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
      abstractRow: null,
    },
    {
      key: "K1",
      citekey: "normal2023",
      title: "Normal paper with abstract",
      authors: ["Author2"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: "Abstract text",
      abstractRow: 0,
    },
  ];
  const vecs = new Float32Array([1, 0, 0, 0]);
  const ix = IndexStore.precomputeIndex({ dims: 4, papers: 2, chunks: 0 }, papers, [], vecs, 4, 1);

  // Keyword finds paper 0
  const kHits = keyword(ix, "Unique");
  assert.strictEqual(kHits.length, 1);
  assert.strictEqual(kHits[0].paper, 0);

  // Semantic search NEVER returns paper 0 (no rows assigned)
  const qVec = new Float32Array([1, 0, 0, 0]);
  const sHits = semantic(ix, qVec, "Unique");
  assert.ok(!sHits.some((h) => h.paper === 0));
});

test("E5 snippet lookup uses rowToChunk with shuffled chunk array", () => {
  const papers: PaperMetadata[] = [
    {
      key: "K0",
      citekey: "p0",
      title: "Paper 0",
      authors: ["A"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
      abstractRow: null,
    },
  ];

  // Chunks ordered in reverse of row order
  const chunks: (ChunkDocument & { row: number })[] = [
    { paper: 0, attachmentKey: "ATT2", page: 2, text: "Second row text about viscoelasticity", row: 1 },
    { paper: 0, attachmentKey: "ATT1", page: 1, text: "First row text about hydrogel", row: 0 },
  ];

  // Vector matches row 1 (which is chunk index 0)
  const vecs = new Float32Array([
    0, 0, // row 0
    1, 0, // row 1
  ]);

  const ix = IndexStore.precomputeIndex({ dims: 2, papers: 1, chunks: 2 }, papers, chunks, vecs, 2, 1);

  // Row 1 wins
  const qVec = new Float32Array([1, 0]);
  const sHits = semantic(ix, qVec, "viscoelasticity");
  assert.strictEqual(sHits.length, 1);
  assert.strictEqual(sHits[0].page, 2);
  assert.strictEqual(sHits[0].attachmentKey, "ATT2");
  assert.ok(sHits[0].snippet.includes("Second row"));
});

test("E6 hybrid with empty semantic equals keyword; with empty keyword equals semantic", () => {
  const ix = loadSmallIndex();
  const kHits = keyword(ix, "viscoelasticity");
  const sHits = semantic(ix, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), "viscoelasticity");

  // Empty semantic list
  const hybridOnlyK = hybrid(kHits, []);
  assert.strictEqual(hybridOnlyK.length, kHits.length);
  for (let i = 0; i < kHits.length; i++) {
    assert.strictEqual(hybridOnlyK[i].paper, kHits[i].paper);
    assert.strictEqual(hybridOnlyK[i].snippet, kHits[i].snippet);
  }

  // Empty keyword list
  const hybridOnlyS = hybrid([], sHits);
  assert.strictEqual(hybridOnlyS.length, sHits.length);
  for (let i = 0; i < sHits.length; i++) {
    assert.strictEqual(hybridOnlyS[i].paper, sHits[i].paper);
    assert.strictEqual(hybridOnlyS[i].snippet, sHits[i].snippet);
  }
});

test("E7 deterministic ties: equal scores are ordered by paper index", () => {
  const papers: PaperMetadata[] = [
    { key: "K0", citekey: "p0", title: "Shared Title", authors: ["A"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: "Same" },
    { key: "K1", citekey: "p1", title: "Shared Title", authors: ["B"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: "Same" },
    { key: "K2", citekey: "p2", title: "Shared Title", authors: ["C"], year: 2023, journal: null, doi: null, tags: [], collections: [], abstract: "Same" },
  ];
  const ix = IndexStore.precomputeIndex({ dims: 2, papers: 3, chunks: 0 }, papers, [], null, 2, 1);

  // In keyword search, all three have exact same score
  const hits1 = keyword(ix, "Shared Title");
  const hits2 = keyword(ix, "Shared Title");

  assert.strictEqual(hits1.length, 3);
  assert.strictEqual(hits1[0].paper, 0);
  assert.strictEqual(hits1[1].paper, 1);
  assert.strictEqual(hits1[2].paper, 2);

  // Deterministic order across multiple calls
  assert.deepStrictEqual(hits1, hits2);
});

test("E8 per-paper max scores keep double precision (no Float32 rounding of dot products)", () => {
  const papers = [0, 1].map((i) => ({ key: `K${i}`, citekey: `p${i}`, title: `P${i}`, authors: [], year: 2020, abstract: "", journal: null, doi: null, tags: [], collections: [], abstractRow: i })) as any;
  // Row 1 scores 1 + 2^-30, row 0 scores exactly 1. Float32 would round both to 1 and tie-break to paper 0.
  const vectors = new Float32Array([1, 0, 1, 2 ** -30]);
  const ix = IndexStore.precomputeIndex({}, papers, [], vectors, 2, 1);
  const hits = semantic(ix, new Float32Array([1, 1]), "");
  assert.deepStrictEqual(hits.map((h) => h.paper), [1, 0]);
  assert.strictEqual(hits[0].score, 1 + 2 ** -30);
});

test("E9 a query vector whose length differs from the index dims gives no semantic hits", () => {
  const papers = [{ key: "K", citekey: "p", title: "P", authors: [], year: 2020, abstract: "", journal: null, doi: null, tags: [], collections: [], abstractRow: 0 }] as any;
  const ix = IndexStore.precomputeIndex({}, papers, [], new Float32Array([1, 1, 1, 1]), 4, 1);
  assert.deepStrictEqual(semantic(ix, new Float32Array([1, 1]), ""), []);
});
