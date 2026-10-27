import type { PaperMetadata } from "./bm25.ts";
import { selectItemUrl } from "./zotero.ts";

export interface VaultLike {
  getFiles(): any[];
  read(file: any): Promise<string>;
  create(path: string, content: string): Promise<any>;
  modify?(file: any, content: string): Promise<unknown>;
  createFolder?(path: string): Promise<unknown>;
  getAbstractFileByPath?(path: string): any;
}

export interface MetadataCacheLike {
  getFileCache(file: any): { frontmatter?: Record<string, any> } | null;
}

export interface LitNoteSettings {
  createLiteratureNotes?: boolean;
  literatureNoteFolder?: string;
  literatureNoteTemplate?: string;
  citationFormat?: string;
}

export const BUILTIN_TEMPLATE = `---
citekey: "{{citekey}}"
title: "{{title}}"
authors: "{{authors}}"
---
# {{title}}

[Zotero]({{zoteroSelect}})

## Abstract
{{abstractNote}}

## Notes
`;

const UNSAFE_CHARS_REGEX = /[/\\:*?"<>|]/;

export function isSafeCitekey(citekey: string | undefined | null): boolean {
  if (!citekey) return false;
  if (citekey.length > 200) return false;
  if (citekey.startsWith(".")) return false;
  if (UNSAFE_CHARS_REGEX.test(citekey)) return false;
  return true;
}

export function normalizeFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed || trimmed === "." || trimmed === "./") {
    return "";
  }
  // Check for path traversal escaping vault
  const parts = trimmed.split(/[/\\]/);
  for (const p of parts) {
    if (p === "..") {
      throw new Error(`Invalid folder path escaping vault: ${folder}`);
    }
  }
  // Normalise slashes
  return parts.filter((p) => p && p !== ".").join("/");
}

export function findLiteratureNote(
  vault: VaultLike,
  metadataCache: MetadataCacheLike | null | undefined,
  citekey: string
): any | null {
  if (!citekey) return null;
  const targetName = `${citekey.toLowerCase()}.md`;
  const files = vault.getFiles();

  // (a) Match filename case-insensitively
  for (const f of files) {
    const name = (f.name || f.path.split("/").pop() || "").toLowerCase();
    if (name === targetName) {
      return f;
    }
  }

  // (b) Match frontmatter citekey
  if (metadataCache) {
    for (const f of files) {
      const cache = metadataCache.getFileCache(f);
      if (cache?.frontmatter?.citekey === citekey) {
        return f;
      }
    }
  }

  return null;
}

export interface RenderTemplateOptions {
  onUnsupportedTemplate?: () => void;
  onUnknownPlaceholder?: (name: string) => void;
}

function escapeYamlString(val: string): string {
  return val
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/** A plain (unquoted) YAML scalar that would parse differently, or not at all, without quotes. */
function needsYamlQuotes(val: string): boolean {
  return (
    val === "" ||
    /^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(val) ||
    /\s$/.test(val) ||
    /:(\s|$)/.test(val) ||
    /\s#/.test(val) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(val)
  );
}

/**
 * Renders one frontmatter line. A placeholder inside "..." is escaped for double quotes, inside
 * '...' for single quotes; elsewhere it goes in as-is (line breaks become spaces). A `key: value`
 * line whose unquoted value came from a placeholder is then quoted once if YAML needs it.
 * List items and lines without placeholders are left alone.
 */
function renderFrontmatterLine(line: string, lookup: (name: string) => string): string {
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(line)) return line;

  const substitute = (text: string, offset: number): string =>
    text.replace(PLACEHOLDER_RE, (_m, name: string, pos: number) => {
      const before = line.slice(0, offset + pos);
      const inDouble = (before.replace(/\\./g, "").match(/"/g) || []).length % 2 === 1;
      const inSingle = !inDouble && (before.match(/'/g) || []).length % 2 === 1;
      const val = lookup(name);
      if (inDouble) return escapeYamlString(val);
      if (inSingle) return val.replace(/\r?\n/g, " ").replace(/'/g, "''");
      return val.replace(/\r?\n/g, " ");
    });

  const kv = line.match(/^(\s*[^\s\-#][^:]*:)(\s*)(.*)$/);
  // Values already quoted, flow collections and block scalars are left to the per-placeholder rules.
  if (kv && !/^(["'\[|>]|\{(?!\{))/.test(kv[3])) {
    const [, key, , rest] = kv;
    const value = substitute(rest, line.length - rest.length);
    return needsYamlQuotes(value) ? `${key} "${escapeYamlString(value)}"` : `${key} ${value}`;
  }
  return substitute(line, 0);
}

export function renderTemplate(
  templateText: string,
  paper: PaperMetadata,
  options?: RenderTemplateOptions
): string {
  // Check for unsupported Nunjucks syntax
  if (
    templateText.includes("{%") ||
    templateText.includes("{#") ||
    /\{\{[^}]+(\|)[^}]+\}\}/.test(templateText)
  ) {
    options?.onUnsupportedTemplate?.();
    templateText = BUILTIN_TEMPLATE;
  }

  const rawValues: Record<string, string> = {
    citekey: paper.citekey || "",
    title: paper.title || "",
    authors: (paper.authors || []).join(", "),
    abstractNote: paper.abstract || "",
    notes: "",
    year: paper.year !== null && paper.year !== undefined ? String(paper.year) : "",
    journal: paper.journal || "",
    doi: paper.doi || "",
    zoteroSelect: paper.key ? selectItemUrl(paper.key) : "",
  };

  // Check frontmatter boundaries
  let frontmatterText = "";
  let bodyText = templateText;
  let hasFrontmatter = false;

  const fmMatch = templateText.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (fmMatch) {
    hasFrontmatter = true;
    frontmatterText = fmMatch[1];
    bodyText = templateText.slice(fmMatch[0].length);
  }

  const lookup = (name: string): string => {
    const val = rawValues[name];
    if (val === undefined) {
      options?.onUnknownPlaceholder?.(name);
      return "";
    }
    return val;
  };

  // Render frontmatter with YAML escaping, applied exactly once per value
  if (hasFrontmatter) {
    frontmatterText = frontmatterText
      .split(/\r?\n/)
      .map((line) => renderFrontmatterLine(line, lookup))
      .join("\n");
  }

  // Render body without escaping (single pass)
  const renderedBody = bodyText.replace(PLACEHOLDER_RE, (_match, name) => lookup(name));

  if (hasFrontmatter) {
    return `---\n${frontmatterText}\n---\n${renderedBody}`;
  }
  return renderedBody;
}

/** Renders a literature note for `paper` from the configured template (else the built-in one). */
async function renderLiteratureNote(
  vault: VaultLike,
  paper: PaperMetadata,
  settings: LitNoteSettings,
  options?: { showNotice?: (msg: string) => void; sessionNotices?: Set<string> }
): Promise<string> {
  let templateText = BUILTIN_TEMPLATE;
  const templatePath = settings.literatureNoteTemplate || "Zotero Template.md";
  const templateFile = vault.getAbstractFileByPath ? vault.getAbstractFileByPath(templatePath) : null;

  if (templateFile) {
    try {
      templateText = await vault.read(templateFile);
    } catch {
      templateText = BUILTIN_TEMPLATE;
    }
  }

  const sessionNotices = options?.sessionNotices || new Set<string>();
  return renderTemplate(templateText, paper, {
    onUnsupportedTemplate: () => {
      if (!sessionNotices.has("nunjucks")) {
        sessionNotices.add("nunjucks");
        options?.showNotice?.(
          "Paper search: template uses unsupported Nunjucks features. Using built-in template."
        );
      }
    },
  });
}

export async function ensureLiteratureNote(
  vault: VaultLike,
  metadataCache: MetadataCacheLike | null | undefined,
  paper: PaperMetadata,
  settings: LitNoteSettings,
  options?: {
    showNotice?: (msg: string) => void;
    sessionNotices?: Set<string>;
  }
): Promise<{ file: any | null; created: boolean }> {
  // 1. Find existing. A blank one (e.g. Obsidian made it when an unresolved [[citekey]] link was
  // clicked) is filled from the template; one with any content is never touched.
  const existing = findLiteratureNote(vault, metadataCache, paper.citekey);
  if (existing) {
    if (settings.createLiteratureNotes === false || !vault.modify) return { file: existing, created: false };
    let current: string;
    try {
      current = await vault.read(existing);
    } catch {
      return { file: existing, created: false };
    }
    if (current.trim() !== "") return { file: existing, created: false };
    const content = await renderLiteratureNote(vault, paper, settings, options);
    try {
      await vault.modify(existing, content);
      return { file: existing, created: true };
    } catch (err: any) {
      options?.showNotice?.(`Paper search: failed to fill literature note: ${err.message}`);
      return { file: existing, created: false };
    }
  }

  // 2. Setting disabled
  if (settings.createLiteratureNotes === false) {
    return { file: null, created: false };
  }

  // 3. Filename safety
  if (!isSafeCitekey(paper.citekey)) {
    options?.showNotice?.(
      `Paper search: citekey "${paper.citekey || ""}" cannot be used as a filename. Citation was inserted without a literature note.`
    );
    return { file: null, created: false };
  }

  // 4. Folder normalisation
  let folder = "";
  try {
    folder = normalizeFolder(settings.literatureNoteFolder || "");
  } catch (err: any) {
    options?.showNotice?.(`Paper search: ${err.message}`);
    return { file: null, created: false };
  }

  // 5. Ensure folder exists
  if (folder && vault.createFolder) {
    try {
      await vault.createFolder(folder);
    } catch {
      // ignore folder already exists
    }
  }

  // 6. Template resolution and rendering
  const content = await renderLiteratureNote(vault, paper, settings, options);

  // 7. Create file
  const filePath = folder ? `${folder}/${paper.citekey}.md` : `${paper.citekey}.md`;
  try {
    const file = await vault.create(filePath, content);
    return { file, created: true };
  } catch (err: any) {
    // If file already exists (race condition with another tool), treat as existing
    if (err.message && err.message.toLowerCase().includes("exist")) {
      // On a case-insensitive disk the other file may differ from ours only in case.
      const lower = filePath.toLowerCase();
      const f =
        (vault.getAbstractFileByPath ? vault.getAbstractFileByPath(filePath) : null) ||
        vault.getFiles().find((x) => (x.path || "").toLowerCase() === lower) ||
        findLiteratureNote(vault, metadataCache, paper.citekey);
      return { file: f, created: false };
    }
    // Creation error: show notice and do not fail caller
    options?.showNotice?.(`Paper search: failed to create literature note: ${err.message}`);
    return { file: null, created: false };
  }
}
