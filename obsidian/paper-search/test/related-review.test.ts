// Medium findings from the 20 Oct review: related papers panel states.
import test from "node:test";
import assert from "node:assert";
import { RelatedPapersController, type RelatedEmbedderLike } from "../src/related.ts";
import { FakeVault, vectorScorer } from "./fakes.ts";
import { BM25Index, type PaperMetadata } from "../src/core/bm25.ts";

function paper(citekey: string, title: string): PaperMetadata {
  return { key: `KEY_${citekey}`, citekey, title, authors: ["Roth"], year: 2023, abstract: `Abstract ${title}`, journal: "J", doi: "", tags: [], collections: [] } as any;
}

class Store {
  ready = true;
  papers = [paper("Roth2023", "Stress relaxation in hydrogels"), paper("lesavage2024", "Stiffness and chemoresistance")];
  isReady() {
    return this.ready;
  }
  getIndex(): any {
    if (!this.ready) return null;
    return {
      papers: this.papers,
      chunks: [],
      bm25: new BM25Index(this.papers, []),
      vectors: new Float32Array(2 * 4).fill(1),
      dims: 4,
      totalRows: 2,
      rowToChunk: new Int32Array([-1, -1]),
      rowToPaper: new Int32Array([0, 1]),
      rowIsAbstract: new Uint8Array([1, 1]),
      paperAbstractRow: new Int32Array([0, 1]),
      paperChunkRows: [new Int32Array(0), new Int32Array(0)],
    };
  }
}

const NOTE = "This passage is long enough to search for related papers about hydrogel stiffness and relaxation.";

function make(opts: { embedder?: RelatedEmbedderLike; store?: Store; settings?: any } = {}) {
  const notices: string[] = [];
  let calls = 0;
  const controller = new RelatedPapersController({
    indexStore: opts.store ?? new Store(),
    embedder: opts.embedder ?? vectorScorer({
      async embedQuery() {
        calls++;
        return new Float32Array(4).fill(0.5);
      },
    }),
    vault: new FakeVault() as any,
    settings: { relatedMinScore: 0.1, ...opts.settings },
    showNotice: (m) => notices.push(m),
  });
  return { controller, notices, calls: () => calls };
}

test("RM1 switching notes during a refresh ends in the new note's empty state, not loading", async () => {
  let resolve!: (v: Float32Array) => void;
  const { controller } = make({
    embedder: vectorScorer({ embedQuery: () => new Promise<Float32Array>((r) => (resolve = r)) }),
  });
  const p = controller.refresh(NOTE, 10, "", "a.md");
  assert.strictEqual(controller.state, "loading");
  controller.onFileOpen({ path: "b.md" });
  resolve(new Float32Array(4).fill(1));
  await p;
  assert.strictEqual(controller.state, "empty");
});

test("RM2 with auto-refresh off, opening another note resets the panel to empty", async () => {
  const { controller } = make();
  await controller.refresh(NOTE, 10, "", "a.md");
  assert.strictEqual(controller.state, "results");
  controller.onFileOpen({ path: "b.md" });
  assert.strictEqual(controller.state, "empty");
  assert.strictEqual(controller.getDisplayItems().items.length, 0, "old results are not shown for the new note");
});

test("RM3 re-opening the same note keeps its results", async () => {
  const { controller } = make();
  await controller.refresh(NOTE, 10, "", "a.md");
  controller.onFileOpen({ path: "a.md" });
  assert.strictEqual(controller.state, "results");
});

test("RM4 index still loading -> loading state, no embed, no 'needs Ollama' notice spent", async () => {
  const store = new Store();
  store.ready = false;
  const { controller, notices, calls } = make({ store });
  await controller.refresh(NOTE, 10, "", "a.md");
  assert.strictEqual(controller.state, "index-loading");
  assert.strictEqual(calls(), 0);
  assert.deepStrictEqual(notices, []);
});

test("RM5 embedder returns null because the index vanished mid-refresh -> index-loading, notice not spent", async () => {
  const store = new Store();
  let first = true;
  const { controller, notices } = make({
    store,
    embedder: vectorScorer({
      async embedQuery() {
        if (first) store.ready = false; // only the first call races an index reload
        first = false;
        return null;
      },
    }),
  });
  await controller.refresh(NOTE, 10, "", "a.md");
  assert.strictEqual(controller.state, "index-loading");
  assert.deepStrictEqual(notices, []);
  // A real Ollama outage later still gets its one notice.
  store.ready = true;
  await controller.refresh(NOTE + " more", 10, "", "a.md");
  assert.strictEqual(controller.state, "needs-ollama");
  assert.strictEqual(notices.length, 1);
});

test("RM6 every result above the threshold already cited -> 'nothing-close', and show reveals them", async () => {
  const { controller } = make();
  await controller.refresh(NOTE + " [[Roth2023]] and [@lesavage2024]", 10, "", "a.md");
  assert.strictEqual(controller.state, "nothing-close");
  assert.strictEqual(controller.getDisplayItems().hiddenCount, 2);
  controller.toggleShowHidden();
  assert.strictEqual(controller.state, "results");
  assert.strictEqual(controller.getDisplayItems().items.length, 2);
  controller.toggleShowHidden();
  assert.strictEqual(controller.state, "nothing-close");
});

test("RM7 cited-key matching is case-insensitive both ways", async () => {
  const { controller } = make();
  // Library key is Roth2023, note cites roth2023; library key lesavage2024, note cites LeSavage2024.
  await controller.refresh(NOTE + " [[roth2023]] and [@LeSavage2024]", 10, "", "a.md");
  assert.strictEqual(controller.getDisplayItems().hiddenCount, 2);
});
