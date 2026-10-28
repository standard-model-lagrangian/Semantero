import type { PaperMetadata } from "../../obsidian/paper-search/src/core/bm25.ts";

export interface AttachmentRef {
  attachmentKey: string;
  file: string | undefined;
  kind: "pdf" | "snapshot";
}

/** Collapses `.` and `..`. Returns null if `..` would climb above the start of a relative path. */
function normalize(path: string): string | null {
  const abs = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** `root + "/" + relative`, only if the result stays inside `root`. */
export function resolveInside(root: string, relative: string): string | null {
  if (!root || !relative || relative.startsWith("/")) return null;
  const r = normalize(root);
  const rel = normalize(relative);
  if (r === null || rel === null || rel === "") return null;
  return `${r.replace(/\/+$/, "")}/${rel}`;
}

/** A paper attachment's absolute path: storage-relative files must stay inside the storage folder;
 * linked files are already absolute and are used as written. */
export function resolvePaperFile(storage: string | null, file: string | undefined): string | null {
  if (!file) return null;
  if (file.startsWith("/")) return normalize(file);
  if (!storage) return null;
  return resolveInside(storage, file);
}

export function resolveNoteFile(vault: string | null, path: string | undefined): string | null {
  if (!vault || !path) return null;
  return resolveInside(vault, path);
}

/** Which attachment a paper result acts on: the winning chunk's, else the first PDF, else the first snapshot. */
export function chooseAttachment(paper: PaperMetadata, winningKey?: string): AttachmentRef | null {
  const pdfs = paper.pdfs ?? [];
  const snaps = paper.snapshots ?? [];
  if (winningKey) {
    const p = pdfs.find((a) => a.attachmentKey === winningKey);
    if (p) return { attachmentKey: p.attachmentKey, file: p.file, kind: "pdf" };
    const s = snaps.find((a) => a.attachmentKey === winningKey);
    if (s) return { attachmentKey: s.attachmentKey, file: s.file, kind: "snapshot" };
  }
  if (pdfs[0]) return { attachmentKey: pdfs[0].attachmentKey, file: pdfs[0].file, kind: "pdf" };
  if (snaps[0]) return { attachmentKey: snaps[0].attachmentKey, file: snaps[0].file, kind: "snapshot" };
  return null;
}
