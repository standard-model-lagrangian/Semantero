#!/bin/bash
# Builds "Daito Search.app" into macos/build/: release build, ranker.js and shortcuts.json copied into Resources,
# App Intents metadata extracted (for the Spotlight action), then signed with the hardened runtime and the JIT
# entitlement JavaScriptCore needs.
#
# Signing identity: $DAITO_SIGN_IDENTITY, else the first "Apple Development" identity in your keychain (a free Apple ID
# "Personal Team" certificate is enough), else ad hoc "-". A stable identity keeps the Accessibility permission across
# rebuilds; an ad hoc signature asks for it again after every build.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"

( cd "$ROOT/launcher-core" && npm run build >/dev/null )
swift build -c release --product DaitoSearch
BIN_DIR="$(swift build -c release --show-bin-path)"
APP="build/Daito Search.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/DaitoSearch" "$APP/Contents/MacOS/DaitoSearch"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp "$ROOT/launcher-core/dist/ranker.js" "$ROOT/launcher-core/shortcuts.json" "$APP/Contents/Resources/"

# App Intents metadata (Spotlight action). Needs the Xcode toolchain; a failure only disables the Spotlight action.
if ! bash scripts/appintents-metadata.sh "$APP"; then
  echo "warning: App Intents metadata not generated; the Spotlight action will not appear (see docs/DECISIONS_AND_GAPS.md, S3)" >&2
fi

IDENTITY="${DAITO_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/ {print $2; exit}')}"
IDENTITY="${IDENTITY:--}"
echo "signing with: $IDENTITY"
codesign --force --deep --options runtime --entitlements Resources/DaitoSearch.entitlements -s "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
echo "built $APP"
