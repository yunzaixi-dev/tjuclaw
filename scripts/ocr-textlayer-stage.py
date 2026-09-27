#!/usr/bin/env python3
"""Stage text-native public PDFs/verified Office conversions without claiming OCR."""

from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
MARKER = "TJUCLAW_TEXT_LAYER_V1"
MAX_PDF_BYTES = 40_000_000
MAX_TEXT_BYTES = 32 * 1024 * 1024


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BACKFILL = load("textlayer_backfill", "ocr-backfill.py")
REPAIR = load("textlayer_repair", "ocr-llm-repair.py")


def pdf_pages(pdf: Path) -> int | None:
    try:
        result = subprocess.run(
            ["pdfinfo", str(pdf)], capture_output=True, text=True,
            timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r"^Pages:\s+(\d+)\s*$", result.stdout, re.M)
    if result.returncode or match is None:
        return None
    return int(match.group(1))


def extract_pages(pdf: Path, expected: int) -> list[str] | None:
    # Poppler output may contain private source text. Keep it in a private temp
    # directory, never forward its stderr or text to the console or a log.
    with tempfile.TemporaryDirectory(prefix="tjuclaw-textlayer-") as directory:
        output = Path(directory) / "document.txt"
        try:
            completed = subprocess.run(
                ["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), str(output)],
                capture_output=True, timeout=120, check=False,
            )
            if completed.returncode or not output.is_file():
                return None
            if output.stat().st_size > MAX_TEXT_BYTES:
                return None
            text = output.read_text(encoding="utf-8")
        except (OSError, UnicodeError, subprocess.TimeoutExpired):
            return None
    pages = text.rstrip("\f\r\n").split("\f")
    return pages if len(pages) == expected else None


def quality_body(pages: list[str], source_size: int) -> str | None:
    if not pages or "\ufffd" in "".join(pages):
        return None
    covered = sum(
        sum(character.isprintable() and not character.isspace() for character in page) >= 80
        for page in pages
    )
    if covered < math.ceil(len(pages) * 0.9):
        return None
    body = "\n\n---\n\n".join(page.strip() for page in pages)
    if len(body.strip()) < 600 or len(body.encode("utf-8")) > MAX_TEXT_BYTES:
        return None
    if REPAIR.repair_reasons(body, {}, source_size):
        return None
    return body


def stage_one(
    source: Path, relative: str, digest: str, destination: Path,
    cache: Path, minimum: int, maximum: int,
) -> str:
    if destination.exists() or destination.is_symlink():
        return "already_staged"
    if (source.is_symlink() or BACKFILL.is_lfs_pointer(source)
            or BACKFILL.is_appledouble(source)
            or source.stat().st_size > MAX_PDF_BYTES
            or BACKFILL.looks_like_html(source)):
        return "deferred_source"
    suffix = source.suffix.lower()
    conversion = None
    if suffix == ".pdf":
        pdf = source
    elif suffix in BACKFILL.OFFICE_SUFFIXES:
        verified = BACKFILL.checked_prepared_office(cache, relative, source)
        if verified is None:
            return "deferred_conversion"
        pdf, conversion = verified
    else:
        return "deferred_source"
    if pdf.stat().st_size > MAX_PDF_BYTES:
        return "deferred_source"
    pages = pdf_pages(pdf)
    if pages is None or not minimum <= pages <= maximum:
        return "deferred_pages"
    extracted = extract_pages(pdf, pages)
    if extracted is None:
        return "deferred_extraction"
    body = quality_body(extracted, source.stat().st_size)
    if body is None:
        return "deferred_quality"
    try:
        categories = REPAIR.scan_privacy(f"{Path(relative).parts[3]}\n{body}")
    except RuntimeError:
        return "deferred_privacy"
    if any(category != "phone" for category in categories):
        return "deferred_privacy"
    metadata = {
        "source_path": relative,
        "source_sha256": digest,
        "original_sha256": BACKFILL.file_sha256(source),
        "pdf_sha256": BACKFILL.file_sha256(pdf),
        "pages": pages,
        "processor": "Poppler-pdftotext",
        "pipeline_version": "text-v1",
    }
    if conversion is not None:
        metadata["conversion"] = {
            "converter": conversion["converter"],
            "pdf_sha256": conversion["pdf_sha256"],
            "pages": conversion["pages"],
        }
    # Both discovery and import bind the stage to the source's attachment id.
    # Do not replace another worker's result between screening and the write.
    if destination.exists() or destination.is_symlink():
        return "already_staged"
    BACKFILL.atomic_write(
        destination,
        f"<!-- {MARKER}\n{json.dumps(metadata, ensure_ascii=False, sort_keys=True)}\n-->\n\n"
        + body + "\n",
    )
    os.chmod(destination, 0o600)
    return "staged"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-repo", required=True, type=Path)
    parser.add_argument("--staging", required=True, type=Path)
    parser.add_argument("--source-map", required=True, type=Path)
    parser.add_argument("--prepared-office-dir", required=True, type=Path)
    parser.add_argument("--min-pages", type=int, default=7)
    parser.add_argument("--max-pages", type=int, default=200)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)
    if (not 1 <= args.min_pages <= args.max_pages <= 2000 or args.limit < 0
            or not args.prepared_office_dir.is_dir()):
        parser.error("invalid stage bounds or missing Office cache")
    raw = args.raw_repo.resolve()
    stage = args.staging.resolve()
    source_map = json.loads(args.source_map.read_text(encoding="utf-8"))
    if not isinstance(source_map, dict):
        parser.error("invalid source map")
    counts: Counter[str] = Counter()
    considered = 0
    for path, source, digest, output in BACKFILL.discover(raw, "public-course-sharing"):
        if source != "public-course-sharing" or output.as_posix() not in source_map:
            continue
        if path.suffix.lower() not in BACKFILL.OFFICE_SUFFIXES | {".pdf"}:
            continue
        destination = stage / output
        if destination.exists() or destination.is_symlink():
            counts["already_staged"] += 1
            continue
        if args.limit and considered >= args.limit:
            break
        considered += 1
        relative = path.relative_to(raw).as_posix()
        try:
            counts[stage_one(
                path, relative, digest, destination,
                args.prepared_office_dir.resolve(), args.min_pages, args.max_pages,
            )] += 1
        except (OSError, ValueError, TypeError):
            counts["deferred_error"] += 1
    print(json.dumps({"event": "ocr_textlayer_stage", "counts": dict(counts)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
