#!/usr/bin/env python3
"""Feed verified public OCR staging to a local WeKnora KB with index backpressure.

Print aggregate counts only. Local credentials, document names and content never
appear in progress output. The importer remains the authority for provenance,
privacy checks, uploads and durable per-document checkpoints.
"""

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "ops/local/ocr-benchmark"

spec = importlib.util.spec_from_file_location(
    "ocr_weknora_import", Path(__file__).with_name("ocr-weknora-import.py")
)
assert spec is not None and spec.loader is not None
importer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = importer
spec.loader.exec_module(importer)


def checked_id(knowledge_id: str) -> str:
    if not isinstance(knowledge_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,128}", knowledge_id):
        raise RuntimeError("invalid_knowledge_id")
    return urllib.parse.quote(knowledge_id, safe="")


def indexed(client, knowledge_id: str) -> bool:
    result = client.request(
        "GET", f"/chunks/{checked_id(knowledge_id)}?page=1&page_size=1"
    )
    return (
        result.get("success") is True
        and isinstance(result.get("total"), int)
        and result["total"] > 0
        and isinstance(result.get("data"), list)
        and len(result["data"]) == 1
        and isinstance(result["data"][0], dict)
        and result["data"][0].get("knowledge_id") == knowledge_id
    )


def wait_for_index(client, knowledge_id: str, timeout: int, interval: int,
                   allow_reparse: bool = True) -> str:
    deadline = time.monotonic() + timeout
    retried = False
    while time.monotonic() < deadline:
        response = client.request("GET", f"/knowledge/{checked_id(knowledge_id)}")
        data = response.get("data")
        if not isinstance(data, dict) or data.get("knowledge_base_id") != client.kb:
            raise RuntimeError("knowledge_scope_mismatch")
        status = data.get("parse_status")
        if status == "completed":
            if not indexed(client, knowledge_id):
                raise RuntimeError("completed_without_chunks")
            return "retried_busy" if retried else "indexed"
        if status == "failed":
            # A 503 from our bounded embedding endpoint is transient; unknown
            # parsing failures must not be retried indefinitely or silently skipped.
            message = (data.get("error_message") or "").lower()
            if (allow_reparse and not retried and "503" in message and "busy" in message):
                submitted = client.request(
                    "POST", f"/knowledge/{checked_id(knowledge_id)}/reparse", b"", None,
                )
                if submitted.get("success") is not True:
                    raise RuntimeError("reparse_rejected")
                retried = True
            else:
                raise RuntimeError("parse_failed")
        elif status not in {"pending", "processing", "finalizing"}:
            raise RuntimeError("unexpected_parse_status")
        time.sleep(interval)
    raise RuntimeError("index_timeout")


def server_provenance(client, page_size: int = 1000, restarts: int = 8) -> dict[tuple[str, str, str, str], str]:
    """Find accepted uploads before retrying an ambiguous HTTP failure.

    WeKnora lists newest first. Other importers may add documents while this
    list is paged; a growing total only shifts rows later, so rows are re-seen
    rather than missed. Deleting replaced versions shrinks it and can skip
    rows, so a shrinking total restarts the scan.
    """
    for _ in range(restarts + 1):
        found = scan_provenance(client, page_size)
        if found is not None:
            return found
    raise RuntimeError("invalid_knowledge_list")


def scan_provenance(client, page_size: int) -> dict[tuple[str, str, str, str], str] | None:
    found = {}
    total = None
    for page in range(1, 1_000_000 // page_size + 2):
        result = client.request(
            "GET", f"/knowledge-bases/{urllib.parse.quote(client.kb, safe='')}"
                   f"/knowledge?page={page}&page_size={page_size}",
        )
        rows = result.get("data")
        count = result.get("total")
        if (not isinstance(rows, list) or type(count) is not int or count < 0
                or count > 1_000_000):
            raise RuntimeError("invalid_knowledge_list")
        if total is not None and count < total:
            return None
        total = count
        for row in rows:
            if not isinstance(row, dict) or row.get("knowledge_base_id") != client.kb:
                raise RuntimeError("knowledge_scope_mismatch")
            meta = row.get("metadata")
            if not isinstance(meta, dict) or meta.get("source") != "public-course-sharing":
                continue
            key = tuple(meta.get(field) for field in (
                "item_id", "source_sha256", "canonical_hash", "source_url",
            ))
            if any(not isinstance(value, str) or not value for value in key):
                continue
            identifier = row.get("id")
            checked_id(identifier)
            if key in found and found[key] != identifier:
                raise RuntimeError("duplicate_provenance")
            found[key] = identifier
        if len(rows) + (page - 1) * page_size >= count:
            return found
        if not rows:
            raise RuntimeError("invalid_knowledge_list")
    raise RuntimeError("knowledge_list_limit")


def source_key(relative: str, url: str, body: str) -> tuple[str, str, str, str]:
    match = importer.PATH_RE.fullmatch(relative)
    if not match:
        raise ValueError("invalid_ocr_path")
    return match["item"], match["sha"], hashlib.sha256(body.encode("utf-8")).hexdigest(), url


def feed(args: argparse.Namespace) -> Counter:
    if args.batch_size < 1 or args.batch_size > 3 or args.max_new < 1:
        raise ValueError("invalid_feed_limit")
    if args.bootstrap.stat().st_mode & 0o077:
        raise ValueError("unsafe_bootstrap_permissions")
    config = json.loads(args.bootstrap.read_text(encoding="utf-8"))
    client = importer.WeKnora(
        args.base_url, config["import_api_key"], config["knowledge_base_id"]
    )
    source_map = json.loads(args.source_map.read_text(encoding="utf-8"))
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        manifest = {}
    if not isinstance(source_map, dict) or not isinstance(manifest, dict):
        raise ValueError("invalid_feed_checkpoint")
    counts = Counter()
    candidates = []
    outstanding = []
    accepted = server_provenance(client)
    seen_content = {key[2] for key in accepted}
    for relative, value in sorted(source_map.items()):
        if len(candidates) >= args.max_new:
            break
        try:
            url = importer.public_url(value)
            body, _ = importer.select_body(
                args.staging, args.raw_repo, args.repaired, relative,
                getattr(args, "prepared_office_dir", None),
            )
            key = source_key(relative, url, body)
            categories = importer.llm_script().scan_privacy(
                urllib.parse.unquote(urllib.parse.urlsplit(url).path)
            )
            if any(category != "phone" for category in categories):
                raise ValueError("privacy_blocked")
            previous = manifest.get(relative)
            if previous is not None:
                if (not isinstance(previous, dict)
                        or previous.get("knowledge_base_id") != client.kb
                        or previous.get("source_url") != url
                        or previous.get("canonical_hash") != key[2]
                        or accepted.get(key) != previous.get("knowledge_id")):
                    raise RuntimeError("checkpoint_mismatch")
                outstanding.append(previous["knowledge_id"])
                counts["already_uploaded"] += 1
            elif key in accepted:
                identifier = accepted[key]
                manifest[relative] = {
                    "knowledge_base_id": client.kb, "knowledge_id": identifier,
                    "canonical_hash": key[2], "source_url": url,
                }
                importer.save_manifest(args.manifest, manifest)
                outstanding.append(identifier)
                counts["recovered_upload"] += 1
            elif key[2] in seen_content:
                # WeKnora rejects a second copy of the same Markdown with 409.
                # Do not claim this distinct source URL was uploaded.
                counts["duplicate_content_deferred"] += 1
            else:
                candidates.append((relative, url, key))
                seen_content.add(key[2])
        except ValueError as error:
            # Categories only. Never print or persist private paths or text.
            reason = str(error)
            counts["deferred_" + reason if reason in {
                "invalid_ocr_provenance", "invalid_repair", "repair_required",
                "privacy_blocked", "missing_original_attachment",
                "missing_or_unsafe_ocr_file", "invalid_source_url",
            } else "deferred_other"] += 1
    for knowledge_id in outstanding:
        wait_for_index(client, knowledge_id, args.timeout, args.poll, allow_reparse=False)
    counts["existing_indexed"] = len(outstanding)
    for start in range(0, len(candidates), args.batch_size):
        group = candidates[start:start + args.batch_size]
        for relative, url, key in group:
            importer.save_manifest(args.batch_map, {relative: url})
            batch_args = argparse.Namespace(
                staging=args.staging, raw_repo=args.raw_repo, repaired=args.repaired,
                prepared_office_dir=getattr(args, "prepared_office_dir", None),
                source_map=args.batch_map, manifest=args.manifest,
                knowledge_base_id=client.kb, dry_run=False, limit=0,
            )
            skipped_duplicate = False
            for attempt in range(3):
                result = importer.import_documents(batch_args, client)
                if result == {"uploaded": 1}:
                    counts["uploaded"] += 1
                    break
                if result != {"deferred_weknora_request_failed": 1}:
                    raise RuntimeError("upload_batch_incomplete")
                # The server may have committed the upload before the connection
                # failed. Check exact provenance before ever issuing another POST.
                time.sleep(5)
                accepted = server_provenance(client)
                if key in accepted:
                    checkpoint = (json.loads(args.manifest.read_text(encoding="utf-8"))
                                  if args.manifest.is_file() else {})
                    checkpoint[relative] = {
                        "knowledge_base_id": client.kb,
                        "knowledge_id": accepted[key],
                        "canonical_hash": key[2], "source_url": url,
                    }
                    importer.save_manifest(args.manifest, checkpoint)
                    counts["recovered_upload"] += 1
                    break
                if any(existing[2] == key[2] for existing in accepted):
                    counts["duplicate_content_deferred"] += 1
                    skipped_duplicate = True
                    break
                if attempt == 2:
                    raise RuntimeError("upload_batch_incomplete")
            if skipped_duplicate:
                # A racing writer inserted identical content under another
                # source; there is no exact upload to index for this source.
                continue
            checkpoint = json.loads(args.manifest.read_text(encoding="utf-8"))
            if checkpoint[relative]["knowledge_base_id"] != client.kb:
                raise RuntimeError("checkpoint_mismatch")
            outcome = wait_for_index(client, checkpoint[relative]["knowledge_id"],
                                     args.timeout, args.poll)
            counts[outcome] += 1
        print(json.dumps({"event": "ocr_weknora_feed_batch",
                          "counts": {key: counts[key] for key in
                                     ("uploaded", "indexed", "retried_busy")}}), flush=True)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap", type=Path, default=LOCAL / "weknora-bootstrap-local.json")
    parser.add_argument("--base-url", default="http://127.0.0.1:18181")
    parser.add_argument("--source-map", type=Path, default=LOCAL / "ocr-course-source-map.json")
    parser.add_argument("--manifest", type=Path,
                        default=LOCAL / "ocr-weknora-import-manifest-embedding.json")
    parser.add_argument("--batch-map", type=Path, default=LOCAL / "ocr-weknora-active-batch.json")
    parser.add_argument("--staging", type=Path, default=LOCAL / "production-stage")
    parser.add_argument("--raw-repo", type=Path, default=LOCAL / "production-raw")
    parser.add_argument("--repaired", type=Path, default=LOCAL / "production-repaired-max-all")
    parser.add_argument("--prepared-office-dir", type=Path, default=LOCAL / "office-prepared")
    parser.add_argument("--batch-size", type=int, default=3)
    parser.add_argument("--max-new", type=int, default=60)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--poll", type=int, default=3)
    args = parser.parse_args()
    if args.timeout < 10 or args.poll < 1 or args.batch_map.resolve() == args.manifest.resolve():
        parser.error("invalid feed settings")
    counts = feed(args)
    print(json.dumps({"event": "ocr_weknora_feed_done", "counts": dict(counts)}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError, KeyError, TypeError) as error:
        # Fail without leaking document names, content or upstream error bodies.
        reason = str(error)
        allowed = {
            "knowledge_scope_mismatch", "completed_without_chunks", "parse_failed",
            "unexpected_parse_status", "index_timeout", "checkpoint_mismatch",
            "upload_batch_incomplete", "invalid_feed_limit", "invalid_feed_checkpoint",
            "unsafe_bootstrap_permissions", "invalid_knowledge_id", "reparse_rejected",
            "invalid_knowledge_list", "duplicate_provenance", "knowledge_list_limit",
        }
        print(json.dumps({"event": "ocr_weknora_feed_failed",
                          "reason": reason if reason in allowed else "feed_error"}))
        sys.exit(1)
