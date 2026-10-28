import { fillSnippets, keyword, rowScores, semanticFromRowScores, type Hit } from "../../obsidian/paper-search/src/core/engine.ts";
import { bestSnippet, tokenize } from "../../obsidian/paper-search/src/core/text.ts";
import { assembleCorpora, buildCorpus, type Corpora, type Corpus, type CorpusName, type RawCorpus } from "./corpora.ts";
import { collapseLitnotes, interleave, rrf, sortByCosine, type CHit, type Row } from "./merge.ts";
import { buildVM, type ResultVM } from "./vm.ts";

export type Scope = "all" | "papers" | "notes";

/** Row scores per corpus, from `rowScores` or from a native scorer. */
export interface RowScoreInput {
  papers?: ArrayLike<number> | null;
  notes?: ArrayLike<number> | null;
}

export interface Status {
  papers: { count: number; builtAt: string | null; semantic: boolean; reason: string | null } | null;
  notes: { count: number; builtAt: string | null; semantic: boolean; reason: string | null } | null;
  flags: string[];
  model: string | null;
  dims: number | null;
  queryInstruction: string | null;
}

const RECENT_LIMIT = 10;

export interface EngineOptions {
  /** Semantic lists of the two corpora alternate by rank instead of merging by cosine. Only for query
   * vectors made with different instructions per corpus (their cosines are not comparable). */
  interleaveSemantic?: boolean;
}

export class Engine {
  readonly corpora: Corpora;
  private readonly opts: EngineOptions;

  constructor(corpora: Corpora, opts: EngineOptions = {}) {
    this.corpora = corpora;
    this.opts = opts;
  }

  private inScope(scope: Scope): Corpus[] {
    const out: Corpus[] = [];
    if ((scope === "all" || scope === "papers") && this.corpora.papers) out.push(this.corpora.papers);
    if ((scope === "all" || scope === "notes") && this.corpora.notes) out.push(this.corpora.notes);
    return out;
  }

  /** The same engine with a new notes corpus; the papers corpus (the expensive part) is reused as it is. */
  withNotes(notes: RawCorpus | null): Engine {
    return new Engine(assembleCorpora(this.corpora.papers, notes ? buildCorpus("notes", notes) : null), this.opts);
  }

  /** Keyword results only (every keystroke). */
  keyword(query: string, scope: Scope, limit: number): ResultVM[] {
    return this.run(query, scope, limit, null);
  }

  /** Keyword + semantic, with the query embedded by the caller. */
  hybrid(query: string, qVec: Float32Array, scope: Scope, limit: number): ResultVM[] {
    const scores: RowScoreInput = {};
    for (const c of this.inScope(scope)) {
      if (!c.semantic) continue;
      scores[c.name] = rowScores(c.ix, qVec);
    }
    return this.run(query, scope, limit, scores);
  }

  /** Same as `hybrid`, with the vector pass done elsewhere (Accelerate). */
  hybridFromRowScores(query: string, scores: RowScoreInput, scope: Scope, limit: number): ResultVM[] {
    return this.run(query, scope, limit, scores);
  }

  /** The most recently modified notes, newest first (the empty-query view). */
  recent(limit: number): ResultVM[] {
    const notes = this.corpora.notes;
    if (!notes) return [];
    const order = notes.ix.papers
      .map((p, i) => ({ i, mtime: p.mtime ?? 0, path: p.path ?? "" }))
      .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, limit);
    const rows: Row[] = order.map(({ i }) => {
      const p = notes.ix.papers[i];
      const hit: Hit = {
        paper: i, score: 0, source: "keyword", fromAbstract: true,
        snippet: bestSnippet(p.abstract || p.title, []).text,
      };
      return { note: { corpus: "notes", hit }, winner: "note" };
    });
    return rows.map((r) => buildVM(r, this.corpora, []));
  }

  status(): Status {
    const one = (c: Corpus | null) =>
      c ? { count: c.ix.papers.length, builtAt: (c.ix.manifest?.built_at as string | undefined) ?? null, semantic: c.semantic, reason: c.reason } : null;
    return {
      papers: one(this.corpora.papers),
      notes: one(this.corpora.notes),
      flags: this.corpora.flags,
      model: this.corpora.model,
      dims: this.corpora.dims,
      queryInstruction: this.corpora.queryInstruction,
    };
  }

  private run(query: string, scope: Scope, limit: number, sem: RowScoreInput | null): ResultVM[] {
    if (query.trim() === "") return scope === "papers" ? [] : this.recent(Math.min(limit, RECENT_LIMIT));
    const { tokens } = tokenize(query);
    if (tokens.length === 0) return [];

    const corpora = this.inScope(scope);
    const tag = (name: CorpusName) => (h: Hit): CHit => ({ corpus: name, hit: h });

    const kwBy = (name: CorpusName) => {
      const c = corpora.find((x) => x.name === name);
      return c ? keyword(c.ix, query, c.ix.papers.length, { snippets: false }).map(tag(name)) : [];
    };
    const kw = interleave(kwBy("papers"), kwBy("notes"));

    let semList: CHit[] = [];
    if (sem) {
      const per: Record<CorpusName, CHit[]> = { papers: [], notes: [] };
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
        const c = ch.corpus === "papers" ? this.corpora.papers! : this.corpora.notes!;
        fillSnippets(c.ix, [ch.hit], query);
      }
    }
    return rows.map((r) => buildVM(r, this.corpora, tokens));
  }
}
