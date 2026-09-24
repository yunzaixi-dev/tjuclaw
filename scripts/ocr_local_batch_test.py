import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("ocr-local-batch.py")
SPEC = importlib.util.spec_from_file_location("ocr_local_batch", SCRIPT)
assert SPEC and SPEC.loader
BATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BATCH)


class LocalBatchTest(unittest.TestCase):
    def test_attempts_survive_incomplete_log_and_are_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "batch.jsonl"
            log.write_text('bad\n' + json.dumps({"event": "batch_attempt", "source_path": "a"}) + "\n"
                           + '{"event":"batch_attempt"', encoding="utf-8")
            self.assertEqual(BATCH.attempted(log), {"a"})

    def test_failed_selection_is_retryable(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "batch.jsonl"
            log.write_text(
                '{"event":"batch_attempt","source_path":"a"}\n'
                '{"event":"batch_failed","source_path":"a"}\n'
                '{"event":"batch_complete","source_path":"b"}\n',
                encoding="utf-8",
            )
            self.assertEqual(BATCH.failed_paths(log), {"a"})

    def test_retry_selection_can_read_failures_from_primary_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "raw"
            stage = root / "stage"
            content = b"pdf"
            digest = hashlib.sha256(content).hexdigest()
            relative = (
                "sources/course/public-course-sharing/title/"
                f"{'ab' * 32}.attachments/{digest}.pdf"
            )
            source = raw / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(content)
            primary_log = root / "primary.jsonl"
            primary_log.write_text(
                json.dumps({"event": "batch_failed", "source_path": relative}) + "\n",
                encoding="utf-8",
            )
            retry_log = root / "retry.jsonl"
            with patch.object(BATCH, "page_count", return_value=1):
                choices = BATCH.select(
                    raw,
                    stage,
                    retry_log,
                    2,
                    100,
                    retry_failed=True,
                    retry_log=primary_log,
                )
            self.assertEqual([item[2] for item in choices], [relative])

    def test_batch_size_is_positive(self):
        with self.assertRaises(SystemExit):
            BATCH.main([
                "--raw-repo", "/tmp/raw", "--staging", "/tmp/stage",
                "--state-dir", "/tmp/state", "--python", "/tmp/python",
                "--batch-size", "0",
            ])

    def test_pdf_page_count(self):
        from types import SimpleNamespace
        with patch.object(BATCH.subprocess, "run",
                          return_value=SimpleNamespace(stdout="Pages:  2\n", returncode=0)):
            self.assertEqual(BATCH.page_count(Path("/tmp/a.pdf")), 2)
        with patch.object(BATCH.subprocess, "run",
                          return_value=SimpleNamespace(stdout="broken", returncode=1)):
            self.assertIsNone(BATCH.page_count(Path("/tmp/a.pdf")))

    def test_full_selection_includes_office_image_text_and_unknown_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "raw"
            stage = root / "stage"
            for suffix in (".pdf", ".png", ".docx", ".txt", ".zip"):
                data = f"body{suffix}".encode()
                digest = hashlib.sha256(data).hexdigest()
                path = raw / f"sources/course/public-course-sharing/title/{'ab' * 32}.attachments/{digest}{suffix}"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            with patch.object(BATCH, "page_count", return_value=None):
                paths = BATCH.select(raw, stage, root / "log", 2, 100, True)
                self.assertEqual({Path(item[2]).suffix for item in paths},
                                 {".pdf", ".png", ".docx", ".txt"})
                only_pdf = BATCH.select(raw, stage, root / "log", 2, 100)
                self.assertEqual({Path(item[2]).suffix for item in only_pdf}, {".pdf"})


if __name__ == "__main__":
    unittest.main()
