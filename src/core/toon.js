import * as THREE from 'three';

// The light ramp toon-shaded materials read (MeshToonMaterial's gradientMap: people, their hair and clothes, and bees).
// Sunlight falls in three bands: shade, lit, and a thin highlight on the faces turned nearly straight at the sun (ambient
// light still adds on top of all three). The shade band takes the sky's color (setToonSky, from updateSun in scene.js),
// so a figure's dark side matches the light around it. The ramp is read at dot(normal, sun)*0.5 + 0.5, so of its 16
// texels the first 8 are the side facing away, and the highlight starts at TOON_HIGHLIGHT.
// Turned off (Display > Toon characters, see ui/toon-shading.js), the same ramp just holds the plain falloff,
// max(dot, 0), smoothly filtered, so switching never recompiles a shader.
const TOON_SHADE = 0.35, TOON_LIT = 0.75, TOON_HIGHLIGHT = 0.75;
export const TOON_RAMP = new THREE.DataTexture(new Uint8Array(16*4), 16, 1);
TOON_RAMP.generateMipmaps = false;
let toon = true;
const sky = new THREE.Color(1, 1, 1);

function fillRamp() {
  const data = TOON_RAMP.image.data;
  for (let i = 0; i < 16; i++) {
    const dotNL = (i + 0.5)/8 - 1;
    const level = !toon ? Math.max(0, dotNL) : dotNL < 0 ? TOON_SHADE : dotNL < TOON_HIGHLIGHT ? TOON_LIT : 1;
    const tint = toon && dotNL < 0 ? sky : null;
    for (let c = 0; c < 3; c++) data[i*4 + c] = Math.round(255*Math.min(1, level*(tint ? [tint.r, tint.g, tint.b][c] : 1)));
    data[i*4 + 3] = 255;
  }
  TOON_RAMP.minFilter = TOON_RAMP.magFilter = toon ? THREE.NearestFilter : THREE.LinearFilter;
  TOON_RAMP.needsUpdate = true;
}

/**
 * Draw toon-shaded materials in bands, or smoothly lit.
 * @param {boolean} on - whether in bands
 */
export function setToon(on) { toon = on; fillRamp(); }

/**
 * Tint the shade band with the sky's color — only its hue: it's scaled so its brightest channel is 1.
 * @param {THREE.Color} color - the sky's light (the hemisphere light's color)
 */
export function setToonSky(color) {
  const max = Math.max(color.r, color.g, color.b, 1e-3);
  const next = color.clone().multiplyScalar(1/max);
  if (next.equals(sky)) return;
  sky.copy(next);
  fillRamp();
}

fillRamp();
