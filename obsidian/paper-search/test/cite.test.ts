import test from "node:test";
import assert from "node:assert";
import {
  findTrigger,
  isExcludedContext,
  formatCitation,
  citedKeys,
  type SectionCacheLike,
} from "../src/cite.ts";

test("C1 basic: text @@stiff with cursor at the end", () => {
  const line = "text @@stiff";
  const res = findTrigger(line, line.length);
  assert.ok(res);
  assert.strictEqual(res.start, 5);
  assert.strictEqual(res.end, 12);
  assert.strictEqual(res.query, "stiff");
});

test("C2 at the start of the line and after opening punctuation triggers", () => {
  // Start of line
  const l1 = "@@stiff";
  const r1 = findTrigger(l1, l1.length);
  assert.ok(r1);
  assert.strictEqual(r1.start, 0);
  assert.strictEqual(r1.query, "stiff");

  // After (
  const l2 = "(@@stiff";
  const r2 = findTrigger(l2, l2.length);
  assert.ok(r2);
  assert.strictEqual(r2.start, 1);
  assert.strictEqual(r2.query, "stiff");

  // After [
  const l3 = "[@@stiff";
  const r3 = findTrigger(l3, l3.length);
  assert.ok(r3);
  assert.strictEqual(r3.start, 1);

  // After {
  const l4 = "{@@stiff";
  const r4 = findTrigger(l4, l4.length);
  assert.ok(r4);
  assert.strictEqual(r4.start, 1);

  // After "
  const l5 = '"@@stiff';
  const r5 = findTrigger(l5, l5.length);
  assert.ok(r5);
  assert.strictEqual(r5.start, 1);

  // After '
  const l6 = "'@@stiff";
  const r6 = findTrigger(l6, l6.length);
  assert.ok(r6);
  assert.strictEqual(r6.start, 1);

  // After space
  const l7 = "some @@stiff";
  const r7 = findTrigger(l7, l7.length);
  assert.ok(r7);
  assert.strictEqual(r7.start, 5);
});

test("C3 after letter, digit, @ or \\ gives no trigger", () => {
  assert.strictEqual(findTrigger("x@@stiff", 8), null);
  assert.strictEqual(findTrigger("2@@stiff", 8), null);
  assert.strictEqual(findTrigger("@@@stiff", 8), null);
  assert.strictEqual(findTrigger("\\@@stiff", 8), null);
  assert.strictEqual(findTrigger("name@domain.com@@stiff", 22), null);
});

test("C4 empty query (@@) triggers with empty string", () => {
  const line = "@@";
  const res = findTrigger(line, line.length);
  assert.ok(res);
  assert.strictEqual(res.start, 0);
  assert.strictEqual(res.end, 2);
  assert.strictEqual(res.query, "");

  const line2 = "some @@";
  const res2 = findTrigger(line2, line2.length);
  assert.ok(res2);
  assert.strictEqual(res2.start, 5);
  assert.strictEqual(res2.end, 7);
  assert.strictEqual(res2.query, "");
});

test("C5 the last @@ wins: @@a done @@stiff -> query stiff", () => {
  const line = "@@a done @@stiff";
  const res = findTrigger(line, line.length);
  assert.ok(res);
  assert.strictEqual(res.start, 9);
  assert.strictEqual(res.query, "stiff");
});

test("C6 more than 160 characters back or query > 120 chars -> no trigger", () => {
  // @@ is 165 characters back from cursor
  const longPrefix = "a".repeat(165);
  const line1 = `@@${longPrefix}`;
  assert.strictEqual(findTrigger(line1, line1.length), null);

  // Query is 121 characters long
  const longQuery = "b".repeat(121);
  const line2 = `@@${longQuery}`;
  assert.strictEqual(findTrigger(line2, line2.length), null);

  // Query of 120 characters is allowed
  const exact120 = "b".repeat(120);
  const line3 = `@@${exact120}`;
  const res3 = findTrigger(line3, line3.length);
  assert.ok(res3);
  assert.strictEqual(res3.query.length, 120);
});

test("C7 query contains ]], @@, tab, or starts with two spaces -> no trigger", () => {
  assert.strictEqual(findTrigger("@@stiff]]more", 13), null);
  assert.strictEqual(findTrigger("@@stiff\tmore", 12), null);
  assert.strictEqual(findTrigger("@@  stiff", 9), null);
  assert.strictEqual(findTrigger("@@  ", 4), null);
});

test("C8 cursor in the middle of a query (@@sti|ff) -> query sti", () => {
  const line = "@@stiff";
  // Cursor after 'sti' is at column 5
  const res = findTrigger(line, 5);
  assert.ok(res);
  assert.strictEqual(res.start, 0);
  assert.strictEqual(res.end, 5);
  assert.strictEqual(res.query, "sti");
});

test("C9 excluded contexts: frontmatter, fenced code, math blocks, inline code, inline math, unclosed [[", () => {
  // Frontmatter section
  const sectionsFm: SectionCacheLike[] = [
    { type: "frontmatter", position: { start: { line: 0 }, end: { line: 4 } } },
  ];
  assert.strictEqual(isExcludedContext(sectionsFm, 2, "title: @@stiff", 13), true);

  // Fenced code block (including inside a list)
  const sectionsCode: SectionCacheLike[] = [
    { type: "code", position: { start: { line: 10 }, end: { line: 15 } } },
  ];
  assert.strictEqual(isExcludedContext(sectionsCode, 12, "  @@stiff", 9), true);

  // Math block $$
  const sectionsMath: SectionCacheLike[] = [
    { type: "math", position: { start: { line: 20 }, end: { line: 25 } } },
  ];
  assert.strictEqual(isExcludedContext(sectionsMath, 22, "E = mc^2 @@stiff", 16), true);

  // Inline code: `@@x`
  assert.strictEqual(isExcludedContext([], 0, "run `@@stiff` today", 11), true);

  // Inline math: $a@@b$
  assert.strictEqual(isExcludedContext([], 0, "value $a@@b$ end", 10), true);

  // Unclosed [[foo @@x
  assert.strictEqual(isExcludedContext([], 0, "see [[foo @@stiff", 17), true);

  // Unclosed ![[foo @@x
  assert.strictEqual(isExcludedContext([], 0, "embed ![[foo @@stiff", 20), true);
});

test("C10 not excluded: after a closed code span, after \\$, after closed [[link]]", () => {
  // After closed code on same line
  assert.strictEqual(isExcludedContext([], 0, "run `code` @@stiff", 18), false);

  // After \$
  assert.strictEqual(isExcludedContext([], 0, "costs \\$100 @@stiff", 19), false);

  // After closed [[link]]
  assert.strictEqual(isExcludedContext([], 0, "see [[link]] @@stiff", 20), false);
});

test("C11 multi-byte text before the trigger -> correct string offsets", () => {
  const line = "naïve Φ29 @@x";
  // 'naïve Φ29 ' is 10 UTF-16 code units:
  // n (1), a (1), ï (1), v (1), e (1), ' ' (1), Φ (1), 2 (1), 9 (1), ' ' (1) = 10 chars
  const res = findTrigger(line, line.length);
  assert.ok(res);
  assert.strictEqual(res.start, 10);
  assert.strictEqual(res.end, 13);
  assert.strictEqual(res.query, "x");
  assert.strictEqual(line.slice(res.start, res.end), "@@x");
});

test("C12 custom trigger setting ';;' behaves the same as '@@' in C1-C8", () => {
  // Basic
  const l1 = "text ;;stiff";
  const r1 = findTrigger(l1, l1.length, ";;");
  assert.ok(r1);
  assert.strictEqual(r1.start, 5);
  assert.strictEqual(r1.query, "stiff");

  // Start of line
  const l2 = ";;stiff";
  const r2 = findTrigger(l2, l2.length, ";;");
  assert.ok(r2);
  assert.strictEqual(r2.start, 0);

  // After letter / digit / ; / \ -> rejected
  assert.strictEqual(findTrigger("x;;stiff", 8, ";;"), null);
  assert.strictEqual(findTrigger("1;;stiff", 8, ";;"), null);
  assert.strictEqual(findTrigger(";;;stiff", 8, ";;"), null);
  assert.strictEqual(findTrigger("\\;;stiff", 8, ";;"), null);

  // Empty query
  const l3 = "some ;;";
  const r3 = findTrigger(l3, l3.length, ";;");
  assert.ok(r3);
  assert.strictEqual(r3.query, "");

  // Last wins
  const l4 = ";;first done ;;second";
  const r4 = findTrigger(l4, l4.length, ";;");
  assert.ok(r4);
  assert.strictEqual(r4.query, "second");

  // Query constraints
  assert.strictEqual(findTrigger(";;  stiff", 9, ";;"), null);
  assert.strictEqual(findTrigger(";;stiff\tmore", 12, ";;"), null);
});

test("formatCitation helper formats template correctly and throws if invalid", () => {
  assert.strictEqual(formatCitation("[[{{citekey}}]]", "roth2023"), "[[roth2023]]");
  assert.strictEqual(formatCitation("[@{{citekey}}]", "roth2023"), "[@roth2023]");
  assert.throws(() => formatCitation("no_key", "roth2023"), /Citation format must contain/);
});

test("citedKeys extracts wiki links, pandoc citations, frontmatter, and ignores code", () => {
  const note = `---
citekey: roth2023
title: Some Paper
---
# Notes

Here is a citation [[lesavage2024]] and an aliased one [[bauer2022|Bauer et al.]].
Also pandoc citations: [@wang2021] and multiple [@kim2020; @schmidt2019].
Suppressed author: [-@muller2018].

\`\`\`markdown
Code block should be ignored:
[[ignored2025]]
[@ignored2026]
\`\`\`

Inline code \`[[ignored2027]]\` should also be ignored.
`;

  const keys = citedKeys(note);
  assert.ok(keys.has("roth2023"), "should have frontmatter citekey");
  assert.ok(keys.has("lesavage2024"), "should have plain wikilink");
  assert.ok(keys.has("bauer2022"), "should have aliased wikilink");
  assert.ok(keys.has("wang2021"), "should have pandoc citation");
  assert.ok(keys.has("kim2020"), "should have first of multiple pandoc");
  assert.ok(keys.has("schmidt2019"), "should have second of multiple pandoc");
  assert.ok(keys.has("muller2018"), "should have suppressed author pandoc");

  assert.ok(!keys.has("ignored2025"), "should ignore fenced code wikilink");
  assert.ok(!keys.has("ignored2026"), "should ignore fenced code pandoc");
  assert.ok(!keys.has("ignored2027"), "should ignore inline code");
});
