"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  DEFAULT_SETTINGS: () => DEFAULT_SETTINGS,
  default: () => PaperSearchPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/text.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves"
]);
function tokenize(text) {
  const rawParts = text.toLowerCase().split(/[^a-z0-9]+/);
  const tokens = [];
  for (const part of rawParts) {
    if (part.length > 0 && !STOPWORDS.has(part)) {
      tokens.push(part);
    }
  }
  const hasTrailingSpace = /\s$/.test(text);
  const lastRaw = rawParts.length > 0 ? rawParts[rawParts.length - 1] : "";
  const lastIncomplete = !hasTrailingSpace && tokens.length > 0 && tokens[tokens.length - 1] === lastRaw;
  return { tokens, lastIncomplete };
}
function splitSentences(text) {
  if (!text.trim()) return [];
  let s = text.replace(/\bet al\./gi, "et al___DOT___").replace(/\bFig\.\s*(\d+)/gi, "Fig___DOT___ $1").replace(/\be\.g\./gi, "e___DOT___g___DOT___").replace(/\bi\.e\./gi, "i___DOT___e___DOT___").replace(/\bDr\./gi, "Dr___DOT___").replace(/\bProf\./gi, "Prof___DOT___").replace(/\bvs\./gi, "vs___DOT___").replace(/(\d+)\.(\d+)/g, "$1___DOT___$2");
  const rawSentences = s.split(/(?<=[.!?])(?:\s+|$)/);
  const sentences = [];
  for (let sent of rawSentences) {
    sent = sent.replace(/___DOT___/g, ".").trim();
    if (sent.length > 0) {
      sentences.push(sent);
    }
  }
  return sentences;
}
function bestSnippet(text, queryTokens, maxLen = 160) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return { text: "", sentence: "" };
  }
  const queryTokenSet = new Set(queryTokens.map((t) => t.toLowerCase()));
  let bestSent = sentences[0];
  let maxOverlap = -1;
  for (const sent of sentences) {
    const { tokens } = tokenize(sent);
    let overlap = 0;
    for (const t of tokens) {
      if (queryTokenSet.has(t)) {
        overlap++;
      }
    }
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestSent = sent;
    }
  }
  if (bestSent.length <= maxLen) {
    return { text: bestSent, sentence: bestSent };
  }
  const lowerSent = bestSent.toLowerCase();
  let firstMatchIdx = -1;
  for (const q of queryTokens) {
    const idx = lowerSent.indexOf(q.toLowerCase());
    if (idx !== -1 && (firstMatchIdx === -1 || idx < firstMatchIdx)) {
      firstMatchIdx = idx;
    }
  }
  if (firstMatchIdx === -1) {
    const trimmed = bestSent.slice(0, maxLen).trimEnd();
    return { text: `${trimmed}\u2026`, sentence: bestSent };
  }
  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, firstMatchIdx - half);
  let end = start + maxLen;
  if (end > bestSent.length) {
    end = bestSent.length;
    start = Math.max(0, end - maxLen);
  }
  if (start > 0) {
    const nextSpace = bestSent.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < firstMatchIdx) {
      start = nextSpace + 1;
    }
  }
  if (end < bestSent.length) {
    const prevSpace = bestSent.lastIndexOf(" ", end);
    if (prevSpace !== -1 && prevSpace > start) {
      end = prevSpace;
    }
  }
  let snippet = bestSent.slice(start, end).trim();
  if (start > 0) {
    snippet = `\u2026${snippet}`;
  }
  if (end < bestSent.length) {
    snippet = `${snippet}\u2026`;
  }
  return { text: snippet, sentence: bestSent };
}

// src/bm25.ts
var FIELD_WEIGHTS = {
  title: 3,
  authors: 3,
  citekey: 3,
  journal: 1,
  tags: 2,
  collections: 2,
  abstract: 1.5
};
var BM25Index = class {
  k1 = 1.2;
  b = 0.75;
  papers;
  chunks;
  // Vocabulary of all terms across index
  vocab = /* @__PURE__ */ new Set();
  sortedVocab = [];
  // Document frequencies: term -> count of docs containing term
  df = /* @__PURE__ */ new Map();
  totalDocs = 0;
  // Average lengths
  avgFieldLengths = /* @__PURE__ */ new Map();
  avgChunkLength = 0;
  // Inverted postings: term -> postings
  paperPostings = /* @__PURE__ */ new Map();
  chunkPostings = /* @__PURE__ */ new Map();
  // Reusable typed arrays for search to avoid GC pauses
  paperScoresBuf;
  chunkScoresBuf;
  bestChunkScoreBuf;
  bestChunkIndexBuf;
  constructor(papers, chunks) {
    this.papers = papers;
    this.chunks = chunks;
    this.paperScoresBuf = new Float64Array(this.papers.length);
    this.chunkScoresBuf = new Float64Array(this.chunks.length);
    this.bestChunkScoreBuf = new Float64Array(this.papers.length);
    this.bestChunkIndexBuf = new Int32Array(this.papers.length);
    this.build();
  }
  build() {
    this.totalDocs = this.papers.length + this.chunks.length;
    const totalFieldLengths = {
      title: 0,
      authors: 0,
      citekey: 0,
      journal: 0,
      tags: 0,
      collections: 0,
      abstract: 0
    };
    const paperFieldTerms = [];
    const paperFieldLengths = [];
    for (const paper of this.papers) {
      const fieldTerms = /* @__PURE__ */ new Map();
      const fieldLengths = /* @__PURE__ */ new Map();
      const paperDistinctTerms = /* @__PURE__ */ new Set();
      const fields = {
        title: paper.title || "",
        authors: paper.authors.join(" "),
        citekey: paper.citekey || "",
        journal: paper.journal || "",
        tags: paper.tags.join(" "),
        collections: paper.collections.join(" "),
        abstract: paper.abstract || ""
      };
      for (const [fName, fText] of Object.entries(fields)) {
        const { tokens } = tokenize(fText);
        const termFreqs = /* @__PURE__ */ new Map();
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
    let totalChunkLen = 0;
    const chunkTermsList = [];
    const chunkLengthsList = [];
    for (const chunk of this.chunks) {
      const { tokens } = tokenize(chunk.text);
      const termFreqs = /* @__PURE__ */ new Map();
      const chunkDistinctTerms = /* @__PURE__ */ new Set();
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
    this.sortedVocab = Array.from(this.vocab).sort();
    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      const fieldTerms = paperFieldTerms[pIdx];
      const fieldLens = paperFieldLengths[pIdx];
      const paperTerms = /* @__PURE__ */ new Set();
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
  idf(term) {
    const docFreq = this.df.get(term) || 0;
    return Math.log(1 + (this.totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  }
  scoreTerm(tf, docLen, avgDocLen, idfVal) {
    if (tf <= 0) return 0;
    const numerator = tf * (this.k1 + 1);
    const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / Math.max(1, avgDocLen)));
    return idfVal * (numerator / denominator);
  }
  findPrefixRange(prefix) {
    const V = this.sortedVocab;
    let l = 0;
    let r = V.length;
    while (l < r) {
      const m = l + r >>> 1;
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
      const m = l + r >>> 1;
      if (V[m].startsWith(prefix)) {
        l = m + 1;
      } else {
        r = m;
      }
    }
    const end = l;
    return [start, end];
  }
  search(query, limit) {
    const { tokens, lastIncomplete } = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }
    const termMatchers = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;
      if (isLast && lastIncomplete) {
        if (t.length < 3) {
          if (this.df.has(t)) {
            termMatchers.push({ isPrefix: false, matchingTerms: [t] });
          }
        } else {
          const [start, end] = this.findPrefixRange(t);
          const matchCount = end - start;
          if (matchCount > 0) {
            if (matchCount <= 64) {
              termMatchers.push({
                isPrefix: true,
                matchingTerms: this.sortedVocab.slice(start, end)
              });
            } else {
              const candidates = this.sortedVocab.slice(start, end);
              candidates.sort((a, b) => {
                const dfDiff = (this.df.get(b) || 0) - (this.df.get(a) || 0);
                if (dfDiff !== 0) return dfDiff;
                return a < b ? -1 : a > b ? 1 : 0;
              });
              termMatchers.push({
                isPrefix: true,
                matchingTerms: candidates.slice(0, 64)
              });
            }
          } else {
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
    this.paperScoresBuf.fill(0);
    this.chunkScoresBuf.fill(0);
    this.bestChunkScoreBuf.fill(0);
    this.bestChunkIndexBuf.fill(-1);
    const matcherPaperScores = /* @__PURE__ */ new Map();
    const matcherChunkScores = /* @__PURE__ */ new Map();
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
      for (const [pIdx, score] of matcherPaperScores.entries()) {
        this.paperScoresBuf[pIdx] += score;
      }
      for (const [cIdx, score] of matcherChunkScores.entries()) {
        this.chunkScoresBuf[cIdx] += score;
      }
    }
    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      const s = this.chunkScoresBuf[cIdx];
      if (s <= 0) continue;
      const pIdx = this.chunks[cIdx].paper;
      if (s > this.bestChunkScoreBuf[pIdx]) {
        this.bestChunkScoreBuf[pIdx] = s;
        this.bestChunkIndexBuf[pIdx] = cIdx;
      }
    }
    const results = [];
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
          bestChunkIndex: cScore > 0 ? this.bestChunkIndexBuf[pIdx] : void 0
        });
      }
    }
    if (limit !== void 0 && results.length > limit * 4) {
      results.sort((a, b) => b.score - a.score || a.paperIndex - b.paperIndex);
      return results.slice(0, limit);
    }
    results.sort((a, b) => b.score - a.score || a.paperIndex - b.paperIndex);
    if (limit !== void 0) {
      return results.slice(0, limit);
    }
    return results;
  }
};

// src/indexstore.ts
var IndexStore = class _IndexStore {
  adapter;
  basePath;
  getClock;
  currentIndex = null;
  ready = false;
  lastCheckTime = 0;
  nextIndexId = 1;
  shownNotices = /* @__PURE__ */ new Set();
  loadPromise = null;
  constructor(adapter, basePath = ".planner/search", getClock = () => Date.now()) {
    this.adapter = adapter;
    this.basePath = basePath.replace(/\/+$/, "");
    this.getClock = getClock;
  }
  isReady() {
    return this.ready && this.currentIndex !== null;
  }
  getIndex() {
    return this.currentIndex;
  }
  notifyOnce(key, msg) {
    if (!this.shownNotices.has(key)) {
      this.shownNotices.add(key);
      this.adapter.showNotice(msg);
    }
  }
  /**
   * Precomputes index lookup tables in O(chunks) one pass.
   */
  static precomputeIndex(manifest, papers, chunks, vectors, dims, id) {
    let maxRow = -1;
    for (let i = 0; i < papers.length; i++) {
      const ar = papers[i].abstractRow;
      if (ar !== void 0 && ar !== null && ar > maxRow) {
        maxRow = ar;
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const r = chunks[i].row;
      if (r !== void 0 && r !== null && r > maxRow) {
        maxRow = r;
      }
    }
    const totalRows = maxRow >= 0 ? maxRow + 1 : 0;
    const rowToChunk = new Int32Array(totalRows).fill(-1);
    const rowToPaper = new Int32Array(totalRows).fill(-1);
    const rowIsAbstract = new Uint8Array(totalRows);
    const paperAbstractRow = new Int32Array(papers.length).fill(-1);
    const chunkCounts = new Int32Array(papers.length);
    for (let i = 0; i < chunks.length; i++) {
      const p = chunks[i].paper;
      if (p >= 0 && p < papers.length) {
        chunkCounts[p]++;
      }
    }
    const paperChunkRows = new Array(papers.length);
    for (let p = 0; p < papers.length; p++) {
      paperChunkRows[p] = new Int32Array(chunkCounts[p]);
    }
    const chunkOffsets = new Int32Array(papers.length);
    for (let p = 0; p < papers.length; p++) {
      const ar = papers[p].abstractRow;
      if (ar !== void 0 && ar !== null && ar >= 0 && ar < totalRows) {
        paperAbstractRow[p] = ar;
        rowToPaper[ar] = p;
        rowIsAbstract[ar] = 1;
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const r = c.row;
      const p = c.paper;
      if (r !== void 0 && r !== null && r >= 0 && r < totalRows) {
        rowToChunk[r] = i;
        rowToPaper[r] = p;
        rowIsAbstract[r] = 0;
        if (p >= 0 && p < papers.length) {
          paperChunkRows[p][chunkOffsets[p]++] = r;
        }
      }
    }
    const bm25 = new BM25Index(papers, chunks);
    return {
      id,
      manifest,
      papers,
      chunks,
      vectors,
      dims,
      totalRows,
      rowToChunk,
      rowToPaper,
      rowIsAbstract,
      paperAbstractRow,
      paperChunkRows,
      bm25
    };
  }
  async load() {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.internalLoad();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }
  async internalLoad() {
    const manifestPath = `${this.basePath}/manifest.json`;
    const papersPath = `${this.basePath}/papers.json`;
    const chunksPath = `${this.basePath}/chunks.json`;
    const vectorsPath = `${this.basePath}/vectors.f32`;
    const manifestExists = await this.adapter.exists(manifestPath);
    if (!manifestExists) {
      this.ready = false;
      return false;
    }
    let manifest;
    try {
      const manifestStr = await this.adapter.read(manifestPath);
      manifest = JSON.parse(manifestStr);
    } catch {
      this.ready = false;
      return false;
    }
    let papers;
    let chunks;
    try {
      const papersStr = await this.adapter.read(papersPath);
      const chunksStr = await this.adapter.read(chunksPath);
      papers = JSON.parse(papersStr);
      chunks = JSON.parse(chunksStr);
    } catch {
      this.notifyOnce("malformed_json", "Paper search: malformed index, keeping previous index");
      return this.currentIndex !== null;
    }
    const dims = manifest.dims || 1024;
    let vectors = null;
    const vectorsExists = await this.adapter.exists(vectorsPath);
    if (vectorsExists) {
      try {
        const bin = await this.adapter.readBinary(vectorsPath);
        const expectedBytes = (manifest.papers + manifest.chunks) * dims * 4;
        if (bin.byteLength % (dims * 4) !== 0) {
          this.notifyOnce("truncated_vectors", "Paper search: vectors file invalid, falling back to keyword-only");
          vectors = null;
        } else {
          vectors = new Float32Array(bin);
        }
      } catch {
        this.notifyOnce("read_vectors_error", "Paper search: vectors file invalid, falling back to keyword-only");
        vectors = null;
      }
    } else {
      vectors = null;
    }
    const id = this.nextIndexId++;
    const loaded = _IndexStore.precomputeIndex(manifest, papers, chunks, vectors, dims, id);
    this.currentIndex = loaded;
    this.ready = true;
    this.lastCheckTime = this.getClock();
    return true;
  }
  /**
   * Throttled check for index freshness (at most once per 10 s).
   * Reads only manifest.json when content_hash is unchanged.
   */
  async ensureFresh() {
    const now = this.getClock();
    if (now - this.lastCheckTime < 1e4) {
      return false;
    }
    this.lastCheckTime = now;
    const manifestPath = `${this.basePath}/manifest.json`;
    if (!await this.adapter.exists(manifestPath)) {
      return false;
    }
    let manifest;
    try {
      const manifestStr = await this.adapter.read(manifestPath);
      manifest = JSON.parse(manifestStr);
    } catch {
      return false;
    }
    const current = this.currentIndex;
    if (!current) {
      return await this.load();
    }
    const currentManifest = current.manifest;
    let changed = false;
    if (manifest.content_hash || currentManifest?.content_hash) {
      changed = manifest.content_hash !== currentManifest?.content_hash;
    } else {
      changed = manifest.built_at !== currentManifest?.built_at;
    }
    if (changed) {
      return await this.load();
    }
    return false;
  }
};

// src/modal.ts
var import_obsidian = require("obsidian");

// src/engine.ts
function keyword(ix, query, limit = 10) {
  const { tokens } = tokenize(query);
  const keywordRes = ix.bm25.search(query, limit);
  const hits = [];
  for (let i = 0; i < keywordRes.length && i < limit; i++) {
    const match = keywordRes[i];
    const pIdx = match.paperIndex;
    const paper = ix.papers[pIdx];
    let snippet = "";
    let page;
    let fromAbstract = true;
    let attKey;
    const chunkWon = match.bestChunkScore > match.metadataScore && match.bestChunkIndex !== void 0 && match.bestChunkIndex >= 0;
    if (chunkWon) {
      const c = ix.chunks[match.bestChunkIndex];
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
      fromAbstract
    });
  }
  return hits;
}
function semantic(ix, qVec, query, opts) {
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
  const paperMaxScore = new Float32Array(ix.papers.length);
  const paperWinningRow = new Int32Array(ix.papers.length);
  paperWinningRow.fill(-1);
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
  const candidates = [];
  for (let p = 0; p < ix.papers.length; p++) {
    const score = paperMaxScore[p];
    if (score <= 0 || score < minScore) continue;
    if (exclude && exclude.has(p)) continue;
    candidates.push({ paper: p, score, winningRow: paperWinningRow[p] });
  }
  candidates.sort((a, b) => b.score - a.score || a.paper - b.paper);
  const topHits = candidates.slice(0, limit);
  const hits = [];
  for (let i = 0; i < topHits.length; i++) {
    const h = topHits[i];
    const paper = ix.papers[h.paper];
    const winningRow = h.winningRow;
    const isAbstract = winningRow >= 0 && ix.rowIsAbstract[winningRow] === 1;
    let snippet = "";
    let page;
    let fromAbstract = true;
    let attKey;
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
      fromAbstract
    });
  }
  return hits;
}
function hybrid(keywordHits, semanticHits, limit = 10, k = 60) {
  if (keywordHits.length === 0 && semanticHits.length === 0) {
    return [];
  }
  if (semanticHits.length === 0) {
    return keywordHits.slice(0, limit);
  }
  if (keywordHits.length === 0) {
    return semanticHits.slice(0, limit);
  }
  const rankedLists = [
    keywordHits.map((h) => h.paper),
    semanticHits.map((h) => h.paper)
  ];
  const rrfScores = /* @__PURE__ */ new Map();
  for (const list of rankedLists) {
    for (let rank = 1; rank <= list.length; rank++) {
      const pIdx = list[rank - 1];
      const cur = rrfScores.get(pIdx) || 0;
      rrfScores.set(pIdx, cur + 1 / (k + rank));
    }
  }
  const results = [];
  for (const [pIdx, score] of rrfScores.entries()) {
    results.push({ paper: pIdx, rrfScore: score });
  }
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  const keywordMap = /* @__PURE__ */ new Map();
  for (const h of keywordHits) keywordMap.set(h.paper, h);
  const semanticMap = /* @__PURE__ */ new Map();
  for (const h of semanticHits) semanticMap.set(h.paper, h);
  const hits = [];
  const top = results.slice(0, limit);
  for (let i = 0; i < top.length; i++) {
    const item = top[i];
    const sHit = semanticMap.get(item.paper);
    const kHit = keywordMap.get(item.paper);
    let source = "keyword";
    if (sHit && kHit) source = "both";
    else if (sHit) source = "semantic";
    else source = "keyword";
    const baseHit = sHit || kHit;
    hits.push({
      paper: item.paper,
      score: item.rrfScore,
      source,
      snippet: baseHit.snippet,
      page: baseHit.page,
      attachmentKey: baseHit.attachmentKey,
      fromAbstract: baseHit.fromAbstract
    });
  }
  return hits;
}

// src/vectors.ts
function truncateAndNormalize(vec, targetDims) {
  const out = new Float32Array(targetDims);
  const n = Math.min(vec.length, targetDims);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = vec[i];
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < targetDims; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

// src/ollama.ts
function formatQuery(instruction, query) {
  return `Instruct: ${instruction}
Query: ${query}`;
}
async function embedQuery(requestUrl2, options) {
  const formattedInput = formatQuery(options.instruction, options.query);
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/embed`;
  const payload = {
    model: options.model,
    input: [formattedInput],
    keep_alive: options.keepAlive ?? "30m",
    truncate: true
  };
  const resp = await requestUrl2({
    url: endpoint,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const embeddings = resp.json?.embeddings;
  if (!embeddings || embeddings.length === 0) {
    throw new Error("No embeddings returned by Ollama");
  }
  const rawVec = embeddings[0];
  const dims = options.dims ?? rawVec.length;
  return truncateAndNormalize(rawVec, dims);
}
async function warmUp(requestUrl2, options) {
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/embed`;
  const payload = {
    model: options.model,
    input: [""],
    keep_alive: options.keepAlive ?? "30m"
  };
  try {
    await requestUrl2({
      url: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
  }
}

// src/rank.ts
function shouldRunSemantic(query, minChars = 12) {
  const trimmed = query.trim();
  if (trimmed.length >= minChars) {
    return true;
  }
  const { tokens, lastIncomplete } = tokenize(query);
  const completeTokens = lastIncomplete ? tokens.length - 1 : tokens.length;
  return completeTokens >= 2;
}
var SemanticCoordinator = class {
  currentSeq = 0;
  newRequest() {
    this.currentSeq += 1;
    return { seq: this.currentSeq };
  }
  isCurrent(seq) {
    return seq === this.currentSeq;
  }
  async runSemantic(query, embedFn) {
    try {
      const scores = await embedFn(query);
      return { semanticAvailable: true, scores };
    } catch {
      return { semanticAvailable: false, scores: null };
    }
  }
};

// src/litnote.ts
var BUILTIN_TEMPLATE = `---
citekey: "{{citekey}}"
title: "{{title}}"
authors: "{{authors}}"
---
# {{title}}

[Zotero]({{zoteroSelect}})

## Abstract
{{abstractNote}}

## Notes
`;
var UNSAFE_CHARS_REGEX = /[/\\:*?"<>|]/;
function isSafeCitekey(citekey) {
  if (!citekey) return false;
  if (citekey.length > 200) return false;
  if (citekey.startsWith(".")) return false;
  if (UNSAFE_CHARS_REGEX.test(citekey)) return false;
  return true;
}
function normalizeFolder(folder) {
  const trimmed = folder.trim();
  if (!trimmed || trimmed === "." || trimmed === "./") {
    return "";
  }
  const parts = trimmed.split(/[/\\]/);
  for (const p of parts) {
    if (p === "..") {
      throw new Error(`Invalid folder path escaping vault: ${folder}`);
    }
  }
  return parts.filter((p) => p && p !== ".").join("/");
}
function formatCitation(format = "[[{{citekey}}]]", citekey) {
  if (!format.includes("{{citekey}}") && !format.includes("{{ citekey }}")) {
    throw new Error(`Citation format must contain {{citekey}}: ${format}`);
  }
  return format.replace(/\{\{\s*citekey\s*\}\}/g, citekey);
}
function findLiteratureNote(vault, metadataCache, citekey) {
  if (!citekey) return null;
  const targetName = `${citekey.toLowerCase()}.md`;
  const files = vault.getFiles();
  for (const f of files) {
    const name = (f.name || f.path.split("/").pop() || "").toLowerCase();
    if (name === targetName) {
      return f;
    }
  }
  if (metadataCache) {
    for (const f of files) {
      const cache = metadataCache.getFileCache(f);
      if (cache?.frontmatter?.citekey === citekey) {
        return f;
      }
    }
  }
  return null;
}
function escapeYamlString(val) {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}
function renderTemplate(templateText, paper, options) {
  if (templateText.includes("{%") || templateText.includes("{#") || /\{\{[^}]+(\|)[^}]+\}\}/.test(templateText)) {
    options?.onUnsupportedTemplate?.();
    templateText = BUILTIN_TEMPLATE;
  }
  const rawValues = {
    citekey: paper.citekey || "",
    title: paper.title || "",
    authors: (paper.authors || []).join(", "),
    abstractNote: paper.abstract || "",
    notes: "",
    year: paper.year !== null && paper.year !== void 0 ? String(paper.year) : "",
    journal: paper.journal || "",
    doi: paper.doi || "",
    zoteroSelect: paper.key ? `zotero://select/items/${paper.key}` : ""
  };
  let frontmatterText = "";
  let bodyText = templateText;
  let hasFrontmatter = false;
  const fmMatch = templateText.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (fmMatch) {
    hasFrontmatter = true;
    frontmatterText = fmMatch[1];
    bodyText = templateText.slice(fmMatch[0].length);
  }
  if (hasFrontmatter) {
    const fmLines = frontmatterText.split(/\r?\n/);
    const renderedFmLines = fmLines.map((line) => {
      return line.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, name) => {
        const val = rawValues[name];
        if (val === void 0) {
          options?.onUnknownPlaceholder?.(name);
          return "";
        }
        return escapeYamlString(val);
      });
    });
    const quotedFmLines = renderedFmLines.map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const rawRest = line.slice(colonIdx + 1).trim();
        if (rawRest && !rawRest.startsWith('"') && !rawRest.startsWith("[") && !rawRest.startsWith("{")) {
          return `${line.slice(0, colonIdx + 1)} "${escapeYamlString(rawRest)}"`;
        }
      }
      return line;
    });
    frontmatterText = quotedFmLines.join("\n");
  }
  const renderedBody = bodyText.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, name) => {
    const val = rawValues[name];
    if (val === void 0) {
      options?.onUnknownPlaceholder?.(name);
      return "";
    }
    return val;
  });
  if (hasFrontmatter) {
    return `---
${frontmatterText}
---
${renderedBody}`;
  }
  return renderedBody;
}
async function ensureLiteratureNote(vault, metadataCache, paper, settings, options) {
  const existing = findLiteratureNote(vault, metadataCache, paper.citekey);
  if (existing) {
    return { file: existing, created: false };
  }
  if (settings.createLiteratureNotes === false) {
    return { file: null, created: false };
  }
  if (!isSafeCitekey(paper.citekey)) {
    options?.showNotice?.(
      `Paper search: citekey "${paper.citekey || ""}" cannot be used as a filename. Citation was inserted without a literature note.`
    );
    return { file: null, created: false };
  }
  let folder = "";
  try {
    folder = normalizeFolder(settings.literatureNoteFolder || "");
  } catch (err) {
    options?.showNotice?.(`Paper search: ${err.message}`);
    return { file: null, created: false };
  }
  if (folder && vault.createFolder) {
    try {
      await vault.createFolder(folder);
    } catch {
    }
  }
  let templateText = BUILTIN_TEMPLATE;
  const templatePath = settings.literatureNoteTemplate || "Zotero Template.md";
  const templateFile = vault.getAbstractFileByPath ? vault.getAbstractFileByPath(templatePath) : null;
  if (templateFile) {
    try {
      templateText = await vault.read(templateFile);
    } catch {
      templateText = BUILTIN_TEMPLATE;
    }
  }
  const sessionNotices = options?.sessionNotices || /* @__PURE__ */ new Set();
  const content = renderTemplate(templateText, paper, {
    onUnsupportedTemplate: () => {
      if (!sessionNotices.has("nunjucks")) {
        sessionNotices.add("nunjucks");
        options?.showNotice?.(
          "Paper search: template uses unsupported Nunjucks features. Using built-in template."
        );
      }
    }
  });
  const filePath = folder ? `${folder}/${paper.citekey}.md` : `${paper.citekey}.md`;
  try {
    const file = await vault.create(filePath, content);
    return { file, created: true };
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes("exist")) {
      const f = vault.getAbstractFileByPath ? vault.getAbstractFileByPath(filePath) : null;
      return { file: f, created: false };
    }
    options?.showNotice?.(`Paper search: failed to create literature note: ${err.message}`);
    return { file: null, created: false };
  }
}

// src/modal.ts
var PaperSearchModal = class extends import_obsidian.SuggestModal {
  plugin;
  coordinator = new SemanticCoordinator();
  currentItems = [];
  debounceTimer = null;
  footerEl = null;
  lastKeywordHits = [];
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Search papers by what they found, title, author, or citekey...");
    this.setInstructions([
      { command: "\u21B5", purpose: "open PDF at page" },
      { command: "\u2318\u21B5", purpose: "insert citation & create note" },
      { command: "\u2325\u21B5", purpose: "open/create literature note" },
      { command: "\u21E7\u21B5", purpose: "select in Zotero" }
    ]);
  }
  async onOpen() {
    super.onOpen();
    this.plugin.indexStore.ensureFresh().catch(() => {
    });
    const ix = this.plugin.indexStore.getIndex();
    if (ix?.manifest?.model) {
      warmUp(import_obsidian.requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model: ix.manifest.model,
        keepAlive: "30m"
      });
    }
    const modalEl = this.modalEl;
    this.footerEl = modalEl.createDiv({ cls: "paper-search-footer" });
    this.footerEl.style.fontSize = "0.8em";
    this.footerEl.style.color = "var(--text-muted)";
    this.footerEl.style.padding = "4px 8px";
    this.scope.register(["Mod"], "Enter", (evt) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item && !item.isLoadingRow && item.paperIndex !== void 0) {
        this.insertCitationAndEnsureNote(item.paperIndex);
        this.close();
      }
      return false;
    });
    this.scope.register(["Alt"], "Enter", (evt) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item && !item.isLoadingRow && item.paperIndex !== void 0) {
        this.openLiteratureNote(item.paperIndex);
        this.close();
      }
      return false;
    });
    this.scope.register(["Shift"], "Enter", (evt) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item && !item.isLoadingRow && item.paperIndex !== void 0) {
        this.selectInZotero(item.paperIndex);
        this.close();
      }
      return false;
    });
  }
  getSelectedItem() {
    return this.chooser?.values?.[this.chooser?.selectedItem] || null;
  }
  updateFooter(msg) {
    if (this.footerEl) {
      this.footerEl.setText(msg);
    }
  }
  getSuggestions(query) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix || !this.plugin.indexStore.isReady()) {
      return [{ isLoadingRow: true }];
    }
    const kHits = keyword(ix, query, this.plugin.settings.limit);
    this.lastKeywordHits = kHits;
    const items = kHits.map((h) => ({
      hit: h,
      paperIndex: h.paper
    }));
    this.currentItems = items;
    this.scheduleSemanticSearch(query, ix);
    return items;
  }
  scheduleSemanticSearch(query, ix) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!shouldRunSemantic(query, this.plugin.settings.minCharsSemantic) || !ix.vectors) {
      return;
    }
    const { seq } = this.coordinator.newRequest();
    this.debounceTimer = setTimeout(async () => {
      await this.runSemantic(query, ix, seq);
    }, this.plugin.settings.debounceMs);
  }
  async runSemantic(query, ix, seq) {
    if (!ix.vectors) return;
    try {
      const qVec = await embedQuery(import_obsidian.requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model: ix.manifest.model,
        instruction: ix.manifest.query_instruction,
        query,
        dims: ix.dims
      });
      if (!this.coordinator.isCurrent(seq)) {
        return;
      }
      this.updateFooter("");
      const sHits = semantic(ix, qVec, query, { limit: this.plugin.settings.limit });
      const mergedHits = hybrid(this.lastKeywordHits, sHits, this.plugin.settings.limit);
      const newItems = mergedHits.map((h) => ({
        hit: h,
        paperIndex: h.paper
      }));
      const currentItem = this.getSelectedItem();
      const prevPaper = currentItem?.paperIndex ?? null;
      let newSelectedIdx = 0;
      if (prevPaper !== null) {
        const found = newItems.findIndex((it) => it.paperIndex === prevPaper);
        if (found >= 0) newSelectedIdx = found;
      }
      this.currentItems = newItems;
      this.chooser?.setSuggestions(newItems);
      this.chooser?.setSelectedItem(newSelectedIdx);
    } catch {
      this.updateFooter("semantic off: Ollama not reachable");
    }
  }
  renderSuggestion(item, el) {
    el.empty();
    if (item.isLoadingRow) {
      el.createDiv({ text: "Loading paper index\u2026", cls: "paper-search-loading" });
      return;
    }
    const ix = this.plugin.indexStore.getIndex();
    if (!ix || item.paperIndex === void 0) return;
    const paper = ix.papers[item.paperIndex];
    const hit = item.hit;
    const row = el.createDiv({ cls: "paper-search-item" });
    const titleEl = row.createDiv({ cls: "paper-title", text: paper.title });
    titleEl.style.fontWeight = "bold";
    const metaParts = [];
    if (paper.authors && paper.authors.length > 0) metaParts.push(paper.authors.join(", "));
    if (paper.year) metaParts.push(String(paper.year));
    if (paper.journal) metaParts.push(paper.journal);
    const metaEl = row.createDiv({ cls: "paper-meta", text: metaParts.join(" \xB7 ") });
    metaEl.style.fontSize = "0.85em";
    metaEl.style.color = "var(--text-muted)";
    if (hit && hit.snippet) {
      const snippetContainer = row.createDiv({ cls: "paper-snippet-container" });
      snippetContainer.style.fontSize = "0.85em";
      snippetContainer.style.marginTop = "2px";
      const badge = snippetContainer.createSpan({ cls: "paper-snippet-badge" });
      badge.style.display = "inline-block";
      badge.style.padding = "1px 4px";
      badge.style.fontSize = "0.75em";
      badge.style.borderRadius = "3px";
      badge.style.marginRight = "6px";
      badge.style.backgroundColor = "var(--background-secondary)";
      if (hit.fromAbstract) {
        badge.setText("abstract");
      } else if (hit.page) {
        badge.setText(`p. ${hit.page}`);
      } else {
        badge.setText("body");
      }
      snippetContainer.createSpan({ text: hit.snippet, cls: "paper-snippet-text" });
    }
  }
  onChooseSuggestion(item, _evt) {
    if (item.isLoadingRow || item.paperIndex === void 0) return;
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[item.paperIndex];
    const hit = item.hit;
    const attKey = hit?.attachmentKey || paper.pdfs?.[0]?.attachmentKey;
    const page = hit?.page || 1;
    if (attKey) {
      window.open(`zotero://open-pdf/library/items/${attKey}?page=${page}`);
    } else {
      window.open(`zotero://select/items/${paper.key}`);
    }
  }
  async insertCitationAndEnsureNote(paperIndex) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];
    const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const citation = formatCitation(this.plugin.settings.citationFormat, paper.citekey);
      editor.replaceRange(citation, editor.getCursor());
    }
    await ensureLiteratureNote(
      this.app.vault,
      this.app.metadataCache,
      paper,
      this.plugin.settings,
      { showNotice: (m) => new import_obsidian.Notice(m) }
    );
  }
  async openLiteratureNote(paperIndex) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];
    const res = await ensureLiteratureNote(
      this.app.vault,
      this.app.metadataCache,
      paper,
      this.plugin.settings,
      { showNotice: (m) => new import_obsidian.Notice(m) }
    );
    if (res.file) {
      this.app.workspace.getLeaf().openFile(res.file);
    }
  }
  selectInZotero(paperIndex) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];
    if (paper.key) {
      window.open(`zotero://select/items/${paper.key}`);
    }
  }
};

// src/hotkey.ts
function checkHotkeyConflict(customHotkeys, targetModifiers = ["Mod", "Shift"], targetKey = "0", ourCommandId = "daito-paper-search:open-paper-search") {
  for (const [cmdId, bindings] of Object.entries(customHotkeys)) {
    if (cmdId === ourCommandId) continue;
    if (!Array.isArray(bindings)) continue;
    for (const b of bindings) {
      if (!b || !b.key || !Array.isArray(b.modifiers)) continue;
      const keyMatches = b.key.toLowerCase() === targetKey.toLowerCase();
      const modsMatch = b.modifiers.length === targetModifiers.length && targetModifiers.every((m) => b.modifiers.includes(m));
      if (keyMatches && modsMatch) {
        return cmdId;
      }
    }
  }
  return null;
}

// src/main.ts
var DEFAULT_SETTINGS = {
  ollamaUrl: "http://127.0.0.1:11434",
  debounceMs: 200,
  minCharsSemantic: 12,
  limit: 12,
  citationFormat: "[[{{citekey}}]]",
  createLiteratureNotes: true,
  literatureNoteFolder: "",
  literatureNoteTemplate: "Zotero Template.md",
  inlineTrigger: "@@",
  inlineLimit: 8,
  inlineShowSnippet: true,
  relatedLimit: 5,
  relatedMinScore: 0.25,
  relatedAutoRefresh: false,
  relatedInstruction: "Given a passage from my research notes, retrieve papers that report the findings or methods it discusses"
};
var PaperSearchPlugin = class extends import_obsidian2.Plugin {
  settings = DEFAULT_SETTINGS;
  indexStore;
  async onload() {
    await this.loadSettings();
    const adapter = {
      read: (p) => this.app.vault.adapter.read(p),
      readBinary: (p) => this.app.vault.adapter.readBinary(p),
      exists: (p) => this.app.vault.adapter.exists(p),
      showNotice: (m) => new import_obsidian2.Notice(m)
    };
    this.indexStore = new IndexStore(adapter, ".planner/search");
    this.app.workspace.onLayoutReady(() => {
      this.indexStore.load().catch((err) => {
        console.error("Failed to load paper search index:", err);
      });
      this.checkHotkeyConflicts();
    });
    this.addCommand({
      id: "open-paper-search",
      name: "Search papers (keyword + semantic)",
      callback: () => {
        new PaperSearchModal(this.app, this).open();
      }
    });
    this.addSettingTab(new PaperSearchSettingTab(this.app, this));
  }
  checkHotkeyConflicts() {
    try {
      const customKeys = this.app.hotkeyManager?.customKeys || {};
      const conflict = checkHotkeyConflict(customKeys, ["Mod", "Shift"], "0");
      if (conflict) {
        new import_obsidian2.Notice(
          `Paper search hotkey (Mod+Shift+0) conflicts with command: ${conflict}`
        );
      }
    } catch {
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var PaperSearchSettingTab = class extends import_obsidian2.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Search Settings" });
    new import_obsidian2.Setting(containerEl).setName("Ollama URL").setDesc("Address of the local Ollama server for embedding search queries").addText(
      (text) => text.setPlaceholder("http://127.0.0.1:11434").setValue(this.plugin.settings.ollamaUrl).onChange(async (value) => {
        this.plugin.settings.ollamaUrl = value.trim() || DEFAULT_SETTINGS.ollamaUrl;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Citation Format").setDesc("Format used when inserting citations (must include {{citekey}})").addText(
      (text) => text.setPlaceholder("[[{{citekey}}]]").setValue(this.plugin.settings.citationFormat).onChange(async (value) => {
        const trimmed = value.trim();
        try {
          formatCitation(trimmed, "test");
          this.plugin.settings.citationFormat = trimmed;
          await this.plugin.saveSettings();
        } catch {
          new import_obsidian2.Notice("Citation format must include {{citekey}}");
        }
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Create Literature Notes").setDesc("Automatically create literature notes when citing papers").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.createLiteratureNotes).onChange(async (value) => {
        this.plugin.settings.createLiteratureNotes = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Literature Note Folder").setDesc("Folder inside vault where new literature notes will be created (leave empty for vault root)").addText(
      (text) => text.setPlaceholder("vault root").setValue(this.plugin.settings.literatureNoteFolder).onChange(async (value) => {
        this.plugin.settings.literatureNoteFolder = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Literature Note Template").setDesc("Vault path to Markdown template file (e.g. Zotero Template.md)").addText(
      (text) => text.setPlaceholder("Zotero Template.md").setValue(this.plugin.settings.literatureNoteTemplate).onChange(async (value) => {
        this.plugin.settings.literatureNoteTemplate = value.trim() || "Zotero Template.md";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Inline Suggestion Trigger").setDesc("Trigger characters to invoke paper citation search while typing").addText(
      (text) => text.setPlaceholder("@@").setValue(this.plugin.settings.inlineTrigger).onChange(async (value) => {
        this.plugin.settings.inlineTrigger = value.trim() || "@@";
        await this.plugin.saveSettings();
      })
    );
  }
};
