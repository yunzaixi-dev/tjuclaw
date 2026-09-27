#!/usr/bin/env python3
"""Continue medium public-PDF OCR after the first bounded Colab L4 run."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def load_batch():
    spec = importlib.util.spec_from_file_location("ocr_colab_batch", HERE / "ocr-colab-batch.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_balance(output: str) -> float:
    match = re.search(r"^Current balance:\s*([\d.]+) compute units\s*$", output, re.M)
    if not match:
        raise ValueError("colab_balance_unavailable")
    return float(match.group(1))


def low_success_rate(log_path: Path) -> bool:
    if not log_path.is_file():
        return False
    results: list[bool] = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == "cloud_imported":
            results.append(True)
        elif event.get("event") == "cloud_failed":
            results.append(False)
        # A failed remote batch has no per-document result. Counting its
        # members as bad OCR makes an infrastructure error permanently block
        # otherwise successful documents from the next bounded run.
    recent = results[-6:]
    return len(recent) == 6 and sum(recent) < 3


def needs_one_document_pilot(log_path: Path) -> bool:
    if not log_path.is_file():
        return False
    for line in reversed(log_path.read_text(encoding="utf-8").splitlines()):
        try:
            event = json.loads(line).get("event")
        except (ValueError, AttributeError):
            continue
        if event in {"cloud_batch_failed", "cloud_imported", "cloud_failed"}:
            return event == "cloud_batch_failed"
    return False


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wait-for-unit")
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--prepared-dir", type=Path)
    parser.add_argument("--session", default="tjuclaw-ocr")
    parser.add_argument("--minimum-balance", type=float, default=25.0)
    parser.add_argument("--gpu", choices=("L4", "A100"), default="L4")
    parser.add_argument("--min-pages", type=int, default=5)
    parser.add_argument("--max-pages", type=int, default=30)
    parser.add_argument("--limit", type=int, default=24)
    parser.add_argument("--document-timeout-seconds", type=int, default=1200)
    parser.add_argument("--backend", choices=("native", "vllm-server"), default="native")
    parser.add_argument("--repetition-penalty", type=float, default=1.0)
    args = parser.parse_args(argv)
    if (not 1 <= args.min_pages <= args.max_pages or args.limit < 0
            or not 600 <= args.document_timeout_seconds <= 1200
            or args.minimum_balance < 25 or not 1.0 <= args.repetition_penalty <= 1.5):
        parser.error("invalid continuation bounds")
    if args.wait_for_unit and not re.fullmatch(
            r"tjuclaw-(?:ocr-)?colab-[a-z0-9-]+\.service", args.wait_for_unit):
        parser.error("invalid unit name")
    while args.wait_for_unit and subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", args.wait_for_unit],
        check=False,
    ).returncode == 0:
        time.sleep(30)
    if args.wait_for_unit:
        time.sleep(10)

    log_path = args.state_dir / "batch.jsonl"
    if low_success_rate(log_path):
        print('{"event":"colab_follow_deferred","reason":"low_success_rate"}', flush=True)
        return 1
    run_limit = 1 if needs_one_document_pilot(log_path) else args.limit
    if run_limit != args.limit:
        print('{"event":"colab_follow_limited","reason":"previous_batch_failed","limit":1}', flush=True)
    batch = load_batch()
    balance = parse_balance(batch.command(["usage"], timeout=40))
    if balance < args.minimum_balance:
        print('{"event":"colab_follow_deferred","reason":"insufficient_balance"}', flush=True)
        return 1
    batch.command(["new", "-s", args.session, "--gpu", args.gpu], timeout=120)
    try:
        batch.command(
            ["upload", "-s", args.session, str(HERE / "ocr-backfill.py"),
             "/content/ocr-backfill.py"], timeout=90,
        )
        invocation = [
                sys.executable, str(HERE / "ocr-colab-batch.py"),
                "--raw-repo", str(args.raw_repo),
                "--staging", str(args.staging),
                "--state-dir", str(args.state_dir),
                "--session", args.session,
                "--batch-size", "4", "--limit", str(run_limit),
                "--min-pages", str(args.min_pages), "--max-pages", str(args.max_pages),
                "--document-timeout-seconds", str(args.document_timeout_seconds),
                "--minimum-balance", str(args.minimum_balance),
                "--backend", args.backend,
                "--repetition-penalty", str(args.repetition_penalty),
                "--skip-known-failures",
            ]
        if args.prepared_dir:
            invocation.extend(["--prepared-dir", str(args.prepared_dir)])
        completed = subprocess.run(
            invocation,
            cwd=ROOT, check=False,
        )
        return completed.returncode
    finally:
        try:
            batch.command(["stop", "-s", args.session], timeout=90)
        except (RuntimeError, subprocess.TimeoutExpired):
            print('{"event":"colab_follow_stop_failed"}', flush=True)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
