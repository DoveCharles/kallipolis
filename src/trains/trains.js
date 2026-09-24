import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, computeWindowGlowFactor, SKY_ENV_MAP, snapPointToGrid, apparentDistance } from '../core/scene.js';
import { mergeGeometryList } from '../buildings/windows.js';
import { createRegionTester } from '../zones/cutouts.js';
import { roadNodes } from '../core/state.js';
import { disposeObject } from '../roads/roads.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { possession, startRiding, endRiding } from '../life/possession.js';
import { IS_TOUCH } from '../core/device.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';
import { updateShuttleSounds, doorSwish } from '../audio/maglev.js';

// ---------------------------------------------------------- the carriage card
// Which carriage the camera's following, in the shared card at the bottom right (ui/entity-card.js) like the car's: its
// name and mood, a picture of it, and what it enjoys and hates — from assets/trains.txt, read the same way as the
// vehicles' and the buildings' files (see core/type-text.js) — and who's riding it. No Smite button: trains can't be
// killed.
const trains = loadTypeText('assets/trains.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'], // can have several per carriage, like people: see [distribution] in trains.txt
  // this stands in until trains.txt has loaded, or if it can't be
  placeholder: { default: { name: ['Train'], mood: ['🚆'], loves: ['Shoooom'], hates: ['Delays'] } },
});
const RIDE_ENTER = ['Enter', 'Ride inside the carriage'], RIDE_LEAVE = ['Exit', 'Back outside the carriage'];
const trainCard = makeCard({
  id: 'train-card',
  title: 'Train',
  onClose: () => App.stopFollowingTrain(),
  action: { text: RIDE_ENTER[0], title: RIDE_ENTER[1], onClick: () => toggleRide() },
  labels: { occupants: 'Passengers' },
});
const drawTrainThumbnail = makeThumbnailDrawer(trainCard.canvas);

// `info.number` is the carriage's place among the lines and `info.view` its thumbnail (see trainThumbnailOf below)
function showTrainCard(info) {
  const type = trains.of(null, info.number);
  trainCard.show({ ...type, name: type.name + ' #' + info.number });
  trainCard.setAction(...RIDE_ENTER);
  setTrainCardPassengers([]);
  drawTrainThumbnail(info.view);
}
function hideTrainCard() {
  trainCard.hide();
}

// who's riding the followed carriage (see "riding the trains" in people.js): their names, one a line — the one at
// `tracked` (whoever the camera came aboard with, or a name that's since been clicked) highlighted, and `onPick` told
// when a name is clicked, to get off with that one instead
function setTrainCardPassengers(names, tracked = -1, onPick = null) {
  trainCard.setList('occupants', names, tracked, onPick && { title: 'Follow them off the train', onClick: onPick });
}

// ---------------------------------------------------------- trains
// Train lines live in roadNodes/roadLines alongside roads (line.kind === 'train'), so drawing, dragging, joining,
// inserting and deleting all run through the same editing code. What differs: their nodes carry a height (y) and
// move in 3D, the line always curves smoothly through them, straightening out over the last stretch into a
// station so it lines up with the station's own straight footprint (there's no poly/spline — a node is either
// plain track or a station), and instead of a road surface each line is built as a glass tube wound with a
// solenoid coil, held up by pairs of collared support posts, with a station building at every 'station' node — the
// tube itself stops short of a station's open interior (see buildLineTube), continuing as 2 bare rails under the
// carriage the rest of the way, between the station's two portal rings (see buildStationParts). Junctions between
// train lines aren't specially handled — tubes that meet simply pass through each other. Each line has one shuttle
// carriage running back and forth along its whole length, stopping at its stations (see updateTrainShuttles) —
// centred on the station even when it's right at the end of the line, since the station's rails reach past the
// last node either way.
S.TRAIN_DEFAULT_RADIUS = 2.5;
S.TRAIN_DEFAULT_HEIGHT = 14;       // height of a new line's first node (later nodes follow the one before)
const TRAIN_MIN_HEIGHT = 0.5;
const TRAIN_SUPPORT_SPACING = 28;    // world units between pairs of support posts
S.TRAIN_COIL_TURNS_PER_10 = 1;     // how tightly the solenoid coil winds: full turns per 10 world units of track
const TRAIN_TUBE_SIDES = 20;
const TRAIN_STATION_LENGTH = 24;
const TRAIN_STATION_NODE_COLOR = 0x5ab8ff;
const TRAIN_SHUTTLE_SPEED = 45;      // world units per second, averaged over each run between stops
const TRAIN_STATION_DWELL = 3.5;     // seconds a shuttle stops at each station
const TRAIN_END_DWELL = 1.5;         // seconds it pauses at an end of the line (one without a station) before heading back
// A station whose deck stands at least this high off the ground gets a glass lift at the end of each landing, for
// people to ride up from the ground and back down (see stationLifts); lower ones, they just step up onto.
const STATION_LIFT_MIN_HEIGHT = 3;
const RAMP_REACH = 0.5;              // how far a boarding ramp comes out from the rails, as a fraction of the way to the doors
const LIFT_DEPTH = 1.1;              // half a lift shaft's depth, out from the landing (it's as wide as the landing)
const LIFT_CAB_HEIGHT = 2.6;         // floor to ceiling inside the cab, where the awning's high enough
const DOOR_SPEED = 2.2;              // how quickly a station's doors slide open or shut: the whole way in 1/DOOR_SPEED seconds
const LIFT_SPEED = 3;                // world units per second, flat out
const LIFT_DWELL = 2.5;              // seconds a cab waits with its doorways open after arriving
let trainShuttles = [];              // rebuilt with the train meshes; moved every frame by updateTrainShuttles
// Each line's shuttle is late by however long it's been held at stations for people getting on and off (see
// holdTrain): kept across rebuilds, like its place in the timetable, which it's subtracted from.
const TRAIN_HOLD_MAX = 30;           // the longest a shuttle waits at one stop for people, past its usual dwell
// A carriage's doors open in two moves, from the model's shape keys: out (Doors1), then apart (Doors2) — each taking
// CARRIAGE_DOOR_STEP seconds — and back the other way to shut, finished before it pulls out.
const CARRIAGE_DOOR_STEP = 0.6;
const CARRIAGE_DOORS_SHUT_BY = 2*CARRIAGE_DOOR_STEP + 0.2; // (seconds before it leaves a station, the doors start to shut)
const lateBy = new Map();            // line id -> seconds
const lastStopOf = new Map();        // line id -> the station node its shuttle was last stopped at, kept across rebuilds
// Every station, for people riding the trains (see "riding the trains" in people.js), rebuilt with the train meshes: node id ->
// { nodeId, x, y, z, radius, halfW, landing, alongMax, lineIds, networkId, networkStations, spot(across, along) }, where
// spot gives a point on its deck, `across` the track (+ to its right) and `along` it from the middle.
let trainStations = new Map(), stationsVersion = 0;
export const getTrainStations = () => trainStations;
export const trainStationsVersion = () => stationsVersion;
// each line's shuttle: { lineId, object (its position is the carriage's), stopNode (the station it's stopped at, or null),
// arrived (whether it pulled in there this frame) }
export const getTrainShuttles = () => trainShuttles;

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
// how far below the tube's centerline a station's platform deck is
const stationDeckTop = radius => -radius - 0.3;

// A point on a cubic Hermite curve from P0 to P1, with tangents m0, m1 (their length sets how hard it pulls out
// along them before bending toward the other end).
function hermitePoint(P0, P1, m0, m1, t) {
  const t2 = t*t, t3 = t2*t;
  return new THREE.Vector3()
    .addScaledVector(P0, 2*t3 - 3*t2 + 1).addScaledVector(m0, t3 - 2*t2 + t)
    .addScaledVector(P1, -2*t3 + 3*t2).addScaledVector(m1, t3 - t2);
}
// A train line's centerline as 3D points — always the smoothest curve through its nodes, never a corner: a cubic
// Hermite spline whose direction at each node follows the line from the node before to the node after, scaled by
// the distances between them (chord-length Catmull-Rom), so unevenly spaced nodes don't make it bulge or overshoot.
// At a station the direction is kept level, so the track runs flat through the station, and — since the station
// building itself is a straight platform (see buildStationParts) — the last TRAIN_STATION_LENGTH/2 running into it
// (or the last half of the stretch to the node before/after, if that's shorter, so two close-together stations
// don't straighten past each other) is a dead-straight run along that same direction, not a curve, so the track
// actually lines up with the platform instead of clipping through its wall. `segments[k]` is the index of the
// node-to-node stretch points[k] lies on.
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
  const unit = directions.map(d => d.clone().normalize());
  const points = [P[0].clone()], segments = [0];
  for (let i=0;i<count-1;i++) {
    const steps = Math.max(6, Math.ceil(chord[i]/2)); // a point every couple of units, so the tube stays round on curves
    let straightIn = nodes[i].type==='station' ? TRAIN_STATION_LENGTH/2 : 0;
    let straightOut = nodes[i+1].type==='station' ? TRAIN_STATION_LENGTH/2 : 0;
    if (straightIn + straightOut > chord[i]) {
      const scale = chord[i]/(straightIn + straightOut);
      straightIn *= scale; straightOut *= scale;
    }
    const midLen = chord[i] - straightIn - straightOut;
    const A = P[i].clone().addScaledVector(unit[i], straightIn), B = P[i+1].clone().addScaledVector(unit[i+1], -straightOut);
    const m0 = directions[i].clone().multiplyScalar(midLen), m1 = directions[i+1].clone().multiplyScalar(midLen);
    for (let s=1;s<=steps;s++) {
      const d = chord[i]*s/steps; // how far along this stretch, by the same chord-length parametrization as before
      const p = d <= straightIn ? P[i].clone().addScaledVector(unit[i], d)
        : d >= chord[i] - straightOut ? P[i+1].clone().addScaledVector(unit[i+1], d - chord[i])
        : hermitePoint(A, B, m0, m1, (d - straightIn)/midLen);
      points.push(p);
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
// The glass tube along a whole line, split into one run per gap between stations, leaving out `coreHalf` either
// side of each one's centre — its open interior, past the portal rings (see buildStationParts and stationPortal)
// — where the tube gives way to the station's own rails. Runs are sampled fresh off the sampler rather than reusing
// its `path`, so each one starts and ends exactly on a gap boundary instead of the nearest existing sample.
function buildLineTube(sampler, radius, coreHalf, stations) {
  const total = sampler.total;
  const bounds = [0, total];
  stations.forEach(s => bounds.push(Math.max(0, s.dist - coreHalf), Math.min(total, s.dist + coreHalf)));
  bounds.sort((a, b) => a - b);
  const geos = [];
  for (let i=0;i<bounds.length-1;i++) {
    const a = bounds[i], b = bounds[i+1];
    if (b - a < 1e-6 || stations.some(s => Math.abs(s.dist - (a+b)/2) < coreHalf)) continue;
    const steps = Math.max(1, Math.ceil((b-a)/2));
    const pts = [];
    for (let k=0;k<=steps;k++) pts.push(sampler.at(a + (b-a)*k/steps).point);
    geos.push(buildTubeGeometry(pts, radius));
  }
  return geos.length ? mergeGeometryList(geos) : null;
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
// A pair of round posts either side of `point` (across the track's heading), from the ground up to `topY`, joined by a
// collar ring around the tube. The ring's axis lies along the track, and it's drawn with the same beamW-wide circular
// section as the posts, on a circle through their centres — so each post runs straight into it without a seam.
function addSupportBeams(geos, point, tangent, halfGap, topY, beamW) {
  if (topY < 0.5) return;
  const side = new THREE.Vector3(-tangent.z, 0, tangent.x);
  if (side.lengthSq() < 1e-6) side.set(1,0,0); else side.normalize();
  [-1, 1].forEach(sign => {
    const post = new THREE.CylinderGeometry(beamW/2, beamW/2, topY, 12);
    post.translate(point.x + side.x*halfGap*sign, topY/2, point.z + side.z*halfGap*sign);
    geos.push(post);
  });
  const ring = new THREE.TorusGeometry(halfGap, beamW/2, 10, 32);
  ring.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent)); // hole along the track
  ring.translate(point.x, point.y, point.z);
  geos.push(ring);
}
// How far from a station's centre, along the track, its portal rings sit (see buildStationParts) — where the
// vault's ceiling comes down to just clear the tube, which is where the tube stops (see buildLineTube) in favor of
// the station's own rails. `ring: false` means the vault's too squat for its ceiling to ever pinch in that close —
// there's no ring, and `half` is just the station's own half-length, its rails (and the tube, outside it) running
// the whole way.
function stationPortal(radius) {
  const { width, height } = trainStationSize(radius);
  const halfW = width/2, halfL = TRAIN_STATION_LENGTH/2, capLength = Math.min(halfW, halfL), straightHalf = halfL - capLength;
  const deckTop = stationDeckTop(radius), rise = height/2 - deckTop;
  const clearance = (radius + 0.15 - deckTop)/rise;
  return clearance < 1 ? { half: straightHalf + capLength*Math.sqrt(1 - clearance*clearance), ring: true }
                        : { half: halfL, ring: false };
}
// A station dragged (or made) low enough that it wouldn't be worth a lift sits right down on the ground instead, its
// deck level with it, for people to walk straight in: the height its node should be at for that, or `y` itself if it's
// high enough to stay up (or isn't a station). By the widest line through it, since that's the biggest station.
export function snapStationHeight(nodeId, y) {
  const n = roadNodes[nodeId];
  if (!n || n.type!=='station') return y;
  const radius = Math.max(0, ...S.roadLines.filter(l => isTrainLine(l) && l.nodeIds.includes(nodeId)).map(l => l.radius || S.TRAIN_DEFAULT_RADIUS));
  if (!radius) return y;
  return y + stationDeckTop(radius) < STATION_LIFT_MIN_HEIGHT ? -stationDeckTop(radius) : y;
}
// The measurements of a station's two entrances (see buildStationParts), in its own coordinates: how wide and tall
// the doorway is, whether it has doors at all (too short a station doesn't), half the landing's width along the track,
// how far out the landing reaches, and the height of the awning over it.
function stationEntrance(radius) {
  const { width, height } = trainStationSize(radius), halfW = width/2, halfL = TRAIN_STATION_LENGTH/2;
  const straightHalf = halfL - Math.min(halfW, halfL), deckTop = stationDeckTop(radius), rise = height/2 - deckTop;
  const doorWidth = Math.min(3.4, 2*straightHalf - 0.6), doorHeight = Math.min(3.4, rise*0.6);
  return { doorWidth, doorHeight, hasDoors: doorWidth > 1.2, landingHalf: doorWidth/2 + 0.4, reach: halfW + 1.5,
    awningY: deckTop + doorHeight + 0.55 };
}
// A station's lifts — none if its deck's too low to need them, or it has no entrances to lead to — one at the outer end
// of each landing: `side` (+1 or -1 across the track, as the entrances go), `across` (how far out from the track its
// middle is), `width` (half its width along the track — the landing's), `bottom` and `top` (the ground's and the deck's
// heights, relative to the tube's centerline, as buildStationParts' own coordinates are), `roof` (level with the
// awning) and `cab` (the cab's height inside). The ground doorway faces out, away from the station; the top one faces
// in, onto the landing.
function stationLifts(position, radius) {
  const { hasDoors, landingHalf, reach, awningY } = stationEntrance(radius), deckTop = stationDeckTop(radius);
  if (!hasDoors) return []; // (no entrances: see buildStationParts)
  if (position.y + deckTop < STATION_LIFT_MIN_HEIGHT) return [];
  const across = reach + 0.12 + LIFT_DEPTH; // just past the landing's edge light
  const cab = Math.max(1.8, Math.min(LIFT_CAB_HEIGHT, awningY - deckTop - 0.45));
  return [1, -1].map(side => ({ side, across, width: landingHalf, bottom: -position.y, top: deckTop, roof: awningY, cab }));
}
// A lift's cab, in its own coordinates: x across the track (pointing out, away from the station, on either side), y up
// from its floor, z along the track — a floor and a ceiling on chrome corner posts, a glowing panel under the ceiling,
// and glass down both sides (the doorway ends are left open).
function buildLiftCab(mats, width, h) {
  const d = LIFT_DEPTH - 0.12, w = width - 0.12;
  const box = (sx, sy, sz, x, y, z) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
  const group = new THREE.Group();
  const part = (geo, material, opaque) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = opaque; mesh.receiveShadow = true;
    group.add(mesh);
  };
  part(mergeGeometryList([box(2*d, 0.18, 2*w, 0, -0.09, 0), box(2*d, 0.16, 2*w, 0, h + 0.08, 0)]), mats.station, true);
  const posts = [];
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => posts.push(new THREE.CylinderGeometry(0.06, 0.06, h, 8).translate(sx*(d - 0.06), h/2, sz*(w - 0.06)))));
  posts.push(box(2*d, 0.06, 0.06, 0, 1.05, w - 0.06), box(2*d, 0.06, 0.06, 0, 1.05, -(w - 0.06))); // handrails
  part(mergeGeometryList(posts), mats.chrome, true);
  part(box(2*d - 0.5, 0.04, 2*w - 0.5, 0, h - 0.02, 0), mats.stationTrim, false);
  const glass = [-1, 1].map(sz => new THREE.PlaneGeometry(2*d, h).translate(0, h/2, sz*(w - 0.02)));
  part(mergeGeometryList(glass), mats.stationGlass, false);
  return group;
}
// A station, built around the tube's centerline at `position`, always level and turned to the track's heading, in
// roughly the footprint of a TRAIN_STATION_LENGTH-long, trainStationSize(radius) box:
//  • a stadium-shaped platform deck just under the tube, ringed by a glowing trim line;
//  • a glass vault rising from the deck's edge — a half-ellipse cross-section along the middle, closing into
//    quarter-ellipsoid ends over the deck's rounded ends;
//  • chrome ribs across the vault, a chrome spine along its ridge, a chrome portal ring where the tube pierces each
//    end (see stationPortal), and a small chrome orb and needle on top;
//  • 2 bare rails, low near where the carriage's underside runs, between the two portals — what the tube gives way
//    to for the open stretch inside the vault (see buildLineTube), so the station's interior isn't cluttered with
//    a length of glass tube it's already enclosing;
//  • an entrance in each long side: a pair of dark glass doors set into the vault's curve, framed in chrome under a
//    glowing lintel, with a landing jutting out from the deck below and a small awning above;
//  • a single flared pylon from the ground up to the deck;
//  • if it stands high enough, a glass lift shaft off the end of each landing, down to the ground (see stationLifts) —
//    the cab that rides up and down it is built separately (see buildLiftCab), since it moves.
// Returns the parts, each with the material it uses.
function buildStationParts(position, tangent, radius, mats) {
  const { width, height } = trainStationSize(radius);
  const halfW = width/2, halfL = TRAIN_STATION_LENGTH/2;
  const capLength = Math.min(halfW, halfL);      // the rounded ends are half-discs in plan
  const straightHalf = halfL - capLength;
  // local coordinates: x across the track, y up (0 = the tube's centerline), z along the track
  const deckTop = stationDeckTop(radius), deckDepth = 0.7;
  const rise = height/2 - deckTop;               // how high the vault stands above the deck
  const forward = new THREE.Vector3(tangent.x, 0, tangent.z);
  if (forward.lengthSq() < 1e-6) forward.set(1,0,0); else forward.normalize();
  const up = new THREE.Vector3(0,1,0);
  const place = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, forward), up, forward).setPosition(position);
  const parts = [];
  const add = (geo, material, name, opaque, slide) => parts.push({ geo: geo.applyMatrix4(place), material, name, opaque, slide });

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
  const { doorWidth, doorHeight, hasDoors, landingHalf, reach, awningY } = stationEntrance(radius);
  const doorTop = Math.asin(doorHeight/rise); // the arc angle, up from the deck, at the top of each door
  // 2 bare rails between the portals, low under where the carriage's underside runs, carrying it the rest of the
  // way once the tube itself has stopped (see buildLineTube)
  const railGap = radius*0.55, railY = -radius*0.75, railR = Math.max(0.12, radius*0.07);

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
    const entrance = [], glow = [];
    const zL = -doorWidth/2, zR = doorWidth/2;
    [1, -1].forEach(side => {
      const arc = a => side > 0 ? a : Math.PI - a; // the same height up the vault, on this side
      const up = (a0, a1, z, n) => Array.from({ length: n+1 }, (_, i) => vaultPoint(arc(a0 + (a1-a0)*i/n), { z, s:1 }, 1.024));
      // two glass leaves, just outside the vault's chrome, that slide apart along the track to let people through
      // (see updateStationDoors): each its own part, framed in chrome along its edges, so it can move
      [[zL, 0, -1], [0, zR, 1]].forEach(([z0, z1, dir]) => {
        const slide = { side, dir, reach: doorWidth/2 - 0.12 };
        const edge = z => Array.from({ length: 9 }, (_, i) => vaultPoint(arc(doorTop*i/8), { z, s:1 }, 1.05));
        add(vaultPatch(arc(0), arc(doorTop), z0, z1, 1.05, 8, 2), mats.stationDoor, 'TrainStationDoor', false, slide);
        add(mergeGeometryList([tubeAlong(edge(z0 + 0.03), 0.04), tubeAlong(edge(z1 - 0.03), 0.04)]), mats.chrome, 'TrainStationDoorFrame', true, slide);
      });
      glow.push(vaultPatch(arc(doorTop + 0.035), arc(doorTop + 0.085), zL, zR, 1.016, 2, 2)); // the lintel
      chrome.push(tubeAlong(up(0, doorTop, zL, 8), 0.12), tubeAlong(up(0, doorTop, zR, 8), 0.12)); // jambs
      chrome.push(tubeAlong([zL, zL/2, 0, zR/2, zR].map(z => vaultPoint(arc(doorTop), { z, s:1 }, 1.024)), 0.12)); // header
      // the landing and awning: boxes running from x0 out to x1 (away from the track, on this side)
      const box = (x0, x1, y0, y1) => {
        const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, 2*landingHalf);
        geo.translate(side*(x0 + x1)/2, (y0 + y1)/2, 0);
        return geo;
      };
      entrance.push(box(halfW - 0.05, reach, deckTop - deckDepth, deckTop));
      glow.push(box(reach, reach + 0.12, deckTop - deckDepth*0.65, deckTop - deckDepth*0.3)); // the landing's edge light
      const vaultX = halfW*Math.sqrt(Math.max(0, 1 - ((awningY - deckTop)/rise)**2)); // where the awning meets the glass
      entrance.push(box(vaultX - 0.1, reach, awningY, awningY + 0.16));
    });
    add(mergeGeometryList(entrance), mats.station, 'TrainStationEntrance', true);
    add(mergeGeometryList(glow), mats.stationTrim, 'TrainStationEntranceGlow', true);
    // a little ramp at each door, stepping up from the deck to rail height right where people board — a plain "/|"
    // wedge facing the doors: flat across the doorway, sloping up from the threshold in toward the rails
    const gapHeight = railY - deckTop;
    if (gapHeight > 0.05) {
      const idxOut = [0,1,3, 0,3,2, 0,4,1, 1,4,5, 2,3,5, 2,5,4, 0,2,4, 1,5,3];
      const idxIn = idxOut.reduce((acc, v, i, arr) => { if (i % 3 === 0) acc.push(arr[i], arr[i+2], arr[i+1]); return acc; }, []);
      const ramps = [1, -1].map(side => {
        // the high edge reaches past the rail's outer face, so the ramp actually touches it rather than stopping short;
        // its foot comes only halfway out to the doors, clear of them
        const { inner, outer } = stationRamp(radius), innerX = side*inner, outerX = side*outer;
        const A0=[outerX,deckTop,zL], B0=[outerX,deckTop,zR], A1=[innerX,deckTop,zL], B1=[innerX,deckTop,zR], A2=[innerX,railY,zL], B2=[innerX,railY,zR];
        const ramp = new THREE.BufferGeometry();
        ramp.setAttribute('position', new THREE.Float32BufferAttribute([A0,B0,A1,B1,A2,B2].flat(), 3));
        ramp.setIndex(side > 0 ? idxOut : idxIn);
        const flat = ramp.toNonIndexed(); // (flat shaded: each face its own normal)
        flat.computeVertexNormals();
        return flat;
      });
      add(mergeGeometryList(ramps), mats.station, 'TrainStationRamp', true);
    }
  }
  // the portals sit where the vault's ridge comes down to just clear the top of the tube
  const { half: zPortal, ring: hasPortal } = stationPortal(radius);
  // the spine along the ridge ends on the portal rings — past them the end cap comes down through where the carriage runs
  const rowAt = z => ({ z, s: Math.abs(z) <= straightHalf ? 1 : Math.sqrt(Math.max(0, 1 - ((Math.abs(z) - straightHalf)/capLength)**2)) });
  const spineRows = [rowAt(-zPortal), ...rows.filter(row => Math.abs(row.z) < zPortal - 0.05), rowAt(zPortal)];
  chrome.push(tubeAlong(spineRows.map(row => vaultPoint(Math.PI/2, row, 1.012)), 0.13));
  if (hasPortal) {
    [-1, 1].forEach(side => {
      const ring = new THREE.TorusGeometry(radius*1.2, Math.max(0.18, radius*0.09), 10, 36);
      ring.translate(0, 0, side*zPortal);
      chrome.push(ring);
    });
  }
  [-1, 1].forEach(side => {
    const rail = new THREE.CylinderGeometry(railR, railR, zPortal*2, 10);
    rail.rotateX(Math.PI/2); // cylinders run along Y; rails run along Z, like the track
    rail.translate(side*railGap, railY, 0);
    chrome.push(rail);
  });
  const crownY = deckTop + rise;
  const orb = new THREE.SphereGeometry(0.55, 16, 12);
  orb.translate(0, crownY + 0.3, 0);
  chrome.push(orb);
  const needle = new THREE.ConeGeometry(0.14, 2.4, 10);
  needle.translate(0, crownY + 1.9, 0);
  chrome.push(needle);
  const tip = new THREE.SphereGeometry(0.16, 12, 10);
  tip.translate(0, crownY + 3.1, 0);
  chrome.push(tip);
  add(mergeGeometryList(chrome), mats.chrome, 'TrainStationChrome', true);

  // lift shafts: chrome corner posts from the ground to above the cab's roof at the top, glass all round but for a
  // doorway at the ground on the outer face and one onto the landing on the inner face, a roof with a glowing band
  // under it, and a plinth at the foot
  const lifts = stationLifts(position, radius);
  if (lifts.length) {
    const shaftChrome = [], shaftGlass = [], shaftSolid = [], shaftGlow = [];
    const L = LIFT_DEPTH;
    lifts.forEach(({ side, across, width: W, bottom, top, roof, cab }) => {
      const cx = side*across, h = roof - bottom, doorH = cab + 0.15;
      [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
        const post = new THREE.BoxGeometry(0.16, h, 0.16);
        post.translate(cx + sx*L, bottom + h/2, sz*W);
        shaftChrome.push(post);
      }));
      // a pane across the face at x (the width of the shaft, along the track), from y0 up to y1
      const faceX = (x, y0, y1) => { if (y1 - y0 > 0.05) shaftGlass.push(new THREE.PlaneGeometry(2*W, y1 - y0).rotateY(Math.PI/2).translate(x, (y0 + y1)/2, 0)); };
      [-1, 1].forEach(sz => shaftGlass.push(new THREE.PlaneGeometry(2*L, h).translate(cx, bottom + h/2, sz*W)));
      const outer = cx + side*L, inner = cx - side*L;
      faceX(outer, bottom + doorH, roof);
      faceX(inner, bottom, top - deckDepth);
      faceX(inner, top + doorH, roof);
      // the lintels over the two doorways, and a band round the shaft at the landing's level
      [[outer, bottom + doorH], [inner, top + doorH]].forEach(([x, y]) => shaftChrome.push(new THREE.BoxGeometry(0.14, 0.14, 2*W).translate(x, y, 0)));
      shaftChrome.push(new THREE.BoxGeometry(0.12, 0.12, 2*W).translate(outer, top - deckDepth/2, 0));
      [-1, 1].forEach(sz => shaftChrome.push(new THREE.BoxGeometry(2*L, 0.12, 0.12).translate(cx, top - deckDepth/2, sz*W)));
      // the roof: the awning over the landing carried on out over the shaft, just as thick and at just the same height
      shaftSolid.push(new THREE.BoxGeometry(2*L + 0.12, 0.16, 2*W).translate(cx + side*0.06, roof + 0.08, 0));
      shaftSolid.push(new THREE.BoxGeometry(2*L + 0.4, 0.12, 2*W + 0.4).translate(cx, bottom + 0.06, 0));
      shaftGlow.push(new THREE.BoxGeometry(0.12, 0.1, 2*W).translate(cx + side*(L + 0.06), roof + 0.08, 0)); // along its outer edge
    });
    add(mergeGeometryList(shaftChrome), mats.chrome, 'TrainStationLiftFrame', true);
    add(mergeGeometryList(shaftGlass), mats.stationGlass, 'TrainStationLiftGlass', false);
    add(mergeGeometryList(shaftSolid), mats.station, 'TrainStationLiftRoof', true);
    add(mergeGeometryList(shaftGlow), mats.stationTrim, 'TrainStationLiftGlow', true);
  }

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
// A carriage's glass: the very material the model was made with (see loadCarriageModel) — the Blender file's own
// tinted, see-through Window, which is what lets you look out of one you're riding in (see enterTrain) and into one
// going past. It's copied per network, so selecting one network only highlights that one, and given the emissive glow
// every lit window in the city shares, so a carriage lights up after dark (see updateWindowGlowForSun). Until the model
// has loaded — and for the built-in capsule, which has no glass of its own — it's a plain dark pane.
const SHUTTLE_WINDOW_GLOW = 1.1;
function carriageWindowMaterial() {
  const m = carriageModel && carriageModel.windowMaterial
    ? carriageModel.windowMaterial.clone()
    : new THREE.MeshStandardMaterial({ color:0x1d2a36, roughness:0.1, metalness:0.3, side:THREE.DoubleSide });
  m.envMap = SKY_ENV_MAP;
  m.depthWrite = false; // (transparent glass: so it doesn't hide the far side of the carriage behind it)
  m.emissive = new THREE.Color(0x9fdcff);
  m.emissiveIntensity = SHUTTLE_WINDOW_GLOW*computeWindowGlowFactor(S.sunElevation);
  m.userData.baseEmissiveIntensity = SHUTTLE_WINDOW_GLOW;
  return m;
}
export function rebuildTrainMeshes() {
  scene.remove(S.trainMeshGroup); disposeObject(S.trainMeshGroup);
  S.trainMeshGroup = new THREE.Group(); S.trainMeshGroup.name = 'Trains';
  trainShuttles = [];
  trainStations = new Map();
  stationLiftList = [];
  stationsVersion++;
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
        const m = new THREE.MeshStandardMaterial({ color:0x8fd4f2, transparent:true, opacity:0.38, roughness:0.05, metalness:0.3, envMap:SKY_ENV_MAP,
          envMapIntensity:1.6, side:THREE.DoubleSide, depthWrite:false, emissive:0x6fb6e0, emissiveIntensity:0.25*computeWindowGlowFactor(S.sunElevation) });
        m.userData.baseEmissiveIntensity = 0.25; // (glass doors, a little more tinted than the vault, faintly lit after dark)
        return m;
      })(),
      stationTrim: (() => {
        const m = new THREE.MeshStandardMaterial({ color:0x5fe3ff, roughness:0.3, metalness:0.1,
          emissive:0x5fe3ff, emissiveIntensity:1.6*computeWindowGlowFactor(S.sunElevation) });
        m.userData.baseEmissiveIntensity = 1.6; // glows after dark, like building windows (see updateWindowGlowForSun)
        return m;
      })(),
      shuttle: new THREE.MeshStandardMaterial({ color:0xf4f6f9, roughness:0.25, metalness:0.55, envMap:SKY_ENV_MAP, envMapIntensity:1.2, side:THREE.DoubleSide }),
      shuttleTrim: new THREE.MeshStandardMaterial({ color:0x1b1f25, roughness:0.4, metalness:0.3, envMap:SKY_ENV_MAP, envMapIntensity:0.6, side:THREE.DoubleSide }),
      shuttleCushion: new THREE.MeshStandardMaterial({ color:0x2f6f8c, roughness:0.85, metalness:0, side:THREE.DoubleSide }),
      // the strip lights along the ceiling, lit day and night (and a real light among them: see placeCarriageLights)
      shuttleLights: new THREE.MeshStandardMaterial({ color:0x000000, roughness:0.4, metalness:0, side:THREE.DoubleSide,
        emissive: carriageModel?.lightColor ?? CARRIAGE_LIGHT_COLOR, emissiveIntensity:CARRIAGE_LIGHTS_GLOW }),
      shuttleWindows: carriageWindowMaterial(),
    });
    return materials.get(netId);
  };
  const addMesh = (geo, material, name, line, opaque) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = opaque; mesh.receiveShadow = true;
    mesh.userData = { networkId: line.networkId, baseColor: material.color.getHex() };
    S.trainMeshGroup.add(mesh);
    return mesh;
  };
  // where support posts mustn't stand, as for raised walkways' pillars (see buildRaisedWalkway)
  const overRoad = createRegionTester(S.roadFootprint || []), overRiver = createRegionTester(S.riverFootprint || []);
  const blocked = (x, z) => overRoad(x, z) || overRiver(x, z);
  S.roadLines.filter(isTrainLine).forEach(line => {
    const path = trainCurve(line.nodeIds).points;
    if (path.length < 2) return;
    const radius = line.radius || S.TRAIN_DEFAULT_RADIUS;
    const beamW = Math.max(0.3, radius*0.16);
    const sampler = createPathSampler(path);
    const mats = materialsFor(line.networkId);
    const stations = line.nodeIds.filter(id => roadNodes[id] && roadNodes[id].type==='station').map(id => {
      const n = roadNodes[id];
      const position = new THREE.Vector3(n.x, trainNodeY(n), n.z);
      const dist = sampler.distanceOf(position);
      const tangent = sampler.at(dist - 0.5).tangent.add(sampler.at(dist + 0.5).tangent).normalize();
      return { node: id, position, dist, tangent };
    });
    const inStation = (d, margin) => stations.some(s => Math.abs(s.dist - d) < TRAIN_STATION_LENGTH/2 + margin);

    // the tube stops short of each station's open interior — see buildLineTube and stationPortal
    const tubeGeo = buildLineTube(sampler, radius, stationPortal(radius).half, stations);
    if (tubeGeo) addMesh(tubeGeo, mats.glass, 'TrainTube', line, false);
    // the solenoid coil wound around the tube — white outside, copper on the face toward the glass; not inside stations
    const coil = buildCoilGeometries(sampler, radius, S.TRAIN_COIL_TURNS_PER_10, d => inStation(d, 0));
    if (coil.outer) addMesh(coil.outer, mats.coilOuter, 'TrainCoil', line, true);
    if (coil.inner) addMesh(coil.inner, mats.coilInner, 'TrainCoilInner', line, true);
    // pairs of posts, each pair ringing the tube in a collar, holding it up at regular intervals — except inside
    // stations, and wherever the tube is on (or in) the ground with nothing to hold up. A pair that would stand in a
    // road or river slides along the track to the nearest clear spot, or is left out if there isn't one near.
    const beams = [], halfGap = radius*1.1 + beamW/2;
    const postsClear = d => {
      const { point, tangent } = sampler.at(d);
      const sx = -tangent.z, sz = tangent.x, sl = Math.hypot(sx, sz) || 1;
      return [-1, 1].every(sign => [-beamW/2, 0, beamW/2].every(e => {
        const x = point.x + sx/sl*(halfGap + e)*sign, z = point.z + sz/sl*(halfGap + e)*sign;
        return !blocked(x, z);
      }));
    };
    for (let d0 = TRAIN_SUPPORT_SPACING/2; d0 < sampler.total; d0 += TRAIN_SUPPORT_SPACING) {
      let d = null;
      for (let k = 0; k <= TRAIN_SUPPORT_SPACING/3; k += 1.5) {
        d = [d0 - k, d0 + k].find(c => c > 0 && c < sampler.total && !inStation(c, 2) && postsClear(c)) ?? null;
        if (d!=null || inStation(d0, 2)) break;
      }
      if (d==null) continue;
      const { point, tangent } = sampler.at(d);
      if (point.y - radius < TRAIN_MIN_HEIGHT) continue;
      addSupportBeams(beams, point, tangent, halfGap, point.y, beamW);
    }
    stations.forEach(s => {
      const leaves = [];
      buildStationParts(s.position, s.tangent, radius, mats).forEach(part => {
        const mesh = addMesh(part.geo, part.material, part.name, line, part.opaque);
        if (part.slide) leaves.push({ mesh, ...part.slide });
      });
      registerStation(s, line, radius, mats, leaves);
    });
    // one shuttle per line, running back and forth along all of it and stopping at each station on the way
    const shuttle = buildShuttle(radius, mats);
    const { steps, cycle } = buildShuttleTimeline(sampler.total, stations, shuttle.userData.length);
    S.trainMeshGroup.add(shuttle);
    trainShuttles.push({ lineId: line.id, object: shuttle, sampler, steps, cycle, offset: (trainHash(line.id) % 997)/997*cycle,
      stopNode: lastStopOf.get(line.id) ?? null, arrived: false, hold: 0, held: 0, doors: 0, doorsWant: 0 });
    if (beams.length) addMesh(mergeGeometryList(beams), mats.steel, 'TrainSupports', line, true);
  });
  const perNetwork = new Map();
  trainStations.forEach(st => perNetwork.set(st.networkId, (perNetwork.get(st.networkId) || 0) + 1));
  trainStations.forEach(st => { st.networkStations = perNetwork.get(st.networkId); });
  scene.add(S.trainMeshGroup);
  // a followed carriage whose line has gone lets go; one whose line was only rebuilt keeps being followed (and renumbered)
  if (followedTrain) {
    if (!trainShuttles.some(s => s.lineId === followedTrain)) stopFollowingTrain();
    else showFollowedTrainCard();
  }
}
// adds a line's station to trainStations (a station shared by several lines is listed once, with each of them), laid out as
// buildStationParts lays it out
// A station's boarding ramps, across from the track (see buildStationParts): from `outer`, on the deck, up to `inner`,
// just past the rails, at `topY` (up from the track's centreline).
function stationRamp(radius) {
  const halfW = trainStationSize(radius).width/2, railGap = radius*0.55, railR = Math.max(0.12, radius*0.07);
  const inner = railGap + railR + 0.05;
  return { inner, outer: inner + (halfW - inner)*RAMP_REACH, topY: -radius*0.75 };
}
function registerStation(s, line, radius, mats, leaves) {
  const known = trainStations.get(s.node);
  if (known) { known.lineIds.push(line.id); known.doors.leaves.push(...leaves); return; }
  const halfW = trainStationSize(radius).width/2, halfL = TRAIN_STATION_LENGTH/2;
  const forward = new THREE.Vector3(s.tangent.x, 0, s.tangent.z);
  if (forward.lengthSq() < 1e-6) forward.set(1,0,0); else forward.normalize();
  const right = { x: forward.z, z: -forward.x }, deckY = s.position.y + stationDeckTop(radius);
  const { x, z } = s.position;
  const { doorWidth, hasDoors, landingHalf, reach } = stationEntrance(radius);
  trainStations.set(s.node, { nodeId: s.node, x, y: s.position.y, z, radius, halfW,
    // its plan, for someone walked about on it by hand (see peopleFooting.js): which way is across and along, how far
    // along its straight sides run, half its doorways' width (0 with no doors), its landings' half-width and reach
    right, forward: { x: forward.x, z: forward.z }, straightHalf: halfL - Math.min(halfW, halfL),
    doorHalf: hasDoors ? doorWidth/2 : 0, landingHalf, reach,
    landing: halfW + 0.9,                                   // across to the middle of an entrance's landing
    alongMax: Math.max(0.5, halfL - Math.min(halfW, halfL) - 1), // along the straight middle, clear of the rounded ends
    lineIds: [line.id], networkId: line.networkId, networkStations: 1,
    spot: (across, along) => ({ x: x + right.x*across + forward.x*along, y: deckY, z: z + right.z*across + forward.z*along }),
    // the ground underfoot at (px, pz), crossing from the landing to a stopped carriage's door, `inside` (a spot on its
    // floor just in from it): the deck, up its boarding ramp (see buildStationParts) to the rails, then a step up
    floorAt(px, pz, inside) {
      const acrossOf = (qx, qz) => Math.abs((qx - x)*right.x + (qz - z)*right.z);
      const across = acrossOf(px, pz), ramp = stationRamp(radius), top = s.position.y + ramp.topY, into = acrossOf(inside.x, inside.z);
      const lerp = (a, b, k) => a + (b - a)*Math.max(0, Math.min(1, k));
      if (across >= ramp.inner) return lerp(top, deckY, (across - ramp.inner)/(ramp.outer - ramp.inner));
      return lerp(inside.y, top, (across - into)/Math.max(1e-3, ramp.inner - into));
    },
    lifts: stationLifts(s.position, radius).map(l => makeLift(s, l, right, forward, line, mats)),
    // its doors, each side's pair sliding open while anyone's by them (see openDoor and updateStationDoors)
    doors: { forward, leaves, open: { 1: 0, [-1]: 0 }, hold: { 1: 0, [-1]: 0 } },
    // someone's at (or just through) the doorway on `side`: its doors stay open for a moment yet
    openDoor(side) { this.doors.hold[side] = 0.6; } });
}
// slides each station's doors open, or shut again once nobody's kept them open for a moment
function updateStationDoors(dt) {
  const ease = x => x*x*(3 - 2*x);
  trainStations.forEach(st => {
    const d = st.doors;
    [1, -1].forEach(side => {
      const opening = d.hold[side] > 0;
      d.hold[side] -= dt;
      const was = d.open[side];
      d.open[side] = THREE.MathUtils.clamp(was + (d.hold[side] > 0 ? 1 : -1)*DOOR_SPEED*dt, 0, 1);
      // "ptshh", as they start to open, and as they start to shut
      if (d.hold[side] > 0 ? was === 0 : opening && was > 0) doorSwish(st.spot(side*st.halfW, 0), 0.85);
      if (d.open[side] === was) return;
      const k = ease(d.open[side]);
      d.leaves.forEach(l => { if (l.side === side) l.mesh.position.copy(d.forward).multiplyScalar(l.dir*l.reach*k); });
    });
  });
}
// ---- the stations' lifts (see stationLifts): each cab waits where it is, doorways open, until someone calls it to
// the other end — anyone waiting there, or anyone aboard (see "riding the trains" in people.js) — then, once it's
// stood LIFT_DWELL there (and nobody's still stepping in), rides over, easing out and in. Their state (where each cab
// is) survives the train meshes being rebuilt, as long as the station does.
let stationLiftList = [];
const liftStateOf = new Map(); // station node id + side -> { y, level }, kept across rebuilds
function makeLift(s, { side, across, width, bottom, top, cab: cabHeight }, right, forward, line, mats) {
  const base = s.position.y, cab = buildLiftCab(mats, width, cabHeight);
  cab.name = 'TrainStationLiftCab';
  cab.traverse(o => { if (o.isMesh) o.userData = { networkId: line.networkId, baseColor: o.material.color.getHex() }; });
  // turned so the cab's +x points out, away from the track, on its side
  const out = new THREE.Vector3(right.x*side, 0, right.z*side), up = new THREE.Vector3(0, 1, 0);
  cab.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(out, up, new THREE.Vector3().crossVectors(out, up)));
  const key = s.node + ':' + side, kept = liftStateOf.get(key);
  const lift = { key, side, across, depth: LIFT_DEPTH, width, bottom: base + bottom, top: base + top, cab,
    y: kept ? Math.min(base + top, Math.max(base + bottom, kept.y)) : base + bottom, level: kept ? kept.level : 'bottom',
    from: null, dwell: 0, hold: 0, calls: new Set(),
    // a spot in or by the lift: `out` metres outward from the shaft's middle (away from the station), `along` the track,
    // at height y
    spot: (outward, along, y) => ({ x: s.position.x + right.x*side*(across + outward) + forward.x*along, y,
      z: s.position.z + right.z*side*(across + outward) + forward.z*along }),
    // the other end of the shaft, to call the cab to, from 'bottom' or 'top'
    other: level => level === 'bottom' ? 'top' : 'bottom',
    // someone waiting at `level` (or aboard, bound for it) wants the cab there
    call(level) { this.calls.add(level); },
    // someone's still stepping in or out: the cab doesn't leave for a moment
    wait() { this.hold = Math.max(this.hold, 0.5); },
    // standing at `level` with its doorway open?
    openAt(level) { return this.level === level; },
  };
  const at = lift.spot(0, 0, lift.y);
  cab.position.set(at.x, lift.y, at.z);
  S.trainMeshGroup.add(cab);
  stationLiftList.push(lift);
  return lift;
}
function updateStationLifts(dt) {
  stationLiftList.forEach(lift => {
    if (lift.level) {
      lift.calls.delete(lift.level);
      lift.dwell -= dt; lift.hold -= dt;
      const next = lift.other(lift.level);
      if (lift.calls.has(next) && lift.dwell <= 0 && lift.hold <= 0) { lift.from = lift.level; lift.level = null; lift.target = next; }
    } else {
      // up or down at LIFT_SPEED, easing in and out over the last couple of metres
      const goal = lift.target === 'top' ? lift.top : lift.bottom, start = lift.from === 'top' ? lift.top : lift.bottom;
      const left = Math.abs(goal - lift.y), gone = Math.abs(lift.y - start);
      const speed = LIFT_SPEED*Math.max(0.15, Math.min(1, left/2, (gone + 0.2)/2));
      if (left <= speed*dt) {
        lift.y = goal; lift.level = lift.target; lift.dwell = LIFT_DWELL; lift.calls.delete(lift.level);
      } else lift.y += Math.sign(goal - lift.y)*speed*dt;
    }
    lift.cab.position.y = lift.y;
    liftStateOf.set(lift.key, { y: lift.y, level: lift.level ?? lift.target });
  });
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
// material the model gave it: 'Window…' keeps the model's own glass (see carriageWindowMaterial), 'Black…' takes the
// shuttle's dark trim, 'Cushion…' the seat fabric inside, 'Lights…' the glowing strips on the ceiling (in the model's own
// emissive colour), anything else its body. Until it's ready (or if it can't load), carriages are the built-in capsule.
// It also measures where people can stand (see carriageSpot): on the floor the seats stand on, in the aisle between the
// two blocks of seats, and where the ceiling lights hang, for the light in the cabin.
const TRAIN_CARRIAGE_FIT = 0.8; // the carriage's furthest reach from its axis, as a fraction of the tube's radius
const CARRIAGE_MODEL_URL = 'assets/models/Carriage.glb';
let carriageModel = null;
export async function loadCarriageModel() {
  let buffer;
  try {
    buffer = await fetch(CARRIAGE_MODEL_URL).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  } catch (err) {
    console.warn('Splinetopia: the carriage model failed to load; train carriages use the built-in capsule', err);
    return;
  }
  new GLTFLoader().parse(buffer, '', (gltf) => {
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    let windowMaterial = null; // the glass the carriage was modelled with — see carriageWindowMaterial
    let lightColor = null;     // and the colour its ceiling lights glow
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      // Blender numbers a material it has had to copy ('Black.002'), so the suffix is dropped before the name is read.
      const name = ((o.material && o.material.name) || '').toLowerCase().replace(/\.\d+$/, '');
      const role = name.startsWith('window') ? 'window' : name.startsWith('black') || name.startsWith('rubber') ? 'trim' : name.startsWith('cushion') ? 'cushion'
        : name.startsWith('lights') ? 'lights' : 'body';
      if (role==='window' && !windowMaterial && o.material) windowMaterial = o.material;
      if (role==='lights' && !lightColor && o.material?.emissive) lightColor = o.material.emissive.clone();
      const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
      // (applyMatrix4 leaves the shape keys alone: they're offsets, so they only need turning and scaling with it)
      bakeMorphs(geometry, o.matrixWorld);
      const doors = o.morphTargetDictionary ? [o.morphTargetDictionary.Doors1, o.morphTargetDictionary.Doors2] : null;
      parts.push({ geometry, role, doors: doors && doors.every(k => k != null) ? doors : null });
    });
    if (!parts.length) return;
    // (measured from the vertices where they rest: a bounding box would reach out to the open doors too)
    const box = new THREE.Box3();
    parts.forEach(p => box.expandByObject(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', p.geometry.attributes.position))));
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    // lay its longest side along Z (a model exported lengthwise along X gets turned a quarter; Y stays up)
    const turn = size.x > size.z ? new THREE.Matrix4().makeRotationY(Math.PI/2) : null;
    let crossRadius = 0, halfWidth = 0, floor = Infinity, seatsFrom = Infinity, lampY = Infinity;
    parts.forEach(p => {
      p.geometry.translate(-center.x, -center.y, -center.z);
      if (turn) { p.geometry.applyMatrix4(turn); bakeMorphs(p.geometry, turn); }
      const pos = p.geometry.attributes.position;
      for (let i=0;i<pos.count;i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        crossRadius = Math.max(crossRadius, Math.hypot(x, y));
        halfWidth = Math.max(halfWidth, Math.abs(x));
        if (p.role==='cushion') { floor = Math.min(floor, y); seatsFrom = Math.min(seatsFrom, Math.abs(z)); }
        if (p.role==='lights') lampY = Math.min(lampY, y);
      }
    });
    const length = Math.max(size.x, size.z);
    // (a model with no seats or lights: the floor a third of the way up, standing room down the middle third, the light
    // just under the roof)
    const stand = {
      floor: isFinite(floor) ? floor : -size.y/3,
      across: halfWidth*0.6,
      along: (isFinite(seatsFrom) ? seatsFrom : length/6)*0.85,
      lampY: (isFinite(lampY) ? lampY : size.y/2) - 0.1,
    };
    carriageModel = { parts, length, crossRadius: crossRadius || 1, windowMaterial, lightColor, stand };
    rebuildTrainMeshes(); App.refreshHighlights();
  }, (err) => console.warn('Splinetopia: the carriage model failed to load; train carriages use the built-in capsule', err));
}
// Turns and scales a geometry's shape keys (offsets from where it rests) by `matrix`, as applyMatrix4 has the rest.
function bakeMorphs(geometry, matrix) {
  const linear = new THREE.Matrix3().setFromMatrix4(matrix), normal = new THREE.Matrix3().getNormalMatrix(matrix);
  (geometry.morphAttributes.position || []).forEach(a => a.applyMatrix3(linear));
  (geometry.morphAttributes.normal || []).forEach(a => { a.applyMatrix3(normal); a.normalizeNormals?.(); });
}
// A carriage's doors, `open` from 0 (shut) to 2 (wide): out over the first half, apart over the second.
function setCarriageDoors(shuttle, open) {
  const ease = x => { x = Math.max(0, Math.min(1, x)); return x*x*(3 - 2*x); };
  shuttle.object.userData.doorMeshes?.forEach(({ mesh, doors }) => {
    mesh.morphTargetInfluences[doors[0]] = ease(open);
    mesh.morphTargetInfluences[doors[1]] = ease(open - 1);
  });
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
      const material = part.role==='window' ? mats.shuttleWindows : part.role==='trim' ? mats.shuttleTrim : part.role==='cushion' ? mats.shuttleCushion
        : part.role==='lights' ? mats.shuttleLights : mats.shuttle;
      const mesh = addPart(part.geometry, material);
      if (part.doors) (group.userData.doorMeshes ??= []).push({ mesh, doors: part.doors });
      mesh.userData.sharedGeometry = true; // every carriage reuses the model's geometry — see disposeObject
      mesh.scale.setScalar(scale);
    });
    group.userData.length = carriageModel.length*scale;
    const { floor, across, along, lampY } = carriageModel.stand;
    group.userData.stand = { floor: floor*scale, across: across*scale, along: along*scale, lampY: lampY*scale };
  } else {
    const r = radius*0.62, length = Math.max(8, radius*4.5);
    const body = buildShuttleGeometry(r, length), windows = new THREE.CylinderGeometry(r*1.02, r*1.02, length*0.34, 24, 1, true);
    body.rotateX(Math.PI/2); windows.rotateX(Math.PI/2); // lathed around Y; carriages run along Z
    addPart(body, mats.shuttle);
    addPart(windows, mats.shuttleWindows);
    group.userData.length = length;
    group.userData.stand = { floor: -r*0.6, across: r*0.4, along: length*0.3, lampY: r*0.6 };
  }
  group.visible = false; // shown once updateTrainShuttles has put it in place
  return group;
}
// The out-and-back schedule for a line's shuttle, as distances along the line: a stop at each end (kept far enough in
// that the whole carriage stays inside the tube) and at every station between, with a run easing out of one stop and
// into the next. Forward to the far end, then back again, and repeat. Returns the steps in order — { at, dwell, node
// (the station's node id, or null for an end of the line) } for a stop, { from, to, duration } for a run — and the whole cycle's length in seconds.
function buildShuttleTimeline(total, stations, shuttleLength) {
  const margin = Math.min(total/2, shuttleLength/2 + 0.5);
  const clamp = d => Math.max(margin, Math.min(total - margin, d));
  // a station that IS the line's end sits centered on it (dist exactly 0 or total); only a station short of a plain
  // dead end needs the margin clamp so the carriage doesn't poke out past the last bit of bare track
  const stopAt = s => (s.dist < 1e-6 || s.dist > total - 1e-6) ? s.dist : clamp(s.dist);
  const stops = [{ at: margin, node: null }];
  stations.map(s => ({ at: stopAt(s), node: s.node })).sort((p, q) => p.at-q.at).forEach(s => {
    const last = stops[stops.length-1];
    if (s.at - last.at < 1) { last.at = s.at; last.node = last.node || s.node; } // a station right at the end of the line is that end's stop
    else stops.push(s);
  });
  if (total - margin - stops[stops.length-1].at >= 1) stops.push({ at: total - margin, node: null });
  const dwellAt = stop => stop.node ? TRAIN_STATION_DWELL : TRAIN_END_DWELL;
  const run = (a, b) => ({ from: a.at, to: b.at, duration: Math.max(1, Math.abs(b.at - a.at)/TRAIN_SHUTTLE_SPEED) });
  const steps = [];
  for (let i=0;i<stops.length;i++) {
    steps.push({ at: stops[i].at, dwell: dwellAt(stops[i]), node: stops[i].node });
    if (i < stops.length-1) steps.push(run(stops[i], stops[i+1]));
  }
  for (let i=stops.length-1;i>0;i--) {
    steps.push(run(stops[i], stops[i-1]));
    if (i-1 > 0) steps.push({ at: stops[i-1].at, dwell: dwellAt(stops[i-1]), node: stops[i-1].node });
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
// ---- the light in the cabin: the ceiling strips glow (mats.shuttleLights), and a soft blue point light hangs among them
// so the seats, the floor and whoever's standing there are lit by them — and some of it spills out through the windows
// onto the tube. Only the CARRIAGE_LIGHTS carriages nearest the camera have one: a fixed few lights, always in the scene
// (unused ones at nothing), so the number of lights never changes and nothing has to recompile as carriages come and go.
const CARRIAGE_LIGHT_COLOR = new THREE.Color(0x4cc8ff), CARRIAGE_LIGHTS_GLOW = 2.2;
const CARRIAGE_LIGHTS = 2, CARRIAGE_LIGHT_INTENSITY = 5, CARRIAGE_LIGHT_FAR = 220;
const carriageLights = Array.from({ length: CARRIAGE_LIGHTS }, () => {
  const light = new THREE.PointLight(CARRIAGE_LIGHT_COLOR, 0, 1, 1.4);
  light.name = 'CarriageLight';
  scene.add(light);
  return light;
});
function placeCarriageLights() {
  const nearest = trainShuttles.filter(s => s.object.visible)
    .map(s => ({ s, d: s.object.position.distanceTo(camera.position) }))
    .filter(n => n.d < CARRIAGE_LIGHT_FAR).sort((a, b) => a.d - b.d);
  carriageLights.forEach((light, k) => {
    const n = nearest[k];
    if (!n) { light.intensity = 0; return; }
    const { stand, length } = n.s.object.userData;
    if (carriageModel?.lightColor) light.color.copy(carriageModel.lightColor);
    light.position.set(0, stand.lampY, 0).applyQuaternion(n.s.object.quaternion).add(n.s.object.position);
    light.distance = length*0.9;
    light.intensity = CARRIAGE_LIGHT_INTENSITY*(1 - THREE.MathUtils.smoothstep(n.d, CARRIAGE_LIGHT_FAR*0.7, CARRIAGE_LIGHT_FAR));
  });
}
// Someone's getting on or off a line's carriage, stopped at a station: it doesn't leave for a moment yet (see
// updateTrainShuttles).
export function holdTrain(lineId) {
  const s = trainShuttles.find(s => s.lineId === lineId);
  if (s) s.hold = 0.3;
}
// Where someone riding a carriage stands (see "riding the trains" in people.js): `across` and `along` from -1 to 1 over its
// standing room, on its floor, and `yaw`, which way the carriage faces, for them to turn from.
export function carriageSpot(shuttle, across, along) {
  const o = shuttle.object, { stand } = o.userData;
  const at = new THREE.Vector3(across*stand.across, stand.floor, along*stand.along).applyQuaternion(o.quaternion).add(o.position);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
  return { x: at.x, y: at.y, z: at.z, yaw: Math.atan2(forward.x, forward.z) };
}
let lastShuttleFrame = null;
export function updateTrainShuttles(t) {
  const dt = lastShuttleFrame == null ? 0 : Math.max(0, t - lastShuttleFrame); // (uncapped: it only measures the carriages' speed)
  lastShuttleFrame = t;
  const ease = x => x*x*(3 - 2*x);
  trainShuttles.forEach(s => {
    const late = lateBy.get(s.lineId) || 0;
    let phase = (((t + s.offset - late) % s.cycle) + s.cycle) % s.cycle, along = s.steps[0].at, stopNode = null, doorsWant = 0;
    for (const step of s.steps) {
      const span = step.dwell!=null ? step.dwell : step.duration;
      if (phase <= span) {
        along = step.dwell!=null ? step.at : step.from + (step.to - step.from)*ease(phase/span);
        if (step.dwell!=null) stopNode = step.node;
        // someone still getting on or off, as its doors are about to shut: it waits (up to TRAIN_HOLD_MAX), running late
        // — kept just short of shutting them, however far along they'd got
        if (step.node != null && s.hold > 0 && span - phase < CARRIAGE_DOORS_SHUT_BY && s.held < TRAIN_HOLD_MAX) {
          lateBy.set(s.lineId, late + CARRIAGE_DOORS_SHUT_BY - (span - phase) + dt); s.held += dt;
        }
        // open while it's stopped at a station, shut in time to leave
        if (step.node != null) doorsWant = span - phase > CARRIAGE_DOORS_SHUT_BY || (s.hold > 0 && s.held < TRAIN_HOLD_MAX) ? 2 : 0;
        break;
      }
      phase -= span;
    }
    s.hold -= dt;
    if (stopNode == null) s.held = 0;
    s.arrived = stopNode != null && stopNode !== s.stopNode;
    s.stopNode = stopNode;
    if (doorsWant !== s.doorsWant && doorsWant !== s.doors) doorSwish(s.object.position); // ("ptshh", opening or shutting)
    s.doorsWant = doorsWant;
    s.doors += Math.max(-dt, Math.min(dt, (doorsWant - s.doors)))/CARRIAGE_DOOR_STEP;
    s.doors = Math.max(0, Math.min(2, s.doors));
    setCarriageDoors(s, s.doors);
    lastStopOf.set(s.lineId, stopNode);
    const { point, tangent } = s.sampler.at(along);
    s.object.position.copy(point);
    orientAlongTrack(s.object, tangent);
    s.object.visible = true;
  });
  updateStationLifts(dt);
  updateStationDoors(dt);
  placeCarriageLights();
  updateShuttleSounds(trainShuttles, dt); // (the hum, the whir-up and the chime: see audio/maglev.js)
  if (followedTrain && S.interactionMode !== 'move') stopFollowingTrain();
  // the camera onto the carriage it's following
  const followed = followedTrain && trainShuttles.find(s => s.lineId === followedTrain);
  if (followed) controls.goalTarget.copy(followed.object.position);
  placeRidingCamera();
}

// ---- following a carriage with the camera: just like a car (see "following a car" in life/traffic/follow.js) — a click on one in
// World mode keeps the view on it, with a card (built above) naming it — Train #n, by its line's place among them —
// until a click elsewhere, leaving World mode, or its line being deleted lets it go. Unlike a car, it can't be killed.
let followedTrain = null; // the followed carriage's line id, which survives the train meshes being rebuilt
// the carriage under a point on the screen, as its index in trainShuttles, or -1
// (out, if given, gets the hit's distance from the camera, for comparing across kinds)
function pickTrain(clientX, clientY, out) {
  const shown = trainShuttles.filter(s => s.object.visible);
  if (!shown.length) return -1;
  App.raycaster.setFromCamera(App.ndcOf(clientX, clientY), camera);
  const hit = App.raycaster.intersectObjects(shown.map(s => s.object), true)[0];
  if (!hit) return -1;
  if (out) out.distance = hit.distance;
  return trainShuttles.findIndex(s => s.object === hit.object.parent);
}
function showFollowedTrainCard() {
  const i = trainShuttles.findIndex(s => s.lineId === followedTrain);
  showTrainCard({ number: i + 1, view: trainThumbnailOf(trainShuttles[i].object) });
  const lineId = followedTrain;
  trainCard.setFavorite({ key: 'train:' + lineId, kind: 'Train', follow: () => followTrainLine(lineId) });
}
// The card's thumbnail: a copy of the carriage (sharing its geometry and materials), sitting level at the origin, and an
// isometric camera framing it — as for a car (see makeCarThumbnail in life/traffic/materials.js).
function trainThumbnailOf(shuttle) {
  const mesh = shuttle.clone();
  mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.visible = true;
  const r = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius;
  const elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = r*4;
  const camera = new THREE.OrthographicCamera(-r, r, r, -r, 0.1, distance*2);
  camera.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  camera.lookAt(0, 0, 0);
  return { mesh, camera };
}
// follows whichever carriage is under a point on the screen, or stops following if none is
function followTrainAt(clientX, clientY) {
  const i = pickTrain(clientX, clientY);
  if (i < 0) { stopFollowingTrain(); return; }
  followTrainLine(trainShuttles[i].lineId);
}
// follows a line's carriage (as when someone being followed boards it — see people.js)
function followTrainLine(lineId) {
  const i = trainShuttles.findIndex(s => s.lineId === lineId);
  if (i < 0) return false;
  if (ridingTrain !== lineId) leaveTrain(); // (the camera moving to another carriage gets off the one it was in)
  followedTrain = lineId;
  const radius = Math.max(1.2, trainShuttles[i].object.userData.length*0.3);
  controls.minRadius = radius;
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, radius*6));
  showFollowedTrainCard();
  return true;
}
function stopFollowingTrain() {
  if (!followedTrain) return;
  leaveTrain(); // (nobody goes on riding a carriage the camera has let go of)
  followedTrain = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  hideTrainCard();
}

// ---- riding inside a carriage: the card's Enter button puts the view in the middle of the carriage the camera's
// following, where it sits for the rest of the journey — a tripod rather than an orbit. It can't be panned, zoomed or
// swung round the carriage; the mouse only turns it on the spot (possession.js does the looking, as it does from
// someone's eyes, and Esc gets off). It rides the carriage's own movement, so the city swings past outside the windows.
// The carriage isn't hidden the way a building is when you go inside it — the whole point is to be sitting in it — which
// is why its shell and glass are drawn from both faces (see materialsFor).
const CARRIAGE_NEAR = 0.05; // near plane while inside: the walls are a couple of units away, so the usual one would clip them
// Where the seat is and how wide the view from it is, both dialled in from the two sliders that come up with the ride
// (#ride-tune in index.html): the height is above or below the middle of the carriage, in world units, and the field of
// view is the vertical one in degrees. They're remembered between rides.
const ride = { height: 0.7, fov: 106 };
const rideTune = document.getElementById('ride-tune');
function wireRideSlider(id, key, decimals, after) {
  const input = document.getElementById('s-' + id), val = document.getElementById('v-' + id);
  input.value = ride[key];
  val.textContent = ride[key].toFixed(decimals);
  input.addEventListener('input', () => {
    ride[key] = parseFloat(input.value);
    val.textContent = ride[key].toFixed(decimals);
    after?.();
  });
}
wireRideSlider('rideheight', 'height', 2, () => placeRidingCamera());
wireRideSlider('ridefov', 'fov', 0);
// what the view's fov should be while riding, for the easing in buildings/interior.js to leave alone (null when not)
const ridingFov = () => ridingTrain ? ride.fov : null;
let ridingTrain = null;     // the ridden carriage's line id, like followedTrain
let rideBefore = null;      // the camera's goals as they were outside, to ease back to
function toggleRide() {
  if (ridingTrain) leaveTrain(); else enterTrain();
}
function enterTrain() {
  const shuttle = followedTrain && trainShuttles.find(s => s.lineId === followedTrain);
  if (!shuttle || ridingTrain) return;
  // facing the way the carriage is going: its own forward is its local +Z (see orientAlongTrack), and a yaw of `a` looks
  // along (sin a, 0, cos a) once possession.js has turned it into a camera angle
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(shuttle.object.quaternion);
  if (!startRiding(Math.atan2(forward.x, forward.z), leaveTrain)) return;
  ridingTrain = followedTrain;
  rideBefore = { radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi, near: camera.near };
  controls.locked = true; // no orbiting, panning or zooming from a seat
  camera.near = CARRIAGE_NEAR;
  camera.updateProjectionMatrix();
  rideTune.hidden = false;
  placeRidingCamera();
  trainCard.setAction(...RIDE_LEAVE);
}
function leaveTrain() {
  if (!ridingTrain) return;
  ridingTrain = null;
  rideTune.hidden = true;
  endRiding();
  controls.locked = false;
  controls.goalRadius = rideBefore.radius;
  controls.goalTheta = rideBefore.theta;
  controls.goalPhi = rideBefore.phi;
  camera.near = rideBefore.near;
  camera.updateProjectionMatrix();
  rideBefore = null;
  trainCard.setAction(...RIDE_ENTER);
}
// The view from the seat, after the carriages have been moved for this frame: the middle of the carriage (which is where
// its object sits — the model is centred on it, see loadCarriageModel), turned wherever the mouse has left it. A carriage
// that's gone out from under the view — its line deleted, say — puts it back outside.
function placeRidingCamera() {
  if (!ridingTrain) return;
  const shuttle = trainShuttles.find(s => s.lineId === ridingTrain);
  if (!shuttle) { leaveTrain(); return; }
  camera.position.copy(shuttle.object.position);
  camera.position.y += ride.height;
  camera.rotation.set(possession.pitch, possession.yaw + Math.PI, 0, 'YXZ');
  if (camera.isPerspectiveCamera && camera.fov !== ride.fov) { camera.fov = ride.fov; camera.updateProjectionMatrix(); }
}
const followedTrainLine = () => followedTrain;
// (the carriage card is handed over too, for whoever else wants to put something on it or open one)
Object.assign(App, { pickTrain, followTrainAt, followTrainLine, followedTrainLine, stopFollowingTrain, showTrainCard, hideTrainCard, setTrainCardPassengers, leaveTrain, ridingFov });
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
    next.y = snapStationHeight(S.draggedNode.nodeId, next.y);
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
// is from the camera, at NODE_UI_DISTANCE away being the size it's made. A nearer distance means bigger markers, which
// is what touch gets: a fingertip covers a good deal more of the screen than a cursor's point does.
const NODE_UI_DISTANCE = IS_TOUCH ? 110 : 160;
export function nodeUiScaleAt(camera, position) { return apparentDistance(camera, position)/NODE_UI_DISTANCE; }
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
