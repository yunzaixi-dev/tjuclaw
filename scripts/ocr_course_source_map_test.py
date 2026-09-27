import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "ocr_course_source_map", Path(__file__).with_name("ocr-course-source-map.py")
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CourseMapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.staging = self.root / "staging"
        child = "/课程/合成示例.pdf"
        self.digest = hashlib.sha256(
            hashlib.sha256(child.encode()).hexdigest().encode()
        ).hexdigest()
        self.relative = (
            "sources/course/public-course-sharing/synthetic/"
            + self.digest + ".attachments/" + "f" * 64 + ".md"
        )
        p = self.staging / self.relative
        p.parent.mkdir(parents=True)
        p.write_text("Synthetic only")

    def test_maps_only_catalog_verified_digest_without_document_read(self):
        def fetch(path, cursor):
            if path == "/":
                return {"folder": {"value": [{"name": "课程", "folder": {}}]}}
            self.assertEqual(path, "/课程")
            return {"folder": {"value": [
                {"name": "合成示例.pdf", "file": {}},
                {"name": "unrelated.pdf", "file": {}},
            ]}}
        mapping, counts = MODULE.catalog_map(self.staging, fetch)
        self.assertEqual(mapping, {
            self.relative: "https://cs.tjuse.com/%E8%AF%BE%E7%A8%8B/%E5%90%88%E6%88%90%E7%A4%BA%E4%BE%8B.pdf"
        })
        self.assertEqual(counts, {"requests": 2, "matched": 1, "targets": 1})
        out = self.root / "source-map.json"
        MODULE.save_map(out, mapping)
        self.assertEqual(json.loads(out.read_text()), mapping)
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)

    def test_raw_attachment_can_be_mapped_before_ocr_without_reading_its_body(self):
        raw = self.root / "raw"
        relative = self.relative.removesuffix(".md") + ".pdf"
        source = raw / relative
        source.parent.mkdir(parents=True)
        source.write_bytes(b"synthetic attachment, not a real PDF")
        (self.staging / self.relative).unlink()

        def fetch(path, cursor):
            if path == "/":
                return {"folder": {"value": [{"name": "课程", "folder": {}}]}}
            return {"folder": {"value": [{"name": "合成示例.pdf", "file": {}}]}}

        mapping, counts = MODULE.catalog_map(self.staging, fetch, raw_repo=raw)
        self.assertEqual(set(mapping), {self.relative})
        self.assertEqual(counts["targets"], 1)
        self.assertEqual(counts["matched"], 1)

    def test_raw_attachment_under_symlinked_directory_is_not_mapped(self):
        raw = self.root / "raw"
        actual = self.root / "outside"
        actual.mkdir()
        (actual / ("f" * 64 + ".pdf")).write_bytes(b"outside")
        folder = raw / Path(self.relative).parent
        folder.parent.mkdir(parents=True)
        folder.symlink_to(actual, target_is_directory=True)
        (self.staging / self.relative).unlink()
        self.assertEqual(MODULE.staged_targets(self.staging, raw), {})

    def test_merging_catalog_keeps_existing_citations_and_rejects_conflicts(self):
        existing = {self.relative: "https://cs.tjuse.com/existing"}
        second = self.relative.replace("f" * 64 + ".md", "e" * 64 + ".md")
        merged = MODULE.merge_verified_maps(
            existing, {self.relative: existing[self.relative],
                       second: "https://cs.tjuse.com/new"},
        )
        self.assertEqual(len(merged), 2)
        with self.assertRaisesRegex(ValueError, "conflicting_catalog_source"):
            MODULE.merge_verified_maps(
                existing, {self.relative: "https://cs.tjuse.com/changed"},
            )
        with self.assertRaisesRegex(ValueError, "invalid_catalog_url"):
            MODULE.merge_verified_maps(existing, {second: "https://elsewhere.invalid/new"})

    def test_pagination_and_invalid_cursor_are_bounded(self):
        def fetch(path, cursor):
            return {"folder": {"value": []}, "next": "same"}
        with self.assertRaisesRegex(RuntimeError, "invalid_catalog_cursor"):
            MODULE.catalog_map(self.staging, fetch)
        with self.assertRaisesRegex(ValueError, "invalid_request_limit"):
            MODULE.catalog_map(self.staging, fetch, max_requests=0)

    def test_rejects_unsafe_catalog_items(self):
        for name in ("../secret", "a/b", "a\\b", "\n"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(RuntimeError, "invalid_catalog_item"):
                    MODULE.catalog_map(self.staging, lambda path, cursor: {
                        "folder": {"value": [{"name": name, "file": {}}]}
                    })

    def test_no_match_does_not_fabricate_citation(self):
        mapping, counts = MODULE.catalog_map(self.staging, lambda path, cursor: {
            "folder": {"value": [{"name": "other.pdf", "file": {}}]}
        })
        self.assertEqual(mapping, {})
        self.assertEqual(counts["matched"], 0)
