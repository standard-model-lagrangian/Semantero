import { keyword, hybridSearch } from "./engine.ts";
import { findTrigger, isExcludedContext, formatCitation } from "./cite.ts";
import { shouldRunSemantic } from "./rank.ts";
import { ensureLiteratureNote, type LitNoteSettings, type VaultLike, type MetadataCacheLike } from "./litnote.ts";
import type { PaperMetadata } from "./bm25.ts";

export interface SuggestionItem {
  type: "paper" | "hint" | "loading" | "footer";
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
    setSelectedItem?(index: number, evt?: unknown): void;
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
 * Index the selection should move to after a refresh: the same paper if it is still listed,
 * otherwise the first row.
 */
export function selectionAfterRefresh(
  oldHits: SuggestionItem[],
  oldSelected: number,
  newHits: SuggestionItem[]
): number {
  const oldPaper = oldHits[oldSelected]?.paper;
  if (!oldPaper) return 0;
  const idx = newHits.findIndex((h) => h.paper && h.paper.citekey === oldPaper.citekey);
  return idx === -1 ? 0 : idx;
}

/** Sets suggest.suggestions.selectedItem to the index from selectionAfterRefresh. */
export function maintainSelection(
  suggest: FakeSuggestLike,
  oldHits: SuggestionItem[],
  newHits: SuggestionItem[]
): void {
  if (!suggest.suggestions) return;
  suggest.suggestions.selectedItem = selectionAfterRefresh(oldHits, suggest.suggestions.selectedItem ?? 0, newHits);
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

  const s = suggest.suggestions;
  if (s && typeof s.setSuggestions === "function") {
    const newIdx = selectionAfterRefresh(s.values || [], s.selectedItem ?? 0, hits);
    // setSuggestions resets the selection to row 0, so restore it afterwards.
    s.setSuggestions(hits);
    if (s.values !== hits) s.values = hits;
    if (typeof s.setSelectedItem === "function") s.setSelectedItem(newIdx);
    else s.selectedItem = newIdx;
  } else if (query && cache) {
    cache.set(query, hits);
  }
}

export interface InlineSuggestSettings extends LitNoteSettings {
  inlineTrigger?: string;
  inlineLimit?: number;
  inlineShowSnippet?: boolean;
  minCharsSemantic?: number;
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
  /** Throttled check that swaps in a newer index from disk; optional so fakes can omit it. */
  ensureFresh?(): Promise<boolean>;
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
  /** content_hash (or load id) of the index the query cache was filled from. */
  private cacheVersion: unknown = undefined;
  private sessionNotices: Set<string>;
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
    /** Shared with the search modal so once-per-session notices really show once. */
    sessionNotices?: Set<string>;
  }) {
    this.sessionNotices = options.sessionNotices ?? new Set<string>();
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
    // findTrigger first: it is cheap and rejects almost every keystroke.
    const trigger = this.settings.inlineTrigger || "@@";
    const res = findTrigger(lineText, cursor.ch, trigger);
    if (!res) return null;

    if (isExcludedContext(sections, cursor.line, lineText, cursor.ch)) {
      return null;
    }

    return {
      start: { line: cursor.line, ch: res.start },
      end: { line: cursor.line, ch: res.end },
      query: res.query,
    };
  }

  /** Drop any pending or in-flight semantic request (list closed, or the query changed). */
  cancel(): void {
    this.currentSeq++;
    if (this.debounceTimer) {
      this.clearTimeoutFn(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  async getSuggestions(
    query: string,
    suggestInstance?: FakeSuggestLike
  ): Promise<SuggestionItem[]> {
    // Every new query supersedes earlier requests, whether or not it runs semantic search itself.
    this.cancel();

    // Pick up a rebuilt index (e.g. a paper deleted in Zotero) without waiting for the modal.
    // Runs in the background so typing never waits on disk; the query cache drops on swap.
    this.indexStore.ensureFresh?.().catch(() => {});

    // 1. If index not ready yet
    if (!this.indexStore.isReady()) {
      return [{ type: "loading", message: "Loading paper index…" }];
    }

    // 2. Empty query: show hint row
    if (query === "") {
      return [{ type: "hint", message: "Type to search your papers" }];
    }

    // 3. Cached results (adapter fallback or repeated query), dropped when the index changes
    const index = this.indexStore.getIndex();
    const version = index?.manifest?.content_hash ?? index?.manifest?.built_at ?? index?.id;
    if (version !== this.cacheVersion) {
      this.queryCache.clear();
      this.cacheVersion = version;
    }
    if (this.queryCache.has(query)) {
      return this.queryCache.get(query)!;
    }

    // 4. Keyword search
    const limit = this.settings.inlineLimit || 8;
    const kwHits = keyword(index, query, limit);
    const initialItems: SuggestionItem[] = kwHits.map((h) => ({
      type: "paper",
      paper: index.papers[h.paper],
      snippet: h.snippet,
      source: h.source,
      score: h.score,
    }));

    if (shouldRunSemantic(query, this.settings.minCharsSemantic ?? 12) && this.embedder) {
      const seq = this.currentSeq;
      this.debounceTimer = this.setTimeoutFn(async () => {
        this.debounceTimer = null;
        try {
          const qVec = await this.embedder!.embedQuery(query);
          if (seq !== this.currentSeq) {
            // Outdated response (I5): drop it
            return;
          }

          if (!qVec) {
            this.handleOllamaDown(initialItems, suggestInstance);
            return;
          }

          const merged = hybridSearch(index, query, qVec, limit);
          const mergedItems: SuggestionItem[] = merged.map((h) => ({
            type: "paper",
            paper: index.papers[h.paper],
            snippet: h.snippet,
            source: h.source,
            score: h.score,
          }));

          refreshSuggestions(suggestInstance, mergedItems, query, this.queryCache);
        } catch {
          if (seq !== this.currentSeq) return; // failure of an outdated request
          this.handleOllamaDown(initialItems, suggestInstance);
        }
      }, 250);
    }

    return initialItems;
  }

  /** Keyword-only results with one footer row. Never cached, so the next query retries semantic. */
  private handleOllamaDown(items: SuggestionItem[], suggestInstance?: FakeSuggestLike): void {
    if (!this.ollamaDownNotified) {
      this.ollamaDownNotified = true;
      this.showNotice?.("Paper search: Ollama is not running. Using keyword-only search.");
    }
    const withSemanticOff: SuggestionItem[] = items.map((it) => ({ ...it, semanticOff: true }));
    withSemanticOff.push({ type: "footer", message: "Semantic search unavailable" });
    refreshSuggestions(suggestInstance, withSemanticOff);
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
      // Loading, hint or footer row does nothing when selected (I8)
      return;
    }

    if (!item.paper.citekey) {
      this.showNotice?.("Paper search: paper has no citekey. Ensure Better BibTeX is installed in Zotero.");
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

    if (item.type === "footer") {
      const row = el.createDiv?.({ cls: "daito-suggest-footer" }) || el;
      row.setText?.(item.message || "Semantic search unavailable");
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
        title = title.slice(0, 79) + "…";
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
      // Tab inserts like Enter (spec 1c) instead of indenting the line.
      this.scope?.register?.([], "Tab", (evt: KeyboardEvent) => {
        if (typeof this.suggestions?.useSelectedItem !== "function") return true;
        this.suggestions.useSelectedItem(evt);
        return false;
      });
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

    close() {
      this.controller.cancel();
      super.close();
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
