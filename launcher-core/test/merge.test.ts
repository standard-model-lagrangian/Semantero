import test from "node:test";
import assert from "node:assert";
import type { Hit } from "../../obsidian/paper-search/src/engine.ts";
import { collapseLitnotes, interleave, rrf, sortByCosine, type CHit } from "../src/merge.ts";
import { buildVM } from "../src/vm.ts";
import { fixtureCorpora, fixtureEngine, fakeVec } from "./helpers.ts";

const hit = (corpus: "papers" | "notes", paper: number, score = 0, source: Hit["source"] = "keyword"): CHit => ({
  corpus,
  hit: { paper, score, source, snippet: "", fromAbstract: true },
});
const ids = (l: CHit[]) => l.map((c) => `${c.corpus[0]}${c.hit.paper}`);

test("R5 interleave alternates by rank, papers first on ties, handles unequal lengths", () => {
  assert.deepStrictEqual(interleave(["p1", "p2", "p3"], ["n1", "n2", "n3"]), ["p1", "n1", "p2", "n2", "p3", "n3"]);
  assert.deepStrictEqual(interleave(["p1"], ["n1", "n2", "n3"]), ["p1", "n1", "n2", "n3"]);
  assert.deepStrictEqual(interleave(["p1", "p2"], []), ["p1", "p2"]);
  assert.deepStrictEqual(interleave([], []), []);
});

test("R6 sortByCosine merges by raw score across corpora", () => {
  const l = sortByCosine([hit("notes", 0, 0.5), hit("papers", 1, 0.9), hit("notes", 2, 0.7), hit("papers", 3, 0.2)]);
  assert.deepStrictEqual(ids(l), ["p1", "n2", "n0", "p3"]);
});

test("R7 rrf over kw and sem: an item in one list only still ranks", () => {
  const kw = [hit("papers", 1), hit("notes", 5)];
  const sem = [hit("papers", 1, 0.9), hit("papers", 2, 0.8)];
  const merged = rrf(kw, sem);
  assert.deepStrictEqual(ids(merged), ["p1", "n5", "p2"]); // n5 and p2 tie on 1/62: the keyword list comes first
  assert.strictEqual(merged[0].hit.source, "both");
  assert.strictEqual(merged.find((c) => c.corpus === "notes")!.hit.source, "keyword");
  assert.strictEqual(merged.find((c) => c.hit.paper === 2)!.hit.source, "semantic");
  assert.ok(Math.abs(merged[0].hit.score - 2 / 61) < 1e-12);
});

test("R8 keyword-only path equals interleave after collapse", () => {
  const c = fixtureCorpora();
  const kw = interleave([hit("papers", 0), hit("papers", 1)], [hit("notes", 1), hit("notes", 2)]);
  assert.deepStrictEqual(ids(rrf(kw, [])), ids(kw));
  const rows = collapseLitnotes(kw, c);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.winner), ["paper", "note", "paper", "note"]);
});

const idx = (c: ReturnType<typeof fixtureCorpora>, corpus: "papers" | "notes", key: (p: any) => boolean) =>
  c[corpus]!.ix.papers.findIndex(key);

test("R9 collapseLitnotes: paper + its litnote → one row at the better position", () => {
  const c = fixtureCorpora();
  const roth = idx(c, "papers", (p) => p.citekey === "roth2023tunable");
  const rothNote = idx(c, "notes", (p) => p.litnoteOf === "roth2023tunable");
  const other = idx(c, "papers", (p) => p.citekey === "wang2024engineered");
  const rows = collapseLitnotes([hit("papers", roth), hit("papers", other), hit("notes", rothNote)], c);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].winner, "paper");
  assert.ok(rows[0].paper && rows[0].note);
  assert.strictEqual(rows[1].paper!.hit.paper, other);
});

test("R10 collapse: the litnote ranked higher → note snippet and heading, ↵ opens the note", () => {
  const c = fixtureCorpora();
  const roth = idx(c, "papers", (p) => p.citekey === "roth2023tunable");
  const rothNote = idx(c, "notes", (p) => p.litnoteOf === "roth2023tunable");
  const rows = collapseLitnotes([hit("notes", rothNote), hit("papers", roth)], c);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].winner, "note");

  // Build the view model for a row whose note won, with a chunk that has a heading.
  const chunkIndex = c.notes!.ix.chunks.findIndex((ch) => ch.paper === rothNote);
  const chunk = c.notes!.ix.chunks[chunkIndex];
  const row = rows[0];
  row.note!.hit.snippet = "my thoughts on stress relaxation";
  row.note!.hit.chunkIndex = chunkIndex;
  row.note!.hit.fromAbstract = false;
  row.paper!.hit.snippet = "Faster stress relaxation accelerated";
  const vm = buildVM(row, c, ["stress"]);
  const last = chunk.heading!.split(" › ").pop()!;
  assert.match(vm.openUrl, /^obsidian:\/\/open\?vault=Obsidian%20Vault&file=roth2023tunable%23/);
  assert.ok(vm.openUrl.endsWith(encodeURIComponent(last)));
  assert.strictEqual(vm.openLabel, "Open in Obsidian");
  assert.strictEqual(vm.snippet, "my thoughts on stress relaxation");
  assert.strictEqual(vm.subtitle, chunk.heading);
  assert.strictEqual(vm.kind, "paper");
  assert.strictEqual(vm.id, "P:KEY0001");
  assert.strictEqual(vm.hasNote, true);
  assert.match(vm.filePath!, /\/Users\/test\/Zotero\/storage\/ATT001\/sample\.pdf$/); // ⌘↵ still pastes the PDF
  assert.strictEqual(vm.citation, `"my thoughts on stress relaxation" (note: Roth 2023 literature note › ${chunk.heading})`);
  assert.match(vm.noteUrl!, /^obsidian:\/\/open\?vault=Obsidian%20Vault&file=roth2023tunable$/);
});

test("R11 collapse: litnote whose paper is absent stays a note row", () => {
  const c = fixtureCorpora();
  const rothNote = idx(c, "notes", (p) => p.litnoteOf === "roth2023tunable");
  const rows = collapseLitnotes([hit("notes", rothNote)], c);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].paper, undefined);
  const vm = fixtureEngine().keyword("faster stress relaxation", "notes", 10).find((r) => r.kind === "litnote" && r.title.startsWith("Roth"))!;
  assert.ok(vm);
  assert.strictEqual(vm.selectUrl, "zotero://select/library/items/KEY0001");
  assert.ok(vm.actions.includes("select-zotero"));
});

test("R12 deterministic order for equal scores (corpus, then index)", () => {
  const l = sortByCosine([hit("notes", 0, 0.5), hit("papers", 2, 0.5), hit("papers", 1, 0.5), hit("notes", 1, 0.5)]);
  assert.deepStrictEqual(ids(l), ["p1", "p2", "n0", "n1"]);
  const e = fixtureEngine();
  const q = "organoid hydrogel stress";
  const a = JSON.stringify(e.hybrid(q, fakeVec(q), "all", 10));
  for (let i = 0; i < 5; i++) assert.strictEqual(JSON.stringify(e.hybrid(q, fakeVec(q), "all", 10)), a);
});
