#!/usr/bin/env python3
"""Recover OCR citation URLs from the public course catalog, never from filenames."""

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://cs.tjuse.com"
STAGED_PATH = re.compile(
    r"^sources/course/public-course-sharing/[^/\x00]+/"
    r"(?P<item>[a-f0-9]{64})\.attachments/[a-f0-9]{64}\.md$"
)
RAW_PATH = re.compile(
    r"^sources/course/public-course-sharing/[^/\x00]+/"
    r"(?P<item>[a-f0-9]{64})\.attachments/[a-f0-9]{64}"
    r"(?:\.(?:pdf|png|jpe?g|webp|bmp|tiff?|docx?|docm|pptx?|pptm|"
    r"ppsx?|ppsm|xlsx?|xlsm|vsd|odt|ods|odp|md|markdown|txt))?$"
)
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ValueError("catalog_redirect")


def staged_targets(staging: Path, raw_repo: Path | None = None) -> dict[str, list[str]]:
    targets: dict[str, set[str]] = {}
    for file in staging.glob("sources/course/public-course-sharing/**/*.attachments/*.md"):
        relative = file.relative_to(staging).as_posix()
        match = STAGED_PATH.fullmatch(relative)
        if match and file.is_file() and not file.is_symlink():
            targets.setdefault(match["item"], set()).add(relative)
    if raw_repo is not None:
        for file in raw_repo.glob("sources/course/public-course-sharing/**/*.attachments/*"):
            relative = file.relative_to(raw_repo).as_posix()
            match = RAW_PATH.fullmatch(relative)
            if (not match or not file.is_file()
                    or any(parent.is_symlink() for parent in (file, *file.parents)
                           if parent == raw_repo or raw_repo in parent.parents)):
                continue
            output = Path(relative).with_suffix(".md").as_posix()
            if STAGED_PATH.fullmatch(output):
                targets.setdefault(match["item"], set()).add(output)
    return {item: sorted(paths) for item, paths in targets.items()}


def fetch_catalog(path: str, cursor: str | None) -> dict:
    query = {"path": path}
    if cursor:
        query["next"] = cursor
    url = BASE_URL + "/api/?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={"User-Agent": "TJUClaw-Catalog-Provenance/1.0"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            data = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
        raise RuntimeError("catalog_request_failed") from None
    if len(data) > MAX_RESPONSE_BYTES:
        raise RuntimeError("catalog_response_too_large")
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise RuntimeError("invalid_catalog_response") from None
    if not isinstance(value, dict):
        raise RuntimeError("invalid_catalog_response")
    return value


def catalog_map(
    staging: Path, fetch=fetch_catalog, max_requests: int = 1000,
    on_progress=None, raw_repo: Path | None = None,
) -> tuple[dict[str, str], dict[str, int]]:
    if max_requests < 1 or max_requests > 10000:
        raise ValueError("invalid_request_limit")
    targets = staged_targets(staging, raw_repo)
    found: dict[str, str] = {}
    pending = deque(["/"])
    visited: set[str] = set()
    requests = 0
    while pending and len(found) < sum(len(paths) for paths in targets.values()):
        folder = pending.popleft()
        if folder in visited:
            continue
        visited.add(folder)
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            if requests >= max_requests:
                raise RuntimeError("catalog_request_limit")
            page = fetch(folder, cursor)
            requests += 1
            entries = page.get("folder")
            entries = entries.get("value") if isinstance(entries, dict) else None
            if not isinstance(entries, list):
                raise RuntimeError("invalid_catalog_response")
            for entry in entries:
                if not isinstance(entry, dict):
                    raise RuntimeError("invalid_catalog_item")
                name = entry.get("name")
                if (not isinstance(name, str) or not name or name in {".", ".."}
                        or "/" in name or "\\" in name or any(ord(ch) < 32 for ch in name)):
                    raise RuntimeError("invalid_catalog_item")
                child = ("" if folder == "/" else folder) + "/" + name
                is_folder = isinstance(entry.get("folder"), dict)
                is_file = isinstance(entry.get("file"), dict)
                if is_folder == is_file:
                    raise RuntimeError("invalid_catalog_item")
                if is_folder:
                    pending.append(child)
                    continue
                item_id = hashlib.sha256(child.encode("utf-8")).hexdigest()
                archive_digest = hashlib.sha256(item_id.encode("utf-8")).hexdigest()
                if archive_digest not in targets:
                    continue
                # This is the same public page path produced by CourseCrawlProvider,
                # never a download URL, authenticated link, or guessed title match.
                source_url = BASE_URL + urllib.parse.quote(child, safe="/")
                for relative in targets[archive_digest]:
                    if relative in found and found[relative] != source_url:
                        raise RuntimeError("conflicting_catalog_source")
                    found[relative] = source_url
            next_cursor = page.get("next")
            if next_cursor is None or next_cursor == "":
                break
            if (not isinstance(next_cursor, str) or len(next_cursor) > 2048
                    or next_cursor in seen_cursors):
                raise RuntimeError("invalid_catalog_cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor
            if on_progress and requests % 25 == 0:
                on_progress(found, {"requests": requests, "matched": len(found),
                                    "targets": sum(len(paths) for paths in targets.values())})
        if on_progress and requests % 25 == 0:
            on_progress(found, {"requests": requests, "matched": len(found),
                                "targets": sum(len(paths) for paths in targets.values())})
    return found, {"requests": requests, "matched": len(found),
                   "targets": sum(len(paths) for paths in targets.values())}


def save_map(output: Path, mapping: dict[str, str]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent,
                                     prefix=".course-map-", delete=False) as stream:
        temporary = Path(stream.name)
        os.chmod(temporary, 0o600)
        json.dump(mapping, stream, ensure_ascii=False, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(output)


def merge_verified_maps(existing: dict, catalog: dict) -> dict[str, str]:
    """Preserve previous citations, but never silently change their public URL."""
    merged: dict[str, str] = {}
    for source in (existing, catalog):
        if not isinstance(source, dict):
            raise ValueError("invalid_catalog_map")
        for relative, url in source.items():
            if not isinstance(relative, str) or not STAGED_PATH.fullmatch(relative):
                raise ValueError("invalid_catalog_path")
            if (not isinstance(url, str) or not url.startswith(BASE_URL + "/")
                    or any(ord(character) < 32 for character in url)
                    or any(character in url for character in "?#")
                    or len(url) > 2048):
                raise ValueError("invalid_catalog_url")
            if relative in merged and merged[relative] != url:
                raise ValueError("conflicting_catalog_source")
            merged[relative] = url
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description="Map staged OCR to authentic public catalog URLs.")
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--raw-repo", type=Path,
                        help="Also verify catalog URLs for raw attachments not yet staged.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-requests", type=int, default=1000)
    args = parser.parse_args()
    if (not args.staging.is_dir() or (args.raw_repo and not args.raw_repo.is_dir())
            or not 1 <= args.max_requests <= 10000):
        parser.error("invalid staging directory or request limit")
    latest: dict[str, str] = {}

    def progress(mapping, counts):
        nonlocal latest
        latest = mapping.copy()
        save_map(args.output, latest)
        print(json.dumps({"event": "course_catalog_progress", **counts}), flush=True)

    try:
        mapping, counts = catalog_map(args.staging, max_requests=args.max_requests,
                                      on_progress=progress, raw_repo=args.raw_repo)
    except RuntimeError as error:
        save_map(args.output, latest)
        print(json.dumps({"event": "course_catalog_stopped", "reason": str(error),
                          "matched": len(latest)}), flush=True)
        return 1
    save_map(args.output, mapping)
    print(json.dumps({"event": "course_catalog_complete", **counts}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
