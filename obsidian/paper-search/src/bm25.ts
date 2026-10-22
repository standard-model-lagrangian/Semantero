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
  /** `file` (added for the launcher): relative to the Zotero storage folder, or absolute for a linked file. */
  pdfs?: { attachmentKey: string; pages: number; hasText: boolean; file?: string }[];
  /** Web snapshots (text/html attachments); their chunks have page 0. */
  snapshots?: { attachmentKey: string; hasText: boolean; file?: string }[];
  abstractRow?: number | null;
  /** Notes corpus only (the launcher): what kind of note, where it lives, when it changed. */
  kind?: "note" | "daily" | "litnote";
  path?: string;
  mtime?: number;
  litnoteOf?: string | null;
}

export interface ChunkDocument {
  paper: number; // index into papers
  attachmentKey: string;
  page: number; // 1-based PDF page; 0 for a web snapshot
  text: string;
  row?: number;
  /** Notes corpus only: heading path of the section ("Materials › EHS") and its 1-based start line. */
  heading?: string;
  line?: number;
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

/** Postings of one term as parallel typed arrays: a few objects per term instead of one per posting
 * (a library has a million of them, and JavaScriptCore needs ~700 bytes of heap per posting-object chain). */
interface PostingList {
  /** paper index (paper postings) or chunk index (chunk postings; the paper is `chunks[i].paper`) */
  ids: Int32Array;
  scores: Float64Array;
}

interface PostingBuilder {
  ids: number[];
  scores: number[];
}

function freeze(builders: Map<string, PostingBuilder>): Map<string, PostingList> {
  const out = new Map<string, PostingList>();
  for (const [term, b] of builders) out.set(term, { ids: Int32Array.from(b.ids), scores: Float64Array.from(b.scores) });
  return out;
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
  private paperPostings: Map<string, PostingList> = new Map();
  private chunkPostings: Map<string, PostingList> = new Map();

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

      // Two hash operations per token (the index is built on every launch, and JavaScriptCore pays for each).
      for (const t of tokens) {
        termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
      }
      for (const t of termFreqs.keys()) {
        this.df.set(t, (this.df.get(t) || 0) + 1);
      }

      chunkTermsList.push(termFreqs);
      chunkLengthsList.push(tokens.length);
      totalChunkLen += tokens.length;
    }

    this.avgChunkLength = this.chunks.length > 0 ? totalChunkLen / this.chunks.length : 1;

    // 3. Build sorted vocabulary: every term of every paper and chunk has a document frequency
    this.sortedVocab = Array.from(this.df.keys()).sort();
    this.vocab = new Set(this.sortedVocab);

    // 4. Precompute inverted postings
    const paperBuild = new Map<string, PostingBuilder>();
    const chunkBuild = new Map<string, PostingBuilder>();
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
          let list = paperBuild.get(term);
          if (!list) {
            list = { ids: [], scores: [] };
            paperBuild.set(term, list);
          }
          list.ids.push(pIdx);
          list.scores.push(score);
        }
      }
    }

    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      const termFreqs = chunkTermsList[cIdx];
      const docLen = chunkLengthsList[cIdx];

      for (const [term, tf] of termFreqs.entries()) {
        if (tf > 0) {
          const idfVal = this.idf(term);
          const score = this.scoreTerm(tf, docLen, this.avgChunkLength, idfVal);
          if (score > 0) {
            let list = chunkBuild.get(term);
            if (!list) {
              list = { ids: [], scores: [] };
              chunkBuild.set(term, list);
            }
            list.ids.push(cIdx);
            list.scores.push(score);
          }
        }
      }
    }
    this.paperPostings = freeze(paperBuild);
    this.chunkPostings = freeze(chunkBuild);
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
          // An unfinished word shorter than 3 characters is ignored, unless it contains a digit
          // and is a vocabulary term ("3d", "6"). Letters-only terms like "s", "c", "il" exist in the
          // vocabulary (from "cell's" etc.) and would match most of the library on the first keystroke.
          if (/\d/.test(t) && this.df.has(t)) {
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
          const { ids, scores } = pPostings;
          for (let i = 0; i < ids.length; i++) {
            const prev = matcherPaperScores.get(ids[i]) || 0;
            if (scores[i] > prev) {
              matcherPaperScores.set(ids[i], scores[i]);
            }
          }
        }

        const cPostings = this.chunkPostings.get(term);
        if (cPostings) {
          const { ids, scores } = cPostings;
          for (let i = 0; i < ids.length; i++) {
            const prev = matcherChunkScores.get(ids[i]) || 0;
            if (scores[i] > prev) {
              matcherChunkScores.set(ids[i], scores[i]);
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
