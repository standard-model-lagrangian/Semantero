import {
  App,
  MarkdownView,
  Notice,
  SuggestModal,
  requestUrl,
} from "obsidian";
import type PaperSearchPlugin from "./main.ts";
import { DEFAULT_KEEP_ALIVE } from "./ollama.ts";
import { DEFAULT_QUERY_INSTRUCTION, warmSemantic } from "./semantic.ts";
import { formatCitation } from "./cite.ts";
import { hitUrl, selectItemUrl } from "./zotero.ts";
import type { PaperMetadata } from "./bm25.ts";
import { ModalSearchController, chooserView, type ChooserLike, type ModalSearchItem } from "./modalsearch.ts";

export type SearchModalItem = ModalSearchItem;

/** The search modal's view: rendering, keys and actions. What to show when lives in ModalSearchController. */
export class PaperSearchModal extends SuggestModal<SearchModalItem> {
  plugin: PaperSearchPlugin;
  controller: ModalSearchController;
  footerEl: HTMLElement | null = null;

  constructor(app: App, plugin: PaperSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.controller = new ModalSearchController({
      indexStore: plugin.indexStore,
      semanticScores: (ix, text, instruction) => plugin.semanticScoresFor(ix, text, instruction || DEFAULT_QUERY_INSTRUCTION),
      zotero: plugin.zotero,
      settings: plugin.settings,
      view: chooserView(() => this.chooser(), (msg) => this.footerEl?.setText(msg)),
      vault: app.vault,
      metadataCache: app.metadataCache,
      showNotice: (m) => new Notice(m),
      sessionNotices: plugin.litNoteNotices,
    });
    this.setPlaceholder("Search papers by what they found, title, author, or citekey...");
    this.setInstructions([
      { command: "↵", purpose: "open in Zotero" },
      { command: "⌘↵", purpose: "insert citation & create note" },
      { command: "⌥↵", purpose: "open/create literature note" },
      { command: "⇧↵", purpose: "select in Zotero" },
    ]);
  }

  /** Obsidian's internal suggestion list (not in its typings); every use goes through chooserView's fallbacks. */
  private chooser(): ChooserLike | undefined {
    return (this as unknown as { chooser?: ChooserLike }).chooser;
  }

  onOpen() {
    super.onOpen();

    // Background ensureFresh check
    this.plugin.indexStore.ensureFresh().catch(() => {});

    // Warm up the query model (Ollama's, or the pplx service's)
    const ix = this.plugin.indexStore.getIndex();
    if (ix?.manifest?.model) {
      warmSemantic(requestUrl, ix, this.plugin.settings.ollamaUrl, DEFAULT_KEEP_ALIVE);
    }

    // Add status footer
    this.footerEl = this.modalEl.createDiv({ cls: "paper-search-footer" });
    this.footerEl.style.fontSize = "0.8em";
    this.footerEl.style.color = "var(--text-muted)";
    this.footerEl.style.padding = "4px 8px";

    // Setup keyboard modifiers
    this.onKey(["Mod"], (paper) => this.insertCitationAndEnsureNote(paper));
    this.onKey(["Alt"], (paper) => this.openLiteratureNote(paper));
    this.onKey(["Shift"], (paper) => this.selectInZotero(paper));
  }

  /** modifiers+Enter runs `action` on the selected paper and closes the modal. */
  private onKey(modifiers: ("Mod" | "Alt" | "Shift")[], action: (paper: PaperMetadata) => unknown) {
    this.scope.register(modifiers, "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.controller.selectedItem();
      const paper = item && this.controller.paperOf(item);
      if (paper) {
        action(paper);
        this.close();
      }
      return false;
    });
  }

  onClose() {
    super.onClose();
    this.controller.close();
  }

  getSuggestions(query: string): SearchModalItem[] {
    return this.controller.getSuggestions(query);
  }

  renderSuggestion(item: SearchModalItem, el: HTMLElement) {
    el.empty();

    if (item.isLoadingRow) {
      el.createDiv({ text: "Loading paper index…", cls: "paper-search-loading" });
      return;
    }

    const paper = this.controller.paperOf(item);
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
    const paper = this.controller.paperOf(item);
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

    await this.controller.ensureNote(paper);
  }

  async openLiteratureNote(paper: PaperMetadata) {
    const res = await this.controller.ensureNote(paper);

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
