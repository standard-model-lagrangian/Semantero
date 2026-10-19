import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadVectors, truncateAndNormalize, topK } from "../src/vectors.ts";

test("rejects vector file whose length ≠ rows × dims × 4", () => {
  const badBuffer = new ArrayBuffer(50); // 50 bytes is not 8 * 8 * 4 = 256
  assert.throws(() => {
    loadVectors(badBuffer, 8, 8);
  }, /does not match/);

  const goodBuffer = new ArrayBuffer(8 * 8 * 4);
  const vecs = loadVectors(goodBuffer, 8, 8);
  assert.strictEqual(vecs.length, 64);
});

test("topk by dot product matches brute force reference", () => {
  const rows = 200;
  const dims = 8;
  const buffer = new ArrayBuffer(rows * dims * 4);
  const matrix = new Float32Array(buffer);

  // Deterministic pseudo-random matrix
  for (let i = 0; i < rows * dims; i++) {
    matrix[i] = Math.sin(i * 1.5);
  }

  const queryVec = new Float32Array(dims);
  for (let d = 0; d < dims; d++) {
    queryVec[d] = Math.cos(d * 2.1);
  }

  // Brute force reference
  const refScores: { row: number; score: number }[] = [];
  for (let r = 0; r < rows; r++) {
    let dot = 0;
    for (let d = 0; d < dims; d++) {
      dot += matrix[r * dims + d] * queryVec[d];
    }
    refScores.push({ row: r, score: dot });
  }
  refScores.sort((a, b) => b.score - a.score);

  const k = 10;
  const topResults = topK(queryVec, matrix, rows, dims, k);
  assert.strictEqual(topResults.length, k);

  for (let i = 0; i < k; i++) {
    assert.strictEqual(topResults[i].row, refScores[i].row);
    assert.ok(Math.abs(topResults[i].score - refScores[i].score) < 1e-5);
  }
});

test("query truncation and renormalisation matches the indexer", () => {
  // Read fixtures/search/trunc.json
  const fixturePath = path.resolve(
    import.meta.dirname,
    "../../../tests/fixtures/search/trunc.json"
  );
  const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const inputVec: number[] = data.input;
  const expectedVec: number[] = data.expected;

  const res = truncateAndNormalize(inputVec, 8);
  assert.strictEqual(res.length, 8);

  for (let i = 0; i < 8; i++) {
    assert.ok(
      Math.abs(res[i] - expectedVec[i]) < 1e-5,
      `Mismatch at index ${i}: got ${res[i]}, expected ${expectedVec[i]}`
    );
  }
});
