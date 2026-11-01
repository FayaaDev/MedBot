# Review references to ASReview

`asreview.py` extracts explicitly selected bibliography entries from a systematic-review or meta-analysis PDF, collects their DOIs, and retrieves metadata for an ASReview-ready CSV. It can also process extracted text or an existing DOI list.

You supply the included-study reference numbers. The script does not identify included studies automatically.

## Docker HTTP service

Build from this directory and bind locally (set a strong token in your shell first):

```bash
docker build -t asreview-local .
export ASREVIEW_TOKEN='replace-with-a-long-random-token'
docker run --rm -p 127.0.0.1:8080:8080 -e ASREVIEW_TOKEN asreview-local
```

The token is required at startup. Keep it out of source control and logs. The service is HTTP; use a trusted TLS-protected connection when calling it remotely. A Cloudflare Worker cannot reach the host's loopback address directly; the service needs a reachable, protected HTTPS endpoint.

**Interface:** `POST /process`, header `Authorization: Bearer <ASREVIEW_TOKEN>`, `Content-Type: multipart/form-data` with `Content-Length`. Supply text fields `refs` (e.g. `15-25,31`), `telegram_token`, and `chat_id`, and exactly one of file field `pdf` or UTF-8 text field `url`. The service reads and validates the entire request before returning `202 {"accepted":true}`. A background thread processes the article and sends the CSV or a processing error directly to the specified Telegram chat through `api.telegram.org`. The token travels in the request body: the connection to the service must use trusted HTTPS, and proxies must not log request bodies. `url` accepts a public HTTP(S) PDF/article URL or a bare DOI. Article pages are checked for citation PDF metadata and PDF links; paywalls, JavaScript-only pages, and nonstandard links may not resolve. Redirects and PDF links are checked for public IP addresses and connections are pinned to the validated IP. The entire request and each download are limited to 20 MiB; at most 500 references can be selected.

```bash
curl -sS -H "Authorization: Bearer $ASREVIEW_TOKEN" \
  -F 'refs=15-25,31' -F "telegram_token=$TELEGRAM_BOT_TOKEN" -F "chat_id=$TELEGRAM_CHAT_ID" \
  -F 'pdf=@review.pdf;type=application/pdf' http://127.0.0.1:8080/process
# Alternatively: -F 'url=https://doi.org/10.1234/example' instead of the pdf field.
```

Acceptance is `202` with JSON `{"accepted":true}`, not a guarantee of completion. Submission errors are JSON `{"error":"..."}` with HTTP `400`, `401`, `404`, `411`, `413`, or `500`; processing errors are sent to Telegram. The delivered CSV has columns `title,abstract,authors,doi,url,abstract_source`. Jobs live only in memory: restarting or stopping the container loses unfinished jobs. Telegram delivery can also fail, in which case the service logs a generic failure and the user must retry. A lost acceptance response can cause duplicate submissions if the caller retries. Only detected DOIs are returned; missing references and references without DOIs are omitted. Metadata enrichment can return blank fields when public APIs fail. Numbered references and OCR limitations below also apply.

Run offline tests with `uv run --no-project python -m unittest test_asreview test_server -v`.

## Requirements

- Python 3.13+ and [uv](https://docs.astral.sh/uv/).
- `pdftotext` for PDF input. On macOS, install it with `brew install poppler`.
- Internet access for metadata enrichment. Extraction-only mode works offline.

No third-party Python packages are required. Run the commands below from this folder; `--no-project` avoids using the parent directory's uv project.

## Usage

### PDF to ASReview CSV

```bash
uv run --no-project python asreview.py \
  --pdf review.pdf \
  --refs "15-25,31" \
  --mailto you@example.com
```

The `--mailto` option is optional and supplies a contact address in API request headers.

### Use already extracted text

```bash
uv run --no-project python asreview.py --text review.txt --refs "15-25,31"
```

PDF and text input must contain bracket-numbered bibliography entries such as `[15]`. The script looks after the last standalone `References` heading when present.

### Extract references and DOIs without API calls

```bash
uv run --no-project python asreview.py \
  --pdf review.pdf --refs "15-25,31" --extract-only
```

`--extract-only` also works with `--text`.

### Enrich an existing DOI list

Create a text file with one DOI per line. DOI URLs are accepted too:

```text
10.1234/example
https://doi.org/10.5678/example
```

```bash
uv run --no-project python asreview.py --dois dois.txt --out enriched-output
```

DOIs are normalized and deduplicated. Use exactly one of `--pdf`, `--text`, or `--dois`. PDF/text input requires `--refs`; DOI-list input does not accept `--refs` or `--extract-only`.

Reference selectors accept individual numbers and inclusive ranges, separated by commas, semicolons, or whitespace—for example, `"15-25,31;40"`.

## Outputs

`--out` always specifies an output directory and defaults to `asreview-output/`.

| File | Contents | When written |
| --- | --- | --- |
| `asreview-records.csv` | Title, abstract, authors, DOI, URL, and abstract source | Enrichment enabled |
| `zotero-dois.txt` | Unique DOIs, one per line | PDF/text input |
| `included-study-provenance.csv` | Source filename, reference number, DOI, and original citation | PDF/text input |

The ASReview CSV columns are:

```text
title,abstract,authors,doi,url,abstract_source
```

The provenance column is named `source_pdf` even when the source is a text file. Existing files with the same output names are overwritten. Extraction-only mode does not remove an ASReview CSV from a previous run; use a separate output directory to keep runs separate.

## Metadata lookup and limitations

- The script queries OpenAlex first, then Crossref and PubMed if an abstract is still missing.
- Missing references, missing DOIs, and lookup failures are reported to standard error.
- Selected references without a detected DOI remain in the provenance CSV but are omitted from enrichment.
- Unresolved DOIs remain in the ASReview CSV with any metadata that was found; missing fields are blank. Check the reported missing-abstract count.
- Extraction depends on the PDF's text and bibliography formatting. Scanned PDFs need OCR before processing; this script does not perform OCR.

## Offline regression checks

```bash
uv run --no-project python -m unittest test_asreview -v
```

The checks cover input modes, reference extraction, DOI normalization and deduplication, CSV output, metadata fallbacks, and invalid CLI arguments. API calls and PDF conversion are mocked.

## Folder contents

- `asreview.py` — standalone command-line script.
- `test_asreview.py` — offline regression checks.
- `asreview-output/` — existing generated outputs.
