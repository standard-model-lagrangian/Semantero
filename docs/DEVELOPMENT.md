# Developing Semantero

For contributors and coding agents. Read [AGENTS.md](../AGENTS.md) first: its rules (vault safety, test-first, privacy)
override anything here. To install, see [INSTALL.md](INSTALL.md).

## The system in one picture

```
 Zotero (read-only)            Python: planner/ (offline indexers, launchd)               consumers (read the index files)
 ──────────────────            ─────────────────────────────────────────────              ────────────────────────────────
 zotero.sqlite ─► zotlib ─┐
 storage/*.pdf ─► pdftext ─┼─► searchindex ─► <vault>/.planner/search/ ─┬─► Obsidian plugin  obsidian/paper-search  (TS, Electron)
 storage/*.html ► htmltext ┘      ▲    (manifest, papers, chunks,      │
                                  │     vectors.f32, state)            ├─► launcher-core   (TS → dist/ranker.js)
            zotwatch (launchd) ───┘                                    │        ▲ runs inside
                                                                       │   Semantero.app  macos/  (Swift, JavaScriptCore)
 vault/**/*.md ─► mdtext ─► notesindex ─► <vault>/.planner/notes/ ─────┘        │
                                  ▲    (same format, one entry per note)        ├─► panel (⌥Space), actions, clipboard
       morning tick (launchd) ────┘                                             ├─► Core Spotlight entries
                                                                                └─► App Intents ("Search Everything")
 embed.py ─► the live profile's embedder ◄── query embedding from the plugin and the app
             pplxd (127.0.0.1:11435, pplx-embed-v2-late, the default) or Ollama (127.0.0.1:11434, qwen3-embedding:0.6b)
```

**The index files are the interface.** Python writes them atomically (`<name>.tmp/` → rename, `<name>.old/` while
swapping) and owns their format. Every reader treats them as read-only and reloads when `manifest.content_hash`
changes. Format: [SEARCH_SPEC.md](SEARCH_SPEC.md#index-format-plannersearch-inside-the-vault-hidden-from-obsidian)
(papers) and [LAUNCHER_SPEC.md](LAUNCHER_SPEC.md#notes-plannernotes-new-corpus-same-format) (notes, and the `file`
paths added to papers).

**One ranking implementation.** BM25, the semantic pass, rank fusion and snippets live in
`obsidian/paper-search/src/{engine,bm25,rank,text,vectors,ollama,indexstore,zotero}.ts`. None of these files may import
Obsidian (a test enforces this). `launcher-core` imports them by relative path and adds the two-corpus merge and the view
model. The app runs the bundled result in JavaScriptCore, so a ranking change is made once and covered by one set of
tests.

## Components

| Path | Language | What | Tests | Build artefact (committed) |
|---|---|---|---|---|
| `planner/` | Python 3.11+, stdlib (+ `anthropic`) | CLI `python -m planner …`: planner, paper index, notes index, watcher, doctor | `tests/` (`unittest`) | — |
| `obsidian/paper-search/` | TypeScript (Node 26 runs `.ts` directly) | Obsidian plugin + the shared ranking core | `test/*.test.ts` (`node --test`) | `main.js` |
| `launcher-core/` | TypeScript, no Node/DOM APIs in `src/` | Merges papers + notes, builds `ResultVM`s; JavaScriptCore API `globalThis.semantero` | `test/*.test.ts`, `conformance/cases.json` | `dist/ranker.js` |
| `macos/` | Swift 6.2 package, no dependencies | `SemanteroKit` (all logic, testable), `Semantero` (the app), `SemanteroBench` (benchmarks) | `Tests/SemanteroKitTests` (Swift Testing); `make app-selftest` | `macos/build/` (git-ignored) |
| `eval/` | TOML | Ground-truth queries (`expect` citekeys, `expect_note` note paths) | `scripts/eval.ts` in both TS packages | — |
| `launchd/`, `bin/` | plist, shell | launchd job templates and `install-launchd.sh`, which fills them in and loads them; `planner-run.sh` adds Homebrew to launchd's PATH | `tests/test_launchd.py` | — |
| `docs/` | Markdown | Specs, decisions log, checklists, these guides | — | — |

## The two setups in the code

| | Obsidian only | Global |
|---|---|---|
| Config | `config.toml` as shipped (`[notes] enabled = false`) | `config.local.toml`: `[notes] enabled = true` + `exclude` |
| Python | `searchindex`, `zotlib`, `pdftext`, `htmltext`, `zotwatch`, `embed`; `planner doctor --search` | also `mdtext`, `notesindex`; the morning tick's `_notes_tick`; doctor's notes and launcher-app checks (both silent when notes are off) |
| TypeScript | `obsidian/paper-search` | also `launcher-core` (imports the plugin's core) |
| Swift | — | `macos/` |
| Install | `./setup-search.sh` | `make install-global` |

Rules: features of the global setup are gated on `notesindex.notes_enabled(cfg)` on the Python side, and nothing in the
plugin may depend on `launcher-core` or `macos/`. The shipped-config test (`TestShippedConfig`) keeps `config.toml`
Obsidian-only.

## Setting up a development checkout

```bash
make dev-setup     # .venv (+ requirements), npm install in obsidian/paper-search and launcher-core
make check         # ruff, tsc ×2, all four test suites, committed bundles up to date
make ci            # the same without the Swift suite: what GitHub Actions runs
```

`make check` needs full Xcode for `test-swift` (Swift Testing) and for the App Intents metadata in `make app`. Everything else, including building and running the app itself, works with the Command Line Tools. Keep it that way: users of the Global setup are told Xcode is optional ([INSTALL.md](INSTALL.md#do-i-need-xcode)).

**CI** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs `make ci` on Ubuntu with Python 3.11 (the oldest supported) and Node 26 on every pull request and every push to `main`. The Swift suite and `make app-selftest` stay local: they need macOS 26 and, for the self-test, a screen. The PDF extraction tests in `tests/test_search_index.py` need `pdftotext`; without poppler they skip, except on CI, which installs it.

| Command | What |
|---|---|
| `make test-py` / `test-ts` / `test-launcher` / `test-swift` | One suite. `test-launcher` sets `TZ=UTC` (note dates are local-time) |
| `make test-swift-tsan` | Swift suite under Thread Sanitizer (actors, reload races) |
| `make lint`, `make typecheck` | ruff; `tsc --noEmit` in both TS packages, over `src/` and (via `tsconfig.test.json`) `test/` and `scripts/` |
| `make build` | Rebuild the plugin's `main.js` |
| `cd launcher-core && npm run build` | Rebuild `dist/ranker.js`. The build fails if Node built-ins, `console.` or `TextDecoder` slip in: JavaScriptCore's bare context has none |
| `make fixtures` | Rebuild `launcher-core/test/fixtures/notes_small/` from `tests/fixtures/notes/vault_small/` with the fake embedder |
| `make record-conformance` | Re-record `launcher-core/conformance/cases.json` from the TypeScript implementation (a deliberate, reviewed commit) |
| `make app` / `make install-app` | Build (and install) `Semantero.app`: release build, `ranker.js` + `shortcuts.json` copied in, App Intents metadata, hardened runtime + JIT entitlement |
| `make app-selftest` | Runs the built app with `SEMANTERO_SELFTEST`: shows the real panel, sends synthetic key events to it, records actions instead of running them, prints pass/fail |
| `make bench-app` | Spike S1 benchmark on your vault: load, keystroke, hybrid (JavaScriptCore vs Accelerate), memory; three signing modes |
| `node launcher-core/scripts/eval.ts --vault <dir> --scope compare` | Recall@1/@5 and MRR, papers vs all; `--keyword-only`, `--per-corpus-instruction` |
| `SEMANTERO_PERF=1 node --test test/perf.test.ts` | Gated performance budgets (both TS packages; generates a 3× synthetic index once, git-ignored) |
| `SEMANTERO_LIVE=1 …` | Python tests that call the real `pdftotext` / Ollama |

## Workflows

**Changing ranking** (BM25, fusion, snippets, merge, view model):
1. Write the failing test: `obsidian/paper-search/test/` for the shared core, `launcher-core/test/` for merge or view-model behaviour.
2. Change the TypeScript. The plugin's goldens (`test/goldens.json`) must stay green unless the change is intended.
3. `make record-conformance` if the launcher's results change on purpose. Review the diff of `cases.json`.
4. `npm run build` in both packages (`main.js`, `ranker.js`), then `make test-swift`: the Swift suite runs the same
   conformance cases through JavaScriptCore and through the Accelerate path.
5. Run the eval on a real vault (`scripts/eval.ts --scope compare`) and note numbers that moved in
   [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md).

**Changing an index format** (a field in `papers.json` or `chunks.json`):
1. Python test first (`tests/test_search_index.py` or `tests/test_notes_index.py`), then `zotlib`/`searchindex` or
   `mdtext`/`notesindex`.
2. Extra fields are fine (readers ignore unknown ones). Renaming or removing one needs a `format` bump and readers that
   handle both.
3. Changing chunking or the embedded text must change the `chunker` name (forces a full rebuild). Changing the model or
   dims rebuilds automatically.
4. Update `tests/fixtures/search/index_small/` by hand if papers change, then `make fixtures`, then re-record
   conformance.
5. Keep `content_hash` stable for data that didn't change, or every reader reloads. Modified times are deliberately
   left out of the notes hash.

**Adding a launcher action** (e.g. "Copy DOI"):
1. Add it to `launcher-core/shortcuts.json`: id, title, key, the kinds it applies to, and what it needs (`filePath`,
   `noteUrl`, `selectUrl`).
2. If it needs data, add a field to `ResultVM` (`launcher-core/src/vm.ts`) and its Swift mirror
   (`macos/Sources/SemanteroKit/Models.swift`).
3. Implement it in `ActionExecutor.run` and add the id to `ActionExecutor.supportedIDs`. A test fails until the two match.
4. Add an icon in `ActionMenu.icon(_:)`. Re-record conformance (the action list is part of each `ResultVM`).

**Adding an app setting:** add a property to `SettingsStore` (with its default in the spec), then to `SettingsSnapshot`
and `SettingsEffect.between` (what must be redone when it changes), then to `SettingsView`, and a test in
`SettingsEffectTests`.

**Changing the Python CLI or launchd behaviour:** anything run by the 5-minute tick must never raise (log instead)
and must take a non-blocking lock. Health problems surface through `planner doctor` checks (`planner/health.py`), which
the morning brief shows as `⚠ Setup:` lines.

## Testing strategy

- **Test first**, always (AGENTS.md). Spec documents number their tests (Py 1–36, R1–R32, S1–S42 in
  [LAUNCHER_SPEC.md](LAUNCHER_SPEC.md)); keep new tests named after the behaviour they pin.
- **No real data in tests.** Temp dirs, fixtures (`tests/fixtures/`), and a deterministic fake embedder (md5 of each
  word → a dimension, normalised). The same fake exists in Python and TypeScript (`launcher-core/test/helpers.ts`) so
  fixtures and query vectors agree. `fixtures/search/trunc.json` pins truncate-and-normalise across Python, TS and Swift.
- **Conformance is the contract** between `launcher-core` and any ranker in the app: 84 cases, compared field by field.
- **Fakes for the OS** in Swift: clipboard, key events, workspace, Accessibility and secure-input state, file existence,
  Spotlight index, HTTP, sleep and scheduler. No test touches the real clipboard, keyboard or Spotlight.
- **What only a person can check** is in [`macos/CHECK.md`](../macos/CHECK.md) (launcher) and [MANUAL_CHECKS.md](MANUAL_CHECKS.md)
  (plugin). `make app-selftest` covers the launcher's keyboard path in the real app.
- **Gated tests**: `SEMANTERO_PERF=1` (performance budgets), `SEMANTERO_LIVE=1` (real `pdftotext` and Ollama).

## Debugging aids

| Aid | What |
|---|---|
| `SEMANTERO_DEBUG=1 "/Applications/Semantero.app/Contents/MacOS/Semantero"` | Logs reload outcomes, compactions, the memory watchdog and Spotlight syncs to stderr |
| `SEMANTERO_SHOW_PANEL="<query>"` | Opens the panel with that query once the index is loaded |
| `SEMANTERO_SNAPSHOT=<png>` (+ `SEMANTERO_SNAPSHOT_ACTIONS=1`) | With `SEMANTERO_SHOW_PANEL`: saves the panel (optionally with ⌘K open) to a PNG via `cacheDisplay`, then quits. Needs no screen-recording permission. Glass and SF Symbols may not render in the capture |
| `SEMANTERO_SELFTEST=<json>` | See `make app-selftest`. Test modes take no hotkey or login item, so they run beside the installed app |
| `semantero-bench` (`swift run -c release semantero-bench --vault …`; sign it with the JIT entitlement first, see `macos/scripts/bench.sh`) | default: load/keyword/hybrid timings for options A and B. `--heapprobe` (live heap, objects by type, footprint over idle time), `--notesprobe` (notes-only reload cost), `--parseprobe` (JSON.parse/string costs), `--dropprobe <debug bundle>` (heap owned by each engine part), `--memprobe`, `--jsprobe`, `--jsprobe2 <bundle>` |
| `SEMANTERO_VAULT=<dir> SEMANTERO_NO_HOTKEY=1` | Run a build of the app against another vault (e.g. a copy of the indexes) without touching the installed app's hotkey or settings |
| `footprint <pid>` / `vmmap -summary <pid>` | The real memory figure (`ps` RSS counts reclaimable pages) |
| `planner notes stats`, `planner search stats`, `planner doctor --search` | Index contents, age, health |

## Gotchas (each one cost time)

- **JavaScriptCore needs the JIT entitlement** (`com.apple.security.cs.allow-jit`). Without it, it runs interpreted:
  the semantic pass is 30× slower and loading 3× slower. `bundle.sh` always signs with it, so `swift run` builds are slow.
- **JavaScriptCore memory.** `JSGarbageCollect` only schedules a collection; every build therefore ends with a
  synchronous one (`JSCPrivate.collectNow`), or the build's ~1 GB churn stays resident. Keep the engine's object count
  low: postings are flat typed arrays (CSR), chunk texts live packed in a `TextStore`, vocabulary strings are flat copies
  (a token slice pins its whole parent string). The app also turns off the DFG and FTL JIT tiers
  (`JSCRanker.configureProcess()`). Every JavaScriptCore call runs in an `autoreleasepool`, or replaced engines stay
  alive. Measure with `semantero-bench --heapprobe` (live heap, objects by type, footprint) and `--dropprobe` (which part
  holds what). Details: [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md) (Spike S1, Review fixes, Memory pass).
- **Notes-only reloads** swap the notes corpus inside the current engine (`semantero.loadNotes`), so editing notes never
  rebuilds the paper index. Keep `Engine.withNotes` exactly equivalent to a full build (test R35).
- **Reloads build off the query actor** on their own VM; the last load started wins. Don't move engine building back
  onto `JSCRanker`'s actor, or every keystroke waits for it.
- **A non-activating `NSPanel`** keeps the previous app frontmost, which is what makes ⌘V reach it. Key handling sits
  on the search field itself (`.onKeyPress`), otherwise the field eats Return (with any modifier) and the arrows.
- **Nested glass is transparent.** Anything drawn over the panel (the ⌘K menu) is opaque and drawn outside the
  `GlassEffectContainer`.
- **Ad hoc signing resets permissions** (Documents, Accessibility) at every reinstall. Use a development identity.
- **App Intents metadata** isn't produced by `swift build`. `macos/scripts/appintents-metadata.sh` gets the
  `.swiftconstvalues` from `xcodebuild` and runs Xcode's `appintentsmetadataprocessor`.
- **launchd has a minimal PATH.** `bin/planner-run.sh` adds `/opt/homebrew/bin`; anything launchd runs must go through it.
- **`os.walk` swallows permission errors.** `notesindex.scan` passes an `onerror` that raises, so an unreadable vault
  can't empty the index. Keep that pattern for any new vault scan.
- **`make check`'s bundle check** compares `main.js` and `ranker.js` with HEAD, so it fails until rebuilt bundles are
  committed. An untracked bundle passes trivially.
- **Testing pastes into web apps:** a throwaway Firefox profile driven over Marionette with
  `-remote-allow-system-access`, made frontmost by PID, with `windowUtils.sendNativeKeyEvent` for a real ⌘V. Synthetic
  WebDriver keys and `execCommand('paste')` don't paste. Recipe in DECISIONS_AND_GAPS.md (First hands-on feedback).

## Releasing a change

1. `make check` green (with rebuilt `main.js` / `ranker.js` committed alongside their sources). CI repeats the non-Swift half on the PR.
2. For launcher changes: `make app-selftest`, then the relevant rows of `macos/CHECK.md` on the installed app.
3. Record decisions, measurements and deviations from the spec in [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md).
4. Never commit personal data: no real note titles or vault contents in docs, fixtures or tests. Personal config goes
   in `config.local.toml` and `secrets.toml` (both git-ignored).
