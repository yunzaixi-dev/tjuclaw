import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import unittest
from collections import Counter
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_SPEC = importlib.util.spec_from_file_location(
    "ocr_llm_repair", Path(__file__).with_name("ocr-llm-repair.py")
)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)

repair_reasons = _MODULE.repair_reasons
split_document = _MODULE.split_document
validate_repair = _MODULE.validate_repair
_selected_pages = _MODULE._selected_pages
load_repair_history = _MODULE.load_repair_history
output_matches_source = _MODULE.output_matches_source
render = _MODULE.render
safe_relative_path = _MODULE.safe_relative_path
candidates_from_history = _MODULE.candidates_from_history
load_follow_attempts = _MODULE.load_follow_attempts
pending_follow_items = _MODULE.pending_follow_items


class OcrLlmRepairTest(unittest.TestCase):
    def test_math_validation_ignores_literal_code(self):
        cases = (
            "# Code\n```php\n$value = 1;\n```\nEnd.",
            "# Code\nUse `$value` as a variable.\nEnd.",
            "# Code\n````php\n```\n$value\n````\nEnd.",
            "# Code\n~~~tex\n\\begin{example}\n$value\n~~~\nEnd.",
            "# Code\nUse ``a ` $value`` as literal code.\nEnd.",
        )
        for body in cases:
            with self.subTest(body=body):
                self.assertNotIn("unbalanced_math_delimiter", repair_reasons(body, {}))
                self.assertTrue(validate_repair(body, body)[0])

    def test_real_math_outside_code_still_rejected(self):
        body = "# Math\n`$variable`\nUnclosed expression $x + 1."
        self.assertIn("unbalanced_math_delimiter", validate_repair(body, body)[1])

    def test_privacy_scanner_fails_closed(self):
        for report in ("invalid", "{}", '[{"category":"unknown"}]'):
            with self.subTest(report=report), patch.object(
                _MODULE.subprocess, "run",
                return_value=SimpleNamespace(returncode=0, stdout=report),
            ):
                with self.assertRaisesRegex(RuntimeError, "privacy_scan_unavailable"):
                    _MODULE.scan_privacy("private text")
        with patch.object(_MODULE.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0,
                          stdout='[{"rule":"PASSWORD_ASSIGNMENT","category":"credential"}]')):
            self.assertEqual(_MODULE.scan_privacy("password=privatevalue"),
                             ("credential",))

    def run_remote_fixture(self, body, scan, response=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / "stage"
            stage.mkdir()
            (stage / "a.md").write_text(
                '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n' + body,
                encoding="utf-8",
            )
            captured = io.StringIO()
            def call(*args, **kwargs):
                kwargs["on_progress"]("PRIVATE_RESPONSE_SENTINEL", 10)
                return _MODULE.ApiResult(response or body, {"total_tokens": 10,
                    "private_field": "PRIVATE_USAGE_SENTINEL"})
            with patch.object(sys, "argv", [
                "ocr-llm-repair.py", "--staging", str(stage),
                "--output", str(root / "out"), "--sleep", "0",
                "--base-url", "https://test.invalid/v1", "--api-key", "test",
            ]), patch.object(_MODULE, "scan_privacy", side_effect=scan), \
                    patch.object(_MODULE, "call_api", side_effect=call) as api, \
                    redirect_stdout(captured):
                _MODULE.main()
            return captured.getvalue(), api.call_count, (root / "out" / "a.md").exists()

    def test_sensitive_input_never_calls_remote_or_logs_body(self):
        log, calls, exists = self.run_remote_fixture(
            "# PRIVATE_INPUT_SENTINEL", [("credential",)])
        self.assertEqual(calls, 0)
        self.assertFalse(exists)
        self.assertNotIn("PRIVATE_INPUT_SENTINEL", log)
        self.assertEqual(json.loads(log.splitlines()[-1])["status"], "privacy_blocked")

    def test_sensitive_response_is_not_written_or_logged(self):
        log, calls, exists = self.run_remote_fixture(
            "# title", [(), ("credential",)])
        self.assertEqual(calls, 1)
        self.assertFalse(exists)
        self.assertNotIn("PRIVATE_RESPONSE_SENTINEL", log)
        self.assertNotIn("PRIVATE_USAGE_SENTINEL", log)
        self.assertEqual(json.loads(log.splitlines()[-1])["status"], "privacy_blocked")

    def test_safe_repair_preserves_counters_without_logging_text(self):
        log, calls, exists = self.run_remote_fixture("# title", [(), ()])
        self.assertEqual(calls, 1)
        self.assertTrue(exists)
        self.assertNotIn("PRIVATE_RESPONSE_SENTINEL", log)
        self.assertNotIn("PRIVATE_USAGE_SENTINEL", log)
        self.assertEqual(json.loads(log.splitlines()[-1])["usage"], {"total_tokens": 10})

    def test_provider_errors_do_not_echo_secrets(self):
        self.assertEqual(_MODULE.safe_error_message(
            ValueError("PRIVATE_ERROR_SENTINEL"), "test"), "ValueError")

    def test_prompt_requires_replacement_character_resolution(self):
        prompt = _MODULE.prompt_for("错误�字符")
        self.assertIn("只将该字符替换为 [无法识别]", prompt)
        self.assertIn("不得猜测或原样输出 �", prompt)

    def test_split_document(self):
        metadata, body = split_document(
            '<!-- TJUCLAW_OCR_V1\n{"source_path":"a.pdf"}\n-->\n\n# 标题\n'
        )
        self.assertEqual(metadata["source_path"], "a.pdf")
        self.assertEqual(body, "\n# 标题\n")

    def test_repair_reasons(self):
        reasons = repair_reasons("坏\ufffd文本 $x", {}, 200_000)
        self.assertIn("replacement_character", reasons)
        self.assertIn("unbalanced_math_delimiter", reasons)

    def test_repair_reasons_ignores_escaped_math_and_matches_latex_names(self):
        self.assertNotIn("unbalanced_math_delimiter", repair_reasons(r"\$ 10", {}))
        self.assertNotIn(
            "unbalanced_latex_environment",
            repair_reasons(r"\begin{aligned}x\end{aligned}", {}),
        )
        self.assertIn(
            "unbalanced_latex_environment",
            repair_reasons(r"\begin{aligned}x\end{matrix}", {}),
        )

    def test_validation_preserves_structure(self):
        original = "# 标题\n\n<table><tr><td>一</td></tr></table>\n<img src=\"a.jpg\">\n"
        repaired = "# 标题\n\n<table><tr><td>1</td></tr></table>\n<img src=\"a.jpg\">\n"
        valid, reasons = validate_repair(original, repaired)
        self.assertTrue(valid, reasons)

    def test_validation_rejects_prompt_leak(self):
        valid, reasons = validate_repair("# 标题\n", "---BEGIN OCR---\n# 标题")
        self.assertFalse(valid)
        self.assertIn("prompt_leak", reasons)

    def test_validation_rejects_unresolved_replacement_character(self):
        valid, reasons = validate_repair("# 标题\n", "# 标题\ufffd")
        self.assertFalse(valid)
        self.assertIn("replacement_character", reasons)

    def test_uncertain_ocr_characters_are_marked_without_guessing(self):
        output, count = _MODULE.replace_unrecognized_characters("题\ufffd和\ufffd")
        self.assertEqual((output, count), ("题[无法识别]和[无法识别]", 2))
        self.assertTrue(validate_repair("题\ufffd和\ufffd", output)[0])

    def test_model_output_with_uncertain_character_can_be_saved(self):
        log, calls, exists = self.run_remote_fixture(
            "# 标题\ufffd", [(), ()], response="# 标题\ufffd")
        self.assertEqual(calls, 1)
        self.assertTrue(exists)
        self.assertEqual(json.loads(log.splitlines()[-1])["status"], "repaired")
        self.assertEqual(
            json.loads(log.splitlines()[-1])["unrecognized_characters_marked"], 1)

    def test_selected_pages_covers_both_ends(self):
        self.assertEqual(_selected_pages(3, 6), [1, 2, 3])
        pages = _selected_pages(20, 4)
        self.assertEqual(len(pages), 4)
        self.assertEqual(pages[0], 1)
        self.assertEqual(pages[-1], 20)

    def test_resume_history_supports_legacy_and_request_complete_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_log = root / "old.jsonl"
            new_log = root / "new.jsonl"
            old_log.write_text(
                '{"source_path":"notes/a.md","status":"rejected"}\n',
                encoding="utf-8",
            )
            new_log.write_text(
                "\n".join([
                    '{"event":"request_start","source_path":"notes/a.md"}',
                    '{"event":"request_complete","source_path":"notes/a.md","status":"repaired"}',
                    '{"event":"request_complete","source_path":"notes/b.md","status":"timeout"}',
                ]) + "\n",
                encoding="utf-8",
            )
            history = load_repair_history([old_log, new_log])
            self.assertEqual(history["notes/a.md"].status, "repaired")
            self.assertEqual(history["notes/b.md"].status, "timeout")
            self.assertIsNone(safe_relative_path("../notes/a.md"))
            self.assertEqual(safe_relative_path("notes/a.md").as_posix(), "notes/a.md")

    def test_resume_history_latest_log_can_retry_previous_success_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = root / "staging"
            source = staging / "notes" / "a.md"
            source.parent.mkdir(parents=True)
            source.write_text(
                '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n\n# A\n',
                encoding="utf-8",
            )
            log = root / "repair.jsonl"
            log.write_text(
                '{"source_path":"notes/a.md","status":"repaired"}\n',
                encoding="utf-8",
            )
            history = load_repair_history([log])
            items = candidates_from_history(staging, None, history)
            self.assertEqual([item.relative.as_posix() for item in items], ["notes/a.md"])

    def test_missing_success_output_is_retried_in_dry_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = root / "staging"
            source = staging / "notes" / "a.md"
            source.parent.mkdir(parents=True)
            source.write_text(
                '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n\n# A\n',
                encoding="utf-8",
            )
            log = root / "repair.jsonl"
            log.write_text(
                '{"source_path":"notes/a.md","status":"repaired"}\n',
                encoding="utf-8",
            )
            output = io.StringIO()
            with patch.object(sys, "argv", [
                "ocr-llm-repair.py", "--staging", str(staging),
                "--output", str(root / "repaired"),
                "--resume-log", str(log), "--dry-run", "--sleep", "0",
            ]), redirect_stdout(output):
                self.assertEqual(_MODULE.main(), 0)
            records = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(records[-1]["status"], "would_repair")
            self.assertEqual(records[-1]["resume"], "missing_output_after_success_log")

    def test_follow_discovers_new_candidates_and_persists_attempt_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, output = root / "staging", root / "output"
            staging.mkdir()
            output.mkdir()
            source = staging / "new.md"
            body = "# 标题\n\n待识别�的正文，包含足够的上下文。\n"
            source.write_text(
                '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n' + body,
                encoding="utf-8",
            )
            os.utime(source, (time.time() - 5, time.time() - 5))
            self.assertEqual(
                [item.relative.as_posix() for item in pending_follow_items(
                    staging, None, output, Counter(), 1
                )], ["new.md"],
            )
            digest = _MODULE.hashlib.sha256(body.encode()).hexdigest()
            log = root / "follow.jsonl"
            log.write_text(json.dumps({
                "event": "request_complete", "source_path": "new.md",
                "source_sha256": digest, "status": "rejected",
            }) + "\n")
            attempts = load_follow_attempts([log, log])
            self.assertEqual(attempts[("new.md", digest)], 1)
            self.assertEqual(pending_follow_items(staging, None, output, attempts, 1), [])

            source.write_text(
                '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n'
                + body.replace("待识别", "新版本待识别"),
                encoding="utf-8",
            )
            os.utime(source, (time.time() - 5, time.time() - 5))
            self.assertEqual(len(pending_follow_items(staging, None, output, attempts, 1)), 1)
            (output / "new.md").write_text(
                render({"source_path": "raw/a.pdf"}, body.replace("待识别", "新版本待识别"),
                       body.replace("待识别", "新版本待识别").replace("�", "[无法识别]"),
                       "tju-llm-max"),
                encoding="utf-8",
            )
            self.assertEqual(pending_follow_items(staging, None, output, attempts, 1), [])

    def test_follow_leaves_mismatched_output_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, output = root / "staging", root / "output"
            staging.mkdir()
            output.mkdir()
            source = staging / "new.md"
            source.write_text(
                '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n# 坏�文本\n',
                encoding="utf-8",
            )
            os.utime(source, (time.time() - 5, time.time() - 5))
            (output / "new.md").write_text("unrelated existing file", encoding="utf-8")
            self.assertEqual(pending_follow_items(staging, None, output, Counter(), 1), [])
            self.assertEqual((output / "new.md").read_text(), "unrelated existing file")

    def test_follow_picks_up_document_created_after_first_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, output, log = root / "staging", root / "output", root / "follow.jsonl"
            staging.mkdir()
            polls = 0

            def on_poll(_seconds):
                nonlocal polls
                polls += 1
                if polls == 1:
                    source = staging / "late.md"
                    source.write_text(
                        '<!-- TJUCLAW_OCR_V1\n{"source_path":"raw/a.pdf"}\n-->\n'
                        '# 标题\n\n识别�文本。\n',
                        encoding="utf-8",
                    )
                    os.utime(source, (time.time() - 5, time.time() - 5))
                else:
                    raise KeyboardInterrupt()

            with patch.object(sys, "argv", [
                "ocr-llm-repair.py", "--staging", str(staging),
                "--output", str(output), "--log", str(log),
                "--follow", "--dry-run", "--sleep", "0",
                "--poll-interval", "0.01",
            ]), patch.object(_MODULE.time, "sleep", side_effect=on_poll), redirect_stdout(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    _MODULE.main()
            completed = [
                json.loads(line) for line in log.read_text().splitlines()
                if '"event": "request_complete"' in line
            ]
            self.assertEqual(len(completed), 1)
            self.assertEqual(completed[0]["status"], "would_repair")
            self.assertEqual(len(load_follow_attempts([log])), 1)

    def test_output_matches_source_requires_current_source_hash(self):
        original = "# 标题\n\n内容\n"
        metadata = {"source_path": "raw/a.pdf"}
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "a.md"
            destination.write_text(
                render(metadata, original, original, "tju-llm-max"),
                encoding="utf-8",
            )
            self.assertTrue(output_matches_source(destination, original))
            self.assertFalse(output_matches_source(destination, original + "changed"))


if __name__ == "__main__":
    unittest.main()
