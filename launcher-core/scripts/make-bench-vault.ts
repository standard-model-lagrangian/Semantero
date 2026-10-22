// Builds a temp vault at 3x scale for the app benchmark: 500 papers x 50 chunks and 2,000 notes x 3 chunks,
// 1024 dims (generated once by the perf tests). Prints the vault path.
//   node scripts/make-bench-vault.ts [outDir]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSyntheticIndex } from "../../obsidian/paper-search/scripts/make-synthetic-index.ts";

const FIX = path.resolve(import.meta.dirname, "../test/fixtures");
function ensure(name: string, opts: { numPapers: number; chunksPerPaper: number; seed: number }) {
  const dir = path.join(FIX, name);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) buildSyntheticIndex({ outDir: dir, dims: 1024, ...opts });
  return dir;
}
const papers = ensure("synthetic_papers_3x", { numPapers: 500, chunksPerPaper: 50, seed: 42 });
const notes = ensure("synthetic_notes_2000", { numPapers: 2000, chunksPerPaper: 3, seed: 7 });

const out = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "daito-bench-vault-"));
const planner = path.join(out, ".planner");
fs.rmSync(planner, { recursive: true, force: true });
fs.mkdirSync(planner, { recursive: true });
fs.cpSync(papers, path.join(planner, "search"), { recursive: true });
fs.cpSync(notes, path.join(planner, "notes"), { recursive: true });

const pm = JSON.parse(fs.readFileSync(path.join(planner, "search", "manifest.json"), "utf8"));
pm.zotero_storage = "/Users/test/Zotero/storage";
fs.writeFileSync(path.join(planner, "search", "manifest.json"), JSON.stringify(pm));
const nDir = path.join(planner, "notes");
const nm = JSON.parse(fs.readFileSync(path.join(nDir, "manifest.json"), "utf8"));
Object.assign(nm, { model: pm.model, dims: pm.dims, query_instruction: pm.query_instruction, vault: out, vault_name: "bench", corpus: "notes" });
fs.writeFileSync(path.join(nDir, "manifest.json"), JSON.stringify(nm));
const np = JSON.parse(fs.readFileSync(path.join(nDir, "papers.json"), "utf8"));
np.forEach((p: any, i: number) => { p.kind = "note"; p.path = `note-${i}.md`; p.mtime = 1_700_000_000 + i; });
fs.writeFileSync(path.join(nDir, "papers.json"), JSON.stringify(np));
console.log(out);
