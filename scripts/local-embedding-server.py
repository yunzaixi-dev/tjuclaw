#!/usr/bin/env python3
"""Small authenticated, local OpenAI-compatible endpoint for WeKnora embeddings."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import math
from pathlib import Path
import threading

MODEL = "BAAI/bge-small-zh-v1.5"
DIMENSIONS = 512
MAX_REQUEST_BYTES = 1024 * 1024
MAX_BATCH = 64
MAX_TEXT_CHARS = 16000
MAX_INFLIGHT = 66
WAIT_TIMEOUT_SECONDS = 50


def create_handler(model, api_key: str):
    concurrency = threading.BoundedSemaphore(2)
    inflight = threading.BoundedSemaphore(MAX_INFLIGHT)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Do not log URLs, headers, private document text, or errors.
            pass

        def respond(self, status: int, value: dict):
            payload = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self) -> bool:
            token = self.headers.get("Authorization", "")
            return hmac.compare_digest(token, "Bearer " + api_key)

        def do_GET(self):
            if self.path == "/health":
                self.respond(200, {"status": "ok"})
            elif self.path == "/v1/models" and self.authorized():
                self.respond(200, {"object": "list", "data": [
                    {"id": MODEL, "object": "model", "owned_by": "tjuclaw-local"}
                ]})
            else:
                self.respond(404, {"error": {"code": "not_found"}})

        def do_POST(self):
            if self.path != "/v1/embeddings":
                self.respond(404, {"error": {"code": "not_found"}})
                return
            if not self.authorized():
                self.respond(401, {"error": {"code": "unauthorized"}})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_REQUEST_BYTES:
                    raise ValueError("invalid_size")
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict) or data.get("model") != MODEL:
                    raise ValueError("invalid_model")
                values = data.get("input")
                if isinstance(values, str):
                    values = [values]
                if (not isinstance(values, list) or not 1 <= len(values) <= MAX_BATCH
                        or any(not isinstance(text, str) or not text
                               or len(text) > MAX_TEXT_CHARS for text in values)):
                    raise ValueError("invalid_input")
            except (ValueError, UnicodeError):
                self.respond(400, {"error": {"code": "invalid_request"}})
                return
            if not inflight.acquire(blocking=False):
                self.respond(503, {"error": {"code": "busy"}})
                return
            try:
                if not concurrency.acquire(timeout=WAIT_TIMEOUT_SECONDS):
                    self.respond(503, {"error": {"code": "busy"}})
                    return
                try:
                    vectors = list(model.embed(values, batch_size=min(16, len(values))))
                    if len(vectors) != len(values):
                        raise RuntimeError("invalid_embedding_count")
                    result = []
                    for index, vector in enumerate(vectors):
                        elements = [float(number) for number in vector]
                        if len(elements) != DIMENSIONS or not all(math.isfinite(x) for x in elements):
                            raise RuntimeError("invalid_embedding")
                        result.append({"object": "embedding", "index": index,
                                       "embedding": elements})
                finally:
                    concurrency.release()
            except Exception:
                self.respond(500, {"error": {"code": "embedding_failed"}})
                return
            finally:
                inflight.release()
            self.respond(200, {"object": "list", "data": result, "model": MODEL})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="172.17.0.1")
    parser.add_argument("--port", type=int, default=18182)
    parser.add_argument("--api-key-file", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or args.bind not in {"172.17.0.1", "127.0.0.1"}:
        parser.error("invalid bind or port")
    if args.api_key_file.stat().st_mode & 0o077:
        parser.error("api key file must be owner-only")
    key = args.api_key_file.read_text(encoding="utf-8").strip()
    if len(key) < 32:
        parser.error("invalid api key")
    try:
        kwargs = embedding_kwargs(args.device)
    except RuntimeError as error:
        if str(error) != "cuda_provider_unavailable":
            raise
        print('{"event":"embedding_device_unavailable","device":"cuda"}', flush=True)
        raise SystemExit(1) from None
    from fastembed import TextEmbedding
    model = TextEmbedding(model_name=MODEL, cache_dir=str(args.cache_dir), **kwargs)
    server = ThreadingHTTPServer((args.bind, args.port), create_handler(model, key))
    server.daemon_threads = True
    server.serve_forever()


def cuda_runtime_ready() -> bool:
    import onnxruntime

    preload = getattr(onnxruntime, "preload_dlls", None)
    if callable(preload):
        preload()
    return "CUDAExecutionProvider" in onnxruntime.get_available_providers()


def embedding_kwargs(device: str) -> dict:
    if device == "cpu":
        return {"threads": 4, "cuda": False}
    if device != "cuda":
        raise ValueError("invalid_device")
    if not cuda_runtime_ready():
        raise RuntimeError("cuda_provider_unavailable")
    return {"threads": 4, "cuda": True, "device_ids": [0]}


if __name__ == "__main__":
    main()
