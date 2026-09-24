// Options > Display > Colour scheme: the schemes Windows 3's Control Panel > Color offered, each setting the css/win3.css
// variables named after its screen elements (Window Background, Menu Bar, Active Title Bar, Active Border, Highlight,
// Button Face …) on <html>. Windows Default is what css/win3.css already has, so picking it just clears them.
// Remembered in localStorage.
// The schemes are CONTROL.INI's [color schemes] lines as Windows 3.1 shipped them: 21 colours each, in the order of ELEMENTS,
// written as COLORREFs (hex 0xBBGGRR, leading zeros dropped; a high byte, as in Black Leather Jacket's scroll bars, marks a
// dithered colour and is ignored). The desktop, workspace, scroll bar, disabled text and button highlight aren't used
// (the view is the desktop).

const KEY = 'splinetopia.colorScheme';
// each CONTROL.INI colour in turn, and the css/win3.css variable it sets (null: not used)
const ELEMENTS = [
  null, null, '--w3-window', '--w3-text', '--w3-menu', '--w3-menu-text', // desktop, application workspace, …
  '--w3-title', '--w3-inactive', '--w3-title-text', '--w3-border', '--w3-border-inactive',
  '--w3-frame', null, '--w3-face', '--w3-shadow', '--w3-btn-text', null, // …, scroll bars, …, disabled text
  '--w3-hl', '--w3-hl-text', '--w3-inactive-text', null,              // …, button highlight
];
const INI = `
Arizona=804000,FFFFFF,FFFFFF,0,FFFFFF,0,808040,C0C0C0,FFFFFF,4080FF,C0C0C0,0,C0C0C0,C0C0C0,808080,0,808080,808000,FFFFFF,0,FFFFFF
Black Leather Jacket=0,C0C0C0,FFFFFF,0,C0C0C0,0,800040,808080,FFFFFF,808080,808080,0,10E0E0E0,C0C0C0,808080,0,808080,0,FFFFFF,0,FFFFFF
Bordeaux=400080,C0C0C0,FFFFFF,0,FFFFFF,0,800080,C0C0C0,FFFFFF,FF0080,C0C0C0,0,C0C0C0,C0C0C0,808080,0,808080,800080,FFFFFF,0,FFFFFF
Cinnamon=404080,C0C0C0,FFFFFF,0,FFFFFF,0,80,C0C0C0,FFFFFF,80,C0C0C0,0,C0C0C0,C0C0C0,808080,0,808080,80,FFFFFF,0,FFFFFF
Designer=7C7C3F,C0C0C0,FFFFFF,0,FFFFFF,0,808000,C0C0C0,FFFFFF,C0C0C0,C0C0C0,0,C0C0C0,C0C0C0,808080,0,C0C0C0,808000,0,0,FFFFFF
Emerald City=404000,C0C0C0,FFFFFF,0,C0C0C0,0,408000,808040,FFFFFF,408000,808040,0,C0C0C0,C0C0C0,808080,0,808080,8000,FFFFFF,0,FFFFFF
Fluorescent=0,FFFFFF,FFFFFF,0,FF00,0,FF00FF,C0C0C0,0,FF80,C0C0C0,0,C0C0C0,C0C0C0,808080,0,808080,0,FFFFFF,0,FFFFFF
Hotdog Stand=FFFF,FFFF,FF,FFFFFF,FFFFFF,0,0,FF,FFFFFF,FF,FF,0,C0C0C0,C0C0C0,808080,0,808080,0,FFFFFF,FFFFFF,FFFFFF
LCD Default Screen Settings=808080,C0C0C0,C0C0C0,0,C0C0C0,0,800000,C0C0C0,FFFFFF,800000,C0C0C0,0,C0C0C0,C0C0C0,7F8080,0,808080,800000,FFFFFF,0,FFFFFF
LCD Reversed - Dark=0,80,80,FFFFFF,8080,0,8080,800000,0,8080,800000,0,8080,C0C0C0,7F8080,0,C0C0C0,800000,FFFFFF,828282,FFFFFF
LCD Reversed - Light=800000,FFFFFF,FFFFFF,0,FFFFFF,0,808040,FFFFFF,0,C0C0C0,C0C0C0,800000,C0C0C0,C0C0C0,7F8080,0,808040,800000,FFFFFF,0,FFFFFF
Mahogany=404040,C0C0C0,FFFFFF,0,FFFFFF,0,40,C0C0C0,FFFFFF,C0C0C0,C0C0C0,0,C0C0C0,C0C0C0,808080,0,C0C0C0,80,FFFFFF,0,FFFFFF
Monochrome=C0C0C0,FFFFFF,FFFFFF,0,FFFFFF,0,0,C0C0C0,FFFFFF,C0C0C0,C0C0C0,0,808080,C0C0C0,808080,0,808080,0,FFFFFF,0,FFFFFF
Ocean=808000,408000,FFFFFF,0,FFFFFF,0,804000,C0C0C0,FFFFFF,C0C0C0,C0C0C0,0,C0C0C0,C0C0C0,808080,0,0,808000,0,0,FFFFFF
Pastel=C0FF82,80FFFF,FFFFFF,0,FFFFFF,0,FFFF80,FFFFFF,0,C080FF,FFFFFF,808080,C0C0C0,C0C0C0,808080,0,C0C0C0,FFFF00,0,0,FFFFFF
Patchwork=9544BB,C1FBFA,FFFFFF,0,FFFFFF,0,FFFF80,FFFFFF,0,64B14E,FFFFFF,0,C0C0C0,C0C0C0,808080,0,808080,FFFF00,0,0,FFFFFF
Plasma Power Saver=0,FF0000,0,FFFFFF,FF00FF,0,800000,C0C0C0,0,80,FFFFFF,C0C0C0,FF0000,C0C0C0,808080,0,C0C0C0,FFFFFF,0,0,FFFFFF
Rugby=C0C0C0,80FFFF,FFFFFF,0,FFFFFF,0,800000,FFFFFF,FFFFFF,80,FFFFFF,0,C0C0C0,C0C0C0,808080,0,808080,800000,FFFFFF,0,FFFFFF
The Blues=804000,C0C0C0,FFFFFF,0,FFFFFF,0,800000,C0C0C0,FFFFFF,C0C0C0,C0C0C0,0,C0C0C0,C0C0C0,808080,0,C0C0C0,800000,FFFFFF,0,FFFFFF
Tweed=6A619E,C0C0C0,FFFFFF,0,FFFFFF,0,408080,C0C0C0,FFFFFF,404080,C0C0C0,0,10E0E0E0,C0C0C0,808080,0,C0C0C0,8080,0,0,FFFFFF
Valentine=C080FF,FFFFFF,FFFFFF,0,FFFFFF,0,8000FF,400080,FFFFFF,C080FF,C080FF,0,C0C0C0,C0C0C0,808080,0,808080,FF00FF,0,FFFFFF,FFFFFF
Wingtips=408080,C0C0C0,FFFFFF,0,FFFFFF,0,808080,FFFFFF,FFFFFF,4080,FFFFFF,0,808080,C0C0C0,808080,0,C0C0C0,808080,FFFFFF,0,FFFFFF`;

// a COLORREF (0xBBGGRR) as a CSS colour
const css = ref => {
  const n = parseInt(ref, 16);
  return '#' + [n & 255, (n >> 8) & 255, (n >> 16) & 255].map(c => c.toString(16).padStart(2, '0')).join('');
};

export const SCHEMES = [{ id: 'default', name: 'Windows Default', colors: null }];
for (const line of INI.trim().split('\n')) {
  const [name, list] = line.split('=');
  SCHEMES.push({ id: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, colors: list.split(',').map(css) });
}

const root = document.documentElement;
export function applyScheme(id) {
  const scheme = SCHEMES.find(s => s.id === id) || SCHEMES[0];
  ELEMENTS.forEach((v, i) => {
    if (!v) return;
    if (scheme.colors) root.style.setProperty(v, scheme.colors[i]);
    else root.style.removeProperty(v);
  });
  return scheme.id;
}

let saved = 'default';
try { saved = localStorage.getItem(KEY) || 'default'; } catch (err) { /* storage blocked */ }
saved = applyScheme(saved);

const select = document.getElementById('s-colorscheme');
for (const s of SCHEMES) select.add(new Option(s.name, s.id));
select.value = saved;
select.addEventListener('change', () => {
  const id = applyScheme(select.value);
  try { localStorage.setItem(KEY, id); } catch (err) { /* storage blocked */ }
});
