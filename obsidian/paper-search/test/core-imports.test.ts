import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
const CORE = ["engine", "bm25", "rank", "text", "vectors", "ollama", "indexstore", "zotero", "textstore"];

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

// T1: the launcher bundles these files without Obsidian, Electron, or Node built-ins
test("T1 core files import nothing from obsidian (recursively)", () => {
  const seen = new Set<string>();
  const queue = CORE.map((n) => path.join(SRC, `${n}.ts`));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      assert.ok(spec.startsWith("."), `${path.basename(file)} imports bare module "${spec}" (core files may only import each other)`);
      assert.ok(!/obsidian|electron/.test(spec), `${path.basename(file)} imports ${spec}`);
      queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  assert.ok(seen.size >= CORE.length);
});
