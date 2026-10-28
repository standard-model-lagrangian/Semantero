import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { hybridSearch, hybridSearchFromScores, rowScores, type LoadedIndex } from "../src/core/engine.ts";
import { IndexStore } from "../src/core/indexstore.ts";
import { pplxRowScores, semanticScores, warmSemantic } from "../src/core/semantic.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/search/index_small");

function loadSmallIndex(manifestExtra: Record<string, unknown> = {}): LoadedIndex {
  const manifest = { ...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8")), ...manifestExtra };
  const papers = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "papers.json"), "utf8"));
  const chunks = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "chunks.json"), "utf8"));
  const vecBuf = fs.readFileSync(path.join(FIXTURES_DIR, "vectors.f32"));
  const vectors = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4);
  return IndexStore.precomputeIndex(manifest, papers, chunks, vectors, manifest.dims, 1);
}

function b64(f: Float32Array): string {
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

function pplxService(ix: LoadedIndex, scores: Float32Array, over: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const fn = async (p: { url: string; body?: string }) => {
    calls.push({ url: p.url, body: p.body ? JSON.parse(p.body) : null });
    return {
      status: 200,
      json: { corpora: { search: { content_hash: ix.manifest.content_hash, rows: scores.length, scores: b64(scores), ...over } } },
    };
  };
  return { fn, calls };
}

test("hybridSearch is hybridSearchFromScores over rowScores", () => {
  const ix = loadSmallIndex();
  const q = new Float32Array(ix.dims);
  q[0] = 1;
  assert.deepStrictEqual(hybridSearch(ix, "viscoelastic", q, 10), hybridSearchFromScores(ix, "viscoelastic", rowScores(ix, q), 10));
});

test("null scores give the keyword ranking", () => {
  const ix = loadSmallIndex();
  const hits = hybridSearchFromScores(ix, "hydrogel", null, 10);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.source === "keyword"));
});

test("Ollama index: query vector from Ollama, dotted with the rows", async () => {
  const ix = loadSmallIndex();
  const q = Array.from({ length: ix.dims }, (_, i) => (i === 3 ? 2 : 0));
  let body: any = null;
  const fn = async (p: { url: string; body?: string }) => {
    body = JSON.parse(p.body!);
    assert.match(p.url, /11434\/api\/embed$/);
    return { status: 200, json: { embeddings: [q] } };
  };
  const res = await semanticScores(fn as any, ix, "text", { ollamaUrl: "http://127.0.0.1:11434", instruction: "find" });
  assert.strictEqual(body.model, ix.manifest.model);
  assert.match(body.input[0], /^Instruct: find\nQuery: text$/);
  const unit = new Float32Array(ix.dims);
  unit[3] = 1;
  assert.deepStrictEqual(res.scores, rowScores(ix, unit));
});

test("pplx index: row scores come from the service and are checked against the loaded build", async () => {
  const ix = loadSmallIndex({ backend: "pplx", backend_url: "http://127.0.0.1:11435/", content_hash: "abc" });
  const scores = Float32Array.from({ length: ix.totalRows }, (_, i) => i / 10);
  const svc = pplxService(ix, scores);
  const res = await semanticScores(svc.fn as any, ix, "my query", { ollamaUrl: "unused", instruction: "ignored" });
  assert.strictEqual(svc.calls[0].url, "http://127.0.0.1:11435/rowscores");
  assert.deepStrictEqual(svc.calls[0].body, { text: "my query", corpora: ["search"] });
  assert.deepStrictEqual(Array.from(res.scores!), Array.from(scores, (x) => x));

  const stale = pplxService(ix, scores, { content_hash: "other" });
  await assert.rejects(semanticScores(stale.fn as any, ix, "q", { ollamaUrl: "", instruction: "" }), /another build/);
  const short = pplxService(ix, scores.subarray(1));
  await assert.rejects(semanticScores(short.fn as any, ix, "q", { ollamaUrl: "", instruction: "" }), /do not match/);
  const err = pplxService(ix, scores, { error: "the live index is qwen" });
  await assert.rejects(semanticScores(err.fn as any, ix, "q", { ollamaUrl: "", instruction: "" }), /live index is qwen/);
});

test("pplx exclusions zero the excluded papers' rows", async () => {
  const ix = loadSmallIndex({ backend: "pplx", content_hash: "abc" });
  const scores = new Float32Array(ix.totalRows).fill(0.5);
  const svc = pplxService(ix, scores);
  const res = await semanticScores(svc.fn as any, ix, "q", { ollamaUrl: "", instruction: "", exclude: new Set([0]) });
  for (let r = 0; r < ix.totalRows; r++) assert.strictEqual(res.scores![r], ix.rowToPaper[r] === 0 ? 0 : 0.5);
});

test("pplxRowScores decodes little-endian float32", async () => {
  const f = new Float32Array([0.25, -1.5, 3]);
  const fn = async () => ({ status: 200, json: { corpora: { notes: { content_hash: "h", scores: b64(f) } } } });
  assert.deepStrictEqual(Array.from(await pplxRowScores(fn as any, "http://x", "q", "notes", "h")), [0.25, -1.5, 3]);
});

test("warm-up goes to the index's backend", async () => {
  const urls: string[] = [];
  const fn = async (p: { url: string }) => {
    urls.push(p.url);
    return { status: 200, json: {} };
  };
  await warmSemantic(fn as any, loadSmallIndex({ backend: "pplx", backend_url: "http://127.0.0.1:11435" }), "http://o:11434");
  await warmSemantic(fn as any, loadSmallIndex(), "http://o:11434");
  assert.deepStrictEqual(urls, ["http://127.0.0.1:11435/warm", "http://o:11434/api/embed"]);
});
