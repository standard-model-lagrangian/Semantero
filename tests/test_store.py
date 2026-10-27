import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from planner import store


class TestStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_write_json_failing_midway_keeps_the_old_file(self):
        path = self.dir / "state.json"
        store.write_json(path, {"fingerprint": "a"})
        with self.assertRaises(TypeError):
            store.write_json(path, {"fingerprint": object()})   # not serialisable
        self.assertEqual(store.load_json(path), {"fingerprint": "a"})
        self.assertEqual([p.name for p in self.dir.iterdir()], ["state.json"])   # no temp file left behind

    def test_load_json_missing_gives_the_default(self):
        self.assertEqual(store.load_json(self.dir / "nope.json", {"x": 1}), {"x": 1})

    def test_load_json_corrupt_gives_the_default_and_says_which_file(self):
        path = self.dir / "state.json"
        path.write_text('{"fingerprint": "a", "deg')
        err = io.StringIO()
        with patch("sys.stderr", err):
            self.assertEqual(store.load_json(path, {}), {})
        self.assertIn(str(path), err.getvalue())

    def test_swap_replaces_the_live_folder(self):
        final, tmp, old = self.dir / "search", self.dir / "search.tmp", self.dir / "search.old"
        final.mkdir()
        (final / "v").write_text("1")
        tmp.mkdir()
        (tmp / "v").write_text("2")
        store.atomic_swap(tmp, final, old)
        self.assertEqual((final / "v").read_text(), "2")
        self.assertFalse(tmp.exists() or old.exists())

    def test_recover_swap_restores_a_folder_left_aside_by_a_crash(self):
        # A crash between the two renames leaves the last good index in <name>.old and none live.
        final, old = self.dir / "search", self.dir / "search.old"
        old.mkdir()
        (old / "v").write_text("1")
        store.recover_swap(final, old)
        self.assertEqual((final / "v").read_text(), "1")
        self.assertFalse(old.exists())

    def test_recover_swap_leaves_a_live_folder_alone(self):
        final, old = self.dir / "search", self.dir / "search.old"
        final.mkdir()
        old.mkdir()
        store.recover_swap(final, old)
        self.assertTrue(final.exists() and old.exists())


if __name__ == "__main__":
    unittest.main()
