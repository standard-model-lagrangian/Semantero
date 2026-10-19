import { tokenize } from "./text.ts";

export interface ScoredPaper {
  paperIndex: number;
  score: number;
  winningRow?: number;
  isAbstract?: boolean;
}

export interface PaperRowRef {
  abstractRow: number | null;
  chunkRows: number[];
}

export function shouldRunSemantic(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length >= 12) {
    return true;
  }
  const { tokens, lastIncomplete } = tokenize(query);
  const completeTokens = lastIncomplete ? tokens.length - 1 : tokens.length;
  return completeTokens >= 2;
}

export function scorePaperSemantic(
  paper: PaperRowRef,
  rowScores: Map<number, number>
): { score: number; winningRow: number | null; isAbstract: boolean } {
  let bestScore = -Infinity;
  let winningRow: number | null = null;
  let isAbstract = false;

  if (paper.abstractRow !== null && paper.abstractRow !== undefined) {
    const s = rowScores.get(paper.abstractRow);
    if (s !== undefined && s > bestScore) {
      bestScore = s;
      winningRow = paper.abstractRow;
      isAbstract = true;
    }
  }

  for (const cRow of paper.chunkRows) {
    const s = rowScores.get(cRow);
    if (s !== undefined && s > bestScore) {
      bestScore = s;
      winningRow = cRow;
      isAbstract = false;
    }
  }

  return {
    score: bestScore === -Infinity ? 0 : bestScore,
    winningRow,
    isAbstract,
  };
}

export function mergeRRF(rankedLists: number[][], k: number = 60): ScoredPaper[] {
  const rrfScores = new Map<number, number>();

  for (const list of rankedLists) {
    for (let rank = 1; rank <= list.length; rank++) {
      const pIdx = list[rank - 1];
      const cur = rrfScores.get(pIdx) || 0;
      rrfScores.set(pIdx, cur + 1.0 / (k + rank));
    }
  }

  const results: ScoredPaper[] = [];
  for (const [pIdx, score] of rrfScores.entries()) {
    results.push({ paperIndex: pIdx, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function maintainSelection(
  prevSelectedPaper: number | null,
  newList: ScoredPaper[],
  limit: number = 12
): number {
  if (prevSelectedPaper === null || newList.length === 0) {
    return 0;
  }
  const topSlice = newList.slice(0, limit);
  const idx = topSlice.findIndex((p) => p.paperIndex === prevSelectedPaper);
  return idx >= 0 ? idx : 0;
}

export class SemanticCoordinator {
  private currentSeq: number = 0;

  public newRequest(): { seq: number } {
    this.currentSeq += 1;
    return { seq: this.currentSeq };
  }

  public isCurrent(seq: number): boolean {
    return seq === this.currentSeq;
  }

  public async runSemantic<T>(
    query: string,
    embedFn: (q: string) => Promise<T>
  ): Promise<{ semanticAvailable: boolean; scores: T | null }> {
    try {
      const scores = await embedFn(query);
      return { semanticAvailable: true, scores };
    } catch {
      return { semanticAvailable: false, scores: null };
    }
  }
}
