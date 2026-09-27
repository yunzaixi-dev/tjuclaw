import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "office_prepare", Path(__file__).with_name("ocr-office-prepare.py"))
OFFICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OFFICE)


class OfficePrepareTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.source = (
            "sources/course/public-course-sharing/test/"
            + "a" * 64 + ".attachments/" + "b" * 64 + ".docx")
        self.original = self.root / self.source
        self.original.parent.mkdir(parents=True)
        self.original.write_bytes(b"office-original")
        self.pdf = self.cache / f"{OFFICE.identifier(self.source)}.pdf"
        self.pdf.write_bytes(b"%PDF-1.4 safe")
        self.metadata = self.pdf.with_suffix(".json")
        self.record = {
            "source": self.source,
            "original_sha256": OFFICE.BACKFILL.file_sha256(self.original),
            "pdf_sha256": OFFICE.BACKFILL.file_sha256(self.pdf),
            "pdf_bytes": self.pdf.stat().st_size, "pages": 2,
            "converter": "isolated-libreoffice",
        }
        self.metadata.write_text(json.dumps(self.record))

    def test_accepts_verified_original_and_conversion(self):
        self.assertEqual(OFFICE.checked_record(
            self.cache, self.source, self.original), self.record)

    def test_rejects_changed_original(self):
        self.original.write_bytes(b"changed")
        self.assertIsNone(OFFICE.checked_record(self.cache, self.source, self.original))

    def test_rejects_changed_conversion(self):
        self.pdf.write_bytes(b"changed")
        self.assertIsNone(OFFICE.checked_record(self.cache, self.source, self.original))

    def test_requires_isolated_converter(self):
        self.metadata.unlink()
        with patch.object(OFFICE.shutil, "which", return_value=None):
            result = OFFICE.prepare_one((self.original,), self.root, self.cache)
        self.assertEqual(result["reason"], "isolation_unavailable")


if __name__ == "__main__":
    unittest.main()
