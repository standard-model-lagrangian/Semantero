process.env.TZ = "UTC";

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import pkg from "../package.json" with { type: "json" };
import { fakeVec, fixtureEngine, fixtureParts } from "./helpers.ts";

const BUNDLE = path.resolve(import.meta.dirname, "../dist/ranker.js");

function bareContext(): any {
  const ctx = vm.createContext({}); // no console, no TextDecoder, no process: like a bare JSContext
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), ctx);
  return ctx;
}

test("R28 dist/ranker.js evaluates in a bare context with no Node globals; version matches package.json", () => {
  const ctx = bareContext();
  assert.strictEqual(typeof (ctx as any).daito, "object");
  assert.strictEqual(ctx.daito.version, pkg.version);
  // (V8 vm contexts always have a `console`; the build step already forbids `console.` in the bundle)
  for (const g of ["process", "require", "Buffer", "TextDecoder", "setTimeout"]) {
    assert.strictEqual(vm.runInContext(`typeof ${g}`, ctx), "undefined", g);
  }
  for (const fn of ["load", "status", "keyword", "hybrid", "hybridFromRowScores", "recent", "shouldRunSemantic", "lookup"]) assert.strictEqual(typeof ctx.daito[fn], "function", fn);
});

test("R29 api round trip: load (JSON as UTF-8 bytes) → keyword → hybrid returns JSON that parses to ResultVM[]", () => {
  const ctx = bareContext();
  const { papers, notes } = fixtureParts();
  const status = JSON.parse(ctx.daito.load(papers, notes));
  assert.strictEqual(status.papers.count, 4);
  assert.strictEqual(status.notes.count, 7);
  assert.strictEqual(status.dims, 8);
  assert.strictEqual(status.model, "qwen3-embedding:0.6b");
  assert.match(status.queryInstruction, /retrieve that paper/);

  const e = fixtureEngine();
  const kw = JSON.parse(ctx.daito.keyword("stress relaxation", "all", 5));
  assert.deepStrictEqual(kw, JSON.parse(JSON.stringify(e.keyword("stress relaxation", "all", 5))));
  for (const r of kw) for (const f of ["id", "kind", "title", "subtitle", "accessory", "snippet", "snippetBold", "hasNote", "filePath", "openUrl", "openLabel", "noteUrl", "selectUrl", "citation", "wikilink", "actions", "detail", "source"]) assert.ok(f in r, f);

  const v = fakeVec("stress relaxation neurons");
  const hy = JSON.parse(ctx.daito.hybrid("stress relaxation neurons", v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), "all", 6));
  assert.deepStrictEqual(hy, JSON.parse(JSON.stringify(e.hybrid("stress relaxation neurons", v, "all", 6))));
  assert.strictEqual(JSON.parse(ctx.daito.recent(3)).length, 3);
});

test("R29b a failed load throws and keeps the previous engine; strings work as parts too", () => {
  const ctx = bareContext();
  const { papers, notes } = fixtureParts();
  ctx.daito.load(papers, notes);
  const before = ctx.daito.keyword("matrigel", "all", 3);
  assert.throws(() => ctx.daito.load({ ...papers!, manifest: "{not json" }, null));
  assert.strictEqual(ctx.daito.keyword("matrigel", "all", 3), before);
  const asText = (b: ArrayBuffer) => new TextDecoder().decode(b);
  ctx.daito.load({ manifest: asText(papers!.manifest as ArrayBuffer), papers: asText(papers!.papers as ArrayBuffer), chunks: asText(papers!.chunks as ArrayBuffer), vectors: papers!.vectors }, null);
  assert.ok(JSON.parse(ctx.daito.keyword("viscoelasticity", "all", 3)).length > 0);
  const fresh = vm.createContext({});
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), fresh);
  assert.throws(() => (fresh as any).daito.keyword("x", "all", 1), /no index loaded/);
});

test("R29c utf-8 decoding handles multi-byte text, a BOM and invalid bytes (JSC has no TextDecoder)", async () => {
  const { decodeUtf8 } = await import("../src/util.ts");
  const s = "café — 日本語 😀 naïve";
  assert.strictEqual(decodeUtf8(new TextEncoder().encode(s)), s);
  assert.strictEqual(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), "a");
  assert.strictEqual(decodeUtf8(new Uint8Array([0x61, 0xff, 0x62])), "a�b");
  assert.strictEqual(decodeUtf8(new Uint8Array([0x61, 0xe2, 0x82])), "a��");
  const big = "x😀é".repeat(20000);
  assert.strictEqual(decodeUtf8(new TextEncoder().encode(big)), big);
  assert.strictEqual(decodeUtf8(new ArrayBuffer(0)), "");
});

test("R30 conformance: TypeScript reproduces conformance/cases.json exactly", () => {
  const file = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../conformance/cases.json"), "utf8"));
  assert.ok(file.cases.length >= 60, `only ${file.cases.length} cases`);
  const e = fixtureEngine();
  for (const c of file.cases) {
    const got =
      c.mode === "recent" ? e.recent(c.limit)
      : c.mode === "hybrid" ? e.hybrid(c.query, new Float32Array(c.qVec), c.scope, c.limit)
      : e.keyword(c.query, c.scope, c.limit);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), c.expect, c.name);
  }
});

test("R30b the bundle reproduces the conformance cases too (what the app will run)", () => {
  const file = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../conformance/cases.json"), "utf8"));
  const ctx = bareContext();
  const { papers, notes } = fixtureParts();
  ctx.daito.load(papers, notes);
  for (const c of file.cases) {
    const v = c.qVec ? new Float32Array(c.qVec) : null;
    const json =
      c.mode === "recent" ? ctx.daito.recent(c.limit)
      : c.mode === "hybrid" ? ctx.daito.hybrid(c.query, v!.buffer, c.scope, c.limit)
      : ctx.daito.keyword(c.query, c.scope, c.limit);
    assert.deepStrictEqual(JSON.parse(json), c.expect, c.name);
  }
});

test("R29d shouldRunSemantic is exposed (≥2 complete tokens or ≥12 chars)", () => {
  const ctx = bareContext();
  assert.strictEqual(ctx.daito.shouldRunSemantic("vis"), false);
  assert.strictEqual(ctx.daito.shouldRunSemantic("stiff gels "), true);
  assert.strictEqual(ctx.daito.shouldRunSemantic("viscoelasticit"), true);
});
