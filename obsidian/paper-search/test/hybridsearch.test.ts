import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyword, semantic, hybrid, hybridSearch, rowScores, type LoadedIndex } from "../src/engine.ts";
import { ModalSearchController, type ModalSearchItem } from "../src/modalsearch.ts";
import { InlineSuggestController, type SuggestionItem } from "../src/inline.ts";
import { FakeClock, FakeVault } from "./fakes.ts";
import { IndexStore } from "../src/indexstore.ts";
import { buildSyntheticIndex } from "../scripts/make-synthetic-index.ts";

// 80 papers: more than the 12-result limit, so truncating before the merge changes results.
function loadIndex(): LoadedIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-"));
  buildSyntheticIndex({ outDir: dir, numPapers: 80, chunksPerPaper: 6, dims: 16, seed: 7 });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const papers = JSON.parse(fs.readFileSync(path.join(dir, "papers.json"), "utf8"));
  const chunks = JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf8"));
  const buf = fs.readFileSync(path.join(dir, "vectors.f32"));
  const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  fs.rmSync(dir, { recursive: true, force: true });
  return IndexStore.precomputeIndex(manifest, papers, chunks, vectors, manifest.dims, 1);
}

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
}

function queries(ix: LoadedIndex): string[] {
  // two-word queries from paper titles, so keyword lists are long
  return ix.papers.slice(0, 40).map((p) => p.title.split(/\s+/).slice(0, 2).join(" ") + " ");
}

test("HS1 hybridSearch ranks over the FULL keyword and semantic lists (original modal behaviour)", () => {
  const ix = loadIndex();
  const r = rng(3);
  const N = ix.papers.length;
  let differsFromTruncated = 0;
  for (const q of queries(ix)) {
    const qVec = new Float32Array(ix.dims).map(() => r());
    const reference = hybrid(keyword(ix, q, N), semantic(ix, qVec, q, { limit: N }), 12);
    const got = hybridSearch(ix, q, qVec, 12);
    assert.deepStrictEqual(got.map((h) => h.paper), reference.map((h) => h.paper), `order for "${q}"`);
    assert.deepStrictEqual(got.map((h) => h.snippet), reference.map((h) => h.snippet), `snippets for "${q}"`);
    assert.deepStrictEqual(got.map((h) => h.page), reference.map((h) => h.page));
    assert.deepStrictEqual(got.map((h) => h.attachmentKey), reference.map((h) => h.attachmentKey));
    const truncated = hybrid(keyword(ix, q, 12), semantic(ix, qVec, q, { limit: 12 }), 12);
    if (truncated.map((h) => h.paper).join() !== reference.map((h) => h.paper).join()) differsFromTruncated++;
  }
  // guard that this fixture actually exercises the bug
  assert.ok(differsFromTruncated > 0, "fixture too small to show truncation");
});

test("HS2 keyword/semantic with snippets:false skip snippet work but keep ranking and locations", () => {
  const ix = loadIndex();
  const q = queries(ix)[0];
  const full = keyword(ix, q, 50);
  const bare = keyword(ix, q, 50, { snippets: false });
  assert.deepStrictEqual(bare.map((h) => [h.paper, h.page, h.attachmentKey]), full.map((h) => [h.paper, h.page, h.attachmentKey]));
  assert.ok(bare.every((h) => h.snippet === ""));
});

/** Runs the debounced work of a controller to completion: timers, then the replies they await. */
async function settle(clock: FakeClock) {
  clock.runAll();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("HS3 the search modal and @@ show the merge over the full lists (hybridSearch), not a merge of truncated ones", async () => {
  const ix = loadIndex();
  const r = rng(5);
  const N = ix.papers.length;
  const store = { isReady: () => true, getIndex: () => ix };
  let differsFromTruncated = 0;
  for (const q of queries(ix).slice(0, 15)) {
    const qVec = new Float32Array(ix.dims).map(() => r());
    const want = hybridSearch(ix, q, qVec, 12).map((h) => h.paper);
    const truncated = hybrid(keyword(ix, q, 12), semantic(ix, qVec, q, { limit: 12 }), 12).map((h) => h.paper);
    if (truncated.join() !== want.join()) differsFromTruncated++;

    // the modal
    const clock = new FakeClock();
    let shown: ModalSearchItem[] = [];
    const modal = new ModalSearchController({
      indexStore: store,
      semanticScores: async (index) => rowScores(index, qVec),
      zotero: { search: async () => [] },
      settings: { limit: 12, debounceMs: 200, minCharsSemantic: 1 },
      view: { setSuggestions: (items) => (shown = items), selectedIndex: () => 0, setFooter: () => {} },
      vault: new FakeVault(),
      setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeoutFn: (id) => clock.clearTimeout(id),
    });
    modal.getSuggestions(q);
    await settle(clock);
    assert.deepStrictEqual(shown.map((it) => it.paperIndex), want, `modal order for "${q}"`);

    // @@
    const iclock = new FakeClock();
    const values: SuggestionItem[] = [];
    const suggest = { suggestions: { values, selectedItem: 0, setSuggestions(items: SuggestionItem[]) { this.values = items; } } };
    const inline = new InlineSuggestController({
      indexStore: store,
      embedder: { embedQuery: async () => qVec, rowScores: async (_t, index) => rowScores(index, qVec) },
      vault: new FakeVault(),
      settings: { inlineLimit: 12, minCharsSemantic: 1, createLiteratureNotes: false },
      setTimeoutFn: (fn, ms) => iclock.setTimeout(fn, ms),
      clearTimeoutFn: (id) => iclock.clearTimeout(id),
    });
    await inline.getSuggestions(q, suggest);
    await settle(iclock);
    assert.deepStrictEqual(suggest.suggestions.values.map((it) => it.paper?.key), want.map((p) => ix.papers[p].key), `@@ order for "${q}"`);
  }
  assert.ok(differsFromTruncated > 0, "fixture too small to show truncation");
});
