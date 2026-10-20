import test from "node:test";
import assert from "node:assert";
import {
  RelatedPapersController,
  type RelatedEmbedderLike,
  type RelatedIndexStoreLike,
} from "../src/related.ts";
import {
  FakeEditor,
  FakeVault,
  FakeMetadataCache,
  FakeClock,
} from "./fakes.ts";
import { BM25Index, type PaperMetadata } from "../src/bm25.ts";

function createDummyPaper(citekey: string, title: string, author = "Roth", year = 2023): PaperMetadata {
  return {
    key: `KEY_${citekey}`,
    citekey,
    title,
    authors: [author],
    year,
    abstract: `Abstract for ${citekey}`,
    journal: "Nature",
    doi: "10.1038/example",
    source: "zotero",
    path: `storage/${citekey}.pdf`,
    tags: [],
    collections: [],
  };
}

class FakeRelatedIndexStore implements RelatedIndexStoreLike {
  papers: PaperMetadata[] = [
    createDummyPaper("roth2023", "Faster stress relaxation in viscoelastic hydrogels"),
    createDummyPaper("lesavage2024", "Engineered matrices reveal stiffness-mediated chemoresistance"),
    createDummyPaper("bauer2022", "Synthetic hydrogels for organoids"),
    createDummyPaper("wang2021", "Cell ratio control with synthetic circuits"),
    createDummyPaper("kim2020", "Extracellular matrix stiffness"),
  ];

  isReady(): boolean {
    return true;
  }

  getIndex(): any {
    // 5 rows, 4 dims each
    const vectors = new Float32Array(5 * 4);
    // Give each row distinctive values
    for (let i = 0; i < 5; i++) {
      vectors[i * 4 + (i % 4)] = 1.0;
    }

    return {
      papers: this.papers,
      chunks: [],
      bm25: new BM25Index(this.papers, []),
      vectors,
      dims: 4,
      totalRows: 5,
      rowToChunk: new Int32Array(5),
      rowToPaper: new Int32Array([0, 1, 2, 3, 4]),
      rowIsAbstract: new Uint8Array([1, 1, 1, 1, 1]),
      paperChunkRows: [new Int32Array(0), new Int32Array(0), new Int32Array(0), new Int32Array(0), new Int32Array(0)],
    };
  }
}

test("P1 refresh embeds passage once with instruction, limits results, hides cited papers, shows count, toggle reveals them", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();

  let embedCalls: { text: string; instruction?: string }[] = [];
  const embedder: RelatedEmbedderLike = {
    async embedQuery(text: string, instruction?: string) {
      embedCalls.push({ text, instruction });
      const vec = new Float32Array(4);
      vec.fill(1.0); // matches all
      return vec;
    },
  };

  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
    settings: {
      relatedLimit: 3,
      relatedMinScore: 0.1,
      relatedInstruction: "Custom instruction for testing",
    },
  });

  // Note text contains citation of roth2023
  const noteText = `Here is our detailed research note describing hydrogel stiffness.
We have cited [[roth2023]] in our work.
The viscoelastic relaxation rate impacts cellular maturation in 3D hydrogel matrices significantly.`;

  await controller.refresh(noteText, 50, "", "notes/test.md");

  // Embedded once with instruction
  assert.strictEqual(embedCalls.length, 1);
  assert.strictEqual(embedCalls[0].instruction, "Custom instruction for testing");

  assert.strictEqual(controller.state, "results");

  // Get display items
  const { items, hiddenCount, showHidden } = controller.getDisplayItems();
  assert.strictEqual(showHidden, false);
  // roth2023 should be hidden because it was cited
  assert.ok(hiddenCount >= 1);
  assert.ok(items.every((it) => it.paper.citekey !== "roth2023"));
  assert.ok(items.length <= 3, "Should respect relatedLimit = 3");

  // Toggle reveal
  controller.toggleShowHidden();
  const revealed = controller.getDisplayItems();
  assert.strictEqual(revealed.showHidden, true);
  assert.ok(revealed.items.some((it) => it.paper.citekey === "roth2023"));
});

test("P2 below relatedMinScore -> Nothing close state, not weak results", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();

  const embedder: RelatedEmbedderLike = {
    async embedQuery(text: string) {
      // Return vector that gives zero or very low score
      return new Float32Array(4); // all 0 dot products
    },
  };

  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
    settings: {
      relatedMinScore: 0.5,
    },
  });

  const noteText = "Viscoelastic matrix stiffness in organoids with enough length to be a valid passage.";
  await controller.refresh(noteText, 20, "", "notes/test.md");

  assert.strictEqual(controller.state, "nothing-close");
});

test("P3 switching notes mid-refresh -> result discarded, shows new note empty state", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();

  let resolveEmbed: ((v: Float32Array) => void) | null = null;
  const embedder: RelatedEmbedderLike = {
    async embedQuery() {
      return new Promise<Float32Array>((res) => {
        resolveEmbed = res;
      });
    },
  };

  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
  });

  const noteText1 = "Passage for note 1 with sufficient characters describing hydrogel matrices.";
  // Start refresh on note 1
  controller.activeFilePath = "notes/note1.md";
  const refreshPromise = controller.refresh(noteText1, 10, "", "notes/note1.md");
  assert.strictEqual(controller.state, "loading");

  // Switch to note 2
  controller.onFileOpen({ path: "notes/note2.md" });

  // Now resolve the embed from note 1
  const vec = new Float32Array(4);
  vec.fill(1.0);
  resolveEmbed!(vec);
  await refreshPromise;

  // Should NOT update to results for note 1
  assert.notStrictEqual(controller.state, "results");
  assert.strictEqual(controller.lastRefreshedPath, "");
});

test("P4 two quick refreshes -> only the last renders, first request ignored", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();

  let resolveFirst: ((v: Float32Array) => void) | null = null;
  let resolveSecond: ((v: Float32Array) => void) | null = null;

  let callCount = 0;
  const embedder: RelatedEmbedderLike = {
    async embedQuery() {
      callCount++;
      if (callCount === 1) {
        return new Promise<Float32Array>((res) => {
          resolveFirst = res;
        });
      }
      return new Promise<Float32Array>((res) => {
        resolveSecond = res;
      });
    },
  };

  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
    settings: { relatedMinScore: 0.1 },
  });

  controller.activeFilePath = "notes/test.md";

  // Refresh 1
  const p1 = controller.refresh("Passage 1 with plenty of characters to qualify as a valid section.", 10, "", "notes/test.md");
  // Refresh 2 quickly
  const p2 = controller.refresh("Passage 2 with plenty of characters to qualify as a valid section.", 10, "", "notes/test.md");

  // Resolve second first
  const vec = new Float32Array(4);
  vec.fill(1.0);
  resolveSecond!(vec);
  await p2;

  assert.strictEqual(controller.state, "results");
  assert.ok(controller.lastRefreshedPassage.includes("Passage 2"));

  // Resolve first later
  resolveFirst!(vec);
  await p1;

  // Stays on Passage 2
  assert.ok(controller.lastRefreshedPassage.includes("Passage 2"));
});

test("P5 auto-refresh off (default) -> opening files triggers ZERO embed calls across 20 file switches", () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();

  let embedCallCount = 0;
  const embedder: RelatedEmbedderLike = {
    async embedQuery() {
      embedCallCount++;
      return new Float32Array(4);
    },
  };

  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
    settings: {
      relatedAutoRefresh: false, // default
    },
  });

  for (let i = 0; i < 20; i++) {
    controller.onFileOpen({ path: `notes/file_${i}.md` }, () => "Some text in note");
  }

  assert.strictEqual(embedCallCount, 0, "Zero embed calls when relatedAutoRefresh is false");
});

test("P6 auto-refresh on -> refreshes 1s after last switch, reopening same file+passage gives no new call", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();
  const clock = new FakeClock();

  let embedCallCount = 0;
  const embedder: RelatedEmbedderLike = {
    async embedQuery() {
      embedCallCount++;
      const v = new Float32Array(4);
      v.fill(1.0);
      return v;
    },
  };

  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
    settings: {
      relatedAutoRefresh: true,
      relatedMinScore: 0.1,
    },
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });

  const noteText = "A full research note discussing viscoelasticity and matrix hydrogel mechanics in detail.";

  // Switch file 1, 2, 3 rapidly
  controller.onFileOpen({ path: "notes/f1.md" }, () => noteText);
  clock.advance(200);
  controller.onFileOpen({ path: "notes/f2.md" }, () => noteText);
  clock.advance(200);
  controller.onFileOpen({ path: "notes/f3.md" }, () => noteText);

  // Before 1s quiet pause
  assert.strictEqual(embedCallCount, 0);

  // Advance 1s
  clock.advance(1000);
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(embedCallCount, 1, "Exactly one embed call 1s after last file switch");
  assert.strictEqual(controller.state, "results");

  // Reopening same file with same passage
  controller.onFileOpen({ path: "notes/f3.md" }, () => noteText);
  clock.advance(1000);
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(embedCallCount, 1, "Reopening same file with same passage gives NO new embed call");
});

test("P7 actions: cite inserts into editor or clipboard; note opens/creates; clicking row generates PDF url", async () => {
  const vault = new FakeVault();
  const metadataCache = new FakeMetadataCache(vault);
  const indexStore = new FakeRelatedIndexStore();

  const notices: string[] = [];
  const controller = new RelatedPapersController({
    indexStore,
    embedder: { async embedQuery() { return new Float32Array(4); } },
    vault,
    metadataCache,
    settings: {
      citationFormat: "[[{{citekey}}]]",
      createLiteratureNotes: true,
    },
    showNotice: (msg) => notices.push(msg),
  });

  const paper = indexStore.papers[0];

  // 1. Cite with active editor
  const editor = new FakeEditor("some text at cursor ", { line: 0, ch: 20 });
  await controller.handleCiteAction(paper, editor, null);
  assert.strictEqual(editor.getValue(), "some text at cursor [[roth2023]]");
  assert.ok(vault.files.has("roth2023.md"), "Literature note created");

  // 2. Cite without active editor -> clipboard + notice
  let clipboardText = "";
  const clipboard = {
    async writeText(t: string) {
      clipboardText = t;
    },
  };
  await controller.handleCiteAction(paper, null, clipboard);
  assert.strictEqual(clipboardText, "[[roth2023]]");
  assert.ok(notices.some((n) => n.includes("Copied citation to clipboard")));

  // 3. Note opens or creates
  let openedFilePath = "";
  const workspace = {
    async openFile(f: any) {
      openedFilePath = f.path;
    },
  };
  await controller.handleNoteAction(indexStore.papers[1], workspace);
  assert.strictEqual(openedFilePath, "lesavage2024.md");

  // 4. PDF url
  const hit = {
    paper: 0,
    score: 1.0,
    source: "semantic" as const,
    snippet: "snippet",
    page: 5,
    fromAbstract: false,
  };
  const url = controller.getPdfUrl(paper, hit);
  assert.strictEqual(url, "zotero://open-pdf/0_KEY_roth2023/5");
});

test("P8 Ollama down -> needs Ollama state and at most one notice per session", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeRelatedIndexStore();

  const embedder: RelatedEmbedderLike = {
    async embedQuery() {
      throw new Error("Connection refused");
    },
  };

  const notices: string[] = [];
  const controller = new RelatedPapersController({
    indexStore,
    embedder,
    vault,
    showNotice: (msg) => notices.push(msg),
  });

  const noteText = "Some research passage with enough characters describing viscoelastic hydrogels.";

  // Refresh 1
  await controller.refresh(noteText, 10, "", "notes/n1.md");
  assert.strictEqual(controller.state, "needs-ollama");

  // Refresh 2
  await controller.refresh(noteText, 10, "", "notes/n2.md");
  assert.strictEqual(controller.state, "needs-ollama");

  // Notice should have fired at most once
  assert.strictEqual(notices.length, 1);
  assert.ok(notices[0].includes("Ollama is not running"));
});
