import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { formatCitation, DEFAULT_CITATION_FORMAT } from "./cite.ts";
import { DEFAULT_RELATED_MIN_SCORE } from "./related.ts";

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
  askZotero: boolean;
}

export const DEFAULT_SETTINGS: PaperSearchSettings = {
  ollamaUrl: "http://127.0.0.1:11434",
  debounceMs: 200,
  minCharsSemantic: 12,
  limit: 12,
  citationFormat: DEFAULT_CITATION_FORMAT,
  createLiteratureNotes: true,
  literatureNoteFolder: "",
  literatureNoteTemplate: "Zotero Template.md",
  inlineTrigger: "@@",
  inlineLimit: 8,
  inlineShowSnippet: true,
  relatedLimit: 5,
  relatedMinScore: DEFAULT_RELATED_MIN_SCORE,
  relatedAutoRefresh: false,
  relatedInstruction:
    "Given a passage from my research notes, retrieve papers that report the findings or methods it discusses",
  askZotero: true,
};

/** The plugin as the settings tab sees it. */
export interface SettingsHost extends Plugin {
  settings: PaperSearchSettings;
  saveSettings(): Promise<void>;
}

/** Settings keys whose values are of type V. */
type KeysOf<V> = { [K in keyof PaperSearchSettings]: PaperSearchSettings[K] extends V ? K : never }[keyof PaperSearchSettings];

export class PaperSearchSettingTab extends PluginSettingTab {
  plugin: SettingsHost;

  constructor(app: App, plugin: SettingsHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Search Settings" });
    const s = this.plugin.settings;

    this.addText("Ollama URL", "Address of the local Ollama server for embedding search queries", "ollamaUrl", {
      placeholder: DEFAULT_SETTINGS.ollamaUrl,
      parse: (v) => v.trim() || DEFAULT_SETTINGS.ollamaUrl,
    });
    this.addText("Citation Format", "Format used when inserting citations (must include {{citekey}})", "citationFormat", {
      placeholder: DEFAULT_CITATION_FORMAT,
      parse: (v) => {
        const trimmed = v.trim();
        try {
          formatCitation(trimmed, "test");
          return trimmed;
        } catch {
          new Notice("Citation format must include {{citekey}}");
          return null;
        }
      },
    });
    this.addToggle("Create Literature Notes", "Automatically create literature notes when citing papers", "createLiteratureNotes");
    this.addText(
      "Literature Note Folder",
      "Folder inside vault where new literature notes will be created (leave empty for vault root)",
      "literatureNoteFolder",
      { placeholder: "vault root", parse: (v) => v.trim() }
    );
    this.addText("Literature Note Template", "Vault path to Markdown template file (e.g. Zotero Template.md)", "literatureNoteTemplate", {
      placeholder: DEFAULT_SETTINGS.literatureNoteTemplate,
      parse: (v) => v.trim() || DEFAULT_SETTINGS.literatureNoteTemplate,
    });
    this.addText("Inline Suggestion Trigger", "Trigger characters to invoke paper citation search while typing", "inlineTrigger", {
      placeholder: DEFAULT_SETTINGS.inlineTrigger,
      parse: (v) => v.trim() || DEFAULT_SETTINGS.inlineTrigger,
    });
    this.addIntSetting("Inline Suggestion Limit", "Maximum number of suggestions shown while typing (default 8)", "inlineLimit");
    this.addToggle(
      "Ask Zotero for new papers",
      "Lists papers saved in Zotero since the index was last built, so they can be cited at once. Needs Zotero's " +
        "Settings → Advanced → \"Allow other applications on this computer to communicate with Zotero\".",
      "askZotero"
    );
    this.addToggle("Inline Show Snippets", "Show matched snippet text below each paper in the inline suggestion list", "inlineShowSnippet");
    this.addIntSetting("Related Papers Limit", "Maximum number of related papers shown in the right sidebar (default 5)", "relatedLimit");
    this.addNumber(
      "Related Minimum Score",
      "Minimum cosine similarity threshold to display related papers (default 0.50)",
      "relatedMinScore",
      DEFAULT_RELATED_MIN_SCORE.toFixed(2),
      String(s.relatedMinScore ?? DEFAULT_RELATED_MIN_SCORE),
      (v) => {
        const parsed = parseFloat(v.trim());
        return !isNaN(parsed) && parsed >= 0 ? parsed : null;
      }
    );
    this.addToggle("Related Auto-Refresh", "Automatically refresh related papers 1s after switching active note", "relatedAutoRefresh");
    this.addText("Related Retrieval Instruction", "Embedding instruction prefix used to query related papers", "relatedInstruction", {
      placeholder: DEFAULT_SETTINGS.relatedInstruction,
      parse: (v) => v.trim() || DEFAULT_SETTINGS.relatedInstruction,
      area: true,
    });
  }

  private async save<K extends keyof PaperSearchSettings>(key: K, value: PaperSearchSettings[K]): Promise<void> {
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
  }

  private addToggle(name: string, desc: string, key: KeysOf<boolean>): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) => toggle.setValue(this.plugin.settings[key]).onChange((value) => this.save(key, value)));
  }

  /** A text (or text area) setting; `parse` returns null to keep the stored value. */
  private addText(
    name: string,
    desc: string,
    key: KeysOf<string>,
    opts: { placeholder: string; parse: (value: string) => string | null; area?: boolean }
  ): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    const wire = (text: { setPlaceholder(p: string): unknown; setValue(v: string): unknown; onChange(cb: (v: string) => unknown): unknown }) => {
      text.setPlaceholder(opts.placeholder);
      text.setValue(this.plugin.settings[key]);
      text.onChange(async (value: string) => {
        const parsed = opts.parse(value);
        if (parsed !== null) await this.save(key, parsed);
      });
    };
    if (opts.area) setting.addTextArea(wire);
    else setting.addText(wire);
  }

  /** A number typed into a text field; `parse` returns null to keep the stored value. */
  private addNumber(
    name: string,
    desc: string,
    key: KeysOf<number>,
    placeholder: string,
    shown: string,
    parse: (value: string) => number | null
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .setValue(shown)
          .onChange(async (value) => {
            const parsed = parse(value);
            if (parsed !== null) await this.save(key, parsed);
          })
      );
  }

  /** A positive whole number; anything else typed keeps the stored value. Unset shows the default. */
  private addIntSetting(name: string, desc: string, key: KeysOf<number>): void {
    const fallback = DEFAULT_SETTINGS[key];
    this.addNumber(name, desc, key, String(fallback), String(this.plugin.settings[key] || fallback), (v) => {
      const parsed = parseInt(v.trim(), 10);
      return !isNaN(parsed) && parsed > 0 ? parsed : null;
    });
  }
}
