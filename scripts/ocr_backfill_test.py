import importlib.util
import hashlib
import tempfile
import time
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("ocr-backfill.py")
SPEC = importlib.util.spec_from_file_location("ocr_backfill", SCRIPT)
assert SPEC and SPEC.loader
OCR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OCR)


class OcrBackfillTest(unittest.TestCase):
    def test_raw_path_requires_adjacent_content_addressed_layout(self) -> None:
        item_hash = "12" * 32
        sha256 = "ab" * 32
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / f"sources/course/public-course-sharing/高等数学/{item_hash}.attachments/{sha256}.pdf"
            invalid = root / f"sources/course/public-course-sharing/高等数学/not-a-hash.attachments/{sha256}.pdf"
            self.assertEqual(
                OCR.parse_raw_path(root, valid),
                (
                    "public-course-sharing",
                    sha256,
                    Path(f"sources/course/public-course-sharing/高等数学/{item_hash}.attachments/{sha256}.md"),
                ),
            )
            self.assertIsNone(OCR.parse_raw_path(root, invalid))

    def test_generated_asset_paths_cannot_escape_output_directory(self) -> None:
        self.assertEqual(OCR.safe_asset_path("/../../etc/passwd", 1), Path("etc/passwd"))
        self.assertFalse(OCR.safe_asset_path("/../../etc/passwd", 1).is_absolute())

    def test_pixel_budget_is_bounded(self) -> None:
        with self.assertRaises(SystemExit):
            OCR.parse_args(["--raw-repo", "/tmp/raw", "--staging", "/tmp/out", "--max-pixels", "99999999"])
        args = OCR.parse_args([
            "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
            "--max-pixels", "1881600", "--use-queues",
        ])
        self.assertEqual(args.max_pixels, 1881600)
        self.assertEqual(args.page_batch_size, 1)
        self.assertEqual(args.shard_index, 0)
        self.assertEqual(args.shard_count, 1)
        self.assertEqual(args.document_timeout_seconds, OCR.DOCUMENT_TIMEOUT_SECONDS)
        self.assertTrue(args.use_queues)
        self.assertEqual(args.vl_rec_backend, "native")
        self.assertEqual(args.pipeline_device, "gpu:0")
        server = OCR.parse_args([
            "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
            "--vl-rec-backend", "vllm-server",
        ])
        self.assertEqual(server.vl_rec_server_url, "http://127.0.0.1:8118/v1")
        selected = OCR.parse_args(["--raw-repo", "/tmp/raw", "--staging", "/tmp/out", "--include-suffix", ".pdf"])
        self.assertEqual(selected.include_suffix, [".pdf"])
        with self.assertRaises(SystemExit):
            OCR.parse_args([
                "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
                "--vl-rec-backend", "vllm-server", "--vl-rec-server-url", "https://untrusted.example/v1",
            ])
        with self.assertRaises(SystemExit):
            OCR.parse_args([
                "--raw-repo", "/tmp/raw", "--staging", "/tmp/out", "--repetition-penalty", "1.2",
            ])
        shard = OCR.parse_args([
            "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
            "--shard-index", "1", "--shard-count", "2",
        ])
        self.assertEqual((shard.shard_index, shard.shard_count), (1, 2))
        with self.assertRaises(SystemExit):
            OCR.parse_args([
                "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
                "--shard-index", "2", "--shard-count", "2",
            ])

    def test_ocr_reports_pages_and_uses_configured_pixel_budget(self) -> None:
        class Pipeline:
            def predict(self, *, input: str, max_pixels: int, repetition_penalty: float = 1.0):
                self.pixels = max_pixels
                self.penalty = repetition_penalty
                return [SimpleNamespace(), SimpleNamespace()]

            def restructure_pages(self, pages, **kwargs):
                self.pages = len(pages)
                return [SimpleNamespace(markdown={"markdown_texts": "## 测试", "markdown_images": {}})]

        pipeline = Pipeline()
        with tempfile.TemporaryDirectory() as directory:
            text, count = OCR.run_ocr(pipeline, Path(directory) / "test.pdf", Path(directory) / "test.md", 1881600)
        self.assertEqual((text, count), ("## 测试", 2))
        self.assertEqual(pipeline.pixels, 1881600)
        self.assertEqual(pipeline.penalty, OCR.REPETITION_PENALTY)
        self.assertEqual(pipeline.pages, 2)
        self.assertIn('"max_pixels": 1881600', OCR.provenance("sources/a", "ab" * 32, 1881600))

    def test_page_batch_size_is_applied_to_pipeline_components(self) -> None:
        class Sampler:
            def __init__(self):
                self.batch_size = 64

        class Component:
            def __init__(self):
                self.batch_sampler = Sampler()

        pipeline = SimpleNamespace(
            paddlex_pipeline=SimpleNamespace(
                batch_sampler=Sampler(),
                layout_det_model=Component(),
                vl_rec_model=Component(),
            )
        )
        OCR.configure_page_batch_size(pipeline, 1)
        self.assertEqual(pipeline.paddlex_pipeline.batch_sampler.batch_size, 1)
        self.assertEqual(pipeline.paddlex_pipeline.layout_det_model.batch_sampler.batch_size, 1)
        self.assertEqual(pipeline.paddlex_pipeline.vl_rec_model.batch_sampler.batch_size, 1)

    def test_paddleocr_html_table_is_preserved_without_flattening(self) -> None:
        source = ("<table border=1><tr><td>科 室</td><td>应诊时间</td></tr>"
                  "<tr><td>综合门诊</td><td>8:30—16:30</td></tr></table>")
        class Pipeline:
            def predict(self, *, input: str, max_pixels: int):
                return [SimpleNamespace()]

            def restructure_pages(self, pages, **kwargs):
                return [SimpleNamespace(markdown={
                    "markdown_texts": source,
                    "markdown_images": {},
                })]

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "test.md"
            markdown, _ = OCR.run_ocr(Pipeline(), Path(directory) / "test.pdf", output)
        self.assertIn("<table", markdown)
        self.assertIn("rowspan", markdown) if "rowspan" in source else None
        self.assertNotIn("| --- |", markdown)

    def test_quality_change_requeues_staged_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.md"
            source = "sources/website/college-arch/attachment.png"
            sha = "ab" * 32
            output.write_text(OCR.provenance(source, sha) + "正文\n", encoding="utf-8")
            self.assertTrue(OCR.staged_at_quality(output, source, sha, OCR.VLM_MAX_PIXELS))
            self.assertFalse(OCR.staged_at_quality(output, source, sha, OCR.MAX_ALLOWED_PIXELS))
            self.assertFalse(OCR.staged_at_quality(output, source, sha, OCR.VLM_MAX_PIXELS, "vllm-server"))
            self.assertTrue(OCR.staged_with_provenance(output, source, sha))
            self.assertFalse(OCR.staged_with_provenance(output, source + "-other", sha))
            self.assertFalse(OCR.staged_with_provenance(output, source, "cd" * 32))
            output.write_text("<!-- TJUCLAW_OCR_V1\n{}\n-->\n\n正文", encoding="utf-8")
            self.assertFalse(OCR.staged_with_provenance(output, source, sha))
            self.assertFalse(OCR.staged_at_quality(output, source, sha, OCR.VLM_MAX_PIXELS, "native", "cpu"))
            self.assertFalse(OCR.staged_at_quality(output, "sources/other.png", sha, OCR.VLM_MAX_PIXELS))
            self.assertFalse(OCR.staged_at_quality(output, source, sha, OCR.VLM_MAX_PIXELS, repetition_penalty=1.1))

    def test_repeated_generation_is_rejected(self) -> None:
        self.assertTrue(OCR.has_generation_loop("A document heading\n" + "P(A) = 0.7 " * 500))
        self.assertFalse(OCR.has_generation_loop("A document heading\n" + "Different explanatory text. " * 30))

    def test_document_timeout_interrupts_pathological_work(self) -> None:
        with self.assertRaises(TimeoutError):
            with OCR.document_timeout(1):
                time.sleep(2)

    def test_vllm_penalty_is_forwarded_to_predict(self) -> None:
        class Pipeline:
            def predict(self, **kwargs):
                self.options = kwargs
                return [SimpleNamespace()]

            def restructure_pages(self, pages, **kwargs):
                return [SimpleNamespace(markdown={"markdown_texts": "正文", "markdown_images": {}})]

        with tempfile.TemporaryDirectory() as directory:
            pipeline = Pipeline()
            OCR.run_ocr(pipeline, Path(directory) / "sample.pdf", Path(directory) / "sample.md", repetition_penalty=1.2)
            self.assertEqual(pipeline.options["repetition_penalty"], 1.2)

    def test_generation_loop_retries_without_page_concatenation(self) -> None:
        class Pipeline:
            def __init__(self):
                self.reconstruct_calls = []

            def predict(self, **kwargs):
                self.options = kwargs
                return [SimpleNamespace()]

            def restructure_pages(self, pages, **kwargs):
                self.reconstruct_calls.append(kwargs["concatenate_pages"])
                text = ("A heading\n" + "P(A) = 0.7 " * 500) if len(self.reconstruct_calls) == 1 else "## Recovered"
                return [SimpleNamespace(markdown={"markdown_texts": text, "markdown_images": {}})]

        with tempfile.TemporaryDirectory() as directory:
            pipeline = Pipeline()
            markdown, pages = OCR.run_ocr(
                pipeline, Path(directory) / "sample.pdf", Path(directory) / "sample.md",
                max_pixels=1881600, repetition_penalty=1.2,
            )
        self.assertEqual((markdown, pages), ("## Recovered", 1))
        self.assertEqual(pipeline.reconstruct_calls, [True, False])
        self.assertEqual(pipeline.options["max_pixels"], 1881600)

    def test_generation_loop_can_be_explicitly_salvaged(self) -> None:
        class Pipeline:
            def predict(self, **_kwargs):
                return [SimpleNamespace()]

            def restructure_pages(self, _pages, **_kwargs):
                text = "A heading\n" + "P(A) = 0.7 " * 500
                return [SimpleNamespace(markdown={"markdown_texts": text, "markdown_images": {}})]

        with tempfile.TemporaryDirectory() as directory:
            markdown, pages = OCR.run_ocr(
                Pipeline(),
                Path(directory) / "sample.pdf",
                Path(directory) / "sample.md",
                accept_generation_loop=True,
            )
        self.assertEqual(pages, 1)
        self.assertTrue(markdown.startswith("A heading"))

    def test_retry_log_collects_only_failed_source_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "run.jsonl"
            log.write_text(
                '{"event":"ocr_complete","source_path":"sources/ok.pdf"}\n'
                '{"event":"ocr_failed","source_path":"sources/bad.pdf","error":"timeout"}\n'
                'not-json\n'
                '{"event":"ocr_failed","source_path":"sources/bad.pdf","error":"retry"}\n',
                encoding="utf-8",
            )
            self.assertEqual(OCR.failed_source_paths(log), {"sources/bad.pdf"})

    def test_input_list_rejects_escape_duplicates_and_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = hashlib.sha256(b"pdf").hexdigest()
            relative = f"sources/course/public-course-sharing/title/{'ab' * 32}.attachments/{digest}.pdf"
            source = root / "raw" / relative
            source.parent.mkdir(parents=True)
            source.write_bytes(b"pdf")
            worklist = root / "inputs.txt"
            for invalid in ("../../etc/passwd", f"{relative}\n{relative}", "/absolute"):
                worklist.write_text(invalid + "\n")
                with self.assertRaises(ValueError):
                    OCR.selected_source_paths(worklist)
            worklist.write_text(relative + "\n")
            self.assertEqual(OCR.selected_source_paths(worklist), {relative})
            self.assertEqual(OCR.main([
                "--raw-repo", str(root / "raw"), "--staging", str(root / "stage"),
                "--input-list", str(worklist), "--dry-run",
            ]), 0)
            worklist.write_text(relative.replace(".pdf", ".png") + "\n")
            with self.assertRaisesRegex(RuntimeError, "missing_source"):
                OCR.main([
                    "--raw-repo", str(root / "raw"), "--staging", str(root / "stage"),
                    "--input-list", str(worklist), "--dry-run",
                ])

    def test_duplicate_archive_bytes_reuse_ocr_and_copy_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = hashlib.sha256(b"%PDF-1.4 sample").hexdigest()
            for title in ("first", "second"):
                source = root / "raw" / f"sources/course/public-course-sharing/{title}/{'ab' * 32}.attachments/{digest}.pdf"
                source.parent.mkdir(parents=True)
                source.write_bytes(b"%PDF-1.4 sample")

            def fake_ocr(pipeline, source, output, max_pixels, repetition_penalty, accept_generation_loop=False):
                asset = output.with_suffix(".assets") / "figure.png"
                asset.parent.mkdir()
                asset.write_bytes(b"image")
                return "## Verified OCR", 1

            with patch.object(OCR, "create_pipeline", return_value=object()), \
                 patch.object(OCR, "run_ocr", side_effect=fake_ocr) as infer:
                self.assertEqual(OCR.main([
                    "--raw-repo", str(root / "raw"), "--staging", str(root / "stage"),
                    "--include-suffix", ".pdf",
                ]), 0)
            self.assertEqual(infer.call_count, 1)
            for title in ("first", "second"):
                output = root / "stage" / f"sources/course/public-course-sharing/{title}/{'ab' * 32}.attachments/{digest}.md"
                self.assertIn("## Verified OCR", output.read_text())
                self.assertEqual((output.with_suffix(".assets") / "figure.png").read_bytes(), b"image")

    def test_failed_reprocessing_preserves_previous_output_and_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content = b"public image sample"
            digest = hashlib.sha256(content).hexdigest()
            item = "ab" * 32
            relative = Path(f"sources/wiki/public/guide/{item}.attachments/{digest}")
            source = root / "raw" / relative.with_suffix(".png")
            source.parent.mkdir(parents=True)
            source.write_bytes(content)
            output = root / "staging" / relative.with_suffix(".md")
            output.parent.mkdir(parents=True)
            output.write_text("previous verified markdown", encoding="utf-8")
            asset = output.with_suffix(".assets") / "image.png"
            asset.parent.mkdir()
            asset.write_bytes(b"previous asset")
            with patch.object(OCR, "materialize_lfs"), patch.object(OCR, "create_pipeline", return_value=object()), \
                 patch.object(OCR, "run_ocr", side_effect=RuntimeError("inference_failed")):
                self.assertEqual(OCR.main([
                    "--raw-repo", str(root / "raw"), "--staging", str(root / "staging"),
                ]), 1)
            self.assertEqual(output.read_text(encoding="utf-8"), "previous verified markdown")
            self.assertEqual(asset.read_bytes(), b"previous asset")

    def test_html_download_page_is_not_sent_to_ocr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "attachment.docx"
            path.write_text("<!DOCTYPE html><html><title>附件下载</title></html>", encoding="utf-8")
            self.assertTrue(OCR.looks_like_html(path))

    def test_materialize_lfs_skips_already_materialized_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sources/course/public-course-sharing/title/aa.attachments/bb.md"
            source.parent.mkdir(parents=True)
            source.write_text("already materialized", encoding="utf-8")
            OCR.materialize_lfs(root, [(source, "public-course-sharing", "bb", source.relative_to(root))])

    def test_extensionless_utf8_attachment_is_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "LICENSE"
            path.write_text("plain text license", encoding="utf-8")
            self.assertTrue(OCR.looks_like_utf8_text(path))

    def test_legacy_gb18030_text_is_decoded_without_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course.txt"
            path.write_bytes("近世代数：课程说明".encode("gb18030"))
            self.assertEqual(OCR.decode_text_document(path), ("近世代数：课程说明", "gb18030"))

    def test_appledouble_resource_fork_is_not_document_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course.txt"
            path.write_bytes(b"\x00\x05\x16\x07\x00\x02\x00\x00Mac OS X" + b"\0" * 120)
            self.assertTrue(OCR.is_appledouble(path))
            with self.assertRaisesRegex(RuntimeError, "appledouble_metadata_not_document"):
                OCR.decode_text_document(path)

    def test_binary_text_attachment_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "course.txt"
            path.write_bytes(b"hello\x00world")
            with self.assertRaisesRegex(RuntimeError, "binary_text_attachment"):
                OCR.decode_text_document(path)


if __name__ == "__main__":
    unittest.main()
