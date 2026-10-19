# Paper Search Plugin Smoke Test Checklist

- [ ] Opens with the hotkey (`Cmd+Shift+F`). The first keystroke shows keyword results in under 50 ms (no visible lag).
- [ ] Semantic results merge in after a pause, with no flicker and no lost selection.
- [ ] Enter opens Zotero at the right page (`zotero://open-pdf/library/items/<attachmentKey>?page=N`).
- [ ] Cmd+Enter inserts `[[citekey]]` at the cursor, matching Zotero Integration citeSuggestTemplate.
- [ ] Alt+Enter opens `<citekey>.md` if it exists, otherwise selects the item in Zotero (`zotero://select/library/items/<itemKey>`).
- [ ] Stop Ollama (`brew services stop ollama`) → keyword only, with footer: `semantic off: Ollama not reachable`. No error pop-ups.
- [ ] Rebuild the index while Obsidian is open → the next pop-up uses the new index.
