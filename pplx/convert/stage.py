"""Stage a text-only copy of pplx-embed-v2-late for llama.cpp's converter.

The checkpoint is a `Qwen3_5Model` (text + vision tower) that llama.cpp's converter doesn't register. The text tower is a
plain Qwen3.5 decoder with bidirectional attention, so we write:
  - model.safetensors: only `language_model.*`, renamed to `model.*` (the converter's Qwen3.5 text layout);
  - config.json: the `text_config`, as a `Qwen3_5TextModel` (the converter's text-only class, which expects no MTP head);
  - the tokenizer files, unchanged.
The Dense projection (1_Dense) and the skiplist (2_MultiVectorMask) are applied outside llama.cpp; see export_head.py.

usage: python -I stage.py <hf_dir> <out_dir>
"""
import json
import shutil
import sys
from pathlib import Path

from safetensors import safe_open
from safetensors.torch import save_file


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((src / "config.json").read_text())
    text = dict(cfg["text_config"])
    text["architectures"] = ["Qwen3_5TextModel"]
    text["model_type"] = "qwen3_5_text"
    text["tie_word_embeddings"] = cfg.get("tie_word_embeddings", True)
    (out / "config.json").write_text(json.dumps(text, indent=2))

    tensors = {}
    with safe_open(str(src / "model.safetensors"), "pt") as f:
        for k in f.keys():
            if k.startswith("language_model."):
                tensors["model." + k[len("language_model."):]] = f.get_tensor(k)
    save_file(tensors, str(out / "model.safetensors"), metadata={"format": "pt"})

    for name in ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja"):
        if (src / name).exists():
            shutil.copy2(src / name, out / name)
    print(f"staged {len(tensors)} text tensors -> {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
