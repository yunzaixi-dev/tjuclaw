import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("ocr_evaluate", Path(__file__).with_name("ocr-evaluate.py"))
assert SPEC and SPEC.loader
OCR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OCR)


class OcrEvaluateTest(unittest.TestCase):
    def test_rows_must_be_in_same_line_and_preserve_dates(self) -> None:
        reference = {"keywords": ["综合门诊", "无假日门诊", "口腔门诊"],
                     "rows": [["综合门诊", "无假日门诊", "8:30—16:30"],
                              ["口腔门诊", "每周二、周四", "8:30—12:00"]]}
        good = "| 综合门诊 | 无假日门诊 | 8:30—16:30 |\n| 口腔门诊 | 每周二、周四 | 8:30—12:00 |"
        self.assertEqual(OCR.score(good, reference)["row_recall"], 1.0)
        shuffled = "| 综合门诊 | 每周二、周四 | 8:30—12:00 |\n| 口腔门诊 | 无假日门诊 | 8:30—16:30 |"
        self.assertEqual(OCR.score(shuffled, reference)["keyword_recall"], 1.0)
        self.assertEqual(OCR.score(shuffled, reference)["row_recall"], 0.0)
        html_shuffled = ("<table><tr><td>综合门诊</td><td>每周二、周四</td><td>8:30—12:00</td></tr>"
                         "<tr><td>口腔门诊</td><td>无假日门诊</td><td>8:30—16:30</td></tr></table>")
        self.assertEqual(OCR.score(html_shuffled, reference)["row_recall"], 0.0)


if __name__ == "__main__":
    unittest.main()
