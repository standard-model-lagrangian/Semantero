# Launcher search: spec (test-driven)

One hotkey, from any app, opens a floating glass panel that searches your whole Zotero library **and** every Obsidian note at once. From a result you can open it where it lives (Zotero at the page, Obsidian at the heading), drop the file itself into the app you were just in (Mail, Teams, Claude, ChatGPT), paste the passage with its citation, or drag the file out. The same search is available from Spotlight.

Status: **implemented, manual checks outstanding** (see [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md#launcher-docslauncher_specmd-implementation-log) for the measured ranker decision, assumptions and deviations; this document describes the original design). Companion to [SEARCH_SPEC.md](SEARCH_SPEC.md) (whose index and ranking this reuses) and [INTEGRATION_SPEC.md](INTEGRATION_SPEC.md). Same rules: see [AGENTS.md](../AGENTS.md).

Scope of this pass: **Zotero items (PDFs and web snapshots) + Markdown notes inside the vault.** Out of scope: files outside the vault and Zotero storage (Downloads, iCloud, OneDrive), PDFs inside the vault (`povthesis_v2.pdf`). See [Later](#later).

## Principles

- **Same principles as paper search.**
  - Every word shown is the source's own.
  - Everything runs locally.
  - Keyword results arrive instantly; semantic results merge in after a pause.
  - Indexing never writes to Zotero.
- **No third-party closed source.** The app is this repository's own code. It uses only Apple's system frameworks (SwiftUI, AppKit, JavaScriptCore, Accelerate, Core Spotlight, App Intents, ServiceManagement, Carbon) and the open-source Swift toolchain. Xcode is used as a build tool, but nothing depends on an Xcode project file. There are no Swift package dependencies.
- **One ranking implementation until measurements say otherwise.** The ranking logic stays in the existing pure TypeScript core. The app runs it in JavaScriptCore, unless the spike shows a part must move to Swift (see [Ranker decision](#ranker-decision-javascriptcore-vs-swift)). Whatever runs it must pass one shared **conformance suite**, so the choice can be reversed safely.
- **The app stays running and keeps the index warm.** Opening the panel never loads an index. Loading happens at login and whenever the index changes, in the background.
- **The file is the result.** Every result knows its path on disk.
- **Tests first.** Every behaviour below has a named test, written before the code.

## Decision record

### Why a native app (and not Raycast, Hammerspoon or Script Kit)

| Option | Verdict |
|---|---|
| Spotlight only | Spotlight ranks its own index; a third party can't plug in a ranker for plain ⌘Space typing. Kept as two *extra* ways in (below), not the main one. |
| Raycast | Closed source. Ruled out by the owner. |
| Hammerspoon (MIT) | Plain chooser UI with no glass, Lua scripts, and it would need a resident Node server for the ranking. |
| Script Kit (MIT) | Node, so it reuses the TypeScript core directly. But it's Electron and niche (about 170 installs a year on Homebrew), so it's a maintenance risk. |
| **Native SwiftUI app** ✅ | Real Liquid Glass, a non-activating panel (pasting into the previous app just works), drag-out, Spotlight integration, all FOSS. Costs more Swift work. |

### Three ways in, one engine

1. **Hotkey panel** (primary): the full experience below.
2. **Spotlight action** "Search Everything" (App Intents). Type the action name in ⌘Space, press Tab, and type the query. Your ranker answers live. You pick a result and it opens. Fewer actions than the panel. **Gated by spike S3.**
3. **Spotlight index entries** (Core Spotlight). Paper titles, authors and citekeys, and note titles, appear in ordinary ⌘Space results, ranked by Spotlight. Selecting one opens it through the app. **Gated by spike S4.**

## What you get

### The panel

Default hotkey `⌥Space`, configurable in settings:

```
╭────────────────────────────────────────────────────────────────────────────────╮
│  🔍 stiffer gels slowed neural maturation                    All · Papers · Notes│
├──────────────────────────────────────────────┬─────────────────────────────────┤
│ ▸ 📄 Tunable hydrogel viscoelasticity…  p. 6 │ Tunable hydrogel viscoelasticity│
│      Roth et al. · 2023 · Science Advances   │ modulates human neural maturation│
│   📝 Viscoelastic properties in hydrogels    │ Roth, Bauer · 2023 · Sci. Adv.  │
│      Stress relaxation              20 Oct   │                                 │
│   📄 Next-generation cancer organoids  📝    │ "…faster **stress relaxation**  │
│      LeSavage et al. · 2022 · Nat. Mater.    │ accelerated neuronal **matur**… │
│   🗓 Tue 20 Oct 2026                         │                          p. 6   │
│      thoughts                       20 Oct   │ Roth 2023.pdf                   │
├──────────────────────────────────────────────┴─────────────────────────────────┤
│ ↵ Open in Zotero   ⌘↵ Paste PDF   ⌘⇧↵ Paste passage   ⌘K Actions   semantic ●│
╰────────────────────────────────────────────────────────────────────────────────╯
```

**Window**
- A borderless, non-activating floating panel with a Liquid Glass background. About 760 × up to 480 pt.
- Centred horizontally, about 22% from the top, on the screen with the mouse.
- Shows over full-screen apps and on every Space.

**Rows**
- Icons: 📄 Zotero item, 📝 note, 🗓 daily note.
- Line 2:
  - papers: `Authors · year · journal`;
  - notes: the heading path of the winning section (`Materials › EHS`), or the folder.
- Trailing accessory: `p. N` / `abstract` / `snapshot` for papers, the modified date for notes.
- A paper with a literature note shows `📝`; the paper and its literature note are **one** row (see [Literature notes](#literature-notes-collapse)).

**Detail pane** (`⌘D` toggles it, remembered)
- Title, metadata, and the snippet with query words in bold.
- Page or heading, and the file name.

**Scope**
- `⌘1` All · `⌘2` Papers · `⌘3` Notes. Remembered.
- Clicking the segmented control works too.

**Footer**
- The primary actions for the selected row, and a status dot: semantic ● on / ○ off, with a tooltip giving the reason.

**Empty query:** the 10 most recently modified notes. That's the "what was I just writing" view.

**Closing:** Esc, clicking outside, or any action that leaves the panel.

**Accessibility**
- Every row has a VoiceOver label (`Paper, Tunable hydrogel…, Roth et al. 2023, page 6`).
- With *Reduce Transparency* on, the glass falls back to an opaque material (SwiftUI does this; a manual check confirms the contrast).

### Actions

`⌘K` opens the action list for the selected row, filtered as you type.

| Key | Paper (has a PDF or snapshot) | Note |
|---|---|---|
| `↵` | Open the winning attachment in Zotero at the winning page (`zotero://open-pdf/…?page=N`, or `zotero://open/…` for a snapshot) | Open in Obsidian at the winning heading |
| `⌘↵` | **Paste the file** (the PDF itself) into the previous app | **Paste the file** (`.md`) into the previous app |
| `⌘⇧↵` | Paste the passage with its citation into the previous app | same |
| `⌘⇧C` | Copy the file to the clipboard | same |
| `⌘⌥C` | Copy the passage with its citation | same |
| `⌘⇧.` | Copy the absolute path | same |
| `⌘⇧F` | Show in Finder (file selected) | same |
| `⌘Y` / Space on an empty query field | Quick Look | same |
| `⌘L` | Copy `[[citekey]]` | Copy `[[Note name]]` |
| `⌘O` | Open the literature note (see [Literature notes](#literature-notes-collapse)) | — |
| `⌘⇧Z` | Select the item in Zotero | — |
| Drag the row | Drags the file (a file URL) into any app or the Finder | same |

- **Which file?** The attachment of the winning chunk; otherwise the item's first PDF; otherwise its first snapshot.
- **Paper with no attachment:** file actions are disabled, and `↵` selects the item in Zotero.
- **File missing on disk:** an inline error `File not found: <name>`. Nothing is written to the clipboard.

**How paste works** (`⌘↵`, `⌘⇧↵`): the panel never activates, so the app you were in stays frontmost.
1. Check that the file exists.
2. Write to the clipboard: the file URL, or the text for a passage.
3. Hide the panel.
4. After a 60 ms settle, post ⌘V with `CGEvent` to the HID event tap.

**Paste fallbacks** (each one is copy only, plus a message in a small toast near the menu bar):
- **No Accessibility permission:** "Copied, press ⌘V. Allow Daito Search in Privacy & Security → Accessibility to paste automatically." The toast has a button that opens that pane.
- **Secure input on** (a password field is focused; `IsSecureEventInputEnabled()`): "Copied, paste manually."
- **Setting "Restore clipboard after paste"** (default off): if on, the previous clipboard contents are put back after 750 ms.

**Citation text** (`⌘⇧↵`, `⌘⌥C`):
- Paper: `"…faster stress relaxation accelerated neuronal maturation…" (Roth et al., 2023, p. 6)`. `abstract` or `snapshot` takes the place of the page.
- Note: `"…only 53% batch to batch similarity…" (note: LeSavage 2022 Next generation cancer organoids › Materials › EHS)`.
- Authors: 1 → `Roth`, 2 → `Roth & Bauer`, 3 or more → `Roth et al.` Reuse `cite.ts` where it already does this.

### Menu bar and settings

- **No Dock icon** (`LSUIElement`). A menu bar item with:
  - Search (shows the hotkey);
  - Reload indexes;
  - index status (papers: N, built …; notes: N, built …; semantic on/off);
  - Settings…;
  - Quit.
- **Settings** (a SwiftUI `Settings` scene):
  - vault path (default `~/Documents/Obsidian Vault`);
  - hotkey;
  - Ollama URL (default `http://127.0.0.1:11434`);
  - result limit (15);
  - restore clipboard after paste (off);
  - Spotlight: add papers (on), add note titles (on), add note text (**off**);
  - launch at login (on).
- **Storage:** settings live in `UserDefaults`. The Zotero storage path comes from the papers manifest.
- **Launch at login:** `SMAppService.mainApp`.

## Architecture

```
 Zotero (read-only)          daito (Python, offline)                     Daito Search.app (Swift, resident)
 ──────────────────          ───────────────────────                     ──────────────────────────────────
 zotero.sqlite ─► zotlib ─┐                                              IndexWatcher (FSEvents on .planner/)
                          ├─► searchindex ─► .planner/search/ ─┐                   │ content_hash changed
 storage/* ─► pdftext ────┘   (+ file paths)                   ├──── mmap/read ──► Ranker ◄── query vector ── OllamaClient
                                                               │                    │  (JSC: ranker.js  │  or Swift parts)
 vault/**/*.md ─► mdtext ───► notesindex ──► .planner/notes/  ─┘                    ▼
                                   │                                     ResultVM[] (JSON view model)
                                 embed ─► Ollama                                    │
                                                         ┌──────────────────────────┼─────────────────────────┐
                                                         ▼                          ▼                         ▼
                                                   Panel (SwiftUI)        SearchIntent (Spotlight)   SpotlightDonor (CS index)
                                                         │
                                                  ActionExecutor ─► NSPasteboard · CGEvent ⌘V · NSWorkspace · QuickLook
```

**The boundary that keeps the ranker decision cheap:** the ranker's only output is a list of **`ResultVM`**, a plain JSON view model. It already contains everything the UI and actions need:
- IDs, kind, title, subtitle, accessory and snippet (with bold ranges);
- the absolute file path, the open URL and the citation text;
- the list of available action IDs.

Swift never re-derives any of this. It renders the list and carries out actions by ID. Whether `ResultVM` is produced by TypeScript in JavaScriptCore or by Swift, the UI and the actions don't change.

```ts
interface ResultVM {
  id: string;                    // "P:<itemKey>" | "N:<noteKey>"; stable across rebuilds
  kind: "paper" | "note" | "daily" | "litnote";
  title: string;
  subtitle: string;
  accessory: string;             // "p. 6" | "abstract" | "snapshot" | "20 Oct"
  snippet: string;
  snippetBold: [number, number][]; // UTF-16 ranges, so Swift can apply them to AttributedString directly
  hasNote: boolean;              // paper with a collapsed literature note
  filePath: string | null;       // absolute, validated inside its root
  openUrl: string;               // the ↵ target
  noteUrl: string | null;        // ⌘O target
  selectUrl: string | null;      // ⌘⇧Z target
  citation: string;              // passage with its citation
  wikilink: string;
  actions: string[];             // ids from shortcuts.json, in menu order
  detail: { label: string; value: string }[];
  source: "keyword" | "semantic" | "both";
}
```

**`shortcuts.json`** (in `launcher-core/`) is the single table of action IDs, titles and key equivalents. TypeScript tests check the action lists against it; Swift reads it to build the key map and the `⌘K` menu.

## Index changes (Python)

### Papers (`.planner/search/`): add file paths

`papers.json` gains a `file` field on each attachment. No format bump: the plugin ignores unknown fields.

```json
"pdfs":      [{"attachmentKey": "EF56GH78", "pages": 14, "hasText": true, "file": "EF56GH78/Roth 2023.pdf"}],
"snapshots": [{"attachmentKey": "IJ90KL12", "hasText": true, "file": "IJ90KL12/index.html"}]
```

- **Stored attachments** (`storage:` prefix): `file` is relative to `<zotero_dir>/storage/`.
- **Linked files:** `file` is the absolute path. A leading `/` tells them apart.
- **`manifest.json` gains `"zotero_storage"`** (absolute, `~` expanded).
- Paths come from the existing `zotlib.attachment_path`.
- **Upgrade:** the content hash changes once; the first build after upgrading rewrites the index once, with no re-embedding.

### Notes (`.planner/notes/`): new corpus, same format

Same four files, the same atomic write (`notes.tmp/` → swap) and `state.json` as the papers index. It has its own lock, `.planner/notes.lock`.

**`manifest.json`**
```json
{
  "format": 1,
  "corpus": "notes",
  "built_at": "2026-10-21T11:05",
  "content_hash": "…",
  "model": "qwen3-embedding:0.6b",
  "dims": 1024,
  "query_instruction": "Given a description of what a paper found or showed, retrieve that paper",
  "chunker": "md-headings-v1",
  "vault": "/Users/you/Documents/Obsidian Vault",
  "vault_name": "Obsidian Vault",
  "papers": 141,
  "chunks": 820,
  "degraded": false
}
```

`model`, `dims` and `query_instruction` are copied from `[search]`, so one query vector serves both corpora.

**`papers.json`**: one entry per note, in the `PaperMetadata` shape so `BM25Index` and `engine.ts` work unchanged. The mapping is deliberate:

| `PaperMetadata` field | Note value | BM25 weight |
|---|---|---|
| `key` | `N` + first 10 hex digits of sha1 of the vault-relative path | — |
| `citekey` | basename without `.md` | ×3 |
| `title` | frontmatter `title`, else the first `# H1`, else the basename. Daily notes: `Tue 20 Oct 2026` | ×3 |
| `authors` | `[]` | — |
| `year` | `null` | — |
| `journal` | `null` | — |
| `tags` | frontmatter `tags` + inline `#tags` + frontmatter `aliases` (aliases are searchable this way) | ×2 |
| `collections` | `[folder]`, `[]` at the vault root | ×2 |
| `abstract` | the **lead**: cleaned text from the start of the body, up to `lead_words` words | ×1.5 |
| `abstractRow` | vector row of `"{title}\n\n{lead}"` | — |

Extra fields (ignored by BM25):
```json
{ "kind": "note", "path": "Viscoelastic properties in hydrogels.md", "mtime": 1792573800, "litnoteOf": null }
```
- `kind`: `note` · `daily` (matches `daily_folder` and `YYYY-MM-DD.md`) · `litnote`.
- `path`: relative to the vault.
- `mtime`: seconds since the epoch.

**`chunks.json`**: `{ "paper": i, "attachmentKey": "", "page": 0, "text": "…", "row": r, "heading": "Materials › EHS", "line": 23 }`
- `heading`: the heading path of the source section (`""` before the first heading).
- `line`: the 1-based line in the file where the section starts.
- `ChunkDocument` in `bm25.ts` gains these two optional fields (types only).

**`vectors.f32`**, **`state.json`**: as for papers. State is keyed per note path: `{mtime, size, sha, rows}`.

### Which notes are indexed

- **Included:** every `*.md` under the vault, recursively.
- **Always excluded:**
  - dot-folders: `.obsidian/`, `.planner/`, `.trash/`, `.git/`;
  - anything matched by `[notes].exclude` globs (vault-relative, `**` supported).
- **Default `exclude`:** `Templates/**`, `Threads.md`, `Zotero Template.md`, `Zotero Citation Template.md`.
- **Personal notes you don't want surfaced** (bank details, travel documents) go in `exclude`. Excluded notes are never opened. They never reach the index, Spotlight, or a snippet.
- **Empty after cleaning** (fewer than 3 words): an entry with no chunks and no row, so the note is still findable by title.

### Markdown cleaning (`mdtext`)

In order:
1. **Frontmatter:** parse the leading `---` YAML block (`title`, `tags`, `aliases`, `citekey`; lists, or comma/space-separated strings), then remove it. Malformed YAML → treat the block as body text, never crash.
2. **Remove generated blocks:**
   - the brief: `%% planner:start %%`…`%% planner:end %%`;
   - Threads: `%% planner:threads:start %%`…`%% planner:threads:end %%`;
   - any other `%%…%%` comment, inline or multi-line.
3. **Remove embeds:** `![[…]]` and `![alt](…)`.
4. **Simplify links:**
   - `[[Target|alias]]` → `alias`;
   - `[[Target#Heading]]` → `Target Heading`;
   - `[[Target]]` → `Target`;
   - `[text](url)` → `text`;
   - bare URLs are kept as written.
5. **Strip markup but keep the words:**
   - list markers, `> ` callout prefixes and `[!type]` headers;
   - emphasis markers, table pipes, HTML tags.

   Fenced code is kept as text, but inline `#tags` inside code aren't collected.
6. **Split into sections** at ATX headings (`#` to `######`). Each section records its heading path and start line. Text before the first heading has heading `""`.
7. **Chunk each section** at about `chunk_words` words with `chunk_overlap_words` overlap, never crossing a section boundary.
   - A section shorter than `min_section_words` merges into the next section of the same or deeper level, keeping its own heading.
   - A trailing short section merges back into the previous one.

### Literature notes (collapse)

- **When a note counts as a literature note:** its frontmatter `citekey` matches a citekey in `.planner/search/papers.json`, **or** its basename does (case-sensitive). It gets `kind: "litnote"` and `litnoteOf: <citekey>`.
- **One row in results:** when a literature note and its paper both appear, they merge into the **paper's** row, at the better of the two positions.
  - The snippet comes from whichever of the two ranked higher.
  - If the note's text won, the row shows the note's heading, and `↵` opens the note.
  - `⌘O` always opens the note.
- **Literature note without its paper in the results:** it stays a note row, with `⌘⇧Z` available.
- **Paper with no literature note:** `⌘O` opens `obsidian://new?vault=…&file=<citekey>`. The Obsidian plugin's template isn't applied this way. Manual check N-M9 confirms what happens, and the outcome is logged.

### Config (`config.toml`)

```toml
[notes]
enabled = true
exclude = ["Templates/**", "Threads.md", "Zotero Template.md", "Zotero Citation Template.md"]
chunk_words = 200            # settled by the evaluation
chunk_overlap_words = 40
min_section_words = 25
lead_words = 120
max_chunks_per_note = 60
# model, dims, query_instruction, batch_size, keep_alive come from [search]
```

Changing `model` or `dims` in `[search]`, or the `chunker` name, forces a full notes rebuild.

### CLI, tick and doctor

| Command | Effect |
|---|---|
| `planner notes index [--full]` | Build or update; prints counts, time, notes embedded, notes skipped |
| `planner notes stats` | Notes per kind, chunks, literature notes matched, excluded count, model, age, degraded |

- **Tick:** every 5-minute `planner morning` check runs `notes index` after its own work, with a non-blocking lock.
  - **Lock busy:** skip.
  - **Ollama down:** keyword-only fallback (`degraded: true`; the next run embeds what's missing).
  - **Any other failure:** logged, never raised. It becomes a `⚠ Setup:` warning only if the index is more than a day old.
- **Doctor** (`planner doctor`, `doctor --search`):
  - the notes index exists and is less than 1 day old;
  - `model` and `dims` match `[search]`;
  - not degraded for more than 1 day;
  - the `exclude` globs are valid;
  - `Daito Search.app` is in `/Applications` and registered as a login item (a warning, not a failure).

## Ranking (TypeScript, `launcher-core/`)

### Merging the two corpora

Both corpora use the same model, dims and query instruction, so **one query vector** serves both, and cosine scores are directly comparable. BM25 scores aren't comparable (different vocabularies and IDF), so keyword lists merge by rank.

```
kwP  = keyword(papers, q, all)    semP = semantic(papers, v, all)
kwN  = keyword(notes,  q, all)    semN = semantic(notes,  v, all)

kw   = interleave(kwP, kwN)                  # P1, N1, P2, N2, …  (papers first on equal rank)
sem  = sortByCosine(semP ∪ semN)             # comparable: same vector, same model
hits = rrf([kw, sem], k = 60) → collapse litnotes → top limit → snippets → ResultVM
```

- **Scope `Papers` or `Notes`:** the other corpus is never searched.
- **Before semantic results arrive** (or with Ollama down): `kw` alone, after collapsing literature notes.
- **A corpus that's missing or bad:** the other corpus only, and the status says why.
- **A corpus whose manifest `model` or `dims` differ from the other's:** keyword-only for that corpus.
- **If the evaluation shows notes need their own instruction:** per-corpus vectors and `sem = interleave(semP, semN)`. That's a decision recorded with eval numbers.
- **Gating and stale responses:** reuse `shouldRunSemantic` from `rank.ts`, and sequence numbers that drop out-of-date responses. The app debounces at `debounce_ms` (default 200 ms), as the plugin does.

### Engine refactor (small, behaviour-preserving)

Split `semantic()` in `engine.ts` into two steps:
1. computing row scores (the dot-product loop);
2. **`semanticFromRowScores(ix, rowScores: Float32Array, query, opts)`**, which does the per-paper maximum, winning row, candidate sort and snippets.

`semantic()` becomes the first step followed by the second, so its output doesn't change; the plugin's existing tests and goldens prove it. This lets a Swift implementation of the vector pass (option **B** below) reuse every line of the per-paper logic.

### `launcher-core/` (pure TypeScript, no Node or DOM APIs in `src/`)

| File | Responsibility |
|---|---|
| `src/corpora.ts` | Build both `LoadedIndex`es from **in-memory** inputs (manifest JSON, papers JSON, chunks JSON, an `ArrayBuffer` of vectors) using `IndexStore.precomputeIndex`; health flags |
| `src/merge.ts` | `interleave`, `sortByCosine`, `rrf`, `collapseLitnotes` |
| `src/query.ts` | `keyword(q, scope, limit)`, `hybrid(q, vec, scope, limit)`, `hybridFromRowScores(q, scoresP, scoresN, scope, limit)`, `recent(limit)`. Each returns `ResultVM[]` |
| `src/paths.ts` | Absolute paths, containment check, "which file" choice |
| `src/urls.ts` | Obsidian URLs; re-exports the Zotero URLs from the plugin's `zotero.ts` |
| `src/cite.ts` | Author formatting, passage citations, wikilinks |
| `src/vm.ts` | Hit → `ResultVM` (subtitle, accessory, bold ranges, detail rows, action list) |
| `src/api.ts` | The JavaScriptCore entry point: `globalThis.daito = { load, keyword, hybrid, hybridFromRowScores, recent, version }`. All arguments and results are JSON strings except `ArrayBuffer`s |
| `shortcuts.json` | Action IDs, titles, key equivalents, and which kinds each applies to |
| `node/fsload.ts` | Node only: read a vault's indexes from disk for tests and `eval.ts` |
| `scripts/eval.ts` | Evaluation CLI |
| `scripts/record-conformance.ts` | Writes the conformance fixtures (see [Tests](#tests)) |
| `build.mjs` | esbuild → `dist/ranker.js` (IIFE, ES2022, no Node built-ins; fails the build if any is pulled in) |

- **Imports:** the core is imported from `../obsidian/paper-search/src/*.ts` by relative path.
- **Bundling:** `dist/ranker.js` is committed, like the plugin's `main.js`. `make check` fails if it's stale.
- **Dependencies:** esbuild is already a dev dependency.

## The app (Swift)

### Layout and build

```
macos/
  Package.swift                 swift-tools-version 6.2, platforms [.macOS(.v26)], no dependencies
  Sources/
    DaitoSearchKit/             library: everything testable, no SwiftUI views
      IndexFiles.swift          locate + read/mmap both corpora, content_hash, validation
      IndexWatcher.swift        FSEvents on <vault>/.planner, 500 ms debounce, reload on hash change
      Ranker.swift              protocol Ranker + RankerActor (serialises access, owns the engine)
      JSCRanker.swift           JavaScriptCore implementation (loads ranker.js from the bundle)
      VectorScorer.swift        Accelerate row scoring (option B/C only; built in the spike)
      OllamaClient.swift        query embedding: instruction, truncate, normalise, timeout, warm-up
      QueryController.swift     debounce, sequence numbers, keyword-now / semantic-later, scope
      ResultVM.swift            Codable mirror of the TS view model
      Shortcuts.swift           decode shortcuts.json → key map + menu
      ActionExecutor.swift      run an action id against injected Pasteboard/EventPoster/Workspace/Clock
      Hotkey.swift              "⌥Space" ⇄ Carbon key code + modifiers; RegisterEventHotKey wrapper
      SpotlightDonor.swift      Core Spotlight diff + donate (injected index for tests)
      Settings.swift            typed UserDefaults
    DaitoSearch/                executable: the app
      App.swift                 @main, MenuBarExtra, Settings scene, login item
      Panel.swift               NSPanel subclass (non-activating, floating, all Spaces) + positioning
      SearchView.swift          SwiftUI: field, list, detail, footer, glass
      ActionMenu.swift          ⌘K list
      QuickLook.swift           QLPreviewPanel data source
      Intents.swift             SearchEntity, EntityStringQuery, OpenResultIntent, AppShortcuts (gated by S3)
      SpotlightOpen.swift       NSUserActivity (CSSearchableItemActionType) → open
  Tests/DaitoSearchKitTests/    Swift Testing
  Resources/Info.plist          LSUIElement, bundle id dev.daito.search, usage strings
  scripts/bundle.sh             swift build -c release → Daito Search.app, copy ranker.js + shortcuts.json, codesign
```

- **Build:** `make app` runs `launcher-core` build → `swift build` → `scripts/bundle.sh`, which assembles `build/Daito Search.app`.
- **Install:** `make install-app` copies it to `/Applications`, so Launch Services, Spotlight and App Intents see it.
- **Signing:** with the free Apple ID "Personal Team" development certificate, so the Accessibility and other privacy permissions survive rebuilds. Ad-hoc signing works but forces you to grant the permission again after each build.
- **App Intents metadata:** a plain SwiftPM build doesn't produce it. If spike S3 passes, `bundle.sh` runs `xcrun appintentsmetadataprocessor` explicitly. If that turns out impractical, the S3 decision entry says so, and an `xcodebuild` scheme over the same package is added for this one step.
- **`make check`** adds `swift test --package-path macos` and the `ranker.js` freshness check.

### Panel behaviour

- **The panel:**
  - `NSPanel` with `.nonactivatingPanel`, `.borderless` and `.fullSizeContentView`;
  - `level = .floating`;
  - `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]`;
  - `canBecomeKey = true`, so the field types but the previous app stays active.
- **Glass:** the content is a SwiftUI view inside `GlassEffectContainer`, with `.glassEffect(.regular, in: .rect(cornerRadius: 22))`. Rows use plain backgrounds; the selected row uses a tinted glass capsule.
- **Hotkey:**
  - opens the panel with the field focused and its text selected (the last query is kept for 60 s, then cleared);
  - pressing it again while open closes the panel.
- **Keys:** handled with `.onKeyPress` and a key-equivalent map built from `shortcuts.json`. ↑/↓ and ⌃N/⌃P move the selection; Esc closes.
- **Freshness on open:** `ensureFresh` compares `content_hash`, a stat of two files (budget B7); FSEvents normally reloaded already. A reload swaps the engine atomically, and the selection is kept if the same ID is still in the list (B14).
- **Ollama warm-up** fires when the panel opens (non-blocking).

### Ranker decision: JavaScriptCore vs Swift

This is decided **by measurement in spike S1**, recorded in `DECISIONS_AND_GAPS.md` with the numbers, and reversible because every option produces the same `ResultVM`s and must pass the same conformance suite.

**The three options**

| | Keyword, merge, snippets, view model | Vector pass (row scores) | Implementations of ranking logic |
|---|---|---|---|
| **A: JSC everything** | TypeScript in JavaScriptCore | TypeScript in JavaScriptCore | 1 |
| **B: JSC + Accelerate** | TypeScript in JavaScriptCore | Swift: `cblas_sgemv` over the memory-mapped `vectors.f32`, then `hybridFromRowScores` | 1 (Swift adds about 30 lines of maths, no ranking logic) |
| **C: Swift port** | Swift | Swift (Accelerate) | 2: TypeScript stays the reference for the plugin; Swift must match it via conformance |

**What S1 measures** on (a) the real index and (b) the 3× synthetic index (`make-synthetic-index.ts`) plus a synthetic 2,000-note corpus. It uses a **release, signed, hardened-runtime** build, so JIT behaviour is the real one.

| ID | Measure | How |
|---|---|---|
| M1 | Background load: files → engine ready for keyword | `ContinuousClock` around `load`, 10 runs, median and max |
| M2 | Keyword per keystroke, **including** the JSON round trip into Swift `ResultVM`s | 1,000 prefix queries from `eval/queries.toml`, p50 and p95 |
| M3 | Semantic scoring + merge, excluding Ollama | 200 queries with fixed vectors, p50 and p95 |
| M4 | Resident memory after load | `task_info` phys_footprint |
| M5 | JSON bridge cost alone | encode/decode of 15 `ResultVM`s, p95 |
| M6 | JIT active under the hardened runtime | M3 with and without `com.apple.security.cs.allow-jit`; a slowdown above 3× means the JIT was off |
| M7 | Swift `sgemv` row scoring (for B and C) | same queries as M3 |

**Budgets** (these are also the app's acceptance budgets L2–L4 and L7):

| ID | Budget |
|---|---|
| M1 | ≤ 1.5 s at 1×, ≤ 4 s at 3× (background, at login or after a rebuild; never on panel open) |
| M2 | p95 ≤ 16 ms at 1×, ≤ 25 ms at 3× |
| M3 | p95 ≤ 40 ms at 1×, ≤ 80 ms at 3× |
| M4 | ≤ 250 MB at 1×, reported at 3× |
| M5 | p95 ≤ 2 ms |

**Decision rules, applied in order**
1. If the hardened-runtime build only meets M2/M3 with `allow-jit`, add that entitlement. It's a normal, documented entitlement for apps that run JavaScriptCore. Re-measure with it.
2. If **A** meets every budget with **at least 1.5× headroom** → choose **A**. That leaves one implementation, and the plugin and the app can't drift.
3. Else, if A misses only on **M3** (semantic) and **B** meets M3 with at least 1.5× headroom → choose **B**.
4. Else, if A misses on **M1, M2, M4 or M5** (load, keystroke, memory, bridge):
   - first try the cheap fixes and re-measure:
     - pass the JSON files as `ArrayBuffer`s and parse them in JS (avoids a Swift `String` copy);
     - build snippets only for the visible rows;
     - batch keystrokes (only the latest query in flight);
   - if it still misses → choose **C**.
5. **C requires** the full conformance suite passing in `swift test`, plus a port of every unit test case from `bm25.test.ts`, `text.test.ts` and `rank.test.ts`, before it replaces A or B. TypeScript stays the reference: when ranking changes, TypeScript changes first, the conformance fixtures are re-recorded, and Swift must match.
6. **Tie-breaks** (when two options both pass): prefer fewer implementations, so A over B over C.

**When to reopen the decision** (as a doctor or `DECISIONS` note, never automatically):
- the library grows past 3× today's size;
- a budget regresses for 2 weeks in daily use;
- a macOS update changes JavaScriptCore performance (re-run `make bench-app`);
- you want the ranker in a separate process (an App Intents extension, for example), where JavaScriptCore start-up cost would count again.

**JSCRanker details** (option A or B):
- **Threading:** one `JSVirtualMachine` and one `JSContext`, owned by `RankerActor` (a Swift actor). JavaScriptCore is never touched off that actor.
- **Loading:**
  - `vectors.f32` is memory-mapped (`Data(contentsOf:options: .alwaysMapped)`) and passed as an `ArrayBuffer` with `JSObjectMakeArrayBufferWithBytesNoCopy`, with the deallocator holding the `Data` alive;
  - the JSON files are passed as `ArrayBuffer`s and decoded in JS.
- **Reloading:** a new `JSContext` is built off to the side and swapped in only after `load` succeeds. A failed load keeps the old one.
- **Errors:** a JS exception (via `context.exceptionHandler`) becomes a Swift `RankerError` carrying the message and stack. It is never a crash.
- **Version check:** `daito.version` must match the app's expected `ranker.js` version; on a mismatch the app shows an error and stays keyword-off.

### Spotlight action (App Intents): gated by S3

- **`SearchEntity: AppEntity`:**
  - `id` = `ResultVM.id`;
  - `displayRepresentation` = title, subtitle, and an SF Symbol per kind (`doc.text`, `note.text`, `calendar`).
- **`SearchEntityQuery: EntityStringQuery`:**
  - `entities(matching:)` → `ranker.hybrid` (or keyword if Ollama is slow, with a 400 ms cap on waiting for the vector), top 10;
  - `suggestedEntities()` → `recent(10)`;
  - `entities(for:)` resolves IDs from the current engine.
- **Intents:**
  - `OpenResultIntent(item: SearchEntity)` does the `↵` action;
  - `RevealResultIntent` does Show in Finder;
  - `CopyFileIntent` copies the file to the clipboard.
  - All have `openAppWhenRun = false`.
- **`AppShortcutsProvider`** with the phrase "Search Everything in \(.applicationName)".
- Intents live in the **app target**, not an extension, so they share the warm engine. That's why the app must be running; launch at login covers it.

### Spotlight index entries (Core Spotlight): gated by S4

- **`SpotlightDonor`** keeps `CSSearchableIndex(name: "daito")` in sync whenever `content_hash` changes:
  - papers: domain `papers`; one item per paper (`uniqueIdentifier` = `P:<itemKey>`);
  - notes: domain `notes`; one per note.
- **Paper attributes:**
  - `title`;
  - `contentDescription` = `Authors · year · journal`;
  - `keywords` = citekey + tags + collections;
  - `contentURL` = the file URL when there is one.

  **The abstract is not donated** (Spotlight would rank on it and duplicate results).
- **Note attributes:**
  - `title`;
  - `contentDescription` = folder and modified date;
  - `keywords` = tags and aliases.

  Note text is donated **only** when the "add note text" setting is on (default off).
- **Diffing:** a per-item hash of the donated attributes is stored in `Application Support/Daito Search/spotlight.json`. Only changed items are re-donated and only removed ones deleted. Turning a domain off deletes it.
- **Opening:** a selected Spotlight item reaches the app as an `NSUserActivity` with `CSSearchableItemActionType`. The app resolves the ID and runs `↵`.

## Opening things

| Target | How |
|---|---|
| Paper PDF at page | `zotero://open-pdf/library/items/<attKey>?page=N` |
| Snapshot | `zotero://open/library/items/<attKey>` |
| Zotero item | `zotero://select/library/items/<itemKey>` |
| Note | `obsidian://open?vault=<vault_name>&file=<path without .md>`, URI-encoded |
| Note at heading | as above, with `%23<last heading>` appended to `file`. **Manual check N-M3.** If Obsidian ignores it, fall back to the file and log it. |
| Open a URL | `NSWorkspace.shared.open(url)` |
| Paste file / text | `NSPasteboard.general` (`writeObjects([url as NSURL])` or a string) → hide → `CGEvent` ⌘V |
| Copy file | the same write, with no ⌘V |
| Finder | `NSWorkspace.shared.activateFileViewerSelecting([url])` |
| Quick Look | `QLPreviewPanel.shared()` with the selected file |
| Drag | `.draggable(url)` / `NSItemProvider(contentsOf: url)` |

**Absolute path resolution** (`paths.ts`):
- papers: `zotero_storage + "/" + file`, or `file` itself when it's absolute;
- notes: `vault + "/" + path`.
- A path that resolves outside its root (`..` escapes) is rejected, and the row loses its file actions.

## Tests

- **Frameworks:** Python uses `unittest`, TypeScript uses `node --test`, and Swift uses **Swift Testing** (`swift test`).
- **No test calls a real model:** embeddings come from the existing fake embedder, and Ollama is faked over an injected `URLProtocol`.
- **No test touches the real clipboard, keyboard, Spotlight index or Launch Services:** each sits behind an injected protocol with a fake.
- **Live tests** (real Ollama, real index, real pasteboard) run only with `DAITO_LIVE=1`.

### Fixtures

- **`tests/fixtures/notes/vault_small/`** (about 10 files):
  - `2026-10-20.md`: a daily note with a brief block and `status/done`;
  - `Organoid bottlenecks.md`: frontmatter tags and aliases, three heading levels, a 10-word section, aliased wikilinks, an embed, a `%%comment%%`, a code fence containing `#include`;
  - `roth2023tunable.md`: frontmatter `citekey: roth2023tunable` (a literature note);
  - `lesavage2022next.md`: basename is a citekey, no frontmatter;
  - `Reviews/2026-W42.md`;
  - `Templates/Daily.md`, `Threads.md`: excluded by default;
  - `Private/bank.md`: excluded by a test glob;
  - `empty.md`;
  - `bad-yaml.md`;
  - `.obsidian/workspace.md`.
- **`tests/fixtures/search/index_small/`** (existing): re-recorded with `file` and `zotero_storage`.
- **`launcher-core/test/fixtures/notes_small/`**: a 5-note index with `dims = 8`, built by running `notesindex` with the fake embedder over `vault_small`. It's committed, and `make fixtures` rebuilds it.
- **`launcher-core/conformance/`**: `cases.json` contains about 60 cases over `index_small` + `notes_small`:
  - queries with complete and incomplete last tokens;
  - each scope;
  - keyword-only, and hybrid with fixed vectors;
  - literature note collapse;
  - empty query → recent;
  - Unicode;
  - ties.

  Each case records the expected `ResultVM[]`, written by `record-conformance.ts` from the TypeScript implementation. **This is the contract every ranker must meet**, compared field by field, with scores compared only through order.

### Python: `tests/test_notes_index.py`, plus additions to `tests/test_search_index.py`

**Papers: file paths**
1. `test_stored_attachment_file_is_relative_to_storage`
2. `test_linked_attachment_file_is_absolute`
3. `test_snapshot_has_file`
4. `test_manifest_has_expanded_zotero_storage`
5. `test_adding_file_field_does_not_reembed`: 0 embed calls; the content hash changes.

**mdtext**
6. `test_frontmatter_title_tags_aliases_citekey`: list and string forms.
7. `test_malformed_frontmatter_is_body_not_crash`
8. `test_title_fallbacks`: frontmatter > H1 > basename; daily → `Tue 20 Oct 2026`.
9. `test_planner_blocks_and_comments_removed`
10. `test_links_simplified_embeds_removed`
11. `test_markup_stripped_words_kept`
12. `test_inline_tags_collected_not_in_code`
13. `test_sections_have_heading_path_and_line`
14. `test_chunks_never_cross_sections_and_overlap`
15. `test_short_section_merges_forward_or_back`
16. `test_lead_is_first_lead_words_of_clean_body`
17. `test_max_chunks_per_note_caps`

**notesindex** (fake embedder)
18. `test_scan_respects_dotfolders_defaults_and_globs`: excluded files are **never opened** (a patched `open` asserts it).
19. `test_kinds_daily_note_litnote`
20. `test_litnote_by_frontmatter_and_by_basename`: papers index missing → no literature notes, no crash.
21. `test_full_build_consistent`: rows in range, byte count, unit length, `heading` and `line` on every chunk.
22. `test_incremental_noop_zero_embeds_zero_writes` (L5)
23. `test_edited_note_reembeds_only_that_note`
24. `test_touched_but_unchanged_note_not_reembedded`
25. `test_renamed_note_reuses_vectors`
26. `test_deleted_note_disappears_rows_compact`
27. `test_model_dims_or_chunker_change_forces_full`
28. `test_ollama_down_writes_degraded_keyword_index_then_recovers`
29. `test_atomic_write_never_partial`
30. `test_empty_note_has_entry_no_rows`
31. `test_manifest_copies_search_model_dims_instruction_and_vault_name`

**CLI, tick and doctor**
32. `test_tick_runs_notes_index_after_daily_work_and_swallows_failure`
33. `test_tick_skips_when_notes_lock_busy`
34. `test_setup_warning_only_when_notes_index_older_than_a_day`
35. `test_doctor_notes_checks`
36. `test_doctor_app_installed_is_warning_not_failure`

### TypeScript: plugin guards (`obsidian/paper-search/test/`)

T1. `core files import nothing from obsidian`: parses imports recursively from `engine`, `bm25`, `rank`, `text`, `vectors`, `ollama`, `indexstore` and `zotero`.
T2. `semantic() equals rowScores + semanticFromRowScores`: on `index_small` and on random 200 × 8 data; the existing goldens are unchanged.

### TypeScript: `launcher-core/test/*.test.ts`

**corpora**
R1. `builds both corpora from in-memory buffers`
R2. `missing notes corpus → papers only with health flag` (and the reverse)
R3. `manifest model mismatch marks that corpus keyword-only`
R4. `bad vectors length → keyword-only for that corpus, no throw`

**merge**
R5. `interleave alternates by rank, papers first on ties, handles unequal lengths`
R6. `sortByCosine merges by raw score across corpora`
R7. `rrf over kw and sem: an item in one list only still ranks`
R8. `keyword-only path equals interleave after collapse`
R9. `collapseLitnotes: paper + its litnote → one row at the better position`
R10. `collapse: the litnote ranked higher → note snippet, note heading, ↵ opens the note`
R11. `collapse: litnote whose paper is absent stays a note row`
R12. `deterministic order for equal scores` (corpus, then index)

**query**
R13. `scope Papers never reads the notes corpus` (a spy on `LoadedIndex` access)
R14. `hybridFromRowScores equals hybrid for the same vector`
R15. `empty query → recent notes by mtime, limit 10`
R16. `query with only stopwords returns [] without throwing`

**paths / urls**
R17. `relative zotero file resolves under storage; absolute linked file kept`
R18. `.. escape rejected → filePath null and no file actions`
R19. `which file: winning chunk's attachment > first PDF > first snapshot > none`
R20. `obsidian open URL encodes spaces, &, #, unicode; strips .md; heading appended as %23`

**cite / vm / shortcuts**
R21. `authors 1/2/≥3 formatting`
R22. `paper citation with page, abstract, snapshot`
R23. `note citation with heading path; lead row cites the title only`
R24. `wikilinks: [[citekey]] for papers, [[Note name]] for notes`
R25. `snippetBold ranges are UTF-16 offsets that cover query tokens` (including an emoji and an accented word before the match)
R26. `action list per kind: paper-with-pdf, paper-no-attachment, snapshot-only, note, daily, collapsed litnote`
R27. `shortcuts.json: unique ids, unique key equivalents, every action id used by vm.ts exists`

**api / bundle**
R28. `dist/ranker.js evaluates in a bare V8 context with no Node globals` (`node:vm` with an empty context) and `daito.version` matches `package.json`
R29. `api round trip: load → keyword → hybrid returns JSON that parses to ResultVM[]`
R30. `conformance: TypeScript reproduces conformance/cases.json exactly` (guards against an unintended change; re-recording is a deliberate commit)

**performance** (`test/perf.test.ts`, Node, 3× synthetic + 2,000 notes)
R31. `keyword over both corpora p95 ≤ 20 ms`
R32. `hybrid scoring over both corpora (no Ollama) p95 ≤ 35 ms`

### Swift: `macos/Tests/DaitoSearchKitTests/`

**IndexFiles / IndexWatcher**
S1. `reads both fixture corpora; vectors are memory-mapped, not copied` (the `Data` is backed by a mapping; the footprint grows less than the file size)
S2. `missing corpus → partial load with a reason`
S3. `content_hash unchanged → no reload; changed → exactly one reload` (a fake clock for the 500 ms debounce)
S4. `half-written index (search.tmp present, swap in progress) never loads` (the old engine is kept)

**Ranker conformance** (run against every `Ranker` implementation that exists)
S5. `JSCRanker passes every conformance case`
S6. `VectorScorer + JSCRanker (option B) passes every conformance case` (once built)
S7. `SwiftRanker (option C) passes every conformance case` (only if C is chosen)
S8. `JS exception becomes RankerError with message, app keeps previous engine`
S9. `ranker.js version mismatch → error state, keyword off`
S10. `RankerActor serialises: 100 concurrent keyword calls all return, no data race` (run with Thread Sanitizer in `make test-swift-tsan`)

**VectorScorer** (spike, kept if B or C)
S11. `sgemv row scores equal a naive Float64 reference to 1e-5`
S12. `query dims ≠ index dims → nil, not a crash`

**OllamaClient** (`URLProtocol` fake)
S13. `query wrapped exactly as "Instruct: …\nQuery: <q>"`
S14. `truncate + normalise matches fixtures/trunc.json` (the same values as the Python and TypeScript tests)
S15. `timeout (1.5 s) or connection refused → nil + semantic-off reason, no throw`
S16. `warm-up sends keep_alive and empty input, errors ignored`

**QueryController** (a fake ranker, fake Ollama and fake clock)
S17. `keystroke publishes keyword results immediately`
S18. `semantic runs only after debounce and when shouldRunSemantic` (`"vis"` no, `"stiff gels "` yes)
S19. `stale semantic response dropped (seq)`
S20. `selection stays on the same id after re-rank when still listed` (B14)
S21. `scope change re-queries and is remembered`

**ActionExecutor** (fake Pasteboard, EventPoster, Workspace, AXTrust, SecureInput, FileManager)
S22. `paste file: checks existence → writes file URL → hides panel → posts ⌘V after 60 ms`
S23. `paste passage writes the citation string, not the file`
S24. `no Accessibility trust → copy only + toast with Settings link, no event posted`
S25. `secure input on → copy only + toast, no event posted`
S26. `file missing → error, pasteboard untouched`
S27. `restore clipboard on: previous items restored after 750 ms; off: untouched`
S28. `open / reveal / select / note actions call Workspace with the ResultVM URL or path`
S29. `every action id in shortcuts.json has an executor branch`

**Hotkey / Shortcuts / Settings**
S30. `hotkey string round-trips to Carbon code + modifiers` (`⌥Space`, `⌃⌥⌘K`, invalid → error)
S31. `key map from shortcuts.json resolves every documented key and has no duplicates`
S32. `settings defaults match the spec`

**SpotlightDonor** (fake index)
S33. `first sync donates papers and note titles, no abstracts, no note text`
S34. `second sync with no change → zero calls`
S35. `changed paper → one re-donation; removed note → one delete`
S36. `excluded notes never donated` (they aren't in the index, so this is a guard)
S37. `note-text setting on → note text donated; turning a domain off deletes the domain`
S38. `NSUserActivity identifier resolves to the right ResultVM and runs ↵`

**Intents** (logic only; Spotlight itself is manual)
S39. `EntityStringQuery returns ≤ 10 entities in ranker order with display representations`
S40. `empty string → suggestedEntities = recent`
S41. `engine not loaded → [] not a crash`
S42. `semantic wait capped at 400 ms, then keyword results`

### Manual checklist (`macos/CHECK.md`, IDs N-M1…)

- [ ] **N-M1:** The hotkey opens the panel from Mail, Teams, Safari/Chrome, Finder, a full-screen app and a second display. It feels instant (L1: record 10 opens with the built-in `os_signpost` timing). The glass looks right in light and dark mode.
- [ ] **N-M2:** `↵` on a paper opens Zotero at the right page. On a snapshot, opens the snapshot. On a paper with no attachment, selects the item.
- [ ] **N-M3:** `↵` on a note opens Obsidian at the heading (or the file; logged).
- [ ] **N-M4:** `⌘↵`:
  - Mail compose attaches the PDF;
  - a Teams chat attaches it;
  - Claude desktop or a browser LLM uploads it;
  - Terminal pastes the path;
  - TextEdit (rich) inserts an attachment.
- [ ] **N-M5:** `⌘⇧↵` pastes the passage with its citation; `⌘⌥C` and `⌘L` copy correctly.
- [ ] **N-M6:** Dragging a row into Mail, the Finder and a browser upload field works.
- [ ] **N-M7:** `⌘⇧F` reveals the file and `⌘Y` Quick Looks it.
- [ ] **N-M8:** With no Accessibility permission, you see the toast and the file is copied. Grant permission in the system pane → pasting works without restarting. After a rebuild with the Personal Team signature, the permission is still granted.
- [ ] **N-M9:** A paper and its literature note show as one row. `⌘O` works; on a paper without a literature note, what `obsidian://new` does is logged.
- [ ] **N-M10:** Stop Ollama → keyword results and the ○ status. Restart it → semantic results return.
- [ ] **N-M11:** Edit a note and wait for one tick → findable with no app action (FSEvents reload). Add a paper in Zotero → findable within B13.
- [ ] **N-M12:** A note in `exclude` never appears, in the panel or in Spotlight, even by its exact title.
- [ ] **N-M13:** Spotlight action (if S3 passed): in ⌘Space, "Search Everything", Tab, a query → live results → opens. It also works right after login.
- [ ] **N-M14:** Spotlight entries (if S4 passed): ⌘Space with a citekey or a note title shows the item, and selecting it opens it.
- [ ] **N-M15:** With Reduce Transparency on, the panel is legible. VoiceOver reads rows and actions.
- [ ] **N-M16:** Log out and in → the app is running and the indexes are loaded before the first hotkey press (L6).

## Spike (phase 1): prove the risky parts before building on them

On a throwaway branch, time-boxed to **3 days total**. Each spike ends with a `DECISIONS_AND_GAPS.md` entry with numbers and the decision. The code may be thrown away; the measurements and decisions stay.

| Spike | Question | Pass criteria | If it fails |
|---|---|---|---|
| **S1 Ranker** | Can JavaScriptCore run the TypeScript core within budget? | Measurements M1–M7 and the [decision rules](#ranker-decision-javascriptcore-vs-swift) pick A, B or C | — (the rules always choose one) |
| **S2 Panel + paste** | Does a non-activating glass panel take typing while the previous app stays frontmost, and does ⌘V reach it? | Works in Mail, Teams, Chrome, Claude desktop and Terminal; and over a full-screen app | Fallback: an activating panel that remembers the previous app (`NSWorkspace.frontmostApplication`), re-activates it, then pastes. Re-test. If that also fails, ship copy-only plus drag. |
| **S3 Spotlight action** | Does Spotlight call `EntityStringQuery` live as you type, with the app running and built from SwiftPM + `appintentsmetadataprocessor`? | Results update per keystroke in under 1 s; selection runs the intent | Try an `xcodebuild` scheme for metadata. If it's still not live (for example, it only offers suggestions), drop the action from scope; Spotlight entries (S4) remain. |
| **S4 Spotlight entries** | Do Core Spotlight items from a non-sandboxed SwiftPM-built app appear in ⌘Space and open via `NSUserActivity`? | A citekey query shows the paper; selecting it opens Zotero | Drop it from scope and record why. |

## Evaluation

Extend [`eval/queries.toml`](../eval/queries.toml). **Write the note queries before phase 3**, from memory, without opening the notes:

```toml
[[q]]
text = "batch to batch variation in matrigel protein content"
expect_note = ["LeSavage 2022 Next generation cancer organoids.md"]
kind = "note-finding"

[[q]]
text = "what did I decide about third year modules"
expect_note = ["Module decisions year 3.md"]
kind = "note-topic"
```

Aim for at least 15 note queries: at least 8 `note-finding` and at least 4 `note-topic`. A query may list both `expect` and `expect_note`; any match counts.

`node launcher-core/scripts/eval.ts --vault <dir> [--scope all|papers|notes] [--keyword-only] [--per-corpus-instruction]` prints recall@1, recall@5 and MRR per `kind`, plus latency, and the misses (query, expected rank, top 3, winning row: lead or section).

**Acceptance**

| Metric | Target |
|---|---|
| Paper `finding` recall@5 in scope **All** | no more than 0.03 below scope **Papers** |
| `note-finding` recall@5 | ≥ 0.8 |
| `note-topic` recall@5 | ≥ 0.85 |
| Overall MRR (All) | ≥ 0.7 |
| **L1** Hotkey → panel visible with the field focused | ≤ 80 ms p95 (signposts) |
| **L2** Keystroke → keyword results rendered | ≤ 33 ms p95 (two frames) |
| **L3** Semantic, warm Ollama, after the pause | ≤ 300 ms p95 |
| **L4** Background index load (M1) | ≤ 1.5 s at 1× |
| **L5** `notes index` with nothing changed | ≤ 1.0 s wall, 0 bytes written |
| **L6** Note saved → findable semantically | ≤ 6 min (5-min tick + embed + FSEvents reload) |
| **L7** Resident memory (M4) | ≤ 250 MB at 1× |
| **L8** `⌘↵` → file pasted in the target app | ≤ 300 ms (manual) |

**If the targets aren't met, look at the misses before adding anything:**

| What the misses look like | Response |
|---|---|
| Notes crowd out papers in All | Weight the keyword interleave (2 papers : 1 note) or demote daily notes; decide from eval numbers |
| Note findings rank low, and the winning row is the lead | Smaller `chunk_words` (150), or drop the lead row for long notes |
| Note queries fail semantically but papers are fine | `--per-corpus-instruction` with interleaved semantic merging |
| Messy daily notes match everything | A separate `daily` scope, or a lower RRF weight for daily notes |

## Build order

Each phase ends with its tests green, `make check` passing, and a commit.

| Phase | Work | Tests | Exit |
|---|---|---|---|
| 0 | **Install Xcode 26** + `xcode-select`; Personal Team signing set up; fixtures; **note queries (you)**; your `exclude` list; `CHECK.md` | — | `swift test` runs a trivial test; 15+ note queries written |
| 1 | **Spike S1–S4** | measurements | Four decision entries written; scope of the Spotlight parts settled; **ranker option chosen** |
| 2 | Paper `file` paths and `zotero_storage` | Py 1–5 | Real index rebuilt with paths, no re-embed |
| 3 | `mdtext`, `notesindex`, CLI, tick, doctor | Py 6–36 | Notes index fresh for a day unattended; `notes stats` looks right |
| 4 | Engine refactor; `launcher-core` (corpora, merge, query, paths, urls, cite, vm, api, shortcuts); conformance recorder; `eval.ts` | T1–T2, R1–R32 | Eval acceptance met (or misses analysed and decided); conformance recorded |
| 5 | `DaitoSearchKit`: IndexFiles, watcher, the chosen Ranker, OllamaClient, QueryController, ActionExecutor, Hotkey, Shortcuts, Settings | S1–S32 (S6/S7 per decision) | `swift test` green with Thread Sanitizer |
| 6 | App: panel, SearchView with glass, action menu, Quick Look, drag, menu bar, settings, login item; `bundle.sh`, `make app`, `make install-app` | N-M1…N-M12, N-M15, N-M16 | L1, L2, L8 measured and within budget |
| 7 | Spotlight: donor (if S4 passed) and intents (if S3 passed) | S33–S42, N-M13, N-M14 | Works after a fresh login |
| 8 | A week of daily use; log decisions; update `AGENTS.md` | — | Status → implemented |

## Later

- **Files outside the vault:** PDFs in Downloads, iCloud and OneDrive found via `mdfind`, deduplicated against Zotero storage by size and hash, filtered to academic PDFs (DOI or arXiv ID on the first pages, or Abstract plus References), as a third corpus `.planner/files/`.
- **PDFs inside the vault** in the notes corpus, with `pdftext` and pages.
- **Live overlay:** notes modified after `built_at` are keyword-indexed in memory, so a just-typed line is findable before the next tick.
- **Related to what's on screen:** a hotkey variant that takes the selected text from the front app (Accessibility API) as the query.
- **The Obsidian plugin using the app's warm engine** over a local socket, if the plugin's own load time ever becomes a problem.
