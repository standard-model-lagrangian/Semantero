// Evaluation of the launcher search against eval/queries.toml, ranked by the production path (Engine, the shared
// core's semantic scorer for whichever backend built the index: Ollama, or the pplx service for a pplx index).
// `--scope papers` is the plugin's ranking of the papers index.
//   node scripts/eval.ts --vault <dir> [--scope all|papers|notes|compare] [--keyword-only]
//                        [--per-corpus-instruction] [--url http://127.0.0.1:11434] [--kind finding]
// `expect` lists acceptable paper citekeys, `expect_note` acceptable vault-relative note paths. A pplx index is scored
// by the running service, which must have the same build of the index loaded (the vault's live index).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { semanticScores, warmSemantic } from "../../obsidian/paper-search/src/core/semantic.ts";
import { buildCorpora, type Corpus } from "../src/corpora.ts";
import { Engine, type Scope } from "../src/query.ts";
import type { ResultVM } from "../src/vm.ts";
import { readCorpus, vaultDirs } from "../node/fsload.ts";

interface Q { text: string; expect: string[]; expectNote: string[]; kind: string }

const NOTE_INSTRUCTION = "Given a search query, retrieve the personal note that contains the answer";

function list(block: string, key: string): string[] {
  const m = block.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]) : [];
}

export function parseQueries(content: string): Q[] {
  const out: Q[] = [];
  for (const block of content.split(/\[\[q\]\]/).slice(1)) {
    const text = block.match(/(?:^|\n)\s*text\s*=\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const kind = block.match(/(?:^|\n)\s*kind\s*=\s*"([^"]+)"/)?.[1] ?? "finding";
    const expect = list(block, "expect");
    const expectNote = list(block, "expect_note");
    if (text && (expect.length || expectNote.length)) out.push({ text, expect, expectNote, kind });
  }
  return out;
}

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

function matches(r: ResultVM, q: Q): boolean {
  if (r.kind === "paper") {
    const citekey = r.wikilink.slice(2, -2);
    if (q.expect.includes(citekey)) return true;
  }
  const path = r.kind === "paper" ? decodeNoteUrl(r.noteUrl) : r.detail.find((d) => d.label === "Path")?.value;
  return !!path && q.expectNote.includes(path) && (r.kind !== "paper" || r.hasNote);
}

function decodeNoteUrl(u: string | null): string | null {
  const m = u?.match(/file=([^&]+)$/);
  return m && u!.startsWith("obsidian://open") ? decodeURIComponent(m[1].split("%23")[0]) + ".md" : null;
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (n: string, d = "") => { const i = a.indexOf(n); return i >= 0 && i + 1 < a.length ? a[i + 1] : d; };
  const vault = arg("--vault");
  const scopeArg = arg("--scope", "all") as Scope | "compare";
  const keywordOnly = a.includes("--keyword-only");
  const perCorpus = a.includes("--per-corpus-instruction");
  const url = arg("--url", "http://127.0.0.1:11434");
  const onlyKind = arg("--kind");
  if (!vault) { console.error("Usage: node scripts/eval.ts --vault <dir> [--scope all|papers|notes|compare] [--keyword-only] [--per-corpus-instruction]"); process.exit(1); }

  const dirs = vaultDirs(vault);
  const corpora = buildCorpora(readCorpus(dirs.papers), readCorpus(dirs.notes));
  const engine = new Engine(corpora, { interleaveSemantic: perCorpus });
  const model = corpora.model ?? "", dims = corpora.dims ?? 0, instruction = corpora.queryInstruction ?? "";
  const backend = (corpora.papers ?? corpora.notes)?.ix.manifest.backend ?? "ollama";
  console.log(`Loaded ${corpora.papers?.ix.papers.length ?? 0} papers, ${corpora.notes?.ix.papers.length ?? 0} notes (${model}, ${dims} dims, ${backend}). ${corpora.flags.join("; ")}`);

  const http = async (p: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    const res = await fetch(p.url, { method: p.method ?? "POST", headers: p.headers, body: p.body });
    return { status: res.status, json: await res.json() };
  };
  let semantic = !keywordOnly;
  const ref = corpora.papers ?? corpora.notes;
  if (semantic && ref) await warmSemantic(http, ref.ix, url);

  const all = parseQueries(fs.readFileSync(path.resolve(import.meta.dirname, "../../eval/queries.toml"), "utf8"));
  const queries = all.filter((q) => !onlyKind || q.kind === onlyKind);
  console.log(`Evaluating ${queries.length} queries (${keywordOnly ? "keyword only" : "hybrid"}).\n`);

  // Row scores per corpus, query and instruction (compare mode ranks every query twice).
  const scoreCache = new Map<string, Float64Array | null>();
  const scores = async (c: Corpus | null, text: string, instr: string) => {
    if (!c?.semantic) return null;
    const k = `${c.name}\n${instr}\n${text}`;
    if (!scoreCache.has(k)) scoreCache.set(k, (await semanticScores(http, c.ix, text, { ollamaUrl: url, instruction: instr, corpus: c.name === "papers" ? "search" : "notes" })).scores);
    return scoreCache.get(k)!;
  };

  async function run(scope: Scope) {
    const rows: { q: Q; rank: number; top: string[]; win: string }[] = [];
    const kwMs: number[] = [], semMs: number[] = [];
    for (const q of queries) {
      let t = performance.now();
      let res = engine.keyword(q.text, scope, 20);
      kwMs.push(performance.now() - t);
      if (semantic) {
        try {
          const papers = await scores(corpora.papers, q.text, instruction);
          const notes = await scores(corpora.notes, q.text, perCorpus ? NOTE_INSTRUCTION : instruction);
          t = performance.now();
          res = engine.hybridFromRowScores(q.text, { papers, notes }, scope, 20);
          semMs.push(performance.now() - t);
        } catch (e) { console.warn(`semantic off: ${(e as Error).message}`); semantic = false; }
      }
      const idx = res.findIndex((r) => matches(r, q));
      const hit = idx >= 0 ? res[idx] : undefined;
      rows.push({ q, rank: idx + 1, top: res.slice(0, 3).map((r) => r.title), win: hit ? (hit.kind === "paper" ? hit.accessory : hit.subtitle ? "section" : "lead") : "" });
    }
    return { rows, kwMs, semMs };
  }

  const stat = (rows: { rank: number }[]) => ({
    n: rows.length,
    r1: rows.filter((r) => r.rank === 1).length / (rows.length || 1),
    r5: rows.filter((r) => r.rank >= 1 && r.rank <= 5).length / (rows.length || 1),
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / (rows.length || 1),
  });
  const line = (label: string, s: ReturnType<typeof stat>) =>
    `  ${label.padEnd(14)} n=${String(s.n).padStart(3)}  recall@1 ${s.r1.toFixed(2)}  recall@5 ${s.r5.toFixed(2)}  MRR ${s.mrr.toFixed(2)}`;

  function report(scope: string, r: Awaited<ReturnType<typeof run>>) {
    console.log(`── scope: ${scope}`);
    console.log(line("overall", stat(r.rows)));
    for (const k of [...new Set(r.rows.map((x) => x.q.kind))]) console.log(line(k, stat(r.rows.filter((x) => x.q.kind === k))));
    console.log(`  keyword latency p50 ${pct(r.kwMs, 50).toFixed(2)} ms, p95 ${pct(r.kwMs, 95).toFixed(2)} ms`);
    if (r.semMs.length) console.log(`  semantic merge (warm, excl. embedding and row scoring) p50 ${pct(r.semMs, 50).toFixed(1)} ms, p95 ${pct(r.semMs, 95).toFixed(1)} ms`);
    const misses = r.rows.filter((x) => x.rank === 0 || x.rank > 5);
    if (misses.length) {
      console.log(`  misses (${misses.length}):`);
      for (const m of misses) console.log(`    "${m.q.text}" → ${m.rank ? `rank ${m.rank}` : "not found"} [${m.win || "-"}]; top: ${m.top.join(" | ")}`);
    }
    console.log("");
  }

  if (scopeArg === "compare") {
    const ra = await run("all"); const rp = await run("papers");
    report("all", ra); report("papers", rp);
    const f = (r: typeof ra) => stat(r.rows.filter((x) => x.q.kind === "finding" && x.q.expect.length));
    const d = f(rp).r5 - f(ra).r5;
    console.log(`Paper finding recall@5: papers ${f(rp).r5.toFixed(2)} vs all ${f(ra).r5.toFixed(2)} → drop ${d.toFixed(2)} (budget 0.03): ${d <= 0.03 ? "PASS" : "FAIL"}`);
  } else {
    report(scopeArg, await run(scopeArg));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
