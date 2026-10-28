import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

/** The shared ranking core is this folder: launcher-core bundles it for JavaScriptCore. */
const CORE = path.resolve(import.meta.dirname, "../src/core");
const LAUNCHER_SRC = path.resolve(import.meta.dirname, "../../../launcher-core/src");

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

const tsFiles = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith(".ts")).map((n) => path.join(dir, n));

// T1: the launcher bundles these files without Obsidian, Electron, or Node built-ins
test("T1 core files import only each other: nothing from obsidian, Node or the rest of the plugin", () => {
  const files = tsFiles(CORE);
  assert.ok(files.length >= 10, "src/core/ holds the ranking core");
  for (const file of files) {
    for (const spec of importsOf(file)) {
      const name = path.basename(file);
      assert.ok(spec.startsWith("./"), `core/${name} imports "${spec}" (core files may only import each other)`);
      assert.ok(fs.existsSync(path.resolve(CORE, spec)), `core/${name} imports missing ${spec}`);
      assert.strictEqual(path.dirname(path.resolve(CORE, spec)), CORE, `core/${name} imports ${spec} from outside src/core/`);
    }
  }
});

test("T1b launcher-core reaches into the plugin only through src/core/", () => {
  for (const file of tsFiles(LAUNCHER_SRC)) {
    for (const spec of importsOf(file)) {
      if (!spec.includes("obsidian/paper-search")) continue;
      assert.ok(spec.includes("obsidian/paper-search/src/core/"), `${path.basename(file)} imports ${spec}`);
    }
  }
});
