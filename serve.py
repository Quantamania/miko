#!/usr/bin/env python3
"""Development server for MIKŌ.

    python3 serve.py            # http://localhost:8000
    python3 serve.py 9000       # pick the port
    python3 serve.py --open     # and open a browser

Why this exists rather than `python3 -m http.server`: that one sends no
Cache-Control header, so the browser heuristically caches ES modules. You edit
a file, reload, and get the old one — which looks exactly like a change that
did not work. Everything here is served `no-store`.

It also sets the media types the app needs (`.webmanifest`, `.mjs`) and falls
back to `index.html` for unknown paths, matching how a static host behaves so
a deep link does not 404.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import socket
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
        ".woff2": "font/woff2",
    }

    def end_headers(self) -> None:
        # Nothing is cached in development. This is the whole point of the file.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        # The worker has to be able to claim the whole origin.
        if self.path.rstrip("/").endswith("sw.js"):
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def send_head(self):
        # A path with no file behind it gets the shell, the way a static host
        # would, so refreshing a deep link works.
        path = self.translate_path(self.path)
        if not os.path.exists(path) and "." not in os.path.basename(path):
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, fmt: str, *args) -> None:
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):  # only the failures are worth printing
            sys.stderr.write("  %s %s\n" % (status, args[0]))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def free_port(start: int, tries: int = 20) -> int:
    """First free port at or after `start`, so a stale server is not fatal."""
    for port in range(start, start + tries):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port between {start} and {start + tries - 1}.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Serve MIKŌ for development.")
    ap.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    ap.add_argument("--open", action="store_true", help="open a browser window")
    args = ap.parse_args()

    port = free_port(args.port)
    if port != args.port:
        print(f"Port {args.port} is taken — using {port}.")

    url = f"http://localhost:{port}"
    handler = functools.partial(Handler, directory=ROOT)

    with Server(("", port), handler) as httpd:
        print(f"MIKŌ  →  {url}")
        print("Ctrl-C to stop.\n")
        if args.open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
