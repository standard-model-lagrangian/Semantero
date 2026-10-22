# daito

A personal research and productivity layer combining **Obsidian** notes and **Zotero** literature.

**Install guide (pick a tier: Obsidian only, notes, the launcher app, the planner): [docs/INSTALL.md](docs/INSTALL.md).** All documentation: [docs/](docs/README.md).

This repository includes **Daito Paper Search**: a local, hybrid paper search engine and Obsidian plugin that gives you instant Zotero search, inline citation autocompletion (`@@`), automatic literature note generation, and context-aware related paper recommendations.

---

## How It Works

Daito Paper Search runs entirely on your local machine with **zero external cloud API calls** and **zero recurring costs**:

```
 ┌──────────────────────────┐             ┌──────────────────────────┐
 │       Zotero App         │             │      Obsidian Vault      │
 │                          │             │                          │
 │  • zotero.sqlite         │             │  • .obsidian/plugins/    │
 │  • storage/ (PDF files)  │             │    daito-paper-search/   │
 └────────────┬─────────────┘             │                          │
              │ (watches changes)         │  • .planner/search/      │
              ▼                           │    - manifest.json       │
 ┌──────────────────────────┐             │    - papers.json         │
 │ Background Watcher       │             │    - chunks.json         │
 │ (macOS launchd daemon)   │             │    - vectors.f32         │
 │                          │             └────────────▲─────────────┘
 │  1. Quiet wait (20s)     │                          │
 │  2. Fingerprint check    │                          │
 │  3. Extract text from PDF│                          │
 │  4. Ollama Embeddings    ├──────────────────────────┘
 │     (qwen3-embedding)    │   (writes atomic hybrid index)
 └──────────────────────────┘
```

### 1. Hybrid Search Engine (BM25 + Dense Embeddings)
- **BM25 Keyword Search**: An inverted index with prefix expansion over paper titles, author surnames, citekeys, abstracts, and full-text chunks from PDFs and Zotero web snapshots (HTML attachments).
- **Dense Vector Search**: Powered locally by [Ollama](https://ollama.com) running `qwen3-embedding:0.6b` (1024 dimensions).
- **Reciprocal Rank Fusion ($k=60$)**: Blends keyword and semantic scores so exact term matches and high-level conceptual queries both rank at the top.

### 2. Automatic Background Indexing (Zotero Watcher)
You never have to manually re-index or run terminal commands when reading and collecting papers:
- A lightweight background daemon (`com.planner.zotero-watch` via macOS `launchd`) monitors your Zotero database (`~/Zotero/zotero.sqlite`) and PDF storage directory (`~/Zotero/storage`).
- Whenever you add a paper, attach a PDF, or edit metadata in Zotero, the watcher detects the modification.
- It waits 20 seconds for database writes to settle (quiet window), computes a fingerprint of the library, extracts clean text from new PDFs (stripping running headers, footers, and references) and web snapshots (dropping scripts, styles, navigation, headers and footers), chunks the content, computes vector embeddings, and writes the updated index to `.planner/search/` inside your Obsidian vault.
- The Obsidian plugin detects the updated index and hot-swaps it atomically in memory without interrupting your typing.

---

## Quick Setup for Friends (5-Minute Install)

### Prerequisites
Make sure you have installed on your Mac:
1. **[Zotero](https://www.zotero.org/)** with the **[Better BibTeX](https://retorque.re/zotero-better-bibtex/)** plugin installed (*Required*: Better BibTeX generates the `citekey` field used for Obsidian wikilinks `[[citekey]]`, inline `@@` autocomplete, and literature notes).
2. **[Obsidian](https://obsidian.md/)** (with an existing vault).
3. **[Homebrew](https://brew.sh/)** (recommended for installing poppler, Ollama, and Python 3.11+).
4. **[Ollama](https://ollama.com)** (*Recommended*): Powers local semantic vector search via `qwen3-embedding:0.6b`. If Ollama is offline or not installed, indexing falls back to BM25 keyword search instead of failing. Once Ollama is running, the watcher fills in the missing embeddings within the hour (or immediately with `./setup-search.sh index`); `./setup-search.sh status` shows when the index is keyword-only.

### 1. Clone & Run the Setup Script
Open Terminal and run:

```bash
git clone https://github.com/standard-model-lagrangian/daito.git
cd daito
./setup-search.sh
```

*(If your Obsidian vault or Zotero folder is not in the default location, specify them with flags:)*
```bash
./setup-search.sh --vault "/path/to/your/Obsidian Vault" --zotero "/path/to/Zotero"
```
> Custom paths are saved to a git-ignored `config.local.toml`, so future `git pull` updates will never conflict with your personal directory structure.

### What the script handles automatically:
1. Creates a Python virtual environment (`.venv`) using Python 3.11+ (installs via Homebrew if needed).
2. Checks for `pdftotext` (`poppler`) and offers to install it via Homebrew.
3. Checks for Ollama, starts the daemon, and downloads the local `qwen3-embedding:0.6b` model.
4. Copies the `daito-paper-search` plugin into your vault (`.obsidian/plugins/daito-paper-search/`).
5. Validates Better BibTeX citekeys in your Zotero library and builds your initial search index into `.planner/search/` in your vault.
6. Installs and registers the automatic background watcher daemon (`com.planner.zotero-watch`) in `launchd`.

### 2. Enable the Plugin in Obsidian
1. In Obsidian, open **Settings** (`Cmd+,`).
2. Go to **Community plugins**.
3. Under **Installed plugins**, click the reload icon, then toggle **Daito Paper Search** to **ON**.

---

## Daito Search: the launcher (macOS 26, optional)

A menu-bar app that searches your Zotero library **and** your Obsidian notes from any app:

- **⌥Space** opens a floating glass panel. Results update as you type (keyword at once, semantic after a pause), with
  the matching passage and page.
- **↵** opens the paper in Zotero at that page, or the note in Obsidian. **⌘↵** pastes the PDF itself into the app you
  were in (Mail, Teams, an LLM chat). **⌘⇧↵** pastes the passage with its citation. **⌘K** lists every action: copy
  file, path, citation or `[[wikilink]]`, show in Finder, Quick Look, open the literature note. Rows also drag out as
  files.
- Papers and their literature notes appear as one row. Private notes can be excluded by glob and are never read.
- Paper and note titles also appear in Spotlight (⌘Space), plus a "Search Everything" Spotlight action.

Install: [docs/INSTALL.md, tier 3](docs/INSTALL.md#tier-3-the-launcher-app-daito-searchapp) (needs Xcode).
Design: [docs/LAUNCHER_SPEC.md](docs/LAUNCHER_SPEC.md).

---

## Features & Shortcuts

### Instant Paper Search (`Cmd+Shift+0` / `Mod+Shift+0`)
Open the search modal from anywhere in Obsidian:
- Type words, authors, citekeys, or conceptual queries (e.g. `optogenetics neural control`).
- **`Enter`**: Open the paper's PDF directly in Zotero at the matching page (or, for a web-snapshot match, the snapshot in Zotero's reader).
- **`Cmd+Enter`**: Insert citation link (default `[[citekey]]`) and create a literature note.
- **`Alt+Enter`**: Open the literature note, creating it from your template if it does not exist yet.
- **`Shift+Enter`**: Select and highlight the paper item in Zotero.

### Inline Citations (`@@`)
Type `@@` anywhere in prose to bring up an autocomplete suggest popup.
- Select a paper with `Enter` or `Tab`.
- Inserts `[[citekey]]` in a single editor transaction and asynchronously creates the literature note.

### Related Papers Panel
Open via Command Palette (`Cmd+P`) → **Daito: Open related papers panel**:
- Reads the passage or section around your cursor.
- Queries your Zotero library using calibrated instruction embeddings.
- Automatically hides papers you have already cited in the note (with a toggle to inspect them).

---

## Managing the Background Watcher

The setup script includes convenient management commands:

| Command | Description |
|---|---|
| `./setup-search.sh status` | Check status of Ollama, Python, index, and background daemon |
| `./setup-search.sh index` | Manually update or rebuild the search index |
| `./setup-search.sh logs` | View the last 40 lines of the background watcher log |
| `./setup-search.sh watch` | Run the watcher in the foreground (useful for testing) |
| `./setup-search.sh stop` | Stop and unload the background watcher daemon from `launchd` |
| `./setup-search.sh start` | Start and load the background watcher daemon into `launchd` |

You can also run health diagnostics at any time with:
```bash
# Check overall status and background watcher
./setup-search.sh status

# Or run search-specific health checks
.venv/bin/python -m planner doctor --search
```

---

## Architecture & Codebase Layout

```
setup-search.sh         One-command installer & watcher management script (symlinked as ./setup.sh)
planner/                Python indexing and planning backend
  ├── searchindex.py    Zotero SQLite extractor, PDF/snapshot chunker, Ollama embedder, BM25 builder
  ├── zotwatch.py       Incremental watcher with quiet window & library fingerprinting
  └── embed.py          Local Ollama embedding client
obsidian/paper-search/  Obsidian plugin (TypeScript)
  ├── src/engine.ts     In-memory BM25 + dense dot-product search with Reciprocal Rank Fusion
  ├── src/modal.ts      Search modal UI with instant page-level Zotero links
  ├── src/inline.ts     Inline @@ citation suggestion controller
  ├── src/related.ts    Related papers sidebar panel
  └── src/litnote.ts    Safe literature note generator
  ├── mdtext.py         Markdown notes → clean text, heading sections, chunks
  └── notesindex.py     Vault notes index (.planner/notes/), same format as the paper index
obsidian/paper-search/  Obsidian plugin (TypeScript); its src/{engine,bm25,rank,text,...}.ts is the shared ranking core
launcher-core/          Launcher ranking + view models (TypeScript) → dist/ranker.js, run by the app in JavaScriptCore
macos/                  Daito Search.app (Swift package: DaitoSearchKit, DaitoSearch, DaitoBench)
launchd/                macOS launchd plist definitions (the owner's copies: absolute paths)
config.toml             Vault paths, model settings, search and notes parameters (personal overrides: config.local.toml)
docs/                   Install guide, development guide, specs, decisions log: start at docs/README.md
```

## Contributing

Read [AGENTS.md](AGENTS.md) first: it has the layout, commands and the rules that keep the owner's vault safe. Design rationale lives in [docs/](docs/).

```bash
make check
```

On a fresh clone run `make dev-setup` first. `make check` runs ruff, `tsc --noEmit` (plugin and launcher-core), the Python (`unittest`), plugin and launcher-core (`node --test`) and Swift (Swift Testing; needs Xcode) suites, and fails if the committed `main.js` or `launcher-core/dist/ranker.js` is out of date. The full development guide is [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Changes are test-first: add the failing test, then the fix. Tests never touch a real vault, Zotero library or Ollama.
