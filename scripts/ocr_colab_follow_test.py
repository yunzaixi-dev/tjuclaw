import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "ocr_colab_follow", Path(__file__).with_name("ocr-colab-follow.py"))
FOLLOW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FOLLOW)


class FollowGateTest(unittest.TestCase):
    def check(self, events):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "batch.jsonl"
            log.write_text(
                "".join(json.dumps(event) + "\n" for event in events),
                encoding="utf-8",
            )
            return FOLLOW.low_success_rate(log)

    def test_infrastructure_batch_failure_does_not_count_as_document_failures(self):
        events = (
            [{"event": "cloud_imported"}] * 5
            + [{"event": "cloud_failed", "reason": "generation_loop"}]
            + [{"event": "cloud_batch_failed", "count": 4}]
        )
        self.assertFalse(self.check(events))

    def test_document_failures_still_stop_continuation(self):
        events = (
            [{"event": "cloud_imported"}] * 2
            + [{"event": "cloud_failed", "reason": "generation_loop"}] * 4
        )
        self.assertTrue(self.check(events))

    def test_previous_batch_failure_limits_next_run_to_one_document(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "batch.jsonl").write_text(
                '{"event":"cloud_imported"}\n'
                '{"event":"cloud_batch_failed","count":4}\n',
                encoding="utf-8",
            )
            batch = Mock()
            batch.command.side_effect = lambda args, timeout: (
                "Current balance: 100 compute units\n" if args == ["usage"] else ""
            )
            with patch.object(FOLLOW, "load_batch", return_value=batch), \
                    patch.object(FOLLOW.subprocess, "run", return_value=Mock(returncode=0)) as run:
                result = FOLLOW.main([
                    "--raw-repo", directory, "--staging", directory,
                    "--state-dir", directory, "--limit", "24",
                ])
            self.assertEqual(result, 0)
            invocation = run.call_args.args[0]
            self.assertEqual(invocation[invocation.index("--limit") + 1], "1")

    def test_waits_for_active_ocr_colab_unit_before_new_session(self):
        with tempfile.TemporaryDirectory() as directory:
            batch = Mock()
            batch.command.side_effect = lambda args, timeout: (
                "Current balance: 100 compute units\n" if args == ["usage"] else ""
            )
            polls = []
            def fake_run(args, **kwargs):
                if args[:3] == ["systemctl", "--user", "is-active"]:
                    polls.append(args)
                    return Mock(returncode=0 if len(polls) == 1 else 1)
                return Mock(returncode=0)
            with patch.object(FOLLOW, "load_batch", return_value=batch), \
                    patch.object(FOLLOW.subprocess, "run", side_effect=fake_run), \
                    patch.object(FOLLOW.time, "sleep") as sleep:
                result = FOLLOW.main([
                    "--raw-repo", directory, "--staging", directory,
                    "--state-dir", directory,
                    "--wait-for-unit", "tjuclaw-ocr-colab-selected3to6-20260927.service",
                    "--limit", "4",
                ])
            self.assertEqual(result, 0)
            self.assertEqual(len(polls), 2)
            self.assertEqual([call.args[0] for call in batch.command.call_args_list][:2],
                             [["usage"], ["new", "-s", "tjuclaw-ocr", "--gpu", "L4"]])
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [30, 10])


if __name__ == "__main__":
    unittest.main()
