import { tokenize } from "./text.ts";

export interface PaperMetadata {
  key: string;
  citekey: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  doi: string | null;
  tags: string[];
  collections: string[];
  abstract: string | null;
  pdfs?: { attachmentKey: string; pages: number; hasText: boolean }[];
  abstractRow?: number | null;
}

export interface ChunkDocument {
  paper: number; // index into papers
  attachmentKey: string;
  page: number;
  text: string;
  row?: number;
}

export interface BM25SearchResult {
  paperIndex: number;
  score: number;
  metadataScore: number;
  bestChunkScore: number;
  bestChunkIndex?: number;
}

const FIELD_WEIGHTS: Record<string, number> = {
  title: 3.0,
  authors: 3.0,
  citekey: 3.0,
  journal: 1.0,
  tags: 2.0,
  collections: 2.0,
  abstract: 1.5,
};

interface TermPostingPaper {
  paperIndex: number;
  score: number;
}

interface TermPostingChunk {
  chunkIndex: number;
  paperIndex: number;
  score: number;
}

export class BM25Index {
  private k1: number = 1.2;
  private b: number = 0.75;

  private papers: PaperMetadata[];
  private chunks: ChunkDocument[];

  // Vocabulary of all terms across index
  private vocab: Set<string> = new Set();
  private sortedVocab: string[] = [];

  // Document frequencies: term -> count of docs containing term
  private df: Map<string, number> = new Map();
  private totalDocs: number = 0;

  // Average lengths
  private avgFieldLengths: Map<string, number> = new Map();
  private avgChunkLength: number = 0;

  // Inverted postings: term -> postings
  private paperPostings: Map<string, TermPostingPaper[]> = new Map();
  private chunkPostings: Map<string, TermPostingChunk[]> = new Map();

  // Reusable typed arrays for search to avoid GC pauses
  private paperScoresBuf: Float64Array;
  private chunkScoresBuf: Float64Array;
  private bestChunkScoreBuf: Float64Array;
  private bestChunkIndexBuf: Int32Array;

  constructor(papers: PaperMetadata[], chunks: ChunkDocument[]) {
    this.papers = papers;
    this.chunks = chunks;

    this.paperScoresBuf = new Float64Array(this.papers.length);
    this.chunkScoresBuf = new Float64Array(this.chunks.length);
    this.bestChunkScoreBuf = new Float64Array(this.papers.length);
    this.bestChunkIndexBuf = new Int32Array(this.papers.length);

    this.build();
  }

  private build() {
    this.totalDocs = this.papers.length + this.chunks.length;

    // 1. Process papers
    const totalFieldLengths: Record<string, number> = {
      title: 0,
      authors: 0,
      citekey: 0,
      journal: 0,
      tags: 0,
      collections: 0,
      abstract: 0,
    };

    const paperFieldTerms: Map<string, Map<string, number>>[] = [];
    const paperFieldLengths: Map<string, number>[] = [];

    for (const paper of this.papers) {
      const fieldTerms = new Map<string, Map<string, number>>();
      const fieldLengths = new Map<string, number>();
      const paperDistinctTerms = new Set<string>();

      const fields: Record<string, string> = {
        title: paper.title || "",
        authors: paper.authors.join(" "),
        citekey: paper.citekey || "",
        journal: paper.journal || "",
        tags: paper.tags.join(" "),
        collections: paper.collections.join(" "),
        abstract: paper.abstract || "",
      };

      for (const [fName, fText] of Object.entries(fields)) {
        const { tokens } = tokenize(fText);
        const termFreqs = new Map<string, number>();
        for (const t of tokens) {
          termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
          paperDistinctTerms.add(t);
          this.vocab.add(t);
        }
        fieldTerms.set(fName, termFreqs);
        fieldLengths.set(fName, tokens.length);
        totalFieldLengths[fName] += tokens.length;
      }

      for (const t of paperDistinctTerms) {
        this.df.set(t, (this.df.get(t) || 0) + 1);
      }

      paperFieldTerms.push(fieldTerms);
      paperFieldLengths.push(fieldLengths);
    }

    const numPapers = Math.max(1, this.papers.length);
    for (const [fName, totalLen] of Object.entries(totalFieldLengths)) {
      this.avgFieldLengths.set(fName, totalLen / numPapers);
    }

    // 2. Process chunks
    let totalChunkLen = 0;
    const chunkTermsList: Map<string, number>[] = [];
    const chunkLengthsList: number[] = [];

    for (const chunk of this.chunks) {
      const { tokens } = tokenize(chunk.text);
      const termFreqs = new Map<string, number>();
      const chunkDistinctTerms = new Set<string>();

      for (const t of tokens) {
        termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
        chunkDistinctTerms.add(t);
        this.vocab.add(t);
      }

      for (const t of chunkDistinctTerms) {
        this.df.set(t, (this.df.get(t) || 0) + 1);
      }

      chunkTermsList.push(termFreqs);
      chunkLengthsList.push(tokens.length);
      totalChunkLen += tokens.length;
    }

    this.avgChunkLength = this.chunks.length > 0 ? totalChunkLen / this.chunks.length : 1;

    // 3. Build sorted vocabulary
    this.sortedVocab = Array.from(this.vocab).sort();

    // 4. Precompute inverted postings
    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      const fieldTerms = paperFieldTerms[pIdx];
      const fieldLens = paperFieldLengths[pIdx];

      // Collect all terms in this paper
      const paperTerms = new Set<string>();
      for (const freqs of fieldTerms.values()) {
        for (const t of freqs.keys()) {
          paperTerms.add(t);
        }
      }

      for (const term of paperTerms) {
        const idfVal = this.idf(term);
        let score = 0;
        for (const [fName, weight] of Object.entries(FIELD_WEIGHTS)) {
          const freqs = fieldTerms.get(fName);
          const tf = freqs ? freqs.get(term) || 0 : 0;
          if (tf > 0) {
            const docLen = fieldLens.get(fName) || 0;
            const avgLen = this.avgFieldLengths.get(fName) || 1;
            score += weight * this.scoreTerm(tf, docLen, avgLen, idfVal);
          }
        }

        if (score > 0) {
          let list = this.paperPostings.get(term);
          if (!list) {
            list = [];
            this.paperPostings.set(term, list);
          }
          list.push({ paperIndex: pIdx, score });
        }
      }
    }

    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      const termFreqs = chunkTermsList[cIdx];
      const docLen = chunkLengthsList[cIdx];
      const pIdx = this.chunks[cIdx].paper;

      for (const [term, tf] of termFreqs.entries()) {
        if (tf > 0) {
          const idfVal = this.idf(term);
          const score = this.scoreTerm(tf, docLen, this.avgChunkLength, idfVal);
          if (score > 0) {
            let list = this.chunkPostings.get(term);
            if (!list) {
              list = [];
              this.chunkPostings.set(term, list);
            }
            list.push({ chunkIndex: cIdx, paperIndex: pIdx, score });
          }
        }
      }
    }
  }

  public idf(term: string): number {
    const docFreq = this.df.get(term) || 0;
    // BM25 standard non-negative IDF: ln(1 + (N - df + 0.5) / (df + 0.5))
    return Math.log(1 + (this.totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  }

  private scoreTerm(tf: number, docLen: number, avgDocLen: number, idfVal: number): number {
    if (tf <= 0) return 0;
    const numerator = tf * (this.k1 + 1);
    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / Math.max(1, avgDocLen)));
    return idfVal * (numerator / denominator);
  }

  public findPrefixRange(prefix: string): [number, number] {
    const V = this.sortedVocab;
    let l = 0;
    let r = V.length;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (V[m] < prefix) {
        l = m + 1;
      } else {
        r = m;
      }
    }
    const start = l;

    l = start;
    r = V.length;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (V[m].startsWith(prefix)) {
        l = m + 1;
      } else {
        r = m;
      }
    }
    const end = l;
    return [start, end];
  }

  public search(query: string, limit?: number): BM25SearchResult[] {
    const { tokens, lastIncomplete } = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    // Resolve query tokens (handling incomplete prefix matching for last token)
    const termMatchers: { isPrefix: boolean; matchingTerms: string[] }[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;

      if (isLast && lastIncomplete) {
        if (t.length < 3) {
          // An unfinished word shorter than 3 characters is ignored,
          // unless it's a complete vocabulary term on its own ("il", "3d")
          if (this.df.has(t)) {
            termMatchers.push({ isPrefix: false, matchingTerms: [t] });
          }
          // otherwise ignored
        } else {
          // 3 or more chars: binary search prefix range in sorted vocabulary
          const [start, end] = this.findPrefixRange(t);
          const matchCount = end - start;
          if (matchCount > 0) {
            if (matchCount <= 64) {
              termMatchers.push({
                isPrefix: true,
                matchingTerms: this.sortedVocab.slice(start, end),
              });
            } else {
              // At most 64 expansions, keep highest document frequency
              const candidates: string[] = this.sortedVocab.slice(start, end);
              candidates.sort((a, b) => {
                const dfDiff = (this.df.get(b) || 0) - (this.df.get(a) || 0);
                if (dfDiff !== 0) return dfDiff;
                return a < b ? -1 : a > b ? 1 : 0;
              });
              termMatchers.push({
                isPrefix: true,
                matchingTerms: candidates.slice(0, 64),
              });
            }
          } else {
            // No prefix matches in vocabulary
            termMatchers.push({ isPrefix: true, matchingTerms: [] });
          }
        }
      } else {
        termMatchers.push({ isPrefix: false, matchingTerms: [t] });
      }
    }

    if (termMatchers.length === 0) {
      return [];
    }

    // Reset reusable score buffers
    this.paperScoresBuf.fill(0);
    this.chunkScoresBuf.fill(0);
    this.bestChunkScoreBuf.fill(0);
    this.bestChunkIndexBuf.fill(-1);

    // Track papers/chunks with non-zero scores for this matcher
    const matcherPaperScores = new Map<number, number>();
    const matcherChunkScores = new Map<number, number>();

    for (const matcher of termMatchers) {
      matcherPaperScores.clear();
      matcherChunkScores.clear();

      for (const term of matcher.matchingTerms) {
        const pPostings = this.paperPostings.get(term);
        if (pPostings) {
          for (let i = 0; i < pPostings.length; i++) {
            const p = pPostings[i];
            const prev = matcherPaperScores.get(p.paperIndex) || 0;
            if (p.score > prev) {
              matcherPaperScores.set(p.paperIndex, p.score);
            }
          }
        }

        const cPostings = this.chunkPostings.get(term);
        if (cPostings) {
          for (let i = 0; i < cPostings.length; i++) {
            const c = cPostings[i];
            const prev = matcherChunkScores.get(c.chunkIndex) || 0;
            if (c.score > prev) {
              matcherChunkScores.set(c.chunkIndex, c.score);
            }
          }
        }
      }

      // Accumulate matcher scores
      for (const [pIdx, score] of matcherPaperScores.entries()) {
        this.paperScoresBuf[pIdx] += score;
      }
      for (const [cIdx, score] of matcherChunkScores.entries()) {
        this.chunkScoresBuf[cIdx] += score;
      }
    }

    // Aggregate chunk scores per paper: best chunk score
    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      const s = this.chunkScoresBuf[cIdx];
      if (s <= 0) continue;
      const pIdx = this.chunks[cIdx].paper;
      if (s > this.bestChunkScoreBuf[pIdx]) {
        this.bestChunkScoreBuf[pIdx] = s;
        this.bestChunkIndexBuf[pIdx] = cIdx;
      }
    }

    // Build final results: score = Math.max(metadataScore, bestChunkScore)
    const results: BM25SearchResult[] = [];

    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      const mScore = this.paperScoresBuf[pIdx];
      const cScore = this.bestChunkScoreBuf[pIdx];
      const finalScore = Math.max(mScore, cScore);

      if (finalScore > 0) {
        results.push({
          paperIndex: pIdx,
          score: finalScore,
          metadataScore: mScore,
          bestChunkScore: cScore,
          bestChunkIndex: cScore > 0 ? this.bestChunkIndexBuf[pIdx] : undefined,
        });
      }
    }

    // Rank results
    // Partial top-k: if limit is provided, keep limit * 4 candidates before final slice
    if (limit !== undefined && results.length > limit * 4) {
      // Sort and take top limit * 4
      results.sort((a, b) => b.score - a.score || a.paperIndex - b.paperIndex);
      return results.slice(0, limit);
    }

    results.sort((a, b) => b.score - a.score || a.paperIndex - b.paperIndex);
    if (limit !== undefined) {
      return results.slice(0, limit);
    }
    return results;
  }
}
