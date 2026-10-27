import type { PaperMetadata } from "./bm25.ts";

export interface TriggerResult {
  start: number;
  end: number;
  query: string;
}

export interface SectionCacheLike {
  type: string;
  position: {
    start: { line: number; col?: number; offset?: number };
    end: { line: number; col?: number; offset?: number };
  };
}

/**
 * Searches the line up to the cursor (ch) for the trigger pattern (default "@@").
 * Only the last 160 characters before the cursor are examined.
 */
export function findTrigger(
  lineText: string,
  ch: number,
  trigger: string = "@@"
): TriggerResult | null {
  if (ch < trigger.length) return null;

  // Only examine at most 160 characters before the cursor
  const windowStart = Math.max(0, ch - 160);
  const windowText = lineText.slice(windowStart, ch);

  // Find the last occurrence of the trigger within this window
  const relIdx = windowText.lastIndexOf(trigger);
  if (relIdx === -1) return null;

  const triggerStart = windowStart + relIdx;
  const triggerEnd = triggerStart + trigger.length;

  // Character before trigger must be:
  // start of line, whitespace, or one of ( [ { " '
  if (triggerStart > 0) {
    const prevChar = lineText[triggerStart - 1];
    const isWhitespace = /\s/.test(prevChar);
    const isOpenPunctuation =
      prevChar === "(" ||
      prevChar === "[" ||
      prevChar === "{" ||
      prevChar === '"' ||
      prevChar === "'";

    if (!isWhitespace && !isOpenPunctuation) {
      return null;
    }
  }

  // Extract query from trigger end to cursor
  const query = lineText.slice(triggerEnd, ch);

  // Constraints on the query:
  // - At most 120 characters
  if (query.length > 120) return null;

  // - Query must not contain "]]", the trigger itself, or a tab
  if (query.includes("]]") || query.includes(trigger) || query.includes("\t")) {
    return null;
  }

  // - Query must not start with two spaces ("@@  " is treated as abandoned)
  if (query.startsWith("  ")) {
    return null;
  }

  return {
    start: triggerStart,
    end: ch,
    query,
  };
}

/**
 * Determines whether the cursor at (line, ch) is inside an excluded context:
 * - frontmatter
 * - fenced code block
 * - math block ($$)
 * - inline code (`...`)
 * - inline math ($...$)
 * - unclosed wiki link ([[... or ![[...)
 */
export function isExcludedContext(
  sections: SectionCacheLike[] | undefined,
  line: number,
  lineText: string,
  ch: number
): boolean {
  // 1. Block-level context from sections
  if (sections && sections.length > 0) {
    for (const sec of sections) {
      if (
        sec.position &&
        line >= sec.position.start.line &&
        line <= sec.position.end.line
      ) {
        const type = (sec.type || "").toLowerCase();
        if (
          type === "code" ||
          type === "math" ||
          type === "frontmatter" ||
          type === "yaml"
        ) {
          return true;
        }
      }
    }
  }

  const textBeforeCursor = lineText.slice(0, ch);
  if (!/[`$]|\[\[/.test(textBeforeCursor)) {
    return false;
  }

  // 2. One left-to-right scan. Inside a code span only its closing backtick run counts,
  //    so `$PATH` or `[[x` inside closed code changes nothing.
  let codeRun = 0; // length of the backtick run that opened the current code span, 0 = none
  let inSingleMath = false;
  let inDoubleMath = false;
  let openLinks = 0;
  let i = 0;
  while (i < textBeforeCursor.length) {
    const c = textBeforeCursor[i];

    if (c === "`" && !inSingleMath && !inDoubleMath) {
      let run = 1;
      while (textBeforeCursor[i + run] === "`") run++;
      if (codeRun === 0) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      i += run;
      continue;
    }
    if (codeRun > 0) {
      i++;
      continue;
    }

    if (c === "\\") {
      i += 2; // escaped character, e.g. \$
      continue;
    }

    if (c === "$") {
      if (textBeforeCursor[i + 1] === "$" && !inSingleMath) {
        inDoubleMath = !inDoubleMath;
        i += 2;
        continue;
      }
      if (inSingleMath) {
        inSingleMath = false;
      } else if (!inDoubleMath) {
        // `$` opens inline math only when followed by a non-space, non-digit ($5 is currency).
        const next = lineText[i + 1];
        if (next !== undefined && !/[\s\d]/.test(next)) inSingleMath = true;
      }
      i++;
      continue;
    }

    if (!inSingleMath && !inDoubleMath) {
      if (c === "[" && textBeforeCursor[i + 1] === "[") {
        openLinks++;
        i += 2;
        continue;
      }
      if (c === "]" && textBeforeCursor[i + 1] === "]" && openLinks > 0) {
        openLinks--;
        i += 2;
        continue;
      }
    }
    i++;
  }

  // An unclosed code span, inline/display math or [[ link before the cursor excludes it.
  return codeRun > 0 || inSingleMath || inDoubleMath || openLinks > 0;
}

/**
 * Formats a citation string according to template.
 */
/** The citation inserted by ⌘↵ and `@@` unless the settings say otherwise: a wikilink to the literature note. */
export const DEFAULT_CITATION_FORMAT = "[[{{citekey}}]]";

export function formatCitation(format: string = DEFAULT_CITATION_FORMAT, citekey: string): string {
  if (!format.includes("{{citekey}}") && !format.includes("{{ citekey }}")) {
    throw new Error(`Citation format must contain "{{citekey}}": ${format}`);
  }
  return format.replace(/\{\{\s*citekey\s*\}\}/g, citekey);
}

/**
 * Extracts all cited citekeys from a note's text:
 * - [[citekey]] or [[citekey|alias]]
 * - [@citekey] or [@citekey1; @citekey2]
 * - frontmatter `citekey: key`
 * Code blocks (fenced and inline) are ignored.
 */
export function citedKeys(noteText: string): Set<string> {
  const result = new Set<string>();
  if (!noteText) return result;

  // 1. Remove fenced code blocks
  let stripped = noteText.replace(/```[\s\S]*?```/g, " ");

  // 2. Remove inline code
  stripped = stripped.replace(/`[^`\n]*`/g, " ");

  // 3. Frontmatter citekey
  const fmMatch = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const citekeyMatch = fm.match(/^citekey:\s*["']?([^\s"'\r\n]+)["']?/m);
    if (citekeyMatch && citekeyMatch[1]) {
      result.add(citekeyMatch[1].trim());
    }
  }

  // 4. Wiki links: [[citekey]] or [[citekey|alias]]
  const wikiRegex = /\[\[([a-zA-Z0-9_.-]+)(?:\|[^\]\n]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiRegex.exec(stripped)) !== null) {
    if (match[1]) {
      result.add(match[1].trim());
    }
  }

  // 5. Pandoc citations inside brackets: [@citekey], [@key1; @key2], [-@citekey]
  const bracketRegex = /\[([^\]\n]*@[a-zA-Z0-9_.-]+[^\]\n]*)\]/g;
  while ((match = bracketRegex.exec(stripped)) !== null) {
    const bracketContent = match[1];
    const keyRegex = /@([a-zA-Z0-9_.-]+)/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRegex.exec(bracketContent)) !== null) {
      if (keyMatch[1]) {
        result.add(keyMatch[1].trim());
      }
    }
  }

  return result;
}
