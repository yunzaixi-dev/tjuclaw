import hashlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
from contextlib import redirect_stderr
from contextlib import redirect_stdout
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BATCH = load("ocr_colab_batch", "ocr-colab-batch.py")
WORKER = load("ocr_colab_batch_worker", "ocr-colab-batch-worker.py")
FOLLOW = load("ocr_colab_follow", "ocr-colab-follow.py")
BACKFILL = load("ocr_backfill", "ocr-backfill.py")


class ColabBatchTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.relative = (
            f"sources/course/public-course-sharing/test/{'a' * 64}.attachments/"
            f"{'b' * 64}.pdf"
        )
        self.source = self.root / self.relative
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b"%PDF-1.4\nsafe test")
        self.archive = self.root / "bundle.tar.gz"

    def test_environment_install_separates_paddle_index_from_dependencies(self):
        python = self.root / "tjuclaw-ocr-venv/bin/python"
        python.parent.mkdir(parents=True)
        python.touch()
        with patch.object(WORKER, "ROOT", self.root), \
                patch.object(WORKER, "METRICS", self.root / "metrics.json"), \
                patch.object(WORKER.subprocess, "run", side_effect=[
                    SimpleNamespace(returncode=1),
                    SimpleNamespace(returncode=0),
                    SimpleNamespace(returncode=0),
                ]) as run:
            self.assertEqual(WORKER.ensure_environment(), python)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn("m.version('paddlepaddle-gpu') == '3.3.0'", commands[0][-1])
        self.assertIn("--no-deps", commands[1])
        self.assertIn("--only-binary=:all:", commands[1])
        self.assertIn("https://www.paddlepaddle.org.cn/packages/stable/cu126/", commands[1])
        self.assertIn("https://pypi.org/simple", commands[2])
        self.assertNotIn("--extra-index-url", commands[2])
        self.assertNotIn("--no-deps", commands[2])
        self.assertEqual(json.loads((self.root / "metrics.json").read_text())["phase"],
                         "install_ocr_dependencies")

    def test_environment_install_failure_never_starts_next_step(self):
        python = self.root / "tjuclaw-ocr-venv/bin/python"
        python.parent.mkdir(parents=True)
        python.touch()
        with patch.object(WORKER, "ROOT", self.root), \
                patch.object(WORKER, "METRICS", self.root / "metrics.json"), \
                patch.object(WORKER.subprocess, "run", side_effect=[
                    SimpleNamespace(returncode=1),
                    SimpleNamespace(returncode=2),
                ]) as run:
            with self.assertRaisesRegex(RuntimeError, "ocr_install_failed:2"):
                WORKER.ensure_environment()
        self.assertEqual(run.call_count, 2)

    def test_bundle_round_trip(self):
        BATCH.bundle(self.archive, [(self.relative, self.source, self.source.stat().st_size)])
        items = WORKER.prepare_input(self.archive, self.root / "remote", BACKFILL)
        self.assertEqual(items[0]["source"], self.relative)
        self.assertEqual((self.root / "remote" / self.relative).read_bytes(), self.source.read_bytes())

    def test_batch_uploads_pipeline_to_fresh_colab_session(self):
        uploads = []
        def command(args, timeout):
            if args[0] == "upload":
                uploads.append((Path(args[3]).name, args[4]))
                return ""
            raise RuntimeError("stop_before_remote_execution")

        with patch.object(BATCH, "command", side_effect=command), \
             self.assertRaisesRegex(RuntimeError, "stop_before_remote_execution"):
            BATCH.run_batch(
                [(self.relative, self.source, self.source.stat().st_size)],
                self.root, self.root / "stage", "fresh-session",
                SimpleNamespace(import_result=Mock()), io.StringIO(),
            )
        self.assertEqual([destination for _, destination in uploads], [
            "/content/tjuclaw-ocr-batch.tar.gz", "/content/ocr-backfill.py",
        ])

    def test_converted_office_bundle_contains_only_pdf_and_original_binding(self):
        original = self.relative.removesuffix(".pdf") + ".pptx"
        metadata = {original: {
            "pdf_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "original_sha256": "c" * 64,
        }}
        BATCH.bundle(self.archive, [(original, self.source, self.source.stat().st_size)],
                     metadata)
        remote = self.root / "remote"
        manifest = WORKER.prepare_input(self.archive, remote, BACKFILL)
        self.assertEqual(manifest[0]["source"], original)
        self.assertEqual(manifest[0]["input"], self.relative)
        self.assertEqual(manifest[0]["original_sha256"], "c" * 64)
        self.assertTrue((remote / self.relative).is_file())
        self.assertFalse((remote / original).exists())

    def test_bundle_rejects_changed_prepared_pdf(self):
        original = self.relative.removesuffix(".pdf") + ".docx"
        with self.assertRaisesRegex(ValueError, "prepared_pdf_changed"):
            BATCH.bundle(self.archive, [(original, self.source, self.source.stat().st_size)],
                         {original: {"pdf_sha256": "c" * 64, "original_sha256": "d" * 64}})

    def test_rejects_tampered_source(self):
        BATCH.bundle(self.archive, [(self.relative, self.source, self.source.stat().st_size)])
        with tarfile.open(self.archive, "r:gz") as archive:
            manifest = archive.extractfile("manifest.json").read()
        changed = self.root / "changed.tar.gz"
        with tarfile.open(changed, "w:gz") as archive:
            for name, value in ((self.relative, b"%PDF-1.4\nchanged!!"),
                                ("manifest.json", manifest)):
                info = tarfile.TarInfo(name)
                info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
        with self.assertRaisesRegex(ValueError, "input_checksum_mismatch"):
            WORKER.prepare_input(changed, self.root / "remote", BACKFILL)

    def test_rejects_extra_archive_member(self):
        BATCH.bundle(self.archive, [(self.relative, self.source, self.source.stat().st_size)])
        with tarfile.open(self.archive, "r:gz") as archive:
            records = [(entry.name, archive.extractfile(entry).read()) for entry in archive]
        changed = self.root / "extra.tar.gz"
        with tarfile.open(changed, "w:gz") as archive:
            for name, value in [*records, ("../../secret", b"bad")]:
                info = tarfile.TarInfo(name)
                info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
        with self.assertRaisesRegex(ValueError, "unexpected_archive_member"):
            WORKER.prepare_input(changed, self.root / "remote", BACKFILL)

    def test_screen_fails_closed_for_uninspectable_pdf(self):
        with patch.object(BATCH.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b""
            self.assertEqual(BATCH.screen_pdf(self.source, self.relative), "uninspectable_text")
            self.assertEqual(run.call_count, 1)

    def test_flags_suspicious_repetition_without_exposing_text(self):
        self.assertEqual(BATCH.quality_flags(("repeated long phrase\n" * 40)), ["repeated_lines"])
        self.assertEqual(BATCH.quality_flags("ordinary short output"), [])

    def test_known_failure_skip_retries_batch_level_failures(self):
        log = self.root / "batch.jsonl"
        log.write_text(
            json.dumps({"event": "cloud_failed", "id": "one"}) + "\n"
            + json.dumps({"event": "cloud_batch_failed", "ids": ["two"]}) + "\n"
            + json.dumps({"event": "cloud_report_missing", "id": "three",
                          "reason": "report_mismatch"}) + "\n"
            + json.dumps({"event": "cloud_failed", "id": "four",
                          "reason": "report_mismatch"}) + "\n"
        )
        self.assertEqual(BATCH.known_failures(log), {"one"})

    def test_follow_requires_reported_balance(self):
        self.assertEqual(FOLLOW.parse_balance("Current balance: 42.25 compute units\n"), 42.25)
        with self.assertRaises(ValueError):
            FOLLOW.parse_balance("Active assignments: 2\n")

    def test_follow_stops_repeating_low_yield_gpu_run(self):
        log = self.root / "batch.jsonl"
        log.write_text(
            "\n".join(
                json.dumps({"event": "cloud_imported" if index == 0 else "cloud_failed"})
                for index in range(6)
            ) + "\n"
        )
        self.assertTrue(FOLLOW.low_success_rate(log))
        log.write_text(
            "\n".join(json.dumps({"event": "cloud_imported"}) for _ in range(6)) + "\n"
        )
        self.assertFalse(FOLLOW.low_success_rate(log))

    def test_follow_recovers_after_recent_successes(self):
        log = self.root / "batch.jsonl"
        events = [{"event": "cloud_failed"} for _ in range(20)]
        events.extend({"event": "cloud_imported"} for _ in range(4))
        log.write_text("\n".join(json.dumps(event) for event in events) + "\n")
        self.assertFalse(FOLLOW.low_success_rate(log))

    def test_worker_classifies_errors_without_returning_content(self):
        event = json.dumps({
            "event": "ocr_failed", "source_path": self.relative,
            "error": "ocr_generation_loop: private document text",
        })
        self.assertEqual(WORKER.failure_categories(event), {self.relative: "generation_loop"})

    def test_pipeline_timeout_retains_partial_events(self):
        partial = b'{"event":"ocr_complete","pages":2}\n'
        with patch.object(WORKER.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                ["worker"], 10, output=partial)):
            output, timed_out = WORKER.run_pipeline(["worker"], 10)
        self.assertTrue(timed_out)
        self.assertEqual(json.loads(output)["pages"], 2)

    def test_main_packages_success_and_prints_final_report(self):
        paths = {
            "ROOT": self.root / "remote",
            "RAW": self.root / "remote/raw",
            "STAGE": self.root / "remote/stage",
            "RESULTS": self.root / "remote/results",
            "REPORT": self.root / "remote/report.json",
            "METRICS": self.root / "remote/metrics.json",
        }
        paths["ROOT"].mkdir()
        manifest = [{"source": self.relative, "sha256": "b" * 64, "size": 20}]

        def pipeline(command, timeout):
            output = paths["STAGE"] / Path(self.relative).with_suffix(".md")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(BACKFILL.provenance(self.relative, "b" * 64) + "# Test\n")
            return "", False

        capture = io.StringIO()
        with patch.multiple(WORKER, **paths), \
                patch.object(WORKER, "load_backfill", return_value=BACKFILL), \
                patch.object(WORKER, "prepare_input", return_value=manifest), \
                patch.object(WORKER, "ensure_environment", return_value=Path("/venv/bin/python")), \
                patch.object(WORKER, "inference_backend", return_value="native"), \
                patch.object(WORKER, "monitor_gpu"), \
                patch.object(WORKER, "run_pipeline", side_effect=pipeline), \
                redirect_stdout(capture):
            WORKER.main()
        final = json.loads(capture.getvalue())
        self.assertEqual(final["completed"], 1)
        self.assertEqual(final["backend"], "native")
        report = json.loads(paths["REPORT"].read_text())
        self.assertTrue(report[0]["ok"])
        self.assertTrue((paths["RESULTS"] / (report[0]["id"] + ".tar.gz")).is_file())

    def test_gpu_metrics_validate_provider_output(self):
        with patch.object(WORKER.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout="87, 12345, 40960\n")):
            self.assertEqual(WORKER.gpu_sample(), {
                "utilization_percent": 87, "memory_used_mib": 12345,
                "memory_total_mib": 40960,
            })
        with patch.object(WORKER.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout="private provider diagnostic")):
            self.assertEqual(WORKER.gpu_sample(), {})

    def test_worker_bootstrap_diagnostic_excludes_arbitrary_error_text(self):
        with patch.object(WORKER, "ROOT", self.root):
            private = WORKER.failure_status(RuntimeError("PRIVATE_SENTINEL"))
            known = WORKER.failure_status(RuntimeError("vllm_install_failed:1"))
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(private))
        self.assertEqual(known["reason"], "vllm_install_failed:1")

    def test_gpu_report_excludes_provider_text_and_nonfinite_values(self):
        valid = {
            "event": "gpu_metrics", "elapsed_seconds": 100, "samples": 10,
            "average_utilization_percent": 75, "peak_memory_used_mib": 20000,
            "private": "PRIVATE_SENTINEL",
        }
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(BATCH.checked_gpu_metrics(valid)))
        self.assertIsNone(BATCH.checked_gpu_metrics({**valid, "elapsed_seconds": float("nan")}))
        self.assertIsNone(BATCH.checked_gpu_metrics({"event": "worker_phase"}))

    def test_worker_restores_office_source_provenance_after_pdf_inference(self):
        original = self.relative.removesuffix(".pdf") + ".docx"
        paths = {
            "ROOT": self.root / "remote",
            "RAW": self.root / "remote/raw",
            "STAGE": self.root / "remote/stage",
            "RESULTS": self.root / "remote/results",
            "REPORT": self.root / "remote/report.json",
            "METRICS": self.root / "remote/metrics.json",
        }
        paths["ROOT"].mkdir()
        manifest = [{"source": original, "input": self.relative, "sha256": "c" * 64,
                     "original_sha256": "d" * 64, "size": 20}]

        def pipeline(command, timeout):
            input_list = paths["ROOT"] / "tjuclaw-ocr-batch-input.txt"
            self.assertEqual(input_list.read_text().strip(), self.relative)
            output = paths["STAGE"] / Path(self.relative).with_suffix(".md")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(BACKFILL.provenance(self.relative, "b" * 64) + "# Office\n")
            return "", False

        with patch.multiple(WORKER, **paths), \
                patch.object(WORKER, "load_backfill", return_value=BACKFILL), \
                patch.object(WORKER, "prepare_input", return_value=manifest), \
                patch.object(WORKER, "ensure_environment", return_value=Path("/venv/bin/python")), \
                patch.object(WORKER, "inference_backend", return_value="native"), \
                patch.object(WORKER, "monitor_gpu"), \
                patch.object(WORKER, "run_pipeline", side_effect=pipeline), \
                redirect_stdout(io.StringIO()):
            WORKER.main()
        output = paths["STAGE"] / Path(original).with_suffix(".md")
        body = output.read_text()
        self.assertTrue(BACKFILL.staged_with_provenance(output, original, "b" * 64))
        self.assertIn('"original_sha256": "' + "d" * 64 + '"', body)
        self.assertTrue(body.endswith("# Office\n"))

    def test_compute_budget_fails_closed(self):
        log = io.StringIO()
        with patch.object(BATCH, "command", return_value="Current balance: 24 compute units\n"):
            self.assertFalse(BATCH.sufficient_balance(25, log))
        self.assertEqual(json.loads(log.getvalue())["reason"], "insufficient_balance")
        log = io.StringIO()
        with patch.object(BATCH, "command", return_value="unexpected PRIVATE_SENTINEL"):
            self.assertFalse(BATCH.sufficient_balance(25, log))
        self.assertNotIn("PRIVATE_SENTINEL", log.getvalue())
        with patch.object(BATCH, "command", return_value="Current balance: 188 compute units\n"):
            self.assertTrue(BATCH.sufficient_balance(25, io.StringIO()))

    def test_unknown_failure_reason_does_not_discard_successful_result(self):
        other = self.relative.replace("b" * 64, "c" * 64)
        other_file = self.root / other
        other_file.write_bytes(self.source.read_bytes())
        selected = [
            (self.relative, self.source, self.source.stat().st_size),
            (other, other_file, other_file.stat().st_size),
        ]
        report = [
            {"id": hashlib.sha256(self.relative.encode()).hexdigest(), "ok": True},
            {"id": hashlib.sha256(other.encode()).hexdigest(), "ok": False,
             "reason": "model returned an unexpected error with private content"},
        ]
        stage = self.root / "stage"

        def command(args, timeout):
            if args[0] == "download":
                if args[3].endswith("report.json"):
                    Path(args[4]).write_text(json.dumps(report))
                else:
                    Path(args[4]).touch()
            return ""

        def import_result(archive, source, raw, staging):
            output = staging / Path(source).with_suffix(".md")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("verified Markdown")
            return "imported"

        log = io.StringIO()
        with patch.object(BATCH, "command", side_effect=command), \
                patch.object(BATCH, "quality_flags", return_value=[]):
            BATCH.run_batch(selected, self.root, stage, "test-session",
                            SimpleNamespace(import_result=Mock(side_effect=import_result)), log)
        events = [json.loads(line) for line in log.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events],
                         ["cloud_execution_complete", "cloud_metrics_unavailable",
                          "cloud_imported", "cloud_failed"])
        self.assertEqual(next(event for event in events
                              if event["event"] == "cloud_failed")["reason"], "other")
        self.assertNotIn("private content", log.getvalue())

    def test_unmatched_report_row_does_not_discard_matched_result(self):
        other = self.relative.replace("b" * 64, "c" * 64)
        other_file = self.root / other
        other_file.write_bytes(self.source.read_bytes())
        selected = [
            (self.relative, self.source, self.source.stat().st_size),
            (other, other_file, other_file.stat().st_size),
        ]
        report = [
            {"id": hashlib.sha256(self.relative.encode()).hexdigest(), "ok": True},
            {"id": "0" * 64, "ok": True},
        ]
        stage = self.root / "stage"

        def command(args, timeout):
            if args[0] == "download":
                if args[3].endswith("report.json"):
                    Path(args[4]).write_text(json.dumps(report))
                else:
                    Path(args[4]).touch()
            return ""

        def import_result(archive, source, raw, staging):
            output = staging / Path(source).with_suffix(".md")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("verified Markdown")
            return "imported"

        log = io.StringIO()
        with patch.object(BATCH, "command", side_effect=command), \
                patch.object(BATCH, "quality_flags", return_value=[]):
            BATCH.run_batch(selected, self.root, stage, "test-session",
                            SimpleNamespace(import_result=Mock(side_effect=import_result)), log)
        events = [json.loads(line) for line in log.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events],
                         ["cloud_execution_complete", "cloud_metrics_unavailable",
                          "cloud_report_partial",
                          "cloud_imported", "cloud_report_missing"])
        self.assertEqual(events[-1]["reason"], "report_mismatch")
        self.assertEqual((stage / Path(self.relative).with_suffix(".md")).read_text(),
                         "verified Markdown")
        self.assertFalse((stage / Path(other).with_suffix(".md")).exists())

    def test_retry_timeout_is_bounded_and_forwarded_to_worker(self):
        with patch.dict(os.environ, {"TJUCLAW_OCR_DOCUMENT_TIMEOUT_SECONDS": "1200"}):
            self.assertEqual(WORKER.ocr_timeout_seconds(), 1200)
        with patch.dict(os.environ, {"TJUCLAW_OCR_DOCUMENT_TIMEOUT_SECONDS": "9999"}):
            with self.assertRaises(ValueError):
                WORKER.ocr_timeout_seconds()
        with patch.dict(os.environ, {"TJUCLAW_OCR_REPETITION_PENALTY": "1.2"}):
            self.assertEqual(WORKER.repetition_penalty(), 1.2)
        with patch.dict(os.environ, {"TJUCLAW_OCR_REPETITION_PENALTY": "1.8"}):
            with self.assertRaises(ValueError):
                WORKER.repetition_penalty()

        report = [{"id": hashlib.sha256(self.relative.encode()).hexdigest(),
                   "ok": False, "reason": "generation_loop"}]
        calls = []

        def command(args, timeout):
            calls.append((args, timeout))
            if args[0] == "download":
                Path(args[4]).write_text(json.dumps(report))
            return ""

        with patch.object(BATCH, "command", side_effect=command):
            BATCH.run_batch(
                [(self.relative, self.source, self.source.stat().st_size)],
                self.root, self.root / "stage", "test-session",
                SimpleNamespace(), io.StringIO(), document_timeout_seconds=1200,
                repetition_penalty=1.2,
            )
        execution = next((args, timeout) for args, timeout in calls if args[0] == "exec")
        self.assertIn("TJUCLAW_OCR_DOCUMENT_TIMEOUT_SECONDS=1200", execution[0])
        self.assertIn("TJUCLAW_OCR_REPETITION_PENALTY=1.2", execution[0])
        self.assertGreaterEqual(execution[1], 2500)

    def test_rejects_non_hash_only_id(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit):
            BATCH.main(["--raw-repo", str(self.root), "--staging", str(self.root),
                        "--state-dir", str(self.root), "--only-id", "../../unsafe"])
        self.assertIn("invalid --only-id", stderr.getvalue())

    def test_limit_counts_screened_candidates_and_dry_run_never_calls_colab(self):
        selected = []
        for index in range(3):
            relative = self.relative.replace("b" * 64, f"{index + 1:064x}")
            path = self.root / relative
            path.write_bytes(self.source.read_bytes())
            selected.append((relative, path, path.stat().st_size))
        with patch.object(BATCH, "candidates", return_value=selected), \
                patch.object(BATCH, "page_count", return_value=1), \
                patch.object(BATCH, "screen_pdf",
                             side_effect=["uninspectable_text", None, None]), \
                patch.object(BATCH, "command") as command:
            BATCH.main([
                "--raw-repo", str(self.root), "--staging", str(self.root / "stage"),
                "--state-dir", str(self.root / "state"), "--limit", "1",
                "--max-pages", "1", "--dry-run", "--stop-session-on-exit",
            ])
        events = [json.loads(line) for line in
                  (self.root / "state" / "batch.jsonl").read_text().splitlines()]
        self.assertEqual([item["event"] for item in events],
                         ["cloud_plan", "cloud_deferred", "cloud_ready", "cloud_finished"])
        command.assert_not_called()


    def test_existing_stage_target_is_skipped_without_printing_body(self):
        marker = "TEXTLAYER_BODY_SENTINEL_" + ("m" * 24)
        output = Path(self.relative).with_suffix(".md")
        staged = self.root / "stage" / output
        staged.parent.mkdir(parents=True)
        staged.write_text("<!-- text-layer -->\n" + marker + "\n", encoding="utf-8")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            found = BATCH.candidates(self.root, self.root / "stage", BACKFILL)
        self.assertEqual(found, [])
        self.assertNotIn(marker, stdout.getvalue())
        self.assertNotIn(marker, stderr.getvalue())
        self.assertLess(staged.stat().st_size, 200)

    def test_prepared_office_with_stage_target_is_skipped_without_printing_body(self):
        marker = "OFFICE_TEXTLAYER_SENTINEL_" + ("n" * 24)
        relative = (
            f"sources/course/public-course-sharing/test/{'c' * 64}.attachments/"
            f"{'d' * 64}.docx"
        )
        original = self.root / relative
        original.parent.mkdir(parents=True)
        original.write_bytes(b"PK\x03\x04not-a-real-office-document")
        cache = self.root / "office-cache"
        cache.mkdir()
        key = hashlib.sha256(relative.encode()).hexdigest()
        pdf = cache / f"{key}.pdf"
        pdf.write_bytes(b"%PDF-1.4\nprepared")
        record = {
            "source": relative,
            "original_sha256": hashlib.sha256(original.read_bytes()).hexdigest(),
            "pdf_sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
            "pdf_bytes": pdf.stat().st_size,
            "pages": 8,
            "converter": "isolated-libreoffice",
        }
        (cache / f"{key}.json").write_text(json.dumps(record), encoding="utf-8")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            included, _ = BATCH.prepared_candidates(
                self.root, self.root / "stage", cache, BACKFILL)
        self.assertEqual([item[0] for item in included], [relative])
        output = Path(relative).with_suffix(".md")
        staged = self.root / "stage" / output
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text(marker, encoding="utf-8")
        with redirect_stdout(stdout), redirect_stderr(stderr):
            skipped, _ = BATCH.prepared_candidates(
                self.root, self.root / "stage", cache, BACKFILL)
        self.assertEqual(skipped, [])
        self.assertNotIn(marker, stdout.getvalue())
        self.assertNotIn(marker, stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
