import * as THREE from 'three';
import { S } from '../core/shared.js';
import { computeWindowGlowFactor, SKY_ENV_MAP } from '../core/scene.js';
import { lerp, centroid } from '../core/math.js';

// ---------------------------------------------------------- building windows
// Windows are drawn by a shader on each building's wall material rather than painted into textures. Every wall
// vertex carries where it sits along its stretch of facade and how high it is above the ground (see
// computeFacadeRuns / buildWallGeometry), and the fragment shader lays the windows out from those real
// measurements. That keeps them crisp at any distance (fading to the facade's average tone once they're too small
// to draw, instead of shimmering), costs no texture memory, and makes tidy layouts straightforward:
//  • each stretch of wall between sharp corners gets a whole number of window bays, centered between solid corner
//    piers, so a window never wraps around a corner;
//  • floors are a fixed height measured from the ground, above a taller lobby of storefront glass, and only whole
//    floors fit below a solid parapet band, so floors line up across a building's tiers and between neighbours;
//  • each building picks one facade style (below) and one glass tint;
//  • after dark, windows light in clusters along each floor like offices, in one warm or cool tone per building,
//    some with their blinds half down, and most of the lobby stays lit.
const WINDOW_STYLES = [ // world units at window scale 1; glassW / glassH are fractions of a bay / a floor
  { bay:3.0, glassW:0.46, glassH:0.48, sill:0.27, mullion:0 },   // punched: separate windows in a solid wall
  { bay:3.0, glassW:1.0,  glassH:0.46, sill:0.3,  mullion:1.5 }, // ribbon: continuous horizontal bands of glass
  { bay:1.6, glassW:0.9,  glassH:0.82, sill:0.09, mullion:0 },   // curtain wall: nearly all glass, thin frames
  { bay:2.4, glassW:0.36, glassH:0.94, sill:0.03, mullion:0 },   // strips: tall vertical slots, floor to floor
];
const WINDOW_FLOOR_HEIGHT = 3.5;
const WINDOW_LOBBY_HEIGHT = 4.7;
const WINDOW_PARAPET_HEIGHT = 1.0; // solid band along the top of every wall
const WINDOW_CORNER_PIER = 0.7; // solid wall either side of a sharp corner
const WINDOW_GLASS_TINTS = [0x2e3d4c, 0x2c4247, 0x3b3833, 0x323749]; // blue-grey, teal, bronze, slate
const FACADE_CORNER_COS = Math.cos(30*Math.PI/180); // a bend sharper than 30° ends a stretch of facade
export const WINDOW_TILE_WORLD_SIZE = 7; // world units per UV repeat on building walls (the windows themselves don't use UVs)

// Splits a footprint outline into facade runs — stretches of wall between sharp corners — so windows can be laid
// out per run. Gentle bends (a circle's facets, a rounded corner) don't break a run, so curved walls carry one
// continuous band of windows; an outline with no sharp corner at all is a single closed loop. Returns, for each
// edge i (poly[i] → poly[i+1]): u0, the distance along its run where the edge starts; runLen, the run's length
// (negative for a closed loop); and run, the run's index.
export function computeFacadeRuns(poly) {
  const n = poly.length;
  const lens = [], dirs = [];
  for (let i=0;i<n;i++) {
    const a=poly[i], b=poly[(i+1)%n], dx=b.x-a.x, dz=b.z-a.z, l=Math.hypot(dx, dz);
    lens.push(l);
    dirs.push(l > 1e-6 ? { x:dx/l, z:dz/l } : null);
  }
  // the corner at vertex i sits between edge i-1 and edge i (skipping zero-length edges)
  const incomingDir = i => { for (let k=1;k<=n;k++) { const d = dirs[(i-k+n)%n]; if (d) return d; } return null; };
  const sharp = dirs.map((d, i) => { const d0 = incomingDir(i); return !!(d && d0 && d0.x*d.x + d0.z*d.z < FACADE_CORNER_COS); });
  const edges = new Array(n);
  const start = sharp.indexOf(true);
  if (start < 0) {
    const perimeter = lens.reduce((s, l) => s+l, 0);
    let u = 0;
    for (let i=0;i<n;i++) { edges[i] = { u0:u, runLen:-perimeter, run:0 }; u += lens[i]; }
    return edges;
  }
  let run = -1, runEdges = [];
  const flush = () => {
    const runLen = runEdges.reduce((s, i) => s+lens[i], 0);
    let u = 0;
    runEdges.forEach(i => { edges[i] = { u0:u, runLen, run }; u += lens[i]; });
  };
  for (let k=0;k<n;k++) {
    const i = (start+k)%n;
    if (sharp[i]) { if (runEdges.length) flush(); run++; runEdges = []; }
    runEdges.push(i);
  }
  flush();
  return edges;
}

const WINDOW_VERTEX_PARS = `
  attribute vec4 facade;     // distance along its run, height above ground, run length (negative: closed loop), wall top height
  attribute float facadeRun; // index of the run within its wall outline
  varying vec4 vFacade;
  varying float vFacadeRun;
`;
const WINDOW_FRAGMENT_UNIFORMS = `
  uniform vec4 uWinBay;          // bay width, glass width (fraction of bay), glass height (fraction of floor), sill (fraction of floor)
  uniform vec4 uWinFloor;        // floor height, lobby height, parapet height, corner pier width
  uniform float uWinMullion;     // spacing of thin glazing bars across the glass (0 = none)
  uniform vec3 uWinGlass;        // glass color
  uniform vec2 uWinGlassSurface; // glass roughness, metalness
  uniform vec3 uWinLit;          // lit window color
  uniform vec4 uWinLitMix;       // seed, chance a cluster of windows is lit, window chance in a lit cluster, in a dark one
`;
const WINDOW_FRAGMENT_PARS = WINDOW_FRAGMENT_UNIFORMS + `
  varying vec4 vFacade;
  varying float vFacadeRun;
  float winHash(vec3 p) {
    p = fract(p*vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y)*p.z);
  }
  // 1 inside [a, b] along t, anti-aliased across w (about one pixel's worth of t)
  float winBand(float t, float a, float b, float w) { return clamp(min(t - a, b - t)/w + 0.5, 0.0, 1.0); }
`;
const WINDOW_FRAGMENT_LAYOUT = `
  float winGlass = 0.0, winLit = 0.0;
  vec3 winLitColor = vec3(0.0);
  {
    float runLen = abs(vFacade.z);
    float pier = vFacade.z < 0.0 ? 0.0 : uWinFloor.w; // a closed loop (round tower) has no corners
    float usable = runLen - 2.0*pier;
    float bays = floor(usable/uWinBay.x + 0.5);
    if (runLen > 0.0 && bays >= 1.0) {
      float bay = usable/bays;
      float floorH = uWinFloor.x, lobbyH = uWinFloor.y;
      float x = vFacade.x - pier, z = vFacade.y;
      float top = vFacade.w - uWinFloor.z;
      // one pixel's footprint in world units — capped, so the jump in x at a corner can't smear a band across it
      float wx = min(max(fwidth(vFacade.x), 1e-4), 0.25*bay);
      float wz = min(max(fwidth(vFacade.y), 1e-4), 0.25*floorH);
      float bayIdx = floor(x/bay);
      float xb = x - bayIdx*bay;
      float inRun = winBand(x, 0.0, usable, wx);
      float halfW = 0.5*uWinBay.y*bay;
      float cols = uWinBay.y > 0.999 ? 1.0 : winBand(xb, 0.5*bay - halfW, 0.5*bay + halfW, wx);
      float bars = uWinMullion > 0.0 ? winBand(mod(x, uWinMullion), 0.04, uWinMullion - 0.04, wx) : 1.0;
      // upper floors: whole floors only, all below the parapet
      float floorIdx = floor((z - lobbyH)/floorH);
      float zf = z - lobbyH - floorIdx*floorH;
      float floorsFit = floor((top - lobbyH)/floorH);
      float upperRow = step(0.0, floorIdx)*step(floorIdx + 1.0, floorsFit);
      float sill = uWinBay.w*floorH, head = (uWinBay.w + uWinBay.z)*floorH;
      float upper = cols*upperRow*winBand(zf, sill, head, wz);
      // lobby: a band of wide storefront glass
      float storeHalfW = 0.5*max(uWinBay.y, 0.82)*bay;
      float store = winBand(xb, 0.5*bay - storeHalfW, 0.5*bay + storeHalfW, wx)*winBand(z, 0.08*lobbyH, min(0.78*lobbyH, top), wz);
      float exact = inRun*bars*max(upper, store);
      // once a window is only a few pixels across, draw the facade's average tone instead of aliasing
      float lod = smoothstep(0.12, 0.35, max(wx/bay, wz/floorH));
      float coverage = inRun*step(z, top)*uWinBay.y*uWinBay.z;
      winGlass = mix(exact, coverage, lod);
      // after dark: windows light in clusters of bays along each floor, and some blinds are half down
      float cluster = floor(bayIdx/4.0);
      float clusterLit = step(winHash(vec3(uWinLitMix.x, vFacadeRun*7.0 + cluster, floorIdx)), uWinLitMix.y);
      float pick = winHash(vec3(bayIdx + vFacadeRun*131.0, floorIdx, uWinLitMix.x));
      float on = step(pick, mix(uWinLitMix.w, uWinLitMix.z, clusterLit));
      float blind = winHash(vec3(pick*91.0, floorIdx + 3.0, bayIdx)) < 0.3 ? 0.55 : 1.0;
      float upperLit = on*cols*upperRow*winBand(zf, sill, sill + (head - sill)*blind, wz);
      float storeLit = store*step(winHash(vec3(bayIdx + vFacadeRun*131.0, 91.0, uWinLitMix.x)), 0.85);
      float litAverage = coverage*mix(uWinLitMix.w, uWinLitMix.z, uWinLitMix.y);
      winLit = mix(inRun*bars*max(upperLit, storeLit), litAverage, lod);
      winLitColor = uWinLit*(0.7 + 0.6*winHash(vec3(floorIdx, cluster + vFacadeRun*17.0, uWinLitMix.x + 5.0)));
    }
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, uWinGlass, winGlass);
`;
// The wall material for one building with windows. All of its randomness comes from texRng, the building's
// isolated window sub-generator, so window settings never shift any other part of the city's layout.
export function createWindowMaterial(color, texRng, lit, litIntensity, windowScale, specular) {
  const scale = windowScale!=null ? windowScale : 1;
  const style = WINDOW_STYLES[Math.floor(texRng()*WINDOW_STYLES.length)];
  const glass = new THREE.Color(WINDOW_GLASS_TINTS[Math.floor(texRng()*WINDOW_GLASS_TINTS.length)]).lerp(color, 0.2);
  const warm = texRng() < 0.7; // mostly warm (lamp-lit) interiors, occasionally cool (screen-lit)
  const uniforms = {
    uWinBay: { value: new THREE.Vector4(style.bay*scale*(0.9 + texRng()*0.25), style.glassW, style.glassH, style.sill) },
    uWinFloor: { value: new THREE.Vector4(WINDOW_FLOOR_HEIGHT*scale, WINDOW_LOBBY_HEIGHT*scale, WINDOW_PARAPET_HEIGHT*scale, WINDOW_CORNER_PIER*scale) },
    uWinMullion: { value: style.mullion*scale },
    uWinGlass: { value: glass },
    uWinGlassSurface: { value: new THREE.Vector2(specular ? 0.08 : 0.3, specular ? 0.3 : 0.1) },
    uWinLit: { value: warm ? new THREE.Color(1.0, 0.76, 0.45) : new THREE.Color(0.62, 0.82, 1.0) },
    uWinLitMix: { value: new THREE.Vector4(Math.floor(texRng()*1000), 0.35 + texRng()*0.3, 0.85, 0.06) },
  };
  // "Specular windows": the cheapest plausible glass look — the shared tiny sky CubeTexture as envMap (repainted
  // for everyone at once by updateSkyEnvMap), with only the glass itself made glossy by the shader. Built from the
  // same colors driving the sky dome, the reflection dims right alongside a real sunset, letting the emissive glow
  // take over at night.
  const mat = new THREE.MeshStandardMaterial({ color, vertexColors:true, roughness:0.85, metalness:0.05, flatShading:true, side:THREE.DoubleSide,
    envMap: specular ? SKY_ENV_MAP : null, envMapIntensity: 1.3,
    emissive: lit ? 0xffffff : 0x000000, emissiveIntensity: litIntensity*computeWindowGlowFactor(S.sunElevation) });
  // tracked so updateWindowGlowForSun can rescale the glow live as the sun elevation slider moves
  if (lit) mat.userData.baseEmissiveIntensity = litIntensity;
  mat.userData.litColor = uniforms.uWinLit.value; // (what its lit lobby spills onto the pavement: see sky/streetlights.js)
  mat.userData.windowUniforms = uniforms; // (what a zone's merged walls carry on their vertices instead: see building-batches.js)
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_VERTEX_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade; vFacadeRun = facadeRun;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WINDOW_FRAGMENT_LAYOUT)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, uWinGlassSurface.x, winGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, uWinGlassSurface.y, winGlass);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= winLitColor*winLit;');
  };
  return mat;
}
// The same walls merged across many buildings (see building-batches.js): what createWindowMaterial keeps in uniforms,
// one building's worth, rides on every vertex instead — flat, so it's the exact number, not one interpolated across a
// triangle (the seed is hashed) — and the shader reads it back under the uniforms' own names. The glow is the lit
// intensity on the vertex times the material's emissiveIntensity, which the sun scales like any other glow.
const WINDOW_BATCH_VERTEX_PARS = WINDOW_VERTEX_PARS + `
  attribute vec4 winBay;
  attribute vec4 winFloor;
  attribute vec4 winGlass;  // glass color, mullion spacing
  attribute vec4 winLit;    // lit color, lit intensity (0: never lit)
  attribute vec4 winLitMix;
  flat varying vec4 vWinBay;
  flat varying vec4 vWinFloor;
  flat varying vec4 vWinGlass;
  flat varying vec4 vWinLit;
  flat varying vec4 vWinLitMix;
`;
const WINDOW_BATCH_FRAGMENT_PARS = WINDOW_FRAGMENT_PARS.replace(WINDOW_FRAGMENT_UNIFORMS, `
  uniform vec2 uWinGlassSurface;
  flat varying vec4 vWinBay;
  flat varying vec4 vWinFloor;
  flat varying vec4 vWinGlass;
  flat varying vec4 vWinLit;
  flat varying vec4 vWinLitMix;
  #define uWinBay vWinBay
  #define uWinFloor vWinFloor
  #define uWinMullion vWinGlass.w
  #define uWinGlass vWinGlass.rgb
  #define uWinLit vWinLit.rgb
  #define uWinLitMix vWinLitMix
`);
export function createBatchedWindowMaterial(specular, side) {
  const glassSurface = { value: new THREE.Vector2(specular ? 0.08 : 0.3, specular ? 0.3 : 0.1) };
  const mat = new THREE.MeshStandardMaterial({ color:0xffffff, vertexColors:true, roughness:0.85, metalness:0.05, flatShading:true, side,
    envMap: specular ? SKY_ENV_MAP : null, envMapIntensity: 1.3,
    emissive: 0xffffff, emissiveIntensity: computeWindowGlowFactor(S.sunElevation) });
  mat.userData.baseEmissiveIntensity = 1;
  mat.onBeforeCompile = shader => {
    shader.uniforms.uWinGlassSurface = glassSurface;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_BATCH_VERTEX_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade; vFacadeRun = facadeRun; vWinBay = winBay; vWinFloor = winFloor; vWinGlass = winGlass; vWinLit = winLit; vWinLitMix = winLitMix;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_BATCH_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WINDOW_FRAGMENT_LAYOUT)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, uWinGlassSurface.x, winGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, uWinGlassSurface.y, winGlass);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= vWinLit.w*winLitColor*winLit;');
  };
  mat.customProgramCacheKey = () => 'batchedWindows';
  return mat;
}
export function mergeGeometries(geoA, geoB) {
  const posA=geoA.attributes.position, posB=geoB.attributes.position;
  const normA=geoA.attributes.normal, normB=geoB.attributes.normal;
  const uvA=geoA.attributes.uv, uvB=geoB.attributes.uv;
  const colA=geoA.attributes.color, colB=geoB.attributes.color;
  const countA=posA.count, countB=posB.count;
  const positions = new Float32Array((countA+countB)*3); positions.set(posA.array,0); positions.set(posB.array,countA*3);
  const normals = new Float32Array((countA+countB)*3); normals.set(normA.array,0); normals.set(normB.array,countA*3);
  const uvs = new Float32Array((countA+countB)*2); uvs.set(uvA.array,0); uvs.set(uvB.array,countA*2);
  const colors = new Float32Array((countA+countB)*3); colors.set(colA.array,0); colors.set(colB.array,countA*3);
  const idxA = geoA.index ? Array.from(geoA.index.array) : [...Array(countA).keys()];
  const idxB = (geoB.index ? Array.from(geoB.index.array) : [...Array(countB).keys()]).map(i=>i+countA);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals,3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs,2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors,3));
  geo.setIndex(idxA.concat(idxB));
  return geo;
}
// Merges plain (uncolored) primitive geometries — BoxGeometry, CylinderGeometry, etc. — that
// have already been transformed (rotate/translate baked in via BufferGeometry.rotateX/
// translate/etc.) into their final local positions. Used to fold many small repeated detail
// pieces (ribs, balcony ledges) into one mesh per building instead of one mesh each, so
// building count doesn't multiply into a much larger object count.
export function mergeGeometryList(geoList) {
  let totalPos=0, totalIdx=0;
  geoList.forEach(g => { totalPos += g.attributes.position.count; totalIdx += (g.index ? g.index.count : g.attributes.position.count); });
  const positions = new Float32Array(totalPos*3);
  const normals = new Float32Array(totalPos*3);
  const uvs = new Float32Array(totalPos*2);
  const indices = new Array(totalIdx);
  let posOffset=0, idxOffset=0;
  geoList.forEach(g => {
    const pos=g.attributes.position, norm=g.attributes.normal, uv=g.attributes.uv;
    positions.set(pos.array, posOffset*3);
    if (norm) normals.set(norm.array, posOffset*3);
    if (uv) uvs.set(uv.array, posOffset*2);
    const idx = g.index ? g.index.array : null;
    const count = idx ? idx.length : pos.count;
    for (let i=0;i<count;i++) indices[idxOffset+i] = (idx ? idx[i] : i) + posOffset;
    idxOffset += count;
    posOffset += pos.count;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals,3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs,2));
  geo.setIndex(indices);
  return geo;
}
export function extractCapGeometry(sourceGeo) {
  // pulls out just the roof/floor-cap triangles (identified by their normal pointing along
  // the extrusion axis) from a default ExtrudeGeometry, with a fixed UV and a darker baked-in
  // tint. Caps always use a building's plain material — windows only ever go on walls.
  const cu = 0.02, cv = 0.02;
  const pos = sourceGeo.attributes.position, norm = sourceGeo.attributes.normal;
  const index = sourceGeo.index;
  const isCap = i => Math.abs(norm.getZ(i)) > 0.5;
  const tris = index ? index.count/3 : pos.count/3;
  const positions=[], normals=[];
  for (let t=0;t<tris;t++) {
    const a = index ? index.getX(t*3) : t*3, b = index ? index.getX(t*3+1) : t*3+1, c = index ? index.getX(t*3+2) : t*3+2;
    if (isCap(a) && isCap(b) && isCap(c)) {
      [a,b,c].forEach(idx => {
        positions.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
        normals.push(norm.getX(idx), norm.getY(idx), norm.getZ(idx));
      });
    }
  }
  const n = positions.length/3;
  const uvs = new Float32Array(n*2);
  for (let i=0;i<n;i++) { uvs[i*2]=cu; uvs[i*2+1]=cv; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals,3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n*3).fill(0.72),3));
  return geo;
}
export function buildWallGeometry(poly, height, gradient, tileSize, facadeBase) {
  // one quad per polygon edge, with exact real-world arc-length UVs (no wraparound seam,
  // since U just keeps increasing around the perimeter instead of wrapping through an angle).
  // `gradient` (optional) is {c0:[r,g,b], c1:[r,g,b]} tinting bottom->top, for a subtle
  // anodized-metal shade (or a more saturated iridescent one) instead of flat white.
  // `facadeBase` (optional): the height above the ground this wall starts at — when given, the
  // geometry also carries the facade attributes the window shader lays windows out from.
  const g0 = (gradient && gradient.c0) || [0.86,0.86,0.86];
  const g1 = (gradient && gradient.c1) || [1.06,1.06,1.06];
  const n = poly.length;
  const c = centroid(poly), clx=c.x, cly=-c.z;
  const s = 1/(tileSize || WINDOW_TILE_WORLD_SIZE);
  const runs = facadeBase!=null ? computeFacadeRuns(poly) : null;
  const positions=[], normals=[], uvs=[], colors=[], indices=[], facade=[], facadeRun=[];
  let cum = 0;
  for (let i=0;i<n;i++) {
    const pa=poly[i], pb=poly[(i+1)%n];
    const ax=pa.x, ay=-pa.z, bx=pb.x, by=-pb.z;
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy)||1;
    let nx=dy/len, ny=-dx/len;
    const midx=(ax+bx)/2, midy=(ay+by)/2;
    const isOutward = ((midx-clx)*nx + (midy-cly)*ny) >= 0;
    if (!isOutward) { nx=-nx; ny=-ny; }
    const u0=cum*s, u1=(cum+len)*s; cum += len;
    const v0=0, v1=height*s;
    const base = positions.length/3;
    positions.push(ax,ay,0, bx,by,0, bx,by,height, ax,ay,height);
    normals.push(nx,ny,0, nx,ny,0, nx,ny,0, nx,ny,0);
    uvs.push(u0,v0, u1,v0, u1,v1, u0,v1);
    colors.push(g0[0],g0[1],g0[2], g0[0],g0[1],g0[2], g1[0],g1[1],g1[2], g1[0],g1[1],g1[2]);
    if (runs) {
      const { u0:fa, runLen, run } = runs[i], fb = fa + Math.hypot(dx,dy), top = facadeBase + height;
      facade.push(fa,facadeBase,runLen,top, fb,facadeBase,runLen,top, fb,top,runLen,top, fa,top,runLen,top);
      facadeRun.push(run, run, run, run);
    }
    if (isOutward) indices.push(base,base+1,base+2, base,base+2,base+3);
    else indices.push(base,base+2,base+1, base,base+3,base+2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals,3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  if (runs) {
    geo.setAttribute('facade', new THREE.Float32BufferAttribute(facade,4));
    geo.setAttribute('facadeRun', new THREE.Float32BufferAttribute(facadeRun,1));
  }
  geo.setIndex(indices);
  return geo;
}
export function buildWedgeCapGeometry(poly, baseH, minTop, maxTop, dirAngle, tileSize) {
  // walls rising from baseH to a top edge that slants linearly along dirAngle (cantilevered/
  // angled-roof archetype), capped with a fan roof following that same slant.
  const n = poly.length;
  const c = centroid(poly);
  let minProj=Infinity, maxProj=-Infinity;
  const proj = poly.map(p => {
    const v = (p.x-c.x)*Math.cos(dirAngle) + (p.z-c.z)*Math.sin(dirAngle);
    if (v<minProj) minProj=v; if (v>maxProj) maxProj=v;
    return v;
  });
  const span = (maxProj-minProj) || 1;
  const topZ = poly.map((p,i) => baseH + lerp(minTop, maxTop, (proj[i]-minProj)/span));
  const s = 1/(tileSize || WINDOW_TILE_WORLD_SIZE);
  const clx=c.x, cly=-c.z;
  // facade attributes for the window shader: walls run from baseH up to their own slanted top; the roof has none
  const runs = computeFacadeRuns(poly);
  const positions=[], normals=[], uvs=[], colors=[], indices=[], facade=[], facadeRun=[];
  let cum=0;
  for (let i=0;i<n;i++) {
    const pa=poly[i], pb=poly[(i+1)%n];
    const ax=pa.x, ay=-pa.z, bx=pb.x, by=-pb.z;
    const za=topZ[i], zb=topZ[(i+1)%n];
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy)||1;
    let nx=dy/len, ny=-dx/len;
    const midx=(ax+bx)/2, midy=(ay+by)/2;
    const isOutward = ((midx-clx)*nx + (midy-cly)*ny) >= 0;
    if (!isOutward) { nx=-nx; ny=-ny; }
    const u0=cum*s, u1=(cum+len)*s; cum += len;
    const base = positions.length/3;
    positions.push(ax,ay,baseH, bx,by,baseH, bx,by,zb, ax,ay,za);
    normals.push(nx,ny,0, nx,ny,0, nx,ny,0, nx,ny,0);
    uvs.push(u0,0, u1,0, u1,(zb-baseH)*s, u0,(za-baseH)*s);
    colors.push(0.9,0.9,0.9, 0.9,0.9,0.9, 1.08,1.08,1.08, 1.08,1.08,1.08);
    const { u0:fa, runLen, run } = runs[i], fb = fa + Math.hypot(dx,dy);
    facade.push(fa,baseH,runLen,za, fb,baseH,runLen,zb, fb,zb,runLen,zb, fa,za,runLen,za);
    facadeRun.push(run, run, run, run);
    if (isOutward) indices.push(base,base+1,base+2, base,base+2,base+3);
    else indices.push(base,base+2,base+1, base,base+3,base+2);
  }
  const capBase = positions.length/3;
  positions.push(c.x, -c.z, topZ.reduce((a,b)=>a+b,0)/n);
  normals.push(0,0,1); uvs.push(0.02,0.02); colors.push(0.72,0.72,0.72); facade.push(0,0,0,0); facadeRun.push(0);
  for (let i=0;i<n;i++) { positions.push(poly[i].x,-poly[i].z,topZ[i]); normals.push(0,0,1); uvs.push(0.02,0.02); colors.push(0.72,0.72,0.72); facade.push(0,0,0,0); facadeRun.push(0); }
  for (let i=0;i<n;i++) { indices.push(capBase, capBase+1+i, capBase+1+((i+1)%n)); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals,3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  geo.setAttribute('facade', new THREE.Float32BufferAttribute(facade,4));
  geo.setAttribute('facadeRun', new THREE.Float32BufferAttribute(facadeRun,1));
  geo.setIndex(indices);
  return geo;
}
