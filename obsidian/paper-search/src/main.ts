import { EditorSuggest, ItemView, MarkdownView, Notice, Plugin, WorkspaceLeaf, requestUrl } from "obsidian";
import { IndexStore } from "./core/indexstore.ts";
import { PaperSearchModal } from "./modal.ts";
import { checkHotkeyConflict } from "./hotkey.ts";
import { queryInstruction, semanticScores } from "./core/semantic.ts";
import type { LoadedIndex } from "./core/engine.ts";
import { createPaperSearchSuggestClass, InlineSuggestController } from "./inline.ts";
import { createRelatedPapersViewClass, RelatedPapersController } from "./related.ts";
import { ActiveEditorTracker, editorSnapshot } from "./editortracker.ts";
import { ZoteroLive } from "./zoterolive.ts";
import { DEFAULT_SETTINGS, PaperSearchSettingTab, type PaperSearchSettings } from "./settings.ts";

export default class PaperSearchPlugin extends Plugin {
  settings: PaperSearchSettings = DEFAULT_SETTINGS;
  indexStore!: IndexStore;
  /** Once-per-session literature-note notices, shared by the modal, @@ and the panel. */
  litNoteNotices = new Set<string>();
  editorTracker = new ActiveEditorTracker();
  private zoteroLive = new ZoteroLive(requestUrl);
  /** Papers saved since the last index build, straight from Zotero ([] when the setting is off). */
  zotero = {
    search: (q: string, known: Set<string>) =>
      this.settings.askZotero ? this.zoteroLive.search(q, known) : Promise.resolve([]),
  };

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
      rowScores: (queryText: string, ix: LoadedIndex) => this.semanticScoresFor(ix, queryText, queryInstruction(ix)),
    };

    const suggestController = new InlineSuggestController({
      indexStore: this.indexStore,
      embedder,
      zotero: this.zotero,
      vault: this.app.vault,
      metadataCache: this.app.metadataCache,
      settings: this.settings,
      showNotice: (msg: string) => new Notice(msg),
      sessionNotices: this.litNoteNotices,
    });

    const PaperSearchSuggest = createPaperSearchSuggestClass(EditorSuggest);
    this.registerEditorSuggest(new PaperSearchSuggest(this.app, suggestController));

    // 3. Register Related Papers panel
    const relatedEmbedder = {
      rowScores: (text: string, ix: LoadedIndex, instruction?: string) =>
        this.semanticScoresFor(ix, text, instruction ?? this.settings.relatedInstruction),
    };

    const relatedController = new RelatedPapersController({
      indexStore: this.indexStore,
      embedder: relatedEmbedder,
      vault: this.app.vault,
      metadataCache: this.app.metadataCache,
      settings: this.settings,
      showNotice: (msg: string) => new Notice(msg),
      sessionNotices: this.litNoteNotices,
    });

    // The panel needs the last Markdown editor, not the active view (which is the panel itself).
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.editorTracker.onActiveLeafChange(leaf)));
    this.app.workspace.onLayoutReady(() => this.editorTracker.seed(this.app.workspace.getActiveViewOfType(MarkdownView)));

    const RelatedPapersView = createRelatedPapersViewClass(ItemView);
    this.registerView(
      "semantero-related-papers",
      (leaf) => new RelatedPapersView(leaf, relatedController, this.editorTracker)
    );

    // File open listener for auto-refresh
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        relatedController.onFileOpen(
          file ? { path: file.path } : null,
          () => this.editorTracker.get()?.editor?.getValue() || ""
        );
      })
    );

    // Commands
    this.addCommand({
      id: "show-related-papers",
      name: "Show related papers",
      callback: () => {
        this.activateRelatedView();
      },
    });

    this.addCommand({
      id: "find-related-papers",
      name: "Find papers related to this note",
      callback: async () => {
        // Snapshot the editor before the panel takes focus.
        const snap = editorSnapshot(this.editorTracker.get());
        await this.activateRelatedView();
        if (snap) {
          await relatedController.refresh(snap.text, snap.cursorOffset, snap.selection, snap.filePath);
        }
      },
    });

    this.addSettingTab(new PaperSearchSettingTab(this.app, this));
  }

  async activateRelatedView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType("semantero-related-papers");
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: "semantero-related-papers",
          active: true,
        });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
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

  /** Per-row semantic scores of `text` over `ix`, from the backend that built it (semantic.ts). Throws when it is down. */
  async semanticScoresFor(ix: LoadedIndex, text: string, instruction: string): Promise<Float64Array | null> {
    return (await semanticScores(requestUrl, ix, text, { ollamaUrl: this.settings.ollamaUrl, instruction })).scores;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
