#!/usr/bin/env python3
"""Local PaddleOCR-VL backfill for raw attachment files beside crawler items."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

PADDLEOCR_VERSION = "3.7.0"
PIPELINE_VERSION = "v1.6"
PROVENANCE_MARKER = "TJUCLAW_OCR_V1"
VLM_MAX_PIXELS = 28 * 28 * 1200
MAX_ALLOWED_PIXELS = VLM_MAX_PIXELS * 4
REPETITION_PENALTY = 1.0
DOCUMENT_TIMEOUT_SECONDS = 1800
LIBREOFFICE_IMAGE = "tjuclaw-ocr-libreoffice:local"
RAW_PATH_RE = re.compile(
    r"^sources/(?P<kind>[a-z0-9][a-z0-9-]*)/(?P<source>[A-Za-z0-9][A-Za-z0-9_-]{0,127})/"
    r"(?P<title>[^/\x00]+)/(?P<item_sha256>[a-f0-9]{64})\.attachments/"
    r"(?P<sha256>[a-f0-9]{64})(?P<suffix>\.[A-Za-z0-9]+)?$"
)
OCR_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
OFFICE_SUFFIXES = {
    ".doc", ".docx", ".docm", ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".ppsm",
    ".xls", ".xlsx", ".xlsm", ".vsd", ".odt", ".ods", ".odp",
}
TEXT_SUFFIXES = {".md", ".markdown", ".txt"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate staged Canonical Markdown with local PaddleOCR-VL.")
    parser.add_argument("--raw-repo", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--source")
    parser.add_argument("--include-suffix", action="append", default=[], help="Limit processing to extensions such as .pdf")
    parser.add_argument(
        "--retry-log",
        type=Path,
        help="Retry only source_path values recorded by prior JSONL ocr_failed events.",
    )
    parser.add_argument(
        "--input-list",
        type=Path,
        help="Process only newline-separated raw-repo-relative source paths.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--shard-index", type=int, default=0,
                        help="Process only this zero-based shard of the pending set.")
    parser.add_argument("--shard-count", type=int, default=1,
                        help="Split the pending set into this many deterministic shards.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--preserve-valid-stage",
        action="store_true",
        help="Keep valid staged Markdown from another OCR backend or pixel budget.",
    )
    parser.add_argument("--max-pixels", type=int, default=VLM_MAX_PIXELS)
    parser.add_argument("--page-batch-size", type=int, default=1)
    parser.add_argument("--repetition-penalty", type=float, default=REPETITION_PENALTY)
    parser.add_argument(
        "--accept-generation-loop",
        action="store_true",
        help="Keep non-empty Markdown when the loop detector flags a reconstruction; use only for salvage retries.",
    )
    parser.add_argument("--document-timeout-seconds", type=int, default=DOCUMENT_TIMEOUT_SECONDS,
                        help="Fail one attachment after this many seconds; zero disables the watchdog.")
    parser.add_argument("--use-queues", action="store_true")
    parser.add_argument("--vl-rec-backend", choices=("native", "vllm-server"), default="native")
    parser.add_argument("--vl-rec-server-url", default="http://127.0.0.1:8118/v1")
    parser.add_argument("--vl-rec-max-concurrency", type=int, default=4)
    parser.add_argument("--pipeline-device", choices=("cpu", "gpu:0"), default="gpu:0")
    args = parser.parse_args(argv)
    if args.limit < 0:
        parser.error("--limit must be zero or positive")
    if args.shard_count < 1:
        parser.error("--shard-count must be positive")
    if not 0 <= args.shard_index < args.shard_count:
        parser.error("--shard-index must be between zero and shard-count - 1")
    if args.document_timeout_seconds < 0:
        parser.error("--document-timeout-seconds must be zero or positive")
    if any(not re.fullmatch(r"\.[a-z0-9]+", suffix) for suffix in args.include_suffix):
        parser.error("--include-suffix requires lowercase file extensions such as .pdf")
    if not 1 <= args.page_batch_size <= 8:
        parser.error("--page-batch-size must be between 1 and 8")
    if not 1.0 <= args.repetition_penalty <= 1.5:
        parser.error("--repetition-penalty must be between 1.0 and 1.5")
    if not VLM_MAX_PIXELS <= args.max_pixels <= MAX_ALLOWED_PIXELS:
        parser.error(f"--max-pixels must be between {VLM_MAX_PIXELS} and {MAX_ALLOWED_PIXELS}")
    if not 1 <= args.vl_rec_max_concurrency <= 32:
        parser.error("--vl-rec-max-concurrency must be between 1 and 32")
    if args.vl_rec_backend == "vllm-server" and args.vl_rec_server_url not in (
        "http://127.0.0.1:8118/v1", "http://localhost:8118/v1"
    ):
        parser.error("--vl-rec-server-url must be the local inference service")
    if args.vl_rec_backend == "native" and args.repetition_penalty != 1.0:
        parser.error("--repetition-penalty requires --vl-rec-backend vllm-server")
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
    output = Path(relative).with_name(f"{sha256}.md")
    return match.group("source"), sha256, output


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def looks_like_html(path: Path) -> bool:
    with path.open("rb") as stream:
        prefix = stream.read(512).lstrip().lower()
    return prefix.startswith((b"<!doctype html", b"<html", b"<head", b"<title"))


def looks_like_utf8_text(path: Path) -> bool:
    try:
        data = path.read_bytes()
    except OSError:
        return False
    if b"\x00" in data:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def is_appledouble(path: Path) -> bool:
    with path.open("rb") as stream:
        return stream.read(8) == b"\x00\x05\x16\x07\x00\x02\x00\x00"


def decode_text_document(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    if is_appledouble(path):
        raise RuntimeError("appledouble_metadata_not_document")
    if b"\x00" in data:
        raise RuntimeError("binary_text_attachment")
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            body = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        controls = sum(ord(character) < 32 and character not in "\r\n\t" for character in body)
        if controls * 100 > len(body):
            raise RuntimeError("binary_text_attachment")
        if not body.strip():
            raise RuntimeError("empty_text_document")
        return body.replace("\x00", "").strip(), encoding
    raise RuntimeError("unknown_text_encoding")


def is_lfs_pointer(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            prefix = stream.read(256)
    except OSError:
        return False
    return prefix.startswith(b"version https://git-lfs.github.com/spec/v1\n")


def materialize_lfs(raw_repo: Path, pending: list[tuple[Path, str, str, Path]]) -> None:
    lfs_paths = [path for path, _, _, _ in pending if is_lfs_pointer(path)]
    if not lfs_paths:
        return
    if not (raw_repo / ".git").exists():
        raise RuntimeError("raw_repo_git_metadata_missing_for_lfs")
    for offset in range(0, len(lfs_paths), 64):
        include = ",".join(path.relative_to(raw_repo).as_posix() for path in lfs_paths[offset : offset + 64])
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
    if shutil.which("docker") is None:
        profile = work_dir / "libreoffice-profile"
        profile.mkdir()
        process = subprocess.run(
            [
                "soffice", "--headless", "--norestore", "--nofirststartwizard",
                f"-env:UserInstallation={profile.as_uri()}",
                "--convert-to", "pdf", "--outdir", str(output), str(source),
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
    # PaddleOCR-VL's reconstructed Markdown may contain HTML tables and layout
    # metadata. Do not flatten it: colspan/rowspan and reading-order details
    # cannot be represented faithfully by a regular Markdown table.
    markdown = "\n\n".join(parts).strip()
    if not markdown:
        raise RuntimeError("empty_ocr_markdown")
    return markdown


def configure_page_batch_size(pipeline: Any, page_batch_size: int) -> None:
    paddlex_pipeline = getattr(pipeline, "paddlex_pipeline", None)
    if paddlex_pipeline is None:
        return
    for component in (
        paddlex_pipeline,
        getattr(paddlex_pipeline, "layout_det_model", None),
        getattr(paddlex_pipeline, "vl_rec_model", None),
    ):
        sampler = getattr(component, "batch_sampler", None)
        if sampler is not None and hasattr(sampler, "batch_size"):
            sampler.batch_size = page_batch_size


def create_pipeline(use_queues: bool = False, backend: str = "native",
                    server_url: str = "http://127.0.0.1:8118/v1",
                    max_concurrency: int = 4, device: str = "gpu:0",
                    page_batch_size: int = 1) -> Any:
    from paddleocr import PaddleOCRVL
    vl_options = {} if backend == "native" else {
        "vl_rec_backend": "vllm-server",
        "vl_rec_server_url": server_url,
        "vl_rec_max_concurrency": max_concurrency,
    }
    pipeline = PaddleOCRVL(
        pipeline_version=PIPELINE_VERSION,
        device=device,
        use_queues=use_queues,
        use_doc_orientation_classify=True,
        use_seal_recognition=True,
        use_doc_unwarping=True,
        use_layout_detection=True,
        use_chart_recognition=True,
        use_ocr_for_image_block=True,
        format_block_content=True,
        **vl_options,
    )
    # PaddleOCR-VL defaults its PDF/image sampler to 64 pages per batch.
    # That retains every decoded page while layout and VLM inference run,
    # which can exhaust VRAM even when the VLM recognition batch is one.
    # Keep the quality budget unchanged and bound only the in-flight pages.
    configure_page_batch_size(pipeline, page_batch_size)
    return pipeline


def has_generation_loop(markdown: str) -> bool:
    if len(markdown) < 2048:
        return False
    width = 64
    counts = Counter(markdown[index:index + width] for index in range(len(markdown) - width + 1))
    return any(count >= 40 and count * width >= len(markdown) * 0.4 for count in counts.values())


def run_ocr(pipeline: Any, source: Path, output: Path, max_pixels: int = VLM_MAX_PIXELS,
            repetition_penalty: float = REPETITION_PENALTY,
            accept_generation_loop: bool = False) -> tuple[str, int]:
    predict_options: dict[str, Any] = {"input": str(source), "max_pixels": max_pixels}
    if repetition_penalty != 1.0:
        predict_options["repetition_penalty"] = repetition_penalty
    pages = list(pipeline.predict(**predict_options))
    if not pages:
        raise RuntimeError("empty_ocr_result")

    def reconstruct(page_results: list[Any], concatenate_pages: bool) -> str:
        asset_root = output.with_suffix(".assets")
        if asset_root.exists():
            shutil.rmtree(asset_root)
        reconstructed = pipeline.restructure_pages(
            page_results,
            merge_tables=True,
            relevel_titles=True,
            concatenate_pages=concatenate_pages,
        )
        markdown = extract_markdown(reconstructed, output)
        if has_generation_loop(markdown) and not accept_generation_loop:
            raise RuntimeError("ocr_generation_loop")
        return markdown

    try:
        return reconstruct(pages, True), len(pages)
    except RuntimeError as error:
        if str(error) != "ocr_generation_loop":
            raise

    # A long slide deck can make the model repeat a local generation loop only
    # when pages are concatenated. Preserve the page boundaries before reducing
    # the image budget, so layout fidelity is retained whenever possible.
    try:
        return reconstruct(pages, False), len(pages)
    except RuntimeError as error:
        if str(error) != "ocr_generation_loop":
            raise

    fallback_pixels = max(VLM_MAX_PIXELS, max_pixels // 2)
    if fallback_pixels >= max_pixels:
        raise RuntimeError("ocr_generation_loop")
    fallback_options = {"input": str(source), "max_pixels": fallback_pixels}
    if repetition_penalty != 1.0:
        fallback_options["repetition_penalty"] = repetition_penalty
    fallback_pages = list(pipeline.predict(**fallback_options))
    if not fallback_pages:
        raise RuntimeError("empty_ocr_result")
    return reconstruct(fallback_pages, False), len(fallback_pages)


def provenance(source_path: str, sha256: str, max_pixels: int = VLM_MAX_PIXELS,
               backend: str = "native", device: str = "gpu:0",
               repetition_penalty: float = REPETITION_PENALTY) -> str:
    metadata = {
        "source_path": source_path,
        "source_sha256": sha256,
        "processor": "PaddleOCR-VL",
        "pipeline_version": PIPELINE_VERSION,
        "paddleocr_version": PADDLEOCR_VERSION,
        "max_pixels": max_pixels,
        "vl_rec_backend": backend,
        "pipeline_device": device,
        "repetition_penalty": repetition_penalty,
    }
    return f"<!-- {PROVENANCE_MARKER}\n{json.dumps(metadata, ensure_ascii=False, sort_keys=True)}\n-->\n\n"


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(f"{path.suffix}.partial")
    partial.write_text(content, encoding="utf-8")
    partial.replace(path)


@contextmanager
def document_timeout(seconds: int):
    """Bound pathological native/Paddle calls without leaving partial output."""
    if seconds <= 0 or not hasattr(signal, "SIGALRM"):
        yield
        return

    def on_alarm(_signum: int, _frame: Any) -> None:
        raise TimeoutError("document_timeout")

    previous_handler = signal.signal(signal.SIGALRM, on_alarm)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, previous_timer[0], previous_timer[1])


def staged_at_quality(path: Path, source_path: str, sha256: str, max_pixels: int,
                      backend: str = "native", device: str = "gpu:0",
                      repetition_penalty: float = REPETITION_PENALTY) -> bool:
    try:
        with path.open("r", encoding="utf-8") as stream:
            header = stream.read(2048)
    except (OSError, UnicodeError):
        return False
    prefix = f"<!-- {PROVENANCE_MARKER}\n"
    if not header.startswith(prefix):
        return False
    try:
        data = json.loads(header[len(prefix):].split("\n-->", 1)[0])
    except (ValueError, IndexError):
        return False
    return (
        data.get("source_path") == source_path
        and data.get("source_sha256") == sha256
        and data.get("pipeline_version") == PIPELINE_VERSION
        and data.get("paddleocr_version") == PADDLEOCR_VERSION
        and data.get("max_pixels") == max_pixels
        and data.get("vl_rec_backend", "native") == backend
        and data.get("pipeline_device", "gpu:0") == device
        and data.get("repetition_penalty") == repetition_penalty
    )


def staged_with_provenance(path: Path, source_path: str, sha256: str) -> bool:
    """Do not overwrite an already verified OCR result during a recovery run."""
    try:
        with path.open("r", encoding="utf-8") as stream:
            header = stream.read(2048)
        prefix = f"<!-- {PROVENANCE_MARKER}\n"
        if not header.startswith(prefix):
            return False
        metadata = json.loads(header[len(prefix):].split("\n-->", 1)[0])
        return (
            metadata.get("source_path") == source_path
            and metadata.get("source_sha256") == sha256
            and metadata.get("processor") == "PaddleOCR-VL"
            and metadata.get("pipeline_version") == PIPELINE_VERSION
        )
    except (OSError, UnicodeError, ValueError, IndexError, AttributeError):
        return False


def discover(raw_repo: Path, source_filter: str | None) -> list[tuple[Path, str, str, Path]]:
    sources = raw_repo / "sources"
    if not sources.is_dir():
        raise RuntimeError("raw_sources_missing")
    found: list[tuple[Path, str, str, Path]] = []
    for path in sources.rglob("*"):
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


def failed_source_paths(path: Path) -> set[str]:
    """Read only failed source paths from a prior JSONL run."""
    failed: set[str] = set()
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            source_path = event.get("source_path")
            if event.get("event") == "ocr_failed" and isinstance(source_path, str):
                failed.add(source_path)
    return failed


def selected_source_paths(path: Path) -> set[str]:
    selected: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.strip()
        if not value:
            continue
        if not RAW_PATH_RE.fullmatch(value) or value in selected:
            raise ValueError("invalid_or_duplicate_input_path")
        selected.add(value)
    return selected


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    raw_repo = args.raw_repo.resolve()
    staging = args.staging.resolve()
    candidates = discover(raw_repo, args.source)
    if args.include_suffix:
        candidates = [item for item in candidates if item[0].suffix.lower() in args.include_suffix]
    if args.retry_log:
        retry_paths = failed_source_paths(args.retry_log)
        candidates = [
            item for item in candidates
            if item[0].relative_to(raw_repo).as_posix() in retry_paths
        ]
    if args.input_list:
        selected = selected_source_paths(args.input_list)
        candidates = [item for item in candidates if item[0].relative_to(raw_repo).as_posix() in selected]
        if len(candidates) != len(selected):
            raise RuntimeError("input_list_contains_missing_source")
    supported_candidates = [
        item for item in candidates
        if (item[0].suffix.lower() in OCR_SUFFIXES | OFFICE_SUFFIXES | TEXT_SUFFIXES
            and not is_appledouble(item[0]))
        or (not item[0].suffix and looks_like_utf8_text(item[0]))
    ]
    unsupported = len(candidates) - len(supported_candidates)
    if args.shard_count > 1:
        supported_candidates = [item for offset, item in enumerate(supported_candidates)
                   if offset % args.shard_count == args.shard_index]
    pending = supported_candidates if args.force else [
        item for item in supported_candidates
        if not (
            staged_with_provenance(staging / item[3], item[0].relative_to(raw_repo).as_posix(), item[2])
            if args.preserve_valid_stage else
            staged_at_quality(staging / item[3], item[0].relative_to(raw_repo).as_posix(), item[2], args.max_pixels, args.vl_rec_backend, args.pipeline_device, args.repetition_penalty)
        )
    ]
    if args.limit:
        pending = pending[: args.limit]
    if args.dry_run:
        print(json.dumps({"event": "ocr_plan", "candidates": len(candidates), "pending": len(pending), "supported": len(supported_candidates), "unsupported": unsupported, "max_pixels": args.max_pixels, "use_queues": args.use_queues, "shard_index": args.shard_index, "shard_count": args.shard_count}))
        return 0
    materialize_lfs(raw_repo, pending)

    pipeline: Any | None = None
    processed = 0
    copied = 0
    reused = 0
    failed = 0
    pages_total = 0
    elapsed_total = 0.0
    ocr_cache: dict[tuple[str, str], tuple[str, int, Path]] = {}
    for source_path, _, sha256, relative_output in pending:
        output = staging / relative_output
        relative_source = source_path.relative_to(raw_repo).as_posix()
        started = time.perf_counter()
        try:
            with document_timeout(args.document_timeout_seconds):
                if file_sha256(source_path) != sha256:
                    # The attachment basename is the crawler's content-addressed
                    # object id, not necessarily the SHA-256 of the materialized
                    # bytes. LFS materialization is still handled above; a
                    # differing digest is valid for Forgejo attachment objects.
                    with source_path.open("rb") as stream:
                        lfs_header = stream.read(40)
                    if lfs_header.startswith(b"version https://git-lfs.github.com/spec/v1"):
                        raise RuntimeError("source_hash_mismatch_or_lfs_pointer")
                suffix = source_path.suffix.lower()
                if suffix in OCR_SUFFIXES | OFFICE_SUFFIXES and looks_like_html(source_path):
                    raise RuntimeError("source_extension_content_mismatch_html")
                if suffix in TEXT_SUFFIXES or (not suffix and looks_like_utf8_text(source_path)):
                    body, _ = decode_text_document(source_path)
                    atomic_write(output, provenance(relative_source, sha256, args.max_pixels, args.vl_rec_backend, args.pipeline_device, args.repetition_penalty) + body + "\n")
                    copied += 1
                    pages = 0
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    cached = ocr_cache.get((sha256, suffix))
                    if cached:
                        body, pages, original_assets = cached
                        assets = output.with_suffix(".assets")
                        if assets.is_symlink() or assets.is_file():
                            assets.unlink()
                        elif assets.exists():
                            shutil.rmtree(assets)
                        if original_assets.exists():
                            shutil.copytree(original_assets, assets)
                        reused += 1
                    else:
                        if pipeline is None:
                            pipeline = create_pipeline(args.use_queues, args.vl_rec_backend,
                                                       args.vl_rec_server_url, args.vl_rec_max_concurrency,
                                                       args.pipeline_device, args.page_batch_size)
                        with tempfile.TemporaryDirectory(prefix="tjuclaw-ocr-") as temporary:
                            ocr_input = source_path
                            if suffix in OFFICE_SUFFIXES:
                                ocr_input = convert_office_to_pdf(source_path, Path(temporary))
                            temporary_output = Path(temporary) / output.name
                            body, pages = run_ocr(
                                pipeline,
                                ocr_input,
                                temporary_output,
                                args.max_pixels,
                                args.repetition_penalty,
                                args.accept_generation_loop,
                            )
                            staged_assets = temporary_output.with_suffix(".assets")
                            assets = output.with_suffix(".assets")
                            if assets.is_symlink() or assets.is_file():
                                assets.unlink()
                            elif assets.exists():
                                shutil.rmtree(assets)
                            if staged_assets.exists():
                                shutil.move(staged_assets, assets)
                    atomic_write(output, provenance(relative_source, sha256, args.max_pixels, args.vl_rec_backend, args.pipeline_device, args.repetition_penalty) + body + "\n")
                    ocr_cache[(sha256, suffix)] = (body, pages, output.with_suffix(".assets"))
                    processed += 1
                    pages_total += pages
            elapsed = time.perf_counter() - started
            elapsed_total += elapsed
            print(json.dumps({"event": "ocr_complete", "source_path": relative_source, "output_path": relative_output.as_posix(), "pages": pages, "seconds": round(elapsed, 3)}, ensure_ascii=False))
        except Exception as error:
            failed += 1
            print(json.dumps({"event": "ocr_failed", "source_path": relative_source, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
    print(json.dumps({"event": "ocr_summary", "processed": processed, "copied": copied, "reused": reused, "pages": pages_total, "seconds": round(elapsed_total, 3), "unsupported": unsupported, "failed": failed}))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
