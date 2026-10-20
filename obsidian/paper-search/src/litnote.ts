import type { PaperMetadata } from "./bm25.ts";

export interface VaultLike {
  getFiles(): any[];
  read(file: any): Promise<string>;
  create(path: string, content: string): Promise<any>;
  createFolder?(path: string): Promise<void>;
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

export function formatCitation(format: string = "[[{{citekey}}]]", citekey: string): string {
  if (!format.includes("{{citekey}}") && !format.includes("{{ citekey }}")) {
    throw new Error(`Citation format must contain {{citekey}}: ${format}`);
  }
  return format.replace(/\{\{\s*citekey\s*\}\}/g, citekey);
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
    zoteroSelect: paper.key ? `zotero://select/items/${paper.key}` : "",
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

  // Render frontmatter with YAML escaping
  if (hasFrontmatter) {
    const fmLines = frontmatterText.split(/\r?\n/);
    const renderedFmLines = fmLines.map((line) => {
      // Find all placeholders on this line
      return line.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, name) => {
        const val = rawValues[name];
        if (val === undefined) {
          options?.onUnknownPlaceholder?.(name);
          return "";
        }
        return escapeYamlString(val);
      });
    });

    // Handle placeholders that weren't double-quoted in frontmatter:
    // If a line is `key: {{placeholder}}` and placeholder was expanded without quotes,
    // ensure quotes if contains colon or special yaml chars.
    const quotedFmLines = renderedFmLines.map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const rawRest = line.slice(colonIdx + 1).trim();
        // If not quoted and has content
        if (rawRest && !rawRest.startsWith('"') && !rawRest.startsWith("[") && !rawRest.startsWith("{")) {
          // If it contains quotes or colons or was a substituted string, wrap in quotes
          return `${line.slice(0, colonIdx + 1)} "${escapeYamlString(rawRest)}"`;
        }
      }
      return line;
    });

    frontmatterText = quotedFmLines.join("\n");
  }

  // Render body without escaping (single pass)
  const renderedBody = bodyText.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, name) => {
    const val = rawValues[name];
    if (val === undefined) {
      options?.onUnknownPlaceholder?.(name);
      return "";
    }
    return val;
  });

  if (hasFrontmatter) {
    return `---\n${frontmatterText}\n---\n${renderedBody}`;
  }
  return renderedBody;
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
  // 1. Find existing
  const existing = findLiteratureNote(vault, metadataCache, paper.citekey);
  if (existing) {
    return { file: existing, created: false };
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

  // 6. Template resolution
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

  // 7. Render template
  const sessionNotices = options?.sessionNotices || new Set<string>();
  const content = renderTemplate(templateText, paper, {
    onUnsupportedTemplate: () => {
      if (!sessionNotices.has("nunjucks")) {
        sessionNotices.add("nunjucks");
        options?.showNotice?.(
          "Paper search: template uses unsupported Nunjucks features. Using built-in template."
        );
      }
    },
  });

  // 8. Create file
  const filePath = folder ? `${folder}/${paper.citekey}.md` : `${paper.citekey}.md`;
  try {
    const file = await vault.create(filePath, content);
    return { file, created: true };
  } catch (err: any) {
    // If file already exists (race condition with another tool), treat as existing
    if (err.message && err.message.toLowerCase().includes("exist")) {
      const f = vault.getAbstractFileByPath ? vault.getAbstractFileByPath(filePath) : null;
      return { file: f, created: false };
    }
    // Creation error: show notice and do not fail caller
    options?.showNotice?.(`Paper search: failed to create literature note: ${err.message}`);
    return { file: null, created: false };
  }
}
