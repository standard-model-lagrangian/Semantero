#!/bin/bash
# Spike S1: runs daito-bench ad hoc signed (no hardened runtime), hardened runtime without the JIT entitlement, and
# hardened with allow-jit (M6). Apple Silicon will not run an unsigned binary, so the baseline is ad hoc signed.
#   macos/scripts/bench.sh <vault> [ranker.js]
set -euo pipefail
cd "$(dirname "$0")/.."
VAULT="${1:?usage: bench.sh <vault> [ranker.js]}"
RANKER="${2:-../launcher-core/dist/ranker.js}"
swift build -c release --product daito-bench >/dev/null
BIN="$(swift build -c release --show-bin-path)/daito-bench"
ENT="$(mktemp -t daito-jit).plist"
cat > "$ENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
PLIST
codesign --force -s - "$BIN"
"$BIN" --vault "$VAULT" --ranker "$RANKER" --label "ad hoc, no hardened runtime"
codesign --force -s - --options runtime "$BIN"
"$BIN" --vault "$VAULT" --ranker "$RANKER" --label "hardened runtime, no allow-jit"
codesign --force -s - --options runtime --entitlements "$ENT" "$BIN"
"$BIN" --vault "$VAULT" --ranker "$RANKER" --label "hardened runtime + allow-jit"

# Clean memory figure (M4): one engine, loaded once, in a fresh process, with the JIT entitlement.
"$BIN" --vault "$VAULT" --ranker "$RANKER" --label "memory: one engine, option A" --loads 1 --option a
"$BIN" --vault "$VAULT" --ranker "$RANKER" --label "memory: one engine, option B" --loads 1 --option b
