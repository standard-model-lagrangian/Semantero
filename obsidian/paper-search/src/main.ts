import {
  App,
  EditorSuggest,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import { IndexStore } from "./indexstore.ts";
import { PaperSearchModal } from "./modal.ts";
import { checkHotkeyConflict } from "./hotkey.ts";
import { formatCitation } from "./litnote.ts";
import { embedQuery } from "./ollama.ts";
import { createPaperSearchSuggestClass, InlineSuggestController } from "./inline.ts";

export interface PaperSearchSettings {
  ollamaUrl: string;
  debounceMs: number;
  minCharsSemantic: number;
  limit: number;
  citationFormat: string;
  createLiteratureNotes: boolean;
  literatureNoteFolder: string;
  literatureNoteTemplate: string;
  inlineTrigger: string;
  inlineLimit: number;
  inlineShowSnippet: boolean;
  relatedLimit: number;
  relatedMinScore: number;
  relatedAutoRefresh: boolean;
  relatedInstruction: string;
}

export const DEFAULT_SETTINGS: PaperSearchSettings = {
  ollamaUrl: "http://127.0.0.1:11434",
  debounceMs: 200,
  minCharsSemantic: 12,
  limit: 12,
  citationFormat: "[[{{citekey}}]]",
  createLiteratureNotes: true,
  literatureNoteFolder: "",
  literatureNoteTemplate: "Zotero Template.md",
  inlineTrigger: "@@",
  inlineLimit: 8,
  inlineShowSnippet: true,
  relatedLimit: 5,
  relatedMinScore: 0.25,
  relatedAutoRefresh: false,
  relatedInstruction:
    "Given a passage from my research notes, retrieve papers that report the findings or methods it discusses",
};

export default class PaperSearchPlugin extends Plugin {
  settings: PaperSearchSettings = DEFAULT_SETTINGS;
  indexStore!: IndexStore;

  async onload() {
    await this.loadSettings();

    // Set up IndexStore with Obsidian vault adapter
    const adapter = {
      read: (p: string) => this.app.vault.adapter.read(p),
      readBinary: (p: string) => this.app.vault.adapter.readBinary(p),
      exists: (p: string) => this.app.vault.adapter.exists(p),
      showNotice: (m: string) => new Notice(m),
    };
    this.indexStore = new IndexStore(adapter, ".planner/search");

    // 0.4: Load off startup path. onload() returns quickly without awaiting index load.
    this.app.workspace.onLayoutReady(() => {
      this.indexStore.load().catch((err) => {
        console.error("Failed to load paper search index:", err);
      });

      // Check hotkey conflict on load (1a)
      this.checkHotkeyConflicts();
    });

    // 1a: Register command with NO default hotkeys field
    this.addCommand({
      id: "open-paper-search",
      name: "Search papers (keyword + semantic)",
      callback: () => {
        new PaperSearchModal(this.app, this).open();
      },
    });

    // 2. Register inline citation suggest (@@)
    const embedder = {
      embedQuery: async (queryText: string) => {
        const ix = this.indexStore.getIndex();
        if (!ix) return null;
        return embedQuery(requestUrl, {
          url: this.settings.ollamaUrl,
          model: ix.manifest?.model || "qwen3-embedding:0.6b",
          instruction: ix.manifest?.query_instruction || "Given a query, retrieve relevant research papers",
          query: queryText,
          dims: ix.dims,
        });
      },
    };

    const suggestController = new InlineSuggestController({
      indexStore: this.indexStore,
      embedder,
      vault: this.app.vault,
      metadataCache: this.app.metadataCache,
      settings: this.settings,
      showNotice: (msg: string) => new Notice(msg),
    });

    const PaperSearchSuggest = createPaperSearchSuggestClass(EditorSuggest);
    this.registerEditorSuggest(new PaperSearchSuggest(this.app, suggestController));

    this.addSettingTab(new PaperSearchSettingTab(this.app, this));
  }

  checkHotkeyConflicts() {
    try {
      const customKeys = (this.app as any).hotkeyManager?.customKeys || {};
      const conflict = checkHotkeyConflict(customKeys, ["Mod", "Shift"], "0");
      if (conflict) {
        new Notice(
          `Paper search hotkey (Mod+Shift+0) conflicts with command: ${conflict}`
        );
      }
    } catch {
      // Hotkey manager check failed gracefully
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      .setDesc("Address of the local Ollama server for embedding search queries")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.plugin.settings.ollamaUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaUrl = value.trim() || DEFAULT_SETTINGS.ollamaUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Citation Format")
      .setDesc("Format used when inserting citations (must include {{citekey}})")
      .addText((text) =>
        text
          .setPlaceholder("[[{{citekey}}]]")
          .setValue(this.plugin.settings.citationFormat)
          .onChange(async (value) => {
            const trimmed = value.trim();
            try {
              formatCitation(trimmed, "test");
              this.plugin.settings.citationFormat = trimmed;
              await this.plugin.saveSettings();
            } catch {
              new Notice("Citation format must include {{citekey}}");
            }
          })
      );

    new Setting(containerEl)
      .setName("Create Literature Notes")
      .setDesc("Automatically create literature notes when citing papers")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createLiteratureNotes)
          .onChange(async (value) => {
            this.plugin.settings.createLiteratureNotes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Literature Note Folder")
      .setDesc("Folder inside vault where new literature notes will be created (leave empty for vault root)")
      .addText((text) =>
        text
          .setPlaceholder("vault root")
          .setValue(this.plugin.settings.literatureNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.literatureNoteFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Literature Note Template")
      .setDesc("Vault path to Markdown template file (e.g. Zotero Template.md)")
      .addText((text) =>
        text
          .setPlaceholder("Zotero Template.md")
          .setValue(this.plugin.settings.literatureNoteTemplate)
          .onChange(async (value) => {
            this.plugin.settings.literatureNoteTemplate = value.trim() || "Zotero Template.md";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Inline Suggestion Trigger")
      .setDesc("Trigger characters to invoke paper citation search while typing")
      .addText((text) =>
        text
          .setPlaceholder("@@")
          .setValue(this.plugin.settings.inlineTrigger)
          .onChange(async (value) => {
            this.plugin.settings.inlineTrigger = value.trim() || "@@";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Inline Suggestion Limit")
      .setDesc("Maximum number of suggestions shown while typing (default 8)")
      .addText((text) =>
        text
          .setPlaceholder("8")
          .setValue(String(this.plugin.settings.inlineLimit || 8))
          .onChange(async (value) => {
            const parsed = parseInt(value.trim(), 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.inlineLimit = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Inline Show Snippets")
      .setDesc("Show matched snippet text below each paper in the inline suggestion list")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.inlineShowSnippet)
          .onChange(async (value) => {
            this.plugin.settings.inlineShowSnippet = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
