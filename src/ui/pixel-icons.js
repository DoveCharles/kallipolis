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
    img.src = `assets/icons/${name}.png`;
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
  const icon = prepare(svg), name = which(svg, icon);
  if (!name) return; // (not one of ours: left as drawn)
  const drawing = ++icon.drawn;
  let bitmap;
  try { bitmap = await load(name); } catch (err) { console.warn(`pixel icon ${name} didn't load`, err); return; }
  if (drawing !== icon.drawn) return; // (drawn again since)
  const image = url => `<image href="${url}" width="${W}" height="${H}" style="image-rendering:pixelated"/>`;
  let layers = bitmap.own ? image(bitmap.own) : '';
  if (bitmap.current) {
    const id = `pixel-icon-${++masks}`;
    layers += `<mask id="${id}" style="mask-type:alpha">${image(bitmap.current)}</mask>`
      + `<rect width="${W}" height="${H}" fill="currentColor" stroke="none" mask="url(#${id})"/>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
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
