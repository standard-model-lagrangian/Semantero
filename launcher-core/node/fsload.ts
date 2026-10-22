/** Node only: read index folders from disk. Used by tests and eval.ts; never bundled into ranker.js. */
import fs from "node:fs";
import path from "node:path";
import type { RawCorpus } from "../src/corpora.ts";
import type { CorpusPart } from "../src/api.ts";

function bytes(file: string): ArrayBuffer {
  const b = fs.readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** A corpus folder as raw parsed data, or null when it has no manifest. */
export function readCorpus(dir: string): RawCorpus | null {
  if (!fs.existsSync(path.join(dir, "manifest.json"))) return null;
  const vf = path.join(dir, "vectors.f32");
  return {
    manifest: JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
    papers: JSON.parse(fs.readFileSync(path.join(dir, "papers.json"), "utf8")),
    chunks: JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf8")),
    vectors: fs.existsSync(vf) ? bytes(vf) : null,
  };
}

/** The same folder as the app hands it to the JavaScriptCore bundle: JSON parts as UTF-8 bytes. */
export function readPart(dir: string): CorpusPart | null {
  if (!fs.existsSync(path.join(dir, "manifest.json"))) return null;
  const vf = path.join(dir, "vectors.f32");
  return {
    manifest: bytes(path.join(dir, "manifest.json")),
    papers: bytes(path.join(dir, "papers.json")),
    chunks: bytes(path.join(dir, "chunks.json")),
    vectors: fs.existsSync(vf) ? bytes(vf) : null,
  };
}

/** `<vault>/.planner/search` and `<vault>/.planner/notes`. */
export function vaultDirs(vault: string) {
  return { papers: path.join(vault, ".planner", "search"), notes: path.join(vault, ".planner", "notes") };
}
