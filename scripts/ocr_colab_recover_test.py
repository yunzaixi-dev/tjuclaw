import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "recovery", Path(__file__).with_name("ocr-colab-recover.py"))
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)


class RecoveryTest(unittest.TestCase):
    def test_report_requires_exact_unique_sources(self):
        expected = {"first": "one", "second": "two"}
        self.assertIsNone(RECOVERY.checked_report(
            [{"id": "first", "ok": True}, {"id": "first", "ok": True}], expected))
        self.assertIsNone(RECOVERY.checked_report([{"id": "first", "ok": True}], expected))
        report = [{"id": "first", "ok": True}, {"id": "second", "ok": False}]
        self.assertEqual(RECOVERY.checked_report(report, expected), report)

    def test_status_timeout_is_retried_without_provider_output(self):
        batch = Mock()
        batch.command.side_effect = subprocess.TimeoutExpired("status", 60)
        self.assertIsNone(RECOVERY.session_status(batch, "session", Mock()))
        self.assertEqual(batch.log_event.call_args.kwargs["reason"], "TimeoutExpired")

    def test_retirement_refuses_replaced_coordinator(self):
        with patch.object(RECOVERY, "coordinator_pid", return_value=456), \
                patch.object(RECOVERY.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "coordinator_identity_changed"):
                RECOVERY.retire_coordinator("unit", 123)
            kill.assert_not_called()

    def test_download_retry_keeps_durable_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "result.tar.gz"
            batch = Mock()
            failures = [True]

            def command(args, timeout):
                if failures:
                    failures.pop()
                    raise subprocess.TimeoutExpired("download", timeout)
                with tarfile.open(args[-1], "w:gz") as content:
                    entry = tarfile.TarInfo("result.md")
                    entry.size = 4
                    content.addfile(entry, io.BytesIO(b"test"))
                return ""

            batch.command.side_effect = command
            with patch.object(RECOVERY, "session_status", return_value="Status: BUSY"), \
                    patch.object(RECOVERY.time, "sleep"):
                RECOVERY.recover_archive(batch, "session", "identifier", archive, Mock())
            self.assertTrue(archive.is_file())
            self.assertFalse(archive.with_suffix(".partial").exists())
            self.assertEqual(batch.command.call_count, 2)


if __name__ == "__main__":
    unittest.main()
