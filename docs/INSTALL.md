# Installing Semantero

## Choose your setup

Semantero is one repository with two ways to use it. Pick one; you can switch later (below).

| | **Obsidian only** | **Global** |
|---|---|---|
| What you get | Paper search inside Obsidian: `⌘⇧0` pop-up over your Zotero library, `@@` inline citations, literature notes, related-papers panel. Index kept fresh in the background | Everything in Obsidian only, **plus** your vault's notes indexed, and **Semantero**: press **⌥Space in any app** to search papers *and* notes, paste the PDF into Mail/Teams/an LLM, copy citations, drag files; also in Spotlight |
| Runs | Obsidian plugin + one background watcher | The same, plus a menu-bar app and the notes index |
| You need | Zotero (+ Better BibTeX), Obsidian, Homebrew, Python 3.11+, poppler; uv for the default embedding model (or Ollama with `--model qwen`) | The same, plus macOS 26, Node.js, and Apple's free **Command Line Tools**. Full Xcode is optional: see [Do I need Xcode?](#do-i-need-xcode) |
| Setup time | ~5 minutes of your time, plus the model download and the first index running on their own (see [tier 1](#tier-1-paper-search-in-obsidian)) | ~5 more minutes (longer if you also download Xcode) |
| Code used | `planner/` (paper index, watcher), `obsidian/paper-search/` | also `planner/notesindex.py`, `launcher-core/`, `macos/` |

The planner (daily brief, weekly review) is a separate, optional add-on for either setup: [tier 4](#tier-4-the-planner-daily-brief-threads-weekly-review).

### Obsidian only

```bash
git clone https://github.com/standard-model-lagrangian/Semantero.git
cd Semantero
./setup-search.sh            # add --vault "/path/to/Vault" --zotero "/path/to/Zotero" if not in the default places
```

Then in Obsidian: **Settings → Community plugins → Installed plugins → reload → enable "Semantero"**, and press
`⌘⇧0`. That's it. Details and management commands: [tier 1](#tier-1-paper-search-in-obsidian).

The notes index is **off** in this setup (`config.toml` ships with `[notes] enabled = false`), so nothing reads your
notes and `planner doctor` doesn't expect a notes index. You don't need Xcode or Node.

### Global

1. Do **Obsidian only** above first.
2. Install the extra tools: Node with `brew install node`, and Apple's Command Line Tools with
   `xcode-select --install` (Homebrew usually installed them already). Full Xcode is optional: it adds the Spotlight
   "Search Everything" action and an easy stable signature. See [Do I need Xcode?](#do-i-need-xcode). If you install it,
   also run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and, recommended, Xcode → Settings →
   Accounts → add your Apple ID.
3. Turn on the notes index and list your private notes, in the git-ignored `config.local.toml` (create it if
   `setup-search.sh` didn't). **Do this before step 4**: excluded notes are never read.

   ```toml
   [notes]
   enabled = true
   exclude = ["Templates/**", "Threads.md", "Zotero Template.md", "Zotero Citation Template.md",
              "Private/**", "My bank details.md"]
   ```

4. Build and install:

   ```bash
   (cd launcher-core && npm install)
   make install-global          # builds the notes index, then builds and installs Semantero.app
   open "/Applications/Semantero.app"
   ```

5. Allow **Documents** access when asked; allow **Accessibility** the first time you press ⌘↵. Then press **⌥Space**.
6. Keep the notes index fresh: the planner's 5-minute job does it if you use the planner; otherwise run
   `.venv/bin/python -m planner notes index` when you like, or schedule `bin/planner-run.sh notes index` with launchd
   (see [tier 2](#tier-2-notes-index)).

Details: [tier 2](#tier-2-notes-index) (notes index) and [tier 3](#tier-3-the-launcher-app-semanteroapp) (the app).

### Switching

| From → to | Do |
|---|---|
| Obsidian only → Global | Steps 2–6 of **Global** above. Nothing in the Obsidian setup changes |
| Global → Obsidian only | Menu bar → Settings… → untick the three Spotlight options → Save; Quit the app; `rm -rf "/Applications/Semantero.app"`; set `[notes] enabled = false` in `config.local.toml`; optionally delete `<vault>/.planner/notes/`. The Obsidian plugin and the watcher are unaffected |
| Update either | `git pull`, then `./setup-search.sh` (plugin, watcher). Global also: `make install-global`, quit and reopen the app |

---

## The pieces in detail (tiers)

Tier 1 is the **Obsidian only** setup; tiers 1–3 are **Global**; tier 4 (the planner) is optional for either.

| Tier | What you get | Runs where | Needs |
|---|---|---|---|
| **1. Paper search in Obsidian** | `⌘⇧0` search pop-up over your Zotero library, `@@` inline citations, literature notes, related-papers panel; index kept fresh by a background watcher | Obsidian plugin + `com.planner.zotero-watch` and `com.planner.pplxd` (launchd) | Zotero, Obsidian, Homebrew, Python 3.11+, poppler, uv (or Ollama with `--model qwen`) |
| **2. Notes index** | Your vault's Markdown notes searchable too (the index the launcher uses) | `planner notes index` | Tier 1's Python setup |
| **3. Launcher app** | **⌥Space from any app** → glass panel over papers *and* notes; open, paste the PDF into Mail/Teams/LLMs, copy citations, drag files; Spotlight entries and a Spotlight action | `Semantero.app` (menu bar) | Tiers 1–2, Command Line Tools (full Xcode optional), Node + npm |
| **4. Planner** (owner's setup) | Daily brief in today's note, `Threads.md`, weekly review, evening reminder | `com.planner.morning` (every 5 min), `com.planner.weekly` (launchd) | Tier 1's Python, API keys (Groq, Anthropic) |

Everything runs locally. Setup downloads the embedding model once (Hugging Face, GitHub for llama.cpp); after that the
only network calls are the planner's model calls (tier 4) and the embedding service on `127.0.0.1`.

## Tools, and which tier needs them

| Tool | Version used | Tier | Install | Notes |
|---|---|---|---|---|
| macOS | 26 (Tahoe) on Apple silicon | all | — | The launcher needs macOS 26 (Liquid Glass, App Intents). Tiers 1–2 also run on older macOS but are untested there |
| [Homebrew](https://brew.sh) | any | all | see site | Puts Python, poppler and Ollama on the path launchd uses (`/opt/homebrew/bin`) |
| [Zotero](https://www.zotero.org) | 7 | 1+ | `brew install --cask zotero` | Data folder `~/Zotero` by default. Read-only to semantero: it never writes to `zotero.sqlite` or `storage/` |
| [Better BibTeX](https://retorque.re/zotero-better-bibtex/) | current | 1+ | Zotero → Tools → Plugins → install from file | Citekeys for `[[citekey]]` links and literature notes. `setup-search.sh` warns if your library has none |
| [Obsidian](https://obsidian.md) | 1.x | 1+ | `brew install --cask obsidian` | An existing vault. Default `~/Documents/Obsidian Vault` |
| Python | 3.11+ (3.15 here) | 1+ | `brew install python` | Standard library only, plus `anthropic` for tier 4. The setup script makes `.venv` |
| poppler (`pdftotext`) | current | 1+ | `brew install poppler` | PDF text extraction |
| [uv](https://docs.astral.sh/uv/) + pplx-embed-v2-late | uv current; model and llama.cpp pinned | 1+ (default model) | `brew install uv`; the setup script does the rest | Semantic search (the default). The script converts the model once into `~/Library/Application Support/Semantero/` (~4 GB of downloads, of which ~1.5 GB is kept at runtime) and runs it as `com.planner.pplxd`. Apple silicon only. Without it everything falls back to keyword search and fills in vectors once it's running |
| [Ollama](https://ollama.com) + `qwen3-embedding:0.6b` | current | 1+ (`--model qwen`) | `brew install ollama && brew services start ollama && ollama pull qwen3-embedding:0.6b` | The lighter alternative (~600 MB), and the fallback if the pplx setup fails |
| Command Line Tools (Swift compiler + macOS SDK) | for macOS 26 SDK | 3 | `xcode-select --install` | Enough to build and run the app. See [Do I need Xcode?](#do-i-need-xcode) |
| Xcode (full app) | 26 or later (27.1 here) | 3 (optional), contributors | Mac App Store | Only for: the Spotlight "Search Everything" action (`appintentsmetadataprocessor`), the Swift test suite, and an easy stable signature. Then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` |
| Node.js + npm | 26 (26.4 here) | 3, and contributors | `brew install node` | Builds `launcher-core/dist/ranker.js` (the app's ranking engine) and runs the TypeScript tests. Older Node versions are untested |
| Apple ID in Xcode (free "Personal Team") | — | 3 (recommended, needs Xcode) | Xcode → Settings → Accounts → **+** | A stable signature, so macOS remembers the app's permissions across rebuilds |
| Groq and Anthropic API keys | — | 4 | their consoles | In `secrets.toml` (git-ignored, `chmod 600`) |

> **Path gotcha.** If you clone into a folder whose name has spaces or a trailing space, always quote it. The owner's
> checkout is `"…/productivity work "` (trailing space).

---

## Tier 1: paper search in Obsidian

```bash
git clone https://github.com/standard-model-lagrangian/Semantero.git
cd Semantero
./setup-search.sh
```

Non-default locations: `./setup-search.sh --vault "/path/to/Vault" --zotero "/path/to/Zotero"`. These are saved to the
git-ignored `config.local.toml`, so `git pull` never conflicts with them. (`setup.sh` is an identical copy of
`setup-search.sh`.)

Pick the embedding model with `--model`: `pplx` (default) or `qwen`. Both are compared in
[EMBED_INSTALLS.md](EMBED_INSTALLS.md); you can build the other one and switch later without reinstalling. The choice
only applies to a vault with no index yet: an existing index keeps its model.

The script:
1. makes `.venv` with Python 3.11+ (installing it with Homebrew if needed);
2. checks for `pdftotext` and sets up the embedding model. For `pplx`: installs `uv`, runs `pplx/convert/convert.sh`
   once (downloads a pinned llama.cpp and the model, converts it and checks it against the reference implementation),
   then installs and starts the `com.planner.pplxd` service. If any of that fails it says so and falls back to
   `qwen`. For `qwen`: checks for Ollama and pulls `qwen3-embedding:0.6b`;
3. copies the plugin into `<vault>/.obsidian/plugins/semantero/`;
4. checks your library has citekeys, then builds the first index into `<vault>/.planner/search/` (with pplx, allow
   about an hour per 9,000 paper texts; after that, a new paper takes seconds);
5. writes and loads `~/Library/LaunchAgents/com.planner.zotero-watch.plist`. This re-indexes about 20 s after Zotero
   changes, plus an hourly retry while the index is keyword-only.

Then in Obsidian: **Settings → Community plugins → Installed plugins → reload → enable "Semantero"**.

Check: `./setup-search.sh status`, or `.venv/bin/python -m planner doctor --search`.

| Command | What it does |
|---|---|
| `./setup-search.sh status` | Embedding model, Python, index and watcher health |
| `./setup-search.sh index [--full]` | Rebuild the paper index now |
| `./setup-search.sh logs` | Last lines of `logs/zotero-watch.log` |
| `./setup-search.sh stop` / `start` | Unload / load the watcher |

Node is **not** needed here: the plugin's `main.js` is committed.

---

## Tier 2: notes index

This makes every Markdown note in the vault searchable, in `<vault>/.planner/notes/`.

**First, turn it on and decide what must never be indexed.** The notes index is off by default. Private notes (bank
details, IDs, health) go in `config.local.toml` **before** the first build. A list there *replaces* the default list,
so repeat the defaults:

```toml
# config.local.toml (git-ignored)
[notes]
enabled = true
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

## Tier 3: the launcher app (Semantero.app)

```bash
# once: Command Line Tools (xcode-select --install) or full Xcode (see "Do I need Xcode?" below), and Node
(cd launcher-core && npm install)          # tools for building the ranking engine
make install-app                           # builds, signs and copies to /Applications
# or, notes index + app in one go (checks the notes index is enabled first):  make install-global
open "/Applications/Semantero.app"
```

On first launch:
1. **Documents access.** macOS asks: *"Semantero would like to access files in your Documents folder"* → **Allow**.
   This is needed because the vault usually lives in `~/Documents`. If you missed the prompt: System Settings → Privacy
   & Security → Files and Folders → Semantero → Documents.
2. **Accessibility** (asked the first time you press ⌘↵). It lets the app paste into the app you're in. Without it,
   ⌘↵ copies and a toast tells you to press ⌘V.
3. A magnifying glass appears in the menu bar. Its menu shows "N papers, M notes".
4. Press **⌥Space**. Change the hotkey in Settings… if another app already uses it.

**Signing.** `make install-app` signs with the first "Apple Development" identity in your keychain, or with
`$SEMANTERO_SIGN_IDENTITY`, or ad hoc (`signing with: -`). With an ad hoc signature, macOS forgets permissions 1 and 2 at
every reinstall. Adding your Apple ID in Xcode creates a free development identity and fixes that.

### Do I need Xcode?

The app ships as source, so it is built on your Mac. What each tool is actually needed for:

| Needed for | Command Line Tools only (`xcode-select --install`) | Full Xcode |
|---|---|---|
| Building and running the app: the ⌥Space panel, every action (open, paste file, paste passage, copy, Finder, Quick Look, drag), notes + papers search | **Yes, enough**. Checked: the app compiles and links with the Command Line Tools alone | yes |
| Paper and note titles in Spotlight (⌘Space) | **Yes**: plain Core Spotlight, no extra build step | yes |
| The Spotlight **"Search Everything"** action (⌘Space → type it → Tab → query) | **No**. Spotlight only sees the action if a metadata file is generated at build time by `appintentsmetadataprocessor`, which ships only with Xcode. Without it `make install-app` prints a warning and builds the app without that one action | yes |
| A stable signature, so macOS keeps the Documents and Accessibility permissions across updates | Possible, untested: create a self-signed *Code Signing* certificate in Keychain Access (Certificate Assistant) and build with `SEMANTERO_SIGN_IDENTITY="<its name>" make install-app`. Otherwise the app is signed ad hoc and the two permissions are asked for again after every update | Easy: add your Apple ID (free) in Xcode → Settings → Accounts |
| The Swift test suite (`make test-swift`, `make check`): contributors only | **No**: Swift's test frameworks aren't in the Command Line Tools | yes |

Caveat: the Command-Line-Tools-only path was checked by compiling the app, not by a full `make install-global` run on a
Mac without Xcode. If a step fails there, the error names the missing tool; please report it. A ready-built app on
GitHub Releases would remove the need for any build tools, but it would have to be notarized (a paid Apple Developer
account) to open without macOS's "unidentified developer" warning, so it isn't offered.

**Updating the app** (the running copy isn't replaced in place):

```bash
make install-app && pkill -f "Semantero.app/Contents/MacOS/Semantero"; sleep 1; open "/Applications/Semantero.app"
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
| Launcher | First menu bar → Settings… → untick the three Spotlight boxes → Save (this removes its Spotlight entries). Then Quit, and `rm -rf "/Applications/Semantero.app" ~/Library/Application\ Support/Semantero\ Search`; `defaults delete dev.semantero.app` |
| Watcher | `./setup-search.sh stop` and `rm ~/Library/LaunchAgents/com.planner.zotero-watch.plist` |
| pplx model and service | See [EMBED_INSTALLS.md → Removing](EMBED_INSTALLS.md#removing) |
| Planner jobs | `launchctl bootout gui/$(id -u)/com.planner.morning` (and `.weekly`), then remove the plists |
| Plugin | Disable it in Obsidian, then delete `<vault>/.obsidian/plugins/semantero` |
| Indexes and state | `<vault>/.planner/` (indexes, sidecars, state). Your notes are not touched |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Launcher says "isn't allowed to read your vault" | Allow Documents in Privacy & Security → Files and Folders, then menu bar → Reload Indexes |
| ⌘↵ only copies ("press ⌘V" toast) | Allow Semantero under Privacy & Security → Accessibility. With an ad hoc signature this resets on each reinstall |
| Grey dot "semantic off: pplx service not reachable" | `bash pplx/install-service.sh` reinstalls and restarts it; its log is `logs/pplxd.log` |
| Grey dot "semantic off: Ollama not reachable" | `brew services start ollama`; `ollama list` should include `qwen3-embedding:0.6b` |
| `_LSOpenURLsWithCompletionHandler() failed with error -600` after reinstalling | The old copy was still quitting: run `open` again (or put `sleep 1` before it) |
| ⌥Space does something else | Another app has it (e.g. an assistant's quick-entry key). Pick another hotkey in Settings |
| A note never shows up | `planner notes stats` (is it excluded? is the index fresh?). Notes in symlinked folders and tags starting with accented letters are not indexed |
| Outlook on the web shows "Something went wrong while the document preview was being created" | The pasted file is correct (verified byte-for-byte in Firefox); it's Outlook's previewer. Download it to check, or compare with Outlook's own Attach button |
| Launcher uses lots of memory | It settles at ~100–150 MB a few seconds after start or after an index change (more for bigger libraries). A watchdog reloads if it is ever over 350 MB while hidden. Activity Monitor's "Memory" is the right number |
| `planner doctor` flags the notes index | The message says the fix: `planner notes index` (missing or stale), `--full` (model changed), or start Ollama (degraded) |
| `make check` fails on a fresh clone | Run `make dev-setup` (npm packages for both TypeScript projects and the Python venv); `make test-swift` needs full Xcode (the app itself doesn't) |
| `make install-app` warns "App Intents metadata not generated" | Full Xcode isn't installed or selected. The app works; only the Spotlight "Search Everything" action is missing. See [Do I need Xcode?](#do-i-need-xcode) |
