import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from planner import pdftext, zotlib

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "search"


class TestZotlib(unittest.TestCase):
    def setUp(self):
        self.zotero_dir = FIXTURES_DIR

    # 1. Reads regular items excluding trash and notes
    def test_reads_regular_items_excluding_trash_and_notes(self):
        papers = zotlib.read_library(self.zotero_dir)
        # 5 items total in db: 1 trash, 1 note (type 28), 1 attachment (type 3).
        # Regular items = 4 (KEY0001, KEY0002, KEY0004, KEY0005)
        self.assertEqual(len(papers), 4)
        keys = {p.key for p in papers}
        self.assertNotIn("KEY0003", keys)  # trashed paper
        self.assertNotIn("NOTE001", keys)  # note item

    # 2. Citekey, authors, year, journal
    def test_citekey_authors_year_journal(self):
        papers = zotlib.read_library(self.zotero_dir)
        by_key = {p.key: p for p in papers}

        p1 = by_key["KEY0001"]
        self.assertEqual(p1.citekey, "roth2023tunable")
        self.assertEqual(p1.authors, ["Roth", "Bauer"])  # in orderIndex order
        self.assertEqual(p1.year, 2023)  # extracted from "2023-05-01"
        self.assertEqual(p1.journal, "Science Advances")
        self.assertEqual(p1.doi, "10.1126/sciadv.abq7529")
        self.assertIn("Faster stress relaxation", p1.abstract)
        self.assertEqual(p1.tags, ["hydrogels"])
        self.assertEqual(p1.collections, ["Biomaterials"])

        p2 = by_key["KEY0002"]
        self.assertEqual(p2.year, 2022)  # extracted from "May 2022"
        self.assertIsNone(p2.abstract)  # paper without an abstract

    # 3. PDFs attached to parent
    def test_pdfs_attached_to_parent(self):
        papers = zotlib.read_library(self.zotero_dir)
        by_key = {p.key: p for p in papers}

        # KEY0004 has 2 PDFs
        p4 = by_key["KEY0004"]
        self.assertEqual(len(p4.pdfs), 2)
        att_keys = [pdf.attachmentKey for pdf in p4.pdfs]
        self.assertEqual(att_keys, ["ATT004A", "ATT004B"])
        expected_path = Path(self.zotero_dir) / "storage" / "ATT004A" / "main.pdf"
        self.assertEqual(p4.pdfs[0].path, expected_path)

        # KEY0005 has no PDF
        p5 = by_key["KEY0005"]
        self.assertEqual(p5.pdfs, [])

    # 4. Reads a copy, not the live db
    def test_reads_a_copy_not_the_live_db(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_zotero = Path(tmp_dir)
            db_path = tmp_zotero / "zotero.sqlite"
            orig_db = FIXTURES_DIR / "zotero.sqlite"
            db_path.write_bytes(orig_db.read_bytes())

            orig_mtime = db_path.stat().st_mtime_ns

            # Call read_library
            papers = zotlib.read_library(tmp_zotero)
            self.assertEqual(len(papers), 4)

            # Assert original file mtime unchanged
            self.assertEqual(db_path.stat().st_mtime_ns, orig_mtime)

            # Assert no -journal or -wal files created
            self.assertFalse((tmp_zotero / "zotero.sqlite-journal").exists())
            self.assertFalse((tmp_zotero / "zotero.sqlite-wal").exists())


class TestPdfText(unittest.TestCase):
    # 5. Pages split on formfeed one-based
    def test_pages_split_on_formfeed_one_based(self):
        canned_output = "Page one content\fPage two content\fPage three content\f"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=canned_output, stderr="")
            has_text, num_pages, chunks = pdftext.extract_chunks(Path("dummy.pdf"))
            self.assertTrue(has_text)
            self.assertEqual(num_pages, 3)

    # 6. Dehyphenates across lines
    def test_dehyphenates_across_lines(self):
        text = "Studying viscoelas-\nticity of cell-free hydrogels."
        cleaned = pdftext.clean_page_text(text)
        self.assertIn("viscoelasticity", cleaned)
        self.assertIn("cell-free", cleaned)
        self.assertNotIn("viscoelas-", cleaned)

    # 7. Drops repeated headers
    def test_drops_repeated_headers(self):
        raw_pages = [
            "Journal of Biomaterials Research\nUnique line page one with plenty of words to avoid short page merging rule.",
            "Journal of Biomaterials Research\nUnique line page two with plenty of words to avoid short page merging rule.",
            "Journal of Biomaterials Research\nUnique line page three with plenty of words to avoid short page merging rule.",
        ]
        cleaned_pages = pdftext.clean_document_pages(raw_pages)
        for page_num, text in cleaned_pages:
            self.assertNotIn("Journal of Biomaterials Research", text)
            self.assertIn(f"Unique line page", text)

    # 8. Strips references after 60 percent
    def test_strips_references_after_60_percent(self):
        p1 = "References are discussed in intro. " + " ".join([f"w1_{i}" for i in range(45)])
        p2 = "Experiments and methods. " + " ".join([f"w2_{i}" for i in range(45)])
        p3 = "Page 3 has discussion.\nReferences\n1. Author et al. Paper title 2023.\n2. Another paper citation."
        raw_pages = [p1, p2, p3]
        cleaned_pages = pdftext.clean_document_pages(raw_pages)
        page_dict = dict(cleaned_pages)
        self.assertIn("References are discussed", page_dict[1])
        self.assertIn("discussion", page_dict[3])
        self.assertNotIn("Author et al.", page_dict[3])
        self.assertNotIn("Another paper citation", page_dict[3])

    # 9. Chunks respect pages and overlap
    def test_chunks_respect_pages_and_overlap(self):
        # 500 words on page 1, 30 words on page 2 (short page), 100 words on page 3
        p1_words = [f"w{i}" for i in range(500)]
        p2_words = [f"short{i}" for i in range(30)]
        p3_words = [f"p3word{i}" for i in range(100)]
        raw_pages = [" ".join(p1_words), " ".join(p2_words), " ".join(p3_words)]

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="\f".join(raw_pages) + "\f", stderr="")
            has_text, num_pages, chunks = pdftext.extract_chunks(
                Path("dummy.pdf"), chunk_words=300, chunk_overlap_words=50
            )
            self.assertTrue(has_text)
            # No chunk should contain words from both page 1 and page 3
            p1_chunks = [c for c in chunks if c.page == 1]
            self.assertTrue(len(p1_chunks) >= 2)
            # Overlap check
            c1_words = p1_chunks[0].text.split()
            c2_words = p1_chunks[1].text.split()
            overlap = set(c1_words).intersection(set(c2_words))
            self.assertEqual(len(overlap), 50)

            # Short page 2 should have been merged into page 3
            p2_chunks = [c for c in chunks if c.page == 2]
            self.assertEqual(len(p2_chunks), 0)
            p3_chunks = [c for c in chunks if c.page == 3]
            self.assertTrue(any("short0" in c.text for c in p3_chunks))

    # 10. Max chunks per paper caps
    def test_max_chunks_per_paper_caps(self):
        # 400 pages, each with 100 words
        raw_pages = [" ".join([f"w_{p}_{i}" for i in range(100)]) for p in range(400)]
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="\f".join(raw_pages) + "\f", stderr="")
            has_text, num_pages, chunks = pdftext.extract_chunks(
                Path("dummy.pdf"), max_chunks=150
            )
            self.assertTrue(has_text)
            self.assertEqual(len(chunks), 150)
            # First pages are kept
            self.assertEqual(chunks[0].page, 1)

    # 11. Scanned PDF has no text
    def test_scanned_pdf_has_no_text(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="\f\f", stderr="")
            has_text, num_pages, chunks = pdftext.extract_chunks(Path("scanned.pdf"))
            self.assertFalse(has_text)
            self.assertEqual(chunks, [])

    # 12. pdftotext timeout is a skipped PDF, not a crash
    def test_pdftotext_timeout_is_a_skipped_pdf_not_a_crash(self):
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="pdftotext", timeout=60)):
            has_text, num_pages, chunks = pdftext.extract_chunks(Path("hang.pdf"))
            self.assertFalse(has_text)
            self.assertEqual(chunks, [])

    # 13. Live test sample PDF (runs only when DAITO_LIVE=1)
    @unittest.skipUnless(os.environ.get("DAITO_LIVE") == "1", "Requires DAITO_LIVE=1")
    def test_live_sample_pdf(self):
        sample_path = FIXTURES_DIR / "sample.pdf"
        has_text, num_pages, chunks = pdftext.extract_chunks(sample_path)
        self.assertTrue(has_text)
        self.assertEqual(num_pages, 3)
        all_text = " ".join(c.text for c in chunks)
        # Running header dropped
        self.assertNotIn("Journal of Biomaterials Research", all_text)
        # Dehyphenated
        self.assertIn("viscoelasticity", all_text)
        self.assertIn("cell-free", all_text)
        # References dropped
        self.assertNotIn("Author et al.", all_text)


if __name__ == "__main__":
    unittest.main()
