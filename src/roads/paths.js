import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, SKIP_OVER_WATER, Y_PATH, Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { distPointSegment } from '../buildings/footprints.js';
import { tessellateOpenPath, ROAD_COLOR } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CURB_COLOR, SIDEWALK_COLOR, CLIPPER_SCALE, roadLineWidths, unionRoadStrokes, clipPolygons, createMeshBuilder, forEachPolyTreeEdge, createEdgeIndex, addRoadLayerMesh, disposeObject } from './roads.js';

// ---------------------------------------------------------- paths
// A road network can be a path instead of a sidewalk road: no curb or raised sidewalk, just a sandy, speckled track laid
// over whatever's underneath, whose edge wanders in and out a little and fades away softly instead of stopping at a hard
// line. Paths don't cut holes in zone ground or park grass — the fade needs something beneath it to fade into — but
// lots, buildings and trees still keep off them (see pathFootprint).
export const PATH_COLOR = 0xb09973; // kept near the grass's brightness, so a path reads as sand on the ground rather than a glowing stripe
export const PATH_COLOR_PALETTE = [PATH_COLOR]; // user-extendable palette; grows via the '+' swatch
// A walkway is a path in every way that matters for the sim (pedestrians walk it, it keeps lots/trees off it, it
// bridges water like a path) but looks nothing like one: just a plain flat color, no dirt texture or soft fade edge.
export const WALKWAY_COLOR = 0xb0ac9f;
export const WALKWAY_COLOR_PALETTE = [WALKWAY_COLOR];
const PATH_MAX_SEGMENTS = 128; // fixed GLSL array size; a network's centerlines are simplified to fit
export function isPathLine(line) { return line.roadType === 'path'; }
export function isWalkwayLine(line) { return line.roadType === 'walkway'; }
export function isRiverLine(line) { return line.roadType === 'river'; }
// how far past its nominal edge a path's sand fades out
function pathFadeWidth(halfWidth) { return Math.min(2.5, halfWidth*0.9); }
// Ramer–Douglas–Peucker: the fewest of `points` that keep the line within `tolerance` of its original course
function simplifyPolyline(points, tolerance) {
  if (points.length <= 2) return points;
  const a = points[0], b = points[points.length-1];
  let worst = 0, index = 0;
  for (let i=1;i<points.length-1;i++) { const d = distPointSegment(points[i], a, b); if (d > worst) { worst = d; index = i; } }
  if (worst <= tolerance) return [a, b];
  return simplifyPolyline(points.slice(0, index+1), tolerance).slice(0, -1).concat(simplifyPolyline(points.slice(index), tolerance));
}
// a path network's centerlines as world-space segments [ax, az, bx, bz], simplified until they fit the shader's list
function pathSegmentsOf(lines) {
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
    float coarse = pathNoise(wp*0.3), grain = pathNoise(wp*3.1);
    // The edge wanders in and out a little. Across the fade beyond it, the sand breaks up grain by grain rather than
    // blurring: fine noise is compared against how far into the fade each point is, so the grains thin out and
    // scatter into the ground. (fadeT runs a little past 0..1 so the core stays solid and the far side fully clear.)
    float edge = uPathHalfWidth*(0.85 + 0.3*coarse);
    float fadeT = smoothstep(edge - uPathFade*0.5, edge + uPathFade*0.5, d)*1.3 - 0.15;
    float speckle = 0.7*pathNoise(wp*4.3) + 0.3*pathNoise(wp*11.0);
    float cover = 1.0 - smoothstep(speckle - 0.12, speckle + 0.12, fadeT);
    vec3 sand = diffuseColor.rgb*(0.88 + 0.18*coarse)*(0.92 + 0.16*grain);
    sand *= mix(1.05, 0.95, smoothstep(0.0, edge, d)); // trodden a little lighter down the middle
    diffuseColor = vec4(sand, diffuseColor.a*cover);
  }
`;
export function applyPathShader(mat, segments, halfWidth, fade) {
  const segmentUniforms = App.segmentUniformArray(segments, PATH_MAX_SEGMENTS);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPathSegments = { value: segmentUniforms };
    shader.uniforms.uPathSegmentCount = { value: segments.length };
    shader.uniforms.uPathHalfWidth = { value: halfWidth };
    shader.uniforms.uPathFade = { value: fade };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPathWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPathWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PATH_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PATH_COLOR_FRAGMENT);
  };
}
// One path network's mesh: the union of its lines stroked out to their full fade, shaded by distance to its centerlines.
function buildPathMesh(lines, networkId) {
  const halfWidth = (lines[0].width || S.DEFAULT_ROAD_WIDTH)/2;
  const fade = pathFadeWidth(halfWidth);
  const color = lines[0].pathColor!=null ? lines[0].pathColor : PATH_COLOR; // colors are set per network in the details panel
  const outline = unionRoadStrokes(lines.map(line => ({
    path: App.toClipperPath(tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean))),
    radius: halfWidth + fade,
  })));
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, outline, [], true), Y_PATH);
  const geo = builder.build();
  if (!geo) return null;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...SKIP_OVER_WATER });
  applyPathShader(mat, pathSegmentsOf(lines), halfWidth, fade);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'Path';
  mesh.userData = { networkId, baseColor: color };
  return mesh;
}

// One walkway network's mesh: like a path, but just a plain flat color — no dirt shader or soft fade edge
function buildWalkwayMesh(lines, networkId) {
  const halfWidth = (lines[0].width || S.DEFAULT_ROAD_WIDTH)/2;
  const color = lines[0].walkwayColor!=null ? lines[0].walkwayColor : WALKWAY_COLOR; // colors are set per network in the details panel
  const outline = unionRoadStrokes(lines.map(line => ({
    path: App.toClipperPath(tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean))),
    radius: halfWidth,
  })));
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, outline, [], true), Y_PATH);
  const geo = builder.build();
  if (!geo) return null;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...SKIP_OVER_WATER });
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
    if (App.isTrainLine(line) || isPathLine(line) || isWalkwayLine(line) || isRiverLine(line)) return; // built separately — see rebuildTrainMeshes, buildPathMesh/buildWalkwayMesh and rebuildWater
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
  // path networks: one soft-edged sandy mesh each, plus their combined footprint for zones to keep lots and trees off
  const pathNetworks = new Map();
  S.roadLines.forEach(line => {
    if (!isPathLine(line) || line.nodeIds.map(id=>roadNodes[id]).filter(Boolean).length < 2) return;
    if (!pathNetworks.has(line.networkId)) pathNetworks.set(line.networkId, []);
    pathNetworks.get(line.networkId).push(line);
  });
  const pathStrokes = [];
  S.pathBridgeSources = [];
  pathNetworks.forEach((lines, netId) => {
    const mesh = buildPathMesh(lines, netId);
    if (mesh) S.roadMeshGroup.add(mesh);
    const strokes = lines.map(line => ({
      path: App.toClipperPath(tessellateOpenPath(line.nodeIds.map(id=>roadNodes[id]).filter(Boolean))),
      radius: (line.width || S.DEFAULT_ROAD_WIDTH)/2,
    }));
    pathStrokes.push(...strokes);
    S.pathBridgeSources.push({ networkId: netId, strokes });
  });
  // walkway networks: same flat plaza-like footprint plumbing as paths, just a different-looking mesh
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
