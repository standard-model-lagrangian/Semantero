import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ActiveEditorTracker, editorSnapshot } from "../src/editortracker.ts";

// Minimal stand-ins for Obsidian views: a leaf points back at its current view, as in Obsidian.
function markdownView(pathName: string, text = "note text", cursorOffset = 3, selection = "") {
  const leaf: any = {};
  const view: any = {
    leaf,
    file: { path: pathName },
    getViewType: () => "markdown",
    editor: {
      getValue: () => text,
      getSelection: () => selection,
      getCursor: () => ({ line: 0, ch: cursorOffset }),
      posToOffset: (pos: { ch: number }) => pos.ch,
    },
  };
  leaf.view = view;
  return view;
}

function panelView() {
  const leaf: any = {};
  const view: any = { leaf, getViewType: () => "semantero-related-papers" };
  leaf.view = view;
  return view;
}

test("ET1 remembers the last markdown view when the panel becomes active", () => {
  const t = new ActiveEditorTracker();
  const note = markdownView("a.md");
  t.onActiveLeafChange(note.leaf);
  t.onActiveLeafChange(panelView().leaf); // user clicks into the panel
  assert.strictEqual(t.get(), note);
});

test("ET2 switching notes tracks the newest markdown view", () => {
  const t = new ActiveEditorTracker();
  const a = markdownView("a.md");
  const b = markdownView("b.md");
  t.onActiveLeafChange(a.leaf);
  t.onActiveLeafChange(b.leaf);
  assert.strictEqual(t.get(), b);
});

test("ET3 a view whose leaf now shows something else is dropped", () => {
  const t = new ActiveEditorTracker();
  const a = markdownView("a.md");
  t.onActiveLeafChange(a.leaf);
  a.leaf.view = panelView(); // the leaf was reused / the note was closed
  assert.strictEqual(t.get(), null);
});

test("ET4 null leaves, views without an editor and non-markdown views are ignored", () => {
  const t = new ActiveEditorTracker();
  const a = markdownView("a.md");
  t.onActiveLeafChange(a.leaf);
  t.onActiveLeafChange(null);
  t.onActiveLeafChange({ view: { getViewType: () => "markdown" } }); // no editor
  t.onActiveLeafChange({ view: { getViewType: () => "pdf", editor: {} } });
  assert.strictEqual(t.get(), a);
});

test("ET5 seed() picks up the view that was active before the tracker existed", () => {
  const t = new ActiveEditorTracker();
  const a = markdownView("a.md");
  t.seed(a);
  assert.strictEqual(t.get(), a);
  t.seed(null);
  assert.strictEqual(t.get(), a);
});

test("ET6 editorSnapshot reads text, cursor offset, selection and path", () => {
  const snap = editorSnapshot(markdownView("notes/x.md", "hello world", 5, "hello"));
  assert.deepStrictEqual(snap, { text: "hello world", cursorOffset: 5, selection: "hello", filePath: "notes/x.md" });
  assert.strictEqual(editorSnapshot(null), null);
});

test("ET7 no source file looks up views by a string type (it throws in Obsidian)", () => {
  const srcDir = path.join(import.meta.dirname, "..", "src");
  for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith(".ts"))) {
    const code = fs.readFileSync(path.join(srcDir, f), "utf8");
    assert.ok(!/getActiveViewOfType\??\.?\(\s*["'`]/.test(code), `${f} calls getActiveViewOfType with a string`);
  }
});
