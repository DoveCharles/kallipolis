import * as THREE from 'three';
import { S, App } from './shared.js';
import { lerp } from './math.js';
import { distPointSegment, closestPointOnSegment } from '../buildings/footprints.js';

// ---------------------------------------------------------- spline / tessellation
const SPLINE_SEGMENTS = 10;
function bezierPoint(p0,p1,p2,p3,t) {
  const mt=1-t, a=mt*mt*mt, b=3*mt*mt*t, c=3*mt*t*t, d=t*t*t;
  return { x:a*p0.x+b*p1.x+c*p2.x+d*p3.x, z:a*p0.z+b*p1.z+c*p2.z+d*p3.z };
}
function edgeIsCurved(a,b) {
  return (a.type==='spline' && a.handleOut) || (b.type==='spline' && b.handleIn);
}
export function tessellateOpenPath(points) {
  const result = [{ x:points[0].x, z:points[0].z }];
  for (let i=0;i<points.length-1;i++) {
    const a=points[i], b=points[i+1];
    if (!edgeIsCurved(a,b)) { result.push({ x:b.x, z:b.z }); continue; }
    const p1 = (a.type==='spline' && a.handleOut) ? a.handleOut : { x:a.x, z:a.z };
    const p2 = (b.type==='spline' && b.handleIn) ? b.handleIn : { x:b.x, z:b.z };
    for (let s=1;s<=SPLINE_SEGMENTS;s++) result.push(bezierPoint({x:a.x,z:a.z}, p1, p2, {x:b.x,z:b.z}, s/SPLINE_SEGMENTS));
  }
  return result;
}
export function tessellateClosedPath(points) {
  const n = points.length;
  const result = [];
  for (let i=0;i<n;i++) {
    const a=points[i], b=points[(i+1)%n];
    result.push({ x:a.x, z:a.z });
    if (!edgeIsCurved(a,b)) continue;
    const p1 = (a.type==='spline' && a.handleOut) ? a.handleOut : { x:a.x, z:a.z };
    const p2 = (b.type==='spline' && b.handleIn) ? b.handleIn : { x:b.x, z:b.z };
    for (let s=1;s<SPLINE_SEGMENTS;s++) result.push(bezierPoint({x:a.x,z:a.z}, p1, p2, {x:b.x,z:b.z}, s/SPLINE_SEGMENTS));
  }
  return result;
}
export function nearestPointOnEdgeTessellated(gp, a, b) {
  if (!edgeIsCurved(a,b)) return { point: closestPointOnSegment(gp,a,b), dist: distPointSegment(gp,a,b) };
  const p1 = (a.type==='spline' && a.handleOut) ? a.handleOut : { x:a.x, z:a.z };
  const p2 = (b.type==='spline' && b.handleIn) ? b.handleIn : { x:b.x, z:b.z };
  let prev = { x:a.x, z:a.z }, best = null;
  for (let s=1;s<=SPLINE_SEGMENTS;s++) {
    const cur = bezierPoint({x:a.x,z:a.z}, p1, p2, {x:b.x,z:b.z}, s/SPLINE_SEGMENTS);
    const d = distPointSegment(gp, prev, cur);
    if (!best || d<best.dist) best = { point: closestPointOnSegment(gp, prev, cur), dist: d };
    prev = cur;
  }
  return best;
}
export function computeAutoHandlesRoad(nodeId) {
  const pos = App.roadNodes[nodeId];
  let prevPos=null, nextPos=null;
  for (const line of S.roadLines) {
    const idx = line.nodeIds.indexOf(nodeId);
    if (idx===-1) continue;
    if (idx>0) prevPos = App.roadNodes[line.nodeIds[idx-1]];
    if (idx<line.nodeIds.length-1) nextPos = App.roadNodes[line.nodeIds[idx+1]];
    if (prevPos || nextPos) break;
  }
  let dx=1, dz=0;
  if (prevPos && nextPos) { dx=nextPos.x-prevPos.x; dz=nextPos.z-prevPos.z; }
  else if (nextPos) { dx=nextPos.x-pos.x; dz=nextPos.z-pos.z; }
  else if (prevPos) { dx=pos.x-prevPos.x; dz=pos.z-prevPos.z; }
  const len = Math.hypot(dx,dz) || 1;
  const ux=dx/len, uz=dz/len;
  const hl = Math.min(15, Math.max(5, len*0.3));
  return { handleOut:{x:pos.x+ux*hl,z:pos.z+uz*hl}, handleIn:{x:pos.x-ux*hl,z:pos.z-uz*hl} };
}
export function computeAutoHandlesZone(zone, i) {
  const n = zone.points.length;
  const pos = zone.points[i], prev = zone.points[(i-1+n)%n], next = zone.points[(i+1)%n];
  const dx=next.x-prev.x, dz=next.z-prev.z;
  const len = Math.hypot(dx,dz) || 1;
  const ux=dx/len, uz=dz/len;
  const hl = Math.min(15, Math.max(5, len*0.25));
  return { handleOut:{x:pos.x+ux*hl,z:pos.z+uz*hl}, handleIn:{x:pos.x-ux*hl,z:pos.z-uz*hl} };
}

const buildingPalette = [0x9a9ea6, 0xb7bac0, 0xc9cbd0, 0x8d9198, 0xa3a7ad, 0xd6d8db];
export const BUILDING_GROUND_COLORS = [0x6b6e73]; // user-extendable palette; grows via the '+' swatch
export const ROAD_COLOR = 0x5c616b;
export const ROAD_COLOR_PALETTE = [0x5c616b]; // user-extendable palette; grows via the '+' swatch
// Default starting swatch is a natural yellow-green rather than white — the material itself is
// pure grayscale (see applyGrassNoiseShader / makeTreeMesh), so this is purely a starting
// parameter value, saving a new project from starting on flat white until you pick a tint.
export const PARK_TINT_COLORS = [0xc4e57e]; // rgb(196,229,126); user-extendable, multiplies over the grass's own procedural (grayscale) color
export const TREE_TINT_COLORS = [0xd6f75b]; // rgb(214,247,91); user-extendable, multiplies over each tree's own rolled (grayscale) foliage color
// World-level default tint, applied to every park's grass and every tree in every zone (park
// AND buildings zones' own unbuilt-lot grass patches) unless a park zone opts into its own
// override via its "Custom color" toggle — see resolveParkTint/resolveTreeTint below.
S.globalParkTint = PARK_TINT_COLORS[0];
S.globalTreeTint = TREE_TINT_COLORS[0];
export function resolveParkTint(zone) {
  if (zone && zone.zoneType==='park' && zone.settings.customTint) {
    return zone.settings.parkTint!=null ? zone.settings.parkTint : PARK_TINT_COLORS[0];
  }
  return S.globalParkTint;
}
export function resolveTreeTint(zone) {
  if (zone && zone.zoneType==='park' && zone.settings.customTint) {
    return zone.settings.treeTint!=null ? zone.settings.treeTint : TREE_TINT_COLORS[0];
  }
  return S.globalTreeTint;
}
// Same World-default-with-per-park-override pattern as the tints above, but for how strongly
// the grass's procedural noise pattern shows: 0 = flat, uniform color, 1 = the shader's normal
// contrast, higher = a rougher, more mottled look.
export const DEFAULT_GRASS_NOISE_STRENGTH = 0.2;
S.globalGrassNoiseStrength = DEFAULT_GRASS_NOISE_STRENGTH;
export function resolveGrassNoiseStrength(zone) {
  if (zone && zone.zoneType==='park' && zone.settings.customTint) {
    return zone.settings.grassNoiseStrength!=null ? zone.settings.grassNoiseStrength : DEFAULT_GRASS_NOISE_STRENGTH;
  }
  return S.globalGrassNoiseStrength;
}
// colorVariation: 0 = every building is the literal same flat gray, 0.25 = the gentle
// gray-palette variety buildings had before this slider existed, 1 = full saturated rainbow
// hue per building. Below 0.25 the gray-palette variety (and its lightness jitter) itself
// fades in from nothing; above 0.25 saturation ramps from that palette's own low saturation
// up to vivid. Hue is always picked fresh/random, but stays invisible until saturation rises.
const FLAT_GRAY_L = 0.66;
export function pickBuildingColor(rng, cv) {
  const grayHex = buildingPalette[Math.floor(rng()*buildingPalette.length)];
  const ghsl = {}; new THREE.Color(grayHex).getHSL(ghsl);
  const hue = rng();
  const vividSat = 0.55 + rng()*0.4;
  const lightJitter = (rng()-0.5)*0.12;
  const grayT = THREE.MathUtils.clamp(cv/0.25, 0, 1);
  const rainbowT = THREE.MathUtils.clamp((cv-0.25)/0.75, 0, 1);
  const sat = THREE.MathUtils.clamp(rainbowT>0 ? lerp(ghsl.s, vividSat, rainbowT) : lerp(0, ghsl.s, grayT), 0, 1);
  const light = THREE.MathUtils.clamp(lerp(FLAT_GRAY_L, ghsl.l + lightJitter, grayT), 0.14, 0.88);
  // `hue` is returned alongside the color because once saturation hits 0 the hue is lost from
  // the color itself (gray RGB has no retrievable hue) — accents still want it, even then.
  return { color: new THREE.Color().setHSL(hue, sat, light), hue };
}
// pulls an accent color out of the building's own color, boosting its saturation for pop —
// but multiplicatively, so a truly flat-gray building (saturation 0) gets a flat-gray accent
// too, not a random vivid one; the boost only shows once the body itself has some color.
export function accentColorFrom(color, hue, rng) {
  const hsl = {}; color.getHSL(hsl);
  const sat = THREE.MathUtils.clamp(hsl.s * (3 + rng()*2), 0, 1);
  const light = THREE.MathUtils.clamp(hsl.l*0.75 + 0.18, 0.25, 0.75);
  return new THREE.Color().setHSL(hue, sat, light).getHex();
}

// Park grass color used to come from a canvas-drawn "fake Perlin" texture tiled across each
// zone. Any tiled texture has a fixed repeat period that a large enough (or close/raking-angle)
// view eventually reveals as a grid, no matter how the sampling is warped — and it only ever
// tiled per-zone, so adjoining parks never lined up with each other either. Grass color is now
// computed straight in the ground material's shader as a fractal (fBM) noise function of each
// vertex's real WORLD position (see applyGrassNoiseShader below) — a continuous function has no
// period to repeat, and since every park samples the SAME world-space field, the blotches read
// as one continuous meadow across zone boundaries instead of a grid of independent tiles.
