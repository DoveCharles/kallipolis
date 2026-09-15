import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, SKY_ENV_MAP, GROUND_HALF_SIZE, ground, Y_MAP } from '../core/scene.js';
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
// how far out along a beach its slope goes under the water — where the waterline and its foam are
const BEACH_WATERLINE = BEACH_SLOPE_WIDTH*(WATER_BANK_TOP - WATER_LEVEL)/(WATER_BANK_TOP - WATER_BANK_BOTTOM);
export const WATER_BANK_COLOR = 0x6f6c66, WATER_BEACH_COLOR = 0xc9b387;
const WATER_MAX_SHORE_SEGMENTS = 128;
const WATER_MAX_BEACH_SEGMENTS = 64;
const WATER_TILE_SIZE = 96;         // world units per surface tile
const WATER_TILE_MARGIN = 12;       // shore this far outside a tile still counts for it — past the shallows' reach
const PARK_BEACH_WIDTH = 5;         // roughly how far sand reaches into a park from the water's edge
export const WATER_TIME = { value: 0 };    // shared by every water material; advanced each frame in animate()

// a fixed-length list of vec4 segment uniforms (GLSL array sizes are compile-time constants) — padding is never read
function segmentUniformArray(segments, max) {
  const out = [];
  for (let i=0;i<max;i++) { const s = segments[i] || [0,0,0,0]; out.push(new THREE.Vector4(s[0], s[1], s[2], s[3])); }
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
    vec3 deep = diffuseColor.rgb; // the material's own color is the deep water
    vec3 water = mix(deep, vec3(0.17, 0.56, 0.58), (1.0 - smoothstep(0.0, 9.0, shoreDistance))*0.85);
    // sand showing through the first few units of water off a beach, with a slightly wavering edge
    float sandy = 1.0 - smoothstep(0.0, 4.0, beachDistance - uBeachWaterline + (waterNoise(wp*0.5) - 0.5)*1.5);
    water = mix(water, vec3(0.55, 0.64, 0.52), sandy*0.65);
    // a thin, broken, slowly shifting line of foam right at the water's edge
    float foam = (1.0 - smoothstep(0.1, 0.9, shoreDistance))*smoothstep(0.35, 0.7, waterNoise(wp*1.6 + vec2(uWaterTime*0.25, -uWaterTime*0.18)));
    diffuseColor.rgb = mix(water, vec3(0.9, 0.95, 0.96), foam*0.8);
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
    vec3 waterNormal = normalize(vec3(-dhdx*1.6*calm, 1.0, -dhdz*1.6*calm));
    normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);
  }
`;
// `shoreSegments`: walled edges; `beachSegments`: edges with a beach, whose waterline is `beachWaterline` out from them
export function applyWaterShader(mat, shoreSegments, beachSegments, beachWaterline) {
  mat.roughness = 0.08;
  mat.metalness = 0;
  mat.envMap = SKY_ENV_MAP;
  mat.envMapIntensity = 1.1;
  const shore = segmentUniformArray(shoreSegments, WATER_MAX_SHORE_SEGMENTS);
  const beach = segmentUniformArray(beachSegments, WATER_MAX_BEACH_SEGMENTS);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = WATER_TIME;
    shader.uniforms.uShoreSegments = { value: shore };
    shader.uniforms.uShoreCount = { value: Math.min(shoreSegments.length, WATER_MAX_SHORE_SEGMENTS) };
    shader.uniforms.uBeachSegments = { value: beach };
    shader.uniforms.uBeachCount = { value: Math.min(beachSegments.length, WATER_MAX_BEACH_SEGMENTS) };
    shader.uniforms.uBeachWaterline = { value: beachWaterline || 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WATER_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WATER_COLOR_FRAGMENT)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + WATER_NORMAL_FRAGMENT);
  };
}
// The water region — every water zone minus the zones above it, plus every river, unioned — and the park area beside it
// (every park minus the zones above it, for beaches). Cached, and only worked out again when a zone or river changes.
const waterCache = { key: null, region: [], parkArea: [] };
function refreshWaterCache() {
  const key = S.riverSeq + '|' + JSON.stringify(S.zones.map(z => (z.drawing || z.points.length < 3) ? null : [z.zoneType, z.points]));
  if (key === waterCache.key) return;
  waterCache.key = key;
  const { ctUnion, ctDifference } = ClipperLib.ClipType;
  const water = S.riverFootprint.slice(), parks = [];
  S.zones.forEach(zone => {
    if (zone.drawing || zone.points.length < 3 || (zone.zoneType !== 'water' && zone.zoneType !== 'park')) return;
    const area = clipPolygons(ctDifference, [App.toClipperPath(tessellateClosedPath(zone.points))], App.zoneOutlinesAbove(zone));
    (zone.zoneType === 'water' ? water : parks).push(...area);
  });
  waterCache.region = water.length ? clipPolygons(ctUnion, water, []) : [];
  waterCache.parkArea = parks.length ? clipPolygons(ctUnion, parks, []) : [];
}
export function getWaterRegion() { refreshWaterCache(); return waterCache.region; }

S.waterGroup = new THREE.Group(); S.waterGroup.name = 'Water'; scene.add(S.waterGroup);
let builtWaterKey = null, builtBridgeKey = null;
// Brings the water, and the bridges over it, up to date — each only if what it depends on has changed. Called from
// animate() whenever waterDirty is set, so any number of zone and road rebuilds in one go cost one water rebuild.
export function rebuildWater() {
  S.waterDirty = false;
  refreshWaterCache();
  if (builtWaterKey !== waterCache.key) {
    builtWaterKey = waterCache.key;
    buildWaterBody(waterCache.region, waterCache.parkArea);
  }
  const bridgeKey = waterCache.key + '#' + S.roadBuildSeq;
  if (builtBridgeKey !== bridgeKey) {
    builtBridgeKey = bridgeKey;
    App.buildBridges(waterCache.region);
  }
}
// The ground: one big flat mesh at height 0, with a hole wherever there's water.
function rebuildGround(region) {
  const S = GROUND_HALF_SIZE*CLIPPER_SCALE;
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, [[{X:-S,Y:-S}, {X:S,Y:-S}, {X:S,Y:S}, {X:-S,Y:S}]], region, true), 0);
  ground.geometry.dispose();
  ground.geometry = builder.build() || new THREE.BufferGeometry();
}
function buildWaterBody(region, parkArea) {
  scene.remove(S.waterGroup); disposeObject(S.waterGroup);
  S.waterGroup = new THREE.Group(); S.waterGroup.name = 'Water';
  rebuildGround(region);
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
        const slopeNormal = { x: inward.x*drop/normalLen, y: W/normalLen, z: inward.z*drop/normalLen };
        const topA = { x:e.a.x, y:WATER_BANK_TOP, z:e.a.z }, topB = { x:e.b.x, y:WATER_BANK_TOP, z:e.b.z };
        const lowA = { x:e.a.x + ra.x*W, y:WATER_BANK_BOTTOM, z:e.a.z + ra.z*W }, lowB = { x:e.b.x + rb.x*W, y:WATER_BANK_BOTTOM, z:e.b.z + rb.z*W };
        beaches.addQuad(topA, topB, lowB, lowA, slopeNormal);
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
    const addBankMesh = (builder, color, name) => {
      const geo = builder.build();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
      mesh.receiveShadow = true;
      mesh.name = name;
      S.waterGroup.add(mesh);
    };
    addBankMesh(banks, WATER_BANK_COLOR, 'WaterBank');
    addBankMesh(beaches, WATER_BEACH_COLOR, 'Beach');

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
        const mat = new THREE.MeshStandardMaterial({ color: WATER_COLOR, roughness: 1 });
        applyWaterShader(mat, segmentsNear(wallList, cx, cz, half, WATER_MAX_SHORE_SEGMENTS), segmentsNear(beachList, cx, cz, half, WATER_MAX_BEACH_SEGMENTS), BEACH_WATERLINE);
        const surface = new THREE.Mesh(geo, mat);
        surface.receiveShadow = true;
        surface.name = 'Water';
        S.waterGroup.add(surface);
      }
    }

    // the stencil mask that keeps the grid, map images and path sand from being drawn over the water (see SKIP_OVER_WATER)
    const maskBuilder = createMeshBuilder();
    maskBuilder.addTops(tree, Y_MAP);
    const mask = new THREE.Mesh(maskBuilder.build(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilRef: 1, stencilZPass: THREE.ReplaceStencilOp }));
    mask.renderOrder = -10; // before anything that tests it
    mask.name = 'WaterMask';
    mask.userData.noExport = true;
    S.waterGroup.add(mask);
  }
  scene.add(S.waterGroup);
}

Object.assign(App, { WATER_COLOR, PARK_BEACH_WIDTH, segmentUniformArray, edgeSegmentsOf, sharedEdgeSegmentsWith, applyWaterShader, getWaterRegion });
