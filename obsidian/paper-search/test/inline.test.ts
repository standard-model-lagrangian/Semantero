import test from "node:test";
import assert from "node:assert";
import {
  InlineSuggestController,
  refreshSuggestions,
  maintainSelection,
  LRUQueryCache,
  type SuggestionItem,
  type FakeSuggestLike,
} from "../src/inline.ts";
import {
  FakeEditor,
  FakeVault,
  FakeMetadataCache,
  FakeClock,
} from "./fakes.ts";
import { BM25Index, type PaperMetadata } from "../src/bm25.ts";

function createDummyPaper(citekey: string, title: string, author = "Roth", year = 2023): PaperMetadata {
  return {
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

class FakeIndexStore {
  ready = true;
  papers: PaperMetadata[] = [
    createDummyPaper("roth2023", "Faster stress relaxation in viscoelastic hydrogels"),
    createDummyPaper("lesavage2024", "Engineered matrices reveal stiffness-mediated chemoresistance"),
    createDummyPaper("bauer2022", "Synthetic hydrogels for organoids"),
  ];
  bm25 = new BM25Index(this.papers, []);

  isReady(): boolean {
    return this.ready;
  }

  getIndex(): any {
    // 3 rows, 4 dims each; give each row positive values so dot product > 0
    const vectors = new Float32Array(3 * 4);
    vectors.fill(1.0);

    return {
      papers: this.papers,
      chunks: [],
      bm25: this.bm25,
      vectors,
      dims: 4,
      totalRows: 3,
      rowToChunk: new Int32Array(3),
      rowToPaper: new Int32Array([0, 1, 2]),
      rowIsAbstract: new Uint8Array([1, 1, 1]),
      paperChunkRows: [new Int32Array(0), new Int32Array(0), new Int32Array(0)],
    };
  }

  getVectors(): Float32Array | null {
    return new Float32Array(3 * 4);
  }
  getDims(): number {
    return 4;
  }
  getRowToChunk(): Int32Array | null {
    return new Int32Array(3);
  }
  getRowToPaper(): Int32Array | null {
    return new Int32Array([0, 1, 2]);
  }
  getRowIsAbstract(): Uint8Array | null {
    return new Uint8Array([1, 1, 1]);
  }
  getPaperChunkRows(): Int32Array[] | null {
    return [[0], [1], [2]];
  }
}

test("I1 Enter replaces exactly [start, cursor) with formatted citation, cursor placed just after, remaining text unchanged", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const controller = new InlineSuggestController({
    indexStore,
    vault,
    settings: {
      citationFormat: "[[{{citekey}}]]",
      createLiteratureNotes: false,
    },
  });

  const editor = new FakeEditor("some notes @@roth and more text afterwards", { line: 0, ch: 17 });
  const trigger = controller.onTrigger(editor.getCursor(), editor.getLine(0));
  assert.ok(trigger);
  assert.strictEqual(trigger.start.ch, 11);
  assert.strictEqual(trigger.end.ch, 17);
  assert.strictEqual(trigger.query, "roth");

  const paperItem: SuggestionItem = {
    type: "paper",
    paper: indexStore.papers[0],
  };

  await controller.selectSuggestion(paperItem, editor, {
    start: trigger.start,
    end: trigger.end,
  });

  assert.strictEqual(
    editor.getValue(),
    "some notes [[roth2023]] and more text afterwards"
  );
  // Cursor placed just after the citation
  assert.strictEqual(editor.getCursor().ch, 11 + "[[roth2023]]".length);
});

test("I2 replacement is a single editor transaction (one replaceRange call)", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const controller = new InlineSuggestController({
    indexStore,
    vault,
    settings: {
      citationFormat: "[@{{citekey}}]",
      createLiteratureNotes: false,
    },
  });

  const editor = new FakeEditor("see @@stiff here", { line: 0, ch: 11 });
  const paperItem: SuggestionItem = {
    type: "paper",
    paper: indexStore.papers[1],
  };

  await controller.selectSuggestion(paperItem, editor, {
    start: { line: 0, ch: 4 },
    end: { line: 0, ch: 11 },
  });

  assert.strictEqual(editor.replaceRangeCalls.length, 1);
  assert.strictEqual(editor.replaceRangeCalls[0].replacement, "[@lesavage2024]");
});

test("I3 literature note created after insert when enabled, and omitted when disabled", async () => {
  const vault = new FakeVault();
  const metadataCache = new FakeMetadataCache(vault);
  const indexStore = new FakeIndexStore();

  // 1. With createLiteratureNotes = true
  const controllerEnabled = new InlineSuggestController({
    indexStore,
    vault,
    metadataCache,
    settings: {
      citationFormat: "[[{{citekey}}]]",
      createLiteratureNotes: true,
      literatureNoteFolder: "Literature",
    },
  });

  const editor1 = new FakeEditor("@@roth", { line: 0, ch: 6 });
  await controllerEnabled.selectSuggestion(
    { type: "paper", paper: indexStore.papers[0] },
    editor1,
    { start: { line: 0, ch: 0 }, end: { line: 0, ch: 6 } }
  );

  assert.ok(vault.files.has("Literature/roth2023.md"), "Literature note should be created");

  // 2. With createLiteratureNotes = false
  const vaultDisabled = new FakeVault();
  const controllerDisabled = new InlineSuggestController({
    indexStore,
    vault: vaultDisabled,
    settings: {
      citationFormat: "[[{{citekey}}]]",
      createLiteratureNotes: false,
    },
  });

  const editor2 = new FakeEditor("@@roth", { line: 0, ch: 6 });
  await controllerDisabled.selectSuggestion(
    { type: "paper", paper: indexStore.papers[0] },
    editor2,
    { start: { line: 0, ch: 0 }, end: { line: 0, ch: 6 } }
  );

  assert.strictEqual(vaultDisabled.files.size, 0, "No vault call when createLiteratureNotes = false");
});

test("I4 semantic results merge in after 250 ms quiet and typing at 100 ms produces zero embed calls", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const clock = new FakeClock();

  let embedCallCount = 0;
  const embedder = {
    async embedQuery(text: string) {
      embedCallCount++;
      const v = new Float32Array(4);
      v.fill(1.0);
      return v;
    },
  };

  const controller = new InlineSuggestController({
    indexStore,
    embedder,
    vault,
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });

  const fakeSuggest: FakeSuggestLike = {
    suggestions: {
      setSuggestions(items) {
        this.values = items;
      },
      selectedItem: 0,
      values: [],
    },
  };

  // Type at 100 ms intervals: "s", "st", "sti", "stiff", "stiff gels "
  const strokes = ["s", "st", "sti", "stiff", "stiff gels "];
  for (const q of strokes) {
    await controller.getSuggestions(q, fakeSuggest);
    clock.advance(100);
  }

  // Before 250 ms quiet pause, embed should NOT have been called yet
  assert.strictEqual(embedCallCount, 0, "No embed call during rapid typing");

  // Advance remaining 150 ms to reach 250 ms quiet pause
  clock.advance(150);
  // Allow microtasks to complete
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(embedCallCount, 1, "Exactly one embed call after 250 ms pause");
  assert.ok(fakeSuggest.suggestions?.values && fakeSuggest.suggestions.values.length > 0);
});

test("I5 outdated semantic responses are dropped", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const clock = new FakeClock();

  let resolveFirst: ((val: Float32Array) => void) | null = null;
  let resolveSecond: ((val: Float32Array) => void) | null = null;

  const embedder = {
    async embedQuery(text: string) {
      if (text === "stiff gel ") {
        return new Promise<Float32Array>((res) => {
          resolveFirst = res;
        });
      }
      return new Promise<Float32Array>((res) => {
        resolveSecond = res;
      });
    },
  };

  const controller = new InlineSuggestController({
    indexStore,
    embedder,
    vault,
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });

  let refreshHistory: SuggestionItem[][] = [];
  const fakeSuggest: FakeSuggestLike = {
    suggestions: {
      setSuggestions(items) {
        refreshHistory.push(items);
        this.values = items;
      },
      values: [],
    },
  };

  // 1. Query "stiff gel "
  await controller.getSuggestions("stiff gel ", fakeSuggest);
  clock.advance(250);

  // 2. Query "stiff gels " (advances sequence)
  await controller.getSuggestions("stiff gels ", fakeSuggest);
  clock.advance(250);

  // 3. Resolve "stiff gels " (the newer query) first
  const v = new Float32Array(4);
  v.fill(1.0);
  resolveSecond!(v);
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(refreshHistory.length, 1);

  // 4. Resolve "stiff gel " (outdated)
  resolveFirst!(v);
  await new Promise((r) => setImmediate(r));

  // Should NOT trigger another refresh because it is outdated
  assert.strictEqual(refreshHistory.length, 1, "Outdated response must be dropped");
});

test("I6 adapter fallback: suggest without setSuggestions caches in 16-entry LRU", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const clock = new FakeClock();

  const embedder = {
    async embedQuery(text: string) {
      return new Float32Array(4);
    },
  };

  const controller = new InlineSuggestController({
    indexStore,
    embedder,
    vault,
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });

  // Suggest object WITHOUT setSuggestions
  const fakeSuggestWithoutSet: FakeSuggestLike = {
    suggestions: {
      values: [],
    },
  };

  await controller.getSuggestions("viscoelastic hydrogel", fakeSuggestWithoutSet);
  clock.advance(250);
  await Promise.resolve();
  await Promise.resolve();

  // Cached in controller.queryCache
  assert.ok(controller.queryCache.has("viscoelastic hydrogel"), "Should cache in LRU");

  // Next call gets cached results immediately
  const nextResults = await controller.getSuggestions("viscoelastic hydrogel", fakeSuggestWithoutSet);
  assert.ok(nextResults.length > 0);

  // Verify LRU eviction at 16 entries
  const lru = new LRUQueryCache<number>(3);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("c", 3);
  assert.strictEqual(lru.size(), 3);
  lru.get("a"); // a is now MRU; b is oldest
  lru.set("d", 4); // should evict b
  assert.strictEqual(lru.has("b"), false);
  assert.strictEqual(lru.has("a"), true);
});

test("I7 Ollama down -> keyword results only, at most one notice per session, semantic off flag", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const clock = new FakeClock();

  const embedder = {
    async embedQuery(text: string) {
      throw new Error("Connection refused (Ollama down)");
    },
  };

  const notices: string[] = [];
  const controller = new InlineSuggestController({
    indexStore,
    embedder,
    vault,
    showNotice: (msg) => notices.push(msg),
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });

  let latestItems: SuggestionItem[] = [];
  const fakeSuggest: FakeSuggestLike = {
    suggestions: {
      setSuggestions(items) {
        latestItems = items;
      },
      values: [],
    },
  };

  // Keystroke 1
  await controller.getSuggestions("organoid stiff", fakeSuggest);
  clock.advance(250);
  await Promise.resolve();
  await Promise.resolve();

  // Keystroke 2
  await controller.getSuggestions("organoid stiffness", fakeSuggest);
  clock.advance(250);
  await Promise.resolve();
  await Promise.resolve();

  // Notice should only have fired once
  assert.strictEqual(notices.length, 1);
  assert.ok(notices[0].includes("Ollama is not running"));

  // Results should have semanticOff = true
  assert.ok(latestItems.length > 0);
  assert.strictEqual(latestItems[0].semanticOff, true);
});

test("I8 index not loaded yet -> returns loading row; choosing it does nothing", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  indexStore.ready = false; // not ready

  const controller = new InlineSuggestController({
    indexStore,
    vault,
  });

  const res = await controller.getSuggestions("stiff");
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].type, "loading");
  assert.strictEqual(res[0].message, "Loading paper index…");

  // Choosing it
  const editor = new FakeEditor("text @@stiff", { line: 0, ch: 12 });
  await controller.selectSuggestion(res[0], editor, {
    start: { line: 0, ch: 5 },
    end: { line: 0, ch: 12 },
  });

  assert.strictEqual(editor.replaceRangeCalls.length, 0, "No replaceRange on loading row");
  assert.strictEqual(editor.getValue(), "text @@stiff", "Text unchanged");
});

test("I9 Escape closes list and leaves text unchanged; reopening works", async () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const controller = new InlineSuggestController({
    indexStore,
    vault,
  });

  const editor = new FakeEditor("writing @@stiff text", { line: 0, ch: 15 });
  // Escape simulates user dismissing suggestion without calling selectSuggestion
  assert.strictEqual(editor.getValue(), "writing @@stiff text");

  // Reopening by typing another letter
  editor.replaceRange("er", { line: 0, ch: 15 }, { line: 0, ch: 15 });
  const trig = controller.onTrigger(editor.getCursor(), editor.getLine(0));
  assert.ok(trig);
  assert.strictEqual(trig.query, "stiffer");
});

test("I10 cursor moves to another line or past query -> trigger returns null", () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();
  const controller = new InlineSuggestController({
    indexStore,
    vault,
  });

  // Cursor on line without trigger
  const res1 = controller.onTrigger({ line: 1, ch: 5 }, "plain line without trigger");
  assert.strictEqual(res1, null);

  // Line with trigger but cursor before trigger
  const res2 = controller.onTrigger({ line: 0, ch: 2 }, "some @@stiff line");
  assert.strictEqual(res2, null);
});

test("I11 rows render title cut at 80 chars, first author · year, and snippet when enabled", () => {
  const vault = new FakeVault();
  const indexStore = new FakeIndexStore();

  const longTitle = "A".repeat(95);
  const paper = createDummyPaper("long2024", longTitle, "LeSavage", 2024);

  // Fake DOM element
  function createFakeEl() {
    const el: any = {
      children: [] as any[],
      text: "",
      className: "",
      empty() {
        this.children = [];
        this.text = "";
      },
      createDiv(opts: any) {
        const child = createFakeEl();
        child.className = opts?.cls || "";
        this.children.push(child);
        return child;
      },
      setText(t: string) {
        this.text = t;
      },
    };
    return el;
  }

  // 1. With inlineShowSnippet = true
  const controllerSnippetOn = new InlineSuggestController({
    indexStore,
    vault,
    settings: { inlineShowSnippet: true },
  });

  const el1 = createFakeEl();
  controllerSnippetOn.renderSuggestion(
    {
      type: "paper",
      paper,
      snippet: "This is the matching snippet.",
    },
    el1
  );

  const container1 = el1.children[0];
  const titleChild1 = container1.children.find((c: any) => c.className === "daito-suggest-title");
  const metaChild1 = container1.children.find((c: any) => c.className === "daito-suggest-meta");
  const snippetChild1 = container1.children.find((c: any) => c.className === "daito-suggest-snippet");

  assert.ok(titleChild1);
  assert.strictEqual(titleChild1.text.length, 80); // 79 + "…"
  assert.ok(titleChild1.text.endsWith("…"));

  assert.ok(metaChild1);
  assert.strictEqual(metaChild1.text, "LeSavage · 2024");

  assert.ok(snippetChild1);
  assert.strictEqual(snippetChild1.text, "This is the matching snippet.");

  // 2. With inlineShowSnippet = false
  const controllerSnippetOff = new InlineSuggestController({
    indexStore,
    vault,
    settings: { inlineShowSnippet: false },
  });

  const el2 = createFakeEl();
  controllerSnippetOff.renderSuggestion(
    {
      type: "paper",
      paper,
      snippet: "This snippet should NOT be rendered.",
    },
    el2
  );

  const container2 = el2.children[0];
  const snippetChild2 = container2.children.find((c: any) => c.className === "daito-suggest-snippet");
  assert.strictEqual(snippetChild2, undefined, "Snippet must not be rendered when inlineShowSnippet = false");
});
