import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "local_embedding_server", Path(__file__).with_name("local-embedding-server.py")
)
assert SPEC and SPEC.loader
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class SyntheticModel:
    def embed(self, texts, batch_size):
        for _ in texts:
            yield [0.0] * SERVER.DIMENSIONS


class EmbeddingServerTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), SERVER.create_handler(SyntheticModel(), "synthetic-token")
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def request(self, payload, token="synthetic-token"):
        request = urllib.request.Request(
            self.url + "/v1/embeddings",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def test_embeds_in_order_without_echoing_input(self):
        result = self.request({"model": SERVER.MODEL, "input": ["synthetic one", "synthetic two"]})
        self.assertEqual([row["index"] for row in result["data"]], [0, 1])
        self.assertEqual(len(result["data"][0]["embedding"]), 512)
        self.assertNotIn("synthetic one", json.dumps(result))

    def test_rejects_bad_token_and_unbounded_requests(self):
        with self.assertRaises(urllib.error.HTTPError) as exc:
            self.request({"model": SERVER.MODEL, "input": "test"}, token="incorrect")
        self.assertEqual(exc.exception.code, 401)
        exc.exception.close()
        for value in ([], ["x"] * 65, ["x" * 16001]):
            with self.subTest(input_length=len(value)):
                with self.assertRaises(urllib.error.HTTPError) as exc:
                    self.request({"model": SERVER.MODEL, "input": value})
                self.assertEqual(exc.exception.code, 400)
                exc.exception.close()

    def test_public_health_does_not_expose_secret(self):
        with urllib.request.urlopen(self.url + "/health", timeout=3) as response:
            self.assertEqual(json.load(response), {"status": "ok"})
        with self.assertRaises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(self.url + "/v1/models", timeout=3)
        exc.exception.close()

    def test_cuda_device_is_requested_and_cpu_only_runtime_is_refused(self):
        with patch.object(SERVER, "cuda_runtime_ready", return_value=True):
            self.assertEqual(
                SERVER.embedding_kwargs("cuda"),
                {"threads": 4, "cuda": True, "device_ids": [0]},
            )
        with patch.object(SERVER, "cuda_runtime_ready", return_value=False):
            with self.assertRaises(RuntimeError) as exc:
                SERVER.embedding_kwargs("cuda")
        self.assertEqual(str(exc.exception), "cuda_provider_unavailable")
        self.assertEqual(SERVER.embedding_kwargs("cpu"), {"threads": 4, "cuda": False})

    def test_waits_for_occupied_model_instead_of_failing_parallel_import(self):
        entered = threading.Event()
        release = threading.Event()
        lock = threading.Lock()
        started = 0

        class SlowModel:
            def embed(self, texts, batch_size):
                nonlocal started
                with lock:
                    started += 1
                    if started == 2:
                        entered.set()
                if not release.wait(2):
                    raise TimeoutError("synthetic stall")
                for _ in texts:
                    yield [0.0] * SERVER.DIMENSIONS

        self.server.RequestHandlerClass = SERVER.create_handler(SlowModel(), "synthetic-token")
        payload = {"model": SERVER.MODEL, "input": "synthetic"}
        with ThreadPoolExecutor(max_workers=3) as pool:
            pending = [pool.submit(self.request, payload) for _ in range(2)]
            self.assertTrue(entered.wait(2))
            third = pool.submit(self.request, payload)
            time.sleep(0.1)
            self.assertFalse(third.done())
            release.set()
            for future in [*pending, third]:
                self.assertEqual(len(future.result(timeout=3)["data"]), 1)
