/** zotero:// links, built in one place. Item and attachment keys are 8-character Zotero keys
 * in the user's personal library. */

export function selectItemUrl(itemKey: string): string {
  return `zotero://select/library/items/${itemKey}`;
}

export function openPdfUrl(attachmentKey: string, page?: number): string {
  const p = page && page > 0 ? Math.floor(page) : 1;
  return `zotero://open-pdf/library/items/${attachmentKey}?page=${p}`;
}
