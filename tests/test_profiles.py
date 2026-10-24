"""Embedding profiles: one index per model, switched by moving folders (see docs/EMBED_INSTALLS.md)."""
import json
import tempfile
import unittest
from pathlib import Path

from planner import config, profiles

PROFILES_TOML = """
["qwen3-0.6b"]
label = "Qwen3 0.6B"
backend = "ollama"
model = "qwen3-embedding:0.6b"
dims = 1024

[qwen3-4b]
label = "Qwen3 4B"
backend = "ollama"
model = "qwen3-embedding:4b-q8_0"
dims = 2560

[pplx-v2-late]
label = "pplx"
backend = "pplx"
model = "pplx-embed-v2-late-0.6b@7bba8e7"
dims = 128
pplx_url = "http://127.0.0.1:11435"
"""


class ProfileTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.vault = self.tmp / "vault"
        (self.vault / ".planner").mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        (self.repo / "config.toml").write_text(
            f'vault = "{self.vault}"\n[models]\nextract = "x"\n[search]\nmodel = "qwen3-embedding:0.6b"\ndims = 1024\n'
            'query_instruction = "find papers"\n')
        (self.repo / "profiles.toml").write_text(PROFILES_TOML)

    def cfg(self):
        return config.load(self.repo / "config.toml")

    def make_index(self, base: Path, corpus: str, model: str, dims: int):
        d = base / corpus
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps({"model": model, "dims": dims, "content_hash": f"{corpus}-{model}"}))
        return d


class TestConfigOverride(ProfileTestCase):
    def test_no_profile_file_keeps_config(self):
        cfg = self.cfg()
        self.assertEqual(cfg.search["model"], "qwen3-embedding:0.6b")
        self.assertEqual(profiles.active_name(cfg), "qwen3-0.6b")  # matched by model and dims

    def test_active_profile_overrides_search_settings(self):
        (self.vault / ".planner" / "profile.json").write_text(json.dumps({"name": "pplx-v2-late"}))
        cfg = self.cfg()
        self.assertEqual(cfg.search["model"], "pplx-embed-v2-late-0.6b@7bba8e7")
        self.assertEqual(cfg.search["dims"], 128)
        self.assertEqual(cfg.search["backend"], "pplx")
        self.assertEqual(cfg.search["pplx_url"], "http://127.0.0.1:11435")
        self.assertEqual(cfg.search["query_instruction"], "find papers")  # untouched keys stay
        self.assertNotIn("label", cfg.search)

    def test_unknown_active_profile_is_ignored_with_config_values(self):
        (self.vault / ".planner" / "profile.json").write_text(json.dumps({"name": "gone"}))
        self.assertEqual(self.cfg().search["model"], "qwen3-embedding:0.6b")

    def test_unmatched_config_is_custom(self):
        (self.repo / "config.toml").write_text(
            f'vault = "{self.vault}"\n[models]\nextract = "x"\n[search]\nmodel = "other"\ndims = 64\n')
        self.assertEqual(profiles.active_name(self.cfg()), "custom")


class TestProfileConfig(ProfileTestCase):
    def test_inactive_profile_builds_in_its_own_folder(self):
        cfg = self.cfg()
        pc = profiles.profile_cfg(cfg, "qwen3-4b")
        self.assertEqual(pc.data_dir, self.vault / ".planner" / "profiles" / "qwen3-4b")
        self.assertEqual(pc.search["model"], "qwen3-embedding:4b-q8_0")
        self.assertEqual(pc.search["dims"], 2560)
        self.assertEqual(cfg.search["model"], "qwen3-embedding:0.6b")  # the original is not mutated

    def test_active_profile_builds_live(self):
        cfg = self.cfg()
        self.assertEqual(profiles.profile_cfg(cfg, "qwen3-0.6b").data_dir, self.vault / ".planner")

    def test_unknown_profile_raises(self):
        with self.assertRaises(KeyError):
            profiles.profile_cfg(self.cfg(), "nope")


class TestUse(ProfileTestCase):
    def test_swap_moves_folders_and_records_profile(self):
        live = self.vault / ".planner"
        self.make_index(live, "search", "qwen3-embedding:0.6b", 1024)
        self.make_index(live, "notes", "qwen3-embedding:0.6b", 1024)
        stash = live / "profiles" / "qwen3-4b"
        self.make_index(stash, "search", "qwen3-embedding:4b-q8_0", 2560)
        self.make_index(stash, "notes", "qwen3-embedding:4b-q8_0", 2560)

        msg = profiles.use(self.cfg(), "qwen3-4b")
        self.assertIn("qwen3-4b", msg)
        self.assertEqual(json.loads((live / "search" / "manifest.json").read_text())["model"], "qwen3-embedding:4b-q8_0")
        self.assertEqual(json.loads((live / "notes" / "manifest.json").read_text())["model"], "qwen3-embedding:4b-q8_0")
        old = live / "profiles" / "qwen3-0.6b"
        self.assertEqual(json.loads((old / "search" / "manifest.json").read_text())["model"], "qwen3-embedding:0.6b")
        self.assertFalse(stash.exists() and any(stash.iterdir()))
        self.assertEqual(json.loads((live / "profile.json").read_text())["name"], "qwen3-4b")
        self.assertEqual(self.cfg().search["model"], "qwen3-embedding:4b-q8_0")

        profiles.use(self.cfg(), "qwen3-0.6b")  # and back
        self.assertEqual(json.loads((live / "search" / "manifest.json").read_text())["model"], "qwen3-embedding:0.6b")
        self.assertEqual(json.loads((live / "profile.json").read_text())["name"], "qwen3-0.6b")

    def test_unbuilt_profile_refuses_and_changes_nothing(self):
        live = self.vault / ".planner"
        self.make_index(live, "search", "qwen3-embedding:0.6b", 1024)
        with self.assertRaises(profiles.ProfileError) as e:
            profiles.use(self.cfg(), "qwen3-4b")
        self.assertIn("planner profile build qwen3-4b", str(e.exception))
        self.assertTrue((live / "search" / "manifest.json").exists())
        self.assertFalse((live / "profile.json").exists())

    def test_profile_with_wrong_model_refuses(self):
        live = self.vault / ".planner"
        self.make_index(live, "search", "qwen3-embedding:0.6b", 1024)
        self.make_index(live / "profiles" / "qwen3-4b", "search", "qwen3-embedding:0.6b", 1024)
        with self.assertRaises(profiles.ProfileError):
            profiles.use(self.cfg(), "qwen3-4b")

    def test_notes_only_in_live_is_kept_with_its_profile(self):
        # the Obsidian-only setup has no notes index: only search moves
        live = self.vault / ".planner"
        self.make_index(live, "search", "qwen3-embedding:0.6b", 1024)
        self.make_index(live / "profiles" / "qwen3-4b", "search", "qwen3-embedding:4b-q8_0", 2560)
        profiles.use(self.cfg(), "qwen3-4b")
        self.assertFalse((live / "notes").exists())
        self.assertTrue((live / "profiles" / "qwen3-0.6b" / "search" / "manifest.json").exists())

    def test_use_active_is_noop(self):
        live = self.vault / ".planner"
        self.make_index(live, "search", "qwen3-embedding:0.6b", 1024)
        self.assertIn("already", profiles.use(self.cfg(), "qwen3-0.6b"))


class TestStatus(ProfileTestCase):
    def test_status_lists_every_profile(self):
        live = self.vault / ".planner"
        self.make_index(live, "search", "qwen3-embedding:0.6b", 1024)
        self.make_index(live / "profiles" / "qwen3-4b", "search", "qwen3-embedding:4b-q8_0", 2560)
        rows = {r["name"]: r for r in profiles.status(self.cfg())}
        self.assertEqual(set(rows), {"qwen3-0.6b", "qwen3-4b", "pplx-v2-late"})
        self.assertTrue(rows["qwen3-0.6b"]["active"])
        self.assertTrue(rows["qwen3-4b"]["built"]["search"])
        self.assertFalse(rows["pplx-v2-late"]["built"]["search"])


if __name__ == "__main__":
    unittest.main()
