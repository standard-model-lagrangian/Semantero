import { keyword, semantic, hybrid, type SearchResult } from "./engine.ts";
import { findTrigger, isExcludedContext, formatCitation } from "./cite.ts";
import { ensureLiteratureNote, type LitNoteSettings, type VaultLike, type MetadataCacheLike } from "./litnote.ts";
import type { PaperMetadata } from "./bm25.ts";

export interface SuggestionItem {
  type: "paper" | "hint" | "loading";
  paper?: PaperMetadata;
  snippet?: string;
  source?: "keyword" | "semantic" | "hybrid";
  score?: number;
  message?: string;
  semanticOff?: boolean;
}

export interface FakeSuggestLike {
  suggestions?: {
    setSuggestions?(items: SuggestionItem[]): void;
    selectedItem?: number;
    values?: SuggestionItem[];
  };
}

/**
 * 16-entry LRU cache for query results when adapter fallback is used.
 */
export class LRUQueryCache<T> {
  private map = new Map<string, T>();
  private maxEntries: number;

  constructor(maxEntries = 16) {
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key)!;
    // Move to most recently used
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: string, val: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      // Evict oldest (first key in map)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, val);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

/**
 * Maintains selection when suggestions are refreshed.
 * If the previously selected paper is still in the new hits, keep it selected.
 */
export function maintainSelection(
  suggest: FakeSuggestLike,
  oldHits: SuggestionItem[],
  newHits: SuggestionItem[]
): void {
  if (!suggest.suggestions) return;
  const currentIdx = suggest.suggestions.selectedItem ?? 0;
  const oldPaper = oldHits[currentIdx]?.paper;

  if (oldPaper) {
    const newIdx = newHits.findIndex(
      (h) => h.paper && h.paper.citekey === oldPaper.citekey
    );
    if (newIdx !== -1) {
      suggest.suggestions.selectedItem = newIdx;
      return;
    }
  }

  suggest.suggestions.selectedItem = 0;
}

/**
 * Single adapter to update suggestions while the suggest list is open.
 * Uses internal suggest.suggestions.setSuggestions if available;
 * otherwise caches results in LRU cache so the next call gets them.
 */
export function refreshSuggestions(
  suggest: FakeSuggestLike | null | undefined,
  hits: SuggestionItem[],
  query?: string,
  cache?: LRUQueryCache<SuggestionItem[]>
): void {
  if (!suggest) return;

  if (suggest.suggestions && typeof suggest.suggestions.setSuggestions === "function") {
    const oldHits = suggest.suggestions.values || [];
    maintainSelection(suggest, oldHits, hits);
    suggest.suggestions.values = hits;
    suggest.suggestions.setSuggestions(hits);
  } else if (query && cache) {
    cache.set(query, hits);
  }
}

export interface InlineSuggestSettings extends LitNoteSettings {
  inlineTrigger?: string;
  inlineLimit?: number;
  inlineShowSnippet?: boolean;
}

export interface EmbedderLike {
  embedQuery(text: string): Promise<Float32Array | null>;
}

export interface IndexStoreLike {
  isReady(): boolean;
  getIndex(): any;
  getVectors(): Float32Array | null;
  getDims(): number;
  getRowToChunk(): Int32Array | null;
  getRowToPaper(): Int32Array | null;
  getRowIsAbstract(): Uint8Array | null;
  getPaperChunkRows(): Int32Array[] | null;
}

/**
 * Pure controller managing inline suggest state, debouncing, search, and selection.
 */
export class InlineSuggestController {
  indexStore: IndexStoreLike;
  embedder?: EmbedderLike;
  vault: VaultLike;
  metadataCache?: MetadataCacheLike;
  settings: InlineSuggestSettings;
  queryCache = new LRUQueryCache<SuggestionItem[]>(16);

  private debounceTimer: any = null;
  private currentSeq = 0;
  private ollamaDownNotified = false;
  private sessionNotices = new Set<string>();
  showNotice?: (msg: string) => void;
  setTimeoutFn: (fn: () => void, ms: number) => any;
  clearTimeoutFn: (id: any) => void;

  constructor(options: {
    indexStore: IndexStoreLike;
    embedder?: EmbedderLike;
    vault: VaultLike;
    metadataCache?: MetadataCacheLike;
    settings?: InlineSuggestSettings;
    showNotice?: (msg: string) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => any;
    clearTimeoutFn?: (id: any) => void;
  }) {
    this.indexStore = options.indexStore;
    this.embedder = options.embedder;
    this.vault = options.vault;
    this.metadataCache = options.metadataCache;
    this.settings = options.settings || {};
    this.showNotice = options.showNotice;
    this.setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));
  }

  onTrigger(
    cursor: { line: number; ch: number },
    lineText: string,
    sections?: any[]
  ): { start: { line: number; ch: number }; end: { line: number; ch: number }; query: string } | null {
    if (isExcludedContext(sections, cursor.line, lineText, cursor.ch)) {
      return null;
    }

    const trigger = this.settings.inlineTrigger || "@@";
    const res = findTrigger(lineText, cursor.ch, trigger);
    if (!res) return null;

    return {
      start: { line: cursor.line, ch: res.start },
      end: { line: cursor.line, ch: res.end },
      query: res.query,
    };
  }

  async getSuggestions(
    query: string,
    suggestInstance?: FakeSuggestLike
  ): Promise<SuggestionItem[]> {
    // 1. If index not ready yet
    if (!this.indexStore.isReady()) {
      return [{ type: "loading", message: "Loading paper index…" }];
    }

    // 2. Empty query: show hint row
    if (query === "") {
      return [{ type: "hint", message: "Type to search your papers" }];
    }

    // 3. Cached results (adapter fallback or repeated query)
    if (this.queryCache.has(query)) {
      return this.queryCache.get(query)!;
    }

    // 4. Keyword search
    const limit = this.settings.inlineLimit || 8;
    const index = this.indexStore.getIndex();
    const kwHits = keyword(index, query, limit);
    const initialItems: SuggestionItem[] = kwHits.map((h) => ({
      type: "paper",
      paper: index.papers[h.paper],
      snippet: h.snippet,
      source: h.source,
      score: h.score,
    }));

    // Check semantic gating: at least 2 complete tokens or >= 12 chars
    const tokens = query.trim().split(/\s+/);
    const isGated = tokens.length >= 2 || query.length >= 12;

    if (isGated && this.embedder) {
      const seq = ++this.currentSeq;
      if (this.debounceTimer) {
        this.clearTimeoutFn(this.debounceTimer);
      }

      this.debounceTimer = this.setTimeoutFn(async () => {
        try {
          const qVec = await this.embedder!.embedQuery(query);
          if (seq !== this.currentSeq) {
            // Outdated response (I5): drop it
            return;
          }

          if (!qVec) {
            this.handleOllamaDown(initialItems, suggestInstance, query);
            return;
          }

          const semHits = semantic(index, qVec, query, { limit });
          const merged = hybrid(kwHits, semHits, limit, 60);
          const mergedItems: SuggestionItem[] = merged.map((h) => ({
            type: "paper",
            paper: index.papers[h.paper],
            snippet: h.snippet,
            source: h.source,
            score: h.score,
          }));

          refreshSuggestions(suggestInstance, mergedItems, query, this.queryCache);
        } catch {
          this.handleOllamaDown(initialItems, suggestInstance, query);
        }
      }, 250);
    }

    return initialItems;
  }

  private handleOllamaDown(
    items: SuggestionItem[],
    suggestInstance?: FakeSuggestLike,
    query?: string
  ): void {
    if (!this.ollamaDownNotified) {
      this.ollamaDownNotified = true;
      this.showNotice?.("Paper search: Ollama is not running. Using keyword-only search.");
    }
    const withSemanticOff = items.map((it) => ({ ...it, semanticOff: true }));
    refreshSuggestions(suggestInstance, withSemanticOff, query, this.queryCache);
  }

  async selectSuggestion(
    item: SuggestionItem,
    editor: {
      replaceRange(replacement: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void;
      setCursor?(pos: { line: number; ch: number }): void;
    },
    context: {
      start: { line: number; ch: number };
      end: { line: number; ch: number };
    }
  ): Promise<void> {
    if (item.type !== "paper" || !item.paper) {
      // Loading or hint row does nothing when selected (I8)
      return;
    }

    const citation = formatCitation(
      this.settings.citationFormat || "[[{{citekey}}]]",
      item.paper.citekey
    );

    // Single editor transaction (I2)
    editor.replaceRange(citation, context.start, context.end);

    if (editor.setCursor) {
      editor.setCursor({
        line: context.start.line,
        ch: context.start.ch + citation.length,
      });
    }

    // Ensure literature note exists if setting enabled (I3)
    if (this.settings.createLiteratureNotes !== false) {
      try {
        await ensureLiteratureNote(
          this.vault,
          this.metadataCache,
          item.paper,
          this.settings,
          {
            showNotice: this.showNotice,
            sessionNotices: this.sessionNotices,
          }
        );
      } catch {
        // Do not fail editor insert if note creation fails (L12)
      }
    }
  }

  renderSuggestion(item: SuggestionItem, el: HTMLElement): void {
    el.empty?.();

    if (item.type === "loading") {
      const row = el.createDiv?.({ cls: "daito-suggest-loading" }) || el;
      row.setText?.(item.message || "Loading paper index…");
      return;
    }

    if (item.type === "hint") {
      const row = el.createDiv?.({ cls: "daito-suggest-hint" }) || el;
      row.setText?.(item.message || "Type to search your papers");
      return;
    }

    if (item.type === "paper" && item.paper) {
      const container = el.createDiv?.({ cls: "daito-suggest-paper" }) || el;

      // Title cut at 80 characters (I11)
      let title = item.paper.title || "Untitled";
      if (title.length > 80) {
        title = title.slice(0, 77) + "…";
      }
      const titleEl = container.createDiv?.({ cls: "daito-suggest-title" });
      titleEl?.setText?.(title);

      // Subtitle: first author · year
      const firstAuthor =
        item.paper.authors && item.paper.authors.length > 0
          ? item.paper.authors[0]
          : "Unknown author";
      const year = item.paper.year ? String(item.paper.year) : "n.d.";
      const metaEl = container.createDiv?.({ cls: "daito-suggest-meta" });
      metaEl?.setText?.(`${firstAuthor} · ${year}`);

      // Snippet only when inlineShowSnippet is enabled
      if (this.settings.inlineShowSnippet !== false && item.snippet) {
        const snippetEl = container.createDiv?.({ cls: "daito-suggest-snippet" });
        snippetEl?.setText?.(item.snippet);
      }

      if (item.semanticOff) {
        const footer = container.createDiv?.({ cls: "daito-suggest-footer" });
        footer?.setText?.("Semantic search unavailable");
      }
    }
  }
}

/**
 * Creates the Obsidian EditorSuggest subclass given the Obsidian EditorSuggest base class.
 */
export function createPaperSearchSuggestClass(BaseClass: any) {
  return class PaperSearchSuggest extends BaseClass {
    controller: InlineSuggestController;

    constructor(app: any, controller: InlineSuggestController) {
      super(app);
      this.controller = controller;
    }

    onTrigger(cursor: any, editor: any, file: any) {
      const lineText = editor.getLine(cursor.line);
      const cache = this.app.metadataCache.getFileCache(file);
      return this.controller.onTrigger(cursor, lineText, cache?.sections);
    }

    getSuggestions(context: any) {
      return this.controller.getSuggestions(context.query, this);
    }

    renderSuggestion(value: SuggestionItem, el: HTMLElement) {
      this.controller.renderSuggestion(value, el);
    }

    selectSuggestion(value: SuggestionItem, evt: MouseEvent | KeyboardEvent) {
      if (this.context) {
        this.controller.selectSuggestion(value, this.context.editor, {
          start: this.context.start,
          end: this.context.end,
        });
      }
    }
  };
}
