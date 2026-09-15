import * as THREE from 'three';
import { renderer } from '../core/scene.js';

// ============================================================ pixelation and the 16-colour palette
// Two filters on the 3D view, from World settings. Pixelation draws the view small — one pixel for every so many screen
// pixels across; the 16-colour palette redraws it in Windows 3.0's sixteen colours, dithering (a 4×4 Bayer pattern, a cell
// per drawn pixel) to fake the shades in between. With either on, the view is drawn into a render target of its own,
// without anti-aliasing (the canvas's can't be turned off once it's made, but a render target's is its own), and copied
// onto the screen by a shader that applies the palette — each drawn pixel exactly so many screen pixels square, with hard
// edges. So pixelating is cheaper to draw, not dearer, and the palette is one pass over the screen. Like the Windows 3.0
// look, both are the browser's preferences, kept in localStorage, not the project's.
const PIXELATION_KEY = 'splinetopia.pixelation', PALETTE_KEY = 'splinetopia.palette16';
const MAX_PIXEL_SIZE = 12;
const SHARP_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2); // (as scene.js sets it up)
// Windows 3.0's sixteen colours: the dark eight, then the light
const PALETTE_16 = [0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
                    0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff];
const slider = document.getElementById('s-pixelation'), label = document.getElementById('dv-pixelation');
const paletteToggle = document.getElementById('s-palette16');
let pixelSize = 1, palette16 = false;

// the view as it's drawn for the filters (with a stencil buffer, which the water's mask needs), and a screen-filling quad
// to copy it onto the screen with
const filteredView = new THREE.WebGLRenderTarget(1, 1, { samples: 0, depthBuffer: true, stencilBuffer: true,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
const copyMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tView: { value: filteredView.texture },
    viewSize: { value: new THREE.Vector2(1, 1) },
    usePalette: { value: 0 },
    palette: { value: PALETTE_16.map(hex => new THREE.Color(hex)) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tView;
    uniform vec2 viewSize;
    uniform float usePalette;
    uniform vec3 palette[16];
    varying vec2 vUv;
    const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    void main() {
      vec3 color = texture2D(tView, vUv).rgb;
      if (usePalette > 0.5) {
        // the nearest of the sixteen, then whichever other one the color lies furthest towards (how far along the line
        // between the two it lies), and the dither pattern deciding, pixel by pixel, which of the two to show
        vec3 nearest = palette[0];
        float nearestDistance = 1e9;
        for (int i = 0; i < 16; i++) {
          float d = distance(color, palette[i]);
          if (d < nearestDistance) { nearestDistance = d; nearest = palette[i]; }
        }
        vec3 other = nearest;
        float otherDistance = nearestDistance, along = 0.0;
        for (int i = 0; i < 16; i++) {
          vec3 span = palette[i] - nearest;
          float lengthSq = dot(span, span);
          if (lengthSq < 1e-6) continue;
          float k = clamp(dot(color - nearest, span)/lengthSq, 0.0, 1.0);
          float d = distance(color, nearest + span*k);
          if (d < otherDistance) { otherDistance = d; other = palette[i]; along = k; }
        }
        vec2 cell = mod(floor(vUv*viewSize), 4.0);
        float threshold = (BAYER[int(cell.y)*4 + int(cell.x)] + 0.5)/16.0;
        color = along > threshold ? other : nearest;
      }
      gl_FragColor = vec4(color, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});
const copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMaterial);
copyQuad.frustumCulled = false;
const copyScene = new THREE.Scene().add(copyQuad);
const screenSize = new THREE.Vector2();

function remember(key, value) { try { localStorage.setItem(key, value); } catch (err) { /* storage blocked: it just isn't remembered */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (err) { return null; } }
// `size`: how many screen pixels (CSS pixels) each drawn pixel covers across; 1 draws at full resolution
function setPixelation(size, save) {
  pixelSize = Math.max(1, Math.min(MAX_PIXEL_SIZE, Math.round(size) || 1));
  // pixelated, the canvas only needs a pixel per screen pixel — and on a high-density screen the browser scales it up
  // with hard edges too
  renderer.setPixelRatio(pixelSize > 1 ? 1 : SHARP_PIXEL_RATIO);
  renderer.domElement.classList.toggle('pixelated', pixelSize > 1);
  slider.value = pixelSize;
  label.textContent = pixelSize > 1 ? pixelSize + 'px' : 'off';
  if (save) remember(PIXELATION_KEY, String(pixelSize));
}
function setPalette(on, save) {
  palette16 = on;
  paletteToggle.classList.toggle('on', on);
  copyMaterial.uniforms.usePalette.value = on ? 1 : 0;
  if (save) remember(PALETTE_KEY, on ? '1' : '0');
}
setPixelation(Number(recall(PIXELATION_KEY)) || 1, false);
setPalette(recall(PALETTE_KEY) === '1', false);
slider.addEventListener('input', () => setPixelation(Number(slider.value), true));
paletteToggle.addEventListener('click', () => setPalette(!palette16, true));

// Draws the view to the screen — straight there, or through the filters.
export function renderView(scene, camera) {
  if (pixelSize <= 1 && !palette16) { renderer.render(scene, camera); return; }
  let width, height, coverX = 1, coverY = 1;
  if (pixelSize > 1) {
    // enough pixels to cover the screen, the last row and column running a little off it, pinned to its top left
    renderer.getSize(screenSize);
    width = Math.ceil(screenSize.x/pixelSize);
    height = Math.ceil(screenSize.y/pixelSize);
    coverX = width*pixelSize/screenSize.x;
    coverY = height*pixelSize/screenSize.y;
  } else {
    renderer.getDrawingBufferSize(screenSize);
    width = screenSize.x;
    height = screenSize.y;
  }
  if (filteredView.width !== width || filteredView.height !== height) filteredView.setSize(width, height);
  copyMaterial.uniforms.viewSize.value.set(width, height);
  copyQuad.scale.set(coverX, coverY, 1);
  copyQuad.position.set(coverX - 1, 1 - coverY, 0);
  renderer.setRenderTarget(filteredView);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(copyScene, copyCamera);
}
