"""Local Python execution server. Run with python3 -m execution.py.main."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import socket
import threading
from urllib.parse import urlsplit

from .execution import BuildSweepMatrix, ExecutionError, ParseExecutionConfig, RunSweep
from .hardware import machine_health

BODY_LIMIT = 1024 * 1024
# One benchmark at a time: children pin to the same core, so overlapping runs corrupt timings.
_RUN_LOCK = threading.Lock()


class ExecutionHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def _respond(self, status, body, content_type="text/plain; charset=utf-8", *, allow=None):
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        if allow:
            self.send_header("Allow", allow)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_POST(self):
        if urlsplit(self.path).path != "/execute":
            self._respond(404, "Not found\n")
            return
        try:
            # The proxy sends Content-Length. Reject ambiguous/chunked framing.
            lengths = self.headers.get_all("Content-Length", [])
            if "Transfer-Encoding" in self.headers or len(lengths) != 1:
                raise ValueError("one Content-Length header is required")
            length = int(lengths[0])
            if not 0 <= length <= BODY_LIMIT:
                raise ValueError("request body must be at most 1 MiB")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete request body")
            cfg = ParseExecutionConfig(json.loads(body))
            BuildSweepMatrix(cfg.Sweep)
        except (ValueError, UnicodeError) as exc:
            self._respond(400, f"invalid request: {exc}\n")
            return
        except (socket.timeout, OSError):
            self._respond(400, "could not read request body\n")
            return
        try:
            with _RUN_LOCK:
                results = RunSweep(cfg)
        except TimeoutError as exc:
            self._respond(504, f"{exc}\n")
        except (ExecutionError, OSError, ValueError) as exc:
            self._respond(500, f"{exc}\n")
        else:
            self._respond(200, json.dumps({"results": results}, allow_nan=False), "application/json")

    def _method_not_allowed(self):
        if urlsplit(self.path).path == "/execute":
            self._respond(405, "use POST\n", allow="POST")
        else:
            self._respond(404, "Not found\n")

    def do_GET(self):
        if urlsplit(self.path).path == "/health":
            self._respond(200, json.dumps(machine_health()), "application/json")
        else:
            self._method_not_allowed()

    do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _method_not_allowed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=6970, type=int)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    with ThreadingHTTPServer((args.host, args.port), ExecutionHandler) as server:
        logging.info("Python execution server listening on http://%s:%s", *server.server_address)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
