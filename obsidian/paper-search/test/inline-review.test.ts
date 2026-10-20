// Medium findings from the 20 Oct review: @@ inline suggest and cite.ts excluded contexts.
import test from "node:test";
import assert from "node:assert";
import {
  InlineSuggestController,
  createPaperSearchSuggestClass,
  type SuggestionItem,
  type FakeSuggestLike,
} from "../src/inline.ts";
import { isExcludedContext } from "../src/cite.ts";
import { BM25Index, type PaperMetadata } from "../src/bm25.ts";
import { FakeClock, FakeVault } from "./fakes.ts";

function paper(citekey: string, title: string): PaperMetadata {
  return { citekey, title, authors: ["Roth"], year: 2023, abstract: `About ${title}`, journal: "J", doi: "", tags: [], collections: [] } as any;
}

const PAPERS = [
  paper("roth2023", "Stiff gels relax stress in hydrogels"),
  paper("lesavage2024", "Stiffness drives chemoresistance in gels"),
  paper("bauer2022", "Synthetic gels for organoids"),
];

function makeStore() {
  const store = {
    contentHash: "h1",
    isReady: () => true,
    getIndex: () => ({
      manifest: { content_hash: store.contentHash },
      papers: PAPERS,
      chunks: [],
      bm25: new BM25Index(PAPERS, []),
      vectors: new Float32Array(3 * 4).fill(1),
      dims: 4,
      totalRows: 3,
      rowToChunk: new Int32Array([-1, -1, -1]),
      rowToPaper: new Int32Array([0, 1, 2]),
      rowIsAbstract: new Uint8Array([1, 1, 1]),
      paperAbstractRow: new Int32Array([0, 1, 2]),
      paperChunkRows: [new Int32Array(0), new Int32Array(0), new Int32Array(0)],
    }),
    getVectors: () => null,
    getDims: () => 4,
    getRowToChunk: () => null,
    getRowToPaper: () => null,
    getRowIsAbstract: () => null,
    getPaperChunkRows: () => null,
  };
  return store;
}

function setup(embedQuery: (q: string) => Promise<Float32Array | null>, settings: any = {}) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const store = makeStore();
  const controller = new InlineSuggestController({
    indexStore: store as any,
    embedder: {
      embedQuery: (q: string) => {
        calls.push(q);
        return embedQuery(q);
      },
    },
    vault: new FakeVault() as any,
    settings: { createLiteratureNotes: false, ...settings },
    showNotice: () => {},
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });
  return { clock, calls, controller, store };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function fakeEl() {
  const el: any = {
    children: [] as any[],
    text: "",
    className: "",
    empty() {
      this.children = [];
      this.text = "";
    },
    createDiv(opts: any) {
      const child = fakeEl();
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

function allClasses(el: any): string[] {
  return [el.className, ...el.children.flatMap((c: any) => allClasses(c))];
}

test("IM1 Tab is bound to insert the selected suggestion, like Enter", () => {
  const registered: { mods: string[]; key: string; fn: (evt: any) => any }[] = [];
  const used: any[] = [];
  class FakeEditorSuggest {
    app: any;
    scope = { register: (mods: string[], key: string, fn: any) => registered.push({ mods, key, fn }) };
    suggestions = { useSelectedItem: (evt: any) => used.push(evt) };
    constructor(app: any) {
      this.app = app;
    }
    close() {}
  }
  const Suggest = createPaperSearchSuggestClass(FakeEditorSuggest);
  new Suggest({}, {} as any);
  const tab = registered.find((r) => r.key === "Tab" && r.mods.length === 0);
  assert.ok(tab, "Tab handler registered");
  const evt = { key: "Tab" };
  const ret = tab!.fn(evt);
  assert.deepStrictEqual(used, [evt], "Tab uses the selected item");
  assert.strictEqual(ret, false, "Tab default (indent) is prevented");
});

test("IM2 semantic gate uses shouldRunSemantic: 'stiff g' does not embed, 'stiff gels ' does", async () => {
  const { clock, calls, controller } = setup(async () => new Float32Array(4).fill(1), { minCharsSemantic: 12 });
  await controller.getSuggestions("stiff g", {});
  clock.advance(300);
  await flush();
  assert.deepStrictEqual(calls, [], "only one complete token: no embed");

  await controller.getSuggestions("stiff gels ", {});
  clock.advance(300);
  await flush();
  assert.deepStrictEqual(calls, ["stiff gels "]);
});

test("IM3 minCharsSemantic setting is honoured", async () => {
  const { clock, calls, controller } = setup(async () => new Float32Array(4).fill(1), { minCharsSemantic: 5 });
  await controller.getSuggestions("hydro", {});
  clock.advance(300);
  await flush();
  assert.deepStrictEqual(calls, ["hydro"]);
});

test("IM4 Ollama-down results are not cached in the LRU fallback", async () => {
  const { clock, calls, controller } = setup(async () => null);
  const noSet: FakeSuggestLike = { suggestions: { values: [] } };
  await controller.getSuggestions("stiff gels relax", noSet);
  clock.advance(300);
  await flush();
  assert.strictEqual(controller.queryCache.has("stiff gels relax"), false);
  // A later query retries semantic search instead of serving keyword-only results forever.
  await controller.getSuggestions("stiff gels relax", noSet);
  clock.advance(300);
  await flush();
  assert.strictEqual(calls.length, 2);
});

test("IM5 a failed (thrown) embed is not cached either", async () => {
  const { clock, controller } = setup(async () => {
    throw new Error("down");
  });
  await controller.getSuggestions("stiff gels relax", { suggestions: { values: [] } });
  clock.advance(300);
  await flush();
  assert.strictEqual(controller.queryCache.size(), 0);
});

test("IM6 the LRU cache is cleared when the index content_hash changes", async () => {
  const { clock, controller, store } = setup(async () => new Float32Array(4).fill(1));
  const noSet: FakeSuggestLike = { suggestions: { values: [] } };
  await controller.getSuggestions("stiff gels relax", noSet);
  clock.advance(300);
  await flush();
  assert.ok(controller.queryCache.has("stiff gels relax"));
  store.contentHash = "h2";
  await controller.getSuggestions("other query", noSet);
  assert.strictEqual(controller.queryCache.has("stiff gels relax"), false);
});

test("IM7 'Semantic search unavailable' is a single footer row, not one per paper row", async () => {
  let latest: SuggestionItem[] = [];
  const { clock, controller } = setup(async () => null);
  await controller.getSuggestions("stiff gels relax", {
    suggestions: { setSuggestions: (items) => (latest = items), values: [] },
  });
  clock.advance(300);
  await flush();
  const papers = latest.filter((i) => i.type === "paper");
  assert.ok(papers.length > 0);
  let footers = 0;
  for (const item of latest) {
    const el = fakeEl();
    controller.renderSuggestion(item, el);
    footers += allClasses(el).filter((c) => c === "daito-suggest-footer").length;
  }
  assert.strictEqual(footers, 1);
  assert.strictEqual(latest[latest.length - 1].type, "footer", "footer is the last row");
});

test("IM8 choosing the footer row inserts nothing", async () => {
  const { controller } = setup(async () => null);
  let replaced = 0;
  await controller.selectSuggestion(
    { type: "footer", message: "Semantic search unavailable" } as SuggestionItem,
    { replaceRange: () => replaced++ },
    { start: { line: 0, ch: 0 }, end: { line: 0, ch: 2 } }
  );
  assert.strictEqual(replaced, 0);
});

test("IM9 title is cut at 80 characters including the ellipsis", () => {
  const { controller } = setup(async () => null);
  const el = fakeEl();
  controller.renderSuggestion({ type: "paper", paper: paper("x", "A".repeat(95)) }, el);
  const title = el.children[0].children.find((c: any) => c.className === "daito-suggest-title");
  assert.strictEqual(title.text.length, 80);
  assert.ok(title.text.endsWith("…"));
  const el2 = fakeEl();
  controller.renderSuggestion({ type: "paper", paper: paper("y", "B".repeat(80)) }, el2);
  const title2 = el2.children[0].children.find((c: any) => c.className === "daito-suggest-title");
  assert.strictEqual(title2.text, "B".repeat(80), "exactly 80 is not cut");
});

test("IM10 closed inline-code spans hide $, [[ and backticks", () => {
  assert.strictEqual(isExcludedContext([], 0, "set `$PATH` then @@stiff", 24), false);
  assert.strictEqual(isExcludedContext([], 0, "see `[[x` then @@stiff", 22), false);
  assert.strictEqual(isExcludedContext([], 0, "code ``a ` b`` then @@stiff", 27), false);
  // Still excluded while inside an open double-backtick span
  assert.strictEqual(isExcludedContext([], 0, "code ``a ` @@stiff", 18), true);
});

test("IM11 $ followed by a digit is currency, not inline math", () => {
  assert.strictEqual(isExcludedContext([], 0, "costs $5 for @@stiff", 20), false);
  assert.strictEqual(isExcludedContext([], 0, "from $5 to $10 @@stiff", 22), false);
  // Real inline math still excluded
  assert.strictEqual(isExcludedContext([], 0, "value $a@@b$ end", 10), true);
  assert.strictEqual(isExcludedContext([], 0, "costs $5 and $x + @@y", 21), true);
});

test("IM12 onTrigger calls findTrigger before isExcludedContext (sections untouched without a trigger)", () => {
  const { controller } = setup(async () => null);
  let touched = 0;
  const sections = new Proxy([{ type: "paragraph", position: { start: { line: 0 }, end: { line: 0 } } }], {
    get(target, prop, recv) {
      touched++;
      return Reflect.get(target, prop, recv);
    },
  });
  assert.strictEqual(controller.onTrigger({ line: 0, ch: 10 }, "plain text here", sections), null);
  assert.strictEqual(touched, 0);
});
