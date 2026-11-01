"""Local HTTP wrapper for the ASReview reference extractor."""

import csv
import hmac
import http.client
import io
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import uuid
from email.parser import BytesParser
from email.policy import default
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import asreview

MAX_BYTES = 20 * 1024 * 1024
MAX_REFS = 500


class ServiceError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class PDFLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name", "").lower() in ("citation_pdf_url", "dc.identifier"):
            self.links.append(attrs.get("content", ""))
        if tag in ("a", "link"):
            href = attrs.get("href", "")
            if (tag == "link" and attrs.get("type", "").lower() == "application/pdf") or re.search(r"\.pdf(?:[?#]|$)", href, re.I):
                self.links.append(href)


def fetch(url):
    """Fetch with public-only DNS, pinned sockets, and revalidation on redirects."""
    for _ in range(6):
        try:
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None:
                raise ServiceError(400, "URL must be a public HTTP(S) URL without credentials")
            port = parts.port or (443 if parts.scheme == "https" else 80)
            addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
            ips = [item[4][0] for item in addresses]
            if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
                raise ServiceError(400, "URL resolves to a non-public address")
            sock = socket.create_connection((ips[0], port), timeout=15)
            if parts.scheme == "https":
                try:
                    sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parts.hostname)
                except Exception:
                    sock.close()
                    raise
            conn = http.client.HTTPConnection(parts.hostname, port, timeout=15)
            conn.sock = sock
            try:
                path = parts.path or "/"
                if parts.query:
                    path += "?" + parts.query
                conn.request("GET", path, headers={"Host": parts.netloc, "User-Agent": "asreview-local/1.0", "Accept": "application/pdf,text/html;q=0.9"})
                response = conn.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location:
                        raise ServiceError(502, "Upstream redirect has no location")
                    url = urljoin(url, location)
                    continue
                if response.status != 200:
                    raise ServiceError(502, f"Upstream returned HTTP {response.status}")
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ServiceError(413, "Downloaded file exceeds 20 MiB")
                return url, response.getheader("Content-Type", ""), data
            finally:
                conn.close()
        except ServiceError:
            raise
        except (OSError, ValueError, http.client.HTTPException) as error:
            raise ServiceError(502, "Could not fetch the public URL") from error
    raise ServiceError(502, "Too many redirects")


def obtain_pdf(url):
    if re.fullmatch(r"10\.\d{4,9}/\S+", url, re.I):
        url = "https://doi.org/" + url
    final_url, content_type, data = fetch(url)
    if data.startswith(b"%PDF-"):
        return data
    if "html" not in content_type.lower() and not data.lstrip().lower().startswith((b"<!doctype html", b"<html")):
        raise ServiceError(422, "URL did not return a PDF or HTML article page")
    parser = PDFLinks()
    parser.feed(data.decode("utf-8", errors="replace"))
    for link in parser.links[:10]:
        if not link:
            continue
        try:
            _, _, candidate = fetch(urljoin(final_url, link))
            if candidate.startswith(b"%PDF-"):
                return candidate
        except ServiceError:
            continue
    raise ServiceError(422, "No accessible public PDF found on article page")


def process(pdf, refs):
    if not pdf.startswith(b"%PDF-"):
        raise ServiceError(422, "Input is not a PDF")
    if not isinstance(refs, str) or len(refs) > 4000:
        raise ServiceError(400, "Invalid reference selector")
    # Bound ranges before calling the existing parser, which expands them into a set.
    for number in re.findall(r"\d+", refs):
        if len(number) > 6 or int(number) > 100000:
            raise ServiceError(400, "Reference number exceeds 100000")
    try:
        selected = asreview.parse_ref_selector(refs)
    except ValueError as error:
        raise ServiceError(400, str(error)) from error
    if len(selected) > MAX_REFS:
        raise ServiceError(400, "Select at most 500 references")
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "review.pdf"
        target = Path(directory) / "review.txt"
        source.write_bytes(pdf)
        try:
            subprocess.run(["pdftotext", str(source), str(target)], check=True, timeout=30, capture_output=True)
            text = target.read_text(encoding="utf-8", errors="replace")
        except (subprocess.SubprocessError, OSError) as error:
            raise ServiceError(422, "Could not extract text from PDF") from error
    records = asreview.extract_records(text, selected)
    dois = list(dict.fromkeys(record["doi"] for record in records if record["doi"]))
    if not dois:
        raise ServiceError(422, "No DOIs found in the selected bracket-numbered references")
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=asreview.FIELDS)
    writer.writeheader()
    for doi in dois:
        writer.writerow(asreview.enrich_doi(doi, ""))
    return output.getvalue().encode("utf-8")


def send_telegram(token, chat_id, *, csv_data=None, text=None):
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n{chat_id}\r\n').encode()
    if csv_data is not None:
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="asreview-records.csv"\r\nContent-Type: text/csv\r\n\r\n').encode() + csv_data + b"\r\n"
        method = "sendDocument"
    else:
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n{text}\r\n').encode()
        method = "sendMessage"
    body += f'--{boundary}--\r\n'.encode()
    conn = http.client.HTTPSConnection("api.telegram.org", timeout=30)
    try:
        conn.request("POST", f"/bot{token}/{method}", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        response = conn.getresponse()
        result = json.loads(response.read())
        if response.status != 200 or not result.get("ok"):
            raise RuntimeError("Telegram delivery failed")
    finally:
        conn.close()


def run_job(pdf, url, refs, token, chat_id):
    try:
        csv_data = process(pdf if pdf is not None else obtain_pdf(url), refs)
    except ServiceError as error:
        try:
            send_telegram(token, chat_id, text=f"Review failed: {error.message}. Start Review Articles to try again.")
        except Exception:
            print("Review error notification failed", file=sys.stderr)
        return
    except Exception:
        try:
            send_telegram(token, chat_id, text="Review processing failed. Start Review Articles to try again.")
        except Exception:
            print("Review error notification failed", file=sys.stderr)
        return
    try:
        send_telegram(token, chat_id, csv_data=csv_data)
    except Exception:
        print("Review CSV delivery failed", file=sys.stderr)
        try:
            send_telegram(token, chat_id, text="Review completed, but CSV delivery failed. Start Review Articles to try again.")
        except Exception:
            print("Review error notification failed", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # URLs and request headers may contain sensitive information.
        pass

    def respond(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8"), ("Bearer " + self.server.token).encode("ascii")):
                raise ServiceError(401, "Unauthorized")
            if self.path != "/process":
                raise ServiceError(404, "Not found")
            if self.headers.get("Transfer-Encoding"):
                raise ServiceError(400, "Transfer-Encoding is not supported; send Content-Length")
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                raise ServiceError(411, "Valid Content-Length required")
            if length < 0:
                raise ServiceError(400, "Invalid Content-Length")
            if length > MAX_BYTES:
                raise ServiceError(413, "Request exceeds 20 MiB")
            content_type = self.headers.get("Content-Type", "")
            if not content_type.lower().startswith("multipart/form-data;"):
                raise ServiceError(400, "Expected multipart/form-data")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ServiceError(400, "Incomplete request body")
            message = BytesParser(policy=default).parsebytes(b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
            if not message.is_multipart():
                raise ServiceError(400, "Invalid multipart body")
            fields = {}
            for part in message.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name not in ("refs", "pdf", "url", "telegram_token", "chat_id") or name in fields:
                    raise ServiceError(400, "Unexpected or duplicate multipart field")
                fields[name] = part.get_payload(decode=True) or b""
            if not {"refs", "telegram_token", "chat_id"} <= fields.keys() or ("pdf" in fields) == ("url" in fields):
                raise ServiceError(400, "Provide refs, telegram_token, chat_id and exactly one of pdf or url")
            try:
                refs = fields["refs"].decode("utf-8")
                url = fields["url"].decode("utf-8").strip() if "url" in fields else None
                token = fields["telegram_token"].decode("ascii")
                chat_id = fields["chat_id"].decode("ascii")
            except UnicodeError as error:
                raise ServiceError(400, "Text fields must be UTF-8") from error
            if not re.fullmatch(r"\d+:[A-Za-z0-9_-]+", token) or not re.fullmatch(r"-?\d+", chat_id):
                raise ServiceError(400, "Invalid Telegram credentials or chat ID")
            # ponytail: in-memory jobs are lost on restart; use a durable queue for recovery.
            threading.Thread(target=run_job, args=(fields.get("pdf"), url, refs, token, chat_id), daemon=True).start()
            self.respond(202, b'{"accepted":true}', "application/json; charset=utf-8")
        except ServiceError as error:
            self.close_connection = True
            self.respond(error.status, json.dumps({"error": error.message}).encode(), "application/json; charset=utf-8")
        except Exception:
            self.close_connection = True
            self.respond(500, b'{"error":"Internal processing error"}', "application/json; charset=utf-8")


if __name__ == "__main__":
    token = os.environ.get("ASREVIEW_TOKEN", "")
    if not token or not token.isascii() or any(c.isspace() or ord(c) < 33 or ord(c) > 126 for c in token):
        raise SystemExit("ASREVIEW_TOKEN must be a nonempty printable ASCII token without whitespace")
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.token = token
    server.serve_forever()
