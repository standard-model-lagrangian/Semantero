import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "../src/core/bm25.ts";
import { tokenize, bestSnippet } from "../src/core/text.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/search/index_small");

const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8"));
const papers: PaperMetadata[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "papers.json"), "utf8"));
const chunks: (ChunkDocument & { row: number })[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "chunks.json"), "utf8"));
const vecBuf = fs.readFileSync(path.join(FIXTURES_DIR, "vectors.f32"));
const vectors = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength / 4);

const bm25 = new BM25Index(papers, chunks);
const dims = manifest.dims; // 8
const totalRows = Math.floor(vectors.length / dims);

// The reference the goldens were recorded from: the original modal's ranking, written out here so that it stays
// independent of src/ (engine, bm25 and rowscores tests compare the production path against these goldens).
interface PaperRowRef {
  abstractRow: number | null;
  chunkRows: number[];
}

/** Dot product of the query with every row. */
function allRowScores(queryVec: Float32Array): Map<number, number> {
  const out = new Map<number, number>();
  for (let r = 0; r < totalRows; r++) {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += vectors[r * dims + d] * queryVec[d];
    out.set(r, dot);
  }
  return out;
}

/** A paper's score: its best row (abstract first, then chunks; ties keep the earlier row). */
function scorePaperSemantic(paper: PaperRowRef, rowScores: Map<number, number>) {
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
  return { score: bestScore === -Infinity ? 0 : bestScore, winningRow, isAbstract };
}

/** Reciprocal rank fusion (k = 60); ties keep first-seen order. */
function mergeRRF(rankedLists: number[][], k: number = 60): { paperIndex: number; score: number }[] {
  const rrfScores = new Map<number, number>();
  for (const list of rankedLists) {
    for (let rank = 1; rank <= list.length; rank++) {
      const pIdx = list[rank - 1];
      rrfScores.set(pIdx, (rrfScores.get(pIdx) || 0) + 1.0 / (k + rank));
    }
  }
  return [...rrfScores.entries()].map(([paperIndex, score]) => ({ paperIndex, score })).sort((a, b) => b.score - a.score);
}

const paperRowRefs: PaperRowRef[] = papers.map((p: any, i: number) => ({
  paperIndex: i,
  abstractRow: p.abstractRow,
  chunkRows: chunks.filter((c) => c.paper === i).map((c) => c.row),
}));

export const QUERIES_30: string[] = [
  "viscoelasticity",
  "hydrogel",
  "organoids",
  "chemoresistance",
  "relaxation",
  "neural",
  "stiffness",
  "biopolymers",
  "mechanics",
  "constitutive",
  "roth",
  "lesavage",
  "wang",
  "johnson",
  "bauer",
  "heilshorn",
  "roth2023tunable",
  "lesavage2022next",
  "wang2024engineered",
  "johnson2020theoretical",
  "faster stress relaxation",
  "cancer organoids matrix stiffness",
  "engineered matrices chemoresistance",
  "cellular viscoelasticity models",
  "integrin signaling",
  "human neural maturation",
  "permissive matrix degradation",
  "continuum mechanics",
  "drug response organoid",
  "tunable hydrogel",
];

function getDeterministicVector(query: string, dims: number): number[] {
  // Generate deterministic float vector from query string hash
  const hash = crypto.createHash("sha256").update(query).digest();
  const raw: number[] = [];
  for (let d = 0; d < dims; d++) {
    // take 2 bytes per dim as signed integer
    const val = hash.readInt16LE((d * 2) % (hash.length - 1)) / 32768.0;
    raw.push(val);
  }
  // normalize
  const norm = Math.hypot(...raw) || 1.0;
  return raw.map((v) => v / norm);
}

function runCurrentModalCode(query: string, limit = 10) {
  const queryTokens = tokenize(query).tokens;

  // 1. Keyword search
  const keywordRes = bm25.search(query);
  const keywordList = keywordRes.map((r) => r.paperIndex);

  const keywordHits: any[] = [];
  for (const pIdx of keywordList.slice(0, limit)) {
    const paper: any = papers[pIdx];
    const match = keywordRes.find((k) => k.paperIndex === pIdx);
    let snippet = "";
    let page: number | undefined;
    let isAbstract = true;
    let attKey: string | undefined;

    const chunkWon = (match?.bestChunkScore || 0) > (match?.metadataScore || 0) && match?.bestChunkIndex !== undefined;
    if (chunkWon) {
      const c = chunks[match.bestChunkIndex!];
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

    keywordHits.push({
      paperIndex: pIdx,
      score: match?.score || 0,
      snippetText: snippet,
      snippetPage: page,
      isAbstract,
      winningAttachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
    });
  }

  // 2. Semantic search
  const queryVec = getDeterministicVector(query, dims);
  const qVecF32 = new Float32Array(queryVec);
  const rowScores = allRowScores(qVecF32);

  const semanticList: { paperIndex: number; score: number; winningRow?: number; isAbstract?: boolean }[] = [];
  for (let pIdx = 0; pIdx < papers.length; pIdx++) {
    const ref = paperRowRefs[pIdx];
    const scored = scorePaperSemantic(ref, rowScores);
    if (scored.score > 0) {
      semanticList.push({
        paperIndex: pIdx,
        score: scored.score,
        winningRow: scored.winningRow ?? undefined,
        isAbstract: scored.isAbstract,
      });
    }
  }
  semanticList.sort((a, b) => b.score - a.score);

  // 3. Hybrid search
  const merged = mergeRRF([
    keywordList,
    semanticList.map((s) => s.paperIndex),
  ]);

  const hybridHits: any[] = [];
  for (const m of merged.slice(0, limit)) {
    const paper: any = papers[m.paperIndex];
    const semInfo = semanticList.find((s) => s.paperIndex === m.paperIndex);

    let snippet = "";
    let page: number | undefined;
    let isAbstract = true;
    let attKey: string | undefined;

    if (semInfo) {
      if (!semInfo.isAbstract && semInfo.winningRow !== undefined) {
        const c = chunks.find((ch) => ch.row === semInfo.winningRow);
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
      const chunkWon = (kMatch?.bestChunkScore || 0) > (kMatch?.metadataScore || 0) && kMatch?.bestChunkIndex !== undefined;
      if (chunkWon) {
        const c = chunks[kMatch.bestChunkIndex!];
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

    hybridHits.push({
      paperIndex: m.paperIndex,
      score: m.score,
      snippetText: snippet,
      snippetPage: page,
      isAbstract,
      winningAttachmentKey: attKey || paper.pdfs?.[0]?.attachmentKey,
    });
  }

  return {
    query,
    queryVec,
    keywordRes: keywordRes.map((r) => ({
      paperIndex: r.paperIndex,
      score: r.score,
      metadataScore: r.metadataScore,
      bestChunkScore: r.bestChunkScore,
      bestChunkIndex: r.bestChunkIndex,
    })),
    keywordHits,
    semanticList,
    hybridHits,
  };
}

const goldens = QUERIES_30.map((q) => runCurrentModalCode(q));
const outPath = path.resolve(import.meta.dirname, "goldens.json");
fs.writeFileSync(outPath, JSON.stringify(goldens, null, 2) + "\n");
console.log(`Wrote ${goldens.length} goldens to ${outPath}`);
