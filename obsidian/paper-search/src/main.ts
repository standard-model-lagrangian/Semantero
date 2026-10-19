import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  requestUrl,
} from "obsidian";
import { BM25Index, type PaperMetadata, type ChunkDocument } from "./bm25.ts";
import { loadVectors, topK } from "./vectors.ts";
import {
  mergeRRF,
  scorePaperSemantic,
  shouldRunSemantic,
  maintainSelection,
  SemanticCoordinator,
  type PaperRowRef,
  type ScoredPaper,
} from "./rank.ts";
import { embedQuery, warmUp } from "./ollama.ts";
import { bestSnippet, tokenize } from "./text.ts";

interface PaperSearchSettings {
  ollamaUrl: string;
  debounceMs: number;
  minCharsSemantic: number;
  limit: number;
  hotkeyHint: string;
}

const DEFAULT_SETTINGS: PaperSearchSettings = {
  ollamaUrl: "http://127.0.0.1:11434",
  debounceMs: 200,
  minCharsSemantic: 12,
  limit: 12,
  hotkeyHint: "Cmd+Shift+F",
};

interface PaperIndexData {
  manifest: any;
  papers: (PaperMetadata & { key: string; pdfs: any[]; abstractRow: number | null })[];
  chunks: (ChunkDocument & { row: number })[];
  vectors: Float32Array | null;
  paperRowRefs: PaperRowRef[];
}

export interface SearchResultItem {
  paperIndex: number;
  paper: PaperMetadata & { key: string; pdfs: any[]; abstractRow: number | null };
  score: number;
  snippetText: string;
  snippetPage?: number;
  isAbstract?: boolean;
  winningAttachmentKey?: string;
}

export default class PaperSearchPlugin extends Plugin {
  settings: PaperSearchSettings = DEFAULT_SETTINGS;
  indexData: PaperIndexData | null = null;
  bm25: BM25Index | null = null;
  lastBuiltAt: string = "";

  async onload() {
    await this.loadSettings();

    await this.loadIndex();

    this.addCommand({
      id: "open-paper-search",
      name: "Search papers (keyword + semantic)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "F" }],
      callback: () => {
        new PaperSearchModal(this.app, this).open();
      },
    });

    this.addSettingTab(new PaperSearchSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadIndex(force: boolean = false): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const manifestPath = ".planner/search/manifest.json";
    const papersPath = ".planner/search/papers.json";
    const chunksPath = ".planner/search/chunks.json";
    const vectorsPath = ".planner/search/vectors.f32";

    if (!(await adapter.exists(manifestPath))) {
      return false;
    }

    try {
      const manifestStr = await adapter.read(manifestPath);
      const manifest = JSON.parse(manifestStr);

      if (!force && this.indexData && manifest.built_at === this.lastBuiltAt) {
        return true; // Already fresh
      }

      const papersStr = await adapter.read(papersPath);
      const papers = JSON.parse(papersStr);

      const chunksStr = await adapter.read(chunksPath);
      const chunks = JSON.parse(chunksStr);

      let vectors: Float32Array | null = null;
      if (await adapter.exists(vectorsPath)) {
        const vecBuf = await adapter.readBinary(vectorsPath);
        const dims = manifest.dims;
        const rowRefs = new Set<number>();
        for (const p of papers) {
          if (p.abstractRow !== null && p.abstractRow !== undefined) {
            rowRefs.add(p.abstractRow);
          }
        }
        for (const c of chunks) {
          if (c.row !== null && c.row !== undefined) {
            rowRefs.add(c.row);
          }
        }
        const expectedRows = rowRefs.size;
        let rowsValid = true;
        for (const r of rowRefs) {
          if (r < 0 || r >= expectedRows) {
            rowsValid = false;
            break;
          }
        }
        if (!rowsValid) {
          new Notice("Paper search index error: row references are out of range.");
        } else {
          try {
            vectors = loadVectors(vecBuf, expectedRows, dims);
          } catch (e: any) {
            new Notice(`Paper search index vector mismatch: ${e.message}`);
          }
        }
      }

      this.bm25 = new BM25Index(papers, chunks);

      const paperRowRefs: PaperRowRef[] = [];
      for (let pIdx = 0; pIdx < papers.length; pIdx++) {
        const p = papers[pIdx];
        const chunkRows: number[] = [];
        for (const c of chunks) {
          if (c.paper === pIdx && c.row !== undefined) {
            chunkRows.push(c.row);
          }
        }
        paperRowRefs.push({
          abstractRow: p.abstractRow,
          chunkRows,
        });
      }

      this.indexData = {
        manifest,
        papers,
        chunks,
        vectors,
        paperRowRefs,
      };
      this.lastBuiltAt = manifest.built_at || "";
      return true;
    } catch (err: any) {
      new Notice(`Failed to load paper search index: ${err.message}`);
      return false;
    }
  }
}

class PaperSearchModal extends SuggestModal<SearchResultItem> {
  plugin: PaperSearchPlugin;
  coordinator: SemanticCoordinator = new SemanticCoordinator();
  currentItems: SearchResultItem[] = [];
  debounceTimer: any = null;
  semanticAvailable: boolean = true;
  footerEl: HTMLElement | null = null;
  selectedPaperIdx: number | null = null;

  constructor(app: App, plugin: PaperSearchPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Search papers by what they found, title, author, or citekey...");
    this.setInstructions([
      { command: "↵", purpose: "open PDF at page" },
      { command: "⌘↵", purpose: "insert [[citekey]]" },
      { command: "⌥↵", purpose: "literature note / Zotero item" },
    ]);
  }

  async onOpen() {
    super.onOpen();

    // Reload index if built_at changed
    await this.plugin.loadIndex(false);

    // Warm up Ollama
    if (this.plugin.indexData?.manifest?.model) {
      warmUp(requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model: this.plugin.indexData.manifest.model,
        keepAlive: "30m",
      });
    }

    // Add status footer
    const modalEl = this.modalEl;
    this.footerEl = modalEl.createDiv({ cls: "paper-search-footer" });
    this.footerEl.style.fontSize = "0.8em";
    this.footerEl.style.color = "var(--text-muted)";
    this.footerEl.style.padding = "4px 8px";

    // Setup keyboard modifiers for Cmd+Enter and Alt+Enter
    this.scope.register(["Mod"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item) {
        this.insertCitekey(item);
        this.close();
      }
      return false;
    });

    this.scope.register(["Alt"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      const item = this.getSelectedItem();
      if (item) {
        this.openLiteratureNoteOrZotero(item);
        this.close();
      }
      return false;
    });
  }

  getSelectedItem(): SearchResultItem | null {
    // Look up selected item index from chooser or active element
    return (this as any).chooser?.values?.[(this as any).chooser?.selectedItem] || null;
  }

  getSuggestions(query: string): SearchResultItem[] {
    if (!this.plugin.indexData || !this.plugin.bm25) {
      return [];
    }

    // 1. Instant Keyword search on every keystroke
    const keywordRes = this.plugin.bm25.search(query);
    const keywordList = keywordRes.map((r) => r.paperIndex);

    // Initial items based on keyword alone
    const queryTokens = tokenize(query).tokens;
    const items: SearchResultItem[] = [];

    for (const pIdx of keywordList.slice(0, this.plugin.settings.limit)) {
      const paper = this.plugin.indexData.papers[pIdx];
      const match = keywordRes.find((k) => k.paperIndex === pIdx);
      let snippet = "";
      let page: number | undefined;
      let isAbstract = true;
      let attKey: string | undefined;

      const chunkWon = (match?.bestChunkScore || 0) > (match?.metadataScore || 0) && match?.bestChunkIndex !== undefined;
      if (chunkWon) {
        const c = this.plugin.indexData.chunks[match.bestChunkIndex!];
        snippet = bestSnippet(c.text, queryTokens).text;
        page = c.page;
        isAbstract = false;
        attKey = c.attachmentKey;
      } else if (paper.abstract) {
        snippet = bestSnippet(paper.abstract, queryTokens).text;
        isAbstract = true;
      } else {
        snippet = bestSnippet(paper.title, queryTokens).text;
        isAbstract = true;
      }

      items.push({
        paperIndex: pIdx,
        paper,
        score: match?.score || 0,
        snippetText: snippet,
        snippetPage: page,
        isAbstract,
        winningAttachmentKey: attKey || paper.pdfs[0]?.attachmentKey,
      });
    }

    this.currentItems = items;

    // Trigger debounced semantic search if eligible
    this.scheduleSemanticSearch(query, keywordList);

    return items;
  }

  scheduleSemanticSearch(query: string, keywordList: number[]) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (!shouldRunSemantic(query, this.plugin.settings.minCharsSemantic) || !this.plugin.indexData?.vectors) {
      return;
    }

    const { seq } = this.coordinator.newRequest();

    this.debounceTimer = setTimeout(async () => {
      await this.runSemantic(query, keywordList, seq);
    }, this.plugin.settings.debounceMs);
  }

  async runSemantic(query: string, keywordList: number[], seq: number) {
    if (!this.plugin.indexData?.vectors) return;

    const manifest = this.plugin.indexData.manifest;
    const model = manifest.model;
    const dims = manifest.dims;
    const instruction = manifest.query_instruction;

    try {
      const queryVec = await embedQuery(requestUrl, {
        url: this.plugin.settings.ollamaUrl,
        model,
        instruction,
        query,
        dims,
      });

      if (!this.coordinator.isCurrent(seq)) {
        return; // Stale response dropped
      }

      this.semanticAvailable = true;
      this.updateFooter("");

      // Top-K vectors dot product
      const totalRows = Math.floor(this.plugin.indexData.vectors.length / dims);
      const matches = topK(queryVec, this.plugin.indexData.vectors, totalRows, dims, 100);
      const rowScores = new Map<number, number>();
      for (const m of matches) {
        rowScores.set(m.row, m.score);
      }

      // Paper semantic scores
      const semanticList: { paperIndex: number; score: number; winningRow?: number; isAbstract?: boolean }[] = [];
      for (let pIdx = 0; pIdx < this.plugin.indexData.papers.length; pIdx++) {
        const ref = this.plugin.indexData.paperRowRefs[pIdx];
        const scored = scorePaperSemantic(ref, rowScores);
        if (scored.score > 0) {
          semanticList.push({
            paperIndex: pIdx,
            score: scored.score,
            winningRow: scored.winningRow ?? undefined,
            isAbstract: scored.isAbstract,
          });
        }
      }
      semanticList.sort((a, b) => b.score - a.score);

      // Reciprocal Rank Fusion
      const merged = mergeRRF([
        keywordList,
        semanticList.map((s) => s.paperIndex),
      ]);

      // Build updated list
      const queryTokens = tokenize(query).tokens;
      const newItems: SearchResultItem[] = [];
      const keywordRes = this.plugin.bm25?.search(query) || [];

      for (const m of merged.slice(0, this.plugin.settings.limit)) {
        const paper = this.plugin.indexData.papers[m.paperIndex];
        const semInfo = semanticList.find((s) => s.paperIndex === m.paperIndex);

        let snippet = "";
        let page: number | undefined;
        let isAbstract = true;
        let attKey: string | undefined;

        if (semInfo) {
          if (!semInfo.isAbstract && semInfo.winningRow !== undefined) {
            const c = this.plugin.indexData.chunks.find((ch) => ch.row === semInfo.winningRow);
            if (c) {
              snippet = bestSnippet(c.text, queryTokens).text;
              page = c.page;
              attKey = c.attachmentKey;
              isAbstract = false;
            }
          } else if (paper.abstract) {
            snippet = bestSnippet(paper.abstract, queryTokens).text;
            isAbstract = true;
          } else {
            snippet = bestSnippet(paper.title, queryTokens).text;
            isAbstract = true;
          }
        } else {
          const kMatch = keywordRes.find((k) => k.paperIndex === m.paperIndex);
          const chunkWon = (kMatch?.bestChunkScore || 0) > (kMatch?.metadataScore || 0) && kMatch?.bestChunkIndex !== undefined;
          if (chunkWon) {
            const c = this.plugin.indexData.chunks[kMatch.bestChunkIndex!];
            snippet = bestSnippet(c.text, queryTokens).text;
            page = c.page;
            isAbstract = false;
            attKey = c.attachmentKey;
          } else if (paper.abstract) {
            snippet = bestSnippet(paper.abstract, queryTokens).text;
            isAbstract = true;
          } else {
            snippet = bestSnippet(paper.title, queryTokens).text;
            isAbstract = true;
          }
        }

        newItems.push({
          paperIndex: m.paperIndex,
          paper,
          score: m.score,
          snippetText: snippet,
          snippetPage: page,
          isAbstract,
          winningAttachmentKey: attKey || paper.pdfs[0]?.attachmentKey,
        });
      }

      // Maintain selection
      const currentItem = this.getSelectedItem();
      const prevPaperIdx = currentItem ? currentItem.paperIndex : null;
      this.currentItems = newItems;

      // Re-render suggestions without losing selection
      const newSel = maintainSelection(prevPaperIdx, newItems, this.plugin.settings.limit);
      (this as any).chooser?.setSuggestions(newItems);
      (this as any).chooser?.setSelectedItem(newSel);
    } catch {
      this.semanticAvailable = false;
      this.updateFooter("semantic off: Ollama not reachable");
    }
  }

  updateFooter(msg: string) {
    if (this.footerEl) {
      this.footerEl.setText(msg);
      this.footerEl.style.display = msg ? "block" : "none";
    }
  }

  renderSuggestion(item: SearchResultItem, el: HTMLElement) {
    el.empty();
    el.addClass("paper-search-item");

    const header = el.createDiv({ cls: "paper-search-header" });
    header.createSpan({ text: item.paper.title, cls: "paper-search-title" });

    const meta = el.createDiv({ cls: "paper-search-meta" });
    const authorStr = item.paper.authors.length > 0 ? `${item.paper.authors[0]} et al.` : "";
    const yearStr = item.paper.year ? `${item.paper.year}` : "";
    const journalStr = item.paper.journal || "";
    const metaParts = [authorStr, yearStr, journalStr].filter(Boolean).join(" · ");

    meta.createSpan({ text: metaParts, cls: "paper-search-author-journal" });

    const rightBadge = item.isAbstract ? "abstract" : item.snippetPage ? `p. ${item.snippetPage}` : "";
    if (rightBadge) {
      const badge = meta.createSpan({ text: rightBadge, cls: "paper-search-page-badge" });
      badge.style.float = "right";
    }

    if (item.snippetText) {
      const snip = el.createDiv({ cls: "paper-search-snippet" });
      snip.createSpan({ text: `"${item.snippetText}"` });
      snip.style.fontSize = "0.9em";
      snip.style.color = "var(--text-muted)";
      snip.style.marginTop = "2px";
    }
  }

  onChooseSuggestion(item: SearchResultItem, evt: MouseEvent | KeyboardEvent) {
    // Default action: Enter opens PDF in Zotero at page
    this.openPdfInZotero(item);
  }

  openPdfInZotero(item: SearchResultItem) {
    const attKey = item.winningAttachmentKey || item.paper.pdfs[0]?.attachmentKey;
    const page = item.snippetPage ?? 1;
    if (attKey) {
      const url = `zotero://open-pdf/library/items/${attKey}?page=${page}`;
      window.open(url);
    } else {
      // Fallback: select item
      window.open(`zotero://select/library/items/${item.paper.key}`);
    }
  }

  insertCitekey(item: SearchResultItem) {
    const citekey = item.paper.citekey;
    if (!citekey) return;
    const textToInsert = `[[${citekey}]]`;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = (this.app.workspace as any).activeEditor?.editor || activeView?.editor;
    if (editor) {
      editor.replaceSelection(textToInsert);
    } else {
      navigator.clipboard.writeText(textToInsert);
      new Notice(`Copied ${textToInsert} to clipboard`);
    }
  }

  async openLiteratureNoteOrZotero(item: SearchResultItem) {
    const citekey = item.paper.citekey;
    if (citekey) {
      const notePath = `${citekey}.md`;
      const file = this.app.metadataCache?.getFirstLinkpathDest(citekey, "") ||
                   this.app.vault.getAbstractFileByPath(notePath);
      if (file) {
        this.app.workspace.openLinkText(file.path, "", false);
        return;
      }
    }
    // Otherwise open in Zotero
    window.open(`zotero://select/library/items/${item.paper.key}`);
  }
}

class PaperSearchSettingTab extends PluginSettingTab {
  plugin: PaperSearchPlugin;

  constructor(app: App, plugin: PaperSearchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Search Settings" });

    new Setting(containerEl)
      .setName("Ollama URL")
      .setDesc("Endpoint for local Ollama server")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.plugin.settings.ollamaUrl)
          .onChange(async (val) => {
            this.plugin.settings.ollamaUrl = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Semantic Search Debounce (ms)")
      .setDesc("Wait time after typing stops before triggering semantic search")
      .addSlider((slider) =>
        slider
          .setLimits(100, 1000, 50)
          .setValue(this.plugin.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.debounceMs = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Minimum Characters for Semantic Search")
      .setDesc("Minimum characters typed before semantic search runs")
      .addSlider((slider) =>
        slider
          .setLimits(4, 30, 1)
          .setValue(this.plugin.settings.minCharsSemantic)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.minCharsSemantic = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Results Limit")
      .setDesc("Maximum number of paper results to show in search modal")
      .addSlider((slider) =>
        slider
          .setLimits(5, 30, 1)
          .setValue(this.plugin.settings.limit)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.limit = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Hotkey Hint")
      .setDesc("Hotkey configured to open the paper search dialog")
      .addText((text) =>
        text
          .setPlaceholder("Cmd+Shift+F")
          .setValue(this.plugin.settings.hotkeyHint)
          .onChange(async (val) => {
            this.plugin.settings.hotkeyHint = val.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
