#!/usr/bin/env python3
"""Process a bounded bundle of vetted public PDFs in one Colab session."""

from __future__ import annotations

import hashlib
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time

ROOT = Path("/content")
INPUT_ARCHIVE = ROOT / "tjuclaw-ocr-batch.tar.gz"
RAW = ROOT / "tjuclaw-ocr-batch-raw"
STAGE = ROOT / "tjuclaw-ocr-batch-stage"
RESULTS = ROOT / "tjuclaw-ocr-batch-results"
REPORT = ROOT / "tjuclaw-ocr-batch-report.json"
METRICS = ROOT / "tjuclaw-ocr-batch-metrics.json"
MAX_INPUT_BYTES = 120_000_000


def ocr_timeout_seconds() -> int:
    value = int(os.environ.get("TJUCLAW_OCR_DOCUMENT_TIMEOUT_SECONDS", "600"))
    if not 600 <= value <= 1200:
        raise ValueError("invalid_ocr_document_timeout")
    return value


def repetition_penalty() -> float:
    value = float(os.environ.get("TJUCLAW_OCR_REPETITION_PENALTY", "1.0"))
    if not 1.0 <= value <= 1.5:
        raise ValueError("invalid_ocr_repetition_penalty")
    return value


def inference_backend() -> str:
    value = os.environ.get("TJUCLAW_OCR_BACKEND", "native")
    if value not in {"native", "vllm-server"}:
        raise ValueError("invalid_inference_backend")
    return value


def load_server():
    spec = importlib.util.spec_from_file_location(
        "ocr_colab_inference", ROOT / "ocr-colab-inference.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("missing_inference_helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_backfill():
    spec = importlib.util.spec_from_file_location("ocr_backfill", ROOT / "ocr-backfill.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("missing_backfill")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_input(archive_path: Path, raw: Path, backfill) -> list[dict]:
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        manifest_members = [member for member in members if member.name == "manifest.json"]
        if len(manifest_members) != 1 or not manifest_members[0].isfile():
            raise ValueError("invalid_manifest")
        stream = archive.extractfile(manifest_members[0])
        if stream is None or manifest_members[0].size > 100_000:
            raise ValueError("invalid_manifest")
        manifest = json.loads(stream.read())
        if not isinstance(manifest, list) or not 1 <= len(manifest) <= 8:
            raise ValueError("invalid_manifest")
        sources = {}
        for record in manifest:
            if not isinstance(record, dict) or set(record) not in (
                    {"source", "sha256", "size"},
                    {"source", "sha256", "size", "input", "original_sha256"}):
                raise ValueError("invalid_manifest_record")
            source, digest, size = record["source"], record["sha256"], record["size"]
            converted = "input" in record
            input_path = record.get("input", source)
            if (
                not isinstance(source, str) or not backfill.RAW_PATH_RE.fullmatch(source)
                or not source.startswith("sources/course/public-course-sharing/")
                or (Path(source).suffix.lower() not in backfill.OFFICE_SUFFIXES
                    if converted else not source.endswith(".pdf"))
                or not isinstance(input_path, str)
                or input_path != (Path(source).with_suffix(".pdf").as_posix()
                                  if converted else source)
                or not isinstance(digest, str) or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)
                or type(size) is not int or not 0 < size <= 50_000_000
                or input_path in sources
            ):
                raise ValueError("invalid_source")
            if converted:
                original_digest = record["original_sha256"]
                if (not isinstance(original_digest, str) or len(original_digest) != 64
                        or any(character not in "0123456789abcdef"
                               for character in original_digest)):
                    raise ValueError("invalid_original_digest")
            sources[input_path] = record
        if len(members) != len(sources) + 1:
            raise ValueError("unexpected_archive_member")
        total = 0
        for member in members:
            if member.name == "manifest.json":
                continue
            name = PurePosixPath(member.name)
            if (member.name not in sources or name.is_absolute() or ".." in name.parts
                    or not member.isfile() or member.size != sources[member.name]["size"]):
                raise ValueError("unsafe_archive_member")
            total += member.size
            if total > MAX_INPUT_BYTES:
                raise ValueError("input_too_large")
            target = raw.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("missing_input")
            digest = hashlib.sha256()
            with stream, target.open("xb") as output:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != sources[member.name]["sha256"]:
                raise ValueError("input_checksum_mismatch")
    return manifest


def ensure_environment() -> Path:
    venv = ROOT / "tjuclaw-ocr-venv"
    python = venv / "bin/python"
    if not python.is_file():
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "virtualenv"],
            check=True, timeout=180, stdout=subprocess.DEVNULL,
        )
        subprocess.run(
            [sys.executable, "-m", "virtualenv", str(venv)],
            check=True, timeout=120, stdout=subprocess.DEVNULL,
        )
    installed = subprocess.run(
        [str(python), "-c",
         "import importlib.metadata as m; import paddle; import paddleocr; "
         "raise SystemExit(0 if m.version('paddlepaddle-gpu') == '3.3.0' "
         "and m.version('paddleocr') == '3.7.0' else 1)"],
        capture_output=True, check=False, timeout=50,
    )
    if installed.returncode:
        commands = (
            ("install_paddle", [
                str(python), "-m", "pip", "install", "--disable-pip-version-check",
                "--only-binary=:all:", "--no-deps", "--index-url",
                "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
                "paddlepaddle-gpu==3.3.0",
            ]),
            ("install_ocr_dependencies", [
                str(python), "-m", "pip", "install", "--disable-pip-version-check",
                "--index-url", "https://pypi.org/simple",
                "paddlepaddle-gpu==3.3.0", "paddleocr[doc-parser]==3.7.0",
            ]),
        )
        # Do not probe Paddle's specialized index for every unrelated dependency.
        for phase, command in commands:
            METRICS.write_text(json.dumps({"event": "worker_phase", "phase": phase}),
                               encoding="utf-8")
            with (ROOT / f"tjuclaw-{phase}.log").open("w") as log:
                result = subprocess.run(
                    command, stdout=log, stderr=subprocess.STDOUT,
                    check=False, timeout=1200,
                )
            if result.returncode:
                raise RuntimeError(f"ocr_install_failed:{result.returncode}")
    return python


def failure_categories(worker_output: str) -> dict[str, str]:
    failures = {}
    for line in worker_output.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict) or event.get("event") != "ocr_failed":
            continue
        source = event.get("source_path")
        if not isinstance(source, str):
            continue
        error = str(event.get("error", "")).lower()
        if "out of memory" in error or "resourceexhausted" in error:
            category = "gpu_oom"
        elif "generation_loop" in error:
            category = "generation_loop"
        elif "timeout" in error:
            category = "timeout"
        elif "office_conversion" in error:
            category = "conversion"
        else:
            category = "other"
        failures[source] = category
    return failures


def gpu_sample() -> dict:
    try:
        result = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        values = [int(value.strip()) for value in result.stdout.strip().split(",")]
        if result.returncode or len(values) != 3:
            return {}
        utilization, used, total = values
        if not 0 <= utilization <= 100 or not 0 <= used <= total:
            return {}
        return {"utilization_percent": utilization,
                "memory_used_mib": used, "memory_total_mib": total}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}


def monitor_gpu(stop: threading.Event, started: float, path: Path) -> None:
    samples = []
    peak_memory = 0
    while True:
        current = gpu_sample()
        if current:
            samples.append(current["utilization_percent"])
            peak_memory = max(peak_memory, current["memory_used_mib"])
        state = {
            "event": "gpu_metrics", "elapsed_seconds": round(time.monotonic() - started, 1),
            "samples": len(samples),
            "average_utilization_percent": round(sum(samples) / len(samples), 1)
            if samples else None,
            "peak_memory_used_mib": peak_memory, "current": current,
        }
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state), encoding="utf-8")
        temporary.replace(path)
        if stop.wait(10):
            break


def run_pipeline(args: list[str], timeout: int) -> tuple[str, bool]:
    """Keep completed staged results even when the final document times out."""
    try:
        result = subprocess.run(
            args, timeout=timeout, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, check=False,
            env={**os.environ, "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
                 "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"},
        )
        return result.stdout, False
    except subprocess.TimeoutExpired as error:
        partial = error.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="replace")
        return partial, True


def failure_status(error: Exception) -> dict:
    status = {"event": "worker_failed", "error_type": type(error).__name__}
    detail = str(error)
    if re.fullmatch(
            r"(?:vllm_install_failed|vllm_server_failed|ocr_install_failed):-?\d+"
            r"|vllm_(?:install_timeout|server_start_timeout|port_already_in_use)", detail):
        status["reason"] = detail
    diagnostics = ROOT / "tjuclaw-vllm-diagnostics.json"
    if diagnostics.is_file():
        try:
            value = json.loads(diagnostics.read_text())
            allowed = {"no_matching_distribution", "dependency_conflict", "build_failed",
                       "disk_full", "unsupported_python", "cuda_missing"}
            if (isinstance(value, dict) and isinstance(value.get("categories"), list)
                    and all(isinstance(item, str) and item in allowed
                            for item in value["categories"])):
                status["dependency_categories"] = value["categories"]
        except (OSError, ValueError):
            pass
    return status


def main() -> None:
    document_timeout = ocr_timeout_seconds()
    penalty = repetition_penalty()
    backend = inference_backend()
    backfill = load_backfill()
    if RAW.exists():
        shutil.rmtree(RAW)
    if STAGE.exists():
        shutil.rmtree(STAGE)
    if RESULTS.exists():
        shutil.rmtree(RESULTS)
    REPORT.unlink(missing_ok=True)
    METRICS.write_text(json.dumps({"event": "worker_phase", "phase": "prepare_input"}),
                       encoding="utf-8")
    RAW.mkdir()
    STAGE.mkdir()
    RESULTS.mkdir()
    manifest = prepare_input(INPUT_ARCHIVE, RAW, backfill)
    input_list = ROOT / "tjuclaw-ocr-batch-input.txt"
    input_list.write_text("\n".join(record.get("input", record["source"])
                                   for record in manifest) + "\n", encoding="utf-8")
    METRICS.write_text(json.dumps({"event": "worker_phase", "phase": "install_environment"}),
                       encoding="utf-8")
    python = ensure_environment()
    server = nullcontext(None)
    if backend == "vllm-server":
        METRICS.write_text(json.dumps({"event": "worker_phase", "phase": "prepare_vllm"}),
                           encoding="utf-8")
        server = load_server().inference_server(python, ROOT)
    with server as server_url:
        command = [
            str(python), str(ROOT / "ocr-backfill.py"),
            "--raw-repo", str(RAW), "--staging", str(STAGE),
            "--input-list", str(input_list), "--preserve-valid-stage",
            "--page-batch-size", "4" if server_url else "1", "--max-pixels", "940800",
            "--repetition-penalty", str(penalty),
            "--document-timeout-seconds", str(document_timeout),
        ]
        if server_url:
            command.extend(["--vl-rec-backend", "vllm-server",
                            "--vl-rec-server-url", server_url,
                            "--vl-rec-max-concurrency", "4"])
        started = time.monotonic()
        stop = threading.Event()
        monitor = threading.Thread(target=monitor_gpu, args=(stop, started, METRICS), daemon=True)
        monitor.start()
        try:
            worker_output, timed_out = run_pipeline(
                command, timeout=(document_timeout + 60) * len(manifest) + 60)
        finally:
            stop.set()
            monitor.join(timeout=15)
    failures = failure_categories(worker_output)
    report = []
    for record in manifest:
        source = record["source"]
        input_source = record.get("input", source)
        output = STAGE / Path(input_source).with_suffix(".md")
        valid = backfill.staged_with_provenance(
            output, input_source, backfill.RAW_PATH_RE.fullmatch(source).group("sha256")
        )
        if valid and "input" in record:
            body = output.read_text(encoding="utf-8").partition("-->\n\n")[2]
            if not body:
                raise ValueError("missing_converted_body")
            backfill.atomic_write(output, backfill.provenance(
                source, backfill.RAW_PATH_RE.fullmatch(source).group("sha256"),
                940800, backend, "gpu:0", penalty,
                conversion={
                    "converter": "isolated-libreoffice",
                    "original_sha256": record["original_sha256"],
                    "pdf_sha256": record["sha256"],
                }) + body)
        identifier = hashlib.sha256(source.encode()).hexdigest()
        if valid:
            with tarfile.open(RESULTS / f"{identifier}.tar.gz", "w:gz") as archive:
                archive.add(output, arcname=output.relative_to(STAGE).as_posix())
                assets = output.with_suffix(".assets")
                if assets.is_dir():
                    archive.add(assets, arcname=assets.relative_to(STAGE).as_posix())
        report.append({
            "id": identifier, "ok": valid,
            "reason": None if valid else failures.get(
                input_source, "timeout" if timed_out else "unknown"),
        })
    REPORT.write_text(json.dumps(report), encoding="utf-8")
    print(json.dumps({"event": "colab_batch", "total": len(manifest),
                      "completed": sum(item["ok"] for item in report),
                      "backend": backend, "timed_out": timed_out}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        status = failure_status(error)
        METRICS.write_text(json.dumps(status), encoding="utf-8")
        print(json.dumps(status), flush=True)
        raise
