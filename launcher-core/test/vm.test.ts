import test from "node:test";
import assert from "node:assert";
import { buildCorpora, type RawCorpus } from "../src/corpora.ts";
import { ACTIONS, actionsFor, RESERVED_KEYS } from "../src/actions.ts";
import { authorsShort, noteCitation, noteWikilink, paperCitation, paperWikilink } from "../src/cite.ts";
import { Engine } from "../src/query.ts";
import { boldRanges } from "../src/vm.ts";
import { fixtureEngine } from "./helpers.ts";

test("R21 authors 1/2/≥3 formatting", () => {
  assert.strictEqual(authorsShort([]), "");
  assert.strictEqual(authorsShort(["Roth"]), "Roth");
  assert.strictEqual(authorsShort(["Roth", "Bauer"]), "Roth & Bauer");
  assert.strictEqual(authorsShort(["Roth", "Bauer", "Lee"]), "Roth et al.");
  assert.strictEqual(authorsShort(["Roth", "", "Bauer"]), "Roth & Bauer");
});

test("R22 paper citation with page, abstract, snapshot; missing parts dropped", () => {
  assert.strictEqual(paperCitation("…faster stress relaxation…", ["Roth", "Bauer", "X"], 2023, "p. 6"),
    '"…faster stress relaxation…" (Roth et al., 2023, p. 6)');
  assert.strictEqual(paperCitation("x", ["Roth"], 2023, "abstract"), '"x" (Roth, 2023, abstract)');
  assert.strictEqual(paperCitation("x", [], null, "snapshot"), '"x" (snapshot)');
  assert.strictEqual(paperCitation("x", [], null, ""), '"x"');
  const vm = fixtureEngine().keyword("stiffer gels promoted chemoresistance", "papers", 1)[0];
  assert.match(vm.citation, /^".*Stiffer gels.*" \(Wang & Zhang, 2024, p\. 4\)$/);
});

test("R23 note citation with heading path; lead row cites the title only", () => {
  assert.strictEqual(noteCitation("only 53%", "LeSavage 2022", "Materials › EHS"), '"only 53%" (note: LeSavage 2022 › Materials › EHS)');
  assert.strictEqual(noteCitation("lead words", "Organoid bottlenecks", undefined), '"lead words" (note: Organoid bottlenecks)');
  const e = fixtureEngine();
  assert.strictEqual(noteCitation("x", "Organoid bottlenecks", "Organoid bottlenecks › Materials"), '"x" (note: Organoid bottlenecks › Materials)');
  assert.strictEqual(noteCitation("x", "Organoid bottlenecks", "Organoid bottlenecks"), '"x" (note: Organoid bottlenecks)');
  const vm = e.keyword("crosslinking reproducible", "notes", 1)[0];
  assert.strictEqual(vm.subtitle, "Organoid bottlenecks › Materials › Collagen");
  assert.match(vm.citation, /\(note: Organoid bottlenecks › Materials › Collagen\)$/);
  const lead = e.keyword("single cells fragments", "notes", 1)[0]; // the lead row won: no heading
  assert.match(lead.citation, /\(note: Organoid bottlenecks\)$/);
});

test("R24 wikilinks: [[citekey]] for papers, [[Note name]] for notes (no .md, folder dropped)", () => {
  assert.strictEqual(paperWikilink("roth2023tunable"), "[[roth2023tunable]]");
  assert.strictEqual(noteWikilink("Reviews/2026-W42.md"), "[[2026-W42]]");
  assert.strictEqual(noteWikilink("Top note.md"), "[[Top note]]");
  const e = fixtureEngine();
  assert.strictEqual(e.keyword("roth", "papers", 1)[0].wikilink, "[[roth2023tunable]]");
  assert.strictEqual(e.keyword("matrigel", "notes", 1)[0].wikilink, "[[Organoid bottlenecks]]");
});

test("R25 snippetBold ranges are UTF-16 offsets covering query tokens (emoji and accents before the match)", () => {
  const text = "😀 café stress relaxation matters";
  const ranges = boldRanges(text, ["stress", "relaxation"]);
  assert.deepStrictEqual(ranges.map(([a, b]) => text.slice(a, b)), ["stress relaxation"]);
  assert.strictEqual(ranges[0][0], 8); // 😀 is two UTF-16 units
  const t2 = "Café Éclair and café au lait";
  assert.deepStrictEqual(boldRanges(t2, ["café"]).map(([a, b]) => t2.slice(a, b)), ["Café", "café"]);
  assert.deepStrictEqual(boldRanges("viscoelasticity viscoelastic", ["viscoel"]).map(([a, b]) => [a, b]), [[0, 28]]);
  assert.deepStrictEqual(boldRanges("nothing here", ["zzz"]), []);
  assert.deepStrictEqual(boldRanges("a.b (c)", ["a.b"]).length, 1); // regex characters in tokens are escaped
  assert.deepStrictEqual(boldRanges("x", []), []);
  const vm = fixtureEngine().keyword("stress relaxation", "papers", 1)[0];
  assert.ok(vm.snippetBold.length > 0);
  for (const [a, b] of vm.snippetBold) assert.match(vm.snippet.slice(a, b).toLowerCase(), /stress|relax/);
});

const customPapers = (papers: any[]): RawCorpus => ({
  manifest: { dims: 8, model: "m", query_instruction: "q", zotero_storage: "/Z/storage" },
  papers: papers.map((p, i) => ({ key: `K${i}`, citekey: `c${i}`, title: `Gel paper ${i}`, authors: [], year: null, journal: null, doi: null,
    tags: [], collections: [], abstract: "gel mechanics abstract text", abstractRow: null, ...p })),
  chunks: [],
  vectors: null,
});

test("R26 action list per kind: paper-with-pdf, paper-no-attachment, snapshot-only, note, daily, collapsed litnote", () => {
  const e = fixtureEngine();
  const all = ACTIONS.map((a) => a.id);
  const paperPdf = e.keyword("stiffer gels promoted", "papers", 1)[0];
  assert.deepStrictEqual(paperPdf.actions, all); // a paper with a file and a literature-note target gets everything
  const note = e.keyword("matrigel", "notes", 1)[0];
  assert.strictEqual(note.kind, "note");
  assert.deepStrictEqual(note.actions, ["open", "paste-file", "paste-passage", "copy-file", "copy-passage", "copy-path", "reveal", "quicklook", "copy-wikilink"]);
  const daily = e.keyword("swiss charity", "notes", 5).find((r) => r.kind === "daily")!;
  assert.ok(daily, "daily note found");
  assert.deepStrictEqual(daily.actions, note.actions);
  const lit = e.keyword("faster stress relaxation", "notes", 5).find((r) => r.kind === "litnote")!;
  assert.deepStrictEqual(lit.actions, [...note.actions, "select-zotero"]);

  const none = new Engine(buildCorpora(customPapers([{}]), null)).keyword("gel", "papers", 1)[0];
  assert.strictEqual(none.filePath, null);
  assert.deepStrictEqual(none.actions, ["open", "paste-passage", "copy-passage", "copy-wikilink", "select-zotero"]);
  assert.strictEqual(none.openUrl, "zotero://select/library/items/K0");
  assert.strictEqual(none.openLabel, "Show in Zotero");
  assert.strictEqual(none.noteUrl, null); // no vault known → nothing to create a note in

  const snap = new Engine(buildCorpora(customPapers([{ snapshots: [{ attachmentKey: "S1", hasText: true, file: "S1/index.html" }] }]), null)).keyword("gel", "papers", 1)[0];
  assert.strictEqual(snap.filePath, "/Z/storage/S1/index.html");
  assert.strictEqual(snap.openUrl, "zotero://open/library/items/S1");
  assert.strictEqual(snap.openLabel, "Open snapshot in Zotero");
  assert.ok(snap.actions.includes("paste-file"));
});

test("R26b the paper's literature-note target: existing note opens it, missing note creates it", () => {
  const e = fixtureEngine();
  const has = e.keyword("stress relaxation", "papers", 3).find((r) => r.id === "P:KEY0001")!;
  assert.strictEqual(has.hasNote, true);
  assert.strictEqual(has.noteUrl, "obsidian://open?vault=Obsidian%20Vault&file=roth2023tunable");
  const without = e.keyword("stiffer gels", "all", 3).find((r) => r.id === "P:KEY0004")!;
  assert.strictEqual(without.hasNote, false);
  assert.strictEqual(without.noteUrl, "obsidian://new?vault=Obsidian%20Vault&file=wang2024engineered");
  assert.ok(without.actions.includes("open-note"));
});

test("R27 shortcuts.json: unique ids, unique keys, none reserved, needs are known fields", () => {
  const ids = ACTIONS.map((a) => a.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  const keys = ACTIONS.map((a) => a.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  for (const k of keys) assert.ok(!RESERVED_KEYS.includes(k), `${k} is reserved`);
  assert.deepStrictEqual(ids, ["open", "paste-file", "paste-passage", "copy-file", "copy-passage", "copy-path", "reveal", "quicklook", "copy-wikilink", "open-note", "select-zotero"]);
  assert.strictEqual(ACTIONS[0].key, "return");
  assert.strictEqual(ACTIONS[1].key, "cmd+return");
  for (const a of ACTIONS) for (const n of a.needs) assert.ok(["filePath", "noteUrl", "selectUrl"].includes(n));
  assert.deepStrictEqual(actionsFor("daily", { filePath: false, noteUrl: false, selectUrl: false }), ["open", "paste-passage", "copy-passage", "copy-wikilink"]);
  const e = fixtureEngine();
  for (const r of [...e.keyword("organoid", "all", 10), ...e.recent(10)]) for (const a of r.actions) assert.ok(ids.includes(a));
});

test("R27b detail rows and subtitles", () => {
  const e = fixtureEngine();
  const p = e.keyword("roth", "papers", 1)[0];
  assert.strictEqual(p.subtitle, "Roth & Bauer · 2023 · Science Advances");
  assert.deepStrictEqual(p.detail.map((d) => d.label), ["Title", "Authors", "Year", "Journal", "DOI", "Tags", "Collections", "File"]);
  assert.strictEqual(p.detail.find((d) => d.label === "File")!.value, "sample.pdf");
  const n = e.keyword("review replication hydrogel", "notes", 1)[0];
  assert.strictEqual(n.subtitle, "Reviews");
  assert.deepStrictEqual(n.detail.map((d) => d.label), ["Path", "Modified"]);
});
