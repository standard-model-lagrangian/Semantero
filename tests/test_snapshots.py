"""Web snapshots (text/html attachments): text extraction, indexing, watcher fingerprint."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from planner import htmltext, searchindex, zotlib, zotwatch

from planner.config import Config

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "search"

SNAPSHOT = FIXTURES_DIR / "snapshot.html"


class TestHtmlText(unittest.TestCase):
    def test_keeps_body_text_and_decodes_entities(self):
        text = htmltext.html_to_text(SNAPSHOT.read_text())
        self.assertIn("Why cytoplasm behaves like a poroelastic sponge", text)
        self.assertIn("relax stress through poroelastic flow of cytosol through the cytoskeletal mesh", text)
        self.assertIn("Microrheology—tracking beads inside cells—shows", text)

    def test_drops_script_style_nav_header_footer_and_head(self):
        text = htmltext.html_to_text(SNAPSHOT.read_text())
        for gone in ["analytics beacon", "font-family", "About us", "Example Science Blog",
                     "Copyright", "Please enable JavaScript", "Cellular viscoelasticity explained",
                     "SingleFile", "base64"]:
            self.assertNotIn(gone, text)

    def test_tag_boundaries_separate_words_and_whitespace_collapses(self):
        self.assertEqual(htmltext.html_to_text("<td>a</td><td>b</td>\n\n  <p>c<br>d</p>"), "a b c d")
        self.assertIn("stiffness relaxation", htmltext.html_to_text(SNAPSHOT.read_text()))

    def test_unbalanced_skip_tags_do_not_swallow_the_page(self):
        self.assertEqual(htmltext.html_to_text("</nav><p>kept text</p>"), "kept text")
        self.assertEqual(htmltext.html_to_text("<nav>menu<body><p>kept text</p>"), "kept text")

    def test_singlefile_page_without_closing_head_keeps_body(self):
        # SingleFile omits optional tags: <head> opens, </head> and <body> never appear
        page = ("<!DOCTYPE html> <html lang=en><head data-x=head><meta charset=utf-8>"
                "<title>Page title</title><style>p{}</style><div><p>Body text survives</div>")
        self.assertEqual(htmltext.html_to_text(page), "Body text survives")

    def test_chunks_use_the_pdf_chunker_with_page_zero(self):
        words = " ".join(f"w{i}" for i in range(700))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.html"
            p.write_text(f"<html><body><p>{words}</p></body></html>")
            has_text, pages, chunks = htmltext.extract_chunks(p, chunk_words=300, chunk_overlap_words=50, max_chunks=2)
        self.assertTrue(has_text)
        self.assertEqual(pages, 0)
        self.assertEqual(len(chunks), 2)  # capped by max_chunks
        self.assertTrue(all(c.page == 0 for c in chunks))
        self.assertEqual(chunks[0].text.split()[-50:], chunks[1].text.split()[:50])

    def test_empty_or_unreadable_snapshot_has_no_text(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.html"
            p.write_text("<html><head><title>only a title</title></head><body><script>x</script></body></html>")
            self.assertEqual(htmltext.extract_chunks(p), (False, 0, []))
            self.assertEqual(htmltext.extract_chunks(Path(d) / "missing.html"), (False, 0, []))

    def test_non_utf8_snapshot_uses_meta_charset(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.html"
            p.write_bytes('<meta charset="iso-8859-1"><p>Zürich</p>'.encode("iso-8859-1"))
            _, _, chunks = htmltext.extract_chunks(p)
        self.assertEqual(chunks[0].text, "Zürich")


class TestZotlibSnapshots(unittest.TestCase):
    def test_reads_child_snapshots_excluding_trashed_and_standalone(self):
        papers = zotlib.read_library(FIXTURES_DIR)
        by_key = {p.key: p for p in papers}
        p5 = by_key["KEY0005"]
        self.assertEqual(p5.pdfs, [])
        self.assertEqual([s.attachmentKey for s in p5.snapshots], ["ATT005H"])
        self.assertEqual(p5.snapshots[0].path, FIXTURES_DIR / "storage" / "ATT005H" / "snapshot.html")
        # ATT001H is trashed, ATT000H has no parent
        self.assertEqual(by_key["KEY0001"].snapshots, [])
        all_keys = {s.attachmentKey for p in papers for s in p.snapshots}
        self.assertEqual(all_keys, {"ATT005H"})
        self.assertEqual(p5.to_dict()["snapshots"], [{"attachmentKey": "ATT005H", "hasText": True, "file": "ATT005H/snapshot.html"}])


class TestSnapshotIndexing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp_dir = Path(self.tmp.name)
        vault_dir = tmp_dir / "vault"
        self.data_dir = vault_dir / ".planner"
        self.data_dir.mkdir(parents=True)
        self.zotero_dir = tmp_dir / "Zotero"
        self.zotero_dir.mkdir()
        (self.zotero_dir / "zotero.sqlite").write_bytes((FIXTURES_DIR / "zotero.sqlite").read_bytes())
        for att_key, fname in [("ATT001", "sample.pdf"), ("ATT002", "sample2.pdf"),
                               ("ATT004A", "main.pdf"), ("ATT004B", "supp.pdf")]:
            sp = self.zotero_dir / "storage" / att_key
            sp.mkdir(parents=True)
            (sp / fname).write_bytes((FIXTURES_DIR / "sample.pdf").read_bytes())
        self.cfg = Config(
            vault=vault_dir, daily_dir=vault_dir, data_dir=self.data_dir, models={}, extract={}, brief={},
            reviews_dir=vault_dir / "Reviews", daily_template=vault_dir / "Daily.md", schedule={}, threads={},
            search={"zotero_dir": str(self.zotero_dir), "dims": 8, "chunk_words": 300,
                    "chunk_overlap_words": 50, "max_chunks_per_paper": 150},
        )

    def tearDown(self):
        self.tmp.cleanup()

    def fake_embed(self, texts, dims=8, **kwargs):
        # One unit vector per text, deterministic in its words
        vecs = []
        for t in texts:
            v = [0.0] * dims
            for w in t.lower().split():
                v[sum(w.encode()) % dims] += 1.0
            v[0] += 1e-3
            n = sum(x * x for x in v) ** 0.5
            vecs.append([x / n for x in v])
        return vecs

    def put_snapshot(self, content: str | None = None):
        d = self.zotero_dir / "storage" / "ATT005H"
        d.mkdir(parents=True, exist_ok=True)
        path = d / "snapshot.html"
        path.write_text(content if content is not None else SNAPSHOT.read_text())
        return path

    def load(self, name):
        return json.loads((self.data_dir / "search" / name).read_text())

    def test_snapshot_chunks_are_indexed_and_embedded_with_page_zero(self):
        self.put_snapshot()
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        papers, chunks = self.load("papers.json"), self.load("chunks.json")
        p5_idx = next(i for i, p in enumerate(papers) if p["key"] == "KEY0005")
        snap = [c for c in chunks if c["attachmentKey"] == "ATT005H"]
        self.assertEqual(len(snap), 1)
        self.assertEqual(snap[0]["paper"], p5_idx)
        self.assertEqual(snap[0]["page"], 0)
        self.assertIsInstance(snap[0]["row"], int)
        self.assertIn("poroelastic", snap[0]["text"])
        self.assertNotIn("analytics beacon", snap[0]["text"])
        self.assertEqual(papers[p5_idx]["snapshots"], [{"attachmentKey": "ATT005H", "hasText": True, "file": "ATT005H/snapshot.html"}])
        self.assertEqual(self.load("manifest.json")["chunker"], "pages-v2")

    def test_unchanged_snapshot_is_not_reembedded_and_changed_one_is(self):
        path = self.put_snapshot()
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)

        mock_embed = MagicMock(side_effect=self.fake_embed)
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertEqual(mock_embed.call_count, 0)

        path.write_text("<html><body><p>Entirely new snapshot text about tensegrity.</p></body></html>")
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertEqual(mock_embed.call_count, 1)
        self.assertEqual(mock_embed.call_args[0][0], ["Entirely new snapshot text about tensegrity."])

    def test_old_chunker_index_rebuilds_once(self):
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["chunker"] = "pages-v1"
        state_file.write_text(json.dumps(state))

        mock_embed = MagicMock(side_effect=self.fake_embed)
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertEqual(mock_embed.call_count, 1)  # everything re-embedded in one batch
        mock_embed.reset_mock()
        searchindex.build_index(self.cfg, full=False, embed_fn=mock_embed)
        self.assertEqual(mock_embed.call_count, 0)

    def test_fingerprint_changes_when_snapshot_changes(self):
        path = self.put_snapshot()
        fp1 = zotwatch.compute_fingerprint(self.zotero_dir)
        self.assertEqual(fp1, zotwatch.compute_fingerprint(self.zotero_dir))
        path.write_text(SNAPSHOT.read_text() + "<p>appended paragraph</p>")
        self.assertNotEqual(zotwatch.compute_fingerprint(self.zotero_dir), fp1)

    def test_fingerprint_ignores_trashed_snapshot_file(self):
        fp1 = zotwatch.compute_fingerprint(self.zotero_dir)
        d = self.zotero_dir / "storage" / "ATT001H"
        d.mkdir(parents=True)
        (d / "trashed.html").write_text("<p>in the trash</p>")
        self.assertEqual(zotwatch.compute_fingerprint(self.zotero_dir), fp1)

    def test_trashing_a_snapshot_removes_its_chunks(self):
        self.put_snapshot()
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        fp1 = zotwatch.compute_fingerprint(self.zotero_dir)
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        conn.execute("INSERT INTO deletedItems (itemID, dateDeleted) VALUES (106, '2026-10-20T10:00:00')")
        conn.commit()
        conn.close()
        self.assertNotEqual(zotwatch.compute_fingerprint(self.zotero_dir), fp1)
        searchindex.build_index(self.cfg, full=False, embed_fn=self.fake_embed)
        self.assertEqual([c for c in self.load("chunks.json") if c["attachmentKey"] == "ATT005H"], [])


if __name__ == "__main__":
    unittest.main()
