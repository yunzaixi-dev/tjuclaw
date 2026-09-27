import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("ocr_weknora_import", HERE / "ocr-weknora-import.py")
assert SPEC and SPEC.loader
IMPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORT)

OCR_SPEC = importlib.util.spec_from_file_location("ocr_backfill", HERE / "ocr-backfill.py")
assert OCR_SPEC and OCR_SPEC.loader
OCR = importlib.util.module_from_spec(OCR_SPEC)
OCR_SPEC.loader.exec_module(OCR)


class Client:
    def __init__(self):
        self.uploads = []
        self.statuses = []

    def upload(self, body, metadata, name):
        self.uploads.append((body, metadata, name))
        return "knowledge-12345678"

    def status(self, knowledge_id):
        self.statuses.append(knowledge_id)
        return "completed"


class OcrWeKnoraImportTest(unittest.TestCase):
    def test_real_llm_repair_module_loads(self):
        self.assertTrue(callable(IMPORT.llm_script().repair_reasons))

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.raw = self.root / "raw"
        self.stage = self.root / "stage"
        self.source = (
            "sources/course/public-course-sharing/sample/"
            + "a" * 64 + ".attachments/" + "b" * 64 + ".docx"
        )
        self.relative = self.source.removesuffix(".docx") + ".md"
        original = self.raw / self.source
        original.parent.mkdir(parents=True)
        original.write_bytes(b"PK synthetic")
        staged = self.stage / self.relative
        staged.parent.mkdir(parents=True)
        staged.write_text(OCR.provenance(self.source, "b" * 64) + "# Synthetic course text\n\n"
                          + "Campus hours and academic calendar.\n", encoding="utf-8")
        self.source_map = self.root / "source-map.json"
        self.source_map.write_text(json.dumps({
            self.relative: "https://example.test/course/sample"
        }), encoding="utf-8")
        self.manifest = self.root / "manifest.json"
        self.args = SimpleNamespace(
            staging=self.stage, raw_repo=self.raw, repaired=None,
            source_map=self.source_map, manifest=self.manifest,
            knowledge_base_id="kb-12345678", limit=0, dry_run=False,
        )
        self.llm = SimpleNamespace(
            repair_reasons=lambda body, metadata, size: (),
            scan_privacy=lambda body: (),
        )

    def test_upload_binds_real_source_and_verifies_index_on_resume(self):
        client = Client()
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, client), {"uploaded": 1})
            self.assertEqual(IMPORT.import_documents(self.args, client), {"indexed": 1})
        self.assertEqual(len(client.uploads), 1)
        text, metadata, name = client.uploads[0]
        self.assertIn("Synthetic course text", text)
        self.assertEqual(metadata["source"], "public-course-sharing")
        self.assertEqual(metadata["source_url"], "https://example.test/course/sample")
        self.assertEqual(metadata["item_id"], "a" * 64)
        self.assertEqual(metadata["canonical_hash"], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(name, "a" * 64 + "-" + "b" * 12 + ".md")
        self.assertEqual(client.statuses, ["knowledge-12345678"])
        self.assertEqual(self.manifest.stat().st_mode & 0o777, 0o600)

    def test_changed_document_is_not_silently_overwritten(self):
        client = Client()
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, client), {"uploaded": 1})
            staged = self.stage / self.relative
            staged.write_text(staged.read_text() + "\nMore synthetic information.\n")
            self.assertEqual(IMPORT.import_documents(self.args, client),
                             {"deferred_changed_after_upload": 1})
        self.assertEqual(len(client.uploads), 1)

    def test_fails_closed_for_missing_repair_and_public_url(self):
        self.llm.repair_reasons = lambda body, metadata, size: ("unbalanced_math_delimiter",)
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()),
                             {"deferred_repair_required": 1})
        self.source_map.write_text(json.dumps({
            self.relative: "https://example.test/course?token=private"
        }))
        self.llm.repair_reasons = lambda body, metadata, size: ()
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()),
                             {"deferred_invalid_source_url": 1})

    def test_repair_worker_body_hash_matches_importer_lineage(self):
        llm = IMPORT.llm_script()
        staged = self.stage / self.relative
        staged.write_text(staged.read_text() + "Unclosed math $.\n", encoding="utf-8")
        metadata, original = llm.split_document(staged.read_text(encoding="utf-8"))
        repaired = original.replace("Unclosed math $.", "Unclosed math.")
        self.args.repaired = self.root / "repaired"
        destination = self.args.repaired / self.relative
        destination.parent.mkdir(parents=True)
        destination.write_text(llm.render(metadata, original, repaired, "tju-llm-max"),
                               encoding="utf-8")
        with patch.object(llm, "scan_privacy", return_value=()):
            result = IMPORT.import_documents(self.args, Client())
        self.assertEqual(result, {"uploaded": 1})

    def test_rejects_invalid_ocr_provenance_and_private_url_path(self):
        staged = self.stage / self.relative
        content = staged.read_text()
        staged.write_text(content.replace('"paddleocr_version": "3.7.0"',
                                          '"paddleocr_version": "0.0.0"'))
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()),
                             {"deferred_invalid_ocr_provenance": 1})
        staged.write_text(content)
        self.source_map.write_text(json.dumps({
            self.relative: "https://example.test/course/%E7%A7%81%E4%BA%BA"
        }))
        self.llm.scan_privacy = lambda text: ("credential",) if "私人" in text else ()
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()),
                             {"deferred_privacy_blocked": 1})

    def test_dry_run_never_uses_network_or_writes_checkpoint(self):
        self.args.dry_run = True
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args), {"ready": 1})
        self.assertFalse(self.manifest.exists())

    def test_privacy_block_and_path_escape(self):
        self.llm.scan_privacy = lambda body: ("credential",)
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()),
                             {"deferred_privacy_blocked": 1})
        self.source_map.write_text(json.dumps({"../../outside.md": "https://example.test/course"}))
        self.assertEqual(IMPORT.import_documents(self.args, Client()),
                         {"deferred_invalid_ocr_path": 1})

    def test_multipart_upload_contains_provenance_metadata(self):
        content, mime = IMPORT.multipart_markdown(
            "# Safe text", {"canonical_hash": "a" * 64, "source_url": "https://example.test/course"},
            "safe.md",
        )
        self.assertTrue(mime.startswith("multipart/form-data; boundary="))
        self.assertIn(b'\"source_url\": \"https://example.test/course\"', content)
        self.assertIn(b'filename=\"safe.md\"', content)
        self.assertIn(b"# Safe text", content)

    def test_text_layer_pdf_requires_real_original_hash_and_has_truthful_channel(self):
        source = self.source.removesuffix(".docx") + ".pdf"
        original = self.raw / source
        original.write_bytes(b"%PDF-synthetic-text-layer")
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        metadata = {
            "source_path": source, "source_sha256": "b" * 64,
            "original_sha256": digest, "pdf_sha256": digest,
            "pages": 2, "processor": "Poppler-pdftotext",
            "pipeline_version": "text-v1",
        }
        stage = self.stage / self.relative
        def write_stage():
            stage.write_text(
                "<!-- TJUCLAW_TEXT_LAYER_V1\n"
                + json.dumps(metadata) + "\n-->\n\n"
                + "Synthetic public campus schedule with enough information.\n",
                encoding="utf-8",
            )
        write_stage()
        client = Client()
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, client), {"uploaded": 1})
        self.assertEqual(client.uploads[0][1]["processor"], "Poppler-pdftotext")
        content, _ = IMPORT.multipart_markdown(
            client.uploads[0][0], client.uploads[0][1], client.uploads[0][2],
        )
        self.assertIn(b"tjuclaw_textlayer", content)
        metadata["original_sha256"] = "0" * 64
        write_stage()
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, client),
                             {"deferred_invalid_ocr_provenance": 1})

    def test_text_layer_office_requires_verified_conversion_cache(self):
        source = self.source
        original = self.raw / source
        cache = self.root / "prepared"
        cache.mkdir()
        key = hashlib.sha256(source.encode()).hexdigest()
        pdf = cache / (key + ".pdf")
        pdf.write_bytes(b"%PDF-synthetic-conversion")
        pdf_hash = hashlib.sha256(pdf.read_bytes()).hexdigest()
        record = {
            "source": source,
            "original_sha256": hashlib.sha256(original.read_bytes()).hexdigest(),
            "pdf_sha256": pdf_hash,
            "pdf_bytes": pdf.stat().st_size,
            "pages": 2,
            "converter": "isolated-libreoffice",
        }
        (cache / (key + ".json")).write_text(json.dumps(record))
        metadata = {
            "source_path": source, "source_sha256": "b" * 64,
            "original_sha256": record["original_sha256"],
            "pdf_sha256": pdf_hash, "pages": 2,
            "processor": "Poppler-pdftotext", "pipeline_version": "text-v1",
            "conversion": {
                "converter": "isolated-libreoffice",
                "pdf_sha256": pdf_hash, "pages": 2,
            },
        }
        (self.stage / self.relative).write_text(
            "<!-- TJUCLAW_TEXT_LAYER_V1\n"
            + json.dumps(metadata) + "\n-->\n\n"
            + "Synthetic course schedule, dates and opening hours.\n",
            encoding="utf-8",
        )
        self.args.prepared_office_dir = cache
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()), {"uploaded": 1})
        pdf.write_bytes(b"tampered conversion")
        with patch.object(IMPORT, "llm_script", return_value=self.llm):
            self.assertEqual(IMPORT.import_documents(self.args, Client()),
                             {"deferred_invalid_ocr_provenance": 1})

    def test_rejects_internal_citations_and_untrusted_weknora(self):
        for value in ("https://127.0.0.2/doc", "https://example.test/doc?key=secret",
                      "http://example.test/doc", "https://localhost/doc"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid_source_url"):
                IMPORT.public_url(value)
        with self.assertRaisesRegex(ValueError, "invalid_weknora_config"):
            IMPORT.WeKnora("http://example.test", "key", "kb-12345678")

    def test_status_rejects_a_different_knowledge_base(self):
        client = IMPORT.WeKnora("http://127.0.0.1:18181", "synthetic-key", "kb-12345678")
        with patch.object(client, "request", return_value={
            "data": {"parse_status": "completed", "knowledge_base_id": "other-kb"}
        }):
            with self.assertRaisesRegex(RuntimeError, "weknora_invalid_response"):
                client.status("knowledge-12345678")

    def test_command_returns_failure_for_named_deferred_count(self):
        with patch.object(IMPORT.sys, "argv", [
            "ocr-weknora-import.py", "--staging", str(self.stage),
            "--raw-repo", str(self.raw), "--source-map", str(self.source_map),
            "--manifest", str(self.manifest),
        ]), patch.object(IMPORT, "import_documents",
                         return_value={"deferred_repair_required": 1}):
            self.assertEqual(IMPORT.main(), 1)


if __name__ == "__main__":
    unittest.main()
