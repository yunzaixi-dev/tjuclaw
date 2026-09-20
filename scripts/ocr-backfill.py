#!/usr/bin/env python3
"""Local PaddleOCR-VL backfill for immutable crawler archive objects."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

PADDLEOCR_VERSION = "3.7.0"
PIPELINE_VERSION = "v1.6"
PROVENANCE_MARKER = "TJUCLAW_OCR_V1"
VLM_MAX_PIXELS = 28 * 28 * 1200
LIBREOFFICE_IMAGE = "tjuclaw-ocr-libreoffice:local"
RAW_PATH_RE = re.compile(
    r"^archive/(?P<source>[A-Za-z0-9][A-Za-z0-9_-]{0,127})/raw/"
    r"(?P<prefix1>[a-f0-9]{2})/(?P<prefix2>[a-f0-9]{2})/"
    r"(?P<sha256>[a-f0-9]{64})(?P<suffix>\..+)?$"
)
OCR_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
OFFICE_SUFFIXES = {".doc", ".docx", ".ppt", ".pptx", ".pps", ".ppsx", ".xls", ".xlsx"}
TEXT_SUFFIXES = {".md", ".markdown", ".txt"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate staged Canonical Markdown with local PaddleOCR-VL.")
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--source")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    if args.limit < 0:
        parser.error("--limit must be zero or positive")
    return args


def parse_raw_path(raw_repo: Path, path: Path) -> tuple[str, str, Path] | None:
    try:
        relative = path.relative_to(raw_repo).as_posix()
    except ValueError:
        return None
    match = RAW_PATH_RE.fullmatch(relative)
    if not match:
        return None
    sha256 = match.group("sha256")
    if match.group("prefix1") != sha256[:2] or match.group("prefix2") != sha256[2:4]:
        return None
    output = Path("archive", match.group("source"), "raw", sha256[:2], sha256[2:4], f"{sha256}.md")
    return match.group("source"), sha256, output


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def materialize_lfs(raw_repo: Path, pending: list[tuple[Path, str, str, Path]]) -> None:
    for offset in range(0, len(pending), 64):
        include = ",".join(path.relative_to(raw_repo).as_posix() for path, _, _, _ in pending[offset : offset + 64])
        process = subprocess.run(
            ["git", "lfs", "pull", "--include", include, "--exclude", ""],
            cwd=raw_repo,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3600,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError("lfs_pull_failed")


def convert_office_to_pdf(source: Path, work_dir: Path) -> Path:
    output = work_dir / "converted"
    output.mkdir()
    container_source = f"/input/document{source.suffix.lower()}"
    process = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--memory",
            "2g",
            "--memory-swap",
            "2g",
            "--cpus",
            "2",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=512m",
            "--mount",
            f"type=bind,src={source},dst={container_source},readonly",
            "--mount",
            f"type=bind,src={output},dst=/output",
            LIBREOFFICE_IMAGE,
            "--convert-to",
            "pdf",
            "--outdir",
            "/output",
            container_source,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=300,
        check=False,
    )
    pdfs = sorted(output.glob("*.pdf"))
    if process.returncode != 0 or len(pdfs) != 1:
        raise RuntimeError("office_conversion_failed")
    return pdfs[0]


def markdown_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return "\n\n".join(part for part in value if isinstance(part, str))
    return ""


def safe_asset_path(raw: str, index: int) -> Path:
    parts = [part for part in raw.replace("\\", "/").split("/") if part not in {"", ".", ".."}]
    if not parts:
        return Path(f"image-{index}.png")
    return Path(*parts)


def extract_markdown(results: Iterable[Any], output: Path) -> str:
    parts: list[str] = []
    image_index = 0
    asset_root = output.with_suffix(".assets")
    for result in results:
        value = result.markdown
        text = markdown_text(value.get("markdown_texts"))
        images = value.get("markdown_images") or {}
        if not isinstance(images, dict):
            raise RuntimeError("invalid_markdown_images")
        for raw_name, image in images.items():
            image_index += 1
            relative = safe_asset_path(str(raw_name), image_index)
            destination = asset_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            image.save(destination)
            replacement = f"{output.stem}.assets/{relative.as_posix()}"
            text = text.replace(str(raw_name), replacement)
        if text.strip():
            parts.append(text.strip())
    markdown = "\n\n".join(parts).strip()
    if not markdown:
        raise RuntimeError("empty_ocr_markdown")
    return markdown


def create_pipeline() -> Any:
    from paddleocr import PaddleOCRVL
    return PaddleOCRVL(
        pipeline_version=PIPELINE_VERSION,
        device="gpu:0",
        use_queues=False,
        use_doc_orientation_classify=True,
        use_seal_recognition=True,
        use_doc_unwarping=True,
        use_layout_detection=True,
        use_chart_recognition=True,
        use_ocr_for_image_block=True,
        format_block_content=True,
    )


def run_ocr(pipeline: Any, source: Path, output: Path) -> str:
    pages = list(pipeline.predict(input=str(source), max_pixels=VLM_MAX_PIXELS))
    if not pages:
        raise RuntimeError("empty_ocr_result")
    reconstructed = pipeline.restructure_pages(
        pages,
        merge_tables=True,
        relevel_titles=True,
        concatenate_pages=True,
    )
    return extract_markdown(reconstructed, output)


def provenance(source_path: str, sha256: str) -> str:
    metadata = {
        "source_path": source_path,
        "source_sha256": sha256,
        "processor": "PaddleOCR-VL",
        "pipeline_version": PIPELINE_VERSION,
        "paddleocr_version": PADDLEOCR_VERSION,
        "max_pixels": VLM_MAX_PIXELS,
    }
    return f"<!-- {PROVENANCE_MARKER}\n{json.dumps(metadata, ensure_ascii=False, sort_keys=True)}\n-->\n\n"


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(f"{path.suffix}.partial")
    partial.write_text(content, encoding="utf-8")
    partial.replace(path)


def discover(raw_repo: Path, source_filter: str | None) -> list[tuple[Path, str, str, Path]]:
    archive = raw_repo / "archive"
    if not archive.is_dir():
        raise RuntimeError("raw_archive_missing")
    found: list[tuple[Path, str, str, Path]] = []
    for path in archive.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        parsed = parse_raw_path(raw_repo, path)
        if not parsed:
            continue
        source, sha256, output = parsed
        if source_filter and source != source_filter:
            continue
        found.append((path, source, sha256, output))
    return sorted(found, key=lambda item: item[0].as_posix())


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    raw_repo = args.raw_repo.resolve()
    staging = args.staging.resolve()
    candidates = discover(raw_repo, args.source)
    supported_candidates = [
        item for item in candidates if item[0].suffix.lower() in OCR_SUFFIXES | OFFICE_SUFFIXES | TEXT_SUFFIXES
    ]
    unsupported = len(candidates) - len(supported_candidates)
    pending = supported_candidates if args.force else [
        item for item in supported_candidates if not (staging / item[3]).is_file()
    ]
    if args.limit:
        pending = pending[: args.limit]
    if args.dry_run:
        print(json.dumps({"event": "ocr_plan", "candidates": len(candidates), "pending": len(pending), "supported": len(supported_candidates), "unsupported": unsupported}))
        return 0
    materialize_lfs(raw_repo, pending)

    pipeline: Any | None = None
    processed = 0
    copied = 0
    failed = 0
    for source_path, _, sha256, relative_output in pending:
        output = staging / relative_output
        relative_source = source_path.relative_to(raw_repo).as_posix()
        try:
            output.unlink(missing_ok=True)
            assets = output.with_suffix(".assets")
            if assets.is_symlink() or assets.is_file():
                assets.unlink()
            elif assets.exists():
                shutil.rmtree(assets)
            if file_sha256(source_path) != sha256:
                raise RuntimeError("source_hash_mismatch_or_lfs_pointer")
            suffix = source_path.suffix.lower()
            if suffix in TEXT_SUFFIXES:
                body = source_path.read_text(encoding="utf-8").replace("\x00", "").strip()
                if not body:
                    raise RuntimeError("empty_text_document")
                atomic_write(output, provenance(relative_source, sha256) + body + "\n")
                copied += 1
            else:
                if pipeline is None:
                    pipeline = create_pipeline()
                with tempfile.TemporaryDirectory(prefix="tjuclaw-ocr-") as temporary:
                    ocr_input = source_path
                    if suffix in OFFICE_SUFFIXES:
                        ocr_input = convert_office_to_pdf(source_path, Path(temporary))
                    body = run_ocr(pipeline, ocr_input, output)
                atomic_write(output, provenance(relative_source, sha256) + body + "\n")
                processed += 1
            print(json.dumps({"event": "ocr_complete", "source_path": relative_source, "output_path": relative_output.as_posix()}, ensure_ascii=False))
        except Exception as error:
            failed += 1
            print(json.dumps({"event": "ocr_failed", "source_path": relative_source, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
    print(json.dumps({"event": "ocr_summary", "processed": processed, "copied": copied, "unsupported": unsupported, "failed": failed}))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
