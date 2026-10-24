import { BM25Index, type PaperMetadata, type ChunkDocument } from "./bm25.ts";
import { tokenize, bestSnippet } from "./text.ts";

export interface LoadedIndex {
  id?: string | number; // index identity for atomic swap verification
  manifest: any;
  papers: PaperMetadata[];
  chunks: (ChunkDocument & { row?: number })[];
  vectors: Float32Array | null;
  dims: number;
  totalRows: number;
  rowToChunk: Int32Array; // row -> chunkIndex (or -1 if row is abstract)
  rowToPaper: Int32Array; // row -> paperIndex
  rowIsAbstract: Uint8Array; // row -> 1 if abstract, 0 if chunk
  paperAbstractRow: Int32Array; // paperIndex -> abstractRow (or -1)
  paperChunkRows: Int32Array[]; // paperIndex -> Int32Array of chunk row indices
  bm25: BM25Index;
}

export interface Hit {
  paper: number;
  score: number;
  source: "keyword" | "semantic" | "both";
  snippet: string;
  page?: number;
  attachmentKey?: string;
  fromAbstract: boolean;
  chunkIndex?: number; // winning chunk, so a snippet can be built later (undefined = abstract/title)
}

export interface SearchOptions {
  /** false: rank only, leave snippet "" (build later with fillSnippets). Default true. */
  snippets?: boolean;
}

/** The snippet for a hit: from its winning chunk, else the abstract, else the title. */
function snippetFor(ix: LoadedIndex, hit: Hit, tokens: string[]): string {
  if (hit.chunkIndex !== undefined && hit.chunkIndex >= 0) return bestSnippet(ix.chunks[hit.chunkIndex].text, tokens).text;
  const paper = ix.papers[hit.paper];
  return bestSnippet(paper.abstract || paper.title, tokens).text;
}

export function fillSnippets(ix: LoadedIndex, hits: Hit[], query: string): Hit[] {
  const { tokens } = tokenize(query);
  for (const h of hits) if (!h.snippet) h.snippet = snippetFor(ix, h, tokens);
  return hits;
}

/**
 * Keyword search over index using BM25.
 * Synchronous, <= 16 ms (Budget B1).
 */
export function keyword(ix: LoadedIndex, query: string, limit: number = 10, opts?: SearchOptions): Hit[] {
  const withSnippets = opts?.snippets !== false;
  const { tokens } = tokenize(query);
  const keywordRes = ix.bm25.search(query, limit);
  const hits: Hit[] = [];

  for (let i = 0; i < keywordRes.length && i < limit; i++) {
    const match = keywordRes[i];
    const pIdx = match.paperIndex;
    const paper = ix.papers[pIdx];

    let snippet = "";
    let page: number | undefined;
    let fromAbstract = true;
    let attKey: string | undefined;

    const chunkWon =
      match.bestChunkScore > match.metadataScore &&
      match.bestChunkIndex !== undefined &&
      match.bestChunkIndex >= 0;

    let chunkIndex: number | undefined;
    if (chunkWon) {
      const c = ix.chunks[match.bestChunkIndex!];
      chunkIndex = match.bestChunkIndex!;
      page = c.page;
      fromAbstract = false;
      attKey = c.attachmentKey;
    }

    const hit: Hit = {
      paper: pIdx,
      score: match.score,
      source: "keyword",
      snippet,
      page,
      attachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
      fromAbstract,
      chunkIndex,
    };
    if (withSnippets) hit.snippet = snippetFor(ix, hit, tokens);
    hits.push(hit);
  }

  return hits;
}

/**
 * Dot product of the query vector with every row. Rows of excluded papers are skipped (left at 0).
 * Returns null when there is nothing to compare: no vectors, or a query embedded with other dims.
 * Float64 on purpose: dot products are summed in doubles, and Float32 rounding would merge close scores.
 */
export function rowScores(ix: LoadedIndex, qVec: Float32Array, exclude?: Set<number>): Float64Array | null {
  if (!ix.vectors || ix.vectors.length === 0 || ix.totalRows === 0) return null;
  if (qVec.length !== ix.dims) return null;
  const { dims, totalRows, vectors } = ix;
  const scores = new Float64Array(totalRows);
  for (let r = 0; r < totalRows; r++) {
    if (exclude && exclude.has(ix.rowToPaper[r])) continue;
    const offset = r * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += qVec[d] * vectors[offset + d];
    scores[r] = dot;
  }
  return scores;
}

/**
 * Semantic search from precomputed row scores (from `rowScores`, or a native scorer such as Accelerate):
 * per-paper maximum, winning row, top-k and snippets. No full sort of all rows.
 */
export function semanticFromRowScores(
  ix: LoadedIndex,
  scores: ArrayLike<number>,
  query: string,
  opts?: { limit?: number; exclude?: Set<number>; minScore?: number } & SearchOptions
): Hit[] {
  const withSnippets = opts?.snippets !== false;
  if (ix.totalRows === 0 || scores.length < ix.totalRows) return [];

  const limit = opts?.limit ?? 10;
  const exclude = opts?.exclude;
  const minScore = opts?.minScore ?? 0;
  const totalRows = ix.totalRows;
  const { tokens } = tokenize(query);

  const paperMaxScore = new Float64Array(ix.papers.length);
  const paperWinningRow = new Int32Array(ix.papers.length);
  paperWinningRow.fill(-1);

  for (let r = 0; r < totalRows; r++) {
    const pIdx = ix.rowToPaper[r];
    if (pIdx < 0) continue;
    if (exclude && exclude.has(pIdx)) continue;
    const dot = scores[r];
    if (dot > paperMaxScore[pIdx]) {
      paperMaxScore[pIdx] = dot;
      paperWinningRow[pIdx] = r;
    }
  }

  // Filter and collect candidate papers
  const candidates: { paper: number; score: number; winningRow: number }[] = [];
  for (let p = 0; p < ix.papers.length; p++) {
    const score = paperMaxScore[p];
    if (score <= 0 || score < minScore) continue;
    if (exclude && exclude.has(p)) continue;
    candidates.push({ paper: p, score, winningRow: paperWinningRow[p] });
  }

  // Sort candidates by score descending, tie-break by paper ascending (E7)
  candidates.sort((a, b) => b.score - a.score || a.paper - b.paper);

  const topHits = candidates.slice(0, limit);
  const hits: Hit[] = [];

  for (let i = 0; i < topHits.length; i++) {
    const h = topHits[i];
    const paper = ix.papers[h.paper];
    const winningRow = h.winningRow;
    const isAbstract = winningRow >= 0 && ix.rowIsAbstract[winningRow] === 1;

    let page: number | undefined;
    let fromAbstract = true;
    let attKey: string | undefined;
    let chunkIndex: number | undefined;
    if (!isAbstract && winningRow >= 0) {
      const chunkIdx = ix.rowToChunk[winningRow];
      if (chunkIdx >= 0) {
        const c = ix.chunks[chunkIdx];
        chunkIndex = chunkIdx;
        page = c.page;
        fromAbstract = false;
        attKey = c.attachmentKey;
      }
    }

    const hit: Hit = {
      paper: h.paper,
      score: h.score,
      source: "semantic",
      snippet: "",
      page,
      attachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
      fromAbstract,
      chunkIndex,
    };
    if (withSnippets) hit.snippet = snippetFor(ix, hit, tokens);
    hits.push(hit);
  }

  return hits;
}

/**
 * Semantic search: one pass over all rows updating paper max scores.
 * No full sort of all rows.
 */
export function semantic(
  ix: LoadedIndex,
  qVec: Float32Array,
  query: string,
  opts?: { limit?: number; exclude?: Set<number>; minScore?: number } & SearchOptions
): Hit[] {
  const scores = rowScores(ix, qVec, opts?.exclude);
  if (!scores) return [];
  return semanticFromRowScores(ix, scores, query, opts);
}

/**
 * Reciprocal Rank Fusion (RRF) merge of keyword and semantic results.
 * Preserves snippet and metadata from winning semantic hit when available,
 * falling back to keyword hit.
 */
export function hybrid(
  keywordHits: Hit[],
  semanticHits: Hit[],
  limit: number = 10,
  k: number = 60
): Hit[] {
  if (keywordHits.length === 0 && semanticHits.length === 0) {
    return [];
  }

  // If one list is empty, return the other directly (E6)
  if (semanticHits.length === 0) {
    return keywordHits.slice(0, limit);
  }
  if (keywordHits.length === 0) {
    return semanticHits.slice(0, limit);
  }

  // RRF: mergeRRF unchanged behaviour from rank.ts
  const rankedLists = [
    keywordHits.map((h) => h.paper),
    semanticHits.map((h) => h.paper),
  ];

  const rrfScores = new Map<number, number>();
  for (const list of rankedLists) {
    for (let rank = 1; rank <= list.length; rank++) {
      const pIdx = list[rank - 1];
      const cur = rrfScores.get(pIdx) || 0;
      rrfScores.set(pIdx, cur + 1.0 / (k + rank));
    }
  }

  const results: { paper: number; rrfScore: number }[] = [];
  for (const [pIdx, score] of rrfScores.entries()) {
    results.push({ paper: pIdx, rrfScore: score });
  }

  // Stable sort preserves Map insertion order for ties
  results.sort((a, b) => b.rrfScore - a.rrfScore);

  const keywordMap = new Map<number, Hit>();
  for (const h of keywordHits) keywordMap.set(h.paper, h);
  const semanticMap = new Map<number, Hit>();
  for (const h of semanticHits) semanticMap.set(h.paper, h);

  const hits: Hit[] = [];
  const top = results.slice(0, limit);

  for (let i = 0; i < top.length; i++) {
    const item = top[i];
    const sHit = semanticMap.get(item.paper);
    const kHit = keywordMap.get(item.paper);

    let source: "keyword" | "semantic" | "both" = "keyword";
    if (sHit && kHit) source = "both";
    else if (sHit) source = "semantic";
    else source = "keyword";

    // Snippet preference matching modal code: semantic hit if present, else keyword hit
    const baseHit = (sHit || kHit)!;

    hits.push({
      paper: item.paper,
      score: item.rrfScore,
      source,
      snippet: baseHit.snippet,
      page: baseHit.page,
      attachmentKey: baseHit.attachmentKey,
      fromAbstract: baseHit.fromAbstract,
      chunkIndex: baseHit.chunkIndex,
    });
  }

  return hits;
}

/**
 * Keyword + semantic merged over the FULL ranked lists (RRF, as the original modal did), with
 * snippets built only for the returned top `limit`. Truncating either list before the merge
 * drops papers that rank well in both but outside one list's top `limit`.
 */
export function hybridSearch(ix: LoadedIndex, query: string, qVec: Float32Array, limit: number): Hit[] {
  return hybridSearchFromScores(ix, query, rowScores(ix, qVec), limit);
}

/** hybridSearch from precomputed row scores (any backend; see semantic.ts). null scores: keyword ranking only. */
export function hybridSearchFromScores(ix: LoadedIndex, query: string, scores: ArrayLike<number> | null, limit: number): Hit[] {
  const n = ix.papers.length;
  const kw = keyword(ix, query, n, { snippets: false });
  const sem = scores ? semanticFromRowScores(ix, scores, query, { limit: n, snippets: false }) : [];
  return fillSnippets(ix, hybrid(kw, sem, limit), query);
}
