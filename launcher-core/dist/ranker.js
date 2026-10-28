"use strict";
(() => {
  // ../obsidian/paper-search/src/core/text.ts
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
    let lastRaw = "";
    for (let i = rawParts.length - 1; i >= 0 && !lastRaw; i--) lastRaw = rawParts[i];
    const lastIncomplete = tokens.length > 0 && tokens[tokens.length - 1] === lastRaw;
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

  // ../obsidian/paper-search/src/core/rank.ts
  function shouldRunSemantic(query, minChars = 12) {
    if (semanticText(query).length >= minChars) {
      return true;
    }
    const { tokens, lastIncomplete } = tokenize(query);
    const last = tokens[tokens.length - 1] ?? "";
    const lastCounts = !lastIncomplete || last.length >= 3 || /\d/.test(last);
    return (lastCounts ? tokens.length : tokens.length - 1) >= 2;
  }
  function semanticText(query) {
    return query.trim().replace(/\s+/g, " ");
  }
  function reciprocalRankFusion(lists, key, k = 60) {
    const byKey = /* @__PURE__ */ new Map();
    lists.forEach((list, li) => {
      list.forEach((item, i) => {
        const id = key(item);
        let f = byKey.get(id);
        if (!f) byKey.set(id, f = { score: 0, from: new Array(lists.length).fill(void 0) });
        f.score += 1 / (k + i + 1);
        f.from[li] = item;
      });
    });
    return [...byKey.values()].sort((a, b) => b.score - a.score);
  }

  // ../obsidian/paper-search/src/core/bm25.ts
  var FIELD_WEIGHTS = {
    title: 3,
    authors: 3,
    citekey: 3,
    journal: 1,
    tags: 2,
    collections: 2,
    abstract: 1.5
  };
  var FIELD_TEXT = {
    title: (p) => p.title || "",
    authors: (p) => p.authors.join(" "),
    citekey: (p) => p.citekey || "",
    journal: (p) => p.journal || "",
    tags: (p) => p.tags.join(" "),
    collections: (p) => p.collections.join(" "),
    abstract: (p) => p.abstract || ""
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
        const fieldTexts = fieldNames.map((name) => FIELD_TEXT[name](paper));
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
      const order2 = Array.from({ length: V }, (_, i) => i).sort((a, b) => terms[a] < terms[b] ? -1 : terms[a] > terms[b] ? 1 : 0);
      const rank = new Int32Array(V);
      this.sortedVocab = new Array(V);
      this.dfById = new Int32Array(V);
      for (let i = 0; i < V; i++) {
        rank[order2[i]] = i;
        this.sortedVocab[i] = terms[order2[i]];
        this.dfById[i] = df[order2[i]];
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
    /**
     * The vocabulary words a last word of 3+ characters expands to (at most 64, the most frequent first; the word itself
     * is always kept), each with a weight on its postings. A longer word is scored as if it were no rarer than the typed
     * word (or, while the typed word is not a vocabulary term yet, the most frequent expansion): otherwise a rare variant
     * ("cells121" from a glued citation number, "transferrin" for "transfer") has a far higher idf than the word being
     * typed and its few papers jump to the top. When the typed word is a term itself, longer words count half, so "cell"
     * ranks papers saying "cell" above papers saying only "cellular".
     */
    prefixMatcher(t) {
      const [start, end] = this.findPrefixRange(t);
      const candidates = [];
      for (let id = start; id < end; id++) candidates.push(id);
      const exact = this.termId(t);
      if (candidates.length > 64) {
        candidates.sort((a, b) => this.dfById[b] - this.dfById[a] || a - b);
        candidates.length = 64;
        if (exact >= 0 && !candidates.includes(exact)) candidates[63] = exact;
      }
      if (candidates.length === 0) return { matchingTerms: [], weights: [] };
      let refDf = exact >= 0 ? this.dfById[exact] : 0;
      if (exact < 0) for (const id of candidates) refDf = Math.max(refDf, this.dfById[id]);
      const refIdf = this.idfFromDf(refDf);
      const variant = exact >= 0 ? 0.5 : 1;
      const weights = candidates.map((id) => id === exact ? 1 : variant * Math.min(1, refIdf / this.idfFromDf(this.dfById[id])));
      return { matchingTerms: candidates, weights };
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
              termMatchers.push({ matchingTerms: [id], weights: [1] });
            }
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
      this.paperScoresBuf.fill(0);
      this.chunkScoresBuf.fill(0);
      this.bestChunkScoreBuf.fill(0);
      this.bestChunkIndexBuf.fill(-1);
      const matcherPaperScores = /* @__PURE__ */ new Map();
      const matcherChunkScores = /* @__PURE__ */ new Map();
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
      results.sort((a, b) => b.score - a.score || a.paperIndex - b.paperIndex);
      if (limit !== void 0) {
        return results.slice(0, limit);
      }
      return results;
    }
  };

  // ../obsidian/paper-search/src/core/textstore.ts
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

  // ../obsidian/paper-search/src/core/vectors.ts
  var FALLBACK_DIMS = 1024;
  function checkVectors(manifestDims, rows, byteLength) {
    const dimsOk = Number.isInteger(manifestDims) && manifestDims > 0;
    const dims = dimsOk ? manifestDims : FALLBACK_DIMS;
    if (byteLength === null) return { dims, reason: rows > 0 ? "no vectors" : null };
    if (!dimsOk) return { dims, reason: "index dims invalid" };
    if (byteLength !== rows * dims * 4) return { dims, reason: "vectors file invalid" };
    return { dims, reason: null };
  }

  // ../obsidian/paper-search/src/core/indexstore.ts
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
      const totalRows = _IndexStore.countRows(papers, chunks);
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
      let bin = null;
      let unreadable = false;
      if (await this.adapter.exists(vectorsPath)) {
        try {
          bin = await this.adapter.readBinary(vectorsPath);
        } catch {
          unreadable = true;
        }
      }
      const { dims, reason } = checkVectors(manifest.dims, _IndexStore.countRows(papers, chunks), bin ? bin.byteLength : null);
      let vectors = null;
      if (unreadable || bin && reason) {
        this.notifyOnce("invalid_vectors", "Paper search: vectors file invalid, falling back to keyword-only");
      } else if (bin) {
        vectors = new Float32Array(bin);
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

  // src/util.ts
  function isArrayBuffer(x) {
    return Object.prototype.toString.call(x) === "[object ArrayBuffer]";
  }
  function toBytes(x) {
    return isArrayBuffer(x) ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  }
  function toFloat32(x) {
    if (isArrayBuffer(x)) return new Float32Array(x);
    const v = x;
    if (v.byteOffset % 4 === 0) return new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
    return new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  }
  function decodeUtf8(input) {
    const b = toBytes(input);
    let i = 0;
    const n = b.length;
    if (n >= 3 && b[0] === 239 && b[1] === 187 && b[2] === 191) i = 3;
    const CH = 8192;
    const units = new Uint16Array(CH + 2);
    let u = 0;
    let out = "";
    const flush = () => {
      out += String.fromCharCode.apply(null, units.subarray(0, u));
      u = 0;
    };
    while (i < n) {
      const c = b[i++];
      let cp;
      if (c < 128) {
        cp = c;
      } else if (c >= 194 && c < 224 && i < n && (b[i] & 192) === 128) {
        cp = (c & 31) << 6 | b[i++] & 63;
      } else if (c >= 224 && c < 240 && i + 1 < n && (b[i] & 192) === 128 && (b[i + 1] & 192) === 128) {
        cp = (c & 15) << 12 | (b[i] & 63) << 6 | b[i + 1] & 63;
        i += 2;
        if (cp < 2048 || cp >= 55296 && cp < 57344) cp = 65533;
      } else if (c >= 240 && c < 245 && i + 2 < n && (b[i] & 192) === 128 && (b[i + 1] & 192) === 128 && (b[i + 2] & 192) === 128) {
        cp = (c & 7) << 18 | (b[i] & 63) << 12 | (b[i + 1] & 63) << 6 | b[i + 2] & 63;
        i += 3;
        if (cp < 65536 || cp > 1114111) cp = 65533;
      } else {
        cp = 65533;
      }
      if (cp >= 65536) {
        cp -= 65536;
        units[u++] = 55296 + (cp >> 10);
        units[u++] = 56320 + (cp & 1023);
      } else {
        units[u++] = cp;
      }
      if (u >= CH) flush();
    }
    flush();
    return out;
  }
  function parseJsonPart(part, timings) {
    let t = Date.now();
    const text = typeof part === "string" ? part : decodeUtf8(part);
    if (timings) timings.decode += Date.now() - t;
    t = Date.now();
    const value = JSON.parse(text);
    if (timings) timings.parse += Date.now() - t;
    return value;
  }
  function noteName(path) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base.replace(/\.md$/i, "");
  }
  function fileName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function folderOf(path) {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(epochSeconds) {
    const d = new Date(epochSeconds * 1e3);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  function isoDate(epochSeconds) {
    const d = new Date(epochSeconds * 1e3);
    const p = (x) => x < 10 ? `0${x}` : `${x}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // src/corpora.ts
  function buildCorpus(name, raw2) {
    const manifest = raw2.manifest ?? {};
    const rows = IndexStore.countRows(raw2.papers, raw2.chunks);
    const { dims, reason } = checkVectors(manifest.dims, rows, raw2.vectors ? raw2.vectors.byteLength : null);
    const vectors = raw2.vectors && !reason && rows > 0 ? toFloat32(raw2.vectors) : null;
    const chunks = raw2.chunks.map((c) => ({ ...c, row: c.row === null ? void 0 : c.row }));
    const ix = IndexStore.precomputeIndex(manifest, raw2.papers, chunks, vectors, dims, name);
    return { name, ix, semantic: vectors !== null, reason };
  }
  function buildCorpora(papersRaw, notesRaw) {
    return assembleCorpora(papersRaw ? buildCorpus("papers", papersRaw) : null, notesRaw ? buildCorpus("notes", notesRaw) : null);
  }
  function assembleCorpora(papers, notes) {
    const flags = [];
    if (!papers) flags.push("papers index missing");
    if (!notes) flags.push("notes index missing");
    if (papers?.reason) flags.push(`papers: semantic off (${papers.reason})`);
    const ref = papers ?? notes;
    const refM = ref?.ix.manifest ?? {};
    if (papers && notes) {
      const m = notes.ix.manifest ?? {};
      const pm = papers.ix.manifest ?? {};
      if (m.model !== pm.model || m.dims !== pm.dims || (m.query_instruction ?? "") !== (pm.query_instruction ?? "")) {
        notes.semantic = false;
        notes.reason = "index model differs";
      }
    }
    if (notes?.reason) flags.push(`notes: semantic off (${notes.reason})`);
    const litnoteByCitekey = /* @__PURE__ */ new Map();
    notes?.ix.papers.forEach((p) => {
      if (p.litnoteOf && p.path && !litnoteByCitekey.has(p.litnoteOf)) litnoteByCitekey.set(p.litnoteOf, { path: p.path });
    });
    const paperKeyByCitekey = /* @__PURE__ */ new Map();
    papers?.ix.papers.forEach((p) => {
      if (p.citekey) paperKeyByCitekey.set(p.citekey, p.key);
    });
    const nm = notes?.ix.manifest ?? {};
    return {
      papers,
      notes,
      flags,
      zoteroStorage: papers?.ix.manifest?.zotero_storage ?? null,
      vault: nm.vault ?? null,
      vaultName: nm.vault_name ?? "",
      model: refM.model ?? null,
      dims: ref ? ref.ix.dims : null,
      queryInstruction: refM.query_instruction ?? null,
      litnoteByCitekey,
      paperKeyByCitekey
    };
  }

  // ../obsidian/paper-search/src/core/engine.ts
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

  // src/merge.ts
  var order = (c) => c === "papers" ? 0 : 1;
  function interleave(papers, notes) {
    const out = [];
    const n = Math.max(papers.length, notes.length);
    for (let i = 0; i < n; i++) {
      if (i < papers.length) out.push(papers[i]);
      if (i < notes.length) out.push(notes[i]);
    }
    return out;
  }
  function sortByCosine(list) {
    return [...list].sort(
      (a, b) => b.hit.score - a.hit.score || order(a.corpus) - order(b.corpus) || a.hit.paper - b.hit.paper
    );
  }
  var keyOf = (c) => `${c.corpus}:${c.hit.paper}`;
  function rrf(kw, sem, k = 60) {
    if (sem.length === 0) return kw;
    if (kw.length === 0) return sem;
    return reciprocalRankFusion([kw, sem], keyOf, k).map(({ score, from: [w, s] }) => {
      const base = s ?? w;
      const source = s && w ? "both" : s ? "semantic" : "keyword";
      return { corpus: base.corpus, hit: { ...base.hit, score, source } };
    });
  }
  function collapseLitnotes(list, corpora) {
    const rows = [];
    const byCitekey = /* @__PURE__ */ new Map();
    for (const item of list) {
      let link = null;
      if (item.corpus === "papers") {
        link = corpora.papers?.ix.papers[item.hit.paper]?.citekey || null;
      } else {
        link = corpora.notes?.ix.papers[item.hit.paper]?.litnoteOf ?? null;
      }
      const existing = link ? byCitekey.get(link) : void 0;
      if (existing) {
        if (item.corpus === "papers" && !existing.paper) existing.paper = item;
        else if (item.corpus === "notes" && !existing.note) existing.note = item;
        continue;
      }
      const row = item.corpus === "papers" ? { paper: item, winner: "paper" } : { note: item, winner: "note" };
      rows.push(row);
      if (link) byCitekey.set(link, row);
    }
    return rows;
  }

  // shortcuts.json
  var shortcuts_default = {
    reserved: ["cmd+k", "cmd+d", "cmd+1", "cmd+2", "cmd+3", "cmd+w", "cmd+,", "cmd+q", "escape", "up", "down", "ctrl+n", "ctrl+p", "tab"],
    actions: [
      { id: "open", title: "Open", key: "return", kinds: ["paper", "note", "daily", "litnote"], needs: [] },
      { id: "paste-file", title: "Paste File", key: "cmd+return", kinds: ["paper", "note", "daily", "litnote"], needs: ["filePath"] },
      { id: "paste-passage", title: "Paste Passage with Citation", key: "cmd+shift+return", kinds: ["paper", "note", "daily", "litnote"], needs: [] },
      { id: "copy-file", title: "Copy File", key: "cmd+shift+c", kinds: ["paper", "note", "daily", "litnote"], needs: ["filePath"] },
      { id: "copy-passage", title: "Copy Passage with Citation", key: "cmd+option+c", kinds: ["paper", "note", "daily", "litnote"], needs: [] },
      { id: "copy-path", title: "Copy Path", key: "cmd+shift+.", kinds: ["paper", "note", "daily", "litnote"], needs: ["filePath"] },
      { id: "reveal", title: "Show in Finder", key: "cmd+shift+f", kinds: ["paper", "note", "daily", "litnote"], needs: ["filePath"] },
      { id: "quicklook", title: "Quick Look", key: "cmd+y", kinds: ["paper", "note", "daily", "litnote"], needs: ["filePath"] },
      { id: "paste-wikilink", title: "Paste Wikilink", key: "cmd+l", kinds: ["paper", "note", "daily", "litnote"], needs: [] },
      { id: "open-note", title: "Open Literature Note", key: "cmd+o", kinds: ["paper"], needs: ["noteUrl"] },
      { id: "select-zotero", title: "Select in Zotero", key: "cmd+shift+z", kinds: ["paper", "litnote"], needs: ["selectUrl"] }
    ]
  };

  // src/actions.ts
  var ACTIONS = shortcuts_default.actions;
  var RESERVED_KEYS = shortcuts_default.reserved;
  function actionsFor(kind, has) {
    return ACTIONS.filter((a) => a.kinds.includes(kind) && a.needs.every((n) => has[n])).map((a) => a.id);
  }

  // src/cite.ts
  function authorsShort(authors) {
    const a = authors.filter(Boolean);
    if (a.length === 0) return "";
    if (a.length === 1) return a[0];
    if (a.length === 2) return `${a[0]} & ${a[1]}`;
    return `${a[0]} et al.`;
  }
  function paperCitation(passage, authors, year, location) {
    const parts = [authorsShort(authors), year ? String(year) : "", location].filter(Boolean);
    return parts.length ? `"${passage}" (${parts.join(", ")})` : `"${passage}"`;
  }
  function noteCitation(passage, title, heading) {
    let h = heading ?? "";
    if (h === title) h = "";
    else if (h.startsWith(`${title} \u203A `)) h = h.slice(title.length + 3);
    return `"${passage}" (note: ${h ? `${title} \u203A ${h}` : title})`;
  }
  function paperWikilink(citekey) {
    return `[[${citekey}]]`;
  }
  function noteWikilink(path) {
    return `[[${noteName(path)}]]`;
  }

  // src/paths.ts
  function normalize(path) {
    const abs = path.startsWith("/");
    const out = [];
    for (const seg of path.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0) return null;
        out.pop();
      } else out.push(seg);
    }
    return (abs ? "/" : "") + out.join("/");
  }
  function resolveInside(root, relative) {
    if (!root || !relative || relative.startsWith("/")) return null;
    const r = normalize(root);
    const rel = normalize(relative);
    if (r === null || rel === null || rel === "") return null;
    return `${r.replace(/\/+$/, "")}/${rel}`;
  }
  function resolvePaperFile(storage, file) {
    if (!file) return null;
    if (file.startsWith("/")) return normalize(file);
    if (!storage) return null;
    return resolveInside(storage, file);
  }
  function resolveNoteFile(vault, path) {
    if (!vault || !path) return null;
    return resolveInside(vault, path);
  }
  function chooseAttachment(paper, winningKey) {
    const pdfs = paper.pdfs ?? [];
    const snaps = paper.snapshots ?? [];
    if (winningKey) {
      const p = pdfs.find((a) => a.attachmentKey === winningKey);
      if (p) return { attachmentKey: p.attachmentKey, file: p.file, kind: "pdf" };
      const s = snaps.find((a) => a.attachmentKey === winningKey);
      if (s) return { attachmentKey: s.attachmentKey, file: s.file, kind: "snapshot" };
    }
    if (pdfs[0]) return { attachmentKey: pdfs[0].attachmentKey, file: pdfs[0].file, kind: "pdf" };
    if (snaps[0]) return { attachmentKey: snaps[0].attachmentKey, file: snaps[0].file, kind: "snapshot" };
    return null;
  }

  // ../obsidian/paper-search/src/core/zotero.ts
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
  function hitLocation(paper, hit, snapshotLabel = "snapshot") {
    if (hit.fromAbstract) return "abstract";
    if (hit.attachmentKey && (paper.snapshots ?? []).some((s) => s.attachmentKey === hit.attachmentKey)) return snapshotLabel;
    return hit.page && hit.page > 0 ? `p. ${hit.page}` : "abstract";
  }

  // src/urls.ts
  var enc = encodeURIComponent;
  function obsidianOpenUrl(vaultName, path, heading) {
    const file = path.replace(/\.md$/i, "");
    const h = heading ? `%23${enc(heading)}` : "";
    return `obsidian://open?vault=${enc(vaultName)}&file=${enc(file)}${h}`;
  }
  function obsidianNewUrl(vaultName, name) {
    return `obsidian://new?vault=${enc(vaultName)}&file=${enc(name)}`;
  }
  function lastHeading(path) {
    if (!path) return void 0;
    const parts = path.split(" \u203A ");
    return parts[parts.length - 1] || void 0;
  }

  // src/vm.ts
  var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function boldRanges(text, tokens) {
    const toks = tokens.filter(Boolean);
    if (!toks.length || !text) return [];
    const rx = new RegExp(`(?<![\\p{L}\\p{N}])(?:${toks.map(escapeRe).join("|")})[\\p{L}\\p{N}]*`, "giu");
    const out = [];
    for (const m of text.matchAll(rx)) {
      const start = m.index;
      const end = start + m[0].length;
      const last = out[out.length - 1];
      if (last && start <= last[1] + 1 && text.slice(last[1], start).trim() === "") last[1] = end;
      else out.push([start, end]);
    }
    return out;
  }
  function paperSubtitle(p) {
    return [authorsShort(p.authors), p.year ? String(p.year) : "", p.journal ?? ""].filter(Boolean).join(" \xB7 ");
  }
  function detailRows(rows) {
    return rows.filter(([, v]) => v).map(([label, value]) => ({ label, value }));
  }
  function buildVM(row, c, tokens) {
    return row.paper ? paperVM(row, c, tokens) : noteVM(row, c, tokens, row.note.hit.snippet);
  }
  function noteHeading(c, row) {
    const hit = row.note.hit;
    if (hit.chunkIndex === void 0) return void 0;
    return c.notes.ix.chunks[hit.chunkIndex]?.heading || void 0;
  }
  function paperVM(row, c, tokens) {
    const phit = row.paper.hit;
    const paper = c.papers.ix.papers[phit.paper];
    const noteWon = row.winner === "note" && !!row.note;
    const nEntry = row.note ? c.notes.ix.papers[row.note.hit.paper] : void 0;
    const known = paper.citekey ? c.litnoteByCitekey.get(paper.citekey) : void 0;
    const notePath = nEntry?.path ?? known?.path;
    const hasNote = !!notePath;
    const loc = hitLocation(paper, phit);
    const att = chooseAttachment(paper, phit.attachmentKey);
    const filePath = att ? resolvePaperFile(c.zoteroStorage, att.file) : null;
    const heading = noteWon ? noteHeading(c, row) : void 0;
    const snippet = noteWon ? row.note.hit.snippet : phit.snippet;
    const noteUrl = notePath ? obsidianOpenUrl(c.vaultName, notePath) : paper.citekey && c.vaultName ? obsidianNewUrl(c.vaultName, paper.citekey) : null;
    const openUrl = noteWon && notePath ? obsidianOpenUrl(c.vaultName, notePath, lastHeading(heading)) : hitUrl(paper, phit);
    const openLabel = noteWon ? "Open in Obsidian" : !att ? "Show in Zotero" : att.kind === "snapshot" ? "Open snapshot in Zotero" : loc.startsWith("p.") ? `Open in Zotero at ${loc}` : "Open in Zotero";
    const selectUrl = selectItemUrl(paper.key);
    const has = { filePath: filePath !== null, noteUrl: noteUrl !== null, selectUrl: true };
    return {
      id: `P:${paper.key}`,
      kind: "paper",
      title: paper.title,
      subtitle: noteWon && heading ? heading : paperSubtitle(paper),
      accessory: noteWon && nEntry?.mtime ? shortDate(nEntry.mtime) : loc,
      snippet,
      snippetBold: boldRanges(snippet, tokens),
      hasNote,
      filePath,
      openUrl,
      openLabel,
      noteUrl,
      selectUrl,
      citation: noteWon ? noteCitation(snippet, nEntry.title, heading) : paperCitation(snippet, paper.authors, paper.year, loc),
      wikilink: paperWikilink(paper.citekey),
      actions: actionsFor("paper", has),
      detail: detailRows([
        ["Title", paper.title],
        ["Authors", paper.authors.join(", ")],
        ["Year", paper.year ? String(paper.year) : ""],
        ["Journal", paper.journal],
        ["DOI", paper.doi],
        ["Tags", paper.tags.join(", ")],
        ["Collections", paper.collections.join(", ")],
        ["File", att?.file ? fileName(att.file) : ""]
      ]),
      source: (noteWon ? row.note : row.paper).hit.source
    };
  }
  function noteVM(row, c, tokens, snippet) {
    const hit = row.note.hit;
    const entry = c.notes.ix.papers[hit.paper];
    const path = entry.path ?? "";
    const heading = noteHeading(c, row);
    const kind = entry.kind ?? "note";
    const filePath = resolveNoteFile(c.vault, path);
    const paperKey = entry.litnoteOf ? c.paperKeyByCitekey.get(entry.litnoteOf) : void 0;
    const selectUrl = paperKey ? selectItemUrl(paperKey) : null;
    const folder = folderOf(path);
    const has = { filePath: filePath !== null, noteUrl: false, selectUrl: selectUrl !== null };
    return {
      id: `N:${entry.key}`,
      kind,
      title: entry.title,
      subtitle: heading ?? folder,
      accessory: entry.mtime ? shortDate(entry.mtime) : "",
      snippet,
      snippetBold: boldRanges(snippet, tokens),
      hasNote: false,
      filePath,
      openUrl: obsidianOpenUrl(c.vaultName, path, lastHeading(heading)),
      openLabel: "Open in Obsidian",
      noteUrl: null,
      selectUrl,
      citation: noteCitation(snippet, entry.title, heading),
      wikilink: noteWikilink(path),
      actions: actionsFor(kind, has),
      detail: detailRows([
        ["Path", path],
        ["Tags", entry.tags.join(", ")],
        ["Modified", entry.mtime ? isoDate(entry.mtime) : ""],
        ["Heading", heading]
      ]),
      source: hit.source
    };
  }

  // src/query.ts
  var RECENT_LIMIT = 10;
  var Engine = class _Engine {
    corpora;
    opts;
    constructor(corpora, opts = {}) {
      this.corpora = corpora;
      this.opts = opts;
    }
    inScope(scope) {
      const out = [];
      if ((scope === "all" || scope === "papers") && this.corpora.papers) out.push(this.corpora.papers);
      if ((scope === "all" || scope === "notes") && this.corpora.notes) out.push(this.corpora.notes);
      return out;
    }
    /** The same engine with a new notes corpus; the papers corpus (the expensive part) is reused as it is. */
    withNotes(notes) {
      return new _Engine(assembleCorpora(this.corpora.papers, notes ? buildCorpus("notes", notes) : null), this.opts);
    }
    /** Keyword results only (every keystroke). */
    keyword(query, scope, limit) {
      return this.run(query, scope, limit, null);
    }
    /** Keyword + semantic, with the query embedded by the caller. */
    hybrid(query, qVec, scope, limit) {
      const scores = {};
      for (const c of this.inScope(scope)) {
        if (!c.semantic) continue;
        scores[c.name] = rowScores(c.ix, qVec);
      }
      return this.run(query, scope, limit, scores);
    }
    /** Same as `hybrid`, with the vector pass done elsewhere (Accelerate). */
    hybridFromRowScores(query, scores, scope, limit) {
      return this.run(query, scope, limit, scores);
    }
    /** The most recently modified notes, newest first (the empty-query view). */
    recent(limit) {
      const notes = this.corpora.notes;
      if (!notes) return [];
      const order2 = notes.ix.papers.map((p, i) => ({ i, mtime: p.mtime ?? 0, path: p.path ?? "" })).sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
      const rows = order2.map(({ i }) => {
        const p = notes.ix.papers[i];
        const hit = {
          paper: i,
          score: 0,
          source: "keyword",
          fromAbstract: true,
          snippet: bestSnippet(p.abstract || p.title, []).text
        };
        return { note: { corpus: "notes", hit }, winner: "note" };
      });
      return rows.map((r) => buildVM(r, this.corpora, []));
    }
    status() {
      const one = (c) => c ? { count: c.ix.papers.length, builtAt: c.ix.manifest?.built_at ?? null, semantic: c.semantic, reason: c.reason } : null;
      return {
        papers: one(this.corpora.papers),
        notes: one(this.corpora.notes),
        flags: this.corpora.flags,
        model: this.corpora.model,
        dims: this.corpora.dims,
        queryInstruction: this.corpora.queryInstruction
      };
    }
    run(query, scope, limit, sem) {
      if (query.trim() === "") return scope === "papers" ? [] : this.recent(Math.min(limit, RECENT_LIMIT));
      const { tokens } = tokenize(query);
      if (tokens.length === 0) return [];
      const corpora = this.inScope(scope);
      const tag = (name) => (h) => ({ corpus: name, hit: h });
      const kwBy = (name) => {
        const c = corpora.find((x) => x.name === name);
        return c ? keyword(c.ix, query, c.ix.papers.length, { snippets: false }).map(tag(name)) : [];
      };
      const kw = interleave(kwBy("papers"), kwBy("notes"));
      let semList = [];
      if (sem) {
        const per = { papers: [], notes: [] };
        for (const c of corpora) {
          const scores = sem[c.name];
          if (!c.semantic || !scores) continue;
          per[c.name] = semanticFromRowScores(c.ix, scores, query, { limit: c.ix.papers.length, snippets: false }).map(tag(c.name));
        }
        semList = this.opts.interleaveSemantic ? interleave(per.papers, per.notes) : sortByCosine([...per.papers, ...per.notes]);
      }
      const rows = collapseLitnotes(rrf(kw, semList), this.corpora).slice(0, limit);
      for (const r of rows) {
        for (const ch of [r.paper, r.note]) {
          if (!ch) continue;
          const c = ch.corpus === "papers" ? this.corpora.papers : this.corpora.notes;
          fillSnippets(c.ix, [ch.hit], query);
        }
      }
      return rows.map((r) => buildVM(r, this.corpora, tokens));
    }
  };

  // src/api.ts
  var VERSION = true ? "1.0.0" : "dev";
  var engine = null;
  function raw(part, timings) {
    if (!part) return null;
    return {
      manifest: parseJsonPart(part.manifest, timings),
      papers: parseJsonPart(part.papers, timings),
      chunks: parseJsonPart(part.chunks, timings),
      vectors: part.vectors ?? null
    };
  }
  function need() {
    if (!engine) throw new Error("semantero: no index loaded");
    return engine;
  }
  function f32(v) {
    return v ? toFloat32(v) : null;
  }
  var api = {
    version: VERSION,
    /** Build both corpora; swaps the engine only on success. Returns the status as JSON. */
    load(papers, notes) {
      const timings = { decode: 0, parse: 0, build: 0 };
      const rawPapers = raw(papers, timings);
      const rawNotes = raw(notes, timings);
      const t = Date.now();
      const next = new Engine(buildCorpora(rawPapers, rawNotes));
      timings.build = Date.now() - t;
      engine = next;
      return JSON.stringify({ ...next.status(), timings });
    },
    /** Replace only the notes corpus, reusing the loaded papers corpus. Returns the status as JSON. */
    loadNotes(notes) {
      const next = need().withNotes(raw(notes));
      engine = next;
      return JSON.stringify(next.status());
    },
    status() {
      return JSON.stringify(need().status());
    },
    /** The single implementation of the "is this query long enough to embed" rule (rank.ts). */
    shouldRunSemantic(query) {
      return shouldRunSemantic(query);
    },
    keyword(query, scope, limit) {
      return JSON.stringify(need().keyword(query, scope, limit));
    },
    hybrid(query, qVec, scope, limit) {
      return JSON.stringify(need().hybrid(query, f32(qVec), scope, limit));
    },
    hybridFromRowScores(query, papersScores, notesScores, scope, limit) {
      const scores = { papers: f32(papersScores), notes: f32(notesScores) };
      return JSON.stringify(need().hybridFromRowScores(query, scores, scope, limit));
    },
    recent(limit) {
      return JSON.stringify(need().recent(limit));
    }
  };
  globalThis.semantero = api;
  var api_default = api;
})();
