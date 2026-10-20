import { splitSentences } from "./text.ts";

/**
 * Cleans Markdown formatting from text according to SPEC 3b:
 * - remove frontmatter
 * - remove planner brief block (%% planner:start %% ... %% planner:end %%)
 * - remove %% ... %% comments
 * - remove fenced code blocks (``` ... ```)
 * - remove math blocks ($$ ... $$)
 * - remove embeds (![[...]])
 * - remove image links (![...](...))
 * - remove bare URLs (http://... or https://...)
 * - [[target|alias]] becomes alias, and [[target]] becomes target
 * - remove Markdown markers (#, >, -, *, _, backticks)
 * - collapse whitespace
 */
export function cleanMarkdown(text: string): string {
  if (!text) return "";

  let s = text;

  // 1. Remove YAML frontmatter
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---/g, " ");

  // 2. Remove planner brief block
  s = s.replace(/%%\s*planner:start\s*%%[\s\S]*?%%\s*planner:end\s*%%/gi, " ");

  // 3. Remove all %% comments %%
  s = s.replace(/%%[\s\S]*?%%/g, " ");

  // 4. Remove fenced code blocks
  s = s.replace(/```[\s\S]*?```/g, " ");

  // 5. Remove math blocks $$ ... $$
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ");

  // 6. Remove embeds ![[...]]
  s = s.replace(/!\[\[[^\]\n]*\]\]/g, " ");

  // 7. Remove image links ![alt](url)
  s = s.replace(/!\[[^\]\n]*\]\([^\)\n]*\)/g, " ");

  // 8. Remove bare URLs
  s = s.replace(/https?:\/\/[^\s\)]+/g, " ");

  // 9. Wikilinks with alias: [[target|alias]] -> alias
  s = s.replace(/\[\[([^|\]\n]+)\|([^\]\n]+)\]\]/g, "$2");

  // 10. Wikilinks without alias: [[target]] -> target
  s = s.replace(/\[\[([^\]\n]+)\]\]/g, "$1");

  // 11. Remove Markdown markers: #, >, -, *, _, backticks
  s = s.replace(/[#>\-*_`]/g, " ");

  // 12. Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Shortens a list of sentences to at most maxChars, centred around sentence cursorIdx.
 * Sentence cursorIdx is always included. Cut at sentence boundaries.
 */
function shortenSentences(
  sentences: string[],
  cursorIdx: number,
  maxChars: number = 2000
): string {
  if (sentences.length === 0) return "";
  const safeCursorIdx = Math.max(0, Math.min(sentences.length - 1, cursorIdx));

  let chosen = [safeCursorIdx];
  let curLen = sentences[safeCursorIdx].length;

  let left = safeCursorIdx - 1;
  let right = safeCursorIdx + 1;

  while (left >= 0 || right < sentences.length) {
    let added = false;

    // Try adding left
    if (left >= 0) {
      const addedLen = sentences[left].length + 1; // +1 for space
      if (curLen + addedLen <= maxChars) {
        chosen.unshift(left);
        curLen += addedLen;
        left--;
        added = true;
      } else {
        left = -1; // won't fit
      }
    }

    // Try adding right
    if (right < sentences.length) {
      const addedLen = sentences[right].length + 1;
      if (curLen + addedLen <= maxChars) {
        chosen.push(right);
        curLen += addedLen;
        right++;
        added = true;
      } else {
        right = sentences.length; // won't fit
      }
    }

    if (!added) break;
  }

  chosen.sort((a, b) => a - b);
  return chosen.map((idx) => sentences[idx]).join(" ");
}

/**
 * Extracts a passage from note text for related paper retrieval:
 * 1. Use selection if >= 20 characters after clean-up.
 * 2. Otherwise use the section around cursor (between headings) if >= 200 chars.
 * 3. Otherwise use the whole note.
 *
 * Shortening: window of maxChars centred on cursor cut at sentence boundaries.
 * Cursor's own sentence is always included.
 * If total cleaned length < 30 chars, returns null (indicates "write a bit more").
 */
export function extractPassage(
  noteText: string,
  cursorOffset: number,
  selection: string = "",
  maxChars: number = 2000
): string | null {
  // 1. Selection check: at least 20 chars after clean-up wins (R1)
  if (selection) {
    const cleanSel = cleanMarkdown(selection);
    if (cleanSel.length >= 20) {
      const sentences = splitSentences(cleanSel);
      if (sentences.length === 0) return cleanSel.slice(0, maxChars);
      return shortenSentences(sentences, 0, maxChars);
    }
  }

  // 2. Section around cursor check (R2)
  // Find headings: lines starting with #
  const headingRegex = /^#{1,6}\s+.+$/gm;
  let prevHeadingEnd = 0;
  let nextHeadingStart = noteText.length;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(noteText)) !== null) {
    const headingStart = match.index;
    const headingEnd = headingStart + match[0].length;
    if (headingEnd <= cursorOffset) {
      prevHeadingEnd = headingEnd;
    } else if (headingStart > cursorOffset) {
      nextHeadingStart = headingStart;
      break;
    }
  }

  const sectionRaw = noteText.slice(prevHeadingEnd, nextHeadingStart);
  const cleanSec = cleanMarkdown(sectionRaw);

  if (cleanSec.length >= 200) {
    // Section has at least 200 chars after clean-up (R2)
    const sentences = splitSentences(cleanSec);
    if (sentences.length === 0) return cleanSec.slice(0, maxChars);

    // Approximate cursor position within cleaned section
    const relOffset = Math.max(0, cursorOffset - prevHeadingEnd);
    const ratio = sectionRaw.length > 0 ? relOffset / sectionRaw.length : 0.5;
    const approxCleanOffset = Math.floor(ratio * cleanSec.length);

    // Find cursor sentence index
    let cursorSentenceIdx = 0;
    let accumulated = 0;
    for (let i = 0; i < sentences.length; i++) {
      accumulated += sentences[i].length + 1;
      if (accumulated >= approxCleanOffset) {
        cursorSentenceIdx = i;
        break;
      }
    }

    return shortenSentences(sentences, cursorSentenceIdx, maxChars);
  }

  // 3. Whole note fallback
  const cleanWhole = cleanMarkdown(noteText);
  if (cleanWhole.length < 30) {
    // Too short -> null -> "Write a bit more first" state (R5)
    return null;
  }

  const sentences = splitSentences(cleanWhole);
  if (sentences.length === 0) return cleanWhole.slice(0, maxChars);

  // Approximate cursor position within cleaned whole note
  const ratio = noteText.length > 0 ? cursorOffset / noteText.length : 0.5;
  const approxCleanOffset = Math.floor(ratio * cleanWhole.length);

  let cursorSentenceIdx = 0;
  let accumulated = 0;
  for (let i = 0; i < sentences.length; i++) {
    accumulated += sentences[i].length + 1;
    if (accumulated >= approxCleanOffset) {
      cursorSentenceIdx = i;
      break;
    }
  }

  return shortenSentences(sentences, cursorSentenceIdx, maxChars);
}
