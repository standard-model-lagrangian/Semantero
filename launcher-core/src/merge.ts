import type { Hit } from "../../obsidian/paper-search/src/core/engine.ts";
import { reciprocalRankFusion } from "../../obsidian/paper-search/src/core/rank.ts";
import type { Corpora, CorpusName } from "./corpora.ts";

/** A hit, tagged with the corpus its `paper` index refers to. */
export interface CHit {
  corpus: CorpusName;
  hit: Hit;
}

/** One result row: a paper, a note, or a paper collapsed with its literature note. */
export interface Row {
  paper?: CHit;
  note?: CHit;
  /** Whose text and action the row shows: the one that ranked higher. */
  winner: "paper" | "note";
}

const order = (c: CorpusName) => (c === "papers" ? 0 : 1);

/** P1, N1, P2, N2, …: papers first on equal rank; the longer list's rest follows. */
export function interleave<T>(papers: T[], notes: T[]): T[] {
  const out: T[] = [];
  const n = Math.max(papers.length, notes.length);
  for (let i = 0; i < n; i++) {
    if (i < papers.length) out.push(papers[i]);
    if (i < notes.length) out.push(notes[i]);
  }
  return out;
}

/** Raw cosine scores are comparable across corpora (same model, same query vector). */
export function sortByCosine(list: CHit[]): CHit[] {
  return [...list].sort(
    (a, b) => b.hit.score - a.hit.score || order(a.corpus) - order(b.corpus) || a.hit.paper - b.hit.paper
  );
}

const keyOf = (c: CHit) => `${c.corpus}:${c.hit.paper}`;

/** Reciprocal rank fusion of the keyword and semantic lists (rank.ts). An item in one list still ranks. */
export function rrf(kw: CHit[], sem: CHit[], k: number = 60): CHit[] {
  if (sem.length === 0) return kw;
  if (kw.length === 0) return sem;
  return reciprocalRankFusion([kw, sem], keyOf, k).map(({ score, from: [w, s] }) => {
    const base = (s ?? w)!;
    const source: Hit["source"] = s && w ? "both" : s ? "semantic" : "keyword";
    return { corpus: base.corpus, hit: { ...base.hit, score, source } };
  });
}

/**
 * A paper and its literature note become one row, at the position of whichever ranked higher; that one
 * is the winner (its snippet and action show). A literature note whose paper is not in the list stays a
 * note row.
 */
export function collapseLitnotes(list: CHit[], corpora: Corpora): Row[] {
  const rows: Row[] = [];
  const byCitekey = new Map<string, Row>();
  for (const item of list) {
    let link: string | null = null;
    if (item.corpus === "papers") {
      link = corpora.papers?.ix.papers[item.hit.paper]?.citekey || null;
    } else {
      link = corpora.notes?.ix.papers[item.hit.paper]?.litnoteOf ?? null;
    }
    const existing = link ? byCitekey.get(link) : undefined;
    if (existing) {
      if (item.corpus === "papers" && !existing.paper) existing.paper = item;
      else if (item.corpus === "notes" && !existing.note) existing.note = item;
      continue;
    }
    const row: Row = item.corpus === "papers" ? { paper: item, winner: "paper" } : { note: item, winner: "note" };
    rows.push(row);
    if (link) byCitekey.set(link, row);
  }
  // A "paper" row's litnote may exist without being in the list; the view model looks it up in the corpus.
  return rows;
}
