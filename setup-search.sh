#!/usr/bin/env bash
# ==============================================================================
# Semantero & Background Indexer Setup
#
# Sets up the local hybrid paper search engine (BM25 + embeddings: the frozen
# pplx-embed-v2-late model by default, or qwen3-embedding:0.6b via Ollama with
# --model qwen), installs the Obsidian plugin into your vault, builds your
# initial index from Zotero, and registers the background launchd watcher daemon.
# ==============================================================================

set -eo pipefail

# Ensure Homebrew and standard tool paths are available
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Text formatting
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
NC="\033[0m"

info()    { echo -e "${BLUE}==>${NC} ${BOLD}$*${NC}"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC} $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

# Usage message
usage() {
    cat <<EOF
${BOLD}Semantero Setup & Management${NC}

Usage:
  ./setup-search.sh [command] [options]

Commands:
  setup              Full end-to-end setup (default if no command given)
  status             Check health of the embedding model, index, and launchd background watcher
  index [--full]     Build or update search index from Zotero
  watch              Run the watcher in the foreground (useful for debugging)
  start              Start / load background watcher daemon in launchd
  stop               Stop / unload background watcher daemon from launchd
  logs               View recent background watcher logs

Options:
  --vault <path>     Path to your Obsidian Vault (default: read from config.toml or ~/Documents/Obsidian Vault)
  --zotero <path>    Path to your Zotero directory (default: ~/Zotero)
  --model <name>     Embedding model for a new install: pplx (default; pplx-embed-v2-late, a ~550 MB download)
                     or qwen (qwen3-embedding:0.6b via Ollama, ~600 MB).
                     An existing index keeps its model; switch with: planner profile build/use (docs/EMBED_INSTALLS.md)
  -h, --help         Show this help message
EOF
}

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

# Expand ~ to $HOME
expand_path() {
    local p="$1"
    if [[ "$p" == ~* ]]; then
        echo "${p/#~/$HOME}"
    else
        echo "$p"
    fi
}

# Auto-detect Obsidian Vault on macOS
auto_detect_vault() {
    local detected=""
    local obs_json="$HOME/Library/Application Support/obsidian/obsidian.json"
    if [[ -f "$obs_json" ]]; then
        detected=$(python3 -c '
import json, os, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    vaults = [v for v in d.get("vaults", {}).values() if v.get("path") and os.path.isdir(v.get("path"))]
    vaults.sort(key=lambda v: (not v.get("open", False)))
    if vaults:
        print(vaults[0]["path"])
except Exception:
    pass
' "$obs_json" 2>/dev/null || true)
    fi
    if [[ -n "$detected" && -d "$detected" ]]; then
        echo "$detected"
        return
    fi
    echo "$HOME/Documents/Obsidian Vault"
}

# Auto-detect Zotero data directory on macOS
auto_detect_zotero() {
    if [[ -f "$HOME/Zotero/zotero.sqlite" ]]; then
        echo "$HOME/Zotero"
        return
    fi
    local zotero_prefs
    zotero_prefs=$(python3 -c '
import glob, os, re
for p in glob.glob(os.path.expanduser("~/Library/Application Support/Zotero/Profiles/*/prefs.js")):
    try:
        with open(p) as f:
            for line in f:
                m = re.search(r"extensions\.zotero\.dataDir\",\s*\"([^\"]+)\"", line)
                if m and os.path.isdir(m.group(1)) and os.path.exists(os.path.join(m.group(1), "zotero.sqlite")):
                    print(m.group(1))
                    exit(0)
    except Exception:
        pass
' 2>/dev/null || true)
    if [[ -n "$zotero_prefs" && -f "$zotero_prefs/zotero.sqlite" ]]; then
        echo "$zotero_prefs"
        return
    fi
    echo "$HOME/Zotero"
}

# Read vault path from config.local.toml, config.toml, or auto-detect
get_config_vault() {
    for f in "$SCRIPT_DIR/config.local.toml" "$SCRIPT_DIR/config.toml"; do
        if [[ -f "$f" ]]; then
            local raw
            raw=$(grep -E '^[[:space:]]*vault[[:space:]]*=' "$f" | head -n1 | sed -E 's/^[[:space:]]*vault[[:space:]]*=[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/' | tr -d '\r')
            if [[ -n "$raw" ]]; then
                local exp
                exp="$(expand_path "$raw")"
                if [[ -d "$exp" ]]; then
                    echo "$exp"
                    return
                fi
            fi
        fi
    done
    auto_detect_vault
}

# Read zotero directory from config.local.toml, config.toml, or auto-detect
get_config_zotero() {
    for f in "$SCRIPT_DIR/config.local.toml" "$SCRIPT_DIR/config.toml"; do
        if [[ -f "$f" ]]; then
            local raw
            raw=$(grep -E '^[[:space:]]*zotero_dir[[:space:]]*=' "$f" | head -n1 | sed -E 's/^[[:space:]]*zotero_dir[[:space:]]*=[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/' | tr -d '\r')
            if [[ -n "$raw" ]]; then
                local exp
                exp="$(expand_path "$raw")"
                if [[ -f "$exp/zotero.sqlite" ]]; then
                    echo "$exp"
                    return
                fi
            fi
        fi
    done
    auto_detect_zotero
}

# Persistently update custom vault and zotero_dir paths in config.local.toml (git-ignored)
update_config_paths() {
    local v="$1"
    local z="$2"
    python3 -c '
import os, re, sys
home = os.path.expanduser("~")
def compact(p):
    if p and p.startswith(home):
        return "~" + p[len(home):]
    return p

vault = compact(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else None
zotero = compact(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None

is_custom_vault = vault and vault != "~/Documents/Obsidian Vault"
is_custom_zotero = zotero and zotero != "~/Zotero"

path = "config.local.toml"
content = ""
if os.path.exists(path):
    with open(path) as f:
        content = f.read()

if is_custom_vault:
    if re.search(r"^[ \t]*vault[ \t]*=", content, flags=re.M):
        content = re.sub(r"^[ \t]*vault[ \t]*=.*$", f"vault = \"{vault}\"", content, flags=re.M)
    else:
        content = f"vault = \"{vault}\"\n" + content

if is_custom_zotero:
    if re.search(r"^[ \t]*zotero_dir[ \t]*=", content, flags=re.M):
        content = re.sub(r"^[ \t]*zotero_dir[ \t]*=.*$", f"zotero_dir = \"{zotero}\"", content, flags=re.M)
    elif "[search]" in content:
        content = content.replace("[search]", f"[search]\nzotero_dir = \"{zotero}\"")
    else:
        content += f"\n[search]\nzotero_dir = \"{zotero}\"\n"

if is_custom_vault or is_custom_zotero:
    with open(path, "w") as f:
        f.write(content.strip() + "\n")
' "$v" "$z" 2>/dev/null || true
}

# A value from the planner's resolved config (config.toml, config.local.toml and the live profile), or "" if unreadable
planner_value() {
    "$SCRIPT_DIR/.venv/bin/python" -c "from planner import config; c = config.load(); print($1)" 2>/dev/null || true
}

# Ollama and qwen3-embedding:0.6b (the --model qwen install)
setup_ollama() {
    if ! command -v ollama >/dev/null 2>&1; then
        warn "Ollama is not installed. Dense semantic search requires Ollama."
        warn "Install it via: brew install --cask ollama  (or visit https://ollama.com)"
        return
    fi
    # Check if Ollama service is running
    if ! curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        info "Starting Ollama..."
        if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q ollama; then
            brew services start ollama >/dev/null 2>&1 || true
        elif [[ -d "/Applications/Ollama.app" ]]; then
            open -a Ollama >/dev/null 2>&1 || true
        fi
        sleep 3
    fi

    if curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        success "Ollama service is reachable"
        local models
        models=$(ollama list 2>/dev/null || true)
        if [[ "$models" != *"qwen3-embedding"* ]]; then
            info "Pulling qwen3-embedding:0.6b (fast, ~600MB)..."
            ollama pull qwen3-embedding:0.6b
            success "Downloaded qwen3-embedding:0.6b"
        else
            success "Model qwen3-embedding:0.6b is ready"
        fi
    else
        warn "Could not connect to Ollama at http://127.0.0.1:11434."
        warn "Keyword BM25 search will still work; start Ollama whenever you want semantic search."
    fi
}

# pplx-embed-v2-late (the default install): download the frozen model once, then start its service. Fails softly.
setup_pplx() {
    if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
        warn "pplx-embed-v2-late runs on a pinned macOS arm64 llama.cpp build only."
        return 1
    fi
    if ! command -v uv >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then
            info "Installing uv via Homebrew (Python environments for the model)..."
            brew install uv || return 1
        else
            warn "uv is required for pplx (https://docs.astral.sh/uv/)."
            return 1
        fi
    fi
    local model_dir="$HOME/Library/Application Support/Semantero/models/pplx-embed-v2-late-0.6b@7bba8e7"
    if [[ -f "$model_dir/SHA256SUMS" ]]; then
        success "pplx-embed-v2-late is already converted"
    else
        info "Downloading pplx-embed-v2-late (once, ~550 MB; every file is checked against pplx/model.sha256)..."
        bash "$SCRIPT_DIR/pplx/fetch.sh" || return 1
        success "Downloaded and verified pplx-embed-v2-late (accuracy check: $model_dir/PARITY.md)"
    fi
    info "Starting the pplx service (com.planner.pplxd)..."
    bash "$SCRIPT_DIR/pplx/install-service.sh" || return 1
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -s -m 2 http://127.0.0.1:11435/health 2>/dev/null | grep -q '"ok": true'; then
            success "pplx service is running at http://127.0.0.1:11435"
            return 0
        fi
        sleep 1
    done
    warn "The pplx service did not answer; see logs/pplxd.log."
    return 1
}

# Makes pplx-v2-late the live profile of a vault that has no index yet. An existing index is left as it is.
choose_profile() {
    local data_dir
    data_dir="$(planner_value 'c.data_dir')"
    [[ -n "$data_dir" ]] || return 0
    if [[ ! -f "$data_dir/search/manifest.json" && ! -f "$data_dir/profile.json" ]]; then
        mkdir -p "$data_dir"
        echo '{"name": "pplx-v2-late"}' > "$data_dir/profile.json"
        success "New index will use pplx-v2-late"
    elif [[ "$(planner_value 'c.search.get("backend", "ollama")')" != "pplx" ]]; then
        info "Your existing index keeps its model. To move it to pplx (takes about as long as a first build):"
        info "  .venv/bin/python -m planner profile build pplx-v2-late && .venv/bin/python -m planner profile use pplx-v2-late"
    fi
}

# ------------------------------------------------------------------------------
# Action Handlers
# ------------------------------------------------------------------------------

cmd_status() {
    info "Checking Semantero status..."

    # 1. Python environment
    if [[ -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
        local py_ver
        py_ver=$("$SCRIPT_DIR/.venv/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null || echo "broken")
        success "Python venv: Python $py_ver"
    else
        warn "Python venv: Not installed (.venv missing)"
    fi

    # 2. Poppler / pdftotext
    if command -v pdftotext >/dev/null 2>&1; then
        local pdf_ver
        pdf_ver=$(pdftotext -v 2>&1 | head -n1 || echo "installed")
        success "Poppler: $pdf_ver"
    else
        warn "Poppler: pdftotext not found on PATH (run: brew install poppler)"
    fi

    # 3. Embedding model: the live index's backend
    if [[ "$(planner_value 'c.search.get("backend", "ollama")')" == "pplx" ]]; then
        if curl -s -m 2 http://127.0.0.1:11435/health 2>/dev/null | grep -q '"ok": true'; then
            success "pplx service: Running at http://127.0.0.1:11435 (pplx-embed-v2-late)"
        else
            warn "pplx service: Not answering (run: bash pplx/install-service.sh, or see logs/pplxd.log)"
        fi
    elif curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        success "Ollama daemon: Running at http://localhost:11434"
        if command -v ollama >/dev/null 2>&1; then
            local models
            models=$(ollama list 2>/dev/null || true)
            if [[ "$models" == *"qwen3-embedding"* ]]; then
                success "Ollama model: qwen3-embedding:0.6b is ready"
            else
                warn "Ollama model: qwen3-embedding:0.6b not found (run: ollama pull qwen3-embedding:0.6b)"
            fi
        fi
    else
        warn "Ollama daemon: Not running (start via Ollama app or brew services start ollama)"
    fi

    # 4. Zotero database
    local zotero_dir
    zotero_dir="$(get_config_zotero)"
    if [[ -f "$zotero_dir/zotero.sqlite" ]]; then
        success "Zotero database: Found at $zotero_dir/zotero.sqlite"
    else
        warn "Zotero database: Not found at $zotero_dir/zotero.sqlite"
    fi

    # 5. Obsidian Vault & Search Index
    local vault_dir
    vault_dir="$(get_config_vault)"
    if [[ -d "$vault_dir" ]]; then
        success "Obsidian Vault: Found at $vault_dir"
        local manifest="$vault_dir/.planner/search/manifest.json"
        if [[ -f "$manifest" ]]; then
            local info_str
            info_str=$("$SCRIPT_DIR/.venv/bin/python" -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        m = json.load(f)
    p = m.get("papers", "?")
    c = m.get("chunks", "?")
    b = m.get("built_at", "unknown")
    miss = m.get("missing_vectors", 0)
    note = f" - KEYWORD-ONLY for {miss} texts until the embedding model runs" if miss else ""
    print(f"{p} papers ({c} chunks), built {b}{note}")
except Exception:
    print("present")
' "$manifest" 2>/dev/null || echo "present")
            if [[ "$info_str" == *KEYWORD-ONLY* ]]; then
                warn "Search Index: $info_str"
            else
                success "Search Index: $info_str"
            fi
        else
            warn "Search Index: No index found in $vault_dir/.planner/search"
        fi

        if [[ -f "$vault_dir/.obsidian/plugins/semantero/main.js" ]]; then
            success "Obsidian Plugin: Installed at .obsidian/plugins/semantero"
        else
            warn "Obsidian Plugin: Not installed in vault"
        fi
    else
        warn "Obsidian Vault: Directory not found at $vault_dir"
    fi

    # 6. Background Watcher Daemon (Launchd)
    if [[ "$(uname -s)" == "Darwin" ]]; then
        local uid
        uid=$(id -u)
        if launchctl print "gui/$uid/com.planner.zotero-watch" >/dev/null 2>&1; then
            success "Background Watcher: Active in launchd (com.planner.zotero-watch)"
        else
            warn "Background Watcher: Not loaded in launchd (run: ./setup-search.sh start)"
        fi
    fi

    # 7. Recent log entries
    if [[ -f "$SCRIPT_DIR/logs/zotero-watch.log" ]]; then
        echo -e "\n${BOLD}Recent Watcher Logs (last 5 lines):${NC}"
        tail -n 5 "$SCRIPT_DIR/logs/zotero-watch.log" | sed 's/^/  /'
    fi
}

cmd_logs() {
    local log="$SCRIPT_DIR/logs/zotero-watch.log"
    if [[ -f "$log" ]]; then
        echo -e "${BOLD}Last 40 lines of $log:${NC}"
        tail -n 40 "$log"
    else
        info "Log file $log does not exist yet."
    fi
}

cmd_index() {
    shift || true
    if [[ ! -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
        die "Virtualenv not found at .venv. Run ./setup-search.sh first."
    fi
    info "Running Zotero paper search indexer..."
    "$SCRIPT_DIR/.venv/bin/python" -m planner search index "$@"
}

cmd_watch() {
    if [[ ! -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
        die "Virtualenv not found at .venv. Run ./setup-search.sh first."
    fi
    info "Running watcher in foreground (watch-run)..."
    "$SCRIPT_DIR/.venv/bin/python" -m planner search watch-run
}

cmd_stop() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        die "launchd stop is only supported on macOS."
    fi
    local uid
    uid=$(id -u)
    info "Stopping background watcher daemon (com.planner.zotero-watch)..."
    launchctl bootout "gui/$uid/com.planner.zotero-watch" 2>/dev/null || true
    success "Watcher daemon stopped."
}

cmd_start() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        die "launchd start is only supported on macOS."
    fi
    local plist="$HOME/Library/LaunchAgents/com.planner.zotero-watch.plist"
    if [[ ! -f "$plist" ]]; then
        warn "Plist not found at $plist. Running setup to generate it..."
        cmd_setup
        return
    fi
    local uid
    uid=$(id -u)
    info "Registering watcher daemon in launchd..."
    launchctl bootout "gui/$uid/com.planner.zotero-watch" 2>/dev/null || true
    launchctl bootstrap "gui/$uid" "$plist"
    success "Watcher daemon started and scheduled to watch Zotero."
}

cmd_setup() {
    local custom_vault=""
    local custom_zotero=""
    local model="pplx"

    # Parse setup-specific arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --vault)
                custom_vault="$2"
                shift 2
                ;;
            --zotero)
                custom_zotero="$2"
                shift 2
                ;;
            --model)
                model="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    [[ "$model" == "pplx" || "$model" == "qwen" ]] || die "--model must be pplx or qwen (got: $model)"

    echo -e "${BOLD}======================================================${NC}"
    echo -e "${BOLD}       Semantero & Background Watcher Setup   ${NC}"
    echo -e "${BOLD}======================================================${NC}\n"

    # 1. OS Check
    local os_name
    os_name=$(uname -s)
    if [[ "$os_name" != "Darwin" ]]; then
        warn "Note: Automatic background indexing via launchd is macOS-only."
        warn "On Linux, you can run './setup-search.sh watch' or configure a systemd service."
    fi

    # 2. Python Environment (>= 3.11)
    info "Step 1/6: Checking Python environment..."
    local py_candidate=""
    for py in "$SCRIPT_DIR/.venv/bin/python" python3.11 python3.12 python3.13 python3.15 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3 /usr/local/bin/python3.11 /usr/local/bin/python3 python3; do
        if command -v "$py" >/dev/null 2>&1; then
            if "$py" -c 'import sys; assert sys.version_info >= (3, 11)' 2>/dev/null; then
                py_candidate="$py"
                break
            fi
        fi
    done

    if [[ -z "$py_candidate" ]]; then
        if command -v brew >/dev/null 2>&1; then
            info "Python 3.11+ not found. Installing python@3.11 via Homebrew..."
            brew install python@3.11
            export PATH="/opt/homebrew/opt/python@3.11/bin:/usr/local/opt/python@3.11/bin:$PATH"
            py_candidate="$(command -v python3.11 || echo "/opt/homebrew/bin/python3.11")"
        else
            die "Python 3.11+ is required. Please install Python 3.11+."
        fi
    fi

    if [[ ! -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
        info "Creating Python virtual environment in .venv..."
        "$py_candidate" -m venv "$SCRIPT_DIR/.venv"
        success "Created .venv using $py_candidate"
    else
        success "Using existing .venv"
    fi

    # Ensure pip packages if requirements exist (optional SDK dependencies for weekly review)
    if [[ -f "$SCRIPT_DIR/requirements.txt" ]]; then
        "$SCRIPT_DIR/.venv/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt" 2>/dev/null || true
    fi

    # 3. Poppler / pdftotext
    info "Step 2/6: Checking poppler (pdftotext)..."
    if ! command -v pdftotext >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then
            info "Installing poppler via Homebrew..."
            brew install poppler
            success "Installed poppler"
        else
            warn "pdftotext not found. PDF full-text indexing requires poppler."
            warn "Install it with: brew install poppler"
        fi
    else
        success "Poppler (pdftotext) is installed"
    fi

    # 4. Embedding model
    if [[ "$model" == "pplx" ]]; then
        info "Step 3/6: Setting up the embedding model (pplx-embed-v2-late)..."
        if ! setup_pplx; then
            warn "pplx setup failed; falling back to qwen3-embedding:0.6b via Ollama. Retry later with: ./setup-search.sh"
            model="qwen"
        fi
    else
        info "Step 3/6: Checking Ollama & embedding model (qwen3-embedding:0.6b)..."
    fi
    [[ "$model" == "qwen" ]] && setup_ollama

    # 5. Zotero & Vault Configuration
    info "Step 4/6: Configuring paths..."
    local zotero_dir
    if [[ -n "$custom_zotero" ]]; then
        zotero_dir="$(expand_path "$custom_zotero")"
    else
        zotero_dir="$(get_config_zotero)"
    fi

    if [[ ! -f "$zotero_dir/zotero.sqlite" ]]; then
        warn "Zotero database not found at $zotero_dir/zotero.sqlite"
        warn "If your Zotero is located elsewhere, run: ./setup-search.sh --zotero /path/to/Zotero"
    else
        success "Zotero database found at $zotero_dir/zotero.sqlite"
        # Check for Better BibTeX citekeys
        local citekey_count
        citekey_count=$(python3 -c '
import sqlite3, sys
try:
    conn = sqlite3.connect(f"file:{sys.argv[1]}?immutable=1", uri=True)
    cur = conn.cursor()
    cur.execute("""
        SELECT COUNT(*) FROM itemDataValues idv
        JOIN itemData id ON idv.valueID = id.valueID
        JOIN fields f ON id.fieldID = f.fieldID
        WHERE f.fieldName = "citationKey" AND idv.value IS NOT NULL AND idv.value != ""
    """)
    print(cur.fetchone()[0])
    conn.close()
except Exception:
    print(-1)
' "$zotero_dir/zotero.sqlite" 2>/dev/null || echo -1)
        if [[ "$citekey_count" -eq 0 ]]; then
            warn "No citation keys (citekeys) found in your Zotero database."
            warn "Better BibTeX is required for Obsidian citations: https://retorque.re/zotero-better-bibtex/"
            warn "Without Better BibTeX, citation wikilinks ([[]]) and literature notes cannot be created."
        elif [[ "$citekey_count" -gt 0 ]]; then
            success "Found Better BibTeX citation keys ($citekey_count keys)"
        fi
    fi

    local vault_dir
    if [[ -n "$custom_vault" ]]; then
        vault_dir="$(expand_path "$custom_vault")"
    else
        vault_dir="$(get_config_vault)"
    fi

    local obs_json="$HOME/Library/Application Support/obsidian/obsidian.json"
    if [[ -z "$custom_vault" && -f "$obs_json" ]]; then
        local vault_count
        vault_count=$(python3 -c '
import json, os, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    vaults = [v["path"] for v in d.get("vaults", {}).values() if v.get("path") and os.path.isdir(v["path"])]
    print(len(vaults))
except Exception:
    print(0)
' "$obs_json" 2>/dev/null || echo 0)
        if [[ "$vault_count" -gt 1 ]]; then
            info "Detected $vault_count Obsidian vaults. Selected active vault: $vault_dir"
            info "(To use a different vault, run: ./setup-search.sh --vault /path/to/vault)"
        fi
    fi

    if [[ ! -d "$vault_dir" ]]; then
        warn "Obsidian Vault directory not found at '$vault_dir'."
        echo -n "Would you like to create it or specify a different path? [c=create / p=enter path / s=skip]: "
        read -r choice || choice="s"
        case "$choice" in
            c|C)
                mkdir -p "$vault_dir"
                success "Created vault directory at $vault_dir"
                ;;
            p|P)
                echo -n "Enter the full path to your Obsidian Vault: "
                read -r custom_input
                if [[ -n "$custom_input" ]]; then
                    vault_dir="$(expand_path "$custom_input")"
                    mkdir -p "$vault_dir"
                fi
                ;;
            *)
                warn "Proceeding with vault path: $vault_dir"
                ;;
        esac
    else
        success "Obsidian Vault found at $vault_dir"
    fi

    # Persist custom paths in config.local.toml if different from defaults
    update_config_paths "$vault_dir" "$zotero_dir"
    if [[ -f "$SCRIPT_DIR/config.local.toml" ]]; then
        success "Saved local overrides to config.local.toml (git-ignored)"
    else
        success "Using default vault and Zotero paths from config.toml"
    fi

    # 6. Install Obsidian Plugin
    info "Step 5/6: Installing Obsidian plugin into vault..."
    local plugin_source="$SCRIPT_DIR/obsidian/paper-search"
    local plugin_dest="$vault_dir/.obsidian/plugins/semantero"

    # Check main.js
    if [[ ! -f "$plugin_source/main.js" ]]; then
        if command -v npm >/dev/null 2>&1; then
            info "Building plugin with npm..."
            (cd "$plugin_source" && npm run build)
        fi
    fi

    local same_target=false
    if [[ -d "$plugin_dest" || -L "$plugin_dest" ]]; then
        local src_can dst_can
        src_can="$(cd "$plugin_source" 2>/dev/null && pwd -P || echo "src")"
        dst_can="$(cd "$plugin_dest" 2>/dev/null && pwd -P || echo "dst")"
        if [[ "$src_can" == "$dst_can" ]]; then
            same_target=true
        fi
    fi

    if [[ "$same_target" == "true" ]]; then
        success "Plugin is already symlinked/active at $plugin_dest"
    elif [[ -f "$plugin_source/main.js" && -f "$plugin_source/manifest.json" ]]; then
        mkdir -p "$plugin_dest"
        cp "$plugin_source/main.js" "$plugin_dest/main.js"
        cp "$plugin_source/manifest.json" "$plugin_dest/manifest.json"
        success "Copied plugin files to $plugin_dest"
    else
        warn "Plugin assets not found in obsidian/paper-search. Build with: cd obsidian/paper-search && npm run build"
    fi

    # 7. Initial Search Index & Background Watcher
    [[ "$model" == "pplx" ]] && choose_profile
    info "Step 6/6: Building initial search index..."
    if [[ "$(planner_value 'c.search.get("backend", "ollama")')" == "pplx" ]]; then
        info "(pplx embeds every page once: allow roughly an hour per 9,000 paper texts; later updates take seconds)"
    fi
    mkdir -p "$SCRIPT_DIR/logs"
    if [[ -f "$zotero_dir/zotero.sqlite" ]]; then
        "$SCRIPT_DIR/.venv/bin/python" -m planner search index || warn "Initial indexing encountered an error; you can retry with ./setup-search.sh index"
    else
        warn "Skipping initial indexing since Zotero database was not found."
    fi

    # 8. Setup launchd background watcher (macOS)
    if [[ "$os_name" == "Darwin" ]]; then
        info "Configuring macOS background watcher daemon..."
        mkdir -p "$HOME/Library/LaunchAgents" "$SCRIPT_DIR/logs" "$zotero_dir/storage"
        local plist_target="$HOME/Library/LaunchAgents/com.planner.zotero-watch.plist"

        cat <<EOF > "$plist_target"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.planner.zotero-watch</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>$SCRIPT_DIR/bin/planner-run.sh</string>
        <string>search</string>
        <string>watch-run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>WatchPaths</key>
    <array>
        <string>$zotero_dir/zotero.sqlite</string>
        <string>$zotero_dir/zotero.sqlite-wal</string>
        <string>$zotero_dir/storage</string>
    </array>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!-- Hourly retry for a keyword-only index; exits after a fingerprint check otherwise. -->
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONUNBUFFERED</key>
        <string>1</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/logs/zotero-watch.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/logs/zotero-watch.log</string>
</dict>
</plist>
EOF

        local uid
        uid=$(id -u)
        launchctl bootout "gui/$uid/com.planner.zotero-watch" 2>/dev/null || true
        launchctl bootstrap "gui/$uid" "$plist_target"
        success "Registered and started background watcher in launchd ($plist_target)"
    fi

    echo -e "\n${GREEN}${BOLD}======================================================${NC}"
    echo -e "${GREEN}${BOLD}               Setup Complete!                        ${NC}"
    echo -e "${GREEN}${BOLD}======================================================${NC}\n"
    echo -e "Next steps in Obsidian:"
    echo -e "  1. Open Obsidian -> ${BOLD}Settings${NC} -> ${BOLD}Community plugins${NC}."
    echo -e "  2. Click the reload icon next to Installed plugins."
    echo -e "  3. Toggle ${BOLD}Semantero${NC} to ${GREEN}ON${NC}."
    echo -e "\nHow to use:"
    echo -e "  • ${BOLD}Cmd+Shift+0${NC} (or Mod+Shift+0): Open instant hybrid paper search modal."
    echo -e "    - ${BOLD}Enter${NC}: Open PDF in Zotero directly at the matching page."
    echo -e "    - ${BOLD}Cmd+Enter${NC}: Insert citation and ensure literature note exists."
    echo -e "    - ${BOLD}Alt+Enter${NC}: Open/create literature note."
    echo -e "    - ${BOLD}Shift+Enter${NC}: Select paper in Zotero."
    echo -e "  • ${BOLD}@@${NC}: Type anywhere in notes for inline citation autocomplete."
    echo -e "  • ${BOLD}Command Palette${NC} -> 'Semantero: Open related papers panel' for contextual literature suggestions."
    echo -e "\n${BOLD}Background Indexing:${NC}"
    echo -e "  • The watcher automatically updates your index whenever you add or edit papers in Zotero."
    echo -e "  • Check status anytime with: ${BOLD}./setup-search.sh status${NC}"
    echo -e "  • View live logs with: ${BOLD}./setup-search.sh logs${NC}\n"
}

# ------------------------------------------------------------------------------
# Main Dispatcher
# ------------------------------------------------------------------------------

ACTION="${1:-setup}"

case "$ACTION" in
    setup|install)
        shift 2>/dev/null || true
        cmd_setup "$@"
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs
        ;;
    index)
        shift
        cmd_index "$@"
        ;;
    watch)
        cmd_watch
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        # If the first argument starts with --, treat as setup with flags
        if [[ "$ACTION" == --* ]]; then
            cmd_setup "$@"
        else
            error "Unknown command: $ACTION"
            usage
            exit 1
        fi
        ;;
esac
