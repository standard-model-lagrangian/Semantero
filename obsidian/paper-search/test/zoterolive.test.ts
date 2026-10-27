import test from "node:test";
import assert from "node:assert";
import { ZoteroLive, paperFromApiItem, indexedKeys } from "../src/zoterolive.ts";
import { InlineSuggestController, withLive, type SuggestionItem } from "../src/inline.ts";
import { BM25Index, type PaperMetadata } from "../src/bm25.ts";
import { FakeClock, FakeRequestUrl, FakeVault } from "./fakes.ts";

function apiItem(key: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    data: {
      key,
      itemType: "journalArticle",
      title,
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Liu" },
        { creatorType: "editor", firstName: "Ed", lastName: "Itor" },
        { creatorType: "author", name: "Cell Consortium" },
      ],
      date: "June 2026",
      publicationTitle: "bioRxiv",
      DOI: "10.1/x",
      abstractNote: "An atlas.",
      citationKey: `${key.toLowerCase()}2026`,
      tags: [{ tag: "imaging" }],
      ...extra,
    },
  };
}

function paper(key: string, title: string): PaperMetadata {
  return { key, citekey: key.toLowerCase(), title, authors: ["Roth"], year: 2023, journal: null, doi: null, tags: [],
    collections: [], abstract: null };
}

test("paperFromApiItem maps an item to the index's paper shape", () => {
  const p = paperFromApiItem(apiItem("NEWKEY01", "A multimodal perturbation atlas"))!;
  assert.deepStrictEqual(p, {
    key: "NEWKEY01", citekey: "newkey012026", title: "A multimodal perturbation atlas",
    authors: ["Liu", "Cell Consortium"], year: 2026, journal: "bioRxiv", doi: "10.1/x", tags: ["imaging"],
    collections: [], abstract: "An atlas.", pdfs: [], snapshots: [],
  });
  assert.strictEqual(paperFromApiItem({ data: { key: "A", itemType: "note" } }), null);
  assert.strictEqual(paperFromApiItem({}), null);
  assert.strictEqual(paperFromApiItem(apiItem("K", "t", { date: "", citationKey: undefined }))!.year, null);
});

test("ZoteroLive returns only papers the index lacks, up to the limit", async () => {
  const req = new FakeRequestUrl();
  req.handler = async () => ({ status: 200, json: [apiItem("OLD00001", "old"), apiItem("NEW00001", "a"),
    apiItem("NEW00002", "b"), apiItem("NEW00003", "c"), apiItem("NEW00004", "d")] });
  const live = new ZoteroLive(req.requestUrl.bind(req), "http://localhost:23119/api/");
  const got = await live.search("  atlas ", new Set(["OLD00001"]));
  assert.deepStrictEqual(got.map((p) => p.key), ["NEW00001", "NEW00002", "NEW00003"]);
  assert.match(req.calls[0].url, /^http:\/\/localhost:23119\/api\/users\/0\/items\/top\?q=atlas&limit=\d+$/);
});

test("ZoteroLive skips short queries and backs off for a minute after a refusal", async () => {
  const clock = new FakeClock(0);
  const req = new FakeRequestUrl();
  req.shouldFail = true; // Zotero closed, or local API off (Obsidian's requestUrl throws on 403)
  const live = new ZoteroLive(req.requestUrl.bind(req), undefined, () => clock.now());
  assert.deepStrictEqual(await live.search("at", new Set()), []);
  assert.strictEqual(req.callCount, 0);
  assert.deepStrictEqual(await live.search("atlas", new Set()), []);
  assert.deepStrictEqual(await live.search("atlas", new Set()), []);
  assert.strictEqual(req.callCount, 1);
  clock.currentTime = 60_001;
  req.shouldFail = false;
  req.handler = async () => ({ status: 200, json: [apiItem("NEW00001", "a")] });
  assert.strictEqual((await live.search("atlas", new Set())).length, 1);
  assert.strictEqual(req.callCount, 2);
});

test("indexedKeys is built once per index", () => {
  const ix = { papers: [paper("A", "a"), paper("B", "b")] };
  const s = indexedKeys(ix);
  assert.deepStrictEqual([...s], ["A", "B"]);
  assert.strictEqual(indexedKeys(ix), s);
});

test("withLive puts Zotero rows after the hits and before a footer, without duplicates", () => {
  const hit: SuggestionItem = { type: "paper", paper: paper("A", "a"), source: "keyword" };
  const footer: SuggestionItem = { type: "footer", message: "Semantic search unavailable" };
  const liveA: SuggestionItem = { type: "paper", paper: paper("A", "a"), source: "zotero" };
  const liveB: SuggestionItem = { type: "paper", paper: paper("B", "b"), source: "zotero" };
  assert.deepStrictEqual(withLive([hit, footer], [liveA, liveB]), [hit, liveB, footer]);
  assert.deepStrictEqual(withLive([hit, liveB], []), [hit]);
  const items = [hit];
  assert.strictEqual(withLive(items, []), items);
});

test("@@ lists a paper Zotero has before the index does, and keeps it through the semantic merge", async () => {
  const clock = new FakeClock();
  const papers = [paper("OLD00001", "Stress relaxation in hydrogels")];
  const index = {
    papers, chunks: [], bm25: new BM25Index(papers, []), vectors: new Float32Array(4).fill(1), dims: 4,
    totalRows: 1, rowToChunk: new Int32Array(1), rowToPaper: new Int32Array([0]), manifest: { content_hash: "h1" },
  };
  const asked: string[] = [];
  const controller = new InlineSuggestController({
    indexStore: { isReady: () => true, getIndex: () => index },
    embedder: { embedQuery: async () => new Float32Array(4).fill(1) },
    zotero: {
      search: async (q, known) => {
        asked.push(q);
        assert.ok(known.has("OLD00001"));
        return [paper("NEW00001", "Hydrogels, the new one")];
      },
    },
    vault: new FakeVault() as any,
    settings: { minCharsSemantic: 3 },
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: (id) => clock.clearTimeout(id),
  });
  let shown: SuggestionItem[] = [];
  const suggest = { suggestions: { setSuggestions: (h: SuggestionItem[]) => { shown = h; }, values: [] as SuggestionItem[] } };

  const first = await controller.getSuggestions("hydrogels", suggest);
  assert.deepStrictEqual(first.map((i) => i.paper?.key), ["OLD00001"]);
  clock.runAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(asked, ["hydrogels"]);
  assert.deepStrictEqual(shown.map((i) => i.paper?.key), ["OLD00001", "NEW00001"]);
  assert.strictEqual(shown[1].source, "zotero");

  // A new query drops the old live rows and their pending lookup
  await controller.getSuggestions("relaxation", suggest);
  controller.cancel();
  clock.runAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(asked, ["hydrogels"]);
});
