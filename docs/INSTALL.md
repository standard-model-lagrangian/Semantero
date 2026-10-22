# Installing daito

daito is four pieces that build on each other. Install only what you want; each tier works without the ones below it.

| Tier | What you get | Runs where | Needs |
|---|---|---|---|
| **1. Paper search in Obsidian** | `⌘⇧0` search pop-up over your Zotero library, `@@` inline citations, literature notes, related-papers panel; index kept fresh by a background watcher | Obsidian plugin + `com.planner.zotero-watch` (launchd) | Zotero, Obsidian, Homebrew, Python 3.11+, poppler, Ollama (optional) |
| **2. Notes index** | Your vault's Markdown notes searchable too (the index the launcher uses) | `planner notes index` | Tier 1's Python setup |
| **3. Launcher app** | **⌥Space from any app** → glass panel over papers *and* notes; open, paste the PDF into Mail/Teams/LLMs, copy citations, drag files; Spotlight entries and a Spotlight action | `Daito Search.app` (menu bar) | Tiers 1–2, full Xcode, Node + npm |
| **4. Planner** (owner's setup) | Daily brief in today's note, `Threads.md`, weekly review, evening reminder | `com.planner.morning` (every 5 min), `com.planner.weekly` (launchd) | Tier 1's Python, API keys (Groq, Anthropic) |

Everything runs locally. The only network calls are the planner's model calls (tier 4) and Ollama on `127.0.0.1`.

## Tools, and which tier needs them

| Tool | Version used | Tier | Install | Notes |
|---|---|---|---|---|
| macOS | 26 (Tahoe) on Apple silicon | all | — | The launcher needs macOS 26 (Liquid Glass, App Intents). Tiers 1–2 also run on older macOS but are untested there |
| [Homebrew](https://brew.sh) | any | all | see site | Puts Python, poppler and Ollama on the path launchd uses (`/opt/homebrew/bin`) |
| [Zotero](https://www.zotero.org) | 7 | 1+ | `brew install --cask zotero` | Data folder `~/Zotero` by default. Read-only to daito: it never writes to `zotero.sqlite` or `storage/` |
| [Better BibTeX](https://retorque.re/zotero-better-bibtex/) | current | 1+ | Zotero → Tools → Plugins → install from file | Citekeys for `[[citekey]]` links and literature notes. `setup-search.sh` warns if your library has none |
| [Obsidian](https://obsidian.md) | 1.x | 1+ | `brew install --cask obsidian` | An existing vault. Default `~/Documents/Obsidian Vault` |
| Python | 3.11+ (3.15 here) | 1+ | `brew install python` | Standard library only, plus `anthropic` for tier 4. The setup script makes `.venv` |
| poppler (`pdftotext`) | current | 1+ | `brew install poppler` | PDF text extraction |
| [Ollama](https://ollama.com) + `qwen3-embedding:0.6b` | current | 1+ (optional) | `brew install ollama && brew services start ollama && ollama pull qwen3-embedding:0.6b` | Semantic search. Without it everything falls back to keyword search and fills in vectors once it's running |
| Xcode (full app, not just Command Line Tools) | 26 or later (27.1 here) | 3 | Mac App Store | Swift Testing, `appintentsmetadataprocessor` (Spotlight action) and signing. Then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` |
| Node.js + npm | 26 (26.4 here) | 3, and contributors | `brew install node` | Builds `launcher-core/dist/ranker.js` (the app's ranking engine) and runs the TypeScript tests. Older Node versions are untested |
| Apple ID in Xcode (free "Personal Team") | — | 3 (recommended) | Xcode → Settings → Accounts → **+** | A stable signature, so macOS remembers the app's permissions across rebuilds |
| Groq and Anthropic API keys | — | 4 | their consoles | In `secrets.toml` (git-ignored, `chmod 600`) |

> **Path gotcha.** If you clone into a folder whose name has spaces or a trailing space, always quote it. The owner's
> checkout is `"…/productivity work "` (trailing space).

---

## Tier 1: paper search in Obsidian

```bash
git clone https://github.com/standard-model-lagrangian/daito.git
cd daito
./setup-search.sh
```

Non-default locations: `./setup-search.sh --vault "/path/to/Vault" --zotero "/path/to/Zotero"`. These are saved to the
git-ignored `config.local.toml`, so `git pull` never conflicts with them. (`setup.sh` is an identical copy of
`setup-search.sh`.)

The script:
1. makes `.venv` with Python 3.11+ (installing it with Homebrew if needed);
2. checks for `pdftotext`, Ollama and the embedding model, and offers to install them;
3. copies the plugin into `<vault>/.obsidian/plugins/daito-paper-search/`;
4. checks your library has citekeys, then builds the first index into `<vault>/.planner/search/`;
5. writes and loads `~/Library/LaunchAgents/com.planner.zotero-watch.plist`. This re-indexes about 20 s after Zotero
   changes, plus an hourly retry while the index is keyword-only.

Then in Obsidian: **Settings → Community plugins → Installed plugins → reload → enable "Daito Paper Search"**.

Check: `./setup-search.sh status`, or `.venv/bin/python -m planner doctor --search`.

| Command | What it does |
|---|---|
| `./setup-search.sh status` | Ollama, Python, index and watcher health |
| `./setup-search.sh index [--full]` | Rebuild the paper index now |
| `./setup-search.sh logs` | Last lines of `logs/zotero-watch.log` |
| `./setup-search.sh stop` / `start` | Unload / load the watcher |

Node is **not** needed here: the plugin's `main.js` is committed.

---

## Tier 2: notes index

This makes every Markdown note in the vault searchable, in `<vault>/.planner/notes/`.

**First, decide what must never be indexed.** Private notes (bank details, IDs, health) go in `config.local.toml`
**before** the first build. A list there *replaces* the default list, so repeat the defaults:

```toml
# config.local.toml (git-ignored)
[notes]
exclude = ["Templates/**", "Threads.md", "Zotero Template.md", "Zotero Citation Template.md",
           "Private/**", "My bank details.md"]
```

Globs are vault-relative: `*` stays within a folder and `**` crosses folders. Excluded notes are never opened, so they
never reach the index, a snippet or Spotlight. Dot-folders (`.obsidian`, `.trash`, `.planner`) are always skipped.

Then:

```bash
.venv/bin/python -m planner notes index     # build (embeds every note once: a minute or two with Ollama)
.venv/bin/python -m planner notes stats     # notes per kind, literature notes matched, excluded count, age
```

**Keeping it fresh.** If you run the planner (tier 4), its 5-minute launchd tick updates the notes index after its own
work. Without the planner there is no notes job yet, so run `planner notes index` when you want, or add your own
launchd job running `bin/planner-run.sh notes index` every few minutes. A run with nothing changed takes milliseconds
and writes nothing; merely touching a note doesn't rewrite the index.

Safety behaviour you can rely on:
- If the vault, or any folder in it, can't be read (macOS privacy settings, an unmounted drive, a renamed vault), the
  build stops and the old index is kept. It is never silently emptied.
- If Ollama is down, notes are indexed keyword-only and embedded later.

A note counts as a **literature note** (shown merged with its paper in the launcher) if its frontmatter `citekey:` or
its file name matches a Zotero citekey.

---

## Tier 3: the launcher app (Daito Search.app)

```bash
# once: full Xcode, then
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
(cd launcher-core && npm install)          # tools for building the ranking engine
make install-app                           # builds, signs and copies to /Applications
open "/Applications/Daito Search.app"
```

On first launch:
1. **Documents access.** macOS asks: *"Daito Search would like to access files in your Documents folder"* → **Allow**.
   This is needed because the vault usually lives in `~/Documents`. If you missed the prompt: System Settings → Privacy
   & Security → Files and Folders → Daito Search → Documents.
2. **Accessibility** (asked the first time you press ⌘↵). It lets the app paste into the app you're in. Without it,
   ⌘↵ copies and a toast tells you to press ⌘V.
3. A magnifying glass appears in the menu bar. Its menu shows "N papers, M notes".
4. Press **⌥Space**. Change the hotkey in Settings… if another app already uses it.

**Signing.** `make install-app` signs with the first "Apple Development" identity in your keychain, or with
`$DAITO_SIGN_IDENTITY`, or ad hoc (`signing with: -`). With an ad hoc signature, macOS forgets permissions 1 and 2 at
every reinstall. Adding your Apple ID in Xcode creates a free development identity and fixes that.

**Updating the app** (the running copy isn't replaced in place):

```bash
make install-app && pkill -f "Daito Search.app/Contents/MacOS/DaitoSearch"; sleep 1; open "/Applications/Daito Search.app"
```

**Settings** (menu bar → Settings…; changes apply when you press Save): vault path, hotkey, Ollama URL, result count,
restore the clipboard after pasting, what to add to Spotlight (papers / note titles / note text; text is off by
default), launch at login.

**Spotlight.** The app adds one entry per paper and per note title to Spotlight (⌘Space). The "Search Everything"
Spotlight action (⌘Space → type "Search Everything" → Tab → query) needs the app running.

Check it's working: `make app-selftest` drives the real panel with synthetic keys and prints a pass/fail report (needs no
permissions). The hands-on checklist is [`macos/CHECK.md`](../macos/CHECK.md).

---

## Tier 4: the planner (daily brief, threads, weekly review)

This is the owner's daily-notes workflow ([SPEC.md](SPEC.md)). It writes into your daily notes, so read the spec first.

```bash
cp secrets.example.toml secrets.toml && chmod 600 secrets.toml   # add GROQ_API_KEY and ANTHROPIC_API_KEY
.venv/bin/pip install -r requirements.txt                       # anthropic SDK
.venv/bin/python -m planner doctor                              # every check, with its fix
```

Daily notes are `YYYY-MM-DD.md` at the vault root, from `Templates/Daily.md` (see [SPEC.md](SPEC.md)).

The launchd jobs in `launchd/` are the **owner's copies, with absolute paths to the owner's checkout**. Edit the paths
in `com.planner.morning.plist` and `com.planner.weekly.plist` (`ProgramArguments`, `WorkingDirectory`, the log paths)
to your checkout, then:

```bash
cp launchd/com.planner.morning.plist launchd/com.planner.weekly.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.planner.morning.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.planner.weekly.plist
```

The morning job runs every 5 minutes. It does the day's work once, on the first run after 04:00 while online, and
updates the notes index on every run. Logs go to `logs/morning.log` and `logs/weekly.log`.

---

## Uninstalling

| Piece | How |
|---|---|
| Launcher | First menu bar → Settings… → untick the three Spotlight boxes → Save (this removes its Spotlight entries). Then Quit, and `rm -rf "/Applications/Daito Search.app" ~/Library/Application\ Support/Daito\ Search`; `defaults delete dev.daito.search` |
| Watcher | `./setup-search.sh stop` and `rm ~/Library/LaunchAgents/com.planner.zotero-watch.plist` |
| Planner jobs | `launchctl bootout gui/$(id -u)/com.planner.morning` (and `.weekly`), then remove the plists |
| Plugin | Disable it in Obsidian, then delete `<vault>/.obsidian/plugins/daito-paper-search` |
| Indexes and state | `<vault>/.planner/` (indexes, sidecars, state). Your notes are not touched |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Launcher says "isn't allowed to read your vault" | Allow Documents in Privacy & Security → Files and Folders, then menu bar → Reload Indexes |
| ⌘↵ only copies ("press ⌘V" toast) | Allow Daito Search under Privacy & Security → Accessibility. With an ad hoc signature this resets on each reinstall |
| Grey dot "semantic off: Ollama not reachable" | `brew services start ollama`; `ollama list` should include `qwen3-embedding:0.6b` |
| `_LSOpenURLsWithCompletionHandler() failed with error -600` after reinstalling | The old copy was still quitting: run `open` again (or put `sleep 1` before it) |
| ⌥Space does something else | Another app has it (e.g. an assistant's quick-entry key). Pick another hotkey in Settings |
| A note never shows up | `planner notes stats` (is it excluded? is the index fresh?). Notes in symlinked folders and tags starting with accented letters are not indexed |
| Outlook on the web shows "Something went wrong while the document preview was being created" | The pasted file is correct (verified byte-for-byte in Firefox); it's Outlook's previewer. Download it to check, or compare with Outlook's own Attach button |
| Launcher uses lots of memory | Normal for a few seconds after start. It compacts itself to ~100–160 MB, and a watchdog re-compacts when hidden and over 350 MB. Activity Monitor's "Memory" is the right number; `ps` RSS over-reports |
| `planner doctor` flags the notes index | The message says the fix: `planner notes index` (missing or stale), `--full` (model changed), or start Ollama (degraded) |
| `make check` fails on a fresh clone | Run `make dev-setup` (npm packages for both TypeScript projects and the Python venv); `make test-swift` needs full Xcode |
