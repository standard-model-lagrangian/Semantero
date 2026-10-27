import { keyword, hybridSearchFromScores, type Hit, type LoadedIndex } from "./engine.ts";
import { semanticText, shouldRunSemantic } from "./rank.ts";
import { QueryJobs } from "./queryjobs.ts";
import { embedderName } from "./semantic.ts";
import { indexedKeys } from "./zoterolive.ts";
import { ensureLiteratureNote, type LitNoteSettings, type MetadataCacheLike, type VaultLike } from "./litnote.ts";
import type { PaperMetadata } from "./bm25.ts";

/**
 * The search modal's logic without Obsidian (modal.ts is the view): keyword results at once, then, after the debounce,
 * the semantic merge and a lookup in Zotero for papers the index doesn't list yet, both owned by the query on screen.
 */

export interface ModalSearchItem {
  hit?: Hit;
  paperIndex?: number;
  /** A paper Zotero has and the index doesn't list yet (zoterolive.ts); no paperIndex. */
  livePaper?: PaperMetadata;
  isLoadingRow?: boolean;
}

export interface ModalSearchSettings extends LitNoteSettings {
  limit: number;
  debounceMs: number;
  minCharsSemantic: number;
}

/** The list on screen. */
export interface ModalListView {
  /** Replace the rows and select row `selected`. */
  setSuggestions(items: ModalSearchItem[], selected: number): void;
  selectedIndex(): number;
  setFooter(msg: string): void;
}

/** The part of Obsidian's internal `SuggestModal.chooser` the modal uses; any of it may be missing. */
export interface ChooserLike {
  values?: ModalSearchItem[];
  selectedItem?: number;
  setSuggestions?(items: ModalSearchItem[]): void;
  setSelectedItem?(index: number, evt?: unknown): void;
}

/**
 * A ModalListView over Obsidian's internal chooser. `setSuggestions` resets the selection to row 0, so the selection is
 * set afterwards. Without a chooser (an Obsidian that renamed it) the list stays as it is.
 */
export function chooserView(chooser: () => ChooserLike | null | undefined, setFooter: (msg: string) => void): ModalListView {
  return {
    setSuggestions(items, selected) {
      const c = chooser();
      if (!c || typeof c.setSuggestions !== "function") return;
      c.setSuggestions(items);
      if (typeof c.setSelectedItem === "function") c.setSelectedItem(selected);
      else c.selectedItem = selected;
    },
    selectedIndex: () => chooser()?.selectedItem ?? 0,
    setFooter,
  };
}

export interface ModalIndexStoreLike {
  isReady(): boolean;
  getIndex(): LoadedIndex | null;
}

export class ModalSearchController {
  private indexStore: ModalIndexStoreLike;
  private semanticScores: (ix: LoadedIndex, text: string, instruction: string | undefined) => Promise<ArrayLike<number> | null>;
  private zotero: { search(query: string, known: Set<string>): Promise<PaperMetadata[]> };
  private settings: ModalSearchSettings;
  private view: ModalListView;
  private vault: VaultLike;
  private metadataCache: MetadataCacheLike | null;
  private showNotice?: (msg: string) => void;
  private sessionNotices?: Set<string>;
  /** The semantic merge and the Zotero lookup for the query on screen; a new query or closing drops them. */
  private jobs: QueryJobs;

  /** The rows on screen. */
  private items: ModalSearchItem[] = [];
  /** Rows from Zotero for the query on screen, kept below the index's own hits. */
  private liveItems: ModalSearchItem[] = [];
  /** The query on screen (as `semanticText`) and the index it was ranked on. */
  private shownKey: string | null = null;
  private shownIndex: LoadedIndex | null = null;

  constructor(options: {
    indexStore: ModalIndexStoreLike;
    /** Per-row semantic scores (semantic.ts); throws when the embedder is down. */
    semanticScores: (ix: LoadedIndex, text: string, instruction: string | undefined) => Promise<ArrayLike<number> | null>;
    zotero: { search(query: string, known: Set<string>): Promise<PaperMetadata[]> };
    settings: ModalSearchSettings;
    view: ModalListView;
    vault: VaultLike;
    metadataCache?: MetadataCacheLike | null;
    showNotice?: (msg: string) => void;
    /** Shared with `@@` and the panel so once-per-session notices really show once. */
    sessionNotices?: Set<string>;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (id: unknown) => void;
  }) {
    this.indexStore = options.indexStore;
    this.semanticScores = options.semanticScores;
    this.zotero = options.zotero;
    this.settings = options.settings;
    this.view = options.view;
    this.vault = options.vault;
    this.metadataCache = options.metadataCache ?? null;
    this.showNotice = options.showNotice;
    this.sessionNotices = options.sessionNotices;
    this.jobs = new QueryJobs(options.setTimeoutFn, options.clearTimeoutFn);
  }

  /** The modal closed: nothing scheduled runs, and nothing in flight touches the list. */
  close(): void {
    this.jobs.cancel();
  }

  paperOf(item: ModalSearchItem): PaperMetadata | null {
    if (item.isLoadingRow) return null;
    if (item.livePaper) return item.livePaper;
    if (item.paperIndex === undefined) return null;
    return this.indexStore.getIndex()?.papers[item.paperIndex] ?? null;
  }

  selectedItem(): ModalSearchItem | null {
    return this.items[this.view.selectedIndex()] ?? null;
  }

  getSuggestions(query: string): ModalSearchItem[] {
    const ix = this.indexStore.getIndex();
    if (!ix || !this.indexStore.isReady()) return [{ isLoadingRow: true }];

    // Typing or deleting whitespace cannot change the results: keep the list on screen (and any semantic merge on its
    // way) instead of flashing back to keyword-only results until the merge lands again.
    const key = semanticText(query);
    if (key === this.shownKey && ix === this.shownIndex) return this.items;
    this.shownKey = key;
    this.shownIndex = ix;
    // Every new query supersedes the last one's jobs, even if it is too short to schedule a semantic merge itself.
    const token = this.jobs.restart();
    this.liveItems = [];

    this.items = keyword(ix, query, this.settings.limit).map((h) => ({ hit: h, paperIndex: h.paper }));

    if (shouldRunSemantic(query, this.settings.minCharsSemantic) && ix.vectors) {
      this.jobs.after(this.settings.debounceMs, () => this.runSemantic(query, ix, token));
    }
    this.jobs.after(this.settings.debounceMs, () => this.runLive(query, ix, token));
    return this.items;
  }

  /** The literature note for `paper`, created from the template if it is missing. */
  ensureNote(paper: PaperMetadata): Promise<{ file: any | null; created: boolean }> {
    return ensureLiteratureNote(this.vault, this.metadataCache, paper, this.settings, {
      showNotice: this.showNotice,
      sessionNotices: this.sessionNotices,
    });
  }

  private async runLive(query: string, ix: LoadedIndex, token: number): Promise<void> {
    const found = await this.zotero.search(query, indexedKeys(ix));
    if (!this.jobs.isCurrent(token) || found.length === 0) return;
    this.liveItems = found.map((livePaper) => ({ livePaper }));
    this.show([...this.items.filter((it) => !it.livePaper), ...this.liveItems]);
  }

  private async runSemantic(query: string, ix: LoadedIndex, token: number): Promise<void> {
    let scores: ArrayLike<number> | null;
    try {
      scores = await this.semanticScores(ix, semanticText(query), ix.manifest?.query_instruction);
    } catch {
      if (this.jobs.isCurrent(token)) this.view.setFooter(`semantic off: ${embedderName(ix)} not reachable`);
      return;
    }
    if (!this.jobs.isCurrent(token)) return; // a reply for a query no longer on screen
    this.view.setFooter("");
    // Merge over the full ranked lists, not the rows shown while typing.
    const merged = hybridSearchFromScores(ix, query, scores, this.settings.limit);
    this.show([...merged.map((h) => ({ hit: h, paperIndex: h.paper })), ...this.liveItems]);
  }

  /** Show `items`, keeping the selection on the same paper if it is still listed (else the first row). */
  private show(items: ModalSearchItem[]): void {
    const before = this.selectedItem();
    const prev = before ? this.paperOf(before)?.key : undefined;
    const at = prev === undefined ? -1 : items.findIndex((it) => this.paperOf(it)?.key === prev);
    this.items = items;
    this.view.setSuggestions(items, at === -1 ? 0 : at);
  }
}
