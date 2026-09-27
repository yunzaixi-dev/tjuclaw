#!/usr/bin/env python3
"""Manage the supported PaddleOCR vLLM service inside a private Colab runtime."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

MODEL = "PaddleOCR-VL-1.6-0.9B"
MODEL_REPOSITORY = "PaddlePaddle/PaddleOCR-VL-1.6"
MODEL_REVISION = "c5630abae1d940eafe0697512a0325494b02ab42"
VLLM_VERSION = "0.14.0"
SERVER_URL = "http://127.0.0.1:8118/v1"
CONFIG = {
    "gpu-memory-utilization": 0.5,
    "max-model-len": 16384,
    "max-num-seqs": 4,
    "max-num-batched-tokens": 16384,
    "enforce-eager": True,
    "enable-prefix-caching": False,
    "mm-processor-cache-gb": 0,
}


def server_ready() -> bool:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(SERVER_URL + "/models", timeout=3) as response:
            result = json.loads(response.read(16_385))
        return (isinstance(result, dict) and isinstance(result.get("data"), list)
                and any(isinstance(item, dict) and item.get("id") == MODEL
                        for item in result["data"]))
    except (OSError, ValueError, urllib.error.URLError):
        return False


def dependency_diagnostics(root: Path) -> dict:
    log_path = root / "tjuclaw-vllm-install.log"
    text = log_path.read_text(errors="replace")[-200_000:] if log_path.exists() else ""
    patterns = {
        "no_matching_distribution": "No matching distribution found",
        "dependency_conflict": "ResolutionImpossible",
        "build_failed": "Failed building wheel",
        "disk_full": "No space left on device",
        "unsupported_python": "Unsupported Python",
        "cuda_missing": "CUDA_HOME",
    }
    packages = re.findall(r"No matching distribution found for ([A-Za-z0-9_.-]+)", text)
    return {"categories": [key for key, value in patterns.items() if value in text],
            "unavailable_packages": sorted(set(packages))}


def ensure_dependencies(python: Path, root: Path) -> Path:
    # PaddleX pins an older vLLM and installs additional compiled plugins.
    # Keep the native layout pipeline separate from the vLLM model server.
    server_python = root / "tjuclaw-vllm-venv/bin/python"
    (root / "tjuclaw-vllm-diagnostics.json").unlink(missing_ok=True)
    if not server_python.is_file():
        subprocess.run(
            [sys.executable, "-m", "virtualenv", str(server_python.parent.parent)],
            capture_output=True, timeout=120, check=True,
        )
    check = subprocess.run(
        [str(server_python), "-c",
         "import importlib.metadata as m; "
         f"raise SystemExit(0 if m.version('vllm') == '{VLLM_VERSION}' else 1)"],
        capture_output=True, timeout=60, check=False,
    )
    if check.returncode == 0:
        return server_python
    environment = {**os.environ,
                   "PATH": f"{server_python.parent}:{os.environ.get('PATH', '')}"}
    with (root / "tjuclaw-vllm-install.log").open("w") as log:
        try:
            installed = subprocess.run(
                [str(server_python), "-m", "pip", "install", "--disable-pip-version-check",
                 "--only-binary=:all:", f"vllm=={VLLM_VERSION}"],
                env=environment, stdout=log, stderr=subprocess.STDOUT,
                timeout=2400, check=False,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("vllm_install_timeout") from None
    if installed.returncode:
        (root / "tjuclaw-vllm-diagnostics.json").write_text(
            json.dumps(dependency_diagnostics(root)), encoding="utf-8")
        raise RuntimeError(f"vllm_install_failed:{installed.returncode}")
    return server_python


def server_command(python: Path) -> list[str]:
    command = [
        str(python), "-m", "vllm.entrypoints.openai.api_server",
        "--model", MODEL_REPOSITORY, "--revision", MODEL_REVISION,
        "--trust-remote-code", "--served-model-name", MODEL,
        "--host", "127.0.0.1", "--port", "8118",
    ]
    for key, value in CONFIG.items():
        if isinstance(value, bool):
            command.append(f"--{'no-' if not value else ''}{key}")
        else:
            command.extend([f"--{key}", str(value)])
    return command


def terminate_server(process) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=15)


@contextmanager
def inference_server(python: Path, root: Path):
    server_python = ensure_dependencies(python, root)
    if server_ready():
        # A leftover listener must not be mistaken for this worker's server.
        raise RuntimeError("vllm_port_already_in_use")
    configuration = root / "tjuclaw-vllm-config.json"
    configuration.write_text(json.dumps(CONFIG), encoding="utf-8")
    environment = {
        **os.environ, "PATH": f"{server_python.parent}:{os.environ.get('PATH', '')}",
        "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
        "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
    }
    with (root / "tjuclaw-vllm-server.log").open("a") as log:
        process = subprocess.Popen(
            server_command(server_python),
            env=environment, stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True,
        )
    try:
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"vllm_server_failed:{process.returncode}")
            if server_ready():
                yield SERVER_URL
                return
            time.sleep(3)
        raise RuntimeError("vllm_server_start_timeout")
    finally:
        terminate_server(process)
