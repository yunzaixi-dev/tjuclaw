#!/usr/bin/env python3
"""Pretty terminal dashboard for the tju-llm-max OCR repair workers."""

from __future__ import annotations

import argparse
import curses
import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Worker:
    index: int
    log: Path
    input_list: Path
    unit: str
    total: int = 0
    completed: int = 0
    repaired: int = 0
    rejected: int = 0
    errors: int = 0
    deferred: int = 0
    existing: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimated_inflight_tokens: int = 0
    estimated_inflight_completion_tokens: int = 0
    active_output_chars: int = 0
    active_output_tail: str = ""
    active_path: str = ""
    active_started: float | None = None
    last_status: str = "waiting"
    last_duration: float = 0.0
    first_started: float | None = None
    last_event_time: float | None = None
    events: int = 0

    def load(self) -> None:
        self.total = count_list(self.input_list)
        if not self.log.exists():
            self.last_status = "waiting"
            return
        active_started = None
        active_path = ""
        completed = 0
        for line in self.log.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.events += 1
            event_type = event.get("event")
            if event_type == "request_start":
                active_path = str(event.get("source_path", ""))
                active_started = float(event.get("started_at", time.time()))
                self.first_started = self.first_started or active_started
                self.estimated_inflight_tokens = int(
                    event.get("estimated_prompt_tokens", 0)
                )
                self.estimated_inflight_completion_tokens = 0
                self.active_output_chars = 0
                self.active_output_tail = ""
                continue
            if event_type == "stream_progress":
                self.estimated_inflight_tokens = int(
                    event.get("estimated_total_tokens", 0) or 0
                )
                self.estimated_inflight_completion_tokens = int(
                    event.get("estimated_completion_tokens", 0) or 0
                )
                self.active_output_chars = int(event.get("output_chars", 0) or 0)
                self.active_output_tail = str(event.get("output_tail", ""))
                continue
            if event_type not in (None, "request_complete"):
                continue
            if not event.get("status"):
                continue
            completed += 1
            self.completed = completed
            self.active_path = ""
            self.active_started = None
            self.estimated_inflight_tokens = 0
            self.estimated_inflight_completion_tokens = 0
            self.active_output_chars = 0
            self.active_output_tail = ""
            self.last_status = str(event.get("status"))
            self.last_duration = float(event.get("duration_seconds", 0) or 0)
            self.last_event_time = time.time()
            usage = event.get("usage") or {}
            self.prompt_tokens += int(usage.get("prompt_tokens", 0) or 0)
            self.completion_tokens += int(usage.get("completion_tokens", 0) or 0)
            self.total_tokens += int(usage.get("total_tokens", 0) or 0)
            status = event["status"]
            if status == "repaired":
                self.repaired += 1
            elif status == "rejected":
                self.rejected += 1
            elif status == "error":
                self.errors += 1
            elif status == "deferred_input_too_large":
                self.deferred += 1
            elif status == "existing":
                self.existing += 1
        if active_started is not None:
            self.active_path = active_path
            self.active_started = active_started
            self.last_status = "processing"
        elif self.completed >= self.total and self.total:
            self.last_status = "done"

    @property
    def running(self) -> bool:
        return self.active_started is not None

    @property
    def elapsed(self) -> float:
        if not self.first_started:
            return 0.0
        return max(0.0, time.time() - self.first_started)

    @property
    def rate(self) -> float:
        return self.completed / self.elapsed if self.elapsed > 2 else 0.0


def count_list(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines()
               if line.strip() and not line.lstrip().startswith("#"))


def fmt_int(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def fmt_duration(seconds: float) -> str:
    if not seconds:
        return "--"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60:02d}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60:02d}m"


def short_path(value: str, width: int) -> str:
    value = value.replace("sources/course/public-course-sharing/", "")
    if len(value) <= width:
        return value
    return "…" + value[-(width - 1):]


def output_tail_lines(value: str, width: int, limit: int) -> list[str]:
    """Return a readable tail without letting model output break the dashboard."""
    lines = [line.rstrip() for line in value.splitlines() if line.strip()]
    if not lines:
        return ["(等待模型输出…)"]
    result = []
    for line in lines[-limit:]:
        compact = " ".join(line.split())
        result.append(compact if len(compact) <= width else compact[:width - 1] + "…")
    return result


def progress_bar(done: int, total: int, width: int) -> str:
    if total <= 0:
        return "░" * width
    filled = min(width, round(width * done / total))
    return "█" * filled + "░" * (width - filled)


def snapshot(args: argparse.Namespace) -> list[Worker]:
    workers = []
    for index in range(args.workers):
        worker = Worker(
            index=index,
            log=args.log_dir / f"{args.log_prefix}{index}.jsonl",
            input_list=args.list_dir / f"{args.list_prefix}{index}.list",
            unit=f"{args.unit_prefix}{index}.service",
        )
        worker.load()
        workers.append(worker)
    return workers


def systemd_state(unit: str) -> str:
    try:
        result = subprocess.run(
            ["systemctl", "--user", "is-active", unit],
            capture_output=True,
            text=True,
            timeout=1,
        )
        return result.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def report(workers: list[Worker]) -> dict:
    total = sum(w.total for w in workers)
    completed = sum(w.completed for w in workers)
    prompt = sum(w.prompt_tokens for w in workers)
    completion = sum(w.completion_tokens for w in workers)
    tokens = sum(w.total_tokens for w in workers)
    estimated = sum(w.estimated_inflight_tokens for w in workers)
    repaired = sum(w.repaired for w in workers)
    rejected = sum(w.rejected for w in workers)
    errors = sum(w.errors for w in workers)
    elapsed = max((w.elapsed for w in workers), default=0)
    rate = completed / elapsed if elapsed > 2 else 0
    remaining = max(0, total - completed)
    return {
        "total": total,
        "completed": completed,
        "prompt": prompt,
        "completion": completion,
        "tokens": tokens,
        "estimated": estimated,
        "repaired": repaired,
        "rejected": rejected,
        "errors": errors,
        "remaining": remaining,
        "rate": rate,
        "eta": remaining / rate if rate else 0,
    }


def put(stdscr, y: int, x: int, text: str, attr: int = 0, width: int | None = None):
    if width is not None:
        text = text[:max(0, width)]
    try:
        stdscr.addstr(y, x, text, attr)
    except curses.error:
        pass


def draw(stdscr, args: argparse.Namespace) -> None:
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    stdscr.nodelay(True)
    try:
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_CYAN, -1)
        curses.init_pair(2, curses.COLOR_GREEN, -1)
        curses.init_pair(3, curses.COLOR_YELLOW, -1)
        curses.init_pair(4, curses.COLOR_RED, -1)
        curses.init_pair(5, curses.COLOR_MAGENTA, -1)
    except curses.error:
        pass
    while True:
        workers = snapshot(args)
        summary = report(workers)
        height, width = stdscr.getmaxyx()
        stdscr.erase()
        title = " TJUCLAW  /  OCR → tju-llm-max  "
        put(stdscr, 0, 0, "╭" + "─" * max(0, width - 2) + "╮", curses.color_pair(1))
        put(stdscr, 1, 2, title, curses.color_pair(1) | curses.A_BOLD)
        put(stdscr, 2, 0, "╰" + "─" * max(0, width - 2) + "╯", curses.color_pair(1))

        pct = (100 * summary["completed"] / summary["total"]
               if summary["total"] else 0)
        put(
            stdscr, 4, 2,
            f"总进度  {summary['completed']:>4}/{summary['total']:<4} "
            f"{pct:6.2f}%  {progress_bar(summary['completed'], summary['total'], max(10, width - 35))}",
            curses.color_pair(2) | curses.A_BOLD,
            width - 4,
        )
        put(
            stdscr, 6, 2,
            f"已确认 tokens  {fmt_int(summary['tokens']):>8}   "
            f"输入 {fmt_int(summary['prompt']):>8}   "
            f"输出 {fmt_int(summary['completion']):>8}   "
            f"进行中估算 ≈{fmt_int(summary['estimated'])}",
            curses.color_pair(1), width - 4,
        )
        put(
            stdscr, 7, 2,
            f"通过 {summary['repaired']}   拒绝 {summary['rejected']}   "
            f"错误 {summary['errors']}   剩余 {summary['remaining']}   "
            f"速率 {summary['rate']:.2f}/s   ETA {fmt_duration(summary['eta'])}",
            curses.color_pair(3), width - 4,
        )
        put(
            stdscr, 8, 2,
            "估算 tokens 只覆盖当前请求；已确认 tokens 来自 NewAPI 流式 usage 回传",
            curses.A_DIM, width - 4,
        )
        put(stdscr, 9, 2, "WORKERS", curses.color_pair(5) | curses.A_BOLD)
        put(
            stdscr, 10, 2,
            "ID  状态       进度          tokens       当前/估算输入       当前文件",
            curses.A_DIM,
            width - 4,
        )
        row = 11
        for worker in workers:
            state = systemd_state(worker.unit)
            status = "RUN" if worker.running else (
                "DONE" if worker.last_status == "done" else worker.last_status.upper()
            )
            attr = curses.color_pair(2) if status == "RUN" else (
                curses.color_pair(3) if status == "DONE" else curses.color_pair(4)
            )
            current = short_path(worker.active_path, max(20, width - 62)) if worker.running else "-"
            put(
                stdscr, row, 2,
                f"r{worker.index:<2} {status:<10} "
                f"{worker.completed:>3}/{worker.total:<3} "
                f"{fmt_int(worker.total_tokens):>8}  "
                f"{fmt_int(worker.estimated_inflight_tokens):>8}  {current}",
                attr, width - 4,
            )
            row += 1
            if row >= height - 3:
                break
        output_row = row + 1
        available_output_rows = height - output_row - 3
        if available_output_rows > 1:
            put(
                stdscr, output_row, 2, "LIVE MODEL OUTPUT",
                curses.color_pair(5) | curses.A_BOLD,
                width - 4,
            )
            active_workers = [worker for worker in workers if worker.running]
            if active_workers:
                active = max(
                    active_workers,
                    key=lambda worker: worker.active_started or 0,
                )
                header = (
                    f"r{active.index}  {active.active_output_chars:,} chars  "
                    f"≈{fmt_int(active.estimated_inflight_completion_tokens)} "
                    "completion tokens"
                )
                put(stdscr, output_row + 1, 2, header, curses.color_pair(1), width - 4)
                for offset, line in enumerate(
                    output_tail_lines(
                        active.active_output_tail,
                        max(20, width - 4),
                        available_output_rows - 2,
                    ),
                    start=2,
                ):
                    put(stdscr, output_row + offset, 2, line, curses.A_DIM, width - 4)
            else:
                put(stdscr, output_row + 1, 2, "(当前没有进行中的模型输出)", curses.A_DIM, width - 4)
        put(
            stdscr, height - 2, 2,
            "q 退出   r 刷新   LIVE OUTPUT 为最近片段   日志目录: " + str(args.log_dir),
            curses.A_DIM, width - 4,
        )
        stdscr.refresh()
        if args.once:
            return
        key = stdscr.getch()
        if key in (ord("q"), ord("Q")):
            return
        time.sleep(args.refresh)


def plain(args: argparse.Namespace) -> None:
    workers = snapshot(args)
    summary = report(workers)
    print(json.dumps({"summary": summary, "workers": [
        {"id": w.index, "completed": w.completed, "total": w.total,
         "status": w.last_status, "tokens": w.total_tokens,
         "active_output_chars": w.active_output_chars,
         "active_output_tail": w.active_output_tail[-500:]}
        for w in workers
    ]}, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-dir", type=Path,
                        default=Path("ops/local/ocr-benchmark"))
    parser.add_argument("--log-prefix", default="production-repaired-max-all-v3-r")
    parser.add_argument("--list-dir", type=Path, default=Path("/tmp"))
    parser.add_argument("--list-prefix", default="tjuclaw-max-all-")
    parser.add_argument("--unit-prefix", default="tjuclaw-ocr-llm-max-all-v3-r")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--refresh", type=float, default=1.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.once:
        plain(args)
    else:
        curses.wrapper(draw, args)


if __name__ == "__main__":
    main()
