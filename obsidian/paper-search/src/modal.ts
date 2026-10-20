import {
  App,
  MarkdownView,
  Notice,
  SuggestModal,
  requestUrl,
} from "obsidian";
import type PaperSearchPlugin from "./main.ts";
import { keyword, hybridSearch, type Hit, type LoadedIndex } from "./engine.ts";
import { embedQuery, warmUp } from "./ollama.ts";
import { shouldRunSemantic, SemanticCoordinator } from "./rank.ts";
import { ensureLiteratureNote, formatCitation } from "./litnote.ts";
import { hitUrl, selectItemUrl } from "./zotero.ts";

export interface SearchModalItem {
  hit?: Hit;
  paperIndex?: number;
  isLoadingRow?: boolean;
}

export class PaperSearchModal extends SuggestModal<SearchModalItem> {
  plugin: PaperSearchPlugin;
  coordinator: SemanticCoordinator = new SemanticCoordinator();
  currentItems: SearchModalItem[] = [];
  debounceTimer: any = null;
  footerEl: HTMLElement | null = null;
  lastKeywordHits: Hit[] = [];

  constructor(app: App, plugin: PaperSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Search papers by what they found, title, author, or citekey...");
    this.setInstructions([
      { command: "↵", purpose: "open in Zotero" },
      { command: "⌘↵", purpose: "insert citation & create note" },
      { command: "⌥↵", purpose: "open/create literature note" },
      { command: "⇧↵", purpose: "select in Zotero" },
    ]);
  }

  async onOpen() {
    super.onOpen();

    // Background ensureFresh check
    this.plugin.indexStore.ensureFresh().catch(() => {});

    // Warm up Ollama
    const ix = this.plugin.indexStore.getIndex();
    if (ix?.manifest?.model) {
      warmUp(requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model: ix.manifest.model,
        keepAlive: "30m",
      });
    }

    // Add status footer
    const modalEl = this.modalEl;
    this.footerEl = modalEl.createDiv({ cls: "paper-search-footer" });
    this.footerEl.style.fontSize = "0.8em";
    this.footerEl.style.color = "var(--text-muted)";
    this.footerEl.style.padding = "4px 8px";

    // Setup keyboard modifiers
    this.scope.register(["Mod"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item && !item.isLoadingRow && item.paperIndex !== undefined) {
        this.insertCitationAndEnsureNote(item.paperIndex);
        this.close();
      }
      return false;
    });

    this.scope.register(["Alt"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item && !item.isLoadingRow && item.paperIndex !== undefined) {
        this.openLiteratureNote(item.paperIndex);
        this.close();
      }
      return false;
    });

    this.scope.register(["Shift"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item && !item.isLoadingRow && item.paperIndex !== undefined) {
        this.selectInZotero(item.paperIndex);
        this.close();
      }
      return false;
    });
  }

  getSelectedItem(): SearchModalItem | null {
    return (this as any).chooser?.values?.[(this as any).chooser?.selectedItem] || null;
  }

  updateFooter(msg: string) {
    if (this.footerEl) {
      this.footerEl.setText(msg);
    }
  }

  getSuggestions(query: string): SearchModalItem[] {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix || !this.plugin.indexStore.isReady()) {
      return [{ isLoadingRow: true }];
    }

    // 1. Instant keyword search
    const kHits = keyword(ix, query, this.plugin.settings.limit);
    this.lastKeywordHits = kHits;

    const items: SearchModalItem[] = kHits.map((h) => ({
      hit: h,
      paperIndex: h.paper,
    }));
    this.currentItems = items;

    // 2. Schedule debounced semantic search
    this.scheduleSemanticSearch(query, ix);

    return items;
  }

  scheduleSemanticSearch(query: string, ix: LoadedIndex) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (!shouldRunSemantic(query, this.plugin.settings.minCharsSemantic) || !ix.vectors) {
      return;
    }

    const { seq } = this.coordinator.newRequest();

    this.debounceTimer = setTimeout(async () => {
      await this.runSemantic(query, ix, seq);
    }, this.plugin.settings.debounceMs);
  }

  async runSemantic(query: string, ix: LoadedIndex, seq: number) {
    if (!ix.vectors) return;

    try {
      const qVec = await embedQuery(requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model: ix.manifest.model,
        instruction: ix.manifest.query_instruction,
        query,
        dims: ix.dims,
      });

      if (!this.coordinator.isCurrent(seq)) {
        return; // Stale response dropped
      }

      this.updateFooter("");

      // Semantic search + Hybrid merge
      // Merge over the full ranked lists, not the 12 shown while typing.
      const mergedHits = hybridSearch(ix, query, qVec, this.plugin.settings.limit);

      const newItems: SearchModalItem[] = mergedHits.map((h) => ({
        hit: h,
        paperIndex: h.paper,
      }));

      // Maintain selection
      const currentItem = this.getSelectedItem();
      const prevPaper = currentItem?.paperIndex ?? null;

      let newSelectedIdx = 0;
      if (prevPaper !== null) {
        const found = newItems.findIndex((it) => it.paperIndex === prevPaper);
        if (found >= 0) newSelectedIdx = found;
      }

      this.currentItems = newItems;
      (this as any).chooser?.setSuggestions(newItems);
      (this as any).chooser?.setSelectedItem(newSelectedIdx);
    } catch {
      this.updateFooter("semantic off: Ollama not reachable");
    }
  }

  renderSuggestion(item: SearchModalItem, el: HTMLElement) {
    el.empty();

    if (item.isLoadingRow) {
      el.createDiv({ text: "Loading paper index…", cls: "paper-search-loading" });
      return;
    }

    const ix = this.plugin.indexStore.getIndex();
    if (!ix || item.paperIndex === undefined) return;
    const paper = ix.papers[item.paperIndex];
    const hit = item.hit;

    const row = el.createDiv({ cls: "paper-search-item" });
    const titleEl = row.createDiv({ cls: "paper-title", text: paper.title });
    titleEl.style.fontWeight = "bold";

    const metaParts = [];
    if (paper.authors && paper.authors.length > 0) metaParts.push(paper.authors.join(", "));
    if (paper.year) metaParts.push(String(paper.year));
    if (paper.journal) metaParts.push(paper.journal);

    const metaEl = row.createDiv({ cls: "paper-meta", text: metaParts.join(" · ") });
    metaEl.style.fontSize = "0.85em";
    metaEl.style.color = "var(--text-muted)";

    if (hit && hit.snippet) {
      const snippetContainer = row.createDiv({ cls: "paper-snippet-container" });
      snippetContainer.style.fontSize = "0.85em";
      snippetContainer.style.marginTop = "2px";

      const badge = snippetContainer.createSpan({ cls: "paper-snippet-badge" });
      badge.style.display = "inline-block";
      badge.style.padding = "1px 4px";
      badge.style.fontSize = "0.75em";
      badge.style.borderRadius = "3px";
      badge.style.marginRight = "6px";
      badge.style.backgroundColor = "var(--background-secondary)";

      if (hit.fromAbstract) {
        badge.setText("abstract");
      } else if (hit.page) {
        badge.setText(`p. ${hit.page}`);
      } else {
        badge.setText("web page");
      }

      snippetContainer.createSpan({ text: hit.snippet, cls: "paper-snippet-text" });
    }
  }

  onChooseSuggestion(item: SearchModalItem, _evt: MouseEvent | KeyboardEvent) {
    if (item.isLoadingRow || item.paperIndex === undefined) return;
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[item.paperIndex];
    const hit = item.hit;

    // Enter: open the matching PDF at its page, or the matching web snapshot, in Zotero
    window.open(hitUrl(paper, hit));
  }

  async insertCitationAndEnsureNote(paperIndex: number) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];
    if (!paper) return;

    if (!paper.citekey) {
      new Notice("Paper search: paper has no citekey. Ensure Better BibTeX is installed in Zotero.");
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const citation = formatCitation(this.plugin.settings.citationFormat, paper.citekey);
      editor.replaceRange(citation, editor.getCursor());
    }

    await ensureLiteratureNote(
      this.app.vault,
      this.app.metadataCache,
      paper,
      this.plugin.settings,
      { showNotice: (m) => new Notice(m), sessionNotices: this.plugin.litNoteNotices }
    );
  }

  async openLiteratureNote(paperIndex: number) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];

    const res = await ensureLiteratureNote(
      this.app.vault,
      this.app.metadataCache,
      paper,
      this.plugin.settings,
      { showNotice: (m) => new Notice(m), sessionNotices: this.plugin.litNoteNotices }
    );

    if (res.file) {
      this.app.workspace.getLeaf().openFile(res.file);
    }
  }

  selectInZotero(paperIndex: number) {
    const ix = this.plugin.indexStore.getIndex();
    if (!ix) return;
    const paper = ix.papers[paperIndex];
    if (paper.key) {
      window.open(selectItemUrl(paper.key));
    }
  }
}
