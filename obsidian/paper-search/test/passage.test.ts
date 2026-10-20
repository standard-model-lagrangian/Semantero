import test from "node:test";
import assert from "node:assert";
import { cleanMarkdown, extractPassage } from "../src/passage.ts";
import { citedKeys } from "../src/cite.ts";

test("R1 a selection of at least 20 characters wins; a shorter selection falls through to section", () => {
  const note = `# Heading 1
This is a long section with plenty of detail explaining the viscoelastic hydrogel mechanics. It easily has more than two hundred characters of detailed prose describing organoid stiffness and cellular behaviour.

# Heading 2
Another section with more content.`;

  // 1. Selection >= 20 characters wins
  const longSel = "selection with more than twenty chars here";
  const res1 = extractPassage(note, 50, longSel);
  assert.ok(res1);
  assert.strictEqual(res1, longSel);

  // 2. Selection < 20 characters falls through to the section
  const shortSel = "short sel";
  const res2 = extractPassage(note, 50, shortSel);
  assert.ok(res2);
  assert.ok(res2.includes("viscoelastic hydrogel mechanics"));
  assert.ok(!res2.includes("short sel"));
});

test("R2 section around cursor between headings when >= 200 characters; otherwise whole note", () => {
  // Case A: Section >= 200 chars
  const sec1Text = "A".repeat(250) + ". First section sentence.";
  const sec2Text = "B".repeat(250) + ". Second section sentence.";
  const noteWithSections = `# Section 1\n${sec1Text}\n\n# Section 2\n${sec2Text}`;

  // Cursor in section 1 (offset 20)
  const resA = extractPassage(noteWithSections, 20);
  assert.ok(resA);
  assert.ok(resA.includes("First section sentence"));
  assert.ok(!resA.includes("Second section sentence"));

  // Cursor in section 2
  const offsetSec2 = noteWithSections.indexOf("Second section sentence");
  const resB = extractPassage(noteWithSections, offsetSec2);
  assert.ok(resB);
  assert.ok(resB.includes("Second section sentence"));
  assert.ok(!resB.includes("First section sentence"));

  // Case B: Section < 200 chars -> falls through to whole note
  const shortSecNote = `# Small Heading 1\nShort section.\n\n# Small Heading 2\nAnother short section but together with the first section they make up enough text for the whole note to be used.`;
  const resC = extractPassage(shortSecNote, 25);
  assert.ok(resC);
  assert.ok(resC.includes("Short section"));
  assert.ok(resC.includes("Another short section"));
});

test("R3 clean-up removes all 3b elements and converts wikilinks correctly", () => {
  // 1. Frontmatter
  const fm = `---\ntitle: Some Title\ncitekey: test2024\n---\nActual content here.`;
  assert.strictEqual(cleanMarkdown(fm), "Actual content here.");

  // 2. Planner brief block
  const brief = `%% planner:start %%\nBrief text to ignore\n%% planner:end %%\nNote content stays.`;
  assert.strictEqual(cleanMarkdown(brief), "Note content stays.");

  // 3. Comments %% ... %%
  const comment = `Text before %% secret comment %% text after.`;
  assert.strictEqual(cleanMarkdown(comment), "Text before text after.");

  // 4. Fenced code
  const code = "Text before ```python\nprint('hello')\n``` text after.";
  assert.strictEqual(cleanMarkdown(code), "Text before text after.");

  // 5. Math blocks $$ ... $$
  const math = "Formula $$E = mc^2$$ explained here.";
  assert.strictEqual(cleanMarkdown(math), "Formula explained here.");

  // 6. Embeds ![[image.png]]
  const embed = "Diagram ![[flowchart.png]] shown above.";
  assert.strictEqual(cleanMarkdown(embed), "Diagram shown above.");

  // 7. Image links ![alt](url)
  const img = "Diagram ![chart](https://example.com/fig1.png) shown.";
  assert.strictEqual(cleanMarkdown(img), "Diagram shown.");

  // 8. Bare URLs
  const url = "Check https://nature.com/articles/123 for details.";
  assert.strictEqual(cleanMarkdown(url), "Check for details.");

  // 9. Wikilink alias: [[target|alias]] -> alias
  const alias = "Studied in [[roth2023|Roth et al. (2023)]] recently.";
  assert.strictEqual(cleanMarkdown(alias), "Studied in Roth et al. (2023) recently.");

  // 10. Wikilink without alias: [[target]] -> target
  const target = "Studied in [[roth2023]] recently.";
  assert.strictEqual(cleanMarkdown(target), "Studied in roth2023 recently.");

  // 11. Markdown markers (#, >, -, *, _, backticks)
  const markers = "# Heading\n> Quote\n- List item\n*italic* and **bold** and `code` span.";
  assert.strictEqual(
    cleanMarkdown(markers),
    "Heading Quote List item italic and bold and code span."
  );

  // 12. Whitespace collapse
  const ws = "Many    spaces   and\n\n\nnewlines\tcollapsed.";
  assert.strictEqual(cleanMarkdown(ws), "Many spaces and newlines collapsed.");
});

test("R4 shortening: 50 kB note gives <= 2000 chars, centred on cursor, cut at sentence boundaries, cursor sentence included", () => {
  // Generate ~50 kB of distinct numbered sentences
  const sentences: string[] = [];
  for (let i = 0; i < 600; i++) {
    sentences.push(`Sentence number ${i} discusses viscoelastic matrix stiffness in organoid culture.`);
  }
  const bigNote = sentences.join(" ");
  assert.ok(bigNote.length > 40000);

  // Position cursor at sentence 300 (roughly middle)
  const targetSentence = "Sentence number 300 discusses viscoelastic matrix stiffness in organoid culture.";
  const cursorOffset = bigNote.indexOf(targetSentence) + 10;

  const res = extractPassage(bigNote, cursorOffset, "", 2000);
  assert.ok(res);
  assert.ok(res.length <= 2000, `Result length ${res.length} must be <= 2000`);
  assert.ok(res.length > 1500, `Result length ${res.length} should be reasonably full`);

  // Cursor's own sentence is always included
  assert.ok(res.includes(targetSentence), "Cursor sentence must be included");

  // Cut at sentence boundaries (starts and ends with complete sentence)
  assert.ok(res.startsWith("Sentence number "));
  assert.ok(res.endsWith("culture."));
});

test("R5 too short after clean-up -> returns null (Write a bit more state)", () => {
  // Frontmatter only
  const fmOnly = `---
title: Empty Note
citekey: empty2024
---
`;
  assert.strictEqual(extractPassage(fmOnly, 10), null);

  // Note with only a couple of characters and an embed
  const tooShort = "Hi. ![[image.png]]";
  assert.strictEqual(extractPassage(tooShort, 2), null);
});

test("R6 cited keys: wikilinks, aliases, pandoc, frontmatter detected; code blocks ignored", () => {
  const note = `---
citekey: roth2023
---
# Literature

We refer to [[roth2023]], and [[lesavage2024|LeSavage et al.]].
Also pandoc references: [@bauer2022] and [@wang2021; @kim2020].

\`\`\`
Ignored:
[[ignoredKey1]]
[@ignoredKey2]
\`\`\`

Inline \`[[ignoredKey3]]\` and \`[@ignoredKey4]\` are also ignored.
`;

  const keys = citedKeys(note);
  assert.ok(keys.has("roth2023"));
  assert.ok(keys.has("lesavage2024"));
  assert.ok(keys.has("bauer2022"));
  assert.ok(keys.has("wang2021"));
  assert.ok(keys.has("kim2020"));

  assert.ok(!keys.has("ignoredKey1"));
  assert.ok(!keys.has("ignoredKey2"));
  assert.ok(!keys.has("ignoredKey3"));
  assert.ok(!keys.has("ignoredKey4"));
});
