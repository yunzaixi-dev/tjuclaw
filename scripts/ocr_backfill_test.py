import importlib.util
import hashlib
import tempfile
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
        self.assertTrue(args.use_queues)
        self.assertEqual(args.vl_rec_backend, "native")
        self.assertEqual(args.pipeline_device, "gpu:0")
        server = OCR.parse_args([
            "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
            "--vl-rec-backend", "vllm-server",
        ])
        self.assertEqual(server.vl_rec_server_url, "http://127.0.0.1:8118/v1")
        with self.assertRaises(SystemExit):
            OCR.parse_args([
                "--raw-repo", "/tmp/raw", "--staging", "/tmp/out",
                "--vl-rec-backend", "vllm-server", "--vl-rec-server-url", "https://untrusted.example/v1",
            ])

    def test_ocr_reports_pages_and_uses_configured_pixel_budget(self) -> None:
        class Pipeline:
            def predict(self, *, input: str, max_pixels: int):
                self.pixels = max_pixels
                return [SimpleNamespace(), SimpleNamespace()]

            def restructure_pages(self, pages, **kwargs):
                self.pages = len(pages)
                return [SimpleNamespace(markdown={"markdown_texts": "## 测试", "markdown_images": {}})]

        pipeline = Pipeline()
        with tempfile.TemporaryDirectory() as directory:
            text, count = OCR.run_ocr(pipeline, Path(directory) / "test.pdf", Path(directory) / "test.md", 1881600)
        self.assertEqual((text, count), ("## 测试", 2))
        self.assertEqual(pipeline.pixels, 1881600)
        self.assertEqual(pipeline.pages, 2)
        self.assertIn('"max_pixels": 1881600', OCR.provenance("sources/a", "ab" * 32, 1881600))

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
            self.assertFalse(OCR.staged_at_quality(output, source, sha, OCR.VLM_MAX_PIXELS, "native", "cpu"))
            self.assertFalse(OCR.staged_at_quality(output, "sources/other.png", sha, OCR.VLM_MAX_PIXELS))

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


if __name__ == "__main__":
    unittest.main()
