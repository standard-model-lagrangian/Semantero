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
}

export interface ChunkDocument {
  paper: number; // index into papers
  attachmentKey: string;
  page: number;
  text: string;
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

export class BM25Index {
  private k1: number = 1.2;
  private b: number = 0.75;

  private papers: PaperMetadata[];
  private chunks: ChunkDocument[];

  // Vocabulary of all terms across index
  private vocab: Set<string> = new Set();

  // Document frequencies: term -> count of docs containing term
  private df: Map<string, number> = new Map();
  private totalDocs: number = 0;

  // Metadata field token counts and lengths
  // paperIndex -> fieldName -> Map<term, freq>
  private paperFieldTerms: Map<string, Map<string, number>>[] = [];
  private paperFieldLengths: Map<string, number>[] = [];
  private avgFieldLengths: Map<string, number> = new Map();

  // Chunk token counts and lengths
  private chunkTerms: Map<string, number>[] = [];
  private chunkLengths: number[] = [];
  private avgChunkLength: number = 0;

  constructor(papers: PaperMetadata[], chunks: ChunkDocument[]) {
    this.papers = papers;
    this.chunks = chunks;
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

      this.paperFieldTerms.push(fieldTerms);
      this.paperFieldLengths.push(fieldLengths);
    }

    const numPapers = Math.max(1, this.papers.length);
    for (const [fName, totalLen] of Object.entries(totalFieldLengths)) {
      this.avgFieldLengths.set(fName, totalLen / numPapers);
    }

    // 2. Process chunks
    let totalChunkLen = 0;
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

      this.chunkTerms.push(termFreqs);
      this.chunkLengths.push(tokens.length);
      totalChunkLen += tokens.length;
    }

    this.avgChunkLength = this.chunks.length > 0 ? totalChunkLen / this.chunks.length : 1;
  }

  private idf(term: string): number {
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

  public search(query: string): BM25SearchResult[] {
    const { tokens, lastIncomplete } = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    // Resolve query tokens (handling incomplete prefix matching for last token)
    const termMatchers: { isPrefix: boolean; prefixToken?: string; exactToken?: string; matchingTerms: string[] }[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;
      if (isLast && lastIncomplete) {
        const matches: string[] = [];
        for (const v of this.vocab) {
          if (v.startsWith(t)) {
            matches.push(v);
          }
        }
        termMatchers.push({ isPrefix: true, prefixToken: t, matchingTerms: matches });
      } else {
        termMatchers.push({ isPrefix: false, exactToken: t, matchingTerms: [t] });
      }
    }

    // Score paper metadata
    const paperScores: number[] = new Array(this.papers.length).fill(0);

    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      let metaScore = 0;
      const fieldTerms = this.paperFieldTerms[pIdx];
      const fieldLens = this.paperFieldLengths[pIdx];

      for (const matcher of termMatchers) {
        // Find best score among matching terms for this matcher across fields
        let bestMatcherScore = 0;

        for (const term of matcher.matchingTerms) {
          const idfVal = this.idf(term);
          let termScore = 0;

          for (const [fName, weight] of Object.entries(FIELD_WEIGHTS)) {
            const freqs = fieldTerms.get(fName);
            const tf = freqs ? freqs.get(term) || 0 : 0;
            if (tf > 0) {
              const docLen = fieldLens.get(fName) || 0;
              const avgLen = this.avgFieldLengths.get(fName) || 1;
              termScore += weight * this.scoreTerm(tf, docLen, avgLen, idfVal);
            }
          }

          if (termScore > bestMatcherScore) {
            bestMatcherScore = termScore;
          }
        }

        metaScore += bestMatcherScore;
      }

      paperScores[pIdx] = metaScore;
    }

    // Score chunks
    const chunkScores: number[] = new Array(this.chunks.length).fill(0);

    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      let cScore = 0;
      const termFreqs = this.chunkTerms[cIdx];
      const docLen = this.chunkLengths[cIdx];

      for (const matcher of termMatchers) {
        let bestMatcherScore = 0;

        for (const term of matcher.matchingTerms) {
          const tf = termFreqs.get(term) || 0;
          if (tf > 0) {
            const idfVal = this.idf(term);
            const s = this.scoreTerm(tf, docLen, this.avgChunkLength, idfVal);
            if (s > bestMatcherScore) {
              bestMatcherScore = s;
            }
          }
        }

        cScore += bestMatcherScore;
      }

      chunkScores[cIdx] = cScore;
    }

    // Aggregate chunk scores per paper: best chunk score
    const bestChunkPerPaper = new Map<number, { score: number; chunkIdx: number }>();
    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      const s = chunkScores[cIdx];
      const pIdx = this.chunks[cIdx].paper;
      const cur = bestChunkPerPaper.get(pIdx);
      if (!cur || s > cur.score) {
        bestChunkPerPaper.set(pIdx, { score: s, chunkIdx: cIdx });
      }
    }

    // Build final results: score = Math.max(metadataScore, bestChunkScore)
    const results: BM25SearchResult[] = [];

    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      const mScore = paperScores[pIdx];
      const bestChunk = bestChunkPerPaper.get(pIdx) || { score: 0, chunkIdx: -1 };
      const cScore = bestChunk.score;
      const finalScore = Math.max(mScore, cScore);

      if (finalScore > 0) {
        results.push({
          paperIndex: pIdx,
          score: finalScore,
          metadataScore: mScore,
          bestChunkScore: cScore,
          bestChunkIndex: bestChunk.chunkIdx >= 0 ? bestChunk.chunkIdx : undefined,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
