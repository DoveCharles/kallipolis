import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, SKIP_OVER_WATER_AND_ROADS, makeStencilMask, STENCIL_ROAD, Y_PATH, Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { distPointSegment } from '../buildings/footprints.js';
import { tessellateOpenPath, ROAD_COLOR } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { buildRaisedWalkway, isRaisedWalkwayLine } from './raised.js';
import { kerbDrops, kerbDropMesh } from '../zones/carpark.js';
import { CURB_COLOR, SIDEWALK_COLOR, CLIPPER_SCALE, roadLineWidths, unionRoadStrokes, clipPolygons, createMeshBuilder, forEachPolyTreeEdge, createEdgeIndex, addRoadLayerMesh, disposeObject } from './roads.js';

// ---------------------------------------------------------- walkways
// A road network can be a walkway instead of a sidewalk road: no curb or raised sidewalk, just a flat surface laid over
// whatever's underneath, which pedestrians walk and which keeps lots, buildings and trees off it (see pathFootprint).
// Walkways don't cut holes in zone ground or park grass. Its texture is paving of some kind, a plain color, or dirt: a
// sandy, speckled track whose edge wanders in and out a little and fades away softly instead of stopping at a hard line.
export const WALKWAY_COLOR = 0xb0ac9f;
export const DIRT_COLOR = 0xb09973; // kept near the grass's brightness, so dirt reads as sand on the ground rather than a glowing stripe
export const WALKWAY_COLOR_PALETTE = [WALKWAY_COLOR, DIRT_COLOR]; // user-extendable palette; grows via the '+' swatch
// the textures a walkway can have (set per network in the details panel); for the paving ones, the index is the paving
// shader's uWalkPattern — dirt has a shader of its own
export const WALKWAY_TEXTURES = [
  { id: 'plain', label: 'Plain' },
  { id: 'planks', label: 'Wood planks' },
  { id: 'cobblestone', label: 'Cobblestone' },
  { id: 'tiles', label: 'Tiles' },
  { id: 'brick', label: 'Brick' },
  { id: 'dirt', label: 'Dirt' },
];
export const WALKWAY_TEXTURE = 'plain';
// The texture scale a walkway starts at, before anyone touches the slider. Dirt's speckle and the
// wander of its edge are a far bigger pattern than any of the paving ones, so at the same scale as
// brick or planks a dirt path reads as a wide, blotchy smear: it starts at a quarter of the size.
export function defaultWalkwayTextureScale(texture) { return texture === 'dirt' ? 0.25 : 1; }
// A line's texture scale, falling back to its texture's own default when it has never been set —
// lines saved before this default existed carry an explicit scale, so they keep the look they had.
export function walkwayTextureScaleOf(line) {
  return line.walkwayTextureScale ?? defaultWalkwayTextureScale(line.walkwayTexture || WALKWAY_TEXTURE);
}
const PATH_MAX_SEGMENTS = 128; // fixed GLSL array size; a network's centerlines are simplified to fit
// (a raised walkway is a walkway too — it has a walkway's color and paving — but see isRaisedWalkwayLine for where it isn't)
export function isWalkwayLine(line) { return line.roadType === 'walkway' || line.roadType === 'raised'; }
export function isGroundWalkwayLine(line) { return line.roadType === 'walkway'; }
export function isRiverLine(line) { return line.roadType === 'river'; }
export function isMallLine(line) { return line.roadType === 'mall'; } // (see roads/mall.js)
// how far past its nominal edge dirt's sand fades out
export function pathFadeWidth(halfWidth) { return Math.min(2.5, halfWidth*0.9); }
// Ramer–Douglas–Peucker: the fewest of `points` that keep the line within `tolerance` of its original course
function simplifyPolyline(points, tolerance) {
  if (points.length <= 2) return points;
  const a = points[0], b = points[points.length-1];
  let worst = 0, index = 0;
  for (let i=1;i<points.length-1;i++) { const d = distPointSegment(points[i], a, b); if (d > worst) { worst = d; index = i; } }
  if (worst <= tolerance) return [a, b];
  return simplifyPolyline(points.slice(0, index+1), tolerance).slice(0, -1).concat(simplifyPolyline(points.slice(index), tolerance));
}
// a network's centerlines as world-space segments [ax, az, bx, bz], simplified until they fit the shader's list
export function pathSegmentsOf(lines) {
  const polylines = lines.map(line => tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean)));
  const countSegments = pls => pls.reduce((sum, pl) => sum + Math.max(0, pl.length-1), 0);
  let simplified = polylines;
  for (let tolerance = 0.1; countSegments(simplified) > PATH_MAX_SEGMENTS && tolerance < 64; tolerance *= 2) {
    simplified = polylines.map(pl => simplifyPolyline(pl, tolerance));
  }
  const segments = [];
  simplified.forEach(pl => { for (let i=0;i<pl.length-1;i++) segments.push([pl[i].x, pl[i].z, pl[i+1].x, pl[i+1].z]); });
  return segments.slice(0, PATH_MAX_SEGMENTS);
}
const PATH_FRAGMENT_PARS = `
  #define PATH_MAX_SEGMENTS ${PATH_MAX_SEGMENTS}
  varying vec3 vPathWorldPos;
  uniform vec4 uPathSegments[PATH_MAX_SEGMENTS];
  uniform int uPathSegmentCount;
  uniform float uPathHalfWidth;
  uniform float uPathFade;
  uniform float uPathScale;
  float pathHash(vec2 p) { p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float pathNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = pathHash(i), b = pathHash(i+vec2(1.0,0.0)), c = pathHash(i+vec2(0.0,1.0)), d = pathHash(i+vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
`;
const PATH_COLOR_FRAGMENT = `
  {
    vec2 wp = vPathWorldPos.xz;
    float d = 1e9;
    for (int i=0; i<PATH_MAX_SEGMENTS; i++) {
      if (i >= uPathSegmentCount) break;
      vec4 s = uPathSegments[i];
      vec2 pa = wp - s.xy, ba = s.zw - s.xy;
      float h = clamp(dot(pa, ba)/max(dot(ba, ba), 1e-6), 0.0, 1.0);
      d = min(d, length(pa - ba*h));
    }
    vec2 np = wp/uPathScale; // the noise, not the width, follows the texture scale
    float coarse = pathNoise(np*0.3);
    // Stylized: flat bands of tone rather than a smooth smear. The edge wanders a little, and past it the dirt breaks
    // into crisp clumps (noise thresholded against how far into the fade each point is) instead of fading.
    float edge = uPathHalfWidth*(0.85 + 0.3*coarse);
    float fadeT = smoothstep(edge - uPathFade*0.5, edge + uPathFade*0.5, d)*1.3 - 0.15;
    float clump = 0.65*pathNoise(np*2.2) + 0.35*pathNoise(np*6.0);
    float aaC = max(fwidth(clump - fadeT), 1e-4);
    float cover = 1.0 - smoothstep(-aaC, aaC, fadeT - clump);
    // three tones from banded low-frequency noise, borders softened by a pixel
    float n = 0.6*pathNoise(np*0.55) + 0.4*pathNoise(np*1.7 + 7.3);
    float aaN = max(fwidth(n), 1e-4);
    float tone = 0.9 + 0.1*smoothstep(0.42 - aaN, 0.42 + aaN, n) + 0.08*smoothstep(0.62 - aaN, 0.62 + aaN, n);
    // a worn, lighter strip down the middle and a darker rim where it meets the ground
    float rel = d/max(edge, 1e-3);
    float aaR = max(fwidth(rel), 1e-4);
    tone *= mix(1.06, 1.0, smoothstep(0.45 - aaR, 0.45 + aaR, rel));
    tone *= mix(1.0, 0.86, smoothstep(0.82 - aaR, 0.82 + aaR, rel)*(1.0 - smoothstep(1.15, 1.35, rel)));
    // scattered pebbles: flat dots in a jittered grid, some lighter, some darker, each with a little shadow below
    vec2 pq = np*1.6, pc = floor(pq), pf = fract(pq);
    float ph = pathHash(pc + 3.1);
    if (ph < 0.35) {
      vec2 c = 0.25 + 0.5*vec2(pathHash(pc + 11.7), pathHash(pc + 23.9));
      float r = 0.07 + 0.07*pathHash(pc + 41.3);
      float pd = length((pf - c)*vec2(1.0, 1.3)) - r;
      float sd = length((pf - c - vec2(0.03, 0.035))*vec2(1.0, 1.3)) - r;
      float aaP = max(fwidth(pd), 1e-4);
      tone *= mix(0.8, 1.0, smoothstep(-aaP, aaP, sd));
      tone = mix(tone, ph < 0.2 ? 1.2 : 0.82, 1.0 - smoothstep(-aaP, aaP, pd));
    }
    vec3 sand = diffuseColor.rgb*tone;
    diffuseColor = vec4(sand, diffuseColor.a*cover);
  }
`;
export function applyPathShader(mat, segments, halfWidth, fade, scale) {
  const segmentUniforms = App.segmentUniformArray(segments, PATH_MAX_SEGMENTS);
  const uniforms = mat.userData.pathUniforms = { uPathScale: { value: scale || 1 } }; // kept so setWalkwayLook can change it live
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPathSegments = { value: segmentUniforms };
    shader.uniforms.uPathSegmentCount = { value: segments.length };
    shader.uniforms.uPathHalfWidth = { value: halfWidth };
    shader.uniforms.uPathFade = { value: fade };
    shader.uniforms.uPathScale = uniforms.uPathScale;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPathWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPathWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PATH_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PATH_COLOR_FRAGMENT);
  };
}
// Walkway paving, drawn in world space like a plaza's so the pattern runs on unbroken along the whole network. Each
// pattern works out, for the point being shaded, which piece (plank, stone, tile, brick) it's on and how far it is from
// that piece's edge: pieces get a slight tint of their own and the gaps between them are darkened. Everything is
// measured in pattern space — world space turned by the rotation and shrunk by the scale — so the gaps scale too.
const WALKWAY_FRAGMENT_PARS = `
  varying vec3 vWalkWorldPos;
  uniform int uWalkPattern;
  uniform float uWalkScale;
  uniform vec2 uWalkRotation; // (cos, sin)
  float walkHash(vec2 p) { p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float walkNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = walkHash(i), b = walkHash(i+vec2(1.0,0.0)), c = walkHash(i+vec2(0.0,1.0)), d = walkHash(i+vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
  #ifdef WALK_EDGE
  #define WALK_MAX_SEGMENTS ${PATH_MAX_SEGMENTS}
  uniform vec4 uWalkSegments[WALK_MAX_SEGMENTS];
  uniform int uWalkSegmentCount;
  uniform float uWalkHalfWidth;
  uniform float uWalkFringe;
  #endif
`;
const WALKWAY_COLOR_FRAGMENT = `
  vec3 walkBase = diffuseColor.rgb;
  if (uWalkPattern != 0) {
    vec2 w = vWalkWorldPos.xz;
    vec2 p = vec2(uWalkRotation.x*w.x + uWalkRotation.y*w.y, uWalkRotation.x*w.y - uWalkRotation.y*w.x)/uWalkScale;
    float edgeDist = 1.0, tint = 1.0, gapLo = 0.03, gapHi = 0.08, gapShade = 0.62;
    if (uWalkPattern == 1) {
      // wood planks: long boards along x, each one flat shade, each row's joints staggered at random
      float boardW = 0.3, boardL = 3.0;
      float row = floor(p.y/boardW);
      float u = p.x/boardL + walkHash(vec2(row, 3.7));
      vec2 id = vec2(floor(u), row), f = vec2(fract(u), fract(p.y/boardW));
      edgeDist = min(min(f.x, 1.0-f.x)*boardL, min(f.y, 1.0-f.y)*boardW);
      tint = 0.76 + 0.3*walkHash(id + 5.0);
      gapLo = 0.008; gapHi = 0.022; gapShade = 0.4;
    } else if (uWalkPattern == 2) {
      // cobblestones: a jittered grid of stones (Voronoi cells), each one flat shade, with a crisp gap between
      float size = 0.5;
      vec2 q = p/size, iq = floor(q), fq = fract(q);
      float f1 = 8.0, f2 = 8.0;
      vec2 id = vec2(0.0);
      for (int j=-1; j<=1; j++) for (int i=-1; i<=1; i++) {
        vec2 g = vec2(float(i), float(j)), cell = iq + g;
        vec2 r = g + 0.15 + 0.7*vec2(walkHash(cell), walkHash(cell + 19.7)) - fq;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; id = cell; } else if (d < f2) { f2 = d; }
      }
      edgeDist = (sqrt(f2) - sqrt(f1))*0.5*size;
      tint = 0.72 + 0.36*walkHash(id + 7.0);
      float aa = max(fwidth(edgeDist), 1e-4); // (the gap's edge a pixel wide, not a blend across the stone)
      gapLo = 0.028 - 0.5*aa; gapHi = 0.028 + 0.5*aa; gapShade = 0.45;
    } else if (uWalkPattern == 3) {
      // square tiles, as on a plaza
      float size = 2.4;
      vec2 f = fract(p/size);
      edgeDist = min(min(f.x, 1.0-f.x), min(f.y, 1.0-f.y))*size;
      tint = 0.9 + 0.2*walkHash(floor(p/size) + 17.0);
    } else {
      // brick: 2:1 bricks in running bond, each course shifted half a brick from the last
      float brickL = 0.44, brickW = 0.22;
      float row = floor(p.y/brickW);
      float u = p.x/brickL + 0.5*mod(row, 2.0);
      vec2 id = vec2(floor(u), row), f = vec2(fract(u), fract(p.y/brickW));
      edgeDist = min(min(f.x, 1.0-f.x)*brickL, min(f.y, 1.0-f.y)*brickW);
      tint = 0.82 + 0.3*walkHash(id + 11.0);
      gapLo = 0.01; gapHi = 0.025; gapShade = 0.55;
    }
    diffuseColor.rgb *= mix(gapShade, tint, smoothstep(gapLo, gapHi, edgeDist));
  }
  #ifdef WALK_EDGE
  {
    // A ground walkway doesn't just stop where the paving does. Its last stretch is an edging course: a band of
    // darker stones laid flush with the paving, not raised, following the line with a grout joint on its inside and
    // cross joints that divide each centerline segment evenly (so on a curve they fan out at every bend). Grime off
    // the ground darkens the outer part of the walkway, and past the edge, dust the paving has shed thins out grain
    // by grain over the fringe, so it fades into the ground instead of stopping at a line.
    vec2 w = vWalkWorldPos.xz;
    float d = 1e9, along = 0.0, pieceLen = 1.0, seg = 0.0;
    for (int i=0; i<WALK_MAX_SEGMENTS; i++) {
      if (i >= uWalkSegmentCount) break;
      vec4 s = uWalkSegments[i];
      vec2 pa = w - s.xy, ba = s.zw - s.xy;
      float len = max(length(ba), 1e-4);
      float h = clamp(dot(pa, ba)/(len*len), 0.0, 1.0);
      float di = length(pa - ba*h);
      if (di < d) { d = di; along = h*len; pieceLen = len/max(1.0, floor(len/0.8 + 0.5)); seg = float(i); }
    }
    float border = min(0.3, uWalkHalfWidth*0.15), inner = uWalkHalfWidth - border;
    float n = walkNoise(w*1.3), fine = walkNoise(w*7.0);
    float piece = floor(along/pieceLen), f = fract(along/pieceLen);
    float joint = min(min(f, 1.0 - f)*pieceLen, abs(d - inner));
    vec3 edging = walkBase*(0.74 + 0.12*walkHash(vec2(seg, piece) + 3.1))*(0.94 + 0.08*fine);
    diffuseColor.rgb = mix(diffuseColor.rgb, edging, smoothstep(inner - 0.01, inner + 0.01, d));
    diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.012, 0.03, d > inner - 0.03 ? joint : 1.0));
    float grime = smoothstep(inner - 1.2*n - 0.3, uWalkHalfWidth + 0.05, d);
    diffuseColor.rgb *= 1.0 - 0.18*grime*(0.6 + 0.4*fine);
    if (d > uWalkHalfWidth) {
      float t = (d - uWalkHalfWidth)/uWalkFringe*1.2 - 0.1;
      float speck = 0.65*fine + 0.35*walkNoise(w*19.0);
      diffuseColor.rgb = walkBase*(0.7 + 0.1*n);
      diffuseColor.a *= 0.75*(1.0 - smoothstep(speck - 0.15, speck + 0.15, t + 0.25*(n - 0.5)));
    }
  }
  #endif
`;
// `edge` ({ segments, halfWidth, fringe }), for a walkway on the ground, gives it an edging course and a dusty fringe
// fading out `fringe` beyond `halfWidth` from its centerline `segments` (the material must then be transparent)
export function applyWalkwayShader(mat, texture, scale, rotationDegrees, edge) {
  // kept on the material so setWalkwayLook can change them live, without a rebuild
  const uniforms = mat.userData.walkUniforms = { uWalkPattern: { value: 0 }, uWalkScale: { value: 1 }, uWalkRotation: { value: new THREE.Vector2(1, 0) } };
  setWalkwayLook(mat, texture, scale, rotationDegrees);
  if (edge) {
    mat.defines = { ...(mat.defines || {}), WALK_EDGE: '' };
    Object.assign(uniforms, {
      uWalkSegments: { value: App.segmentUniformArray(edge.segments, PATH_MAX_SEGMENTS) },
      uWalkSegmentCount: { value: Math.min(edge.segments.length, PATH_MAX_SEGMENTS) },
      uWalkHalfWidth: { value: edge.halfWidth },
      uWalkFringe: { value: Math.max(edge.fringe, 1e-3) },
    });
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWalkWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWalkWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WALKWAY_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WALKWAY_COLOR_FRAGMENT);
  };
}
// Changes a walkway material's texture (paving to paving only — dirt is a different material), scale and rotation in place
function setWalkwayLook(mat, texture, scale, rotationDegrees) {
  const walk = mat.userData.walkUniforms, path = mat.userData.pathUniforms;
  if (walk) {
    const angle = (rotationDegrees || 0)*Math.PI/180;
    walk.uWalkPattern.value = Math.max(0, WALKWAY_TEXTURES.findIndex(t => t.id === texture));
    walk.uWalkScale.value = scale || 1;
    walk.uWalkRotation.value.set(Math.cos(angle), Math.sin(angle));
  }
  if (path) path.uPathScale.value = scale || 1;
}
// Whether switching a walkway from one texture to another needs its mesh rebuilt (dirt has a fade and a material of its own)
export function walkwayTextureChangeNeedsRebuild(from, to) { return (from === 'dirt') !== (to === 'dirt'); }
// how far past its nominal edge paving's dust fades out
export function pavingFringeWidth(halfWidth) { return Math.min(0.6, halfWidth*0.2); }
// Sidewalk slabs: joints laid off the nearest centerline segment — rows across the sidewalk's width, cross joints
// dividing each segment evenly — on the top only (walls are below Y_SIDEWALK)
const SLAB = 1.8, SLAB_ACROSS = 3; // along, and the widest a row gets across
function applySlabShader(mat, segments, inner, width) {
  if (!segments.length || width <= 0) return;
  const uniforms = {
    uSlabSegments: { value: App.segmentUniformArray(segments, PATH_MAX_SEGMENTS) },
    uSlabSegmentCount: { value: segments.length },
    uSlabInner: { value: inner },
    uSlabRow: { value: width/Math.max(1, Math.ceil(width/SLAB_ACROSS - 0.01)) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSlabPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlabPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSlabPos;
uniform vec4 uSlabSegments[${PATH_MAX_SEGMENTS}];
uniform int uSlabSegmentCount;
uniform float uSlabInner, uSlabRow;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if (vSlabPos.y > ${Y_SIDEWALK.toFixed(4)} - 0.01) {
  vec2 w = vSlabPos.xz;
  float d = 1e9, along = 0.0, pieceLen = 1.0, h = 0.5;
  for (int i=0; i<${PATH_MAX_SEGMENTS}; i++) {
    if (i >= uSlabSegmentCount) break;
    vec4 s = uSlabSegments[i];
    vec2 pa = w - s.xy, ba = s.zw - s.xy;
    float len = max(length(ba), 1e-4);
    float hi = clamp(dot(pa, ba)/(len*len), 0.0, 1.0);
    float di = length(pa - ba*hi);
    if (di < d) { d = di; h = hi; along = hi*len; pieceLen = len/max(1.0, floor(len/${SLAB.toFixed(2)} + 0.5)); }
  }
  float fr = fract(max(d - uSlabInner, 0.0)/uSlabRow);
  float joint = min(fr, 1.0 - fr)*uSlabRow;
  if (h > 0.0 && h < 1.0) { float fa = fract(along/pieceLen); joint = min(joint, min(fa, 1.0 - fa)*pieceLen); } // not round a segment's end
  float aa = max(fwidth(joint), 1e-4);
  diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.012, 0.012 + aa, joint));
}`);
  };
}
// A walkway's material, fading out across `fade` beyond `halfWidth` from `segments`: dirt, or paving (or plain) with an
// edging course (see applyWalkwayShader) — or, with no fade, paving that just stops at its edge
export function makeWalkwayMaterial({ texture, color, scale, rotation, segments, halfWidth, fade }) {
  if (texture === 'dirt') {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...SKIP_OVER_WATER_AND_ROADS });
    applyPathShader(mat, segments, halfWidth, fade, scale);
    return mat;
  }
  const edged = fade > 0 && segments.length > 0;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, transparent: edged, depthWrite: !edged, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...SKIP_OVER_WATER_AND_ROADS });
  applyWalkwayShader(mat, texture, scale, rotation, edged ? { segments, halfWidth, fringe: fade } : null);
  return mat;
}
// One walkway network's mesh: the union of its lines stroked out to their width (plus the fade, for dirt), minus
// `claim` — whatever higher-priority walkway networks have already staked out (see rebuildRoadMeshes and
// S.walkwayOrder), so two walkways crossing don't z-fight over the same ground: the higher one wins the overlap
// and the lower one is simply cut off at its edge. Returns the network's own (unclaimed) outline alongside the
// mesh, so the caller can add it to what the next, lower-priority network has to give way to. Paving's dusty
// fringe isn't part of either: it's returned as `fringeBand`, for rebuildRoadMeshes to trim and attachWalkwayFringes
// to lay only where the walkway crosses grass or sand.
// a walkway network's outline (paved, or a dirt path's out to its faded edge) and, paved, the outer edge of its fringe
function walkwayOutlines(lines) {
  const line = lines[0], halfWidth = (line.width || S.DEFAULT_ROAD_WIDTH)/2, dirt = (line.walkwayTexture || WALKWAY_TEXTURE) === 'dirt';
  const fade = dirt ? pathFadeWidth(halfWidth) : pavingFringeWidth(halfWidth);
  const strokesAt = radius => unionRoadStrokes(lines.map(l => ({
    path: App.toClipperPath(tessellateOpenPath(l.nodeIds.map(id => roadNodes[id]).filter(Boolean))),
    radius,
  })));
  return { outline: strokesAt(dirt ? halfWidth + fade : halfWidth), outer: dirt ? [] : strokesAt(halfWidth + fade) };
}
function buildWalkwayMesh(lines, networkId, claim, outline, outer) {
  const line = lines[0]; // colors and textures are set per network in the details panel
  const halfWidth = (line.width || S.DEFAULT_ROAD_WIDTH)/2;
  const texture = line.walkwayTexture || WALKWAY_TEXTURE;
  const dirt = texture === 'dirt';
  const fade = dirt ? pathFadeWidth(halfWidth) : pavingFringeWidth(halfWidth);
  const color = line.walkwayColor!=null ? line.walkwayColor : WALKWAY_COLOR;
  const { ctDifference } = ClipperLib.ClipType;
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ctDifference, outline, claim || [], true), Y_PATH);
  const geo = builder.build();
  let mesh = null;
  if (geo) {
    const mat = makeWalkwayMaterial({ texture, color, scale: walkwayTextureScaleOf(line), rotation: line.walkwayTextureRotation,
      segments: pathSegmentsOf(lines), halfWidth, fade });
    mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = -1; // flat on the ground: its faded edge is drawn before other see-through things (glass tubes), not sorted among them
    mesh.name = 'Walkway';
    mesh.userData = { networkId, baseColor: color };
  }
  return { mesh, fringeBand: dirt ? null : clipPolygons(ctDifference, outer, outline) };
}
// Lays each paved walkway's dusty fringe (its userData.fringeBand) where it crosses grass or sand — park and beach
// zones — and nowhere else: past a walkway's edge on a plaza, a lot or bare ground the paving just stops. The fringe
// is a child mesh sharing the walkway's material. Redone only when the grass and sand change (rebuildWater calls this
// once a frame when anything might have) or the walkways were just rebuilt (`force`).
let fringeArea = null;
export function attachWalkwayFringes(force) {
  const area = App.getGrassAndSandArea();
  if (area === fringeArea && !force) return;
  fringeArea = area;
  S.roadMeshGroup.children.forEach(mesh => {
    if (!mesh.userData.fringeBand || mesh.userData.fringeArea === area) return; // (a kept walkway's is still right)
    mesh.userData.fringeArea = area;
    mesh.children.filter(c => c.name === 'WalkwayFringe').forEach(child => { mesh.remove(child); child.geometry.dispose(); }); // (not a highlight's twin)
    if (!area.length || !mesh.userData.fringeBand.length) return;
    const builder = createMeshBuilder();
    builder.addTops(clipPolygons(ClipperLib.ClipType.ctIntersection, mesh.userData.fringeBand, area, true), Y_PATH);
    const geo = builder.build();
    if (!geo) return;
    const fringe = new THREE.Mesh(geo, mesh.material);
    fringe.receiveShadow = true;
    fringe.renderOrder = -1;
    fringe.name = 'WalkwayFringe';
    fringe.raycast = () => {}; // picking a walkway means its paving, not the dust beside it
    fringe.userData.ground = true; // (but things still land on it: see core/ground-probe.js)
    mesh.add(fringe);
  });
}
// Moves a walkway network to just before (or after) another in S.walkwayOrder: like moveZone, the order is
// priority, so overlapping walkways need re-laying out (rebuildRoadMeshes re-syncs the order too, but that's a
// no-op here since both ids are already in it).
S.draggedWalkwayId = null;
export function moveWalkwayNetwork(networkId, targetNetworkId, before) {
  if (networkId === targetNetworkId) return;
  S.walkwayOrder = S.walkwayOrder.filter(id => id !== networkId);
  const at = S.walkwayOrder.indexOf(targetNetworkId);
  S.walkwayOrder.splice(before ? at : at+1, 0, networkId);
  rebuildRoadMeshes();
}

// Updates the colors and walkway textures of already-built road and walkway meshes from their lines — for the purely
// cosmetic settings, which don't need rebuildRoadMeshes (and so don't make people, traffic or water rebuild either).
// Only `networkId`'s meshes, or every network's when it's left out.
export function refreshRoadAppearance(networkId) {
  S.roadMeshGroup.children.forEach(mesh => {
    const netId = mesh.userData && mesh.userData.networkId;
    if (netId == null || (networkId != null && netId !== networkId)) return;
    const line = S.roadLines.find(l => l.networkId === netId);
    if (!line) return;
    if (mesh.name === 'Road') mesh.userData.baseColor = line.color!=null ? line.color : ROAD_COLOR;
    else if (mesh.name === 'Sidewalk') mesh.userData.baseColor = line.sidewalkColor!=null ? line.sidewalkColor : SIDEWALK_COLOR;
    else if (mesh.name === 'Walkway') {
      mesh.userData.baseColor = line.walkwayColor!=null ? line.walkwayColor : WALKWAY_COLOR;
      const texture = line.walkwayTexture || WALKWAY_TEXTURE;
      setWalkwayLook(mesh.material, mesh.userData.raised && texture === 'dirt' ? 'plain' : texture, walkwayTextureScaleOf(line), line.walkwayTextureRotation);
    }
  });
  App.refreshHighlights();
}
// Everything about the roads that people, traffic and water depend on — not colors or textures — so a rebuild that only
// changed those doesn't make them rebuild too
let lastLayoutKey = null;
function roadLayoutKey() {
  return JSON.stringify([S.DEFAULT_ROAD_WIDTH, S.DEFAULT_SIDEWALK_WIDTH, S.roadLines.map(l => [l.id, l.networkId, l.kind, l.roadType,
    l.width, l.sidewalkWidth, l.radius, !!l.drawing, l.raisedHeight, !!l.raisedTrees, !!l.raisedBenches, l.mall, l.nodeIds.map(id => roadNodes[id])])]);
}
// the stencil mask over the whole road footprint (see SKIP_OVER_WATER_AND_ROADS), a mesh per network — kept out of
// roadMeshGroup, which is exported and recolored for highlights
let roadMask = null;
// the stretches of segment p→q (as [t0, t1] ranges) that `ranges` — sorted and merged, as coverage returns them — leave out
function uncoveredRanges(ranges) {
  const out = [];
  let t = 0;
  ranges.forEach(([t0, t1]) => { if (t0 > t) out.push([t, t0]); t = Math.max(t, t1); });
  if (t < 1) out.push([t, 1]);
  return out;
}
// Builds network `netId`'s road, kerb and pavement meshes into roadMeshGroup, from its `strokes` and those of everything
// near it (`nearStrokes`, itself included): the outlines are traced round them all at once, so roads from separate networks
// that overlap without sharing a junction still merge cleanly; it then takes the part of those layers inside its own
// `footprint` less what earlier networks `claimed`, so the per-network meshes (own colors, own selection highlight) never
// overlap. `rects`: the dropped kerbs near it.
function buildRoadNetwork(netId, strokes, nearStrokes, rects, claimed, footprint) {
  const { ctDifference, ctIntersection } = ClipperLib.ClipType;
  const outlineAt = radiusOf => unionRoadStrokes(nearStrokes.map(s => ({ path:s.path, radius:radiusOf(s) })));
  const roadOutline = outlineAt(s => s.hw);
  const curbOutline = outlineAt(s => s.hw+s.cw);
  const sidewalkOutline = outlineAt(s => s.hw+s.cw+s.sw);
  const cutDrops = band => rects.length ? clipPolygons(ctDifference, band, rects) : band;
  const curbBand = cutDrops(clipPolygons(ctDifference, curbOutline, roadOutline));
  const sidewalkBand = cutDrops(clipPolygons(ctDifference, sidewalkOutline, curbOutline));
  // Curb and sidewalk together are one raised platform: where its edge runs along the road outline it steps
  // down to the road, and where it runs along the outer outline it drops to the ground. The road itself is sunk
  // below the ground, so wherever its edge has no platform beside it, a low wall lines the hole it sits in.
  const platformBand = clipPolygons(ctDifference, sidewalkOutline, roadOutline);
  const roadEdges = createEdgeIndex(roadOutline), outerEdges = createEdgeIndex(sidewalkOutline), platformEdges = createEdgeIndex(platformBand);
  const territory = claimed.length ? clipPolygons(ctDifference, footprint, claimed) : footprint;
  const first = S.roadMeshGroup.children.length;
  const { line } = strokes[0]; // colors are set per network in the details panel
  const road = createMeshBuilder(), curb = createMeshBuilder(), sidewalk = createMeshBuilder();
  const roadSurface = clipPolygons(ctIntersection, roadOutline, territory, true);
  road.addTops(roadSurface, Y_ROAD);
  curb.addTops(clipPolygons(ctIntersection, curbBand, territory, true), Y_SIDEWALK);
  sidewalk.addTops(clipPolygons(ctIntersection, sidewalkBand, territory, true), Y_SIDEWALK);
  const roadFacing = strokes.some(s => s.cw>0) ? curb : sidewalk; // curbless paths step straight up onto the sidewalk
  const pointAt = (p, q, t) => ({ X: p.X+(q.X-p.X)*t, Y: p.Y+(q.Y-p.Y)*t });
  forEachPolyTreeEdge(clipPolygons(ctIntersection, cutDrops(platformBand), territory, true), (p, q, outward) => {
    roadEdges.coverage(p, q).forEach(([t0, t1]) => roadFacing.addWall(pointAt(p, q, t0), pointAt(p, q, t1), Y_ROAD, Y_SIDEWALK, outward));
    outerEdges.coverage(p, q).forEach(([t0, t1]) => sidewalk.addWall(pointAt(p, q, t0), pointAt(p, q, t1), 0, Y_SIDEWALK, outward));
    // the rest of an edge is where this network's share of the platform meets another network's — no step there
  });
  const inward = n => ({ x: -n.x, y: 0, z: -n.z });
  forEachPolyTreeEdge(roadSurface, (p, q, outward) => {
    const bare = uncoveredRanges(platformEdges.coverage(p, q));
    // and of those, only the stretches on the road's outline — not where this network's share meets another's
    bare.forEach(([b0, b1]) => {
      const a = pointAt(p, q, b0), b = pointAt(p, q, b1);
      roadEdges.coverage(a, b).forEach(([t0, t1]) => road.addWall(pointAt(a, b, t0), pointAt(a, b, t1), Y_ROAD, 0, inward(outward)));
    });
  });
  addRoadLayerMesh(road.build(), line.color!=null ? line.color : ROAD_COLOR, 0.95, 'Road', netId);
  addRoadLayerMesh(curb.build(), CURB_COLOR, 0.85, 'Curb', netId);
  addRoadLayerMesh(sidewalk.build(), line.sidewalkColor!=null ? line.sidewalkColor : SIDEWALK_COLOR, 0.9, 'Sidewalk', netId);
  const sidewalkMesh = S.roadMeshGroup.children[S.roadMeshGroup.children.length-1];
  if (sidewalkMesh?.name === 'Sidewalk') applySlabShader(sidewalkMesh.material, pathSegmentsOf(strokes.map(s => s.line)), strokes[0].hw+strokes[0].cw, strokes[0].sw);
  // its share of the stencil mask over the road footprint, level with the sidewalk top it lines up with
  const maskBuilder = createMeshBuilder();
  maskBuilder.addTops(clipPolygons(ctDifference, territory, [], true), Y_SIDEWALK);
  const maskGeo = maskBuilder.build();
  return { meshes: S.roadMeshGroup.children.slice(first), territory, mask: maskGeo && makeStencilMask(maskGeo, STENCIL_ROAD, 'RoadMask') };
}
// Each sidewalk-road network's meshes, kept across rebuilds (roadNetCache: netId → { key, meshes, territory }) and only
// redone when it or a network overlapping it changed — so letting go of a dragged node redoes the roads round it, not
// the city's. Its footprint and road outline are kept too (netShapes: netId → { sig, footprint, roadOutline }).
const roadNetCache = new Map(), netShapes = new Map();
const dropEntry = c => { c.meshes.forEach(m => disposeObject(m)); if (c.mask) disposeObject(c.mask); };
let trainKey = null; // what the train meshes were last built from (see rebuildRoadMeshes)
// a short hash of string `str` (cyrb53)
function hashOf(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const boxesMeet = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
function clipperBox(paths, pad = 0) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  paths.forEach(path => path.forEach(p => { b.minX = Math.min(b.minX, p.X); b.maxX = Math.max(b.maxX, p.X); b.minY = Math.min(b.minY, p.Y); b.maxY = Math.max(b.maxY, p.Y); }));
  b.minX -= pad; b.maxX += pad; b.minY -= pad; b.maxY += pad;
  return b;
}
export function rebuildRoadMeshes() {
  roadNetCache.forEach(c => { c.meshes.forEach(m => S.roadMeshGroup.remove(m)); if (c.mask) roadMask?.remove(c.mask); }); // (kept: see below)
  scene.remove(S.roadMeshGroup); disposeObject(S.roadMeshGroup);
  if (roadMask) { scene.remove(roadMask); disposeObject(roadMask); }
  roadMask = new THREE.Group(); roadMask.name = 'RoadMask';
  S.roadMeshGroup = new THREE.Group(); S.roadMeshGroup.name='Roads';
  const networks = new Map(); // networkId -> [{ path, line, hw, cw, sw }]
  S.roadLines.forEach(line => {
    if (App.isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line) || isMallLine(line)) return; // built separately — see rebuildTrainMeshes, buildWalkwayMesh, rebuildWater and rebuildMalls
    const pts = line.nodeIds.map(id=>roadNodes[id]).filter(Boolean);
    if (pts.length<2) return;
    const path = tessellateOpenPath(pts).map(p => ({ X:Math.round(p.x*CLIPPER_SCALE), Y:Math.round(p.z*CLIPPER_SCALE) }));
    if (!networks.has(line.networkId)) networks.set(line.networkId, []);
    networks.get(line.networkId).push({ path, line, ...roadLineWidths(line) });
  });
  const allStrokes = [...networks.values()].flat();
  const { ctDifference, ctIntersection, ctUnion } = ClipperLib.ClipType;
  // dropped kerbs into car parks: cut from the kerb and pavement, and drawn on their own (see zones/carpark.js)
  const kerb = kerbDrops(allStrokes);
  S.kerbDrops = kerb.drops;
  const kerbBoxes = kerb.rects.map(r => clipperBox([r]));
  // each network's shapes, and what its meshes depend on: itself, the networks overlapping it (and which come first,
  // as the first claims where they overlap) and the kerb drops in it
  const nets = [...networks].map(([netId, strokes], ord) => {
    const { line } = strokes[0];
    const sig = hashOf(JSON.stringify([line.color, line.sidewalkColor, strokes.map(s => [s.hw, s.cw, s.sw, s.path])]));
    let shape = netShapes.get(netId);
    if (!shape || shape.sig !== sig) {
      shape = { sig, footprint: unionRoadStrokes(strokes.map(s => ({ path:s.path, radius:s.hw+s.cw+s.sw }))), roadOutline: unionRoadStrokes(strokes.map(s => ({ path:s.path, radius:s.hw }))) };
      netShapes.set(netId, shape);
    }
    const pad = Math.max(...strokes.map(s => s.hw+s.cw+s.sw))*CLIPPER_SCALE + 1;
    return { netId, strokes, ord, shape, box: clipperBox(strokes.map(s => s.path), pad) };
  });
  S.roadFootprint = clipPolygons(ctUnion, nets.flatMap(n => n.shape.footprint), []);
  const roadOutlineAll = clipPolygons(ctUnion, nets.flatMap(n => n.shape.roadOutline), []);
  // the ground has a hole cut here, for the sunk road surface (see rebuildGround)
  S.roadSurfaceOutline = kerb.rects.length ? clipPolygons(ctUnion, roadOutlineAll, kerb.rects) : roadOutlineAll;
  S.roadBridgeSources = [];
  const kept = new Set();
  nets.forEach(net => {
    const { netId, strokes, ord, shape, box } = net;
    const near = nets.filter(n => boxesMeet(n.box, box));
    const rects = kerb.rects.filter((r, i) => boxesMeet(kerbBoxes[i], box));
    const key = JSON.stringify([near.map(n => (n.ord < ord ? 'b' : n.ord > ord ? 'a' : 's') + n.shape.sig), rects]);
    let entry = roadNetCache.get(netId);
    if (!entry || entry.key !== key) {
      if (entry) dropEntry(entry);
      entry = { key, ...buildRoadNetwork(netId, strokes, near.flatMap(n => n.strokes), rects, near.filter(n => n.ord < ord).flatMap(n => n.shape.footprint), shape.footprint) };
      roadNetCache.set(netId, entry);
    } else entry.meshes.forEach(m => S.roadMeshGroup.add(m));
    if (entry.mask) roadMask.add(entry.mask);
    kept.add(netId);
    S.roadBridgeSources.push({ networkId: netId, territory: entry.territory, strokes });
  });
  if (kerb.drops.length) S.roadMeshGroup.add(kerbDropMesh(kerb.drops));
  // walkway networks: one mesh each, plus their combined footprint for zones to keep lots and trees off
  const walkwayNetworks = new Map();
  S.roadLines.forEach(line => {
    if (!isGroundWalkwayLine(line) || line.nodeIds.map(id=>roadNodes[id]).filter(Boolean).length < 2) return;
    if (!walkwayNetworks.has(line.networkId)) walkwayNetworks.set(line.networkId, []);
    walkwayNetworks.get(line.networkId).push(line);
  });
  // priority order for overlapping walkways (see buildWalkwayMesh): keep it in sync with what actually exists —
  // networks that are gone drop out, new ones join at the back (lowest priority) until dragged elsewhere
  const walkwayIds = new Set(walkwayNetworks.keys());
  S.walkwayOrder = S.walkwayOrder.filter(id => walkwayIds.has(id));
  walkwayIds.forEach(id => { if (!S.walkwayOrder.includes(id)) S.walkwayOrder.push(id); });
  // as the roads: each network's mesh kept until it, or a walkway overlapping it, changes (or they swap priority)
  const walks = S.walkwayOrder.map((netId, ord) => {
    const lines = walkwayNetworks.get(netId);
    const strokes = lines.map(line => ({
      path: App.toClipperPath(tessellateOpenPath(line.nodeIds.map(id=>roadNodes[id]).filter(Boolean))),
      radius: (line.width || S.DEFAULT_ROAD_WIDTH)/2,
    }));
    const l = lines[0];
    const sig = hashOf(JSON.stringify([l.width, S.DEFAULT_ROAD_WIDTH, l.walkwayTexture, l.walkwayColor, l.walkwayTextureScale, l.walkwayTextureRotation, strokes.map(s => s.path)]));
    let shape = netShapes.get(netId);
    if (!shape || shape.sig !== sig) {
      const { outline, outer } = walkwayOutlines(lines);
      shape = { sig, outline, outer, footprint: unionRoadStrokes(strokes) };
      netShapes.set(netId, shape);
    }
    return { netId, lines, strokes, ord, shape, box: clipperBox(shape.outer.length ? shape.outer : shape.outline) };
  });
  S.pathBridgeSources = walks.map(w => ({ networkId: w.netId, strokes: w.strokes }));
  walks.forEach(w => {
    const near = walks.filter(n => boxesMeet(n.box, w.box));
    const key = JSON.stringify(['walk', near.map(n => (n.ord < w.ord ? 'b' : n.ord > w.ord ? 'a' : 's') + n.shape.sig)]);
    let entry = roadNetCache.get(w.netId);
    if (!entry || entry.key !== key) {
      if (entry) dropEntry(entry);
      const before = near.filter(n => n.ord < w.ord).flatMap(n => n.shape.outline);
      const { mesh, fringeBand } = buildWalkwayMesh(w.lines, w.netId, before.length ? clipPolygons(ctUnion, before, []) : [], w.shape.outline, w.shape.outer);
      // no network's dust on another's paving
      if (mesh && fringeBand) mesh.userData.fringeBand = clipPolygons(ctDifference, fringeBand, near.flatMap(n => n.shape.outline));
      entry = { key, meshes: mesh ? [mesh] : [] };
      roadNetCache.set(w.netId, entry);
    }
    entry.meshes.forEach(m => S.roadMeshGroup.add(m));
    kept.add(w.netId);
  });
  attachWalkwayFringes(true);
  // raised walkways: built whole, each on its own (they stand over everything else, so nothing's claimed between them);
  // kept until it changes, or the roads or rivers its pillars keep clear of do
  const raisedNetworks = new Map();
  S.roadLines.forEach(line => {
    if (!isRaisedWalkwayLine(line)) return;
    if (!raisedNetworks.has(line.networkId)) raisedNetworks.set(line.networkId, []);
    raisedNetworks.get(line.networkId).push(line);
  });
  const raisedFootprints = [];
  S.raisedNav = [];
  raisedNetworks.forEach((lines, netId) => {
    const pts = lines.flatMap(l => l.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (!pts.length) return;
    const box = clipperBox([pts.map(p => ({ X: p.x*CLIPPER_SCALE, Y: p.z*CLIPPER_SCALE }))], 200*CLIPPER_SCALE); // (ramps reach out past the nodes)
    const key = JSON.stringify(['raised', S.DEFAULT_ROAD_WIDTH, S.globalTreeTint, S.riverSeq, nets.filter(n => boxesMeet(n.box, box)).map(n => n.shape.sig),
      lines.map(l => [l.id, l.width, l.raisedHeight, !!l.raisedTrees, !!l.raisedBenches, l.walkwayTexture, l.walkwayColor, l.walkwayTextureScale, l.walkwayTextureRotation, l.nodeIds.map(id => roadNodes[id])])]);
    let entry = roadNetCache.get(netId);
    if (!entry || entry.key !== key) {
      if (entry) dropEntry(entry);
      const built = buildRaisedWalkway(lines, netId);
      entry = { key, meshes: built ? built.objects : [], built };
      roadNetCache.set(netId, entry);
    }
    kept.add(netId);
    if (!entry.built) return;
    entry.meshes.forEach(o => S.roadMeshGroup.add(o));
    raisedFootprints.push(...entry.built.footprint);
    S.raisedNav.push(entry.built.nav);
  });
  roadNetCache.forEach((c, id) => { if (!kept.has(id)) { dropEntry(c); roadNetCache.delete(id); } });
  [...netShapes.keys()].forEach(id => { if (!networks.has(id) && !walkwayNetworks.has(id)) netShapes.delete(id); });
  S.pathFootprint = clipPolygons(ctUnion, walks.flatMap(w => w.shape.footprint), []);
  if (raisedFootprints.length) S.pathFootprint = clipPolygons(ctUnion, S.pathFootprint, raisedFootprints);
  scene.add(roadMask);
  App.buildRoadDetails(); // markings, crossings and traffic lights
  // rivers: only their footprint is kept here (rebuildWater draws them) — recomputed only when a river actually changed,
  // so editing an ordinary road doesn't make the water rebuild
  const riverLines = S.roadLines.filter(line => isRiverLine(line) && line.nodeIds.filter(id => roadNodes[id]).length >= 2);
  const riverKey = JSON.stringify(riverLines.map(line => [line.width, line.nodeIds.map(id => roadNodes[id])]));
  if (riverKey !== S.riverFootprintKey) {
    S.riverFootprintKey = riverKey;
    S.riverFootprint = unionRoadStrokes(riverLines.map(line => ({
      path: App.toClipperPath(tessellateOpenPath(line.nodeIds.map(id=>roadNodes[id]).filter(Boolean))),
      radius: (line.width || S.DEFAULT_ROAD_WIDTH)/2,
    })));
    S.riverSeq++;
  }
  S.landCutFootprint = S.riverFootprint.length ? clipPolygons(ctUnion, S.roadFootprint, S.riverFootprint) : S.roadFootprint;
  // malls: their footprints worked out now, for the zones to give way to as they do to roads; the malls themselves built
  // (or not, while a node's dragged) by rebuildMalls
  const malls = App.mallFootprints?.() || [];
  if (malls.length) S.landCutFootprint = clipPolygons(ctUnion, S.landCutFootprint, malls);
  // what people can walk over water on: paths, malls and their entrance bridges
  S.pathWalkDeck = malls.length ? clipPolygons(ctUnion, S.pathFootprint, malls.concat(S.pathBridgeSources.flatMap(src => src.outline || []))) : S.pathFootprint;
  refreshWalkDeck();
  App.rebuildMalls?.();
  const layoutKey = roadLayoutKey();
  if (layoutKey !== lastLayoutKey) {
    lastLayoutKey = layoutKey;
    S.roadBuildSeq++;
    S.waterDirty = true;
    S.peopleNavDirty = true;
    S.trafficNavDirty = true;
  }
  scene.add(S.roadMeshGroup);
  // trains: only when they, or the roads and rivers their pillars keep clear of, changed (rebuilding resets the shuttles)
  const trainLines = S.roadLines.filter(l => App.isTrainLine(l));
  const trainPts = trainLines.flatMap(l => l.nodeIds.map(id => roadNodes[id]).filter(Boolean));
  const trainBox = trainPts.length ? clipperBox([trainPts.map(p => ({ X: p.x*CLIPPER_SCALE, Y: p.z*CLIPPER_SCALE }))], 50*CLIPPER_SCALE) : null;
  const newTrainKey = JSON.stringify([S.TRAIN_DEFAULT_RADIUS, S.TRAIN_COIL_TURNS_PER_10, S.riverSeq, trainLines, trainLines.map(l => l.nodeIds.map(id => roadNodes[id])),
    trainBox ? nets.filter(n => boxesMeet(n.box, trainBox)).map(n => n.shape.sig) : []]);
  if (newTrainKey !== trainKey) { trainKey = newTrainKey; App.rebuildTrainMeshes(); }
  App.rebuildRoadMarkers();
  App.rebuildRoadHandles();
  App.refreshHighlights();
  App.updateStats();
}
// S.walkDeck: S.pathWalkDeck plus marina jetties (zone.pontoonDeck, see zones/marina.js)
export function refreshWalkDeck() {
  const jetties = S.zones.flatMap(z => z.pontoonDeck || []), base = S.pathWalkDeck || [];
  S.walkDeck = jetties.length ? clipPolygons(ClipperLib.ClipType.ctUnion, base, jetties) : base;
}
Object.assign(App, { attachWalkwayFringes, refreshWalkDeck });
