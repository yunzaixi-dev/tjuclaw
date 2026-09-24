import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("ocr_archive_fetch", Path(__file__).with_name("ocr-archive-fetch.py"))
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ArchiveFetchTests(unittest.TestCase):
    def test_verified_override_materializes_all_placements(self):
        data = b"<html>the exact stored object</html>"
        digest = hashlib.sha256(data).hexdigest()
        key = f"archive/sources/public-course-sharing/raw/{digest[:2]}/{digest[2:4]}/{digest}.htm"
        paths = [
            f"sources/course/public-course-sharing/first/{'a' * 64}.attachments/{digest}.htm",
            f"sources/course/public-course-sharing/second/{'b' * 64}.attachments/{digest}.htm",
        ]
        record = {"key": key, "sha256": digest, "size_bytes": len(data), "paths": paths}
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            override = base / "override"
            override.mkdir()
            (override / f"{digest}.htm").write_bytes(data)
            downloaded, placed = MODULE.fetch_object(record, base / "raw", override)
            self.assertFalse(downloaded)
            self.assertEqual(placed, 2)
            for relative in paths:
                self.assertEqual((base / "raw" / relative).read_bytes(), data)

    def test_rejects_corrupted_override_without_materializing(self):
        data = b"original"
        digest = hashlib.sha256(data).hexdigest()
        key = f"archive/sources/public-course-sharing/raw/{digest[:2]}/{digest[2:4]}/{digest}.htm"
        relative = f"sources/course/public-course-sharing/first/{'a' * 64}.attachments/{digest}.htm"
        record = {"key": key, "sha256": digest, "size_bytes": len(data), "paths": [relative]}
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            override = base / "override"
            override.mkdir()
            (override / f"{digest}.htm").write_bytes(b"not-good")
            with self.assertRaisesRegex(ValueError, "archive_override_checksum_mismatch"):
                MODULE.fetch_object(record, base / "raw", override)
            self.assertFalse((base / "raw" / relative).exists())


if __name__ == "__main__":
    unittest.main()
