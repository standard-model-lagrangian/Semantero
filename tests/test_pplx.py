"""The pplx-embed-v2-late profile: the stdlib client (planner/pplx.py), the backend dispatch in the builders, and the
service (planner/pplxd.py: encoder pipeline, token cache, MaxSim, row mapping, HTTP). The service tests need numpy and
run under the pplxd venv (`make test-pplx`); in the main venv they are skipped."""
import array
import base64
import json
import plistlib
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from planner import embed, notesindex, pplx
from planner.config import Config

try:
    import numpy as np
    from planner import pplxd
except ImportError:  # main venv: numpy is only in the pplxd venv
    np = None

VAULT_FIXTURE = Path(__file__).parent / "fixtures" / "notes" / "vault_small"


def serve(handler_cls):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


class TestClient(unittest.TestCase):
    def test_row_key_is_sha256_of_the_vector_bytes(self):
        v = array.array("f", [0.5] * 128).tobytes()
        self.assertEqual(len(pplx.row_key(v)), 32)
        self.assertEqual(pplx.row_key(v), pplx.row_key(bytes(v)))
        self.assertNotEqual(pplx.row_key(v), pplx.row_key(array.array("f", [0.25] * 128).tobytes()))

    def test_cache_dir_is_per_model_and_vault_and_outside_it(self):
        a = pplx.cache_dir("m@1", Path("/tmp/vault-a"))
        self.assertNotEqual(a, pplx.cache_dir("m@1", Path("/tmp/vault-b")))
        self.assertNotEqual(a, pplx.cache_dir("m@2", Path("/tmp/vault-a")))
        self.assertNotIn("vault-a", str(a))
        self.assertTrue(str(a).startswith(str(pplx.SEMANTERO_SUPPORT)))

    def test_embed_documents_batches_and_checks_dims(self):
        seen = []

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, body["texts"]))
                out = json.dumps({"vectors": [[float(len(t))] * 4 for t in body["texts"]]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        srv, url = serve(H)
        try:
            vecs = pplx.embed_documents(["a", "bb", "ccc"], url, dims=4, batch_size=2)
            self.assertEqual([v[0] for v in vecs], [1.0, 2.0, 3.0])
            self.assertEqual([p for p, _ in seen], ["/encode", "/encode"])
            self.assertEqual([t for _, t in seen], [["a", "bb"], ["ccc"]])
            with self.assertRaises(ValueError):
                pplx.embed_documents(["a"], url, dims=128)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_embed_documents_raises_when_service_is_down(self):
        with self.assertRaises(OSError):
            pplx.embed_documents(["a"], "http://127.0.0.1:9", max_retries=0, timeout=1)

    def test_embed_dispatches_on_backend(self):
        with patch.object(pplx, "embed_documents", return_value=[[1.0] * 128]) as ed:
            out = embed.embed(["x"], model="pplx-embed-v2-late-0.6b@7bba8e7", dims=128, backend="pplx",
                              pplx_url="http://127.0.0.1:11435", batch_size=16)
        self.assertEqual(out, [[1.0] * 128])
        ed.assert_called_once_with(["x"], "http://127.0.0.1:11435", dims=128, batch_size=16)


class TestManifestBackend(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self.tmp.name) / "vault"
        shutil.copytree(VAULT_FIXTURE, self.vault)
        (self.vault / ".planner" / "search").mkdir(parents=True)
        (self.vault / ".planner" / "search" / "papers.json").write_text("[]")
        (self.vault / ".planner" / "search" / "manifest.json").write_text(json.dumps({"content_hash": "abc"}))

    def tearDown(self):
        self.tmp.cleanup()

    def cfg(self, search):
        return Config(vault=self.vault, daily_dir=self.vault, data_dir=self.vault / ".planner", search=search, notes={})

    def fake(self, texts, **k):
        return [[1.0] + [0.0] * (k["dims"] - 1) for _ in texts]

    def test_pplx_index_records_backend(self):
        notesindex.build_index(self.cfg({"model": "pplx-x", "dims": 4, "backend": "pplx"}), embed_fn=self.fake)
        m = json.loads((self.vault / ".planner" / "notes" / "manifest.json").read_text())
        self.assertEqual(m["backend"], "pplx")
        self.assertEqual(m["backend_url"], "http://127.0.0.1:11435")

    def test_ollama_index_has_no_backend_field(self):
        notesindex.build_index(self.cfg({"model": "qwen3-embedding:0.6b", "dims": 4}), embed_fn=self.fake)
        m = json.loads((self.vault / ".planner" / "notes" / "manifest.json").read_text())
        self.assertNotIn("backend", m)


class TestDoctor(unittest.TestCase):
    def cfg(self):
        v = Path(tempfile.mkdtemp())
        return Config(vault=v, daily_dir=v, data_dir=v / ".planner", search={"model": "pplx-x", "dims": 128, "backend": "pplx", "pplx_url": "http://127.0.0.1:9"}, notes={})

    @patch("shutil.which", return_value="/opt/homebrew/bin/pdftotext")
    def test_pplx_profile_checks_the_service_not_ollama(self, _):
        from planner import health
        with patch("subprocess.run") as run, patch.object(pplx, "health", return_value=None):
            res = health.check_search_tools(self.cfg())
            run.assert_not_called()
        self.assertFalse(res.ok)
        self.assertIn("pplx/install-service.sh", res.message)
        with patch.object(pplx, "health", return_value={"ok": True, "model": "pplx-x"}):
            self.assertIsNone(health.check_search_tools(self.cfg()))
        with patch.object(pplx, "health", return_value={"ok": True, "model": "pplx-y"}):
            self.assertIn("pplx-y", health.check_search_tools(self.cfg()).message)


class TestLaunchdJob(unittest.TestCase):
    def test_service_is_not_throttled_as_background(self):
        # It answers queries as the owner types; as a Background job macOS kept it on efficiency cores with throttled
        # I/O and a query took ~2 s instead of ~0.25 s, past the app's 3 s timeout once requests overlapped.
        with open(Path(__file__).parent.parent / "launchd" / "com.planner.pplxd.plist", "rb") as f:
            pl = plistlib.load(f)
        self.assertEqual(pl["Label"], "com.planner.pplxd")
        self.assertEqual(pl.get("ProcessType"), "Interactive")


@unittest.skipIf(np is None, "numpy not installed (run: make test-pplx)")
class ServiceCase(unittest.TestCase):
    HEAD = {"hidden": 8, "dims": 4, "query_prefix_id": 1, "document_prefix_id": 2, "skiplist_ids": [3],
            "skiplist_tasks": ["document"], "query_length": 6, "document_length": 6}

    class FakeLlama:
        """Token id = 3 for ',' else 10 + word length; hidden state = a fixed random vector per id + position bias."""

        def __init__(self):
            self.table = np.random.default_rng(1).standard_normal((64, 8)).astype(np.float32)
            self.calls = 0
            self.proc = None

        def tokenize(self, text):
            return [3 if w == "," else 10 + len(w) for w in text.replace(",", " , ").split()]

        def hidden(self, id_lists):
            self.calls += 1
            return [self.table[np.asarray(ids)] + 0.01 * np.arange(len(ids))[:, None] for ids in id_lists]

    def setUp(self):
        self.proj = np.random.default_rng(2).standard_normal((4, 8)).astype(np.float32)
        self.llama = self.FakeLlama()
        self.enc = pplxd.Encoder(self.HEAD, self.proj, self.llama)
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestEncoder(ServiceCase):
    def test_document_pipeline_prefix_projection_skiplist_normalise(self):
        (v,) = self.enc.encode(["ab , cde"], "document")
        ids = [2, 12, 3, 13]
        h = self.llama.table[np.asarray(ids)] + 0.01 * np.arange(4)[:, None]
        want = h @ self.proj.T
        want = want[[0, 1, 3]]  # ',' (id 3) dropped for documents
        want /= np.linalg.norm(want, axis=1, keepdims=True)
        np.testing.assert_allclose(v, want, rtol=1e-5)

    def test_query_keeps_skiplist_tokens_and_uses_query_prefix(self):
        (v,) = self.enc.encode(["ab , cde"], "query")
        self.assertEqual(len(v), 4)
        h = self.llama.table[np.asarray([1, 12, 3, 13])] + 0.01 * np.arange(4)[:, None]
        w = h @ self.proj.T
        np.testing.assert_allclose(v[0], w[0] / np.linalg.norm(w[0]), rtol=1e-5)

    def test_truncates_to_model_length_including_prefix(self):
        (v,) = self.enc.encode(["a b c d e f g h"], "query")
        self.assertEqual(len(v), 6)

    def test_empty_text_is_the_prefix_alone(self):
        (v,) = self.enc.encode([""], "document")
        self.assertEqual(v.shape, (1, 4))


class TestParity(ServiceCase):
    """pplx/convert/parity.py checks the service's own Encoder (not a copy of it) against a reference encoding."""

    def setUp(self):
        super().setUp()
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "parity", Path(__file__).resolve().parent.parent / "pplx" / "convert" / "parity.py")
        self.parity = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.parity)
        self.texts = {"documents": ["ab , cde", "a bb ccc", "dddd , e"], "queries": ["ab cde", "dddd e"]}

    def reference(self, noise: float = 0.0) -> dict:
        """What sentence-transformers would give: every token's vector (skiplist ones too) and the keep mask."""
        rng = np.random.default_rng(3)
        ref = {}
        for key, kind in (("documents", "document"), ("queries", "query")):
            ref[key] = []
            for ids in self.enc.token_ids(self.texts[key], kind):
                h = self.llama.table[np.asarray(ids)] + 0.01 * np.arange(len(ids))[:, None]
                v = h @ self.proj.T + noise * rng.standard_normal((len(ids), 4))
                mask = [not (kind == "document" and i in self.HEAD["skiplist_ids"]) for i in ids]
                ref[key].append({"ids": ids, "vecs": v.tolist(), "mask": mask})
        return ref

    def test_the_services_encoder_matches_its_own_reference(self):
        checks, problems, _ = self.parity.compare(self.enc, self.texts, self.reference(), q8=False)
        self.assertEqual(problems, [])
        self.assertTrue(all(ok for _, _, ok in checks), checks)

    def test_a_drifted_encoder_fails(self):
        checks, _, _ = self.parity.compare(self.enc, self.texts, self.reference(noise=1.0), q8=False)
        self.assertFalse(all(ok for _, _, ok in checks))


class TestLlamaRequests(ServiceCase):
    def test_hidden_states_requested_a_few_texts_at_a_time_in_order(self):
        llama = pplxd.Llama.__new__(pplxd.Llama)
        sent = []

        def post(path, body):
            sent.append(len(body["content"]))
            # llama-server may answer out of order; each row carries its index
            return [{"index": i, "embedding": [[float(ids[0])]]} for i, ids in reversed(list(enumerate(body["content"])))]

        llama._post = post
        out = llama.hidden([[n] for n in range(10)])
        self.assertEqual(sent, [pplxd.HIDDEN_GROUP] * 2 + [10 - 2 * pplxd.HIDDEN_GROUP])
        self.assertEqual([float(v[0][0]) for v in out], [float(n) for n in range(10)])


class TestTokenCache(ServiceCase):
    def test_add_dedupe_reopen(self):
        c = pplxd.TokenCache(self.tmp / "c", dims=4)
        a = np.ones((3, 4), np.float32) / 2
        c.add(b"k" * 32, a)
        c.add(b"k" * 32, a)  # same key: stored once
        c.add(b"j" * 32, np.zeros((2, 4), np.float32))
        self.assertEqual((len(c), c.end), (2, 5))
        c2 = pplxd.TokenCache(self.tmp / "c", dims=4)
        self.assertEqual(c2.index, {b"k" * 32: 0, b"j" * 32: 1})
        toks, starts, counts, _ = c2.view()
        np.testing.assert_allclose(toks[0:3], a)
        self.assertEqual(starts.tolist(), [0, 3])

    def test_crash_leftovers_are_trimmed(self):
        c = pplxd.TokenCache(self.tmp / "c", dims=4)
        c.add(b"k" * 32, np.ones((3, 4), np.float32))
        with open(self.tmp / "c" / "tokens.f16", "ab") as f:
            f.write(b"\0" * 4 * 2 * 5)  # tokens written, key never was
        with open(self.tmp / "c" / "keys.bin", "ab") as f:
            f.write(b"partial")
        c2 = pplxd.TokenCache(self.tmp / "c", dims=4)
        self.assertEqual((len(c2), c2.end), (1, 3))
        self.assertEqual((self.tmp / "c" / "tokens.f16").stat().st_size, 3 * 4 * 2)
        c2.add(b"j" * 32, np.ones((1, 4), np.float32))
        self.assertEqual(pplxd.TokenCache(self.tmp / "c", dims=4).starts, [0, 3])


class TestMaxSim(ServiceCase):
    def test_matches_naive_maxsim_with_and_without_threads(self):
        rng = np.random.default_rng(3)
        c = pplxd.TokenCache(self.tmp / "c", dims=4)
        segs = []
        for i in range(40):
            t = rng.standard_normal((int(rng.integers(1, 9)), 4)).astype(np.float32)
            t /= np.linalg.norm(t, axis=1, keepdims=True)
            c.add(bytes([i]) * 32, t)
            segs.append(t.astype(np.float16).astype(np.float32))
        q = rng.standard_normal((5, 4)).astype(np.float32)
        want = np.array([(q @ s.T).max(axis=1).sum() for s in segs])
        with patch.object(pplxd, "BLOCK_TOKENS", 16):  # many blocks
            c._view = None
            np.testing.assert_allclose(pplxd.maxsim_segments(c.view(), q), want, rtol=1e-5)
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(3) as pool:
                np.testing.assert_allclose(pplxd.maxsim_segments(c.view(), q, pool), want, rtol=1e-5)


class TestService(ServiceCase):
    def make(self, model="pplx-test"):
        vault = self.tmp / "vault"
        (vault / ".planner").mkdir(parents=True)
        cfg = Config(vault=vault, daily_dir=vault, data_dir=vault / ".planner", search={}, notes={})
        with patch.object(pplxd, "cache_dir", return_value=self.tmp / "cache"):
            svc = pplxd.Service(cfg, model, llama=self.llama, encoder=self.enc)
        return cfg, svc

    def write_index(self, cfg, corpus, vectors, model="pplx-test", content_hash="h1"):
        d = cfg.data_dir / corpus
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps({"model": model, "dims": 4, "content_hash": content_hash}))
        a = array.array("f")
        for v in vectors:
            a.extend(v)
        (d / "vectors.f32").write_bytes(a.tobytes())

    def scores(self, res, corpus):
        return np.frombuffer(base64.b64decode(res["corpora"][corpus]["scores"]), dtype="<f4")

    def test_rows_score_by_maxsim_of_their_tokens(self):
        with patch.object(pplxd, "DIMS", 4):
            cfg, svc = self.make()
            texts = ["ab cde", "fghij , k", "lm"]
            means = svc.encode_documents(texts)
            self.write_index(cfg, "search", [means[2], means[0], means[1]])  # row order differs from encode order
            res = svc.rowscores("cde fghij", ["search"])
            got = self.scores(res, "search")
            q = self.enc.encode(["cde fghij"], "query")[0]
            toks = self.enc.encode(texts, "document")
            want = [float((q @ toks[i].astype(np.float16).astype(np.float32).T).max(axis=1).sum()) / len(q) for i in (2, 0, 1)]
            np.testing.assert_allclose(got, want, rtol=1e-4)
            self.assertEqual(res["corpora"]["search"]["content_hash"], "h1")
            self.assertEqual(res["corpora"]["search"]["missing"], 0)

    def test_unknown_rows_score_zero_and_other_models_are_refused(self):
        with patch.object(pplxd, "DIMS", 4):
            cfg, svc = self.make()
            (m,) = svc.encode_documents(["ab cde"])
            self.write_index(cfg, "search", [m, [0.5, 0.5, 0.5, 0.5]])
            self.write_index(cfg, "notes", [m], model="qwen3-embedding:0.6b")
            res = svc.rowscores("cde", ["search", "notes"])
            s = self.scores(res, "search")
            self.assertGreater(s[0], 0)
            self.assertEqual(s[1], 0)
            self.assertEqual(res["corpora"]["search"]["missing"], 1)
            self.assertIn("qwen3-embedding:0.6b", res["corpora"]["notes"]["error"])

    def test_index_rebuild_is_picked_up(self):
        with patch.object(pplxd, "DIMS", 4):
            cfg, svc = self.make()
            a, b = svc.encode_documents(["ab", "cde"])
            self.write_index(cfg, "search", [a], content_hash="h1")
            self.assertEqual(svc.rowscores("ab", ["search"])["corpora"]["search"]["rows"], 1)
            import os
            import time
            self.write_index(cfg, "search", [a, b], content_hash="h2")
            os.utime(cfg.data_dir / "search" / "manifest.json", ns=(time.time_ns() + 10**9,) * 2)
            res = svc.rowscores("ab", ["search"])
            self.assertEqual((res["corpora"]["search"]["rows"], res["corpora"]["search"]["content_hash"]), (2, "h2"))

    def test_http_roundtrip(self):
        with patch.object(pplxd, "DIMS", 4):
            cfg, svc = self.make()
            srv, url = serve(pplxd.make_handler(svc))
            try:
                vecs = pplx.embed_documents(["ab cde", "fg"], url, dims=4)
                self.write_index(cfg, "search", vecs)
                req = urllib.request.Request(url + "/rowscores", json.dumps({"text": "ab", "corpora": ["search"]}).encode(),
                                             {"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as r:
                    res = json.loads(r.read())
                self.assertEqual(len(self.scores(res, "search")), 2)
                self.assertEqual(pplx.health(url)["segments"], 2)
                bad = urllib.request.Request(url + "/rowscores", b"{}", {"Content-Type": "application/json"})
                with self.assertRaises(urllib.error.HTTPError) as e:
                    urllib.request.urlopen(bad)
                self.assertEqual(e.exception.code, 500)
            finally:
                srv.shutdown()
                srv.server_close()


if __name__ == "__main__":
    unittest.main()
