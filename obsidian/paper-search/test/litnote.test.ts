import test from "node:test";
import assert from "node:assert";
import {
  findLiteratureNote,
  renderTemplate,
  ensureLiteratureNote,
  formatCitation,
  isSafeCitekey,
  normalizeFolder,
  BUILTIN_TEMPLATE,
} from "../src/litnote.ts";
import { FakeVault, FakeMetadataCache, FakeEditor } from "./fakes.ts";
import type { PaperMetadata } from "../src/bm25.ts";

function parseSimpleYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const res: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      res[key] = val;
    }
  }
  return res;
}

test("L1 existing note by file name is found case-insensitively and in subfolders", () => {
  const vault = new FakeVault();
  vault.addFile("roth2023.md", "content 1");
  vault.addFile("Literature/LeSavage2022.md", "content 2");

  // 1. exact match
  const f1 = findLiteratureNote(vault, null, "roth2023");
  assert.ok(f1);
  assert.strictEqual(f1.path, "roth2023.md");

  // 2. case-insensitive match: "lesavage2022" matches "Literature/LeSavage2022.md"
  const f2 = findLiteratureNote(vault, null, "lesavage2022");
  assert.ok(f2);
  assert.strictEqual(f2.path, "Literature/LeSavage2022.md");

  // 3. uppercase query matches lowercase file
  const f3 = findLiteratureNote(vault, null, "ROTH2023");
  assert.ok(f3);
  assert.strictEqual(f3.path, "roth2023.md");
});

test("L2 existing note by frontmatter citekey with different file name", () => {
  const vault = new FakeVault();
  const cache = new FakeMetadataCache(vault);
  vault.addFile(
    "CustomNoteTitle.md",
    "---\ncitekey: roth2023tunable\n---\nSome content",
    { frontmatter: { citekey: "roth2023tunable" } }
  );

  const found = findLiteratureNote(vault, cache, "roth2023tunable");
  assert.ok(found);
  assert.strictEqual(found.path, "CustomNoteTitle.md");
});

test("L3 creates <folder>/<citekey>.md from template for 3 paper variations", async () => {
  const vault = new FakeVault();
  const settings = {
    createLiteratureNotes: true,
    literatureNoteFolder: "Literature",
    literatureNoteTemplate: "Zotero Template.md",
  };

  const templateText = `---
citekey: "{{citekey}}"
title: "{{title}}"
authors: "{{authors}}"
year: "{{year}}"
journal: "{{journal}}"
---
# {{title}}

{{abstractNote}}
`;
  vault.addFile("Zotero Template.md", templateText);

  // Paper 1: with abstract
  const p1: PaperMetadata = {
    key: "K1",
    citekey: "roth2023",
    title: "Paper 1 Title",
    authors: ["Roth", "Bauer"],
    year: 2023,
    journal: "Science Advances",
    doi: "10.1126/test",
    tags: [],
    collections: [],
    abstract: "Abstract text for paper 1.",
  };
  const res1 = await ensureLiteratureNote(vault, null, p1, settings);
  assert.strictEqual(res1.created, true);
  assert.strictEqual(res1.file.path, "Literature/roth2023.md");
  assert.ok(res1.file.content.includes("Abstract text for paper 1."));

  // Paper 2: without abstract
  const p2: PaperMetadata = {
    key: "K2",
    citekey: "lesavage2022",
    title: "Paper 2 Title",
    authors: ["LeSavage"],
    year: 2022,
    journal: "Nature",
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };
  const res2 = await ensureLiteratureNote(vault, null, p2, settings);
  assert.strictEqual(res2.created, true);
  assert.strictEqual(res2.file.path, "Literature/lesavage2022.md");

  // Paper 3: without journal or year
  const p3: PaperMetadata = {
    key: "K3",
    citekey: "smithPreprint",
    title: "Paper 3 Title",
    authors: ["Smith"],
    year: null,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };
  const res3 = await ensureLiteratureNote(vault, null, p3, settings);
  assert.strictEqual(res3.created, true);
  assert.strictEqual(res3.file.path, "Literature/smithPreprint.md");
  const parsed3 = parseSimpleYamlFrontmatter(res3.file.content);
  assert.strictEqual(parsed3.year, "");
  assert.strictEqual(parsed3.journal, "");
});

test("L4 YAML escaping handles quotes, colons, and line breaks in frontmatter", () => {
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "review2024",
    title: 'Mitochondrial "transfer": a review\nwith second line',
    authors: ["Author: Name", "Other, Person"],
    year: 2024,
    journal: "Journal",
    doi: null,
    tags: [],
    collections: [],
    abstract: "Abstract",
  };

  const rendered = renderTemplate(BUILTIN_TEMPLATE, paper);
  const parsed = parseSimpleYamlFrontmatter(rendered);

  assert.strictEqual(parsed.title, 'Mitochondrial "transfer": a review with second line');
  assert.strictEqual(parsed.authors, "Author: Name, Other, Person");
  // Asserts title is on a single line in frontmatter
  const titleLine = rendered.split("\n").find((l) => l.startsWith("title:"));
  assert.ok(titleLine);
  assert.ok(!titleLine.includes("\n"));
});

test("L5 outside frontmatter, Markdown values go in unchanged", () => {
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "test2023",
    title: "Title",
    authors: ["Author"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: "Abstract with **bold**, *italics*, and [link](https://example.com).",
  };

  const rendered = renderTemplate(BUILTIN_TEMPLATE, paper);
  assert.ok(rendered.includes("Abstract with **bold**, *italics*, and [link](https://example.com)."));
});

test("L6 single pass: abstract containing {{title}} stays literally {{title}}", () => {
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "test2023",
    title: "Expanded Title",
    authors: ["Author"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: "Abstract discussing {{title}} placeholder in text.",
  };

  const rendered = renderTemplate(BUILTIN_TEMPLATE, paper);
  assert.ok(rendered.includes("Abstract discussing {{title}} placeholder in text."));
  assert.ok(!rendered.includes("Abstract discussing Expanded Title placeholder in text."));
});

test("L7 Nunjucks template triggers built-in fallback and exactly one notice per session", () => {
  const nunjucksTemplate = `---
title: {{ title }}
---
{% for author in authors %}
- {{ author }}
{% endfor %}
`;
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "p1",
    title: "My Paper",
    authors: ["A"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };

  let noticesCount = 0;
  const sessionNotices = new Set<string>();
  const showNotice = () => {
    noticesCount++;
  };

  // First call
  const out1 = renderTemplate(nunjucksTemplate, paper, {
    onUnsupportedTemplate: () => {
      if (!sessionNotices.has("nunjucks")) {
        sessionNotices.add("nunjucks");
        showNotice();
      }
    },
  });
  assert.ok(out1.includes("# My Paper")); // Built-in template header
  assert.strictEqual(noticesCount, 1);

  // Second call in same session: no second notice
  const out2 = renderTemplate(nunjucksTemplate, paper, {
    onUnsupportedTemplate: () => {
      if (!sessionNotices.has("nunjucks")) {
        sessionNotices.add("nunjucks");
        showNotice();
      }
    },
  });
  assert.strictEqual(noticesCount, 1);
});

test("L8 missing template file falls back to built-in template without notice spam", async () => {
  const vault = new FakeVault();
  const settings = {
    createLiteratureNotes: true,
    literatureNoteTemplate: "NonExistentTemplate.md",
  };
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "p1",
    title: "Title",
    authors: ["A"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };

  const notices: string[] = [];
  const res = await ensureLiteratureNote(vault, null, paper, settings, {
    showNotice: (msg) => notices.push(msg),
  });
  assert.strictEqual(res.created, true);
  assert.ok(res.file.content.includes("# Title"));
  assert.strictEqual(notices.length, 0); // No notice spam for missing template file
});

test("L9 never overwrites existing note even if created concurrently", async () => {
  const vault = new FakeVault();
  const settings = { createLiteratureNotes: true };
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "p1",
    title: "Title",
    authors: ["A"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };

  // Existing note
  vault.addFile("p1.md", "Original Content");

  const notices: string[] = [];
  const res = await ensureLiteratureNote(vault, null, paper, settings, {
    showNotice: (msg) => notices.push(msg),
  });

  assert.strictEqual(res.created, false);
  assert.strictEqual(res.file.content, "Original Content");
  assert.strictEqual(notices.length, 0);
});

test("L10 unsafe citekeys do not create note and produce explanatory notice", async () => {
  const vault = new FakeVault();
  const settings = { createLiteratureNotes: true };
  const unsafeKeys = ["a/b", "a:b", ".hidden", "a".repeat(201), ""];

  for (const k of unsafeKeys) {
    const paper: PaperMetadata = {
      key: "K1",
      citekey: k,
      title: "Title",
      authors: ["A"],
      year: 2023,
      journal: null,
      doi: null,
      tags: [],
      collections: [],
      abstract: null,
    };
    const notices: string[] = [];
    const res = await ensureLiteratureNote(vault, null, paper, settings, {
      showNotice: (msg) => notices.push(msg),
    });
    assert.strictEqual(res.created, false);
    assert.strictEqual(res.file, null);
    assert.ok(notices.some((n) => n.includes("cannot be used as a filename")));
  }
});

test("L11 citation format helper and validation", () => {
  assert.strictEqual(formatCitation("[[{{citekey}}]]", "roth2023"), "[[roth2023]]");
  assert.strictEqual(formatCitation("[@{{citekey}}]", "roth2023"), "[@roth2023]");
  assert.strictEqual(formatCitation("[[{{ citekey }}]]", "roth2023"), "[[roth2023]]");

  // Format without {{citekey}} throws
  assert.throws(() => {
    formatCitation("invalid_format", "roth2023");
  });
});

test("L12 creation failure does not undo citation insert in editor", async () => {
  const vault = new FakeVault();
  vault.throwOnCreate = new Error("Disk write error");
  const editor = new FakeEditor("Text @@query", { line: 0, ch: 12 });

  // 1. Insert citation
  const citation = formatCitation("[[{{citekey}}]]", "roth2023");
  editor.replaceRange(citation, { line: 0, ch: 5 }, { line: 0, ch: 12 });
  assert.strictEqual(editor.getValue(), "Text [[roth2023]]");

  // 2. Try creating note
  const paper: PaperMetadata = {
    key: "K1",
    citekey: "roth2023",
    title: "Title",
    authors: ["A"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };
  const notices: string[] = [];
  const res = await ensureLiteratureNote(vault, null, paper, { createLiteratureNotes: true }, {
    showNotice: (msg) => notices.push(msg),
  });

  // Note was not created due to error, but editor still has citation
  assert.strictEqual(res.created, false);
  assert.strictEqual(editor.getValue(), "Text [[roth2023]]");
  assert.ok(notices.some((n) => n.includes("failed to create literature note")));
});

test("L13 folder setting normalisation and path traversal rejection", async () => {
  assert.strictEqual(normalizeFolder("Literature/"), "Literature");
  assert.strictEqual(normalizeFolder("/Literature/Papers/"), "Literature/Papers");
  assert.strictEqual(normalizeFolder("./Literature"), "Literature");
  assert.strictEqual(normalizeFolder(""), "");

  // Path escaping vault is rejected
  assert.throws(() => {
    normalizeFolder("../Literature");
  });
  assert.throws(() => {
    normalizeFolder("Literature/../../escape");
  });
});
