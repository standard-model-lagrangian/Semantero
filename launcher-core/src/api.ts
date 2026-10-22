/**
 * The JavaScriptCore entry point: `globalThis.daito`. Everything crossing the boundary is a JSON string,
 * except the large inputs, which are ArrayBuffers (or strings) and the vector arguments (ArrayBuffers).
 * No Node or DOM globals are used.
 */
import { shouldRunSemantic } from "../../obsidian/paper-search/src/rank.ts";
import { buildCorpora, type RawCorpus } from "./corpora.ts";
import { Engine, type RowScoreInput, type Scope } from "./query.ts";
import pkg from "../package.json" with { type: "json" };
import { loadTimings, parseJsonPart, toFloat32 } from "./util.ts";

/** The ranker/bundle version the app checks before using it: bump package.json when the API changes. */
export const VERSION: string = pkg.version;

type Part = string | ArrayBuffer | ArrayBufferView;
export interface CorpusPart {
  manifest: Part;
  papers: Part;
  chunks: Part;
  vectors: ArrayBuffer | ArrayBufferView | null;
}

let engine: Engine | null = null;

function raw(part: CorpusPart | null | undefined): RawCorpus | null {
  if (!part) return null;
  return {
    manifest: parseJsonPart(part.manifest),
    papers: parseJsonPart(part.papers),
    chunks: parseJsonPart(part.chunks),
    vectors: part.vectors ?? null,
  };
}

function need(): Engine {
  if (!engine) throw new Error("daito: no index loaded");
  return engine;
}

function f32(v: ArrayBuffer | ArrayBufferView | null | undefined): Float32Array | null {
  return v ? toFloat32(v) : null;
}

const api = {
  version: VERSION,

  /** Build both corpora; swaps the engine only on success. Returns the status as JSON. */
  load(papers: CorpusPart | null, notes: CorpusPart | null): string {
    loadTimings.decode = loadTimings.parse = loadTimings.build = 0;
    const rawPapers = raw(papers);
    const rawNotes = raw(notes);
    const t = Date.now();
    const next = new Engine(buildCorpora(rawPapers, rawNotes));
    loadTimings.build = Date.now() - t;
    engine = next;
    return JSON.stringify({ ...next.status(), timings: { ...loadTimings } });
  },

  /** Replace only the notes corpus, reusing the loaded papers corpus. Returns the status as JSON. */
  loadNotes(notes: CorpusPart | null): string {
    const next = need().withNotes(raw(notes));
    engine = next;
    return JSON.stringify(next.status());
  },

  status(): string {
    return JSON.stringify(need().status());
  },

  /** The single implementation of the "is this query long enough to embed" rule (rank.ts). */
  shouldRunSemantic(query: string): boolean {
    return shouldRunSemantic(query);
  },

  keyword(query: string, scope: Scope, limit: number): string {
    return JSON.stringify(need().keyword(query, scope, limit));
  },

  hybrid(query: string, qVec: ArrayBuffer | ArrayBufferView, scope: Scope, limit: number): string {
    return JSON.stringify(need().hybrid(query, f32(qVec)!, scope, limit));
  },

  hybridFromRowScores(
    query: string,
    papersScores: ArrayBuffer | ArrayBufferView | null,
    notesScores: ArrayBuffer | ArrayBufferView | null,
    scope: Scope,
    limit: number
  ): string {
    const scores: RowScoreInput = { papers: f32(papersScores), notes: f32(notesScores) };
    return JSON.stringify(need().hybridFromRowScores(query, scores, scope, limit));
  },

  lookup(ids: string[]): string {
    return JSON.stringify(need().lookup(ids));
  },

  recent(limit: number): string {
    return JSON.stringify(need().recent(limit));
  },
};

(globalThis as unknown as { daito: typeof api }).daito = api;
export default api;
