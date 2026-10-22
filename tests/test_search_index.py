import json
import os
import subprocess
import tempfile
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

    def test_excludes_deleted_attachments(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_zotero = Path(tmp_dir)
            db_path = tmp_zotero / "zotero.sqlite"
            orig_db = FIXTURES_DIR / "zotero.sqlite"
            db_path.write_bytes(orig_db.read_bytes())

            # Mark ATT004A as deleted in deletedItems
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            cur.execute("SELECT itemID FROM items WHERE key = 'ATT004A'")
            att_id = cur.fetchone()[0]
            cur.execute("INSERT INTO deletedItems (itemID, dateDeleted) VALUES (?, '2026-10-18T10:00:00')", (att_id,))
            conn.commit()
            conn.close()

            papers = zotlib.read_library(tmp_zotero)
            by_key = {p.key: p for p in papers}
            p4 = by_key["KEY0004"]
            # Previously had 2 PDFs; now only 1 because ATT004A was trashed
            self.assertEqual(len(p4.pdfs), 1)
            self.assertEqual(p4.pdfs[0].attachmentKey, "ATT004B")


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
            self.assertIn("Unique line page", text)

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

    def test_short_page_before_stripped_references_stays_on_own_page(self):
        raw = [
            "Page one has plenty of words to avoid any merging issues here. " * 10,
            "Page two is short conclusion text.",
            "References\nSmith et al 2020\nJones et al 2021",
        ]
        res = pdftext.clean_document_pages(raw)
        page_dict = dict(res)
        self.assertIn(1, page_dict)
        self.assertIn(2, page_dict)
        self.assertNotIn(3, page_dict)
        self.assertIn("short conclusion", page_dict[2])

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


class TestEmbed(unittest.TestCase):
    # 14. Batches inputs
    @patch("urllib.request.urlopen")
    def test_batches_inputs(self, mock_urlopen):
        from planner import embed

        def make_resp(req, *args, **kwargs):
            import json
            body = json.loads(req.data.decode("utf-8"))
            n = len(body["input"])
            resp_data = {"embeddings": [[1.0] * 8 for _ in range(n)]}
            resp_mock = MagicMock()
            resp_mock.read.return_value = json.dumps(resp_data).encode("utf-8")
            resp_mock.__enter__.return_value = resp_mock
            return resp_mock

        mock_urlopen.side_effect = make_resp

        inputs = [f"text_{i}" for i in range(70)]
        res = embed.embed(inputs, dims=8, batch_size=32)
        self.assertEqual(len(res), 70)
        self.assertEqual(mock_urlopen.call_count, 3)

        # Verify batch sizes: 32, 32, 6
        calls = mock_urlopen.call_args_list
        import json
        b1 = json.loads(calls[0][0][0].data.decode("utf-8"))["input"]
        b2 = json.loads(calls[1][0][0].data.decode("utf-8"))["input"]
        b3 = json.loads(calls[2][0][0].data.decode("utf-8"))["input"]
        self.assertEqual(len(b1), 32)
        self.assertEqual(len(b2), 32)
        self.assertEqual(len(b3), 6)
        self.assertEqual(b1[0], "text_0")
        self.assertEqual(b3[-1], "text_69")

    # 15. Truncates and normalises
    @patch("urllib.request.urlopen")
    def test_truncates_and_normalises(self, mock_urlopen):
        import json, math
        from planner import embed

        trunc_data = json.loads((FIXTURES_DIR / "trunc.json").read_text())
        input_vec = trunc_data["input"]
        expected_vec = trunc_data["expected"]

        resp_mock = MagicMock()
        resp_mock.read.return_value = json.dumps({"embeddings": [input_vec]}).encode("utf-8")
        resp_mock.__enter__.return_value = resp_mock
        mock_urlopen.return_value = resp_mock

        res = embed.embed(["dummy input"], dims=8)
        self.assertEqual(len(res), 1)
        self.assertEqual(len(res[0]), 8)

        # Check unit length
        norm = math.sqrt(sum(x * x for x in res[0]))
        self.assertAlmostEqual(norm, 1.0, places=5)

        # Compare with fixture expected values
        for a, b in zip(res[0], expected_vec):
            self.assertAlmostEqual(a, b, places=5)

    @patch("urllib.request.urlopen")
    def test_fewer_dimensions_raises_error(self, mock_urlopen):
        import json
        from planner import embed

        resp_mock = MagicMock()
        resp_mock.read.return_value = json.dumps({"embeddings": [[0.5] * 4]}).encode("utf-8")
        resp_mock.__enter__.return_value = resp_mock
        mock_urlopen.return_value = resp_mock

        with self.assertRaises(ValueError):
            embed.embed(["test text"], dims=8)

    # 16. Documents have no instruction
    @patch("urllib.request.urlopen")
    def test_documents_have_no_instruction(self, mock_urlopen):
        import json
        from planner import embed

        resp_mock = MagicMock()
        resp_mock.read.return_value = json.dumps({"embeddings": [[1.0] * 8]}).encode("utf-8")
        resp_mock.__enter__.return_value = resp_mock
        mock_urlopen.return_value = resp_mock

        doc_text = "Just a raw document text about polymers."
        embed.embed([doc_text], dims=8)

        call_req = mock_urlopen.call_args[0][0]
        body = json.loads(call_req.data.decode("utf-8"))
        self.assertEqual(body["input"], [doc_text])
        self.assertNotIn("Instruct:", body["input"][0])

    # 17. Missing model error mentions pull
    @patch("urllib.request.urlopen")
    def test_missing_model_error_mentions_pull(self, mock_urlopen):
        import urllib.error, io
        from planner import embed

        err = urllib.error.HTTPError(
            url="http://localhost:11434/api/embed",
            code=404,
            msg="Not Found",
            hdrs={},
            fp=io.BytesIO(b'{"error":"model \'qwen3-embedding:0.6b\' not found"}')
        )
        mock_urlopen.side_effect = err

        with self.assertRaises(RuntimeError) as ctx:
            embed.embed(["test"], model="qwen3-embedding:0.6b", dims=8)
        self.assertIn("ollama pull qwen3-embedding:0.6b", str(ctx.exception))

    # 18. Retries connection errors then raises
    @patch("time.sleep")
    @patch("urllib.request.urlopen")
    def test_retries_connection_errors_then_raises(self, mock_urlopen, mock_sleep):
        import urllib.error
        from planner import embed

        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        with self.assertRaises(urllib.error.URLError):
            embed.embed(["test"], dims=8, max_retries=3)

        # Initial call + 3 retries = 4 calls total
        self.assertEqual(mock_urlopen.call_count, 4)

    # 19. Live test ollama roundtrip (DAITO_LIVE=1)
    @unittest.skipUnless(os.environ.get("DAITO_LIVE") == "1", "Requires DAITO_LIVE=1")
    def test_live_ollama_roundtrip(self):
        from planner import embed

        texts = [
            "Viscoelastic hydrogels promote human neural differentiation and maturation.",
            "Faster stress relaxation in stiffness-matched matrices accelerates neuronal growth.",
            "Completely unrelated topic regarding classical French literature and poetry."
        ]
        res = embed.embed(texts, dims=64)
        self.assertEqual(len(res), 3)
        self.assertEqual(len(res[0]), 64)

        # Dot products
        sim_0_1 = sum(a * b for a, b in zip(res[0], res[1]))
        sim_0_2 = sum(a * b for a, b in zip(res[0], res[2]))
        self.assertTrue(sim_0_1 > sim_0_2)


class TestSearchIndex(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_dir = Path(self.tmp.name)
        self.vault_dir = self.tmp_dir / "vault"
        self.vault_dir.mkdir(parents=True)
        self.data_dir = self.vault_dir / ".planner"
        self.data_dir.mkdir(parents=True)

        # Create temporary zotero directory with sqlite and PDFs
        self.zotero_dir = self.tmp_dir / "Zotero"
        self.zotero_dir.mkdir(parents=True)
        db_path = self.zotero_dir / "zotero.sqlite"
        orig_db = FIXTURES_DIR / "zotero.sqlite"
        db_path.write_bytes(orig_db.read_bytes())

        # Copy sample.pdf to storage locations
        for att_key, fname in [("ATT001", "sample.pdf"), ("ATT002", "sample2.pdf"),
                                ("ATT004A", "main.pdf"), ("ATT004B", "supp.pdf")]:
            sp = self.zotero_dir / "storage" / att_key
            sp.mkdir(parents=True, exist_ok=True)
            (sp / fname).write_bytes((FIXTURES_DIR / "sample.pdf").read_bytes())

        from planner.config import Config
        self.cfg = Config(
            vault=self.vault_dir,
            daily_dir=self.vault_dir,
            data_dir=self.data_dir,
            models={},
            extract={},
            brief={},
            reviews_dir=self.vault_dir / "Reviews",
            daily_template=self.vault_dir / "Daily.md",
            schedule={},
            threads={},
            search={
                "zotero_dir": str(self.zotero_dir),
                "model": "qwen3-embedding:0.6b",
                "dims": 8,
                "batch_size": 32,
                "chunk_words": 300,
                "chunk_overlap_words": 50,
                "max_chunks_per_paper": 150,
            }
        )

    def tearDown(self):
        self.tmp.cleanup()

    def fake_embed(self, texts, **kwargs):
        import hashlib, math
        dims = kwargs.get("dims", 8)
        vectors = []
        for text in texts:
            vec = [0.0] * dims
            words = text.lower().split()
            for w in words:
                h = int(hashlib.md5(w.encode()).hexdigest(), 16)
                vec[h % dims] += 1.0
            if not any(vec):
                vec[0] = 1.0
            norm = math.sqrt(sum(x * x for x in vec))
            vectors.append([x / norm for x in vec])
        return vectors

    # 20. Full build writes all files consistently
    def test_full_build_writes_all_files_consistently(self):
        import array, json, math
        from planner import searchindex

        res = searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"

        manifest = json.loads((search_dir / "manifest.json").read_text())
        papers = json.loads((search_dir / "papers.json").read_text())
        chunks = json.loads((search_dir / "chunks.json").read_text())
        vec_bytes = (search_dir / "vectors.f32").read_bytes()

        self.assertTrue(res["changed"])
        self.assertEqual(res["papers"], len(papers))
        self.assertEqual(res["chunks"], len(chunks))

        self.assertEqual(manifest["format"], 1)
        self.assertEqual(manifest["dims"], 8)
        self.assertEqual(manifest["papers"], len(papers))
        self.assertEqual(manifest["chunks"], len(chunks))

        # Vector file length check: rows * dims * 4
        total_rows = sum(1 for p in papers if p["abstractRow"] is not None) + len(chunks)
        self.assertEqual(len(vec_bytes), total_rows * 8 * 4)

        # Check all vectors are unit length
        arr = array.array("f")
        arr.frombytes(vec_bytes)
        for i in range(total_rows):
            row_vec = arr[i * 8 : (i + 1) * 8]
            norm = math.sqrt(sum(x * x for x in row_vec))
            self.assertAlmostEqual(norm, 1.0, places=5)

        # Check rows in range and verify exact vector alignment for every abstract and chunk
        for p in papers:
            if p["abstractRow"] is not None:
                r = p["abstractRow"]
                self.assertTrue(0 <= r < total_rows)
                abs_text = f"{p['title']}\n\n{p['abstract']}" if p["abstract"] else p["title"]
                expected_vec = self.fake_embed([abs_text], dims=8)[0]
                actual_vec = list(arr[r * 8 : (r + 1) * 8])
                for a, b in zip(actual_vec, expected_vec):
                    self.assertAlmostEqual(a, b, places=5)
        for c in chunks:
            r = c["row"]
            self.assertTrue(0 <= r < total_rows)
            expected_vec = self.fake_embed([c["text"]], dims=8)[0]
            actual_vec = list(arr[r * 8 : (r + 1) * 8])
            for a, b in zip(actual_vec, expected_vec):
                self.assertAlmostEqual(a, b, places=5)

    # 21. Incremental skips unchanged PDFs
    def test_incremental_skips_unchanged_pdfs(self):
        from planner import searchindex

        mock_embed = MagicMock(side_effect=self.fake_embed)
        # First build
        searchindex.build_index(self.cfg, full=True, embed_fn=mock_embed)
        first_calls = mock_embed.call_count
        self.assertTrue(first_calls > 0)

        # Second build (nothing changed)
        mock_embed.reset_mock()
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertEqual(mock_embed.call_count, 0)

    # 22. Changed PDF reembeds only that PDF
    def test_changed_pdf_reembeds_only_that_pdf(self):
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)

        # Modify sample2.pdf mtime & content
        pdf_path = self.zotero_dir / "storage" / "ATT002" / "sample2.pdf"
        pdf_path.write_bytes(pdf_path.read_bytes() + b"\n% added dummy content\n")

        mock_embed = MagicMock(side_effect=self.fake_embed)
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)

        # Only sample2.pdf chunks should be embedded
        self.assertEqual(mock_embed.call_count, 1)

    # 23. Changed abstract reembeds only that row
    def test_changed_abstract_reembeds_only_that_row(self):
        import sqlite3
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)

        # Modify abstract in sqlite
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        cur = conn.cursor()
        cur.execute("UPDATE itemDataValues SET value = 'Brand new abstract about neural networks' WHERE value LIKE 'Faster stress relaxation%'")
        conn.commit()
        conn.close()

        mock_embed = MagicMock(side_effect=self.fake_embed)
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)

        # Exactly 1 call with 1 text (the new abstract)
        self.assertEqual(mock_embed.call_count, 1)
        texts_embedded = mock_embed.call_args[0][0]
        self.assertEqual(len(texts_embedded), 1)
        self.assertIn("Brand new abstract", texts_embedded[0])

    # 24. Removed paper disappears and rows are compact
    def test_removed_paper_disappears_and_rows_are_compact(self):
        import json, sqlite3
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)

        # Delete paper KEY0005 from sqlite
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        cur = conn.cursor()
        cur.execute("DELETE FROM items WHERE key = 'KEY0005'")
        conn.commit()
        conn.close()

        searchindex.build_index(self.cfg, full=False, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"
        papers = json.loads((search_dir / "papers.json").read_text())
        chunks = json.loads((search_dir / "chunks.json").read_text())

        keys = [p["key"] for p in papers]
        self.assertNotIn("KEY0005", keys)

        # Check rows are compact 0..N-1
        all_rows = set()
        for p in papers:
            if p["abstractRow"] is not None:
                all_rows.add(p["abstractRow"])
        for c in chunks:
            all_rows.add(c["row"])

        total_rows = len(all_rows)
        self.assertEqual(all_rows, set(range(total_rows)))

    # 25. Model or dims change forces full rebuild
    def test_model_or_dims_change_forces_full_rebuild(self):
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)

        # Change dims to 16
        self.cfg.search["dims"] = 16
        mock_embed = MagicMock(side_effect=self.fake_embed)
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)

        # Full rebuild occurred: everything re-embedded
        self.assertTrue(mock_embed.call_count > 0)

    def test_rebuild_preserves_watcher_fingerprint(self):
        """The watcher's fingerprint in state.json survives full and dims-change rebuilds."""
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = "fp-123"
        state_file.write_text(json.dumps(state))

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        self.assertEqual(json.loads(state_file.read_text()).get("fingerprint"), "fp-123")

        self.cfg.search["dims"] = 16  # state no longer reusable: everything re-embedded
        searchindex.build_index(self.cfg, full=False, embed_fn=self.fake_embed)
        self.assertEqual(json.loads(state_file.read_text()).get("fingerprint"), "fp-123")

    # 26. Atomic write never leaves partial index
    def test_atomic_write_never_leaves_partial_index(self):
        from planner import searchindex

        # Build initial valid index
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"
        manifest_before = (search_dir / "manifest.json").read_text()

        # Build with failing embedder
        failing_embed = MagicMock(side_effect=RuntimeError("Ollama crashed"))
        with self.assertRaises(RuntimeError):
            searchindex.build_index(self.cfg, full=True, embed_fn=failing_embed)

        # Original search directory intact
        self.assertTrue(search_dir.exists())
        self.assertEqual((search_dir / "manifest.json").read_text(), manifest_before)
        # Temp dir was cleaned up
        self.assertFalse((self.data_dir / "search.tmp").exists())

    def test_ollama_unavailable_falls_back_to_keyword_only(self):
        """When Ollama cannot be reached, indexing builds a keyword-only index without crashing."""
        from planner import searchindex

        failing_embed = MagicMock(side_effect=RuntimeError("Connection refused"))
        res = searchindex.build_index(self.cfg, full=True, allow_fallback=True, embed_fn=failing_embed)
        self.assertGreater(res["papers"], 0)
        self.assertGreater(res["chunks"], 0)

        search_dir = self.data_dir / "search"
        self.assertTrue((search_dir / "manifest.json").exists())
        self.assertTrue((search_dir / "papers.json").exists())
        self.assertTrue((search_dir / "chunks.json").exists())

        # Vectors file is 0 bytes when no vectors could be embedded
        vec_bytes = (search_dir / "vectors.f32").read_bytes()
        self.assertEqual(len(vec_bytes), 0)

        papers = json.loads((search_dir / "papers.json").read_text())
        chunks = json.loads((search_dir / "chunks.json").read_text())
        for p in papers:
            self.assertIsNone(p["abstractRow"])
        for c in chunks:
            self.assertIsNone(c["row"])

        # When Ollama becomes available again, next build populates vectors
        res2 = searchindex.build_index(self.cfg, full=False, embed_fn=self.fake_embed)
        self.assertGreater(res2["papers"], 0)
        vec_bytes2 = (search_dir / "vectors.f32").read_bytes()
        self.assertGreater(len(vec_bytes2), 0)

    def test_keyword_only_index_is_marked_and_flagged_until_embedded(self):
        """A fallback build records how many texts lack vectors; a failed retry writes nothing; doctor warns."""
        from planner import health, searchindex

        failing_embed = MagicMock(side_effect=RuntimeError("Connection refused"))
        res = searchindex.build_index(self.cfg, full=True, allow_fallback=True, embed_fn=failing_embed)
        self.assertGreater(res["missing_vectors"], 0)

        search_dir = self.data_dir / "search"
        manifest = json.loads((search_dir / "manifest.json").read_text())
        self.assertEqual(manifest["missing_vectors"], res["missing_vectors"])
        self.assertTrue(json.loads((search_dir / "state.json").read_text())["degraded"])

        bad = health.check_search_index(self.cfg)
        self.assertIsNotNone(bad)
        self.assertFalse(bad.ok)
        self.assertIn("Semantic search is off", bad.message)

        # Ollama still down: same keyword-only index, so nothing is rewritten
        mtime = (search_dir / "manifest.json").stat().st_mtime_ns
        res_retry = searchindex.build_index(self.cfg, allow_fallback=True, embed_fn=failing_embed)
        self.assertFalse(res_retry["changed"])
        self.assertEqual((search_dir / "manifest.json").stat().st_mtime_ns, mtime)

        # Ollama back: vectors filled in, degraded mark and doctor warning gone
        res_ok = searchindex.build_index(self.cfg, embed_fn=self.fake_embed)
        self.assertEqual(res_ok["missing_vectors"], 0)
        self.assertEqual(json.loads((search_dir / "manifest.json").read_text())["missing_vectors"], 0)
        self.assertNotIn("degraded", json.loads((search_dir / "state.json").read_text()))
        self.assertIsNone(health.check_search_index(self.cfg))

    # 27. Paper without abstract embeds title as abstract row and keeps chunks
    def test_paper_without_abstract_embeds_title_and_chunks(self):
        import array, json
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"
        papers = json.loads((search_dir / "papers.json").read_text())
        chunks = json.loads((search_dir / "chunks.json").read_text())
        vec_bytes = (search_dir / "vectors.f32").read_bytes()
        arr = array.array("f")
        arr.frombytes(vec_bytes)

        # KEY0002 has no abstract; its title is embedded as abstractRow
        p2 = next(p for p in papers if p["key"] == "KEY0002")
        self.assertIsNone(p2["abstract"])
        self.assertIsNotNone(p2["abstractRow"])
        r = p2["abstractRow"]
        expected_vec = self.fake_embed([p2["title"]], dims=8)[0]
        actual_vec = list(arr[r * 8 : (r + 1) * 8])
        for a, b in zip(actual_vec, expected_vec):
            self.assertAlmostEqual(a, b, places=5)

        # And it has chunks
        p2_idx = papers.index(p2)
        p2_chunks = [c for c in chunks if c["paper"] == p2_idx]
        self.assertTrue(len(p2_chunks) > 0)
        self.assertTrue(all(isinstance(c["row"], int) for c in p2_chunks))

    # 28. Paper without PDF has abstract row only
    def test_paper_without_pdf_has_abstract_row_only(self):
        import json
        from planner import searchindex

        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"
        papers = json.loads((search_dir / "papers.json").read_text())
        chunks = json.loads((search_dir / "chunks.json").read_text())

        # KEY0005 has no PDF
        p5 = next(p for p in papers if p["key"] == "KEY0005")
        self.assertIsNotNone(p5["abstractRow"])

        p5_idx = papers.index(p5)
        p5_chunks = [c for c in chunks if c["paper"] == p5_idx]
        self.assertEqual(len(p5_chunks), 0)

    # --- Phase 0c: Tests N1–N5 ---

    def test_n1_noop_run_writes_nothing(self):
        import io
        from unittest.mock import patch
        from planner import searchindex

        # Initial build
        res1 = searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        self.assertTrue(res1["changed"])
        search_dir = self.data_dir / "search"

        files = ["manifest.json", "papers.json", "chunks.json", "state.json", "vectors.f32"]
        mtimes_before = {fn: (search_dir / fn).stat().st_mtime_ns for fn in files}
        bytes_before = {fn: (search_dir / fn).read_bytes() for fn in files}
        manifest_before = json.loads((search_dir / "manifest.json").read_text())

        # Second build (no-op)
        mock_embed = MagicMock(side_effect=self.fake_embed)
        stdout_capture = io.StringIO()
        with patch("sys.stdout", stdout_capture):
            res2 = searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)

        self.assertFalse(res2["changed"])
        self.assertEqual(mock_embed.call_count, 0)
        self.assertIn("search index: no changes", stdout_capture.getvalue())

        # Check mtimes and bytes of all 5 files are identical
        for fn in files:
            self.assertEqual((search_dir / fn).stat().st_mtime_ns, mtimes_before[fn], f"{fn} mtime changed")
            self.assertEqual((search_dir / fn).read_bytes(), bytes_before[fn], f"{fn} bytes changed")

        manifest_after = json.loads((search_dir / "manifest.json").read_text())
        self.assertEqual(manifest_after["built_at"], manifest_before["built_at"])
        self.assertEqual(manifest_after["content_hash"], manifest_before["content_hash"])

    def test_n2_only_title_changed(self):
        import sqlite3
        from planner import searchindex

        # Initial build
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"
        manifest1 = json.loads((search_dir / "manifest.json").read_text())
        hash1 = manifest1["content_hash"]
        chunks1 = json.loads((search_dir / "chunks.json").read_text())
        vecs1 = (search_dir / "vectors.f32").read_bytes()

        # Extract chunk vector bytes from vecs1
        chunk_rows = [c["row"] for c in chunks1]
        dims = 8
        chunk_bytes_map = {}
        for r in chunk_rows:
            chunk_bytes_map[r] = vecs1[r * dims * 4 : (r + 1) * dims * 4]

        # Change title in sqlite
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        cur = conn.cursor()
        cur.execute("UPDATE itemDataValues SET value = 'Brand New Title for Viscoelasticity Paper' WHERE value LIKE 'Tunable hydrogel viscoelasticity%'")
        conn.commit()
        conn.close()

        mock_embed = MagicMock(side_effect=self.fake_embed)
        res = searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertTrue(res["changed"])

        # Exactly 1 abstract re-embedded
        self.assertEqual(mock_embed.call_count, 1)
        embedded_texts = mock_embed.call_args[0][0]
        self.assertEqual(len(embedded_texts), 1)
        self.assertIn("Brand New Title", embedded_texts[0])

        manifest2 = json.loads((search_dir / "manifest.json").read_text())
        self.assertNotEqual(manifest2["content_hash"], hash1)

        # Chunk vectors should remain identical
        vecs2 = (search_dir / "vectors.f32").read_bytes()
        chunks2 = json.loads((search_dir / "chunks.json").read_text())
        for c in chunks2:
            r = c["row"]
            self.assertEqual(vecs2[r * dims * 4 : (r + 1) * dims * 4], chunk_bytes_map[r])

    def test_n3_content_hash_stability_and_sensitivity(self):
        from planner.searchindex import compute_content_hash

        papers = [{"title": "Paper 1", "abstractRow": 0}]
        chunks = [{"paper": 0, "row": 1, "text": "Chunk text"}]
        vecs = b"\x00" * 64

        h1 = compute_content_hash(papers, chunks, vecs)
        h2 = compute_content_hash(papers, chunks, vecs)
        self.assertEqual(h1, h2)

        # Changing paper changes hash
        h_paper = compute_content_hash([{"title": "Paper 2", "abstractRow": 0}], chunks, vecs)
        self.assertNotEqual(h_paper, h1)

        # Changing chunks changes hash
        h_chunk = compute_content_hash(papers, [{"paper": 0, "row": 1, "text": "Modified"}], vecs)
        self.assertNotEqual(h_chunk, h1)

        # Changing row order changes hash
        h_row = compute_content_hash(papers, [{"paper": 0, "row": 2, "text": "Chunk text"}], vecs)
        self.assertNotEqual(h_row, h1)

        # Changing vector bytes changes hash
        h_vec = compute_content_hash(papers, chunks, b"\x01" * 64)
        self.assertNotEqual(h_vec, h1)

    def test_n4_missing_pdf_is_retried(self):
        import sqlite3
        from planner import searchindex

        # Add item with a non-existent PDF file
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        cur = conn.cursor()
        cur.execute("INSERT INTO items (itemID, itemTypeID, key, clientDateModified) VALUES (9999, 2, 'KEY9999', '2026-10-18T10:00:00')")
        cur.execute("INSERT INTO itemDataValues (valueID, value) VALUES (9991, 'Missing PDF Paper'), (9992, 'rothMissing2024')")
        cur.execute("INSERT INTO itemData (itemID, fieldID, valueID) VALUES (9999, 1, 9991), (9999, 110, 9992)")
        # Attachment pointing to missing file
        cur.execute("INSERT INTO items (itemID, itemTypeID, key, clientDateModified) VALUES (9998, 3, 'ATT9999', '2026-10-18T10:00:00')")
        cur.execute("INSERT INTO itemAttachments (itemID, parentItemID, contentType, path) VALUES (9998, 9999, 'application/pdf', 'storage:missing.pdf')")
        conn.commit()
        conn.close()

        # First build: file is missing
        res1 = searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        search_dir = self.data_dir / "search"
        state1 = json.loads((search_dir / "state.json").read_text())

        # Missing PDF should not be in state_attachments (not cached as no-text)
        self.assertNotIn("ATT9999", state1["attachments"])
        # And not in no_text_pdfs
        self.assertNotIn("rothMissing2024:ATT9999", res1["no_text_pdfs"])

        papers1 = json.loads((search_dir / "papers.json").read_text())
        p9999 = next(p for p in papers1 if p["key"] == "KEY9999")
        chunks1 = json.loads((search_dir / "chunks.json").read_text())
        p9999_chunks = [c for c in chunks1 if c["paper"] == papers1.index(p9999)]
        self.assertEqual(len(p9999_chunks), 0)

        # Now create the PDF file
        att_dir = self.zotero_dir / "storage" / "ATT9999"
        att_dir.mkdir(parents=True, exist_ok=True)
        (att_dir / "missing.pdf").write_bytes((FIXTURES_DIR / "sample.pdf").read_bytes())

        # Second build: now file exists, should extract chunks and embed them
        mock_embed = MagicMock(side_effect=self.fake_embed)
        res2 = searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertTrue(res2["changed"])
        self.assertTrue(mock_embed.call_count > 0)

        chunks2 = json.loads((search_dir / "chunks.json").read_text())
        p9999_chunks_after = [c for c in chunks2 if c["attachmentKey"] == "ATT9999"]
        self.assertTrue(len(p9999_chunks_after) > 0)

    def test_n5_shared_lock(self):
        import fcntl
        from planner import searchindex

        lock_path = self.data_dir / "search.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        f = open(lock_path, "w")
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

        try:
            # build_index with timeout should fail with TimeoutError
            with self.assertRaises(TimeoutError) as ctx:
                searchindex.build_index(self.cfg, lock_timeout=0.1, embed_fn=self.fake_embed)
            self.assertIn("search.lock", str(ctx.exception))

            # Non-blocking search_lock should raise BlockingIOError
            with self.assertRaises(BlockingIOError) as ctx_nb:
                with searchindex.search_lock(self.cfg, blocking=False):
                    pass
            self.assertIn("busy", str(ctx_nb.exception))
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()

        # After releasing lock, build_index should succeed
        res = searchindex.build_index(self.cfg, lock_timeout=1.0, embed_fn=self.fake_embed)
        self.assertTrue(res["changed"])



class TestCliAndDoctor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault_dir = Path(self.tmp.name) / "vault"
        self.vault_dir.mkdir(parents=True)
        self.data_dir = self.vault_dir / ".planner"
        self.data_dir.mkdir(parents=True)
        self.template_path = self.vault_dir / "Templates" / "Daily.md"
        self.template_path.parent.mkdir(parents=True)
        self.template_path.write_text("Flow\n- \n\ntype A\n- \n\nstatus/done\n- \n")

        from planner.config import Config
        self.cfg = Config(
            vault=self.vault_dir,
            daily_dir=self.vault_dir,
            data_dir=self.data_dir,
            models={"extract": "mock:model"},
            extract={"thread_window_days": 21},
            brief={"slip_window_notes": 6, "slip_min": 3, "collapsed": True},
            reviews_dir=self.vault_dir / "Reviews",
            daily_template=self.template_path,
            schedule={"day_starts_hour": 4},
            threads={"file": "Threads.md", "active_days": 14, "quiet_days": 60, "lines_per_thread": 6},
            search={"model": "qwen3-embedding:0.6b", "dims": 1024, "zotero_dir": str(FIXTURES_DIR)},
        )

    def tearDown(self):
        self.tmp.cleanup()

    # 29. Morning search failure is a warning, not a crash
    @patch("planner.searchindex.build_index", side_effect=RuntimeError("Search index builder failed"))
    @patch("planner.__main__.online", return_value=True)
    def test_morning_search_failure_is_a_warning_not_a_crash(self, mock_online, mock_build):
        import argparse
        from planner import __main__ as main_mod
        from planner import vault

        today_date = vault.logical_today(self.cfg.schedule.get("day_starts_hour", 4))
        today = (self.vault_dir / f"{today_date.isoformat()}.md")
        today.write_text("Flow\n- task 1\n")

        # Run cmd_morning
        main_mod.cmd_morning(self.cfg, argparse.Namespace(force=True))

        # Check brief was written
        note_content = today.read_text()
        self.assertIn("%% planner:start %%", note_content)
        # Warning text appears in the note
        self.assertIn("Search index couldn't be updated", note_content)

    # 30. Doctor flags stale or mismatched index
    def test_doctor_flags_stale_or_mismatched_index(self):
        import json
        from datetime import datetime, timedelta
        from planner import health

        search_dir = self.data_dir / "search"
        search_dir.mkdir(parents=True, exist_ok=True)

        # 1. Stale index: 4 days old
        stale_date = (datetime.now() - timedelta(days=4)).strftime("%Y-%m-%dT%H:%M")
        manifest = {
            "format": 1,
            "built_at": stale_date,
            "model": "qwen3-embedding:0.6b",
            "dims": 1024,
            "papers": 10,
            "chunks": 20,
        }
        (search_dir / "manifest.json").write_text(json.dumps(manifest))

        res = health.check_search_index(self.cfg)
        self.assertIsNotNone(res)
        self.assertFalse(res.ok)
        self.assertIn("planner search index", res.message)

        # 2. Mismatched model/dims
        manifest["built_at"] = datetime.now().strftime("%Y-%m-%dT%H:%M")
        manifest["model"] = "other-model:latest"
        (search_dir / "manifest.json").write_text(json.dumps(manifest))

        res2 = health.check_search_index(self.cfg)
        self.assertIsNotNone(res2)
        self.assertFalse(res2.ok)
        self.assertIn("planner search index --full", res2.message)

    # 31. Doctor flags missing ollama model and pdftotext
    @patch("shutil.which")
    def test_doctor_flags_missing_ollama_model_and_pdftotext(self, mock_which):
        from planner import health

        # 1. Missing pdftotext
        mock_which.return_value = None
        res_pdf = health.check_search_tools(self.cfg)
        self.assertIsNotNone(res_pdf)
        self.assertFalse(res_pdf.ok)
        self.assertIn("pdftotext", res_pdf.message)

        # 2. Missing Ollama model
        mock_which.return_value = "/opt/homebrew/bin/pdftotext"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="NAME\nsome-other-model:latest\n")
            res_ollama = health.check_search_tools(self.cfg)
            self.assertIsNotNone(res_ollama)
            self.assertFalse(res_ollama.ok)
            self.assertIn("ollama pull", res_ollama.message)

    # 32. config.local.toml overrides config.toml
    def test_config_local_override(self):
        import shutil, tempfile
        from planner import config
        tmp_dir = Path(tempfile.mkdtemp())
        try:
            cfg_path = tmp_dir / "config.toml"
            cfg_path.write_text('vault = "~/BaseVault"\nmodels = {}\n[search]\nzotero_dir = "~/BaseZotero"\n')

            # Without local override
            c1 = config.load(cfg_path)
            self.assertEqual(c1.vault, Path("~/BaseVault").expanduser())
            self.assertEqual(c1.search["zotero_dir"], "~/BaseZotero")

            # With local override
            local_path = tmp_dir / "config.local.toml"
            local_path.write_text('vault = "~/OverrideVault"\n[search]\nzotero_dir = "~/OverrideZotero"\n')
            c2 = config.load(cfg_path)
            self.assertEqual(c2.vault, Path("~/OverrideVault").expanduser())
            self.assertEqual(c2.search["zotero_dir"], "~/OverrideZotero")
        finally:
            shutil.rmtree(tmp_dir)

    # 33. Doctor search_only runs only search-relevant checks
    def test_doctor_search_only(self):
        from planner import health
        with patch("subprocess.run") as mock_run, patch("shutil.which") as mock_which:
            mock_which.return_value = "/opt/homebrew/bin/pdftotext"
            mock_run.return_value = MagicMock(returncode=0, stdout="NAME\nqwen3-embedding:0.6b\n")
            results = health.run(self.cfg, [], online=False, search_only=True)
            names = [r.name for r in results]
            # Should have vault access, python env, search index, search tools, zotero watch
            self.assertIn("vault access", names)
            self.assertIn("search tools", names)
            self.assertIn("zotero watch", names)
            # Should NOT have LLM endpoint or planner job checks
            self.assertNotIn("launchd jobs", names)
            self.assertNotIn("anthropic SDK", names)
            self.assertNotIn("extract model", names)


if __name__ == "__main__":
    unittest.main()




class TestPaperFilePaths(unittest.TestCase):
    """Launcher spec Py 1-5: papers.json carries the file each attachment lives in."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.zotero_dir = self.root / "Zotero"
        self.zotero_dir.mkdir()
        (self.zotero_dir / "zotero.sqlite").write_bytes((FIXTURES_DIR / "zotero.sqlite").read_bytes())

    def tearDown(self):
        self.tmp.cleanup()

    def _add_attachment(self, att_id, parent_id, key, path, content_type):
        import sqlite3
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        conn.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (?, 3, ?)", (att_id, key))
        conn.execute(
            "INSERT INTO itemAttachments (itemID, parentItemID, contentType, path) VALUES (?, ?, ?, ?)",
            (att_id, parent_id, content_type, path),
        )
        conn.commit()
        conn.close()

    def _by_key(self):
        return {p.key: p for p in zotlib.read_library(self.zotero_dir)}

    # 1
    def test_stored_attachment_file_is_relative_to_storage(self):
        p1 = self._by_key()["KEY0001"]
        self.assertEqual(p1.pdfs[0].file, "ATT001/sample.pdf")
        self.assertEqual(p1.pdfs[0].to_dict()["file"], "ATT001/sample.pdf")

    # 2
    def test_linked_attachment_file_is_absolute(self):
        self._add_attachment(300, 1, "ATTLINK", "/Users/x/Papers/linked one.pdf", "application/pdf")
        pdfs = {a.attachmentKey: a for a in self._by_key()["KEY0001"].pdfs}
        self.assertEqual(pdfs["ATTLINK"].file, "/Users/x/Papers/linked one.pdf")
        self.assertEqual(pdfs["ATTLINK"].path, Path("/Users/x/Papers/linked one.pdf"))

    # 3
    def test_snapshot_has_file(self):
        self._add_attachment(301, 1, "ATTSNAP", "storage:index.html", "text/html")
        snap = self._by_key()["KEY0001"].snapshots[0]
        self.assertEqual(snap.to_dict()["file"], "ATTSNAP/index.html")

    def _cfg(self, vault):
        from planner.config import Config
        data_dir = vault / ".planner"
        data_dir.mkdir(parents=True)
        return Config(
            vault=vault, daily_dir=vault, data_dir=data_dir, models={}, extract={}, brief={},
            reviews_dir=vault / "Reviews", daily_template=vault / "Daily.md", schedule={}, threads={},
            search={"zotero_dir": str(self.zotero_dir), "model": "m", "dims": 8},
        )

    def _fake_embed(self, texts, **kw):
        return [[1.0] + [0.0] * 7 for _ in texts]

    # 4
    def test_manifest_has_expanded_zotero_storage(self):
        from planner import searchindex
        cfg = self._cfg(self.root / "vault")
        searchindex.build_index(cfg, full=True, embed_fn=self._fake_embed)
        manifest = json.loads((cfg.data_dir / "search" / "manifest.json").read_text())
        self.assertEqual(manifest["zotero_storage"], str(self.zotero_dir / "storage"))
        self.assertNotIn("~", manifest["zotero_storage"])

    # 5
    def test_adding_file_field_does_not_reembed(self):
        """An index built before this change (no `file`, no `zotero_storage`) is rewritten once, with 0 embeds."""
        from planner import searchindex
        cfg = self._cfg(self.root / "vault")
        searchindex.build_index(cfg, full=True, embed_fn=self._fake_embed)
        search = cfg.data_dir / "search"
        old_hash = json.loads((search / "manifest.json").read_text())["content_hash"]

        # Downgrade the index on disk to the previous format.
        papers = json.loads((search / "papers.json").read_text())
        for p in papers:
            for a in p["pdfs"] + p.get("snapshots", []):
                a.pop("file", None)
        (search / "papers.json").write_text(json.dumps(papers))
        manifest = json.loads((search / "manifest.json").read_text())
        manifest.pop("zotero_storage")
        manifest["content_hash"] = "old"
        (search / "manifest.json").write_text(json.dumps(manifest))

        calls = []

        def counting(texts, **kw):
            calls.append(len(texts))
            return self._fake_embed(texts)

        res = searchindex.build_index(cfg, embed_fn=counting)
        self.assertEqual(calls, [])
        self.assertTrue(res["changed"])
        new_manifest = json.loads((search / "manifest.json").read_text())
        self.assertIn("zotero_storage", new_manifest)
        self.assertEqual(new_manifest["content_hash"], old_hash)
        papers = json.loads((search / "papers.json").read_text())
        self.assertEqual(papers[0]["pdfs"][0]["file"], "ATT001/sample.pdf")
