/**
 * Literature notes for citations that reach the vault without the plugin inserting them: a `[[citekey]]` pasted into
 * an editor (the launcher's ⌘L pastes one with ⌘V) and the launcher's ⌘O on a paper that has no note yet
 * (`obsidian://semantero-note?vault=…&citekey=…`), and a blank note made by clicking an unresolved `[[citekey]]`.
 * All go through ensureLiteratureNote, like @@ and the modal.
 * No Obsidian imports, so it is tested with the fakes.
 */
import type { PaperMetadata } from "./core/bm25.ts";
import {
  ensureLiteratureNote,
  findLiteratureNote,
  type LitNoteSettings,
  type MetadataCacheLike,
  type VaultLike,
} from "./litnote.ts";

/** The action of the protocol handler: `obsidian://semantero-note?vault=<vault>&citekey=<citekey>`. */
export const OPEN_NOTE_ACTION = "semantero-note";

const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

/** Note names linked by `[[…]]` in `text` (no embeds), without alias, heading, block id, folder or `.md`. */
export function wikilinkTargets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) {
    if (m[1]) continue;
    const target = m[2].split("|")[0].split("#")[0].split("^")[0].trim();
    const name = (target.split("/").pop() ?? "").replace(/\.md$/i, "").trim();
    if (name) out.add(name);
  }
  return [...out];
}

export interface CiteLinkDeps {
  /** The indexed papers, loading or refreshing the index first if needed. */
  papers: () => Promise<PaperMetadata[]>;
  vault: VaultLike;
  metadataCache: MetadataCacheLike | null;
  settings: LitNoteSettings;
  showNotice: (msg: string) => void;
  sessionNotices: Set<string>;
  openFile: (file: any) => Promise<void>;
}

export class CiteLinkNotes {
  private deps: CiteLinkDeps;
  /** Citekeys whose note is being made, so two pastes at once make it once. */
  private pending = new Map<string, Promise<{ file: any | null; created: boolean }>>();

  constructor(deps: CiteLinkDeps) {
    this.deps = deps;
  }

  /** Text was pasted into an editor: make the literature note of every cited paper that has none. */
  async onPaste(text: string): Promise<void> {
    if (this.deps.settings.createLiteratureNotes === false || !text.includes("[[")) return;
    const targets = wikilinkTargets(text);
    if (targets.length === 0) return;
    const papers = await this.papersByCitekey();
    const found = targets.map((t) => this.lookup(papers, t)).filter((p): p is PaperMetadata => !!p);
    await Promise.all(found.map((p) => this.ensure(p).catch(() => undefined)));
  }

  /** A file appeared. A blank Markdown note named after an indexed citekey (Obsidian makes one when an unresolved
   * `[[citekey]]` is clicked) is filled from the template; ensureLiteratureNote never touches one with content. */
  async onCreate(file: { extension?: string; basename?: string }): Promise<void> {
    if (this.deps.settings.createLiteratureNotes === false || file.extension !== "md" || !file.basename) return;
    const paper = this.lookup(await this.papersByCitekey(), file.basename);
    if (!paper) return;
    if ((await this.deps.vault.read(file)).trim() !== "") return;
    await this.ensure(paper);
  }

  /** Open the literature note of `citekey`, creating it from the template if the paper is indexed. */
  async openNote(citekey: string): Promise<void> {
    const paper = this.lookup(await this.papersByCitekey(), citekey);
    const file = paper
      ? (await this.ensure(paper)).file
      : findLiteratureNote(this.deps.vault, this.deps.metadataCache, citekey);
    if (file) await this.deps.openFile(file);
    else if (!paper) this.deps.showNotice(`Paper search: no paper with citekey "${citekey}" in the index yet.`);
  }

  private ensure(paper: PaperMetadata): Promise<{ file: any | null; created: boolean }> {
    const running = this.pending.get(paper.citekey);
    if (running) return running;
    const job = ensureLiteratureNote(this.deps.vault, this.deps.metadataCache, paper, this.deps.settings, {
      showNotice: this.deps.showNotice,
      sessionNotices: this.deps.sessionNotices,
    }).finally(() => this.pending.delete(paper.citekey));
    this.pending.set(paper.citekey, job);
    return job;
  }

  private async papersByCitekey(): Promise<Map<string, PaperMetadata>> {
    const map = new Map<string, PaperMetadata>();
    for (const p of await this.deps.papers()) if (p.citekey) map.set(p.citekey, p);
    return map;
  }

  /** Obsidian resolves links case-insensitively; an exact match wins. */
  private lookup(papers: Map<string, PaperMetadata>, name: string): PaperMetadata | undefined {
    const exact = papers.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const [k, p] of papers) if (k.toLowerCase() === lower) return p;
    return undefined;
  }
}
