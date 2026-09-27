import importlib.util
import io
import json
from pathlib import Path
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "ocr_colab_inference", Path(__file__).with_name("ocr-colab-inference.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class InferenceTest(unittest.TestCase):
    def test_health_requires_expected_model(self):
        for identifier, ready in ((MODULE.MODEL, True), ("another-model", False)):
            response = io.BytesIO(json.dumps({"data": [{"id": identifier}]}).encode())
            opener = Mock()
            opener.open.return_value = response
            with patch.object(MODULE.urllib.request, "build_opener", return_value=opener):
                self.assertEqual(MODULE.server_ready(), ready)
            self.assertEqual(opener.open.call_args.args[0],
                             "http://127.0.0.1:8118/v1/models")

    def test_install_failure_does_not_echo_private_log(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(MODULE.subprocess, "run", side_effect=[
                    SimpleNamespace(returncode=0), SimpleNamespace(returncode=1),
                    SimpleNamespace(returncode=7)]):
                with self.assertRaisesRegex(RuntimeError, "^vllm_install_failed:7$"):
                    MODULE.ensure_dependencies(Path("/venv/bin/python"), Path(directory))

    def test_context_stops_server_after_worker_failure(self):
        process = Mock(pid=123, returncode=None)
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(MODULE, "ensure_dependencies",
                             return_value=Path("/server/bin/python")), \
                patch.object(MODULE, "server_ready", side_effect=[False, True]), \
                patch.object(MODULE.subprocess, "Popen", return_value=process) as spawn, \
                patch.object(MODULE.os, "killpg") as kill:
            with self.assertRaisesRegex(ValueError, "^worker_failed$"):
                with MODULE.inference_server(Path("/venv/bin/python"), Path(directory)) as url:
                    self.assertEqual(url, MODULE.SERVER_URL)
                    raise ValueError("worker_failed")
            kill.assert_called_once_with(123, signal.SIGTERM)
            self.assertIn("127.0.0.1", spawn.call_args.args[0])
            self.assertEqual(spawn.call_args.args[0][0], "/server/bin/python")
            self.assertEqual(json.loads(
                (Path(directory) / "tjuclaw-vllm-config.json").read_text()), MODULE.CONFIG)

    def test_occupied_listener_is_not_reused_or_killed(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(MODULE, "ensure_dependencies"), \
                patch.object(MODULE, "server_ready", return_value=True), \
                patch.object(MODULE.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "^vllm_port_already_in_use$"):
                with MODULE.inference_server(Path("/venv/bin/python"), Path(directory)):
                    pass
            spawn.assert_not_called()

    def test_hard_kill_is_bounded(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("server", 15), 0]
        with patch.object(MODULE.os, "killpg") as kill:
            MODULE.terminate_server(process)
        self.assertEqual([call.args[1] for call in kill.call_args_list],
                         [signal.SIGTERM, signal.SIGKILL])

    def test_server_command_pins_model_and_disables_cross_document_caches(self):
        command = MODULE.server_command(Path("/server/bin/python"))
        self.assertIn(MODULE.MODEL_REVISION, command)
        self.assertIn(MODULE.MODEL_REPOSITORY, command)
        self.assertIn("--no-enable-prefix-caching", command)
        self.assertEqual(command[command.index("--mm-processor-cache-gb") + 1], "0")

    def test_dependency_diagnostics_never_include_raw_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tjuclaw-vllm-install.log").write_text(
                "PRIVATE_SENTINEL\nERROR: No matching distribution found for example==1\n")
            diagnostics = MODULE.dependency_diagnostics(root)
        self.assertEqual(diagnostics["unavailable_packages"], ["example"])
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(diagnostics))


if __name__ == "__main__":
    unittest.main()
