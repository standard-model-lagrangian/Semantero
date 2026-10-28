/** zotero:// links, built in one place. Item and attachment keys are 8-character Zotero keys
 * in the user's personal library. */

import type { PaperMetadata } from "./bm25.ts";

export function selectItemUrl(itemKey: string): string {
  return `zotero://select/library/items/${itemKey}`;
}

export function openPdfUrl(attachmentKey: string, page?: number): string {
  const p = page && page > 0 ? Math.floor(page) : 1;
  return `zotero://open-pdf/library/items/${attachmentKey}?page=${p}`;
}

/** Opens any file attachment (PDF, EPUB, web snapshot) in Zotero's reader. `open-pdf` is an alias
 * of the same handler in Zotero 7+, which passes the item to Zotero.FileHandlers.open. */
export function openAttachmentUrl(attachmentKey: string): string {
  return `zotero://open/library/items/${attachmentKey}`;
}

/** Where Enter on a hit goes: the matching attachment (a PDF at the matching page, a web snapshot
 * as a whole, since it has no pages); for abstract hits the first PDF, else the first snapshot;
 * the item itself when it has neither. */
export function hitUrl(paper: PaperMetadata, hit?: { attachmentKey?: string; page?: number }): string {
  const snapshots = paper.snapshots ?? [];
  const attKey = hit?.attachmentKey || paper.pdfs?.[0]?.attachmentKey || snapshots[0]?.attachmentKey;
  if (!attKey) return selectItemUrl(paper.key);
  if (snapshots.some((s) => s.attachmentKey === attKey)) return openAttachmentUrl(attKey);
  return openPdfUrl(attKey, hit?.attachmentKey ? hit.page : 1);
}

/**
 * Where a hit matched, as shown beside it: "abstract", "p. N" (a page of a PDF) or `snapshotLabel` (a web snapshot,
 * which has no pages). The plugin says "web page", the launcher "snapshot".
 */
export function hitLocation(
  paper: PaperMetadata,
  hit: { fromAbstract: boolean; attachmentKey?: string; page?: number },
  snapshotLabel: string = "snapshot"
): string {
  if (hit.fromAbstract) return "abstract";
  if (hit.attachmentKey && (paper.snapshots ?? []).some((s) => s.attachmentKey === hit.attachmentKey)) return snapshotLabel;
  return hit.page && hit.page > 0 ? `p. ${hit.page}` : "abstract";
}
