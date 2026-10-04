#!/usr/bin/env python3
"""Development server for MIKŌ.

    python3 serve.py            # http://localhost:8000
    python3 serve.py 9000       # pick the port
    python3 serve.py --open     # and open a browser

Why this exists rather than `python3 -m http.server`: that one sends no
Cache-Control header, so the browser heuristically caches ES modules. You edit
a file, reload, and get the old one — which looks exactly like a change that
did not work. Everything here is served `no-store`.

It also sets the media types the app needs (`.webmanifest`, `.mjs`) and serves
404.html with a real 404 status for unknown paths, matching how a static host
behaves once a 404 page is present.
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
        """Unknown paths get 404.html, with a real 404 status.

        This used to serve index.html for anything extensionless, the usual
        SPA-rewrite trick. MIKŌ does not need it: every route lives in the
        fragment (`/#/today`), which never reaches a server, so there is no
        path-based deep link to rescue. What the rewrite did instead was make a
        mistyped URL answer 200 with the app — so the custom 404 page could
        never appear, and a crawler was told every wrong URL was a real page.
        """
        path = self.translate_path(self.path)
        if not os.path.exists(path):
            notfound = os.path.join(ROOT, "404.html")
            if os.path.exists(notfound):
                self.path = "/404.html"
                # Build the response ourselves so the status stays 404; letting
                # the base class handle it would send 200 for the rewritten path.
                try:
                    f = open(notfound, "rb")
                except OSError:
                    return super().send_head()
                self.send_response(404)
                self.send_header("Content-type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(os.path.getsize(notfound)))
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                self.end_headers()
                return f
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
