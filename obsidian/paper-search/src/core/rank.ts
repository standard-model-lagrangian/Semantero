import { tokenize } from "./text.ts";

/** Embed a query of `minChars` or more, or of two words once the last one counts for keyword search too (3+
 * characters or a digit, as in bm25.ts). Trailing spaces never change the answer. */
export function shouldRunSemantic(query: string, minChars: number = 12): boolean {
  if (semanticText(query).length >= minChars) {
    return true;
  }
  const { tokens, lastIncomplete } = tokenize(query);
  const last = tokens[tokens.length - 1] ?? "";
  const lastCounts = !lastIncomplete || last.length >= 3 || /\d/.test(last);
  return (lastCounts ? tokens.length : tokens.length - 1) >= 2;
}

/** The query as it is embedded: surrounding whitespace dropped and runs of whitespace made one space, so a trailing
 * or doubled space gives the same vector. */
export function semanticText(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

/** One item of a rank fusion: its fused score and, per input list, the item from that list (undefined if absent). */
export interface Fused<T> {
  score: number;
  from: (T | undefined)[];
}

/**
 * Reciprocal rank fusion: an item scores the sum of 1 / (k + rank) over the lists it is in (ranks from 1), so an item
 * in one list still ranks. Items are identified by `key`; best first, ties in the order the items were first seen
 * (first list first). The one implementation for the plugin (engine.hybrid) and the launcher (merge.rrf).
 */
export function reciprocalRankFusion<T, K>(lists: T[][], key: (item: T) => K, k: number = 60): Fused<T>[] {
  const byKey = new Map<K, Fused<T>>();
  lists.forEach((list, li) => {
    list.forEach((item, i) => {
      const id = key(item);
      let f = byKey.get(id);
      if (!f) byKey.set(id, (f = { score: 0, from: new Array(lists.length).fill(undefined) }));
      f.score += 1 / (k + i + 1);
      f.from[li] = item;
    });
  });
  // Array.prototype.sort is stable: equal scores keep first-seen order.
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}
