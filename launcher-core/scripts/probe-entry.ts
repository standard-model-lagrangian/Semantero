// Memory probe entry: staged BM25 work with the real code, driven from Swift (`semantero-bench --jsprobe2 <probe.js>`).
import { BM25Index } from "../../obsidian/paper-search/src/core/bm25.ts";
import { tokenize } from "../../obsidian/paper-search/src/core/text.ts";

let papers: any[] = [], chunks: any[] = [], idx: any = null, tok: any = null;
(globalThis as any).probe = {
  parse(papersJson: string, chunksJson: string) { papers = JSON.parse(papersJson); chunks = JSON.parse(chunksJson); return chunks.length; },
  tokenizeAll() { let n = 0; for (const c of chunks) n += tokenize(c.text).tokens.length; return n; },
  keepTokens() { tok = chunks.map((c) => tokenize(c.text).tokens); return tok.length; },
  dropTokens() { tok = null; },
  build() { idx = new BM25Index(papers, chunks); return 1; },
  dropIndex() { idx = null; },
  mapsOnly() { const out: Map<string, number>[] = []; for (const c of chunks) { const m = new Map<string, number>(); for (const t of tokenize(c.text).tokens) m.set(t, (m.get(t) || 0) + 1); out.push(m); } tok = out; return out.length; },
};
