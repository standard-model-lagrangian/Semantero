import fs from "node:fs";
import path from "node:path";
import { extractPassage } from "../src/passage.ts";
import { semantic, type Hit, type LoadedIndex } from "../src/engine.ts";
import { embedQuery, warmUp } from "../src/ollama.ts";
import { IndexStore } from "../src/indexstore.ts";
import { type PaperMetadata } from "../src/bm25.ts";

interface EvalNoteEntry {
  note: string;
  section?: string;
  expect: string[];
}

function parseRelatedToml(content: string): EvalNoteEntry[] {
  const entries: EvalNoteEntry[] = [];
  const blocks = content.split(/\[\[n\]\]/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const noteMatch = trimmed.match(/note\s*=\s*"([^"]+)"/);
    const sectionMatch = trimmed.match(/section\s*=\s*"([^"]*)"/);
    const expectMatch = trimmed.match(/expect\s*=\s*\[([^\]]+)\]/);

    if (noteMatch && expectMatch) {
      const note = noteMatch[1];
      const section = sectionMatch ? sectionMatch[1] : "";
      const expect = expectMatch[1]
        .split(",")
        .map((s) => s.replace(/["'\s]/g, ""))
        .filter(Boolean);
      entries.push({ note, section, expect });
    }
  }

  return entries;
}

async function requestUrlNative(req: any): Promise<any> {
  const res = await fetch(req.url, {
    method: req.method || "POST",
    headers: req.headers || { "Content-Type": "application/json" },
    body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return { status: res.status, json, text: JSON.stringify(json) };
}

async function main() {
  const args = process.argv.slice(2);
  let indexDir = "";
  let vaultCopy = "";
  let tomlPath = "eval/related.toml";
  let useInstruction = true;
  let instruction = "Given a passage from my research notes, retrieve papers that report the findings or methods it discusses";
  let ollamaUrl = "http://127.0.0.1:11434";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--index" && i + 1 < args.length) {
      indexDir = args[++i];
    } else if (args[i] === "--vault" && i + 1 < args.length) {
      vaultCopy = args[++i];
    } else if (args[i] === "--toml" && i + 1 < args.length) {
      tomlPath = args[++i];
    } else if (args[i] === "--no-instruction") {
      useInstruction = false;
    } else if (args[i] === "--instruction" && i + 1 < args.length) {
      instruction = args[++i];
    } else if (args[i] === "--url" && i + 1 < args.length) {
      ollamaUrl = args[++i];
    }
  }

  if (!indexDir || !vaultCopy) {
    console.error("Usage: node scripts/eval-related.ts --index <dir> --vault <copy> [--no-instruction] [--toml <file>]");
    process.exit(1);
  }

  // Load index via production IndexStore
  const adapter = {
    read: async (p: string) => fs.promises.readFile(path.join(indexDir, p), "utf8"),
    readBinary: async (p: string) => {
      const buf = fs.readFileSync(path.join(indexDir, p));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    exists: async (p: string) => fs.existsSync(path.join(indexDir, p)),
    showNotice: (msg: string) => console.log("Notice:", msg),
  };
  const store = new IndexStore(adapter, "");
  await store.load();
  const loadedIndex = store.getIndex()!;
  const papers = loadedIndex.papers;
  const manifest = loadedIndex.manifest;
  const dims = loadedIndex.dims;

  // Warm up Ollama
  const model = manifest.model || "qwen3-embedding:0.6b";
  try {
    await warmUp(requestUrlNative, { url: ollamaUrl, model });
  } catch (err: any) {
    console.error("Warning: Ollama warmUp failed:", err.message);
  }

  // Load eval TOML
  if (!fs.existsSync(tomlPath)) {
    console.error(`TOML file not found: ${tomlPath}`);
    process.exit(1);
  }
  const tomlContent = fs.readFileSync(tomlPath, "utf8");
  const entries = parseRelatedToml(tomlContent);

  console.log(`\nEvaluating ${entries.length} notes from ${tomlPath}...`);
  console.log(`Instruction: ${useInstruction ? `"${instruction}"` : "(none - plain document)"}\n`);

  let hitsAt5Count = 0;
  let totalReciprocalRank = 0;
  const expectedScores: number[] = [];
  const bestNonExpectedScores: number[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const fullPath = path.join(vaultCopy, entry.note);
    if (!fs.existsSync(fullPath)) {
      console.warn(`[Skip] Note not found in vault copy: ${entry.note}`);
      continue;
    }

    let noteText = fs.readFileSync(fullPath, "utf8");
    if (entry.section) {
      // Find section heading
      const headingMatch = noteText.match(new RegExp(`^#{1,6}\\s+${entry.section}.*$`, "m"));
      if (headingMatch && headingMatch.index !== undefined) {
        const start = headingMatch.index + headingMatch[0].length;
        const rest = noteText.slice(start);
        const nextHeading = rest.match(/^#{1,6}\s+/m);
        noteText = nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
      }
    }

    const passage = extractPassage(noteText, 0, "", 2000);
    if (!passage) {
      console.warn(`[Skip] Note passage too short: ${entry.note}`);
      continue;
    }

    const qVec = await embedQuery(requestUrlNative, {
      url: ollamaUrl,
      model,
      instruction: useInstruction ? instruction : undefined,
      query: passage,
      dims,
    });

    if (!qVec) {
      console.error(`[Error] Failed to embed passage for ${entry.note}`);
      continue;
    }

    const hits = semantic(loadedIndex, qVec, passage, { limit: 50, minScore: 0 });

    const expectedSet = new Set(entry.expect.map((s) => s.toLowerCase()));
    let firstExpectedRank = -1;
    let noteExpectedScores: { citekey: string; score: number; rank: number }[] = [];
    let bestNonExpected = 0;

    for (let r = 0; r < hits.length; r++) {
      const h = hits[r];
      const p = papers[h.paper];
      const key = p.citekey.toLowerCase();
      if (expectedSet.has(key)) {
        if (firstExpectedRank === -1) {
          firstExpectedRank = r + 1;
        }
        noteExpectedScores.push({ citekey: p.citekey, score: h.score, rank: r + 1 });
        expectedScores.push(h.score);
      } else {
        if (h.score > bestNonExpected) {
          bestNonExpected = h.score;
        }
      }
    }

    bestNonExpectedScores.push(bestNonExpected);

    const hitAt5 = firstExpectedRank > 0 && firstExpectedRank <= 5;
    if (hitAt5) hitsAt5Count++;
    const rr = firstExpectedRank > 0 ? 1.0 / firstExpectedRank : 0;
    totalReciprocalRank += rr;

    console.log(`[Note ${idx + 1}] ${entry.note}`);
    console.log(`  Hit@5: ${hitAt5 ? "YES" : "NO"} (first expected rank: ${firstExpectedRank > 0 ? firstExpectedRank : "not in top 50"})`);
    for (const s of noteExpectedScores) {
      console.log(`  Expected: ${s.citekey} -> score: ${s.score.toFixed(4)}, rank: ${s.rank}`);
    }
    console.log(`  Best non-expected score: ${bestNonExpected.toFixed(4)}`);
  }

  const numEvaluated = entries.length;
  const hitAt5Rate = numEvaluated > 0 ? hitsAt5Count / numEvaluated : 0;
  const mrr = numEvaluated > 0 ? totalReciprocalRank / numEvaluated : 0;

  console.log("\n=========================================");
  console.log(`Results (${numEvaluated} notes evaluated):`);
  console.log(`Hit@5: ${(hitAt5Rate * 100).toFixed(1)}% (${hitsAt5Count}/${numEvaluated})`);
  console.log(`MRR:   ${mrr.toFixed(4)}`);
  console.log("=========================================\n");

  // Calibrate relatedMinScore:
  // Largest threshold that keeps at least 90% of expected papers' scores, rounded down to 0.01.
  if (expectedScores.length > 0) {
    const sortedScores = [...expectedScores].sort((a, b) => a - b);
    // 10th percentile score: 90% of scores are >= this score
    const p10Idx = Math.floor(0.10 * sortedScores.length);
    const p10Score = sortedScores[p10Idx];
    const calibratedMinScore = Math.floor(p10Score * 100) / 100;

    console.log(`Calibration of relatedMinScore:`);
    console.log(`Total expected papers found: ${expectedScores.length}`);
    console.log(`Min expected score: ${sortedScores[0].toFixed(4)}`);
    console.log(`10th percentile expected score: ${p10Score.toFixed(4)}`);
    console.log(`Calibrated relatedMinScore (>= 90% kept, rounded down to 0.01): ${calibratedMinScore.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error("Eval error:", err);
  process.exit(1);
});
