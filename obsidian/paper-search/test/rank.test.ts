import test from "node:test";
import assert from "node:assert";
import {
  semanticText,
  shouldRunSemantic,
  mergeRRF,
  scorePaperSemantic,
  maintainSelection,
  SemanticCoordinator,
  type ScoredPaper,
} from "../src/rank.ts";

test("paper semantic score is max(abstract row, best chunk row) and records the winning row", () => {
  // Row 0: abstract score 0.65
  // Row 1: chunk score 0.85
  const rowScores = new Map<number, number>([
    [0, 0.65],
    [1, 0.85],
    [2, 0.40],
  ]);

  const paper = {
    abstractRow: 0,
    chunkRows: [1, 2],
  };

  const res = scorePaperSemantic(paper, rowScores);
  assert.strictEqual(res.score, 0.85);
  assert.strictEqual(res.winningRow, 1);
  assert.strictEqual(res.isAbstract, false);

  // If abstract is higher
  rowScores.set(0, 0.95);
  const res2 = scorePaperSemantic(paper, rowScores);
  assert.strictEqual(res2.score, 0.95);
  assert.strictEqual(res2.winningRow, 0);
  assert.strictEqual(res2.isAbstract, true);
});

test("rrf merges lists and handles a paper present in only one list", () => {
  // Paper A (id 0) is rank 1 in list 1, absent in list 2
  // Paper B (id 1) is rank 2 in list 1, rank 1 in list 2
  const list1 = [0, 1];
  const list2 = [1];

  const merged = mergeRRF([list1, list2]);
  // Paper 1 score: 1/(60+2) + 1/(60+1) = 1/62 + 1/61 = 0.016129 + 0.016393 = 0.03252
  // Paper 0 score: 1/(60+1) = 0.016393
  assert.strictEqual(merged[0].paperIndex, 1);
  assert.strictEqual(merged[1].paperIndex, 0);
  assert.ok(merged[0].score > merged[1].score);
});

test("keyword-only ordering is shown before semantic arrives", () => {
  const keywordOrder = [2, 0, 1];
  const merged = mergeRRF([keywordOrder]);
  assert.deepStrictEqual(
    merged.map((m) => m.paperIndex),
    [2, 0, 1]
  );
});

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

test("stale semantic responses are dropped", async () => {
  const coordinator = new SemanticCoordinator();

  let latestResolvedSeq = -1;

  // Launch request 1
  const req1 = coordinator.newRequest();
  // Launch request 2
  const req2 = coordinator.newRequest();

  // Request 2 completes first
  if (coordinator.isCurrent(req2.seq)) {
    latestResolvedSeq = req2.seq;
  }
  assert.strictEqual(latestResolvedSeq, req2.seq);

  // Request 1 completes later (stale)
  const isReq1Current = coordinator.isCurrent(req1.seq);
  assert.strictEqual(isReq1Current, false);
});

test("selection stays on the same paper after re-rank when still in top limit", () => {
  // Previous list: papers [10, 20, 30, 40], user had selected index 1 (paper 20)
  const prevSelectedPaper = 20;

  // New list after re-ranking: papers [30, 20, 10, 50], limit = 4
  const newList: ScoredPaper[] = [
    { paperIndex: 30, score: 0.9 },
    { paperIndex: 20, score: 0.8 },
    { paperIndex: 10, score: 0.7 },
    { paperIndex: 50, score: 0.6 },
  ];

  const newSelectedIndex = maintainSelection(prevSelectedPaper, newList, 4);
  assert.strictEqual(newSelectedIndex, 1); // paper 20 is at index 1

  // If paper dropped out of limit
  const shortLimitIndex = maintainSelection(prevSelectedPaper, newList, 1);
  assert.strictEqual(shortLimitIndex, 0); // falls back to top item
});

test("ollama down → keyword results plus semantic-off flag, no throw", async () => {
  const coordinator = new SemanticCoordinator();

  const fakeFailingEmbedder = async () => {
    throw new Error("Connection refused");
  };

  const res = await coordinator.runSemantic("viscoelasticity", fakeFailingEmbedder);
  assert.strictEqual(res.semanticAvailable, false);
  assert.strictEqual(res.scores, null);
});
