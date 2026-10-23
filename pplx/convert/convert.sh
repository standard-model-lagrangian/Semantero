#!/bin/bash
# One-off: freeze pplx-embed-v2-late-0.6b for the pplx install. Run by `make pplx-convert`; rerun only to bump a version.
#
#   1. download a pinned llama.cpp release (binary + source for the converter) and the pinned HF model revision
#   2. a locked Python env (requirements.lock): torch etc. are used here only, never at runtime
#   3. stage the text tower -> GGUF (F16) -> Q8_0; export the Dense projection and scoring rules (head.json)
#   4. reference vectors from sentence-transformers -> parity check of both GGUFs against them (PARITY.md)
#   5. SHA256SUMS, checked by planner/pplx.py before it serves or indexes anything
#
# Everything lands in ~/Library/Application Support/daito/. Nothing here is needed again unless a version changes.
set -euo pipefail

LLAMA_TAG="${LLAMA_TAG:-b11829}"
HF_REPO="perplexity-ai/pplx-embed-v2-late-0.6b"
HF_REV="${HF_REV:-7bba8e7cf2075dec747fa8557f41eb90e70361ed}"
SHORT="${HF_REV:0:7}"

HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/Library/Application Support/daito"
LLAMA_DIR="$D/llama/$LLAMA_TAG"
SRC_DIR="$D/llama-src/$LLAMA_TAG"
HF_DIR="$D/hf/pplx-embed-v2-late-0.6b@$SHORT"
STAGE="$D/stage/pplx-text@$SHORT"
MODEL="$D/models/pplx-embed-v2-late-0.6b@$SHORT"
VENV="$D/convert-venv"
PY="$VENV/bin/python"

mkdir -p "$LLAMA_DIR" "$SRC_DIR" "$HF_DIR" "$MODEL" "$D/parity"

if [ ! -x "$LLAMA_DIR/llama-$LLAMA_TAG/llama-server" ]; then
  echo "== llama.cpp $LLAMA_TAG (binary)"
  curl -fsSL -o "$LLAMA_DIR/bin.tar.gz" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-macos-arm64.tar.gz"
  tar -xzf "$LLAMA_DIR/bin.tar.gz" -C "$LLAMA_DIR" && rm "$LLAMA_DIR/bin.tar.gz"
fi
if [ ! -f "$SRC_DIR/llama.cpp-$LLAMA_TAG/convert_hf_to_gguf.py" ]; then
  echo "== llama.cpp $LLAMA_TAG (source, for the converter)"
  curl -fsSL -o "$SRC_DIR/src.tar.gz" "https://github.com/ggml-org/llama.cpp/archive/refs/tags/$LLAMA_TAG.tar.gz"
  tar -xzf "$SRC_DIR/src.tar.gz" -C "$SRC_DIR" && rm "$SRC_DIR/src.tar.gz"
fi
LSRC="$SRC_DIR/llama.cpp-$LLAMA_TAG"
SERVER="$LLAMA_DIR/llama-$LLAMA_TAG/llama-server"

if [ ! -x "$PY" ]; then
  echo "== convert env"
  uv venv --python 3.12 "$VENV"
  uv pip install --python "$PY" -r "$HERE/requirements.lock" "$LSRC/gguf-py"
fi

if [ ! -f "$HF_DIR/model.safetensors" ]; then
  echo "== $HF_REPO@$HF_REV"
  "$VENV/bin/hf" download "$HF_REPO" --revision "$HF_REV" --local-dir "$HF_DIR"
fi

echo "== stage + convert"
"$PY" -I "$HERE/stage.py" "$HF_DIR" "$STAGE"
"$PY" -I "$HERE/convert_gguf.py" "$LSRC" "$STAGE" "$MODEL/model.f16.gguf" --outtype f16
"$LLAMA_DIR/llama-$LLAMA_TAG/llama-quantize" "$MODEL/model.f16.gguf" "$MODEL/model.q8_0.gguf" Q8_0 >/dev/null 2>&1
"$PY" -I "$HERE/export_head.py" "$HF_DIR" "$MODEL"

echo "== parity"
cd "$D/parity"
"$PY" -I "$HERE/reference.py" "$HF_DIR" "$HERE/parity_texts.json" "$D/parity/reference.json"
{
  echo "# Parity: pplx-embed-v2-late-0.6b@$HF_REV on llama.cpp $LLAMA_TAG"
  echo
  echo "Reference: sentence-transformers $("$PY" -I -c 'import sentence_transformers as s; print(s.__version__)'), transformers $("$PY" -I -c 'import transformers as t; print(t.__version__)'), CPU, fp32."
} > "$MODEL/PARITY.md"
"$PY" -I "$HERE/parity.py" "$SERVER" "$MODEL/model.f16.gguf" "$MODEL" "$D/parity/reference.json" "$HERE/parity_texts.json"
"$PY" -I "$HERE/parity.py" "$SERVER" "$MODEL/model.q8_0.gguf" "$MODEL" "$D/parity/reference.json" "$HERE/parity_texts.json"

cat > "$MODEL/runtime.json" <<JSON
{"llama_tag": "$LLAMA_TAG", "llama_server": "$SERVER", "hf_repo": "$HF_REPO", "hf_revision": "$HF_REV", "gguf": "model.q8_0.gguf"}
JSON
(cd "$MODEL" && shasum -a 256 model.q8_0.gguf proj.f32 head.json > SHA256SUMS && shasum -a 256 "$SERVER" | sed "s|  .*|  llama-server|" >> SHA256SUMS)
rm -rf "$STAGE"
echo "== done: $MODEL"
