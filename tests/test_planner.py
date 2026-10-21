import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

from planner import brief, health, stats, threads, vault
from planner.config import Config
from planner.extract import PROMPT_VERSION


class TestDaitoR1(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault_dir = Path(self.tmp.name) / "vault"
        self.vault_dir.mkdir(parents=True)
        self.daily_dir = self.vault_dir
        self.data_dir = self.vault_dir / ".planner"
        self.data_dir.mkdir(parents=True)
        self.template_path = self.vault_dir / "Templates" / "Daily.md"
        self.template_path.parent.mkdir(parents=True)
        self.template_text = (
            "Flow\n- \n\ntype A\n- \ntype B\n- \ntype C\n- \n\nstatus/done\n- \n\nthoughts\n- \n"
        )
        self.template_path.write_text(self.template_text)
        self.cfg = Config(
            vault=self.vault_dir,
            daily_dir=self.daily_dir,
            data_dir=self.data_dir,
            models={"extract": "groq:openai/gpt-oss-120b"},
            extract={"thread_window_days": 21},
            brief={"slip_window_notes": 6, "slip_min": 3, "collapsed": True},
            reviews_dir=self.vault_dir / "Reviews",
            daily_template=self.template_path,
            schedule={"day_starts_hour": 4, "remind": True, "remind_hour": 21},
            threads={"file": "Threads.md", "active_days": 14, "quiet_days": 60, "lines_per_thread": 6},
        )

    def tearDown(self):
        self.tmp.cleanup()

    # 1. Done headings
    def test_1_done_headings(self):
        # Empty template
        p1 = self.daily_dir / "2026-10-18.md"
        p1.write_text(self.template_text)
        self.assertFalse(stats.has_done_section(p1))

        # Bullet under status/done
        p2 = self.daily_dir / "2026-10-19.md"
        p2.write_text(
            "Flow\n- gym\n\ntype A\n- task 1\n\nstatus/done\n- schlogl chap 1\n\nthoughts\n- \n"
        )
        self.assertTrue(stats.has_done_section(p2))

        # Bullet only under thoughts
        p3 = self.daily_dir / "2026-10-20.md"
        p3.write_text(
            "Flow\n- \n\ntype A\n- task 2\n\nstatus/done\n- \n\nthoughts\n- had a nice chat with victor\n"
        )
        self.assertFalse(stats.has_done_section(p3))

    # 2. note_text
    def test_2_note_text(self):
        d_minus_1 = self.daily_dir / "2026-10-19.md"
        d = self.daily_dir / "2026-10-20.md"

        d_minus_1.write_text("type A\n- task 1\n\nstatus/done\n- existing item\n\nthoughts\n- t\n")
        d.write_text("%% planner:start %%\n> Brief\n%% planner:end %%\ny: did something\n- y: also did this\ntype A\n- task 2\n")

        # y: lines removed from day D and brief stripped
        d_text = vault.note_text(d)
        self.assertNotIn("y: did something", d_text)
        self.assertNotIn("also did this", d_text)
        self.assertNotIn("planner:start", d_text)
        self.assertIn("type A\n- task 2", d_text)

        # y: lines appended under done on D-1 and status/done -> done
        d1_text = vault.note_text(d_minus_1)
        self.assertIn("done\n- existing item\n- did something\n- also did this", d1_text)
        self.assertNotIn("status/done", d1_text)

        # When D-1 has no note
        isolated_d = self.daily_dir / "2026-10-25.md"
        isolated_d.write_text("y: line for missing day\ntype B\n- research\n")
        iso_text = vault.note_text(isolated_d)
        self.assertNotIn("y:", iso_text)
        self.assertIn("type B\n- research", iso_text)

        # When D-1 has no done section at all, y: lines create a done section
        no_done = self.daily_dir / "2026-10-21.md"
        no_done.write_text("type A\n- solo task\n")
        next_note = self.daily_dir / "2026-10-22.md"
        next_note.write_text("yesterday: retro item\n")
        res_text = vault.note_text(no_done)
        self.assertIn("done\n- retro item", res_text)

    # 3. Hashing
    def test_3_hashing(self):
        d1 = self.daily_dir / "2026-10-18.md"
        d2 = self.daily_dir / "2026-10-19.md"

        d1.write_text("type A\n- study\n")
        h1_before = vault.sha(vault.note_text(d1))

        d2.write_text("type A\n- more study\n")
        h2_before = vault.sha(vault.note_text(d2))

        # Adding a y: line to d2
        d2.write_text("y: completed study\ntype A\n- more study\n")
        h2_after = vault.sha(vault.note_text(d2))
        h1_after = vault.sha(vault.note_text(d1))

        # d2's own hash is unchanged
        self.assertEqual(h2_before, h2_after)
        # d1's hash changed because it absorbed d2's y: line
        self.assertNotEqual(h1_before, h1_after)

        # PROMPT_VERSION is unchanged
        extract_prompt_path = Path(__file__).parent.parent / "prompts" / "extract.md"
        self.assertEqual(PROMPT_VERSION, vault.sha(extract_prompt_path.read_text()))

    # 4. Same-day refresh
    def test_4_same_day_refresh(self):
        from planner.__main__ import _daytime_tick

        today = date(2026, 10, 19)
        now = datetime(2026, 10, 19, 10, 0)
        today_note = self.daily_dir / "2026-10-19.md"
        today_note.write_text("Flow\n- cafe\ny: schlogl part 1\n")
        # mtime set to 5 minutes ago (> 3 min relative to now)
        os.utime(today_note, (now.timestamp() - 300, now.timestamp() - 300))

        state = {"last_morning": "2026-10-19", "brief_inserted": ["2026-10-19"]}

        with patch("planner.__main__.online", return_value=True), \
             patch("planner.__main__.cmd_backfill") as mock_bf, \
             patch("planner.__main__.cmd_brief") as mock_br:
            _daytime_tick(self.cfg, state, today, now)
            self.assertEqual(mock_bf.call_count, 1)
            self.assertEqual(mock_br.call_count, 1)
            self.assertIn("y_refreshed", state)
            self.assertEqual(state["y_refreshed"]["day"], "2026-10-19")

            # Second tick with same lines does nothing
            mock_bf.reset_mock()
            mock_br.reset_mock()
            _daytime_tick(self.cfg, state, today, now)
            mock_bf.assert_not_called()
            mock_br.assert_not_called()

        # mtime < 3 min -> nothing
        state2 = {"last_morning": "2026-10-19"}
        os.utime(today_note, (now.timestamp() - 60, now.timestamp() - 60))
        with patch("planner.__main__.online", return_value=True), \
             patch("planner.__main__.cmd_backfill") as mock_bf:
            _daytime_tick(self.cfg, state2, today, now)
            mock_bf.assert_not_called()

        # offline -> nothing
        os.utime(today_note, (now.timestamp() - 300, now.timestamp() - 300))
        with patch("planner.__main__.online", return_value=False), \
             patch("planner.__main__.cmd_backfill") as mock_bf:
            _daytime_tick(self.cfg, state2, today, now)
            mock_bf.assert_not_called()

    # 5. Reminder
    def test_5_reminder(self):
        from planner.__main__ import _daytime_tick, show_reminder

        today = date(2026, 10, 19)
        today_note = self.daily_dir / "2026-10-19.md"
        today_note.write_text("type A\n- work\n")

        state = {"last_morning": "2026-10-19"}

        # Fires after remind_hour (21:30)
        with patch("planner.__main__.show_reminder") as mock_rem:
            _daytime_tick(self.cfg, state, today, datetime(2026, 10, 19, 21, 30))
            self.assertEqual(mock_rem.call_count, 1)
            self.assertEqual(state.get("last_reminded"), "2026-10-19")

        # Does not fire twice
        with patch("planner.__main__.show_reminder") as mock_rem:
            _daytime_tick(self.cfg, state, today, datetime(2026, 10, 19, 22, 0))
            mock_rem.assert_not_called()

        # Does not fire before 21:00
        state2 = {"last_morning": "2026-10-19"}
        with patch("planner.__main__.show_reminder") as mock_rem:
            _daytime_tick(self.cfg, state2, today, datetime(2026, 10, 19, 15, 0))
            mock_rem.assert_not_called()

        # Fires after midnight before 04:00
        with patch("planner.__main__.show_reminder") as mock_rem:
            _daytime_tick(self.cfg, state2, today, datetime(2026, 10, 20, 1, 30))
            self.assertEqual(mock_rem.call_count, 1)

        # Does not fire when note has a done section
        state3 = {"last_morning": "2026-10-19"}
        today_note.write_text("type A\n- work\n\nstatus/done\n- finished\n")
        with patch("planner.__main__.show_reminder") as mock_rem:
            _daytime_tick(self.cfg, state3, today, datetime(2026, 10, 19, 21, 30))
            mock_rem.assert_not_called()

        # Fallback to health.notify when osascript fails
        with patch("subprocess.run") as mock_sub, patch("planner.health.notify") as mock_not:
            mock_sub.return_value = MagicMock(returncode=1, stderr="no user interaction", stdout="")
            show_reminder(self.cfg, today)
            mock_not.assert_called_once_with("Planner", "One line on what got done today, even 'nothing'.")

    # 6. Future notes
    def test_6_future_notes(self):
        future_file = self.daily_dir / "2028-09-01.md"
        future_file.write_text("future content")
        today = date(2026, 10, 19)

        res = health.check_future_notes(self.cfg, today)
        self.assertIsNotNone(res)
        self.assertFalse(res.ok)
        self.assertIn("2028-09-01.md is dated in the future", res.message)

        # Renaming it fixes it
        future_file.rename(self.daily_dir / "2026-09-01.md")
        res2 = health.check_future_notes(self.cfg, today)
        self.assertIsNone(res2)

    # 7. Carried grouping
    def test_7_carried_grouping(self):
        sides = [
            {
                "date": "2026-10-18",
                "items": [
                    {"kind": "task", "type": "B", "planned": True, "status": "unknown", "thread": "weinberg-review", "text": "weinberg next reading research"},
                    {"kind": "task", "type": "B", "planned": True, "status": "unknown", "thread": "weinberg-review", "text": "find evidence on AS"},
                    {"kind": "task", "type": "B", "planned": True, "status": "unknown", "thread": "weinberg-review", "text": "possible paths validating"},
                    {"kind": "task", "type": "A", "planned": True, "status": "partial", "thread": "mib-derivation", "text": "mib sim"},
                    {"kind": "task", "type": "A", "planned": True, "status": "unknown", "thread": "mib-derivation", "text": "mib derivation"},
                    {"kind": "task", "type": "C", "planned": True, "status": "unknown", "thread": "", "text": "standalone task 1"},
                    {"kind": "task", "type": "C", "planned": True, "status": "unknown", "thread": "", "text": "standalone task 2"},
                ]
            }
        ]
        (self.daily_dir / "2026-10-18.md").write_text("status/done\n- partial work\n")

        st = stats.compute(date(2026, 10, 19), sides, self.daily_dir)
        # Check carried entries
        self.assertEqual(len(st.carried), 4)
        # weinberg-review grouped
        w = next(it for it in st.carried if it["thread"] == "weinberg-review")
        self.assertEqual(w["extra"], 2)
        self.assertEqual(w["text"], "weinberg next reading research")
        self.assertEqual(w["status"], "unknown")

        # mib-derivation grouped with partial status
        m = next(it for it in st.carried if it["thread"] == "mib-derivation")
        self.assertEqual(m["extra"], 1)
        self.assertEqual(m["status"], "partial")

        # Brief rendering
        block = brief.render(st, focus=[], collapsed=True)
        self.assertIn("weinberg next reading research (+2)", block)
        self.assertIn("mib sim (+1) (partial)", block)
        self.assertIn("standalone task 1", block)
        self.assertIn("standalone task 2", block)

    # 8. Threads.md dashboard
    def test_8_threads_dashboard(self):
        sides = [
            {
                "date": "2026-10-14",
                "items": [
                    {"kind": "task", "type": "B", "thread": "weinberg-review", "text": "weinberg lit search", "status": "done"},
                ]
            },
            {
                "date": "2026-10-18",
                "items": [
                    {"kind": "task", "type": "B", "thread": "weinberg-review", "text": "weinberg next reading research", "status": "unknown"},
                    {"kind": "task", "type": "B", "thread": "weinberg-review", "text": "find evidence on AS", "status": "unknown"},
                    {"kind": "task", "type": "A", "thread": "cancer-ankis", "text": "Ankis for cancer slides", "status": "unknown"},
                ]
            },
            {
                "date": "2026-09-20",
                "items": [
                    {"kind": "task", "type": "B", "thread": "chuling-spheroid", "text": "Chuling cells", "status": "done"},
                ]
            },
            {
                "date": "2026-09-23",
                "items": [
                    {"kind": "task", "type": "B", "thread": "chuling-spheroid", "text": "Chuling spheroid brainstorm", "status": "partial"},
                ]
            },
            {
                "date": "2026-07-01",
                "items": [
                    {"kind": "task", "type": "A", "thread": "ancient-thread", "text": "old work", "status": "done"},
                ]
            }
        ]
        today = date(2026, 10, 19)
        dash = threads.render_dashboard(sides, today, self.cfg)

        # Check sections
        self.assertIn("## Active (seen in the last 14 days)", dash)
        self.assertIn("### weinberg-review · B · 2 notes · last Sun 18 Oct", dash)
        self.assertIn("- [[2026-10-18]] · weinberg next reading research (+1)", dash)
        self.assertIn("- [[2026-10-14]] ✓ weinberg lit search", dash)

        self.assertIn("## Quiet (15–60 days)", dash)
        self.assertIn("### chuling-spheroid · B · 2 notes", dash)

        self.assertIn("> [!info]- Mentioned once (1)", dash)
        self.assertIn("cancer-ankis · Ankis for cancer slides", dash)
        # Ancient thread (>60 days) is left out
        self.assertNotIn("ancient-thread", dash)

        # Upsert
        # 1. Missing file -> returns dash
        self.assertEqual(threads.upsert_threads(None, dash), dash)
        # 2. Existing with markers -> replaces
        existing = "Header note\n\n%% planner:threads:start %%\nold\n%% planner:threads:end %%\nFooter note"
        updated = threads.upsert_threads(existing, dash)
        self.assertIn("Header note\n\n" + dash + "Footer note", updated)
        # 3. Existing without markers -> returns None
        no_markers = "Custom handwritten file without planner markers"
        self.assertIsNone(threads.upsert_threads(no_markers, dash))


class TestR1Fixes(unittest.TestCase):
    """Fixes from the 19 Oct review of R1."""

    setUp = TestDaitoR1.setUp
    tearDown = TestDaitoR1.tearDown

    def test_blank_template_note_stays_blank_through_note_text(self):
        note = self.daily_dir / "2026-10-19.md"
        note.write_text("%% planner:start %%\n> brief\n%% planner:end %%\n\n" + self.template_text)
        self.assertTrue(vault.is_blank(vault.note_text(note).lstrip("\n"), self.template_text))
        note.write_text(self.template_text.replace("status/done\n- ", "status/done\n- gym"))
        self.assertFalse(vault.is_blank(vault.note_text(note).lstrip("\n"), self.template_text))

    def test_groq_json_failure_retries_at_medium_effort(self):
        from planner import extract
        from planner.llm import LLMError

        efforts = []

        def fake_call(msg, cfg):
            efforts.append(cfg.get("reasoning_effort"))
            if cfg.get("reasoning_effort") == "high":
                raise LLMError('HTTP 400: {"code":"json_validate_failed","failed_generation":""}')
            return {"flow": [], "items": [{"text": "gym", "kind": "task", "type": "life"}]}, False

        cfg = {"extract": "groq:openai/gpt-oss-120b", "reasoning_effort": "high"}
        with patch.object(extract, "_call", side_effect=fake_call):
            side = extract._extract(date(2026, 10, 18), "done\n- gym", [], cfg)
        self.assertEqual(efforts, ["high", "medium"])
        self.assertEqual(side["model"], "groq:openai/gpt-oss-120b")  # still counts as a primary-model sidecar
        self.assertEqual(cfg["reasoning_effort"], "high")  # caller's config untouched

        # Other errors keep the effort as configured.
        efforts.clear()
        with patch.object(extract, "_call", side_effect=LLMError("HTTP 500")), self.assertRaises(LLMError):
            extract._extract(date(2026, 10, 18), "x", [], cfg)

    def _tick_setup(self):
        today, now = date(2026, 10, 19), datetime(2026, 10, 19, 10, 0)
        note = self.daily_dir / "2026-10-19.md"
        note.write_text("Flow\n- cafe\ny: schlogl part 1\n")
        os.utime(note, (now.timestamp() - 300, now.timestamp() - 300))
        return today, now, {"last_morning": "2026-10-19", "brief_inserted": ["2026-10-19"]}

    def test_refresh_keeps_morning_warnings(self):
        from planner.__main__ import _daytime_tick, write_json

        write_json(self.data_dir / "health.json", {"results": [], "warnings": ["Groq has been failing."]})
        today, now, state = self._tick_setup()
        with patch("planner.__main__.online", return_value=True), \
             patch("planner.__main__.cmd_backfill"), \
             patch("planner.__main__.cmd_brief") as mock_br:
            _daytime_tick(self.cfg, state, today, now)
        self.assertEqual(mock_br.call_args.args[1].warnings, ["Groq has been failing."])

        # health.json written before this fix has no "warnings" key: fall back to the failed checks.
        write_json(self.data_dir / "health.json", {"results": [{"name": "x", "ok": False, "message": "old"},
                                                               {"name": "y", "ok": True, "message": ""}]})
        state.pop("y_refreshed")
        with patch("planner.__main__.online", return_value=True), \
             patch("planner.__main__.cmd_backfill"), \
             patch("planner.__main__.cmd_brief") as mock_br:
            _daytime_tick(self.cfg, state, today, now)
        self.assertEqual(mock_br.call_args.args[1].warnings, ["old"])

    def test_refresh_survives_failed_extraction_and_does_not_retry(self):
        from planner.__main__ import _daytime_tick

        today, now, state = self._tick_setup()
        with patch("planner.__main__.online", return_value=True), \
             patch("planner.__main__.cmd_backfill", side_effect=SystemExit("both models failed")) as mock_bf, \
             patch("planner.__main__.cmd_brief") as mock_br:
            _daytime_tick(self.cfg, state, today, now)  # must not raise
            mock_br.assert_not_called()
            self.assertTrue(state["y_refreshed"]["failed"])
            _daytime_tick(self.cfg, state, today, now)  # same y: lines: no retry
            self.assertEqual(mock_bf.call_count, 1)

        # New y: lines try again.
        note = self.daily_dir / "2026-10-19.md"
        note.write_text("Flow\n- cafe\ny: schlogl part 1\ny: gym\n")
        os.utime(note, (now.timestamp() - 300, now.timestamp() - 300))
        with patch("planner.__main__.online", return_value=True), \
             patch("planner.__main__.cmd_backfill") as mock_bf, \
             patch("planner.__main__.cmd_brief") as mock_br:
            _daytime_tick(self.cfg, state, today, now)
            mock_bf.assert_called_once()
            mock_br.assert_called_once()
        self.assertNotIn("failed", state["y_refreshed"])


if __name__ == "__main__":
    unittest.main()
