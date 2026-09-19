#!/usr/bin/env python3
"""The dev server: python3 serve.py [port]

http.server with one header added. Without it the browser is free to hold on to whatever it already
has — and it decides that per file, so an edit spanning two modules can load fresh and stale side by
side: a slider wired up in one file driving a shader that's still the old one in another. Nothing in
the page says so; it just quietly doesn't work. Served no-store, every reload reads from disk.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    # a browser holding a copy from before this server took over can still ask "only if it changed",
    # and be told it hasn't; the question goes unasked instead
    def send_head(self):
        del self.headers['If-Modified-Since']
        return super().send_head()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'Serving {sys.path[0] or "."} on port {port} (no-store)')
    ThreadingHTTPServer(('', port), NoStoreHandler).serve_forever()
