import importlib.util
import hashlib
import json
import shutil
import subprocess
import sys
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
        self.assertEqual(
            OCR.parse_args([
                "--raw-repo", "/tmp/raw", "--staging", "/tmp/out", "--repetition-penalty", "1.2",
            ]).repetition_penalty, 1.2,
        )
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

    def test_chunk_watchdog_does_not_extend_document_deadline(self) -> None:
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            with OCR.document_timeout(1):
                with OCR.document_timeout(4):
                    time.sleep(2)
        self.assertLess(time.monotonic() - started, 1.6)

    def chunk_fixture(self, directory, invalid=None):
        counts = {}
        source = Path(directory) / "original.pdf"
        source.touch()
        counts[str(source)] = 5

        class Document:
            is_encrypted = False
            def __init__(self, path=None):
                self.page_count = counts.get(str(path), 0)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def insert_pdf(self, original, from_page, to_page):
                self.page_count = to_page - from_page + 1
            def save(self, path):
                counts[str(path)] = self.page_count
                path.write_bytes(b"test PDF chunk")

        class Pipeline:
            def __init__(self):
                self.calls = []
                self.reconstructed = None
            def predict(self, *, input, **options):
                self.calls.append((input, options))
                count = counts[input] - (1 if invalid == "missing" else 0)
                return [{"page_index": (1 if invalid == "order" else index),
                         "page_count": count, "input_path": input}
                        for index in range(count)]
            def restructure_pages(self, pages, **options):
                self.reconstructed = (pages, options)
                return [SimpleNamespace(markdown={
                    "markdown_texts": "Whole document", "markdown_images": {},
                })]
        return source, SimpleNamespace(open=Document), Pipeline()

    @unittest.skipUnless(all(shutil.which(name) for name in
                             ("pdfinfo", "pdfseparate", "pdfunite")), "Poppler is required")
    def test_pdf_chunk_fallback_without_pymupdf_preserves_page_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sample.pdf"
            objects = [
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
            ]
            data, offsets = b"%PDF-1.4\n", [0]
            for number, body in enumerate(objects, start=1):
                offsets.append(len(data))
                data += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
            xref = len(data)
            data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
            data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
            data += (f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
                     f"startxref\n{xref}\n%%EOF\n").encode()
            source.write_bytes(data)

            class Pipeline:
                def predict(self, *, input, **_options):
                    info = subprocess.run(["pdfinfo", input], capture_output=True, text=True, check=True)
                    count = int(next(line.split(":", 1)[1] for line in info.stdout.splitlines()
                                     if line.startswith("Pages:")))
                    return [{"page_index": index} for index in range(count)]

            for chunk_pages in (1, 2):
                with self.subTest(chunk_pages=chunk_pages), patch.dict(sys.modules, {"fitz": None}):
                    pages = OCR.predict_document(Pipeline(), source, {}, chunk_pages=chunk_pages)
                self.assertEqual([page["page_index"] for page in pages], [0, 1])
                self.assertTrue(all(page["page_count"] == 2 for page in pages))
                self.assertTrue(all(page["input_path"] == str(source) for page in pages))

    def test_pdf_chunks_preserve_global_order_and_restructure_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source, fitz, pipeline = self.chunk_fixture(directory)
            with patch.dict(sys.modules, {"fitz": fitz}):
                text, count = OCR.run_ocr(
                    pipeline, source, Path(directory) / "out.md",
                    repetition_penalty=1.2, pdf_chunk_pages=2, chunk_timeout_seconds=10,
                )
            self.assertEqual((text, count), ("Whole document", 5))
            self.assertEqual(len(pipeline.calls), 3)
            pages, options = pipeline.reconstructed
            self.assertEqual([page["page_index"] for page in pages], list(range(5)))
            self.assertTrue(all(page["page_count"] == 5 for page in pages))
            self.assertTrue(all(page["input_path"] == str(source) for page in pages))
            self.assertEqual(options, {"merge_tables": True, "relevel_titles": True,
                                       "concatenate_pages": True})
            self.assertTrue(all(call[1]["repetition_penalty"] == 1.2
                                for call in pipeline.calls))
            self.assertFalse(Path(pipeline.calls[0][0]).exists())

    def test_pdf_chunk_incomplete_or_unordered_results_never_reconstruct(self) -> None:
        for invalid, reason in (("missing", "incomplete_chunk_coverage"),
                                ("order", "unordered_chunk_pages")):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                source, fitz, pipeline = self.chunk_fixture(directory, invalid)
                with patch.dict(sys.modules, {"fitz": fitz}):
                    with self.assertRaisesRegex(RuntimeError, reason):
                        OCR.run_ocr(pipeline, source, Path(directory) / "out.md",
                                    pdf_chunk_pages=2)
                self.assertIsNone(pipeline.reconstructed)
                self.assertFalse(Path(pipeline.calls[0][0]).exists())

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

    def test_generation_loop_retries_below_default_pixel_budget(self) -> None:
        class Pipeline:
            def __init__(self):
                self.pixel_budgets = []

            def predict(self, **kwargs):
                self.pixel_budgets.append(kwargs["max_pixels"])
                return [SimpleNamespace()]

            def restructure_pages(self, pages, **kwargs):
                text = ("A heading\n" + "P(A) = 0.7 " * 500
                        if self.pixel_budgets[-1] >= OCR.VLM_MAX_PIXELS
                        else "## Recovered after smaller image")
                return [SimpleNamespace(markdown={
                    "markdown_texts": text, "markdown_images": {},
                })]

        with tempfile.TemporaryDirectory() as directory:
            pipeline = Pipeline()
            text, pages = OCR.run_ocr(
                pipeline, Path(directory) / "sample.pdf", Path(directory) / "sample.md",
            )
        self.assertEqual((text, pages), ("## Recovered after smaller image", 1))
        self.assertEqual(pipeline.pixel_budgets,
                         [OCR.VLM_MAX_PIXELS, OCR.VLM_MAX_PIXELS // 2])

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

            def fake_ocr(pipeline, source, output, max_pixels, repetition_penalty,
                         accept_generation_loop=False, pdf_chunk_pages=0,
                         chunk_timeout_seconds=0):
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

    def test_office_conversion_failure_does_not_load_gpu_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "raw" / "sources/course/public-course-sharing/test"
            source = source / (("a" * 64) + ".attachments") / (("b" * 64) + ".docx")
            source.parent.mkdir(parents=True)
            source.write_bytes(b"PK synthetic office")
            with patch.object(OCR, "convert_office_to_pdf",
                              side_effect=RuntimeError("office_conversion_failed")), \
                 patch.object(OCR, "create_pipeline") as create:
                self.assertEqual(OCR.main([
                    "--raw-repo", str(root / "raw"), "--staging", str(root / "stage"),
                    "--include-suffix", ".docx",
                ]), 1)
                create.assert_not_called()

    def test_prepared_office_cache_is_verified_and_reused_for_ocr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = ("sources/course/public-course-sharing/test/"
                        + "a" * 64 + ".attachments/" + "b" * 64 + ".docx")
            source = root / "raw" / relative
            source.parent.mkdir(parents=True)
            source.write_bytes(b"PK synthetic office")
            cache = root / "prepared"
            cache.mkdir()
            identifier = hashlib.sha256(relative.encode()).hexdigest()
            pdf = cache / f"{identifier}.pdf"
            pdf.write_bytes(b"%PDF-1.4 synthetic")
            record = {
                "source": relative, "original_sha256": OCR.file_sha256(source),
                "pdf_sha256": OCR.file_sha256(pdf), "pdf_bytes": pdf.stat().st_size,
                "pages": 2, "converter": "isolated-libreoffice",
            }
            (cache / f"{identifier}.json").write_text(json.dumps(record))

            def infer(_pipeline, ocr_input, _output, *_args):
                self.assertEqual(ocr_input, pdf)
                return "## Synthetic verified text", 2

            with patch.object(OCR, "convert_office_to_pdf") as convert, \
                 patch.object(OCR, "create_pipeline", return_value=object()), \
                 patch.object(OCR, "run_ocr", side_effect=infer):
                self.assertEqual(OCR.main([
                    "--raw-repo", str(root / "raw"), "--staging", str(root / "stage"),
                    "--prepared-office-dir", str(cache), "--include-suffix", ".docx",
                ]), 0)
                convert.assert_not_called()
            output = root / "stage" / relative.replace(".docx", ".md")
            text = output.read_text(encoding="utf-8")
            self.assertIn('"pdf_sha256": "' + record["pdf_sha256"] + '"', text)
            self.assertIn("## Synthetic verified text", text)

            pdf.write_bytes(b"%PDF-1.4 changed")
            self.assertIsNone(OCR.checked_prepared_office(cache, relative, source))
            with patch.object(OCR, "create_pipeline") as create, \
                 patch.object(OCR, "convert_office_to_pdf") as convert:
                self.assertEqual(OCR.main([
                    "--raw-repo", str(root / "raw"), "--staging", str(root / "new-stage"),
                    "--prepared-office-dir", str(cache), "--include-suffix", ".docx",
                ]), 1)
                create.assert_not_called()
                convert.assert_not_called()

    def test_materialize_lfs_skips_already_materialized_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sources/course/public-course-sharing/title/aa.attachments/bb.md"
            source.parent.mkdir(parents=True)
            source.write_text("already materialized", encoding="utf-8")
            OCR.materialize_lfs(root, [(source, "public-course-sharing", "bb", source.relative_to(root))])

    def test_materialize_lfs_rejects_pointers_left_after_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".git").mkdir()
            source = root / "sources/course/public-course-sharing/title/aa.attachments/bb.md"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"version https://git-lfs.github.com/spec/v1\n"
                              b"oid sha256:" + b"b" * 64 + b"\nsize 4\n")
            with patch("subprocess.run") as run:
                run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
                with self.assertRaisesRegex(RuntimeError, "lfs_materialization_failed"):
                    OCR.materialize_lfs(
                        root,
                        [(source, "public-course-sharing", "bb", source.relative_to(root))],
                    )
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0][:3], ["git", "lfs", "checkout"])

    def test_appledouble_header_revealed_after_lfs_is_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw, stage = root / "raw", root / "stage"
            source = (
                raw / "sources/course/public-course-sharing/example"
                / f"{'a' * 64}.attachments" / f"{'b' * 64}.txt"
            )
            source.parent.mkdir(parents=True)
            source.write_bytes(
                b"version https://git-lfs.github.com/spec/v1\n"
                + b"oid sha256:" + b"b" * 64 + b"\nsize 21\n"
            )

            def materialize(_raw, _pending):
                source.write_bytes(b"\x00\x05\x16\x07\x00\x02\x00\x00resource fork")

            with patch.object(OCR, "materialize_lfs", side_effect=materialize), \
                 patch("builtins.print") as printed:
                self.assertEqual(OCR.main([
                    "--raw-repo", str(raw), "--staging", str(stage),
                    "--include-suffix", ".txt",
                ]), 0)
            summary = json.loads(printed.call_args.args[0])
            self.assertEqual(summary["metadata_excluded"], 1)
            self.assertEqual(summary["failed"], 0)
            self.assertFalse((stage / source.relative_to(raw)).with_suffix(".md").exists())

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
