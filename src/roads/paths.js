import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, SKIP_OVER_WATER, Y_PATH, Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { distPointSegment } from '../buildings/footprints.js';
import { tessellateOpenPath, ROAD_COLOR } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
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
const PATH_MAX_SEGMENTS = 128; // fixed GLSL array size; a network's centerlines are simplified to fit
export function isWalkwayLine(line) { return line.roadType === 'walkway'; }
export function isRiverLine(line) { return line.roadType === 'river'; }
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
    float coarse = pathNoise(np*0.3), grain = pathNoise(np*3.1);
    // The edge wanders in and out a little. Across the fade beyond it, the sand breaks up grain by grain rather than
    // blurring: fine noise is compared against how far into the fade each point is, so the grains thin out and
    // scatter into the ground. (fadeT runs a little past 0..1 so the core stays solid and the far side fully clear.)
    float edge = uPathHalfWidth*(0.85 + 0.3*coarse);
    float fadeT = smoothstep(edge - uPathFade*0.5, edge + uPathFade*0.5, d)*1.3 - 0.15;
    float speckle = 0.7*pathNoise(np*4.3) + 0.3*pathNoise(np*11.0);
    float cover = 1.0 - smoothstep(speckle - 0.12, speckle + 0.12, fadeT);
    vec3 sand = diffuseColor.rgb*(0.88 + 0.18*coarse)*(0.92 + 0.16*grain);
    sand *= mix(1.05, 0.95, smoothstep(0.0, edge, d)); // trodden a little lighter down the middle
    diffuseColor = vec4(sand, diffuseColor.a*cover);
  }
`;
export function applyPathShader(mat, segments, halfWidth, fade, scale) {
  const segmentUniforms = App.segmentUniformArray(segments, PATH_MAX_SEGMENTS);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPathSegments = { value: segmentUniforms };
    shader.uniforms.uPathSegmentCount = { value: segments.length };
    shader.uniforms.uPathHalfWidth = { value: halfWidth };
    shader.uniforms.uPathFade = { value: fade };
    shader.uniforms.uPathScale = { value: scale || 1 };
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
`;
const WALKWAY_COLOR_FRAGMENT = `
  if (uWalkPattern != 0) {
    vec2 w = vWalkWorldPos.xz;
    vec2 p = vec2(uWalkRotation.x*w.x + uWalkRotation.y*w.y, uWalkRotation.x*w.y - uWalkRotation.y*w.x)/uWalkScale;
    float edgeDist = 1.0, tint = 1.0, gapLo = 0.03, gapHi = 0.08, gapShade = 0.62;
    if (uWalkPattern == 1) {
      // wood planks: long boards along x, each row's joints staggered at random, with grain streaking along them
      float boardW = 0.3, boardL = 3.0;
      float row = floor(p.y/boardW);
      float u = p.x/boardL + walkHash(vec2(row, 3.7));
      vec2 id = vec2(floor(u), row), f = vec2(fract(u), fract(p.y/boardW));
      edgeDist = min(min(f.x, 1.0-f.x)*boardL, min(f.y, 1.0-f.y)*boardW);
      float grain = walkNoise(vec2(u*6.0, p.y*40.0) + id*13.0);
      tint = (0.8 + 0.3*walkHash(id + 5.0))*(0.86 + 0.2*grain);
      gapLo = 0.008; gapHi = 0.022; gapShade = 0.4;
    } else if (uWalkPattern == 2) {
      // cobblestones: a jittered grid of stones (Voronoi cells), rounded off darker toward their edges
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
      tint = (0.78 + 0.36*walkHash(id + 7.0))*mix(0.8, 1.0, smoothstep(0.02, 0.14, edgeDist));
      gapLo = 0.015; gapHi = 0.04; gapShade = 0.45;
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
`;
export function applyWalkwayShader(mat, texture, scale, rotationDegrees) {
  const pattern = Math.max(0, WALKWAY_TEXTURES.findIndex(t => t.id === texture));
  const angle = (rotationDegrees || 0)*Math.PI/180;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWalkPattern = { value: pattern };
    shader.uniforms.uWalkScale = { value: scale || 1 };
    shader.uniforms.uWalkRotation = { value: new THREE.Vector2(Math.cos(angle), Math.sin(angle)) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWalkWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWalkWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WALKWAY_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WALKWAY_COLOR_FRAGMENT);
  };
}
// A walkway's material: paving (or plain) with a hard edge, or dirt fading out across `fade` beyond `halfWidth` from `segments`
export function makeWalkwayMaterial({ texture, color, scale, rotation, segments, halfWidth, fade }) {
  if (texture === 'dirt') {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...SKIP_OVER_WATER });
    applyPathShader(mat, segments, halfWidth, fade, scale);
    return mat;
  }
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...SKIP_OVER_WATER });
  applyWalkwayShader(mat, texture, scale, rotation);
  return mat;
}
// One walkway network's mesh: the union of its lines stroked out to their width (plus the fade, for dirt)
function buildWalkwayMesh(lines, networkId) {
  const line = lines[0]; // colors and textures are set per network in the details panel
  const halfWidth = (line.width || S.DEFAULT_ROAD_WIDTH)/2;
  const texture = line.walkwayTexture || WALKWAY_TEXTURE;
  const fade = texture === 'dirt' ? pathFadeWidth(halfWidth) : 0;
  const color = line.walkwayColor!=null ? line.walkwayColor : WALKWAY_COLOR;
  const outline = unionRoadStrokes(lines.map(l => ({
    path: App.toClipperPath(tessellateOpenPath(l.nodeIds.map(id => roadNodes[id]).filter(Boolean))),
    radius: halfWidth + fade,
  })));
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, outline, [], true), Y_PATH);
  const geo = builder.build();
  if (!geo) return null;
  const mat = makeWalkwayMaterial({ texture, color, scale: line.walkwayTextureScale, rotation: line.walkwayTextureRotation,
    segments: texture === 'dirt' ? pathSegmentsOf(lines) : [], halfWidth, fade });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'Walkway';
  mesh.userData = { networkId, baseColor: color };
  return mesh;
}

export function rebuildRoadMeshes() {
  scene.remove(S.roadMeshGroup); disposeObject(S.roadMeshGroup);
  S.roadMeshGroup = new THREE.Group(); S.roadMeshGroup.name='Roads';
  const networks = new Map(); // networkId -> [{ path, line, hw, cw, sw }]
  S.roadLines.forEach(line => {
    if (App.isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return; // built separately — see rebuildTrainMeshes, buildWalkwayMesh and rebuildWater
    const pts = line.nodeIds.map(id=>roadNodes[id]).filter(Boolean);
    if (pts.length<2) return;
    const path = tessellateOpenPath(pts).map(p => ({ X:Math.round(p.x*CLIPPER_SCALE), Y:Math.round(p.z*CLIPPER_SCALE) }));
    if (!networks.has(line.networkId)) networks.set(line.networkId, []);
    networks.get(line.networkId).push({ path, line, ...roadLineWidths(line) });
  });
  const allStrokes = [...networks.values()].flat();
  const outlineAt = radiusOf => unionRoadStrokes(allStrokes.map(s => ({ path:s.path, radius:radiusOf(s) })));
  const roadOutline = outlineAt(s => s.hw);
  const curbOutline = outlineAt(s => s.hw+s.cw);
  const sidewalkOutline = outlineAt(s => s.hw+s.cw+s.sw);
  S.roadFootprint = sidewalkOutline;
  const { ctDifference, ctIntersection, ctUnion } = ClipperLib.ClipType;
  const curbBand = clipPolygons(ctDifference, curbOutline, roadOutline);
  const sidewalkBand = clipPolygons(ctDifference, sidewalkOutline, curbOutline);
  // Curb and sidewalk together are one raised platform: where its edge runs along the road outline it steps
  // down to the road, and where it runs along the outer outline it drops to the ground.
  const platformBand = clipPolygons(ctDifference, sidewalkOutline, roadOutline);
  const roadEdges = createEdgeIndex(roadOutline), outerEdges = createEdgeIndex(sidewalkOutline);
  // The outlines above are traced around every network at once, so roads from separate networks that
  // overlap without sharing a junction still merge cleanly. Each network then takes the part of those
  // layers inside its own footprint — minus whatever an earlier network already took — so the per-network
  // meshes (own colors, own selection highlight) never overlap each other either.
  let claimed = [];
  S.roadBridgeSources = [];
  networks.forEach((strokes, netId) => {
    const footprint = unionRoadStrokes(strokes.map(s => ({ path:s.path, radius:s.hw+s.cw+s.sw })));
    const territory = claimed.length ? clipPolygons(ctDifference, footprint, claimed) : footprint;
    claimed = claimed.length ? clipPolygons(ctUnion, claimed, footprint) : footprint;
    S.roadBridgeSources.push({ networkId: netId, territory, strokes });
    const { line } = strokes[0]; // colors are set per network in the details panel
    const road = createMeshBuilder(), curb = createMeshBuilder(), sidewalk = createMeshBuilder();
    road.addTops(clipPolygons(ctIntersection, roadOutline, territory, true), Y_ROAD);
    curb.addTops(clipPolygons(ctIntersection, curbBand, territory, true), Y_SIDEWALK);
    sidewalk.addTops(clipPolygons(ctIntersection, sidewalkBand, territory, true), Y_SIDEWALK);
    const roadFacing = strokes.some(s => s.cw>0) ? curb : sidewalk; // curbless paths step straight up onto the sidewalk
    const pointAt = (p, q, t) => ({ X: p.X+(q.X-p.X)*t, Y: p.Y+(q.Y-p.Y)*t });
    forEachPolyTreeEdge(clipPolygons(ctIntersection, platformBand, territory, true), (p, q, outward) => {
      roadEdges.coverage(p, q).forEach(([t0, t1]) => roadFacing.addWall(pointAt(p, q, t0), pointAt(p, q, t1), Y_ROAD, Y_SIDEWALK, outward));
      outerEdges.coverage(p, q).forEach(([t0, t1]) => sidewalk.addWall(pointAt(p, q, t0), pointAt(p, q, t1), 0, Y_SIDEWALK, outward));
      // the rest of an edge is where this network's share of the platform meets another network's — no step there
    });
    addRoadLayerMesh(road.build(), line.color!=null ? line.color : ROAD_COLOR, 0.95, 'Road', netId);
    addRoadLayerMesh(curb.build(), CURB_COLOR, 0.85, 'Curb', netId);
    addRoadLayerMesh(sidewalk.build(), line.sidewalkColor!=null ? line.sidewalkColor : SIDEWALK_COLOR, 0.9, 'Sidewalk', netId);
  });
  const pathStrokes = [];
  S.pathBridgeSources = [];
  // walkway networks: one mesh each, plus their combined footprint for zones to keep lots and trees off
  const walkwayNetworks = new Map();
  S.roadLines.forEach(line => {
    if (!isWalkwayLine(line) || line.nodeIds.map(id=>roadNodes[id]).filter(Boolean).length < 2) return;
    if (!walkwayNetworks.has(line.networkId)) walkwayNetworks.set(line.networkId, []);
    walkwayNetworks.get(line.networkId).push(line);
  });
  walkwayNetworks.forEach((lines, netId) => {
    const mesh = buildWalkwayMesh(lines, netId);
    if (mesh) S.roadMeshGroup.add(mesh);
    const strokes = lines.map(line => ({
      path: App.toClipperPath(tessellateOpenPath(line.nodeIds.map(id=>roadNodes[id]).filter(Boolean))),
      radius: (line.width || S.DEFAULT_ROAD_WIDTH)/2,
    }));
    pathStrokes.push(...strokes);
    S.pathBridgeSources.push({ networkId: netId, strokes });
  });
  S.pathFootprint = unionRoadStrokes(pathStrokes);
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
  S.roadBuildSeq++;
  S.waterDirty = true;
  S.peopleNavDirty = true;
  S.trafficNavDirty = true;
  scene.add(S.roadMeshGroup);
  App.rebuildTrainMeshes();
  App.rebuildRoadMarkers();
  App.rebuildRoadHandles();
  App.refreshHighlights();
  App.updateStats();
}
