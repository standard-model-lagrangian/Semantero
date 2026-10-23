"""Reference token vectors from the official sentence-transformers pipeline, for the parity check.

Writes reference.json: for every input, the token ids (prefix included), the scoring mask and the final vectors of the
kept tokens (Dense -> skiplist -> normalise), exactly as `encode_query` / `encode_document` return them.

usage: python -I reference.py <hf_dir> <parity_texts.json> <out.json>
"""
import json
import sys
from pathlib import Path

from sentence_transformers import MultiVectorEncoder


def main(src: Path, texts_path: Path, out: Path) -> None:
    texts = json.loads(texts_path.read_text())
    m = MultiVectorEncoder(str(src), device="cpu")
    res: dict[str, list] = {"documents": [], "queries": []}
    for kind, items, fn in (("documents", texts["documents"], m.encode_document), ("queries", texts["queries"], m.encode_query)):
        for i in range(0, len(items), 8):
            for o in fn(items[i:i + 8], output_value=None, batch_size=8):
                # batches are right-padded to the longest input: drop the trailing pad positions
                ids = o["input_ids"].tolist()
                n = len(ids)
                while n > 1 and ids[n - 1] == m.tokenizer.pad_token_id:
                    n -= 1
                res[kind].append({
                    "ids": ids[:n],
                    "mask": o["attention_mask"].bool().tolist()[:n],
                    "vecs": o["token_embeddings"].float()[:n].tolist(),
                })
        print(f"{kind}: {len(res[kind])}", flush=True)
    out.write_text(json.dumps(res))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
