"""Offline HTTP and URL-fetch regression checks."""

import http.client
import threading
import unittest
from unittest.mock import patch

import server


def multipart(fields):
    body = b""
    for name, value in fields.items():
        body += b'--boundary\r\nContent-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n' + value + b'\r\n'
    return body + b'--boundary--\r\n'


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.token = "test-token"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def request(self, fields, token="test-token"):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        connection.request("POST", "/process", multipart(fields), {"Authorization": "Bearer " + token, "Content-Type": "multipart/form-data; boundary=boundary"})
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_http_upload_and_errors(self):
        pdf = b"%PDF-fake"
        fields = {"refs": b"1", "pdf": pdf, "telegram_token": b"123:ABC_test", "chat_id": b"123"}
        started, release, delivered = threading.Event(), threading.Event(), threading.Event()
        def process(data, refs):
            self.assertEqual((data, refs), (pdf, "1"))
            started.set()
            release.wait(5)
            return b"title,doi\n"
        def send(token, chat_id, **kwargs):
            self.assertEqual((token, chat_id, kwargs), ("123:ABC_test", "123", {"csv_data": b"title,doi\n"}))
            delivered.set()
        with patch.object(server, "process", side_effect=process), patch.object(server, "send_telegram", side_effect=send):
            status, data = self.request(fields)
            self.assertEqual((status, data), (202, b'{"accepted":true}'))
            self.assertTrue(started.wait(2))
            self.assertFalse(delivered.is_set())
            release.set()
            self.assertTrue(delivered.wait(2))
        self.assertEqual(self.request(fields, "wrong")[0], 401)
        self.assertEqual(self.request({"refs": b"1"})[0], 400)
        self.assertEqual(self.request({**fields, "telegram_token": b"../../bad"})[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        connection.putrequest("POST", "/process")
        connection.putheader("Authorization", "Bearer test-token")
        connection.putheader("Content-Length", str(server.MAX_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()

    def test_background_url_error_and_fixed_telegram_destination(self):
        sent = threading.Event()
        def notify(token, chat_id, **kwargs):
            self.assertEqual((token, chat_id), ("123:ABC", "123"))
            self.assertIn("No accessible public PDF", kwargs["text"])
            sent.set()
        fields = {"refs": b"1", "url": b"https://example.org/article", "telegram_token": b"123:ABC", "chat_id": b"123"}
        with patch.object(server, "obtain_pdf", side_effect=server.ServiceError(422, "No accessible public PDF")), patch.object(server, "send_telegram", side_effect=notify):
            self.assertEqual(self.request(fields)[0], 202)
            self.assertTrue(sent.wait(2))
        with patch.object(server.http.client, "HTTPSConnection") as connection:
            connection.return_value.getresponse.return_value.status = 200
            connection.return_value.getresponse.return_value.read.return_value = b'{"ok":true}'
            server.send_telegram("123:ABC", "123", csv_data=b"title\n")
            connection.assert_called_once_with("api.telegram.org", timeout=30)
            args = connection.return_value.request.call_args.args
            self.assertEqual(args[1], "/bot123:ABC/sendDocument")
            self.assertIn(b"title\n", args[2])

    def test_article_resolution_and_private_addresses(self):
        html = b'<meta name="citation_pdf_url" content="/article.pdf">'
        with patch.object(server, "fetch", side_effect=[("https://example.org/article", "text/html", html), ("https://example.org/article.pdf", "application/pdf", b"%PDF-test")]) as fetch:
            self.assertEqual(server.obtain_pdf("10.1234/example"), b"%PDF-test")
            self.assertEqual(fetch.call_args_list[0].args[0], "https://doi.org/10.1234/example")
            self.assertEqual(fetch.call_args_list[1].args[0], "https://example.org/article.pdf")
        with patch.object(server.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 80))]), patch.object(server.socket, "create_connection") as connect:
            with self.assertRaises(server.ServiceError) as error:
                server.fetch("http://example.org/")
            self.assertEqual(error.exception.status, 400)
            connect.assert_not_called()

    def test_redirect_is_revalidated(self):
        class Response:
            status = 302
            def getheader(self, name, default=None):
                return "http://127.0.0.1/secret"
        class Connection:
            def __init__(self, *args, **kwargs): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        addresses = [[(2, 1, 6, "", ("8.8.8.8", 80))], [(2, 1, 6, "", ("127.0.0.1", 80))]]
        with patch.object(server.socket, "getaddrinfo", side_effect=addresses), patch.object(server.socket, "create_connection") as connect, patch.object(server.http.client, "HTTPConnection", Connection):
            with self.assertRaises(server.ServiceError):
                server.fetch("http://example.org/")
            self.assertEqual(connect.call_count, 1)


if __name__ == "__main__":
    unittest.main()
