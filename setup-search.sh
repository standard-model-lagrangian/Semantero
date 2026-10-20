#!/usr/bin/env bash
# ==============================================================================
# Daito Paper Search & Background Indexer Setup
#
# Sets up the local hybrid paper search engine (BM25 + Ollama embeddings),
# installs the Obsidian plugin into your vault, builds your initial index from
# Zotero, and registers the background launchd watcher daemon.
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
${BOLD}Daito Paper Search Setup & Management${NC}

Usage:
  ./setup-search.sh [command] [options]

Commands:
  setup              Full end-to-end setup (default if no command given)
  status             Check health of Ollama, index, and launchd background watcher
  index [--full]     Build or update search index from Zotero
  watch              Run the watcher in the foreground (useful for debugging)
  start              Start / load background watcher daemon in launchd
  stop               Stop / unload background watcher daemon from launchd
  logs               View recent background watcher logs

Options:
  --vault <path>     Path to your Obsidian Vault (default: read from config.toml or ~/Documents/Obsidian Vault)
  --zotero <path>    Path to your Zotero directory (default: ~/Zotero)
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
    for v in d.get("vaults", {}).values():
        p = v.get("path")
        if p and os.path.isdir(p):
            print(p)
            break
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

# Read vault path from config.toml if present and existing, else auto-detect
get_config_vault() {
    if [[ -f "$SCRIPT_DIR/config.toml" ]]; then
        local raw
        raw=$(grep -E '^[[:space:]]*vault[[:space:]]*=' "$SCRIPT_DIR/config.toml" | head -n1 | sed -E 's/^[[:space:]]*vault[[:space:]]*=[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/' | tr -d '\r')
        if [[ -n "$raw" ]]; then
            local exp
            exp="$(expand_path "$raw")"
            if [[ -d "$exp" ]]; then
                echo "$exp"
                return
            fi
        fi
    fi
    auto_detect_vault
}

# Read zotero directory from config.toml if present and existing, else auto-detect
get_config_zotero() {
    if [[ -f "$SCRIPT_DIR/config.toml" ]]; then
        local raw
        raw=$(grep -E '^[[:space:]]*zotero_dir[[:space:]]*=' "$SCRIPT_DIR/config.toml" | head -n1 | sed -E 's/^[[:space:]]*zotero_dir[[:space:]]*=[[:space:]]*["'\'']?([^"'\'']+)["'\'']?/\1/' | tr -d '\r')
        if [[ -n "$raw" ]]; then
            local exp
            exp="$(expand_path "$raw")"
            if [[ -f "$exp/zotero.sqlite" ]]; then
                echo "$exp"
                return
            fi
        fi
    fi
    auto_detect_zotero
}

# Persistently update vault and zotero_dir paths in config.toml
update_config_paths() {
    local v="$1"
    local z="$2"
    if [[ -f "$SCRIPT_DIR/config.toml" ]]; then
        python3 -c '
import os, re, sys
home = os.path.expanduser("~")
def compact(p):
    if p and p.startswith(home):
        return "~" + p[len(home):]
    return p

vault = compact(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else None
zotero = compact(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None

with open("config.toml", "r") as f:
    text = f.read()
if vault:
    text = re.sub(r"^[ \t]*vault[ \t]*=.*$", f"vault = \"{vault}\"", text, flags=re.M)
if zotero:
    text = re.sub(r"^[ \t]*zotero_dir[ \t]*=.*$", f"zotero_dir = \"{zotero}\"", text, flags=re.M)
with open("config.toml", "w") as f:
    f.write(text)
' "$v" "$z" 2>/dev/null || true
    fi
}

# ------------------------------------------------------------------------------
# Action Handlers
# ------------------------------------------------------------------------------

cmd_status() {
    info "Checking Daito Paper Search status..."

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

    # 3. Ollama daemon & model
    if curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
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
    print(f"{p} papers ({c} chunks), built {b}")
except Exception:
    print("present")
' "$manifest" 2>/dev/null || echo "present")
            success "Search Index: $info_str"
        else
            warn "Search Index: No index found in $vault_dir/.planner/search"
        fi

        if [[ -f "$vault_dir/.obsidian/plugins/daito-paper-search/main.js" ]]; then
            success "Obsidian Plugin: Installed at .obsidian/plugins/daito-paper-search"
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
            *)
                shift
                ;;
        esac
    done

    echo -e "${BOLD}======================================================${NC}"
    echo -e "${BOLD}       Daito Paper Search & Background Watcher Setup   ${NC}"
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

    # 4. Ollama & Embedding Model
    info "Step 3/6: Checking Ollama & embedding model (qwen3-embedding:0.6b)..."
    if ! command -v ollama >/dev/null 2>&1; then
        warn "Ollama is not installed. Dense semantic search requires Ollama."
        warn "Install it via: brew install --cask ollama  (or visit https://ollama.com)"
    else
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
    fi

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
    fi

    local vault_dir
    if [[ -n "$custom_vault" ]]; then
        vault_dir="$(expand_path "$custom_vault")"
    else
        vault_dir="$(get_config_vault)"
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

    # Persist paths in config.toml
    update_config_paths "$vault_dir" "$zotero_dir"
    success "Synchronized paths in config.toml"

    # 6. Install Obsidian Plugin
    info "Step 5/6: Installing Obsidian plugin into vault..."
    local plugin_source="$SCRIPT_DIR/obsidian/paper-search"
    local plugin_dest="$vault_dir/.obsidian/plugins/daito-paper-search"

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
    info "Step 6/6: Building initial search index..."
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
        <string>$zotero_dir/storage</string>
    </array>
    <key>ThrottleInterval</key>
    <integer>30</integer>
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
    echo -e "  3. Toggle ${BOLD}Daito Paper Search${NC} to ${GREEN}ON${NC}."
    echo -e "\nHow to use:"
    echo -e "  • ${BOLD}Cmd+Shift+0${NC} (or Mod+Shift+0): Open instant hybrid paper search modal."
    echo -e "    - ${BOLD}Enter${NC}: Open PDF in Zotero directly at the matching page."
    echo -e "    - ${BOLD}Cmd+Enter${NC}: Insert citation and ensure literature note exists."
    echo -e "    - ${BOLD}Alt+Enter${NC}: Open/create literature note."
    echo -e "    - ${BOLD}Shift+Enter${NC}: Select paper in Zotero."
    echo -e "  • ${BOLD}@@${NC}: Type anywhere in notes for inline citation autocomplete."
    echo -e "  • ${BOLD}Command Palette${NC} -> 'Daito: Open related papers panel' for contextual literature suggestions."
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
