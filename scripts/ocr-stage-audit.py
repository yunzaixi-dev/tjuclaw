#!/usr/bin/env python3
"""Verify that staged OCR Markdown covers and safely references raw attachments."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

RAW_PATH_RE = re.compile(
    r"^sources/(?P<kind>[a-z0-9][a-z0-9-]*)/(?P<source>[A-Za-z0-9][A-Za-z0-9_-]{0,127})/"
    r"(?P<title>[^/\x00]+)/(?P<item>[a-f0-9]{64})\.attachments/"
    r"(?P<object>[a-f0-9]{64})(?P<suffix>\.[A-Za-z0-9]+)?$"
)
MARKER = "<!-- TJUCLAW_OCR_V1\n"
SUPPORTED = {
    ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
    ".doc", ".docx", ".docm", ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".ppsm",
    ".xls", ".xlsx", ".xlsm", ".vsd", ".odt", ".ods", ".odp",
    ".md", ".markdown", ".txt",
}
ASSET_RE = re.compile(
    r"!\[[^\]]*\]\(([^)]+)\)|<img\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_provenance(markdown: str) -> dict[str, object] | None:
    if not markdown.startswith(MARKER):
        return None
    end = markdown.find("\n-->\n\n")
    if end < 0:
        return None
    try:
        value = json.loads(markdown[len(MARKER):end])
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def audit(raw: Path, staging: Path) -> dict[str, object]:
    counts = Counter()
    failures: list[dict[str, str]] = []
    for source_path in sorted((raw / "sources").rglob("*")):
        if not source_path.is_file() or source_path.is_symlink():
            continue
        relative = source_path.relative_to(raw).as_posix()
        match = RAW_PATH_RE.fullmatch(relative)
        if not match or (match.group("suffix") or "").lower() not in SUPPORTED:
            continue
        counts["candidates"] += 1
        output = staging / Path(relative).with_name(f"{match.group('object')}.md")
        if not output.is_file():
            counts["missing"] += 1
            failures.append({"path": relative, "reason": "missing_output"})
            continue
        try:
            body = output.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            counts["invalid"] += 1
            failures.append({"path": relative, "reason": "invalid_utf8"})
            continue
        metadata = parse_provenance(body)
        if (
            metadata is None
            or metadata.get("source_path") != relative
            or metadata.get("source_sha256") != match.group("object")
            or metadata.get("processor") != "PaddleOCR-VL"
        ):
            counts["invalid"] += 1
            failures.append({"path": relative, "reason": "invalid_provenance"})
            continue
        counts["valid"] += 1
        for markdown_reference, html_reference in ASSET_RE.findall(body):
            reference = markdown_reference or html_reference
            prefix = f"{match.group('object')}.assets/"
            if not reference.startswith(prefix):
                continue
            asset_relative = Path(reference)
            asset = staging / Path(relative).parent / asset_relative
            if (
                not asset_relative.parts
                or ".." in asset_relative.parts
                or not asset.is_file()
                or asset.is_symlink()
            ):
                counts["missing_assets"] += 1
                failures.append({"path": relative, "reason": f"missing_asset:{reference}"})
    return {
        "schema": "TJUCLAW_OCR_STAGE_AUDIT_V1",
        "summary": dict(sorted(counts.items())),
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = audit(args.raw_repo.resolve(), args.staging.resolve())
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    print(json.dumps({"event": "ocr_stage_audit", **report["summary"]}, ensure_ascii=False))
    return 0 if not report["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
