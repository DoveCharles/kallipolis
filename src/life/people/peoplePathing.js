import * as THREE from 'three';
import { App, S } from '../../core/shared.js';
import { Y_PARK, Y_PATH, Y_ROAD, Y_SIDEWALK, Y_ZONE_GROUND } from '../../core/scene.js';
import { centroid } from '../../core/math.js';
import { buildingEnterable, buildingKindOf } from '../../buildings/building-types.js';
import { buildingKey, buildingNumber, closestPointOnSegment } from '../../buildings/footprints.js';
import { tessellateClosedPath, tessellateOpenPath } from '../../core/splines.js';
import { roadNodes } from '../../core/state.js';
import { CLIPPER_SCALE, clipPolygons, roadLineWidths, unionRoadStrokes } from '../../roads/roads.js';
import { isRiverLine, isWalkwayLine } from '../../roads/paths.js';
import { isTrainLine } from '../../trains/trains.js';
import { Y_PLAZA } from '../../zones/plazas.js';
import { getWaterRegion } from '../../water/water.js';
import { createRegionTester, offsetPaths, pathsArea, toClipperPath, zoneCutoutsNear } from '../../zones/cutouts.js';
import { FOOTBRIDGE_TOP } from '../../water/bridges.js';
import { PEOPLE_NAV_SPACING, headingTo, isOpenGround, lastPeopleTime, people, peopleNav, peopleNavDebugMesh, peopleRng, pickWeighted, randomSpotIn } from './people.js';
import { ENTER_CHANCE, RIDE_CHANCE, goIndoors, goRideTrain, mayGoIndoors, stationLinks } from './peopleActivities.js';
import { signalRedLeft } from '../../roads/markings.js';

// Which way, and how far per unit of lateral offset, a walkway's point `vi` is set off square to it: the average of the
// nearest non-zero-length segments either side, stretched so a bend keeps its full width, wrapping round for a ring.

/** How far a mitre may stretch, as a limit on 1/cos(half the bend): a full U-turn shares its one direction's mitre. */
const NAV_MITER_LIMIT = 2;

// A suburb's lanes: how far off the middle of one people stray (the hedges either side leave about three quarters of a
// unit, so this keeps them off the leaves), and how far a lane's mouth may be from a sidewalk to come out onto it — the
// block stops at the sidewalk's outer edge, so a lane that reaches the pavement is half a sidewalk short of the ring.
const LANE_LATERAL = 0.45, LANE_TO_SIDEWALK = 8;

/**
 * Work out which way, and how far per unit of lateral offset, a walkway's point `vi` is set off square to the line there.
 * @param {Array<{x: number, z: number}>} pts - the walkway's points
 * @param {number} vi - the point to work it out for
 * @param {boolean} loop - whether the line wraps round
 * @returns {{x: number, z: number}} the offset per unit of lateral offset (zero, for a line with no length at all)
 */
function navVertexMitre(pts, vi, loop) {
  const last = pts.length - 1;
  // the direction of the nearest segment of at least some length, walking `step` from `j`
  const dirFrom = (j, step) => {
    for (let n = 0; n < last; n++, j += step) {
      if (loop) j = (j + last) % last;
      else if (j < 0 || j >= last) return null;
      const a = pts[j], b = pts[j+1], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len > 1e-6) return { x: (b.x-a.x)/len, z: (b.z-a.z)/len };
    }
    return null;
  };
  // the average of the nearest non-zero-length segments either side, skipping the zero-length ones a duplicate node leaves
  const d1 = dirFrom(vi-1, -1) || dirFrom(vi, 1), d2 = dirFrom(vi, 1) || d1;
  if (!d1) return { x: 0, z: 0 };
  let tx = d1.x + d2.x, tz = d1.z + d2.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-6) { tx = d1.x; tz = d1.z; } else { tx /= len; tz /= len; } // (a full U-turn)
  const stretch = 1/Math.max(tx*d1.x + tz*d1.z, 1/NAV_MITER_LIMIT); // stretched, so a bend keeps the full width from both
  return { x: -tz*stretch, z: tx*stretch };
}

/**
 * Rebuild the walkway debug wireframe: cyan along each sidewalk ring and path, red where a path runs over a road (and
 * nobody walks), yellow across each zebra crossing, and white joining a path to the sidewalk it meets.
 * @returns {void}
 */
export function rebuildPeopleNavDebug() {
  const positions = [], colors = [], walk = [0.22, 0.77, 1], blocked = [1, 0.18, 0.33], zebra = [1, 0.82, 0.2], join = [1, 1, 1];
  const seg = (a, b, c, y) => { positions.push(a.x, y, a.z, b.x, y, b.z); colors.push(...c, ...c); };
  if (peopleNav) peopleNav.lines.forEach((nav, li) => {
    const y = nav.y + 0.15;
    for (let vi = 0; vi < nav.pts.length - 1; vi++) seg(nav.pts[vi], nav.pts[vi+1], nav.blocked && (nav.blocked[vi] || nav.blocked[vi+1]) ? blocked : walk, y);
    nav.vertices.forEach((vertex, vi) => vertex.links.forEach(link => {
      if (link.li < li || (link.li === li && link.vi < vi)) return; // (each pair once)
      seg(nav.pts[vi], peopleNav.lines[link.li].pts[link.vi], link.cross ? zebra : join, y);
    }));
  });
  const geom = peopleNavDebugMesh.geometry;
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
}

/**
 * Bucket segments by grid cell for finding the nearest one to a point.
 *
 * @param {Segment[]} segs - the segments to search
 * @param {number} [cell] - the cell size
 * @returns {function(number, number, number): ?SegmentHit} near(x, z, maxD): the nearest segment within maxD, or null
 */
function segmentGrid(segs, cell = 8) {
  const grid = new Map();
  segs.forEach(seg => {
    const { a, b } = seg, steps = Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/(cell*0.5)), cells = new Set();
    for (let k=0; k<=steps; k++) {
      const t = steps ? k/steps : 0;
      cells.add(Math.floor((a.x + (b.x-a.x)*t)/cell) + ',' + Math.floor((a.z + (b.z-a.z)*t)/cell));
    }
    cells.forEach(key => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(seg); });
  });
  // the search itself: the whole cells within maxD of the point, each segment looked at once
  return (x, z, maxD) => {
    const rings = Math.ceil(maxD/cell), cx = Math.floor(x/cell), cz = Math.floor(z/cell), seen = new Set();
    let best = null;
    for (let dx=-rings; dx<=rings; dx++) for (let dz=-rings; dz<=rings; dz++) (grid.get((cx+dx) + ',' + (cz+dz)) || []).forEach(seg => {
      if (seen.has(seg)) return;
      seen.add(seg);
      const q = closestPointOnSegment({ x, z }, seg.a, seg.b), d = Math.hypot(q.x-x, q.z-z);
      if (d <= maxD && (!best || d < best.d)) {
        const len2 = (seg.b.x-seg.a.x)**2 + (seg.b.z-seg.a.z)**2;
        best = { seg, q, d, t: len2 ? ((q.x-seg.a.x)*(seg.b.x-seg.a.x) + (q.z-seg.a.z)*(seg.b.z-seg.a.z))/len2 : 0 };
      }
    });
    return best;
  };
}

/**
 * Resample a line's points to at least every PEOPLE_NAV_SPACING.
 * @param {Array<{x: number, z: number}>} pts - the line's points
 * @returns {{pts: Array<{x: number, z: number}>, at: number[]}} the new points, and where each of the originals ended up
 */
function resampleLine(pts) {
  const out = [pts[0]], at = [0];
  for (let i=1;i<pts.length;i++) {
    const a = pts[i-1], b = pts[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/PEOPLE_NAV_SPACING));
    for (let k=1;k<=steps;k++) out.push(k === steps ? b : { x: a.x + (b.x-a.x)*k/steps, z: a.z + (b.z-a.z)*k/steps });
    at.push(out.length - 1);
  }
  return { pts: out, at };
}

/**
 * Work out the distance along a line to each of its points.
 * @param {Array<{x: number, z: number}>} pts - the line's points
 * @returns {number[]} the distance to each of them, the first being zero
 */
function cumulative(pts) {
  const cum = [0];
  for (let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
  return cum;
}

/**
 * Work out the walkways and the hangouts — everything about the map people need.
 *
 * A sidewalk ring runs down the middle of a block's sidewalks: every sidewalk road stroked out to mid-sidewalk width and
 * unioned, which leaves one closed ring round each block (and one round the outside of the network). It turns each
 * junction's corners and runs round each dead end by itself, and never crosses a road. Rings are joined across the roads
 * by each junction's zebra crossings (links with `cross`); anywhere else, people cross mid-block as they please (see
 * maybeCrossRoad). A path is walked anywhere across its width: where one runs over a road it's `blocked`, and the points
 * either side are linked to the nearest ring; paths meeting at a node are linked to each other.
 *
 * `onPath` is the walkways' footprint, which people keep off when they sit down. A hangout's `inside` is the zone with
 * everything that cuts into it taken out, so water in one — a pond drawn in a park, a river running across a beach — is
 * no part of it; walking round it rather than over it is randomSpotIn's job.
 * @returns {object} the nav: { areas, lines, grid, CELL, onPath, onPavement, nearRing, buildings }
 */
export function buildPeopleNav() {
  const areas = [], lines = [];
  S.zones.forEach(zone => {
    if (zone.drawing || zone.points.length < 3 || (zone.zoneType !== 'plaza' && zone.zoneType !== 'park' && zone.zoneType !== 'beach')) return;
    const poly = tessellateClosedPath(zone.points);
    const paths = offsetPaths(clipPolygons(ClipperLib.ClipType.ctDifference, [toClipperPath(poly)], zoneCutoutsNear(zone, poly)), -1.2, ClipperLib.JoinType.jtMiter);
    const size = pathsArea(paths);
    if (size < 20) return;
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    paths.forEach(path => path.forEach(p => { minX=Math.min(minX,p.X); maxX=Math.max(maxX,p.X); minZ=Math.min(minZ,p.Y); maxZ=Math.max(maxZ,p.Y); }));
    const inArea = createRegionTester(paths), fountain = zone.zoneType==='plaza' ? zone.fountainSpot : null;
    const inside = fountain ? (x, z) => inArea(x, z) && Math.hypot(x - fountain.x, z - fountain.z) > fountain.r + 0.8 : inArea;
    areas.push({ kind: zone.zoneType, inside, fountain, minX: minX/CLIPPER_SCALE, maxX: maxX/CLIPPER_SCALE, minZ: minZ/CLIPPER_SCALE, maxZ: maxZ/CLIPPER_SCALE,
      size, y: zone.zoneType==='plaza' ? Y_PLAZA : Y_PARK, exits: [],
      seats: zone.zoneType==='plaza' ? (zone.benchSeats || []).map(seat => ({ ...seat, by: null })) : [],
      trees: zone.zoneType==='park' ? zone.treeSpots || [] : [] });
  });
  const inWater = createRegionTester(getWaterRegion());
  // the walkways' own footprint, a little proud of their edges: a path cutting through a park is part of the hangout —
  // people walk and stand on it — but nobody sits or lies down on one (see clearGround)
  const onPath = createRegionTester(S.pathFootprint.length ? offsetPaths(S.pathFootprint, 0.35, ClipperLib.JoinType.jtRound) : []);
  // the road network, stroked three times: out to mid-sidewalk (the rings, and what paths are blocked by), to the curb, and
  // just past the sidewalk's outer edge (what a path's end has to reach to join it)
  const midStrokes = [], curbStrokes = [], edgeStrokes = [];
  let anySidewalk = false, widestSidewalk = 0; // (the widest, for how far a building can be off a walkway: see buildingDoors)
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return;
    const nodePts = line.nodeIds.map(id => roadNodes[id]).filter(Boolean);
    if (nodePts.length < 2) return;
    const { hw, cw, sw } = roadLineWidths(line);
    if (sw > 0) anySidewalk = true;
    widestSidewalk = Math.max(widestSidewalk, sw);
    const path = tessellateOpenPath(nodePts).map(p => ({ X: Math.round(p.x*CLIPPER_SCALE), Y: Math.round(p.z*CLIPPER_SCALE) }));
    midStrokes.push({ radius: hw + cw + sw*0.5, path });
    curbStrokes.push({ radius: hw + cw, path });
    edgeStrokes.push({ radius: hw + cw + sw + 0.5, path });
  });
  const midOutline = midStrokes.length ? unionRoadStrokes(midStrokes) : [];
  const inMid = createRegionTester(midOutline), bySidewalk = createRegionTester(edgeStrokes.length ? unionRoadStrokes(edgeStrokes) : []);
  const onPavement = createRegionTester(curbStrokes.length ? unionRoadStrokes(curbStrokes) : []);
  const rings = [];
  midOutline.forEach(path => {
    const pts = [];
    path.forEach(P => {
      const q = { x: P.X/CLIPPER_SCALE, z: P.Y/CLIPPER_SCALE }, prev = pts[pts.length-1];
      if (!prev || Math.hypot(q.x-prev.x, q.z-prev.z) > 1e-3) pts.push(q);
    });
    while (pts.length > 2 && Math.hypot(pts[0].x-pts[pts.length-1].x, pts[0].z-pts[pts.length-1].z) <= 1e-3) pts.pop();
    let perimeter = 0;
    pts.forEach((p, k) => { const q = pts[(k+1) % pts.length]; perimeter += Math.hypot(q.x-p.x, q.z-p.z); });
    if (pts.length >= 3 && perimeter >= 6) rings.push({ pts, inserts: [] });
  });
  const nearRawRing = segmentGrid(rings.flatMap((ring, ri) => ring.pts.map((a, k) => ({ a, b: ring.pts[(k+1) % ring.pts.length], ri, k }))));
  // points that have to be ring vertices (to link to): added to the ring at the nearest point to `at`, if there's one
  // within maxD, and given back as a handle whose vi is filled in once the rings are built
  const ringPoint = (at, maxD) => {
    const hit = nearRawRing(at.x, at.z, maxD);
    if (!hit) return null;
    const handle = { k: hit.seg.k, t: hit.t, q: hit.q, li: -1, vi: -1 };
    rings[hit.seg.ri].inserts.push(handle);
    return handle;
  };
  // paths
  const pending = [];
  S.roadLines.forEach(line => {
    if (!isWalkwayLine(line)) return;
    const nodes = tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (nodes.length < 2) return;
    const { pts } = resampleLine(nodes), cum = cumulative(pts);
    if (cum[cum.length-1] < 1) return;
    const blocked = pts.map(p => inMid(p.x, p.z));
    if (blocked.every(Boolean)) return;
    const loop = line.nodeIds.length > 3 && line.nodeIds[0] === line.nodeIds[line.nodeIds.length-1]; // (drawn back onto its first node)
    const { hw } = roadLineWidths(line), li = lines.length;
    // (a path's drawn end reaches its half-width past its last point)
    const endReaches = (vi, from) => {
      const d = Math.hypot(pts[vi].x - pts[from].x, pts[vi].z - pts[from].z) || 1;
      return bySidewalk(pts[vi].x + (pts[vi].x - pts[from].x)/d*hw, pts[vi].z + (pts[vi].z - pts[from].z)/d*hw);
    };
    const nav = { pts, cum, total: cum[cum.length-1], loop, ring: false, path: true, y: Y_PATH, lateral: hw*0.55,
      blocked, overWater: pts.map(p => inWater(p.x, p.z)), vertices: pts.map(() => ({ links: [], entrances: [] })) };
    if (loop) nav.vertices[pts.length-1] = nav.vertices[0];
    lines.push(nav);
    // where it comes off a road, or ends at a sidewalk (just touching it, short of where people walk along it): onto the
    // sidewalk there
    pts.forEach((p, vi) => {
      if (loop && vi === pts.length-1) return; // (the same point as its first)
      const endsBySidewalk = !loop && ((vi === 0 && endReaches(0, 1)) || (vi === pts.length-1 && endReaches(vi, vi-1)));
      if (blocked[vi] || !(blocked[nextVertex(nav, vi, -1)] || blocked[nextVertex(nav, vi, 1)] || endsBySidewalk)) return;
      const handle = ringPoint(p, PEOPLE_NAV_SPACING + 12);
      if (handle) pending.push({ li, vi, handle });
    });
  });
  // the lanes between a suburb's hedges, walked like any other path: laid out with the plots, since they're the gaps
  // left between them (see gapLanes). They're also what brings a house in the middle of a block within reach of a door —
  // off the sidewalk, the only house anyone could walk into is one fronting the road (see buildingDoors).
  S.zones.forEach(zone => {
    if (zone.drawing || zone.zoneType !== 'suburbs') return;
    (zone.walkGaps || []).forEach(lane => {
      const { pts } = resampleLine(lane), cum = cumulative(pts);
      if (cum[cum.length-1] < 1) return;
      const blocked = pts.map(p => inMid(p.x, p.z));
      if (blocked.every(Boolean)) return;
      const li = lines.length;
      lines.push({ pts, cum, total: cum[cum.length-1], loop: false, ring: false, path: true, y: Y_ZONE_GROUND, lateral: LANE_LATERAL,
        blocked, overWater: pts.map(p => inWater(p.x, p.z)), vertices: pts.map(() => ({ links: [], entrances: [] })) });
      // a lane that comes out at the pavement joins the sidewalk there, the way a drawn path's end does. The others meet
      // the lanes they run into, which byPlace picks up from the point they share.
      [0, pts.length-1].forEach(vi => {
        const handle = !blocked[vi] && ringPoint(pts[vi], LANE_TO_SIDEWALK);
        if (handle) pending.push({ li, vi, handle });
      });
    });
  });
  // the zebra crossings: the two ends of each, where it meets the middle of the sidewalk either side
  const zebras = [];
  (S.roadJunctions || []).forEach(j => j.arms.forEach(arm => {
    const w = arm.hw + arm.cw + arm.sw*0.5, d = j.r + 1.25, end = s => ({ x: j.x + arm.x*d + arm.z*s*w, z: j.z + arm.z*d - arm.x*s*w });
    const a = ringPoint(end(1), 2.5), b = a && ringPoint(end(-1), 2.5);
    if (a && b) zebras.push({ a, b, cross: { junction: j, arm } });
  }));
  // the rings, with those points added and every edge resampled
  rings.forEach(ring => {
    const anchors = [];
    ring.pts.forEach((p, k) => {
      anchors.push(p);
      ring.inserts.filter(h => h.k === k).sort((h1, h2) => h1.t - h2.t).forEach(h => { anchors.push(h.q); h.anchor = anchors.length - 1; });
    });
    anchors.push(ring.pts[0]);
    const { pts, at } = resampleLine(anchors), cum = cumulative(pts), li = lines.length;
    const vertices = pts.map(() => ({ links: [], entrances: [] }));
    vertices[pts.length-1] = vertices[0]; // (the ring's last point is its first)
    ring.inserts.forEach(h => { h.li = li; h.vi = at[h.anchor] === pts.length-1 ? 0 : at[h.anchor]; });
    lines.push({ pts, cum, total: cum[cum.length-1], loop: true, ring: true, path: false, y: anySidewalk ? Y_SIDEWALK : Y_ROAD, lateral: 0.7,
      blocked: null, overWater: null, vertices });
  });
  const link = (a, b, cross) => {
    lines[a.li].vertices[a.vi].links.push({ li: b.li, vi: b.vi, cross });
    lines[b.li].vertices[b.vi].links.push({ li: a.li, vi: a.vi, cross });
  };
  pending.forEach(({ li, vi, handle }) => link({ li, vi }, handle));
  zebras.forEach(({ a, b, cross }) => link(a, b, cross));
  // paths meeting at a node
  const byPlace = new Map();
  lines.forEach((nav, li) => nav.path && nav.pts.forEach((p, vi) => {
    if (nav.blocked[vi] || (nav.loop && vi === nav.pts.length-1)) return;
    const key = Math.round(p.x*2) + ',' + Math.round(p.z*2);
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push({ li, vi });
  }));
  byPlace.forEach(list => list.forEach(a => list.forEach(b => {
    if (b.li !== a.li) lines[a.li].vertices[a.vi].links.push({ li: b.li, vi: b.vi });
  })));
  lines.forEach(nav => {
    nav.mitres = nav.pts.map((p, vi) => navVertexMitre(nav.pts, vi, nav.loop));
    if (!nav.ring) return;
    // which side of the ring the road's on (relative to the mitres)
    let votes = 0;
    nav.pts.forEach((p, vi) => {
      const m = nav.mitres[vi], len = Math.hypot(m.x, m.z) || 1;
      votes += inMid(p.x + m.x/len*0.3, p.z + m.z/len*0.3) ? 1 : -1;
    });
    nav.roadSide = votes >= 0 ? 1 : -1;
  });
  // entrances: points beside (or, for a path, in) a plaza or park — never looking across a road; and a grid of every
  // point people can be at, for finding the nearest
  const grid = new Map(), CELL = 16;
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    if ((nav.loop && vi === nav.pts.length-1) || (nav.blocked && nav.blocked[vi])) return;
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ li, vi });
    if (!areas.length) return;
    const m = nav.mitres[vi], len = Math.hypot(m.x, m.z) || 1, nx = m.x/len, nz = m.z/len, edge = nav.lateral + (nav.ring ? 1.5 : 0);
    // look straight out from the walkway, a few steps further each time — a zone's edge can sit well back from the
    // sidewalk — and, for a path, at the path itself (running through a park)
    const areaAt = (x, z) => areas.findIndex(ar => x >= ar.minX && x <= ar.maxX && z >= ar.minZ && z <= ar.maxZ && ar.inside(x, z));
    const entrances = nav.vertices[vi].entrances;
    (nav.ring ? [-nav.roadSide] : [1, -1]).forEach(side => {
      const offsets = (nav.path ? [0] : []).concat([2, 5, 9, 14].map(extra => side*(edge + extra)));
      for (const off of offsets) {
        const x = p.x + nx*off, z = p.z + nz*off;
        if (onPavement(x, z)) break;
        const area = areaAt(x, z);
        if (area >= 0) { entrances.push({ area, side, x, z }); if (!areas[area].exits.some(e => e.li === li && e.vi === vi)) areas[area].exits.push({ li, vi, x, z }); break; }
      }
    });
  }));
  // for crossing mid-block: the nearest point on any ring
  const nearRing = segmentGrid(lines.flatMap((nav, li) => nav.ring ? nav.pts.slice(0, -1).map((a, seg) => ({ a, b: nav.pts[seg+1], li, seg })) : []));
  const buildings = buildingDoors(lines, grid, CELL, onPavement, widestSidewalk);
  return { areas, lines, grid, CELL, onPath, onPavement, nearRing, buildings };
}

/** How much slack, and the cap, on how far off a walkway a building's door may be (see doorReach). */
const DOOR_SLACK = 4, DOOR_REACH_MAX = 20;

/**
 * How far off a walkway point a building may stand and still be walked into.
 *
 * Derived from the zone's own settings, not a flat number: half the sidewalk width to reach the kerb, plus the zone's
 * setbacks to reach the lot's edge, plus DOOR_SLACK for a footprint that doesn't fill its lot (a rounded or stepped-back
 * one). Capped at DOOR_REACH_MAX, so nobody hikes across a field to a door.
 *
 * `zone.doorSetback` is for a zone that stands its buildings back by an amount its settings don't name — a suburb keeps
 * its front gardens in its layout rather than in a setting, so it says so there instead (see generateSuburbsContent).
 * @param {object} zone - the zone the building stands in
 * @param {number} sidewalkWidth - the widest sidewalk in the city
 * @returns {number} how far a door may be, in world units
 */
const doorReach = (zone, sidewalkWidth) =>
  Math.min(DOOR_REACH_MAX, sidewalkWidth*0.5 + (zone.settings.setback || 0) + (zone.settings.borderSetback || 0) + (zone.doorSetback || 0) + DOOR_SLACK);

/**
 * Find the door of every building people can go into: each enterable building that keeps its footprint on the walkway,
 * close enough to a walkway point, with no road in between, gets a door on the wall nearest the nearest such point —
 * which is where people on that walkway go in. The point's vertex gets `building`.
 * @param {NavLine[]} lines - the walkways
 * @param {Map<string, Array<{li: number, vi: number}>>} grid - walkway points bucketed by cell (see buildPeopleNav)
 * @param {number} CELL - the grid's cell size
 * @param {function(number, number): boolean} onPavement - whether a point is on the road network
 * @param {number} sidewalkWidth - the widest sidewalk in the city
 * @returns {object[]} one { key, number, kind, x, z, y, height, size, door: { x, z } } per building
 */
function buildingDoors(lines, grid, CELL, onPavement, sidewalkWidth) {
  const buildings = [];
  S.zones.forEach(zone => {
    const reach = doorReach(zone, sidewalkWidth);
    (zone.buildingsGroup?.children || []).forEach((group, k) => {
      const fp = group.userData.footprint;
      if (!fp || fp.length < 3) return;
      const kind = buildingKindOf(group, zone);
      if (!buildingEnterable(kind)) return; // (nobody wanders into a tank farm: see enterable in buildings.txt)
      const c = centroid(fp), size = Math.max(...fp.map(q => Math.hypot(q.x - c.x, q.z - c.z)));
      const span = Math.ceil((size + reach)/CELL), cx = Math.floor(c.x/CELL), cz = Math.floor(c.z/CELL);
      /** @type {?{li: number, vi: number, q: {x: number, z: number}, d: number, from: {x: number, z: number}}} */
      let best = null;
      for (let ox=-span;ox<=span;ox++) for (let oz=-span;oz<=span;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
        const p = lines[li].pts[vi];
        /** @type {?{q: {x: number, z: number}, d: number}} */
        let wall = null;
        fp.forEach((a, n) => {
          const q = closestPointOnSegment(p, a, fp[(n+1) % fp.length]), d = Math.hypot(q.x - p.x, q.z - p.z);
          if (!wall || d < wall.d) wall = { q, d };
        });
        if (!wall || wall.d > reach || wall.d < 0.5 || (best && wall.d >= best.d)) return;
        for (let t=0.2;t<1;t+=0.2) if (onPavement(p.x + (wall.q.x - p.x)*t, p.z + (wall.q.z - p.z)*t)) return; // (across a road)
        best = { li, vi, ...wall, from: p };
      });
      if (!best) return;
      const vertex = lines[best.li].vertices[best.vi];
      if (vertex.building) return; // (a door onto that point already)
      // just short of the wall, so they don't walk into it
      const back = Math.min(0.4, best.d)/best.d;
      const key = buildingKey(zone, k);
      const building = { key, number: buildingNumber(key), kind,
        x: c.x, z: c.z, y: Y_ZONE_GROUND, height: group.userData.height || 10, size,
        door: { x: best.q.x + (best.from.x - best.q.x)*back, z: best.q.z + (best.from.z - best.q.z)*back } };
      vertex.building = building;
      buildings.push(building);
    });
  });
  return buildings;
}

/**
 * Put a person on walkway `li` at distance u along it, heading `dir`, somewhere across it.
 * @param {Person} p - the person
 * @param {number} li - the walkway
 * @param {number} u - how far along it they are
 * @param {number} dir - which way along it they head
 * @returns {void}
 */
export function joinWalkway(p, li, u, dir) {
  const nav = peopleNav.lines[li];
  p.mode = 'line'; p.li = li; p.dir = dir; p.u = Math.max(0, Math.min(nav.total, u));
  p.seg = 0;
  while (p.seg < nav.pts.length-2 && nav.cum[p.seg+1] <= p.u) p.seg++;
  p.lat = (peopleRng()-0.5)*2*nav.lateral;
}

/**
 * Send a person off into a hangout, to pick their way about in it.
 * @param {Person} p - the person
 * @param {number} areaIndex - the hangout, in peopleNav.areas
 * @param {?{x: number, z: number}} near - roughly where to head first, or null
 * @returns {void}
 */
export function wanderInto(p, areaIndex, near) {
  const spot = randomSpotIn(peopleNav.areas[areaIndex], near);
  p.mode = 'wander'; p.area = areaIndex; p.tx = spot.x; p.tz = spot.z; p.wait = 0;
}

/**
 * Put a person somewhere on the map to begin with: in a hangout, or on a walkway.
 * @param {Person} p - the person
 * @returns {void}
 */
export function spawnPerson(p) {
  const { areas, lines } = peopleNav;
  if (areas.length && (!lines.length || peopleRng() < 0.45)) {
    const ai = pickWeighted(areas, a => a.size), spot = randomSpotIn(areas[ai]);
    p.x = spot.x; p.z = spot.z; p.y = areas[ai].y;
    wanderInto(p, ai, spot);
    p.wait = peopleRng()*6;
  } else if (lines.length) {
    const li = pickWeighted(lines, l => l.total), nav = lines[li];
    let u = peopleRng()*nav.total;
    // (not out on a road, for a path that crosses one)
    for (let k=0; k<8 && nav.blocked && nav.blocked.some((b, vi) => b && Math.abs(nav.cum[vi] - u) < PEOPLE_NAV_SPACING); k++) u = peopleRng()*nav.total;
    joinWalkway(p, li, u, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else {
    p.mode = 'none';
  }
}

/**
 * Set a person back on the map after the walkways are rebuilt: back into the hangout they're standing in, else onto the
 * nearest walkway, else anywhere.
 * @param {Person} p - the person
 * @returns {void}
 */
export function reseatPerson(p) {
  if (p.mode === 'dead') return; // (who stays that way)
  if (p.mode === 'train') return; // (up in a station or on a train, and dropped back onto whatever's there when they're done)
  if (p.mode === 'possessed') return; // (walked wherever they're walked, and set back on a walkway when let go)
  if (p.mode === 'indoors') {
    if (p.indoors.stage === 'inside') return; // (back out where they went in, when they're done)
    p.indoors = null; p.mode = 'line'; // (on their way in or out: back onto the walkway)
  }
  const { areas, lines, grid, CELL } = peopleNav;
  if (p.mode === 'wander' || p.mode === 'leaving') {
    const ai = areas.findIndex(a => p.x >= a.minX && p.x <= a.maxX && p.z >= a.minZ && p.z <= a.maxZ && a.inside(p.x, p.z));
    if (ai >= 0) { wanderInto(p, ai, p); return; }
  }
  if (p.mode !== 'none') {
    /** @type {?{li: number, vi: number, d: number}} */
    let best = null;
    const cx = Math.floor(p.x/CELL), cz = Math.floor(p.z/CELL);
    for (let ox=-2;ox<=2;ox++) for (let oz=-2;oz<=2;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      const q = lines[li].pts[vi], d = Math.hypot(q.x-p.x, q.z-p.z);
      if (!best || d < best.d) best = { li, vi, d };
    });
    if (best) { placeAtVertex(p, best.li, best.vi, p.dir || 1); return; }
  }
  spawnPerson(p);
}

/**
 * Work out where a person on a walkway should be: the walkway's point at their distance along it, set off to one side
 * by p.lat.
 * @param {Person} p - the person
 * @returns {{x: number, y: number, z: number}} where they are
 */
export function walkwayPoint(p) {
  const nav = peopleNav.lines[p.li];
  const point = Math.max(0, Math.min(nav.pts.length-2, p.seg));
  const a = nav.pts[point], b = nav.pts[point+1], segLen = (nav.cum[point+1] - nav.cum[point]) || 1;
  const t = Math.max(0, Math.min(1, (p.u - nav.cum[point])/segLen));
  // blending between the two points' own offsets, so the walkway bends round corners smoothly
  const ma = nav.mitres[point], mb = nav.mitres[point+1], k = p.lat;
  const y = nav.overWater && nav.overWater[point] && nav.overWater[point+1] ? FOOTBRIDGE_TOP : nav.y;
  return { x: a.x + (b.x-a.x)*t + (ma.x + (mb.x-ma.x)*t)*k, y, z: a.z + (b.z-a.z)*t + (ma.z + (mb.z-ma.z)*t)*k };
}

/**
 * The point after vi, heading dir — round the end, on a loop (or past it: vi -1 or pts.length).
 * @param {NavLine} nav - the walkway
 * @param {number} vi - the point they're at
 * @param {number} dir - which way they're heading
 * @returns {number} the point's index
 */
const nextVertex = (nav, vi, dir) => !nav.loop ? vi + dir : dir > 0 && vi === nav.pts.length-1 ? 1 : dir < 0 && vi === 0 ? nav.pts.length-2 : vi + dir;

/**
 * The segment someone standing at point vi, heading dir, is on — round the end, for a loop's first point going back.
 * (See walkAlong: the point ahead is seg+1 going forward, seg going back.)
 * @param {NavLine} nav - the walkway
 * @param {number} vi - the point they're at
 * @param {number} dir - which way they're heading
 * @returns {number} the segment's index
 */
const segFrom = (nav, vi, dir) => dir > 0 ? Math.min(vi, nav.pts.length-2) : nav.loop && vi === 0 ? nav.pts.length-2 : Math.max(vi-1, 0);

/**
 * Put a person on walkway li at its point vi, heading dir (or away from the end, or the road a path runs onto, there).
 * @param {Person} p - the person
 * @param {number} li - the walkway
 * @param {number} vi - the walkway point
 * @param {number} dir - which way they head along it
 * @returns {void}
 */
export function placeAtVertex(p, li, vi, dir) {
  const nav = peopleNav.lines[li];
  if (!nav.loop) { if (vi === 0) dir = 1; else if (vi === nav.pts.length-1) dir = -1; }
  if (nav.blocked?.[nextVertex(nav, vi, dir)]) dir = -dir;
  joinWalkway(p, li, nav.cum[vi], dir);
  if (nav.loop && vi === 0 && dir < 0) p.u = nav.total;
  p.seg = segFrom(nav, vi, dir);
}

/**
 * Put a person onto the walkway a (non-crossing) link leads to, either way along it.
 * @param {Person} p - the person
 * @param {{li: number, vi: number}} link - the link to take
 * @returns {NavLine} the walkway they're now on
 */
function takeLink(p, link) {
  placeAtVertex(p, link.li, link.vi, peopleRng() < 0.5 ? -1 : 1);
  p.linkCooldown = 6 + peopleRng()*4;
  return peopleNav.lines[link.li];
}

/**
 * Move a person `dist` along their walkway, dealing with each point they pass: maybe wandering into a hangout, maybe
 * turning off onto another walkway or heading over a zebra crossing, and turning back at a dead end (or where a path
 * runs onto a road). A loop just goes round and round.
 * @param {Person} p - the person
 * @param {number} dist - how far to move them
 * @returns {void}
 */
export function walkAlong(p, dist) {
  let nav = peopleNav.lines[p.li];
  let u = p.u + p.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const last = nav.pts.length-1, ahead = p.dir > 0 ? p.seg + 1 : p.seg, at = nav.cum[ahead];
    if (p.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead];
    const station = p.trainCooldown <= 0 ? stationLinks().byVertex.get(p.li + ':' + ahead) : null;
    if (station != null && peopleRng() < RIDE_CHANCE) { p.u = at; goRideTrain(p, station, walkwayPoint(p)); return; }
    if (vertex.building && mayGoIndoors(p) && peopleRng() < ENTER_CHANCE) { p.u = at; goIndoors(p, vertex.building, walkwayPoint(p)); return; }
    const isEnd = (!nav.loop && (ahead === 0 || ahead === last)) || !!nav.blocked?.[nextVertex(nav, ahead, p.dir)];
    const entrance = vertex.entrances.length ? vertex.entrances[Math.floor(peopleRng()*vertex.entrances.length)] : null;
    const drawn = entrance ? (isOpenGround(peopleNav.areas[entrance.area]) ? p.traits.parks : p.traits.plazas) : 0;
    if (entrance && peopleRng() < 0.12*drawn) { p.u = at; wanderInto(p, entrance.area, entrance); return; }
    // linkCooldown stops them turning off again immediately after a turn, which would otherwise let a junction with
    // several close-together links send them zigzagging back the way they came
    if (vertex.links.length && p.linkCooldown <= 0) {
      const crossings = vertex.links.filter(l => l.cross), turns = vertex.links.filter(l => !l.cross);
      if (crossings.length && peopleRng() < 0.35) {
        p.u = at;
        startZebraCrossing(p, nav, ahead, crossings[Math.floor(peopleRng()*crossings.length)]);
        return;
      }
      if (turns.length && peopleRng() < (isEnd ? 0.85 : 0.3)) {
        const remaining = Math.abs(u - at);
        nav = takeLink(p, turns[Math.floor(peopleRng()*turns.length)]);
        u = p.u + p.dir*remaining;
        continue;
      }
    }
    if (isEnd) { p.dir = -p.dir; u = 2*at - u; continue; }
    if (nav.loop && ahead === (p.dir > 0 ? last : 0)) {
      if (p.dir > 0) { u -= nav.total; p.seg = 0; } else { u += nav.total; p.seg = last - 1; }
      continue;
    }
    p.seg += p.dir;
  }
  p.u = Math.max(0, Math.min(nav.total, u));
}

// Crossing a road. p.jc holds the way over: route (the points walked through, route[i] the one being walked to), legs (the
// crossStage while walking to each), holds (the one, if any, while waiting on arriving at each), to (where it comes out)
// and back (where they came from, for giving up).
//
// p.crossStage is where they are on it:
// - at a junction's zebra crossing: 'jwalk' to the curb, 'jwait' there until that road's lights have gone red with time
//   enough left to get over and nothing still moving across it, then 'jcross' over
// - anywhere else: 'jwalk' to the curb, 'curb' checking for traffic (giving up after a while), 'half1' to the middle,
//   'mid' checking again, 'half2' the rest of the way — straight out once a car has stopped to let them over, and with no
//   car able to hit them until they are off the road (jc.waved, checkYield in traffic.js)
/** How far someone checks for traffic before crossing, how long they'll wait at a curb, and the chance and pace of a crossing. */
export const ROADSAFETY_RADIUS = 14, CROSS_CURB_TIMEOUT = 10, CROSS_DECIDE_CHANCE = 0.15, CROSS_SPEED_MULT = 1.6;

/**
 * Start a person over the zebra crossing a link is.
 * @param {Person} p - the person
 * @param {NavLine} nav - the walkway they're on
 * @param {number} vi - the walkway point the crossing starts at
 * @param {{li: number, vi: number, cross: {junction: object, arm: object}}} link - the crossing
 * @returns {void}
 */
function startZebraCrossing(p, nav, vi, link) {
  p.jc = { route: [nav.pts[vi], peopleNav.lines[link.li].pts[link.vi]], legs: ['jwalk', 'jcross'], holds: ['jwait', null], i: 0,
    holding: false, to: { li: link.li, vi: link.vi }, back: null, junction: link.cross.junction, arm: link.cross.arm, checkIn: 0, wait: Infinity };
  p.crossStage = 'jwalk';
}

/**
 * Now and then, someone on a sidewalk heads straight over the road beside them — if it is just the one road, out of the
 * way of any junction, with sidewalk on the far side.
 * @param {Person} p - the person
 * @param {NavLine} nav - the walkway they're on
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function maybeCrossRoad(p, nav, dt) {
  if (!nav.ring || (p.crossCheckIn -= dt) > 0) return;
  p.crossCheckIn = 4 + peopleRng()*6;
  if (peopleRng() >= CROSS_DECIDE_CHANCE) return;
  const { onPavement, nearRing } = peopleNav, here = walkwayPoint(p);
  const vi = Math.abs(p.u - nav.cum[p.seg]) < Math.abs(p.u - nav.cum[p.seg+1]) ? p.seg : p.seg+1, m = nav.mitres[vi], len = Math.hypot(m.x, m.z);
  if (len < 1e-6) return;
  const nx = m.x/len*nav.roadSide, nz = m.z/len*nav.roadSide;
  // along the way over: onto the road, then off it again
  let enter = -1, leave = -1;
  for (let d = 0.25; d < 60; d += 0.25) {
    const on = onPavement(here.x + nx*d, here.z + nz*d);
    if (enter < 0) { if (on) enter = d; else if (d > 6) return; }
    else if (!on) { leave = d; break; }
  }
  if (leave < 0) return;
  const far = nearRing(here.x + nx*(leave + enter), here.z + nz*(leave + enter), 2);
  if (!far) return;
  const curb = { x: here.x + nx*Math.max(0, enter - 0.4), z: here.z + nz*Math.max(0, enter - 0.4) };
  const mid = { x: here.x + nx*(enter + leave)/2, z: here.z + nz*(enter + leave)/2 };
  if ((S.roadJunctions || []).some(j => [here, mid, far.q].some(q => Math.hypot(j.x - q.x, j.z - q.z) < j.r + 8))) return;
  const other = peopleNav.lines[far.seg.li], s = far.seg.seg;
  p.jc = { route: [curb, mid, far.q], legs: ['jwalk', 'half1', 'half2'], holds: ['curb', 'mid', null], i: 0, holding: false,
    to: { li: far.seg.li, u: other.cum[s] + far.t*(other.cum[s+1] - other.cum[s]) }, back: { li: p.li, u: p.u, dir: p.dir },
    junction: null, arm: null, checkIn: 0, wait: CROSS_CURB_TIMEOUT };
  p.crossStage = 'jwalk';
}

/**
 * Work out whether it's safe to set off on the crossing's next leg.
 * @param {Person} p - the person crossing
 * @param {object} jc - the way over they're taking (see maybeCrossRoad)
 * @param {number} speed - how fast they walk
 * @returns {boolean} whether they can go
 */
function crossingClear(p, jc, speed) {
  const from = jc.route[jc.i-1], to = jc.route[jc.i], radius = ROADSAFETY_RADIUS*p.traits.roadsafety;
  if (!jc.junction && p.crossStage === 'mid') {
    // halfway, only the far lane's still to cross, so they only check the half in front of them
    const len = Math.hypot(to.x - from.x, to.z - from.z) || 1, cx = (to.x - from.x)/len, cz = (to.z - from.z)/len;
    return !App.carsWhere((x, z, car) => {
      const dx = x - from.x, dz = z - from.z;
      return Math.hypot(dx, dz) < radius && dx*cx + dz*cz >= 0 && App.people[car.yieldFor] !== p;
    });
  }
  if (!jc.junction) return !App.carsNearby((from.x + to.x)/2, (from.z + to.z)/2, radius);
  const j = jc.junction, arm = jc.arm, sx = arm.z, sz = -arm.x;
  const need = Math.hypot(to.x - from.x, to.z - from.z)/Math.max(0.1, speed*CROSS_SPEED_MULT) + 1;
  // Check for cars:
  // - no car on the crossing (stopped or not — though one stopped at the stop line, just past it, is fine)
  // - none still moving in over the stop line
  // - none in the middle of the junction heading out this way (turning in off the road with the green)
  return signalRedLeft(j, arm.phase, lastPeopleTime) >= Math.min(need, 9) && !App.carsWhere((x, z, car) => {
    const a = (x - j.x)*arm.x + (z - j.z)*arm.z, s = (x - j.x)*sx + (z - j.z)*sz;
    if (Math.hypot(x - j.x, z - j.z) < j.r + 1) return Math.sin(car.heading)*arm.x + Math.cos(car.heading)*arm.z > 0.3;
    if (a <= j.r*0.5 || Math.abs(s) >= arm.hw + 1.5) return false;
    return a < j.r + 2.9 || (car.speed > 0.5 && a < j.r + 6);
  });
}

/**
 * Take a person off the crossing, onto the walkway at dest.
 * @param {Person} p - the person
 * @param {{li: number, vi?: number, u?: number, dir?: number}} dest - where they come out
 * @returns {void}
 */
function endCrossing(p, dest) {
  p.crossStage = null;
  p.jc = null;
  p.faceTo = null;
  const dir = dest.dir || (peopleRng() < 0.5 ? -1 : 1);
  if (dest.vi != null) placeAtVertex(p, dest.li, dest.vi, dir); else joinWalkway(p, dest.li, dest.u, dir);
  p.linkCooldown = 6 + peopleRng()*4;
  p.crossCheckIn = 4 + peopleRng()*6;
}

/**
 * Work out the next step of a crossing.
 * @param {Person} p - the person crossing
 * @param {number} dt - seconds since the last frame
 * @param {number} speed - how fast they walk
 * @returns {?{x: number, y: number, z: number}} where to head for this frame (null to stand still)
 */
export function updateCrossing(p, dt, speed) {
  const jc = p.jc;
  if (jc.holding) {
    p.faceTo = headingTo(p, jc.route[jc.i]);
    if (p.crossStage === 'curb' && (jc.wait -= dt) <= 0) { endCrossing(p, jc.back); return walkwayPoint(p); } // no gap in time
    if ((jc.checkIn -= dt) > 0) return null;
    jc.checkIn = 0.3 + peopleRng()*0.3;
    if (p.crossStage === 'mid' && App.carsWhere((x, z, car) => App.people[car.yieldFor] === p)) jc.waved = true;
    if (!jc.waved && !crossingClear(p, jc, speed)) return null;
    jc.holding = false;
    p.faceTo = null;
    p.crossStage = jc.legs[jc.i];
  }
  const target = jc.route[jc.i];
  if (Math.hypot(target.x - p.x, target.z - p.z) < 0.2) {
    if (jc.i === jc.route.length - 1) { endCrossing(p, jc.to); return walkwayPoint(p); }
    const hold = jc.holds[jc.i];
    jc.i++;
    if (hold) { jc.holding = true; jc.checkIn = 0; p.crossStage = hold; return null; }
    p.crossStage = jc.legs[jc.i];
  }
  const next = jc.route[jc.i];
  return { x: next.x, y: peopleNav.lines[p.li].y, z: next.z };
}

