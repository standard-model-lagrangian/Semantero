import test from "node:test";
import assert from "node:assert";
import { chooseAttachment, resolveInside, resolveNoteFile, resolvePaperFile } from "../src/paths.ts";
import { lastHeading, obsidianNewUrl, obsidianOpenUrl } from "../src/urls.ts";
import { fixtureEngine } from "./helpers.ts";
import type { PaperMetadata } from "../../obsidian/paper-search/src/core/bm25.ts";

const paper = (extra: Partial<PaperMetadata>): PaperMetadata => ({
  key: "K", citekey: "k", title: "t", authors: [], year: null, journal: null, doi: null, tags: [], collections: [], abstract: null, ...extra,
});

test("R17 relative zotero file resolves under storage; absolute linked file kept", () => {
  assert.strictEqual(resolvePaperFile("/Z/storage", "ATT1/a b.pdf"), "/Z/storage/ATT1/a b.pdf");
  assert.strictEqual(resolvePaperFile("/Z/storage/", "ATT1/a.pdf"), "/Z/storage/ATT1/a.pdf");
  assert.strictEqual(resolvePaperFile("/Z/storage", "/Users/x/Papers/linked.pdf"), "/Users/x/Papers/linked.pdf");
  assert.strictEqual(resolvePaperFile(null, "/Users/x/linked.pdf"), "/Users/x/linked.pdf");
  assert.strictEqual(resolvePaperFile(null, "ATT1/a.pdf"), null);
  assert.strictEqual(resolvePaperFile("/Z/storage", undefined), null);
});

test("R18 '..' escape rejected → filePath null and no file actions", () => {
  assert.strictEqual(resolveInside("/vault", "../etc/passwd"), null);
  assert.strictEqual(resolveInside("/vault", "a/../../etc"), null);
  assert.strictEqual(resolveInside("/vault", "a/../b.md"), "/vault/b.md");
  assert.strictEqual(resolveInside("/vault", "/abs.md"), null);
  assert.strictEqual(resolveNoteFile("/vault", "../x.md"), null);
  assert.strictEqual(resolvePaperFile("/Z/storage", "../../secret.pdf"), null);
  const e = fixtureEngine();
  const vmBefore = e.keyword("matrigel", "notes", 3)[0];
  assert.ok(vmBefore.actions.includes("paste-file"));
  // a note whose recorded path escapes the vault
  const ix = e.corpora.notes!.ix;
  const i = ix.papers.findIndex((p) => p.path === "Organoid bottlenecks.md");
  const saved = ix.papers[i].path;
  ix.papers[i].path = "../outside.md";
  const vm = e.keyword("matrigel", "notes", 3)[0];
  ix.papers[i].path = saved;
  assert.strictEqual(vm.filePath, null);
  for (const a of ["paste-file", "copy-file", "copy-path", "reveal", "quicklook"]) assert.ok(!vm.actions.includes(a), a);
  assert.ok(vm.actions.includes("open") && vm.actions.includes("paste-wikilink"));
});

test("R19 which file: winning chunk's attachment > first PDF > first snapshot > none", () => {
  const p = paper({
    pdfs: [{ attachmentKey: "A", pages: 1, hasText: true, file: "A/a.pdf" }, { attachmentKey: "B", pages: 1, hasText: true, file: "B/b.pdf" }],
    snapshots: [{ attachmentKey: "S", hasText: true, file: "S/index.html" }],
  });
  assert.strictEqual(chooseAttachment(p, "B")!.attachmentKey, "B");
  assert.strictEqual(chooseAttachment(p, "S")!.kind, "snapshot");
  assert.strictEqual(chooseAttachment(p, "nope")!.attachmentKey, "A");
  assert.strictEqual(chooseAttachment(p, undefined)!.attachmentKey, "A");
  assert.strictEqual(chooseAttachment(paper({ snapshots: p.snapshots }), undefined)!.attachmentKey, "S");
  assert.strictEqual(chooseAttachment(paper({}), "A"), null);
});

test("R20 obsidian open URL encodes spaces, &, #, unicode; strips .md; heading appended as %23", () => {
  assert.strictEqual(obsidianOpenUrl("My Vault", "Folder/Note & Café #1.md"),
    "obsidian://open?vault=My%20Vault&file=Folder%2FNote%20%26%20Caf%C3%A9%20%231");
  assert.strictEqual(obsidianOpenUrl("V", "n.md", "Materials & more"), "obsidian://open?vault=V&file=n%23Materials%20%26%20more");
  assert.strictEqual(obsidianOpenUrl("V", "n.md", undefined), "obsidian://open?vault=V&file=n");
  assert.strictEqual(obsidianNewUrl("V", "roth2023tunable"), "obsidian://new?vault=V&file=roth2023tunable");
  assert.strictEqual(lastHeading("A › B › C"), "C");
  assert.strictEqual(lastHeading(""), undefined);
  assert.strictEqual(lastHeading(undefined), undefined);
});

test("R20b a paper's ↵ target is the Zotero URL for its winning attachment, page, snapshot or item", () => {
  const e = fixtureEngine();
  const vm = e.keyword("stiffer gels promoted chemoresistance", "papers", 3)[0];
  assert.strictEqual(vm.openUrl, "zotero://open-pdf/library/items/ATT004A?page=4");
  assert.strictEqual(vm.openLabel, "Open in Zotero at p. 4");
  assert.strictEqual(vm.accessory, "p. 4");
  const abs = e.keyword("viscoelasticity", "papers", 3).find((r) => r.accessory === "abstract")!;
  assert.match(abs.openUrl, /^zotero:\/\/open-pdf\/library\/items\/ATT\w+\?page=1$/);
  assert.strictEqual(abs.openLabel, "Open in Zotero");
});
