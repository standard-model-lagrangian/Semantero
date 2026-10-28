import test from "node:test";
import assert from "node:assert";
import { tokenize, splitSentences, bestSnippet } from "../src/core/text.ts";

test("tokenises numbers and drops stopwords", () => {
  const res = tokenize("IL-6 in the 3D gels");
  assert.deepStrictEqual(res.tokens, ["il", "6", "3d", "gels"]);
});

test("marks the last token as possibly unfinished, whatever follows it", () => {
  const typing = tokenize("stiff gel");
  assert.deepStrictEqual(typing.tokens, ["stiff", "gel"]);
  assert.strictEqual(typing.lastIncomplete, true);

  // A trailing space, tab, newline or punctuation changes nothing
  for (const q of ["stiff gel ", "stiff gel  ", "stiff gel\t", "stiff gel\n", "stiff gel.", " stiff  gel "]) {
    assert.deepStrictEqual(tokenize(q), typing, q);
  }

  // A trailing stopword finishes the word before it
  const completeWithStopword = tokenize("stiff in");
  assert.deepStrictEqual(completeWithStopword.tokens, ["stiff"]);
  assert.strictEqual(completeWithStopword.lastIncomplete, false);
  assert.deepStrictEqual(tokenize("stiff in "), completeWithStopword);
});

test('splits sentences without breaking "et al." or "Fig. 2"', () => {
  const text =
    "Roth et al. evaluated hydrogel stiffness. In Fig. 2 we show accelerated neuronal maturation. Finally, we observed functional synapses.";
  const sentences = splitSentences(text);
  assert.strictEqual(sentences.length, 3);
  assert.strictEqual(sentences[0], "Roth et al. evaluated hydrogel stiffness.");
  assert.strictEqual(sentences[1], "In Fig. 2 we show accelerated neuronal maturation.");
  assert.strictEqual(sentences[2], "Finally, we observed functional synapses.");
});

test("snippet picks max-overlap sentence and trims around it", () => {
  const text =
    "Initial background on biomaterial scaffolds. Tunable hydrogel viscoelasticity modulates human neural maturation dramatically in 3D culture models. Concluding remarks on future work.";
  const queryTokens = ["viscoelasticity", "neural", "maturation"];
  const snip = bestSnippet(text, queryTokens, 80);

  assert.strictEqual(
    snip.sentence,
    "Tunable hydrogel viscoelasticity modulates human neural maturation dramatically in 3D culture models."
  );
  assert.ok(snip.text.includes("viscoelasticity"));
  assert.ok(snip.text.includes("maturation"));
  assert.ok(snip.text.length <= 90);
});

test("snippet falls back to the first sentence when nothing overlaps", () => {
  const text =
    "First sentence introducing organoids. Second sentence discussing unrelated things.";
  const queryTokens = ["quantum", "gravity"];
  const snip = bestSnippet(text, queryTokens, 160);

  assert.strictEqual(snip.sentence, "First sentence introducing organoids.");
  assert.ok(snip.text.includes("First sentence"));
});
