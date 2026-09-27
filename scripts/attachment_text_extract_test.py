import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "attachment_text_extract", Path(__file__).with_name("attachment-text-extract.py"))
EXTRACT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXTRACT)


class AttachmentTextExtractTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.raw = self.root / "raw"
        self.out = self.root / "out"
        self.parent = self.raw / "sources/website/college-test/notice"

    def attach(self, data: bytes, suffix: str = "") -> Path:
        digest = hashlib.sha256(data).hexdigest()
        path = self.parent / ("a" * 64 + ".attachments") / (digest + suffix)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_kinds_are_detected_by_content_not_extension(self):
        self.assertEqual(EXTRACT.kind_of(b"%PDF-1.7"), "pdf")
        self.assertEqual(EXTRACT.kind_of(b"PK\x03\x04....word/document.xml"), "docx")
        self.assertEqual(EXTRACT.kind_of(b"PK\x03\x04....xl/workbook.xml"), "xlsx")
        self.assertEqual(EXTRACT.kind_of(b"\x89PNG\r\n\x1a\n"), "image")
        self.assertEqual(EXTRACT.kind_of(b"<!DOCTYPE html>"), "other")

    def test_saved_error_pages_images_and_tampered_files_are_skipped(self):
        self.attach(b"<!DOCTYPE html><title>404</title>", ".docx")
        self.attach(b"\x89PNG\r\n\x1a\nimage")
        tampered = self.attach(b"%PDF-1.4 original")
        tampered.write_bytes(b"%PDF-1.4 changed")
        counts = EXTRACT.run(self.raw, self.out)
        self.assertEqual((counts["html"], counts["image"], counts["provenance_mismatch"]), (1, 1, 1))
        self.assertFalse(self.out.exists())

    def test_text_is_written_beside_the_mirror_path_and_reused(self):
        source = self.attach(b"%PDF-1.4 text layer", ".pdf")
        text = "招生简章\n\n\n一、申请条件：具有学士学位，   成绩优良。" * 2
        with patch.object(EXTRACT, "pdf_text", return_value=text):
            self.assertEqual(EXTRACT.run(self.raw, self.out)["extracted"], 1)
            self.assertEqual(EXTRACT.run(self.raw, self.out)["unchanged"], 1)
        written = (self.out / source.relative_to(self.raw)).with_name(source.name + ".md").read_text("utf-8")
        self.assertIn("一、申请条件：具有学士学位， 成绩优良。", written)
        self.assertNotIn("\n\n\n", written)

    def test_scanned_pdfs_wait_for_ocr(self):
        self.attach(b"%PDF-1.4 scanned")
        with patch.object(EXTRACT, "pdf_text", return_value="  \n"):
            self.assertEqual(EXTRACT.run(self.raw, self.out)["scanned_or_empty"], 1)


if __name__ == "__main__":
    unittest.main()
