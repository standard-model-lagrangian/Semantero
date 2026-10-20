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
}

/**
 * Keyword search over index using BM25.
 * Synchronous, <= 16 ms (Budget B1).
 */
export function keyword(ix: LoadedIndex, query: string, limit: number = 10): Hit[] {
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

    if (chunkWon) {
      const c = ix.chunks[match.bestChunkIndex!];
      snippet = bestSnippet(c.text, tokens).text;
      page = c.page;
      fromAbstract = false;
      attKey = c.attachmentKey;
    } else if (paper.abstract) {
      snippet = bestSnippet(paper.abstract, tokens).text;
      fromAbstract = true;
    } else {
      snippet = bestSnippet(paper.title, tokens).text;
      fromAbstract = true;
    }

    hits.push({
      paper: pIdx,
      score: match.score,
      source: "keyword",
      snippet,
      page,
      attachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
      fromAbstract,
    });
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
  opts?: { limit?: number; exclude?: Set<number>; minScore?: number }
): Hit[] {
  if (!ix.vectors || ix.vectors.length === 0 || ix.totalRows === 0) {
    return [];
  }

  const limit = opts?.limit ?? 10;
  const exclude = opts?.exclude;
  const minScore = opts?.minScore ?? 0;
  const dims = ix.dims;
  const totalRows = ix.totalRows;
  const vectors = ix.vectors;
  const { tokens } = tokenize(query);

  // Per-paper tracking
  const paperMaxScore = new Float32Array(ix.papers.length);
  const paperWinningRow = new Int32Array(ix.papers.length);
  paperWinningRow.fill(-1);

  // Single pass over all rows
  for (let r = 0; r < totalRows; r++) {
    const pIdx = ix.rowToPaper[r];
    if (pIdx < 0) continue;
    if (exclude && exclude.has(pIdx)) continue;

    const offset = r * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) {
      dot += qVec[d] * vectors[offset + d];
    }

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

    let snippet = "";
    let page: number | undefined;
    let fromAbstract = true;
    let attKey: string | undefined;

    if (!isAbstract && winningRow >= 0) {
      const chunkIdx = ix.rowToChunk[winningRow];
      if (chunkIdx >= 0) {
        const c = ix.chunks[chunkIdx];
        snippet = bestSnippet(c.text, tokens).text;
        page = c.page;
        fromAbstract = false;
        attKey = c.attachmentKey;
      }
    } else if (paper.abstract) {
      snippet = bestSnippet(paper.abstract, tokens).text;
      fromAbstract = true;
    } else {
      snippet = bestSnippet(paper.title, tokens).text;
      fromAbstract = true;
    }

    hits.push({
      paper: h.paper,
      score: h.score,
      source: "semantic",
      snippet,
      page,
      attachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
      fromAbstract,
    });
  }

  return hits;
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
    });
  }

  return hits;
}
