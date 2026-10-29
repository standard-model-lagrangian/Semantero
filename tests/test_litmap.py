"""Weekly literature map (docs/LITMAP_SPEC.md, tests LM1–LM15). Synthetic index: three clusters in 16 dims sharing one
big common direction, abstract rows interleaved with chunk rows as the real builder writes them."""
import array
import fcntl
import json
import math
import os
import random
import shutil
import sqlite3
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

from planner import litmap
from tests.helpers import make_cfg

DIMS = 16
FIXTURE_ZOTERO = Path(__file__).parent / "fixtures" / "search" / "zotero.sqlite"
PROSE = ("The hydrogel network relaxes stress over minutes, and cells spread more on the softer gels, which suggests "
         "that matrix mechanics guide how the organoids grow and fold over the first week of culture.")


def axis(i, w=1.0):
    v = [0.0] * DIMS
    v[i] = w
    return v


def add(*vs):
    return [sum(x) for x in zip(*vs)]


def unit(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]


CENTRES = {"A": axis(1), "B": axis(2), "C": axis(3)}


def chunk_vec(rng, centre):
    """A chunk near `centre`, plus the big common direction every real vector shares."""
    return unit(add(axis(0, 3.0), centre, [rng.gauss(0, 0.15) for _ in range(DIMS)]))


def write_index(d: Path, papers: list[dict], model="test-model", content_hash="hash-1"):
    """papers: {key, cluster (str, or a list giving each chunk's cluster), n (chunks), texts (optional)}. Writes
    papers.json, chunks.json (each record naming its row) and vectors.f32 with an abstract row before each paper's chunks."""
    rng = random.Random(7)
    d.mkdir(parents=True, exist_ok=True)
    vecs = array.array("f")
    pj, cj, row = [], [], 0
    for i, p in enumerate(papers):
        clusters = p["cluster"] if isinstance(p["cluster"], list) else [p["cluster"]] * p.get("n", 4)
        vecs.extend(chunk_vec(rng, axis(5 + i % 10, 2.0)))   # the abstract row: deliberately unlike the chunks
        pj.append({"key": p["key"], "citekey": f"author{p['key']}2026", "title": f"Paper {p['key']}",
                   "authors": [f"Author{p['key']}"], "year": 2026, "abstractRow": row, "collections": [], "tags": []})
        row += 1
        for j, c in enumerate(clusters):
            if c is None:   # a chunk with no vector
                cj.append({"paper": i, "page": j + 1, "text": PROSE, "row": None})
                continue
            vecs.extend(chunk_vec(rng, CENTRES[c]))
            text = p.get("texts", {}).get(j, f"{PROSE} ({p['key']} part {j})")
            cj.append({"paper": i, "attachmentKey": f"ATT{i}", "page": j + 1, "text": text, "row": row})
            row += 1
    (d / "papers.json").write_text(json.dumps(pj))
    (d / "chunks.json").write_text(json.dumps(cj))
    (d / "vectors.f32").write_bytes(vecs.tobytes())
    (d / "manifest.json").write_text(json.dumps({"model": model, "dims": DIMS, "content_hash": content_hash,
                                                 "papers": len(pj), "chunks": len(cj)}))


# Mondays of three consecutive ISO weeks: 2026-W40, W41, W42
W40, W41, W42, W43 = "2026-09-29 10:00:00", "2026-10-06 10:00:00", "2026-10-13 10:00:00", "2026-10-20 10:00:00"

BASE = [{"key": f"A{i}", "cluster": "A"} for i in range(4)] + [{"key": f"B{i}", "cluster": "B"} for i in range(4)]
BASE_DATES = {**{f"A{i}": W40 for i in range(4)}, **{f"B{i}": W41 for i in range(4)}}


class LitmapCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = self.root / "vault"
        self.vault.mkdir()
        self.cfg = make_cfg(self.vault)
        self.cfg.litmap = {"enabled": True, "folder": "Literature maps", "weeks": 3}
        self.index = self.cfg.data_dir / "search"
        self._tz = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()

    def tearDown(self):
        if self._tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self._tz
        time.tzset()
        self.tmp.cleanup()

    def run_map(self, week="2026-W42", out=None, **kw):
        kw.setdefault("dates", self.dates)
        kw.setdefault("now", datetime(2026, 10, 19, 9, 0))
        return litmap.run(self.cfg, week=week, out=out or self.root / "out", **kw)


class TestWeeksAndLoading(LitmapCase):
    def test_lm1_utc_date_maps_to_the_local_iso_week(self):
        self.assertEqual(litmap.local_week("2026-10-25 23:30:00"), "2026-W43")   # Sunday, in UTC
        os.environ["TZ"] = "Europe/Berlin"
        time.tzset()
        self.assertEqual(litmap.local_week("2026-10-25 23:30:00"), "2026-W44")   # already Monday in Berlin
        self.assertEqual(litmap.week_range("2026-W44"), ("2026-10-26", "2026-11-01"))
        self.assertEqual(litmap.previous_week("2026-W01"), "2025-W52")

    def test_lm1_papers_without_dates_or_chunks_are_skipped_and_counted(self):
        write_index(self.index, BASE + [{"key": "N0", "cluster": [None, None]}])
        self.dates = {k: v for k, v in BASE_DATES.items() if k != "B3"}
        res = self.run_map(week="2026-W41", dry_run=True)
        self.assertEqual(res["skipped"], {"no chunks": 1, "no date": 1})

    def test_lm1_zotero_dates_come_from_a_snapshot(self):
        zdir = self.root / "Zotero"
        zdir.mkdir()
        shutil.copy(FIXTURE_ZOTERO, zdir / "zotero.sqlite")
        with sqlite3.connect(zdir / "zotero.sqlite") as c:
            c.execute("UPDATE items SET dateAdded = '2026-10-01 12:00:00' WHERE key = 'KEY0001'")
        dates = litmap.zotero_dates(zdir)
        self.assertEqual(dates["KEY0001"], "2026-10-01 12:00:00")
        self.assertNotIn("KEY0002", dates)   # no date

    def test_lm2_chunk_vectors_come_from_their_row_not_their_position(self):
        write_index(self.index, BASE)
        lib = litmap.load_library(self.index)
        self.assertEqual(len(lib.papers), 8)
        self.assertEqual(len(lib.chunk_row), 32)
        abstract_rows = {p["abstractRow"] for p in json.loads((self.index / "papers.json").read_text())}
        self.assertFalse(set(lib.chunk_row) & abstract_rows)
        # each paper's chunks sit on its own cluster axis after centring
        for p in lib.papers:
            own, other = (1, 2) if p.key.startswith("A") else (2, 1)
            for c in p.chunks:
                v = lib.chunk_vec[c]
                self.assertGreater(v[own] - v[other], 0.5)   # misread rows would land on the abstract axes 5–14
                self.assertAlmostEqual(math.sqrt(sum(x * x for x in v)), 1.0, places=6)
        mean0 = sum(lib.paper_vec[i][0] for i in range(8)) / 8
        self.assertLess(abs(mean0), 0.1)   # the common direction is gone


class TestNovelty(LitmapCase):
    def setUp(self):
        super().setUp()
        papers = BASE + [{"key": "C0", "cluster": "C"}, {"key": "A9", "cluster": "A"},
                         {"key": "AB", "cluster": ["A", "A", "B", "B"]}, {"key": "A8", "cluster": "A"}]
        write_index(self.index, papers)
        self.dates = {**BASE_DATES, "C0": W42, "A9": W42, "AB": W42, "A8": W42}
        self.lib = litmap.load_library(self.index)
        weeks = [litmap.local_week(self.dates[p.key]) for p in self.lib.papers]
        self.nov = litmap.novelty(self.lib, weeks)
        self.by_key = {p.key: self.nov[i] for i, p in enumerate(self.lib.papers)}

    def test_lm3_nearest_ignores_the_same_week_and_later(self):
        self.assertIsNone(self.by_key["A0"])   # first week: nothing earlier
        a9 = self.by_key["A9"]
        self.assertTrue(self.lib.papers[a9.nearest].key.startswith("A"))
        self.assertNotIn(self.lib.papers[a9.nearest].key, {"A8", "AB", "C0"})   # same week
        b0 = self.by_key["B0"]
        self.assertTrue(self.lib.papers[b0.nearest].key.startswith("A"))   # only week-40 papers came before

    def test_lm4_a_new_cluster_is_more_novel_than_a_known_one(self):
        self.assertGreater(self.by_key["C0"].novelty, self.by_key["A9"].novelty)
        self.assertGreater(self.by_key["C0"].percentile, self.by_key["A9"].percentile)
        self.assertLessEqual(self.by_key["C0"].percentile, 1.0)

    def test_lm5_recombination_is_high_when_no_single_paper_covers_it(self):
        self.assertGreater(self.by_key["AB"].recombination, self.by_key["A9"].recombination + 0.1)
        for n in self.nov:
            if n:
                self.assertGreaterEqual(n.recombination, -1e-9)

    def test_lm12_junk_takes_no_part_and_is_never_quoted(self):
        refs = "; ".join(f"Smith J. et al. Nature {1990 + i}" for i in range(10))
        papers = BASE + [{"key": "A9", "cluster": "A", "texts": {0: refs}}]
        write_index(self.index, papers)
        lib = litmap.load_library(self.index)
        a9 = next(i for i, p in enumerate(lib.papers) if p.key == "A9")
        self.assertTrue(lib.chunk_junk[lib.papers[a9].chunks[0]])
        weeks = [litmap.local_week({**BASE_DATES, "A9": W42}[p.key]) for p in lib.papers]
        nov = litmap.novelty(lib, weeks)
        pas = litmap.passage(lib, a9, nov[a9].nearest, scorer=None)
        self.assertNotEqual(pas.chunk_p, lib.papers[a9].chunks[0])


class TestJunk(unittest.TestCase):
    def test_lm12_junk_kinds(self):
        junk = {
            "references": "; ".join(f"Lee K. et al. Cell {2000 + i}, 12, 4–9" for i in range(9)),
            "authors": ", ".join(f"{a}. {b}. Name" for a, b in zip("ABCDEFGHIJKLMNOPQR", "STUVWXYZABCDEFGHIJ")),
            "checklist": "NeurIPS Paper Checklist. Answer: [Yes] Justification: the code is released with the paper.",
            "licence": "This article is licensed under a Creative Commons Attribution 4.0 International License.",
            "table": "0.969 0.363 0/3 3 10 0.380 3.67 4.67 42 0.845 0.246 0/3 5 16 0.000 4.33 7.33 44 0.879 0.187",
            "garbled": "\x06\x17\x03-)552 ±71)Į W \x03\x15\x17\x03K JF669 0 \x06\x18\x03-)669 \x0e71)Į W",
        }
        for kind, text in junk.items():
            self.assertTrue(litmap.is_junk(text), kind)
        self.assertFalse(litmap.is_junk(PROSE))
        self.assertFalse(litmap.is_junk("Cells were cultured for 7 days (n = 3) in 2% gels before imaging in 2024."))


class TestPassages(LitmapCase):
    def setUp(self):
        super().setUp()
        write_index(self.index, BASE + [{"key": "A9", "cluster": "A"}])
        self.dates = {**BASE_DATES, "A9": W42}
        self.lib = litmap.load_library(self.index)
        self.p = next(i for i, p in enumerate(self.lib.papers) if p.key == "A9")
        weeks = [litmap.local_week(self.dates[p.key]) for p in self.lib.papers]
        self.q = litmap.novelty(self.lib, weeks)[self.p].nearest

    def test_lm13_maxsim_picks_the_pair_when_the_service_matches_the_index(self):
        cos = litmap.passage(self.lib, self.p, self.q, scorer=None)
        self.assertEqual(cos.method, "chunk vectors")
        target = next(c for c in self.lib.papers[self.q].chunks if c != cos.chunk_q)
        scores = [0.0] * 100
        scores[self.lib.chunk_row[target]] = 0.9

        def scorer(text):
            return {"content_hash": "hash-1", "scores": scores}

        ms = litmap.passage(self.lib, self.p, self.q, scorer=scorer)
        self.assertEqual((ms.chunk_q, ms.method), (target, "MaxSim"))

    def test_lm13_a_different_index_or_no_service_falls_back_to_cosine(self):
        cos = litmap.passage(self.lib, self.p, self.q, scorer=None)
        for scorer in (lambda t: {"content_hash": "other", "scores": [1.0] * 100}, lambda t: None):
            got = litmap.passage(self.lib, self.p, self.q, scorer=scorer)
            self.assertEqual((got.chunk_p, got.chunk_q, got.method), (cos.chunk_p, cos.chunk_q, "chunk vectors"))


class TestLayout(LitmapCase):
    def test_lm6_smacof_lowers_the_sammon_stress_of_its_pca_start_and_scores_are_sane(self):
        write_index(self.index, BASE + [{"key": f"C{i}", "cluster": "C"} for i in range(4)])
        lib = litmap.load_library(self.index)
        D = litmap.distances(lib.paper_vec)
        Y0 = litmap.pca_start(lib.paper_vec, D)
        Y = litmap.smacof(D, Y0)
        self.assertLess(litmap.stress(D, Y), 0.9 * litmap.stress(D, Y0))
        self.assertLess(litmap.stress(D, litmap.smacof(D, Y0, iters=300)), litmap.stress(D, litmap.smacof(D, Y0, iters=5)))
        pts = [[random.Random(i).random() for _ in range(3)] for i in range(12)]
        perfect = [[math.dist(a, b) for b in pts] for a in pts]
        self.assertEqual(litmap.layout_scores(perfect, pts), (1.0, 1.0))

    def test_lm7_stored_points_stay_put_and_new_ones_land_in_their_cluster(self):
        write_index(self.index, BASE)
        self.dates = dict(BASE_DATES)
        self.run_map(week="2026-W41")
        first = json.loads((self.root / "out" / "layout.json").read_text())["coords"]
        write_index(self.index, BASE + [{"key": "A9", "cluster": "A"}, {"key": "B9", "cluster": "B"}])
        self.dates.update({"A9": W42, "B9": W42})
        res = self.run_map(week="2026-W42")
        self.assertFalse(res["new_epoch"])
        coords = json.loads((self.root / "out" / "layout.json").read_text())["coords"]
        for k, v in first.items():
            self.assertEqual(coords[k], v)

        def centre(prefix):
            pts = [first[k] for k in first if k.startswith(prefix)]
            return [sum(c) / len(pts) for c in zip(*pts)]

        for new, own, other in (("A9", "A", "B"), ("B9", "B", "A")):
            self.assertLess(math.dist(coords[new], centre(own)), math.dist(coords[new], centre(other)))

    def test_lm9_epoch_rules(self):
        keys = [f"K{i}" for i in range(20)]
        stored = {"model": "m", "coords": {k: [0, 0, 0] for k in keys}}
        self.assertEqual(litmap.epoch_reason(None, "m", keys, False), "first run")
        self.assertEqual(litmap.epoch_reason(stored, "other", keys, False), "model changed")
        self.assertEqual(litmap.epoch_reason(stored, "m", keys, True), "asked for (--relayout)")
        self.assertIsNone(litmap.epoch_reason(stored, "m", keys[1:], False))           # one removal
        self.assertEqual(litmap.epoch_reason(stored, "m", keys[3:], False), "15% of mapped papers removed")
        self.assertIsNone(litmap.epoch_reason(stored, "m", keys + ["NEW"], False))     # additions never


class TestOutput(LitmapCase):
    def setUp(self):
        super().setUp()
        many = [{"key": f"N{i:02d}", "cluster": "ABC"[i % 3]} for i in range(14)]
        write_index(self.index, BASE + many)
        self.dates = {**BASE_DATES, **{f"N{i:02d}": W42 for i in range(14)}}

    def test_lm8_same_inputs_same_bytes(self):
        self.run_map(out=self.root / "one")
        self.run_map(out=self.root / "two")
        for name in ("layout.json", "2026-W42.svg", "2026-W42.md"):
            self.assertEqual((self.root / "one" / name).read_bytes(), (self.root / "two" / name).read_bytes(), name)

    def test_lm10_week_ages_and_colours(self):
        weeks = {"a": "2026-W42", "b": "2026-W41", "c": "2026-W40", "d": "2026-W39", "e": "2026-W43"}
        ages = litmap.week_ages(weeks, "2026-W42", 3)
        self.assertEqual(ages, {"a": 0, "b": 1, "c": 2, "d": None, "e": None})
        self.assertEqual(litmap.LIGHT, ("#104281", "#2a78d6", "#86b6ef"))
        self.assertEqual(litmap.DARK, ("#9ec5f4", "#3987e5", "#184f95"))

    def test_lm11_svg(self):
        self.run_map()
        svg = (self.root / "out" / "2026-W42.svg").read_text()
        root = ET.fromstring(svg)
        ns = "{http://www.w3.org/2000/svg}"
        self.assertFalse(list(root.iter(f"{ns}script")))
        text = " ".join("".join(t.itertext()) for t in root.iter(f"{ns}text"))
        self.assertIn("12–18 Oct · 14 added", text)
        self.assertIn("5–11 Oct · 4 added", text)
        self.assertIn("28 Sep – 4 Oct · 4 added", text)
        labels = [t for t in root.iter(f"{ns}text") if "label" in (t.get("class") or "").split()]
        self.assertEqual(len(labels), 14)
        self.assertEqual(sum(1 for t in labels if "AuthorN" in t.text), 12)
        self.assertEqual(sorted(t.text for t in labels if "AuthorN" not in t.text), ["13", "14"])
        self.assertEqual(len([e for e in root.iter(f"{ns}line") if e.get("class") == "nearest"]), 14)

    def test_lm11_an_empty_week_is_in_the_legend(self):
        self.run_map(week="2026-W43")
        root = ET.fromstring((self.root / "out" / "2026-W43.svg").read_text())
        text = " ".join("".join(t.itertext()) for t in root.iter("{http://www.w3.org/2000/svg}text"))
        self.assertIn("19–25 Oct · 0 added", text)

    def test_lm14_note(self):
        self.run_map()
        note = (self.root / "out" / "2026-W42.md").read_text()
        self.assertIn("![[2026-W42.svg]]", note)
        self.assertEqual(note.count("\n### "), 14)
        for word in ("Novelty", "more novel than", "Nearest earlier paper", "Recombination", "Spread", "Mean novelty",
                     "Layout", "[[authorN00"):
            self.assertIn(word, note)
        self.assertIn("> ", note)
        self.assertIn("chosen by chunk vectors", note)


class TestQuotes(unittest.TestCase):
    def test_lm13_quotes_the_sentences_that_share_the_most_words(self):
        text = ("Figure 3 shows the gating strategy. Statistics used two-sided tests. "
                "Stress relaxation in alginate gels controls stem cell spreading. Data are mean values.")
        other = "Faster stress relaxation in viscoelastic alginate gels enhanced spreading of stem cells."
        q = litmap._quote(text, other, limit=70)
        self.assertTrue(q.startswith("… Stress relaxation in alginate gels"), q)
        self.assertEqual(litmap._quote("Short and only.", "unrelated words here"), "Short and only.")
        self.assertEqual(litmap._page(0), "")
        self.assertEqual(litmap._page(4), ", p. 4")


class TestCommand(LitmapCase):
    def setUp(self):
        super().setUp()
        write_index(self.index, BASE)
        self.dates = dict(BASE_DATES)

    def test_lm15_disabled_is_a_no_op_unless_out_is_given(self):
        self.cfg.litmap["enabled"] = False
        res = litmap.run(self.cfg, week="2026-W41", dates=self.dates)
        self.assertIn("not enabled", res["message"])
        self.assertFalse((self.vault / "Literature maps").exists())
        self.assertFalse((self.cfg.data_dir / "litmap").exists())
        self.run_map(week="2026-W41")
        self.assertTrue((self.root / "out" / "2026-W41.md").exists())
        self.assertFalse((self.vault / "Literature maps").exists())

    def test_lm15_enabled_writes_into_the_vault(self):
        litmap.run(self.cfg, week="2026-W41", dates=self.dates, now=datetime(2026, 10, 19))
        self.assertTrue((self.vault / "Literature maps" / "2026-W41.md").exists())
        self.assertTrue((self.vault / "Literature maps" / "2026-W41.svg").exists())
        self.assertTrue((self.cfg.data_dir / "litmap" / "layout.json").exists())

    def test_lm15_dry_run_writes_nothing(self):
        res = self.run_map(week="2026-W41", dry_run=True)
        self.assertFalse((self.root / "out").exists())
        self.assertIn("B0", res["summary"])

    def test_lm15_busy_lock(self):
        lock = self.cfg.data_dir / "litmap.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        with open(lock, "a") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            res = litmap.run(self.cfg, week="2026-W41", dates=self.dates)
        self.assertIn("busy", res["message"])

    def test_default_week_is_the_last_complete_one(self):
        self.assertEqual(litmap.last_complete_week(datetime(2026, 10, 29, 12)), "2026-W43")
        self.assertEqual(litmap.last_complete_week(datetime(2026, 10, 26, 0, 1)), "2026-W43")


if __name__ == "__main__":
    unittest.main()
