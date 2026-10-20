import test from "node:test";
import assert from "node:assert";
import {
  InlineSuggestController,
  refreshSuggestions,
  createPaperSearchSuggestClass,
  type SuggestionItem,
} from "../src/inline.ts";
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

const store = {
  isReady: () => true,
  getIndex: () => ({
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

/** Embedder whose requests resolve or fail only when the test says so. */
class DeferredEmbedder {
  calls: { query: string; resolve: (v: Float32Array | null) => void; reject: (e: Error) => void }[] = [];
  embedQuery(query: string): Promise<Float32Array | null> {
    return new Promise((resolve, reject) => this.calls.push({ query, resolve, reject }));
  }
}

/** Behaves like Obsidian's internal suggestion list: setSuggestions resets the selection to row 0. */
class ObsidianLikeSuggestions {
  values: SuggestionItem[] = [];
  selectedItem = 0;
  log: string[] = [];
  setSuggestions(items: SuggestionItem[]) {
    this.values = items;
    this.selectedItem = 0;
    this.log.push("setSuggestions:" + items.map((i) => i.paper?.citekey + (i.semanticOff ? "(off)" : "")).join(","));
  }
  setSelectedItem(i: number) {
    this.selectedItem = i;
    this.log.push("setSelectedItem:" + i);
  }
}

function setup() {
  const clock = new FakeClock();
  const embedder = new DeferredEmbedder();
  const suggestions = new ObsidianLikeSuggestions();
  const controller = new InlineSuggestController({
    indexStore: store as any,
    embedder,
    vault: new FakeVault() as any,
    settings: { createLiteratureNotes: false },
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });
  return { clock, embedder, suggestions, controller, suggest: { suggestions } };
}

const flush = () => new Promise((r) => setImmediate(r));

test("IR1 backspacing to a shorter query before the pause cancels the longer query's semantic run", async () => {
  const { clock, embedder, suggestions, controller, suggest } = setup();
  await controller.getSuggestions("stiff gels ", suggest);
  clock.advance(100);
  await controller.getSuggestions("stif", suggest); // below the semantic gate
  clock.advance(500);
  await flush();
  assert.deepStrictEqual(embedder.calls.map((c) => c.query), [], "no embed for an abandoned query");
  assert.deepStrictEqual(suggestions.log, []);
});

test("IR2 a response that arrives after the query changed is ignored, even below the gate", async () => {
  const { clock, embedder, suggestions, controller, suggest } = setup();
  await controller.getSuggestions("stiff gels ", suggest);
  clock.advance(260); // embed request in flight
  assert.strictEqual(embedder.calls.length, 1);
  await controller.getSuggestions("stif", suggest);
  embedder.calls[0].resolve(new Float32Array(4).fill(1));
  await flush();
  assert.deepStrictEqual(suggestions.log, []);
});

test("IR3 closing the list cancels both a pending timer and an in-flight request", async () => {
  const { clock, embedder, suggestions, controller, suggest } = setup();
  await controller.getSuggestions("stiff gels ", suggest);
  clock.advance(50);
  controller.cancel();
  clock.advance(500);
  assert.strictEqual(embedder.calls.length, 0, "timer cleared on close");

  await controller.getSuggestions("stiff gels ", suggest);
  clock.advance(260);
  controller.cancel();
  embedder.calls[0].resolve(new Float32Array(4).fill(1));
  await flush();
  assert.deepStrictEqual(suggestions.log, [], "in-flight result dropped after close");
});

test("IR4 a late failure of an older query does not overwrite the current list", async () => {
  const { clock, embedder, suggestions, controller, suggest } = setup();
  await controller.getSuggestions("stiff gel ", suggest);
  clock.advance(260); // request #1 in flight
  await controller.getSuggestions("stiff gels ", suggest);
  clock.advance(260); // request #2 in flight
  embedder.calls[1].resolve(new Float32Array(4).fill(1));
  await flush();
  assert.strictEqual(suggestions.log.filter((l) => l.startsWith("setSuggestions")).length, 1);
  embedder.calls[0].reject(new Error("timeout"));
  await flush();
  const sets = suggestions.log.filter((l) => l.startsWith("setSuggestions"));
  assert.strictEqual(sets.length, 1, "old failure must not apply its keyword list");
  assert.ok(!sets[0].includes("(off)"));
});

test("IR5 a failure of the CURRENT query still falls back to keyword results with semantic off", async () => {
  const { clock, embedder, suggestions, controller, suggest } = setup();
  await controller.getSuggestions("stiff gels ", suggest);
  clock.advance(260);
  embedder.calls[0].reject(new Error("Connection refused"));
  await flush();
  const sets = suggestions.log.filter((l) => l.startsWith("setSuggestions"));
  assert.strictEqual(sets.length, 1);
  assert.ok(sets[0].includes("(off)"));
});

test("IR6 selection is applied AFTER setSuggestions, so it survives Obsidian resetting it to row 0", () => {
  const suggestions = new ObsidianLikeSuggestions();
  const [a, b, c] = PAPERS.map((p) => ({ type: "paper", paper: p }) as SuggestionItem);
  suggestions.values = [a, b, c];
  suggestions.selectedItem = 1; // user is on b
  refreshSuggestions({ suggestions }, [c, a, b]);
  assert.strictEqual(suggestions.selectedItem, 2, "still on b");
  assert.deepStrictEqual(suggestions.log, ["setSuggestions:bauer2022,roth2023,lesavage2024", "setSelectedItem:2"]);
});

test("IR7 without setSelectedItem, the index is written after setSuggestions", () => {
  const values: SuggestionItem[] = PAPERS.map((p) => ({ type: "paper", paper: p }) as SuggestionItem);
  const s: any = {
    values,
    selectedItem: 1,
    setSuggestions(items: SuggestionItem[]) {
      this.values = items;
      this.selectedItem = 0;
    },
  };
  refreshSuggestions({ suggestions: s }, [values[2], values[0], values[1]]);
  assert.strictEqual(s.selectedItem, 2);
});

test("IR8 the EditorSuggest glue cancels the controller when Obsidian closes the list", () => {
  let baseClosed = 0;
  class FakeEditorSuggest {
    app: any;
    constructor(app: any) {
      this.app = app;
    }
    close() {
      baseClosed++;
    }
  }
  const Suggest = createPaperSearchSuggestClass(FakeEditorSuggest);
  let cancelled = 0;
  const instance: any = new Suggest({}, { cancel: () => cancelled++ } as any);
  instance.close();
  assert.strictEqual(cancelled, 1);
  assert.strictEqual(baseClosed, 1);
});
