#!/usr/bin/env python3
"""Report only the Colab runtime capabilities needed by the OCR worker."""

import json
import subprocess
import sys


def main() -> None:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    print(json.dumps({
        "python": sys.version.split()[0],
        "gpu": result.stdout.strip() if result.returncode == 0 else None,
        "nvidia_smi_exit": result.returncode,
    }))


if __name__ == "__main__":
    main()
