import test from "node:test";
import assert from "node:assert";
import { buildCorpora } from "../src/corpora.ts";
import { Engine } from "../src/query.ts";
import { fakeVec, fixtureCorpora, rawFixtures } from "./helpers.ts";

test("R1 builds both corpora from in-memory buffers", () => {
  const c = fixtureCorpora();
  assert.strictEqual(c.papers!.ix.papers.length, 4);
  assert.strictEqual(c.notes!.ix.papers.length, 7);
  assert.ok(c.papers!.semantic && c.notes!.semantic);
  assert.deepStrictEqual(c.flags, []);
  assert.strictEqual(c.zoteroStorage, "/Users/test/Zotero/storage");
  assert.strictEqual(c.vault, "/Users/test/Obsidian Vault");
  assert.strictEqual(c.vaultName, "Obsidian Vault");
  assert.strictEqual(c.dims, 8);
  assert.strictEqual(c.model, "qwen3-embedding:0.6b");
  assert.strictEqual(c.litnoteByCitekey.get("roth2023tunable")?.path, "roth2023tunable.md");
  assert.strictEqual(c.paperKeyByCitekey.get("roth2023tunable"), "KEY0001");
});

test("R2 missing notes corpus → papers only with a flag; and the reverse; never throws", () => {
  const f = rawFixtures();
  const papersOnly = new Engine(buildCorpora(f.papers, null));
  assert.ok(papersOnly.corpora.flags.includes("notes index missing"));
  assert.ok(papersOnly.keyword("stress relaxation", "all", 5).length > 0);
  assert.deepStrictEqual(papersOnly.recent(5), []);

  const notesOnly = new Engine(buildCorpora(null, f.notes));
  assert.ok(notesOnly.corpora.flags.includes("papers index missing"));
  const r = notesOnly.keyword("matrigel", "all", 5);
  assert.strictEqual(r[0].kind, "note");
  assert.strictEqual(r[0].selectUrl, null);

  const none = new Engine(buildCorpora(null, null));
  assert.deepStrictEqual(none.keyword("anything", "all", 5), []);
  assert.deepStrictEqual(none.hybrid("anything", fakeVec("anything"), "all", 5), []);
});

test("R3 manifest model/dims/instruction mismatch marks that corpus keyword-only", () => {
  for (const change of [{ model: "other" }, { dims: 16 }, { query_instruction: "different" }]) {
    const f = rawFixtures();
    f.notes.manifest = { ...f.notes.manifest, ...change };
    const c = buildCorpora(f.papers, f.notes);
    assert.strictEqual(c.notes!.semantic, false, JSON.stringify(change));
    assert.strictEqual(c.notes!.reason, "index model differs");
    assert.ok(c.flags.some((x) => x.startsWith("notes: semantic off")));
    assert.ok(c.papers!.semantic);
    // keyword still finds notes; hybrid contributes semantic hits from papers only
    const e = new Engine(c);
    const hits = e.hybrid("stress relaxation neurons", fakeVec("stress relaxation neurons"), "all", 10);
    assert.ok(hits.every((h) => !(h.id.startsWith("N:") && h.source === "semantic")));
    assert.ok(e.keyword("matrigel", "all", 5).some((h) => h.id.startsWith("N:")));
  }
});

test("R4 bad vectors length → keyword-only for that corpus, no throw", () => {
  const f = rawFixtures();
  f.papers.vectors = new ArrayBuffer(12);
  const c = buildCorpora(f.papers, f.notes);
  assert.strictEqual(c.papers!.semantic, false);
  assert.strictEqual(c.papers!.reason, "vectors file invalid");
  const e = new Engine(c);
  assert.ok(e.keyword("viscoelasticity", "papers", 5).length > 0);
  assert.ok(e.hybrid("stress relaxation", fakeVec("stress relaxation"), "papers", 5).length > 0);

  const g = rawFixtures();
  g.notes.vectors = null;
  const c2 = buildCorpora(g.papers, g.notes);
  assert.strictEqual(c2.notes!.semantic, false);
  assert.strictEqual(c2.notes!.reason, "no vectors");

  const h = rawFixtures();
  h.notes.manifest = { ...h.notes.manifest, dims: "x" };
  assert.strictEqual(buildCorpora(h.papers, h.notes).notes!.semantic, false);
});

test("R4b degraded corpus (rows with no vectors) is keyword-only without a flag", () => {
  const f = rawFixtures();
  f.notes.chunks = f.notes.chunks.map((c) => ({ ...c, row: null }));
  f.notes.papers = f.notes.papers.map((p) => ({ ...p, abstractRow: null }));
  f.notes.vectors = new ArrayBuffer(0);
  const c = buildCorpora(f.papers, f.notes);
  assert.strictEqual(c.notes!.semantic, false);
  assert.ok(new Engine(c).keyword("matrigel", "notes", 5).length > 0);
});
