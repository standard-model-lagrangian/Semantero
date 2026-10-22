import test from "node:test";
import assert from "node:assert";
import { rowScores } from "../../obsidian/paper-search/src/engine.ts";
import { Engine } from "../src/query.ts";
import { fakeVec, fixtureCorpora, fixtureEngine } from "./helpers.ts";

test("R13 scope Papers never reads the notes corpus (and the reverse)", () => {
  for (const [scope, other] of [["papers", "notes"], ["notes", "papers"]] as const) {
    const c = fixtureCorpora();
    let reads = 0;
    (c as any)[other] = new Proxy((c as any)[other], { get(t, k) { reads++; return t[k]; } });
    const e = new Engine(c);
    const q = "stress relaxation neurons";
    assert.ok(e.keyword(q, scope, 5).length > 0);
    assert.ok(e.hybrid(q, fakeVec(q), scope, 5).length > 0);
    assert.strictEqual(reads, 0, `scope ${scope} touched ${other}`);
  }
});

test("R14 hybridFromRowScores equals hybrid for the same vector", () => {
  const c = fixtureCorpora();
  const e = new Engine(c);
  for (const q of ["stress relaxation neurons", "organoid growth", "matrigel batch"]) {
    const v = fakeVec(q);
    const scores = { papers: rowScores(c.papers!.ix, v), notes: rowScores(c.notes!.ix, v) };
    for (const scope of ["all", "papers", "notes"] as const) {
      assert.deepStrictEqual(e.hybridFromRowScores(q, scores, scope, 8), e.hybrid(q, v, scope, 8), `${q} / ${scope}`);
    }
  }
});

test("R15 empty query → recent notes by mtime, newest first, limit 10", () => {
  const e = fixtureEngine();
  const r = e.keyword("", "all", 15);
  assert.strictEqual(r.length, 7);
  assert.deepStrictEqual(r.map((x) => x.title), [
    "Roth 2023 literature note", "Next generation cancer organoids", "Only frontmatter", "bad-yaml",
    "Review 2026-W42", "Organoid bottlenecks", "Tue 20 Oct 2026",
  ]);
  assert.strictEqual(e.keyword("   ", "all", 3).length, 3);
  assert.deepStrictEqual(e.keyword("", "papers", 5), []);
  assert.strictEqual(e.recent(2).length, 2);
  assert.strictEqual(e.hybrid("", fakeVec("x"), "all", 4).length, 4);
});

test("R16 stopword-only or token-less query returns [] without throwing", () => {
  const e = fixtureEngine();
  for (const q of ["the of and", "!!!", "—", "a"]) {
    assert.deepStrictEqual(e.keyword(q, "all", 5), [], q);
    assert.deepStrictEqual(e.hybrid(q, fakeVec(q), "all", 5), [], q);
  }
});

test("R16b query vector with the wrong dims is ignored (keyword results only)", () => {
  const e = fixtureEngine();
  const kw = e.keyword("stress relaxation", "all", 5).map((r) => r.id);
  const bad = e.hybrid("stress relaxation", new Float32Array(3), "all", 5).map((r) => r.id);
  assert.deepStrictEqual(bad, kw);
});

test("R14b interleaveSemantic alternates the two corpora's semantic lists instead of comparing cosines", () => {
  const c = fixtureCorpora();
  const q = "stress relaxation neurons organoid";
  const v = fakeVec(q);
  const scores = { papers: rowScores(c.papers!.ix, v), notes: rowScores(c.notes!.ix, v) };
  const a = new Engine(c).hybridFromRowScores(q, scores, "all", 10).map((r) => r.id);
  const b = new Engine(c, { interleaveSemantic: true }).hybridFromRowScores(q, scores, "all", 10).map((r) => r.id);
  assert.strictEqual(new Set(b).size, b.length);
  assert.ok(b.length >= a.length - 1);
});

test("R16c lookup resolves ids from the current engine, in order, skipping unknown ones", () => {
  const e = fixtureEngine();
  const found = e.keyword("stress relaxation", "all", 5);
  const ids = found.map((r) => r.id);
  const looked = e.lookup([...ids].reverse().concat(["P:NOPE", "N:NOPE", "X:1"]));
  assert.deepStrictEqual(looked.map((r) => r.id), [...ids].reverse());
  const paper = e.lookup(["P:KEY0001"])[0];
  assert.strictEqual(paper.kind, "paper");
  assert.strictEqual(paper.title, "Tunable hydrogel viscoelasticity modulates human neural maturation");
  assert.strictEqual(paper.accessory, "abstract");
  assert.ok(paper.filePath);
  const note = e.lookup([e.recent(1)[0].id])[0];
  assert.strictEqual(note.kind, "litnote");
  assert.deepStrictEqual(e.lookup([]), []);
});
