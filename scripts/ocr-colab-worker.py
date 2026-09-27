#!/usr/bin/env python3
"""Process one explicitly selected public attachment inside a Colab GPU VM."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path("/content")
VENV = ROOT / "tjuclaw-ocr-venv"
INPUT = ROOT / "tjuclaw-ocr-input.pdf"
RAW = ROOT / "tjuclaw-ocr-raw"
STAGE = ROOT / "tjuclaw-ocr-stage"
RESULT = ROOT / "tjuclaw-ocr-result.tar.gz"


def main() -> None:
    source = os.environ.get("TJUCLAW_OCR_SOURCE", "")
    spec = importlib.util.spec_from_file_location("ocr_backfill", ROOT / "ocr-backfill.py")
    if not spec or not spec.loader:
        raise RuntimeError("OCR script missing")
    backfill = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backfill)
    if (
        not backfill.RAW_PATH_RE.fullmatch(source)
        or not source.startswith("sources/course/public-course-sharing/")
        or not source.endswith(".pdf")
    ):
        raise ValueError("Expected an explicitly selected public PDF source")
    if not INPUT.is_file() or INPUT.is_symlink():
        raise FileNotFoundError("OCR input missing")

    python = str(VENV / "bin/python")
    healthy = (VENV / "bin/python").exists() and subprocess.run(
        [python, "-m", "pip", "--version"],
        capture_output=True,
        check=False,
        timeout=10,
    ).returncode == 0
    if not healthy:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "virtualenv"],
            check=True, timeout=180, stdout=subprocess.DEVNULL,
        )
        subprocess.run(
            [sys.executable, "-m", "virtualenv", "--clear", str(VENV)],
            check=True, timeout=120, stdout=subprocess.DEVNULL,
        )
    install = subprocess.run(
        [
            python, "-m", "pip", "install", "--disable-pip-version-check",
            "--extra-index-url", "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
            "paddlepaddle-gpu==3.3.0", "paddleocr[doc-parser]==3.7.0",
        ],
        check=False,
        timeout=1200,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if install.returncode:
        diagnostic = "\n".join(install.stdout.splitlines()[-12:])
        raise RuntimeError(f"Package install exited {install.returncode}:\n{diagnostic[-3000:]}")
    target = RAW / source
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(INPUT, target)
    result = subprocess.run(
        [
            python, str(ROOT / "ocr-backfill.py"),
            "--raw-repo", str(RAW), "--staging", str(STAGE),
            "--source", "public-course-sharing", "--limit", "1",
            "--page-batch-size", "1", "--max-pixels", "940800",
            "--document-timeout-seconds", "600",
        ],
        check=False,
        timeout=900,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env={
            **os.environ, "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
            "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
        },
    )
    if result.returncode:
        diagnostic = "\n".join(result.stdout.splitlines()[-12:])
        raise RuntimeError(f"OCR exited {result.returncode}:\n{diagnostic[-3000:]}")
    relative_output = Path(source).with_suffix(".md")
    markdown = STAGE / relative_output
    if not markdown.is_file():
        raise RuntimeError("OCR produced no Markdown")
    with tarfile.open(RESULT, "w:gz") as archive:
        archive.add(markdown, arcname=relative_output.as_posix())
        assets = markdown.with_suffix(".assets")
        if assets.is_dir():
            archive.add(assets, arcname=assets.relative_to(STAGE).as_posix())
    print(f"OCR result ready: {RESULT.name}")


if __name__ == "__main__":
    main()
