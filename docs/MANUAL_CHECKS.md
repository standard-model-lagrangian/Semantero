# Paper Search Plugin Manual Test Checklist

## Quick Smoke Test Checklist

- [ ] Opens with the configured hotkey (`Mod+Shift+0` / `Cmd+Shift+F`). The first keystroke shows keyword results in under 50 ms (no visible lag).
- [ ] Semantic results merge in after a pause, with no flicker and no lost selection.
- [ ] Enter opens Zotero at the right page (`zotero://open-pdf/library/items/<attachmentKey>?page=N`).
- [ ] Cmd+Enter inserts `[[citekey]]` at the cursor, matching Zotero Integration citeSuggestTemplate. Creates literature note from template if enabled.
- [ ] Alt+Enter opens `<citekey>.md` if it exists, otherwise selects the item in Zotero (`zotero://select/library/items/<itemKey>`).
- [ ] Stop Ollama (`brew services stop ollama`) → keyword only, with footer: `semantic off: Ollama not reachable`. No error pop-ups.
- [ ] Rebuild the index while Obsidian is open → the next pop-up uses the new index.

---

## INTEGRATION_SPEC Manual Verification Checklist (M1–M12)

- [ ] **M1 Hotkey Binding:** The hotkey from `.obsidian/hotkeys.json` (e.g. `Mod+Shift+0`) opens the pop-up, and `Cmd+Shift+F` still opens Obsidian's own global search without conflict.
- [ ] **M2 Plugin Start Latency:** Obsidian starts with no visible delay from the plugin; the first search opened immediately after start shows a "Loading search index…" status row and switches cleanly to results once the background load finishes.
- [ ] **M3 Input Typing Fluidity:** Type quickly in the pop-up, one letter at a time: no UI stutter on the first letter of any word (ensured by binary search prefix bounds and precomputed term postings).
- [ ] **M4 Zotero Watcher Incremental Index:** Save a new paper in Zotero. Within 90 seconds it is findable by title in Obsidian, and `logs/zotero-watch.log` records exactly one index build.
- [ ] **M5 Zotero Watcher Idle Check:** Leave Zotero open and idle for 10 minutes, then check `logs/zotero-watch.log`: only `no changes` entries appear, and the index files (`papers.json`, `manifest.json`, `vectors.f32`) have untouched modification times.
- [ ] **M6 Literature Note Creation & Idempotency:** Press `Cmd+Enter` on a paper without an existing note → `[[citekey]]` is inserted at the cursor and `<folder>/<citekey>.md` is created from the template. Run `Cmd+Enter` again on the same paper → citation inserted, existing note preserved with no duplicate note created.
- [ ] **M7 Inline Trigger Context Exclusions:** Type `@@` followed by letters in a daily note, seminar note, inside a markdown list item, and inside a callout → citation suggestion list appears. Type `@@` inside a frontmatter block, inline code `` `...` ``, math blocks `$$...$$`, inline math `$..$`, or inside fenced code blocks ``` ``` → no suggestion list appears.
- [ ] **M8 Inline Undo Single Transaction:** Press `Enter` to select a paper from the `@@` suggestion list. Press Undo (`Cmd+Z`) immediately → restores the exact original typed trigger and query (e.g. `@@query`) in a single step.
- [ ] **M9 Pandoc Reference List Compatibility:** With the Pandoc Reference List plugin enabled, typing `@@` triggers only our paper search list, and typing `[@` triggers only Pandoc's list.
- [ ] **M10 Related Papers Panel Switching:** Open the Related Papers panel in the right sidebar. Browse between different notes in the main workspace: the panel stays unchanged and preserves the current query passage until the "Refresh" button is explicitly clicked (when auto-refresh is off).
- [ ] **M11 Related Papers Insertion:** Click the "Cite" button next to a paper in the Related Papers panel → inserts `[[citekey]]` (or configured citation template) directly into the last active cursor position of the current note.
- [ ] **M12 Ollama Graceful Degradation:** Stop Ollama via `brew services stop ollama` → the search pop-up and inline `@@` suggest list continue working with instant BM25 keyword results (marking semantic off in footer / single non-intrusive notice), and the Related Papers panel displays an informative "Ollama is not running" card. Restart Ollama via `brew services start ollama` → full hybrid search and related paper recommendations resume automatically.
