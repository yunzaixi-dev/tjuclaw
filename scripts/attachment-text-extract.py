#!/usr/bin/env python3
"""Extract text from website/wiki attachments that already carry a text layer.

Office documents and text PDFs need no OCR. Each attachment in the raw crawler
mirror is content-addressed (its file name is the SHA-256 of its bytes); the
extracted text is written to a separate tree at the same relative path plus
".md", where the offline injector pairs it with the parent article. Saved error
pages, images and scanned PDFs are skipped and counted; they wait for OCR.
Logs carry only aggregate counts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

PATH = re.compile(
    r"^sources/(wiki|website)/[A-Za-z0-9_-]+/[^/.][^/]*/[a-f0-9]{64}\.attachments/([a-f0-9]{64})(\.[A-Za-z0-9]+)?$")
MAX_INPUT = 20 * 1024 * 1024
MAX_TEXT = 1024 * 1024
MIN_TEXT = 40
MAX_ROWS = 2000


def kind_of(data: bytes) -> str:
    head = data[:8]
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"PK\x03\x04"):
        # OOXML is a zip; the content types part names the document family.
        if b"word/" in data[:65536]:
            return "docx"
        if b"xl/" in data[:65536]:
            return "xlsx"
        return "zip"
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        # Legacy OLE compound file: Word and Excel share the container.
        return "xls" if b"W\x00o\x00r\x00k\x00b\x00o\x00o\x00k" in data or b"Workbook" in data else "doc"
    if head[:4] in (b"\x89PNG", b"GIF8") or head[:3] == b"\xff\xd8\xff" or data[8:12] == b"WEBP":
        return "image"
    return "other"


def clean(text: str) -> str:
    lines = [re.sub(r"[ \t　\xa0]+", " ", line).strip() for line in text.replace("\r", "").split("\n")]
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip().replace("\x0c", "\n")


LIBREOFFICE_IMAGE = os.environ.get("TJUCLAW_LIBREOFFICE_IMAGE", "tjuclaw-ocr-libreoffice:local")


def soffice(work: Path, source: Path, target: str) -> Path | None:
    """Convert inside the network-less, read-only LibreOffice container
    (scripts/ocr-libreoffice.Dockerfile), falling back to a host soffice."""
    output = work / "out"
    output.mkdir(exist_ok=True)
    if shutil.which("docker"):
        command = [
            "docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "2g",
            "--memory-swap", "2g", "--cpus", "2", "--user", f"{os.getuid()}:{os.getgid()}",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m",
            "--mount", f"type=bind,src={source},dst=/input/{source.name},readonly",
            "--mount", f"type=bind,src={output},dst=/output",
            LIBREOFFICE_IMAGE, "--convert-to", target, "--outdir", "/output", f"/input/{source.name}",
        ]
    else:
        command = ["soffice", f"-env:UserInstallation={(work / 'profile').as_uri()}", "--headless",
                   "--convert-to", target, "--outdir", str(output), str(source)]
    try:
        subprocess.run(command, check=True, timeout=300, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.SubprocessError, OSError):
        return None
    produced = sorted(output.glob("*"))
    return produced[0] if produced else None


def pdf_text(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf") as handle:
        handle.write(data)
        handle.flush()
        try:
            result = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", handle.name, "-"],
                                    capture_output=True, timeout=120, check=True)
        except (subprocess.SubprocessError, OSError):
            return ""
    return result.stdout.decode("utf-8", "replace")


def sheet_markdown(path: Path) -> str:
    import openpyxl  # Provided by the uv run wrapper; only needed for spreadsheets.

    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    parts: list[str] = []
    for sheet in book.worksheets:
        rows = []
        for row in sheet.iter_rows(values_only=True):
            cells = ["" if value is None else str(value).replace("|", "／").replace("\n", " ").strip() for value in row]
            while cells and not cells[-1]:
                cells.pop()
            if any(cells):
                rows.append(cells)
            if len(rows) >= MAX_ROWS:
                break
        if not rows:
            continue
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        parts.append(f"## {sheet.title}\n")
        parts.append("| " + " | ".join(rows[0]) + " |")
        parts.append("|" + " --- |" * width)
        parts.extend("| " + " | ".join(row) + " |" for row in rows[1:])
        parts.append("")
    return "\n".join(parts)


def extract(data: bytes, kind: str) -> str:
    if kind == "pdf":
        return clean(pdf_text(data))
    # Temporary copies of attachments never outlive the extraction.
    with tempfile.TemporaryDirectory(prefix="tju-attach-") as directory:
        work = Path(directory)
        source = work / f"in.{kind}"
        source.write_bytes(data)
        if kind in ("docx", "doc"):
            produced = soffice(work, source, "txt:Text (encoded):UTF8")
            return clean(produced.read_text("utf-8", "replace")) if produced else ""
        if kind in ("xlsx", "xls"):
            path = soffice(work, source, "xlsx") if kind == "xls" else source
            if not path:
                return ""
            try:
                return sheet_markdown(path).strip()
            except Exception:  # noqa: BLE001 - a malformed workbook is skipped, not fatal.
                return ""
    return ""


def run(raw: Path, out: Path, limit: int = 0) -> dict[str, int]:
    counts = {"extracted": 0, "unchanged": 0, "html": 0, "image": 0, "scanned_or_empty": 0,
              "unsupported": 0, "provenance_mismatch": 0}
    raw = raw.resolve()
    out = out.resolve()
    done = 0
    for kind_dir in ("website", "wiki"):
        for path in sorted((raw / "sources" / kind_dir).glob("**/*.attachments/*")):
            rel = path.relative_to(raw).as_posix()
            match = PATH.match(rel)
            if not match or path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INPUT:
                counts["unsupported"] += 1
                continue
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != match.group(2):
                counts["provenance_mismatch"] += 1
                continue
            target = out / (rel + ".md")
            if target.exists():
                counts["unchanged"] += 1
                continue
            kind = kind_of(data)
            if kind == "other" and data.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
                counts["html"] += 1
                continue
            if kind == "image":
                counts["image"] += 1
                continue
            if kind in ("other", "zip"):
                counts["unsupported"] += 1
                continue
            text = extract(data, kind)
            if len(text) < MIN_TEXT:
                counts["scanned_or_empty"] += 1
                continue
            encoded = text.encode("utf-8")[:MAX_TEXT].decode("utf-8", "ignore")
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_name(target.name + f".{os.getpid()}.partial")
            partial.write_text(encoded + "\n", "utf-8")
            partial.replace(target)
            counts["extracted"] += 1
            done += 1
            if limit and done >= limit:
                return counts
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True, help="raw crawler mirror (LFS objects pulled)")
    parser.add_argument("--out", type=Path, required=True, help="extracted text tree, outside the mirrors")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    if args.out.resolve().is_relative_to(args.raw.resolve()):
        parser.error("--out must be outside the raw mirror")
    print(json.dumps({"event": "attachment_text_extract", "counts": run(args.raw, args.out, args.limit)}))


if __name__ == "__main__":
    main()
