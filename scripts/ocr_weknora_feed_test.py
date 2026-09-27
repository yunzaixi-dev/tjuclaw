import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "ocr_weknora_feed", Path(__file__).with_name("ocr-weknora-feed.py")
)
assert SPEC is not None and SPEC.loader is not None
FEED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FEED)

KNOWLEDGE_ID = "12345678-1234-1234-1234-123456789abc"


class FakeClient:
    kb = "test_knowledge_base"

    def __init__(self, statuses, chunks=1):
        self.statuses = iter(statuses)
        self.chunks = chunks
        self.reparses = 0

    def request(self, method, path, payload=None, content_type=None):
        if path.endswith("/reparse"):
            self.reparses += 1
            return {"success": True}
        if path.startswith("/chunks/"):
            return {"success": True, "total": self.chunks,
                    "data": [{"knowledge_id": KNOWLEDGE_ID}] if self.chunks else []}
        status = next(self.statuses)
        return {"data": {"knowledge_base_id": self.kb, "parse_status": status,
                         "error_message": "upstream 503 busy embedding"}}


class FeedTests(unittest.TestCase):
    def test_completed_requires_real_chunk_in_same_knowledge(self):
        client = FakeClient(["completed"], chunks=0)
        with self.assertRaisesRegex(RuntimeError, "completed_without_chunks"):
            FEED.wait_for_index(client, KNOWLEDGE_ID, 2, 0)

    def test_transient_busy_reparse_once_then_verify_chunks(self):
        client = FakeClient(["failed", "processing", "completed"])
        self.assertEqual(FEED.wait_for_index(client, KNOWLEDGE_ID, 2, 0), "retried_busy")
        self.assertEqual(client.reparses, 1)

    def test_unknown_failure_is_not_retried(self):
        client = FakeClient(["failed"])
        with self.assertRaisesRegex(RuntimeError, "parse_failed"):
            FEED.wait_for_index(client, KNOWLEDGE_ID, 2, 0, allow_reparse=False)
        self.assertEqual(client.reparses, 0)

    def test_rejects_unsafe_checkpoint_id(self):
        with self.assertRaisesRegex(RuntimeError, "invalid_knowledge_id"):
            FEED.wait_for_index(FakeClient([]), "../other", 2, 0)


if __name__ == "__main__":
    unittest.main()
