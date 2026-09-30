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
And assets/tv-loudness.json: each YouTube video in assets/text/tv.txt's loudness (YouTube's loudnessDb, off its watch
page), for the homes' TVs to even out (src/buildings/interior.js); only those not in it yet are looked up, on start, in
the background — commit it too. `python3 serve.py --index` just writes them.
"""
import json
import os
import re
import sys
import threading
import urllib.request
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

TV_LIST = os.path.join(ASSETS, 'text', 'tv.txt')
TV_LOUDNESS = os.path.join(ASSETS, 'tv-loudness.json')
YOUTUBE_ID = re.compile(r'(?:[?&]v=|youtu\.be/|/embed/|/shorts/|/live/)([\w-]{11})|^([\w-]{11})$')

def write_tv_loudness():
    try:
        with open(TV_LOUDNESS, encoding='utf-8') as f:
            known = json.load(f)
    except (OSError, ValueError):
        known = {}
    try:
        with open(TV_LIST, encoding='utf-8') as f:
            lines = [re.sub(r'\s#.*', '', line).strip() for line in f]
    except OSError:
        return
    ids = [m.group(1) or m.group(2) for m in (YOUTUBE_ID.search(line) for line in lines if line and not line.startswith('#')) if m]
    missing = [i for i in dict.fromkeys(ids) if i not in known]
    for video in missing:
        try:
            request = urllib.request.Request(f'https://www.youtube.com/watch?v={video}', headers={'User-Agent': 'Mozilla/5.0'})
            page = urllib.request.urlopen(request, timeout=15).read().decode('utf-8', 'replace')
        except OSError:
            continue
        found = re.search(r'"loudnessDb":(-?[\d.]+)', page)
        if found:
            known[video] = round(float(found.group(1)), 2)
    if missing:
        with open(TV_LOUDNESS, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(known, f, indent=0, sort_keys=True)
            f.write('\n')

# ...except the UI icons: many small images the page uses over and over (as CSS masks too), which no-store had going
# missing now and then. Kept a minute, then checked for changes, so an edited icon still shows up soon.
ICONS = '/assets/icons/'
ICON_CACHE = 'max-age=60, must-revalidate'

class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        icon = self.path.split('?')[0].startswith(ICONS)
        self.send_header('Cache-Control', ICON_CACHE if icon else 'no-store, max-age=0')
        super().end_headers()

    # a browser holding a copy from before this server took over can still ask "only if it changed",
    # and be told it hasn't; the question goes unasked instead
    def send_head(self):
        if not self.path.split('?')[0].startswith(ICONS):
            del self.headers['If-Modified-Since']
        for folder_name in INDEXED:
            if self.path.split('?')[0] == f'/assets/{folder_name}/{INDEX_NAME}':
                write_index(folder_name)
        return super().send_head()

if __name__ == '__main__':
    for folder_name in INDEXED:
        write_index(folder_name)
    if '--index' in sys.argv:
        write_tv_loudness()
        sys.exit()
    threading.Thread(target=write_tv_loudness, daemon=True).start()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'Serving {sys.path[0] or "."} on port {port} (no-store)')
    ThreadingHTTPServer(('', port), NoStoreHandler).serve_forever()
