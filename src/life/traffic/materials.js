import * as THREE from 'three';
import { scene, renderer, SKY_ENV_MAP } from '../../core/scene.js';
import { hashLicensePlate, hashNameToNumber, mulberry32 } from '../../core/math.js';
import { carTypeOf, vanityChanceOf, vanityPlatesOf } from '../car-types.js';
import { BOX_CAR_LENGTH, CAR_GLOW_MATERIALS, CAR_SLOT_NAMES, carMeshes } from './models.js';
import { TERRIBLE_RUST } from './special.js';
import { TRAFFIC_MAX } from './state.js';

// Number plates and the car shader (plates, legendary sheen, rust), and the instanced mesh each design draws with.

// ============================================================ NUMBER PLATES ============================================================
// a car's registration (carPlate) is drawn by the car shader itself (injectCarShader) from one shared
// atlas of plate characters, so it adds no draw calls. instanceCarPlate carries each car's characters — six bits each,
// three to a float — with length*4 + format (0 UK, 1 EU, 2 US) in the fourth float.
const PLATE_GLYPHS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'; // (glyph index 0, the space, is drawn blank)
const PLATE_MAX_CHARS = 9, PLATE_ATLAS_COLUMNS = 8, PLATE_ATLAS_ROWS = 5, PLATE_CELL_W = 48, PLATE_CELL_H = 96;
const plateAtlas = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = PLATE_ATLAS_COLUMNS*PLATE_CELL_W;
  canvas.height = PLATE_ATLAS_ROWS*PLATE_CELL_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  // each capital is drawn at most of the cell's height, thickened by a stroke round it, then scaled on X to the width a
  // typical character needs (wider ones such as M and W get their own fit), leaving a sliver either side of the cell
  const font = size => `900 ${size}px "Arial Black", "Arial Narrow", Arial, sans-serif`;
  ctx.font = font(100);
  const capHeight = ctx.measureText('W').actualBoundingBoxAscent/100, stroke = PLATE_CELL_H*0.06;
  ctx.font = font((PLATE_CELL_H*0.86 - stroke)/capHeight);
  ctx.lineWidth = stroke;
  const fit = ch => (PLATE_CELL_W*0.96 - stroke)/ctx.measureText(ch).width, typical = fit('0');
  const baseline = PLATE_CELL_H*0.5 + ctx.measureText('W').actualBoundingBoxAscent*0.5;
  [...PLATE_GLYPHS].forEach((ch, g) => {
    ctx.save();
    ctx.translate((g % PLATE_ATLAS_COLUMNS + 0.5)*PLATE_CELL_W, Math.floor(g/PLATE_ATLAS_COLUMNS)*PLATE_CELL_H + baseline);
    ctx.scale(Math.min(typical, fit(ch)), 1);
    ctx.fillText(ch, 0, 0);
    ctx.strokeText(ch, 0, 0);
    ctx.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
})();
/**
 * Pack a registration into the floats the plate shader reads: six bits per character, three characters to a float, and in
 * the fourth float length*4 + format (0 UK, 1 EU, 2 US, worked out from the text's shape).
 * @param {string} text
 * @returns {number[]} four floats
 */
function packPlate(text) {
  const format = text.includes('-') ? 1 : text[3] === ' ' ? 2 : 0; // (AB-123-CD is EU, ABC 1234 US, AB12 CDE UK)
  const length = Math.min(PLATE_MAX_CHARS, text.length), packed = [0, 0, 0, length*4 + format];
  for (let k=0;k<length;k++) packed[Math.floor(k/3)] += Math.max(0, PLATE_GLYPHS.indexOf(text[k]))*64**(k % 3);
  return packed;
}
/** Vehicle types that always get a UK-format plate. */
const UK_ONLY_TYPES = ['bus', 'ambulance', 'police car', 'taxi'];
/**
 * A car's registration, from its type's name and its number within that type, packed for its plates (packPlate).
 * It takes a vanity plate, at the chance and from the list assets/cars.txt gives its type; otherwise it comes from
 * hashLicensePlate, UK-formatted for UK_ONLY_TYPES.
 * @param {object} car
 * @returns {{ text: string, packed: number[] }}
 */
export function carPlate(car) {
  const carRNG = mulberry32(hashNameToNumber(carMeshes[car.design].name+ car.number));
  const type = carTypeOf(carMeshes[car.design].name, car.number), name = (type.name || '').trim().toLowerCase();
  const vanity = vanityPlatesOf(carMeshes[car.design].name); // (from the `plate` lines in assets/cars.txt)
  // a legendary car's registration stands out too: each legendary love/hate doubles the chance of a vanity plate,
  // capped at 100% — the same tally refreshCarTraits does for legendaryCount, but car.legendaryCount isn't set yet
  // this early (carPlate runs before refreshCarTraits, see the spawn loop), so it's read straight off type here.
  const legendaryCount = [...(type.lovesTier || []), ...(type.hatesTier || [])].filter(tier => tier === 'legendary').length;
  const vanityChance = Math.min(1, vanityChanceOf(carMeshes[car.design].name)*Math.pow(2, legendaryCount));
  const text = (carRNG() < vanityChance && vanity.length) ? vanity[Math.round(carRNG()*(vanity.length-1))].toUpperCase() :
  hashLicensePlate(`${type.name} #${car.number}`, UK_ONLY_TYPES.includes(name) ? 0 : undefined);
  return { text, packed: packPlate(text) };
}
/**
 * Adding a car design's coloring to its material's shader.
 *
 * vCarColor is per vertex: its instance's paint (instanceCarPaint) for a CarCol vertex, otherwise its own baked carColor.
 * vCarEmissive is for the lit slots, added to what the material emits and scaled by carGlowFactor. Wheels (carWheel) turn
 * about their hubs — rolled by instanceCarWheel.x, and where carWheel.w is 2 steered by instanceCarWheel.y, for position
 * and normal both (see turnWheels). Everything else, the body, sits on its springs: pitched by instanceCarWheel.z (nose
 * up) about the rear axle and rolled by instanceCarWheel.w about the middle at the axle's height (see swayBody). Plates shade a Plate vertex by the character cell vCarPlateUv.xy falls in, that
 * character's glyph from instanceCarPlate, and its shape from the atlas, sampled with the gradients of the whole plate
 * rather than the per-cell ones, and faded to blank as the characters shrink below a readable size.
 * @param {object} shader - the material's shader, patched in place
 * @param {object} glowUniform - the shared carGlowFactor uniform
 * @param {?object} paintUniform - set to draw one car un-instanced, for a card thumbnail (makeCarThumbnail): paint and
 *   plates arrive as uniforms set before each draw, and the wheels sit still. Null for the instanced crowd.
 * @param {?object} plateUniform - the per-instance plate glyph uniform, or null as with paintUniform
 * @param {boolean} isGlass - true for the glass material, which never wears the holo sheen (see applyCarHolo)
 * @param {number} halfLength - half the design's own local-space length (design.length*BOX_CAR_LENGTH/2), so the foil
 *   sheen's ring can sit a fixed real distance behind this design specifically (carFoilCentreZ, see applyCarFoilField)
 * @param {number[]} rearAxle - the design's rear axle (z, y), the body's pivot on its springs (design.rearAxle)
 * @returns {void}
 */
export const carHoloTimeUniform = { value: 0 }; // the shared clock for every car's holo sheen (see updateTraffic, applyCarHolo)
function injectCarShader(shader, glowUniform, paintUniform, plateUniform, isGlass = false, halfLength = 0, rearAxle = [0, 0]) {
  shader.uniforms.carGlowFactor = glowUniform;
  shader.uniforms.carPlateAtlas = { value: plateAtlas };
  shader.uniforms.carHoloTime = carHoloTimeUniform;
  shader.uniforms.carFoilCentreZ = { value: halfLength };
  shader.uniforms.carRustColor = { value: TERRIBLE_RUST };
  shader.uniforms.carRearAxle = { value: new THREE.Vector2(...rearAxle) };
  if (paintUniform) shader.uniforms.instanceCarPaint = paintUniform;
  if (paintUniform) shader.uniforms.instanceCarWheel = { value: new THREE.Vector4(0, 0, 0, 0) }; // (not Vector4()'s w = 1, which would roll the body a radian)
  if (paintUniform) shader.uniforms.instanceCarHolo = { value: new THREE.Vector4() }; // (a thumbnail never shows the holo sheen or rust spots)
  if (paintUniform) shader.uniforms.instanceCarRust = { value: new THREE.Vector2() };
  if (plateUniform) shader.uniforms.instanceCarPlate = plateUniform;
  const paintDecl = paintUniform
    ? 'uniform vec3 instanceCarPaint;\nuniform vec4 instanceCarWheel;\nuniform vec4 instanceCarPlate;\nuniform vec4 instanceCarHolo;\nuniform vec2 instanceCarRust;'
    : 'attribute vec3 instanceCarPaint;\nattribute vec4 instanceCarWheel;\nattribute vec4 instanceCarPlate;\nattribute vec4 instanceCarHolo;\nattribute vec2 instanceCarRust;';
  const plateDecl = 'varying vec3 vCarPlateUv;\nflat varying vec4 vCarPlate;';
  const holoVaryingDecl = 'varying vec4 vCarHolo;\nvarying vec2 vCarRust;\nvarying vec3 vHoloPos;\nvarying float vCarPainted;';
  const holoFns = `
    uniform float carHoloTime;
    uniform float carFoilCentreZ;
    uniform vec3 carRustColor;
    vec3 carHoloHsv(vec3 c) {
      vec4 k = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + k.xyz)*6.0 - k.www);
      return c.z*mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), c.y);
    }
    // foil shine: ported from a Balatro-style card shader (four overlapping sine/cosine interference terms over a flat
    // surface coordinate, driven by a two-phase "foil" driver, clamped and summed into "maxfac" — the shine's
    // moment-to-moment intensity). uv stands in for the card's own UV, foilR/foilG for its foil phase.
    float carFoilFac(vec2 uv, float foilR, float foilG) {
      float len1 = length(90.0*uv), len2 = length(113.1121*uv);
      float fac = clamp(2.0*sin(len1 + foilR*2.0 + 3.0*(1.0 + 0.8*cos(len2 - foilR*3.121))) - 1.0 - max(5.0 - len1, 0.0), 0.0, 1.0);
      vec2 rotater = vec2(cos(foilR*0.1221), sin(foilR*0.3512));
      float angle = dot(rotater, uv)/(length(rotater)*max(length(uv), 0.0001));
      float fac2 = clamp(5.0*cos(foilG*0.3 + angle*3.14159*(2.2 + 0.9*sin(foilR*1.65 + 0.2*foilG))) - 4.0 - max(2.0 - length(20.0*uv), 0.0), 0.0, 1.0);
      float fac3 = 0.3*clamp(2.0*sin(foilR*5.0 + uv.x*3.0 + 3.0*(1.0 + 0.5*cos(foilR*7.0))) - 1.0, -1.0, 1.0);
      float fac4 = 0.3*clamp(2.0*sin(foilR*6.66 + uv.y*3.8 + 3.0*(1.0 + 0.5*cos(foilR*3.414))) - 1.0, -1.0, 1.0);
      return max(max(fac, max(fac2, max(fac3, max(fac4, 0.0)))) + 2.2*(fac + fac2 + fac3 + fac4), 0.0);
    }
    // a legendary car's sheen, both kinds driven by the same carFoilFac glint moving over the body (drifting over time,
    // shifting whenever the car turns via holo.w folded into the phase) — foil (one legendary, or a two-legendary car
    // with any terrible) tints the glint with carFoilTint below (a lightened, hue-shifted echo of the car's own paint,
    // or a fixed lightened electric blue where there's no paint to echo); polychrome (a spotless two-legendary car)
    // tints it with a shifting rainbow hue instead. Both are purely maxfac-driven — off the bright bands maxfac is 0,
    // so the result is exactly base, unchanged, not a permanent tint. See carHoloOf/placeCar for what's packed into holo.
    //
    // standard GLSL rgb->hsv (the inverse of carHoloHsv above), used by carFoilTint to shift and lighten the paint's own hue
    vec3 carRgb2Hsv(vec3 c) {
      vec4 k = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
      vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y), e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y)/(6.0*d + e)), d/(q.x + e), q.x);
    }
    // Tuning knobs — edit these directly, no need to touch the maths below them.
    const float FOIL_ROTATION_REACTIVITY = 0.05; // how much the car's own turning shifts the pattern's phase; higher = twitchier
    const float FOIL_CENTRE_CAR_LENGTHS = 20.0; // how many car lengths behind the car the ring's own centre sits
    const float FOIL_SWING_DEGREES = 20.0; // how far that centre swings side to side, each direction, pivoting about the car
    const float FOIL_SWING_PERIOD = 4.0; // seconds for one full left-right-left swing
    const float FOIL_ZOOM = 0.0006; // the pattern's spatial scale — smaller = more zoomed out, bigger bands
    const float FOIL_OPACITY = 0.62; // how strongly the glint shows over the paint, never fully opaque
    const float FOIL_HUE_SHIFT = -40.0; // degrees the paint's own hue turns for the level-1 glint's own tint
    const float FOIL_TINT_LIGHTEN = 0.55; // how far that tint is pulled toward white; 0 keeps the full colour, 1 is white
    // the level-1 glint's own colour: painted (vCarPainted, see placeCar's vertex shader) shifts and lightens the
    // car's own paint; unpainted (trim that keeps its baked colour regardless of the car, or a whole design with no
    // paintable body) has no car colour to shift, so it gets a fixed lightened electric blue instead.
    vec3 carFoilTint(vec3 paintBase, float painted) {
      vec3 hsv = painted > 0.5 ? carRgb2Hsv(paintBase) : vec3(0.58, 0.85, 1.0); // 0.58 turns ~ electric blue
      if (painted > 0.5) hsv.x = fract(hsv.x + FOIL_HUE_SHIFT/360.0);
      hsv.y *= 1.0 - FOIL_TINT_LIGHTEN;
      hsv.z = mix(hsv.z, 1.0, FOIL_TINT_LIGHTEN);
      return carHoloHsv(hsv);
    }
    vec3 applyCarHolo(vec3 base, vec4 holo, vec3 localPos, float painted) {
      float strength = holo.x, kind = holo.y, seed = holo.z;
      // sin() of the bearing, not the raw angle: holo.w (placeCar) jumps from +pi to -pi at the instant the camera
      // crosses directly behind the car — the same angle, just written the other way round, but foilR below multiplies
      // it into several different non-whole frequencies, so a raw 2*pi jump there doesn't cancel out and the whole
      // pattern would visibly snap. sin() is continuous straight through that wrap (it already treats +pi and -pi as
      // the same point), so the phase stays smooth all the way around the car regardless.
      float turn = sin(holo.w)*FOIL_ROTATION_REACTIVITY;
      // carFoilCentreZ is half this design's own local-space length (injectCarShader), so *2.0*FOIL_CENTRE_CAR_LENGTHS
      // puts the ring's own centre (uv = (0,0)) that many car lengths behind the car — off the body, so only the near
      // curve of the ring reaches it. That centre also swings side to side, pivoting about the car.
      float swingAngle = radians(FOIL_SWING_DEGREES)*sin(carHoloTime*6.283185/FOIL_SWING_PERIOD);
      vec2 behind = vec2(-sin(swingAngle), cos(swingAngle))*carFoilCentreZ*2.0*FOIL_CENTRE_CAR_LENGTHS;
      vec2 uv = (localPos.xz + behind)*FOIL_ZOOM;
      float foilR = carHoloTime*0.5 + seed*40.0 + turn, foilG = carHoloTime*0.25 + seed*21.0; // slow flicker
      float maxfac = carFoilFac(uv, foilR, foilG);
      float low = min(base.r, min(base.g, base.b)), high = max(base.r, max(base.g, base.b));
      float delta = min(high, max(0.5, 1.0 - low)); // how much headroom this particular paint colour has for a shine
      if (kind > 0.5) { // polychrome
        float hue = fract(localPos.z*0.2 - carHoloTime*0.3 + seed);
        vec3 rainbow = carHoloHsv(vec3(hue, 0.85, 1.0));
        return base + rainbow*delta*maxfac*0.9*strength*FOIL_OPACITY;
      }
      // foil: a bright glint tinted by carFoilTint above, not the flat white it used to be
      return base + carFoilTint(base, painted)*delta*maxfac*0.9*strength*FOIL_OPACITY;
    }
    // rust spots: a terrible car's own colour, grimed over with patchy dirt, with ragged rust-orange flakes scattered
    // over that — blobs placed the same way as a bloodied person's splotches (see src/life/people/peopleModel.js's
    // BLOOD_GLSL), at three times the scale, with their edges and insides broken up by noise so they read as flaked
    // paint rather than paint. carRustOf packs [strength, seed] into rust; strength sets how many blobs there are and
    // how dirty the paint between them is.
    float carRustHash(vec3 p) { p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
    float carRustBlobs(vec3 at, float coverage) {
      vec3 base = floor(at - 0.5);
      float field = 0.0;
      for (int k = 0; k < 8; k++) {
        vec3 cell = base + vec3(mod(float(k), 2.0), mod(floor(float(k)/2.0), 2.0), floor(float(k)/4.0));
        vec3 centre = cell + 0.5 + (vec3(carRustHash(cell), carRustHash(cell + 17.1), carRustHash(cell + 31.3)) - 0.5)*0.4;
        float radius = 0.8 + 0.3*carRustHash(cell + 41.7);
        vec3 off = at - centre;
        float fall = max(0.0, 1.0 - dot(off, off)/(radius*radius));
        field += step(1.0 - coverage, carRustHash(cell + 7.9))*fall*fall*fall; // (only a coverage share of the cells host a blob)
      }
      return field;
    }
    // smooth value noise from the same hash, and four octaves of it, for the ragged edges, the patches and the dirt
    float carRustNoise(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f*f*(3.0 - 2.0*f);
      return mix(mix(mix(carRustHash(i), carRustHash(i + vec3(1,0,0)), f.x), mix(carRustHash(i + vec3(0,1,0)), carRustHash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(carRustHash(i + vec3(0,0,1)), carRustHash(i + vec3(1,0,1)), f.x), mix(carRustHash(i + vec3(0,1,1)), carRustHash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float carRustFbm(vec3 p) {
      return carRustNoise(p)*0.45 + carRustNoise(p*2.3 + 3.1)*0.28 + carRustNoise(p*5.3 + 7.7)*0.17 + carRustNoise(p*12.1 + 1.9)*0.10;
    }
    const float RUST_ZOOM = 1.4; // the blob pattern's spatial scale — bigger = more zoomed in, smaller blobs relative to the car
    const float RUST_ROUGH = 0.36; // how far the noise pushes the blob field about, i.e. how ragged the spots' edges are
    const float RUST_COVERAGE = 0.3; // the share of blob cells that rust, at full strength
    const vec3 CAR_DIRT = vec3(0.13, 0.10, 0.065); // the grime under the rust (linear)
    vec3 applyCarRust(vec3 base, vec2 rust, vec3 localPos) {
      float strength = rust.x, seed = rust.y;
      vec3 spot = localPos*RUST_ZOOM + vec3(seed*13.7, seed*7.1, seed*3.3);
      // dirt: a film of dust over all the paint, thicker in soft patches, with a grain, dirtier the worse the car
      float dirt = (0.3 + 0.7*smoothstep(0.3, 0.75, carRustFbm(spot*0.7 + 9.1)))*(0.3 + 0.35*strength)*(0.75 + 0.5*carRustNoise(spot*16.0)); // (sized to the car, not the smaller blobs; never below 0.3 of it, so no panel looks clean)
      // the paint itself faded towards rust all over, more the worse the car
      vec3 color = mix(base, carRustColor, 0.15 + 0.3*strength);
      color = mix(color, CAR_DIRT, dirt);
      // rust: blobs warped out of round, their edge pushed about by fine noise, so it breaks into flakes and pits
      vec3 warp = vec3(carRustNoise(spot*1.7), carRustNoise(spot*1.7 + 4.3), carRustNoise(spot*1.7 + 8.9)) - 0.5;
      float field = carRustBlobs(spot + warp*0.8, RUST_COVERAGE*strength) + (carRustFbm(spot*9.0)*0.7 + carRustNoise(spot*41.0)*0.3 - 0.5)*RUST_ROUGH; // (fine noise, so the edge frays in small bites)
      color = mix(color, CAR_DIRT*0.6, smoothstep(0.1, 0.17, field)*0.5); // (a brown stain bleeding out round each flake)
      float mask = smoothstep(0.17, 0.18, field); // (a hard edge: flaked paint, not a stain)
      float deep = smoothstep(0.5, 0.56, carRustNoise(spot*6.0 + 5.3) + (carRustNoise(spot*23.0) - 0.5)*0.3); // (hard-edged, grainy patches eaten deeper)
      vec3 rustColor = mix(carRustColor, carRustColor*0.65, deep)*(0.85 + 0.3*carRustNoise(spot*40.0)); // (orange rust, darker there, with a fine grain)
      return mix(color, rustColor, mask);
    }`;
  const plateColor = `
    uniform sampler2D carPlateAtlas;
    vec3 carPlateColor() {
      int format = int(vCarPlate.w + 0.5) % 4, count = int(vCarPlate.w + 0.5) / 4;
      bool back = vCarPlateUv.z > 1.5;
      vec3 background = format == 0 && back ? vec3(0.98, 0.72, 0.02) : vec3(0.92);
      // the text: ${PLATE_MAX_CHARS} cells across the plate, inside a margin, the characters centered among them
      const vec2 grid = vec2(${PLATE_ATLAS_COLUMNS}.0, ${PLATE_ATLAS_ROWS}.0), toAtlas = vec2(1.0, -1.0)/grid;
      float left = format == 1 ? 0.09 : 0.05; // (clear of the EU's blue band)
      vec2 inner = (vCarPlateUv.xy - vec2(left, 0.06))/vec2(0.95 - left, 0.88);
      vec2 p = vec2(inner.x*${PLATE_MAX_CHARS}.0 - float(${PLATE_MAX_CHARS} - count)*0.5, inner.y);
      vec2 dx = dFdx(p)*toAtlas, dy = dFdy(p)*toAtlas; // (before any branching, where derivatives aren't to be trusted)
      float tiny = smoothstep(0.35, 0.8, max(fwidth(p.x), fwidth(p.y))); // (characters only a pixel or two across)
      if (format == 1 && vCarPlateUv.x < 0.07) return vec3(0.0, 0.12, 0.6); // (the EU's blue band)
      float cell = floor(p.x);
      if (p.y < 0.0 || p.y > 1.0 || cell < 0.0 || cell >= float(count)) return background;
      int k = int(cell), glyph = (int(vCarPlate[k/3] + 0.5) >> (6*(k % 3))) & 63;
      if (glyph == 0) return background;
      vec2 corner = vec2(float(glyph % ${PLATE_ATLAS_COLUMNS}), float(glyph / ${PLATE_ATLAS_COLUMNS}));
      vec2 atlasUv = vec2((corner.x + p.x - cell)/grid.x, 1.0 - (corner.y + p.y)/grid.y);
      float ink = mix(textureGrad(carPlateAtlas, atlasUv, dx, dy).r, 0.3, tiny);
      return mix(background, vec3(0.03), ink);
    }`;
  const wheelTurn = `
    attribute vec4 carWheel;
    vec3 carWheelTurn(vec3 v) {
      if (carWheel.w < 0.5) return v;
      float s = sin(instanceCarWheel.x), c = cos(instanceCarWheel.x);
      v = vec3(v.x, c*v.y - s*v.z, s*v.y + c*v.z);
      if (carWheel.w > 1.5) { float ss = sin(instanceCarWheel.y), cs = cos(instanceCarWheel.y); v = vec3(cs*v.x + ss*v.z, v.y, cs*v.z - ss*v.x); }
      return v;
    }
    uniform vec2 carRearAxle;
    // the body (not the wheels) leant on its springs: rolled about its length, then pitched nose up about its sideways
    // axis — a direction as it is, a point about the rear axle (see swayBody)
    vec3 carBodySway(vec3 v, bool point) {
      if (carWheel.w > 0.5) return v;
      vec3 pivot = point ? vec3(0.0, carRearAxle.y, carRearAxle.x) : vec3(0.0);
      v -= pivot;
      float sr = sin(instanceCarWheel.w), cr = cos(instanceCarWheel.w), sp = sin(instanceCarWheel.z), cp = cos(instanceCarWheel.z);
      v = vec3(cr*v.x - sr*v.y, sr*v.x + cr*v.y, v.z);
      v = vec3(v.x, cp*v.y + sp*v.z, cp*v.z - sp*v.y);
      return v + pivot;
    }`;
  const glowTerm = (name, slot) => { const g = CAR_GLOW_MATERIALS[name], c = new THREE.Color(g.emissive).multiplyScalar(g.intensity);
    return `carSlot > ${slot - 0.5} && carSlot < ${slot + 0.5} ? vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)}) : `; };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float carSlot;\nattribute vec3 carColor;\nattribute vec3 carPlate;\n' + paintDecl + wheelTurn + '\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\n' + plateDecl + '\n' + holoVaryingDecl)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = carBodySway(carWheelTurn(objectNormal), false);')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed = carWheelTurn(transformed - carWheel.xyz) + carWheel.xyz;
      transformed = carBodySway(transformed, true);
      vCarColor = carSlot > 0.5 && carSlot < 1.5 ? instanceCarPaint : carColor;
      // whether this fragment is the paintable CarCol slot (instanceCarPaint above) or keeps its own baked colour
      // regardless of the car — see carFoilTint, which only has a car colour to work from in the first case
      vCarPainted = carSlot > 0.5 && carSlot < 1.5 ? 1.0 : 0.0;
      vCarPlateUv = carPlate;
      vCarPlate = instanceCarPlate;
      // the holo sheen and rust spots only ever play on the body (paintable or not) — never lights, plate or glass
      vCarHolo = ${isGlass ? 'vec4(0.0)' : 'carSlot < 1.5 ? instanceCarHolo : vec4(0.0)'};
      vCarRust = ${isGlass ? 'vec2(0.0)' : 'carSlot < 1.5 && carWheel.w < 0.5 ? instanceCarRust : vec2(0.0)'}; // (and never the wheels)
      vHoloPos = position;
      vCarEmissive = ${CAR_SLOT_NAMES.map((name, k) => CAR_GLOW_MATERIALS[name] ? glowTerm(name, k + 1) : '').join('')}vec3(0.0);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCarColor;\nvarying vec3 vCarEmissive;\nuniform float carGlowFactor;\n' + plateDecl + plateColor + '\n' + holoVaryingDecl + holoFns)
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec3 carBodyColor = vCarRust.x > 0.0 ? applyCarRust(vCarColor, vCarRust, vHoloPos) : vCarColor;
      carBodyColor = vCarHolo.x > 0.0 ? applyCarHolo(carBodyColor, vCarHolo, vHoloPos, vCarPainted) : carBodyColor;
      diffuseColor.rgb = vCarPlateUv.z > 0.5 ? carPlateColor() : carBodyColor;`)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vCarEmissive*carGlowFactor;');
}
/**
 * A design's two materials — the body, and the glass (the Window parts) at the opacity, roughness and metalness the model
 * gives that material. Both take the car shader through onBeforeCompile.
 * @param {object} design - one entry from buildCarDesigns
 * @param {string} key - the custom program cache key prefix, distinguishing instanced from thumbnail programs
 * @param {object} glowUniform - the shared carGlowFactor uniform
 * @param {?object} paintUniform - per-draw paint, for a thumbnail, or null for the instanced crowd
 * @param {?object} plateUniform - per-draw plate glyphs, for a thumbnail, or null
 * @returns {object[]} [body, glass]
 */
function makeCarMaterials(design, key, glowUniform, paintUniform, plateUniform) {
  const { opacity, roughness, metalness } = design.glass;
  const body = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, envMap: SKY_ENV_MAP, envMapIntensity: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ roughness, metalness, envMap: SKY_ENV_MAP, envMapIntensity: 0.8,
    transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  [body, glass].forEach((material, k) => {
    material.onBeforeCompile = shader => injectCarShader(shader, glowUniform, paintUniform, plateUniform, k === 1, design.length*BOX_CAR_LENGTH/2, design.rearAxle);
    material.customProgramCacheKey = () => key + (k ? '-glass' : '');
  });
  return [body, glass];
}
/**
 * The card's thumbnail: the design's own geometry, drawn un-instanced through injectCarShader's paint and plate uniforms,
 * from an isometric orthographic camera sized and aimed at the design (carThumbnailScene sets the paint and plate before
 * the card draws it).
 * @param {object} design - one entry from buildCarDesigns
 * @returns {{ mesh: object, camera: object, paint: object, plate: object }}
 */
function makeCarThumbnail(design) {
  const glowUniform = { value: 1 }, paintUniform = { value: new THREE.Color(0xffffff) }, plateUniform = { value: new THREE.Vector4() };
  const material = makeCarMaterials(design, 'car-thumb', glowUniform, paintUniform, plateUniform);
  const mesh = new THREE.Mesh(design.geometry, material);
  const r = design.radius, elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = r*4;
  const thumbCamera = new THREE.OrthographicCamera(-r*1.15, r*1.15, r*1.15, -r*1.15, 0.1, distance*2);
  thumbCamera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  thumbCamera.up.set(0, 1, 0);
  thumbCamera.lookAt(0, design.height*0.5, 0);
  return { mesh, camera: thumbCamera, paint: paintUniform, plate: plateUniform };
}
/**
 * The instanced mesh the crowd of this design is drawn with, with its per-instance paint, wheel and plate attributes.
 * @param {object} design - one entry from buildCarDesigns
 * @returns {object} the carMeshes entry for this design
 */
export function makeCarMesh(design) {
  const glowUniform = { value: 1 };
  const material = makeCarMaterials(design, 'car', glowUniform, null, null);
  const mesh = new THREE.InstancedMesh(design.geometry, material, TRAFFIC_MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const paint = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*3), 3);
  paint.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarPaint', paint);
  const wheels = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*4), 4); // [spin, steer, body pitch, body roll]
  wheels.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarWheel', wheels);
  const plates = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*4), 4);
  plates.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarPlate', plates);
  const holo = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*4), 4); // [strength, kind, seed, heading] — a legendary car's foil/polychrome sheen (see carHoloOf, applyCarHolo); heading is written fresh each frame, the rest cached
  holo.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarHolo', holo);
  const rust = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_MAX*2), 2); // [strength, seed] — a terrible car's rust spots (see carRustOf, applyCarRust)
  rust.setUsage(THREE.DynamicDrawUsage);
  design.geometry.setAttribute('instanceCarRust', rust);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.visible = false;
  mesh.name = 'Traffic';
  scene.add(mesh);
  const thumb = makeCarThumbnail(design);
  return { mesh, paint, wheels, plates, holo, rust, glowUniform, length: design.length, width: design.width, height: design.height,
    wheelRadius: design.wheelRadius, wheelbase: design.wheelbase,
    name: design.name, bodyColor: design.bodyColor, // (null where the design is repainted per car)
    thumbMesh: thumb.mesh, thumbCamera: thumb.camera, thumbPaint: thumb.paint, thumbPlate: thumb.plate };
}
