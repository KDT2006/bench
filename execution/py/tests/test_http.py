from contextlib import contextmanager
from dataclasses import replace
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import patch

from execution.py import main
from execution.py.execution import ExecutionError, RunSweep


@contextmanager
def server():
    with ThreadingHTTPServer(("127.0.0.1", 0), main.ExecutionHandler) as httpd:
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield httpd.server_address
        finally:
            httpd.shutdown()
            thread.join()


class HTTPTests(unittest.TestCase):
    def request(self, address, method="POST", body="", path="/execute", headers=None):
        connection = HTTPConnection(*address, timeout=5)
        try:
            connection.request(method, path, body, headers or {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            connection.close()

    def test_invalid_requests_never_execute(self):
        cases = [
            ("GET", "", "/execute", 405), ("PUT", "", "/execute", 405),
            ("POST", "", "/missing", 404), ("POST", "{", "/execute", 400),
            ("POST", "null", "/execute", 400), ("POST", "[]", "/execute", 400),
            ("POST", '{"name":"x","code":"#bench","extra":1}', "/execute", 400),
            ("POST", '{"name":"x","code":"#bench"} {}', "/execute", 400),
            ("POST", '{"name":"x","code":"#setup"}', "/execute", 400),
            ("POST", json.dumps({"name": "x", "code": "#sweep\nn: [bad]\n#bench"}), "/execute", 400),
        ]
        with server() as address, patch.object(main, "RunSweep") as run:
            for method, body, path, expected in cases:
                with self.subTest(body=body, method=method):
                    status, headers, _ = self.request(address, method, body, path)
                    self.assertEqual(status, expected)
                    if expected == 405:
                        self.assertEqual(headers["Allow"], "POST")
            status, _, _ = self.request(address, headers={"Content-Length": str(main.BODY_LIMIT + 1)})
            self.assertEqual(status, 400)
            status, _, _ = self.request(address, headers={"Transfer-Encoding": "chunked"})
            self.assertEqual(status, 400)
            run.assert_not_called()

    def test_real_http_execution(self):
        body = json.dumps({"name": "HTTP example", "byteCount": 8, "fenced": True,
            "code": "#sweep\nn: [1, 2]\n#setup\nvalue = n\n#bench\nresult = value + 1\n#cleanup\nassert result == n + 1"})
        # Keep the production default at ten seconds; shorten only this test.
        with server() as address, patch.object(main, "RunSweep", side_effect=lambda cfg: RunSweep(replace(cfg, BenchDuration=0.005))):
            status, headers, body = self.request(address, body=body)
        self.assertEqual(status, 200, body)
        self.assertEqual(headers["Content-Type"], "application/json")
        results = json.loads(body)["results"]
        self.assertEqual([r["name"] for r in results], ["HTTP example (n=1)", "HTTP example (n=2)"])
        for result in results:
            self.assertEqual(result["byte_count"], 8)
            self.assertTrue(result["fenced"])
            self.assertGreater(result["iterations"], 0)
            self.assertGreater(result["measurements"]["TotalTime"], 0)

    def test_error_statuses(self):
        body = json.dumps({"name": "x", "code": "#bench"})
        with server() as address:
            for error, expected in [(ExecutionError("work failed"), 500), (TimeoutError("too slow"), 504)]:
                with patch.object(main, "RunSweep", side_effect=error):
                    status, _, response = self.request(address, body=body)
                self.assertEqual(status, expected)
                self.assertIn(str(error), response)


if __name__ == "__main__":
    unittest.main()
