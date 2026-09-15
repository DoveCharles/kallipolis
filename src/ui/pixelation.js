import { renderer } from '../core/scene.js';

// ============================================================ pixelation
// A slider in World settings pixelates the 3D view: the scene is drawn at a fraction of the screen's resolution — one drawn
// pixel for every so many screen pixels across — and the canvas is scaled back up with hard edges (canvas.pixelated in
// style.css), so it's cheaper to draw, not dearer. Like the Windows 3.0 look it's the browser's preference, kept in
// localStorage, not the project's.
const STORAGE_KEY = 'splinetopia.pixelation';
const MAX_PIXEL_SIZE = 12;
const SHARP_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2); // (as scene.js sets it up)
const slider = document.getElementById('s-pixelation'), label = document.getElementById('dv-pixelation');
// `size`: how many screen pixels (CSS pixels) each drawn pixel covers across; 1 draws at full resolution
function setPixelation(size, remember) {
  size = Math.max(1, Math.min(MAX_PIXEL_SIZE, Math.round(size) || 1));
  renderer.setPixelRatio(size > 1 ? 1/size : SHARP_PIXEL_RATIO);
  renderer.domElement.classList.toggle('pixelated', size > 1);
  slider.value = size;
  label.textContent = size > 1 ? size + 'px' : 'off';
  if (remember) { try { localStorage.setItem(STORAGE_KEY, String(size)); } catch (err) { /* storage blocked: it just isn't remembered */ } }
}
let stored = 1;
try { stored = Number(localStorage.getItem(STORAGE_KEY)) || 1; } catch (err) { /* as above */ }
setPixelation(stored, false);
slider.addEventListener('input', () => setPixelation(Number(slider.value), true));
