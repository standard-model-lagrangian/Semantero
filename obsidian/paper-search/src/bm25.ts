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

/**
 * Inverted postings in compressed-sparse-row form: postings of term t are ids[offsets[t] .. offsets[t+1]) with their
 * scores. A handful of large typed arrays instead of one or two small arrays (and a Map entry) per term: a library has
 * ~65k terms and a million postings, and in JavaScriptCore every small object costs heap, GC time and allocator
 * memory that is slow to be returned (measured: 529k live objects before, see DECISIONS_AND_GAPS.md).
 */
interface Postings {
  offsets: Int32Array; // length V + 1
  ids: Int32Array; // paper index (paper postings) or chunk index (chunk postings; the paper is chunks[i].paper)
  scores: Float64Array;
}

export class BM25Index {
  private k1: number = 1.2;
  private b: number = 0.75;

  private papers: PaperMetadata[];
  private chunks: ChunkDocument[];

  /** Every term, sorted; a term's index here is its id everywhere below. */
  private sortedVocab: string[] = [];
  /** Document frequency by term id. */
  private dfById: Int32Array = new Int32Array(0);
  private totalDocs: number = 0;

  // Average lengths
  private avgFieldLengths: Map<string, number> = new Map();
  private avgChunkLength: number = 0;

  private paperPostings: Postings = { offsets: new Int32Array(1), ids: new Int32Array(0), scores: new Float64Array(0) };
  private chunkPostings: Postings = { offsets: new Int32Array(1), ids: new Int32Array(0), scores: new Float64Array(0) };

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

    // Terms get provisional ids in order of first sight; renumbered alphabetically once all are known.
    const idOf = new Map<string, number>();
    const terms: string[] = [];
    const df: number[] = [];
    const intern = (t: string): number => {
      let id = idOf.get(t);
      if (id === undefined) {
        id = terms.length;
        idOf.set(t, id);
        terms.push(t);
        df.push(0);
      }
      return id;
    };

    // 1. Papers: per field, term id -> frequency
    const fieldNames = Object.keys(FIELD_WEIGHTS);
    const totalFieldLengths = new Float64Array(fieldNames.length);
    const paperFields: { ids: Int32Array; tfs: Int32Array; len: number }[][] = [];
    const counts = new Map<number, number>();
    const seen = new Set<number>();

    for (const paper of this.papers) {
      const fieldTexts = [
        paper.title || "",
        paper.authors.join(" "),
        paper.citekey || "",
        paper.journal || "",
        paper.tags.join(" "),
        paper.collections.join(" "),
        paper.abstract || "",
      ];
      seen.clear();
      const perField: { ids: Int32Array; tfs: Int32Array; len: number }[] = [];
      for (let f = 0; f < fieldNames.length; f++) {
        const { tokens } = tokenize(fieldTexts[f]);
        counts.clear();
        for (const t of tokens) {
          const id = intern(t);
          counts.set(id, (counts.get(id) || 0) + 1);
          seen.add(id);
        }
        perField.push({ ids: Int32Array.from(counts.keys()), tfs: Int32Array.from(counts.values()), len: tokens.length });
        totalFieldLengths[f] += tokens.length;
      }
      for (const id of seen) df[id]++;
      paperFields.push(perField);
    }

    const numPapers = Math.max(1, this.papers.length);
    for (let f = 0; f < fieldNames.length; f++) this.avgFieldLengths.set(fieldNames[f], totalFieldLengths[f] / numPapers);

    // 2. Chunks: term id -> frequency, kept as two small typed arrays per chunk until the postings are built
    let totalChunkLen = 0;
    const chunkIds: Int32Array[] = new Array(this.chunks.length);
    const chunkTfs: Int32Array[] = new Array(this.chunks.length);
    const chunkLen = new Int32Array(this.chunks.length);
    for (let c = 0; c < this.chunks.length; c++) {
      const { tokens } = tokenize(this.chunks[c].text);
      counts.clear();
      for (const t of tokens) {
        const id = intern(t);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      for (const id of counts.keys()) df[id]++;
      chunkIds[c] = Int32Array.from(counts.keys());
      chunkTfs[c] = Int32Array.from(counts.values());
      chunkLen[c] = tokens.length;
      totalChunkLen += tokens.length;
    }
    this.avgChunkLength = this.chunks.length > 0 ? totalChunkLen / this.chunks.length : 1;

    // 3. Sorted vocabulary; rank[provisional id] = final id
    const V = terms.length;
    const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => (terms[a] < terms[b] ? -1 : terms[a] > terms[b] ? 1 : 0));
    const rank = new Int32Array(V);
    this.sortedVocab = new Array(V);
    this.dfById = new Int32Array(V);
    for (let i = 0; i < V; i++) {
      rank[order[i]] = i;
      this.sortedVocab[i] = terms[order[i]];
      this.dfById[i] = df[order[i]];
    }
    // Tokens are slices of a lowercased copy of their chunk, and engines keep a slice's parent string alive: without
    // fresh copies the vocabulary pins tens of MB of lowercased chunk text. A JSON round trip makes flat copies.
    this.sortedVocab = JSON.parse(JSON.stringify(this.sortedVocab));
    const idfById = new Float64Array(V);
    for (let i = 0; i < V; i++) idfById[i] = this.idfFromDf(this.dfById[i]);

    // 4. Paper postings: a paper's score for a term sums the weighted field scores. Ids ascend within each term.
    const paperScoreOf = (fields: { ids: Int32Array; tfs: Int32Array; len: number }[], into: Map<number, number>) => {
      into.clear();
      for (let f = 0; f < fieldNames.length; f++) {
        const { ids, tfs, len } = fields[f];
        const weight = FIELD_WEIGHTS[fieldNames[f]];
        const avgLen = this.avgFieldLengths.get(fieldNames[f]) || 1;
        for (let k = 0; k < ids.length; k++) {
          const id = rank[ids[k]];
          into.set(id, (into.get(id) || 0) + weight * this.scoreTerm(tfs[k], len, avgLen, idfById[id]));
        }
      }
    };
    const scores = new Map<number, number>();
    const paperCount = new Int32Array(V + 1);
    for (let p = 0; p < this.papers.length; p++) {
      paperScoreOf(paperFields[p], scores);
      for (const [id, score] of scores) if (score > 0) paperCount[id + 1]++;
    }
    const paperPost = this.allocate(paperCount);
    const paperFill = paperPost.offsets.slice(0, V);
    for (let p = 0; p < this.papers.length; p++) {
      paperScoreOf(paperFields[p], scores);
      for (const [id, score] of scores) {
        if (score <= 0) continue;
        const at = paperFill[id]++;
        paperPost.ids[at] = p;
        paperPost.scores[at] = score;
      }
    }
    this.paperPostings = paperPost;

    // 5. Chunk postings
    const chunkCount = new Int32Array(V + 1);
    for (let c = 0; c < this.chunks.length; c++) {
      const ids = chunkIds[c];
      for (let k = 0; k < ids.length; k++) chunkCount[rank[ids[k]] + 1]++;
    }
    const chunkPost = this.allocate(chunkCount);
    const chunkFill = chunkPost.offsets.slice(0, V);
    for (let c = 0; c < this.chunks.length; c++) {
      const ids = chunkIds[c], tfs = chunkTfs[c];
      for (let k = 0; k < ids.length; k++) {
        const id = rank[ids[k]];
        const score = this.scoreTerm(tfs[k], chunkLen[c], this.avgChunkLength, idfById[id]);
        if (score <= 0) continue;
        const at = chunkFill[id]++;
        chunkPost.ids[at] = c;
        chunkPost.scores[at] = score;
      }
    }
    this.chunkPostings = chunkPost;
  }

  /** CSR arrays for per-term counts in `count[t + 1]`. */
  private allocate(count: Int32Array): Postings {
    const offsets = new Int32Array(count.length);
    for (let i = 1; i < count.length; i++) offsets[i] = offsets[i - 1] + count[i];
    const n = offsets[offsets.length - 1];
    return { offsets, ids: new Int32Array(n), scores: new Float64Array(n) };
  }

  /** Id of an exact vocabulary term, or -1. */
  private termId(term: string): number {
    const V = this.sortedVocab;
    let l = 0, r = V.length;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (V[m] < term) l = m + 1;
      else r = m;
    }
    return l < V.length && V[l] === term ? l : -1;
  }

  private idfFromDf(docFreq: number): number {
    // BM25 standard non-negative IDF: ln(1 + (N - df + 0.5) / (df + 0.5))
    return Math.log(1 + (this.totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  }

  public idf(term: string): number {
    const id = this.termId(term);
    return this.idfFromDf(id < 0 ? 0 : this.dfById[id]);
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

  /**
   * The vocabulary words a last word of 3+ characters expands to (at most 64, the most frequent first; the word itself
   * is always kept), each with a weight on its postings. A longer word is scored as if it were no rarer than the typed
   * word (or, while the typed word is not a vocabulary term yet, the most frequent expansion): otherwise a rare variant
   * ("cells121" from a glued citation number, "transferrin" for "transfer") has a far higher idf than the word being
   * typed and its few papers jump to the top. When the typed word is a term itself, longer words count half, so "cell"
   * ranks papers saying "cell" above papers saying only "cellular".
   */
  private prefixMatcher(t: string): { matchingTerms: number[]; weights: number[] } {
    const [start, end] = this.findPrefixRange(t);
    const candidates: number[] = [];
    for (let id = start; id < end; id++) candidates.push(id);
    const exact = this.termId(t);
    if (candidates.length > 64) {
      // ids are alphabetical, so ties on df stay alphabetical
      candidates.sort((a, b) => this.dfById[b] - this.dfById[a] || a - b);
      candidates.length = 64;
      if (exact >= 0 && !candidates.includes(exact)) candidates[63] = exact;
    }
    if (candidates.length === 0) return { matchingTerms: [], weights: [] };
    let refDf = exact >= 0 ? this.dfById[exact] : 0;
    if (exact < 0) for (const id of candidates) refDf = Math.max(refDf, this.dfById[id]);
    const refIdf = this.idfFromDf(refDf);
    const variant = exact >= 0 ? 0.5 : 1;
    const weights = candidates.map((id) => (id === exact ? 1 : variant * Math.min(1, refIdf / this.idfFromDf(this.dfById[id]))));
    return { matchingTerms: candidates, weights };
  }

  public search(query: string, limit?: number): BM25SearchResult[] {
    const { tokens, lastIncomplete } = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    // Resolve query tokens. The last word may still be in progress, so it matches every vocabulary word it is a
    // prefix of, whether or not a space follows it (results must not change when the space is typed).
    const termMatchers: { matchingTerms: number[]; weights: number[] }[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;

      if (isLast && lastIncomplete) {
        if (t.length < 3) {
          // A last word shorter than 3 characters is ignored, unless it contains a digit
          // and is a vocabulary term ("3d", "6"). Letters-only terms like "s", "c", "il" exist in the
          // vocabulary (from "cell's" etc.) and would match most of the library on the first keystroke.
          const id = /\d/.test(t) ? this.termId(t) : -1;
          if (id >= 0) {
            termMatchers.push({ matchingTerms: [id], weights: [1] });
          }
          // otherwise ignored
        } else {
          termMatchers.push(this.prefixMatcher(t));
        }
      } else {
        const id = this.termId(t);
        termMatchers.push({ matchingTerms: id >= 0 ? [id] : [], weights: [1] });
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

      for (let k = 0; k < matcher.matchingTerms.length; k++) {
        const term = matcher.matchingTerms[k];
        const w = matcher.weights[k];
        const pp = this.paperPostings;
        for (let i = pp.offsets[term], end = pp.offsets[term + 1]; i < end; i++) {
          const prev = matcherPaperScores.get(pp.ids[i]) || 0;
          if (pp.scores[i] * w > prev) matcherPaperScores.set(pp.ids[i], pp.scores[i] * w);
        }
        const cp = this.chunkPostings;
        for (let i = cp.offsets[term], end = cp.offsets[term + 1]; i < end; i++) {
          const prev = matcherChunkScores.get(cp.ids[i]) || 0;
          if (cp.scores[i] * w > prev) matcherChunkScores.set(cp.ids[i], cp.scores[i] * w);
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
