import type { ChunkDocument, PaperMetadata } from "../../obsidian/paper-search/src/bm25.ts";
import type { LoadedIndex } from "../../obsidian/paper-search/src/engine.ts";
import { IndexStore } from "../../obsidian/paper-search/src/indexstore.ts";
import { toFloat32 } from "./util.ts";

export type CorpusName = "papers" | "notes";

/** One corpus as read from disk (or handed over by the app). */
export interface RawCorpus {
  manifest: any;
  papers: PaperMetadata[];
  chunks: (ChunkDocument & { row?: number | null })[];
  vectors: ArrayBuffer | ArrayBufferView | null;
}

export interface Corpus {
  name: CorpusName;
  ix: LoadedIndex;
  /** false → keyword-only for this corpus; `reason` says why. */
  semantic: boolean;
  reason: string | null;
}

export interface Corpora {
  papers: Corpus | null;
  notes: Corpus | null;
  /** Human-readable problems, for the status line and the menu. */
  flags: string[];
  zoteroStorage: string | null;
  vault: string | null;
  vaultName: string;
  /** Embedding setup shared by both corpora (taken from the reference corpus). */
  model: string | null;
  dims: number | null;
  queryInstruction: string | null;
  /** citekey → the literature note for that paper. Precomputed so building a result never reads the
   * other corpus's index (a Papers-only search must not touch the notes corpus). */
  litnoteByCitekey: Map<string, { path: string }>;
  /** citekey → Zotero item key. */
  paperKeyByCitekey: Map<string, string>;
}

export function buildCorpus(name: CorpusName, raw: RawCorpus): Corpus {
  const manifest = raw.manifest ?? {};
  const dimsOk = Number.isInteger(manifest.dims) && manifest.dims > 0;
  const dims = dimsOk ? (manifest.dims as number) : 1024;
  const rows = IndexStore.countRows(raw.papers, raw.chunks as { row?: number }[]);

  let vectors: Float32Array | null = null;
  let reason: string | null = null;
  if (raw.vectors === null || raw.vectors === undefined) {
    reason = rows > 0 ? "no vectors" : null;
  } else if (!dimsOk) {
    reason = "index dims invalid";
  } else {
    if (raw.vectors.byteLength !== rows * dims * 4) reason = "vectors file invalid";
    else if (rows > 0) vectors = toFloat32(raw.vectors);
  }
  const chunks = raw.chunks.map((c) => ({ ...c, row: c.row === null ? undefined : c.row })) as (ChunkDocument & { row?: number })[];
  const ix = IndexStore.precomputeIndex(manifest, raw.papers, chunks, vectors, dims, name);
  return { name, ix, semantic: vectors !== null, reason };
}

export function buildCorpora(papersRaw: RawCorpus | null, notesRaw: RawCorpus | null): Corpora {
  return assembleCorpora(papersRaw ? buildCorpus("papers", papersRaw) : null, notesRaw ? buildCorpus("notes", notesRaw) : null);
}

/** Corpora from built corpora: flags, the cross-corpus checks and lookups. `papers` may be reused from an earlier
 * engine (a notes-only reload); `notes` must be freshly built, because the model check may mark it keyword-only. */
export function assembleCorpora(papers: Corpus | null, notes: Corpus | null): Corpora {
  const flags: string[] = [];
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

  const litnoteByCitekey = new Map<string, { path: string }>();
  notes?.ix.papers.forEach((p) => {
    if (p.litnoteOf && p.path && !litnoteByCitekey.has(p.litnoteOf)) litnoteByCitekey.set(p.litnoteOf, { path: p.path });
  });
  const paperKeyByCitekey = new Map<string, string>();
  papers?.ix.papers.forEach((p) => {
    if (p.citekey) paperKeyByCitekey.set(p.citekey, p.key);
  });

  const nm = notes?.ix.manifest ?? {};
  return {
    papers,
    notes,
    flags,
    zoteroStorage: (papers?.ix.manifest?.zotero_storage as string | undefined) ?? null,
    vault: (nm.vault as string | undefined) ?? null,
    vaultName: (nm.vault_name as string | undefined) ?? "",
    model: (refM.model as string | undefined) ?? null,
    dims: ref ? ref.ix.dims : null,
    queryInstruction: (refM.query_instruction as string | undefined) ?? null,
    litnoteByCitekey,
    paperKeyByCitekey,
  };
}

