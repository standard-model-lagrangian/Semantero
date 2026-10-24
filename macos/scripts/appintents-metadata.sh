#!/bin/bash
# Extracts App Intents metadata (Contents/Resources/Metadata.appintents) for a SwiftPM-built app. `swift build` does not do
# this and `xcodebuild` on a package makes a bare executable, but xcodebuild does produce the .swiftconstvalues files
# Xcode's appintentsmetadataprocessor reads, so: xcodebuild for the const values, then the processor.
#   appintents-metadata.sh "<app bundle>"
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$1"
DD="build/dd"
xcodebuild -scheme Semantero -destination 'platform=macOS' -derivedDataPath "$DD" build >"$DD.log" 2>&1 \
  || { echo "xcodebuild failed, see macos/$DD.log" >&2; exit 1; }
OBJ="$(find "$DD/Build/Intermediates.noindex/Semantero.build" -type d -path '*Semantero-p.build/Objects-normal/arm64' | head -1)"
ls "$OBJ"/*.swiftconstvalues > "$DD/constvalues.txt"
find Sources/Semantero -name '*.swift' > "$DD/sources.txt"
TOOL="$(xcrun --find appintentsmetadataprocessor)"
TOOLCHAIN="$(dirname "$(dirname "$(dirname "$TOOL")")")"
"$TOOL" \
  --toolchain-dir "$TOOLCHAIN" \
  --module-name Semantero \
  --sdk-root "$(xcrun --sdk macosx --show-sdk-path)" \
  --xcode-version "$(xcodebuild -version | awk '/Build version/ {print $3}')" \
  --platform-family macOS \
  --deployment-target 26.0 \
  --target-triple arm64-apple-macos26.0 \
  --source-file-list "$DD/sources.txt" \
  --swift-const-vals-list "$DD/constvalues.txt" \
  --output "$APP/Contents/Resources" \
  --force >/dev/null
test -d "$APP/Contents/Resources/Metadata.appintents"
