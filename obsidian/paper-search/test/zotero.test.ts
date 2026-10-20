import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { selectItemUrl, openPdfUrl } from "../src/zotero.ts";
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
  for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith(".ts") && n !== "zotero.ts")) {
    const code = fs.readFileSync(path.join(srcDir, f), "utf8");
    assert.ok(!code.includes("zotero://"), `${f} builds a zotero:// link; use src/zotero.ts`);
  }
});
