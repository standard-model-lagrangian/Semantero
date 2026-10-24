import test from "node:test";
import assert from "node:assert";
import { checkHotkeyConflict } from "../src/hotkey.ts";
import fs from "node:fs";
import path from "node:path";

test("H1 the plugin declares no default hotkey in command registration", () => {
  const mainTs = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main.ts"), "utf8");
  // Check that addCommand for open-paper-search does NOT contain hotkeys: [...]
  const cmdMatch = mainTs.match(/id:\s*"open-paper-search"[\s\S]*?name:\s*"[^"]+"/);
  assert.ok(cmdMatch, "Expected open-paper-search command registration");
  const block = mainTs.slice(cmdMatch.index!, cmdMatch.index! + 300);
  assert.ok(!block.includes("hotkeys:"), "Command registration must NOT contain default hotkeys");
});

test("H2 conflict check names conflicting command when Mod+Shift+0 is taken, no notice if none", () => {
  // 1. Conflict exists
  const hotkeysWithConflict = {
    "some-other-plugin:some-command": [{ modifiers: ["Mod", "Shift"], key: "0" }],
  };
  const conflict = checkHotkeyConflict(hotkeysWithConflict, ["Mod", "Shift"], "0");
  assert.strictEqual(conflict, "some-other-plugin:some-command");

  // 2. Bound to our command itself -> no conflict
  const hotkeysOurs = {
    "semantero:open-paper-search": [{ modifiers: ["Mod", "Shift"], key: "0" }],
  };
  const conflictSelf = checkHotkeyConflict(hotkeysOurs, ["Mod", "Shift"], "0");
  assert.strictEqual(conflictSelf, null);

  // 3. Different key or modifiers -> no conflict
  const hotkeysDifferent = {
    "omnisearch:open": [{ modifiers: ["Mod"], key: "0" }],
  };
  const conflictDiff = checkHotkeyConflict(hotkeysDifferent, ["Mod", "Shift"], "0");
  assert.strictEqual(conflictDiff, null);
});
