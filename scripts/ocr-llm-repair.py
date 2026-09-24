#!/usr/bin/env python3
"""Repair OCR-derived Markdown through an OpenAI-compatible NewAPI endpoint.

The script writes to a separate derived tree. It never modifies the OCR
staging tree in place and rejects responses that look like prompt leakage or
large destructive rewrites.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


MARKER = "<!-- TJUCLAW_OCR_V1"
REPAIR_MARKER = "<!-- TJUCLAW_LLM_REPAIR_V1"
DEFAULT_MODEL = "tju-llm-max"
# tju-llm-max is provisioned with a large context/quota for this workload.
# Keep these high so large course notes are not silently deferred.
DEFAULT_MAX_INPUT = 220_000
DEFAULT_MAX_OUTPUT = 100_000


@dataclass(frozen=True)
class ApiResult:
    content: str
    usage: dict


@dataclass(frozen=True)
class Candidate:
    source: Path
    relative: Path
    body: str
    metadata: dict
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class RepairHistory:
    status: str
    source_sha256: str | None
    log: Path
    line_number: int


SUCCESS_STATUSES = frozenset({"repaired", "existing", "already_repaired"})
RETRYABLE_STATUSES = frozenset({
    "deferred_input_too_large",
    "error",
    "failed",
    "incomplete",
    "rejected",
    "timeout",
})


def safe_relative_path(value: str) -> Path | None:
    path = Path(value)
    if (
        not value
        or path.is_absolute()
        or ".." in path.parts
        or path.suffix.lower() != ".md"
    ):
        return None
    return Path(path.as_posix())


def _split_marker_document(text: str, marker: str) -> tuple[dict, str]:
    if not text.startswith(marker):
        return {}, text
    parts = text.split("-->\n", 1)
    if len(parts) != 2:
        return {}, text
    lines = parts[0].splitlines()
    if len(lines) < 2:
        return {}, parts[1]
    try:
        metadata = json.loads(lines[1])
    except json.JSONDecodeError:
        return {}, parts[1]
    return metadata if isinstance(metadata, dict) else {}, parts[1]


def split_document(text: str) -> tuple[dict, str]:
    return _split_marker_document(text, MARKER)


def split_repair_document(text: str) -> tuple[dict, str]:
    return _split_marker_document(text, REPAIR_MARKER)


def _unescaped_count(text: str, character: str) -> int:
    count = 0
    backslashes = 0
    for value in text:
        if value == "\\":
            backslashes += 1
            continue
        if value == character and backslashes % 2 == 0:
            count += 1
        backslashes = 0
    return count


def _balanced_latex_environments(text: str) -> bool:
    stack: list[str] = []
    for match in re.finditer(r"\\(begin|end)\{([^{}\n]+)\}", text):
        action, name = match.groups()
        if action == "begin":
            stack.append(name)
        elif not stack or stack.pop() != name:
            return False
    return not stack


def repair_reasons(body: str, metadata: dict, source_size: int | None = None) -> tuple[str, ...]:
    reasons: list[str] = []
    if "\ufffd" in body:
        reasons.append("replacement_character")
    if _unescaped_count(body, "$") % 2:
        reasons.append("unbalanced_math_delimiter")
    if not _balanced_latex_environments(body):
        reasons.append("unbalanced_latex_environment")
    if body.count("<table") != body.count("</table>"):
        reasons.append("unbalanced_table")
    if source_size and source_size >= 100_000 and len(body.strip()) < 300:
        reasons.append("large_source_short_output")
    if len(body.strip()) < 100:
        reasons.append("very_short_output")
    return tuple(reasons)


def candidates(staging: Path, raw: Path | None = None, limit: int | None = None) -> list[Candidate]:
    result: list[Candidate] = []
    for source in sorted(staging.rglob("*.md")):
        text = source.read_text(encoding="utf-8", errors="replace")
        metadata, body = split_document(text)
        if not metadata.get("source_path"):
            continue
        source_size = None
        if raw:
            raw_path = raw / metadata["source_path"]
            try:
                source_size = raw_path.stat().st_size
            except OSError:
                pass
        reasons = repair_reasons(body, metadata, source_size)
        if not reasons:
            continue
        result.append(Candidate(source, source.relative_to(staging), body, metadata, reasons))
        if limit and len(result) >= limit:
            break
    return result


def read_input_list(staging: Path, path: Path) -> list[Candidate]:
    result: list[Candidate] = []
    seen: set[Path] = set()
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        item = raw_line.strip()
        if not item or item.startswith("#"):
            continue
        relative = safe_relative_path(item)
        if relative is None:
            raise ValueError(f"invalid input-list path: {item!r}")
        if relative in seen:
            continue
        seen.add(relative)
        source = (staging / relative).resolve()
        if staging.resolve() not in source.parents:
            raise ValueError(f"input-list path escapes staging: {item!r}")
        text = source.read_text(encoding="utf-8", errors="replace")
        metadata, body = split_document(text)
        if not metadata.get("source_path"):
            raise ValueError(f"missing OCR metadata: {item!r}")
        result.append(Candidate(source, relative, body, metadata, repair_reasons(body, metadata)))
    return result


def load_repair_history(paths: list[Path]) -> dict[str, RepairHistory]:
    """Load the latest result for each source path from old and new JSONL logs."""
    history: dict[str, RepairHistory] = {}
    for log in paths:
        if not log.is_file():
            continue
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line_number, line in enumerate(lines, start=1):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or not isinstance(event.get("status"), str):
                continue
            relative = safe_relative_path(str(event.get("source_path", "")))
            if relative is None:
                continue
            status = str(event["status"]).strip().lower()
            source_sha256 = None
            for key in ("source_sha256", "llm_repair_source_sha256", "input_sha256"):
                value = event.get(key)
                if isinstance(value, str) and re.fullmatch(r"[a-fA-F0-9]{64}", value):
                    source_sha256 = value.lower()
                    break
            history[relative.as_posix()] = RepairHistory(
                status=status,
                source_sha256=source_sha256,
                log=log,
                line_number=line_number,
            )
    return history


def candidates_from_history(
    staging: Path,
    raw: Path | None,
    history: dict[str, RepairHistory],
) -> list[Candidate]:
    result: list[Candidate] = []
    for value, record in sorted(history.items()):
        if record.status not in RETRYABLE_STATUSES and record.status not in SUCCESS_STATUSES:
            continue
        relative = safe_relative_path(value)
        if relative is None:
            continue
        source = (staging / relative).resolve()
        if staging.resolve() not in source.parents or not source.is_file():
            continue
        text = source.read_text(encoding="utf-8", errors="replace")
        metadata, body = split_document(text)
        if not metadata.get("source_path"):
            continue
        source_size = None
        if raw:
            try:
                source_size = (raw / metadata["source_path"]).stat().st_size
            except (OSError, TypeError):
                pass
        result.append(Candidate(
            source,
            relative,
            body,
            metadata,
            repair_reasons(body, metadata, source_size),
        ))
    return result


def output_matches_source(destination: Path, original: str) -> bool:
    if not destination.is_file():
        return False
    try:
        text = destination.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    metadata, repaired = split_repair_document(text)
    expected_sha256 = hashlib.sha256(original.encode("utf-8")).hexdigest()
    if metadata.get("llm_repair_source_sha256") != expected_sha256:
        return False
    valid, _ = validate_repair(original, repaired)
    return valid


def error_status(exc: Exception) -> str:
    message = str(exc).lower()
    if isinstance(exc, TimeoutError) or "timeout" in message or "timed out" in message:
        return "timeout"
    return "error"


def safe_error_message(exc: Exception, api_key: str) -> str:
    message = str(exc)
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    return message[:2000]


def prompt_for(body: str, image_count: int = 0) -> str:
    image_note = (
        f"\n原始页面图像已附上（共 {image_count} 页），请用它核对乱码、公式和版式。"
        if image_count else ""
    )
    return f"""你是严谨的 OCR 文档修复编辑。下面是 PaddleOCR 生成的 Markdown 正文。

请在不改变事实的前提下修复明显的 OCR 结果：
1. 修复确定的错别字、乱码、断行和标题层级；
2. 保留所有原文信息、数字、选项、答案、图片引用、HTML 表格和代码；
3. 数学公式只有在上下文可以确定时才修复；无法确定时原样保留；
4. 不得凭常识补写缺失内容，不得总结、删节、改写成摘要；
5. 不要把 HTML 表格改成列表，不要删除图片；
6. 如果原始图像也无法确认某个字符，不要猜测，保留原文并使用 [无法识别] 标记；
7. 只输出修复后的 Markdown 正文，不要输出解释、JSON 或 ``` 包裹。

OCR 正文开始：
---BEGIN OCR---
{body}
---END OCR---
{image_note}
"""


def call_api(
    base_url: str,
    api_key: str,
    model: str,
    prompt: str | list[dict],
    max_tokens: int,
    timeout: int,
    retries: int,
    on_progress: Callable[[str, int], None] | None = None,
) -> ApiResult:
    url = base_url.rstrip("/") + "/chat/completions"
    messages = (
        [
            {
                "role": "system",
                "content": "你只输出修复后的 Markdown 正文。严禁编造和解释。",
            },
            {"role": "user", "content": prompt},
        ]
        if isinstance(prompt, str)
        else [{"role": "user", "content": prompt}]
    )
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
        "enable_thinking": False,
        "thinking": {"type": "disabled"},
        "messages": messages,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content_parts: list[str] = []
                usage: dict = {}
                last_progress_at = 0.0
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload_line = line[5:].strip()
                    if payload_line == "[DONE]":
                        break
                    chunk = json.loads(payload_line)
                    if isinstance(chunk.get("usage"), dict):
                        usage = chunk["usage"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    # NewAPI may stream reasoning_content before the answer.
                    # Only the answer is allowed into the repaired document.
                    if isinstance(delta.get("content"), str):
                        content_parts.append(delta["content"])
                        now = time.time()
                        if on_progress and now - last_progress_at >= 0.75:
                            partial = "".join(content_parts)
                            on_progress(
                                partial,
                                max(1, (len(partial) + 3) // 4),
                            )
                            last_progress_at = now
            content = "".join(content_parts)
            if not isinstance(content, str) or not content.strip():
                raise ValueError("empty_model_response")
            if on_progress:
                on_progress(content, max(1, (len(content) + 3) // 4))
            return ApiResult(content.strip(), usage)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
                OSError, KeyError, IndexError, TypeError, ValueError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"newapi_request_failed: {last_error}") from last_error


def _pdf_pages(path: Path) -> int:
    result = subprocess.run(
        ["pdfinfo", str(path)],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    match = re.search(r"^Pages:\s+(\d+)", result.stdout, re.MULTILINE)
    if not match:
        raise ValueError(f"pdf_page_count_missing: {path}")
    return int(match.group(1))


def _selected_pages(total: int, maximum: int) -> list[int]:
    if total <= maximum:
        return list(range(1, total + 1))
    # Include both ends and evenly spaced interior pages rather than only the
    # first page; this catches headers, answer pages, and appendices.
    values = {1, total}
    for index in range(1, maximum - 1):
        values.add(round(1 + index * (total - 1) / (maximum - 1)))
    return sorted(values)[:maximum]


def reference_images(
    item: Candidate,
    raw: Path,
    render_dir: Path,
    maximum_pages: int,
) -> tuple[list[dict], list[int]]:
    source = raw / item.metadata["source_path"]
    if not source.is_file():
        return [], []
    suffix = source.suffix.lower()
    paths: list[tuple[int, Path]] = []
    if suffix == ".pdf":
        pages = _selected_pages(_pdf_pages(source), maximum_pages)
        for page in pages:
            prefix = render_dir / f"{hashlib.sha256(str(source).encode()).hexdigest()}-{page}"
            target = prefix.with_suffix(".jpg")
            if not target.exists():
                subprocess.run(
                    [
                        "pdftoppm", "-f", str(page), "-l", str(page),
                        "-singlefile", "-jpeg", "-scale-to", "1400",
                        str(source), str(prefix),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=60,
                )
            paths.append((page, target))
    elif suffix in {".jpg", ".jpeg", ".png", ".webp"}:
        paths.append((1, source))
    else:
        return [], []

    content: list[dict] = []
    page_numbers: list[int] = []
    for page, path in paths:
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{data}"},
        })
        page_numbers.append(page)
    return content, page_numbers


def normalized_anchors(text: str) -> set[str]:
    return set(re.findall(r"[\u3400-\u9fffA-Za-z0-9]{2,}", text.lower()))


def validate_repair(original: str, repaired: str) -> tuple[bool, tuple[str, ...]]:
    reasons: list[str] = []
    value = repaired.strip()
    if not value:
        reasons.append("empty")
    if value.startswith("```") and value.endswith("```"):
        reasons.append("wrapped_in_code_fence")
    if "---BEGIN OCR---" in value or "---END OCR---" in value:
        reasons.append("prompt_leak")
    if "\ufffd" in value:
        reasons.append("replacement_character")
    if original and not 0.45 <= len(value) / len(original) <= 2.25:
        reasons.append("length_outlier")
    if original.count("<table") != value.count("<table"):
        reasons.append("table_count_changed")
    if original.count("<img") != value.count("<img"):
        reasons.append("image_count_changed")
    original_anchors = normalized_anchors(original)
    repaired_anchors = normalized_anchors(value)
    if original_anchors and len(original_anchors & repaired_anchors) / len(original_anchors) < 0.55:
        reasons.append("anchor_loss")
    if _unescaped_count(value, "$") % 2:
        reasons.append("unbalanced_math_delimiter")
    if value.count("<table") != value.count("</table>"):
        reasons.append("unbalanced_table")
    if not _balanced_latex_environments(value):
        reasons.append("unbalanced_latex_environment")
    return not reasons, tuple(reasons)


def render(
    metadata: dict,
    original: str,
    repaired: str,
    model: str,
    vision_pages: list[int] | None = None,
) -> str:
    updated = dict(metadata)
    updated["llm_repair_model"] = model
    updated["llm_repair_source_sha256"] = hashlib.sha256(
        original.encode("utf-8")
    ).hexdigest()
    updated["llm_repair_version"] = "1"
    if vision_pages:
        updated["llm_repair_vision_pages"] = vision_pages
    return (
        f"{REPAIR_MARKER}\n"
        f"{json.dumps(updated, ensure_ascii=False, sort_keys=True)}\n"
        "-->\n\n"
        f"{repaired.rstrip()}\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw", type=Path)
    parser.add_argument("--input-list", type=Path)
    parser.add_argument(
        "--resume-log",
        type=Path,
        action="append",
        default=[],
        help=(
            "Reuse prior JSONL result logs. Old one-result-per-line logs and "
            "request_complete logs are supported; successful results are skipped "
            "only when their output is present, while failures are retried."
        ),
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--base-url",
        default=os.environ.get("NEWAPI_BASE_URL") or os.environ.get("OPENAI_BASE_URL", ""),
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("NEWAPI_API_KEY") or os.environ.get("OPENAI_API_KEY", ""),
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("NEWAPI_MODEL") or DEFAULT_MODEL,
    )
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--max-input-chars", type=int, default=DEFAULT_MAX_INPUT)
    parser.add_argument("--max-output-tokens", type=int, default=DEFAULT_MAX_OUTPUT)
    parser.add_argument(
        "--vision",
        action="store_true",
        help="attach rendered original PDF pages to the LLM request",
    )
    parser.add_argument("--max-image-pages", type=int, default=6)
    parser.add_argument("--render-dir", type=Path)
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--log", type=Path)
    args = parser.parse_args()

    if not args.base_url and not args.dry_run:
        parser.error("--base-url or NEWAPI_BASE_URL is required")
    if not args.api_key and not args.dry_run:
        parser.error("--api-key or NEWAPI_API_KEY is required")
    history = load_repair_history(args.resume_log)
    if args.input_list:
        items = read_input_list(args.staging, args.input_list)
    elif history:
        items = candidates_from_history(args.staging, args.raw, history)
    else:
        items = candidates(args.staging, args.raw, args.limit)
    if args.limit:
        items = items[:args.limit]
    args.output.mkdir(parents=True, exist_ok=True)
    log_file = args.log.open("a", encoding="utf-8") if args.log else None
    temporary_render_dir = None
    if args.vision:
        if args.raw is None:
            parser.error("--vision requires --raw")
        if args.render_dir:
            args.render_dir.mkdir(parents=True, exist_ok=True)
        else:
            temporary_render_dir = tempfile.TemporaryDirectory(
                prefix="tjuclaw-ocr-pages-"
            )
            args.render_dir = Path(temporary_render_dir.name)

    try:
        def emit(event: dict) -> None:
            line = json.dumps(event, ensure_ascii=False)
            print(line, flush=True)
            if log_file:
                log_file.write(line + "\n")
                log_file.flush()

        for index, item in enumerate(items, start=1):
            started_at = time.time()
            source_sha256 = hashlib.sha256(item.body.encode("utf-8")).hexdigest()
            estimated_prompt_tokens = max(1, (len(item.body) + 1800) // 4)
            emit({
                "event": "request_start",
                "index": index,
                "total": len(items),
                "source_path": str(item.relative),
                "source_sha256": source_sha256,
                "characters": len(item.body),
                "estimated_prompt_tokens": estimated_prompt_tokens,
                "model": args.model,
                "started_at": started_at,
            })
            record = {
                "event": "request_complete",
                "index": index,
                "total": len(items),
                "source_path": str(item.relative),
                "source_sha256": source_sha256,
                "reasons": list(item.reasons),
                "status": "skipped",
                "model": args.model,
            }
            destination = args.output / item.relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            previous = history.get(item.relative.as_posix())
            if output_matches_source(destination, item.body):
                record["status"] = "existing"
                record["resume"] = "verified_output"
            elif destination.exists():
                # Never overwrite an output that cannot be tied to this exact
                # OCR body. A later manual review can decide whether to replace it.
                record["status"] = "stale_existing"
                record["resume"] = "output_source_mismatch"
            elif previous and previous.status in SUCCESS_STATUSES:
                # A success log without its output is not a success: retry it.
                record["resume"] = "missing_output_after_success_log"
            elif len(item.body) > args.max_input_chars:
                record["status"] = "deferred_input_too_large"
            elif args.dry_run:
                record["status"] = "would_repair"
            else:
                try:
                    user_content: str | list[dict] = prompt_for(item.body)
                    vision_pages: list[int] = []
                    if args.vision:
                        images, vision_pages = reference_images(
                            item, args.raw, args.render_dir, args.max_image_pages
                        )
                        if images:
                            user_content = [
                                {
                                    "type": "text",
                                    "text": prompt_for(item.body, len(images)),
                                }
                            ] + images
                            record["vision_pages"] = vision_pages

                    def on_progress(partial: str, completion_tokens: int) -> None:
                        emit({
                            "event": "stream_progress",
                            "index": index,
                            "total": len(items),
                            "source_path": str(item.relative),
                            "estimated_prompt_tokens": estimated_prompt_tokens,
                            "estimated_completion_tokens": completion_tokens,
                            "estimated_total_tokens": (
                                estimated_prompt_tokens + completion_tokens
                            ),
                            "output_chars": len(partial),
                            "output_tail": partial[-1600:],
                            "at": time.time(),
                        })

                    api_result = call_api(
                        args.base_url,
                        args.api_key,
                        args.model,
                        user_content,
                        args.max_output_tokens,
                        args.timeout,
                        args.retries,
                        on_progress=on_progress,
                    )
                    repaired = api_result.content
                    record["usage"] = api_result.usage
                    valid, validation_reasons = validate_repair(item.body, repaired)
                    record["validation"] = list(validation_reasons)
                    if valid:
                        destination.write_text(
                            render(
                                item.metadata,
                                item.body,
                                repaired,
                                args.model,
                                vision_pages,
                            ),
                            encoding="utf-8",
                        )
                        record["status"] = "repaired"
                    else:
                        record["status"] = "rejected"
                except Exception as exc:  # keep the long-running batch alive
                    record["status"] = error_status(exc)
                    record["error_type"] = type(exc).__name__
                    record["error"] = safe_error_message(exc, args.api_key)
            record["duration_seconds"] = round(time.time() - started_at, 3)
            emit(record)
            if args.sleep:
                time.sleep(args.sleep)
    finally:
        if log_file:
            log_file.close()
        if temporary_render_dir:
            temporary_render_dir.cleanup()
    return 0


if __name__ == "__main__":
    sys.exit(main())
