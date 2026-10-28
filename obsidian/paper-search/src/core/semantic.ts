import { rowScores, type LoadedIndex } from "./engine.ts";
import { embedQuery, warmUp, type RequestUrlFn } from "./ollama.ts";

/**
 * Per-row semantic scores for a query, from whichever backend built the index (`manifest.backend`):
 * - no backend (Ollama, single vector): the query vector from Ollama, dotted with every row of vectors.f32;
 * - "pplx" (pplx-embed-v2-late, late interaction): the pplx service scores every row with MaxSim and returns the scores
 *   (see planner/pplx.py). vectors.f32 then holds per-row mean vectors, which are only the service's row keys.
 * Either way the result feeds the same ranking (semanticFromRowScores, hybridSearchFromScores).
 */
export interface SemanticBackendOptions {
  ollamaUrl: string;
  instruction: string;
  keepAlive?: string;
  /** Rows of these papers score 0 (as rowScores' exclude). */
  exclude?: Set<number>;
  /** Which of the pplx service's corpora `ix` is: "search" (papers, the default) or "notes". */
  corpus?: "search" | "notes";
}

/** `scores: null` means there is nothing to score (no vectors, other dims); a thrown error means the service is down. */
export interface SemanticScores {
  scores: Float64Array | null;
}

/** For an index whose manifest names no query instruction (every index the planner writes names one). */
export const DEFAULT_QUERY_INSTRUCTION = "Given a query, retrieve relevant research papers";

/** The instruction search queries are embedded with: the one the index was built for, else the default. */
export function queryInstruction(ix: LoadedIndex): string {
  return ix.manifest.query_instruction || DEFAULT_QUERY_INSTRUCTION;
}

export function isPplx(ix: LoadedIndex): boolean {
  return ix.manifest?.backend === "pplx";
}

/** The service that embeds queries for this index, as the owner knows it, for "not running" messages. */
export function embedderName(ix: LoadedIndex | null): string {
  return ix && isPplx(ix) ? "the pplx service" : "Ollama";
}

export async function semanticScores(
  requestUrl: RequestUrlFn,
  ix: LoadedIndex,
  text: string,
  opts: SemanticBackendOptions
): Promise<SemanticScores> {
  if (!ix.vectors || ix.totalRows === 0) return { scores: null };
  if (isPplx(ix)) {
    const scores = await pplxRowScores(requestUrl, ix.manifest.backend_url ?? "", text, opts.corpus ?? "search", ix.manifest.content_hash);
    if (scores.length !== ix.totalRows) throw new Error("pplx scores do not match the loaded index");
    if (opts.exclude && opts.exclude.size > 0) {
      for (let r = 0; r < scores.length; r++) if (opts.exclude.has(ix.rowToPaper[r])) scores[r] = 0;
    }
    return { scores };
  }
  const qVec = await embedQuery(requestUrl, {
    url: opts.ollamaUrl,
    model: ix.manifest.model ?? "",
    instruction: opts.instruction,
    query: text,
    dims: ix.dims,
    keepAlive: opts.keepAlive,
  });
  return { scores: rowScores(ix, qVec, opts.exclude) };
}

/**
 * MaxSim score of every row of one live corpus ("search" or "notes"), from the pplx service. Throws when the service
 * is unreachable, reports an error, or has a different build of the index loaded than `expectHash` (rows would not
 * line up; the plugin reloads its index shortly after a rebuild).
 */
export async function pplxRowScores(
  requestUrl: RequestUrlFn,
  url: string,
  text: string,
  corpus: string,
  expectHash?: string
): Promise<Float64Array> {
  const resp = await requestUrl({
    url: `${(url || "http://127.0.0.1:11435").replace(/\/+$/, "")}/rowscores`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, corpora: [corpus] }),
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

/** Loads the query model ahead of the first semantic query: Ollama's, or the pplx service's. Never throws. */
export async function warmSemantic(requestUrl: RequestUrlFn, ix: LoadedIndex, ollamaUrl: string, keepAlive?: string) {
  if (isPplx(ix)) {
    try {
      await requestUrl({
        url: `${(ix.manifest.backend_url || "http://127.0.0.1:11435").replace(/\/+$/, "")}/warm`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // warm-up failure is non-blocking
    }
    return;
  }
  await warmUp(requestUrl, { url: ollamaUrl, model: ix.manifest.model ?? "", keepAlive });
}
