import fs from "node:fs";
import path from "node:path";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "../src/bm25.ts";
import { loadVectors, topK } from "../src/vectors.ts";
import { mergeRRF, scorePaperSemantic, type PaperRowRef } from "../src/rank.ts";
import { embedQuery, warmUp } from "../src/ollama.ts";

interface QueryEntry {
  text: string;
  expect: string[];
  kind: string;
}

function parseTomlQueries(content: string): QueryEntry[] {
  const queries: QueryEntry[] = [];
  const blocks = content.split(/\[\[q\]\]/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const textMatch = trimmed.match(/text\s*=\s*"([^"]+)"/);
    const expectMatch = trimmed.match(/expect\s*=\s*\[([^\]]+)\]/);
    const kindMatch = trimmed.match(/kind\s*=\s*"([^"]+)"/);

    if (textMatch && expectMatch && kindMatch) {
      const text = textMatch[1];
      const kind = kindMatch[1];
      const expect = expectMatch[1]
        .split(",")
        .map((s) => s.replace(/["'\s]/g, ""))
        .filter(Boolean);
      queries.push({ text, expect, kind });
    }
  }

  return queries;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const args = process.argv.slice(2);
  let indexDir = "";
  let keywordOnly = false;
  let modelOverride = "";
  let ollamaUrl = "http://127.0.0.1:11434";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--index" && i + 1 < args.length) {
      indexDir = args[++i];
    } else if (args[i] === "--keyword-only") {
      keywordOnly = true;
    } else if (args[i] === "--model" && i + 1 < args.length) {
      modelOverride = args[++i];
    } else if (args[i] === "--url" && i + 1 < args.length) {
      ollamaUrl = args[++i];
    }
  }

  if (!indexDir) {
    console.error("Usage: node scripts/eval.ts --index <dir> [--keyword-only] [--model <model>]");
    process.exit(1);
  }

  const manifestPath = path.join(indexDir, "manifest.json");
  const papersPath = path.join(indexDir, "papers.json");
  const chunksPath = path.join(indexDir, "chunks.json");
  const vectorsPath = path.join(indexDir, "vectors.f32");

  if (!fs.existsSync(manifestPath) || !fs.existsSync(papersPath) || !fs.existsSync(chunksPath)) {
    console.error(`Index files missing in ${indexDir}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const papers: any[] = JSON.parse(fs.readFileSync(papersPath, "utf-8"));
  const chunks: ChunkDocument[] = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));

  const dims = manifest.dims;
  const model = modelOverride || manifest.model;
  const instruction = manifest.query_instruction;

  console.log(`Loaded index from ${indexDir}:`);
  console.log(`  Papers: ${papers.length}, Chunks: ${chunks.length}, Model: ${model}, Dims: ${dims}`);
  console.log(`  Mode: ${keywordOnly ? "Keyword-only" : "Hybrid (BM25 + Semantic)"}`);

  const bm25 = new BM25Index(papers, chunks);

  // Group chunk rows by paper for semantic scoring
  const paperRowRefs: PaperRowRef[] = [];
  for (let pIdx = 0; pIdx < papers.length; pIdx++) {
    const p = papers[pIdx];
    const chunkRows: number[] = [];
    for (const c of chunks) {
      if (c.paper === pIdx && (c as any).row !== undefined) {
        chunkRows.push((c as any).row);
      }
    }
    paperRowRefs.push({
      abstractRow: p.abstractRow,
      chunkRows,
    });
  }

  let vectors: Float32Array | null = null;
  if (!keywordOnly && fs.existsSync(vectorsPath)) {
    const buf = fs.readFileSync(vectorsPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const rowRefs = new Set<number>();
    for (const p of papers) {
      if (p.abstractRow !== null && p.abstractRow !== undefined) {
        rowRefs.add(p.abstractRow);
      }
    }
    for (const c of chunks) {
      if ((c as any).row !== null && (c as any).row !== undefined) {
        rowRefs.add((c as any).row);
      }
    }
    const expectedRows = rowRefs.size;
    vectors = loadVectors(ab, expectedRows, dims);

    // Warm-up Ollama
    try {
      await warmUp(
        async (params) => {
          const res = await fetch(params.url, {
            method: params.method || "POST",
            headers: params.headers,
            body: params.body,
          });
          const json = await res.json();
          return { status: res.status, json };
        },
        { url: ollamaUrl, model }
      );
    } catch {
      console.warn("Warm-up failed, continuing...");
    }
  }

  // Load queries
  const queriesFile = path.resolve(import.meta.dirname, "../../../eval/queries.toml");
  if (!fs.existsSync(queriesFile)) {
    console.error(`Queries file not found at ${queriesFile}`);
    process.exit(1);
  }
  const queries = parseTomlQueries(fs.readFileSync(queriesFile, "utf-8"));
  console.log(`Evaluating ${queries.length} queries...\n`);

  interface EvalResult {
    query: QueryEntry;
    rank: number; // 1-based, 0 if not found
    topTitles: string[];
    expectedPaperIdx: number;
    winningKind?: "abstract" | "chunk";
    winningPage?: number;
  }

  const results: EvalResult[] = [];
  const keywordLatencies: number[] = [];
  const semanticLatencies: number[] = [];

  for (const q of queries) {
    const tKw0 = performance.now();
    const keywordRes = bm25.search(q.text);
    const tKw1 = performance.now();
    keywordLatencies.push(tKw1 - tKw0);

    const keywordList = keywordRes.map((r) => r.paperIndex);
    let finalList: number[] = keywordList;

    const semanticMap = new Map<number, { score: number; winningRow?: number; isAbstract?: boolean }>();

    if (!keywordOnly && vectors) {
      const tSem0 = performance.now();
      try {
        const queryVec = await embedQuery(
          async (params) => {
            const res = await fetch(params.url, {
              method: params.method || "POST",
              headers: params.headers,
              body: params.body,
            });
            const json = await res.json();
            return { status: res.status, json };
          },
          { url: ollamaUrl, model, instruction, query: q.text, dims }
        );

        const totalRows = Math.floor(vectors.length / dims);
        const matches = topK(queryVec, vectors, totalRows, dims, totalRows);
        const rowScores = new Map<number, number>();
        for (const m of matches) {
          rowScores.set(m.row, m.score);
        }

        const semanticList: { paperIndex: number; score: number; winningRow?: number; isAbstract?: boolean }[] = [];
        for (let pIdx = 0; pIdx < papers.length; pIdx++) {
          const scored = scorePaperSemantic(paperRowRefs[pIdx], rowScores);
          if (scored.score > 0) {
            const item = {
              paperIndex: pIdx,
              score: scored.score,
              winningRow: scored.winningRow ?? undefined,
              isAbstract: scored.isAbstract,
            };
            semanticList.push(item);
            semanticMap.set(pIdx, item);
          }
        }
        semanticList.sort((a, b) => b.score - a.score);

        const merged = mergeRRF([keywordList, semanticList.map((s) => s.paperIndex)]);
        finalList = merged.map((m) => m.paperIndex);
      } catch (e) {
        // fallback to keyword
      }
      const tSem1 = performance.now();
      semanticLatencies.push(tSem1 - tSem0);
    }

    // Find rank of expected papers
    let bestRank = 0;
    for (let r = 0; r < finalList.length; r++) {
      const pIdx = finalList[r];
      const p = papers[pIdx];
      if (q.expect.includes(p.citekey)) {
        bestRank = r + 1;
        break;
      }
    }

    // Find expected paper index in dataset
    let expPaperIdx = -1;
    for (let i = 0; i < papers.length; i++) {
      if (q.expect.includes(papers[i].citekey)) {
        expPaperIdx = i;
        break;
      }
    }

    let winningKind: "abstract" | "chunk" | undefined = undefined;
    let winningPage: number | undefined = undefined;

    if (expPaperIdx >= 0) {
      if (!keywordOnly && vectors) {
        const sem = semanticMap.get(expPaperIdx);
        if (sem) {
          if (!sem.isAbstract && sem.winningRow !== undefined) {
            winningKind = "chunk";
            const c = chunks.find((ch: any) => ch.row === sem.winningRow);
            winningPage = c?.page;
          } else {
            winningKind = "abstract";
          }
        } else {
          const km = keywordRes.find((k) => k.paperIndex === expPaperIdx);
          if (km && km.bestChunkScore > km.metadataScore && km.bestChunkIndex !== undefined) {
            winningKind = "chunk";
            winningPage = chunks[km.bestChunkIndex]?.page;
          } else {
            winningKind = "abstract";
          }
        }
      } else {
        const km = keywordRes.find((k) => k.paperIndex === expPaperIdx);
        if (km && km.bestChunkScore > km.metadataScore && km.bestChunkIndex !== undefined) {
          winningKind = "chunk";
          winningPage = chunks[km.bestChunkIndex]?.page;
        } else {
          winningKind = "abstract";
        }
      }
    }

    const topTitles = finalList.slice(0, 3).map((idx) => papers[idx]?.title || "Unknown");

    results.push({
      query: q,
      rank: bestRank,
      topTitles,
      expectedPaperIdx: expPaperIdx,
      winningKind,
      winningPage,
    });
  }

  // Calculate metrics
  const kinds = [...new Set(queries.map((q) => q.kind))];

  function calcMetrics(subset: EvalResult[]) {
    let r1 = 0;
    let r5 = 0;
    let mrr = 0;

    for (const res of subset) {
      if (res.rank === 1) r1++;
      if (res.rank > 0 && res.rank <= 5) r5++;
      if (res.rank > 0) mrr += 1.0 / res.rank;
    }

    const n = Math.max(1, subset.length);
    return {
      r1: (r1 / n).toFixed(3),
      r5: (r5 / n).toFixed(3),
      mrr: (mrr / n).toFixed(3),
      count: subset.length,
    };
  }

  console.log("Evaluation Results:");
  console.log("---------------------------------------------------------------");
  const overall = calcMetrics(results);
  console.log(`Overall (n=${overall.count}):  Recall@1: ${overall.r1}  Recall@5: ${overall.r5}  MRR: ${overall.mrr}`);

  for (const k of kinds) {
    const subset = results.filter((r) => r.query.kind === k);
    const m = calcMetrics(subset);
    console.log(`Kind: ${k.padEnd(14)} (n=${m.count.toString().padEnd(2)}): Recall@1: ${m.r1}  Recall@5: ${m.r5}  MRR: ${m.mrr}`);
  }

  console.log("---------------------------------------------------------------");
  console.log(`Keyword latency:        p50: ${percentile(keywordLatencies, 50).toFixed(1)} ms, p95: ${percentile(keywordLatencies, 95).toFixed(1)} ms`);
  if (!keywordOnly && semanticLatencies.length > 0) {
    console.log(`Semantic latency (warm): p50: ${percentile(semanticLatencies, 50).toFixed(1)} ms, p95: ${percentile(semanticLatencies, 95).toFixed(1)} ms`);
  }
  console.log("---------------------------------------------------------------");

  // Print misses (expected paper not at rank 1)
  const misses = results.filter((r) => r.rank !== 1);
  if (misses.length > 0) {
    console.log(`Misses (${misses.length}/${results.length}):`);
    for (const m of misses) {
      const rankStr = m.rank > 0 ? `#${m.rank}` : "not in top results";
      let sourceStr = "";
      if (m.expectedPaperIdx < 0) {
        sourceStr = " (not in index)";
      } else if (m.winningKind === "chunk") {
        sourceStr = ` (winning row: chunk, p. ${m.winningPage ?? "?"})`;
      } else if (m.winningKind === "abstract") {
        sourceStr = " (winning row: abstract)";
      }
      console.log(`- Query: "${m.query.text}" (${m.query.kind})`);
      console.log(`  Expected: ${m.query.expect.join(", ")} → Rank: ${rankStr}${sourceStr}`);
      console.log(`  Top-3 titles: ${m.topTitles.join(" | ")}`);
    }
  } else {
    console.log("All queries retrieved expected paper at rank 1!");
  }
}

main().catch(console.error);
