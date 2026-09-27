#!/usr/bin/env python3
"""Resume vetted public PDF OCR on an existing Colab GPU session."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REMOTE = "/content"
MAX_SOURCE_BYTES = 40_000_000
MAX_BATCH_BYTES = 80_000_000
FAILURE_REASONS = {
    "gpu_oom", "generation_loop", "timeout", "conversion", "other", "unknown",
}
SENSITIVE_TITLE = re.compile(r"名册|成绩单|身份证|学生信息|口令|密钥|密码|secret|password|credential", re.I)
SCAN = (
    'import {scanForPii} from "./crawler/src/archive/pii.ts"; '
    'const result=scanForPii(await Bun.stdin.text()); '
    'console.log(JSON.stringify(result.matches));'
)


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def screen_pdf(path: Path, relative: str) -> str | None:
    if SENSITIVE_TITLE.search(relative):
        return "sensitive_title"
    if path.stat().st_size > MAX_SOURCE_BYTES or path.stat().st_size == 0:
        return "size_limit"
    try:
        extracted = subprocess.run(
            ["pdftotext", "-enc", "UTF-8", str(path), "-"],
            capture_output=True, timeout=45, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "text_inspection_failed"
    if extracted.returncode or len(extracted.stdout.strip()) < 100:
        return "uninspectable_text"
    if len(extracted.stdout) > 5_000_000:
        return "text_inspection_limit"
    try:
        scan = subprocess.run(
            ["bun", "-e", SCAN], input=extracted.stdout, capture_output=True,
            cwd=ROOT, timeout=20, check=False,
        )
        matches = json.loads(scan.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return "pii_scan_failed"
    if scan.returncode or not isinstance(matches, list):
        return "pii_scan_failed"
    if matches:
        return "sensitive_content"
    return None


def command(args: list[str], timeout: int) -> str:
    environment = os.environ.copy()
    environment.setdefault("HTTPS_PROXY", "http://127.0.0.1:10808")
    environment.setdefault("HTTP_PROXY", "http://127.0.0.1:10808")
    result = subprocess.run(
        ["/home/yun/.local/bin/colab", *args], capture_output=True, text=True,
        env=environment, cwd=ROOT, timeout=timeout, check=False,
    )
    if result.returncode:
        # Colab can echo supplied paths and runtime output. Never forward it
        # into a public log or a user-facing exception.
        raise RuntimeError(f"colab_{args[0]}_failed:{result.returncode}")
    return result.stdout


def log_event(log, event: str, **fields) -> None:
    line = json.dumps({"event": event, **fields}, ensure_ascii=False)
    log.write(line + "\n")
    log.flush()
    print(line, flush=True)


def sufficient_balance(minimum: float, log) -> bool:
    if minimum == 0:
        return True
    try:
        output = command(["usage"], timeout=50)
        match = re.search(r"^Current balance:\s*([\d.]+) compute units\s*$", output, re.M)
        if not match:
            raise ValueError("balance_unavailable")
        balance = float(match.group(1))
        if balance >= minimum:
            return True
        log_event(log, "cloud_paused", reason="insufficient_balance",
                  balance=balance, minimum=minimum)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired):
        log_event(log, "cloud_paused", reason="balance_unavailable")
    return False


def safe_batch_error(error: Exception) -> str:
    if isinstance(error, subprocess.TimeoutExpired):
        return "command_timeout"
    detail = str(error)
    if isinstance(error, RuntimeError) and (
        detail == "invalid_colab_report"
        or re.fullmatch(r"colab_(?:upload|exec|download)_failed:\d+", detail)
    ):
        return detail
    return type(error).__name__


def known_failures(log_path: Path) -> set[str]:
    failed: set[str] = set()
    if not log_path.is_file():
        return failed
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("event") == "cloud_failed" and event.get("reason") != "report_mismatch":
            failed.add(event["id"])
    return failed


def stage_target_present(staging: Path, output: Path) -> bool:
    """Skip cloud OCR when import would refuse to replace any staged file.

    A Poppler text layer is a valid stage result. It is not Paddle provenance,
    but sending it again only fails at import. Do not read or log the body.
    """
    target = staging / output
    assets = target.with_suffix(".assets")
    try:
        return any((
            target.exists(), target.is_symlink(),
            assets.exists(), assets.is_symlink(),
        ))
    except OSError:
        return True


def candidates(raw: Path, staging: Path, backfill) -> list[tuple[str, Path, int]]:
    found = []
    for path, source, _digest, output in backfill.discover(raw, "public-course-sharing"):
        if source != "public-course-sharing" or path.suffix.lower() != ".pdf":
            continue
        relative = path.relative_to(raw).as_posix()
        if stage_target_present(staging, output):
            continue
        if path.is_symlink() or backfill.is_lfs_pointer(path):
            continue
        found.append((relative, path, path.stat().st_size))
    return sorted(found, key=lambda item: (page_count(item[1]), item[2]))


def prepared_candidates(raw: Path, staging: Path, cache: Path, backfill):
    office = load_module("ocr_office_prepare", "ocr-office-prepare.py")
    found, metadata = [], {}
    for original, _, _digest, output in backfill.discover(raw, "public-course-sharing"):
        if original.suffix.lower() not in backfill.OFFICE_SUFFIXES:
            continue
        relative = original.relative_to(raw).as_posix()
        if stage_target_present(staging, output):
            continue
        record = office.checked_record(cache, relative, original)
        if record is None:
            continue
        pdf = cache / f"{office.identifier(relative)}.pdf"
        found.append((relative, pdf, record["pdf_bytes"]))
        metadata[relative] = record
    return found, metadata


def page_count(path: Path) -> int:
    try:
        info = subprocess.run(
            ["pdfinfo", str(path)], capture_output=True, text=True,
            timeout=8, check=False,
        )
        match = re.search(r"^Pages:\s+(\d+)\s*$", info.stdout, re.M)
        return int(match.group(1)) if info.returncode == 0 and match else 100_000
    except (OSError, subprocess.TimeoutExpired):
        return 100_000


def bundle(path: Path, selected: list[tuple[str, Path, int]],
           prepared: dict[str, dict] | None = None) -> None:
    manifest = []
    with tarfile.open(path, "w:gz") as archive:
        for relative, source, size in selected:
            record = {
                "source": relative,
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "size": size,
            }
            input_path = relative
            if prepared and relative in prepared:
                metadata = prepared[relative]
                if record["sha256"] != metadata["pdf_sha256"]:
                    raise ValueError("prepared_pdf_changed")
                input_path = Path(relative).with_suffix(".pdf").as_posix()
                record.update(input=input_path, original_sha256=metadata["original_sha256"])
            manifest.append(record)
            archive.add(source, arcname=input_path, recursive=False)
        payload = json.dumps(manifest, ensure_ascii=False).encode()
        with tempfile.TemporaryFile() as stream:
            stream.write(payload)
            stream.seek(0)
            metadata = tarfile.TarInfo("manifest.json")
            metadata.size = len(payload)
            archive.addfile(metadata, stream)


def quality_flags(markdown: str) -> list[str]:
    lines = [line.strip() for line in markdown.splitlines() if len(line.strip()) >= 12]
    counts = Counter(lines)
    flags = []
    if len(markdown) > 100_000:
        flags.append("large_output")
    if any(count >= 40 for count in counts.values()):
        flags.append("repeated_lines")
    return flags


def checked_gpu_metrics(value) -> dict | None:
    if not isinstance(value, dict) or value.get("event") != "gpu_metrics":
        return None
    fields = {}
    for key, maximum in (
        ("elapsed_seconds", 100_000), ("samples", 100_000),
        ("average_utilization_percent", 100), ("peak_memory_used_mib", 1_000_000),
    ):
        number = value.get(key)
        if (type(number) not in (int, float) or not math.isfinite(number)
                or not 0 <= number <= maximum):
            return None
        fields[key] = number
    return fields if fields["samples"] > 0 else None


def run_batch(selected, raw: Path, staging: Path, session: str, importer, log,
              document_timeout_seconds: int = 600,
              repetition_penalty: float = 1.0, backend: str = "native",
              prepared: dict[str, dict] | None = None) -> int:
    with tempfile.TemporaryDirectory(prefix="tjuclaw-colab-batch-") as directory:
        local = Path(directory)
        source_archive = local / "input.tar.gz"
        bundle(source_archive, selected, prepared)
        command(["upload", "-s", session, str(source_archive),
                 f"{REMOTE}/tjuclaw-ocr-batch.tar.gz"], timeout=360)
        # Fresh Colab runtimes do not have the pipeline script pre-installed.
        # Upload the exact local version used to prepare and validate this batch.
        command(["upload", "-s", session, str(HERE / "ocr-backfill.py"),
                 f"{REMOTE}/ocr-backfill.py"], timeout=90)
        if backend == "vllm-server":
            command(["upload", "-s", session, str(HERE / "ocr-colab-inference.py"),
                     f"{REMOTE}/ocr-colab-inference.py"], timeout=90)
        timeout = max(680, document_timeout_seconds + 60) * len(selected) + 1400
        if backend == "vllm-server":
            timeout += 3600
        started = time.monotonic()
        command(["exec", "-s", session, "--timeout", str(timeout),
                 "--env", f"TJUCLAW_OCR_DOCUMENT_TIMEOUT_SECONDS={document_timeout_seconds}",
                 "--env", f"TJUCLAW_OCR_REPETITION_PENALTY={repetition_penalty}",
                 "--env", f"TJUCLAW_OCR_BACKEND={backend}",
                 "-f", str(HERE / "ocr-colab-batch-worker.py")], timeout=timeout + 60)
        log_event(log, "cloud_execution_complete", count=len(selected),
                  seconds=round(time.monotonic() - started, 2))
        try:
            metrics_file = local / "metrics.json"
            command(["download", "-s", session, f"{REMOTE}/tjuclaw-ocr-batch-metrics.json",
                     str(metrics_file)], timeout=60)
            metrics = checked_gpu_metrics(json.loads(metrics_file.read_text()))
            if metrics:
                log_event(log, "cloud_inference_metrics", **metrics)
        except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError):
            log_event(log, "cloud_metrics_unavailable")
        report_file = local / "report.json"
        try:
            command(["download", "-s", session, f"{REMOTE}/tjuclaw-ocr-batch-report.json",
                     str(report_file)], timeout=120)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            try:
                metrics = local / "metrics.json"
                command(["download", "-s", session, f"{REMOTE}/tjuclaw-ocr-batch-metrics.json",
                         str(metrics)], timeout=60)
                diagnostic = json.loads(metrics.read_text())
                error_type = diagnostic.get("error_type")
                reason = diagnostic.get("reason")
                if diagnostic.get("event") == "worker_failed":
                    fields = {"error_type": error_type if isinstance(error_type, str)
                              and re.fullmatch(r"[A-Za-z]+Error|TimeoutExpired", error_type)
                              else "unknown"}
                    if isinstance(reason, str) and re.fullmatch(
                            r"(?:vllm_install_failed|vllm_server_failed|ocr_install_failed):-?\d+"
                            r"|vllm_(?:install_timeout|server_start_timeout|port_already_in_use)",
                            reason):
                        fields["reason"] = reason
                    categories = diagnostic.get("dependency_categories")
                    if isinstance(categories, list) and all(
                        isinstance(item, str) and item in {
                            "no_matching_distribution", "dependency_conflict", "build_failed",
                            "disk_full", "unsupported_python", "cuda_missing",
                        } for item in categories
                    ):
                        fields["dependency_categories"] = categories
                    log_event(log, "cloud_worker_failed", **fields)
            except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError):
                log_event(log, "cloud_worker_diagnostic_unavailable")
            raise error
        report = json.loads(report_file.read_text(encoding="utf-8"))
        expected = {hashlib.sha256(relative.encode()).hexdigest(): relative
                    for relative, _, _ in selected}
        if not isinstance(report, list) or len(report) > 8:
            raise RuntimeError("invalid_colab_report")
        rows: dict[str, dict] = {}
        duplicates: set[str] = set()
        invalid = 0
        for item in report:
            if (not isinstance(item, dict) or not {"id", "ok"} <= set(item)
                    or not set(item) <= {"id", "ok", "reason"}
                    or not isinstance(item["id"], str) or item["id"] not in expected
                    or not isinstance(item["ok"], bool)):
                invalid += 1
                continue
            identifier = item["id"]
            if identifier in rows or identifier in duplicates:
                rows.pop(identifier, None)
                duplicates.add(identifier)
                invalid += 1
                continue
            rows[identifier] = item
        missing = len(expected) - len(rows)
        if invalid or missing:
            log_event(log, "cloud_report_partial", count=len(selected),
                      invalid_rows=invalid, missing_rows=missing)
        imported = 0
        for identifier, relative in expected.items():
            item = rows.get(identifier)
            if item is None:
                log_event(log, "cloud_report_missing", id=identifier, reason="report_mismatch")
                continue
            if not item["ok"]:
                reason = item.get("reason")
                log_event(log, "cloud_failed", id=identifier,
                          reason=reason if isinstance(reason, str)
                          and reason in FAILURE_REASONS else "other")
                continue
            result_file = local / (identifier + ".tar.gz")
            try:
                command(["download", "-s", session,
                         f"{REMOTE}/tjuclaw-ocr-batch-results/{identifier}.tar.gz",
                         str(result_file)], timeout=240)
                state = importer.import_result(result_file, relative, raw, staging)
                output = staging / Path(relative).with_suffix(".md")
                flags = quality_flags(output.read_text(encoding="utf-8"))
                log_event(log, "cloud_imported", id=identifier, result=state,
                          quality_flags=flags)
                imported += 1
            except (RuntimeError, ValueError, OSError, KeyError, tarfile.TarError,
                    subprocess.TimeoutExpired) as error:
                log_event(log, "cloud_import_failed", id=identifier,
                          reason=type(error).__name__)
        return len(expected) - imported


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--prepared-dir", type=Path)
    parser.add_argument("--session", default="tjuclaw-ocr")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--min-pages", type=int, default=1)
    parser.add_argument("--max-pages", type=int, default=0)
    parser.add_argument("--only-id", help="Retry the SHA-256 of one raw-repo-relative path")
    parser.add_argument("--document-timeout-seconds", type=int, default=600)
    parser.add_argument("--repetition-penalty", type=float, default=1.0)
    parser.add_argument("--backend", choices=("native", "vllm-server"), default="native")
    parser.add_argument("--dry-run", action="store_true",
                        help="Screen candidates locally without uploading or starting OCR.")
    parser.add_argument("--skip-known-failures", action="store_true")
    parser.add_argument("--stop-session-on-exit", action="store_true")
    parser.add_argument("--minimum-balance", type=float, default=0,
                        help="Check the remaining compute units before each batch; 0 disables it.")
    args = parser.parse_args(argv)
    if (not 1 <= args.batch_size <= 8 or args.limit < 0 or args.min_pages < 1
            or args.max_pages < 0 or 0 < args.max_pages < args.min_pages):
        parser.error("invalid batch, page or limit bounds")
    if args.only_id and not re.fullmatch(r"[a-f0-9]{64}", args.only_id):
        parser.error("invalid --only-id: expected a SHA-256 hex digest")
    if not 600 <= args.document_timeout_seconds <= 1200:
        parser.error("invalid --document-timeout-seconds: expected 600 to 1200")
    if not 1.0 <= args.repetition_penalty <= 1.5:
        parser.error("invalid --repetition-penalty: expected 1.0 to 1.5")
    if args.minimum_balance != 0 and not 25 <= args.minimum_balance <= 1_000_000:
        parser.error("minimum balance must be zero or at least 25 compute units")
    raw, staging = args.raw_repo.resolve(), args.staging.resolve()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    log_path = args.state_dir / "batch.jsonl"
    backfill = load_module("ocr_backfill", "ocr-backfill.py")
    importer = load_module("ocr_colab_import", "ocr-colab-import.py")
    available = candidates(raw, staging, backfill)
    prepared = {}
    if args.prepared_dir:
        converted, prepared = prepared_candidates(
            raw, staging, args.prepared_dir.resolve(), backfill)
        available = sorted([*available, *converted],
                           key=lambda item: (page_count(item[1]), item[2]))
    selected = [
        item for item in available
        if args.min_pages <= page_count(item[1])
        and (not args.max_pages or page_count(item[1]) <= args.max_pages)
        and (not args.only_id or hashlib.sha256(item[0].encode()).hexdigest() == args.only_id)
    ]
    if args.skip_known_failures:
        failures = known_failures(log_path)
        selected = [item for item in selected
                    if hashlib.sha256(item[0].encode()).hexdigest() not in failures]
    batch: list[tuple[str, Path, int]] = []
    size = 0
    ready = 0
    failed = 0
    try:
        with log_path.open("a", encoding="utf-8") as log:
            os.chmod(log_path, 0o600)
            log_event(log, "cloud_plan", candidates=len(selected))
            for relative, path, length in selected:
                if args.limit and ready >= args.limit:
                    break
                identifier = hashlib.sha256(relative.encode()).hexdigest()
                reason = screen_pdf(path, relative)
                if reason:
                    log_event(log, "cloud_deferred", id=identifier, reason=reason)
                    continue
                ready += 1
                if args.dry_run:
                    log_event(log, "cloud_ready", id=identifier, pages=page_count(path))
                    continue
                if batch and (len(batch) >= args.batch_size or size + length > MAX_BATCH_BYTES):
                    if not sufficient_balance(args.minimum_balance, log):
                        return 2
                    try:
                        failed += run_batch(
                            batch, raw, staging, args.session, importer, log,
                            args.document_timeout_seconds, args.repetition_penalty,
                            args.backend, prepared)
                    except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError) as error:
                        log_event(log, "cloud_batch_failed",
                                  ids=[hashlib.sha256(item[0].encode()).hexdigest()
                                       for item in batch], count=len(batch),
                                  reason=safe_batch_error(error))
                        return 1
                    batch, size = [], 0
                batch.append((relative, path, length))
                size += length
            if batch:
                if not sufficient_balance(args.minimum_balance, log):
                    return 2
                try:
                    failed += run_batch(
                        batch, raw, staging, args.session, importer, log,
                        args.document_timeout_seconds, args.repetition_penalty,
                        args.backend, prepared)
                except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError) as error:
                    log_event(log, "cloud_batch_failed",
                              ids=[hashlib.sha256(item[0].encode()).hexdigest()
                                   for item in batch], count=len(batch),
                              reason=safe_batch_error(error))
                    return 1
            log_event(log, "cloud_finished", failed=failed)
    finally:
        if args.stop_session_on_exit and not args.dry_run:
            try:
                command(["stop", "-s", args.session], timeout=90)
            except (RuntimeError, subprocess.TimeoutExpired):
                print('{"event":"cloud_stop_failed"}', flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
