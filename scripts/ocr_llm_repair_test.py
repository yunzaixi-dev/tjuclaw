import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

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


class OcrLlmRepairTest(unittest.TestCase):
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
