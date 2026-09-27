import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "ocr_textlayer_stage", Path(__file__).with_name("ocr-textlayer-stage.py")
)
assert SPEC and SPEC.loader
STAGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = STAGE
SPEC.loader.exec_module(STAGE)


class TextLayerStageTest(unittest.TestCase):
    def test_quality_requires_near_complete_text_coverage_and_valid_math(self):
        dense = "Campus schedule and contact details with real searchable text. " * 15
        self.assertIsNotNone(STAGE.quality_body([dense] * 9 + ["figure"], 10000))
        self.assertIsNone(STAGE.quality_body([dense] * 8 + ["figure"] * 2, 10000))
        self.assertIsNone(STAGE.quality_body([dense + " $unclosed"], 10000))
        self.assertIsNone(STAGE.quality_body([dense + "\ufffd"], 10000))

    def test_pdf_stage_is_truthfully_marked_and_privacy_gated(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "raw"
            relative = ("sources/course/public-course-sharing/example/"
                        + "a" * 64 + ".attachments/" + "b" * 64 + ".pdf")
            source = raw / relative
            source.parent.mkdir(parents=True)
            source.write_bytes(b"%PDF synthetic")
            output = Path(directory) / "stage" / Path(relative).with_suffix(".md")
            dense = "Public campus timetable with useful searchable information. " * 15
            with patch.object(STAGE, "pdf_pages", return_value=2), \
                 patch.object(STAGE, "extract_pages", return_value=[dense, dense]), \
                 patch.object(STAGE.REPAIR, "scan_privacy", return_value=()):
                result = STAGE.stage_one(
                    source, relative, "b" * 64, output, Path(directory), 1, 200,
                )
            self.assertEqual(result, "staged")
            text = output.read_text()
            self.assertTrue(text.startswith("<!-- TJUCLAW_TEXT_LAYER_V1\n"))
            head = json.loads(text.split("\n-->\n", 1)[0].split("\n", 1)[1])
            self.assertEqual(head["processor"], "Poppler-pdftotext")
            self.assertEqual(head["source_path"], relative)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            output.unlink()
            with patch.object(STAGE, "pdf_pages", return_value=2), \
                 patch.object(STAGE, "extract_pages", return_value=[dense, dense]), \
                 patch.object(STAGE.REPAIR, "scan_privacy", return_value=("credential",)):
                result = STAGE.stage_one(
                    source, relative, "b" * 64, output, Path(directory), 1, 200,
                )
            self.assertEqual(result, "deferred_privacy")
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
