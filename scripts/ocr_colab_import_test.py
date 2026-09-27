import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("ocr-colab-import.py")
SPEC = importlib.util.spec_from_file_location("ocr_colab_import", SCRIPT)
assert SPEC and SPEC.loader
IMPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORT)
BACKFILL, _ = IMPORT.modules()


class ColabImportTest(unittest.TestCase):
    def setUp(self):
        privacy = patch.object(IMPORT, "privacy_categories", return_value=())
        self.privacy = privacy.start()
        self.addCleanup(privacy.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.raw = self.root / "raw"
        self.stage = self.root / "stage"
        data = b"%PDF-1.4\npublic test\n"
        digest = hashlib.sha256(data).hexdigest()
        self.source = (
            f"sources/course/public-course-sharing/test/{'a' * 64}.attachments/{digest}.pdf"
        )
        raw_file = self.raw / self.source
        raw_file.parent.mkdir(parents=True)
        raw_file.write_bytes(data)
        self.relative_output = Path(self.source).with_suffix(".md")
        self.output = self.stage / self.relative_output
        self.body = BACKFILL.provenance(self.source, digest) + "Hello\n"

    def archive(self, entries):
        result = self.root / "result.tar.gz"
        with tarfile.open(result, "w:gz") as tar:
            for name, content in entries:
                payload = content.encode() if isinstance(content, str) else content
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                tar.addfile(info, io.BytesIO(payload))
        return result

    def test_valid_markdown_and_image_imported(self):
        asset = self.relative_output.with_suffix(".assets") / "image.png"
        body = self.body + f"![picture]({asset.parent.name}/image.png)\n"
        archive = self.archive([
            (self.relative_output.as_posix(), body),
            (asset.as_posix(), b"PNG"),
        ])
        self.assertEqual(IMPORT.import_result(archive, self.source, self.raw, self.stage), "imported")
        self.assertEqual(self.output.read_text(), body)
        self.assertEqual(self.output.with_suffix(".assets").joinpath("image.png").read_bytes(), b"PNG")

    def test_accepts_archive_with_explicit_asset_directory(self):
        asset = self.relative_output.with_suffix(".assets") / "image.png"
        archive_path = self.root / "with-directory.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            for entry in (self.relative_output.with_suffix(".assets"),):
                directory = tarfile.TarInfo(entry.as_posix())
                directory.type = tarfile.DIRTYPE
                archive.addfile(directory)
            for name, data in (
                (self.relative_output.as_posix(),
                 self.body + f"![picture]({asset.parent.name}/image.png)\n"),
                (asset.as_posix(), b"PNG"),
            ):
                payload = data.encode() if isinstance(data, str) else data
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
        self.assertEqual(
            IMPORT.import_result(archive_path, self.source, self.raw, self.stage), "imported"
        )

    def test_rejects_path_traversal(self):
        archive = self.archive([
            (self.relative_output.as_posix(), self.body),
            ("../../outside", b"bad"),
        ])
        with self.assertRaisesRegex(ValueError, "unsafe_archive_entry"):
            IMPORT.import_result(archive, self.source, self.raw, self.stage)
        self.assertFalse(self.output.exists())

    def test_rejects_missing_asset(self):
        body = self.body + f"![missing]({self.relative_output.stem}.assets/missing.png)\n"
        archive = self.archive([(self.relative_output.as_posix(), body)])
        with self.assertRaisesRegex(ValueError, "missing_or_unsafe_asset"):
            IMPORT.import_result(archive, self.source, self.raw, self.stage)

    def test_sensitive_result_is_not_imported(self):
        archive = self.archive([(self.relative_output.as_posix(), self.body)])
        self.privacy.return_value = ("student_log",)
        with self.assertRaisesRegex(ValueError, "^privacy_blocked$"):
            IMPORT.import_result(archive, self.source, self.raw, self.stage)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_suffix(".assets").exists())

    def test_unavailable_scan_fails_closed(self):
        archive = self.archive([(self.relative_output.as_posix(), self.body)])
        self.privacy.side_effect = ValueError("privacy_scan_unavailable")
        with self.assertRaisesRegex(ValueError, "^privacy_scan_unavailable$"):
            IMPORT.import_result(archive, self.source, self.raw, self.stage)
        self.assertFalse(self.output.exists())

    def test_existing_result_is_not_overwritten(self):
        self.output.parent.mkdir(parents=True)
        self.output.write_text(self.body)
        archive = self.archive([(self.relative_output.as_posix(), self.body + "new")])
        self.assertEqual(
            IMPORT.import_result(archive, self.source, self.raw, self.stage),
            "already_staged",
        )
        self.assertEqual(self.output.read_text(), self.body)

    def test_office_conversion_requires_unchanged_original_bytes(self):
        source = self.source.removesuffix(".pdf") + ".pptx"
        original = self.raw / source
        original.write_bytes(b"original-presentation")
        digest = Path(source).stem
        conversion = {
            "converter": "isolated-libreoffice",
            "original_sha256": hashlib.sha256(original.read_bytes()).hexdigest(),
            "pdf_sha256": "c" * 64,
        }
        body = BACKFILL.provenance(source, digest, conversion=conversion) + "Slide\n"
        output = Path(source).with_suffix(".md")
        archive = self.archive([(output.as_posix(), body)])
        original.write_bytes(b"changed-presentation")
        with self.assertRaisesRegex(ValueError, "invalid_conversion_provenance"):
            IMPORT.import_result(archive, source, self.raw, self.stage)
        self.assertFalse((self.stage / output).exists())

    def test_office_conversion_import_retains_original_source(self):
        source = self.source.removesuffix(".pdf") + ".docx"
        original = self.raw / source
        original.write_bytes(b"original-document")
        conversion = {
            "converter": "isolated-libreoffice",
            "original_sha256": hashlib.sha256(original.read_bytes()).hexdigest(),
            "pdf_sha256": "c" * 64,
        }
        body = BACKFILL.provenance(
            source, Path(source).stem, conversion=conversion) + "Paragraph\n"
        output = Path(source).with_suffix(".md")
        archive = self.archive([(output.as_posix(), body)])
        self.assertEqual(IMPORT.import_result(archive, source, self.raw, self.stage), "imported")
        self.assertEqual((self.stage / output).read_text(), body)

if __name__ == "__main__":
    unittest.main()
