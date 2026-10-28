import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { checkVectors, truncateAndNormalize } from "../src/core/vectors.ts";

test("checkVectors: usable only with valid dims and exactly rows x dims x 4 bytes; says why not", () => {
  assert.deepStrictEqual(checkVectors(8, 8, 8 * 8 * 4), { dims: 8, reason: null });
  assert.deepStrictEqual(checkVectors(8, 8, 50), { dims: 8, reason: "vectors file invalid" });
  assert.deepStrictEqual(checkVectors(0, 8, 8 * 8 * 4), { dims: 1024, reason: "index dims invalid" });
  assert.deepStrictEqual(checkVectors(undefined, 8, 8 * 1024 * 4), { dims: 1024, reason: "index dims invalid" });
  assert.deepStrictEqual(checkVectors(8, 8, null), { dims: 8, reason: "no vectors" });
  assert.deepStrictEqual(checkVectors(8, 0, null), { dims: 8, reason: null });
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
