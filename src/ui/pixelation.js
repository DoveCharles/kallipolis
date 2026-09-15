import * as THREE from 'three';
import { renderer } from '../core/scene.js';

// ============================================================ pixelation
// A slider in World settings pixelates the 3D view. The view is drawn small — one pixel for every so many screen pixels
// across — into a render target of its own, without anti-aliasing (the canvas's anti-aliasing can't be turned off once
// it's made, but a render target's is its own), and then copied up onto the screen with hard edges, each drawn pixel
// exactly that many screen pixels square. So it's cheaper to draw, not dearer. Like the Windows 3.0 look it's the
// browser's preference, kept in localStorage, not the project's.
const STORAGE_KEY = 'splinetopia.pixelation';
const MAX_PIXEL_SIZE = 12;
const SHARP_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2); // (as scene.js sets it up)
const slider = document.getElementById('s-pixelation'), label = document.getElementById('dv-pixelation');
let pixelSize = 1;

// the small view (with a stencil buffer, which the water's mask needs), and a screen-filling quad to copy it up with
const smallView = new THREE.WebGLRenderTarget(1, 1, { samples: 0, depthBuffer: true, stencilBuffer: true,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
const copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ map: smallView.texture, depthTest: false, depthWrite: false, toneMapped: false }));
copyQuad.frustumCulled = false;
const copyScene = new THREE.Scene().add(copyQuad);

// `size`: how many screen pixels (CSS pixels) each drawn pixel covers across; 1 draws at full resolution, anti-aliased
function setPixelation(size, remember) {
  pixelSize = Math.max(1, Math.min(MAX_PIXEL_SIZE, Math.round(size) || 1));
  // pixelated, the canvas only needs a pixel per screen pixel — and on a high-density screen the browser scales it up
  // with hard edges too
  renderer.setPixelRatio(pixelSize > 1 ? 1 : SHARP_PIXEL_RATIO);
  renderer.domElement.classList.toggle('pixelated', pixelSize > 1);
  slider.value = pixelSize;
  label.textContent = pixelSize > 1 ? pixelSize + 'px' : 'off';
  if (remember) { try { localStorage.setItem(STORAGE_KEY, String(pixelSize)); } catch (err) { /* storage blocked: it just isn't remembered */ } }
}
let stored = 1;
try { stored = Number(localStorage.getItem(STORAGE_KEY)) || 1; } catch (err) { /* as above */ }
setPixelation(stored, false);
slider.addEventListener('input', () => setPixelation(Number(slider.value), true));

// Draws the view to the screen — straight there, or pixelated.
export function renderView(scene, camera) {
  if (pixelSize <= 1) { renderer.render(scene, camera); return; }
  const screen = renderer.getSize(new THREE.Vector2());
  // enough pixels to cover the screen, the last row and column running a little off it, pinned to its top left
  const width = Math.ceil(screen.x/pixelSize), height = Math.ceil(screen.y/pixelSize);
  if (smallView.width !== width || smallView.height !== height) smallView.setSize(width, height);
  const coverX = width*pixelSize/screen.x, coverY = height*pixelSize/screen.y;
  copyQuad.scale.set(coverX, coverY, 1);
  copyQuad.position.set(coverX - 1, 1 - coverY, 0);
  renderer.setRenderTarget(smallView);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(copyScene, copyCamera);
}
