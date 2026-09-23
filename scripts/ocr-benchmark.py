#!/usr/bin/env python3
"""Benchmark the actual OCR pipeline on one approved local public attachment."""

from __future__ import annotations

import argparse
import faulthandler
import importlib.util
import json
import signal
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--max-pixels", type=int, default=940800)
    parser.add_argument("--use-queues", action="store_true")
    parser.add_argument("--vl-rec-backend", choices=("native", "vllm-server"), default="native")
    parser.add_argument("--vl-rec-server-url", default="http://127.0.0.1:8118/v1")
    parser.add_argument("--pipeline-device", choices=("cpu", "gpu:0"), default="gpu:0")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    faulthandler.register(signal.SIGUSR1)
    if not 940800 <= args.max_pixels <= 3763200:
        parser.error("invalid max-pixels")
    if args.vl_rec_backend == "vllm-server" and args.vl_rec_server_url not in (
        "http://127.0.0.1:8118/v1", "http://localhost:8118/v1"
    ):
        parser.error("invalid local inference service")
    source = Path(__file__).with_name("ocr-backfill.py")
    spec = importlib.util.spec_from_file_location("ocr_backfill", source)
    assert spec and spec.loader
    ocr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ocr)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    print(json.dumps({"phase": "loading"}), flush=True)
    pipeline = ocr.create_pipeline(args.use_queues, args.vl_rec_backend, args.vl_rec_server_url,
                                   device=args.pipeline_device)
    loaded = time.perf_counter()
    print(json.dumps({"phase": "predicting", "load_seconds": round(loaded - started, 3)}), flush=True)
    text, pages = ocr.run_ocr(pipeline, args.input, args.output, args.max_pixels)
    completed = time.perf_counter()
    args.output.write_text(text + "\n", encoding="utf-8")
    import paddle

    try:
        peak_mib = round(paddle.device.cuda.max_memory_reserved("gpu:0") / (1024 * 1024))
    except (AttributeError, RuntimeError, ValueError):
        peak_mib = None
    print(json.dumps({
        "pages": pages,
        "characters": len(text),
        "max_pixels": args.max_pixels,
        "use_queues": args.use_queues,
        "vl_rec_backend": args.vl_rec_backend,
        "pipeline_device": args.pipeline_device,
        "load_seconds": round(loaded - started, 3),
        "ocr_seconds": round(completed - loaded, 3),
        "paddle_reserved_peak_mib": peak_mib,
    }))


if __name__ == "__main__":
    main()
