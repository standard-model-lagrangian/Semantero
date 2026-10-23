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
  /** Every term, sorted; a term's index here is its id everywhere below. */
  sortedVocab = [];
  /** Document frequency by term id. */
  dfById = new Int32Array(0);
  totalDocs = 0;
  // Average lengths
  avgFieldLengths = /* @__PURE__ */ new Map();
  avgChunkLength = 0;
  paperPostings = { offsets: new Int32Array(1), ids: new Int32Array(0), scores: new Float64Array(0) };
  chunkPostings = { offsets: new Int32Array(1), ids: new Int32Array(0), scores: new Float64Array(0) };
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
    const idOf = /* @__PURE__ */ new Map();
    const terms = [];
    const df = [];
    const intern = (t) => {
      let id = idOf.get(t);
      if (id === void 0) {
        id = terms.length;
        idOf.set(t, id);
        terms.push(t);
        df.push(0);
      }
      return id;
    };
    const fieldNames = Object.keys(FIELD_WEIGHTS);
    const totalFieldLengths = new Float64Array(fieldNames.length);
    const paperFields = [];
    const counts = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    for (const paper of this.papers) {
      const fieldTexts = [
        paper.title || "",
        paper.authors.join(" "),
        paper.citekey || "",
        paper.journal || "",
        paper.tags.join(" "),
        paper.collections.join(" "),
        paper.abstract || ""
      ];
      seen.clear();
      const perField = [];
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
    let totalChunkLen = 0;
    const chunkIds = new Array(this.chunks.length);
    const chunkTfs = new Array(this.chunks.length);
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
    const V = terms.length;
    const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => terms[a] < terms[b] ? -1 : terms[a] > terms[b] ? 1 : 0);
    const rank = new Int32Array(V);
    this.sortedVocab = new Array(V);
    this.dfById = new Int32Array(V);
    for (let i = 0; i < V; i++) {
      rank[order[i]] = i;
      this.sortedVocab[i] = terms[order[i]];
      this.dfById[i] = df[order[i]];
    }
    this.sortedVocab = JSON.parse(JSON.stringify(this.sortedVocab));
    const idfById = new Float64Array(V);
    for (let i = 0; i < V; i++) idfById[i] = this.idfFromDf(this.dfById[i]);
    const paperScoreOf = (fields, into) => {
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
    const scores = /* @__PURE__ */ new Map();
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
  allocate(count) {
    const offsets = new Int32Array(count.length);
    for (let i = 1; i < count.length; i++) offsets[i] = offsets[i - 1] + count[i];
    const n = offsets[offsets.length - 1];
    return { offsets, ids: new Int32Array(n), scores: new Float64Array(n) };
  }
  /** Id of an exact vocabulary term, or -1. */
  termId(term) {
    const V = this.sortedVocab;
    let l = 0, r = V.length;
    while (l < r) {
      const m = l + r >>> 1;
      if (V[m] < term) l = m + 1;
      else r = m;
    }
    return l < V.length && V[l] === term ? l : -1;
  }
  idfFromDf(docFreq) {
    return Math.log(1 + (this.totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  }
  idf(term) {
    const id = this.termId(term);
    return this.idfFromDf(id < 0 ? 0 : this.dfById[id]);
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
          const id = /\d/.test(t) ? this.termId(t) : -1;
          if (id >= 0) {
            termMatchers.push({ isPrefix: false, matchingTerms: [id] });
          }
        } else {
          const [start, end] = this.findPrefixRange(t);
          const matchCount = end - start;
          if (matchCount > 0) {
            if (matchCount <= 64) {
              const range = [];
              for (let id = start; id < end; id++) range.push(id);
              termMatchers.push({ isPrefix: true, matchingTerms: range });
            } else {
              const candidates = [];
              for (let id = start; id < end; id++) candidates.push(id);
              candidates.sort((a, b) => this.dfById[b] - this.dfById[a] || a - b);
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
        const id = this.termId(t);
        termMatchers.push({ isPrefix: false, matchingTerms: id >= 0 ? [id] : [] });
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
        const pp = this.paperPostings;
        for (let i = pp.offsets[term], end = pp.offsets[term + 1]; i < end; i++) {
          const prev = matcherPaperScores.get(pp.ids[i]) || 0;
          if (pp.scores[i] > prev) matcherPaperScores.set(pp.ids[i], pp.scores[i]);
        }
        const cp = this.chunkPostings;
        for (let i = cp.offsets[term], end = cp.offsets[term + 1]; i < end; i++) {
          const prev = matcherChunkScores.get(cp.ids[i]) || 0;
          if (cp.scores[i] > prev) matcherChunkScores.set(cp.ids[i], cp.scores[i]);
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

// src/textstore.ts
var TextStore = class _TextStore {
  bytes;
  offsets;
  constructor(bytes, offsets) {
    this.bytes = bytes;
    this.offsets = offsets;
  }
  get count() {
    return this.offsets.length - 1;
  }
  get byteLength() {
    return this.bytes.length;
  }
  static from(texts) {
    const offsets = new Int32Array(texts.length + 1);
    let total = 0;
    for (let i = 0; i < texts.length; i++) {
      total += encodedLength(texts[i]);
      offsets[i + 1] = total;
    }
    const bytes = new Uint8Array(total);
    for (let i = 0; i < texts.length; i++) encodeInto(texts[i], bytes, offsets[i]);
    return new _TextStore(bytes, offsets);
  }
  get(i) {
    if (i < 0 || i >= this.count) return "";
    return decode(this.bytes, this.offsets[i], this.offsets[i + 1]);
  }
};
var isHigh = (u) => u >= 55296 && u <= 56319;
var isLow = (u) => u >= 56320 && u <= 57343;
function encodedLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u < 128) n += 1;
    else if (u < 2048) n += 2;
    else if (isHigh(u) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
function encodeInto(s, out, at) {
  for (let i = 0; i < s.length; i++) {
    let u = s.charCodeAt(i);
    if (u < 128) {
      out[at++] = u;
    } else if (u < 2048) {
      out[at++] = 192 | u >> 6;
      out[at++] = 128 | u & 63;
    } else if (isHigh(u) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      u = 65536 + (u - 55296 << 10) + (s.charCodeAt(++i) - 56320);
      out[at++] = 240 | u >> 18;
      out[at++] = 128 | u >> 12 & 63;
      out[at++] = 128 | u >> 6 & 63;
      out[at++] = 128 | u & 63;
    } else {
      out[at++] = 224 | u >> 12;
      out[at++] = 128 | u >> 6 & 63;
      out[at++] = 128 | u & 63;
    }
  }
}
function decode(b, start, end) {
  const units = [];
  let out = "";
  for (let i = start; i < end; ) {
    const c = b[i];
    if (c < 128) {
      units.push(c);
      i += 1;
    } else if (c < 224) {
      units.push((c & 31) << 6 | b[i + 1] & 63);
      i += 2;
    } else if (c < 240) {
      units.push((c & 15) << 12 | (b[i + 1] & 63) << 6 | b[i + 2] & 63);
      i += 3;
    } else {
      const cp = ((c & 7) << 18 | (b[i + 1] & 63) << 12 | (b[i + 2] & 63) << 6 | b[i + 3] & 63) - 65536;
      units.push(55296 + (cp >> 10), 56320 + (cp & 1023));
      i += 4;
    }
    if (units.length >= 8192) {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode.apply(null, units);
}
function compactChunkTexts(chunks) {
  const store = TextStore.from(chunks.map((c) => c.text));
  const proto = Object.defineProperty({}, "text", {
    get() {
      return store.get(this.i);
    },
    enumerable: true
  });
  const shared = /* @__PURE__ */ new Map();
  const intern = (v) => {
    if (v === void 0) return v;
    let s = shared.get(v);
    if (s === void 0) {
      s = v;
      shared.set(v, v);
    }
    return s;
  };
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const lean = Object.create(proto);
    lean.i = i;
    lean.paper = c.paper;
    lean.attachmentKey = intern(c.attachmentKey);
    lean.page = c.page;
    lean.row = c.row;
    if (c.heading !== void 0) lean.heading = intern(c.heading);
    if (c.line !== void 0) lean.line = c.line;
    chunks[i] = lean;
  }
  return store;
}

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
  /** content_hash of a build whose JSON failed to parse; not retried until the hash changes. */
  failedContentHash = null;
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
  /** Number of vector rows the index refers to: highest abstract or chunk row + 1. */
  static countRows(papers, chunks) {
    let maxRow = -1;
    for (const p of papers) if (typeof p.abstractRow === "number" && p.abstractRow > maxRow) maxRow = p.abstractRow;
    for (const c of chunks) if (typeof c.row === "number" && c.row > maxRow) maxRow = c.row;
    return maxRow + 1;
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
    compactChunkTexts(chunks);
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
      if (manifest.content_hash) this.failedContentHash = manifest.content_hash;
      return this.currentIndex !== null;
    }
    this.failedContentHash = null;
    const dimsValid = Number.isInteger(manifest.dims) && manifest.dims > 0;
    const dims = dimsValid ? manifest.dims : 1024;
    let vectors = null;
    const invalidVectors = () => this.notifyOnce("invalid_vectors", "Paper search: vectors file invalid, falling back to keyword-only");
    if (await this.adapter.exists(vectorsPath)) {
      try {
        const bin = await this.adapter.readBinary(vectorsPath);
        const expectedBytes = _IndexStore.countRows(papers, chunks) * dims * 4;
        if (!dimsValid || bin.byteLength !== expectedBytes) {
          invalidVectors();
        } else {
          vectors = new Float32Array(bin);
        }
      } catch {
        invalidVectors();
      }
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
    if (manifest.content_hash && manifest.content_hash === this.failedContentHash) {
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
function snippetFor(ix, hit, tokens) {
  if (hit.chunkIndex !== void 0 && hit.chunkIndex >= 0) return bestSnippet(ix.chunks[hit.chunkIndex].text, tokens).text;
  const paper = ix.papers[hit.paper];
  return bestSnippet(paper.abstract || paper.title, tokens).text;
}
function fillSnippets(ix, hits, query) {
  const { tokens } = tokenize(query);
  for (const h of hits) if (!h.snippet) h.snippet = snippetFor(ix, h, tokens);
  return hits;
}
function keyword(ix, query, limit = 10, opts) {
  const withSnippets = opts?.snippets !== false;
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
    let chunkIndex;
    if (chunkWon) {
      const c = ix.chunks[match.bestChunkIndex];
      chunkIndex = match.bestChunkIndex;
      page = c.page;
      fromAbstract = false;
      attKey = c.attachmentKey;
    }
    const hit = {
      paper: pIdx,
      score: match.score,
      source: "keyword",
      snippet,
      page,
      attachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
      fromAbstract,
      chunkIndex
    };
    if (withSnippets) hit.snippet = snippetFor(ix, hit, tokens);
    hits.push(hit);
  }
  return hits;
}
function rowScores(ix, qVec, exclude) {
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
function semanticFromRowScores(ix, scores, query, opts) {
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
    let page;
    let fromAbstract = true;
    let attKey;
    let chunkIndex;
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
    const hit = {
      paper: h.paper,
      score: h.score,
      source: "semantic",
      snippet: "",
      page,
      attachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
      fromAbstract,
      chunkIndex
    };
    if (withSnippets) hit.snippet = snippetFor(ix, hit, tokens);
    hits.push(hit);
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
      fromAbstract: baseHit.fromAbstract,
      chunkIndex: baseHit.chunkIndex
    });
  }
  return hits;
}
function hybridSearchFromScores(ix, query, scores, limit) {
  const n = ix.papers.length;
  const kw = keyword(ix, query, n, { snippets: false });
  const sem = scores ? semanticFromRowScores(ix, scores, query, { limit: n, snippets: false }) : [];
  return fillSnippets(ix, hybrid(kw, sem, limit), query);
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
var DEFAULT_KEEP_ALIVE = "5m";
function formatQuery(instruction, query) {
  return `Instruct: ${instruction}
Query: ${query}`;
}
async function embedQuery(requestUrl3, options) {
  const formattedInput = formatQuery(options.instruction, options.query);
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/embed`;
  const payload = {
    model: options.model,
    input: [formattedInput],
    keep_alive: options.keepAlive ?? DEFAULT_KEEP_ALIVE,
    truncate: true
  };
  const resp = await requestUrl3({
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
async function warmUp(requestUrl3, options) {
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/embed`;
  const payload = {
    model: options.model,
    input: [""],
    keep_alive: options.keepAlive ?? DEFAULT_KEEP_ALIVE
  };
  try {
    await requestUrl3({
      url: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
  }
}

// src/semantic.ts
function isPplx(ix) {
  return ix.manifest?.backend === "pplx";
}
async function semanticScores(requestUrl3, ix, text, opts) {
  if (!ix.vectors || ix.totalRows === 0) return { scores: null };
  if (isPplx(ix)) {
    const scores = await pplxRowScores(requestUrl3, ix.manifest.backend_url, text, "search", ix.manifest.content_hash);
    if (scores.length !== ix.totalRows) throw new Error("pplx scores do not match the loaded index");
    if (opts.exclude && opts.exclude.size > 0) {
      for (let r = 0; r < scores.length; r++) if (opts.exclude.has(ix.rowToPaper[r])) scores[r] = 0;
    }
    return { scores };
  }
  const qVec = await embedQuery(requestUrl3, {
    url: opts.ollamaUrl,
    model: ix.manifest.model,
    instruction: opts.instruction,
    query: text,
    dims: ix.dims,
    keepAlive: opts.keepAlive
  });
  return { scores: rowScores(ix, qVec, opts.exclude) };
}
async function pplxRowScores(requestUrl3, url, text, corpus, expectHash) {
  const resp = await requestUrl3({
    url: `${(url || "http://127.0.0.1:11435").replace(/\/+$/, "")}/rowscores`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, corpora: [corpus] })
  });
  const c = resp.json?.corpora?.[corpus];
  if (!c || c.error) throw new Error(`pplx service: ${c?.error ?? "no scores"}`);
  if (expectHash && c.content_hash !== expectHash) throw new Error("pplx service has another build of the index loaded");
  const bin = atob(c.scores);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f32 = new Float32Array(bytes.buffer, 0, bytes.length >> 2);
  return Float64Array.from(f32);
}
async function warmSemantic(requestUrl3, ix, ollamaUrl, keepAlive) {
  if (isPplx(ix)) {
    try {
      await requestUrl3({
        url: `${(ix.manifest.backend_url || "http://127.0.0.1:11435").replace(/\/+$/, "")}/warm`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
    } catch {
    }
    return;
  }
  await warmUp(requestUrl3, { url: ollamaUrl, model: ix.manifest.model, keepAlive });
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

// src/zotero.ts
function selectItemUrl(itemKey) {
  return `zotero://select/library/items/${itemKey}`;
}
function openPdfUrl(attachmentKey, page) {
  const p = page && page > 0 ? Math.floor(page) : 1;
  return `zotero://open-pdf/library/items/${attachmentKey}?page=${p}`;
}
function openAttachmentUrl(attachmentKey) {
  return `zotero://open/library/items/${attachmentKey}`;
}
function hitUrl(paper, hit) {
  const snapshots = paper.snapshots ?? [];
  const attKey = hit?.attachmentKey || paper.pdfs?.[0]?.attachmentKey || snapshots[0]?.attachmentKey;
  if (!attKey) return selectItemUrl(paper.key);
  if (snapshots.some((s) => s.attachmentKey === attKey)) return openAttachmentUrl(attKey);
  return openPdfUrl(attKey, hit?.attachmentKey ? hit.page : 1);
}

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
var PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
function needsYamlQuotes(val) {
  return val === "" || /^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(val) || /\s$/.test(val) || /:(\s|$)/.test(val) || /\s#/.test(val) || /^(true|false|yes|no|on|off|null|~)$/i.test(val);
}
function renderFrontmatterLine(line, lookup) {
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(line)) return line;
  const substitute = (text, offset) => text.replace(PLACEHOLDER_RE, (_m, name, pos) => {
    const before = line.slice(0, offset + pos);
    const inDouble = (before.replace(/\\./g, "").match(/"/g) || []).length % 2 === 1;
    const inSingle = !inDouble && (before.match(/'/g) || []).length % 2 === 1;
    const val = lookup(name);
    if (inDouble) return escapeYamlString(val);
    if (inSingle) return val.replace(/\r?\n/g, " ").replace(/'/g, "''");
    return val.replace(/\r?\n/g, " ");
  });
  const kv = line.match(/^(\s*[^\s\-#][^:]*:)(\s*)(.*)$/);
  if (kv && !/^(["'\[|>]|\{(?!\{))/.test(kv[3])) {
    const [, key, , rest] = kv;
    const value = substitute(rest, line.length - rest.length);
    return needsYamlQuotes(value) ? `${key} "${escapeYamlString(value)}"` : `${key} ${value}`;
  }
  return substitute(line, 0);
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
    zoteroSelect: paper.key ? selectItemUrl(paper.key) : ""
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
  const lookup = (name) => {
    const val = rawValues[name];
    if (val === void 0) {
      options?.onUnknownPlaceholder?.(name);
      return "";
    }
    return val;
  };
  if (hasFrontmatter) {
    frontmatterText = frontmatterText.split(/\r?\n/).map((line) => renderFrontmatterLine(line, lookup)).join("\n");
  }
  const renderedBody = bodyText.replace(PLACEHOLDER_RE, (_match, name) => lookup(name));
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
      const lower = filePath.toLowerCase();
      const f = (vault.getAbstractFileByPath ? vault.getAbstractFileByPath(filePath) : null) || vault.getFiles().find((x) => (x.path || "").toLowerCase() === lower) || findLiteratureNote(vault, metadataCache, paper.citekey);
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
      { command: "\u21B5", purpose: "open in Zotero" },
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
      warmSemantic(import_obsidian.requestUrl, ix, this.plugin.settings.ollamaUrl, DEFAULT_KEEP_ALIVE);
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
      const scores = await this.plugin.semanticScoresFor(ix, query, ix.manifest.query_instruction);
      if (!this.coordinator.isCurrent(seq)) {
        return;
      }
      this.updateFooter("");
      const mergedHits = hybridSearchFromScores(ix, query, scores, this.plugin.settings.limit);
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
      this.updateFooter(`semantic off: ${isPplx(ix) ? "pplx service" : "Ollama"} not reachable`);
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
        badge.setText("web page");
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
    window.open(hitUrl(paper, hit));
  }
  async insertCitationAndEnsureNote(paperIndex) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];
    if (!paper) return;
    if (!paper.citekey) {
      new import_obsidian.Notice("Paper search: paper has no citekey. Ensure Better BibTeX is installed in Zotero.");
      return;
    }
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
      { showNotice: (m) => new import_obsidian.Notice(m), sessionNotices: this.plugin.litNoteNotices }
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
      { showNotice: (m) => new import_obsidian.Notice(m), sessionNotices: this.plugin.litNoteNotices }
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
      window.open(selectItemUrl(paper.key));
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

// src/cite.ts
function findTrigger(lineText, ch, trigger = "@@") {
  if (ch < trigger.length) return null;
  const windowStart = Math.max(0, ch - 160);
  const windowText = lineText.slice(windowStart, ch);
  const relIdx = windowText.lastIndexOf(trigger);
  if (relIdx === -1) return null;
  const triggerStart = windowStart + relIdx;
  const triggerEnd = triggerStart + trigger.length;
  if (triggerStart > 0) {
    const prevChar = lineText[triggerStart - 1];
    const isWhitespace = /\s/.test(prevChar);
    const isOpenPunctuation = prevChar === "(" || prevChar === "[" || prevChar === "{" || prevChar === '"' || prevChar === "'";
    if (!isWhitespace && !isOpenPunctuation) {
      return null;
    }
  }
  const query = lineText.slice(triggerEnd, ch);
  if (query.length > 120) return null;
  if (query.includes("]]") || query.includes(trigger) || query.includes("	")) {
    return null;
  }
  if (query.startsWith("  ")) {
    return null;
  }
  return {
    start: triggerStart,
    end: ch,
    query
  };
}
function isExcludedContext(sections, line, lineText, ch) {
  if (sections && sections.length > 0) {
    for (const sec of sections) {
      if (sec.position && line >= sec.position.start.line && line <= sec.position.end.line) {
        const type = (sec.type || "").toLowerCase();
        if (type === "code" || type === "math" || type === "frontmatter" || type === "yaml") {
          return true;
        }
      }
    }
  }
  const textBeforeCursor = lineText.slice(0, ch);
  if (!/[`$]|\[\[/.test(textBeforeCursor)) {
    return false;
  }
  let codeRun = 0;
  let inSingleMath = false;
  let inDoubleMath = false;
  let openLinks = 0;
  let i = 0;
  while (i < textBeforeCursor.length) {
    const c = textBeforeCursor[i];
    if (c === "`" && !inSingleMath && !inDoubleMath) {
      let run = 1;
      while (textBeforeCursor[i + run] === "`") run++;
      if (codeRun === 0) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      i += run;
      continue;
    }
    if (codeRun > 0) {
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "$") {
      if (textBeforeCursor[i + 1] === "$" && !inSingleMath) {
        inDoubleMath = !inDoubleMath;
        i += 2;
        continue;
      }
      if (inSingleMath) {
        inSingleMath = false;
      } else if (!inDoubleMath) {
        const next = lineText[i + 1];
        if (next !== void 0 && !/[\s\d]/.test(next)) inSingleMath = true;
      }
      i++;
      continue;
    }
    if (!inSingleMath && !inDoubleMath) {
      if (c === "[" && textBeforeCursor[i + 1] === "[") {
        openLinks++;
        i += 2;
        continue;
      }
      if (c === "]" && textBeforeCursor[i + 1] === "]" && openLinks > 0) {
        openLinks--;
        i += 2;
        continue;
      }
    }
    i++;
  }
  return codeRun > 0 || inSingleMath || inDoubleMath || openLinks > 0;
}
function formatCitation2(format = "[[{{citekey}}]]", citekey) {
  if (!format.includes("{{citekey}}") && !format.includes("{{ citekey }}")) {
    throw new Error('Citation format must contain "{{citekey}}"');
  }
  return format.replace(/\{\{\s*citekey\s*\}\}/g, citekey);
}
function citedKeys(noteText) {
  const result = /* @__PURE__ */ new Set();
  if (!noteText) return result;
  let stripped = noteText.replace(/```[\s\S]*?```/g, " ");
  stripped = stripped.replace(/`[^`\n]*`/g, " ");
  const fmMatch = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const citekeyMatch = fm.match(/^citekey:\s*["']?([^\s"'\r\n]+)["']?/m);
    if (citekeyMatch && citekeyMatch[1]) {
      result.add(citekeyMatch[1].trim());
    }
  }
  const wikiRegex = /\[\[([a-zA-Z0-9_.-]+)(?:\|[^\]\n]*)?\]\]/g;
  let match;
  while ((match = wikiRegex.exec(stripped)) !== null) {
    if (match[1]) {
      result.add(match[1].trim());
    }
  }
  const bracketRegex = /\[([^\]\n]*@[a-zA-Z0-9_.-]+[^\]\n]*)\]/g;
  while ((match = bracketRegex.exec(stripped)) !== null) {
    const bracketContent = match[1];
    const keyRegex = /@([a-zA-Z0-9_.-]+)/g;
    let keyMatch;
    while ((keyMatch = keyRegex.exec(bracketContent)) !== null) {
      if (keyMatch[1]) {
        result.add(keyMatch[1].trim());
      }
    }
  }
  return result;
}

// src/inline.ts
var LRUQueryCache = class {
  map = /* @__PURE__ */ new Map();
  maxEntries;
  constructor(maxEntries = 16) {
    this.maxEntries = maxEntries;
  }
  get(key) {
    if (!this.map.has(key)) return void 0;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== void 0) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, val);
  }
  has(key) {
    return this.map.has(key);
  }
  clear() {
    this.map.clear();
  }
  size() {
    return this.map.size;
  }
};
function selectionAfterRefresh(oldHits, oldSelected, newHits) {
  const oldPaper = oldHits[oldSelected]?.paper;
  if (!oldPaper) return 0;
  const idx = newHits.findIndex((h) => h.paper && h.paper.citekey === oldPaper.citekey);
  return idx === -1 ? 0 : idx;
}
function refreshSuggestions(suggest, hits, query, cache) {
  if (!suggest) return;
  const s = suggest.suggestions;
  if (s && typeof s.setSuggestions === "function") {
    const newIdx = selectionAfterRefresh(s.values || [], s.selectedItem ?? 0, hits);
    s.setSuggestions(hits);
    if (s.values !== hits) s.values = hits;
    if (typeof s.setSelectedItem === "function") s.setSelectedItem(newIdx);
    else s.selectedItem = newIdx;
  } else if (query && cache) {
    cache.set(query, hits);
  }
}
var InlineSuggestController = class {
  indexStore;
  embedder;
  vault;
  metadataCache;
  settings;
  queryCache = new LRUQueryCache(16);
  debounceTimer = null;
  currentSeq = 0;
  ollamaDownNotified = false;
  /** content_hash (or load id) of the index the query cache was filled from. */
  cacheVersion = void 0;
  sessionNotices;
  showNotice;
  setTimeoutFn;
  clearTimeoutFn;
  constructor(options) {
    this.sessionNotices = options.sessionNotices ?? /* @__PURE__ */ new Set();
    this.indexStore = options.indexStore;
    this.embedder = options.embedder;
    this.vault = options.vault;
    this.metadataCache = options.metadataCache;
    this.settings = options.settings || {};
    this.showNotice = options.showNotice;
    this.setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));
  }
  onTrigger(cursor, lineText, sections) {
    const trigger = this.settings.inlineTrigger || "@@";
    const res = findTrigger(lineText, cursor.ch, trigger);
    if (!res) return null;
    if (isExcludedContext(sections, cursor.line, lineText, cursor.ch)) {
      return null;
    }
    return {
      start: { line: cursor.line, ch: res.start },
      end: { line: cursor.line, ch: res.end },
      query: res.query
    };
  }
  /** Drop any pending or in-flight semantic request (list closed, or the query changed). */
  cancel() {
    this.currentSeq++;
    if (this.debounceTimer) {
      this.clearTimeoutFn(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
  async getSuggestions(query, suggestInstance) {
    this.cancel();
    this.indexStore.ensureFresh?.().catch(() => {
    });
    if (!this.indexStore.isReady()) {
      return [{ type: "loading", message: "Loading paper index\u2026" }];
    }
    if (query === "") {
      return [{ type: "hint", message: "Type to search your papers" }];
    }
    const index = this.indexStore.getIndex();
    const version = index?.manifest?.content_hash ?? index?.manifest?.built_at ?? index?.id;
    if (version !== this.cacheVersion) {
      this.queryCache.clear();
      this.cacheVersion = version;
    }
    if (this.queryCache.has(query)) {
      return this.queryCache.get(query);
    }
    const limit = this.settings.inlineLimit || 8;
    const kwHits = keyword(index, query, limit);
    const initialItems = kwHits.map((h) => ({
      type: "paper",
      paper: index.papers[h.paper],
      snippet: h.snippet,
      source: h.source,
      score: h.score
    }));
    if (shouldRunSemantic(query, this.settings.minCharsSemantic ?? 12) && this.embedder) {
      const seq = this.currentSeq;
      this.debounceTimer = this.setTimeoutFn(async () => {
        this.debounceTimer = null;
        try {
          let scores;
          if (this.embedder.rowScores) {
            scores = await this.embedder.rowScores(query, index);
            if (seq !== this.currentSeq) return;
          } else {
            const qVec = await this.embedder.embedQuery(query);
            if (seq !== this.currentSeq) {
              return;
            }
            if (!qVec) {
              this.handleOllamaDown(initialItems, suggestInstance);
              return;
            }
            scores = rowScores(index, qVec);
          }
          const merged = hybridSearchFromScores(index, query, scores, limit);
          const mergedItems = merged.map((h) => ({
            type: "paper",
            paper: index.papers[h.paper],
            snippet: h.snippet,
            source: h.source,
            score: h.score
          }));
          refreshSuggestions(suggestInstance, mergedItems, query, this.queryCache);
        } catch {
          if (seq !== this.currentSeq) return;
          this.handleOllamaDown(initialItems, suggestInstance);
        }
      }, 250);
    }
    return initialItems;
  }
  /** Keyword-only results with one footer row. Never cached, so the next query retries semantic. */
  handleOllamaDown(items, suggestInstance) {
    if (!this.ollamaDownNotified) {
      this.ollamaDownNotified = true;
      this.showNotice?.("Paper search: Ollama is not running. Using keyword-only search.");
    }
    const withSemanticOff = items.map((it) => ({ ...it, semanticOff: true }));
    withSemanticOff.push({ type: "footer", message: "Semantic search unavailable" });
    refreshSuggestions(suggestInstance, withSemanticOff);
  }
  async selectSuggestion(item, editor, context) {
    if (item.type !== "paper" || !item.paper) {
      return;
    }
    if (!item.paper.citekey) {
      this.showNotice?.("Paper search: paper has no citekey. Ensure Better BibTeX is installed in Zotero.");
      return;
    }
    const citation = formatCitation2(
      this.settings.citationFormat || "[[{{citekey}}]]",
      item.paper.citekey
    );
    editor.replaceRange(citation, context.start, context.end);
    if (editor.setCursor) {
      editor.setCursor({
        line: context.start.line,
        ch: context.start.ch + citation.length
      });
    }
    if (this.settings.createLiteratureNotes !== false) {
      try {
        await ensureLiteratureNote(
          this.vault,
          this.metadataCache,
          item.paper,
          this.settings,
          {
            showNotice: this.showNotice,
            sessionNotices: this.sessionNotices
          }
        );
      } catch {
      }
    }
  }
  renderSuggestion(item, el) {
    el.empty?.();
    if (item.type === "loading") {
      const row = el.createDiv?.({ cls: "daito-suggest-loading" }) || el;
      row.setText?.(item.message || "Loading paper index\u2026");
      return;
    }
    if (item.type === "footer") {
      const row = el.createDiv?.({ cls: "daito-suggest-footer" }) || el;
      row.setText?.(item.message || "Semantic search unavailable");
      return;
    }
    if (item.type === "hint") {
      const row = el.createDiv?.({ cls: "daito-suggest-hint" }) || el;
      row.setText?.(item.message || "Type to search your papers");
      return;
    }
    if (item.type === "paper" && item.paper) {
      const container = el.createDiv?.({ cls: "daito-suggest-paper" }) || el;
      let title = item.paper.title || "Untitled";
      if (title.length > 80) {
        title = title.slice(0, 79) + "\u2026";
      }
      const titleEl = container.createDiv?.({ cls: "daito-suggest-title" });
      titleEl?.setText?.(title);
      const firstAuthor = item.paper.authors && item.paper.authors.length > 0 ? item.paper.authors[0] : "Unknown author";
      const year = item.paper.year ? String(item.paper.year) : "n.d.";
      const metaEl = container.createDiv?.({ cls: "daito-suggest-meta" });
      metaEl?.setText?.(`${firstAuthor} \xB7 ${year}`);
      if (this.settings.inlineShowSnippet !== false && item.snippet) {
        const snippetEl = container.createDiv?.({ cls: "daito-suggest-snippet" });
        snippetEl?.setText?.(item.snippet);
      }
    }
  }
};
function createPaperSearchSuggestClass(BaseClass) {
  return class PaperSearchSuggest extends BaseClass {
    controller;
    constructor(app, controller) {
      super(app);
      this.controller = controller;
      this.scope?.register?.([], "Tab", (evt) => {
        if (typeof this.suggestions?.useSelectedItem !== "function") return true;
        this.suggestions.useSelectedItem(evt);
        return false;
      });
    }
    onTrigger(cursor, editor, file) {
      const lineText = editor.getLine(cursor.line);
      const cache = this.app.metadataCache.getFileCache(file);
      return this.controller.onTrigger(cursor, lineText, cache?.sections);
    }
    getSuggestions(context) {
      return this.controller.getSuggestions(context.query, this);
    }
    renderSuggestion(value, el) {
      this.controller.renderSuggestion(value, el);
    }
    close() {
      this.controller.cancel();
      super.close();
    }
    selectSuggestion(value, evt) {
      if (this.context) {
        this.controller.selectSuggestion(value, this.context.editor, {
          start: this.context.start,
          end: this.context.end
        });
      }
    }
  };
}

// src/passage.ts
function cleanMarkdown(text) {
  if (!text) return "";
  let s = text;
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---/g, " ");
  s = s.replace(/%%\s*planner:start\s*%%[\s\S]*?%%\s*planner:end\s*%%/gi, " ");
  s = s.replace(/%%[\s\S]*?%%/g, " ");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ");
  s = s.replace(/!\[\[[^\]\n]*\]\]/g, " ");
  s = s.replace(/!\[[^\]\n]*\]\([^\)\n]*\)/g, " ");
  s = s.replace(/https?:\/\/[^\s\)]+/g, " ");
  s = s.replace(/\[\[([^|\]\n]+)\|([^\]\n]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]\n]+)\]\]/g, "$1");
  s = s.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, " ");
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]*(>[ \t]?)+/gm, "");
  s = s.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, "");
  s = s.replace(/(\*\*|__|~~|==)(?=\S)([^\n]*?\S)\1/g, "$2");
  s = s.replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2");
  s = s.replace(/`+([^`\n]*?)`+/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
function shortenSentences(sentences, cursorIdx, maxChars = 2e3) {
  if (sentences.length === 0) return "";
  const safeCursorIdx = Math.max(0, Math.min(sentences.length - 1, cursorIdx));
  let chosen = [safeCursorIdx];
  let curLen = sentences[safeCursorIdx].length;
  let left = safeCursorIdx - 1;
  let right = safeCursorIdx + 1;
  while (left >= 0 || right < sentences.length) {
    let added = false;
    if (left >= 0) {
      const addedLen = sentences[left].length + 1;
      if (curLen + addedLen <= maxChars) {
        chosen.unshift(left);
        curLen += addedLen;
        left--;
        added = true;
      } else {
        left = -1;
      }
    }
    if (right < sentences.length) {
      const addedLen = sentences[right].length + 1;
      if (curLen + addedLen <= maxChars) {
        chosen.push(right);
        curLen += addedLen;
        right++;
        added = true;
      } else {
        right = sentences.length;
      }
    }
    if (!added) break;
  }
  chosen.sort((a, b) => a - b);
  return chosen.map((idx) => sentences[idx]).join(" ");
}
function extractPassage(noteText, cursorOffset, selection = "", maxChars = 2e3) {
  if (selection) {
    const cleanSel = cleanMarkdown(selection);
    if (cleanSel.length >= 20) {
      const sentences2 = splitSentences(cleanSel);
      if (sentences2.length === 0) return cleanSel.slice(0, maxChars);
      return shortenSentences(sentences2, 0, maxChars);
    }
  }
  const headingRegex = /^#{1,6}\s+.+$/gm;
  let prevHeadingEnd = 0;
  let nextHeadingStart = noteText.length;
  let match;
  while ((match = headingRegex.exec(noteText)) !== null) {
    const headingStart = match.index;
    const headingEnd = headingStart + match[0].length;
    if (headingEnd <= cursorOffset) {
      prevHeadingEnd = headingEnd;
    } else if (headingStart > cursorOffset) {
      nextHeadingStart = headingStart;
      break;
    }
  }
  const sectionRaw = noteText.slice(prevHeadingEnd, nextHeadingStart);
  const cleanSec = cleanMarkdown(sectionRaw);
  if (cleanSec.length >= 200) {
    const sentences2 = splitSentences(cleanSec);
    if (sentences2.length === 0) return cleanSec.slice(0, maxChars);
    const approxCleanOffset2 = cleanMarkdown(noteText.slice(prevHeadingEnd, Math.max(prevHeadingEnd, cursorOffset))).length;
    let cursorSentenceIdx2 = 0;
    let accumulated2 = 0;
    for (let i = 0; i < sentences2.length; i++) {
      accumulated2 += sentences2[i].length + 1;
      if (accumulated2 >= approxCleanOffset2) {
        cursorSentenceIdx2 = i;
        break;
      }
    }
    return shortenSentences(sentences2, cursorSentenceIdx2, maxChars);
  }
  const cleanWhole = cleanMarkdown(noteText);
  if (cleanWhole.length < 30) {
    return null;
  }
  const sentences = splitSentences(cleanWhole);
  if (sentences.length === 0) return cleanWhole.slice(0, maxChars);
  const approxCleanOffset = cleanMarkdown(noteText.slice(0, Math.max(0, cursorOffset))).length;
  let cursorSentenceIdx = 0;
  let accumulated = 0;
  for (let i = 0; i < sentences.length; i++) {
    accumulated += sentences[i].length + 1;
    if (accumulated >= approxCleanOffset) {
      cursorSentenceIdx = i;
      break;
    }
  }
  return shortenSentences(sentences, cursorSentenceIdx, maxChars);
}

// src/editortracker.ts
function isMarkdownView(view) {
  return !!view && typeof view.getViewType === "function" && view.getViewType() === "markdown" && !!view.editor;
}
var ActiveEditorTracker = class {
  last = null;
  /** Call from workspace "active-leaf-change". */
  onActiveLeafChange(leaf) {
    const view = leaf?.view;
    if (isMarkdownView(view)) this.last = view;
  }
  /** Call once on layout ready with the currently active Markdown view, if any. */
  seed(view) {
    if (isMarkdownView(view)) this.last = view;
  }
  /** The last Markdown view, or null if it has since been closed or its leaf reused. */
  get() {
    const v = this.last;
    if (!v) return null;
    if (v.leaf && v.leaf.view !== v) {
      this.last = null;
      return null;
    }
    return v;
  }
};
function editorSnapshot(view) {
  const editor = view?.editor;
  if (!editor) return null;
  return {
    text: editor.getValue(),
    cursorOffset: editor.posToOffset(editor.getCursor()),
    selection: editor.getSelection(),
    filePath: view?.file?.path || ""
  };
}

// src/related.ts
var RelatedPapersController = class {
  indexStore;
  embedder;
  vault;
  metadataCache;
  settings;
  showNotice;
  setTimeoutFn;
  clearTimeoutFn;
  state = "empty";
  allHits = [];
  citedKeysSet = /* @__PURE__ */ new Set();
  showHiddenCited = false;
  activeFilePath = "";
  lastRefreshedPath = "";
  lastRefreshedPassage = "";
  currentSeq = 0;
  autoRefreshTimer = null;
  ollamaDownNotified = false;
  sessionNotices;
  onStateChange;
  constructor(options) {
    this.sessionNotices = options.sessionNotices ?? /* @__PURE__ */ new Set();
    this.indexStore = options.indexStore;
    this.embedder = options.embedder;
    this.vault = options.vault;
    this.metadataCache = options.metadataCache;
    this.settings = options.settings || {};
    this.showNotice = options.showNotice;
    this.setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));
  }
  setState(newState) {
    this.state = newState;
    this.onStateChange?.(newState);
  }
  /** Drop results and any in-flight refresh; the panel shows its empty state. */
  resetToEmpty() {
    this.currentSeq++;
    this.allHits = [];
    this.citedKeysSet = /* @__PURE__ */ new Set();
    this.showHiddenCited = false;
    this.lastRefreshedPath = "";
    this.lastRefreshedPassage = "";
    this.setState("empty");
  }
  onFileOpen(file, getTextFn, cursorOffset = 0, selection = "") {
    const filePath = file?.path || "";
    const switched = filePath !== this.activeFilePath;
    this.activeFilePath = filePath;
    if (this.autoRefreshTimer) {
      this.clearTimeoutFn(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    if (!file || switched) {
      this.resetToEmpty();
    }
    if (!file) return;
    if (!this.settings.relatedAutoRefresh) {
      return;
    }
    this.autoRefreshTimer = this.setTimeoutFn(() => {
      if (getTextFn && this.activeFilePath === filePath) {
        const text = getTextFn();
        this.refresh(text, cursorOffset, selection, filePath, true);
      }
    }, 1e3);
  }
  async refresh(noteText, cursorOffset = 0, selection = "", filePath = this.activeFilePath, isAuto = false) {
    if (filePath) {
      this.activeFilePath = filePath;
    }
    const passage = extractPassage(noteText, cursorOffset, selection, 2e3);
    if (!passage) {
      this.setState("too-short");
      return;
    }
    if (isAuto && (this.state === "results" || this.state === "nothing-close") && filePath === this.lastRefreshedPath && passage === this.lastRefreshedPassage) {
      return;
    }
    const seq = ++this.currentSeq;
    const pathAtStart = filePath;
    if (!this.indexStore.isReady()) {
      this.setState("index-loading");
      return;
    }
    this.setState("loading");
    if (this.indexStore.ensureFresh) {
      await this.indexStore.ensureFresh().catch(() => false);
      if (seq !== this.currentSeq) return;
      if (this.activeFilePath !== pathAtStart) {
        this.resetToEmpty();
        return;
      }
    }
    try {
      const instruction = this.settings.relatedInstruction;
      const byScores = !!this.embedder.rowScores;
      const qVec = byScores ? null : await this.embedder.embedQuery(passage, instruction);
      if (seq !== this.currentSeq) return;
      if (this.activeFilePath !== pathAtStart) {
        this.resetToEmpty();
        return;
      }
      const ix = this.indexStore.isReady() ? this.indexStore.getIndex() : null;
      if (!ix) {
        this.setState("index-loading");
        return;
      }
      let scores;
      if (byScores) {
        scores = await this.embedder.rowScores(passage, ix, instruction);
        if (seq !== this.currentSeq) return;
        if (this.activeFilePath !== pathAtStart) {
          this.resetToEmpty();
          return;
        }
      } else {
        if (!qVec) {
          this.handleOllamaDown();
          return;
        }
        scores = rowScores(ix, qVec);
      }
      const minScore = this.settings.relatedMinScore ?? 0.25;
      const candidates = scores ? semanticFromRowScores(ix, scores, passage, { limit: 50, minScore }) : [];
      this.citedKeysSet = new Set([...citedKeys(noteText)].map((k) => k.toLowerCase()));
      this.allHits = candidates;
      this.showHiddenCited = false;
      this.lastRefreshedPath = pathAtStart;
      this.lastRefreshedPassage = passage;
      this.settleResultsState();
    } catch {
      if (seq === this.currentSeq && this.activeFilePath === pathAtStart) {
        if (this.indexStore.isReady()) this.handleOllamaDown();
        else this.setState("index-loading");
      }
    }
  }
  /** "results" when something uncited (or the revealed cited ones) is listed, else "nothing-close". */
  settleResultsState() {
    const { items } = this.getDisplayItems();
    this.setState(items.length > 0 ? "results" : "nothing-close");
  }
  handleOllamaDown() {
    if (!this.ollamaDownNotified) {
      this.ollamaDownNotified = true;
      this.showNotice?.("Paper search: Ollama is not running for related papers.");
    }
    this.setState("needs-ollama");
  }
  getDisplayItems() {
    const ix = this.indexStore.getIndex();
    if (!ix) return { items: [], hiddenCount: 0, showHidden: false };
    const limit = this.settings.relatedLimit || 5;
    const uncitedItems = [];
    const citedItems = [];
    for (const h of this.allHits) {
      const paper = ix.papers[h.paper];
      const isCited = !!paper.citekey && this.citedKeysSet.has(paper.citekey.toLowerCase());
      const item = { hit: h, paper, isCited };
      if (isCited) {
        citedItems.push(item);
      } else {
        uncitedItems.push(item);
      }
    }
    const hiddenCount = citedItems.length;
    let items;
    if (this.showHiddenCited) {
      items = [...uncitedItems.slice(0, limit), ...citedItems];
    } else {
      items = uncitedItems.slice(0, limit);
    }
    return {
      items,
      hiddenCount,
      showHidden: this.showHiddenCited
    };
  }
  toggleShowHidden() {
    this.showHiddenCited = !this.showHiddenCited;
    if (this.state === "results" || this.state === "nothing-close") this.settleResultsState();
    else this.setState(this.state);
  }
  async handleCiteAction(paper, activeEditor, clipboard) {
    const format = this.settings.citationFormat || "[[{{citekey}}]]";
    const citation = formatCitation2(format, paper.citekey);
    if (activeEditor) {
      const cursor = activeEditor.getCursor ? activeEditor.getCursor() : { line: 0, ch: 0 };
      activeEditor.replaceRange(citation, cursor);
    } else if (clipboard) {
      await clipboard.writeText(citation);
      this.showNotice?.("Copied citation to clipboard");
    }
    if (this.settings.createLiteratureNotes !== false) {
      try {
        await ensureLiteratureNote(
          this.vault,
          this.metadataCache,
          paper,
          this.settings,
          {
            showNotice: this.showNotice,
            sessionNotices: this.sessionNotices
          }
        );
      } catch {
      }
    }
  }
  async handleNoteAction(paper, workspace) {
    const res = await ensureLiteratureNote(
      this.vault,
      this.metadataCache,
      paper,
      this.settings,
      {
        showNotice: this.showNotice,
        sessionNotices: this.sessionNotices
      }
    );
    if (res.file && workspace?.openFile) {
      await workspace.openFile(res.file);
    }
  }
  /** The attachment that matched (a PDF at the matching page, or a web snapshot); see hitUrl. */
  getPdfUrl(paper, hit) {
    return hitUrl(paper, hit);
  }
};
function createRelatedPapersViewClass(ItemViewBase) {
  return class RelatedPapersView extends ItemViewBase {
    controller;
    tracker;
    constructor(leaf, controller, tracker) {
      super(leaf);
      this.controller = controller;
      this.tracker = tracker;
      this.controller.onStateChange = () => this.render();
    }
    getViewType() {
      return "daito-related-papers";
    }
    getDisplayText() {
      return "Related papers";
    }
    getIcon() {
      return "documents";
    }
    async onOpen() {
      this.render();
    }
    render() {
      const container = this.containerEl.children[1] || this.containerEl;
      container.empty?.();
      const header = container.createDiv?.({ cls: "daito-related-header" }) || container;
      const titleEl = header.createEl?.("h4", { text: "Related papers" });
      const refreshBtn = header.createEl?.("button", { text: "Refresh" });
      refreshBtn?.addEventListener?.("click", () => {
        const snap = editorSnapshot(this.tracker.get());
        if (snap) {
          this.controller.refresh(snap.text, snap.cursorOffset, snap.selection, snap.filePath);
        }
      });
      const body = container.createDiv?.({ cls: "daito-related-body" }) || container;
      if (this.controller.state === "empty") {
        body.createEl?.("div", {
          cls: "daito-related-empty",
          text: "Open a note and press Refresh to find related papers."
        });
        return;
      }
      if (this.controller.state === "index-loading") {
        body.createEl?.("div", {
          cls: "daito-related-loading",
          text: "Loading paper index\u2026"
        });
        return;
      }
      if (this.controller.state === "loading") {
        body.createEl?.("div", {
          cls: "daito-related-loading",
          text: "Searching for related papers\u2026"
        });
        return;
      }
      if (this.controller.state === "too-short") {
        body.createEl?.("div", {
          cls: "daito-related-empty",
          text: "Write a bit more first"
        });
        return;
      }
      if (this.controller.state === "needs-ollama") {
        body.createEl?.("div", {
          cls: "daito-related-warning",
          text: "Related papers needs Ollama running"
        });
        return;
      }
      if (this.controller.state === "nothing-close") {
        body.createEl?.("div", {
          cls: "daito-related-empty",
          text: "Nothing close in your library"
        });
        if (this.controller.getDisplayItems().hiddenCount === 0) return;
      }
      if (this.controller.state === "results" || this.controller.state === "nothing-close") {
        const { items, hiddenCount, showHidden } = this.controller.getDisplayItems();
        for (const item of items) {
          const row = body.createDiv?.({ cls: "daito-related-row" });
          const rowTitle = row?.createDiv?.({
            cls: "daito-related-title",
            text: item.paper.title || "Untitled"
          });
          rowTitle?.addEventListener?.("click", () => {
            const url = this.controller.getPdfUrl(item.paper, item.hit);
            window.open(url);
          });
          const meta = row?.createDiv?.({ cls: "daito-related-meta" });
          const author = item.paper.authors?.[0] || "Unknown";
          const year = item.paper.year ? String(item.paper.year) : "n.d.";
          const badge = item.hit.page ? `p. ${item.hit.page}` : item.hit.fromAbstract === false ? "web page" : "abstract";
          meta?.setText?.(`${author} \xB7 ${year} \xB7 [${badge}]`);
          if (item.hit.snippet) {
            const snippet = row?.createDiv?.({ cls: "daito-related-snippet" });
            snippet?.setText?.(item.hit.snippet);
          }
          const actions = row?.createDiv?.({ cls: "daito-related-actions" });
          const citeBtn = actions?.createEl?.("button", { text: "Cite" });
          citeBtn?.addEventListener?.("click", () => {
            this.controller.handleCiteAction(
              item.paper,
              this.tracker.get()?.editor,
              navigator.clipboard
            );
          });
          const noteBtn = actions?.createEl?.("button", { text: "Note" });
          noteBtn?.addEventListener?.("click", () => {
            this.controller.handleNoteAction(item.paper, this.app.workspace);
          });
        }
        if (hiddenCount > 0) {
          const footer = body.createDiv?.({ cls: "daito-related-footer" });
          const toggleText = showHidden ? "hide" : "show";
          const link = footer?.createEl?.("a", {
            text: `${hiddenCount} already cited \xB7 ${toggleText}`
          });
          link?.addEventListener?.("click", (e) => {
            e.preventDefault();
            this.controller.toggleShowHidden();
          });
        }
      }
    }
  };
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
  relatedMinScore: 0.5,
  relatedAutoRefresh: false,
  relatedInstruction: "Given a passage from my research notes, retrieve papers that report the findings or methods it discusses"
};
var PaperSearchPlugin = class extends import_obsidian2.Plugin {
  settings = DEFAULT_SETTINGS;
  indexStore;
  /** Once-per-session literature-note notices, shared by the modal, @@ and the panel. */
  litNoteNotices = /* @__PURE__ */ new Set();
  editorTracker = new ActiveEditorTracker();
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
    const embedder = {
      embedQuery: async (queryText) => {
        const ix = this.indexStore.getIndex();
        if (!ix) return null;
        return embedQuery(import_obsidian2.requestUrl, {
          url: this.settings.ollamaUrl,
          model: ix.manifest?.model || "qwen3-embedding:0.6b",
          instruction: ix.manifest?.query_instruction || "Given a query, retrieve relevant research papers",
          query: queryText,
          dims: ix.dims
        });
      },
      rowScores: (queryText, ix) => this.semanticScoresFor(ix, queryText, ix.manifest?.query_instruction || "Given a query, retrieve relevant research papers")
    };
    const suggestController = new InlineSuggestController({
      indexStore: this.indexStore,
      embedder,
      vault: this.app.vault,
      metadataCache: this.app.metadataCache,
      settings: this.settings,
      showNotice: (msg) => new import_obsidian2.Notice(msg),
      sessionNotices: this.litNoteNotices
    });
    const PaperSearchSuggest = createPaperSearchSuggestClass(import_obsidian2.EditorSuggest);
    this.registerEditorSuggest(new PaperSearchSuggest(this.app, suggestController));
    const relatedEmbedder = {
      embedQuery: async (text, instruction) => {
        const ix = this.indexStore.getIndex();
        if (!ix) return null;
        return embedQuery(import_obsidian2.requestUrl, {
          url: this.settings.ollamaUrl,
          model: ix.manifest?.model || "qwen3-embedding:0.6b",
          instruction: instruction ?? this.settings.relatedInstruction,
          query: text,
          dims: ix.dims
        });
      },
      rowScores: (text, ix, instruction) => this.semanticScoresFor(ix, text, instruction ?? this.settings.relatedInstruction)
    };
    const relatedController = new RelatedPapersController({
      indexStore: this.indexStore,
      embedder: relatedEmbedder,
      vault: this.app.vault,
      metadataCache: this.app.metadataCache,
      settings: this.settings,
      showNotice: (msg) => new import_obsidian2.Notice(msg),
      sessionNotices: this.litNoteNotices
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.editorTracker.onActiveLeafChange(leaf)));
    this.app.workspace.onLayoutReady(() => this.editorTracker.seed(this.app.workspace.getActiveViewOfType(import_obsidian2.MarkdownView)));
    const RelatedPapersView = createRelatedPapersViewClass(import_obsidian2.ItemView);
    this.registerView(
      "daito-related-papers",
      (leaf) => new RelatedPapersView(leaf, relatedController, this.editorTracker)
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        relatedController.onFileOpen(
          file ? { path: file.path } : null,
          () => this.editorTracker.get()?.editor?.getValue() || ""
        );
      })
    );
    this.addCommand({
      id: "show-related-papers",
      name: "Show related papers",
      callback: () => {
        this.activateRelatedView();
      }
    });
    this.addCommand({
      id: "find-related-papers",
      name: "Find papers related to this note",
      callback: async () => {
        const snap = editorSnapshot(this.editorTracker.get());
        await this.activateRelatedView();
        if (snap) {
          await relatedController.refresh(snap.text, snap.cursorOffset, snap.selection, snap.filePath);
        }
      }
    });
    this.addSettingTab(new PaperSearchSettingTab(this.app, this));
  }
  async activateRelatedView() {
    const { workspace } = this.app;
    let leaf = null;
    const leaves = workspace.getLeavesOfType("daito-related-papers");
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: "daito-related-papers",
          active: true
        });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
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
  /** Per-row semantic scores of `text` over `ix`, from the backend that built it (semantic.ts). Throws when it is down. */
  async semanticScoresFor(ix, text, instruction) {
    return (await semanticScores(import_obsidian2.requestUrl, ix, text, { ollamaUrl: this.settings.ollamaUrl, instruction })).scores;
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
    new import_obsidian2.Setting(containerEl).setName("Inline Suggestion Limit").setDesc("Maximum number of suggestions shown while typing (default 8)").addText(
      (text) => text.setPlaceholder("8").setValue(String(this.plugin.settings.inlineLimit || 8)).onChange(async (value) => {
        const parsed = parseInt(value.trim(), 10);
        if (!isNaN(parsed) && parsed > 0) {
          this.plugin.settings.inlineLimit = parsed;
          await this.plugin.saveSettings();
        }
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Inline Show Snippets").setDesc("Show matched snippet text below each paper in the inline suggestion list").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.inlineShowSnippet).onChange(async (value) => {
        this.plugin.settings.inlineShowSnippet = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Related Papers Limit").setDesc("Maximum number of related papers shown in the right sidebar (default 5)").addText(
      (text) => text.setPlaceholder("5").setValue(String(this.plugin.settings.relatedLimit || 5)).onChange(async (value) => {
        const parsed = parseInt(value.trim(), 10);
        if (!isNaN(parsed) && parsed > 0) {
          this.plugin.settings.relatedLimit = parsed;
          await this.plugin.saveSettings();
        }
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Related Minimum Score").setDesc("Minimum cosine similarity threshold to display related papers (default 0.50)").addText(
      (text) => text.setPlaceholder("0.50").setValue(String(this.plugin.settings.relatedMinScore ?? 0.5)).onChange(async (value) => {
        const parsed = parseFloat(value.trim());
        if (!isNaN(parsed) && parsed >= 0) {
          this.plugin.settings.relatedMinScore = parsed;
          await this.plugin.saveSettings();
        }
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Related Auto-Refresh").setDesc("Automatically refresh related papers 1s after switching active note").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.relatedAutoRefresh).onChange(async (value) => {
        this.plugin.settings.relatedAutoRefresh = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Related Retrieval Instruction").setDesc("Embedding instruction prefix used to query related papers").addTextArea(
      (text) => text.setPlaceholder(DEFAULT_SETTINGS.relatedInstruction).setValue(this.plugin.settings.relatedInstruction).onChange(async (value) => {
        this.plugin.settings.relatedInstruction = value.trim() || DEFAULT_SETTINGS.relatedInstruction;
        await this.plugin.saveSettings();
      })
    );
  }
};
