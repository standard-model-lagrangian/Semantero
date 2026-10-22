process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { buildCorpora } from "../src/corpora.ts";
import { Engine } from "../src/query.ts";
import { fakeVec, fixtureParts, rawFixtures } from "./helpers.ts";

const QUERIES = ["organoid", "stress relaxation", "matrigel", "roth", "crosslinking reproducible", "faster stress relaxation", ""];

test("R35 a notes-only reload gives exactly what a full build gives, and reuses the papers corpus", () => {
  const f = rawFixtures();
  const full = new Engine(buildCorpora(f.papers, f.notes));
  const g = rawFixtures();
  const partial = new Engine(buildCorpora(g.papers, null)).withNotes(g.notes);
  for (const q of QUERIES) for (const scope of ["all", "papers", "notes"] as const) {
    assert.deepStrictEqual(partial.keyword(q, scope, 8), full.keyword(q, scope, 8), `${q} ${scope}`);
    assert.deepStrictEqual(partial.hybrid(q, fakeVec(q), scope, 6), full.hybrid(q, fakeVec(q), scope, 6), `${q} ${scope} hybrid`);
  }
  assert.deepStrictEqual(partial.status(), full.status());
  const base = new Engine(buildCorpora(rawFixtures().papers, rawFixtures().notes));
  assert.strictEqual(base.withNotes(rawFixtures().notes).corpora.papers, base.corpora.papers, "papers corpus object reused");
});

test("R36 notes-only reload picks up changed notes and literature-note links, and handles a removed notes index", () => {
  const base = new Engine(buildCorpora(rawFixtures().papers, rawFixtures().notes));
  const changed = rawFixtures().notes;
  changed.papers = changed.papers.filter((p) => p.litnoteOf !== "roth2023tunable");
  const next = base.withNotes({ ...changed, chunks: [], vectors: null });
  assert.strictEqual(next.keyword("roth", "papers", 1)[0].hasNote, false, "the removed literature note no longer collapses");
  assert.strictEqual(base.keyword("roth", "papers", 1)[0].hasNote, true, "the old engine is unchanged");
  const gone = base.withNotes(null);
  assert.ok(gone.corpora.flags.includes("notes index missing"));
  assert.deepStrictEqual(gone.keyword("matrigel", "notes", 3), []);
});

test("R37 bundle: daito.loadNotes swaps the notes corpus and keeps answering", () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.resolve(import.meta.dirname, "../dist/ranker.js"), "utf8"), ctx);
  const { papers, notes } = fixtureParts();
  (ctx as any).daito.load(papers, null);
  assert.deepStrictEqual(JSON.parse((ctx as any).daito.keyword("matrigel", "notes", 3)), []);
  const st = JSON.parse((ctx as any).daito.loadNotes(notes));
  assert.strictEqual(st.notes.count, 7);
  assert.strictEqual(JSON.parse((ctx as any).daito.keyword("matrigel", "notes", 3))[0].title, "Organoid bottlenecks");
  assert.throws(() => (ctx as any).daito.loadNotes({ ...notes!, manifest: "{bad" }));
  assert.strictEqual(JSON.parse((ctx as any).daito.keyword("matrigel", "notes", 3))[0].title, "Organoid bottlenecks", "failed reload keeps the engine");
});
