#!/usr/bin/env python3
"""Safely import a verified one-document Colab OCR archive into local staging."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
MAX_ARCHIVE_BYTES = 100_000_000
PII_SCAN = (
    'import {scanForPii} from "./crawler/src/archive/pii.ts"; '
    'console.log(JSON.stringify(scanForPii(await Bun.stdin.text()).matches));'
)


def privacy_categories(body: str) -> tuple[str, ...]:
    try:
        result = subprocess.run(
            ["bun", "-e", PII_SCAN], input=body, capture_output=True,
            text=True, cwd=HERE.parent, timeout=20, check=False,
        )
        matches = json.loads(result.stdout)
        if result.returncode or not isinstance(matches, list) or any(
            not isinstance(item, dict)
            or item.get("category") not in {"credential", "id_card", "phone", "student_log"}
            for item in matches
        ):
            raise ValueError("invalid_privacy_report")
        return tuple(sorted({item["category"] for item in matches}))
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        raise ValueError("privacy_scan_unavailable") from None


def modules():
    backfill_spec = importlib.util.spec_from_file_location("ocr_backfill", HERE / "ocr-backfill.py")
    audit_spec = importlib.util.spec_from_file_location("ocr_audit", HERE / "ocr-stage-audit.py")
    assert backfill_spec and backfill_spec.loader and audit_spec and audit_spec.loader
    backfill = importlib.util.module_from_spec(backfill_spec)
    audit = importlib.util.module_from_spec(audit_spec)
    backfill_spec.loader.exec_module(backfill)
    audit_spec.loader.exec_module(audit)
    return backfill, audit


def import_result(archive_path: Path, source: str, raw: Path, staging: Path) -> str:
    backfill, audit = modules()
    match = backfill.RAW_PATH_RE.fullmatch(source)
    if not match or not source.startswith("sources/course/public-course-sharing/"):
        raise ValueError("invalid_public_source")
    raw_file = raw / source
    if not raw_file.is_file() or raw_file.is_symlink() or backfill.is_lfs_pointer(raw_file):
        raise ValueError("missing_or_unmaterialized_source")

    relative_output = PurePosixPath(source).with_suffix(".md")
    prefix = relative_output.with_suffix(".assets")
    output = staging.joinpath(*relative_output.parts)
    if output.exists():
        if backfill.staged_with_provenance(output, source, match.group("sha256")):
            return "already_staged"
        raise FileExistsError(output)

    with tempfile.TemporaryDirectory(prefix="tjuclaw-colab-import-") as temporary:
        extracted = Path(temporary)
        total = 0
        seen: set[str] = set()
        with tarfile.open(archive_path, "r:gz") as archive:
            for entry in archive:
                name = PurePosixPath(entry.name)
                if (
                    name.is_absolute() or ".." in name.parts
                    or (
                        name != relative_output
                        and not (name == prefix and entry.isdir())
                        and prefix not in name.parents
                    )
                    or not entry.isfile() and not entry.isdir()
                    or entry.name in seen
                ):
                    raise ValueError("unsafe_archive_entry")
                seen.add(entry.name)
                total += entry.size
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("archive_too_large")
                destination = extracted.joinpath(*name.parts)
                if entry.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                data = archive.extractfile(entry)
                if data is None:
                    raise ValueError("unreadable_archive_entry")
                with data, destination.open("xb") as target:
                    shutil.copyfileobj(data, target)

        markdown = extracted.joinpath(*relative_output.parts)
        body = markdown.read_text(encoding="utf-8")
        metadata = audit.parse_provenance(body)
        if not metadata or any((
            metadata.get("source_path") != source,
            metadata.get("source_sha256") != match.group("sha256"),
            metadata.get("processor") != "PaddleOCR-VL",
            metadata.get("pipeline_version") != backfill.PIPELINE_VERSION,
        )):
            raise ValueError("invalid_provenance")
        conversion = metadata.get("conversion")
        if conversion is not None:
            if (raw_file.suffix.lower() not in backfill.OFFICE_SUFFIXES
                    or not isinstance(conversion, dict)
                    or set(conversion) != {"converter", "original_sha256", "pdf_sha256"}
                    or conversion.get("converter") != "isolated-libreoffice"
                    or any(not isinstance(conversion.get(key), str)
                           or not re.fullmatch(r"[a-f0-9]{64}", conversion[key])
                           for key in ("original_sha256", "pdf_sha256"))
                    or conversion["original_sha256"] != backfill.file_sha256(raw_file)):
                raise ValueError("invalid_conversion_provenance")
        if privacy_categories(body):
            raise ValueError("privacy_blocked")
        asset_dir = extracted.joinpath(*prefix.parts)
        asset_prefix = f"{prefix.name}/"
        for markdown_ref, html_ref in audit.ASSET_RE.findall(body):
            reference = markdown_ref or html_ref
            if reference.startswith(asset_prefix):
                asset_path = PurePosixPath(reference)
                if ".." in asset_path.parts or not (markdown.parent / reference).is_file():
                    raise ValueError("missing_or_unsafe_asset")

        # Another local worker can finish during the import. Never replace its result.
        if output.exists() or output.with_suffix(".assets").exists():
            raise FileExistsError(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        if asset_dir.exists():
            shutil.move(str(asset_dir), str(output.with_suffix(".assets")))
        shutil.move(str(markdown), str(output))
    return "imported"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--source", required=True, help="Raw-repo-relative source path")
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps({
        "event": "colab_ocr_import",
        "result": import_result(args.archive, args.source, args.raw_repo, args.staging),
    }))


if __name__ == "__main__":
    main()
