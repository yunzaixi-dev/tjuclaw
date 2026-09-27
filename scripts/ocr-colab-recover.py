#!/usr/bin/env python3
"""Recover one live legacy batch before retiring its frozen coordinator."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tarfile
import tempfile
import time

HERE = Path(__file__).resolve().parent


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expected_sources(archive_path: Path, raw: Path, backfill) -> dict[str, str]:
    with tarfile.open(archive_path, "r:gz") as archive:
        entry = archive.getmember("manifest.json")
        if not entry.isfile() or entry.size > 100_000:
            raise ValueError("invalid_recovery_manifest")
        stream = archive.extractfile(entry)
        if stream is None:
            raise ValueError("invalid_recovery_manifest")
        records = json.loads(stream.read())
    if not isinstance(records, list) or not 1 <= len(records) <= 8:
        raise ValueError("invalid_recovery_manifest")
    expected = {}
    for item in records:
        if not isinstance(item, dict) or set(item) != {"source", "sha256", "size"}:
            raise ValueError("invalid_recovery_source")
        source, digest = item["source"], item["sha256"]
        if (not isinstance(source, str) or not backfill.RAW_PATH_RE.fullmatch(source)
                or not source.startswith("sources/course/public-course-sharing/")
                or not source.endswith(".pdf")
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise ValueError("invalid_recovery_source")
        original = raw / source
        if (original.is_symlink() or not original.is_file()
                or backfill.file_sha256(original) != digest):
            raise ValueError("recovery_source_changed")
        identifier = hashlib.sha256(source.encode()).hexdigest()
        if identifier in expected:
            raise ValueError("duplicate_recovery_source")
        expected[identifier] = source
    return expected


def checked_report(value, expected: dict[str, str]) -> list[dict] | None:
    if not isinstance(value, list) or len(value) != len(expected):
        return None
    found = set()
    for item in value:
        if (not isinstance(item, dict) or not {"id", "ok"} <= set(item)
                or not set(item) <= {"id", "ok", "reason"}
                or not isinstance(item["id"], str) or item["id"] not in expected
                or item["id"] in found or not isinstance(item["ok"], bool)):
            return None
        found.add(item["id"])
    return value


def coordinator_pid(unit: str) -> int:
    return int(subprocess.check_output(
        ["systemctl", "--user", "show", unit, "--property=MainPID", "--value"],
        text=True).strip())


def retire_coordinator(unit: str, expected_pid: int) -> None:
    current = coordinator_pid(unit)
    if current and current != expected_pid:
        raise RuntimeError("coordinator_identity_changed")
    if not current:
        return
    # Pending SIGTERM is delivered before the stopped process can dispatch
    # another upload. SIGCONT alone would let the legacy loop advance.
    os.kill(current, signal.SIGTERM)
    os.kill(current, signal.SIGCONT)


def session_status(batch, session: str, log) -> str | None:
    try:
        return batch.command(["status", "-s", session], timeout=60)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        batch.log_event(log, "cloud_recovery_status_retry", reason=type(error).__name__)
        return None


def recover_archive(batch, session: str, identifier: str, archive: Path, log) -> None:
    if archive.is_file():
        return
    partial = archive.with_suffix(".partial")
    while True:
        try:
            batch.command(["download", "-s", session,
                           f"/content/tjuclaw-ocr-batch-results/{identifier}.tar.gz",
                           str(partial)], timeout=240)
            with tarfile.open(partial, "r:gz") as content:
                content.getmembers()
            partial.replace(archive)
            return
        except (RuntimeError, OSError, tarfile.TarError, subprocess.TimeoutExpired) as error:
            partial.unlink(missing_ok=True)
            batch.log_event(log, "cloud_recovery_download_retry", id=identifier,
                            reason=type(error).__name__)
            status = session_status(batch, session, log)
            if status and "No active sessions" in status:
                raise RuntimeError("recovery_session_missing") from None
            time.sleep(30)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-archive", type=Path, required=True)
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--coordinator-unit", required=True)
    parser.add_argument("--coordinator-pid", type=int, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"tjuclaw-colab-[a-z0-9-]+\.service", args.coordinator_unit):
        parser.error("invalid coordinator unit")
    if args.coordinator_pid < 1:
        parser.error("invalid coordinator pid")
    batch = load("ocr_batch", "ocr-colab-batch.py")
    backfill = load("ocr_backfill", "ocr-backfill.py")
    importer = load("ocr_import", "ocr-colab-import.py")
    raw, stage = args.raw_repo.resolve(), args.staging.resolve()
    expected = expected_sources(args.input_archive, raw, backfill)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    log_path = args.state_dir / "recovery.jsonl"
    archive_dir = args.state_dir / "recovered-archives"
    archive_dir.mkdir(mode=0o700, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as log, \
            tempfile.TemporaryDirectory(prefix="tjuclaw-ocr-recovery-") as directory:
        os.chmod(log_path, 0o600)
        local = Path(directory)
        report = None
        while report is None:
            try:
                batch.command(["download", "-s", args.session,
                               "/content/tjuclaw-ocr-batch-report.json",
                               str(local / "report.json")], timeout=60)
                report = checked_report(json.loads(
                    (local / "report.json").read_text(encoding="utf-8")), expected)
            except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired):
                pass
            if report is None:
                status = session_status(batch, args.session, log)
                if status and "No active sessions" in status:
                    batch.log_event(log, "cloud_recovery_session_missing")
                    retire_coordinator(args.coordinator_unit, args.coordinator_pid)
                    return 1
                batch.log_event(log, "cloud_recovery_wait", count=len(expected))
                time.sleep(30)
        for item in report:
            identifier = item["id"]
            if not item["ok"]:
                reason = item.get("reason")
                batch.log_event(log, "cloud_recovered_failed", id=identifier,
                                reason=reason if isinstance(reason, str)
                                and reason in batch.FAILURE_REASONS else "other")
                continue
            try:
                archive = archive_dir / f"{identifier}.tar.gz"
                recover_archive(batch, args.session, identifier, archive, log)
                os.chmod(archive, 0o600)
                result = importer.import_result(archive, expected[identifier], raw, stage)
                batch.log_event(log, "cloud_recovered", id=identifier, result=result)
            except (RuntimeError, ValueError, OSError, tarfile.TarError,
                    subprocess.TimeoutExpired) as error:
                if isinstance(error, ValueError) and str(error) == "privacy_blocked":
                    archive.unlink(missing_ok=True)
                batch.log_event(log, "cloud_recovery_import_failed", id=identifier,
                                reason=type(error).__name__)
        while True:
            status = session_status(batch, args.session, log)
            if status is None:
                time.sleep(30)
                continue
            if "Status: BUSY" not in status:
                break
            time.sleep(5)
        while True:
            try:
                batch.command(["stop", "-s", args.session], timeout=90)
                break
            except (RuntimeError, OSError, subprocess.TimeoutExpired):
                batch.log_event(log, "cloud_recovery_stop_retry")
                time.sleep(30)
        retire_coordinator(args.coordinator_unit, args.coordinator_pid)
        batch.log_event(log, "cloud_recovery_finished")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
