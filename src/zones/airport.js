import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { Y_ZONE_GROUND, Y_PARK } from '../core/scene.js';
import { mulberry32, lerp, polygonArea, pointInPolygon, centroid } from '../core/math.js';
import { resolveParkTint, resolveGrassNoiseStrength } from '../core/splines.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder, forEachPolyTreeEdge } from '../roads/roads.js';
import { makeParkMesh } from './surface-detail.js';
import { builderMesh, addGableRoof } from './farmland.js';
import { buildRailingMesh } from './fences.js';
import { streetSegmentsNear, streetFor } from './suburbs.js';

// ---------------------------------------------------------- airports
// Every other zone subdivides its outline first and fits content into the pieces. An airport can't: a runway is one long
// straight thing that either fits or doesn't, and no amount of splitting will make one out of two halves. So this zone
// works the other way round — it finds its runway first, and everything else goes in what's left over.
//
// The runway is the longest straight line that fits inside the zone once the zone has been shrunk by half a runway width
// (with roads and the zones above it taken out as solid blockers, not as things to cut through — a road across a runway
// is the one thing an airport can't have). A line inside the shrunk outline means the full-width strip fits inside the
// real one, which is the whole trick. What's left after the runway is subtracted is subdivided the ordinary way, into a
// taxiway, an apron, a terminal and a car park.
//
// Nothing here validates the zone's size. The longest line that fits decides what kind of airfield it is — a helipad, a
// grass strip, a regional field or an international one — the way a suburb plot too small for a house quietly becomes a
// lawn. Draw a small airport and you get a small airfield; there's no failure state, and the worst case (a zone too thin
// even for a helipad) is apron tarmac with markings on it, which still reads as an airport.
//
// World north is along -Z (see day-night.js), so the numbers painted on the runway are the real ones: the compass heading
// of the take-off run from that end, to the nearest ten degrees. A runway pointing due east is 09, and 27 from the other
// end.
const Y_TARMAC = Y_PARK + 0.04;   // the paving stands as a low slab over the airfield grass, like an industrial yard
const Y_MARK = Y_TARMAC + 0.008;
const UP = { x: 0, y: 1, z: 0 };
const TARMAC_COLOR = 0x53575c, MARKING_COLOR = 0xe9e7df;
// A mown strip is the airfield's own grass, cut shorter: the zone's grass tint taken down to just above what the grass
// shader averages it to (grassMid in applyGrassNoiseShader), so the strip reads a shade paler than the field around it —
// and flat, where the field is mottled, which is most of what makes it look mown.
const MOWN_SHADE = 0.64;
const TERMINAL_WALL = 0xd3d6da, TERMINAL_ROOF = 0x7f858c, TERMINAL_GLASS = 0x2f4a60;
const AIRLINE_COLORS = [0x2f6fae, 0xb8412f, 0x3f8f5a, 0xd2a23a, 0x6b4f8a, 0x2b3038];
const FIELD_FENCE_STYLE = { height:2.4, rails:[2.4, 0.2], railWidth:0.06, railHeight:0.06, postSize:0.11, postSpacing:4, color:0x7b8188, roughness:0.5, metalness:0.5 };

/**
 * The kinds of airfield, widest first. `minLength` is how long the runway has to come out before that tier is the one
 * built; each tier is tried in turn and the first whose runway fits wins, so the tier is a *result* of the search rather
 * than something checked against the zone afterwards.
 */
const TIERS = [
  { id:'international', label:'International', width:40, minLength:400, terminal:34, apron:60, paved:true, tower:true, piers:true, stands:4 },
  { id:'regional',      label:'Regional',      width:26, minLength:150, terminal:20, apron:38, paved:true, tower:true, stands:2 },
  { id:'airstrip',      label:'Airstrip',      width:14, minLength:40,  hangars:true, mown:true },
  { id:'heliport',      label:'Heliport',      width:22, minLength:22,  pad:true },
];
const CHORD_ANGLES = 36;        // directions swept through each seed — every 5°, since a line and its reverse are one line
const CHORD_SEED_GRID = 6;      // seeds across the bounding box, each way
const CHORD_MAX_VERTICES = 90;  // above this the vertex-pair pass is dropped and the sweep carries the search on its own
const CHORD_SIMPLIFY = 0.5;     // world units a tessellated outline is cleaned to before the search
const CLEARWAY = 0.45;          // strip kept clear either side of the runway, as a fraction of its width
const FIT_TRIES = 7;            // how many times something is shrunk and pulled back toward the runway before giving up

// ---- finding the runway
/**
 * The stretch of the line through `at` along (dx, dz) that lies inside `poly`.
 *
 * Where the line crosses the polygon's edges is sorted along it; between consecutive crossings the line is alternately
 * inside and outside, starting outside, so the pair straddling `at` is the chord `at` sits in. Exact for a simple
 * polygon, which is what the caller hands it — no sampling, so a thin sliver can't be mistaken for solid ground.
 *
 * @param {Vec2[]} poly A simple polygon (no holes).
 * @param {Vec2} at A point to search through.
 * @param {number} dx Unit direction.
 * @param {number} dz
 * @returns {{a: Vec2, b: Vec2, length: number, dx: number, dz: number}|null} null if `at` is outside `poly`.
 */
function chordThrough(poly, at, dx, dz) {
  const nx = -dz, nz = dx, crossings = [];
  for (let i=0;i<poly.length;i++) {
    const a = poly[i], b = poly[(i+1)%poly.length];
    const sa = (a.x-at.x)*nx + (a.z-at.z)*nz, sb = (b.x-at.x)*nx + (b.z-at.z)*nz;
    // the half-open rule — an edge crosses only if exactly one end is strictly on the positive side — so a vertex sitting
    // exactly on the line is counted once, rather than twice or not at all
    if ((sa > 0) === (sb > 0)) continue;
    const t = sa/(sa - sb);
    crossings.push((a.x - at.x + (b.x-a.x)*t)*dx + (a.z - at.z + (b.z-a.z)*t)*dz);
  }
  crossings.sort((p, q) => p - q);
  for (let i=0;i+1<crossings.length;i+=2) {
    const t0 = crossings[i], t1 = crossings[i+1];
    if (t0 <= 0 && t1 >= 0) return { a: { x: at.x + dx*t0, z: at.z + dz*t0 }, b: { x: at.x + dx*t1, z: at.z + dz*t1 }, length: t1 - t0, dx, dz };
  }
  return null;
}
// Points inside `poly` to search through: its middle, and a coarse grid over its bounding box. A seed only has to land in
// the same part of the polygon as the longest chord, not on the chord itself.
function seedPoints(poly) {
  const seeds = [], middle = centroid(poly);
  if (pointInPolygon(middle, poly)) seeds.push(middle);
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  poly.forEach(p => { if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x; if (p.z<minZ) minZ=p.z; if (p.z>maxZ) maxZ=p.z; });
  for (let i=0;i<CHORD_SEED_GRID;i++) for (let j=0;j<CHORD_SEED_GRID;j++) {
    const p = { x: lerp(minX, maxX, (i+0.5)/CHORD_SEED_GRID), z: lerp(minZ, maxZ, (j+0.5)/CHORD_SEED_GRID) };
    if (pointInPolygon(p, poly)) seeds.push(p);
  }
  return seeds;
}
// `poly` with its near-collinear and near-coincident points dropped, so the search below runs over a handful of corners
// rather than every point a tessellated outline was drawn with.
function cleanPolygon(poly) {
  const cleaned = App.fromClipperPath(ClipperLib.Clipper.CleanPolygon(App.toClipperPath(poly), CHORD_SIMPLIFY*CLIPPER_SCALE));
  return cleaned.length >= 3 ? cleaned : poly;
}
/**
 * The longest straight line that fits inside a simple polygon.
 *
 * Deliberately *not* the long axis of a minimum-area bounding rectangle (longAxisOf in farmland.js): that's taken over
 * the convex hull, so on an L-shaped or crescent zone it happily returns an axis running through ground the zone doesn't
 * own. Fine for crop rows, wrong for a runway.
 *
 * Two passes, since the longest chord of a polygon usually ends on two of its corners but doesn't have to: every pair of
 * vertices, and a sweep of directions through a scattering of interior points, which catches the ones that miss every
 * corner — a chord down a long bend, say.
 *
 * @param {Vec2[]} poly
 * @returns {{a: Vec2, b: Vec2, length: number, dx: number, dz: number}|null}
 */
function longestChordIn(poly) {
  let best = null;
  const consider = chord => { if (chord && (!best || chord.length > best.length)) best = chord; };
  if (poly.length <= CHORD_MAX_VERTICES) {
    for (let i=0;i<poly.length;i++) for (let j=i+1;j<poly.length;j++) {
      const a = poly[i], b = poly[j], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len < 1e-6) continue;
      consider(chordThrough(poly, { x:(a.x+b.x)/2, z:(a.z+b.z)/2 }, (b.x-a.x)/len, (b.z-a.z)/len));
    }
  }
  seedPoints(poly).forEach(seed => {
    for (let k=0;k<CHORD_ANGLES;k++) {
      const angle = k*Math.PI/CHORD_ANGLES;
      consider(chordThrough(poly, seed, Math.cos(angle), Math.sin(angle)));
    }
  });
  return best;
}
/**
 * The runway the zone can hold, and so what kind of airfield it is.
 *
 * The ground searched is the zone with the roads and the zones above it taken out as hole-free pieces, each then shrunk
 * by half the tier's runway width — a chord of the shrunk piece is the centreline of a full-width strip inside the real
 * one. Tiers are tried widest first, so a zone that could hold an international runway is never given a regional one.
 *
 * @returns {{tier: object, chord: object}|null} null when not even a helipad fits.
 */
function findRunway(poly, blockers) {
  const pieces = App.cutLotByCutouts(poly, blockers).pieces.filter(p => p.length >= 3);
  for (const tier of TIERS) {
    let best = null;
    pieces.forEach(piece => App.insetPolygonExact(piece, tier.width/2).forEach(region => {
      if (region.length < 3 || Math.abs(polygonArea(region)) < 1) return;
      const chord = longestChordIn(cleanPolygon(region));
      if (chord && (!best || chord.length > best.length)) best = chord;
    }));
    if (best && best.length >= tier.minLength) return { tier, chord: best };
  }
  return null;
}

// ---- ground markings
// a flat painted rectangle centered on (cx, cz), `halfLen` along (dx, dz) and `halfWid` across it
function paintRect(marks, cx, cz, dx, dz, halfLen, halfWid) {
  const ax = dx*halfLen, az = dz*halfLen, bx = -dz*halfWid, bz = dx*halfWid;
  marks.addQuad({ x: cx-ax-bx, y: Y_MARK, z: cz-az-bz }, { x: cx+ax-bx, y: Y_MARK, z: cz+az-bz },
                { x: cx+ax+bx, y: Y_MARK, z: cz+az+bz }, { x: cx-ax+bx, y: Y_MARK, z: cz-az+bz }, UP);
}
// Runway numerals really are drawn as a few blocky bars, so a seven-segment digit is close to the right shape: the strokes
// each digit uses, where `I` is the single bar down the middle that makes a 1 (rather than two bars off to the right).
const DIGIT_STROKES = { 0:'abcdef', 1:'I', 2:'abged', 3:'abgcd', 4:'fgbc', 5:'afgcd', 6:'afgedc', 7:'abc', 8:'abcdefg', 9:'afgbcd' };
// where each stroke sits in a digit's own frame: [up (-1 bottom to +1 top), right (-1..1), horizontal?, how many half-heights tall]
const STROKES = {
  a:[1, 0, true], g:[0, 0, true], d:[-1, 0, true],
  f:[0.5, -1, false, 1], b:[0.5, 1, false, 1], e:[-0.5, -1, false, 1], c:[-0.5, 1, false, 1], I:[0, 0, false, 2],
};
// A digit painted flat on the ground at (cx, cz), `h` and `w` its half-height and half-width, reading along (ux, uz) —
// the direction a pilot rolling over it is heading, so the number is the right way up on the take-off run.
function paintDigit(marks, digit, cx, cz, ux, uz, h, w, stroke) {
  const rx = -uz, rz = ux; // the digit's own right, seen from above with (ux, uz) as its up
  (DIGIT_STROKES[digit] || '').split('').forEach(key => {
    const [u, r, horizontal, span] = STROKES[key];
    const x = cx + ux*u*h + rx*r*w, z = cz + uz*u*h + rz*r*w;
    if (horizontal) paintRect(marks, x, z, rx, rz, w + stroke/2, stroke/2);
    else paintRect(marks, x, z, ux, uz, h*span/2 + stroke/2, stroke/2);
  });
}
// a two-digit number, its digits side by side across the direction it reads in
function paintNumber(marks, value, cx, cz, ux, uz, h, w, stroke) {
  const rx = -uz, rz = ux, digits = String(value).padStart(2, '0').split(''), pitch = w*2.9;
  digits.forEach((digit, i) => {
    const off = (i - (digits.length-1)/2)*pitch;
    paintDigit(marks, digit, cx + rx*off, cz + rz*off, ux, uz, h, w, stroke);
  });
}
/**
 * The number painted at a runway's end: the compass heading of the take-off run from it, in tens of degrees, with world
 * north along -Z (see day-night.js). Due north reads 36, due east 09.
 * @param {number} dx Unit direction of the take-off run.
 * @param {number} dz
 * @returns {number} 1..36
 */
function runwayNumber(dx, dz) {
  const tens = Math.round((((Math.atan2(dx, -dz)*180/Math.PI) % 360) + 360) % 360/10) % 36;
  return tens === 0 ? 36 : tens;
}

// ---- the runway's own frame
// Everything on an airport is laid out along the runway and across it, so the whole build works in the runway's frame:
// `s` runs along it from the middle, `w` across it (positive toward whichever side the terminal is on). `at(s, w)` puts
// a point back into the world.
function runwayFrame(chord) {
  const center = { x: (chord.a.x + chord.b.x)/2, z: (chord.a.z + chord.b.z)/2 };
  const dx = chord.dx, dz = chord.dz, nx = -dz, nz = dx;
  return { center, dx, dz, nx, nz, halfLength: chord.length/2,
    at: (s, w) => ({ x: center.x + dx*s + nx*w, z: center.z + dz*s + nz*w }) };
}
// the four corners of a rectangle given in the runway's frame, as a polygon
function frameRect(frame, box) {
  return [[1,-1], [1,1], [-1,1], [-1,-1]].map(([u, v]) => frame.at(box.s + u*box.halfLen, box.w + v*box.halfWid));
}
// whether all of a rectangle in the runway's frame stands on ground the airport actually owns
function frameRectInside(frame, inside, box) {
  for (let i=0;i<=4;i++) for (let j=0;j<=2;j++) {
    const p = frame.at(box.s + (i/2 - 1)*box.halfLen, box.w + (j - 1)*box.halfWid);
    if (!inside(p.x, p.z)) return false;
  }
  return true;
}
/**
 * Fit a rectangle beside the runway: the wanted one if it stands clear, else the same shape shrunk a little and drawn in
 * toward the runway, and so on. The same easing a suburb house does to get itself onto its plot — which is what lets a
 * zone with a runway but not much room beside it still have a terminal, just a smaller one with less apron.
 *
 * @param {object} want `nearW` is as close to the runway as it may be drawn; left out, it doesn't move at all.
 * @returns {{s: number, w: number, halfLen: number, halfWid: number}|null} null if it never fits.
 */
function fitInFrame(frame, inside, want) {
  const nearW = want.nearW != null ? want.nearW : want.w;
  for (let k=0;k<FIT_TRIES;k++) {
    const shrink = 1 - k*0.1;
    for (let pull=0;pull<=FIT_TRIES;pull++) {
      const box = { s: want.s, w: lerp(want.w, nearW, pull/FIT_TRIES), halfLen: want.halfLen*shrink, halfWid: want.halfWid*shrink };
      if (frameRectInside(frame, inside, box)) return box;
    }
  }
  return null;
}
// A paved slab over `poly`, kept inside `limit` (Clipper paths) so no corner of it spills onto a road or out of the zone.
function pave(builder, poly, limit) {
  const tree = clipPolygons(ClipperLib.ClipType.ctIntersection, [App.toClipperPath(poly)], limit, true);
  builder.addTops(tree, Y_TARMAC);
  forEachPolyTreeEdge(tree, (p, q, outward) => builder.addWall(p, q, Y_ZONE_GROUND, Y_TARMAC, outward));
}

// ---- aircraft
/**
 * An airliner built along its own +Z, wheels on y = 0, so placing one is a position and a heading. `span` is wing tip to
 * wing tip and everything else is in proportion to it; a propeller aircraft (the light one on a grass strip) goes
 * without the underwing engines.
 */
function buildAircraft(span, rng, jet) {
  const group = new THREE.Group();
  group.name = 'Aircraft';
  const L = span*1.08, r = span*0.055, ride = r*1.9; // how high the belly sits on its gear
  const white = new THREE.MeshStandardMaterial({ color: 0xeceff2, roughness: 0.45, metalness: 0.15 });
  const livery = new THREE.MeshStandardMaterial({ color: AIRLINE_COLORS[Math.floor(rng()*AIRLINE_COLORS.length)], roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.35, metalness: 0.2 });
  const add = (geo, mat, x, y, z, yaw) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (yaw) m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };
  // fuselage: a barrel along +Z, a cone for a nose and a longer, slightly raised one for the tail
  add(new THREE.CylinderGeometry(r, r, L*0.66, 14).rotateX(Math.PI/2), white, 0, ride, 0);
  add(new THREE.ConeGeometry(r, L*0.2, 14).rotateX(Math.PI/2), white, 0, ride, L*0.42);
  add(new THREE.ConeGeometry(r, L*0.3, 14).rotateX(-Math.PI/2), white, 0, ride + r*0.35, -L*0.47);
  add(new THREE.BoxGeometry(r*1.9, r*0.5, L*0.44), dark, 0, ride + r*0.45, L*0.04); // the window line, dark from above
  // wings, each swept back from the root
  const sweep = 0.3;
  [1, -1].forEach(side => {
    add(new THREE.BoxGeometry(span*0.46, r*0.3, L*0.19), white, side*span*0.25, ride - r*0.35, -L*0.05, -side*sweep);
    if (jet) add(new THREE.CylinderGeometry(r*0.6, r*0.6, L*0.13, 12).rotateX(Math.PI/2), dark, side*span*0.27, ride - r*0.85, L*0.03);
  });
  // tailplane and fin, the fin in the airline's colour
  [1, -1].forEach(side => add(new THREE.BoxGeometry(span*0.17, r*0.24, L*0.11), white, side*span*0.1, ride + r*0.5, -L*0.45, -side*sweep));
  add(new THREE.BoxGeometry(r*0.3, span*0.17, L*0.17), livery, 0, ride + r*0.5 + span*0.085, -L*0.45);
  if (!jet) add(new THREE.CylinderGeometry(r*0.08, r*0.08, span*0.34, 8).rotateZ(Math.PI/2), dark, 0, ride + r*0.2, L*0.5);
  return group;
}
/**
 * A helicopter, built the same way — along +Z, skids on y = 0. Its rotors come back on the group so the caller can spin
 * them; everything else about it is one static lump.
 */
function buildHelicopter(span, rng) {
  const group = new THREE.Group();
  group.name = 'Helicopter';
  const r = span*0.16, livery = new THREE.MeshStandardMaterial({ color: AIRLINE_COLORS[Math.floor(rng()*AIRLINE_COLORS.length)], roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.35, metalness: 0.2 });
  const add = (geo, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    (parent || group).add(m);
    return m;
  };
  const ride = r*1.4;
  add(new THREE.SphereGeometry(r, 14, 10).scale(0.85, 0.85, 1.5), livery, 0, ride, r*0.3);
  add(new THREE.CylinderGeometry(r*0.22, r*0.16, span*0.5, 10).rotateX(Math.PI/2), livery, 0, ride + r*0.25, -span*0.33);
  add(new THREE.SphereGeometry(r*0.72, 12, 9).scale(0.9, 0.85, 1.1), dark, 0, ride + r*0.1, r*1.05); // the glazed nose
  [1, -1].forEach(side => {
    add(new THREE.CylinderGeometry(r*0.07, r*0.07, span*0.44, 8).rotateX(Math.PI/2), dark, side*r*0.6, 0, r*0.2);
    add(new THREE.CylinderGeometry(r*0.06, r*0.06, ride, 6), dark, side*r*0.6, ride/2, r*0.2);
  });
  const mast = new THREE.Group();
  mast.position.set(0, ride + r*0.95, r*0.1);
  group.add(mast);
  [0, Math.PI/2].forEach(a => { const blade = add(new THREE.BoxGeometry(span, r*0.05, r*0.2), dark, 0, 0, 0, mast); blade.rotation.y = a; });
  const tailRotor = new THREE.Group();
  tailRotor.position.set(r*0.2, ride + r*0.35, -span*0.55);
  group.add(tailRotor);
  [0, Math.PI/2].forEach(a => { const blade = add(new THREE.BoxGeometry(r*0.05, span*0.28, r*0.12), dark, 0, 0, 0, tailRotor); blade.rotation.z = a; });
  group.userData.rotors = [{ object: mast, axis: 'y', speed: 9 }, { object: tailRotor, axis: 'z', speed: 22 }];
  return group;
}
// Points an aircraft along a heading, nose up by `pitch`. Built along +Z, so the yaw is measured from +Z, and a positive
// rotation about its own X would put the nose down — hence the minus.
function poseAircraft(object, x, y, z, dx, dz, pitch) {
  object.position.set(x, y, z);
  object.rotation.order = 'YXZ';
  object.rotation.set(-(pitch || 0), Math.atan2(dx, dz), 0);
}
// how far along `path` (a polyline of {x,z}) a distance lands, and which way it's heading there
function alongPath(path, distance) {
  let left = Math.max(0, distance);
  for (let i=0;i<path.length-1;i++) {
    const a = path[i], b = path[i+1], len = Math.hypot(b.x-a.x, b.z-a.z);
    if (len < 1e-6) continue;
    if (left <= len || i === path.length-2) {
      const t = Math.min(1, left/len);
      return { x: a.x + (b.x-a.x)*t, z: a.z + (b.z-a.z)*t, dx: (b.x-a.x)/len, dz: (b.z-a.z)/len };
    }
    left -= len;
  }
  const end = path[path.length-1];
  return { x: end.x, z: end.z, dx: 1, dz: 0 };
}
const TAXI_SPEED = 11, HOLD_TIME = 3.5, ROLL_TIME = 7, CLIMB_TIME = 10, AWAY_TIME = 7;
/**
 * The one departure, going round and round: the plane taxis out from its stand, holds at the threshold, lines up, rolls,
 * rotates about three-quarters of the way down and climbs away — then a few seconds later it's back on stand doing it
 * again. Its place in the cycle comes straight from the clock, the way a train shuttle's does, so nothing restarts when
 * the zone is rebuilt.
 *
 * @param {THREE.Group} plane
 * @param {Vec2[]} taxiPath From the stand to the threshold.
 * @param {object} frame The runway's frame.
 * @param {number} from Where along the runway the roll starts, in the frame's `s`.
 * @returns {(t: number) => void}
 */
function makeDeparture(plane, taxiPath, frame, from) {
  let taxiLength = 0;
  for (let i=0;i<taxiPath.length-1;i++) taxiLength += Math.hypot(taxiPath[i+1].x - taxiPath[i].x, taxiPath[i+1].z - taxiPath[i].z);
  const taxiTime = Math.max(2, taxiLength/TAXI_SPEED);
  const cycle = taxiTime + HOLD_TIME + ROLL_TIME + CLIMB_TIME + AWAY_TIME;
  const runLength = frame.halfLength - from, liftoff = runLength*0.78;
  const { dx, dz } = frame;
  return (t) => {
    let phase = ((t % cycle) + cycle) % cycle;
    plane.visible = true;
    if (phase < taxiTime) {
      const p = alongPath(taxiPath, phase/taxiTime*taxiLength);
      poseAircraft(plane, p.x, Y_TARMAC, p.z, p.dx, p.dz, 0);
      return;
    }
    phase -= taxiTime;
    if (phase < HOLD_TIME) {
      const p = frame.at(from, 0);
      poseAircraft(plane, p.x, Y_TARMAC, p.z, dx, dz, 0);
      return;
    }
    phase -= HOLD_TIME;
    if (phase < ROLL_TIME) {
      const u = phase/ROLL_TIME, p = frame.at(from + liftoff*u*u, 0);
      // the nose comes up over the last of the roll, just before the wheels leave
      poseAircraft(plane, p.x, Y_TARMAC, p.z, dx, dz, Math.max(0, u - 0.82)/0.18*0.14);
      return;
    }
    phase -= ROLL_TIME;
    if (phase < CLIMB_TIME) {
      const u = phase/CLIMB_TIME, p = frame.at(from + liftoff + runLength*1.9*u, 0);
      poseAircraft(plane, p.x, Y_TARMAC + Math.pow(u, 1.4)*runLength*0.55, p.z, dx, dz, 0.2);
      return;
    }
    plane.visible = false;
  };
}
const HELI_IDLE = 7, HELI_LIFT = 4.5, HELI_CIRCUIT = 26, HELI_LAND = 4.5, HELI_HOVER = 55;
/**
 * The helipad's chopper: it sits on the H with its rotors turning, lifts straight off, flies one slow circuit over the
 * airfield and settles back on the pad. The circuit is a circle passing through the pad itself, so it leaves and arrives
 * pointing the same way it started.
 */
function makeCircuit(heli, pad, radius, heading) {
  const cycle = HELI_IDLE + HELI_LIFT + HELI_CIRCUIT + HELI_LAND;
  // the circle sits off to the chopper's left, so its edge runs through the pad
  const center = { x: pad.x - heading.dz*radius, z: pad.z + heading.dx*radius };
  const start = Math.atan2(pad.x - center.x, pad.z - center.z);
  return (t) => {
    heli.userData.rotors.forEach(({ object, axis, speed }) => { object.rotation[axis] = t*speed; });
    let phase = ((t % cycle) + cycle) % cycle;
    if (phase < HELI_IDLE) { poseAircraft(heli, pad.x, Y_TARMAC, pad.z, heading.dx, heading.dz, 0); return; }
    phase -= HELI_IDLE;
    if (phase < HELI_LIFT) {
      const u = phase/HELI_LIFT;
      poseAircraft(heli, pad.x, Y_TARMAC + HELI_HOVER*u*u, pad.z, heading.dx, heading.dz, 0);
      return;
    }
    phase -= HELI_LIFT;
    if (phase < HELI_CIRCUIT) {
      const angle = start + phase/HELI_CIRCUIT*Math.PI*2;
      const x = center.x + Math.sin(angle)*radius, z = center.z + Math.cos(angle)*radius;
      // nose along the tangent, and banked into the turn by leaning the whole thing over
      poseAircraft(heli, x, Y_TARMAC + HELI_HOVER, z, Math.cos(angle), -Math.sin(angle), 0);
      heli.rotation.z = -0.18;
      return;
    }
    phase -= HELI_CIRCUIT;
    const u = 1 - phase/HELI_LAND;
    poseAircraft(heli, pad.x, Y_TARMAC + HELI_HOVER*u*u, pad.z, heading.dx, heading.dz, 0);
  };
}

// ---- the buildings beside it
// A terminal: a long low block facing the apron, glazed all round, with a canopy over the forecourt and — at the biggest
// airports — a pair of piers reaching out onto the apron with stands along them.
function buildTerminal(frame, box, tier, rng) {
  const group = new THREE.Group();
  group.name = 'Building';
  group.userData.buildingKind = 'terminal'; // what its card says about it: see building-types.js
  const walls = createMeshBuilder(), roof = createMeshBuilder(), glass = createMeshBuilder();
  const { dx, dz } = frame, c = frame.at(box.s, box.w), height = tier.id === 'international' ? 15 : 10;
  const apronSide = -Math.sign(box.w || 1); // the way the apron lies from the terminal: toward the runway
  walls.addBox(c.x, c.z, dx, dz, box.halfLen, box.halfWid, Y_TARMAC, Y_TARMAC + height);
  glass.addBox(c.x, c.z, dx, dz, box.halfLen + 0.08, box.halfWid + 0.08, Y_TARMAC + height*0.28, Y_TARMAC + height*0.78);
  // a roof that oversails the walls all round, and a canopy out over where the cars pull up
  roof.addBox(c.x, c.z, dx, dz, box.halfLen + 1.4, box.halfWid + 1.4, Y_TARMAC + height, Y_TARMAC + height + 1.1);
  const forecourt = frame.at(box.s, box.w - apronSide*(box.halfWid + 3));
  roof.addBox(forecourt.x, forecourt.z, dx, dz, box.halfLen*0.55, 3, Y_TARMAC + 5.4, Y_TARMAC + 5.9);
  if (tier.piers) {
    // piers out onto the apron, with the stands down either side of them
    [-1, 1].forEach(end => {
      const pierLen = box.halfWid*1.3, at = frame.at(box.s + end*box.halfLen*0.55, box.w + apronSide*(box.halfWid + pierLen));
      walls.addBox(at.x, at.z, frame.nx, frame.nz, pierLen, 5, Y_TARMAC, Y_TARMAC + 8);
      glass.addBox(at.x, at.z, frame.nx, frame.nz, pierLen + 0.06, 5.06, Y_TARMAC + 2.4, Y_TARMAC + 6);
      roof.addBox(at.x, at.z, frame.nx, frame.nz, pierLen + 0.8, 5.8, Y_TARMAC + 8, Y_TARMAC + 8.7);
    });
  }
  [[walls, TERMINAL_WALL, 'Terminal'], [roof, TERMINAL_ROOF, 'TerminalRoof', { metalness: 0.25 }],
   [glass, TERMINAL_GLASS, 'TerminalGlass', { roughness: 0.15, metalness: 0.4 }]].forEach(([builder, color, name, opts]) => {
    const mesh = builderMesh(builder, color, name, opts);
    if (mesh) group.add(mesh);
  });
  // its corners and its height, kept on it so people can find a door on its wall and go in (see buildingDoors in
  // people.js) and so it stops being drawn when the camera's inside it (see see-through.js)
  group.userData.footprint = frameRect(frame, box);
  group.userData.height = height;
  return group;
}
// A control tower: a slim tapering shaft with a wider glazed cab on top and a red beacon that blinks all night.
function buildControlTower(at, rng) {
  const group = new THREE.Group();
  group.name = 'Building';
  group.userData.buildingKind = 'controltower';
  const height = 26 + rng()*10;
  const shaft = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.7 });
  const cab = new THREE.MeshStandardMaterial({ color: TERMINAL_GLASS, roughness: 0.15, metalness: 0.45 });
  const place = (mesh, y) => { mesh.position.set(at.x, Y_TARMAC + y, at.z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh; };
  place(new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.8, height, 14), shaft), height/2);
  place(new THREE.Mesh(new THREE.CylinderGeometry(4.2, 3.4, 4.4, 14), cab), height + 2.2);
  place(new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 0.5, 14), shaft), height + 4.6);
  const beacon = place(new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: new THREE.Color(0xff3b30), emissiveIntensity: 1 })), height + 5.4);
  beacon.userData = { isBlinkLight: true, blinkPhase: rng()*Math.PI*2 }; // picked up by refreshSceneIndex, blinked in main.js
  group.userData.footprint = [[1,1], [1,-1], [-1,-1], [-1,1]].map(([a, b]) => ({ x: at.x + a*3, z: at.z + b*3 }));
  group.userData.height = height + 5;
  return group;
}
// A hangar: a wide shallow shed with a gable roof and a big door across its front, for a grass strip.
function buildHangar(frame, box, rng) {
  const group = new THREE.Group();
  group.name = 'Building';
  group.userData.buildingKind = 'hangar';
  const walls = createMeshBuilder(), roof = createMeshBuilder(), doors = createMeshBuilder();
  const c = frame.at(box.s, box.w), { dx, dz } = frame, height = 5.5;
  walls.addBox(c.x, c.z, dx, dz, box.halfLen, box.halfWid, Y_TARMAC, Y_TARMAC + height);
  addGableRoof(roof, walls, c.x, c.z, dx, dz, box.halfLen + 0.35, box.halfWid + 0.35, Y_TARMAC + height, box.halfWid*0.4);
  const front = frame.at(box.s, box.w - Math.sign(box.w || 1)*(box.halfWid + 0.05));
  doors.addBox(front.x, front.z, dx, dz, box.halfLen*0.8, 0.08, Y_TARMAC, Y_TARMAC + height*0.82);
  [[walls, 0xb4b8bc, 'Hangar'], [roof, 0x6b7076, 'HangarRoof', { metalness: 0.3 }], [doors, 0x4a4f55, 'HangarDoors', { metalness: 0.35 }]]
    .forEach(([builder, color, name, opts]) => { const mesh = builderMesh(builder, color, name, opts); if (mesh) group.add(mesh); });
  group.userData.footprint = frameRect(frame, box);
  group.userData.height = height + box.halfWid*0.4;
  return group;
}
// A windsock: a striped cone on a pole, the one thing every airfield has however small it is.
function buildWindsock(at, rng) {
  const group = new THREE.Group();
  group.name = 'Windsock';
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 7, 8), new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.7 }));
  pole.position.set(at.x, Y_TARMAC + 3.5, at.z);
  group.add(pole);
  const angle = rng()*Math.PI*2; // whichever way the wind happens to be going
  [[0xe8732a, 0, 1.5], [0xe9e7df, 1.5, 1.2], [0xe8732a, 2.7, 1.0]].forEach(([color, from, len]) => {
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.75 - from*0.13, 0.75 - (from+len)*0.13, len, 10, 1, true),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide }));
    sock.position.set(at.x + Math.cos(angle)*(from + len/2), Y_TARMAC + 6.5, at.z + Math.sin(angle)*(from + len/2));
    sock.rotation.set(0, -angle, Math.PI/2);
    group.add(sock);
  });
  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.name = 'Windsock'; } });
  return group;
}

// ---- putting one together
/**
 * Generate an airport's contents into `zone.buildingsGroup`.
 *
 * @param {object} zone
 * @param {Vec2[]} poly The zone's tessellated outline.
 * @param {Array} cutouts Roads and the zones above it — what the ground gives way to.
 * @param {Array} blockers The cut-outs plus the paths, which lots and buildings keep off.
 * @returns {void}
 */
export function generateAirportContent(zone, poly, cutouts, blockers) {
  const { ctUnion, ctDifference } = ClipperLib.ClipType;
  const s = zone.settings, rng = mulberry32(s.seed>>>0);
  zone.doorSetback = 6; // how far back from the road the terminal's doors are (see doorReach in people.js)
  // the airfield itself is grass, with everything else paved on top of it
  const tint = resolveParkTint(zone);
  const grass = makeParkMesh(poly, tint, resolveGrassNoiseStrength(zone), cutouts);
  if (grass) zone.buildingsGroup.add(grass);
  const zonePath = [App.toClipperPath(poly)];
  const owned = blockers.length ? clipPolygons(ctDifference, zonePath, blockers) : zonePath; // ground the airport actually has
  const tarmac = createMeshBuilder(), marks = createMeshBuilder(), mown = createMeshBuilder();
  const found = findRunway(poly, blockers);

  if (!found) {
    // Nothing straight enough for even a helipad — so it's apron: the zone paved over with a grid of stand markings,
    // which still reads as airport rather than as a zone that failed to generate.
    zone.airportInfo = { tier: 'apron', label: 'Apron', length: 0 };
    App.insetPolygonExact(poly, 2).forEach(piece => {
      if (Math.abs(polygonArea(piece)) < 40) return;
      pave(tarmac, piece, owned);
      const middle = centroid(piece);
      for (let k=-4;k<=4;k++) {
        const p = { x: middle.x + k*9, z: middle.z };
        if (pointInPolygon(p, piece)) paintRect(marks, p.x, p.z, 0, 1, Math.min(12, Math.abs(polygonArea(piece))/60), 0.3);
      }
    });
    finishAirport(zone, { tarmac, marks, mown }, poly, s, tint);
    return;
  }

  const { tier, chord } = found;
  const frame = runwayFrame(chord), L = frame.halfLength, W = tier.width/2;
  const number = runwayNumber(frame.dx, frame.dz);
  zone.airportInfo = { tier: tier.id, label: tier.label, length: Math.round(chord.length),
    numbers: tier.pad ? null : `${String(number).padStart(2, '0')}/${String((number + 18 - 1)%36 + 1).padStart(2, '0')}` };

  // ---- the runway, and the strip of ground kept clear either side of it
  const strip = frameRect(frame, { s: 0, w: 0, halfLen: L, halfWid: W });
  if (tier.pad) {
    // a helipad: a square of apron with an H on it, rather than a strip
    const half = Math.min(L, tier.width/2);
    const padBox = { s: 0, w: 0, halfLen: half, halfWid: half };
    pave(tarmac, frameRect(frame, padBox), owned);
    const bar = half*0.11;
    [-1, 1].forEach(side => { const p = frame.at(0, side*half*0.3); paintRect(marks, p.x, p.z, frame.dx, frame.dz, half*0.45, bar/2); });
    paintRect(marks, frame.center.x, frame.center.z, frame.nx, frame.nz, half*0.3, bar/2);
  } else {
    // a grass strip is mown rather than paved: the same slab, in a shade of the grass around it, and no markings on it
    pave(tier.mown ? mown : tarmac, strip, owned);
    if (tier.paved) paintRunway(marks, frame, tier, number);
  }
  // what's left after the runway and its clearway: where everything else goes
  const clearway = frameRect(frame, { s: 0, w: 0, halfLen: L + tier.width*CLEARWAY, halfWid: W*(1 + CLEARWAY*2) });
  const taken = clipPolygons(ctUnion, blockers, [App.toClipperPath(clearway)]);
  const free = clipPolygons(ctDifference, zonePath, taken);
  const inside = App.createRegionTester(free.length ? App.offsetPaths(free, -1.5, ClipperLib.JoinType.jtMiter) : []);

  // ---- which side of the runway the buildings go, which is whichever side the nearest road is on
  const streets = streetSegmentsNear(poly);
  const street = streetFor(frame.center, streets);
  const side = street ? Math.sign((street.x - frame.center.x)*frame.nx + (street.z - frame.center.z)*frame.nz) || 1 : 1;
  // the terminal has its forecourt out toward the road and its apron in toward the runway, which is how a real one sits
  // and — because the road comes at the airport from outside — puts the two the right way round at once

  let stand = null, taxiFrom = null;
  if (tier.terminal && s.airportTerminal !== false) {
    const taxiW = side*(W + tier.width*CLEARWAY + 9);
    const apronMid = taxiW + side*(9 + tier.apron/2);
    const want = { s: 0, w: apronMid + side*(tier.apron/2 + tier.terminal/2),
      nearW: taxiW + side*(9 + tier.width*0.5 + tier.terminal/2), // as close in as it can come and still leave an apron
      halfLen: Math.min(L*0.5, tier.id === 'international' ? 75 : 38), halfWid: tier.terminal/2 };
    const box = fitInFrame(frame, inside, want);
    if (box) {
      // the taxiway, the apron in front of the terminal, and the terminal itself
      const apronBox = { s: box.s, w: (box.w - side*box.halfWid + taxiW)/2, halfLen: box.halfLen*1.15, halfWid: Math.abs(box.w - side*box.halfWid - taxiW)/2 };
      pave(tarmac, frameRect(frame, { s: 0, w: taxiW, halfLen: L*0.88, halfWid: 9 }), free);
      pave(tarmac, frameRect(frame, apronBox), free);
      zone.buildingsGroup.add(buildTerminal(frame, box, tier, rng));
      if (tier.tower && s.airportTower !== false) {
        const towerAt = frame.at(box.s + box.halfLen + 9, box.w - side*box.halfWid*0.4);
        if (inside(towerAt.x, towerAt.z)) zone.buildingsGroup.add(buildControlTower(towerAt, rng));
      }
      // a car park out on the forecourt side, with its bays painted on
      const parkBox = fitInFrame(frame, inside, { s: box.s, w: box.w + side*(box.halfWid + 4 + tier.terminal*0.7), halfLen: box.halfLen*0.8, halfWid: tier.terminal*0.7 });
      if (parkBox) {
        pave(tarmac, frameRect(frame, parkBox), free);
        for (let bay = -Math.floor(parkBox.halfLen/3); bay <= Math.floor(parkBox.halfLen/3); bay++) {
          const p = frame.at(parkBox.s + bay*3, parkBox.w);
          paintRect(marks, p.x, p.z, frame.nx, frame.nz, parkBox.halfWid*0.85, 0.12);
        }
      }
      // the stands: spread evenly along the apron, nose in to the terminal. The first is the one the departure pushes
      // back off, and the rest have an aircraft sitting on them.
      const stands = tier.stands || 1, standW = box.w - side*(box.halfWid + tier.width*0.45);
      const standS = k => box.s + ((k + 0.5)/stands - 0.5)*box.halfLen*1.8;
      stand = { s: standS(0), w: standW };
      taxiFrom = taxiW;
      if (s.airportAircraft !== false) {
        for (let k=1;k<stands;k++) {
          const at = frame.at(standS(k), standW);
          if (!inside(at.x, at.z)) continue;
          const parked = buildAircraft(tier.width*0.8, rng, true);
          poseAircraft(parked, at.x, Y_TARMAC, at.z, -side*frame.nx, -side*frame.nz, 0);
          zone.buildingsGroup.add(parked);
        }
      }
    }
  }
  if (tier.hangars && s.airportTerminal !== false) {
    // a grass strip gets a pair of hangars beside it instead, and light aircraft parked on the grass
    [-1, 1].forEach(end => {
      const want = { s: end*L*0.32, w: side*(W + tier.width*CLEARWAY + 13), nearW: side*(W + tier.width*CLEARWAY + 9), halfLen: 11, halfWid: 7 };
      const box = fitInFrame(frame, inside, want);
      if (!box) return;
      pave(tarmac, frameRect(frame, { ...box, halfLen: box.halfLen*1.2, halfWid: box.halfWid*1.9 }), free);
      zone.buildingsGroup.add(buildHangar(frame, box, rng));
      if (!stand) { stand = { s: box.s, w: box.w - side*box.halfWid*2.4 }; taxiFrom = box.w - side*box.halfWid*2.4; }
    });
  }

  // ---- the aircraft that actually moves, which is the most alive thing on the zone
  zone.airportAnim = null;
  if (s.airportAircraft !== false) {
    if (tier.pad) {
      const heli = buildHelicopter(tier.width*0.55, rng);
      zone.buildingsGroup.add(heli);
      const extent = Math.max(L*2, 60);
      zone.airportAnim = makeCircuit(heli, frame.center, extent*0.7, { dx: frame.dx, dz: frame.dz });
    } else {
      const jet = tier.id !== 'airstrip';
      const plane = buildAircraft(tier.width*0.8, rng, jet);
      zone.buildingsGroup.add(plane);
      // out from the stand, onto the taxiway, down to the threshold and round onto the runway
      const holdShort = -L + tier.width*0.35;
      const lane = taxiFrom != null ? taxiFrom : side*(W + tier.width*CLEARWAY + 6);
      const from = stand || { s: L*0.2, w: lane };
      const taxiPath = [frame.at(from.s, from.w), frame.at(from.s, lane), frame.at(holdShort + tier.width*0.9, lane), frame.at(holdShort, 0)];
      zone.airportAnim = makeDeparture(plane, taxiPath, frame, holdShort);
    }
    zone.airportAnim(0); // posed once where it stands, so a zone that's never updated (a carousel thumbnail) still shows it
  }
  // a windsock, somewhere beside the strip, and the perimeter fence
  const sockAt = frame.at(-L*0.55, -side*(W + tier.width*CLEARWAY + 5));
  if (inside(sockAt.x, sockAt.z)) zone.buildingsGroup.add(buildWindsock(sockAt, rng));
  finishAirport(zone, { tarmac, marks, mown }, poly, s, tint);
}
// The centreline dashes, threshold bars, edge lines and runway numbers. Real runway markings, at the sizes a runway this
// long would really use them.
function paintRunway(marks, frame, tier, number) {
  const L = frame.halfLength, W = tier.width/2, { dx, dz } = frame;
  const stroke = Math.max(0.55, tier.width*0.025);
  // centreline dashes, stopping short of each threshold
  const dash = Math.min(14, L*0.14), period = dash*1.7, endGap = tier.width*1.7;
  for (let from = -L + endGap; from + dash < L - endGap; from += period) {
    const p = frame.at(from + dash/2, 0);
    paintRect(marks, p.x, p.z, dx, dz, dash/2, stroke*0.55);
  }
  // an edge line down each side
  [1, -1].forEach(side => {
    const p = frame.at(0, side*(W - stroke));
    paintRect(marks, p.x, p.z, dx, dz, L - 0.5, stroke*0.45);
  });
  const bars = Math.max(2, Math.round(tier.width/7)*2), barLen = Math.min(20, L*0.15), barWid = tier.width/(bars*2.4);
  const numberH = Math.min(11, tier.width*0.3), numberW = numberH*0.48;
  [1, -1].forEach(end => {
    // the piano keys you touch down over
    for (let k=0;k<bars;k++) {
      const p = frame.at(end*(L - tier.width*0.22 - barLen/2), (k - (bars-1)/2)*(tier.width/(bars + 0.6)));
      paintRect(marks, p.x, p.z, dx, dz, barLen/2, barWid/2);
    }
    // and the number, reading the way a pilot rolling from this end is heading — which is toward the other one
    const runNumber = end > 0 ? (number + 18 - 1)%36 + 1 : number;
    const at = frame.at(end*(L - tier.width*0.22 - barLen - numberH*1.4), 0);
    paintNumber(marks, runNumber, at.x, at.z, -end*dx, -end*dz, numberH, numberW, stroke*1.6);
    // aiming-point bars, a third of the way in, on the biggest runways only
    if (tier.id !== 'international') return;
    [1, -1].forEach(side => {
      const p = frame.at(end*L*0.36, side*W*0.4);
      paintRect(marks, p.x, p.z, dx, dz, Math.min(22, L*0.1), tier.width*0.055);
    });
  });
}
// The tarmac and its markings as meshes, plus the perimeter fence; shared by both the runway path and the apron fallback.
function finishAirport(zone, builders, poly, s, tint) {
  // All three are biased forward of the grass, which is itself biased forward of the ground: a few centimetres of height
  // isn't enough to settle them from a camera this far up.
  [[builders.mown, new THREE.Color(tint).multiplyScalar(MOWN_SHADE), 'MownStrip', 1, -4], [builders.tarmac, TARMAC_COLOR, 'Tarmac', 0.95, -4],
   [builders.marks, MARKING_COLOR, 'RunwayMarkings', 0.8, -7]].forEach(([builder, color, name, roughness, bias]) => {
    const mesh = builderMesh(builder, color, name, { roughness, polygonOffset: true, polygonOffsetFactor: bias, polygonOffsetUnits: bias });
    if (!mesh) return;
    mesh.castShadow = false;
    zone.buildingsGroup.add(mesh);
  });
  if (poly && s.airportFence !== false) {
    const fence = buildRailingMesh(App.zoneFenceLines(zone, poly, 1.5), Y_PARK, FIELD_FENCE_STYLE, 'PerimeterFence');
    if (fence) zone.buildingsGroup.add(fence);
  }
}
/**
 * Runs every frame: moves whatever's flying at each airport. Each zone's aircraft reads its place in its cycle straight
 * off the clock, so rebuilding a zone — or the one next to it — doesn't restart anything.
 * @param {number} t Seconds.
 * @returns {void}
 */
export function updateAirports(t) {
  S.zones.forEach(zone => { if (zone.airportAnim) zone.airportAnim(t); });
}

Object.assign(App, { generateAirportContent, longestChordIn, runwayNumber });
