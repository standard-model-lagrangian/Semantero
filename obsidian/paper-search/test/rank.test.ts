import test from "node:test";
import assert from "node:assert";
import { semanticText, shouldRunSemantic, reciprocalRankFusion } from "../src/core/rank.ts";

test("semantic gating: needs 2 words (the last one 3+ chars or a digit) or ≥12 chars", () => {
  assert.strictEqual(shouldRunSemantic("vis"), false);
  assert.strictEqual(shouldRunSemantic("stiff gels "), true); // 2 words
  assert.strictEqual(shouldRunSemantic("viscoelasticit"), true); // 15 chars >= 12
  assert.strictEqual(shouldRunSemantic("gel"), false); // 1 token, 3 chars < 12
  assert.strictEqual(shouldRunSemantic("neural stem"), true); // 2 tokens, the last one 3+ chars
  assert.strictEqual(shouldRunSemantic("stiff g"), false); // the last word does not count yet
  assert.strictEqual(shouldRunSemantic("il 6"), true); // a digit counts
  assert.strictEqual(shouldRunSemantic("stiff in"), false); // a stopword is not a word
});

test("shouldRunSemantic and semanticText ignore surrounding and repeated whitespace", () => {
  for (const q of ["neural stem", "stiff g", "vis", "viscoelasticit", "stiff gels", "il 6", "hepatitis b"]) {
    for (const v of [q + " ", q + "  ", " " + q, q + "\t", q + "\n", q.replace(/ /g, "  ")]) {
      assert.strictEqual(shouldRunSemantic(v), shouldRunSemantic(q), JSON.stringify(v));
      assert.strictEqual(semanticText(v), q, JSON.stringify(v));
    }
  }
  // 12 characters counted after trimming: padding does not push a query over the threshold
  assert.strictEqual(shouldRunSemantic("hepatitis b"), false);
  assert.strictEqual(shouldRunSemantic("hepatitis b   "), false);
});

test("rrf merges lists and handles an item present in only one list", () => {
  // 1 is rank 2 in the first list and rank 1 in the second: 1/62 + 1/61 beats 0's 1/61
  const merged = reciprocalRankFusion([[0, 1], [1]], (x) => x);
  assert.deepStrictEqual(merged.map((m) => m.from), [[1, 1], [0, undefined]]);
  assert.strictEqual(merged[0].score, 1 / 62 + 1 / 61);
  assert.strictEqual(merged[1].score, 1 / 61);
});

test("rrf of one list keeps its order; equal scores keep first-seen order (first list first)", () => {
  assert.deepStrictEqual(reciprocalRankFusion([[2, 0, 1]], (x) => x).map((m) => m.from[0]), [2, 0, 1]);
  // a and b both rank 1 in one list: tie, a was seen first
  assert.deepStrictEqual(reciprocalRankFusion([["a"], ["b"]], (x) => x).map((m) => m.from), [["a", undefined], [undefined, "b"]]);
});

test("rrf identifies items by key, keeps each list's own item, and honours k", () => {
  const kw = [{ id: 7, src: "kw" }];
  const sem = [{ id: 9, src: "sem" }, { id: 7, src: "sem" }];
  const merged = reciprocalRankFusion([kw, sem], (h) => h.id, 10);
  assert.strictEqual(merged[0].from[0]!.src, "kw");
  assert.strictEqual(merged[0].from[1]!.src, "sem");
  assert.strictEqual(merged[0].score, 1 / 11 + 1 / 12);
});
