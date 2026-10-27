import hashlib
import io
import json
import os
import plistlib
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from planner import searchindex, store, zotwatch
from planner.config import Config

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "search"


class TestZotwatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.vault_dir = self.tmp_path / "vault"
        self.vault_dir.mkdir(parents=True)
        self.data_dir = self.vault_dir / ".planner"
        self.data_dir.mkdir(parents=True)
        self.zotero_dir = self.tmp_path / "zotero"
        self.zotero_dir.mkdir(parents=True)

        # Copy sqlite fixture
        orig_db = FIXTURES_DIR / "zotero.sqlite"
        (self.zotero_dir / "zotero.sqlite").write_bytes(orig_db.read_bytes())

        # Copy sample storage PDFs
        for att_dir, fname in [
            ("ATT001", "sample.pdf"),
            ("ATT002", "sample2.pdf"),
            ("ATT004A", "main.pdf"),
            ("ATT004B", "supp.pdf"),
        ]:
            sp = self.zotero_dir / "storage" / att_dir
            sp.mkdir(parents=True, exist_ok=True)
            (sp / fname).write_bytes((FIXTURES_DIR / "sample.pdf").read_bytes())

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
            },
        )

    def tearDown(self):
        self.tmp.cleanup()

    def fake_embed(self, texts, **kwargs):
        import math
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

    # W1 no change -> no build, no writes, finished in under 1.5s
    def test_w1_no_change_no_build_no_writes(self):
        # Initial build
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        # Record initial fingerprint in state.json
        fp = zotwatch.compute_fingerprint(self.zotero_dir)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = fp
        state_file.write_text(json.dumps(state))

        # Take recursive snapshot of search dir
        search_dir = self.data_dir / "search"
        files_before = {p: (p.stat().st_mtime_ns, p.read_bytes()) for p in search_dir.glob("*")}

        t0 = time.time()
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            ret = zotwatch.watch_run(self.cfg, quiet_s=0.01)
        elapsed = time.time() - t0

        self.assertEqual(ret, 0)
        self.assertLess(elapsed, 1.5)
        self.assertIn("no changes", stdout.getvalue())

        # Assert zero bytes written (all mtimes and contents identical)
        for p, (mtime, content) in files_before.items():
            self.assertEqual(p.stat().st_mtime_ns, mtime)
            self.assertEqual(p.read_bytes(), content)

    # W2 changed item, attachment count, or PDF mtime/size -> exactly one build
    def test_w2_fingerprint_components(self):
        # Initial build
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        fp0 = zotwatch.compute_fingerprint(self.zotero_dir)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = fp0
        state_file.write_text(json.dumps(state))

        # 1. Modify item clientDateModified
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        cur = conn.cursor()
        cur.execute("UPDATE items SET clientDateModified = '2026-10-20T12:00:00' WHERE key = 'KEY0001'")
        conn.commit()
        conn.close()

        fp1 = zotwatch.compute_fingerprint(self.zotero_dir)
        self.assertNotEqual(fp1, fp0)

        # 2. Modify attachment count
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        cur = conn.cursor()
        cur.execute("INSERT INTO items (itemID, itemTypeID, key, clientDateModified) VALUES (8888, 3, 'ATT8888', '2026-10-20T12:00:00')")
        cur.execute("INSERT INTO itemAttachments (itemID, parentItemID, contentType, path) VALUES (8888, 1, 'application/pdf', 'storage:test.pdf')")
        conn.commit()
        conn.close()

        fp2 = zotwatch.compute_fingerprint(self.zotero_dir)
        self.assertNotEqual(fp2, fp1)

        # 3. Modify PDF file mtime & size
        pdf = self.zotero_dir / "storage" / "ATT001" / "sample.pdf"
        pdf.write_bytes(pdf.read_bytes() + b"\n% added content\n")
        fp3 = zotwatch.compute_fingerprint(self.zotero_dir)
        self.assertNotEqual(fp3, fp2)

    # W3 lock held -> busy, exit 0, no build
    def test_w3_lock_held_busy_exit_0(self):
        import fcntl
        lock_file = self.data_dir / "search.lock"
        f = open(lock_file, "w")
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

        stdout = io.StringIO()
        try:
            with patch("sys.stdout", stdout):
                ret = zotwatch.watch_run(self.cfg)
            self.assertEqual(ret, 0)
            self.assertIn("busy", stdout.getvalue())
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()

    # W4 quiet wait: countdown restarts on new change, gives up after max_wait_s
    def test_w4_quiet_wait(self):
        db_path = self.zotero_dir / "zotero.sqlite"
        simulated_time = 1000.0

        def fake_time():
            return simulated_time

        def fake_sleep(dur):
            nonlocal simulated_time
            simulated_time += dur

        # Database modified at t = 995 (5s ago), quiet_s = 20s
        os.utime(db_path, (995, 995))
        quiet = zotwatch.wait_for_quiet(
            db_path,
            quiet_s=20.0,
            check_interval_s=5.0,
            max_wait_s=600.0,
            time_fn=fake_time,
            sleep_fn=fake_sleep,
        )
        self.assertTrue(quiet)
        # Should have advanced time by 15s (from 1000 to 1015, age 20)
        self.assertAlmostEqual(simulated_time, 1015.0, places=1)

        # Gives up after max_wait_s
        simulated_time = 1000.0
        def fake_sleep_stuck(dur):
            nonlocal simulated_time
            simulated_time += dur
            # Database continuously touched
            os.utime(db_path, (simulated_time, simulated_time))

        quiet_timeout = zotwatch.wait_for_quiet(
            db_path,
            quiet_s=20.0,
            check_interval_s=5.0,
            max_wait_s=50.0,
            time_fn=fake_time,
            sleep_fn=fake_sleep_stuck,
        )
        self.assertFalse(quiet_timeout)

    # W5 failed build: error logged, fingerprint not recorded, exit 0, retries next run
    def test_w5_failed_build_keeps_old_fingerprint(self):
        # Initial build
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = "old_fingerprint"
        state_file.write_text(json.dumps(state))

        # Build fails with error
        with patch("planner.searchindex.build_index", side_effect=RuntimeError("Ollama offline")):
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                ret = zotwatch.watch_run(self.cfg, quiet_s=0.01)

            self.assertEqual(ret, 0)
            self.assertIn("build failed", stdout.getvalue())

        # Old fingerprint preserved so next run retries
        state_after = json.loads(state_file.read_text())
        self.assertEqual(state_after["fingerprint"], "old_fingerprint")

    # W6 change during build -> second round runs, at most 3 rounds
    def test_w6_change_during_build(self):
        # Initial build
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = "old_fp"
        state_file.write_text(json.dumps(state))

        rounds = 0
        def changing_build(*args, **kwargs):
            nonlocal rounds
            rounds += 1
            # Modify sqlite date during build
            conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
            cur = conn.cursor()
            cur.execute(f"UPDATE items SET clientDateModified = '2026-10-20T12:00:0{rounds}' WHERE key = 'KEY0001'")
            conn.commit()
            conn.close()
            return {"papers": 4, "chunks": 4, "elapsed": 0.1, "no_text_pdfs": []}

        with patch("planner.searchindex.build_index", side_effect=changing_build):
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                ret = zotwatch.watch_run(self.cfg, quiet_s=0.01)

            self.assertEqual(ret, 0)
            # Reached max 3 rounds
            self.assertEqual(rounds, 3)

    # W7 zotero.sqlite missing or unreadable -> logged, exit 0, no traceback
    def test_w7_sqlite_missing_or_unreadable(self):
        (self.zotero_dir / "zotero.sqlite").unlink()

        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            ret = zotwatch.watch_run(self.cfg, quiet_s=0.01)

        self.assertEqual(ret, 0)
        self.assertIn("does not exist", stdout.getvalue())

    # W8 plist validation
    def test_w8_plist_validity(self):
        plist_path = Path(__file__).parent.parent / "launchd" / "com.planner.zotero-watch.plist"
        self.assertTrue(plist_path.exists())

        with open(plist_path, "rb") as f:
            pl = plistlib.load(f)

        self.assertEqual(pl["Label"], "com.planner.zotero-watch")
        self.assertIn("WatchPaths", pl)
        self.assertEqual(len(pl["WatchPaths"]), 3)
        self.assertTrue(any(w.endswith("zotero.sqlite-wal") for w in pl["WatchPaths"]))
        self.assertGreaterEqual(pl["ThrottleInterval"], 10)
        self.assertIn("watch-run", pl["ProgramArguments"])
        self.assertIn("logs/zotero-watch.log", pl["StandardOutPath"])
        self.assertNotIn("KeepAlive", pl)
        self.assertFalse(pl.get("RunAtLoad", True))
        # Hourly retry for a keyword-only index; no tighter, to keep wake-ups rare
        self.assertGreaterEqual(pl["StartInterval"], 3600)

    # W10 keyword-only index: unchanged library retries only when Ollama answers
    def test_w10_degraded_index_retries_once_ollama_is_back(self):
        failing_embed = MagicMock(side_effect=RuntimeError("Connection refused"))
        searchindex.build_index(self.cfg, full=True, allow_fallback=True, embed_fn=failing_embed)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = zotwatch.compute_fingerprint(self.zotero_dir)
        state_file.write_text(json.dumps(state))
        self.assertTrue(state["degraded"])

        # Ollama still down: one probe, no build
        with patch("planner.zotwatch.ollama_up", return_value=False), \
                patch("planner.searchindex.build_index") as mock_build:
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(zotwatch.watch_run(self.cfg, quiet_s=0.01), 0)
            mock_build.assert_not_called()
            self.assertIn("Ollama still unavailable", stdout.getvalue())

        # Ollama back: rebuild embeds the missing texts and clears the mark
        real_build = searchindex.build_index
        with patch("planner.zotwatch.ollama_up", return_value=True), \
                patch("planner.searchindex.build_index",
                      side_effect=lambda cfg, full=False: real_build(cfg, full=full, embed_fn=self.fake_embed)):
            with patch("sys.stdout", io.StringIO()):
                self.assertEqual(zotwatch.watch_run(self.cfg, quiet_s=0.01), 0)
        state_after = json.loads(state_file.read_text())
        self.assertNotIn("degraded", state_after)
        manifest = json.loads((self.data_dir / "search" / "manifest.json").read_text())
        self.assertEqual(manifest["missing_vectors"], 0)

        # Healthy and unchanged: back to the plain no-change exit, no Ollama probe
        with patch("planner.zotwatch.ollama_up") as mock_up, patch("sys.stdout", io.StringIO()):
            zotwatch.watch_run(self.cfg, quiet_s=0.01)
            mock_up.assert_not_called()

    # W9 doctor checks
    def test_w9_doctor_checks(self):
        from planner import health

        # 1. Watch job not loaded -> fail with bootstrap fix
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            res = health.check_zotero_watch(self.cfg)
            self.assertIsNotNone(res)
            self.assertFalse(res.ok)
            self.assertIn("./setup-search.sh start", res.message)

        # 2. Watch log has 3 consecutive build failed -> warning. A log in a scratch root: the real
        # logs/zotero-watch.log belongs to the running watcher (this test used to overwrite and delete it).
        log_dir = self.tmp_path / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / "zotero-watch.log").write_text(
            "zotero watch: build failed (1)\nzotero watch: build failed (2)\nzotero watch: build failed (3)\n")

        with patch("subprocess.run") as mock_run, patch("planner.health.ROOT", self.tmp_path):
            mock_run.return_value = MagicMock(returncode=0)
            res = health.check_zotero_watch(self.cfg)
            self.assertIsNotNone(res)
            self.assertFalse(res.ok)
            self.assertIn("3 consecutive failed builds", res.message)

    # W10 morning job and watcher at once: one builds, other busy, index consistent
    def test_w10_concurrent_watcher_and_morning(self):
        import fcntl
        # Run searchindex.build_index and zotwatch.watch_run concurrently
        # Lock acquired by searchindex
        lock_path = self.data_dir / "search.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        f = open(lock_path, "w")
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

        try:
            # Watcher runs while lock is held
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                ret = zotwatch.watch_run(self.cfg, quiet_s=0.01)
            self.assertEqual(ret, 0)
            self.assertIn("busy", stdout.getvalue())
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()

    # PF9 / B12: watch-run 10 times with unchanged fingerprint: p95 <= 1.5s, 0 bytes written
    def test_pf9_b12_watch_run_performance(self):
        searchindex.build_index(self.cfg, full=True, embed_fn=self.fake_embed)
        fp = zotwatch.compute_fingerprint(self.zotero_dir)
        state_file = self.data_dir / "search" / "state.json"
        state = json.loads(state_file.read_text())
        state["fingerprint"] = fp
        state_file.write_text(json.dumps(state))

        search_dir = self.data_dir / "search"
        files_before = {p: (p.stat().st_mtime_ns, p.read_bytes()) for p in search_dir.glob("*")}

        times = []
        for _ in range(10):
            t0 = time.time()
            ret = zotwatch.watch_run(self.cfg, quiet_s=0.01)
            times.append(time.time() - t0)
            self.assertEqual(ret, 0)

        times.sort()
        p95 = times[int(0.95 * len(times))]
        print(f"\n[PF9 / B12] watch-run unchanged p95: {p95:.4f}s (budget <= 1.5s)")
        self.assertLessEqual(p95, 1.5)

        # 0 bytes written
        for p, (mtime, content) in files_before.items():
            self.assertEqual(p.stat().st_mtime_ns, mtime)
            self.assertEqual(p.read_bytes(), content)

    # W11 the real watch_run -> build_index path builds (regression: build_index re-took the
    # watcher's own lock and always timed out). Only the embedding call is faked.
    def test_w11_real_build_under_watcher_lock(self):
        import functools

        real_build = searchindex.build_index
        stdout = io.StringIO()
        # lock_timeout=1 so a self-deadlock fails in 1 s instead of 60 s
        with patch("planner.searchindex.build_index", functools.partial(real_build, lock_timeout=1.0)), \
             patch("planner.embed.embed", side_effect=lambda texts, **kw: self.fake_embed(texts, **kw)), \
             patch("sys.stdout", stdout):
            ret = zotwatch.watch_run(self.cfg, quiet_s=0.0)

        log = stdout.getvalue()
        self.assertEqual(ret, 0)
        self.assertIn("build completed", log, log)
        self.assertNotIn("build failed", log)
        state = json.loads((self.data_dir / "search" / "state.json").read_text())
        self.assertEqual(state.get("fingerprint"), zotwatch.compute_fingerprint(self.zotero_dir))
        self.assertTrue((self.data_dir / "search" / "vectors.f32").exists())

    # W15 Zotero runs in WAL mode with an exclusive lock: changes not yet checkpointed into zotero.sqlite must still
    # be seen (regression: ?immutable=1 and a copy of zotero.sqlite alone both missed them, for hours)
    def test_w15_sees_changes_still_in_the_write_ahead_log(self):
        from planner import zotlib
        db = self.zotero_dir / "zotero.sqlite"
        before_fp = zotwatch.compute_fingerprint(self.zotero_dir)
        before = {p.key for p in zotlib.read_library(self.zotero_dir)}
        self.assertIn("KEY0001", before)

        zotero = sqlite3.connect(db)   # plays Zotero: stays open, holds the lock, never checkpoints
        try:
            zotero.execute("PRAGMA journal_mode=WAL")
            zotero.execute("PRAGMA locking_mode=EXCLUSIVE")
            zotero.execute("PRAGMA wal_autocheckpoint=0")
            zotero.execute("INSERT INTO deletedItems (itemID, dateDeleted) VALUES (1, '2026-10-27 09:23:15')")
            zotero.commit()
            wal = self.zotero_dir / "zotero.sqlite-wal"
            self.assertGreater(wal.stat().st_size, 0)
            with self.assertRaises(sqlite3.OperationalError):   # why the readers copy instead of opening in place
                sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute("SELECT COUNT(*) FROM items").fetchone()

            self.assertNotEqual(zotwatch.compute_fingerprint(self.zotero_dir), before_fp)
            after = {p.key for p in zotlib.read_library(self.zotero_dir)}
            self.assertEqual(before - after, {"KEY0001"})
            # The quiet wait goes by the log, which is what Zotero writes
            os.utime(db, (time.time() - 100, time.time() - 100))
            self.assertFalse(zotwatch.wait_for_quiet(db, quiet_s=30, max_wait_s=0, sleep_fn=lambda s: None))
        finally:
            zotero.close()

    # W13 a library change is published keyword-only first (citable before embedding), then embedded
    def test_w13_keyword_index_published_before_embedding(self):
        real_build = searchindex.build_index
        seen = []

        def recording_build(cfg, **kw):
            res = real_build(cfg, embed_fn=None if kw.get("keyword_only") else self.fake_embed, **kw)
            papers = json.loads((self.data_dir / "search" / "papers.json").read_text())
            seen.append((kw.get("keyword_only", False), res["missing_vectors"], len(papers)))
            return res

        stdout = io.StringIO()
        with patch("planner.searchindex.build_index", side_effect=recording_build), patch("sys.stdout", stdout):
            self.assertEqual(zotwatch.watch_run(self.cfg, quiet_s=0.0), 0)
        log = stdout.getvalue()
        self.assertEqual([k for k, _, _ in seen], [True, False], log)
        (_, missing, n_first), (_, missing_after, n_after) = seen
        self.assertGreater(missing, 0)          # first publish: every paper listed, no vectors yet
        self.assertEqual(n_first, n_after)
        self.assertEqual(missing_after, 0)
        self.assertIn("keyword index published", log)
        self.assertNotIn("degraded", json.loads((self.data_dir / "search" / "state.json").read_text()))

        # Metadata-only edit with nothing new to embed: the keyword-only build is the whole build
        seen.clear()
        conn = sqlite3.connect(self.zotero_dir / "zotero.sqlite")
        conn.execute("UPDATE items SET clientDateModified = '2026-10-21T12:00:00' WHERE key = 'KEY0001'")
        conn.commit()
        conn.close()
        with patch("planner.searchindex.build_index", side_effect=recording_build), patch("sys.stdout", io.StringIO()):
            zotwatch.watch_run(self.cfg, quiet_s=0.0)
        self.assertEqual([k for k, _, _ in seen], [True])

    # W14 the retry probe asks the configured embedder, not always Ollama
    def test_w14_embedder_up_follows_backend(self):
        self.cfg.search["backend"] = "pplx"
        with patch("planner.pplx.health", return_value={"ok": True}) as h, patch("planner.zotwatch.ollama_up") as o:
            self.assertEqual(zotwatch.embedder_up(self.cfg), ("pplx", True))
            o.assert_not_called()
            h.assert_called_once()
        with patch("planner.pplx.health", return_value=None):
            self.assertEqual(zotwatch.embedder_up(self.cfg), ("pplx", False))
        self.cfg.search["backend"] = "ollama"
        with patch("planner.zotwatch.ollama_up", return_value=True):
            self.assertEqual(zotwatch.embedder_up(self.cfg), ("Ollama", True))

    # W12 the lock still excludes a different process while held re-entrantly in this one
    def test_w12_reentrant_lock_still_excludes_other_processes(self):
        import subprocess, sys, textwrap

        probe = textwrap.dedent(f"""
            import fcntl, sys
            f = open({str(self.data_dir / 'search.lock')!r}, 'a')
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                print('acquired')
            except OSError:
                print('busy')
        """)
        with store.search_lock(self.cfg, blocking=False):
            with store.search_lock(self.cfg, timeout=1.0):
                out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True).stdout.strip()
                self.assertEqual(out, "busy")
            # inner exit must not release the outer hold
            out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True).stdout.strip()
            self.assertEqual(out, "busy")
        out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "acquired")


if __name__ == "__main__":
    unittest.main()
