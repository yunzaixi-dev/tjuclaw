#!/usr/bin/env python3
"""Import vetted OCR Markdown to WeKnora with original, verifiable citations.

The source map is an explicit JSON object from staged relative Markdown path
to its public HTTPS source URL. No inferred or placeholder citation is used.
The manifest is a local checkpoint, not an authorization or publication list.
"""

from __future__ import annotations

import argparse
from functools import lru_cache
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
PATH_RE = re.compile(
    r"^sources/course/public-course-sharing/[^/\x00]+/"
    r"(?P<item>[a-f0-9]{64})\.attachments/(?P<sha>[a-f0-9]{64})\.md$"
)
MAX_MARKDOWN_BYTES = 32 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024


def load_script(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def llm_script():
    return load_script("ocr-llm-repair.py")


@lru_cache(maxsize=1)
def backfill_script():
    return load_script("ocr-backfill.py")


def public_url(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid_source_url")
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
            or any(ord(character) < 32 for character in value)
            or parsed.hostname.lower() in {
                "localhost", "127.0.0.1", "::1"
            } or len(value) > 2048):
        raise ValueError("invalid_source_url")
    try:
        if not ipaddress.ip_address(parsed.hostname).is_global:
            raise ValueError("invalid_source_url")
    except ValueError as error:
        if str(error) == "invalid_source_url":
            raise
    return value


def checked_path(root: Path, relative: str) -> Path:
    if not PATH_RE.fullmatch(relative):
        raise ValueError("invalid_ocr_path")
    path = root / relative
    if path.is_symlink() or not path.is_file() or root.resolve() not in path.resolve().parents:
        raise ValueError("missing_or_unsafe_ocr_file")
    if not 0 < path.stat().st_size <= MAX_MARKDOWN_BYTES:
        raise ValueError("invalid_ocr_file_size")
    return path


def select_body(
    stage: Path, raw: Path, repaired: Path | None, relative: str,
    prepared_office_dir: Path | None = None,
) -> tuple[str, dict]:
    path = checked_path(stage, relative)
    text = path.read_text(encoding="utf-8")
    ocr_marker = "<!-- TJUCLAW_OCR_V1\n"
    text_marker = "<!-- TJUCLAW_TEXT_LAYER_V1\n"
    marker = ocr_marker if text.startswith(ocr_marker) else text_marker
    if not text.startswith(marker) or "\n-->\n\n" not in text:
        raise ValueError("invalid_ocr_provenance")
    head, body = text.split("\n-->\n\n", 1)
    # The repair worker splits at "-->\n" and hashes the remaining body,
    # including the separator's second newline. Preserve those exact bytes
    # when verifying a repair rather than silently changing its lineage.
    body = "\n" + body
    try:
        metadata = json.loads(head[len(marker):])
    except (json.JSONDecodeError, TypeError):
        raise ValueError("invalid_ocr_provenance") from None
    match = PATH_RE.fullmatch(relative)
    if not isinstance(metadata, dict):
        raise ValueError("invalid_ocr_provenance")
    source = metadata.get("source_path")
    if (not isinstance(source, str)
            or Path(source).with_suffix(".md").as_posix() != relative
            or metadata.get("source_sha256") != match["sha"]):
        raise ValueError("invalid_ocr_provenance")
    raw_path = raw / source
    if (raw_path.is_symlink() or not raw_path.is_file()
            or raw.resolve() not in raw_path.resolve().parents):
        raise ValueError("missing_original_attachment")
    if marker == ocr_marker:
        if (metadata.get("processor") != "PaddleOCR-VL"
                or metadata.get("pipeline_version") != "v1.6"
                or metadata.get("paddleocr_version") != "3.7.0"
                or type(metadata.get("max_pixels")) is not int
                or not 940800 <= metadata["max_pixels"] <= 3763200):
            raise ValueError("invalid_ocr_provenance")
    else:
        if (metadata.get("processor") != "Poppler-pdftotext"
                or metadata.get("pipeline_version") != "text-v1"
                or type(metadata.get("pages")) is not int
                or not 1 <= metadata["pages"] <= 2000):
            raise ValueError("invalid_ocr_provenance")
        original_sha = backfill_script().file_sha256(raw_path)
        if metadata.get("original_sha256") != original_sha:
            raise ValueError("invalid_ocr_provenance")
        if raw_path.suffix.lower() == ".pdf":
            if metadata.get("pdf_sha256") != original_sha or "conversion" in metadata:
                raise ValueError("invalid_ocr_provenance")
        elif raw_path.suffix.lower() in backfill_script().OFFICE_SUFFIXES:
            if prepared_office_dir is None:
                raise ValueError("invalid_ocr_provenance")
            verified = backfill_script().checked_prepared_office(
                prepared_office_dir, source, raw_path,
            )
            if verified is None:
                raise ValueError("invalid_ocr_provenance")
            _, record = verified
            if (metadata.get("pdf_sha256") != record["pdf_sha256"]
                    or metadata.get("pages") != record["pages"]
                    or metadata.get("conversion") != {
                        "converter": record["converter"],
                        "pdf_sha256": record["pdf_sha256"],
                        "pages": record["pages"],
                    }):
                raise ValueError("invalid_ocr_provenance")
        else:
            raise ValueError("invalid_ocr_provenance")
    llm = llm_script()
    reasons = llm.repair_reasons(body, metadata, raw_path.stat().st_size)
    if reasons:
        if repaired is None:
            raise ValueError("repair_required")
        repair = repaired / relative
        if repair.is_symlink() or not repair.is_file() or repaired.resolve() not in repair.resolve().parents:
            raise ValueError("repair_required")
        if not llm.output_matches_source(repair, body):
            raise ValueError("invalid_repair")
        _, body = llm.split_repair_document(repair.read_text(encoding="utf-8"))
    body = body.strip()
    if not body or len(body.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        raise ValueError("invalid_ocr_body")
    # The scanner runs locally. Matched values and source titles are never logged.
    categories = llm.scan_privacy(f"{Path(source).parts[3]}\n{body}")
    if any(category != "phone" for category in categories):
        raise ValueError("privacy_blocked")
    return body, {
        "item_id": match["item"], "source_sha256": match["sha"],
        "processor": metadata["processor"],
    }


def multipart_markdown(body: str, metadata: dict[str, str], name: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    def field(key: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n"
            f"{value}\r\n"
        ).encode("utf-8")
    payload = (
        field("metadata", json.dumps(metadata, ensure_ascii=False))
        + field("fileName", name)
        + field("channel", "tjuclaw_textlayer" if metadata.get("processor") == "Poppler-pdftotext"
                else "tjuclaw_ocr")
        + f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
          "Content-Type: text/markdown; charset=utf-8\r\n\r\n".encode()
        + body.encode("utf-8")
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return payload, f"multipart/form-data; boundary={boundary}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ValueError("weknora_redirect_rejected")


class WeKnora:
    def __init__(self, base: str, api_key: str, knowledge_base_id: str):
        parsed = urllib.parse.urlsplit(base)
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query
                or parsed.path not in {"", "/"}
                or parsed.fragment or (parsed.scheme != "https" and not (
                    parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"
                    })) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", knowledge_base_id)
                or not api_key):
            raise ValueError("invalid_weknora_config")
        self.base = base.rstrip("/")
        self.key = api_key
        self.kb = knowledge_base_id
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method: str, path: str, payload: bytes | None = None,
                content_type: str | None = None) -> dict:
        request = urllib.request.Request(
            self.base + "/api/v1" + path, data=payload, method=method,
            headers={
                "X-API-Key": self.key, "Accept": "application/json",
                **({"Content-Type": content_type} if content_type else {}),
            },
        )
        try:
            with self.opener.open(request, timeout=45) as response:
                data = response.read(MAX_RESPONSE_BYTES + 1)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
            raise RuntimeError("weknora_request_failed") from None
        if len(data) > MAX_RESPONSE_BYTES:
            raise RuntimeError("weknora_response_too_large")
        try:
            result = json.loads(data)
        except (ValueError, TypeError):
            raise RuntimeError("weknora_invalid_response") from None
        if not isinstance(result, dict) or result.get("success") is False:
            raise RuntimeError("weknora_invalid_response")
        return result

    def upload(self, body: str, metadata: dict[str, str], name: str) -> str:
        payload, content_type = multipart_markdown(body, metadata, name)
        result = self.request(
            "POST",
            f"/knowledge-bases/{urllib.parse.quote(self.kb, safe='')}/knowledge/file",
            payload, content_type,
        )
        data = result.get("data")
        identifier = data.get("id") if isinstance(data, dict) else None
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,128}", identifier):
            raise RuntimeError("weknora_invalid_response")
        return identifier

    def status(self, knowledge_id: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9-]{8,128}", knowledge_id):
            raise ValueError("invalid_knowledge_id")
        result = self.request("GET", f"/knowledge/{urllib.parse.quote(knowledge_id, safe='')}")
        data = result.get("data")
        if not isinstance(data, dict) or data.get("knowledge_base_id") != self.kb:
            raise RuntimeError("weknora_invalid_response")
        status = data.get("parse_status") if isinstance(data, dict) else None
        if not isinstance(status, str):
            raise RuntimeError("weknora_invalid_response")
        return status


def save_manifest(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".ocr-import-",
        delete=False,
    ) as stream:
        temporary = Path(stream.name)
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def import_documents(args: argparse.Namespace, client: WeKnora | None = None) -> dict[str, int]:
    if args.manifest.resolve().is_relative_to(args.staging.resolve()):
        raise ValueError("manifest_inside_staging")
    if args.source_map.resolve().is_relative_to(args.staging.resolve()):
        raise ValueError("source_map_inside_staging")
    sources = json.loads(args.source_map.read_text(encoding="utf-8"))
    if not isinstance(sources, dict):
        raise ValueError("invalid_source_map")
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        manifest = {}
    if not isinstance(manifest, dict):
        raise ValueError("invalid_import_manifest")
    counts: dict[str, int] = {}
    def add(key: str) -> None:
        counts[key] = counts.get(key, 0) + 1
    for relative, value in sorted(sources.items()):
        if args.limit and sum(counts.values()) >= args.limit:
            break
        try:
            url = public_url(value)
            body, provenance = select_body(
                args.staging, args.raw_repo, args.repaired, relative,
                getattr(args, "prepared_office_dir", None),
            )
            url_categories = llm_script().scan_privacy(urllib.parse.unquote(urllib.parse.urlsplit(url).path))
            if any(category != "phone" for category in url_categories):
                raise ValueError("privacy_blocked")
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
            metadata = {
                "source": "public-course-sharing", "item_id": provenance["item_id"],
                "source_url": url, "canonical_hash": digest,
                "source_sha256": provenance["source_sha256"],
            }
            if provenance["processor"] == "Poppler-pdftotext":
                metadata["processor"] = provenance["processor"]
            previous = manifest.get(relative)
            if previous is not None and (not isinstance(previous, dict)
                    or previous.get("knowledge_base_id") != args.knowledge_base_id
                    or previous.get("source_url") != url
                    or not isinstance(previous.get("knowledge_id"), str)):
                raise ValueError("checkpoint_mismatch")
            if previous is not None:
                if previous.get("canonical_hash") != digest:
                    raise ValueError("changed_after_upload")
                if not args.dry_run:
                    assert client is not None
                    status = client.status(previous["knowledge_id"])
                    add("indexed" if status == "completed" else "index_" + status)
                else:
                    add("already_uploaded")
                continue
            if args.dry_run:
                add("ready")
                continue
            assert client is not None
            name = provenance["item_id"] + "-" + provenance["source_sha256"][:12] + ".md"
            knowledge_id = client.upload(body, metadata, name)
            manifest[relative] = {
                "knowledge_base_id": args.knowledge_base_id,
                "knowledge_id": knowledge_id,
                "canonical_hash": digest,
                "source_url": url,
            }
            save_manifest(args.manifest, manifest)
            add("uploaded")
        except (ValueError, RuntimeError, OSError, UnicodeError) as error:
            # Only categories, never private paths or file contents, reach logs.
            allowed = {
                "invalid_source_url", "invalid_ocr_path", "missing_or_unsafe_ocr_file",
                "invalid_ocr_file_size", "invalid_ocr_provenance",
                "missing_original_attachment", "repair_required", "invalid_repair",
                "invalid_ocr_body", "privacy_blocked", "privacy_scan_unavailable",
                "checkpoint_mismatch", "changed_after_upload",
                "weknora_request_failed", "weknora_invalid_response",
                "weknora_response_too_large",
            }
            reason = str(error) if isinstance(error, (RuntimeError, ValueError)) else ""
            add("deferred_" + reason if reason in allowed else "deferred")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", required=True, type=Path)
    parser.add_argument("--raw-repo", required=True, type=Path)
    parser.add_argument("--repaired", type=Path)
    parser.add_argument("--prepared-office-dir", type=Path)
    parser.add_argument("--source-map", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--knowledge-base-id", default=os.getenv("WEKNORA_KNOWLEDGE_BASE_ID", ""))
    parser.add_argument("--base-url", default=os.getenv("WEKNORA_BASE_URL", ""))
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--execute", action="store_true", help="Upload verified files; default is a no-network plan.")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit must be nonnegative")
    args.dry_run = not args.execute
    client = None
    if args.execute:
        client = WeKnora(args.base_url, os.getenv("WEKNORA_API_KEY", ""), args.knowledge_base_id)
    counts = import_documents(args, client)
    print(json.dumps({"event": "ocr_weknora_import", "counts": counts}))
    return 1 if any(key.startswith("deferred") for key in counts) else 0


if __name__ == "__main__":
    raise SystemExit(main())
