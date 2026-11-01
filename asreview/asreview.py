#!/usr/bin/env python3
"""Extract selected review references and enrich DOIs into ASReview-ready CSV."""

import argparse
import csv
import html
import json
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

FIELDS = ["title", "abstract", "authors", "doi", "url", "abstract_source"]
REF_START = re.compile(r"(?m)^\s*\[(\d+)\]\s+")
DOI = re.compile(r"(?i)\b(10\.\d{4,9}/[-._;()/:a-z0-9]+)")


def normalize_doi(value: str) -> str:
    value = value.strip()
    value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value, flags=re.IGNORECASE)
    return value.rstrip(".,;:)]}").lower()


def parse_ref_selector(selector: str) -> set[int]:
    """Parse selectors such as '15-25, 31; 40'."""
    selected: set[int] = set()
    for token in re.split(r"[,;\s]+", selector.strip()):
        if not token:
            continue
        match = re.fullmatch(r"(\d+)\s*(?:-|–|—)\s*(\d+)", token)
        if match:
            start, end = map(int, match.groups())
            if end < start:
                raise ValueError(f"Invalid descending range: {token}")
            selected.update(range(start, end + 1))
        elif token.isdigit():
            selected.add(int(token))
        else:
            raise ValueError(f"Invalid reference selector: {token}")
    if not selected:
        raise ValueError("At least one reference number is required")
    return selected


def extract_records(text: str, selected_refs: set[int]) -> list[dict[str, object]]:
    """Return citation provenance and DOI for the selected numbered references only."""
    headings = list(re.finditer(r"(?mi)^\s*references\s*$", text))
    if headings:
        text = text[headings[-1].end() :]
    starts = list(REF_START.finditer(text))
    records: list[dict[str, object]] = []
    for index, match in enumerate(starts):
        ref_number = int(match.group(1))
        if ref_number not in selected_refs:
            continue
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        citation = " ".join(text[match.start() : end].split())
        doi_text = re.sub(
            r"(10\.\d{4,9}/[-._;()/:a-z0-9]*)\s+([-._;()/:a-z0-9])",
            r"\1\2",
            citation,
            flags=re.IGNORECASE,
        )
        doi_match = DOI.search(doi_text)
        records.append(
            {
                "reference_number": ref_number,
                "doi": normalize_doi(doi_match.group(1)) if doi_match else "",
                "citation": citation,
            }
        )
    return sorted(records, key=lambda record: int(record["reference_number"]))


def write_outputs(records: list[dict[str, object]], output_dir: Path, source_pdf: str) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = output_dir / "included-study-provenance.csv"
    doi_path = output_dir / "zotero-dois.txt"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["source_pdf", "reference_number", "doi", "citation"])
        writer.writeheader()
        for record in records:
            writer.writerow({"source_pdf": source_pdf, **record})
    dois = list(dict.fromkeys(record["doi"] for record in records if record["doi"]))
    doi_path.write_text("\n".join(dois) + ("\n" if dois else ""), encoding="utf-8")
    return {"csv": csv_path, "doi_list": doi_path}


def _pdf_to_text(pdf: Path) -> str:
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as handle:
        text_path = Path(handle.name)
    try:
        subprocess.run(["pdftotext", str(pdf), str(text_path)], check=True)
        return text_path.read_text(encoding="utf-8", errors="replace")
    finally:
        text_path.unlink(missing_ok=True)


def selected_dois_from_text(text: str, refs: str) -> list[str]:
    records = extract_records(text, parse_ref_selector(refs))
    return list(dict.fromkeys(record["doi"] for record in records if record["doi"]))


def reconstruct_abstract(inverted: dict | None) -> str:
    if not inverted:
        return ""
    positions = {position: word for word, indexes in inverted.items() for position in indexes}
    return " ".join(positions[position] for position in sorted(positions))


def openalex_to_record(doi: str, work: dict) -> dict[str, str]:
    authors = "; ".join(
        authorship.get("author", {}).get("display_name", "")
        for authorship in work.get("authorships", [])
        if authorship.get("author", {}).get("display_name")
    )
    primary_location = work.get("primary_location") or {}
    return {
        "title": work.get("display_name") or "",
        "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
        "authors": authors,
        "doi": normalize_doi(work.get("doi") or doi),
        "url": primary_location.get("landing_page_url") or f"https://doi.org/{doi}",
        "abstract_source": "openalex" if work.get("abstract_inverted_index") else "",
    }


def crossref_to_record(doi: str, message: dict) -> dict[str, str]:
    authors = "; ".join(
        " ".join(part for part in (author.get("given"), author.get("family")) if part)
        for author in message.get("author", [])
    )
    abstract = re.sub(r"<[^>]+>", " ", html.unescape(message.get("abstract") or ""))
    return {
        "title": (message.get("title") or [""])[0],
        "abstract": " ".join(abstract.split()),
        "authors": authors,
        "doi": normalize_doi(message.get("DOI") or doi),
        "url": message.get("URL") or f"https://doi.org/{doi}",
        "abstract_source": "crossref" if abstract else "",
    }


def pubmed_xml_to_record(doi: str, xml: ET.Element) -> dict[str, str]:
    article = xml.find(".//Article")
    if article is None:
        return {field: "" for field in FIELDS}
    title = "".join(article.find("ArticleTitle").itertext()) if article.find("ArticleTitle") is not None else ""
    abstract_parts = []
    for element in article.findall("./Abstract/AbstractText"):
        label = element.get("Label")
        content = " ".join("".join(element.itertext()).split())
        if content:
            abstract_parts.append(f"{label}: {content}" if label else content)
    authors = []
    for author in article.findall("./AuthorList/Author"):
        name = " ".join(filter(None, [author.findtext("ForeName"), author.findtext("LastName")]))
        if name:
            authors.append(name)
    return {
        "title": title,
        "abstract": " ".join(abstract_parts),
        "authors": "; ".join(authors),
        "doi": doi,
        "url": f"https://doi.org/{doi}",
        "abstract_source": "pubmed" if abstract_parts else "",
    }


def fetch_bytes(url: str, mailto: str) -> bytes:
    agent = f"asreview-doi-enricher/1.0 (mailto:{mailto})" if mailto else "asreview-doi-enricher/1.0"
    request = Request(url, headers={"User-Agent": agent})
    with urlopen(request, timeout=30) as response:
        return response.read()


def fetch_pubmed_record(doi: str, mailto: str) -> dict[str, str]:
    query = quote(f"{doi}[AID]")
    search = fetch_json(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term={query}", mailto)
    ids = search.get("esearchresult", {}).get("idlist", [])
    if not ids:
        return {field: "" for field in FIELDS}
    xml = ET.fromstring(fetch_bytes(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id={quote(ids[0])}&retmode=xml", mailto))
    return pubmed_xml_to_record(doi, xml)


def fetch_json(url: str, mailto: str) -> dict:
    agent = f"asreview-doi-enricher/1.0 (mailto:{mailto})" if mailto else "asreview-doi-enricher/1.0"
    request = Request(url, headers={"User-Agent": agent, "Accept": "application/json"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def enrich_doi(doi: str, mailto: str) -> dict[str, str]:
    doi = normalize_doi(doi)
    base = {field: "" for field in FIELDS}
    base["doi"] = doi
    base["url"] = f"https://doi.org/{doi}"
    try:
        work = fetch_json("https://api.openalex.org/works/https://doi.org/" + quote(doi, safe=""), mailto)
        base.update(openalex_to_record(doi, work))
    except Exception as error:
        print(f"OpenAlex lookup failed for {doi}: {error}", file=sys.stderr)
    if not base["abstract"]:
        try:
            message = fetch_json("https://api.crossref.org/works/" + quote(doi, safe=""), mailto)["message"]
            fallback = crossref_to_record(doi, message)
            for field in ("title", "abstract", "authors", "doi", "url", "abstract_source"):
                if fallback[field]:
                    base[field] = fallback[field]
        except Exception as error:
            print(f"Crossref lookup failed for {doi}: {error}", file=sys.stderr)
    if not base["abstract"]:
        try:
            fallback = fetch_pubmed_record(doi, mailto)
            for field in ("title", "abstract", "authors", "doi", "url", "abstract_source"):
                if fallback[field]:
                    base[field] = fallback[field]
        except Exception as error:
            print(f"PubMed lookup failed for {doi}: {error}", file=sys.stderr)
    return base


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--pdf", type=Path, help="Review PDF with numbered references")
    source.add_argument("--text", type=Path, help="Text extracted from a review PDF")
    source.add_argument("--dois", type=Path, help="Text file: one DOI per line")
    parser.add_argument("--refs", help="Included reference numbers, e.g. '15-25,31'")
    parser.add_argument("--extract-only", action="store_true", help="Extract references without API enrichment")
    parser.add_argument("--out", type=Path, default=Path("asreview-output"), help="Output directory")
    parser.add_argument("--mailto", default="", help="Contact address supplied to public APIs")
    args = parser.parse_args()
    if args.dois is not None:
        if args.refs is not None:
            parser.error("--refs cannot be used with --dois")
        if args.extract_only:
            parser.error("--extract-only cannot be used with --dois")
    elif args.refs is None:
        parser.error("--refs is required with --pdf or --text")

    try:
        if args.dois is not None:
            dois = list(dict.fromkeys(normalize_doi(line) for line in args.dois.read_text(encoding="utf-8").splitlines() if line.strip()))
        else:
            selected = parse_ref_selector(args.refs)
            text = _pdf_to_text(args.pdf) if args.pdf else args.text.read_text(encoding="utf-8", errors="replace")
            source_name = args.pdf.name if args.pdf else args.text.name
            source_records = extract_records(text, selected)
            source_paths = write_outputs(source_records, args.out, source_name)
            found = {record["reference_number"] for record in source_records}
            missing_refs = sorted(selected - found)
            dois = list(dict.fromkeys(record["doi"] for record in source_records if record["doi"]))
            missing_doi_refs = [record["reference_number"] for record in source_records if not record["doi"]]
            if args.extract_only:
                if missing_refs:
                    print(f"Warning: references not found in extracted bibliography: {missing_refs}", file=sys.stderr)
                if missing_doi_refs:
                    print(f"Warning: selected references without detected DOI: {', '.join(map(str, missing_doi_refs))}", file=sys.stderr)
                print(f"Selected references: {len(selected)}; extracted entries: {len(source_records)}; DOIs: {sum(bool(r['doi']) for r in source_records)}")
                print(f"Zotero DOI list: {source_paths['doi_list']}")
                print(f"Provenance CSV: {source_paths['csv']}")
                return 0
            if missing_refs:
                print(f"Warning: bibliography entries not found: {missing_refs}", file=sys.stderr)
            if missing_doi_refs:
                print(f"Warning: entries without a detected DOI: {missing_doi_refs}", file=sys.stderr)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    records = []
    for index, doi in enumerate(dois, start=1):
        print(f"Resolving {index}/{len(dois)}: {doi}", file=sys.stderr)
        records.append(enrich_doi(doi, args.mailto))
        time.sleep(0.1)
    args.out.mkdir(parents=True, exist_ok=True)
    asreview_csv = args.out / "asreview-records.csv"
    with asreview_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(records)
    missing = sum(not record["abstract"] for record in records)
    if args.dois is not None:
        print(f"Wrote {len(records)} records to {asreview_csv}; missing abstracts: {missing}")
    else:
        print(f"Selected references: {len(selected)}; records with DOI: {len(dois)}; missing abstracts: {missing}")
        print(f"ASReview CSV: {asreview_csv}")
        print(f"Zotero DOI list: {source_paths['doi_list']}")
        print(f"Provenance CSV: {source_paths['csv']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
