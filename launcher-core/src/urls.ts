export { selectItemUrl, openPdfUrl, openAttachmentUrl, hitUrl, hitLocation } from "../../obsidian/paper-search/src/core/zotero.ts";

const enc = encodeURIComponent;

/** obsidian://open for a vault-relative note path; `heading` (the last heading of the path) is appended as `#heading`. */
export function obsidianOpenUrl(vaultName: string, path: string, heading?: string): string {
  const file = path.replace(/\.md$/i, "");
  const h = heading ? `%23${enc(heading)}` : "";
  return `obsidian://open?vault=${enc(vaultName)}&file=${enc(file)}${h}`;
}

/** The Obsidian plugin's handler (src/citelinks.ts, OPEN_NOTE_ACTION) for a literature note that may not exist yet:
 * it creates the note from the plugin's template (abstract, Zotero link) and opens it. `obsidian://new` made a blank note. */
export function obsidianLitNoteUrl(vaultName: string, citekey: string): string {
  return `obsidian://semantero-note?vault=${enc(vaultName)}&citekey=${enc(citekey)}`;
}

/** The last segment of a "A › B › C" heading path. */
export function lastHeading(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(" › ");
  return parts[parts.length - 1] || undefined;
}
