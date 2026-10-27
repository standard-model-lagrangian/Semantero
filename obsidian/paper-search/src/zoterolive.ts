/** Zotero's own local API (Zotero 7+, http://localhost:23119/api/), asked for papers the index doesn't list yet, so a
 * paper saved a few seconds ago can be cited before the watcher has published it. Off in Zotero until the owner ticks
 * Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"; until then (or while
 * Zotero is closed) every lookup returns [] after one quick refused request a minute. */

import type { PaperMetadata } from "./bm25.ts";
import type { RequestUrlFn } from "./ollama.ts";

export const DEFAULT_ZOTERO_API = "http://localhost:23119/api";
/** Shortest query sent to Zotero; shorter ones match half the library by title. */
export const MIN_LIVE_CHARS = 3;
/** At most this many papers come from Zotero; in steady state there are none (all are indexed). */
export const LIVE_LIMIT = 3;
const QUERY_PAGE = 25;
/** After a refused or failed request (Zotero closed, local API off), no request for this long. */
const RETRY_MS = 60_000;

interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

/** One local API item (`/items/top`, format json) as a PaperMetadata, in the shape the index writes
 * (authors are last names, as planner/zotlib.py stores them). */
export function paperFromApiItem(item: any): PaperMetadata | null {
  const d = item?.data;
  if (!d || typeof d.key !== "string") return null;
  if (d.itemType === "attachment" || d.itemType === "note" || d.itemType === "annotation") return null;
  const creators: ZoteroCreator[] = Array.isArray(d.creators) ? d.creators : [];
  const authors = creators
    .filter((c) => !c.creatorType || c.creatorType === "author")
    .map((c) => (c.lastName || c.name || "").trim())
    .filter(Boolean);
  const m = /\b(\d{4})\b/.exec(String(d.date ?? ""));
  return {
    key: d.key,
    citekey: typeof d.citationKey === "string" ? d.citationKey : "",
    title: d.title || "",
    authors,
    year: m ? Number(m[1]) : null,
    journal: d.publicationTitle || null,
    doi: d.DOI || null,
    tags: Array.isArray(d.tags) ? d.tags.map((t: any) => t?.tag).filter(Boolean) : [],
    collections: [],
    abstract: d.abstractNote || null,
    pdfs: [],
    snapshots: [],
  };
}

export class ZoteroLive {
  private downUntil = 0;
  private requestUrl: RequestUrlFn;
  private baseUrl: string;
  private now: () => number;

  constructor(requestUrl: RequestUrlFn, baseUrl: string = DEFAULT_ZOTERO_API, now: () => number = () => Date.now()) {
    this.requestUrl = requestUrl;
    this.baseUrl = baseUrl;
    this.now = now;
  }

  /** Papers matching `query` (Zotero's title/creator/year search) whose keys are not in `known`. Never throws. */
  async search(query: string, known: Set<string>, limit = LIVE_LIMIT): Promise<PaperMetadata[]> {
    const q = query.trim();
    if (q.length < MIN_LIVE_CHARS || this.now() < this.downUntil) return [];
    try {
      const resp = await this.requestUrl({
        // Most matches are already indexed and get dropped, so ask for a page of them.
        url: `${this.baseUrl.replace(/\/+$/, "")}/users/0/items/top?q=${encodeURIComponent(q)}&limit=${QUERY_PAGE}`,
        method: "GET",
      });
      if (resp.status !== 200 || !Array.isArray(resp.json)) {
        this.downUntil = this.now() + RETRY_MS; // 403: local API switched off
        return [];
      }
      const out: PaperMetadata[] = [];
      for (const item of resp.json) {
        const p = paperFromApiItem(item);
        if (p && !known.has(p.key)) out.push(p);
        if (out.length >= limit) break;
      }
      return out;
    } catch {
      this.downUntil = this.now() + RETRY_MS; // Zotero not running
      return [];
    }
  }
}

/** Keys of the papers an index lists, kept per index object so typing doesn't rebuild the set. */
const keySets = new WeakMap<object, Set<string>>();
export function indexedKeys(index: { papers: PaperMetadata[] }): Set<string> {
  let s = keySets.get(index);
  if (!s) {
    s = new Set(index.papers.map((p) => p.key));
    keySets.set(index, s);
  }
  return s;
}
