# daito

A personal research and productivity layer combining **Obsidian** notes and **Zotero** literature.

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
- **BM25 Keyword Search**: An inverted index with prefix expansion over paper titles, author surnames, citekeys, abstracts, and full PDF text chunks.
- **Dense Vector Search**: Powered locally by [Ollama](https://ollama.com) running `qwen3-embedding:0.6b` (1024 dimensions).
- **Reciprocal Rank Fusion ($k=60$)**: Blends keyword and semantic scores so exact term matches and high-level conceptual queries both rank at the top.

### 2. Automatic Background Indexing (Zotero Watcher)
You never have to manually re-index or run terminal commands when reading and collecting papers:
- A lightweight background daemon (`com.planner.zotero-watch` via macOS `launchd`) monitors your Zotero database (`~/Zotero/zotero.sqlite`) and PDF storage directory (`~/Zotero/storage`).
- Whenever you add a paper, attach a PDF, or edit metadata in Zotero, the watcher detects the modification.
- It waits 20 seconds for database writes to settle (quiet window), computes a fingerprint of the library, extracts clean text from new PDFs (stripping running headers, footers, and references), chunks the content, computes vector embeddings, and writes the updated index to `.planner/search/` inside your Obsidian vault.
- The Obsidian plugin detects the updated index and hot-swaps it atomically in memory without interrupting your typing.

---

## Quick Setup for Friends (5-Minute Install)

### Prerequisites
Make sure you have installed on your Mac:
1. **[Zotero](https://www.zotero.org/)** with the **[Better BibTeX](https://retorque.re/zotero-better-bibtex/)** plugin installed (*Required*: Better BibTeX generates the `citekey` field used for Obsidian wikilinks `[[citekey]]`, inline `@@` autocomplete, and literature notes).
2. **[Obsidian](https://obsidian.md/)** (with an existing vault).
3. **[Homebrew](https://brew.sh/)** (recommended for installing poppler, Ollama, and Python 3.11+).
4. **[Ollama](https://ollama.com)** (*Recommended*): Powers local semantic vector search via `qwen3-embedding:0.6b`. If Ollama is offline or not installed, Daito seamlessly falls back to BM25 keyword search without crashing, and automatically activates semantic search once Ollama is running.

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

## Features & Shortcuts

### Instant Paper Search (`Cmd+Shift+0` / `Mod+Shift+0`)
Open the search modal from anywhere in Obsidian:
- Type words, authors, citekeys, or conceptual queries (e.g. `optogenetics neural control`).
- **`Enter`**: Open the paper's PDF directly in Zotero at the matching page.
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
  ├── searchindex.py    Zotero SQLite extractor, PDF chunker, Ollama embedder, BM25 builder
  ├── zotwatch.py       Incremental watcher with quiet window & library fingerprinting
  └── embed.py          Local Ollama embedding client
obsidian/paper-search/  Obsidian plugin (TypeScript)
  ├── src/engine.ts     In-memory BM25 + dense dot-product search with Reciprocal Rank Fusion
  ├── src/modal.ts      Search modal UI with instant page-level Zotero links
  ├── src/inline.ts     Inline @@ citation suggestion controller
  ├── src/related.ts    Related papers sidebar panel
  └── src/litnote.ts    Safe literature note generator
launchd/                macOS launchd plist definitions
config.toml             Vault paths, model settings, and search parameters
```
