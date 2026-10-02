# Names this version from 2 random words in assets/text/speech/words and writes it into index.html's title bar.
import random, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
words = []
for f in (root / 'assets/text/speech/words').rglob('*.txt'):
    for line in f.read_text(encoding='utf-8').splitlines():
        w = re.sub(r'\{[^}]*\}|<[^>]*>', '', line).split('|')[0].strip()
        if w and not re.search(r'[#\[\]>:]', w) and len(w.split()) == 1: words.append(w)
name = ' '.join(w.capitalize() for w in random.sample(words, 2))
html = root / 'index.html'
text = html.read_bytes().decode('utf-8')
html.write_bytes(re.sub(r'<span id="version">[^<]*</span>', f'<span id="version">{name}</span>', text, count=1).encode('utf-8'))
print(name)
