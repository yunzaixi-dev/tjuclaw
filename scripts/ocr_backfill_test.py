import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("ocr-backfill.py")
SPEC = importlib.util.spec_from_file_location("ocr_backfill", SCRIPT)
assert SPEC and SPEC.loader
OCR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OCR)


class OcrBackfillTest(unittest.TestCase):
    def test_raw_path_requires_content_addressed_layout(self) -> None:
        sha256 = "ab" * 32
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / f"archive/course/raw/ab/ab/{sha256}.pdf"
            invalid = root / f"archive/course/raw/00/00/{sha256}.pdf"
            self.assertEqual(
                OCR.parse_raw_path(root, valid),
                ("course", sha256, Path(f"archive/course/raw/ab/ab/{sha256}.md")),
            )
            self.assertIsNone(OCR.parse_raw_path(root, invalid))

    def test_generated_asset_paths_cannot_escape_output_directory(self) -> None:
        self.assertEqual(OCR.safe_asset_path("/../../etc/passwd", 1), Path("etc/passwd"))
        self.assertFalse(OCR.safe_asset_path("/../../etc/passwd", 1).is_absolute())


if __name__ == "__main__":
    unittest.main()
