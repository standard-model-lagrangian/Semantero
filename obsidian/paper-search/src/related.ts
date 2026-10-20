import { extractPassage } from "./passage.ts";
import { citedKeys, formatCitation } from "./cite.ts";
import { semantic, type Hit, type LoadedIndex } from "./engine.ts";
import { ensureLiteratureNote, type LitNoteSettings, type VaultLike, type MetadataCacheLike } from "./litnote.ts";
import type { PaperMetadata } from "./bm25.ts";

export interface RelatedSettings extends LitNoteSettings {
  relatedLimit?: number;
  relatedMinScore?: number;
  relatedAutoRefresh?: boolean;
  relatedInstruction?: string;
  citationFormat?: string;
}

export interface RelatedEmbedderLike {
  embedQuery(text: string, instruction?: string): Promise<Float32Array | null>;
}

export interface RelatedIndexStoreLike {
  isReady(): boolean;
  getIndex(): LoadedIndex | null;
}

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export type RelatedPanelState =
  | "empty"
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
  private sessionNotices = new Set<string>();

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

  setState(newState: RelatedPanelState): void {
    this.state = newState;
    this.onStateChange?.(newState);
  }

  onFileOpen(
    file: { path: string } | null,
    getTextFn?: () => string,
    cursorOffset = 0,
    selection = ""
  ): void {
    const filePath = file?.path || "";
    this.activeFilePath = filePath;

    if (this.autoRefreshTimer) {
      this.clearTimeoutFn(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }

    if (!file) {
      this.setState("empty");
      return;
    }

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
      filePath === this.lastRefreshedPath &&
      passage === this.lastRefreshedPassage
    ) {
      return;
    }

    const seq = ++this.currentSeq;
    const pathAtStart = filePath;
    this.setState("loading");

    try {
      const instruction = this.settings.relatedInstruction;
      const qVec = await this.embedder.embedQuery(passage, instruction);

      // Switching notes mid-refresh or older refresh arriving drops response (P3, P4)
      if (seq !== this.currentSeq || this.activeFilePath !== pathAtStart) {
        return;
      }

      if (!qVec) {
        this.handleOllamaDown();
        return;
      }

      const ix = this.indexStore.getIndex();
      if (!ix) {
        this.setState("empty");
        return;
      }

      // Semantic search candidates
      const minScore = this.settings.relatedMinScore ?? 0.25;
      const candidates = semantic(ix, qVec, passage, {
        limit: 50,
        minScore,
      });

      if (candidates.length === 0) {
        this.setState("nothing-close");
        return;
      }

      this.citedKeysSet = citedKeys(noteText);
      this.allHits = candidates;
      this.lastRefreshedPath = pathAtStart;
      this.lastRefreshedPassage = passage;
      this.setState("results");
    } catch {
      if (seq === this.currentSeq && this.activeFilePath === pathAtStart) {
        this.handleOllamaDown();
      }
    }
  }

  private handleOllamaDown(): void {
    if (!this.ollamaDownNotified) {
      this.ollamaDownNotified = true;
      this.showNotice?.("Paper search: Ollama is not running for related papers.");
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
      const isCited =
        this.citedKeysSet.has(paper.citekey) ||
        (paper.citekey && this.citedKeysSet.has(paper.citekey.toLowerCase()));

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
    this.setState(this.state);
  }

  async handleCiteAction(
    paper: PaperMetadata,
    activeEditor?: {
      replaceRange(text: string, pos?: any): void;
      getCursor?(): any;
    } | null,
    clipboard?: ClipboardLike | null
  ): Promise<void> {
    const format = this.settings.citationFormat || "[[{{citekey}}]]";
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

  getPdfUrl(paper: PaperMetadata, hit: Hit): string {
    const key = paper.key || paper.citekey;
    const page = hit.page || 1;
    return `zotero://open-pdf/0_${key}/${page}`;
  }
}

/**
 * Creates the Obsidian ItemView subclass for Related Papers panel.
 */
export function createRelatedPapersViewClass(ItemViewBase: any) {
  return class RelatedPapersView extends ItemViewBase {
    controller: RelatedPapersController;

    constructor(leaf: any, controller: RelatedPapersController) {
      super(leaf);
      this.controller = controller;
      this.controller.onStateChange = () => this.render();
    }

    getViewType(): string {
      return "daito-related-papers";
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
      const header = container.createDiv?.({ cls: "daito-related-header" }) || container;
      const titleEl = header.createEl?.("h4", { text: "Related papers" });
      const refreshBtn = header.createEl?.("button", { text: "Refresh" });
      refreshBtn?.addEventListener?.("click", () => {
        const activeView = (this.app.workspace as any).getActiveViewOfType?.("markdown");
        if (activeView?.editor) {
          const editor = activeView.editor;
          const text = editor.getValue();
          const sel = editor.getSelection();
          const cursor = editor.posToOffset(editor.getCursor());
          this.controller.refresh(text, cursor, sel, activeView.file?.path || "");
        }
      });

      const body = container.createDiv?.({ cls: "daito-related-body" }) || container;

      // State views
      if (this.controller.state === "empty") {
        body.createEl?.("div", {
          cls: "daito-related-empty",
          text: "Open a note and press Refresh to find related papers.",
        });
        return;
      }

      if (this.controller.state === "loading") {
        body.createEl?.("div", {
          cls: "daito-related-loading",
          text: "Searching for related papers…",
        });
        return;
      }

      if (this.controller.state === "too-short") {
        body.createEl?.("div", {
          cls: "daito-related-empty",
          text: "Write a bit more first",
        });
        return;
      }

      if (this.controller.state === "needs-ollama") {
        body.createEl?.("div", {
          cls: "daito-related-warning",
          text: "Related papers needs Ollama running",
        });
        return;
      }

      if (this.controller.state === "nothing-close") {
        body.createEl?.("div", {
          cls: "daito-related-empty",
          text: "Nothing close in your library",
        });
        return;
      }

      if (this.controller.state === "results") {
        const { items, hiddenCount, showHidden } = this.controller.getDisplayItems();

        for (const item of items) {
          const row = body.createDiv?.({ cls: "daito-related-row" });
          const rowTitle = row?.createDiv?.({
            cls: "daito-related-title",
            text: item.paper.title || "Untitled",
          });
          rowTitle?.addEventListener?.("click", () => {
            const url = this.controller.getPdfUrl(item.paper, item.hit);
            window.open(url);
          });

          const meta = row?.createDiv?.({ cls: "daito-related-meta" });
          const author = item.paper.authors?.[0] || "Unknown";
          const year = item.paper.year ? String(item.paper.year) : "n.d.";
          const badge = item.hit.page ? `p. ${item.hit.page}` : "abstract";
          meta?.setText?.(`${author} · ${year} · [${badge}]`);

          if (item.hit.snippet) {
            const snippet = row?.createDiv?.({ cls: "daito-related-snippet" });
            snippet?.setText?.(item.hit.snippet);
          }

          // Action buttons
          const actions = row?.createDiv?.({ cls: "daito-related-actions" });
          const citeBtn = actions?.createEl?.("button", { text: "Cite" });
          citeBtn?.addEventListener?.("click", () => {
            const activeView = (this.app.workspace as any).getActiveViewOfType?.("markdown");
            this.controller.handleCiteAction(
              item.paper,
              activeView?.editor,
              navigator.clipboard
            );
          });

          const noteBtn = actions?.createEl?.("button", { text: "Note" });
          noteBtn?.addEventListener?.("click", () => {
            this.controller.handleNoteAction(item.paper, this.app.workspace);
          });
        }

        if (hiddenCount > 0) {
          const footer = body.createDiv?.({ cls: "daito-related-footer" });
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
