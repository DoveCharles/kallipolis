#!/usr/bin/env python3
"""The dev server: python3 serve.py [port]

http.server with one header added. Without it the browser is free to hold on to whatever it already
has — and it decides that per file, so an edit spanning two modules can load fresh and stale side by
side: a slider wired up in one file driving a shader that's still the old one in another. Nothing in
the page says so; it just quietly doesn't work. Served no-store, every reload reads from disk.

It also keeps assets/text/index.txt up to date: every .txt under assets/text/, one path per line, which the
speech loader (src/life/speech-text.js) reads, since a browser can't list a folder. Written afresh each time
it's asked for, and on start — commit it, so the deployed site (no server of its own) has it too.
assets/music/index.txt the same, for the .mid files under assets/music/ (the pubs' music: src/audio/pub-music.js).
`python3 serve.py --index` just writes them.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')
INDEX_NAME = 'index.txt'
INDEXED = {'text': '.txt', 'music': '.mid'} # folder under assets/ -> the files listed in its index.txt

def write_index(folder_name):
    top, ending, paths = os.path.join(ASSETS, folder_name), INDEXED[folder_name], []
    for folder, dirs, files in os.walk(top):
        dirs.sort()
        for name in sorted(files):
            path = os.path.relpath(os.path.join(folder, name), top).replace(os.sep, '/')
            if name.lower().endswith(ending) and path != INDEX_NAME:
                paths.append(path)
    with open(os.path.join(top, INDEX_NAME), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(paths) + '\n')

class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    # a browser holding a copy from before this server took over can still ask "only if it changed",
    # and be told it hasn't; the question goes unasked instead
    def send_head(self):
        del self.headers['If-Modified-Since']
        for folder_name in INDEXED:
            if self.path.split('?')[0] == f'/assets/{folder_name}/{INDEX_NAME}':
                write_index(folder_name)
        return super().send_head()

if __name__ == '__main__':
    for folder_name in INDEXED:
        write_index(folder_name)
    if '--index' in sys.argv:
        sys.exit()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'Serving {sys.path[0] or "."} on port {port} (no-store)')
    ThreadingHTTPServer(('', port), NoStoreHandler).serve_forever()
