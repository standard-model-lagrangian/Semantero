from pathlib import Path


def make_pdf(pages_text: list[str], filename: Path):
    num_pages = len(pages_text)
    page_obj_ids = [3 + i * 3 for i in range(num_pages)]
    font_obj_id = 3 + num_pages * 3
    objs = {}
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids_str = " ".join(f"{pid} 0 R" for pid in page_obj_ids)
    objs[2] = f"<< /Type /Pages /Kids [{kids_str}] /Count {num_pages} >>".encode("ascii")
    objs[font_obj_id] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    for i, ptext in enumerate(pages_text):
        pid = page_obj_ids[i]
        cid = pid + 1
        objs[pid] = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_obj_id} 0 R >> >> /Contents {cid} 0 R >>".encode("ascii")

        stream_lines = ["BT", "/F1 12 Tf", "16 TL", "72 720 Td"]
        first = True
        for line in ptext.split("\n"):
            safe_line = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            if first:
                stream_lines.append(f"({safe_line}) Tj")
                first = False
            else:
                stream_lines.append(f"T* ({safe_line}) Tj")
        stream_lines.append("ET")
        stream_bytes = "\n".join(stream_lines).encode("utf-8")
        objs[cid] = f"<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii") + stream_bytes + b"\nendstream"

    out = [b"%PDF-1.4\n"]
    offsets = {}
    for obj_id in sorted(objs.keys()):
        offsets[obj_id] = sum(len(x) for x in out)
        out.append(f"{obj_id} 0 obj\n".encode("ascii") + objs[obj_id] + b"\nendobj\n")

    xref_offset = sum(len(x) for x in out)
    max_id = max(objs.keys())
    out.append(f"xref\n0 {max_id + 1}\n0000000000 65535 f \n".encode("ascii"))
    for obj_id in range(1, max_id + 1):
        if obj_id in offsets:
            out.append(f"{offsets[obj_id]:010d} 00000 n \n".encode("ascii"))
        else:
            out.append(b"0000000000 65535 f \n")
    out.append(f"trailer << /Size {max_id + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii"))

    filename.write_bytes(b"".join(out))


def make_scanned_pdf(filename: Path):
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    }
    out = [b"%PDF-1.4\n"]
    offsets = {}
    for obj_id in sorted(objs.keys()):
        offsets[obj_id] = sum(len(x) for x in out)
        out.append(f"{obj_id} 0 obj\n".encode("ascii") + objs[obj_id] + b"\nendobj\n")

    xref_offset = sum(len(x) for x in out)
    max_id = max(objs.keys())
    out.append(f"xref\n0 {max_id + 1}\n0000000000 65535 f \n".encode("ascii"))
    for obj_id in range(1, max_id + 1):
        if obj_id in offsets:
            out.append(f"{offsets[obj_id]:010d} 00000 n \n".encode("ascii"))
        else:
            out.append(b"0000000000 65535 f \n")
    out.append(f"trailer << /Size {max_id + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii"))

    filename.write_bytes(b"".join(out))


if __name__ == "__main__":
    d = Path(__file__).parent
    p1 = """Journal of Biomaterials Research
Introduction to neural maturation in 3D gels.
We evaluated cell-free scaffolds and viscoelasticity of synthetic matrices.
This is a unique line on page one."""

    p2 = """Journal of Biomaterials Research
Results of hydrogel stiffness experiments.
Neuronal differentiation showed significant acceleration in fast-relaxing gels.
This is a unique line on page two."""

    p3 = """Journal of Biomaterials Research
Discussion of organoid culture conditions.
References
1. Roth et al. Science Advances 2023.
2. LeSavage et al. Nature Materials 2022."""

    make_pdf([p1, p2, p3], d / "sample.pdf")
    make_scanned_pdf(d / "scanned.pdf")
    print(f"Generated {d / 'sample.pdf'} and {d / 'scanned.pdf'}")
