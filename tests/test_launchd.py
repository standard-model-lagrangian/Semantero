import os
import plistlib
import shutil
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).parent.parent
INSTALLER = REPO / "bin" / "install-launchd.sh"
TEMPLATES = sorted((REPO / "launchd").glob("*.plist"))
PLACEHOLDERS = ("__REPO__", "__HOME__", "__ZOTERO__")


class TestLaunchdTemplates(unittest.TestCase):
    """The plists in launchd/ are templates that bin/install-launchd.sh fills in for whoever installs them."""

    def test_templates_hold_no_personal_paths(self):
        self.assertTrue(TEMPLATES)
        for path in TEMPLATES:
            text = path.read_text()
            self.assertNotIn("/Users/", text, path.name)
            self.assertIn("__REPO__", text, path.name)

    def test_templates_are_named_after_their_label(self):
        for path in TEMPLATES:
            with open(path, "rb") as f:
                self.assertEqual(plistlib.load(f)["Label"], path.stem)

    @unittest.skipIf(shutil.which("bash") is None, "needs bash")
    def test_print_fills_every_placeholder(self):
        # A path with spaces, a trailing one and sed's special characters, like the owner's checkout.
        home = "/tmp/a home & co|x "
        for path in TEMPLATES:
            out = subprocess.run(
                ["bash", str(INSTALLER), "--print", path.stem, "/tmp/zot dir"],
                capture_output=True, text=True, check=True, env={**os.environ, "HOME": home},
            ).stdout
            for p in PLACEHOLDERS:
                self.assertNotIn(p, out, path.name)
            pl = plistlib.loads(out.encode())
            self.assertEqual(pl["WorkingDirectory"], str(REPO.resolve()), path.name)
            if path.stem == "com.planner.zotero-watch":
                self.assertIn("/tmp/zot dir/zotero.sqlite-wal", pl["WatchPaths"])
            if path.stem == "com.planner.pplxd":
                self.assertTrue(pl["ProgramArguments"][0].startswith(home + "/Library/"))

    @unittest.skipIf(shutil.which("bash") is None, "needs bash")
    def test_unknown_label_fails(self):
        r = subprocess.run(["bash", str(INSTALLER), "--print", "com.planner.nope"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("com.planner.nope", r.stderr)


if __name__ == "__main__":
    unittest.main()
