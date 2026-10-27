import {
  App,
  MarkdownView,
  Notice,
  SuggestModal,
  requestUrl,
} from "obsidian";
import type PaperSearchPlugin from "./main.ts";
import { keyword, hybridSearchFromScores, type Hit, type LoadedIndex } from "./engine.ts";
import { DEFAULT_KEEP_ALIVE } from "./ollama.ts";
import { embedderName, warmSemantic } from "./semantic.ts";
import { semanticText, shouldRunSemantic } from "./rank.ts";
import { QueryJobs } from "./queryjobs.ts";
import { ensureLiteratureNote } from "./litnote.ts";
import { formatCitation } from "./cite.ts";
import { hitUrl, selectItemUrl } from "./zotero.ts";
import { indexedKeys } from "./zoterolive.ts";
import type { PaperMetadata } from "./bm25.ts";

export interface SearchModalItem {
  hit?: Hit;
  paperIndex?: number;
  /** A paper Zotero has and the index doesn't list yet (zoterolive.ts); no paperIndex. */
  livePaper?: PaperMetadata;
  isLoadingRow?: boolean;
}

export class PaperSearchModal extends SuggestModal<SearchModalItem> {
  plugin: PaperSearchPlugin;
  /** The semantic merge and the Zotero lookup for the query on screen; a new query or closing drops them. */
  jobs = new QueryJobs();
  currentItems: SearchModalItem[] = [];
  /** Rows from Zotero for the query on screen, kept below the index's own hits. */
  liveItems: SearchModalItem[] = [];
  footerEl: HTMLElement | null = null;
  lastKeywordHits: Hit[] = [];
  /** The query on screen (as `semanticText`) and the index it was ranked on. */
  shownKey: string | null = null;
  shownIndex: LoadedIndex | null = null;

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

    // Warm up the query model (Ollama's, or the pplx service's)
    const ix = this.plugin.indexStore.getIndex();
    if (ix?.manifest?.model) {
      warmSemantic(requestUrl, ix, this.plugin.settings.ollamaUrl, DEFAULT_KEEP_ALIVE);
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
      const paper = item && this.paperOf(item);
      if (paper) {
        this.insertCitationAndEnsureNote(paper);
        this.close();
      }
      return false;
    });

    this.scope.register(["Alt"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      const paper = item && this.paperOf(item);
      if (paper) {
        this.openLiteratureNote(paper);
        this.close();
      }
      return false;
    });

    this.scope.register(["Shift"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      const paper = item && this.paperOf(item);
      if (paper) {
        this.selectInZotero(paper);
        this.close();
      }
      return false;
    });
  }

  onClose() {
    super.onClose();
    this.jobs.cancel();
  }

  paperOf(item: SearchModalItem): PaperMetadata | null {
    if (item.isLoadingRow) return null;
    if (item.livePaper) return item.livePaper;
    if (item.paperIndex === undefined) return null;
    return this.plugin.indexStore.getIndex()?.papers[item.paperIndex] ?? null;
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

    // Typing or deleting whitespace cannot change the results: keep the list on screen (and any semantic merge on its
    // way) instead of flashing back to keyword-only results until the merge lands again.
    const key = semanticText(query);
    if (key === this.shownKey && ix === this.shownIndex) return this.currentItems;
    this.shownKey = key;
    this.shownIndex = ix;
    // Every new query supersedes the last one's jobs, even if it is too short to schedule a semantic merge itself.
    const token = this.jobs.restart();

    // 1. Instant keyword search
    const kHits = keyword(ix, query, this.plugin.settings.limit);
    this.lastKeywordHits = kHits;

    const items: SearchModalItem[] = kHits.map((h) => ({
      hit: h,
      paperIndex: h.paper,
    }));
    this.currentItems = items;

    // 2. Schedule debounced semantic search, and a lookup in Zotero for papers saved since the last build
    this.scheduleSemanticSearch(query, ix, token);
    this.scheduleLive(query, ix, token);

    return items;
  }

  scheduleLive(query: string, ix: LoadedIndex, token: number) {
    this.liveItems = [];
    this.jobs.after(this.plugin.settings.debounceMs, async () => {
      const found = await this.plugin.zotero.search(query, indexedKeys(ix));
      if (!this.jobs.isCurrent(token) || found.length === 0) return;
      this.liveItems = found.map((livePaper) => ({ livePaper }));
      const items = [...this.currentItems.filter((it) => !it.livePaper), ...this.liveItems];
      const selected = (this as any).chooser?.selectedItem ?? 0;
      this.currentItems = items;
      (this as any).chooser?.setSuggestions(items);
      (this as any).chooser?.setSelectedItem(selected);
    });
  }

  scheduleSemanticSearch(query: string, ix: LoadedIndex, token: number) {
    if (!shouldRunSemantic(query, this.plugin.settings.minCharsSemantic) || !ix.vectors) {
      return;
    }
    this.jobs.after(this.plugin.settings.debounceMs, () => this.runSemantic(query, ix, token));
  }

  async runSemantic(query: string, ix: LoadedIndex, token: number) {
    if (!ix.vectors) return;

    try {
      const scores = await this.plugin.semanticScoresFor(ix, semanticText(query), ix.manifest.query_instruction);

      if (!this.jobs.isCurrent(token)) {
        return; // Stale response dropped
      }

      this.updateFooter("");

      // Semantic search + Hybrid merge
      // Merge over the full ranked lists, not the 12 shown while typing.
      const mergedHits = hybridSearchFromScores(ix, query, scores, this.plugin.settings.limit);

      const newItems: SearchModalItem[] = [
        ...mergedHits.map((h) => ({ hit: h, paperIndex: h.paper })),
        ...this.liveItems,
      ];

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
      if (!this.jobs.isCurrent(token)) return;
      this.updateFooter(`semantic off: ${embedderName(ix)} not reachable`);
    }
  }

  renderSuggestion(item: SearchModalItem, el: HTMLElement) {
    el.empty();

    if (item.isLoadingRow) {
      el.createDiv({ text: "Loading paper index…", cls: "paper-search-loading" });
      return;
    }

    const paper = this.paperOf(item);
    if (!paper) return;
    const hit = item.hit;

    const row = el.createDiv({ cls: "paper-search-item" });
    const titleEl = row.createDiv({ cls: "paper-title", text: paper.title });
    titleEl.style.fontWeight = "bold";

    const metaParts = [];
    if (paper.authors && paper.authors.length > 0) metaParts.push(paper.authors.join(", "));
    if (paper.year) metaParts.push(String(paper.year));
    if (paper.journal) metaParts.push(paper.journal);
    if (item.livePaper) metaParts.push("new in Zotero");

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
    const paper = this.paperOf(item);
    if (!paper) return;
    const hit = item.hit;

    // Enter: open the matching PDF at its page, or the matching web snapshot, in Zotero
    window.open(hitUrl(paper, hit));
  }

  async insertCitationAndEnsureNote(paper: PaperMetadata) {
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

  async openLiteratureNote(paper: PaperMetadata) {
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

  selectInZotero(paper: PaperMetadata) {
    if (paper.key) {
      window.open(selectItemUrl(paper.key));
    }
  }
}
