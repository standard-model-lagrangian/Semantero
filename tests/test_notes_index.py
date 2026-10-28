"""Launcher spec Py 6-36: Markdown cleaning, the notes index, the tick hook and the doctor checks."""
import array
import json
import math
import os
import shutil
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from tests.helpers import fake_embed, make_cfg
from planner import mdtext, notesindex

VAULT_FIXTURE = Path(__file__).parent / "fixtures" / "notes" / "vault_small"
WORDS = lambda n, p="w": " ".join(f"{p}{i}" for i in range(n))  # noqa: E731


class TestFrontmatter(unittest.TestCase):
    # 6
    def test_frontmatter_title_tags_aliases_citekey(self):
        txt = ('---\ntitle: "My title"\ntags: [a, "b c"]\naliases:\n  - alias one\n  - alias two\n'
               'citekey: smith2020x\n---\nBody words here now.\n')
        n = mdtext.parse_note(txt, "base")
        self.assertEqual(n.title, "My title")
        self.assertEqual(n.citekey, "smith2020x")
        self.assertEqual(n.aliases, ["alias one", "alias two"])
        self.assertEqual(n.tags[:2], ["a", "b c"])
        self.assertIn("alias one", n.tags)  # aliases are searchable through tags

    def test_tags_in_string_forms(self):
        for raw in ("a, b", "a b", "#a #b"):
            n = mdtext.parse_note(f"---\ntags: {raw}\n---\nbody body body\n", "x")
            self.assertEqual(n.tags, ["a", "b"], raw)

    # 7
    def test_malformed_frontmatter_is_body_not_crash(self):
        txt = "---\ntitle: [unclosed\nthis line is not yaml\n---\nBody text after the broken block.\n"
        n = mdtext.parse_note(txt, "bad")
        self.assertEqual(n.title, "bad")
        self.assertIn("Body text after the broken block", n.body_text)
        self.assertIn("this line is not yaml", n.body_text)  # the block itself counts as body

    # 8
    def test_title_fallbacks(self):
        self.assertEqual(mdtext.parse_note('---\ntitle: FM\n---\n# H1\nx y z\n', "base").title, "FM")
        self.assertEqual(mdtext.parse_note("intro\n\n# The H1\nx y z\n", "base").title, "The H1")
        self.assertEqual(mdtext.parse_note("just words here\n", "base").title, "base")
        self.assertEqual(mdtext.parse_note("flow\n", "2026-10-20", daily_iso="2026-10-20").title, "Tue 20 Oct 2026")
        self.assertEqual(mdtext.parse_note("# H1\n", "2026-10-21", daily_iso="2026-10-21").title, "Wed 21 Oct 2026")


class TestCleaning(unittest.TestCase):
    # 9
    def test_planner_blocks_and_comments_removed(self):
        txt = ("%% planner:start %%\n> [!summary] Brief\n> carried over stuff\n%% planner:end %%\n\n"
               "keep this %% inline hidden %% and this\n"
               "%% multi\nline\ncomment %%\n"
               "%% planner:threads:start %%\ngenerated\n%% planner:threads:end %%\nlast words\n")
        body = mdtext.parse_note(txt, "n").body_text
        self.assertEqual(body, "keep this and this last words")

    # 10
    def test_links_simplified_embeds_removed(self):
        txt = "See [[T|alias]], [[T#H]], [[Plain]], ![[img.png]] and [x](http://u) plus http://bare.example/a.\n"
        body = mdtext.parse_note(txt, "n").body_text
        self.assertEqual(body, "See alias, T H, Plain, and x plus http://bare.example/a.")
        self.assertNotIn("img.png", body)

    # 11
    def test_markup_stripped_words_kept(self):
        txt = ("- item **bold** and *it* ~~gone~~ `code`\n  - nested item\n1. numbered\n- [x] done task\n"
               "> [!note] Title here\n> quoted words\n| a | b |\n|---|---|\n| c | d |\n<span>html</span> end\n")
        body = mdtext.parse_note(txt, "n").body_text
        for kept in ["item bold and it gone code", "nested item", "numbered", "done task", "Title here",
                     "quoted words", "a b", "c d", "html end"]:
            self.assertIn(kept, body)
        for gone in ["**", "[!note]", "|", "<span>", "- ", "---"]:
            self.assertNotIn(gone, body)

    # 12
    def test_inline_tags_collected_not_in_code(self):
        txt = ("# Heading not a tag\nProse with #organoids and #3d-culture and #a/b.\n"
               "Inline `#nottag` and url http://x.org/#frag.\n```\n#include <stdio.h>\n```\n")
        tags = mdtext.parse_note(txt, "n").tags
        self.assertIn("organoids", tags)
        self.assertIn("a/b", tags)
        self.assertNotIn("include", tags)
        self.assertNotIn("nottag", tags)
        self.assertNotIn("frag", tags)
        self.assertNotIn("Heading", tags)
        self.assertNotIn("3d-culture", tags)  # tags must start with a letter (as in Obsidian: not all digits)

    # 13
    def test_sections_have_heading_path_and_line(self):
        txt = "lead words\n\n# A\nunder a\n## B\nunder b\n### C\nunder c\n## D\nunder d\n"
        secs = mdtext.parse_note(txt, "n").sections
        got = [(s.path, s.level, s.line) for s in secs]
        self.assertEqual(got, [("", 0, 1), ("A", 1, 3), ("A › B", 2, 5), ("A › B › C", 3, 7), ("A › D", 2, 9)])

    def test_headings_inside_code_fences_are_not_sections(self):
        secs = mdtext.parse_note("# A\ntext\n```\n# not heading\n```\nmore\n", "n").sections
        self.assertEqual([s.path for s in secs], ["A"])
        self.assertIn("# not heading", secs[0].text)

    def test_line_numbers_survive_frontmatter_and_removed_blocks(self):
        txt = "---\ntitle: T\n---\n%% a\nb %%\n\n## Real heading\nwords words words\n"
        secs = mdtext.parse_note(txt, "n").sections
        self.assertEqual(secs[0].line, 7)

    # 14
    def test_chunks_never_cross_sections_and_overlap(self):
        txt = f"# One\n{WORDS(450, 'a')}\n# Two\n{WORDS(450, 'b')}\n"
        chunks = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual({c.heading for c in chunks}, {"One", "Two"})
        for c in chunks:
            self.assertEqual(len({w[0] for w in c.text.split()}), 1)  # all 'a…' or all 'b…'
        ones = [c for c in chunks if c.heading == "One"]
        self.assertGreater(len(ones), 1)
        for x, y in zip(ones, ones[1:]):
            self.assertEqual(x.text.split()[-40:], y.text.split()[:40])
        self.assertEqual(ones[0].line, 1)

    # 15
    def test_short_section_merges_forward_or_back(self):
        # same level: A (short) merges into B, keeping A's heading
        txt = f"## A\n{WORDS(10, 'a')}\n## B\n{WORDS(60, 'b')}\n"
        ch = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual([(c.heading, len(c.text.split())) for c in ch], [("A", 70)])
        # deeper next section is eligible too
        txt = f"# T\n{WORDS(10, 'a')}\n## S\n{WORDS(60, 'b')}\n"
        ch = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual([(c.heading, len(c.text.split())) for c in ch], [("T", 70)])
        # a shallower next section is not: A stays on its own
        txt = f"## A\n{WORDS(10, 'a')}\n# B\n{WORDS(60, 'b')}\n"
        ch = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual([c.heading for c in ch], ["A", "B"])
        # trailing short section merges back into the previous one
        txt = f"## A\n{WORDS(60, 'a')}\n## B\n{WORDS(5, 'b')}\n"
        ch = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual([(c.heading, len(c.text.split())) for c in ch], [("A", 65)])
        # a short lead without a heading takes the next heading
        txt = f"intro words only\n## B\n{WORDS(60, 'b')}\n"
        ch = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual([c.heading for c in ch], ["B"])

    # 16
    def test_lead_is_first_lead_words_of_clean_body(self):
        txt = f"---\ntitle: T\n---\n%% hidden %%\n# H\n[[Link|{WORDS(1, 'x')}]] {WORDS(300)}\n"
        lead = mdtext.lead_text(mdtext.parse_note(txt, "n").sections, 120)
        self.assertEqual(len(lead.split()), 120)
        self.assertTrue(lead.startswith("x0 w0 w1"))
        self.assertNotIn("hidden", lead)

    # 17
    def test_max_chunks_per_note_caps(self):
        txt = "".join(f"# S{i}\n{WORDS(60, f's{i}_')}\n" for i in range(100))
        ch = mdtext.chunk_note(mdtext.parse_note(txt, "n").sections, 200, 40, 25, 60)
        self.assertEqual(len(ch), 60)
        self.assertEqual(ch[0].heading, "S0")  # first sections kept




class NotesCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = self.root / "vault"
        shutil.copytree(VAULT_FIXTURE, self.vault)
        self.data_dir = self.vault / ".planner"
        (self.data_dir / "search").mkdir(parents=True)
        # a papers index whose citekeys the literature notes should match
        papers = [{"key": "K1", "citekey": "roth2023tunable", "title": "Roth"},
                  {"key": "K2", "citekey": "lesavage2022next", "title": "LeSavage"}]
        (self.data_dir / "search" / "papers.json").write_text(json.dumps(papers))
        (self.data_dir / "search" / "manifest.json").write_text(json.dumps({"content_hash": "abc"}))
        self.cfg = make_cfg(self.vault, self.data_dir, notes={"exclude": [*notesindex.DEFAULTS["exclude"], "Private/**"]},
                            model="qwen3-embedding:0.6b", dims=8)
        self.notes_dir = self.data_dir / "notes"

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, **kw):
        calls = []

        def counting(texts, **k):
            calls.append(list(texts))
            return fake_embed(texts, **k)

        kw.setdefault("embed_fn", counting)
        res = notesindex.build_index(self.cfg, **kw)
        res["calls"] = calls
        return res

    def papers(self):
        return json.loads((self.notes_dir / "papers.json").read_text())

    def chunks(self):
        return json.loads((self.notes_dir / "chunks.json").read_text())

    def by_path(self):
        return {p["path"]: p for p in self.papers()}

    def mtimes(self):
        return {p.name: p.stat().st_mtime_ns for p in self.notes_dir.iterdir()}


class TestScan(NotesCase):
    # 18
    def test_scan_respects_dotfolders_defaults_and_globs(self):
        read = []
        real = notesindex._read_text
        with patch.object(notesindex, "_read_text", side_effect=lambda p: (read.append(Path(p)), real(p))[1]):
            res = self.build()
        paths = set(self.by_path())
        self.assertEqual(paths, {"2026-10-20.md", "Organoid bottlenecks.md", "roth2023tunable.md",
                                 "lesavage2022next.md", "Reviews/2026-W42.md", "empty.md", "bad-yaml.md"})
        opened = {p.relative_to(self.vault).as_posix() for p in read}
        for never in ["Private/bank.md", "Templates/Daily.md", "Threads.md", "Zotero Template.md",
                      ".obsidian/workspace.md"]:
            self.assertNotIn(never, opened)
        self.assertEqual(res["excluded"], 4)  # folders Templates/ and Private/, files Threads.md and Zotero Template.md

    def test_glob_semantics(self):
        rx = notesindex.glob_to_regex
        self.assertTrue(rx("Templates/**").match("Templates/Daily.md"))
        self.assertTrue(rx("Templates/**").match("Templates/sub/x.md"))
        self.assertFalse(rx("Templates/**").match("Other/Templates/x.md"))
        self.assertTrue(rx("**/Private/**").match("a/b/Private/x.md"))
        self.assertTrue(rx("**/Private/**").match("Private/x.md"))
        self.assertTrue(rx("Threads.md").match("Threads.md"))
        self.assertFalse(rx("Threads.md").match("sub/Threads.md"))
        self.assertTrue(rx("*.md").match("a.md"))
        self.assertFalse(rx("*.md").match("sub/a.md"))
        for bad in ["", "/abs/path", "../up/**", "a/../b"]:
            with self.assertRaises(ValueError):
                rx(bad)


class TestKinds(NotesCase):
    # 19
    def test_kinds_daily_note_litnote(self):
        self.build()
        bp = self.by_path()
        self.assertEqual(bp["2026-10-20.md"]["kind"], "daily")
        self.assertEqual(bp["2026-10-20.md"]["title"], "Tue 20 Oct 2026")
        self.assertEqual(bp["Organoid bottlenecks.md"]["kind"], "note")
        self.assertEqual(bp["Reviews/2026-W42.md"]["kind"], "note")  # not a daily-note filename
        self.assertEqual(bp["roth2023tunable.md"]["kind"], "litnote")
        self.assertEqual(bp["roth2023tunable.md"]["litnoteOf"], "roth2023tunable")

    def test_daily_kind_only_in_the_daily_folder(self):
        sub = self.vault / "Archive"
        sub.mkdir()
        (sub / "2026-01-01.md").write_text("some words in an archived note\n")
        self.cfg.daily_dir = self.vault  # dailies live at the vault root
        self.build()
        self.assertEqual(self.by_path()["Archive/2026-01-01.md"]["kind"], "note")

    # 20
    def test_litnote_by_frontmatter_and_by_basename(self):
        (self.vault / "Roth reading.md").write_text("---\ncitekey: roth2023tunable\n---\nmy reading notes here\n")
        self.build()
        bp = self.by_path()
        self.assertEqual(bp["Roth reading.md"]["litnoteOf"], "roth2023tunable")      # by frontmatter
        self.assertEqual(bp["lesavage2022next.md"]["litnoteOf"], "lesavage2022next")  # by basename
        self.assertEqual(bp["Organoid bottlenecks.md"]["litnoteOf"], None)

    def test_missing_papers_index_means_no_litnotes_and_no_crash(self):
        shutil.rmtree(self.data_dir / "search")
        self.build()
        self.assertTrue(all(p["kind"] != "litnote" for p in self.papers()))


class TestBuild(NotesCase):
    # 21
    def test_full_build_consistent(self):
        self.build(full=True)
        papers, chunks = self.papers(), self.chunks()
        manifest = json.loads((self.notes_dir / "manifest.json").read_text())
        vec = array.array("f")
        vec.frombytes((self.notes_dir / "vectors.f32").read_bytes())
        rows = len(vec) // 8
        self.assertEqual(len(vec) * 4, rows * 8 * 4)
        used = [p["abstractRow"] for p in papers if p["abstractRow"] is not None] + [c["row"] for c in chunks]
        self.assertTrue(all(0 <= r < rows for r in used))
        self.assertEqual(sorted(used), list(range(rows)))  # compact: every row referenced exactly once
        for r in range(rows):
            self.assertAlmostEqual(math.sqrt(sum(x * x for x in vec[r * 8:(r + 1) * 8])), 1.0, places=5)
        for c in chunks:
            self.assertIn("heading", c)
            self.assertGreaterEqual(c["line"], 1)
            self.assertEqual(c["page"], 0)
            self.assertEqual(c["attachmentKey"], "")
        self.assertEqual(manifest["papers"], len(papers))
        self.assertEqual(manifest["chunks"], len(chunks))
        p0 = papers[0]
        for field in ["key", "citekey", "title", "authors", "year", "journal", "doi", "tags", "collections",
                      "abstract", "pdfs", "abstractRow", "kind", "path", "mtime", "litnoteOf"]:
            self.assertIn(field, p0)
        ob = self.by_path()["Organoid bottlenecks.md"]
        self.assertEqual(ob["citekey"], "Organoid bottlenecks")
        self.assertEqual(ob["collections"], [])
        self.assertEqual(self.by_path()["Reviews/2026-W42.md"]["collections"], ["Reviews"])
        self.assertTrue(ob["key"].startswith("N") and len(ob["key"]) == 11)

    # 22
    def test_incremental_noop_zero_embeds_zero_writes(self):
        self.build()
        before = self.mtimes()
        time_files = {p: p.stat().st_mtime_ns for p in self.notes_dir.rglob("*")}
        res = self.build()
        self.assertFalse(res["changed"])
        self.assertEqual(res["calls"], [])
        self.assertEqual(self.mtimes(), before)
        self.assertEqual({p: p.stat().st_mtime_ns for p in self.notes_dir.rglob("*")}, time_files)

    # 23
    def test_edited_note_reembeds_only_that_note(self):
        self.build()
        p = self.vault / "Reviews" / "2026-W42.md"
        p.write_text(p.read_text() + "\nA completely new sentence about mitochondria transfer.\n")
        res = self.build()
        self.assertTrue(res["changed"])
        texts = [t for batch in res["calls"] for t in batch]
        self.assertGreaterEqual(len(texts), 1)
        self.assertLessEqual(len(texts), 2)  # that note's lead row and its single chunk
        self.assertTrue(all("mitochondria" in t or "Review 2026-W42" in t for t in texts))

    # 24
    def test_touched_but_unchanged_note_not_reembedded_and_not_rewritten(self):
        """A touch (sync, a re-save with no edits) must not rewrite the index: a rewrite makes the app reload."""
        self.build()
        before = {n: t for n, t in self.mtimes().items() if n != "state.json"}
        hash_before = json.loads((self.notes_dir / "manifest.json").read_text())["content_hash"]
        p = self.vault / "Organoid bottlenecks.md"
        st = p.stat()
        os.utime(p, (st.st_atime, st.st_mtime + 100))
        res = self.build()
        self.assertEqual(res["calls"], [])
        self.assertFalse(res["changed"])
        self.assertEqual({n: t for n, t in self.mtimes().items() if n != "state.json"}, before)
        self.assertEqual(json.loads((self.notes_dir / "manifest.json").read_text())["content_hash"], hash_before)
        # and the next tick is a cheap no-op again (the signature was refreshed)
        self.assertFalse(self.build()["changed"])

    def test_edit_after_a_touch_records_fresh_mtimes(self):
        self.build()
        p = self.vault / "Organoid bottlenecks.md"
        os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 100))
        self.build()
        p.write_text(p.read_text() + "\nnew words about collagen density\n")
        self.build()
        self.assertEqual(self.by_path()["Organoid bottlenecks.md"]["mtime"], int(p.stat().st_mtime))

    # 25
    def test_renamed_note_reuses_vectors(self):
        self.build()
        old_key = self.by_path()["Organoid bottlenecks.md"]["key"]
        (self.vault / "Organoid bottlenecks.md").rename(self.vault / "Renamed note.md")
        res = self.build()
        self.assertEqual(res["calls"], [])
        bp = self.by_path()
        self.assertNotIn("Organoid bottlenecks.md", bp)
        self.assertNotEqual(bp["Renamed note.md"]["key"], old_key)
        self.assertIsNotNone(bp["Renamed note.md"]["abstractRow"])

    # 26
    def test_deleted_note_disappears_rows_compact(self):
        self.build()
        (self.vault / "Organoid bottlenecks.md").unlink()
        self.build()
        self.assertNotIn("Organoid bottlenecks.md", self.by_path())
        used = [p["abstractRow"] for p in self.papers() if p["abstractRow"] is not None]
        used += [c["row"] for c in self.chunks()]
        vec = (self.notes_dir / "vectors.f32").stat().st_size // 4 // 8
        self.assertEqual(sorted(used), list(range(vec)))

    # 27
    def test_model_dims_or_chunker_change_forces_full(self):
        n_texts = sum(len(b) for b in self.build()["calls"])
        self.assertGreater(n_texts, 10)
        self.cfg.search["dims"] = 16
        res = self.build()
        self.assertGreaterEqual(sum(len(b) for b in res["calls"]), n_texts)
        self.assertEqual(json.loads((self.notes_dir / "manifest.json").read_text())["dims"], 16)
        self.cfg.search["model"] = "other-model"
        res = self.build()
        self.assertTrue(res["calls"])
        with patch.object(notesindex, "CHUNKER", "md-headings-v2"):
            res = self.build()
            self.assertTrue(res["calls"])

    # 28
    def test_ollama_down_writes_degraded_keyword_index_then_recovers(self):
        def down(texts, **k):
            raise ConnectionError("connection refused")

        res = self.build(embed_fn=down, allow_fallback=True)
        manifest = json.loads((self.notes_dir / "manifest.json").read_text())
        self.assertTrue(manifest["degraded"])
        self.assertGreater(manifest["missing_vectors"], 0)
        self.assertEqual((self.notes_dir / "vectors.f32").stat().st_size, 0)
        self.assertTrue(all(p["abstractRow"] is None for p in self.papers()))
        self.assertGreater(len(self.papers()), 0)
        self.assertTrue(res["changed"])
        # still down: retried, same keyword-only index, nothing rewritten
        before = self.mtimes()
        self.build(embed_fn=down, allow_fallback=True)
        self.assertEqual(self.mtimes(), before)
        # back up: the next run embeds what is missing
        res = self.build()
        manifest = json.loads((self.notes_dir / "manifest.json").read_text())
        self.assertFalse(manifest["degraded"])
        self.assertEqual(manifest["missing_vectors"], 0)
        self.assertTrue(any(p["abstractRow"] is not None for p in self.papers()))

    # 29
    def test_atomic_write_never_partial(self):
        self.build()
        before = self.mtimes()
        before_hash = json.loads((self.notes_dir / "manifest.json").read_text())["content_hash"]
        (self.vault / "Reviews" / "2026-W42.md").write_text("entirely different words for this note now\n")

        def boom(texts, **k):
            raise RuntimeError("embedder exploded")

        with self.assertRaises(RuntimeError):
            self.build(embed_fn=boom, allow_fallback=False)
        self.assertFalse((self.data_dir / "notes.tmp").exists())
        self.assertEqual(self.mtimes(), before)
        self.assertEqual(json.loads((self.notes_dir / "manifest.json").read_text())["content_hash"], before_hash)

    # 30
    def test_empty_note_has_entry_no_rows(self):
        self.build()
        empty = self.by_path()["empty.md"]
        self.assertIsNone(empty["abstractRow"])
        self.assertEqual(empty["title"], "Only frontmatter")
        idx = self.papers().index(empty)
        self.assertEqual([c for c in self.chunks() if c["paper"] == idx], [])
        self.assertIsNotNone(self.by_path()["bad-yaml.md"]["abstractRow"])  # malformed YAML: body still indexed

    # 31
    def test_manifest_copies_search_model_dims_instruction_and_vault_name(self):
        self.cfg.search["query_instruction"] = "Find the note"
        self.build()
        m = json.loads((self.notes_dir / "manifest.json").read_text())
        self.assertEqual(m["corpus"], "notes")
        self.assertEqual(m["format"], 1)
        self.assertEqual(m["model"], "qwen3-embedding:0.6b")
        self.assertEqual(m["dims"], 8)
        self.assertEqual(m["query_instruction"], "Find the note")
        self.assertEqual(m["chunker"], "md-headings-v1")
        self.assertEqual(m["vault"], str(self.vault))
        self.assertEqual(m["vault_name"], "vault")
        self.assertEqual(m["papers"], len(self.papers()))

    def test_unreadable_note_is_skipped_not_fatal(self):
        real = notesindex._read_text

        def flaky(p):
            if Path(p).name == "empty.md":
                raise PermissionError(1, "Operation not permitted")
            return real(p)

        with patch.object(notesindex, "_read_text", side_effect=flaky):
            res = self.build()
        self.assertEqual(len(res["skipped"]), 1)
        self.assertNotIn("empty.md", self.by_path())

    def test_blocking_false_raises_when_lock_is_held(self):
        from planner.store import named_lock
        import fcntl
        lock = self.data_dir / "notes.lock"
        f = open(lock, "a")
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            with self.assertRaises(BlockingIOError):
                notesindex.build_index(self.cfg, embed_fn=fake_embed, blocking=False)
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()
        self.assertTrue(named_lock)


class TestUnreadableVault(NotesCase):
    """An unreadable or missing vault must never silently empty the index (the next good run would re-embed all)."""

    def tearDown(self):
        for d in self.vault.rglob("*"):
            if d.is_dir():
                os.chmod(d, 0o755)
        super().tearDown()

    def test_unreadable_folder_raises_and_keeps_the_index(self):
        self.build()
        before = self.mtimes()
        os.chmod(self.vault / "Reviews", 0o000)
        with self.assertRaises(notesindex.VaultUnreadable) as ctx:
            self.build()
        self.assertIn("Reviews", str(ctx.exception))
        self.assertEqual(self.mtimes(), before)
        self.assertEqual(len(self.papers()), 7)

    def test_unreadable_excluded_folder_is_fine(self):
        os.chmod(self.vault / "Private", 0o000)
        self.build()  # Private/** is excluded: never listed, never an error
        self.assertNotIn("Private/bank.md", self.by_path())

    def test_missing_vault_raises_and_keeps_the_index(self):
        self.build()
        before = self.mtimes()
        self.cfg.vault = self.root / "gone"
        with self.assertRaises(notesindex.VaultUnreadable):
            self.build()
        self.assertEqual(self.mtimes(), before)

    def test_vault_that_suddenly_has_no_notes_is_refused_unless_full(self):
        self.build()
        empty = self.root / "empty-vault"
        empty.mkdir()
        self.cfg.vault = empty
        self.cfg.daily_dir = empty
        with self.assertRaises(notesindex.VaultUnreadable):
            self.build()
        self.assertEqual(len(self.papers()), 7)
        self.build(full=True)  # deliberate: allowed
        self.assertEqual(self.papers(), [])

    def test_tick_logs_vault_unreadable_without_raising(self):
        from planner import __main__ as main
        with patch.object(notesindex, "build_index", side_effect=notesindex.VaultUnreadable("no access")), \
                patch("builtins.print") as pr:
            main.notes_tick(self.cfg)
        self.assertTrue(any("no access" in str(c) for c in pr.call_args_list))


class TestShippedConfig(unittest.TestCase):
    def test_shipped_config_is_obsidian_only(self):
        """config.toml ships with the notes index off: the Obsidian-only setup must pass `doctor` untouched."""
        import tomllib
        raw = tomllib.loads((Path(__file__).resolve().parent.parent / "config.toml").read_text())
        self.assertIs(raw["notes"]["enabled"], False)


class TestTickAndDoctor(NotesCase):
    # 32
    def test_tick_runs_the_notes_index_without_blocking_and_swallows_failure(self):
        from planner import __main__ as main
        with patch.object(notesindex, "build_index", return_value={"changed": False}) as b:
            main.notes_tick(self.cfg)
        b.assert_called_once_with(self.cfg, blocking=False)

        with patch.object(notesindex, "build_index", side_effect=RuntimeError("kaboom")):
            main.notes_tick(self.cfg)  # does not raise

    def test_tick_skipped_when_notes_not_configured(self):
        from planner import __main__ as main
        self.cfg.notes = {}
        with patch.object(notesindex, "build_index") as b:
            main.notes_tick(self.cfg)
        b.assert_not_called()

    # 33
    def test_tick_skips_when_notes_lock_busy(self):
        from planner import __main__ as main
        with patch.object(notesindex, "build_index", side_effect=BlockingIOError("busy")), \
                patch("builtins.print") as pr:
            main.notes_tick(self.cfg)
        self.assertFalse(any("failed" in str(c) for c in pr.call_args_list))

    # 34
    def test_setup_warning_only_when_notes_index_older_than_a_day(self):
        from planner import __main__ as main
        self.build()
        self.assertIsNone(main.notes_tick_warning(self.cfg, RuntimeError("x")))  # fresh index: silent
        m = json.loads((self.notes_dir / "manifest.json").read_text())
        m["built_at"] = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")
        (self.notes_dir / "manifest.json").write_text(json.dumps(m))
        w = main.notes_tick_warning(self.cfg, RuntimeError("disk is full"))
        self.assertIn("Notes index", w)
        self.assertIn("disk is full", w)
        shutil.rmtree(self.notes_dir)
        self.assertIsNotNone(main.notes_tick_warning(self.cfg, RuntimeError("x")))  # no index at all

    # 35
    def test_doctor_notes_checks(self):
        from planner import health
        r = health.check_notes_index(self.cfg)
        self.assertIn("planner notes index", r.message)  # missing
        self.build()
        self.assertIsNone(health.check_notes_index(self.cfg))
        path = self.notes_dir / "manifest.json"
        base = json.loads(path.read_text())

        def with_manifest(**kw):
            path.write_text(json.dumps({**base, **kw}))
            return health.check_notes_index(self.cfg)

        old = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")
        state = self.notes_dir / "state.json"
        two_days, two_hours = time.time() - 2 * 86400, time.time() - 7200
        os.utime(state, (two_days, two_days))
        self.assertIsNone(with_manifest(built_at=old))   # old, but no note changed since: fine
        note = self.vault / "Organoid bottlenecks.md"
        os.utime(note, (two_hours, two_hours))           # edited 2 h ago, and the index never caught up
        self.assertIn("hasn't picked up", with_manifest(built_at=old).message)
        os.utime(note, None)                             # edited just now: the notes job is still due
        self.assertIsNone(with_manifest(built_at=old))
        os.utime(note, (two_days - 60, two_days - 60))
        r = with_manifest(model="other")
        self.assertIn("planner notes index --full", r.message)
        self.assertIn("degraded", with_manifest(degraded=True, missing_vectors=3, built_at=old).message.lower())
        self.assertIsNone(with_manifest(degraded=True, missing_vectors=3))  # degraded for under a day: fine
        path.write_text(json.dumps(base))
        self.cfg.notes["exclude"] = ["ok/**", "/abs/path"]
        self.assertIn("/abs/path", health.check_notes_index(self.cfg).message)
        self.cfg.notes = {}
        self.assertIsNone(health.check_notes_index(self.cfg))  # not configured: no check
        self.cfg.notes = {"enabled": False}
        self.assertIsNone(health.check_notes_index(self.cfg))  # Obsidian-only setup: no check, no failure

    # 36
    def test_doctor_app_installed_is_warning_not_failure(self):
        from planner import health
        with patch.object(health, "APP_PATHS", [self.root / "Missing.app"]):
            r = health.check_launcher_app(self.cfg)
        self.assertTrue(r.ok)
        self.assertIn("Semantero", r.message)
        app = self.root / "Semantero.app"
        app.mkdir()
        with patch.object(health, "APP_PATHS", [app]):
            r = health.check_launcher_app(self.cfg)
        self.assertTrue(r.ok)
        self.assertEqual(r.message, "")


if __name__ == "__main__":
    unittest.main()
