import test from "node:test";
import assert from "node:assert";
import { CiteLinkNotes, wikilinkTargets } from "../src/citelinks.ts";
import type { PaperMetadata } from "../src/core/bm25.ts";
import { FakeMetadataCache, FakeVault } from "./fakes.ts";

function paper(key: string, citekey: string, abstract: string | null = `Abstract of ${citekey}`): PaperMetadata {
  return {
    key, citekey, title: `Title ${citekey}`, authors: ["Roth"], year: 2023, abstract,
    journal: null, doi: null, tags: [], collections: [],
  };
}

const PAPERS = [paper("KEY1", "roth2023tunable"), paper("KEY2", "wang2024engineered")];

function setup(settings: Record<string, unknown> = { literatureNoteFolder: "Lit" }, papers = PAPERS) {
  const vault = new FakeVault();
  const notices: string[] = [];
  const opened: string[] = [];
  let lookups = 0;
  const notes = new CiteLinkNotes({
    papers: async () => {
      lookups++;
      return papers;
    },
    vault,
    metadataCache: new FakeMetadataCache(vault),
    settings,
    showNotice: (m) => notices.push(m),
    sessionNotices: new Set(),
    openFile: async (f) => {
      opened.push(f.path);
    },
  });
  return { vault, notes, notices, opened, lookups: () => lookups };
}

test("CL1 wikilink targets: alias, heading, block, .md and folder are stripped; embeds skipped; deduplicated", () => {
  assert.deepStrictEqual(
    wikilinkTargets("see [[roth2023tunable]] and [[Lit/wang2024engineered.md|Wang]], [[roth2023tunable#Abstract]] ![[fig.png]] [[a^b1]]"),
    ["roth2023tunable", "wang2024engineered", "a"]
  );
  assert.deepStrictEqual(wikilinkTargets("no links [here] or [[]]"), []);
});

test("CL2 pasting [[citekey]] (the launcher's ⌘L) creates the literature note with abstract and Zotero link", async () => {
  const { vault, notes } = setup();
  await notes.onPaste("[[roth2023tunable]]");
  const f = vault.getAbstractFileByPath("Lit/roth2023tunable.md");
  assert.ok(f, "literature note created");
  assert.match(f!.content, /Abstract of roth2023tunable/);
  assert.match(f!.content, /zotero:\/\/select\/library\/items\/KEY1/);
});

test("CL3 pasting several citations creates each missing note; existing notes are left alone", async () => {
  const { vault, notes } = setup();
  vault.addFile("Lit/roth2023tunable.md", "my own notes");
  await notes.onPaste("as shown [[roth2023tunable]] and [[wang2024engineered|Wang]]");
  assert.strictEqual(vault.getAbstractFileByPath("Lit/roth2023tunable.md")!.content, "my own notes");
  assert.ok(vault.getAbstractFileByPath("Lit/wang2024engineered.md"));
});

test("CL4 links that are not citekeys, plain text and disabled note creation create nothing", async () => {
  const off = setup({ literatureNoteFolder: "Lit", createLiteratureNotes: false });
  await off.notes.onPaste("[[roth2023tunable]]");
  assert.strictEqual(off.vault.getFiles().length, 0);

  const { vault, notes, lookups } = setup();
  await notes.onPaste("[[Some other note]] and roth2023tunable without brackets");
  assert.strictEqual(vault.getFiles().length, 0);
  await notes.onPaste("no link at all");
  assert.strictEqual(lookups(), 1, "text without [[ never loads the index");
});

test("CL5 a citekey link matches regardless of case, as Obsidian resolves links", async () => {
  const { vault, notes } = setup();
  await notes.onPaste("[[Roth2023Tunable]]");
  assert.ok(vault.getAbstractFileByPath("Lit/roth2023tunable.md"));
});

test("CL6 opening a note by citekey (the launcher's ⌘O) creates it from the template, then opens it", async () => {
  const { vault, notes, opened } = setup();
  await notes.openNote("wang2024engineered");
  assert.match(vault.getAbstractFileByPath("Lit/wang2024engineered.md")!.content, /Abstract of wang2024engineered/);
  assert.deepStrictEqual(opened, ["Lit/wang2024engineered.md"]);
});

test("CL7 opening a citekey the index does not list opens an existing note, else says so", async () => {
  const { vault, notes, opened, notices } = setup();
  vault.addFile("Elsewhere/smith2019.md", "x");
  await notes.openNote("smith2019");
  assert.deepStrictEqual(opened, ["Elsewhere/smith2019.md"]);
  await notes.openNote("nobody2000");
  assert.strictEqual(opened.length, 1);
  assert.match(notices.join("\n"), /nobody2000/);
  assert.strictEqual(vault.getAbstractFileByPath("Lit/nobody2000.md"), null);
});

test("CL8 two pastes of the same citation at once create one note without a notice", async () => {
  const { vault, notes, notices } = setup();
  await Promise.all([notes.onPaste("[[roth2023tunable]]"), notes.onPaste("[[roth2023tunable]]")]);
  assert.strictEqual(vault.getFiles().length, 1);
  assert.deepStrictEqual(notices, []);
});

test("CL9 a blank note named after a citekey (clicking an unresolved [[citekey]]) is filled from the template", async () => {
  const { vault, notes } = setup();
  const blank = vault.addFile("roth2023tunable.md", "");
  await notes.onCreate(blank);
  assert.match(blank.content, /Abstract of roth2023tunable/);

  const written = vault.addFile("wang2024engineered.md", "already written");
  await notes.onCreate(written);
  assert.strictEqual(written.content, "already written");

  const other = vault.addFile("Ideas.md", "");
  await notes.onCreate(other);
  assert.strictEqual(other.content, "");

  const pdf = vault.addFile("roth2023tunable.pdf", "");
  await notes.onCreate(pdf);
  assert.strictEqual(pdf.content, "");
});
