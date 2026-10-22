import type { Hit } from "../../obsidian/paper-search/src/engine.ts";
import type { PaperMetadata } from "../../obsidian/paper-search/src/bm25.ts";
import { actionsFor, type ResultKind } from "./actions.ts";
import { authorsShort, noteCitation, noteWikilink, paperCitation, paperWikilink } from "./cite.ts";
import type { Corpora } from "./corpora.ts";
import type { Row } from "./merge.ts";
import { chooseAttachment, resolveNoteFile, resolvePaperFile } from "./paths.ts";
import { hitUrl, lastHeading, obsidianNewUrl, obsidianOpenUrl, selectItemUrl } from "./urls.ts";
import { fileName, folderOf, isoDate, shortDate } from "./util.ts";

/** Everything the UI and the actions need. Swift only renders this and runs actions by id. */
export interface ResultVM {
  id: string;
  kind: ResultKind;
  title: string;
  subtitle: string;
  accessory: string;
  snippet: string;
  /** UTF-16 ranges in `snippet` to show in bold. */
  snippetBold: [number, number][];
  hasNote: boolean;
  filePath: string | null;
  openUrl: string;
  openLabel: string;
  noteUrl: string | null;
  selectUrl: string | null;
  citation: string;
  wikilink: string;
  actions: string[];
  detail: { label: string; value: string }[];
  source: Hit["source"];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words that start with a query token, merged, as UTF-16 [start, end) ranges. */
export function boldRanges(text: string, tokens: string[]): [number, number][] {
  const toks = tokens.filter(Boolean);
  if (!toks.length || !text) return [];
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])(?:${toks.map(escapeRe).join("|")})[\\p{L}\\p{N}]*`, "giu");
  const out: [number, number][] = [];
  for (const m of text.matchAll(rx)) {
    const start = m.index!;
    const end = start + m[0].length;
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1 && text.slice(last[1], start).trim() === "") last[1] = end;
    else out.push([start, end]);
  }
  return out;
}

function paperLocation(paper: PaperMetadata, hit: Hit): string {
  if (hit.fromAbstract) return "abstract";
  if (hit.attachmentKey && (paper.snapshots ?? []).some((s) => s.attachmentKey === hit.attachmentKey)) return "snapshot";
  return hit.page && hit.page > 0 ? `p. ${hit.page}` : "abstract";
}

function paperSubtitle(p: PaperMetadata): string {
  return [authorsShort(p.authors), p.year ? String(p.year) : "", p.journal ?? ""].filter(Boolean).join(" · ");
}

function detailRows(rows: [string, string | null | undefined][]) {
  return rows.filter(([, v]) => v).map(([label, value]) => ({ label, value: value as string }));
}

/** Snippets must already be filled on the row's hits (`fillSnippets`). */
export function buildVM(row: Row, c: Corpora, tokens: string[]): ResultVM {
  return row.paper ? paperVM(row, c, tokens) : noteVM(row, c, tokens, row.note!.hit.snippet);
}

function noteHeading(c: Corpora, row: Row): string | undefined {
  const hit = row.note!.hit;
  if (hit.chunkIndex === undefined) return undefined;
  return c.notes!.ix.chunks[hit.chunkIndex]?.heading || undefined;
}

function paperVM(row: Row, c: Corpora, tokens: string[]): ResultVM {
  const phit = row.paper!.hit;
  const paper = c.papers!.ix.papers[phit.paper];
  const noteWon = row.winner === "note" && !!row.note;
  const nEntry = row.note ? c.notes!.ix.papers[row.note.hit.paper] : undefined;
  const known = paper.citekey ? c.litnoteByCitekey.get(paper.citekey) : undefined;
  const notePath = nEntry?.path ?? known?.path;
  const hasNote = !!notePath;

  const loc = paperLocation(paper, phit);
  const att = chooseAttachment(paper, phit.attachmentKey);
  const filePath = att ? resolvePaperFile(c.zoteroStorage, att.file) : null;

  const heading = noteWon ? noteHeading(c, row) : undefined;
  const snippet = noteWon ? row.note!.hit.snippet : phit.snippet;
  const noteUrl = notePath
    ? obsidianOpenUrl(c.vaultName, notePath)
    : paper.citekey && c.vaultName
      ? obsidianNewUrl(c.vaultName, paper.citekey)
      : null;
  const openUrl = noteWon && notePath ? obsidianOpenUrl(c.vaultName, notePath, lastHeading(heading)) : hitUrl(paper, phit);
  const openLabel = noteWon
    ? "Open in Obsidian"
    : !att
      ? "Show in Zotero"
      : att.kind === "snapshot"
        ? "Open snapshot in Zotero"
        : loc.startsWith("p.")
          ? `Open in Zotero at ${loc}`
          : "Open in Zotero";
  const selectUrl = selectItemUrl(paper.key);
  const has = { filePath: filePath !== null, noteUrl: noteUrl !== null, selectUrl: true };

  return {
    id: `P:${paper.key}`,
    kind: "paper",
    title: paper.title,
    subtitle: noteWon && heading ? heading : paperSubtitle(paper),
    accessory: noteWon && nEntry?.mtime ? shortDate(nEntry.mtime) : loc,
    snippet,
    snippetBold: boldRanges(snippet, tokens),
    hasNote,
    filePath,
    openUrl,
    openLabel,
    noteUrl,
    selectUrl,
    citation: noteWon ? noteCitation(snippet, nEntry!.title, heading) : paperCitation(snippet, paper.authors, paper.year, loc),
    wikilink: paperWikilink(paper.citekey),
    actions: actionsFor("paper", has),
    detail: detailRows([
      ["Title", paper.title],
      ["Authors", paper.authors.join(", ")],
      ["Year", paper.year ? String(paper.year) : ""],
      ["Journal", paper.journal],
      ["DOI", paper.doi],
      ["Tags", paper.tags.join(", ")],
      ["Collections", paper.collections.join(", ")],
      ["File", att?.file ? fileName(att.file) : ""],
    ]),
    source: (noteWon ? row.note! : row.paper!).hit.source,
  };
}

function noteVM(row: Row, c: Corpora, tokens: string[], snippet: string): ResultVM {
  const hit = row.note!.hit;
  const entry = c.notes!.ix.papers[hit.paper];
  const path = entry.path ?? "";
  const heading = noteHeading(c, row);
  const kind: ResultKind = entry.kind ?? "note";
  const filePath = resolveNoteFile(c.vault, path);
  const paperKey = entry.litnoteOf ? c.paperKeyByCitekey.get(entry.litnoteOf) : undefined;
  const selectUrl = paperKey ? selectItemUrl(paperKey) : null;
  const folder = folderOf(path);
  const has = { filePath: filePath !== null, noteUrl: false, selectUrl: selectUrl !== null };
  return {
    id: `N:${entry.key}`,
    kind,
    title: entry.title,
    subtitle: heading ?? folder,
    accessory: entry.mtime ? shortDate(entry.mtime) : "",
    snippet,
    snippetBold: boldRanges(snippet, tokens),
    hasNote: false,
    filePath,
    openUrl: obsidianOpenUrl(c.vaultName, path, lastHeading(heading)),
    openLabel: "Open in Obsidian",
    noteUrl: null,
    selectUrl,
    citation: noteCitation(snippet, entry.title, heading),
    wikilink: noteWikilink(path),
    actions: actionsFor(kind, has),
    detail: detailRows([
      ["Path", path],
      ["Tags", entry.tags.join(", ")],
      ["Modified", entry.mtime ? isoDate(entry.mtime) : ""],
      ["Heading", heading],
    ]),
    source: hit.source,
  };
}
