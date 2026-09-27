"""Regression tests for resumable WeKnora OCR uploads."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("ocr-weknora-feed.py")
SPEC = importlib.util.spec_from_file_location("ocr_weknora_feed_recovery", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
feed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(feed)

KB = "knowledge-base-test"
URL = "https://example.edu/course"


def relative(item: str, sha: str) -> str:
    return f"sources/course/public-course-sharing/test/{item}.attachments/{sha}.md"


def row(item: str, sha: str, body: str, identifier: str) -> dict:
    return {
        "id": identifier,
        "knowledge_base_id": KB,
        "metadata": {
            "source": "public-course-sharing",
            "item_id": item,
            "source_sha256": sha,
            "canonical_hash": feed.hashlib.sha256(body.encode()).hexdigest(),
            "source_url": URL,
        },
    }


class Client:
    kb = KB

    def __init__(self, rows):
        self.rows = rows

    def request(self, method, path):
        assert method == "GET" and "/knowledge?page=" in path
        page = int(path.split("page=")[1].split("&")[0])
        return {
            "success": True,
            "data": self.rows[(page - 1) * 100:page * 100],
            "total": len(self.rows),
        }


class RecoveryTests(unittest.TestCase):
    def test_provenance_paginates_and_rejects_ambiguous_uploads(self):
        rows = [
            row(f"{n:064x}", "a" * 64, "body", f"knowledge-{n:04d}")
            for n in range(101)
        ]
        self.assertEqual(len(feed.server_provenance(Client(rows))), 101)
        with self.assertRaisesRegex(RuntimeError, "duplicate_provenance"):
            feed.server_provenance(Client([rows[0], {**rows[0], "id": "knowledge-other"}]))

    def test_provenance_scans_more_than_ten_thousand_campus_documents(self):
        class LargeClient:
            kb = KB
            pages = 0

            def request(self, method, path):
                self.pages += 1
                page = int(path.split("page=")[1].split("&")[0])
                start = (page - 1) * 100
                return {
                    "success": True,
                    "data": [{"id": f"knowledge-{n}", "knowledge_base_id": KB,
                              "metadata": {"source": "website"}}
                             for n in range(start, min(start + 100, 10_001))],
                    "total": 10_001,
                }

        client = LargeClient()
        self.assertEqual(feed.server_provenance(client), {})
        self.assertEqual(client.pages, 101)

    def test_ambiguous_upload_recovers_exact_server_record_without_second_post(self):
        import argparse

        item, sha, body = "a" * 64, "b" * 64, "valid text"
        source = relative(item, sha)
        accepted = row(item, sha, body, "knowledge-recovered")
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            bootstrap = base / "bootstrap.json"
            bootstrap.write_text(json.dumps({"import_api_key": "dummy", "knowledge_base_id": KB}))
            os.chmod(bootstrap, 0o600)
            source_map = base / "source-map.json"
            source_map.write_text(json.dumps({source: URL}))
            manifest = base / "manifest.json"
            args = argparse.Namespace(
                bootstrap=bootstrap, base_url="http://127.0.0.1:18181",
                source_map=source_map, manifest=manifest, batch_map=base / "batch.json",
                staging=base / "stage", raw_repo=base / "raw", repaired=base / "repaired",
                batch_size=3, max_new=10, timeout=20, poll=1,
            )
            client = Client([])
            with (
                mock.patch.object(feed.importer, "WeKnora", return_value=client),
                mock.patch.object(feed.importer, "select_body", return_value=(body, {})),
                mock.patch.object(feed.importer, "public_url", return_value=URL),
                mock.patch.object(feed.importer.llm_script(), "scan_privacy", return_value=()),
                mock.patch.object(feed, "server_provenance", side_effect=[{}, {feed.source_key(source, URL, body): accepted["id"]}]),
                mock.patch.object(feed.importer, "import_documents", return_value={"deferred_weknora_request_failed": 1}) as upload,
                mock.patch.object(feed, "wait_for_index", return_value="indexed"),
                mock.patch.object(feed.time, "sleep"),
            ):
                result = feed.feed(args)
            self.assertEqual(upload.call_count, 1)
            self.assertEqual(result["recovered_upload"], 1)
            self.assertEqual(result["indexed"], 1)
            self.assertEqual(json.loads(manifest.read_text())[source]["knowledge_id"], accepted["id"])
            self.assertEqual(manifest.stat().st_mode & 0o077, 0)

    def test_duplicate_content_under_other_source_is_not_claimed_as_uploaded(self):
        import argparse

        body = "same OCR body"
        source = relative("a" * 64, "b" * 64)
        duplicate = row("c" * 64, "d" * 64, body, "knowledge-duplicate")
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            bootstrap = base / "bootstrap.json"
            bootstrap.write_text(json.dumps({"import_api_key": "dummy", "knowledge_base_id": KB}))
            os.chmod(bootstrap, 0o600)
            source_map = base / "source-map.json"
            source_map.write_text(json.dumps({source: URL}))
            manifest = base / "manifest.json"
            args = argparse.Namespace(
                bootstrap=bootstrap, base_url="http://127.0.0.1:18181",
                source_map=source_map, manifest=manifest, batch_map=base / "batch.json",
                staging=base / "stage", raw_repo=base / "raw", repaired=base / "repaired",
                batch_size=3, max_new=10, timeout=20, poll=1,
            )
            with (
                mock.patch.object(feed.importer, "WeKnora", return_value=Client([duplicate])),
                mock.patch.object(feed.importer, "select_body", return_value=(body, {})),
                mock.patch.object(feed.importer, "public_url", return_value=URL),
                mock.patch.object(feed.importer.llm_script(), "scan_privacy", return_value=()),
                mock.patch.object(feed.importer, "import_documents") as upload,
            ):
                result = feed.feed(args)
            upload.assert_not_called()
            self.assertEqual(result["duplicate_content_deferred"], 1)
            self.assertFalse(manifest.exists())

    def test_duplicate_content_race_does_not_retry_or_checkpoint(self):
        import argparse

        body = "same OCR body"
        source = relative("a" * 64, "b" * 64)
        duplicate = row("c" * 64, "d" * 64, body, "knowledge-duplicate")
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            bootstrap = base / "bootstrap.json"
            bootstrap.write_text(json.dumps({"import_api_key": "dummy", "knowledge_base_id": KB}))
            os.chmod(bootstrap, 0o600)
            source_map = base / "source-map.json"
            source_map.write_text(json.dumps({source: URL}))
            manifest = base / "manifest.json"
            args = argparse.Namespace(
                bootstrap=bootstrap, base_url="http://127.0.0.1:18181",
                source_map=source_map, manifest=manifest, batch_map=base / "batch.json",
                staging=base / "stage", raw_repo=base / "raw", repaired=base / "repaired",
                batch_size=1, max_new=10, timeout=20, poll=1,
            )
            with (
                mock.patch.object(feed.importer, "WeKnora", return_value=Client([])),
                mock.patch.object(feed.importer, "select_body", return_value=(body, {})),
                mock.patch.object(feed.importer, "public_url", return_value=URL),
                mock.patch.object(feed.importer.llm_script(), "scan_privacy", return_value=()),
                mock.patch.object(feed, "server_provenance", side_effect=[
                    {}, {feed.source_key(relative("c" * 64, "d" * 64), URL, body): duplicate["id"]},
                ]),
                mock.patch.object(feed.importer, "import_documents", return_value={"deferred_weknora_request_failed": 1}) as upload,
                mock.patch.object(feed.time, "sleep"),
            ):
                result = feed.feed(args)
            self.assertEqual(upload.call_count, 1)
            self.assertEqual(result["duplicate_content_deferred"], 1)
            self.assertFalse(manifest.exists())


if __name__ == "__main__":
    unittest.main()
