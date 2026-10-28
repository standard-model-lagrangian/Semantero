import test from "node:test";
import assert from "node:assert";
import {
  ModalSearchController,
  chooserView,
  type ModalListView,
  type ModalSearchItem,
  type ModalSearchSettings,
} from "../src/modalsearch.ts";
import { BM25Index, type PaperMetadata } from "../src/core/bm25.ts";
import type { LoadedIndex } from "../src/core/engine.ts";
import { FakeClock, FakeVault, flushPromises } from "./fakes.ts";

function paper(key: string, title: string): PaperMetadata {
  return {
    key, citekey: key.toLowerCase(), title, authors: ["Roth"], year: 2023, abstract: `About ${title}`,
    journal: "J", doi: null, tags: [], collections: [],
  };
}

const PAPERS = [
  paper("ROTH2023", "Stiff gels relax stress in hydrogels"),
  paper("LESA2024", "Stiffness drives chemoresistance in gels"),
  paper("BAUE2022", "Synthetic gels for organoids"),
];

function makeIndex(manifest: Record<string, unknown> = {}): LoadedIndex {
  return {
    manifest: { model: "m", content_hash: "h1", ...manifest },
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
  };
}

/** A semantic scorer whose replies arrive only when the test says so. */
class DeferredScorer {
  calls: { text: string; resolve: (v: ArrayLike<number> | null) => void; reject: (e: Error) => void }[] = [];
  scores = (_ix: LoadedIndex, text: string): Promise<ArrayLike<number> | null> =>
    new Promise((resolve, reject) => this.calls.push({ text, resolve, reject }));
  last() {
    const c = this.calls[this.calls.length - 1];
    assert.ok(c, "no semantic request was sent");
    return c;
  }
}

/** Zotero's local API, answering each lookup when the test says so. */
class DeferredZotero {
  calls: { query: string; resolve: (v: PaperMetadata[]) => void }[] = [];
  search = (query: string, _known: Set<string>): Promise<PaperMetadata[]> =>
    new Promise((resolve) => this.calls.push({ query, resolve }));
}

/** The list on screen, as Obsidian's chooser shows it. */
class FakeView implements ModalListView {
  items: ModalSearchItem[] = [];
  selected = 0;
  footer = "";
  log: string[] = [];
  setSuggestions(items: ModalSearchItem[], selected: number): void {
    this.items = items;
    this.selected = selected;
    this.log.push(keys(items).join(","));
  }
  selectedIndex(): number {
    return this.selected;
  }
  setFooter(msg: string): void {
    this.footer = msg;
  }
}

const SETTINGS: ModalSearchSettings = { limit: 12, debounceMs: 200, minCharsSemantic: 12 };

function setup(opts: { index?: LoadedIndex | null; ready?: boolean } = {}) {
  const clock = new FakeClock();
  const scorer = new DeferredScorer();
  const zotero = new DeferredZotero();
  const view = new FakeView();
  let index = opts.index === undefined ? makeIndex() : opts.index;
  const ready = opts.ready ?? true;
  const controller = new ModalSearchController({
    indexStore: { isReady: () => ready, getIndex: () => index },
    semanticScores: scorer.scores,
    zotero,
    settings: SETTINGS,
    view,
    vault: new FakeVault(),
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });
  /** What Obsidian does with the returned list: show it, selecting the first row. */
  const type = (q: string) => {
    const items = controller.getSuggestions(q);
    if (items !== view.items) {
      view.items = items;
      view.selected = 0;
    }
    return items;
  };
  return { clock, scorer, zotero, view, controller, type, setIndex: (ix: LoadedIndex) => (index = ix) };
}

function keys(items: ModalSearchItem[]): string[] {
  return items.map((it) => it.livePaper ? `live:${it.livePaper.key}` : it.hit ? PAPERS[it.hit.paper].key : "?");
}


/** Scores that rank the papers in this order (row i is paper i's abstract). */
function scoresRanking(...order: number[]): Float64Array {
  const s = new Float64Array(3);
  order.forEach((p, i) => (s[p] = 0.9 - i * 0.2));
  return s;
}

test("MS1 keyword results come back at once; the semantic merge and the Zotero lookup wait for the debounce", () => {
  const { clock, scorer, zotero, type } = setup();
  const items = type("stiff gels relax");
  assert.ok(items.length > 0);
  assert.ok(items.every((it) => it.hit && it.paperIndex === it.hit.paper));
  assert.strictEqual(scorer.calls.length, 0);
  assert.strictEqual(zotero.calls.length, 0);
  clock.advance(SETTINGS.debounceMs);
  assert.strictEqual(scorer.calls.length, 1);
  assert.strictEqual(scorer.last().text, "stiff gels relax");
  assert.strictEqual(zotero.calls.length, 1);
});

test("MS2 stale-query race: a reply for a query you shortened below the semantic threshold never replaces the list", async () => {
  const { clock, scorer, view, type } = setup();
  type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs); // the long query's semantic request is now in flight
  const short = type("bauer"); // too short for semantic: schedules no merge of its own
  clock.advance(1000);
  assert.strictEqual(scorer.calls.length, 1, "the short query sends no semantic request");
  scorer.calls[0].resolve(scoresRanking(1, 0, 2));
  await flushPromises();
  assert.deepStrictEqual(view.log, [], "the late reply was dropped");
  assert.strictEqual(view.items, short);
});

test("MS3 closing the modal cancels pending work and drops replies already in flight", async () => {
  {
    const { clock, scorer, zotero, controller, type } = setup();
    type("stiff gels relax");
    controller.close();
    clock.advance(1000);
    assert.strictEqual(scorer.calls.length, 0);
    assert.strictEqual(zotero.calls.length, 0);
  }
  {
    const { clock, scorer, zotero, view, controller, type } = setup();
    type("stiff gels relax");
    clock.advance(SETTINGS.debounceMs);
    controller.close();
    scorer.last().reject(new Error("refused"));
    zotero.calls[0].resolve([paper("NEW00001", "A new gel paper")]);
    await flushPromises();
    assert.deepStrictEqual(view.log, []);
    assert.strictEqual(view.footer, "", "no footer for a request of a closed modal");
  }
});

test("MS4 a whitespace-only edit keeps the list on screen and the merge on its way", async () => {
  const { clock, scorer, view, type } = setup();
  const first = type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs);
  assert.strictEqual(type("stiff gels relax "), first, "same list object: Obsidian redraws nothing");
  assert.strictEqual(type("stiff  gels relax "), first);
  clock.advance(1000);
  assert.strictEqual(scorer.calls.length, 1, "no second semantic request");
  scorer.last().resolve(scoresRanking(2, 1, 0));
  await flushPromises();
  assert.strictEqual(view.log.length, 1, "the merge still landed");
  assert.deepStrictEqual(keys(view.items).slice(0, 1), ["BAUE2022"]);
});

test("MS4b the same text on a rebuilt index is ranked again", () => {
  const { type, setIndex } = setup();
  const first = type("stiff gels");
  setIndex(makeIndex({ content_hash: "h2" }));
  assert.notStrictEqual(type("stiff gels "), first);
});

test("MS5 live Zotero rows go below the index's hits, survive the merge, and are dropped for a new query", async () => {
  const { clock, scorer, zotero, view, type } = setup();
  type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs);
  zotero.calls[0].resolve([paper("NEW00001", "A new gel paper")]);
  await flushPromises();
  const indexKeys = keys(view.items).filter((k) => !k.startsWith("live:"));
  assert.ok(indexKeys.length > 0);
  assert.deepStrictEqual(keys(view.items), [...indexKeys, "live:NEW00001"]);

  scorer.last().resolve(scoresRanking(2, 1, 0));
  await flushPromises();
  assert.strictEqual(keys(view.items).at(-1), "live:NEW00001", "the merged list keeps the live row last");

  const next = type("organoids");
  assert.ok(!keys(next).some((k) => k.startsWith("live:")), "a new query starts without the old live rows");
  clock.advance(SETTINGS.debounceMs);
  assert.strictEqual(zotero.calls.length, 2);
  scorer.last().resolve(scoresRanking(2, 1, 0));
  await flushPromises();
  assert.ok(!keys(view.items).some((k) => k.startsWith("live:")), "the old query's live row does not come back with the merge");
});

test("MS5b a Zotero reply for a query no longer on screen is dropped", async () => {
  const { clock, zotero, view, type } = setup();
  type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs);
  const now = type("organoids");
  zotero.calls[0].resolve([paper("NEW00001", "A new gel paper")]);
  await flushPromises();
  assert.deepStrictEqual(view.log, []);
  assert.strictEqual(view.items, now);
});

test("MS6 the selection stays on the same paper when the merge re-ranks the list", async () => {
  const { clock, scorer, view, type } = setup();
  const kw = type("stiff gels relax");
  assert.ok(kw.length >= 2);
  view.selected = 1; // the owner arrowed down
  const chosen = kw[1].paperIndex;
  assert.deepStrictEqual(kw.map((it) => it.paperIndex), [0, 2, 1], "fixture: keyword order");
  clock.advance(SETTINGS.debounceMs);
  // semantic ranks the chosen paper (2) first and paper 0 last, so the merge puts paper 2 first
  scorer.last().resolve(scoresRanking(2, 1, 0));
  await flushPromises();
  assert.strictEqual(view.items[view.selected].paperIndex, chosen);
  assert.strictEqual(view.selected, 0, "it moved, and the selection followed it");
});

test("MS6b the selection stays on a live Zotero row when the merge lands after it", async () => {
  const { clock, scorer, zotero, view, type } = setup();
  type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs);
  zotero.calls[0].resolve([paper("NEW00001", "A new gel paper")]);
  await flushPromises();
  view.selected = view.items.length - 1;
  scorer.last().resolve(scoresRanking(2, 1, 0));
  await flushPromises();
  assert.strictEqual(view.items[view.selected].livePaper?.key, "NEW00001");
});

test("MS7 the footer names the pplx service for a pplx index, and clears once semantic search answers", async () => {
  const { clock, scorer, view, type } = setup({ index: makeIndex({ backend: "pplx" }) });
  type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs);
  scorer.last().reject(new Error("connection refused"));
  await flushPromises();
  assert.strictEqual(view.footer, "semantic off: the pplx service not reachable");
  assert.deepStrictEqual(view.log, [], "the keyword list stays");

  type("stiff gels in hydrogels");
  clock.advance(SETTINGS.debounceMs);
  scorer.last().resolve(scoresRanking(0, 1, 2));
  await flushPromises();
  assert.strictEqual(view.footer, "");
});

test("MS7b the footer names Ollama for an Ollama index", async () => {
  const { clock, scorer, view, type } = setup();
  type("stiff gels relax");
  clock.advance(SETTINGS.debounceMs);
  scorer.last().reject(new Error("connection refused"));
  await flushPromises();
  assert.strictEqual(view.footer, "semantic off: Ollama not reachable");
});

test("MS8 no semantic request for an index without vectors; a loading row until the index is ready", () => {
  {
    const { clock, scorer, type } = setup({ index: { ...makeIndex(), vectors: null } });
    assert.ok(type("stiff gels relax").length > 0);
    clock.advance(1000);
    assert.strictEqual(scorer.calls.length, 0);
  }
  {
    const { controller, type } = setup({ ready: false });
    const items = type("stiff gels relax");
    assert.deepStrictEqual(items, [{ isLoadingRow: true }]);
    assert.strictEqual(controller.paperOf(items[0]), null);
  }
});

test("MS9 paperOf: index rows from the index, live rows from Zotero", () => {
  const { controller } = setup();
  assert.strictEqual(controller.paperOf({ paperIndex: 2 })?.key, "BAUE2022");
  const live = paper("NEW00001", "A new gel paper");
  assert.strictEqual(controller.paperOf({ livePaper: live }), live);
  assert.strictEqual(controller.paperOf({}), null);
});

test("MS10 (was L3d) ensureNote passes the shared session notice set (a notice shown by @@ is not shown again)", async () => {
  const vault = new FakeVault();
  vault.addFile("Zotero Template.md", "{% if x %}{{title}}{% endif %}"); // unsupported Nunjucks: one notice a session
  const notices: string[] = [];
  const sessionNotices = new Set<string>();
  const controller = new ModalSearchController({
    indexStore: { isReady: () => true, getIndex: () => makeIndex() },
    semanticScores: async () => null,
    zotero: { search: async () => [] },
    settings: { ...SETTINGS, createLiteratureNotes: true, literatureNoteTemplate: "Zotero Template.md" },
    view: new FakeView(),
    vault,
    showNotice: (m) => notices.push(m),
    sessionNotices,
  });
  const r = await controller.ensureNote(PAPERS[0]);
  assert.ok(r.file);
  await controller.ensureNote(PAPERS[1]);
  assert.strictEqual(notices.length, 1);
  assert.ok(sessionNotices.size > 0, "the notice was recorded in the shared set");
});

test("MS11 chooserView drives Obsidian's chooser, restoring the selection after setSuggestions resets it", () => {
  const log: string[] = [];
  const chooser = {
    values: [] as ModalSearchItem[],
    selectedItem: 3,
    setSuggestions(items: ModalSearchItem[]) {
      this.values = items;
      this.selectedItem = 0;
      log.push(`set:${items.length}`);
    },
    setSelectedItem(i: number) {
      this.selectedItem = i;
      log.push(`select:${i}`);
    },
  };
  let footer = "";
  const view = chooserView(() => chooser, (m) => (footer = m));
  assert.strictEqual(view.selectedIndex(), 3);
  view.setSuggestions([{ paperIndex: 0 }, { paperIndex: 1 }], 1);
  assert.deepStrictEqual(log, ["set:2", "select:1"]);
  assert.strictEqual(view.selectedIndex(), 1);
  view.setFooter("x");
  assert.strictEqual(footer, "x");

  // Fallback: an Obsidian without the internal chooser leaves the list as it is instead of throwing.
  const none = chooserView(() => undefined, () => {});
  assert.strictEqual(none.selectedIndex(), 0);
  none.setSuggestions([{ paperIndex: 0 }], 0);
  // A chooser missing setSelectedItem still gets its selection.
  const partial = { values: [] as ModalSearchItem[], selectedItem: 0, setSuggestions(items: ModalSearchItem[]) { this.values = items; } };
  chooserView(() => partial, () => {}).setSuggestions([{ paperIndex: 0 }, { paperIndex: 1 }], 1);
  assert.strictEqual(partial.selectedItem, 1);
});
