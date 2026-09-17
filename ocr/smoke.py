#!/usr/bin/env python3
"""Confirm the local GPU can load PaddleOCR-VL 1.6 and read one page."""

from __future__ import annotations

import sys
import time
from pathlib import Path

DEMO_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/imgs/demo_image/paddleocr_vl_demo.png"
OUT_DIR = Path(__file__).resolve().parent / "smoke-out"


def main() -> int:
    import paddle

    device = paddle.device.get_device()
    print(f"paddle={paddle.__version__} device={device} cuda_count={paddle.device.cuda.device_count()}")
    if not device.startswith("gpu"):
        print("expected GPU device", file=sys.stderr)
        return 1
    try:
        props = paddle.device.cuda.get_device_properties(0)
        print(f"gpu={props.name} total_memory_mb={props.total_memory // 1024 // 1024}")
    except Exception as exc:
        print(f"gpu properties unavailable: {exc}")

    from paddleocr import PaddleOCRVL

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pipeline = PaddleOCRVL(pipeline_version="v1.6")
    print("pipeline loaded", flush=True)
    started = time.monotonic()
    results = pipeline.predict(
        DEMO_URL,
        max_new_tokens=256,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_chart_recognition=False,
        use_seal_recognition=False,
    )
    print(f"predict finished in {time.monotonic() - started:.1f}s", flush=True)
    if not results:
        print("no OCR result", file=sys.stderr)
        return 1
    for index, result in enumerate(results):
        markdown_path = OUT_DIR / f"page-{index}.md"
        result.save_to_markdown(save_path=str(markdown_path))
        print(f"wrote {markdown_path}")
        preview = markdown_path.read_text(encoding="utf-8")[:400].strip()
        if preview:
            print(preview)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
