import test from "node:test";
import assert from "node:assert";
import { TextStore, compactChunkTexts } from "../../obsidian/paper-search/src/core/textstore.ts";
import { fixtureEngine, rawFixtures } from "./helpers.ts";

test("R33 TextStore round-trips every kind of string exactly, including unpaired surrogates", () => {
  const texts = ["", "ascii only", "café — naïve", "日本語のテキスト", "emoji 😀👩‍🔬 mixed", "lone high \ud800 x", "lone low \udc00 y",
    "end with high \ud83d", "\udc00\ud800 reversed pair", "tab\tnewline\nnull\u0000", "x".repeat(20000) + "é".repeat(5000)];
  let rnd = 7;
  for (let k = 0; k < 200; k++) {
    let s = "";
    for (let j = 0; j < 50; j++) { rnd = (rnd * 1103515245 + 12345) >>> 0; s += String.fromCharCode(rnd % 0x10000); }
    texts.push(s);
  }
  const store = TextStore.from(texts);
  assert.strictEqual(store.count, texts.length);
  texts.forEach((t, i) => assert.strictEqual(store.get(i), t, `index ${i}`));
  assert.strictEqual(store.get(-1), "");
  assert.strictEqual(store.get(texts.length), "");
  assert.ok(TextStore.from(["abc", "dé"]).byteLength === 6);
});

test("R34 compacted chunks keep every field and read their text through the store", () => {
  const raw = rawFixtures().papers.chunks.map((c) => ({ ...c, row: c.row ?? undefined, heading: "H", line: 3 }));
  const before = raw.map((c) => ({ ...c }));
  compactChunkTexts(raw);
  raw.forEach((c, i) => {
    assert.strictEqual(c.text, before[i].text);
    assert.strictEqual(c.paper, before[i].paper);
    assert.strictEqual(c.attachmentKey, before[i].attachmentKey);
    assert.strictEqual(c.page, before[i].page);
    assert.strictEqual(c.row, before[i].row);
    assert.strictEqual(c.heading, "H");
    assert.strictEqual(c.line, 3);
    assert.ok(!Object.prototype.hasOwnProperty.call(c, "text"), "text is not an own property");
  });
  // the engine still builds snippets from it
  assert.match(fixtureEngine().keyword("stiffer gels promoted", "papers", 1)[0].snippet, /Stiffer gels/);
});
