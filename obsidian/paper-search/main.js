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
  default: () => PaperSearchPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

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
  // Document frequencies: term -> count of docs containing term
  df = /* @__PURE__ */ new Map();
  totalDocs = 0;
  // Metadata field token counts and lengths
  // paperIndex -> fieldName -> Map<term, freq>
  paperFieldTerms = [];
  paperFieldLengths = [];
  avgFieldLengths = /* @__PURE__ */ new Map();
  // Chunk token counts and lengths
  chunkTerms = [];
  chunkLengths = [];
  avgChunkLength = 0;
  constructor(papers, chunks) {
    this.papers = papers;
    this.chunks = chunks;
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
      this.paperFieldTerms.push(fieldTerms);
      this.paperFieldLengths.push(fieldLengths);
    }
    const numPapers = Math.max(1, this.papers.length);
    for (const [fName, totalLen] of Object.entries(totalFieldLengths)) {
      this.avgFieldLengths.set(fName, totalLen / numPapers);
    }
    let totalChunkLen = 0;
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
      this.chunkTerms.push(termFreqs);
      this.chunkLengths.push(tokens.length);
      totalChunkLen += tokens.length;
    }
    this.avgChunkLength = this.chunks.length > 0 ? totalChunkLen / this.chunks.length : 1;
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
  search(query) {
    const { tokens, lastIncomplete } = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }
    const termMatchers = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isLast = i === tokens.length - 1;
      if (isLast && lastIncomplete) {
        const matches = [];
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
    const paperScores = new Array(this.papers.length).fill(0);
    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      let metaScore = 0;
      const fieldTerms = this.paperFieldTerms[pIdx];
      const fieldLens = this.paperFieldLengths[pIdx];
      for (const matcher of termMatchers) {
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
    const chunkScores = new Array(this.chunks.length).fill(0);
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
    const bestChunkPerPaper = /* @__PURE__ */ new Map();
    for (let cIdx = 0; cIdx < this.chunks.length; cIdx++) {
      const s = chunkScores[cIdx];
      if (s <= 0) continue;
      const pIdx = this.chunks[cIdx].paper;
      const cur = bestChunkPerPaper.get(pIdx);
      if (!cur || s > cur.score) {
        bestChunkPerPaper.set(pIdx, { score: s, chunkIdx: cIdx });
      }
    }
    const results = [];
    for (let pIdx = 0; pIdx < this.papers.length; pIdx++) {
      const mScore = paperScores[pIdx];
      const bestChunk = bestChunkPerPaper.get(pIdx);
      const cScore = bestChunk ? bestChunk.score : 0;
      const finalScore = Math.max(mScore, cScore);
      if (finalScore > 0) {
        results.push({
          paperIndex: pIdx,
          score: finalScore,
          metadataScore: mScore,
          bestChunkScore: cScore,
          bestChunkIndex: bestChunk && cScore > 0 ? bestChunk.chunkIdx : void 0
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }
};

// src/vectors.ts
function loadVectors(buffer, rows, dims) {
  const expectedBytes = rows * dims * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Vector file length (${buffer.byteLength}) does not match expected rows (${rows}) * dims (${dims}) * 4 = ${expectedBytes}`
    );
  }
  return new Float32Array(buffer);
}
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
function topK(queryVec, allVectors, rows, dims, k) {
  const scores = [];
  for (let r = 0; r < rows; r++) {
    let dot = 0;
    const offset = r * dims;
    for (let d = 0; d < dims; d++) {
      dot += allVectors[offset + d] * queryVec[d];
    }
    scores.push({ row: r, score: dot });
  }
  scores.sort((a, b) => b.score - a.score);
  return k < rows ? scores.slice(0, k) : scores;
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
function scorePaperSemantic(paper, rowScores) {
  let bestScore = -Infinity;
  let winningRow = null;
  let isAbstract = false;
  if (paper.abstractRow !== null && paper.abstractRow !== void 0) {
    const s = rowScores.get(paper.abstractRow);
    if (s !== void 0 && s > bestScore) {
      bestScore = s;
      winningRow = paper.abstractRow;
      isAbstract = true;
    }
  }
  for (const cRow of paper.chunkRows) {
    const s = rowScores.get(cRow);
    if (s !== void 0 && s > bestScore) {
      bestScore = s;
      winningRow = cRow;
      isAbstract = false;
    }
  }
  return {
    score: bestScore === -Infinity ? 0 : bestScore,
    winningRow,
    isAbstract
  };
}
function mergeRRF(rankedLists, k = 60) {
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
    results.push({ paperIndex: pIdx, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
function maintainSelection(prevSelectedPaper, newList, limit = 12) {
  if (prevSelectedPaper === null || newList.length === 0) {
    return 0;
  }
  const topSlice = newList.slice(0, limit);
  const idx = topSlice.findIndex((p) => p.paperIndex === prevSelectedPaper);
  return idx >= 0 ? idx : 0;
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

// src/main.ts
var DEFAULT_SETTINGS = {
  ollamaUrl: "http://127.0.0.1:11434",
  debounceMs: 200,
  minCharsSemantic: 12,
  limit: 12,
  hotkeyHint: "Cmd+Shift+F"
};
var PaperSearchPlugin = class extends import_obsidian.Plugin {
  settings = DEFAULT_SETTINGS;
  indexData = null;
  bm25 = null;
  lastBuiltAt = "";
  async onload() {
    await this.loadSettings();
    await this.loadIndex();
    this.addCommand({
      id: "open-paper-search",
      name: "Search papers (keyword + semantic)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "F" }],
      callback: () => {
        new PaperSearchModal(this.app, this).open();
      }
    });
    this.addSettingTab(new PaperSearchSettingTab(this.app, this));
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async loadIndex(force = false) {
    const adapter = this.app.vault.adapter;
    const manifestPath = ".planner/search/manifest.json";
    const papersPath = ".planner/search/papers.json";
    const chunksPath = ".planner/search/chunks.json";
    const vectorsPath = ".planner/search/vectors.f32";
    if (!await adapter.exists(manifestPath)) {
      return false;
    }
    try {
      const manifestStr = await adapter.read(manifestPath);
      const manifest = JSON.parse(manifestStr);
      if (!force && this.indexData && manifest.built_at === this.lastBuiltAt) {
        return true;
      }
      const papersStr = await adapter.read(papersPath);
      const papers = JSON.parse(papersStr);
      const chunksStr = await adapter.read(chunksPath);
      const chunks = JSON.parse(chunksStr);
      let vectors = null;
      if (await adapter.exists(vectorsPath)) {
        const vecBuf = await adapter.readBinary(vectorsPath);
        const dims = manifest.dims;
        const rowRefs = /* @__PURE__ */ new Set();
        for (const p of papers) {
          if (p.abstractRow !== null && p.abstractRow !== void 0) {
            rowRefs.add(p.abstractRow);
          }
        }
        for (const c of chunks) {
          if (c.row !== null && c.row !== void 0) {
            rowRefs.add(c.row);
          }
        }
        const expectedRows = rowRefs.size;
        let rowsValid = true;
        for (const r of rowRefs) {
          if (r < 0 || r >= expectedRows) {
            rowsValid = false;
            break;
          }
        }
        if (!rowsValid) {
          new import_obsidian.Notice("Paper search index error: row references are out of range.");
        } else {
          try {
            vectors = loadVectors(vecBuf, expectedRows, dims);
          } catch (e) {
            new import_obsidian.Notice(`Paper search index vector mismatch: ${e.message}`);
          }
        }
      }
      this.bm25 = new BM25Index(papers, chunks);
      const paperRowRefs = [];
      for (let pIdx = 0; pIdx < papers.length; pIdx++) {
        const p = papers[pIdx];
        const chunkRows = [];
        for (const c of chunks) {
          if (c.paper === pIdx && c.row !== void 0) {
            chunkRows.push(c.row);
          }
        }
        paperRowRefs.push({
          abstractRow: p.abstractRow,
          chunkRows
        });
      }
      this.indexData = {
        manifest,
        papers,
        chunks,
        vectors,
        paperRowRefs
      };
      this.lastBuiltAt = manifest.built_at || "";
      return true;
    } catch (err) {
      new import_obsidian.Notice(`Failed to load paper search index: ${err.message}`);
      return false;
    }
  }
};
var PaperSearchModal = class extends import_obsidian.SuggestModal {
  plugin;
  coordinator = new SemanticCoordinator();
  currentItems = [];
  debounceTimer = null;
  semanticAvailable = true;
  footerEl = null;
  selectedPaperIdx = null;
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Search papers by what they found, title, author, or citekey...");
    this.setInstructions([
      { command: "\u21B5", purpose: "open PDF at page" },
      { command: "\u2318\u21B5", purpose: "insert [[citekey]]" },
      { command: "\u2325\u21B5", purpose: "literature note / Zotero item" }
    ]);
  }
  async onOpen() {
    super.onOpen();
    await this.plugin.loadIndex(false);
    if (this.plugin.indexData?.manifest?.model) {
      warmUp(import_obsidian.requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model: this.plugin.indexData.manifest.model,
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
      if (item) {
        this.insertCitekey(item);
        this.close();
      }
      return false;
    });
    this.scope.register(["Alt"], "Enter", (evt) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item) {
        this.openLiteratureNoteOrZotero(item);
        this.close();
      }
      return false;
    });
  }
  getSelectedItem() {
    return this.chooser?.values?.[this.chooser?.selectedItem] || null;
  }
  getSuggestions(query) {
    if (!this.plugin.indexData || !this.plugin.bm25) {
      return [];
    }
    const keywordRes = this.plugin.bm25.search(query);
    const keywordList = keywordRes.map((r) => r.paperIndex);
    const queryTokens = tokenize(query).tokens;
    const items = [];
    for (const pIdx of keywordList.slice(0, this.plugin.settings.limit)) {
      const paper = this.plugin.indexData.papers[pIdx];
      const match = keywordRes.find((k) => k.paperIndex === pIdx);
      let snippet = "";
      let page;
      let isAbstract = true;
      let attKey;
      const chunkWon = (match?.bestChunkScore || 0) > (match?.metadataScore || 0) && match?.bestChunkIndex !== void 0;
      if (chunkWon) {
        const c = this.plugin.indexData.chunks[match.bestChunkIndex];
        snippet = bestSnippet(c.text, queryTokens).text;
        page = c.page;
        isAbstract = false;
        attKey = c.attachmentKey;
      } else if (paper.abstract) {
        snippet = bestSnippet(paper.abstract, queryTokens).text;
        isAbstract = true;
      } else {
        snippet = bestSnippet(paper.title, queryTokens).text;
        isAbstract = true;
      }
      items.push({
        paperIndex: pIdx,
        paper,
        score: match?.score || 0,
        snippetText: snippet,
        snippetPage: page,
        isAbstract,
        winningAttachmentKey: attKey || paper.pdfs[0]?.attachmentKey
      });
    }
    this.currentItems = items;
    this.scheduleSemanticSearch(query, keywordList);
    return items;
  }
  scheduleSemanticSearch(query, keywordList) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!shouldRunSemantic(query, this.plugin.settings.minCharsSemantic) || !this.plugin.indexData?.vectors) {
      return;
    }
    const { seq } = this.coordinator.newRequest();
    this.debounceTimer = setTimeout(async () => {
      await this.runSemantic(query, keywordList, seq);
    }, this.plugin.settings.debounceMs);
  }
  async runSemantic(query, keywordList, seq) {
    if (!this.plugin.indexData?.vectors) return;
    const manifest = this.plugin.indexData.manifest;
    const model = manifest.model;
    const dims = manifest.dims;
    const instruction = manifest.query_instruction;
    try {
      const queryVec = await embedQuery(import_obsidian.requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model,
        instruction,
        query,
        dims
      });
      if (!this.coordinator.isCurrent(seq)) {
        return;
      }
      this.semanticAvailable = true;
      this.updateFooter("");
      const totalRows = Math.floor(this.plugin.indexData.vectors.length / dims);
      const matches = topK(queryVec, this.plugin.indexData.vectors, totalRows, dims, totalRows);
      const rowScores = /* @__PURE__ */ new Map();
      for (const m of matches) {
        rowScores.set(m.row, m.score);
      }
      const semanticList = [];
      for (let pIdx = 0; pIdx < this.plugin.indexData.papers.length; pIdx++) {
        const ref = this.plugin.indexData.paperRowRefs[pIdx];
        const scored = scorePaperSemantic(ref, rowScores);
        if (scored.score > 0) {
          semanticList.push({
            paperIndex: pIdx,
            score: scored.score,
            winningRow: scored.winningRow ?? void 0,
            isAbstract: scored.isAbstract
          });
        }
      }
      semanticList.sort((a, b) => b.score - a.score);
      const merged = mergeRRF([
        keywordList,
        semanticList.map((s) => s.paperIndex)
      ]);
      const queryTokens = tokenize(query).tokens;
      const newItems = [];
      const keywordRes = this.plugin.bm25?.search(query) || [];
      for (const m of merged.slice(0, this.plugin.settings.limit)) {
        const paper = this.plugin.indexData.papers[m.paperIndex];
        const semInfo = semanticList.find((s) => s.paperIndex === m.paperIndex);
        let snippet = "";
        let page;
        let isAbstract = true;
        let attKey;
        if (semInfo) {
          if (!semInfo.isAbstract && semInfo.winningRow !== void 0) {
            const c = this.plugin.indexData.chunks.find((ch) => ch.row === semInfo.winningRow);
            if (c) {
              snippet = bestSnippet(c.text, queryTokens).text;
              page = c.page;
              attKey = c.attachmentKey;
              isAbstract = false;
            }
          } else if (paper.abstract) {
            snippet = bestSnippet(paper.abstract, queryTokens).text;
            isAbstract = true;
          } else {
            snippet = bestSnippet(paper.title, queryTokens).text;
            isAbstract = true;
          }
        } else {
          const kMatch = keywordRes.find((k) => k.paperIndex === m.paperIndex);
          const chunkWon = (kMatch?.bestChunkScore || 0) > (kMatch?.metadataScore || 0) && kMatch?.bestChunkIndex !== void 0;
          if (chunkWon) {
            const c = this.plugin.indexData.chunks[kMatch.bestChunkIndex];
            snippet = bestSnippet(c.text, queryTokens).text;
            page = c.page;
            isAbstract = false;
            attKey = c.attachmentKey;
          } else if (paper.abstract) {
            snippet = bestSnippet(paper.abstract, queryTokens).text;
            isAbstract = true;
          } else {
            snippet = bestSnippet(paper.title, queryTokens).text;
            isAbstract = true;
          }
        }
        newItems.push({
          paperIndex: m.paperIndex,
          paper,
          score: m.score,
          snippetText: snippet,
          snippetPage: page,
          isAbstract,
          winningAttachmentKey: attKey || paper.pdfs[0]?.attachmentKey
        });
      }
      const currentItem = this.getSelectedItem();
      const prevPaperIdx = currentItem ? currentItem.paperIndex : null;
      this.currentItems = newItems;
      const newSel = maintainSelection(prevPaperIdx, newItems, this.plugin.settings.limit);
      this.chooser?.setSuggestions(newItems);
      this.chooser?.setSelectedItem(newSel);
    } catch {
      this.semanticAvailable = false;
      this.updateFooter("semantic off: Ollama not reachable");
    }
  }
  updateFooter(msg) {
    if (this.footerEl) {
      this.footerEl.setText(msg);
      this.footerEl.style.display = msg ? "block" : "none";
    }
  }
  renderSuggestion(item, el) {
    el.empty();
    el.addClass("paper-search-item");
    const header = el.createDiv({ cls: "paper-search-header" });
    header.createSpan({ text: item.paper.title, cls: "paper-search-title" });
    const meta = el.createDiv({ cls: "paper-search-meta" });
    const authorStr = item.paper.authors.length > 0 ? `${item.paper.authors[0]} et al.` : "";
    const yearStr = item.paper.year ? `${item.paper.year}` : "";
    const journalStr = item.paper.journal || "";
    const metaParts = [authorStr, yearStr, journalStr].filter(Boolean).join(" \xB7 ");
    meta.createSpan({ text: metaParts, cls: "paper-search-author-journal" });
    const rightBadge = item.isAbstract ? "abstract" : item.snippetPage ? `p. ${item.snippetPage}` : "";
    if (rightBadge) {
      const badge = meta.createSpan({ text: rightBadge, cls: "paper-search-page-badge" });
      badge.style.float = "right";
    }
    if (item.snippetText) {
      const snip = el.createDiv({ cls: "paper-search-snippet" });
      snip.createSpan({ text: `"${item.snippetText}"` });
      snip.style.fontSize = "0.9em";
      snip.style.color = "var(--text-muted)";
      snip.style.marginTop = "2px";
    }
  }
  onChooseSuggestion(item, evt) {
    this.openPdfInZotero(item);
  }
  openPdfInZotero(item) {
    const attKey = item.winningAttachmentKey || item.paper.pdfs[0]?.attachmentKey;
    const page = item.snippetPage ?? 1;
    if (attKey) {
      const url = `zotero://open-pdf/library/items/${attKey}?page=${page}`;
      window.open(url);
    } else {
      window.open(`zotero://select/library/items/${item.paper.key}`);
    }
  }
  insertCitekey(item) {
    const citekey = item.paper.citekey;
    if (!citekey) return;
    const textToInsert = `[[${citekey}]]`;
    const activeView = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    const editor = this.app.workspace.activeEditor?.editor || activeView?.editor;
    if (editor) {
      editor.replaceSelection(textToInsert);
    } else {
      navigator.clipboard.writeText(textToInsert);
      new import_obsidian.Notice(`Copied ${textToInsert} to clipboard`);
    }
  }
  async openLiteratureNoteOrZotero(item) {
    const citekey = item.paper.citekey;
    if (citekey) {
      const notePath = `${citekey}.md`;
      const file = this.app.metadataCache?.getFirstLinkpathDest(citekey, "") || this.app.vault.getAbstractFileByPath(notePath);
      if (file) {
        this.app.workspace.openLinkText(file.path, "", false);
        return;
      }
    }
    window.open(`zotero://select/library/items/${item.paper.key}`);
  }
};
var PaperSearchSettingTab = class extends import_obsidian.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Search Settings" });
    new import_obsidian.Setting(containerEl).setName("Ollama URL").setDesc("Endpoint for local Ollama server").addText(
      (text) => text.setPlaceholder("http://127.0.0.1:11434").setValue(this.plugin.settings.ollamaUrl).onChange(async (val) => {
        this.plugin.settings.ollamaUrl = val.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Semantic Search Debounce (ms)").setDesc("Wait time after typing stops before triggering semantic search").addSlider(
      (slider) => slider.setLimits(100, 1e3, 50).setValue(this.plugin.settings.debounceMs).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.debounceMs = val;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Minimum Characters for Semantic Search").setDesc("Minimum characters typed before semantic search runs").addSlider(
      (slider) => slider.setLimits(4, 30, 1).setValue(this.plugin.settings.minCharsSemantic).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.minCharsSemantic = val;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Results Limit").setDesc("Maximum number of paper results to show in search modal").addSlider(
      (slider) => slider.setLimits(5, 30, 1).setValue(this.plugin.settings.limit).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.limit = val;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Hotkey Hint").setDesc("Hotkey configured to open the paper search dialog").addText(
      (text) => text.setPlaceholder("Cmd+Shift+F").setValue(this.plugin.settings.hotkeyHint).onChange(async (val) => {
        this.plugin.settings.hotkeyHint = val.trim();
        await this.plugin.saveSettings();
      })
    );
  }
};
