"""Run llama.cpp's converter on the staged text tower, marking it as an embedding model with bidirectional attention.

The converter's Qwen3.5 class writes a causal decoder. pplx-embed-v2-late was trained with `is_causal: false`, so the
full-attention layers must see the whole input: we add `qwen35.attention.causal = false`, and pooling `none` (one vector
per token; the server returns them all with `--pooling none` too).

usage: python -I convert_gguf.py <llama_src_dir> <staged_dir> <out.gguf> [--outtype f16|f32|bf16]
"""
import sys
from pathlib import Path


def main() -> None:
    llama_src, staged, out = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    outtype = sys.argv[sys.argv.index("--outtype") + 1] if "--outtype" in sys.argv else "f16"
    sys.path.insert(0, str(llama_src))
    sys.path.insert(0, str(llama_src / "gguf-py"))

    import gguf
    from conversion.qwen import Qwen3_5TextModel

    base_set = Qwen3_5TextModel.set_gguf_parameters

    def set_gguf_parameters(self):
        base_set(self)
        self.gguf_writer.add_causal_attention(False)
        self.gguf_writer.add_pooling_type(gguf.PoolingType.NONE)

    Qwen3_5TextModel.set_gguf_parameters = set_gguf_parameters

    import convert_hf_to_gguf
    sys.argv = ["convert_hf_to_gguf.py", staged, "--outfile", out, "--outtype", outtype]
    convert_hf_to_gguf.main()


if __name__ == "__main__":
    main()
