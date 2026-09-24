import importlib.util
import sys
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


if __name__ == "__main__":
    unittest.main()
