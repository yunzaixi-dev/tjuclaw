#!/usr/bin/env python3
"""Bounded, resumable local PaddleOCR batch runner; never starts more than one model."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def backfill_module():
    spec = importlib.util.spec_from_file_location("ocr_backfill", HERE / "ocr-backfill.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def page_count(path: Path) -> int | None:
    try:
        result = subprocess.run(
            ["pdfinfo", str(path)], capture_output=True, text=True, timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r"^Pages:\s+(\d+)\s*$", result.stdout, re.M)
    return int(match.group(1)) if result.returncode == 0 and match else None


def attempted(log: Path) -> set[str]:
    if not log.exists():
        return set()
    paths: set[str] = set()
    for line in log.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == "batch_attempt" and isinstance(event.get("source_path"), str):
            paths.add(event["source_path"])
    return paths


def failed_paths(log: Path) -> set[str]:
    if not log.exists():
        return set()
    paths: set[str] = set()
    for line in log.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == "batch_failed" and isinstance(event.get("source_path"), str):
            paths.add(event["source_path"])
    return paths


def select(raw: Path, staging: Path, log: Path, max_pages: int, max_bytes: int,
           all_supported: bool = False, retry_failed: bool = False,
           retry_log: Path | None = None):
    ocr = backfill_module()
    seen = attempted(log)
    # A retry worker commonly has its own checkpoint log. Read failures from
    # the source run explicitly so an empty retry log cannot cause a silent
    # no-op after the primary batch finishes.
    failure_log = retry_log or log
    retry = failed_paths(failure_log) if retry_failed else set()
    choices = []
    for path, _, sha, relative_output in ocr.discover(raw, None):
        suffix = path.suffix.lower()
        if path.stat().st_size > max_bytes or ocr.is_appledouble(path):
            continue
        if not all_supported and suffix != ".pdf":
            continue
        if all_supported and suffix not in ocr.OCR_SUFFIXES | ocr.OFFICE_SUFFIXES | ocr.TEXT_SUFFIXES:
            if suffix or not ocr.looks_like_utf8_text(path):
                continue
        relative = path.relative_to(raw).as_posix()
        if retry_failed and relative not in retry:
            continue
        if (relative in seen and relative not in retry) or ocr.staged_with_provenance(
            staging / relative_output, relative, sha
        ):
            continue
        if suffix == ".pdf":
            pages = page_count(path)
            if pages is not None and pages > max_pages:
                continue
            priority = pages if pages is not None and pages > 0 else max_pages + 1
        elif suffix in ocr.TEXT_SUFFIXES or not suffix:
            priority = 0
        elif suffix in ocr.OCR_SUFFIXES:
            priority = 1
        else:
            priority = 2
        choices.append((priority, path.stat().st_size, relative))
    return sorted(choices)


def emit(log, event: dict) -> None:
    line = json.dumps(event, ensure_ascii=False)
    log.write(line + "\n")
    log.flush()
    print(line, flush=True)


def run_group(args, relatives: list[str], log) -> int:
    with tempfile.TemporaryDirectory(prefix="ocr-input-") as work:
        worklist = Path(work) / "input.txt"
        worklist.write_text("\n".join(relatives) + "\n", encoding="utf-8")
        command = [
            str(args.python), str(HERE / "ocr-backfill.py"),
            "--raw-repo", str(args.raw_repo), "--staging", str(args.staging),
            "--input-list", str(worklist),
            "--preserve-valid-stage", "--max-pixels", str(args.max_pixels),
            "--page-batch-size", "1", "--document-timeout-seconds", str(args.timeout),
        ]
        available_cpus = sorted(os.sched_getaffinity(0))
        command = ["taskset", "-c", ",".join(map(str, available_cpus[:args.cpu_cores]))] + command
        environment = dict(os.environ, OMP_NUM_THREADS="2", MKL_NUM_THREADS="2",
                           OPENBLAS_NUM_THREADS="2", PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="True")
        for relative in relatives:
            emit(log, {"event": "batch_attempt", "source_path": relative, "max_pixels": args.max_pixels})
        started = time.monotonic()
        # A C/CUDA call need not honor SIGALRM: terminate the whole process group
        # before starting another document. Capture model output to a private log.
        with args.worker_log.open("a", encoding="utf-8") as worker_log:
            worker_log.write(f"\n=== batch {len(relatives)} ===\n")
            worker_log.write("\n".join(f"--- {relative} ---" for relative in relatives) + "\n")
            worker_log.flush()
            proc = subprocess.Popen(
                command, stdout=worker_log, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=environment, start_new_session=True,
            )
            try:
                exit_code = proc.wait(timeout=args.timeout * len(relatives) + 60)
                reason = "exit"
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                exit_code, reason = proc.returncode, "hard_timeout"
        ocr = backfill_module()
        completed = 0
        elapsed = round(time.monotonic() - started, 2)
        for relative in relatives:
            source = args.raw_repo / relative
            parsed = ocr.parse_raw_path(args.raw_repo, source)
            assert parsed
            _, sha, output = parsed
            valid = ocr.staged_with_provenance(args.staging / output, relative, sha)
            # A multi-document backfill returns 1 if any member failed. Verify
            # each output independently so earlier successful members remain
            # complete when a later member times out.
            ok = valid
            emit(log, {
                "event": "batch_complete" if ok else "batch_failed",
                "source_path": relative, "exit_code": exit_code, "reason": reason,
                "seconds": elapsed, "verified": valid,
            })
            completed += ok
        return completed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--max-bytes", type=int, default=2_000_000)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--max-pixels", type=int, default=940800)
    parser.add_argument("--cpu-cores", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=1,
                        help="Documents per model process; use 4-8 for short homogeneous files.")
    parser.add_argument("--all-supported", action="store_true",
                        help="Include PDF, image, Office, and text attachments instead of only PDFs.")
    parser.add_argument("--retry-failed", action="store_true",
                        help="Select previously failed files instead of new files.")
    parser.add_argument("--retry-log", type=Path,
                        help="Read failed source paths from this checkpoint log.")
    parser.add_argument("--wait-for-unit",
                        help="Wait for another user systemd OCR unit to stop before selecting work.")
    args = parser.parse_args(argv)
    if min(args.limit, args.max_pages, args.max_bytes, args.timeout, args.cpu_cores, args.batch_size) < 1:
        parser.error("limit, page/byte/CPU/batch caps and timeout must be positive")
    if args.wait_for_unit and not re.fullmatch(r"tjuclaw-ocr-[a-z0-9-]+", args.wait_for_unit):
        parser.error("--wait-for-unit must name a TJUClaw OCR unit")
    if args.wait_for_unit:
        while subprocess.run(["systemctl", "--user", "is-active", "--quiet", args.wait_for_unit],
                             check=False).returncode == 0:
            time.sleep(5)
    args.raw_repo = args.raw_repo.resolve()
    args.staging = args.staging.resolve()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    args.worker_log = args.state_dir / "worker.log"
    log_path = args.state_dir / "batch.jsonl"
    choices = select(args.raw_repo, args.staging, log_path, args.max_pages, args.max_bytes,
                     args.all_supported, args.retry_failed, args.retry_log)
    with log_path.open("a", encoding="utf-8") as log:
        emit(log, {"event": "batch_plan", "eligible": len(choices), "limit": args.limit})
        complete = 0
        selected = [relative for _, _, relative in choices[:args.limit]]
        for offset in range(0, len(selected), args.batch_size):
            complete += run_group(args, selected[offset:offset + args.batch_size], log)
        emit(log, {"event": "batch_summary", "attempted": min(len(choices), args.limit), "completed": complete})
    return 0 if complete == min(len(choices), args.limit) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
