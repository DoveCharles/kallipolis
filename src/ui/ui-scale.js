// ============================================================ UI scale
// Display > UI scale: everything but the 3D view drawn bigger, by CSS zoom on the page, undone on #canvas-wrap so the
// view (and all that maps the mouse into it by innerWidth/innerHeight) stays one to one. Under zoom, a length set in
// px is drawn that many times bigger, so what places UI by the mouse or by getBoundingClientRect (both in the screen's
// px) divides by uiScale() first (toUi), and the CSS's vh/vw, zoomed as well, divide by --ui-scale.
// Taken on letting go of the slider, not while dragging it, as the slider itself grows under the mouse.
// A browser preference in localStorage, like pixelation.
const KEY = 'splinetopia.uiScale';
const slider = document.getElementById('s-uiscale');
const label = document.getElementById('dv-uiscale');
let scale = 1;

/** @returns {number} how much bigger the UI is drawn (1 = as designed) */
export function uiScale() { return scale; }

/**
 * A length in the screen's px (a mouse position, a getBoundingClientRect) as the px to set on an element of the UI.
 * @param {number} px
 * @returns {number}
 */
export function toUi(px) { return px / scale; }

const percent = s => Math.round(s * 100) + '%';
function setScale(s, save) {
  scale = s;
  document.documentElement.style.zoom = s === 1 ? '' : s;
  document.documentElement.style.setProperty('--ui-scale', s);
  document.getElementById('canvas-wrap').style.zoom = s === 1 ? '' : 1 / s;
  slider.value = s * 100;
  label.textContent = percent(s);
  if (save) try { localStorage.setItem(KEY, String(s)); } catch (err) { /* storage blocked */ }
}

slider.addEventListener('input', () => { label.textContent = percent(slider.value / 100); });
slider.addEventListener('change', () => setScale(slider.value / 100, true));
let saved = null;
try { saved = parseFloat(localStorage.getItem(KEY)); } catch (err) { /* storage blocked */ }
setScale(saved >= 1 && saved <= 2 ? saved : 1, false);
