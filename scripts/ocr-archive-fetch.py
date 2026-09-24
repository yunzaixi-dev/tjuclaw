#!/usr/bin/env python3
"""Materialize content-addressed crawler archive objects for offline OCR."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE_URL = "https://tjuclaw-crawler.zaixi.dev/"
KEY_RE = re.compile(
    r"archive/sources/public-course-sharing/raw/([a-f0-9]{2})/([a-f0-9]{2})/"
    r"([a-f0-9]{64})(\.[A-Za-z0-9_]+)?"
)
ITEM_RE = re.compile(r"[a-f0-9]{64}")


def metadata_paths(root: Path) -> dict[tuple[str, str], tuple[Path, str]]:
    paths: dict[tuple[str, str], tuple[Path, str]] = {}
    for path in root.glob("sources/**/*.json"):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            source, item_id = item["source"], item["itemId"]
            if ITEM_RE.fullmatch(item_id) and ITEM_RE.fullmatch(path.stem):
                paths[(source, item_id)] = (path.parent.relative_to(root), path.stem)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError):
            continue
    return paths


def plan(csv_path: Path, metadata_root: Path) -> list[dict]:
    paths = metadata_paths(metadata_root)
    objects: dict[str, dict] = {}
    with csv_path.open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            key, digest = row["object_key"], row["sha256"]
            match = KEY_RE.fullmatch(key)
            if not match or match.group(3) != digest or digest[:2] != match.group(1) or digest[2:4] != match.group(2):
                raise ValueError("invalid_archive_object_key")
            size = int(row["size_bytes"])
            if size <= 0 or size > 256 * 1024 * 1024:
                raise ValueError("invalid_archive_object_size")
            source = row["source"] or "public-course-sharing"
            item_id = row["item_id"] or digest
            if source != "public-course-sharing" or not ITEM_RE.fullmatch(item_id):
                raise ValueError("invalid_archive_placement")
            placement = paths.get((source, item_id))
            if placement is None:
                placement = (Path("sources/course/public-course-sharing") / f"archive-{item_id[:12]}", item_id)
            parent, content_hash = placement
            relative = parent / f"{content_hash}.attachments" / f"{digest}{match.group(4) or ''}"
            record = objects.setdefault(key, {"key": key, "sha256": digest, "size_bytes": size, "paths": []})
            if record["size_bytes"] != size or record["sha256"] != digest:
                raise ValueError("conflicting_archive_object")
            if relative.as_posix() not in record["paths"]:
                record["paths"].append(relative.as_posix())
    return list(objects.values())


def verify(path: Path, digest: str, size: int) -> bool:
    if not path.is_file() or path.is_symlink() or path.stat().st_size != size:
        return False
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest() == digest


def fetch_object(record: dict, raw_root: Path, override_root: Path | None = None) -> tuple[bool, int]:
    key = record["key"]
    digest, size = record["sha256"], record["size_bytes"]
    match = KEY_RE.fullmatch(key)
    if (not match or match.group(3) != digest or
            not isinstance(size, int) or size <= 0 or size > 256 * 1024 * 1024 or
            not isinstance(record["paths"], list) or not record["paths"]):
        raise ValueError("invalid_archive_plan_record")
    paths = []
    for relative in record["paths"]:
        if not isinstance(relative, str):
            raise ValueError("invalid_archive_placement_path")
        candidate = Path(relative)
        if (candidate.is_absolute() or
                ".." in candidate.parts or len(candidate.parts) != 6 or
                candidate.parts[:3] != ("sources", "course", "public-course-sharing") or
                not ITEM_RE.fullmatch(candidate.parts[-2].removesuffix(".attachments")) or
                candidate.parts[-1] != f"{digest}{match.group(4) or ''}"):
            raise ValueError("invalid_archive_placement_path")
        paths.append(raw_root / candidate)
    source = next((path for path in paths if verify(path, digest, size)), None)
    downloaded = False
    if source is None:
        source = paths[0]
        source.parent.mkdir(parents=True, exist_ok=True)
        override = override_root / f"{digest}{match.group(4) or ''}" if override_root else None
        if override is not None and override.exists():
            if not verify(override, digest, size):
                raise ValueError("archive_override_checksum_mismatch")
            shutil.copyfile(override, source)
        else:
            for attempt in range(3):
                try:
                    with tempfile.NamedTemporaryFile(dir=source.parent, prefix=".ocr-download-", delete=False) as temporary:
                        partial = Path(temporary.name)
                        checksum = hashlib.sha256()
                        total = 0
                        try:
                            request = urllib.request.Request(BASE_URL + record["key"], headers={"User-Agent": "TJUClaw-OCR-archive/1"})
                            with urllib.request.urlopen(request, timeout=90) as response:
                                while chunk := response.read(1024 * 1024):
                                    total += len(chunk)
                                    if total > size:
                                        raise ValueError("archive_download_oversize")
                                    checksum.update(chunk)
                                    temporary.write(chunk)
                            if total != size or checksum.hexdigest() != digest:
                                raise ValueError("archive_download_checksum_mismatch")
                            partial.replace(source)
                            downloaded = True
                            break
                        finally:
                            partial.unlink(missing_ok=True)
                except (OSError, ValueError, TimeoutError):
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
    for destination in paths:
        if destination == source or verify(destination, digest, size):
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.unlink(missing_ok=True)
        try:
            os.link(source, destination)
        except OSError:
            shutil.copyfile(source, destination)
    return downloaded, len(paths)


def main() -> int:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    make = subcommands.add_parser("plan")
    make.add_argument("--archive-csv", type=Path, required=True)
    make.add_argument("--metadata-repo", type=Path, required=True)
    make.add_argument("--output", type=Path, required=True)
    fetch = subcommands.add_parser("fetch")
    fetch.add_argument("--plan", type=Path, required=True)
    fetch.add_argument("--raw-root", type=Path, required=True)
    fetch.add_argument("--override-root", type=Path, help="Locally exported, SHA-verified objects when a public URL transforms bytes")
    fetch.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    if args.command == "plan":
        objects = plan(args.archive_csv, args.metadata_repo)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(objects, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"event": "archive_plan", "objects": len(objects), "placements": sum(len(x["paths"]) for x in objects),
                          "bytes": sum(x["size_bytes"] for x in objects)}))
        return 0
    if not 1 <= args.workers <= 16:
        parser.error("--workers must be between 1 and 16")
    objects = json.loads(args.plan.read_text(encoding="utf-8"))
    if not isinstance(objects, list):
        raise ValueError("invalid_archive_plan")
    downloaded = placed = failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_object, record, args.raw_root, args.override_root): record for record in objects}
        for future in as_completed(futures):
            try:
                did_download, count = future.result()
                downloaded += did_download
                placed += count
            except Exception as error:
                failed += 1
                print(json.dumps({"event": "archive_fetch_failed", "key": futures[future]["key"],
                                  "error": type(error).__name__}), flush=True)
            if (downloaded + failed) % 100 == 0 and (downloaded + failed):
                print(json.dumps({"event": "archive_fetch_progress", "downloaded": downloaded, "placed": placed, "failed": failed}), flush=True)
    print(json.dumps({"event": "archive_fetch_summary", "downloaded": downloaded, "placed": placed, "failed": failed}))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
