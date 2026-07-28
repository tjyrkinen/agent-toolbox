import concurrent.futures
import http.client
import json
import socket
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import serve


class ServeSecurityTest(unittest.TestCase):
    def setUp(self):
        self.request_timeout = serve.REQUEST_TIMEOUT_SECONDS
        serve.REQUEST_TIMEOUT_SECONDS = 0.1
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output = Path(self.temp_dir.name) / "answer.json"
        self.done = threading.Event()
        self.state = {}
        handler = serve.build_handler(
            b"<html>fixture</html>",
            "fixture-nonce",
            self.output,
            self.done,
            self.state,
        )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        serve.REQUEST_TIMEOUT_SECONDS = self.request_timeout
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.temp_dir.cleanup()

    def request(self, path):
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            self.server.server_address[1],
            timeout=2,
        )
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body

    def raw_post(self, content_length, body=b""):
        with socket.create_connection(
            ("127.0.0.1", self.server.server_address[1]),
            timeout=2,
        ) as connection:
            request = (
                b"POST /submit HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                + f"Content-Length: {content_length}\r\n".encode()
                + b"Content-Type: application/json\r\n"
                b"Connection: close\r\n\r\n"
                + body
            )
            connection.sendall(request)
            connection.shutdown(socket.SHUT_WR)
            response = b""
            while True:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                response += chunk
        return int(response.split(b" ", 2)[1])

    def post_json(self, payload):
        body = json.dumps(payload).encode()
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            self.server.server_address[1],
            timeout=2,
        )
        connection.request(
            "POST",
            "/submit",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        response.read()
        connection.close()
        return response.status

    def test_page_requires_matching_query_nonce(self):
        status, _ = self.request("/")
        self.assertEqual(status, 403)

        status, body = self.request("/?n=fixture-nonce")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"<html>fixture</html>")

    def test_submit_rejects_negative_content_length_before_reading(self):
        status = self.raw_post(
            -1,
            b'{"nonce":"fixture-nonce","actionKind":"primary"}',
        )
        self.assertEqual(status, 400)
        self.assertFalse(self.output.exists())

    def test_submit_rejects_oversized_content_length_before_reading(self):
        status = self.raw_post(1_048_577)
        self.assertEqual(status, 413)
        self.assertFalse(self.output.exists())

    def test_submit_times_out_when_body_never_completes(self):
        with socket.create_connection(
            ("127.0.0.1", self.server.server_address[1]),
            timeout=2,
        ) as connection:
            connection.sendall(
                b"POST /submit HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Length: 10\r\n"
                b"Content-Type: application/json\r\n\r\n"
                b"{"
            )
            response = connection.recv(4096)
        status = int(response.split(b" ", 2)[1])
        self.assertEqual(status, 408)
        self.assertFalse(self.output.exists())

    def test_first_valid_submission_wins(self):
        payloads = [
            {"nonce": "fixture-nonce", "action": "approve"},
            {"nonce": "fixture-nonce", "action": "request-changes"},
        ]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(self.post_json, payloads))

        self.assertCountEqual(statuses, [200, 409])
        stored = json.loads(self.output.read_text())
        self.assertIn(stored["action"], {"approve", "request-changes"})


class ServeInjectionTest(unittest.TestCase):
    def test_script_json_escapes_html_and_javascript_separators(self):
        encoded = serve.script_json({"body": "<!--<script>\u2028\u2029"})

        self.assertNotIn("<", encoded)
        self.assertNotIn("\u2028", encoded)
        self.assertNotIn("\u2029", encoded)
        self.assertIn("\\u003c", encoded)
        self.assertIn("\\u2028", encoded)
        self.assertIn("\\u2029", encoded)

    def test_existing_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "answer.json"
            output.write_text('{"stale": true}')

            with self.assertRaisesRegex(ValueError, "output already exists"):
                serve.require_fresh_output(output)


if __name__ == "__main__":
    unittest.main()
