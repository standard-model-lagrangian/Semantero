"""Export what llama.cpp doesn't apply: the Dense projection and the scoring rules.

Writes into the model folder:
  proj.f32     Dense weight, row-major [out=128][in=hidden], float32 little-endian (no bias, identity activation)
  head.json    {"hidden": 1024, "dims": 128, "query_prefix": "[Q] ", "document_prefix": "[D] ",
                "query_prefix_id": ..., "document_prefix_id": ..., "skiplist_ids": [...], "skiplist_tasks": ["document"],
                "query_length": 1024, "document_length": 4096}

The pipeline (from modules.json): hidden states of every token -> Dense -> drop skiplist tokens (documents only) -> L2
normalise. The prefixes are single special tokens and come first (PyLate puts them second; this model doesn't).

usage: python -I export_head.py <hf_dir> <model_dir>
"""
import json
import sys
from pathlib import Path

from safetensors import safe_open
from tokenizers import Tokenizer


def main(src: Path, out: Path) -> None:
    with safe_open(str(src / "1_Dense" / "model.safetensors"), "pt") as f:
        (key,) = [k for k in f.keys() if k.endswith("weight")]
        w = f.get_tensor(key).float().contiguous()
    dense = json.loads((src / "1_Dense" / "config.json").read_text())
    assert not dense.get("bias") and dense["activation_function"].endswith("Identity"), dense
    assert tuple(w.shape) == (dense["out_features"], dense["in_features"]), w.shape
    (out / "proj.f32").write_bytes(w.numpy().astype("<f4").tobytes())

    st = json.loads((src / "config_sentence_transformers.json").read_text())
    bert = json.loads((src / "sentence_bert_config.json").read_text())
    mask = json.loads((src / "2_MultiVectorMask" / "config.json").read_text())
    tok = Tokenizer.from_file(str(src / "tokenizer.json"))

    def single_id(s: str) -> int:
        i = tok.token_to_id(s)
        if i is None:
            raise SystemExit(f"{s!r} is not a single token")
        return i

    head = {
        "hidden": dense["in_features"],
        "dims": dense["out_features"],
        "query_prefix": st["prompts"]["query"],
        "document_prefix": st["prompts"]["document"],
        "query_prefix_id": single_id(st["prompts"]["query"]),
        "document_prefix_id": single_id(st["prompts"]["document"]),
        # MultiVectorMask resolves each word with convert_tokens_to_ids: exact single tokens only (",", not "Ġ,")
        "skiplist_ids": sorted({i for w in mask["skiplist_words"] if (i := tok.token_to_id(w)) is not None}),
        "skiplist_tasks": mask.get("skiplist_tasks", ["document"]),
        "query_length": bert["query_length"],
        "document_length": bert["document_length"],
    }
    (out / "head.json").write_text(json.dumps(head, indent=1))
    print(f"proj {tuple(w.shape)}, {len(head['skiplist_ids'])} skiplist ids -> {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
