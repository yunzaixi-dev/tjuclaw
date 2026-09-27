#!/usr/bin/env python3
"""Prepare privacy-screened Office PDFs offline, retaining original provenance."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BACKFILL = load("office_backfill", "ocr-backfill.py")
BATCH = load("office_batch", "ocr-colab-batch.py")


def identifier(source: str) -> str:
    return hashlib.sha256(source.encode()).hexdigest()


def checked_record(cache: Path, source: str, original: Path) -> dict | None:
    prepared = BACKFILL.checked_prepared_office(cache, source, original)
    return prepared[1] if prepared else None


def prepare_one(item, raw: Path, cache: Path) -> dict:
    original = item[0]
    source = original.relative_to(raw).as_posix()
    key = identifier(source)
    if (original.is_symlink() or BACKFILL.is_lfs_pointer(original)
            or not original.is_file() or original.stat().st_size > BATCH.MAX_SOURCE_BYTES):
        return {"event": "office_deferred", "id": key, "reason": "invalid_source"}
    if BATCH.SENSITIVE_TITLE.search(source):
        return {"event": "office_deferred", "id": key, "reason": "sensitive_title"}
    record = checked_record(cache, source, original)
    if record:
        return {"event": "office_cached", "id": key, "pages": record["pages"]}
    # Never fall back to an unisolated host LibreOffice process for this batch.
    if shutil.which("docker") is None:
        return {"event": "office_deferred", "id": key, "reason": "isolation_unavailable"}
    try:
        digest = BACKFILL.file_sha256(original)
        with tempfile.TemporaryDirectory(prefix="office-", dir=cache) as directory:
            pdf = BACKFILL.convert_office_to_pdf(original, Path(directory))
            reason = BATCH.screen_pdf(pdf, source)
            if reason:
                return {"event": "office_deferred", "id": key, "reason": reason}
            pages = BATCH.page_count(pdf)
            if not 1 <= pages <= 2000:
                return {"event": "office_deferred", "id": key, "reason": "invalid_pdf"}
            if BACKFILL.file_sha256(original) != digest:
                return {"event": "office_deferred", "id": key, "reason": "source_changed"}
            record = {
                "source": source, "original_sha256": digest,
                "pdf_sha256": BACKFILL.file_sha256(pdf), "pdf_bytes": pdf.stat().st_size,
                "pages": pages, "converter": "isolated-libreoffice",
            }
            target = cache / f"{key}.pdf"
            pdf.replace(target)
            os.chmod(target, 0o600)
            BACKFILL.atomic_write(cache / f"{key}.json", json.dumps(record) + "\n")
            os.chmod(cache / f"{key}.json", 0o600)
        return {"event": "office_prepared", "id": key, "pages": pages}
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        return {"event": "office_failed", "id": key, "reason": type(error).__name__}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    if not 1 <= args.workers <= 4 or args.limit < 0:
        parser.error("invalid preparation bounds")
    raw, stage, cache = args.raw_repo.resolve(), args.staging.resolve(), args.cache.resolve()
    cache.mkdir(parents=True, mode=0o700, exist_ok=True)
    pending = [
        item for item in BACKFILL.discover(raw, "public-course-sharing")
        if item[0].suffix.lower() in BACKFILL.OFFICE_SUFFIXES
        and not BACKFILL.is_appledouble(item[0])
        and not BACKFILL.staged_with_provenance(
            stage / item[3], item[0].relative_to(raw).as_posix(), item[2])
    ]
    if args.limit:
        pending = pending[:args.limit]
    print(json.dumps({"event": "office_plan", "pending": len(pending)}), flush=True)
    counts: dict[str, int] = {}
    log_path = cache / "prepare.jsonl"
    with log_path.open("a", encoding="utf-8") as log, \
            ThreadPoolExecutor(max_workers=args.workers) as pool:
        os.chmod(log_path, 0o600)
        for result in pool.map(lambda item: prepare_one(item, raw, cache), pending):
            event = result["event"]
            counts[event] = counts.get(event, 0) + 1
            line = json.dumps(result)
            log.write(line + "\n")
            log.flush()
            print(line, flush=True)
    print(json.dumps({"event": "office_finished", "counts": counts}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
