import * as THREE from 'three';
import { renderer } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';

// ============================================================ pixelation and the 16-colour palette
// Filters on the 3D view, from World settings. Pixelation draws the view small — one pixel for every so many screen pixels
// across; the 16-colour palette redraws it in sixteen colours or fewer (Windows 3.0's or another set, from the Palette menu),
// dithering (in a pattern picked from the Dithering menu, or by Floyd–Steinberg error diffusion) to fake the shades in between. With either on, the view is drawn into a render target of its own,
// without anti-aliasing (the canvas's can't be turned off once it's made, but a render target's is its own), and copied
// onto the screen by a shader that applies the palette — each drawn pixel exactly so many screen pixels square, with hard
// edges. So pixelating is cheaper to draw, not dearer, and the palette is one pass over the screen. Like the Windows 3.0
// look, these are the browser's preferences, kept in localStorage, not the project's.
const PIXELATION_KEY = 'splinetopia.pixelation', PALETTE_KEY = 'splinetopia.palette16', PALETTE_COLORS_KEY = 'splinetopia.paletteColors';
const DITHER_KEY = 'splinetopia.dither';
const MAX_PIXEL_SIZE = 12;
const SHARP_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2); // (as scene.js sets it up)
// the sets of colours, in the Palette menu's order — sixteen, or fewer (repeated round to fill the shader's sixteen)
const PALETTES = [
  // Windows 3.0's: the dark eight, then the light
  { id: 'win3', name: 'Windows 3.0', colors: [0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
                                             0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff] },
  // the PICO-8 fantasy console's
  { id: 'pico8', name: 'PICO-8', colors: [0x000000, 0x1d2b53, 0x7e2553, 0x008751, 0xab5236, 0x5f574f, 0xc2c3c7, 0xfff1e8,
                                         0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xffccaa] },
  // IBM's CGA and EGA: the DOS sixteen, with the brown in place of dark yellow
  { id: 'cga', name: 'CGA / EGA', colors: [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
                                          0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff] },
  // the Commodore 64's (as Pepto measured them)
  { id: 'c64', name: 'Commodore 64', colors: [0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f,
                                             0x6f4f25, 0x433900, 0x9a6759, 0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595] },
  // the ZX Spectrum's: each colour normal and bright (black only the once)
  { id: 'zx', name: 'ZX Spectrum', colors: [0x000000, 0x0000d7, 0xd70000, 0xd700d7, 0x00d700, 0x00d7d7, 0xd7d700, 0xd7d7d7,
                                           0x0000ff, 0xff0000, 0xff00ff, 0x00ff00, 0x00ffff, 0xffff00, 0xffffff] },
  // the Apple II's low-resolution colours (its two greys are the same)
  { id: 'apple2', name: 'Apple II', colors: [0x000000, 0x901740, 0x402ca5, 0xd043e5, 0x006940, 0x808080, 0x2f95e5, 0xbfabff,
                                            0x405400, 0xd06a1a, 0xff96bf, 0x2fbc1a, 0xbfd35a, 0x6fe8bf, 0xffffff] },
  // the Macintosh II's sixteen system colours
  { id: 'mac', name: 'Mac OS', colors: [0xffffff, 0xfbf305, 0xff6403, 0xdd0907, 0xf20884, 0x4700a5, 0x0000d3, 0x02abea,
                                       0x1fb714, 0x006412, 0x562c05, 0x90713a, 0xc0c0c0, 0x808080, 0x404040, 0x000000] },
  // pixel artists' palettes: Sweetie 16 (by GrafxKid, TIC-80's), DawnBringer's 16 and Endesga 16
  { id: 'sweetie16', name: 'Sweetie 16', colors: [0x1a1c2c, 0x5d275d, 0xb13e53, 0xef7d57, 0xffcd75, 0xa7f070, 0x38b764, 0x257179,
                                                 0x29366f, 0x3b5dc9, 0x41a6f6, 0x73eff7, 0xf4f4f4, 0x94b0c2, 0x566c86, 0x333c57] },
  { id: 'db16', name: 'DawnBringer 16', colors: [0x140c1c, 0x442434, 0x30346d, 0x4e4a4e, 0x854c30, 0x346524, 0xd04648, 0x757161,
                                                0x597dce, 0xd27d2c, 0x8595a1, 0x6daa2c, 0xd2aa99, 0x6dc2ca, 0xdad45e, 0xdeeed6] },
  { id: 'endesga16', name: 'Endesga 16', colors: [0xe4a672, 0xb86f50, 0x743f39, 0x3f2832, 0x9e2835, 0xe53b44, 0xfb922b, 0xffe762,
                                                 0x63c64d, 0x327345, 0x193d3f, 0x4f6781, 0xafbfd2, 0xffffff, 0x2ce8f4, 0x0484d1] },
  // the original Game Boy's four greens, and plain black and white
  { id: 'gameboy', name: 'Game Boy', colors: [0x0f380f, 0x306230, 0x8bac0f, 0x9bbc0f] },
  { id: '1bit', name: '1-bit', colors: [0x000000, 0xffffff] },
];
const DEFAULT_PALETTE = 'win3';
// the dithering patterns, in the menu's order — each one's place in the list is its ditherMode in the shader
const DITHER_PATTERNS = [
  { id: 'none', name: 'None' },
  { id: 'bayer2', name: 'Ordered 2×2' },
  { id: 'bayer4', name: 'Ordered 4×4' },
  { id: 'bayer8', name: 'Ordered 8×8' },
  { id: 'blue', name: 'Blue noise' },
  { id: 'random', name: 'Random' },
  { id: 'halftone', name: 'Halftone dots' },
  { id: 'lines', name: 'Lines' },
  { id: 'floyd', name: 'Floyd-Steinberg (SLOW)' },
];
const DEFAULT_DITHER = 'bayer4';
const BLUE_NOISE_SIZE = 64;
const slider = document.getElementById('s-pixelation'), label = document.getElementById('dv-pixelation');
const paletteToggle = document.getElementById('s-palette16');
const paletteRow = document.getElementById('palette-row'), paletteMenu = document.getElementById('s-palette');
const ditherRow = document.getElementById('dither-row'), ditherMenu = document.getElementById('s-dither');
let pixelSize = 1, palette16 = false;

// A tile of blue noise — every cell a different threshold, spread as evenly as can be, so a dither through it has no
// clumps and no visible grid — by void-and-cluster: from a scattering of points evened out (the most crowded point moved to
// the emptiest spot until it's already there), the most crowded points are taken away in turn, ranked downwards, and then
// the emptiest spots filled in turn, ranked upwards. "Crowded" is how much of a Gaussian blur of the points lands on a cell,
// wrapping around the tile's edges so it tiles seamlessly. Made the first time it's needed.
let blueNoiseTexture = null;
function makeBlueNoise(size) {
  const n = size*size, rng = mulberry32(20240915), sigma = 1.5;
  const kernel = new Float32Array(n);
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const dx = Math.min(x, size - x), dy = Math.min(y, size - y);
    kernel[y*size + x] = Math.exp(-(dx*dx + dy*dy)/(2*sigma*sigma));
  }
  const energy = new Float32Array(n), points = new Uint8Array(n);
  const splat = (i, sign) => {
    const ix = i % size, iy = (i/size) | 0;
    for (let y=0;y<size;y++) {
      const row = ((y - iy + size) % size)*size, out = y*size;
      for (let x=0;x<size;x++) energy[out + x] += sign*kernel[row + (x - ix + size) % size];
    }
  };
  const mostCrowdedPoint = () => { let best = -1, e = -Infinity; for (let i=0;i<n;i++) if (points[i] && energy[i] > e) { e = energy[i]; best = i; } return best; };
  const emptiestSpot = () => { let best = -1, e = Infinity; for (let i=0;i<n;i++) if (!points[i] && energy[i] < e) { e = energy[i]; best = i; } return best; };
  const initialCount = Math.floor(n*0.1);
  for (let placed = 0; placed < initialCount;) { const i = Math.floor(rng()*n); if (!points[i]) { points[i] = 1; splat(i, 1); placed++; } }
  for (let guard = 0; guard < n; guard++) {
    const crowded = mostCrowdedPoint();
    points[crowded] = 0; splat(crowded, -1);
    const empty = emptiestSpot();
    points[empty] = 1; splat(empty, 1);
    if (empty === crowded) break;
  }
  const ranks = new Uint32Array(n), initialPoints = points.slice(), initialEnergy = energy.slice();
  for (let rank = initialCount - 1; rank >= 0; rank--) { const i = mostCrowdedPoint(); points[i] = 0; splat(i, -1); ranks[i] = rank; }
  points.set(initialPoints); energy.set(initialEnergy);
  // (past halfway the points are the crowd and the gaps the scattering, but the emptiest spot among the gaps is still the
  // right one to fill next)
  for (let rank = initialCount; rank < n; rank++) { const i = emptiestSpot(); points[i] = 1; splat(i, 1); ranks[i] = rank; }
  const texture = new THREE.DataTexture(Uint8Array.from(ranks, rank => Math.floor(rank*256/n)), size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

// the view as it's drawn for the filters (with a stencil buffer, which the water's mask needs), and a screen-filling quad
// to copy it onto the screen with
const filteredView = new THREE.WebGLRenderTarget(1, 1, { samples: 0, depthBuffer: true, stencilBuffer: true,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
const placeholderNoise = new THREE.DataTexture(new Uint8Array([128]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
placeholderNoise.needsUpdate = true;
const copyMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tView: { value: filteredView.texture },
    viewSize: { value: new THREE.Vector2(1, 1) },
    usePalette: { value: 0 },
    palette: { value: PALETTES[0].colors.map(hex => new THREE.Color(hex)) },
    ditherMode: { value: DITHER_PATTERNS.findIndex(p => p.id === DEFAULT_DITHER) },
    blueNoise: { value: placeholderNoise },
    floydIndices: { value: placeholderNoise },
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
    uniform int ditherMode;
    uniform sampler2D blueNoise;
    uniform sampler2D floydIndices;
    varying vec2 vUv;
    // the Bayer matrix of 2^bits cells across, built up a bit at a time: each level's 2×2 [0 2; 3 1] set inside the next
    float bayer(ivec2 p, int bits) {
      int value = 0;
      for (int b = 0; b < 3; b++) {
        if (b >= bits) break;
        int xb = (p.x >> b) & 1, yb = (p.y >> b) & 1;
        value += (2*(xb ^ yb) + yb) << (2*(bits - 1 - b));
      }
      return (float(value) + 0.5)/float(1 << (2*bits));
    }
    // how far a color has to lie towards the second of its two palette colors, at this drawn pixel, to show that one
    float ditherThreshold(vec2 cell) {
      ivec2 p = ivec2(cell);
      float threshold = 0.5;
      if (ditherMode == 1) threshold = bayer(p, 1);
      else if (ditherMode == 2) threshold = bayer(p, 2);
      else if (ditherMode == 3) threshold = bayer(p, 3);
      else if (ditherMode == 4) threshold = (texelFetch(blueNoise, p % textureSize(blueNoise, 0), 0).r*255.0 + 0.5)/256.0;
      else if (ditherMode == 5) {
        uint h = uint(p.x)*1973u + uint(p.y)*9277u + 89173u;
        h = (h ^ (h >> 15u))*0x2c1b3c6du;
        h = (h ^ (h >> 12u))*0x297a2d39u;
        h ^= h >> 15u;
        threshold = (float(h & 0xffffu) + 0.5)/65536.0;
      } else if (ditherMode == 6) {
        // dots on a grid turned 45°, six drawn pixels apart, growing from their middles
        vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071)*(cell + 0.5)/6.0;
        vec2 local = fract(q) - 0.5;
        threshold = min(1.0, 3.14159*dot(local, local));
      } else if (ditherMode == 7) threshold = (mod(cell.y, 4.0) + 0.5)/4.0;
      return threshold;
    }
    void main() {
      vec3 color = texture2D(tView, vUv).rgb;
      if (usePalette > 0.5 && ditherMode == 8) {
        // (Floyd–Steinberg: already worked out, pixel by pixel — see floydSteinberg below)
        color = palette[int(texelFetch(floydIndices, ivec2(floor(vUv*viewSize)), 0).r*255.0 + 0.5)];
      } else if (usePalette > 0.5) {
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
        color = along > ditherThreshold(floor(vUv*viewSize)) ? other : nearest;
      }
      gl_FragColor = vec4(color, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});
// Floyd–Steinberg dithering: each pixel's color depends on the error carried over from the ones before it, so the shader
// can't pick them one at a time like the patterns above — instead the view is read back each frame and dithered here, a
// row at a time (every other row right to left, which keeps the error from streaking one way), and the shader just shows
// the palette color picked for each pixel. The error is worked out against the same colors, in the same space, as the
// shader's palette, so a pixel comes out the color it would with no dithering at all where it's already a palette color.
// It costs a read back of the whole view every frame, so it's slow unpixelated on a big screen.
const FLOYD_STEINBERG = DITHER_PATTERNS.findIndex(p => p.id === 'floyd');
const floydPalette = new Float32Array(48);
let floydPixels = null, floydIndices = null, floydTexture = null, floydError = null, floydNextError = null;
function floydSteinberg(width, height) {
  if (!floydTexture || floydTexture.image.width !== width || floydTexture.image.height !== height) {
    if (floydTexture) floydTexture.dispose();
    floydPixels = new Uint8Array(width*height*4);
    floydIndices = new Uint8Array(width*height);
    floydTexture = new THREE.DataTexture(floydIndices, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    floydTexture.magFilter = floydTexture.minFilter = THREE.NearestFilter;
    // (the error carried to each pixel of this row and the next, with a spare pixel's worth either end)
    floydError = new Float32Array((width + 2)*3);
    floydNextError = new Float32Array((width + 2)*3);
    copyMaterial.uniforms.floydIndices.value = floydTexture;
  }
  renderer.readRenderTargetPixels(filteredView, 0, 0, width, height, floydPixels);
  copyMaterial.uniforms.palette.value.forEach((color, i) => { floydPalette[i*3] = color.r; floydPalette[i*3+1] = color.g; floydPalette[i*3+2] = color.b; });
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  floydError.fill(0);
  for (let y = 0; y < height; y++) {
    floydNextError.fill(0);
    const step = y & 1 ? -1 : 1;
    for (let n = 0; n < width; n++) {
      const x = step > 0 ? n : width - 1 - n, i = y*width + x, e = (x + 1)*3;
      const r = clamp01(floydPixels[i*4]/255 + floydError[e]);
      const g = clamp01(floydPixels[i*4+1]/255 + floydError[e+1]);
      const b = clamp01(floydPixels[i*4+2]/255 + floydError[e+2]);
      let best = 0, bestDistance = Infinity;
      for (let k = 0; k < 48; k += 3) {
        const dr = r - floydPalette[k], dg = g - floydPalette[k+1], db = b - floydPalette[k+2], d = dr*dr + dg*dg + db*db;
        if (d < bestDistance) { bestDistance = d; best = k; }
      }
      floydIndices[i] = best/3;
      // the error spread on: 7/16 to the next pixel along the row, and 3/16, 5/16 and 1/16 to the ones below it — behind,
      // straight below and ahead
      const ahead = e + step*3, behind = e - step*3;
      for (let c = 0; c < 3; c++) {
        const error = (c === 0 ? r : c === 1 ? g : b) - floydPalette[best + c];
        floydError[ahead + c] += error*7/16;
        floydNextError[behind + c] += error*3/16;
        floydNextError[e + c] += error*5/16;
        floydNextError[ahead + c] += error/16;
      }
    }
    [floydError, floydNextError] = [floydNextError, floydError];
  }
  floydTexture.needsUpdate = true;
}

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
  paletteRow.style.display = on ? '' : 'none';
  ditherRow.style.display = on ? '' : 'none';
  copyMaterial.uniforms.usePalette.value = on ? 1 : 0;
  if (save) remember(PALETTE_KEY, on ? '1' : '0');
}
// which set of colours the palette draws in (a colour repeated is only ever picked once, so a short set just repeats)
function setPaletteColors(id, save) {
  const palette = PALETTES.find(p => p.id === id) || PALETTES[0];
  copyMaterial.uniforms.palette.value.forEach((color, i) => color.setHex(palette.colors[i % palette.colors.length]));
  paletteMenu.value = palette.id;
  if (save) remember(PALETTE_COLORS_KEY, palette.id);
}
function setDither(id, save) {
  const index = Math.max(0, DITHER_PATTERNS.findIndex(p => p.id === id));
  if (DITHER_PATTERNS[index].id === 'blue' && !blueNoiseTexture) {
    blueNoiseTexture = makeBlueNoise(BLUE_NOISE_SIZE);
    copyMaterial.uniforms.blueNoise.value = blueNoiseTexture;
  }
  copyMaterial.uniforms.ditherMode.value = index;
  ditherMenu.value = DITHER_PATTERNS[index].id;
  if (save) remember(DITHER_KEY, DITHER_PATTERNS[index].id);
}
PALETTES.forEach(palette => paletteMenu.add(new Option(palette.name, palette.id)));
DITHER_PATTERNS.forEach(pattern => ditherMenu.add(new Option(pattern.name, pattern.id)));
setPixelation(Number(recall(PIXELATION_KEY)) || 1, false);
setPalette(recall(PALETTE_KEY) === '1', false);
setPaletteColors(recall(PALETTE_COLORS_KEY) || DEFAULT_PALETTE, false);
setDither(recall(DITHER_KEY) || DEFAULT_DITHER, false);
slider.addEventListener('input', () => setPixelation(Number(slider.value), true));
paletteToggle.addEventListener('click', () => setPalette(!palette16, true));
paletteMenu.addEventListener('change', () => setPaletteColors(paletteMenu.value, true));
ditherMenu.addEventListener('change', () => setDither(ditherMenu.value, true));

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
  if (palette16 && copyMaterial.uniforms.ditherMode.value === FLOYD_STEINBERG) floydSteinberg(width, height);
  renderer.render(copyScene, copyCamera);
}
