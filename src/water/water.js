import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { S, App, SAND_TINT } from '../core/shared.js';
import { scene, SKY_ENV_MAP, GROUND_HALF_SIZE, ground, makeStencilMask, STENCIL_WATER, Y_MAP, Y_PARK } from '../core/scene.js';
import { distPointSegment } from '../buildings/footprints.js';
import { tessellateClosedPath } from '../core/splines.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder, disposeObject } from '../roads/roads.js';

// ---------------------------------------------------------- water
// Water zones and rivers are one body of water: their areas are unioned, so a river running into a lake joins it without
// a seam. It sits sunk below the ground — the ground mesh has a hole cut where it is — at WATER_LEVEL, and it's edged by
// banks: a sandy beach sloping down into the water wherever it meets a park, and a stone embankment wall everywhere else.
// Roads and paths don't cut into it: where they cross, they're carried over on bridges (see "bridges").
// The surface is animated: travelling waves (a few long swells plus drifting noise) tilt its normals so it glints in the
// sun and picks up the sky reflection, and it's colored by how far each point is from the waterline — deep blue-green in
// the middle, lighter turquoise in the shallows, and a thin broken line of foam at the water's edge. Along a beach, the
// shallows take on a sandy tint while the park's grass turns to sand along the same edge (see applyGrassNoiseShader), so
// grass, sand and water blend into each other. Both shaders measure distance to shore edges passed in as fixed-size
// lists of segments; to keep those lists short, the surface is built in square tiles, each told only about the shore
// near it (see rebuildWater).
export const WATER_COLOR = 0x0d4a5a;       // deep water; the shallows are mixed in lighter by the shader
export const WATER_LEVEL = -1.2;           // the water's surface, below ground level
export const WATER_BANK_TOP = 0.05;        // banks start a hair above the ground, so zone floors meet them without a gap
export const WATER_BANK_BOTTOM = -1.6;     // and reach down past the surface (which is opaque)
const BEACH_SLOPE_WIDTH = 3;        // how far out a beach slopes before it reaches the bottom of the bank
const BEACH_SLOPE_SHADING_TILT = 0.25; // how much of the slope's real pitch its shading uses (0 = lit as flat sand, 1 = its true angle)
// how far out along a beach its slope goes under the water — where the waterline and its foam are
const BEACH_WATERLINE = BEACH_SLOPE_WIDTH*(WATER_BANK_TOP - WATER_LEVEL)/(WATER_BANK_TOP - WATER_BANK_BOTTOM);
export const WATER_BANK_COLOR = 0x6f6c66;
const WATER_MAX_SHORE_SEGMENTS = 128;
const WATER_MAX_BEACH_SEGMENTS = 64;
const WATER_TILE_SIZE = 96;         // world units per surface tile
const WATER_TILE_MARGIN = 12;       // shore this far outside a tile still counts for it — past the shallows' reach
const PARK_BEACH_WIDTH = 5;         // roughly how far sand reaches into a park from the water's edge
export const WATER_TIME = { value: 0 };    // shared by every water material; advanced each frame in animate()
export const WATER_SUN = { value: new THREE.Color(1, 1, 1) }; // the sun's (or moon's) light, glints lit by it; set in animate()
// The water shaders' looks, as uniforms every water material shares; tuned live from View > Water (debug), ui/water-debug.js
const rgb = (r, g, b) => ({ value: new THREE.Color(r, g, b) }), num = v => ({ value: v });
export const WATER_TUNE = {
  deep: { value: new THREE.Color(WATER_COLOR) }, shallow: rgb(0.2, 0.42, 0.42), weed: rgb(0.22, 0.478, 0.341),
  sandTint: rgb(0.58, 0.92, 0.72), halo: rgb(0.52, 0.84, 0.64), foam: rgb(0.92, 0.97, 0.98), wet: rgb(0.5, 0.58, 0.52), coping: rgb(0.78, 0.76, 0.71),
  shallowWidth: num(5.9), shallowMix: num(0), bands: num(3), weedFrom: num(0), weedMix: num(0.79), weedPatch: num(0.74),
  sandWidth: num(6.1), sandMix: num(0.02), haloWidth: num(5.15), haloMix: num(0.19), wobble: num(0.65), lip: num(0.16),
  foamReach: num(0.54), foamSwell: num(0.6), swellSpeed: num(0.66), laceScale: num(1.2), laceHoles: num(0),
  ringSpeed: num(0.165), ringReach: num(2.9), ringWidth: num(0.07), ringBreak: num(0.44), ringMix: num(1),
  wwAmount: num(0.07), wwScale: num(3.4), wwWidth: num(0.02), wwSoft: num(0), wwRound: num(0.095), wwWarp: num(0.3), wwBreak: num(0),
  wwSpeed: num(0.1), wwDrift: num(0.03), wwCover: num(0),
  glint: num(2), glintColor: rgb(1, 0.95, 0.8), glintScale: num(2), glintSize: num(1), glintSpeed: num(1.5),
  ripple: num(0.65), facets: num(10), wetHeight: num(0), wetWave: num(0), copeHeight: num(0.31),
  roughness: num(0.01), reflection: num(1.72),
};
const TUNE_PARS = Object.entries(WATER_TUNE).map(([k, u]) => `uniform ${u.value.isColor ? 'vec3' : 'float'} uW_${k};`).join('\n');
const tuneUniforms = shader => { for (const k in WATER_TUNE) shader.uniforms['uW_' + k] = WATER_TUNE[k]; };
// ---- Wind Waker foam's field: WW_CELLS × WW_CELLS cells of md (as WW_FIELD_PROCEDURAL, at time 0), tiling, WW_RES texels a
// cell; baked again when wwRound changes (see refreshWaterMaterials). Baked, cells keep still (only drift and warp move
// them); false is the old per-pixel version, where they wobble on wwSpeed
const WW_BAKED = true;
const WW_CELLS = 8, WW_RES = 32;
const WW_FIELD = { value: null };
let wwBakedRound = null;
function bakeWindWaker() {
  const k = Math.max(WATER_TUNE.wwRound.value, 1e-3), N = WW_CELLS, size = N*WW_RES, data = new Uint16Array(size*size);
  const fract = x => x - Math.floor(x), hash = (x, y) => fract(Math.sin(x*127.1 + y*311.7)*43758.5453);
  const pts = []; // (each cell's point, wrapped so the field tiles)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) pts.push([0.5 + 0.4*Math.sin(6.283*hash(x, y)), 0.5 + 0.4*Math.sin(6.283*hash(x + 5.3, y + 5.3))]);
  const pt = (x, y) => pts[((y % N) + N) % N*N + ((x % N) + N) % N];
  for (let ty = 0; ty < size; ty++) for (let tx = 0; tx < size; tx++) {
    const vx = (tx + 0.5)/WW_RES, vy = (ty + 0.5)/WW_RES, ix = Math.floor(vx), iy = Math.floor(vy), fx = vx - ix, fy = vy - iy;
    let md = 8, mrx = 0, mry = 0, mgx = 0, mgy = 0;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const q = pt(ix + x, iy + y), rx = x + q[0] - fx, ry = y + q[1] - fy, d = rx*rx + ry*ry;
      if (d < md) { md = d; mrx = rx; mry = ry; mgx = x; mgy = y; }
    }
    let sum = 0;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const ox = mgx + x, oy = mgy + y, q = pt(ix + ox, iy + oy), rx = ox + q[0] - fx, ry = oy + q[1] - fy;
      const dx = rx - mrx, dy = ry - mry, l = Math.hypot(dx, dy);
      if (l*l > 1e-5) sum += Math.exp(-((mrx + rx)*0.5*dx + (mry + ry)*0.5*dy)/l/k);
    }
    data[ty*size + tx] = THREE.DataUtils.toHalfFloat(-Math.log(Math.max(sum, 1e-20))*k);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  WW_FIELD.value?.dispose();
  WW_FIELD.value = tex;
  wwBakedRound = WATER_TUNE.wwRound.value;
}
if (WW_BAKED) bakeWindWaker();
/** Roughness and reflection onto every water surface (they're the material's own, not uniforms). */
export function refreshWaterMaterials() {
  if (WW_BAKED && WATER_TUNE.wwRound.value !== wwBakedRound) bakeWindWaker();
  S.waterGroup?.traverse(o => { if (o.material?.userData.water) { o.material.roughness = WATER_TUNE.roughness.value; o.material.envMapIntensity = WATER_TUNE.reflection.value; } });
}

// a fixed-length list of vec4 segment uniforms (GLSL array sizes are compile-time constants) — padding is never read
// (flat, four numbers a segment: three.js hands a Float32Array straight to the GPU, where an array of Vector4s would be
// copied into a new one every time anything using it is drawn)
function segmentUniformArray(segments, max) {
  const out = new Float32Array(max*4);
  for (let i=0;i<Math.min(max, segments.length);i++) for (let k=0;k<4;k++) out[i*4 + k] = segments[i][k];
  return out;
}
// A zone's actual area — its outline minus its cut-outs — as Clipper paths (empty while it's still being drawn).
function zoneEffectivePaths(zone) {
  if (zone.drawing || zone.points.length < 3) return [];
  const poly = tessellateClosedPath(zone.points);
  return clipPolygons(ClipperLib.ClipType.ctDifference, [App.toClipperPath(poly)], App.zoneCutoutsNear(zone, poly));
}
// Every edge of some closed Clipper paths as world-space segments [ax, az, bx, bz], simplified — dropping near-
// collinear points, harder each pass — until there are no more than `max`.
function edgeSegmentsOf(paths, max) {
  const countEdges = ps => ps.reduce((sum, p) => sum + p.length, 0);
  let cleaned = paths;
  for (let tolerance = 0.2; countEdges(cleaned) > max && tolerance < 64; tolerance *= 2) {
    cleaned = ClipperLib.Clipper.CleanPolygons(paths, tolerance*CLIPPER_SCALE).filter(p => p.length >= 3);
  }
  const segments = [];
  cleaned.forEach(path => path.forEach((a, i) => {
    const b = path[(i+1)%path.length];
    segments.push([a.X/CLIPPER_SCALE, a.Y/CLIPPER_SCALE, b.X/CLIPPER_SCALE, b.Y/CLIPPER_SCALE]);
  }));
  return segments.slice(0, max);
}
// The stretches of the edge of an area (`ownPaths`) that border another area (`otherArea`) — where a park meets water,
// or water meets a park — as world-space segments, at most `max` of them. Each edge is sampled along its length, just
// either side of it, so a partly shared edge only contributes the part that's shared; if that makes too many, segments
// that join end to end are merged in pairs until they fit.
function sharedEdgeSegmentsWith(ownPaths, otherArea, max) {
  if (!ownPaths.length || !otherArea.length) return [];
  const inOther = App.createRegionTester(otherArea);
  let segments = [];
  edgeSegmentsOf(ownPaths, 1000).forEach(([ax, az, bx, bz]) => {
    const len = Math.hypot(bx-ax, bz-az);
    if (len < 1e-6) return;
    const nx = -(bz-az)/len*0.3, nz = (bx-ax)/len*0.3;
    const steps = Math.max(1, Math.ceil(len/1.5));
    const at = k => [ax + (bx-ax)*k/steps, az + (bz-az)*k/steps];
    let runStart = null;
    for (let k=0;k<=steps;k++) {
      let shared = false;
      if (k < steps) {
        const [mx, mz] = at(k + 0.5);
        shared = inOther(mx+nx, mz+nz) || inOther(mx-nx, mz-nz);
      }
      if (shared && runStart===null) runStart = k;
      if (!shared && runStart!==null) { segments.push([...at(runStart), ...at(k)]); runStart = null; }
    }
  });
  while (segments.length > max) {
    const merged = [];
    for (let i=0;i<segments.length;i++) {
      const s = segments[i], next = segments[i+1];
      if (next && Math.hypot(s[2]-next[0], s[3]-next[1]) < 1e-3) { merged.push([s[0], s[1], next[2], next[3]]); i++; }
      else merged.push(s);
    }
    if (merged.length === segments.length) { segments = segments.slice(0, max); break; }
    segments = merged;
  }
  return segments;
}

// Wind Waker foam's cell-border distance (md, in cells) at vc: baked (WW_BAKED) or worked out per pixel as before
const WW_FIELD_BAKED = `      float md = textureLod(uWWField, vc/${WW_CELLS}.0, 0.0).r;
`;
const WW_FIELD_PROCEDURAL = `      vec2 mr = vec2(0.0), mg = vec2(0.0);
      vec2 pts[9]; // (each cell's point, kept for the second pass)
      float md = 8.0;
      for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
        vec2 o = vec2(float(x), float(y)), r = o + (pts[(y + 1)*3 + x + 1] = wwPoint(vi + o)) - vf;
        if (dot(r, r) < md) { md = dot(r, r); mr = r; mg = o; }
      }
      // (then the distance to every border round it, smooth-min'd so the cell's corners round off into blobs, the foam
      // pooling where cells meet; wwRound is how round)
      float wsum = 0.0, wk = max(uW_wwRound, 1e-3);
      for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
        vec2 o = mg + vec2(float(x), float(y));
        vec2 r = o + (abs(o.x) < 1.5 && abs(o.y) < 1.5 ? pts[int(o.y + 1.0)*3 + int(o.x + 1.0)] : wwPoint(vi + o)) - vf;
        if (dot(mr - r, mr - r) > 1e-5) wsum += exp(-dot(0.5*(mr + r), normalize(r - mr))/wk);
      }
      md = -log(max(wsum, 1e-20))*wk;
`;
const WATER_FRAGMENT_PARS = `
  #define WATER_MAX_SHORE ${WATER_MAX_SHORE_SEGMENTS}
  #define WATER_MAX_BEACH ${WATER_MAX_BEACH_SEGMENTS}
  varying vec3 vWaterWorldPos;
  uniform float uWaterTime;
  uniform vec4 uShoreSegments[WATER_MAX_SHORE];
  uniform int uShoreCount;
  uniform vec4 uBeachSegments[WATER_MAX_BEACH];
  uniform int uBeachCount;
  uniform float uBeachWaterline;
  uniform vec3 uSandTint;
  ${TUNE_PARS}
  float waterGlint = 0.0;
  uniform vec3 uWaterSun;
  uniform sampler2D uWWField;
  float waterHash(vec2 p) { p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float waterNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = waterHash(i), b = waterHash(i+vec2(1.0,0.0)), c = waterHash(i+vec2(0.0,1.0)), d = waterHash(i+vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
  float waterSegmentDistance(vec2 p, vec4 s) {
    vec2 pa = p - s.xy, ba = s.zw - s.xy;
    float h = clamp(dot(pa, ba)/max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba*h);
  }
  // a Wind Waker foam cell's wobbling point
  vec2 wwPoint(vec2 c) { return 0.5 + 0.4*sin(uWaterTime*uW_wwSpeed + 6.283*vec2(waterHash(c), waterHash(c + 5.3))); }
  // the surface's height: a few long travelling swells plus two layers of drifting noise
  float waterHeight(vec2 p) {
    float t = uWaterTime;
    float h = 0.10*sin(dot(p, vec2(0.21, 0.11)) + t*1.1)
            + 0.07*sin(dot(p, vec2(-0.13, 0.27)) + t*1.6)
            + 0.05*sin(dot(p, vec2(0.37, -0.29)) + t*2.3);
    return h + 0.14*waterNoise(p*0.35 + vec2(t*0.08, t*0.05)) + 0.06*waterNoise(p*1.2 - vec2(t*0.13, -t*0.1));
  }
`;
const WATER_COLOR_FRAGMENT = `
  {
    vec2 wp = vWaterWorldPos.xz;
    // uShoreSegments are the edges walled by an embankment, uBeachSegments the ones with a beach sloping into the water
    float wallDistance = 1e9;
    for (int i=0; i<WATER_MAX_SHORE; i++) { if (i >= uShoreCount) break; wallDistance = min(wallDistance, waterSegmentDistance(wp, uShoreSegments[i])); }
    float beachDistance = 1e9;
    for (int i=0; i<WATER_MAX_BEACH; i++) { if (i >= uBeachCount) break; beachDistance = min(beachDistance, waterSegmentDistance(wp, uBeachSegments[i])); }
    // the waterline is right at a wall, but part-way out from a beach's edge, where its slope goes under
    float shoreDistance = min(wallDistance, abs(beachDistance - uBeachWaterline));
    vec3 deep = uW_deep;
    // stylized: the shallows come in flat bands (three steps out from the waterline), edges kept soft by a pixel
    float shallow = 1.0 - smoothstep(0.0, uW_shallowWidth, shoreDistance);
    float aa = max(fwidth(shallow*uW_bands), 1e-3);
    float banded = (floor(shallow*uW_bands) + smoothstep(1.0 - aa, 1.0, fract(shallow*uW_bands)))/uW_bands;
    vec3 water = mix(deep, uW_shallow, banded*uW_shallowMix);
    // the bands nearest the shore turn green, unevenly, as if over weed
    float weedy = smoothstep(uW_weedFrom, 1.0, banded)*(1.0 - uW_weedPatch + uW_weedPatch*waterNoise(wp*0.25));
    water = mix(water, uW_weed, weedy*uW_weedMix);
    // sand showing through the first few units of water off a beach, with a slightly wavering edge
    float sandy = 1.0 - smoothstep(0.0, uW_sandWidth, beachDistance - uBeachWaterline + (waterNoise(wp*0.5) - 0.5)*1.5);
    water = mix(water, uSandTint*uW_sandTint, step(0.4, sandy)*uW_sandMix); // the same sand tint as the beach it runs on from, green-shifted and dimmed by the water above it
    float foamAa = max(fwidth(shoreDistance), 1e-3);
    float wobble = (waterNoise(wp*0.8 + vec2(uWaterTime*0.2, -uWaterTime*0.15)) - 0.5)*uW_wobble;
    float d = shoreDistance + wobble;
    // a lighter halo of churned water just past the foam
    water = mix(water, uW_halo, (1.0 - smoothstep(0.5, uW_haloWidth, d))*uW_haloMix);
    // a solid lip at the edge, then lacy foam that swells out and ebbs, holed by drifting noise
    float swell = 0.5 + 0.5*sin(uWaterTime*uW_swellSpeed + waterNoise(wp*0.12)*6.283);
    float lip = 1.0 - smoothstep(uW_lip - foamAa, uW_lip + foamAa, d);
    float reach = uW_foamReach + swell*uW_foamSwell;
    float band = 1.0 - smoothstep(reach - foamAa, reach + foamAa, d);
    float lace = waterNoise(wp*uW_laceScale + vec2(uWaterTime*0.25, -uWaterTime*0.2))*0.6 + waterNoise(wp*uW_laceScale*2.08 - vec2(uWaterTime*0.3))*0.4;
    float laceAa = max(fwidth(lace), 1e-3), holeAt = uW_laceHoles + d/reach*0.3;
    float foam = max(lip, band*smoothstep(holeAt - laceAa, holeAt + laceAa, lace));
    // two broken rings drifting out in turn, thinning and fading as they go
    float ring = 0.0;
    for (int k=0; k<2; k++) {
      float ph = fract(uWaterTime*uW_ringSpeed + float(k)*0.5);
      float w = mix(uW_ringWidth, uW_ringWidth*0.3, ph);
      float r = 1.0 - smoothstep(w, w + foamAa*1.5, abs(d - (0.9 + ph*uW_ringReach)));
      r *= step(uW_ringBreak + ph*0.2, waterNoise(wp*0.9 + vec2(float(k)*17.0) - vec2(uWaterTime*0.1)));
      ring = max(ring, r*(1.0 - ph*ph));
    }
    // glints: sun twinkles out on open water — a star (dot and cross) in some cells of a grid, each flashing on its own clock
    // (glintScale: world units between them; glintSize: how big each one is, in world units too)
    vec2 gc = wp/uW_glintScale, gi = floor(gc), gf = (fract(gc) - (vec2(waterHash(gi + 3.1), waterHash(gi + 7.7))*0.6 + 0.2))*uW_glintScale;
    float gpix = max(fwidth(wp.x), 1e-3), gPhase = waterHash(gi + 11.3), gRate = 0.6 + 0.8*waterHash(gi + 19.7);
    float life = pow(max(0.0, sin(uWaterTime*uW_glintSpeed*gRate + gPhase*6.283)), 12.0)*step(0.55, waterHash(gi));
    vec2 ga = abs(gf);
    float gr = 0.06*uW_glintSize, garm = 0.008*uW_glintSize;
    // (edges smoothed across a pixel centred on them, and anything thinner than a pixel dimmed by how much of it it covers,
    // so they shrink with distance instead of holding at a pixel or two wide)
    float star = max((1.0 - smoothstep(gr - gpix*0.5, gr + gpix*0.5, length(gf)))*min(1.0, gr*gr*4.0/(gpix*gpix)),
      (1.0 - smoothstep(garm - gpix*0.5, garm + gpix*0.5, min(ga.x, ga.y)))*min(1.0, garm*2.0/gpix)*(1.0 - smoothstep(0.0, 0.4*uW_glintSize*life + 1e-3, max(ga.x, ga.y))));
    waterGlint = star*life*smoothstep(1.5, 6.0, shoreDistance)*clamp(1.4 - gpix*1.2, 0.0, 1.0);
    float ww = 0.0;
    // (patch mask and distance fade first, derivatives outside the branch: the cells are skipped wherever they'd come to 0)
    float wwPix = max(fwidth(wp.x), fwidth(wp.y))/uW_wwScale;
    float wwFade = clamp(1.4 - wwPix*2.1, 0.0, 1.0);
    float wwMask = smoothstep(uW_wwCover, uW_wwCover + 0.12, waterNoise(wp*0.04 + vec2(uWaterTime*0.02, -uWaterTime*0.013)));
    if (uW_wwAmount > 0.0 && wwFade*wwMask > 0.0) { // (it's most of the shader's cost after the shore loop)
      // Wind Waker foam: soft, broken lines along the borders of wobbling cells, bent by noise so they curve, in patches
      vec2 warp = vec2(waterNoise(wp*0.15 + uWaterTime*0.05), waterNoise(wp*0.15 + 9.1 - uWaterTime*0.04)) - 0.5;
      vec2 vc = wp/uW_wwScale + warp*uW_wwWarp + vec2(1.0, 0.6)*uWaterTime*uW_wwDrift, vi = floor(vc), vf = fract(vc);
${WW_BAKED ? WW_FIELD_BAKED : WW_FIELD_PROCEDURAL}
      float soft = uW_wwSoft*0.5 + max(wwPix, 1e-3);
      float wwBreak = uW_wwBreak <= 0.0 ? 1.0 : smoothstep(uW_wwBreak - 0.1, uW_wwBreak + 0.1, waterNoise(vc*2.3 + 4.7));
      ww = (1.0 - smoothstep(uW_wwWidth - soft, uW_wwWidth + soft, md))*wwBreak*wwMask*wwFade*uW_wwAmount;
    }
    diffuseColor.rgb = mix(water, uW_foam, max(max(foam, ring*uW_ringMix), ww));
  }
`;
const WATER_NORMAL_FRAGMENT = `
  {
    vec2 wp = vWaterWorldPos.xz;
    float e = 0.2;
    float dhdx = (waterHeight(wp + vec2(e, 0.0)) - waterHeight(wp - vec2(e, 0.0)))/(2.0*e);
    float dhdz = (waterHeight(wp + vec2(0.0, e)) - waterHeight(wp - vec2(0.0, e)))/(2.0*e);
    // calm the ripples where they'd be smaller than a pixel, so distant water doesn't sparkle
    float calm = clamp(1.2 - length(fwidth(wp))*0.9, 0.15, 1.0);
    // stylized: the slope snapped to 8 directions and 3 steepnesses, so the surface catches light in flat facets
    vec2 slope = vec2(dhdx, dhdz)*uW_ripple*calm;
    float steep = floor(length(slope)*uW_facets + 0.5)/uW_facets;
    float dir = floor(atan(slope.y, slope.x)/0.7853982 + 0.5)*0.7853982;
    slope = vec2(cos(dir), sin(dir))*min(steep, 0.5);
    vec3 waterNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
    normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);
  }
`;
// Embankments: a pale coping along the top and a dark wet band at the waterline, lapping with the water
function applyBankShader(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = WATER_TIME;
    tuneUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBankPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBankPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBankPos;\nuniform float uWaterTime;\n' + TUNE_PARS)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float y = vBankPos.y, aa = max(fwidth(y), 1e-3);
          float lap = ${WATER_LEVEL.toFixed(2)} + uW_wetHeight + uW_wetWave*sin(dot(vBankPos.xz, vec2(0.7, 0.5)) + uWaterTime*1.3);
          float wet = 1.0 - smoothstep(lap - aa, lap + aa, y);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*uW_wet, wet);
          float copeAt = ${WATER_BANK_TOP.toFixed(2)} - uW_copeHeight, cope = smoothstep(copeAt - aa, copeAt + aa, y);
          diffuseColor.rgb = mix(diffuseColor.rgb, uW_coping, cope);
        }`);
  };
}
// `shoreSegments`: walled edges; `beachSegments`: edges with a beach, whose waterline is `beachWaterline` out from them
export function applyWaterShader(mat, shoreSegments, beachSegments, beachWaterline) {
  mat.roughness = WATER_TUNE.roughness.value;
  mat.metalness = 0;
  mat.envMap = SKY_ENV_MAP;
  mat.envMapIntensity = WATER_TUNE.reflection.value;
  mat.userData.water = true;
  const shore = segmentUniformArray(shoreSegments, WATER_MAX_SHORE_SEGMENTS);
  const beach = segmentUniformArray(beachSegments, WATER_MAX_BEACH_SEGMENTS);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = WATER_TIME;
    shader.uniforms.uShoreSegments = { value: shore };
    shader.uniforms.uShoreCount = { value: Math.min(shoreSegments.length, WATER_MAX_SHORE_SEGMENTS) };
    shader.uniforms.uBeachSegments = { value: beach };
    shader.uniforms.uBeachCount = { value: Math.min(beachSegments.length, WATER_MAX_BEACH_SEGMENTS) };
    shader.uniforms.uBeachWaterline = { value: beachWaterline || 0 };
    shader.uniforms.uSandTint = SAND_TINT;
    shader.uniforms.uWaterSun = WATER_SUN;
    shader.uniforms.uWWField = WW_FIELD;
    tuneUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WATER_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WATER_COLOR_FRAGMENT)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + WATER_NORMAL_FRAGMENT)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uW_glintColor*uWaterSun*waterGlint*uW_glint;');
  };
}
// The water region — every water zone minus the zones above it, plus every river, unioned — and the land beside it that
// gets a sloping beach rather than a wall (every park and beach zone minus the zones above it), plus the beach zones on
// their own (for parks to fade into sand beside them). Cached, and only worked out again when a zone or river changes.
const waterCache = { key: null, region: [], parkArea: [], beachZoneArea: [], shoreLand: [] };
// (the key's a stringify of every zone's points, and everyone walking is checked against the water each frame: so it's
// worked out once a task — a frame — unless something's marked the water dirty since)
let keyChecked = false;
function refreshWaterCache() {
  if (keyChecked && !S.waterDirty) return;
  keyChecked = true;
  queueMicrotask(() => { keyChecked = false; });
  const key = S.riverSeq + '|' + JSON.stringify(S.zones.map(z => (z.drawing || z.points.length < 3) ? null : [z.zoneType, z.points]));
  if (key === waterCache.key) return;
  waterCache.key = key;
  const { ctUnion, ctDifference } = ClipperLib.ClipType;
  const water = S.riverFootprint.slice(), parks = [], beaches = [];
  S.zones.forEach(zone => {
    if (zone.drawing || zone.points.length < 3 || (zone.zoneType !== 'water' && zone.zoneType !== 'park' && zone.zoneType !== 'beach')) return;
    const area = clipPolygons(ctDifference, [App.toClipperPath(tessellateClosedPath(zone.points))], App.zoneOutlinesAbove(zone));
    (zone.zoneType === 'water' ? water : zone.zoneType === 'beach' ? beaches : parks).push(...area);
  });
  waterCache.region = water.length ? clipPolygons(ctUnion, water, []) : [];
  waterCache.parkArea = parks.length || beaches.length ? clipPolygons(ctUnion, parks.concat(beaches), []) : [];
  waterCache.beachZoneArea = beaches.length ? clipPolygons(ctUnion, beaches, []) : [];
  // (the grass and sand that's actually land: a river isn't a zone, so one running through a park is still inside it)
  waterCache.shoreLand = waterCache.parkArea.length && waterCache.region.length ? clipPolygons(ctDifference, waterCache.parkArea, waterCache.region) : waterCache.parkArea;
}
export function getWaterRegion() { refreshWaterCache(); return waterCache.region; }
// Where the water's surface actually shows: the water region less the stretch of beach slope still above the waterline
// (BEACH_WATERLINE out from any park or beach beside it). Cached against the same key as the region.
const sinkCache = { key: null, region: [] };
export function getVisibleWaterRegion() {
  refreshWaterCache();
  if (sinkCache.key === waterCache.key) return sinkCache.region;
  sinkCache.key = waterCache.key;
  const { region, shoreLand } = waterCache;
  sinkCache.region = region.length && shoreLand.length
    ? clipPolygons(ClipperLib.ClipType.ctDifference, region, App.offsetPaths(shoreLand, BEACH_WATERLINE, ClipperLib.JoinType.jtRound))
    : region;
  return sinkCache.region;
}
// Whether a point is over open water: in the visible water (getVisibleWaterRegion) and on none of `decks` — the
// footprints that carry things across it, such as S.roadFootprint for cars, plus S.walkDeck for people. Each
// region's point tester is kept until that region is replaced.
const regionTesters = new WeakMap();
const testerOf = region => { let test = regionTesters.get(region); if (!test) regionTesters.set(region, test = App.createRegionTester(region)); return test; };
export function isOpenWater(x, z, decks) {
  const region = getVisibleWaterRegion();
  return region.length > 0 && testerOf(region)(x, z) && !onAnyDeck(x, z, decks);
}
// Whether a point is on any of `decks` (see isOpenWater).
export const onAnyDeck = (x, z, decks) => decks.some(deck => deck.length && testerOf(deck)(x, z));
export function getBeachZoneArea() { refreshWaterCache(); return waterCache.beachZoneArea; }
// Every park and beach zone (minus the zones above them): all the grass and sand. The same array until it changes.
export function getGrassAndSandArea() { refreshWaterCache(); return waterCache.parkArea; }
// The height of the water's top at a point: null off the water region; along a beach, the slope (falling from
// WATER_BANK_TOP at the grass or sand to WATER_LEVEL at the waterline); otherwise the surface. Shore edges are
// bucketed in a grid (SHORE_CELL), cached against the water key.
const SHORE_CELL = 4, shoreCache = { key: null, grid: new Map() };
function shoreGrid() {
  refreshWaterCache();
  if (shoreCache.key === waterCache.key) return shoreCache.grid;
  shoreCache.key = waterCache.key;
  const grid = shoreCache.grid = new Map(), reach = BEACH_WATERLINE;
  waterCache.shoreLand.forEach(path => path.forEach((a, i) => {
    const b = path[(i+1)%path.length], seg = [a.X/CLIPPER_SCALE, a.Y/CLIPPER_SCALE, b.X/CLIPPER_SCALE, b.Y/CLIPPER_SCALE];
    const x0 = Math.floor((Math.min(seg[0], seg[2]) - reach)/SHORE_CELL), x1 = Math.floor((Math.max(seg[0], seg[2]) + reach)/SHORE_CELL);
    const z0 = Math.floor((Math.min(seg[1], seg[3]) - reach)/SHORE_CELL), z1 = Math.floor((Math.max(seg[1], seg[3]) + reach)/SHORE_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const key = cx + ',' + cz;
      (grid.get(key) ?? grid.set(key, []).get(key)).push(seg);
    }
  }));
  return grid;
}
export function waterTopAt(x, z) {
  const region = getWaterRegion();
  if (!region.length || !testerOf(region)(x, z)) return null;
  const near = shoreGrid().get(Math.floor(x/SHORE_CELL) + ',' + Math.floor(z/SHORE_CELL));
  let d = Infinity;
  near?.forEach(([ax, az, bx, bz]) => {
    const ex = bx - ax, ez = bz - az, len2 = ex*ex + ez*ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax)*ex + (z - az)*ez)/len2)) : 0;
    d = Math.min(d, Math.hypot(x - ax - ex*t, z - az - ez*t));
  });
  return d < BEACH_WATERLINE ? WATER_BANK_TOP - d*(WATER_BANK_TOP - WATER_BANK_BOTTOM)/BEACH_SLOPE_WIDTH : WATER_LEVEL;
}

S.waterGroup = new THREE.Group(); S.waterGroup.name = 'Water'; scene.add(S.waterGroup);
let builtWaterKey = null, builtBridgeKey = null, builtGroundKey = null;
// Brings the water, and the bridges over it, up to date — each only if what it depends on has changed. Called from
// animate() whenever waterDirty is set, so any number of zone and road rebuilds in one go cost one water rebuild.
export function rebuildWater() {
  S.waterDirty = false;
  refreshWaterCache();
  App.attachWalkwayFringes(); // paved walkways' dust follows the grass and sand
  if (builtWaterKey !== waterCache.key) {
    builtWaterKey = waterCache.key;
    buildWaterBody(waterCache.region, waterCache.parkArea);
  }
  const bridgeKey = waterCache.key + '#' + S.roadBuildSeq;
  if (builtGroundKey !== bridgeKey) {
    builtGroundKey = bridgeKey;
    rebuildGround(waterCache.region, S.roadSurfaceOutline);
  }
  if (builtBridgeKey !== bridgeKey) {
    builtBridgeKey = bridgeKey;
    App.buildBridges(waterCache.region);
  }
}
// The ground: one big flat mesh at height 0, with a hole wherever there's water or a (sunk) road surface.
function rebuildGround(region, roadSurface) {
  const S = GROUND_HALF_SIZE*CLIPPER_SCALE;
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, [[{X:-S,Y:-S}, {X:S,Y:-S}, {X:S,Y:S}, {X:-S,Y:S}]], region.concat(roadSurface), true), 0);
  ground.geometry.dispose();
  ground.geometry = builder.build() || new THREE.BufferGeometry();
}
function buildWaterBody(region, parkArea) {
  scene.remove(S.waterGroup); disposeObject(S.waterGroup);
  S.waterGroup = new THREE.Group(); S.waterGroup.name = 'Water';
  if (region.length) {
    const tree = clipPolygons(ClipperLib.ClipType.ctUnion, region, [], true);
    const inPark = App.createRegionTester(parkArea);
    const banks = createMeshBuilder(), beaches = createMeshBuilder();
    const shaderSegments = []; // { a, b, beach } — the shore simplified, for the surface shader
    const drop = WATER_BANK_TOP - WATER_BANK_BOTTOM;
    const visit = node => {
      const raw = node.Contour().map(p => ({ x:p.X/CLIPPER_SCALE, z:p.Y/CLIPPER_SCALE }));
      let area2 = 0;
      raw.forEach((a, i) => { const b = raw[(i+1)%raw.length]; area2 += a.x*b.z - b.x*a.z; });
      const filledOnLeft = (area2 > 0) === !node.IsHole();
      // the contour in pieces of at most 2 units, so a beach can start and stop part-way along an edge
      const pts = [];
      raw.forEach((a, i) => {
        const b = raw[(i+1)%raw.length], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/2));
        for (let k=0;k<steps;k++) pts.push({ x: a.x+(b.x-a.x)*k/steps, z: a.z+(b.z-a.z)*k/steps });
      });
      const count = pts.length;
      const edges = pts.map((a, i) => {
        const b = pts[(i+1)%count], dx = b.x-a.x, dz = b.z-a.z, len = Math.hypot(dx, dz) || 1;
        const out = filledOnLeft ? { x:dz/len, z:-dx/len } : { x:-dz/len, z:dx/len }; // pointing away from the water
        return { a, b, dir: { x:dx/len, z:dz/len }, out, beach: inPark((a.x+b.x)/2 + out.x*0.4, (a.z+b.z)/2 + out.z*0.4) };
      });
      // where a beach's slope reaches out from the vertex at the start of edge i: mitered with the edge before it when that
      // one's a beach too, so neighboring pieces of slope meet without gaps or overlaps
      const reachAt = i => {
        const e = edges[i], prev = edges[(i-1+count)%count];
        const n1 = { x:-e.out.x, z:-e.out.z };
        if (!prev.beach || !e.beach) return n1;
        let mx = n1.x - prev.out.x, mz = n1.z - prev.out.z;
        const ml = Math.hypot(mx, mz);
        if (ml < 1e-3) return n1;
        mx /= ml; mz /= ml;
        const scale = 1/Math.max(0.5, mx*n1.x + mz*n1.z);
        return { x: mx*scale, z: mz*scale };
      };
      edges.forEach((e, i) => {
        const inward = { x:-e.out.x, y:0, z:-e.out.z };
        if (!e.beach) {
          banks.addQuad({ x:e.a.x, y:WATER_BANK_TOP, z:e.a.z }, { x:e.b.x, y:WATER_BANK_TOP, z:e.b.z },
            { x:e.b.x, y:WATER_BANK_BOTTOM, z:e.b.z }, { x:e.a.x, y:WATER_BANK_BOTTOM, z:e.a.z }, inward);
          return;
        }
        const ra = reachAt(i), next = edges[(i+1)%count];
        const rb = next.beach ? reachAt((i+1)%count) : { x:-e.out.x, z:-e.out.z };
        const W = BEACH_SLOPE_WIDTH;
        const normalLen = Math.hypot(drop, W);
        // Shaded as much flatter than it is. Only the top ~2 units of the slope show above the (opaque)
        // water, and at its true pitch that face catches noticeably more sky and less sun than the beach
        // it carries on from, which is what made it read as a grey kerb laid along the shore instead of
        // sand running into the water. Keeping a little of the real tilt leaves it some shape.
        const nx = inward.x*drop/normalLen, ny = W/normalLen, nz = inward.z*drop/normalLen;
        const bx = nx*BEACH_SLOPE_SHADING_TILT, by = ny*BEACH_SLOPE_SHADING_TILT + (1 - BEACH_SLOPE_SHADING_TILT), bz = nz*BEACH_SLOPE_SHADING_TILT;
        const bl = Math.hypot(bx, by, bz);
        const slopeNormal = { x: bx/bl, y: by/bl, z: bz/bl };
        // top at the sand's own height, lit straight up there like it, so no step or crease where they meet
        const topA = { x:e.a.x, y:Y_PARK, z:e.a.z }, topB = { x:e.b.x, y:Y_PARK, z:e.b.z };
        const lowA = { x:e.a.x + ra.x*W, y:WATER_BANK_BOTTOM, z:e.a.z + ra.z*W }, lowB = { x:e.b.x + rb.x*W, y:WATER_BANK_BOTTOM, z:e.b.z + rb.z*W };
        const up = { x:0, y:1, z:0 };
        beaches.addQuad(topA, topB, lowB, lowA, [up, up, slopeNormal, slopeNormal]);
        // close off the side of the slope where the beach gives way to a wall
        const prev = edges[(i-1+count)%count];
        if (!prev.beach) beaches.addQuad(topA, lowA, { x:e.a.x, y:WATER_BANK_BOTTOM, z:e.a.z }, topA, { x:-e.dir.x, y:0, z:-e.dir.z });
        if (!next.beach) beaches.addQuad(topB, { x:e.b.x, y:WATER_BANK_BOTTOM, z:e.b.z }, lowB, topB, { x:e.dir.x, y:0, z:e.dir.z });
      });
      // the shore for the shader: runs of edges of the same kind merged while they stay within 0.25 of a straight line
      let run = null;
      const flush = () => { if (run) shaderSegments.push({ a: run.start, b: run.end, beach: run.beach }); run = null; };
      edges.forEach(e => {
        if (run && run.beach === e.beach && run.inner.length < 64) {
          const inner = run.inner.concat([run.end]);
          if (inner.every(p => distPointSegment(p, run.start, e.b) <= 0.25)) { run.inner = inner; run.end = e.b; return; }
        }
        flush();
        run = { start: e.a, end: e.b, inner: [], beach: e.beach };
      });
      flush();
      node.Childs().forEach(visit);
    };
    tree.Childs().forEach(visit);
    const addBankMesh = (builder, color, name, shader, roughness) => {
      const geo = builder.build();
      if (!geo) return;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: roughness!=null ? roughness : 0.95 });
      if (shader) shader(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.name = name;
      S.waterGroup.add(mesh);
    };
    addBankMesh(banks, WATER_BANK_COLOR, 'WaterBank', applyBankShader);
    // the same wet sand the beach meets the water with, so the slope carries straight on from it
    addBankMesh(beaches, 0xffffff, 'Beach', mat => App.applySandShader(mat, [], true), 1); // fully rough like the flat sand beside it, so it picks up no sheen the beach doesn't have

    // the surface, tile by tile: each tile is the region clipped to its square (rows first, so each square only clips a
    // row's worth of outline), shaded with just the shore within WATER_TILE_MARGIN of it — nearest first if that's still
    // more than the shader's lists hold
    let minX=Infinity, minZ=Infinity, maxX=-Infinity, maxZ=-Infinity;
    region.forEach(path => path.forEach(p => { minX=Math.min(minX,p.X); maxX=Math.max(maxX,p.X); minZ=Math.min(minZ,p.Y); maxZ=Math.max(maxZ,p.Y); }));
    const T = WATER_TILE_SIZE*CLIPPER_SCALE;
    const x0 = Math.floor(minX/T)*T, z0 = Math.floor(minZ/T)*T;
    const rect = (ax, az, bx, bz) => [{X:ax,Y:az}, {X:bx,Y:az}, {X:bx,Y:bz}, {X:ax,Y:bz}];
    const { ctIntersection } = ClipperLib.ClipType;
    const segmentsNear = (list, cx, cz, half, max) => {
      const reach = half + WATER_TILE_MARGIN;
      const near = list.filter(s => Math.max(s.a.x, s.b.x) >= cx-reach && Math.min(s.a.x, s.b.x) <= cx+reach && Math.max(s.a.z, s.b.z) >= cz-reach && Math.min(s.a.z, s.b.z) <= cz+reach);
      if (near.length > max) near.sort((s, t) => distPointSegment({ x:cx, z:cz }, s.a, s.b) - distPointSegment({ x:cx, z:cz }, t.a, t.b));
      return near.slice(0, max).map(s => [s.a.x, s.a.z, s.b.x, s.b.z]);
    };
    const wallList = shaderSegments.filter(s => !s.beach), beachList = shaderSegments.filter(s => s.beach);
    const addSurface = (geo, shore, beach) => {
      const mat = new THREE.MeshStandardMaterial({ color: WATER_COLOR, roughness: 1 });
      applyWaterShader(mat, shore, beach, BEACH_WATERLINE);
      const surface = new THREE.Mesh(geo, mat);
      surface.receiveShadow = true;
      surface.name = 'Water';
      S.waterGroup.add(surface);
    };
    // (tiles out of reach of any shore all shade alike, so they're drawn as one mesh — open sea can be hundreds of tiles)
    const open = [];
    for (let rz = z0; rz < maxZ; rz += T) {
      const row = clipPolygons(ctIntersection, region, [rect(x0, rz, maxX+1, rz+T)]);
      if (!row.length) continue;
      for (let rx = x0; rx < maxX; rx += T) {
        const piece = clipPolygons(ctIntersection, row, [rect(rx, rz, rx+T, rz+T)], true);
        if (!piece.Childs().length) continue;
        const builder = createMeshBuilder();
        builder.addTops(piece, WATER_LEVEL);
        const geo = builder.build();
        if (!geo) continue;
        const cx = (rx + T/2)/CLIPPER_SCALE, cz = (rz + T/2)/CLIPPER_SCALE, half = WATER_TILE_SIZE/2;
        const shore = segmentsNear(wallList, cx, cz, half, WATER_MAX_SHORE_SEGMENTS), beach = segmentsNear(beachList, cx, cz, half, WATER_MAX_BEACH_SEGMENTS);
        if (!shore.length && !beach.length) open.push(geo);
        else addSurface(geo, shore, beach);
      }
    }
    if (open.length) {
      const merged = open.length > 1 ? mergeGeometries(open) : open[0];
      if (open.length > 1) open.forEach(geo => geo.dispose());
      addSurface(merged, [], []);
    }

    // the stencil mask that keeps the grid, map images and walkways from being drawn over the water (see SKIP_OVER_WATER_AND_ROADS)
    const maskBuilder = createMeshBuilder();
    maskBuilder.addTops(tree, Y_MAP);
    S.waterGroup.add(makeStencilMask(maskBuilder.build(), STENCIL_WATER, 'WaterMask'));
  }
  scene.add(S.waterGroup);
}

Object.assign(App, { WATER_COLOR, PARK_BEACH_WIDTH, segmentUniformArray, edgeSegmentsOf, sharedEdgeSegmentsWith, applyWaterShader, getWaterRegion, getBeachZoneArea, getGrassAndSandArea });
