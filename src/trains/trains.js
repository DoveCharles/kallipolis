import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, computeWindowGlowFactor, SKY_ENV_MAP, snapPointToGrid } from '../core/scene.js';
import { mergeGeometryList } from '../buildings/windows.js';
import { roadNodes } from '../core/state.js';
import { disposeObject } from '../roads/roads.js';

// ---------------------------------------------------------- trains
// Train lines live in roadNodes/roadLines alongside roads (line.kind === 'train'), so drawing, dragging, joining,
// inserting and deleting all run through the same editing code. What differs: their nodes carry a height (y) and
// move in 3D, the line always curves smoothly through them (there's no poly/spline — a node is either plain track
// or a station), and instead of a road surface each line is built as a glass tube wound with a solenoid
// coil, held up by pairs of support beams, with a station building at every 'station' node. Junctions between
// train lines aren't specially handled — tubes that meet simply pass through each other. Each line has one shuttle
// carriage running back and forth along its whole length, stopping at its stations (see updateTrainShuttles).
S.TRAIN_DEFAULT_RADIUS = 2.5;
S.TRAIN_DEFAULT_HEIGHT = 14;       // height of a new line's first node (later nodes follow the one before)
const TRAIN_MIN_HEIGHT = 0.5;
const TRAIN_SUPPORT_SPACING = 28;    // world units between pairs of support beams
S.TRAIN_COIL_TURNS_PER_10 = 1;     // how tightly the solenoid coil winds: full turns per 10 world units of track
const TRAIN_TUBE_SIDES = 20;
const TRAIN_STATION_LENGTH = 24;
const TRAIN_STATION_NODE_COLOR = 0x5ab8ff;
const TRAIN_SHUTTLE_SPEED = 45;      // world units per second, averaged over each run between stops
const TRAIN_STATION_DWELL = 3.5;     // seconds a shuttle stops at each station
const TRAIN_END_DWELL = 1.5;         // seconds it pauses at an end of the line (one without a station) before heading back
let trainShuttles = [];              // rebuilt with the train meshes; moved every frame by updateTrainShuttles

export function isTrainLine(line) { return line.kind==='train'; }
function trainNodeIdSet() {
  const ids = new Set();
  S.roadLines.forEach(line => { if (isTrainLine(line)) line.nodeIds.forEach(id => ids.add(id)); });
  return ids;
}
export function isTrainNode(nodeId) { return S.roadLines.some(line => isTrainLine(line) && line.nodeIds.includes(nodeId)); }
// the selection type / entity tab a line's network belongs to
export function networkKindOf(line) { return isTrainLine(line) ? 'train' : 'road'; }
export function trainNodeY(n) { return n.y!=null ? n.y : S.TRAIN_DEFAULT_HEIGHT; }
function trainStationSize(radius) { return { width: radius*2 + 5, height: radius*2 + 2.5 }; }

// A train line's centerline as 3D points — always the smoothest curve through its nodes, never a corner: a cubic
// Hermite spline whose direction at each node follows the line from the node before to the node after, scaled by
// the distances between them (chord-length Catmull-Rom), so unevenly spaced nodes don't make it bulge or overshoot.
// At a station the direction is kept level, so the track runs flat through the station. `segments[k]` is the index
// of the node-to-node stretch points[k] lies on.
function trainCurve(nodeIds) {
  const nodes = nodeIds.map(id => roadNodes[id]).filter(Boolean);
  const P = nodes.map(n => new THREE.Vector3(n.x, trainNodeY(n), n.z));
  const count = P.length;
  if (count < 2) return { points: P, segments: P.map(() => 0) };
  const chord = [];
  for (let i=0;i<count-1;i++) chord.push(Math.max(1e-6, P[i].distanceTo(P[i+1])));
  const directions = P.map((p, i) => {
    const d = i===0 ? P[1].clone().sub(P[0]).divideScalar(chord[0])
      : i===count-1 ? P[i].clone().sub(P[i-1]).divideScalar(chord[i-1])
      : P[i+1].clone().sub(P[i-1]).divideScalar(chord[i-1] + chord[i]);
    if (nodes[i].type==='station') {
      const len = d.length();
      d.y = 0;
      if (d.lengthSq() > 1e-8) d.setLength(len);
    }
    return d;
  });
  const points = [P[0].clone()], segments = [0];
  for (let i=0;i<count-1;i++) {
    const steps = Math.max(6, Math.ceil(chord[i]/2)); // a point every couple of units, so the tube stays round on curves
    const m0 = directions[i].clone().multiplyScalar(chord[i]), m1 = directions[i+1].clone().multiplyScalar(chord[i]);
    for (let s=1;s<=steps;s++) {
      const t = s/steps, t2 = t*t, t3 = t2*t;
      points.push(new THREE.Vector3()
        .addScaledVector(P[i], 2*t3 - 3*t2 + 1).addScaledVector(m0, t3 - 2*t2 + t)
        .addScaledVector(P[i+1], -2*t3 + 3*t2).addScaledVector(m1, t3 - t2));
      segments.push(i);
    }
  }
  // drop repeated points (nodes stacked on top of each other), so every segment has a direction
  const outPoints = [], outSegments = [];
  points.forEach((p, k) => {
    if (outPoints.length && p.distanceToSquared(outPoints[outPoints.length-1]) <= 1e-8) return;
    outPoints.push(p); outSegments.push(segments[k]);
  });
  return { points: outPoints, segments: outSegments };
}
// Arc-length lookups along a path: the point and heading a given distance from its start, and how far along the
// path the point nearest some position is.
function createPathSampler(path) {
  const cum = [0];
  for (let i=1;i<path.length;i++) cum.push(cum[i-1] + path[i].distanceTo(path[i-1]));
  const total = cum[cum.length-1];
  return {
    total,
    at(d) {
      d = Math.max(0, Math.min(total, d));
      let lo = 1, hi = path.length-1;
      while (lo < hi) { const mid = (lo+hi)>>1; if (cum[mid] < d) lo = mid+1; else hi = mid; }
      const a = path[lo-1], b = path[lo], seg = cum[lo]-cum[lo-1];
      return { point: a.clone().lerp(b, seg>0 ? (d-cum[lo-1])/seg : 0), tangent: b.clone().sub(a).normalize() };
    },
    distanceOf(p) {
      let best = 0, bestD = Infinity;
      path.forEach((q, i) => { const dd = q.distanceToSquared(p); if (dd < bestD) { bestD = dd; best = i; } });
      return cum[best];
    }
  };
}
// The glass tube: a ring of vertices around every path point, carried along without twisting, and stretched across
// each bend so the straight runs either side meet in a clean mitre instead of pinching at the corner.
function buildTubeGeometry(path, radius) {
  const n = path.length, sides = TRAIN_TUBE_SIDES;
  const dirs = [];
  for (let i=0;i<n-1;i++) dirs.push(path[i+1].clone().sub(path[i]).normalize());
  const positions = [], normals = [], uvs = [], indices = [];
  let normal = null;
  for (let i=0;i<n;i++) {
    const dIn = dirs[Math.max(0, i-1)], dOut = dirs[Math.min(n-2, i)];
    const t = dIn.clone().add(dOut);
    if (t.lengthSq() < 1e-8) t.copy(dOut);
    t.normalize();
    if (!normal) normal = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
    normal.addScaledVector(t, -normal.dot(t));
    if (normal.lengthSq() < 1e-8) {
      normal.set(0,0,1).addScaledVector(t, -t.z);
      if (normal.lengthSq() < 1e-8) normal.set(1,0,0).addScaledVector(t, -t.x);
    }
    normal.normalize();
    const binormal = new THREE.Vector3().crossVectors(t, normal);
    const bend = dOut.clone().sub(dIn);
    const stretch = bend.lengthSq() > 1e-8 ? 1/Math.max(0.25, dIn.dot(t)) - 1 : 0;
    if (stretch) bend.normalize();
    for (let s=0;s<=sides;s++) {
      const ang = s/sides*Math.PI*2;
      const radial = normal.clone().multiplyScalar(Math.cos(ang)).addScaledVector(binormal, Math.sin(ang));
      const offset = radial.clone().multiplyScalar(radius);
      if (stretch) offset.addScaledVector(bend, radial.dot(bend)*radius*stretch);
      positions.push(path[i].x+offset.x, path[i].y+offset.y, path[i].z+offset.z);
      normals.push(radial.x, radial.y, radial.z);
      uvs.push(s/sides, i/(n-1));
    }
  }
  for (let i=0;i<n-1;i++) {
    for (let s=0;s<sides;s++) {
      const a = i*(sides+1)+s, b = a+sides+1;
      indices.push(a, b, a+1, a+1, b, b+1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}
// The solenoid coil: one continuous flat ribbon spiralling around the tube, `turnsPer10` full turns per 10 world units
// of track. It's wound on a frame carried along the track without twisting (as the tube is), so the spiral keeps an
// even pitch through curves, and the ribbon's width always lies across its own direction of travel on the tube's
// surface — so it stays a flat ribbon whether it's wound tight (running round the tube) or loose (running along it).
// Stretches where `skip(distance)` is true (inside stations) are left out. Returns two geometries: `outer`, the
// outward face and the two edges, and `inner`, the face turned in toward the glass — so each can take its own material.
function buildCoilGeometries(sampler, radius, turnsPer10, skip) {
  const coilRadius = radius*1.06, halfWidth = Math.max(0.3, radius*0.16)/2, halfDepth = Math.max(0.12, radius*0.06)/2;
  const turnsPerUnit = turnsPer10/10;
  const total = sampler.total;
  const samples = Math.max(2, Math.ceil(total / Math.min(0.5, 1/(Math.max(turnsPerUnit, 1e-3)*28)))); // ~28 per turn
  const lean = 2*Math.PI*turnsPerUnit*coilRadius; // how far round the tube the coil moves per unit along it
  const runs = [];
  let run = null, normal = null;
  for (let k=0;k<=samples;k++) {
    const d = total*k/samples;
    const p = sampler.at(d).point;
    const t = sampler.at(Math.min(total, d + 0.5)).point.sub(sampler.at(Math.max(0, d - 0.5)).point).normalize();
    // carry the frame along even through skipped stretches, so the spiral picks up where it left off
    if (!normal) normal = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
    normal.addScaledVector(t, -normal.dot(t));
    if (normal.lengthSq() < 1e-8) normal.set(0,0,1).addScaledVector(t, -t.z);
    normal.normalize();
    if (skip(d)) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    const theta = 2*Math.PI*turnsPerUnit*d;
    const binormal = new THREE.Vector3().crossVectors(t, normal);
    const u = normal.clone().multiplyScalar(Math.cos(theta)).addScaledVector(binormal, Math.sin(theta)); // out from the axis
    const w = new THREE.Vector3().crossVectors(t, u);                                                   // round the tube
    const across = t.clone().multiplyScalar(lean).sub(w).normalize(); // the ribbon's width: across its path on the tube
    run.push({ p, u, across });
  }
  const outer = { pos:[], nrm:[], idx:[] }, inner = { pos:[], nrm:[], idx:[] };
  const rIn = coilRadius - halfDepth, rOut = coilRadius + halfDepth;
  // each face is a strip between two corners of the ribbon's cross-section, given as [out from the axis, across]
  const faces = [
    { mesh: outer, from: [rOut, -halfWidth], to: [rOut, halfWidth], normal: s => s.u },
    { mesh: outer, from: [rIn, -halfWidth], to: [rOut, -halfWidth], normal: s => s.across.clone().negate() },
    { mesh: outer, from: [rOut, halfWidth], to: [rIn, halfWidth], normal: s => s.across },
    { mesh: inner, from: [rIn, halfWidth], to: [rIn, -halfWidth], normal: s => s.u.clone().negate() },
  ];
  runs.forEach(r => {
    if (r.length < 2) return;
    faces.forEach(face => {
      const m = face.mesh, base = m.pos.length/3;
      r.forEach(s => {
        const n = face.normal(s);
        [face.from, face.to].forEach(([out, side]) => {
          m.pos.push(s.p.x + s.u.x*out + s.across.x*side, s.p.y + s.u.y*out + s.across.y*side, s.p.z + s.u.z*out + s.across.z*side);
          m.nrm.push(n.x, n.y, n.z);
        });
      });
      for (let k=0;k<r.length-1;k++) { const a = base + k*2, b = a + 2; m.idx.push(a, b, a+1, a+1, b, b+1); }
    });
  });
  const toGeometry = m => {
    if (!m.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3));
    geo.setIndex(m.idx);
    return geo;
  };
  return { outer: toGeometry(outer), inner: toGeometry(inner) };
}
// a pair of beams either side of `point` (across the track's heading), from the ground up to `topY`
function addSupportBeams(geos, point, tangent, halfGap, topY, beamW) {
  if (topY < 0.5) return;
  const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
  if (side.lengthSq() < 1e-6) side.set(1,0,0); else side.normalize();
  const yaw = Math.atan2(-tangent.z, tangent.x);
  [-1, 1].forEach(sign => {
    const beam = new THREE.BoxGeometry(beamW, topY, beamW);
    beam.rotateY(yaw);
    beam.translate(point.x + side.x*halfGap*sign, topY/2, point.z + side.z*halfGap*sign);
    geos.push(beam);
  });
}
// A station, built around the tube's centerline at `position`, always level and turned to the track's heading, in
// roughly the footprint of a TRAIN_STATION_LENGTH-long, trainStationSize(radius) box:
//  • a stadium-shaped platform deck just under the tube, ringed by a glowing trim line;
//  • a glass vault rising from the deck's edge — a half-ellipse cross-section along the middle, closing into
//    quarter-ellipsoid ends over the deck's rounded ends — which the tube runs straight through;
//  • chrome ribs across the vault, a chrome spine along its ridge, a chrome portal ring where the tube pierces each
//    end, and a small chrome orb and needle on top;
//  • an entrance in each long side: a pair of dark glass doors set into the vault's curve, framed in chrome under a
//    glowing lintel, with a landing jutting out from the deck below and a small awning above;
//  • a single flared pylon from the ground up to the deck.
// Returns the parts, each with the material it uses.
function buildStationParts(position, tangent, radius, mats) {
  const { width, height } = trainStationSize(radius);
  const halfW = width/2, halfL = TRAIN_STATION_LENGTH/2;
  const capLength = Math.min(halfW, halfL);      // the rounded ends are half-discs in plan
  const straightHalf = halfL - capLength;
  // local coordinates: x across the track, y up (0 = the tube's centerline), z along the track
  const deckTop = -radius - 0.3, deckDepth = 0.7;
  const rise = height/2 - deckTop;               // how high the vault stands above the deck
  const forward = new THREE.Vector3(tangent.x, 0, tangent.z);
  if (forward.lengthSq() < 1e-6) forward.set(1,0,0); else forward.normalize();
  const up = new THREE.Vector3(0,1,0);
  const place = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, forward), up, forward).setPosition(position);
  const parts = [];
  const add = (geo, material, name, opaque) => parts.push({ geo: geo.applyMatrix4(place), material, name, opaque });

  // deck: a stadium-shaped slab (straight sides, half-disc ends), with a thin glowing trim band around its edge
  const stadium = (hw, hl) => {
    const straight = hl - hw, shape = new THREE.Shape();
    shape.moveTo(-hw, -straight); shape.lineTo(-hw, straight);
    shape.absarc(0, straight, hw, Math.PI, 0, true);
    shape.lineTo(hw, -straight);
    shape.absarc(0, -straight, hw, 0, -Math.PI, true);
    return shape;
  };
  const slab = (shape, bottom, depth) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled:false, curveSegments:16 });
    geo.rotateX(-Math.PI/2); // the shape lies flat, extruded upward
    geo.translate(0, bottom, 0);
    return geo;
  };
  add(slab(stadium(halfW, halfL), deckTop - deckDepth, deckDepth), mats.station, 'TrainStationDeck', true);
  const trim = stadium(halfW + 0.2, halfL + 0.2);
  trim.holes.push(stadium(halfW - 0.02, halfL - 0.02));
  add(slab(trim, deckTop - deckDepth*0.65, deckDepth*0.35), mats.stationTrim, 'TrainStationTrim', true);

  // vault: rows of half-ellipse arcs along the track, full size through the middle and shrinking over each end
  // (sampled by angle there, so the curve closing onto the deck stays smooth)
  const capRows = 10, midRows = straightHalf > 0 ? 8 : 0;
  const rows = [];
  for (let k=capRows;k>0;k--) { const phi = Math.PI/2*k/capRows; rows.push({ z: -(straightHalf + capLength*Math.sin(phi)), s: Math.max(0.02, Math.cos(phi)) }); }
  for (let k=0;k<=midRows;k++) rows.push({ z: midRows ? -straightHalf + 2*straightHalf*k/midRows : 0, s: 1 });
  for (let k=1;k<=capRows;k++) { const phi = Math.PI/2*k/capRows; rows.push({ z: straightHalf + capLength*Math.sin(phi), s: Math.max(0.02, Math.cos(phi)) }); }
  const arcSteps = 24;
  const vaultPoint = (a, row, grow) => new THREE.Vector3(Math.cos(a)*halfW*row.s*grow, deckTop + Math.sin(a)*rise*row.s*grow, row.z);
  const positions = [], indices = [];
  rows.forEach(row => {
    for (let i=0;i<=arcSteps;i++) { const p = vaultPoint(Math.PI*i/arcSteps, row, 1); positions.push(p.x, p.y, p.z); }
  });
  for (let j=0;j<rows.length-1;j++) {
    for (let i=0;i<arcSteps;i++) { const a = j*(arcSteps+1)+i, b = a+arcSteps+1; indices.push(a, b, a+1, a+1, b, b+1); }
  }
  const vault = new THREE.BufferGeometry();
  vault.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  vault.setIndex(indices);
  vault.computeVertexNormals();
  add(vault, mats.stationGlass, 'TrainStationVault', false);

  // the entrances sit in the middle of each long side, as tall as fits comfortably under the vault's curve
  const doorWidth = Math.min(3.4, 2*straightHalf - 0.6), doorHeight = Math.min(3.4, rise*0.6);
  const doorTop = Math.asin(doorHeight/rise); // the arc angle, up from the deck, at the top of each door
  const hasDoors = doorWidth > 1.2;

  // chrome: ribs across the middle (stopping above the doors, where they'd cross them), a spine along the ridge, the
  // door frames, a portal ring at each end, an orb and needle on top
  const chrome = [];
  const tubeAlong = (points, thickness) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length*2, thickness, 6, false);
  const ribCount = Math.max(2, Math.round(2*straightHalf/2.6) + 1);
  for (let k=0;k<ribCount;k++) {
    const row = { z: -straightHalf + 2*straightHalf*k/(ribCount-1), s: 1 };
    const a0 = hasDoors && Math.abs(row.z) < doorWidth/2 + 0.3 ? doorTop + 0.12 : 0, a1 = Math.PI - a0;
    const pts = [];
    for (let i=0;i<=16;i++) pts.push(vaultPoint(a0 + (a1-a0)*i/16, row, 1.012));
    chrome.push(tubeAlong(pts, 0.1));
  }
  if (hasDoors) {
    // a patch of the vault's surface between two arc angles and two positions along the track, pushed out by `grow`
    const vaultPatch = (aFrom, aTo, zFrom, zTo, grow, aSteps, zSteps) => {
      const pos = [], idx = [];
      for (let j=0;j<=zSteps;j++) {
        for (let i=0;i<=aSteps;i++) {
          const p = vaultPoint(aFrom + (aTo-aFrom)*i/aSteps, { z: zFrom + (zTo-zFrom)*j/zSteps, s:1 }, grow);
          pos.push(p.x, p.y, p.z);
        }
      }
      for (let j=0;j<zSteps;j++) for (let i=0;i<aSteps;i++) { const a = j*(aSteps+1)+i, b = a+aSteps+1; idx.push(a, b, a+1, a+1, b, b+1); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    const doors = [], entrance = [], glow = [];
    const zL = -doorWidth/2, zR = doorWidth/2, landingHalf = doorWidth/2 + 0.4, reach = halfW + 1.5;
    [1, -1].forEach(side => {
      const arc = a => side > 0 ? a : Math.PI - a; // the same height up the vault, on this side
      const up = (a0, a1, z, n) => Array.from({ length: n+1 }, (_, i) => vaultPoint(arc(a0 + (a1-a0)*i/n), { z, s:1 }, 1.024));
      doors.push(vaultPatch(arc(0), arc(doorTop), zL, zR, 1.014, 8, 2));
      glow.push(vaultPatch(arc(doorTop + 0.035), arc(doorTop + 0.085), zL, zR, 1.016, 2, 2)); // the lintel
      chrome.push(tubeAlong(up(0, doorTop, zL, 8), 0.12), tubeAlong(up(0, doorTop, zR, 8), 0.12)); // jambs
      chrome.push(tubeAlong(up(0, doorTop, 0, 8), 0.05)); // where the two doors meet
      chrome.push(tubeAlong([zL, zL/2, 0, zR/2, zR].map(z => vaultPoint(arc(doorTop), { z, s:1 }, 1.024)), 0.12)); // header
      // the landing and awning: boxes running from x0 out to x1 (away from the track, on this side)
      const box = (x0, x1, y0, y1) => {
        const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, 2*landingHalf);
        geo.translate(side*(x0 + x1)/2, (y0 + y1)/2, 0);
        return geo;
      };
      entrance.push(box(halfW - 0.05, reach, deckTop - deckDepth, deckTop));
      glow.push(box(reach, reach + 0.12, deckTop - deckDepth*0.65, deckTop - deckDepth*0.3)); // the landing's edge light
      const awningY = deckTop + doorHeight + 0.55;
      const vaultX = halfW*Math.sqrt(Math.max(0, 1 - ((awningY - deckTop)/rise)**2)); // where the awning meets the glass
      entrance.push(box(vaultX - 0.1, reach, awningY, awningY + 0.16));
    });
    add(mergeGeometryList(doors), mats.stationDoor, 'TrainStationDoors', true);
    add(mergeGeometryList(entrance), mats.station, 'TrainStationEntrance', true);
    add(mergeGeometryList(glow), mats.stationTrim, 'TrainStationEntranceGlow', true);
  }
  chrome.push(tubeAlong(rows.map(row => vaultPoint(Math.PI/2, row, 1.012)), 0.13));
  // the portals sit where the vault's ridge comes down to just clear the top of the tube
  const clearance = (radius + 0.15 - deckTop)/rise;
  if (clearance < 1) {
    const zPortal = straightHalf + capLength*Math.sqrt(1 - clearance*clearance);
    [-1, 1].forEach(side => {
      const ring = new THREE.TorusGeometry(radius*1.2, Math.max(0.18, radius*0.09), 10, 36);
      ring.translate(0, 0, side*zPortal);
      chrome.push(ring);
    });
  }
  const crownY = deckTop + rise;
  const orb = new THREE.SphereGeometry(0.55, 16, 12);
  orb.translate(0, crownY + 0.3, 0);
  chrome.push(orb);
  const needle = new THREE.ConeGeometry(0.14, 2.4, 10);
  needle.translate(0, crownY + 1.9, 0);
  chrome.push(needle);
  add(mergeGeometryList(chrome), mats.chrome, 'TrainStationChrome', true);

  // pylon: a column from the ground (world y 0) up to the deck's underside, pinched at the waist and flared at the top
  const pylonTop = deckTop - deckDepth, pylonBottom = -position.y, h = pylonTop - pylonBottom;
  if (h > 0.5) {
    const profile = h >= 6
      ? [[0,0], [1.35,0], [1.05,0.5], [0.55,h*0.5], [0.7,h-2.2], [1.8,h-0.55], [2.5,h], [0,h]]
      : [[0,0], [1.0,0], [0.75,h*0.5], [1.8,h], [0,h]];
    const pylon = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 28);
    pylon.translate(0, pylonBottom, 0);
    add(pylon, mats.steel, 'TrainStationPylon', true);
  }
  return parts;
}
export function rebuildTrainMeshes() {
  scene.remove(S.trainMeshGroup); disposeObject(S.trainMeshGroup);
  S.trainMeshGroup = new THREE.Group(); S.trainMeshGroup.name = 'Trains';
  trainShuttles = [];
  // each network gets its own materials, so selecting one only highlights that network
  const materials = new Map();
  const materialsFor = netId => {
    if (!materials.has(netId)) materials.set(netId, {
      glass: new THREE.MeshStandardMaterial({ color:0xd6f1ff, transparent:true, opacity:0.3, roughness:0.05, metalness:0.1, envMap:SKY_ENV_MAP, envMapIntensity:1.5, side:THREE.DoubleSide, depthWrite:false }),
      chrome: new THREE.MeshStandardMaterial({ color:0xe8ebf0, roughness:0.15, metalness:1, envMap:SKY_ENV_MAP, envMapIntensity:1.3 }),
      coilOuter: new THREE.MeshStandardMaterial({ color:0xf3f4f6, roughness:0.35, metalness:0.15, envMap:SKY_ENV_MAP, envMapIntensity:0.9 }),
      coilInner: new THREE.MeshStandardMaterial({ color:0xc47a45, roughness:0.28, metalness:0.85, envMap:SKY_ENV_MAP, envMapIntensity:1.2 }),
      steel: new THREE.MeshStandardMaterial({ color:0x9ba1a9, roughness:0.35, metalness:0.75, envMap:SKY_ENV_MAP }),
      station: new THREE.MeshStandardMaterial({ color:0xe8ecf1, roughness:0.35, metalness:0.25, envMap:SKY_ENV_MAP, envMapIntensity:0.8 }),
      stationGlass: new THREE.MeshStandardMaterial({ color:0xaee3ff, transparent:true, opacity:0.22, roughness:0.05, metalness:0.2, envMap:SKY_ENV_MAP, envMapIntensity:1.6, side:THREE.DoubleSide, depthWrite:false }),
      stationDoor: (() => {
        const m = new THREE.MeshStandardMaterial({ color:0x1e3a50, roughness:0.15, metalness:0.6, envMap:SKY_ENV_MAP, envMapIntensity:1.2, side:THREE.DoubleSide,
          emissive:0x6fb6e0, emissiveIntensity:0.5*computeWindowGlowFactor(S.sunElevation) });
        m.userData.baseEmissiveIntensity = 0.5; // a soft glow through the doors after dark, as if lit inside
        return m;
      })(),
      stationTrim: (() => {
        const m = new THREE.MeshStandardMaterial({ color:0x5fe3ff, roughness:0.3, metalness:0.1,
          emissive:0x5fe3ff, emissiveIntensity:1.6*computeWindowGlowFactor(S.sunElevation) });
        m.userData.baseEmissiveIntensity = 1.6; // glows after dark, like building windows (see updateWindowGlowForSun)
        return m;
      })(),
      shuttle: new THREE.MeshStandardMaterial({ color:0xf4f6f9, roughness:0.25, metalness:0.55, envMap:SKY_ENV_MAP, envMapIntensity:1.2 }),
      shuttleTrim: new THREE.MeshStandardMaterial({ color:0x1b1f25, roughness:0.4, metalness:0.3, envMap:SKY_ENV_MAP, envMapIntensity:0.6 }),
      shuttleWindows: (() => {
        const m = new THREE.MeshStandardMaterial({ color:0x1d2a36, roughness:0.1, metalness:0.3, envMap:SKY_ENV_MAP,
          emissive:0x9fdcff, emissiveIntensity:1.1*computeWindowGlowFactor(S.sunElevation) });
        m.userData.baseEmissiveIntensity = 1.1; // so updateWindowGlowForSun lights them up after dark, like building windows
        return m;
      })(),
    });
    return materials.get(netId);
  };
  const addMesh = (geo, material, name, line, opaque) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = opaque; mesh.receiveShadow = true;
    mesh.userData = { networkId: line.networkId, baseColor: material.color.getHex() };
    S.trainMeshGroup.add(mesh);
  };
  S.roadLines.filter(isTrainLine).forEach(line => {
    const path = trainCurve(line.nodeIds).points;
    if (path.length < 2) return;
    const radius = line.radius || S.TRAIN_DEFAULT_RADIUS;
    const beamW = Math.max(0.3, radius*0.16);
    const sampler = createPathSampler(path);
    const mats = materialsFor(line.networkId);
    const stations = line.nodeIds.map(id => roadNodes[id]).filter(n => n && n.type==='station').map(n => {
      const position = new THREE.Vector3(n.x, trainNodeY(n), n.z);
      const dist = sampler.distanceOf(position);
      const tangent = sampler.at(dist - 0.5).tangent.add(sampler.at(dist + 0.5).tangent).normalize();
      return { position, dist, tangent };
    });
    const inStation = (d, margin) => stations.some(s => Math.abs(s.dist - d) < TRAIN_STATION_LENGTH/2 + margin);

    addMesh(buildTubeGeometry(path, radius), mats.glass, 'TrainTube', line, false);
    // the solenoid coil wound around the tube — white outside, copper on the face toward the glass; not inside stations
    const coil = buildCoilGeometries(sampler, radius, S.TRAIN_COIL_TURNS_PER_10, d => inStation(d, 0));
    if (coil.outer) addMesh(coil.outer, mats.coilOuter, 'TrainCoil', line, true);
    if (coil.inner) addMesh(coil.inner, mats.coilInner, 'TrainCoilInner', line, true);
    // pairs of beams holding the tube up at regular intervals — except inside stations, and wherever the tube is on
    // (or in) the ground with nothing to hold up
    const beams = [];
    for (let d = TRAIN_SUPPORT_SPACING/2; d < sampler.total; d += TRAIN_SUPPORT_SPACING) {
      if (inStation(d, 2)) continue;
      const { point, tangent } = sampler.at(d);
      if (point.y - radius < TRAIN_MIN_HEIGHT) continue;
      addSupportBeams(beams, point, tangent, radius*1.1 + beamW/2, point.y, beamW);
    }
    stations.forEach(s => {
      buildStationParts(s.position, s.tangent, radius, mats).forEach(part => addMesh(part.geo, part.material, part.name, line, part.opaque));
    });
    // one shuttle per line, running back and forth along all of it and stopping at each station on the way
    const shuttle = buildShuttle(radius, mats);
    const { steps, cycle } = buildShuttleTimeline(sampler.total, stations.map(s => s.dist), shuttle.userData.length);
    S.trainMeshGroup.add(shuttle);
    trainShuttles.push({ object: shuttle, sampler, steps, cycle, offset: (trainHash(line.id) % 997)/997*cycle });
    if (beams.length) addMesh(mergeGeometryList(beams), mats.steel, 'TrainSupports', line, true);
  });
  scene.add(S.trainMeshGroup);
}
function trainHash(s) { let h = 7; for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0; return h; }
// A shuttle carriage's body: a capsule — a cylinder with hemispherical ends — lathed around the Y axis.
function buildShuttleGeometry(r, length) {
  const halfBody = Math.max(0, length/2 - r), capSteps = 10, profile = [];
  for (let i=0;i<=capSteps;i++) { const a = -Math.PI/2 + (Math.PI/2)*i/capSteps; profile.push(new THREE.Vector2(Math.max(1e-4, r*Math.cos(a)), -halfBody + r*Math.sin(a))); }
  for (let i=0;i<=capSteps;i++) { const a = (Math.PI/2)*i/capSteps; profile.push(new THREE.Vector2(Math.max(1e-4, r*Math.cos(a)), halfBody + r*Math.sin(a))); }
  return new THREE.LatheGeometry(profile, 24);
}
// The train carriage is a custom model (assets/models/Carriage.glb, made in Blender). It's loaded once at startup into a
// template: each part's geometry baked
// into one space and centered on the carriage, with its length along Z and up along Y, plus `crossRadius` — how far the
// carriage reaches out from its lengthwise axis, which is what has to fit inside a tube. Each part is sorted by the
// material the model gave it: 'Window…' takes the shuttle's window material, 'Black' its dark trim, anything else its
// body. Until it's ready (or if it can't load), carriages are the built-in capsule.
const TRAIN_CARRIAGE_FIT = 0.8; // the carriage's furthest reach from its axis, as a fraction of the tube's radius
const CARRIAGE_MODEL_URL = 'assets/models/Carriage.glb';
let carriageModel = null;
export async function loadCarriageModel() {
  let buffer;
  try {
    buffer = await fetch(CARRIAGE_MODEL_URL).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  } catch (err) {
    console.warn('Blockout: the carriage model failed to load; train carriages use the built-in capsule', err);
    return;
  }
  new GLTFLoader().parse(buffer, '', (gltf) => {
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const name = ((o.material && o.material.name) || '').toLowerCase();
      parts.push({ geometry: o.geometry.clone().applyMatrix4(o.matrixWorld), role: name.startsWith('window') ? 'window' : name==='black' ? 'trim' : 'body' });
    });
    if (!parts.length) return;
    const box = new THREE.Box3();
    parts.forEach(p => { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); });
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    // lay its longest side along Z (a model exported lengthwise along X gets turned a quarter; Y stays up)
    const turn = size.x > size.z ? new THREE.Matrix4().makeRotationY(Math.PI/2) : null;
    let crossRadius = 0;
    parts.forEach(p => {
      p.geometry.translate(-center.x, -center.y, -center.z);
      if (turn) p.geometry.applyMatrix4(turn);
      const pos = p.geometry.attributes.position;
      for (let i=0;i<pos.count;i++) crossRadius = Math.max(crossRadius, Math.hypot(pos.getX(i), pos.getY(i)));
    });
    carriageModel = { parts, length: Math.max(size.x, size.z), crossRadius: crossRadius || 1 };
    rebuildTrainMeshes(); App.refreshHighlights();
  }, (err) => console.warn('Blockout: the carriage model failed to load; train carriages use the built-in capsule', err));
}
// One shuttle carriage, built along its local Z axis with up along +Y (see orientAlongTrack) and sized to its tube: the
// carriage model — scaled uniformly, keeping its proportions, so its widest cross-section fits inside the tube — or the
// capsule with a band of windows until that has loaded.
function buildShuttle(radius, mats) {
  const group = new THREE.Group();
  group.name = 'TrainShuttle';
  const addPart = (geometry, material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.userData.isShuttle = true;
    group.add(mesh);
    return mesh;
  };
  if (carriageModel) {
    const scale = radius*TRAIN_CARRIAGE_FIT/carriageModel.crossRadius;
    carriageModel.parts.forEach(part => {
      const material = part.role==='window' ? mats.shuttleWindows : part.role==='trim' ? mats.shuttleTrim : mats.shuttle;
      const mesh = addPart(part.geometry, material);
      mesh.userData.sharedGeometry = true; // every carriage reuses the model's geometry — see disposeObject
      mesh.scale.setScalar(scale);
    });
    group.userData.length = carriageModel.length*scale;
  } else {
    const r = radius*0.62, length = Math.max(8, radius*4.5);
    const body = buildShuttleGeometry(r, length), windows = new THREE.CylinderGeometry(r*1.02, r*1.02, length*0.34, 24, 1, true);
    body.rotateX(Math.PI/2); windows.rotateX(Math.PI/2); // lathed around Y; carriages run along Z
    addPart(body, mats.shuttle);
    addPart(windows, mats.shuttleWindows);
    group.userData.length = length;
  }
  group.visible = false; // shown once updateTrainShuttles has put it in place
  return group;
}
// The out-and-back schedule for a line's shuttle, as distances along the line: a stop at each end (kept far enough in
// that the whole carriage stays inside the tube) and at every station between, with a run easing out of one stop and
// into the next. Forward to the far end, then back again, and repeat. Returns the steps in order — { at, dwell } for
// a stop, { from, to, duration } for a run — and the whole cycle's length in seconds.
function buildShuttleTimeline(total, stationDists, shuttleLength) {
  const margin = Math.min(total/2, shuttleLength/2 + 0.5);
  const clamp = d => Math.max(margin, Math.min(total - margin, d));
  const stops = [{ at: margin, station: false }];
  stationDists.map(clamp).sort((p, q) => p-q).forEach(d => {
    const last = stops[stops.length-1];
    if (d - last.at < 1) last.station = true; // a station right at the end of the line is that end's stop
    else stops.push({ at: d, station: true });
  });
  if (total - margin - stops[stops.length-1].at >= 1) stops.push({ at: total - margin, station: false });
  const dwellAt = stop => stop.station ? TRAIN_STATION_DWELL : TRAIN_END_DWELL;
  const run = (a, b) => ({ from: a.at, to: b.at, duration: Math.max(1, Math.abs(b.at - a.at)/TRAIN_SHUTTLE_SPEED) });
  const steps = [];
  for (let i=0;i<stops.length;i++) {
    steps.push({ at: stops[i].at, dwell: dwellAt(stops[i]) });
    if (i < stops.length-1) steps.push(run(stops[i], stops[i+1]));
  }
  for (let i=stops.length-1;i>0;i--) {
    steps.push(run(stops[i], stops[i-1]));
    if (i-1 > 0) steps.push({ at: stops[i-1].at, dwell: dwellAt(stops[i-1]) });
  }
  return { steps, cycle: steps.reduce((sum, step) => sum + (step.dwell!=null ? step.dwell : step.duration), 0) };
}
// Runs every frame. Each shuttle's place in its cycle comes straight from the clock (plus its own offset), so
// rebuilding the train meshes doesn't restart anything.
// Turns a carriage (built along its local Z, up along +Y) to run along `tangent`: it pitches with the track's slope but
// never rolls, so its top stays up through curves.
const WORLD_UP = new THREE.Vector3(0,1,0);
function orientAlongTrack(object, tangent) {
  const forward = tangent.clone().normalize();
  const right = new THREE.Vector3().crossVectors(WORLD_UP, forward);
  if (right.lengthSq() < 1e-6) right.set(1,0,0); else right.normalize();
  const up = new THREE.Vector3().crossVectors(forward, right);
  object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward));
}
export function updateTrainShuttles(t) {
  const ease = x => x*x*(3 - 2*x);
  trainShuttles.forEach(s => {
    let phase = (t + s.offset) % s.cycle, along = s.steps[0].at;
    for (const step of s.steps) {
      const span = step.dwell!=null ? step.dwell : step.duration;
      if (phase <= span) { along = step.dwell!=null ? step.at : step.from + (step.to - step.from)*ease(phase/span); break; }
      phase -= span;
    }
    const { point, tangent } = s.sampler.at(along);
    s.object.position.copy(point);
    orientAlongTrack(s.object, tangent);
    s.object.visible = true;
  });
}
// where the cursor's ray crosses the level plane at height `y` (null if it doesn't)
export function trainPlanePoint(sx, sy, y) {
  App.raycaster.setFromCamera(App.ndcOf(sx, sy), camera);
  const hit = new THREE.Vector3();
  return App.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0), -y), hit) ? { x:hit.x, z:hit.z } : null;
}
// Drags a train node or spline handle freely in 3D: it follows the cursor across the plane facing the camera, so
// from the top view it moves level, from a side view it rises and falls, and from anywhere in between it does
// both. With alt held it only changes height, from any angle. Whatever part of the marker was grabbed stays under
// the cursor; the plane (or line) is anchored where the drag started, or where alt was last pressed or released.
export function dragTrainPoint(e) {
  const n = roadNodes[S.draggedNode.nodeId];
  if (!n) return;
  const isHandle = S.draggedNode.kind==='roadHandle';
  const target = isHandle ? n[S.draggedNode.which] : n;
  if (!target) return;
  const cur = new THREE.Vector3(target.x, target.y!=null ? target.y : trainNodeY(n), target.z);
  const mode = e.altKey ? 'height' : 'free';
  if (S.draggedNode.trainMode !== mode) {
    S.draggedNode.trainMode = mode;
    S.draggedNode.anchor = cur.clone();
    S.draggedNode.grab = null;
  }
  App.raycaster.setFromCamera(App.ndcOf(e.clientX, e.clientY), camera);
  const ray = App.raycaster.ray;
  let next;
  if (mode==='free') {
    const facing = new THREE.Vector3();
    camera.getWorldDirection(facing);
    const hit = new THREE.Vector3();
    if (!ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(facing, S.draggedNode.anchor), hit)) return;
    if (!S.draggedNode.grab) S.draggedNode.grab = cur.clone().sub(hit);
    hit.add(S.draggedNode.grab);
    const sp = isHandle ? { x:hit.x, z:hit.z } : snapPointToGrid({ x:hit.x, z:hit.z }, 'road');
    next = { x:sp.x, y:Math.max(TRAIN_MIN_HEIGHT, hit.y), z:sp.z };
  } else {
    // the height on the vertical line through the anchor that passes closest to the cursor's ray
    const up = new THREE.Vector3(0,1,0);
    const b = up.dot(ray.direction);
    const denom = 1 - b*b;
    if (denom < 1e-4) return; // looking straight down that line — there's no height to read from the cursor
    const w0 = S.draggedNode.anchor.clone().sub(ray.origin);
    const along = (b*ray.direction.dot(w0) - up.dot(w0))/denom;
    const y = S.draggedNode.anchor.y + along;
    if (S.draggedNode.grab == null) S.draggedNode.grab = cur.y - y;
    next = { x:cur.x, y:Math.max(TRAIN_MIN_HEIGHT, y + S.draggedNode.grab), z:cur.z };
  }
  if (isHandle) {
    n[S.draggedNode.which] = next;
  } else {
    const dx=next.x-cur.x, dy=next.y-cur.y, dz=next.z-cur.z;
    n.x=next.x; n.y=next.y; n.z=next.z;
    ['handleIn','handleOut'].forEach(key => {
      const h = n[key];
      if (h) { h.x+=dx; h.y=(h.y!=null ? h.y : cur.y)+dy; h.z+=dz; }
    });
  }
  // only trains changed, so skip rebuilding the roads (and zones) on every mouse move
  rebuildTrainMeshes(); rebuildRoadMarkers(); rebuildRoadHandles(); App.refreshHighlights();
}
// The train edge nearest the cursor, matched on screen (train lines float above the ground, so the ground point
// under the cursor isn't a useful guide) — for shift+click node insertion.
export function findNearestTrainEdge(sx, sy) {
  let best = null;
  const v = new THREE.Vector3();
  const toScreen = p => { v.copy(p).project(camera); return { x:(v.x+1)/2*window.innerWidth, y:(1-v.y)/2*window.innerHeight, ok: v.z > -1 && v.z < 1 }; };
  S.roadLines.filter(isTrainLine).forEach(line => {
    const { points: pts, segments } = trainCurve(line.nodeIds);
    for (let k=0;k<pts.length-1;k++) {
      const p = toScreen(pts[k]), q = toScreen(pts[k+1]);
      if (!p.ok || !q.ok) continue;
      const dx=q.x-p.x, dy=q.y-p.y, l2=dx*dx+dy*dy;
      const t = l2 ? Math.max(0, Math.min(1, ((sx-p.x)*dx+(sy-p.y)*dy)/l2)) : 0;
      const dist = Math.hypot(sx-(p.x+dx*t), sy-(p.y+dy*t));
      if (dist <= 14 && (!best || dist < best.dist)) {
        best = { kind:'train', line, index:segments[k+1], point: pts[k].clone().lerp(pts[k+1], t), dist,
          angle: Math.atan2(pts[k+1].z-pts[k].z, pts[k+1].x-pts[k].x) };
      }
    }
  });
  return best;
}

// Node UI — road, zone and train node markers, spline handles and their guide lines — draws over everything else,
// so it can always be seen (and clicked) through buildings, roads and tubes: it skips the depth test and renders
// last (in the transparent pass, where its renderOrder puts it after glass like the train tubes).
export function nodeUiMaterial(MaterialType, params) {
  return new MaterialType({ ...params, transparent:true, depthTest:false, depthWrite:false });
}
// (its markers and handles — its meshes — are also kept the same size on screen, by scaleNodeUi)
export function asNodeUi(object) { object.renderOrder = 1000; if (object.isMesh) object.userData.screenSized = true; return object; }
// Node UI stays the same size on screen however near or far the camera is: each marker and handle is scaled by how far it
// is from the camera, at NODE_UI_DISTANCE away being the size it's made.
const NODE_UI_DISTANCE = 160;
export function nodeUiScaleAt(camera, position) { return camera.position.distanceTo(position)/NODE_UI_DISTANCE; }
export function scaleNodeUi(camera) {
  const scaleGroup = group => {
    if (!group || !group.visible) return;
    group.children.forEach(o => { if (o.userData.screenSized) o.scale.setScalar(nodeUiScaleAt(camera, o.position)); });
  };
  scaleGroup(S.roadMarkerGroup);
  scaleGroup(S.roadHandleGroup);
  S.zones.forEach(z => { if (z.outlineGroup && z.outlineGroup.visible) scaleGroup(z.markerGroup); });
}

export function rebuildRoadMarkers() {
  scene.remove(S.roadMarkerGroup); disposeObject(S.roadMarkerGroup);
  S.roadMarkerGroup = new THREE.Group();
  S.roadMarkerGroup.visible = S.interactionMode==='node' && (S.currentTool==='road' || S.currentTool==='train'); // (the Paths tab's alone)
  // Road and train nodes share roadNodes, but the road and train tools (the Paths tab's Type) each only show (and so only
  // let you pick) their own kind — so a train line can't be joined onto a road, or the other way round.
  const trainIds = trainNodeIdSet();
  const showTrains = S.currentTool==='train';
  Object.keys(roadNodes).forEach(id => {
    const n = roadNodes[id];
    const isTrain = trainIds.has(id);
    if (isTrain !== showTrains) return;
    const color = isTrain && n.type==='station' ? TRAIN_STATION_NODE_COLOR : 0x3ddc97;
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.6,12,12), nodeUiMaterial(THREE.MeshBasicMaterial, { color }));
    m.position.set(n.x, isTrain ? trainNodeY(n) : 1.6, n.z);
    m.userData = { nodeId:id, baseColor:color };
    S.roadMarkerGroup.add(asNodeUi(m));
  });
  scene.add(S.roadMarkerGroup);
}
export function rebuildRoadHandles() {
  scene.remove(S.roadHandleGroup); disposeObject(S.roadHandleGroup);
  S.roadHandleGroup = new THREE.Group();
  S.roadHandleGroup.visible = S.interactionMode==='node' && (S.currentTool==='road' || S.currentTool==='train');
  const trainIds = trainNodeIdSet();
  const showTrains = S.currentTool==='train';
  Object.keys(roadNodes).forEach(id => {
    const n = roadNodes[id];
    const isTrain = trainIds.has(id);
    if (isTrain !== showTrains) return;
    if (isTrain) {
      // train lines are always smooth, so their nodes have no handles — just a faint drop line under each one, so
      // its height reads at a glance
      const dropGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(n.x,0,n.z), new THREE.Vector3(n.x,trainNodeY(n),n.z)]);
      S.roadHandleGroup.add(asNodeUi(new THREE.Line(dropGeo, nodeUiMaterial(THREE.LineBasicMaterial, { color:0x3ddc97, opacity:0.35 }))));
      return;
    }
    if (n.type!=='spline') return;
    ['handleIn','handleOut'].forEach(key => {
      const h = n[key];
      if (!h) return;
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0), nodeUiMaterial(THREE.MeshBasicMaterial, { color:0xffd23d }));
      m.position.set(h.x,1.6,h.z);
      m.userData = { nodeId:id, handleKind:key, baseColor:0xffd23d };
      S.roadHandleGroup.add(asNodeUi(m));
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(n.x,1.5,n.z), new THREE.Vector3(h.x,1.5,h.z)]);
      S.roadHandleGroup.add(asNodeUi(new THREE.Line(lineGeo, nodeUiMaterial(THREE.LineBasicMaterial, { color:0xffd23d, opacity:0.5 }))));
    });
  });
  scene.add(S.roadHandleGroup);
}

export function cleanupOrphanRoadNodes() {
  const used = new Set();
  S.roadLines.forEach(l => l.nodeIds.forEach(id => used.add(id)));
  Object.keys(roadNodes).forEach(id => { if (!used.has(id)) delete roadNodes[id]; });
}

Object.assign(App, { isTrainLine, rebuildTrainMeshes, rebuildRoadMarkers, rebuildRoadHandles });
