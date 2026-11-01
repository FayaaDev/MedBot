"""Offline regression checks: uv run python -m unittest test_asreview."""

import contextlib
import csv
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import asreview


class WorkflowTest(unittest.TestCase):
    def test_extraction_and_cli_modes(self):
        text = "References\n[1] Study. doi:10.1234/ABC.\n[2] Duplicate. doi:10.1234/ABC.\n[3] No DOI."
        self.assertEqual(asreview.normalize_doi(" https://doi.org/10.1234/ABC. "), "10.1234/abc")
        self.assertEqual(asreview.selected_dois_from_text(text, "1-3"), ["10.1234/abc"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "review.txt"
            source.write_text(text, encoding="utf-8")
            record = dict.fromkeys(asreview.FIELDS, "")
            record.update(doi="10.1234/abc", title="Study", abstract="An abstract")
            cases = [
                ["--text", str(source), "--refs", "1-4", "--extract-only"],
                ["--text", str(source), "--refs", "1-4"],
                ["--pdf", str(root / "review.pdf"), "--refs", "1-4"],
                ["--dois", str(root / "0" / "zotero-dois.txt")],
            ]
            for index, options in enumerate(cases):
                output = root / str(index)
                errors = io.StringIO()
                with patch("sys.argv", ["asreview.py", *options, "--out", str(output)]), \
                     patch.object(asreview, "_pdf_to_text", return_value=text), \
                     patch.object(asreview, "enrich_doi", return_value=record) as enrich, \
                     patch.object(asreview.time, "sleep"), \
                     contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
                    self.assertEqual(asreview.main(), 0)
                if index == 0:
                    enrich.assert_not_called()
                    self.assertFalse((output / "asreview-records.csv").exists())
                else:
                    enrich.assert_called_once_with("10.1234/abc", "")
                    with (output / "asreview-records.csv").open(newline="", encoding="utf-8") as handle:
                        self.assertEqual(list(csv.DictReader(handle)), [record])
                if index < 3:
                    self.assertIn("4", errors.getvalue())
                    self.assertIn("3", errors.getvalue())
                    self.assertEqual((output / "zotero-dois.txt").read_text(), "10.1234/abc\n")
                    with (output / "included-study-provenance.csv").open(newline="", encoding="utf-8") as handle:
                        self.assertEqual(len(list(csv.DictReader(handle))), 3)

    def test_metadata_fallback(self):
        doi = "10.1234/abc"
        with patch.object(asreview, "fetch_json", return_value={"abstract_inverted_index": {"An": [0], "abstract": [1]}}) as fetch, \
             patch.object(asreview, "fetch_pubmed_record") as pubmed:
            self.assertEqual(asreview.enrich_doi(doi, "")["abstract"], "An abstract")
            self.assertEqual(fetch.call_count, 1)
            pubmed.assert_not_called()
        with patch.object(asreview, "fetch_json", side_effect=[{}, {"message": {"abstract": "<p>Crossref abstract</p>"}}]), \
             patch.object(asreview, "fetch_pubmed_record") as pubmed:
            self.assertEqual(asreview.enrich_doi(doi, "")["abstract_source"], "crossref")
            pubmed.assert_not_called()
        with patch.object(asreview, "fetch_json", side_effect=OSError("offline")), \
             patch.object(asreview, "fetch_bytes", return_value=b""), \
             contextlib.redirect_stderr(io.StringIO()):
            record = asreview.enrich_doi(doi, "")
            self.assertEqual(record["doi"], doi)
            self.assertEqual(record["abstract"], "")
        xml = asreview.ET.fromstring("<PubmedArticle><Article><ArticleTitle>Study</ArticleTitle><Abstract><AbstractText Label='Results'>PubMed abstract</AbstractText></Abstract></Article></PubmedArticle>")
        with patch.object(asreview, "fetch_json", side_effect=[{}, {"message": {}}, {"esearchresult": {"idlist": ["123"]}}]), \
             patch.object(asreview, "fetch_bytes", return_value=asreview.ET.tostring(xml)):
            record = asreview.enrich_doi(doi, "")
            self.assertEqual(record["abstract"], "Results: PubMed abstract")
            self.assertEqual(record["abstract_source"], "pubmed")

    def test_invalid_arguments(self):
        cases = [[], ["--text", "review.txt"], ["--dois", "dois.txt", "--refs", "1"],
                 ["--dois", "dois.txt", "--extract-only"], ["--pdf", "a.pdf", "--text", "a.txt", "--refs", "1"]]
        for options in cases:
            with patch("sys.argv", ["asreview.py", *options]), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    asreview.main()
                self.assertEqual(error.exception.code, 2)
        with self.assertRaises(ValueError):
            asreview.parse_ref_selector("3-1")


if __name__ == "__main__":
    unittest.main()
