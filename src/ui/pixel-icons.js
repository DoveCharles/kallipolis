// ============================================================ pixel icons
// Windows 3.0's icons were bitmaps, so every icon here — drawn as SVG in index.html and by the JS that swaps them (the
// sound, favorite and map buttons) — is shown as a hand-drawn 16x15 bitmap from assets/icons/ in place of its drawing,
// one per icon and state (favorites-on, world-open…: which() below).
// Its pure black pixels are drawn in the text's colour, as a mask of that colour, so they follow it as the vector did
// (greyed when disabled, and so on); every other colour is its own, a bitmap under that. An icon whose button changes
// state is drawn again, in case it has another bitmap for it.
const NS = 'http://www.w3.org/2000/svg';
const W = 16, H = 15;
const icons = new Map(); // svg -> { layers: what's shown, name: its bitmap for icons that don't change with their button }
const bitmaps = new Map(); // name -> Promise of { current, own } data URLs (either null if there's nothing there)
let masks = 0;

// Options > Display > Colorful Icons: the coloured bitmap in place of the plain one (the plain one if it's missing)
const COLORFUL = { 'grid-toggle': 'grid-toggle-on', favorites: 'favorites-on', 'ped-view': 'ped-view-on', world: 'world-open',
  maps: 'maps-open', edit: 'edit-open', 'ped-builder': 'ped-builder-open', quests: 'quests-open', identify: 'identify-on',
  undo: 'undo-c', redo: 'redo-c', 'sound-on': 'sound-on-c', 'sound-off': 'sound-off-c',
  'projection-perspective': 'projection-perspective-c', 'projection-orthographic': 'projection-orthographic-c', 'status/gift': 'daily-gift-c' };
const TINTED = new Set(Object.values(COLORFUL));
let colorful = false;
const colored = name => colorful && COLORFUL[name] || name;
// an <img> icon (data-icon its plain name) shown as `name`
export function setImgIcon(img, name) {
  if (!img) return;
  img.dataset.icon = name;
  const shown = colored(name), plain = () => { img.src = `assets/icons/${name}.png`; };
  if (!TINTED.has(shown)) return plain();
  tinted(shown).then(url => { if (img.dataset.icon === name && colored(name) === shown) img.src = url; }, plain);
}
const redraw = () => {
  icons.forEach((icon, svg) => pixelate(svg));
  document.querySelectorAll('img[data-icon]').forEach(img => setImgIcon(img, img.dataset.icon));
};
export function setColorfulIcons(on) {
  colorful = on;
  redraw();
}

// Colourful bitmaps are evened out in OKLCH: every coloured pixel gets the same share of its hue's most chroma (the
// Icon saturation slider's), and each icon's colours are shifted together to the same mean lightness — TINT_L, lifted
// HUE_LIFT of the way to each hue's most colourful lightness (so yellow stays bright) — keeping hues and contrast.
const TINT_L = 0.65, HUE_LIFT = 0.7, TINT_C = 0.7;
const FLAT = new Set(['daily-gift-c', 'identify-on']); // each colour at its own target, to match one-colour icons (Ped View, Edit, Favorites)
let saturation = 1;
export function setIconSaturation(s) {
  if (s === saturation) return;
  saturation = s;
  for (const name of TINTED) { bitmaps.delete(name); tints.delete(name); }
  if (colorful) redraw();
}
const lin = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gam = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toLab(r, g, b) {
  [r, g, b] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const shows = (L, h, c) => fromLab(L, c * Math.cos(h), c * Math.sin(h)).every(v => v >= -1e-4 && v <= 1.0001);
// the most chroma the screen can show at lightness L, hue h
function maxChroma(L, h) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; if (shows(L, h, m)) lo = m; else hi = m; }
  return lo;
}
// hue h's target lightness: TINT_L lifted toward the lightness it's most colourful at
const targets = new Map();
function target(h) {
  const key = Math.round(h * 100);
  if (!targets.has(key)) {
    let most = 0, cusp = TINT_L;
    for (let L = 0.3; L <= 0.98; L += 0.01) { const c = maxChroma(L, h); if (c > most) { most = c; cusp = L; } }
    targets.set(key, TINT_L + HUE_LIFT * (cusp - TINT_L));
  }
  return targets.get(key);
}
// the colour at lightness L, hue h, at `share` of the most chroma it can have there
function lch(L, h, share) {
  const c = Math.min(1, share) * maxChroma(L, h);
  return fromLab(L, c * Math.cos(h), c * Math.sin(h)).map(v => Math.round(gam(Math.min(1, Math.max(0, v)))));
}
const tints = new Map(); // name -> Promise of its evened-out bitmap's data URL
function tinted(name) {
  if (!tints.has(name)) tints.set(name, (async () => {
    const img = new Image();
    img.src = `assets/icons/${name}.png`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height), d = all.data, coloured = [];
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const [L, a, b] = toLab(d[i], d[i + 1], d[i + 2]);
      if (Math.hypot(a, b) < 0.03) continue; // (black, white, greys: left be)
      const h = Math.atan2(b, a), t = target(h);
      coloured.push([i, L, h, t]); sum += t - L;
    }
    const shift = coloured.length ? sum / coloured.length : 0, flat = FLAT.has(name);
    for (const [i, L, h, t] of coloured)
      d.set(lch(flat ? t : Math.min(0.97, Math.max(0.2, L + shift)), h, TINT_C * saturation), i);
    ctx.putImageData(all, 0, 0);
    return canvas.toDataURL();
  })());
  return tints.get(name);
}

// which bitmap the icon shows, now
function which(svg, icon) {
  if (icon.name) return icon.name;
  const button = svg.closest('button, #grid-toggle');
  const on = button?.matches('.on, .active');
  switch (button?.id) {
    case 'grid-toggle': return on ? 'grid-toggle-on' : 'grid-toggle';
    case 'btn-favorites': return on ? 'favorites-on' : 'favorites';
    case 'btn-ped-view': return on ? 'ped-view-on' : 'ped-view';
  }
  return null;
}

// what an icon is, from its drawing, for those whose drawing is swapped rather than their button's state changing
function nameOf(svg) {
  const cls = svg.classList, markup = svg.innerHTML, button = svg.closest('button, #grid-toggle');
  const byClass = { 'world-open': 'world-open', 'world-shut': 'world', 'node-open': 'edit-open', 'node-shut': 'edit',
    'maps-open': 'maps-open', 'maps-shut': 'maps', 'proj-perspective': 'projection-perspective', 'proj-ortho': 'projection-orthographic' };
  for (const c in byClass) if (cls.contains(c)) return byClass[c];
  const byId = { 'btn-panel-toggle': 'panel-toggle', 'btn-undo': 'undo', 'btn-redo': 'redo', 'btn-touch-add': 'touch-add' };
  if (byId[button?.id]) return byId[button.id];
  if (button?.id === 'btn-sound') return markup.includes('m16 9') ? 'sound-off' : 'sound-on';
  if (button?.classList.contains('card-heart')) return svg.getAttribute('fill') === 'currentColor' ? 'card-heart-on' : 'card-heart';
  if (markup.includes('M1 8 C3 3.5')) return markup.includes('M2 14 L14 2') ? 'map-eye-hidden' : 'map-eye'; // (maps/map-images.js)
  return null;
}

// the bitmap split in two: its black pixels (to be drawn in the text's colour) and the rest
function load(name) {
  if (!bitmaps.has(name)) bitmaps.set(name, (async () => {
    const img = new Image();
    img.src = TINTED.has(name) ? await tinted(name) : `assets/icons/${name}.png`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const all = ctx.getImageData(0, 0, W, H), current = new ImageData(W, H), own = new ImageData(W, H);
    let anyCurrent = false, anyOwn = false;
    for (let i = 0; i < all.data.length; i += 4) {
      const [r, g, b, a] = all.data.subarray(i, i + 4);
      if (a < 128) continue; // (a stray half-rubbed-out pixel)
      const black = r === 0 && g === 0 && b === 0, to = black ? current : own;
      to.data.set([r, g, b, 255], i);
      if (black) anyCurrent = true; else anyOwn = true;
    }
    const url = (pixels, any) => { if (!any) return null; ctx.putImageData(pixels, 0, 0); return canvas.toDataURL(); };
    return { current: url(current, anyCurrent), own: url(own, anyOwn) };
  })());
  return bitmaps.get(name);
}

function prepare(svg) {
  if (icons.has(svg)) return icons.get(svg);
  const icon = { name: nameOf(svg), layers: null, drawn: 0 };
  icons.set(svg, icon);
  const button = svg.closest('button, #grid-toggle');
  if (button) states.observe(button, { attributes: true, attributeFilter: ['class', 'disabled'] });
  return icon;
}

async function pixelate(svg) {
  const icon = prepare(svg), plain = which(svg, icon);
  if (!plain) return; // (not one of ours: left as drawn)
  const name = colored(plain), drawing = ++icon.drawn;
  let bitmap;
  try { bitmap = await load(name); } catch (err) {
    try { bitmap = await load(plain); } catch (err) { console.warn(`pixel icon ${plain} didn't load`, err); return; }
  }
  if (drawing !== icon.drawn) return; // (drawn again since)
  const image = url => `<image href="${url}" width="${W}" height="${H}" style="image-rendering:pixelated"/>`;
  let layers = bitmap.own ? image(bitmap.own) : '';
  if (bitmap.current) {
    const id = `pixel-icon-${++masks}`;
    layers += `<mask id="${id}" style="mask-type:alpha">${image(bitmap.current)}</mask>`
      + `<rect width="${W}" height="${H}" fill="currentColor" stroke="none" mask="url(#${id})"/>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.add('pixel-icon');
  svg.innerHTML = layers;
}

// a button changing state may change its icon's bitmap
const states = new MutationObserver(records => records.forEach(r => r.target.querySelectorAll('svg').forEach(svg => {
  if (icons.has(svg)) pixelate(svg);
})));

function pixelateWithin(node) {
  if (node.nodeType !== 1) return;
  if (node.tagName === 'svg') { if (!icons.has(node)) pixelate(node); }
  else node.querySelectorAll('svg').forEach(svg => { if (!icons.has(svg)) pixelate(svg); });
}

pixelateWithin(document.body);
new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(pixelateWithin)))
  .observe(document.body, { childList: true, subtree: true });
