import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_ZONE_GROUND } from '../core/scene.js';
import { mulberry32, lerp, polygonArea, recursiveSubdivide, insetPolygon } from '../core/math.js';
import { applyFootprintArchetype } from '../buildings/footprints.js';
import { tessellateClosedPath, BUILDING_GROUND_COLORS, resolveParkTint, resolveGrassNoiseStrength } from '../core/splines.js';
import { CLIPPER_SCALE, ROAD_ARC_TOLERANCE, clipPolygons, disposeObject } from '../roads/roads.js';
import { makeBuildingMesh, makeParkMesh, makeFlatZoneMesh, generateParkContent, generateBeachContent } from './surface-detail.js';
import { generatePlazaContent } from './plazas.js';
import { generateFarmlandContent } from './farmland.js';

// ---------------------------------------------------------- zone cut-outs
// Zones give way to whatever takes priority over them: zone ground, park floors, lots, buildings and trees all leave out
// the road network's full footprint (road + curb + sidewalk), and the outline of every zone higher up the zone list —
// a zone cuts itself out of all the zones below it (drag zones in the list to reorder them). rebuildRoadMeshes caches
// the road footprint in roadFootprint, and every road edit rebuilds the road meshes before re-subdividing zones, so it's
// current by the time a zone reads it; anything that changes a zone's outline, or its place in the list, re-subdivides
// that zone and every zone below it (see subdivideZonesFrom).
const BUILDING_OVERHANG = 2.5; // furthest a building's extras (entrance canopy, balconies, podium) reach past its footprint
const ZONE_CUTOUT_REACH = 4; // how far past a zone's outline a cut-out still matters — overhangs and tree canopies at its edge

export function toClipperPath(poly) { return poly.map(p => ({ X:Math.round(p.x*CLIPPER_SCALE), Y:Math.round(p.z*CLIPPER_SCALE) })); }
function fromClipperPath(path) { return path.map(p => ({ x:p.X/CLIPPER_SCALE, z:p.Y/CLIPPER_SCALE })); }
// total filled area (world units²) of closed Clipper paths — holes count negative
export function pathsArea(paths) { return Math.abs(paths.reduce((sum, path) => sum + ClipperLib.Clipper.Area(path), 0))/(CLIPPER_SCALE*CLIPPER_SCALE); }
// closed Clipper paths grown (positive `amount`, world units) or shrunk (negative)
export function offsetPaths(paths, amount, joinType) {
  const offset = new ClipperLib.ClipperOffset(2, ROAD_ARC_TOLERANCE*CLIPPER_SCALE);
  offset.AddPaths(paths, joinType, ClipperLib.EndType.etClosedPolygon);
  const out = [];
  offset.Execute(out, amount*CLIPPER_SCALE);
  return out;
}
// A point-in-region test for closed Clipper paths as boolean ops produce them (outlines plus holes): inside means
// inside an odd number of contours. Each contour's bounding box is checked first.
export function createRegionTester(paths) {
  const boxed = paths.map(path => {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    path.forEach(p => { if (p.X<minX) minX=p.X; if (p.X>maxX) maxX=p.X; if (p.Y<minY) minY=p.Y; if (p.Y>maxY) maxY=p.Y; });
    return { path, minX, minY, maxX, maxY };
  });
  return (x, z) => {
    const X = Math.round(x*CLIPPER_SCALE), Y = Math.round(z*CLIPPER_SCALE);
    let inside = false;
    for (const b of boxed) {
      if (X<b.minX || X>b.maxX || Y<b.minY || Y>b.maxY) continue;
      if (ClipperLib.Clipper.PointInPolygon({ X, Y }, b.path) === 1) inside = !inside;
    }
    return inside;
  };
}
// Everything cut out of `zone` in and just around its outline `poly`: the road footprint, plus the outlines of the zones
// above it in the list (not counting one still being drawn). Empty when nothing is near, which skips all cut-out handling.
// Water zones are the exception: roads cross them on bridges rather than cutting them, and rivers merge into them, so only
// the zones above cut into water.
export function zoneCutoutsNear(zone, poly) {
  const { ctUnion, ctIntersection } = ClipperLib.ClipType;
  const linear = zone.zoneType==='water' ? [] : S.landCutFootprint; // roads and rivers
  const zonesAbove = zoneOutlinesAbove(zone);
  if (!linear.length && !zonesAbove.length) return [];
  const reach = offsetPaths([toClipperPath(poly)], ZONE_CUTOUT_REACH, ClipperLib.JoinType.jtRound);
  return clipPolygons(ctIntersection, clipPolygons(ctUnion, linear, zonesAbove), reach);
}
// The union of the outlines of every zone above `zone` in the list (not counting one still being drawn). The outlines are
// unioned on their own, so each one counts as filled whichever way round it was drawn, before being combined with
// anything that has holes of its own (like the road footprint).
function zoneOutlinesAbove(zone) {
  const above = [];
  for (const other of S.zones) {
    if (other === zone) break;
    if (!other.drawing && other.points.length >= 3) above.push(toClipperPath(tessellateClosedPath(other.points)));
  }
  return above.length ? clipPolygons(ClipperLib.ClipType.ctUnion, above, []) : [];
}
// The path footprint in and just around `poly`. Paths don't cut into a zone's ground (see "paths"), but its lots,
// buildings and trees keep off them.
function pathFootprintNear(poly) {
  if (!S.pathFootprint.length) return [];
  const reach = offsetPaths([toClipperPath(poly)], ZONE_CUTOUT_REACH, ClipperLib.JoinType.jtRound);
  return clipPolygons(ClipperLib.ClipType.ctIntersection, S.pathFootprint, reach);
}
// Hole-free polygons ({x,z}[]) covering a Clipper PolyTree's filled area. Lots and building footprints need simple
// shapes, so an outline with holes (a lot with a road loop, or a small zone above, entirely inside it) is cut in two by a vertical line through
// its first hole — turning that hole into a notch in each half — and so on until no holes are left.
function simplePolygonsOf(tree, depth) {
  depth = depth || 0;
  const out = [];
  const visit = node => {
    const contour = node.Contour(), holes = node.Childs();
    if (!holes.length) out.push(fromClipperPath(contour));
    else if (depth < 8) {
      const xs = contour.map(p => p.X), ys = contour.map(p => p.Y), holeXs = holes[0].Contour().map(p => p.X);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const cutX = Math.round((Math.min(...holeXs) + Math.max(...holeXs))/2);
      const shape = [contour, ...holes.map(hole => hole.Contour())];
      [[minX, cutX], [cutX, maxX]].forEach(([x0, x1]) => {
        const half = [{X:x0,Y:minY}, {X:x1,Y:minY}, {X:x1,Y:maxY}, {X:x0,Y:maxY}];
        out.push(...simplePolygonsOf(clipPolygons(ClipperLib.ClipType.ctIntersection, shape, [half], true), depth+1));
      });
    }
    holes.forEach(hole => hole.Childs().forEach(visit)); // islands sitting inside a hole are pieces of their own
  };
  tree.Childs().forEach(visit);
  return out;
}
// `lot` with the cut-outs taken out, as hole-free pieces. `cut` is false when no cut-out actually overlaps it, in which
// case the lot comes back untouched — so lots clear of roads and other zones generate exactly as they would on their own.
export function cutLotByCutouts(lot, cutouts) {
  if (!cutouts.length) return { cut:false, pieces:[lot] };
  const lotPath = [toClipperPath(lot)];
  if (!(pathsArea(clipPolygons(ClipperLib.ClipType.ctIntersection, lotPath, cutouts)) > 1e-3)) return { cut:false, pieces:[lot] };
  return { cut:true, pieces: simplePolygonsOf(clipPolygons(ClipperLib.ClipType.ctDifference, lotPath, cutouts, true)) };
}
// `poly` shrunk by a true inward offset of `amount` — every point keeps at least that distance from every edge —
// as its pieces, largest first (shrinking a concave shape can split it); empty if nothing is left.
export function insetPolygonExact(poly, amount) {
  return offsetPaths([toClipperPath(poly)], -amount, ClipperLib.JoinType.jtMiter)
    .map(fromClipperPath)
    .filter(p => p.length>=3)
    .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}
// Whether a generated building reaches into a cut-out (a road, or a zone above): its base footprint overlapping one, or
// any vertex of anything attached to it (entrance canopy, balconies, podium…) landing in one.
function buildingReachesCutout(building, footprint, cutouts, inCutout) {
  const footprintPath = [toClipperPath(footprint)];
  if (pathsArea(clipPolygons(ClipperLib.ClipType.ctIntersection, footprintPath, cutouts)) > 1e-3) return true;
  // nothing attached reaches further than this, so a building clear of every cut-out by that much needs no vertex check
  const reach = offsetPaths(footprintPath, BUILDING_OVERHANG*1.5, ClipperLib.JoinType.jtRound);
  if (!clipPolygons(ClipperLib.ClipType.ctIntersection, reach, cutouts).length) return false;
  building.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let hit = false;
  building.traverse(o => {
    if (hit || !o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i=0; i<pos.count && !hit; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); hit = inCutout(v.x, v.z); }
  });
  return hit;
}
export function subdivideZone(zone) {
  if (zone.buildingsGroup) { scene.remove(zone.buildingsGroup); disposeObject(zone.buildingsGroup); }
  zone.buildingsGroup = new THREE.Group();
  S.waterDirty = true; // any zone can cut into water, border it, or cross it
  S.peopleNavDirty = true;

  if (zone.points.length>=3) {
    const poly = tessellateClosedPath(zone.points);
    const cutouts = zoneCutoutsNear(zone, poly); // roads, and the zones above this one
    // lots, buildings and trees also keep off paths, which (unlike roads) leave the zone's ground whole
    const pathsHere = pathFootprintNear(poly);
    const blockers = pathsHere.length ? clipPolygons(ClipperLib.ClipType.ctUnion, cutouts, pathsHere) : cutouts;
    if (zone.zoneType==='park') {
      generateParkContent(zone, poly, cutouts, blockers);
    } else if (zone.zoneType==='beach') {
      generateBeachContent(zone, poly, cutouts);
    } else if (zone.zoneType==='water') {
      // nothing of its own: all water is built together, by rebuildWater
    } else if (zone.zoneType==='plaza') {
      generatePlazaContent(zone, poly, cutouts, blockers);
    } else if (zone.zoneType==='farmland') {
      generateFarmlandContent(zone, poly, cutouts, blockers);
    } else if (zone.zoneType==='industrial') {
      App.generateIndustrialContent(zone, poly, cutouts, blockers);
    } else if (zone.zoneType==='plain') {
      const ground = makeFlatZoneMesh(poly, zone.settings.groundColor!=null ? zone.settings.groundColor : BUILDING_GROUND_COLORS[0], Y_ZONE_GROUND, 'ZoneGround', null, cutouts);
      if (ground) zone.buildingsGroup.add(ground);
    } else {
      const ground = makeFlatZoneMesh(poly, zone.settings.groundColor!=null ? zone.settings.groundColor : BUILDING_GROUND_COLORS[0], Y_ZONE_GROUND, 'ZoneGround', null, cutouts);
      if (ground) zone.buildingsGroup.add(ground);
      const layoutRng = mulberry32(zone.settings.seed>>>0);
      const boundary = zone.settings.borderSetback>0 ? insetPolygon(poly, zone.settings.borderSetback) : poly;
      // Target lot count is a flat number (1..MAX_TARGET_LOTS), not an area threshold, so the
      // same slider position yields roughly the same number of lots no matter the zone's size.
      const targetLots = Math.max(1, Math.round(zone.settings.lotCount));
      const boundaryArea = Math.abs(polygonArea(boundary));
      const avgLotArea = boundaryArea / targetLots;
      const opts = { minArea: avgLotArea, maxDepth:9, jitter:0.35, minSplitDim:3 };
      const lots = [];
      if (boundary.length>=3) recursiveSubdivide(boundary, 0, opts, layoutRng, lots);
      // shrunk a hair so a building merely touching a cut-out's edge (setback 0) doesn't count as in it
      const inCutout = createRegionTester(blockers.length ? offsetPaths(blockers, -0.01, ClipperLib.JoinType.jtMiter) : []);
      lots.forEach((lot, li) => {
        const { cut, pieces } = cutLotByCutouts(lot, blockers);
        pieces.forEach((piece, pi) => {
          const larea = Math.abs(polygonArea(piece));
          if (larea < avgLotArea*0.12) return;
          // Every lot draws from its own stream, keyed to where it sits rather than to how far along the zone we are, so
          // nothing that happens on one lot can shift what happens on the next. On one shared stream a lot flipping
          // between built and empty changed how many numbers it took, which re-rolled every lot after it — so nudging
          // Density (or the landmark, height or colour sliders) looked like it reshuffled the whole zone, when in fact
          // the lots underneath had never moved. Now each slider only changes the thing it names.
          const rng = mulberry32(((zone.settings.seed>>>0) ^ Math.imul(li+1, 0x9E3779B1) ^ Math.imul(pi+1, 0x85EBCA6B)) >>> 0);
          const built = rng() < zone.settings.density;
          const setback = built ? zone.settings.setback : zone.settings.setback*0.4;
          // A lot something cut into can be any shape, so it's shrunk with a true offset — keeping the setback from the
          // cut edge all the way along — rather than the centroid scaling that untouched lots use.
          const insets = cut ? insetPolygonExact(piece, setback) : [insetPolygon(piece, setback)];
          if (!insets.length || insets[0].length<3) return;
          if (built) {
            const isLandmark = rng() < zone.settings.landmarkChance;
            let h = lerp(zone.settings.heightMin, zone.settings.heightMax, Math.pow(rng(),1.4));
            if (isLandmark) h = Math.max(h, zone.settings.heightMax*lerp(1.15,1.7,rng()));
            const { poly: footprint, isRound, archetype, corners } = applyFootprintArchetype(insets[0], rng);
            // Each building rolls its own colorVariation within the zone's range, so a "0 to 1"
            // range genuinely mixes flat-grey and rainbow-saturated buildings side by side,
            // rather than every building in the zone sharing one fixed variation amount.
            const cvMin = zone.settings.colorVariationMin!=null ? zone.settings.colorVariationMin : 0.25;
            const cvMax = zone.settings.colorVariationMax!=null ? zone.settings.colorVariationMax : 0.25;
            const cv = lerp(cvMin, cvMax, rng());
            // (its footprint and height kept on it, for people going in: see "going indoors" in people.js; its kind for
            // what its card says about it: see building-types.js)
            const buildOn = (fp, round, arch, crn) => {
              const mesh = makeBuildingMesh(fp,h,isLandmark,rng,zone.settings.windowsEnabled,cv,zone.settings.windowScale,round,arch,crn,zone.settings.litWindowChance,zone.settings.specularWindows);
              if (mesh) Object.assign(mesh.userData, { footprint: fp, height: h, buildingKind: isLandmark ? 'landmark' : 'buildings' });
              return mesh;
            };
            let building = buildOn(footprint, isRound, archetype, corners);
            if (blockers.length && buildingReachesCutout(building, footprint, blockers, inCutout)) {
              // it reached into a road or a zone above (a round footprint, canopy, balcony or podium): rebuild it as a
              // plain footprint pulled back from the cut edge far enough that nothing attached to it can reach
              const safer = insetPolygonExact(piece, setback + BUILDING_OVERHANG)[0];
              building = safer ? buildOn(safer, false, 'rect', safer) : null;
              if (building && buildingReachesCutout(building, safer, blockers, inCutout)) building = null;
            }
            if (building) zone.buildingsGroup.add(building);
          } else {
            insets.forEach(inset => { if (inset.length>=3) zone.buildingsGroup.add(makeParkMesh(inset, resolveParkTint(zone), resolveGrassNoiseStrength(zone))); });
          }
        });
      });
    }
  }
  scene.add(zone.buildingsGroup);
  App.updateStats();
}
// Re-subdivides `zone` and every zone below it in the list — needed whenever a zone's outline or type changes, or it's
// added, since each zone is cut by the outlines of all the zones above it. Water, park and beach zones above it are redone
// as well: their shorelines and beaches depend on every zone around them, not just the ones above.
export function subdivideZonesFrom(zone) {
  subdivideZonesFromIndex(Math.max(0, S.zones.indexOf(zone)));
}
export function subdivideZonesFromIndex(index) {
  S.zones.forEach((z, i) => { if (i >= index || z.zoneType==='water' || z.zoneType==='park' || z.zoneType==='beach' || z.zoneType==='farmland') subdivideZone(z); });
}
// Moves a zone to just before (or after) another in the zone list. The order is priority — a zone cuts itself out of
// every zone below it — so every zone is re-subdivided.
S.draggedZoneId = null;
export function moveZone(zoneId, targetId, before) {
  S.draggedZoneId = null;
  const zone = S.zones.find(z => z.id===zoneId);
  if (zone && zoneId !== targetId) {
    S.zones = S.zones.filter(z => z !== zone);
    const at = S.zones.findIndex(z => z.id===targetId);
    S.zones.splice(before ? at : at+1, 0, zone);
    S.zones.forEach(subdivideZone);
  }
  App.renderHierarchy();
}

Object.assign(App, { ZONE_CUTOUT_REACH, toClipperPath, fromClipperPath, offsetPaths, createRegionTester, zoneCutoutsNear, zoneOutlinesAbove, cutLotByCutouts, insetPolygonExact, subdivideZone, subdivideZonesFrom });
