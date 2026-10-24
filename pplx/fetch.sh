#!/bin/bash
# Downloads the frozen pplx-embed-v2-late model from Semantero's GitHub release, instead of converting it. Run by
# setup-search.sh and `make pplx-fetch`. pplx/convert/convert.sh makes the same bytes; every file is checked against
# pplx/model.sha256 (the SHA256SUMS that conversion wrote) before it is kept, and pplxd checks them again at start.
#
# Everything lands in ~/Library/Application Support/Semantero/, where convert.sh puts it: ~575 MB.
set -euo pipefail

LLAMA_TAG="b11829"
SHORT="7bba8e7"
RELEASE="https://github.com/standard-model-lagrangian/Semantero/releases/download/pplx-v2-late-q8_0-$SHORT"

HERE="$(cd "$(dirname "$0")" && pwd)"
SUMS="$HERE/model.sha256"
D="$HOME/Library/Application Support/Semantero"
LLAMA_DIR="$D/llama/$LLAMA_TAG"
SERVER="$LLAMA_DIR/llama-$LLAMA_TAG/llama-server"
MODEL="$D/models/pplx-embed-v2-late-0.6b@$SHORT"

matches() {  # matches FILE NAME: FILE's sha256 is NAME's line in model.sha256
  [ -f "$1" ] && [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$(awk -v n="$2" '$2 == n {print $1}' "$SUMS")" ]
}

mkdir -p "$LLAMA_DIR" "$MODEL"

if ! matches "$SERVER" llama-server; then
  echo "== llama.cpp $LLAMA_TAG (binary)"
  curl -fsSL --retry 3 -o "$LLAMA_DIR/bin.tar.gz" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-macos-arm64.tar.gz"
  tar -xzf "$LLAMA_DIR/bin.tar.gz" -C "$LLAMA_DIR" && rm "$LLAMA_DIR/bin.tar.gz"
  matches "$SERVER" llama-server || { echo "llama-server does not match pplx/model.sha256" >&2; exit 1; }
fi

for f in model.q8_0.gguf proj.f32 head.json; do
  matches "$MODEL/$f" "$f" && continue
  echo "== $f"
  curl -fL --retry 3 --progress-bar -o "$MODEL/$f.part" "$RELEASE/$f"
  if ! matches "$MODEL/$f.part" "$f"; then
    rm -f "$MODEL/$f.part"
    echo "$f does not match pplx/model.sha256; nothing kept" >&2
    exit 1
  fi
  mv "$MODEL/$f.part" "$MODEL/$f"
done
curl -fsSL --retry 3 -o "$MODEL/PARITY.md" "$RELEASE/PARITY.md" || true

cat > "$MODEL/runtime.json" <<JSON
{"llama_tag": "$LLAMA_TAG", "llama_server": "$SERVER", "hf_repo": "perplexity-ai/pplx-embed-v2-late-0.6b", "hf_revision": "7bba8e7cf2075dec747fa8557f41eb90e70361ed", "gguf": "model.q8_0.gguf"}
JSON
cp "$SUMS" "$MODEL/SHA256SUMS"
echo "== done: $MODEL"
