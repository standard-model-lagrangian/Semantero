import { noteName } from "./util.ts";

/** 1 → "Roth", 2 → "Roth & Bauer", 3 or more → "Roth et al." */
export function authorsShort(authors: string[]): string {
  const a = authors.filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} & ${a[1]}`;
  return `${a[0]} et al.`;
}

/** `"…passage…" (Roth et al., 2023, p. 6)`; missing parts are left out. */
export function paperCitation(
  passage: string,
  authors: string[],
  year: number | null | undefined,
  location: string
): string {
  const parts = [authorsShort(authors), year ? String(year) : "", location].filter(Boolean);
  return parts.length ? `"${passage}" (${parts.join(", ")})` : `"${passage}"`;
}

/** `"…passage…" (note: Title › Heading)`; a lead row (no heading) cites the title only. */
export function noteCitation(passage: string, title: string, heading: string | undefined): string {
  // A note whose first H1 is its title repeats it at the front of every heading path: say it once.
  let h = heading ?? "";
  if (h === title) h = "";
  else if (h.startsWith(`${title} › `)) h = h.slice(title.length + 3);
  return `"${passage}" (note: ${h ? `${title} › ${h}` : title})`;
}

export function paperWikilink(citekey: string): string {
  return `[[${citekey}]]`;
}

export function noteWikilink(path: string): string {
  return `[[${noteName(path)}]]`;
}
