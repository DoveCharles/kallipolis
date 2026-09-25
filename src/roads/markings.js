import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { distPointSegment } from '../buildings/footprints.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths, createMeshBuilder } from './roads.js';
import { isWalkwayLine, isRiverLine } from './paths.js';

// ---------------------------------------------------------- road markings & traffic lights
// Sidewalk roads get painted markings: a solid line along each edge, and a dashed center line on roads wide enough for
// two lanes, both stopping short of junctions. Where three or more roads meet, every road arm gets a zebra crossing, a
// stop line across its incoming lane, and a traffic light — a pole on the sidewalk with a mast reaching out over that lane
// and a signal head facing the oncoming traffic. A junction's lights run in two phases (arms roughly in line with each
// other share one): green, amber, then red, with a moment of all-red before the other phase goes green. Cars stop for them
// (see updateTraffic).
const MARKING_COLOR = 0xe6e4dc;
const MARKING_Y = Y_ROAD + 0.01;
const SIGNAL_CYCLE = 22, SIGNAL_GREEN = 8, SIGNAL_AMBER = 2.5; // seconds; phase 1 runs half a cycle behind phase 0
const SIGNAL_LAMPS_MAX = 3000;
const SIGNAL_LAMP_COLORS = [0xff3b30, 0xffb020, 0x3ddc6b]; // red, amber, green — top to bottom, and signalState's 0, 1, 2
S.roadJunctions = [], S.roadJunctionByPlace = new Map();
let signalLamps = []; // { junction, phase, lamp, on } for each lamp in signalLampMesh, in order
const signalLampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), SIGNAL_LAMPS_MAX);
signalLampMesh.setColorAt(0, new THREE.Color()); // while the count is still the maximum, so the color buffer is full-size
signalLampMesh.count = 0;
signalLampMesh.frustumCulled = false;
signalLampMesh.name = 'SignalLamps';
scene.add(signalLampMesh);
// the key a junction is found under — the same rounding the walkway and lane graphs use to join lines at a point
export function placeKey(x, z) { return Math.round(x*2) + ',' + Math.round(z*2); }
// 0 red, 1 amber or 2 green, for a phase of a junction's lights at time t
export function signalState(junction, phase, t) {
  const s = (((t + junction.offset - phase*SIGNAL_CYCLE/2) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return s < SIGNAL_GREEN ? 2 : s < SIGNAL_GREEN + SIGNAL_AMBER ? 1 : 0;
}
// how many more seconds a phase of a junction's lights stays red at time t (0 if it isn't red) — for a pedestrian
// deciding whether there's time to get across before its traffic goes again
export function signalRedLeft(junction, phase, t) {
  const s = (((t + junction.offset - phase*SIGNAL_CYCLE/2) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return s < SIGNAL_GREEN + SIGNAL_AMBER ? 0 : SIGNAL_CYCLE - s;
}
// Every node where three or more sidewalk-road arms meet: { x, z, r (how far the junction reaches out from its center),
// offset (so neighboring junctions don't all change together), arms: [{ x, z (unit direction away from the center), hw,
// cw, sw, phase }] }.
function findRoadJunctions() {
  const armsAt = new Map();
  S.roadLines.forEach(line => {
    if (App.isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return;
    const nodes = line.nodeIds.map(id => roadNodes[id]);
    if (nodes.length < 2 || nodes.some(n => !n)) return;
    const pts = tessellateOpenPath(nodes), widths = roadLineWidths(line);
    let from = 0; // (a loop has its first node again at the end: that's its last point, not its first again)
    line.nodeIds.forEach(id => {
      const n = roadNodes[id], at = pts.findIndex((p, i) => i >= from && Math.abs(p.x - n.x) < 1e-6 && Math.abs(p.z - n.z) < 1e-6);
      if (at < 0) return;
      from = at + 1;
      if (!armsAt.has(id)) armsAt.set(id, []);
      [pts[at-1], pts[at+1]].forEach(q => {
        if (!q) return;
        const dx = q.x - n.x, dz = q.z - n.z, len = Math.hypot(dx, dz);
        if (len > 1e-6) armsAt.get(id).push({ x: dx/len, z: dz/len, ...widths });
      });
    });
  });
  const junctions = [];
  armsAt.forEach((arms, id) => {
    if (arms.length < 3) return;
    const n = roadNodes[id];
    // phase 0 for the two arms most nearly in line with each other (the road straight through), or just the first if
    // none are; phase 1 for the rest — comparing every arm against one, a diagonal arm would put them all in one phase
    let through = [arms[0]], straightest = -0.5;
    arms.forEach((a, i) => arms.slice(i+1).forEach(b => {
      const dot = a.x*b.x + a.z*b.z;
      if (dot < straightest) { straightest = dot; through = [a, b]; }
    }));
    arms.forEach(arm => { arm.phase = through.includes(arm) ? 0 : 1; });
    junctions.push({ x: n.x, z: n.z, arms, r: Math.max(...arms.map(a => a.hw + a.cw + a.sw)) + 0.6,
      offset: (Math.abs(Math.round(n.x*7 + n.z*13)) % 97)/97*SIGNAL_CYCLE });
  });
  return junctions;
}
// the stretches ([t0, t1], 0 at a and 1 at b) of the segment a→b that lie outside every circle ({ x, z, R })
function outsideCircles(a, b, circles) {
  let spans = [[0, 1]];
  circles.forEach(c => {
    const dx = b.x - a.x, dz = b.z - a.z, fx = a.x - c.x, fz = a.z - c.z;
    const A = dx*dx + dz*dz, B = 2*(fx*dx + fz*dz), C = fx*fx + fz*fz - c.R*c.R, disc = B*B - 4*A*C;
    if (A < 1e-9 || disc <= 0) return;
    const root = Math.sqrt(disc), t0 = (-B - root)/(2*A), t1 = (-B + root)/(2*A);
    spans = spans.flatMap(([u0, u1]) => {
      const out = [];
      if (t0 > u0) out.push([u0, Math.min(u1, t0)]);
      if (t1 < u1) out.push([Math.max(u0, t1), u1]);
      return out.filter(([p, q]) => q - p > 1e-4);
    });
  });
  return spans;
}
const EDGE_MITER_LIMIT = 4; // as the road surface's: sharper bends are bevelled instead of spiking outward
// where segments p→q and r→s cross, or null
function segmentsCross(p, q, r, s) {
  const dx = q.x - p.x, dz = q.z - p.z, ex = s.x - r.x, ez = s.z - r.z, den = dx*ez - dz*ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((r.x - p.x)*ez - (r.z - p.z)*ex)/den, u = ((r.x - p.x)*dz - (r.z - p.z)*dx)/den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: p.x + dx*t, z: p.z + dz*t } : null;
}
// The polyline pts shifted `off` to its left, joined at each bend (mitered, or bevelled past the limit) rather than
// each segment shifted on its own — which left the lines crossing on the inside of a sharp turn and apart on the
// outside. On the inside of a bend tighter than `off`, the shifted line folds back over itself; those small loops
// are cut out where it crosses itself.
function offsetPolyline(pts, off) {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i-1].x, q.z - pts[i-1].z) > 1e-4);
  if (p.length < 2) return [];
  const normals = p.slice(1).map((b, i) => {
    const a = p[i], len = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: -(b.z - a.z)/len, z: (b.x - a.x)/len };
  });
  const out = [{ x: p[0].x + normals[0].x*off, z: p[0].z + normals[0].z*off }];
  for (let i=1;i<p.length-1;i++) {
    const n0 = normals[i-1], n1 = normals[i], mx = n0.x + n1.x, mz = n0.z + n1.z, cos = Math.hypot(mx, mz)/2;
    if (cos > 1/EDGE_MITER_LIMIT) out.push({ x: p[i].x + mx/(2*cos)*off/cos, z: p[i].z + mz/(2*cos)*off/cos });
    else out.push({ x: p[i].x + n0.x*off, z: p[i].z + n0.z*off }, { x: p[i].x + n1.x*off, z: p[i].z + n1.z*off });
  }
  const last = normals[normals.length-1], end = p[p.length-1];
  out.push({ x: end.x + last.x*off, z: end.z + last.z*off });
  // cut out loops: from each segment, the furthest later one it crosses within a short stretch of line
  const reach = Math.abs(off)*8 + 2;
  for (let i=0;i<out.length-3;i++) {
    let stretch = 0, cut = null;
    for (let j=i+2;j<out.length-1;j++) {
      stretch += Math.hypot(out[j].x - out[j-1].x, out[j].z - out[j-1].z);
      if (stretch > reach) break;
      const x = segmentsCross(out[i], out[i+1], out[j], out[j+1]);
      if (x) cut = { j, x };
    }
    if (cut) out.splice(i+1, cut.j - i, cut.x);
  }
  return out;
}
// Builds the markings, crossings and traffic lights into roadMeshGroup, and places the signal lamps. Called by
// rebuildRoadMeshes.
function buildRoadDetails() {
  S.roadJunctions = findRoadJunctions();
  S.roadJunctionByPlace = new Map(S.roadJunctions.map(j => [placeKey(j.x, j.z), j]));
  const marks = createMeshBuilder(), poles = createMeshBuilder(), heads = createMeshBuilder(), up = { x: 0, y: 1, z: 0 };
  const at = (p, q, t) => ({ x: p.x + (q.x - p.x)*t, z: p.z + (q.z - p.z)*t });
  // a flat painted rectangle centered on (cx, cz), halfLen along (dx, dz) and halfWid across it
  const paintRect = (cx, cz, dx, dz, halfLen, halfWid) => {
    const ax = dx*halfLen, az = dz*halfLen, bx = -dz*halfWid, bz = dx*halfWid;
    marks.addQuad({ x: cx-ax-bx, y: MARKING_Y, z: cz-az-bz }, { x: cx+ax-bx, y: MARKING_Y, z: cz+az-bz }, { x: cx+ax+bx, y: MARKING_Y, z: cz+az+bz }, { x: cx-ax+bx, y: MARKING_Y, z: cz-az+bz }, up);
  };
  const paintLine = (p, q, halfWidth) => {
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len > 1e-4) paintRect((p.x + q.x)/2, (p.z + q.z)/2, (q.x - p.x)/len, (q.z - p.z)/len, len/2, halfWidth);
  };
  S.roadLines.forEach(line => {
    if (App.isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return;
    const nodes = line.nodeIds.map(id => roadNodes[id]).filter(Boolean);
    const { hw } = roadLineWidths(line);
    if (nodes.length < 2 || hw*2 < 5) return;
    const pts = tessellateOpenPath(nodes), DASH = 3, PERIOD = 7;
    // edge lines, up to the crossing — each piece lengthened by its half-width where it meets the next, so a
    // bend's outer corner isn't notched
    [1, -1].forEach(side => {
      const edge = offsetPolyline(pts, (hw - 0.35)*side);
      for (let i=0;i<edge.length-1;i++) {
        const pa = edge[i], pb = edge[i+1], len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        if (len < 1e-4) continue;
        const near = S.roadJunctions.filter(j => distPointSegment(j, pa, pb) < j.r + 1);
        outsideCircles(pa, pb, near.map(j => ({ x: j.x, z: j.z, R: j.r + 0.3 }))).forEach(([t0, t1]) => {
          const e0 = t0 < 1e-6 && i > 0 ? 0.09/len : 0, e1 = t1 > 1 - 1e-6 && i < edge.length-2 ? 0.09/len : 0;
          paintLine(at(pa, pb, t0 - e0), at(pa, pb, t1 + e1), 0.09);
        });
      }
    });
    let along = 0;
    for (let i=0;i<pts.length-1;i++) {
      const a = pts[i], b = pts[i+1], len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-4) continue;
      const near = S.roadJunctions.filter(j => distPointSegment(j, a, b) < j.r + 6);
      // center dashes, up to the stop lines
      if (hw*2 >= 6) {
        for (let k = Math.floor(along/PERIOD); k*PERIOD < along + len; k++) {
          const d0 = Math.max(along, k*PERIOD), d1 = Math.min(along + len, k*PERIOD + DASH);
          if (d1 <= d0) continue;
          const pa = at(a, b, (d0 - along)/len), pb = at(a, b, (d1 - along)/len);
          outsideCircles(pa, pb, near.map(j => ({ x: j.x, z: j.z, R: j.r + 3.6 }))).forEach(([t0, t1]) => paintLine(at(pa, pb, t0), at(pa, pb, t1), 0.1));
        }
      }
      along += len;
    }
  });
  signalLamps = [];
  const matrix = new THREE.Matrix4();
  S.roadJunctions.forEach(j => j.arms.forEach(arm => {
    // along the arm, away from the junction; and across it, towards the side its incoming traffic drives on
    const ax = arm.x, az = arm.z, sx = az, sz = -ax, { hw, cw, sw } = arm;
    const crossing = { x: j.x + ax*(j.r + 1.25), z: j.z + az*(j.r + 1.25) };
    for (let k = -hw + 0.5; k <= hw - 0.45; k += 1) paintRect(crossing.x + sx*k, crossing.z + sz*k, ax, az, 1.25, 0.25);
    paintRect(j.x + ax*(j.r + 3) + sx*hw*0.5, j.z + az*(j.r + 3) + sz*hw*0.5, ax, az, 0.2, Math.max(0.3, hw*0.5 - 0.1));
    const base = { x: j.x + ax*(j.r + 3.6), z: j.z + az*(j.r + 3.6) };
    const poleOut = hw + cw + Math.max(0.4, sw*0.5), headOut = hw*0.5;
    const pole = { x: base.x + sx*poleOut, z: base.z + sz*poleOut }, head = { x: base.x + sx*headOut, z: base.z + sz*headOut };
    poles.addBox(pole.x, pole.z, ax, az, 0.09, 0.09, Y_SIDEWALK, Y_ROAD + 4.6);
    poles.addBox((pole.x + head.x)/2, (pole.z + head.z)/2, sx, sz, (poleOut - headOut)/2 + 0.1, 0.06, Y_ROAD + 4.35, Y_ROAD + 4.48);
    heads.addBox(head.x, head.z, ax, az, 0.14, 0.22, Y_ROAD + 3.3, Y_ROAD + 4.35);
    [4.1, 3.82, 3.54].forEach((height, lamp) => {
      if (signalLamps.length >= SIGNAL_LAMPS_MAX) return;
      signalLampMesh.setMatrixAt(signalLamps.length, matrix.makeTranslation(head.x + ax*0.16, Y_ROAD + height, head.z + az*0.16));
      signalLamps.push({ junction: j, phase: arm.phase, lamp, on: null });
    });
  }));
  signalLampMesh.count = signalLamps.length;
  signalLampMesh.instanceMatrix.needsUpdate = true;
  [[marks, MARKING_COLOR, 'RoadMarkings', { roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }],
   [poles, 0x3a3d42, 'SignalPoles', { roughness: 0.5, metalness: 0.4 }], [heads, 0x17181a, 'SignalHeads', { roughness: 0.6 }]].forEach(([builder, color, name, params]) => {
    const geo = builder.build();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, ...params }));
    mesh.receiveShadow = true;
    mesh.castShadow = name !== 'RoadMarkings';
    mesh.name = name;
    mesh.userData = { baseColor: color }; // no network of its own, so selecting a road doesn't tint it
    S.roadMeshGroup.add(mesh);
  });
}
// lights each lamp that matches its phase's current state, and dims the rest
export function updateTrafficLights(t) {
  const color = new THREE.Color();
  let changed = false;
  signalLamps.forEach((lamp, i) => {
    const on = signalState(lamp.junction, lamp.phase, t) === lamp.lamp;
    if (on === lamp.on) return;
    lamp.on = on;
    changed = true;
    signalLampMesh.setColorAt(i, color.set(SIGNAL_LAMP_COLORS[lamp.lamp]).multiplyScalar(on ? 1.6 : 0.15));
  });
  if (changed) signalLampMesh.instanceColor.needsUpdate = true;
}

Object.assign(App, { buildRoadDetails });
