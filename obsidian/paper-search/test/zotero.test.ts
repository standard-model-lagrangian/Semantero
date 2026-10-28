import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { selectItemUrl, openPdfUrl, openAttachmentUrl, hitUrl, hitLocation } from "../src/core/zotero.ts";
import { renderTemplate } from "../src/litnote.ts";
import { RelatedPapersController } from "../src/related.ts";

test("Z1 select link uses the library form Zotero accepts for a bare item key", () => {
  assert.strictEqual(selectItemUrl("AB12CD34"), "zotero://select/library/items/AB12CD34");
});

test("Z2 open-pdf link uses the attachment key and a page query", () => {
  assert.strictEqual(openPdfUrl("EF56GH78", 7), "zotero://open-pdf/library/items/EF56GH78?page=7");
  assert.strictEqual(openPdfUrl("EF56GH78"), "zotero://open-pdf/library/items/EF56GH78?page=1");
  assert.strictEqual(openPdfUrl("EF56GH78", 0), "zotero://open-pdf/library/items/EF56GH78?page=1");
});

test("Z3 built-in template's {{zoteroSelect}} is a valid select link", () => {
  const paper: any = { key: "AB12CD34", citekey: "roth2023", title: "T", authors: ["Roth"], abstract: "" };
  const out = renderTemplate("[Zotero]({{zoteroSelect}})", paper);
  assert.strictEqual(out.trim(), "[Zotero](zotero://select/library/items/AB12CD34)");
});

test("Z4 panel opens the matching attachment at the matching page, not the parent item", () => {
  const c = Object.create(RelatedPapersController.prototype);
  const paper: any = { key: "PARENTKY", citekey: "x", pdfs: [{ attachmentKey: "OTHERATT" }, { attachmentKey: "ATTKEY12" }] };
  assert.strictEqual(c.getPdfUrl(paper, { page: 7, attachmentKey: "ATTKEY12" }), "zotero://open-pdf/library/items/ATTKEY12?page=7");
  // abstract hit: first PDF at page 1
  assert.strictEqual(c.getPdfUrl(paper, { fromAbstract: true }), "zotero://open-pdf/library/items/OTHERATT?page=1");
  // no PDF at all: select the item instead
  assert.strictEqual(c.getPdfUrl({ key: "PARENTKY", pdfs: [] } as any, {}), "zotero://select/library/items/PARENTKY");
});

test("Z5 no source file builds zotero:// links by hand", () => {
  const srcDir = path.join(import.meta.dirname, "..", "src");
  for (const f of fs.readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((n) => n.endsWith(".ts") && n !== "core/zotero.ts")) {
    const code = fs.readFileSync(path.join(srcDir, f), "utf8");
    assert.ok(!code.includes("zotero://"), `${f} builds a zotero:// link; use src/core/zotero.ts`);
  }
});

test("Z6 a web-snapshot hit opens the snapshot without a page; abstract hits fall back to it", () => {
  assert.strictEqual(openAttachmentUrl("SNAPKEY1"), "zotero://open/library/items/SNAPKEY1");
  const both: any = { key: "PARENTKY", pdfs: [{ attachmentKey: "PDFKEY01" }], snapshots: [{ attachmentKey: "SNAPKEY1" }] };
  // chunk from the snapshot (page 0): never an open-pdf link with a page
  assert.strictEqual(hitUrl(both, { attachmentKey: "SNAPKEY1", page: 0 }), "zotero://open/library/items/SNAPKEY1");
  // chunk from the PDF of the same paper still opens at its page
  assert.strictEqual(hitUrl(both, { attachmentKey: "PDFKEY01", page: 4 }), "zotero://open-pdf/library/items/PDFKEY01?page=4");
  // abstract hit prefers the PDF
  assert.strictEqual(hitUrl(both, {}), "zotero://open-pdf/library/items/PDFKEY01?page=1");
  // abstract hit on a snapshot-only paper opens the snapshot
  const snapOnly: any = { key: "PARENTKY", pdfs: [], snapshots: [{ attachmentKey: "SNAPKEY1" }] };
  assert.strictEqual(hitUrl(snapOnly, {}), "zotero://open/library/items/SNAPKEY1");
  // the panel uses the same rule
  const c = Object.create(RelatedPapersController.prototype);
  assert.strictEqual(c.getPdfUrl(snapOnly, { attachmentKey: "SNAPKEY1", page: 0, fromAbstract: false }), "zotero://open/library/items/SNAPKEY1");
  // papers.json from an index built before snapshots existed has no `snapshots` field
  assert.strictEqual(hitUrl({ key: "PARENTKY" } as any, undefined), "zotero://select/library/items/PARENTKY");
});

test("Z7 hitLocation: abstract, the PDF page, or the snapshot (one label for the modal, the panel and the launcher)", () => {
  const p: any = { key: "PARENTKY", pdfs: [{ attachmentKey: "PDFKEY01" }], snapshots: [{ attachmentKey: "SNAPKEY1" }] };
  assert.strictEqual(hitLocation(p, { fromAbstract: true }), "abstract");
  assert.strictEqual(hitLocation(p, { fromAbstract: false, attachmentKey: "PDFKEY01", page: 4 }), "p. 4");
  assert.strictEqual(hitLocation(p, { fromAbstract: false, attachmentKey: "SNAPKEY1", page: 0 }), "snapshot");
  assert.strictEqual(hitLocation(p, { fromAbstract: false, attachmentKey: "SNAPKEY1", page: 0 }, "web page"), "web page");
  // a chunk with no page to show falls back to "abstract"
  assert.strictEqual(hitLocation(p, { fromAbstract: false, attachmentKey: "PDFKEY01", page: 0 }), "abstract");
});
