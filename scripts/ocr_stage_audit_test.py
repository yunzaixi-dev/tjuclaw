import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("ocr_stage_audit", Path(__file__).with_name("ocr-stage-audit.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class StageAuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.raw = root / "raw"
        self.stage = root / "stage"
        self.object_id = "a" * 64
        relative = (
            f"sources/course/public-course-sharing/example/"
            f"{'b' * 64}.attachments/{self.object_id}.pdf"
        )
        self.source = self.raw / relative
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b"%PDF-1.4")
        self.output = self.stage / Path(relative).with_suffix(".md")
        self.output.parent.mkdir(parents=True)

    def write_markdown(self, body):
        metadata = {
            "source_path": self.source.relative_to(self.raw).as_posix(),
            "source_sha256": self.object_id,
            "processor": "PaddleOCR-VL",
        }
        self.output.write_text(
            "<!-- TJUCLAW_OCR_V1\n" + json.dumps(metadata) + "\n-->\n\n" + body,
            encoding="utf-8",
        )

    def test_markdown_asset_present_and_missing(self):
        self.write_markdown(f"![diagram]({self.object_id}.assets/diagram.png)")
        result = AUDIT.audit(self.raw, self.stage)
        self.assertEqual(result["summary"]["missing_assets"], 1)
        asset = self.output.with_suffix(".assets") / "diagram.png"
        asset.parent.mkdir()
        asset.write_bytes(b"\x89PNG")
        result = AUDIT.audit(self.raw, self.stage)
        self.assertEqual(result["summary"], {"candidates": 1, "valid": 1})

    def test_html_asset_is_checked(self):
        self.write_markdown(f'<img src="{self.object_id}.assets/charts/one.png">')
        result = AUDIT.audit(self.raw, self.stage)
        self.assertEqual(result["summary"]["missing_assets"], 1)

    def test_asset_path_cannot_escape_directory(self):
        self.write_markdown(f"![diagram]({self.object_id}.assets/../../secret.png)")
        (self.output.parent.parent / "secret.png").write_bytes(b"secret")
        result = AUDIT.audit(self.raw, self.stage)
        self.assertEqual(result["summary"]["missing_assets"], 1)


if __name__ == "__main__":
    unittest.main()
