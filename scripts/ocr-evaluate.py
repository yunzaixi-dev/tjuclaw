#!/usr/bin/env python3
"""Evaluate OCR Markdown against human-reviewed public-source reference fields."""

from __future__ import annotations

import argparse
import html
import json
import re
import unicodedata
from pathlib import Path


def normalize(text: str) -> str:
    value = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\s|:：,，;；、—–\-]+", "", value)


def score(markdown: str, reference: dict) -> dict:
    expected = reference["keywords"]
    rows = reference["rows"]
    if not isinstance(expected, list) or not isinstance(rows, list) or not expected or not rows:
        raise ValueError("invalid_reference")
    if not all(isinstance(word, str) and word.strip() for word in expected):
        raise ValueError("invalid_reference")
    if not all(isinstance(row, list) and len(row) >= 2 and
               all(isinstance(cell, str) and cell.strip() for cell in row) for row in rows):
        raise ValueError("invalid_reference")
    body = normalize(markdown)
    html_rows = [normalize(html.unescape(re.sub(r"<[^>]*>", " ", row))) for row in
                 re.findall(r"<tr\b[^>]*>.*?</tr>", markdown, re.IGNORECASE | re.DOTALL)]
    lines = [normalize(line) for line in markdown.splitlines()
             if line.strip() and not re.search(r"<table\b", line, re.IGNORECASE)] + html_rows
    hits = [word for word in expected if normalize(word) in body]
    row_hits = [row for row in rows if any(
        all(normalize(cell) in line for cell in row) for line in lines
    )]
    return {
        "keyword_recall": round(len(hits) / len(expected), 4),
        "row_recall": round(len(row_hits) / len(rows), 4),
        "keyword_hits": len(hits),
        "row_hits": len(row_hits),
        "keyword_total": len(expected),
        "row_total": len(rows),
        "characters": len(markdown),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    reference = json.loads(args.reference.read_text(encoding="utf-8"))
    result = score(args.candidate.read_text(encoding="utf-8"), reference)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
