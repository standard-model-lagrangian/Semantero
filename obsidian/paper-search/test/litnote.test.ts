import test from "node:test";
import { readFileSync } from "node:fs";
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

// L3 renders a copy of the user's real template (~/Documents/Obsidian Vault/Zotero Template.md,
// copied into test/fixtures/litnote; the vault itself is never read) and compares whole files.
const LITNOTE_FIXTURES = new URL("./fixtures/litnote/", import.meta.url);

test("L3 creates <folder>/<citekey>.md from the real template, matching expected files", async () => {
  const vault = new FakeVault();
  const settings = {
    createLiteratureNotes: true,
    literatureNoteFolder: "Literature",
    literatureNoteTemplate: "Zotero Template.md",
  };
  vault.addFile("Zotero Template.md", readFileSync(new URL("zotero-template.md", LITNOTE_FIXTURES), "utf8"));

  const base = { doi: null, journal: null, year: 2023, tags: [], collections: [] };
  const papers: PaperMetadata[] = [
    {
      ...base,
      key: "K1",
      citekey: "roth2023",
      title: "Faster stress relaxation in viscoelastic hydrogels",
      authors: ["Roth", "Bauer"],
      abstract: "Hydrogels with faster stress relaxation promote spreading.",
    },
    {
      ...base,
      key: "K2",
      citekey: "lesavage2024",
      title: 'Mitochondrial "transfer": a review\nwith C:\\ paths',
      authors: ["LeSavage", "O'Brien: J."],
      abstract: null,
    },
    {
      ...base,
      key: "K3",
      citekey: "smith-2020_x",
      title: "N-cadherin in cell-free systems",
      authors: [],
      year: null,
      abstract: "Line one.\nLine two with {{title}} kept literally.",
    },
  ];

  for (const p of papers) {
    const res = await ensureLiteratureNote(vault, null, p, settings);
    assert.strictEqual(res.created, true);
    assert.strictEqual(res.file.path, `Literature/${p.citekey}.md`);
    const expected = readFileSync(new URL(`expected/${p.citekey}.md`, LITNOTE_FIXTURES), "utf8");
    assert.strictEqual(res.file.content, expected, `${p.citekey}.md`);
  }
});

test("L3b unquoted frontmatter placeholders are escaped once; list items and plain values untouched", () => {
  const template = `---
citekey: {{citekey}}
title: {{title}}
quoted: "{{title}}"
tags: literature, to-read
year: {{year}}
authors:
  - {{authors}}
---
body`;
  const paper: PaperMetadata = {
    key: "K",
    citekey: "roth2023",
    title: 'A "quoted" \\ title: part',
    authors: ["Roth: A"],
    year: 2023,
    journal: null,
    doi: null,
    tags: [],
    collections: [],
    abstract: null,
  };
  const out = renderTemplate(template, paper);
  const lines = out.split("\n");
  assert.ok(lines.includes("citekey: roth2023"), out);
  assert.ok(lines.includes('title: "A \\"quoted\\" \\\\ title: part"'), out);
  assert.ok(lines.includes('quoted: "A \\"quoted\\" \\\\ title: part"'), out);
  assert.ok(lines.includes("tags: literature, to-read"), out);
  assert.ok(lines.includes("year: 2023"), out);
  assert.ok(lines.includes("  - Roth: A"), out);
});

test("L3c the Nunjucks notice shows once per session across separate calls sharing the session set", async () => {
  const vault = new FakeVault();
  vault.addFile("Zotero Template.md", "{% if x %}{{title}}{% endif %}");
  const notices: string[] = [];
  const sessionNotices = new Set<string>();
  const mk = (citekey: string): PaperMetadata =>
    ({ key: citekey, citekey, title: "T", authors: [], year: null, journal: null, doi: null, tags: [], collections: [], abstract: null }) as any;
  for (const k of ["a1", "a2", "a3"]) {
    await ensureLiteratureNote(vault, null, mk(k), { createLiteratureNotes: true }, { showNotice: (m) => notices.push(m), sessionNotices });
  }
  assert.strictEqual(notices.length, 1);
});

test("L3d the search modal passes the plugin's session notice set to ensureLiteratureNote", () => {
  const src = readFileSync(new URL("../src/modal.ts", import.meta.url), "utf8");
  const calls = src.split("ensureLiteratureNote(").slice(1);
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    const args = c.slice(0, c.indexOf(");"));
    assert.ok(args.includes("sessionNotices: this.plugin.litNoteNotices"), args);
  }
});

test("L3e create race on a case-insensitive disk returns the existing file found case-insensitively", async () => {
  class CaseInsensitiveRaceVault extends FakeVault {
    async create(filePath: string, content: string): Promise<any> {
      // Another tool wrote literature/ROTH2023.md just before us; the disk refuses our create.
      this.addFile("literature/ROTH2023.md", "Theirs");
      throw new Error(`File already exists: ${filePath}`);
    }
  }
  const vault = new CaseInsensitiveRaceVault();
  const paper = { key: "K", citekey: "roth2023", title: "T", authors: [], year: null, journal: null, doi: null, tags: [], collections: [], abstract: null } as any;
  const notices: string[] = [];
  const res = await ensureLiteratureNote(vault, null, paper, { createLiteratureNotes: true, literatureNoteFolder: "Literature" }, { showNotice: (m) => notices.push(m) });
  assert.strictEqual(res.created, false);
  assert.ok(res.file, "existing file returned");
  assert.strictEqual(res.file.content, "Theirs");
  assert.deepStrictEqual(notices, []);
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
