import { extractPassage } from "./passage.ts";
import { citedKeys, formatCitation, DEFAULT_CITATION_FORMAT } from "./cite.ts";
import { rowScores, semanticFromRowScores, type Hit, type LoadedIndex } from "./engine.ts";
import { ensureLiteratureNote, type LitNoteSettings, type VaultLike, type MetadataCacheLike } from "./litnote.ts";
import type { PaperMetadata } from "./bm25.ts";
import { editorSnapshot, type ActiveEditorTracker } from "./editortracker.ts";
import { hitUrl } from "./zotero.ts";
import { embedderName } from "./semantic.ts";

/** Hide related papers scoring below this (calibrated with scripts/eval-related.ts; a setting overrides it). */
export const DEFAULT_RELATED_MIN_SCORE = 0.5;

export interface RelatedSettings extends LitNoteSettings {
  relatedLimit?: number;
  relatedMinScore?: number;
  relatedAutoRefresh?: boolean;
  relatedInstruction?: string;
  citationFormat?: string;
}

export interface RelatedEmbedderLike {
  embedQuery(text: string, instruction?: string): Promise<Float32Array | null>;
  /** Per-row scores for any backend (semantic.ts); when present it is used instead of embedQuery. Throws when down. */
  rowScores?(text: string, ix: LoadedIndex, instruction?: string): Promise<ArrayLike<number> | null>;
}

export interface RelatedIndexStoreLike {
  isReady(): boolean;
  getIndex(): LoadedIndex | null;
  /** Throttled check that swaps in a newer index from disk; optional so fakes can omit it. */
  ensureFresh?(): Promise<boolean>;
}

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export type RelatedPanelState =
  | "empty"
  | "index-loading"
  | "loading"
  | "needs-ollama"
  | "too-short"
  | "nothing-close"
  | "results";

export interface DisplayResultItem {
  hit: Hit;
  paper: PaperMetadata;
  isCited: boolean;
}

/**
 * Controller managing the Related Papers sidebar panel logic.
 */
export class RelatedPapersController {
  indexStore: RelatedIndexStoreLike;
  embedder: RelatedEmbedderLike;
  vault: VaultLike;
  metadataCache?: MetadataCacheLike;
  settings: RelatedSettings;
  showNotice?: (msg: string) => void;
  setTimeoutFn: (fn: () => void, ms: number) => any;
  clearTimeoutFn: (id: any) => void;

  state: RelatedPanelState = "empty";
  allHits: Hit[] = [];
  citedKeysSet = new Set<string>();
  showHiddenCited = false;

  activeFilePath: string = "";
  lastRefreshedPath: string = "";
  lastRefreshedPassage: string = "";

  private currentSeq = 0;
  private autoRefreshTimer: any = null;
  private ollamaDownNotified = false;
  private sessionNotices: Set<string>;

  onStateChange?: (state: RelatedPanelState) => void;

  constructor(options: {
    indexStore: RelatedIndexStoreLike;
    embedder: RelatedEmbedderLike;
    vault: VaultLike;
    metadataCache?: MetadataCacheLike;
    settings?: RelatedSettings;
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

  setState(newState: RelatedPanelState): void {
    this.state = newState;
    this.onStateChange?.(newState);
  }

  /** Drop results and any in-flight refresh; the panel shows its empty state. */
  private resetToEmpty(): void {
    this.currentSeq++;
    this.allHits = [];
    this.citedKeysSet = new Set();
    this.showHiddenCited = false;
    this.lastRefreshedPath = "";
    this.lastRefreshedPassage = "";
    this.setState("empty");
  }

  onFileOpen(
    file: { path: string } | null,
    getTextFn?: () => string,
    cursorOffset = 0,
    selection = ""
  ): void {
    const filePath = file?.path || "";
    const switched = filePath !== this.activeFilePath;
    this.activeFilePath = filePath;

    if (this.autoRefreshTimer) {
      this.clearTimeoutFn(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }

    // Results (or a pending refresh) belong to the previous note.
    if (!file || switched) {
      this.resetToEmpty();
    }
    if (!file) return;

    // Default relatedAutoRefresh = false: Opening files triggers ZERO embed calls (P5)
    if (!this.settings.relatedAutoRefresh) {
      return;
    }

    // When relatedAutoRefresh = true: debounce 1s after file switch (P6)
    this.autoRefreshTimer = this.setTimeoutFn(() => {
      if (getTextFn && this.activeFilePath === filePath) {
        const text = getTextFn();
        this.refresh(text, cursorOffset, selection, filePath, true);
      }
    }, 1000);
  }

  async refresh(
    noteText: string,
    cursorOffset: number = 0,
    selection: string = "",
    filePath: string = this.activeFilePath,
    isAuto = false
  ): Promise<void> {
    if (filePath) {
      this.activeFilePath = filePath;
    }

    const passage = extractPassage(noteText, cursorOffset, selection, 2000);

    if (!passage) {
      this.setState("too-short");
      return;
    }

    // For auto-refresh: reopening same file with same passage gives no new call (P6)
    if (
      isAuto &&
      (this.state === "results" || this.state === "nothing-close") &&
      filePath === this.lastRefreshedPath &&
      passage === this.lastRefreshedPassage
    ) {
      return;
    }

    const seq = ++this.currentSeq;
    const pathAtStart = filePath;

    // Still loading the index: say so, and don't blame Ollama or spend its notice.
    if (!this.indexStore.isReady()) {
      this.setState("index-loading");
      return;
    }
    this.setState("loading");

    // Pick up a rebuilt index first so a refresh never shows papers already removed from Zotero.
    // Reads only manifest.json unless the index changed; at most once per 10 s.
    if (this.indexStore.ensureFresh) {
      await this.indexStore.ensureFresh().catch(() => false);
      if (seq !== this.currentSeq) return;
      if (this.activeFilePath !== pathAtStart) {
        this.resetToEmpty();
        return;
      }
    }

    try {
      const instruction = this.settings.relatedInstruction;
      const byScores = !!this.embedder.rowScores;
      const qVec = byScores ? null : await this.embedder.embedQuery(passage, instruction);

      // Switching notes mid-refresh or older refresh arriving drops response (P3, P4)
      if (seq !== this.currentSeq) return;
      if (this.activeFilePath !== pathAtStart) {
        this.resetToEmpty();
        return;
      }

      const ix = this.indexStore.isReady() ? this.indexStore.getIndex() : null;
      if (!ix) {
        this.setState("index-loading");
        return;
      }

      let scores: ArrayLike<number> | null;
      if (byScores) {
        scores = await this.embedder.rowScores!(passage, ix, instruction);
        if (seq !== this.currentSeq) return;
        if (this.activeFilePath !== pathAtStart) {
          this.resetToEmpty();
          return;
        }
      } else {
        if (!qVec) {
          this.handleEmbedderDown();
          return;
        }
        scores = rowScores(ix, qVec);
      }

      // Semantic search candidates
      const minScore = this.settings.relatedMinScore ?? DEFAULT_RELATED_MIN_SCORE;
      const candidates = scores ? semanticFromRowScores(ix, scores, passage, { limit: 50, minScore }) : [];

      this.citedKeysSet = new Set([...citedKeys(noteText)].map((k) => k.toLowerCase()));
      this.allHits = candidates;
      this.showHiddenCited = false;
      this.lastRefreshedPath = pathAtStart;
      this.lastRefreshedPassage = passage;
      this.settleResultsState();
    } catch {
      if (seq === this.currentSeq && this.activeFilePath === pathAtStart) {
        if (this.indexStore.isReady()) this.handleEmbedderDown();
        else this.setState("index-loading");
      }
    }
  }

  /** "results" when something uncited (or the revealed cited ones) is listed, else "nothing-close". */
  private settleResultsState(): void {
    const { items } = this.getDisplayItems();
    this.setState(items.length > 0 ? "results" : "nothing-close");
  }

  private handleEmbedderDown(): void {
    if (!this.ollamaDownNotified) {
      this.ollamaDownNotified = true;
      this.showNotice?.(`Paper search: ${embedderName(this.indexStore.getIndex())} is not running for related papers.`);
    }
    this.setState("needs-ollama");
  }

  getDisplayItems(): {
    items: DisplayResultItem[];
    hiddenCount: number;
    showHidden: boolean;
  } {
    const ix = this.indexStore.getIndex();
    if (!ix) return { items: [], hiddenCount: 0, showHidden: false };

    const limit = this.settings.relatedLimit || 5;
    const uncitedItems: DisplayResultItem[] = [];
    const citedItems: DisplayResultItem[] = [];

    for (const h of this.allHits) {
      const paper = ix.papers[h.paper];
      // citedKeysSet holds lower-cased keys.
      const isCited = !!paper.citekey && this.citedKeysSet.has(paper.citekey.toLowerCase());

      const item: DisplayResultItem = { hit: h, paper, isCited };
      if (isCited) {
        citedItems.push(item);
      } else {
        uncitedItems.push(item);
      }
    }

    const hiddenCount = citedItems.length;

    let items: DisplayResultItem[];
    if (this.showHiddenCited) {
      items = [...uncitedItems.slice(0, limit), ...citedItems];
    } else {
      items = uncitedItems.slice(0, limit);
    }

    return {
      items,
      hiddenCount,
      showHidden: this.showHiddenCited,
    };
  }

  toggleShowHidden(): void {
    this.showHiddenCited = !this.showHiddenCited;
    if (this.state === "results" || this.state === "nothing-close") this.settleResultsState();
    else this.setState(this.state);
  }

  async handleCiteAction(
    paper: PaperMetadata,
    activeEditor?: {
      replaceRange(text: string, pos?: any): void;
      getCursor?(): any;
    } | null,
    clipboard?: ClipboardLike | null
  ): Promise<void> {
    const format = this.settings.citationFormat || DEFAULT_CITATION_FORMAT;
    const citation = formatCitation(format, paper.citekey);

    if (activeEditor) {
      const cursor = activeEditor.getCursor ? activeEditor.getCursor() : { line: 0, ch: 0 };
      activeEditor.replaceRange(citation, cursor);
    } else if (clipboard) {
      await clipboard.writeText(citation);
      this.showNotice?.("Copied citation to clipboard");
    }

    // Ensure literature note exists (1c)
    if (this.settings.createLiteratureNotes !== false) {
      try {
        await ensureLiteratureNote(
          this.vault,
          this.metadataCache,
          paper,
          this.settings,
          {
            showNotice: this.showNotice,
            sessionNotices: this.sessionNotices,
          }
        );
      } catch {
        // non-blocking
      }
    }
  }

  async handleNoteAction(
    paper: PaperMetadata,
    workspace?: { openFile(file: any): Promise<void> } | null
  ): Promise<void> {
    const res = await ensureLiteratureNote(
      this.vault,
      this.metadataCache,
      paper,
      this.settings,
      {
        showNotice: this.showNotice,
        sessionNotices: this.sessionNotices,
      }
    );

    if (res.file && workspace?.openFile) {
      await workspace.openFile(res.file);
    }
  }

  /** The attachment that matched (a PDF at the matching page, or a web snapshot); see hitUrl. */
  getPdfUrl(paper: PaperMetadata, hit: Partial<Hit>): string {
    return hitUrl(paper, hit);
  }
}

/**
 * Creates the Obsidian ItemView subclass for Related Papers panel.
 */
export function createRelatedPapersViewClass(
  ItemViewBase: any
): new (leaf: any, controller: RelatedPapersController, tracker: ActiveEditorTracker) => any {
  return class RelatedPapersView extends ItemViewBase {
    controller: RelatedPapersController;
    tracker: ActiveEditorTracker;

    constructor(leaf: any, controller: RelatedPapersController, tracker: ActiveEditorTracker) {
      super(leaf);
      this.controller = controller;
      this.tracker = tracker;
      this.controller.onStateChange = () => this.render();
    }

    getViewType(): string {
      return "semantero-related-papers";
    }

    getDisplayText(): string {
      return "Related papers";
    }

    getIcon(): string {
      return "documents";
    }

    async onOpen(): Promise<void> {
      this.render();
    }

    render(): void {
      const container = this.containerEl.children[1] || this.containerEl;
      container.empty?.();

      // Header with Refresh button
      const header = container.createDiv?.({ cls: "semantero-related-header" }) || container;
      const titleEl = header.createEl?.("h4", { text: "Related papers" });
      const refreshBtn = header.createEl?.("button", { text: "Refresh" });
      refreshBtn?.addEventListener?.("click", () => {
        // The panel is the active view once clicked, so use the last Markdown editor instead.
        const snap = editorSnapshot(this.tracker.get());
        if (snap) {
          this.controller.refresh(snap.text, snap.cursorOffset, snap.selection, snap.filePath);
        }
      });

      const body = container.createDiv?.({ cls: "semantero-related-body" }) || container;

      // State views
      if (this.controller.state === "empty") {
        body.createEl?.("div", {
          cls: "semantero-related-empty",
          text: "Open a note and press Refresh to find related papers.",
        });
        return;
      }

      if (this.controller.state === "index-loading") {
        body.createEl?.("div", {
          cls: "semantero-related-loading",
          text: "Loading paper index…",
        });
        return;
      }

      if (this.controller.state === "loading") {
        body.createEl?.("div", {
          cls: "semantero-related-loading",
          text: "Searching for related papers…",
        });
        return;
      }

      if (this.controller.state === "too-short") {
        body.createEl?.("div", {
          cls: "semantero-related-empty",
          text: "Write a bit more first",
        });
        return;
      }

      if (this.controller.state === "needs-ollama") {
        body.createEl?.("div", {
          cls: "semantero-related-warning",
          text: `Related papers needs ${embedderName(this.controller.indexStore.getIndex())} running`,
        });
        return;
      }

      if (this.controller.state === "nothing-close") {
        body.createEl?.("div", {
          cls: "semantero-related-empty",
          text: "Nothing close in your library",
        });
        // Every close match is already cited: still offer to reveal them.
        if (this.controller.getDisplayItems().hiddenCount === 0) return;
      }

      if (this.controller.state === "results" || this.controller.state === "nothing-close") {
        const { items, hiddenCount, showHidden } = this.controller.getDisplayItems();

        for (const item of items) {
          const row = body.createDiv?.({ cls: "semantero-related-row" });
          const rowTitle = row?.createDiv?.({
            cls: "semantero-related-title",
            text: item.paper.title || "Untitled",
          });
          rowTitle?.addEventListener?.("click", () => {
            const url = this.controller.getPdfUrl(item.paper, item.hit);
            window.open(url);
          });

          const meta = row?.createDiv?.({ cls: "semantero-related-meta" });
          const author = item.paper.authors?.[0] || "Unknown";
          const year = item.paper.year ? String(item.paper.year) : "n.d.";
          const badge = item.hit.page ? `p. ${item.hit.page}` : item.hit.fromAbstract === false ? "web page" : "abstract";
          meta?.setText?.(`${author} · ${year} · [${badge}]`);

          if (item.hit.snippet) {
            const snippet = row?.createDiv?.({ cls: "semantero-related-snippet" });
            snippet?.setText?.(item.hit.snippet);
          }

          // Action buttons
          const actions = row?.createDiv?.({ cls: "semantero-related-actions" });
          const citeBtn = actions?.createEl?.("button", { text: "Cite" });
          citeBtn?.addEventListener?.("click", () => {
            this.controller.handleCiteAction(
              item.paper,
              this.tracker.get()?.editor as any,
              navigator.clipboard
            );
          });

          const noteBtn = actions?.createEl?.("button", { text: "Note" });
          noteBtn?.addEventListener?.("click", () => {
            this.controller.handleNoteAction(item.paper, this.app.workspace);
          });
        }

        if (hiddenCount > 0) {
          const footer = body.createDiv?.({ cls: "semantero-related-footer" });
          const toggleText = showHidden ? "hide" : "show";
          const link = footer?.createEl?.("a", {
            text: `${hiddenCount} already cited · ${toggleText}`,
          });
          link?.addEventListener?.("click", (e: any) => {
            e.preventDefault();
            this.controller.toggleShowHidden();
          });
        }
      }
    }
  };
}
