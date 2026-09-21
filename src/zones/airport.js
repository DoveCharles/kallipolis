import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { Y_ZONE_GROUND, Y_PARK, camera } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { startFlying, endFlying } from '../life/possession.js';
import { explodeCar } from '../life/giblets.js';
import { stepFlight, autopilot, makeHand, cruiseSpeed, chaseBehind, touchdownBounce } from '../life/flight.js';
import { mulberry32, lerp, polygonArea, pointInPolygon, centroid } from '../core/math.js';
import { resolveParkTint, resolveGrassNoiseStrength } from '../core/splines.js';
import { CLIPPER_SCALE, clipPolygons, createMeshBuilder, forEachPolyTreeEdge } from '../roads/roads.js';
import { makeParkMesh } from './surface-detail.js';
import { builderMesh, addGableRoof } from './farmland.js';
import { buildRailingMesh } from './fences.js';
import { streetSegmentsNear, streetFor } from './suburbs.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';

// ---------------------------------------------------------- the aircraft card
// Which aircraft the camera's following, in the shared card at the bottom right (ui/entity-card.js) like the train's: its
// name and mood, a picture of it, and what it loves and hates — from assets/planes.txt, read the same way as the trains'
// and the vehicles' files (see core/type-text.js). Clicking the picture takes the controls off it, the way clicking a
// car's picture gets you behind the wheel. No Kill button: there's nothing in here to blow up.
const planes = loadTypeText('assets/planes.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'], // can have several per aircraft, like people: see [distribution] in planes.txt
  // this stands in until planes.txt has loaded, or if it can't be
  placeholder: { default: { name: ['Flight'], mood: ['✈️'], loves: ['A tailwind'], hates: ['Holding'] } },
});
const planeCard = makeCard({
  id: 'plane-card',
  title: 'Aircraft',
  onClose: () => App.stopFollowingPlane(),
  // the picture itself: at the controls (see "the flying itself" below)
  thumb: { title: 'Fly it', onClick: () => App.flyPlane() },
  labels: { occupants: 'Passengers' },
});
const drawPlaneThumbnail = makeThumbnailDrawer(planeCard.canvas);

// `info.number` is the aircraft's place among all of them and `info.view` its picture (see planeThumbnailOf below)
function showPlaneCard(info) {
  const type = planes.of(null, info.number);
  planeCard.show({ ...type, name: type.name + ' #' + info.number });
  drawPlaneThumbnail(info.view);
}
function hidePlaneCard() {
  planeCard.hide();
}

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
// The aeroplane is a custom model (assets/models/Plane.glb, made in Blender): a twin jet, modelled nose-first along its
// own -Z with its wheels on y = 0, and carrying three shape keys — `Wheels`, `RightWing` and `LeftWing` — which are
// everything about it that moves (see "the moving parts" below). It's loaded once at startup into a template every
// aircraft is cloned from, sharing its geometry and its materials; until it's ready, or if it can't load, aircraft are
// the built-in box airliner.
//
// A clone is the one thing that has to be done rather than instanced: each aeroplane works its own control surfaces, and
// morph influences live on the mesh, not on the geometry.
const PLANE_MODEL_URL = 'assets/models/Plane.glb';
const PLANE_PAINT = ['Col1', 'Col2'];  // the two materials an airline paints — its body and its trim; the rest of the
                                       // model (tyres, glass, lights) is its own
const PLANE_WHITE = 0xeceff2;          // the bare fuselage white most of them wear, the same one the box airliner has
let planeModel = null;                 // { root, span, middle, floor, paint }
const liveries = new Map();            // one repainted material per material and colour, shared by every aircraft wearing it
export async function loadPlaneModel() {
  let gltf;
  try {
    const buffer = await fetch(PLANE_MODEL_URL).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.arrayBuffer(); });
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch (err) {
    console.warn('Blockout: the aeroplane model failed to load; aircraft use the built-in box airliner', err);
    return;
  }
  gltf.scene.updateMatrixWorld(true);
  const paint = new Map();
  gltf.scene.traverse(o => { if (o.isMesh && o.material && PLANE_PAINT.includes(o.material.name)) paint.set(o.material.name, o.material); });
  const box = restingBox(gltf.scene), size = box.getSize(new THREE.Vector3());
  if (!(size.x > 0)) { console.warn('Blockout: the aeroplane model is empty; aircraft use the built-in box airliner'); return; }
  planeModel = { root: gltf.scene, span: size.x, middle: box.getCenter(new THREE.Vector3()), floor: box.min.y, paint };
  S.zones.forEach(zone => { if (zone.zoneType === 'airport') App.subdivideZone(zone); });
}
// How big the aeroplane is with its shape keys wound off — which is not what Box3.setFromObject would say, because a
// mesh's bounds cover its morph targets at full deflection as well as its own vertices. Measured that way the model has a
// floor half a wingspan-percent below its wheels, somewhere a shape key reaches and it never rests, and standing it on
// that floor leaves it hovering. So the vertices are walked directly and the keys left out of it.
function restingBox(root) {
  const box = new THREE.Box3(), point = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh) return;
    const position = o.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) box.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld));
  });
  return box;
}
// One of the model's painted materials in one of the airline colours: the model's own, repainted, so it keeps whatever
// else the material says about itself and only changes colour. Kept in a map rather than cloned per aircraft, so however
// many are flying there are only ever as many of these as there are colours on the field.
function liveryMaterial(name, color) {
  const key = `${name}|${color}`;
  let material = liveries.get(key);
  if (!material) {
    const own = planeModel.paint.get(name);
    material = own ? own.clone() : new THREE.MeshStandardMaterial({ roughness: 0.5 });
    material.color.setHex(color);
    liveries.set(key, material);
  }
  return material;
}
/**
 * An airliner along its own +Z, wheels on y = 0, so placing one is a position and a heading — the model if it has
 * loaded, the built-in box airliner if not. `span` is wing tip to wing tip and everything else is in proportion to it.
 *
 * `userData.surfaces` is what the shape keys are worked through: `span` for the height the gear comes up at, and one
 * entry per mesh, since the model arrives as nine of them (one per material) sharing a single set of keys.
 */
function buildAircraft(span, rng, jet) {
  if (!planeModel) return buildBoxAircraft(span, rng, jet);
  const group = new THREE.Group();
  group.name = 'Aircraft';
  const model = planeModel.root.clone(true);
  const scale = span/planeModel.span;
  // centred on its own middle and stood on the ground, in the model's own terms...
  model.scale.setScalar(scale);
  model.position.set(-planeModel.middle.x*scale, -planeModel.floor*scale, -planeModel.middle.z*scale);
  // ...and then turned round as a whole, because the model flies nose-first along -Z and everything here flies along +Z
  const turn = new THREE.Group();
  turn.rotation.y = Math.PI;
  turn.add(model);
  group.add(turn);
  // its livery: a body colour, and a trim colour for the engines that isn't the same one, so every aeroplane on the field
  // is in somebody's colours rather than all of them in the model's. Two aeroplanes in three wear the white fuselage
  // most airlines actually fly, and only the trim tells them apart; the third is painted all over.
  const body = Math.floor(rng()*AIRLINE_COLORS.length);
  const trim = (body + 1 + Math.floor(rng()*(AIRLINE_COLORS.length - 1)))%AIRLINE_COLORS.length;
  const livery = {
    Col1: liveryMaterial('Col1', rng() < 2/3 ? PLANE_WHITE : AIRLINE_COLORS[body]),
    Col2: liveryMaterial('Col2', AIRLINE_COLORS[trim]),
  };
  const parts = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    // both belong to the template and are shared by every aircraft cut from it — see disposeObject
    o.userData.sharedGeometry = true; o.userData.sharedMaterial = true;
    if (o.material && livery[o.material.name]) o.material = livery[o.material.name];
    // the model is saved with a shape key or two wound on; an aeroplane starts clean and is posed from there
    if (o.morphTargetInfluences) o.morphTargetInfluences.fill(0);
    if (o.morphTargetInfluences && o.morphTargetDictionary) parts.push({ at: o.morphTargetInfluences, keys: o.morphTargetDictionary });
  });
  group.userData.span = span;
  group.userData.surfaces = { span, parts, wheels: 0, right: 0, left: 0, settled: false };
  return group;
}
/**
 * The box airliner: what an aircraft is until the model has loaded, built the same way — along its own +Z, wheels on
 * y = 0. A propeller aircraft (the light one on a grass strip) goes without the underwing engines.
 */
function buildBoxAircraft(span, rng, jet) {
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
  group.userData.span = span;
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
  group.userData.span = span;
  return group;
}
// ---- the moving parts
// Three shape keys, and between them they are everything about an aeroplane that moves: `Wheels` pulls the gear up into
// the belly at 1, and `RightWing` and `LeftWing` swing a wing's trailing edge from all the way down at -1 to all the way
// up at +1.
//
// Nothing tells this code what an aeroplane is doing. It reads the pose the aeroplane has just been put in — the one
// thing the schedule, a hand on the controls and a handback all have in common — and works the surfaces from that:
//
// - the gear comes up once it is more than a couple of wingspans off the tarmac and goes back down on the way in, so a
//   schedule that never mentions the undercarriage still raises it after take-off and lowers it on final, and so does an
//   aeroplane being flown by hand, for nothing
// - both wings together are the elevators: nose up, both trailing edges up
// - the two against each other are the ailerons: banked right, the right one up and the left one down, which is the
//   deflection that put it there — so a turn is flown with the stick over, the way it looks from outside
//
// Both are eased rather than set, so the gear takes a couple of seconds to swing and the surfaces a moment to follow the
// stick. The easing needs the length of a frame, which comes from updateAirports; until an aeroplane has been posed once
// there is nothing to ease from, so the first pose simply arrives (which is what a carousel thumbnail gets).
const GEAR_CLEARANCE = 3.5;               // wingspans above the tarmac the gear comes up at
const GEAR_RATE = 0.4;                    // of its travel a second: a gear cycle takes about two and a half
const FULL_PITCH = 0.35, FULL_BANK = 0.7; // the attitudes that put a control surface at full deflection
const SURFACE_RATE = 3;                   // of its travel a second
let frameSeconds = 0;
function workSurfaces(object, pitch, roll, height) {
  const surfaces = object.userData.surfaces;
  if (!surfaces) return; // the box airliner has no moving parts
  const hold = v => Math.max(-1, Math.min(1, v));
  const elevator = hold(pitch/FULL_PITCH), aileron = hold(roll/FULL_BANK);
  const ease = (from, to, rate) => surfaces.settled
    ? from + Math.max(-rate*frameSeconds, Math.min(rate*frameSeconds, to - from)) : to;
  surfaces.wheels = ease(surfaces.wheels, height > surfaces.span*GEAR_CLEARANCE ? 1 : 0, GEAR_RATE);
  surfaces.right = ease(surfaces.right, hold(elevator + aileron), SURFACE_RATE);
  surfaces.left = ease(surfaces.left, hold(elevator - aileron), SURFACE_RATE);
  surfaces.settled = true;
  surfaces.parts.forEach(({ at, keys }) => {
    at[keys.Wheels] = surfaces.wheels;
    at[keys.RightWing] = surfaces.right;
    at[keys.LeftWing] = surfaces.left;
  });
}
// The nose coming round. The schedule's paths turn their corners instantly — a bend in a taxiway, the 180 off the stand
// once the tug has finished with it — and an aeroplane whose yaw is simply set from one pivots on the spot, which is the
// one thing on the field that looks like a model being moved by hand rather than an aeroplane taxiing. So the yaw is
// walked toward whatever it has been asked for instead of set to it, at a rate faster than anything here ever turns
// under its own flying (a full-bank turn comes round at about 1.9 radians a second) — which leaves a hand-flown one free
// to turn as hard as it likes and only ever catches a corner.
//
// What isn't a turn is a whole new flight: round the loop, away over the horizon and back on final at the far end of the
// field. That shows up as the aeroplane having moved further between two poses than it could possibly have flown, and
// that one simply arrives, the way the first pose of all does.
const TURN_RATE = 2.2, TURN_JUMP = 2; // radians a second, and the wingspans between poses past which it is somewhere else
function turnTo(object, dx, dz, moved) {
  const goal = Math.atan2(dx, dz);
  if (!frameSeconds || moved > (object.userData.span || 0)*TURN_JUMP) return goal;
  const turn = Math.atan2(Math.sin(goal - object.rotation.y), Math.cos(goal - object.rotation.y)); // (the short way round)
  return object.rotation.y + Math.max(-TURN_RATE*frameSeconds, Math.min(TURN_RATE*frameSeconds, turn));
}
// Points an aircraft along a heading, nose up by `pitch` and leaning by `roll`, and works its shape keys to match. Built
// along +Z, so the yaw is measured from +Z, and a positive rotation about its own X would put the nose down — hence the
// minus. The order matters: YXZ rolls it about its own length first, then pitches and yaws that, which is how a wing
// drops rather than a whole aeroplane sliding sideways. A positive `roll` drops the right wing. Nothing on the schedule
// ever banks — only a hand on the controls does (see flyByHand).
function poseAircraft(object, x, y, z, dx, dz, pitch, roll) {
  const was = object.userData.posedAt;
  const moved = was ? Math.hypot(x - was.x, y - was.y, z - was.z) : Infinity;
  object.position.set(x, y, z);
  object.rotation.order = 'YXZ';
  object.rotation.set(-(pitch || 0), turnTo(object, dx, dz, moved), roll || 0);
  if (was) was.set(x, y, z); else object.userData.posedAt = new THREE.Vector3(x, y, z);
  workSurfaces(object, pitch || 0, roll || 0, y - Y_TARMAC);
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
function pathLength(path) {
  let total = 0;
  for (let i=0;i<path.length-1;i++) total += Math.hypot(path[i+1].x - path[i].x, path[i+1].z - path[i].z);
  return total;
}
// The height of an arc (0 to 1 over w = 0 to 1) that rises slowly off the ground and ever more steeply toward the top, and
// its slope
const RISE_STEEPNESS = 3.2;
const rise = w => (Math.exp(RISE_STEEPNESS*w) - 1)/(Math.exp(RISE_STEEPNESS) - 1);
const riseSlope = w => RISE_STEEPNESS*Math.exp(RISE_STEEPNESS*w)/(Math.exp(RISE_STEEPNESS) - 1);
const smooth = u => { const s = Math.max(0, Math.min(1, u)); return s*s*(3 - 2*s); };
const fades = new WeakMap(); // aircraft -> { alpha, materials: its own copies, with what they were before fading }
/**
 * How opaque an aircraft is, from 1 (solid) down to 0. The first time one fades it is given copies of its materials, since
 * the ones it comes with are shared by every aircraft in the same colours.
 * @param {THREE.Object3D} plane
 * @param {number} alpha
 * @returns {void}
 */
function fadeAircraft(plane, alpha) {
  let state = fades.get(plane);
  if (!state) { state = { alpha: 1, materials: null }; fades.set(plane, state); }
  if (alpha === state.alpha) return;
  if (!state.materials) {
    const copies = new Map();
    state.materials = [];
    const own = material => {
      if (!copies.has(material)) {
        const copy = material.clone();
        copies.set(material, copy);
        state.materials.push({ material: copy, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
      }
      return copies.get(material);
    };
    plane.traverse(o => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
      o.userData.sharedMaterial = false; // (these are its own now, to be disposed with it)
    });
  }
  state.alpha = alpha;
  state.materials.forEach(({ material, opacity, transparent, depthWrite }) => {
    const wasTransparent = material.transparent;
    material.opacity = opacity*alpha;
    material.transparent = transparent || alpha < 1;
    material.depthWrite = alpha < 1 ? false : depthWrite;
    if (material.transparent !== wasTransparent) material.needsUpdate = true;
  });
}
const TAXI_SPEED = 11, HOLD_TIME = 3.5, ROLL_TIME = 7, CLIMB_TIME = 10, AWAY_TIME = 5;
const LIFTOFF_PITCH = 0.14, CLIMB_PITCH = 0.2, CLIMB_ROTATE_TIME = 1.2; // nose up as the wheels leave, nose up in the climb, and the seconds between
// Past the top of its climb a departure carries on up into the cloud, fading out over CLIMB_OUT_TIME, and an arrival
// comes back out of it, fading in over the first APPROACH_FADE of its approach; the cloud base is CLOUD_HEIGHT times the
// height the climb reached.
// Touching down: the nose is FLARE_PITCH up as the wheels meet the runway and comes down over TOUCHDOWN_SETTLE of the
// rollout, and the aircraft bounces (see touchdownBounce).
const MAX_PATH_PITCH = Math.PI/6; // (the steepest the nose points on a climb or dive, however steep the path: 30 degrees)
const FLARE_PITCH = 0.13, TOUCHDOWN_SETTLE = 0.3;
const CLIMB_OUT_TIME = 9, APPROACH_FADE = 0.4, CLOUD_HEIGHT = 5;
const APPROACH_TIME = 12, ROLLOUT_TIME = 6, PUSH_TIME = 5, DWELL_MIN = 12, RUNWAY_GAP = 6;
/**
 * How long one aircraft's round of the field takes, and how much of that is spent sitting on the stand.
 *
 * Two aircraft fly the same round half a cycle apart, which is what gives the field its rhythm: one lands and parks while
 * the other sits, then that one leaves, then the first one leaves, and round again. For that to work the runway has to be
 * free when each of them wants it, and it is exactly when half a cycle is longer than the two spells on the runway — the
 * arrival's and the departure's — put together. Whatever slack that leaves goes into the dwell, so a field whose taxiways
 * are short doesn't break the rhythm, it just leaves the aircraft on stand a while longer.
 *
 * @param {number} taxiInLength Turnoff to stand.
 * @param {number} taxiOutLength Stand to threshold, after the pushback.
 * @param {number} flights How many aircraft share the schedule.
 */
function flightSchedule(taxiInLength, taxiOutLength, flights) {
  const taxiIn = Math.max(1.5, taxiInLength/TAXI_SPEED), taxiOut = Math.max(2, taxiOutLength/TAXI_SPEED);
  const arriving = APPROACH_TIME + ROLLOUT_TIME, leaving = HOLD_TIME + ROLL_TIME + CLIMB_TIME + CLIMB_OUT_TIME + AWAY_TIME;
  const ground = taxiIn + PUSH_TIME + taxiOut;
  const cycle = Math.max(arriving + ground + DWELL_MIN + leaving,
    flights > 1 ? 2*(arriving + leaving + RUNWAY_GAP) : 0);
  return { cycle, taxiIn, taxiOut, dwell: cycle - arriving - ground - leaving };
}
/**
 * One aircraft's whole working round, on a loop: it comes down the glideslope, flares onto the numbers, rolls out, turns
 * off and taxis to its stand, where it sits nose in to the terminal for a while. Then the tug pushes it back onto the
 * taxiway, it taxis down to the threshold, holds, lines up, rolls, rotates and climbs away — and a moment later it's on
 * final again. Its place in the round comes straight from the clock, the way a train shuttle's does, so nothing restarts
 * when the zone is rebuilt; `offset` is all that separates one aircraft from the other.
 *
 * It lands one way down the runway and leaves the other, which is what keeps two aircraft out of each other's way. Each
 * works the end of the apron nearest the way it arrives, so it turns off the runway on its own side, taxis straight to
 * its stand and later leaves the same side — it never runs the length of the apron, and so never passes another stand.
 * That is worth more than the realism of a common runway direction: it means a field whose apron is only as wide as the
 * ground allows still works two aircraft, instead of a wing going through a parked tail.
 *
 * @param {THREE.Group} plane
 * @param {object} sched From {@link flightSchedule}.
 * @param {{in: Vec2[], push: Vec2[], out: Vec2[]}} paths Turnoff to stand, stand back onto the taxiway, taxiway to threshold.
 * @param {object} frame The runway's frame.
 * @param {{touchdown: number, turnoff: number, holdShort: number, arrive: number, leave: number}} marks Points along the
 *   runway, measured from the threshold it is using; `arrive` and `leave` are which way round that is, ±1.
 * @param {number} offset How far into the round this aircraft starts.
 * @returns {((t: number) => void) & { dockAt: (t: number) => void }} Poses the aircraft for that moment; `dockAt(t)` puts it
 *   on its stand at `t`, with the round running on from there.
 */
function makeFlight(plane, sched, paths, frame, marks, offset) {
  const { cycle, taxiIn, taxiOut, dwell } = sched;
  const { touchdown, turnoff, holdShort, arrive, leave } = marks;
  const inLength = pathLength(paths.in), pushLength = pathLength(paths.push), outLength = pathLength(paths.out);
  const onStand = paths.in[paths.in.length-1], noseIn = paths.push[0], pushTo = paths.push[1];
  // nose in to the terminal is the way it came onto the stand, which is the way the pushback goes in reverse
  const standDx = (noseIn.x - pushTo.x)/Math.max(1e-6, Math.hypot(pushTo.x - noseIn.x, pushTo.z - noseIn.z));
  const standDz = (noseIn.z - pushTo.z)/Math.max(1e-6, Math.hypot(pushTo.x - noseIn.x, pushTo.z - noseIn.z));
  const runLength = frame.halfLength - holdShort, liftoff = runLength*0.78;
  // the departure climbs away as far as the arrival came from, so the field is left and joined at the same sort of distance
  const glideRun = runLength*1.9, glideTop = runLength*0.55, cloudTop = glideTop*CLOUD_HEIGHT;
  const climbTime = CLIMB_TIME + CLIMB_OUT_TIME;
  // the nose on the approach follows the path down (and comes up in the flare); rolling out starts from where it ended
  const diveAt = v => Math.min(MAX_PATH_PITCH, Math.atan(cloudTop*riseSlope(v)/glideRun));
  // (the nose only points down while there is height to spare, so it is never into the runway)
  const approachPitch = u => 0.05 + (FLARE_PITCH - 0.05)*smooth((u - 0.8)/0.2) - 0.6*diveAt(1 - u)*smooth(cloudTop*rise(1 - u)/(plane.userData.span*0.5));
  const touchdownPitch = approachPitch(1);
  // both halves of the round are flown in the runway's own along-and-across terms, then turned whichever way round that
  // half is being flown, so one body of arithmetic serves a landing from either end
  const onRunway = (dir, s) => frame.at(dir*s, 0);
  const inDx = arrive*frame.dx, inDz = arrive*frame.dz, outDx = leave*frame.dx, outDz = leave*frame.dz;
  let shift = offset; // (where in the round the clock puts it; dockAt moves it)
  const pose = (t) => { // (returns how opaque it is, when that isn't fully)
    let phase = (((t - shift) % cycle) + cycle) % cycle;
    plane.visible = true;
    if (phase < APPROACH_TIME) {
      // out of the cloud and down the slope, steep at first and flattening over the threshold, the nose coming down to
      // follow it and then up in the flare
      const u = phase/APPROACH_TIME, p = onRunway(arrive, touchdown - glideRun*(1 - u));
      poseAircraft(plane, p.x, Y_TARMAC + cloudTop*rise(1 - u), p.z, inDx, inDz, approachPitch(u));
      return smooth(u/APPROACH_FADE);
    }
    phase -= APPROACH_TIME;
    if (phase < ROLLOUT_TIME) {
      // wheels down, nose lowering, braking hard at first and coasting the last of it to the turnoff
      const u = phase/ROLLOUT_TIME, p = onRunway(arrive, touchdown + (turnoff - touchdown)*(1 - (1 - u)*(1 - u)));
      const { hop, rock, dip } = touchdownBounce(phase, plane.userData.span);
      poseAircraft(plane, p.x, Y_TARMAC + hop, p.z, inDx, inDz, Math.max(0, touchdownPitch*(1 - smooth(u/TOUCHDOWN_SETTLE)) - dip), rock);
      return;
    }
    phase -= ROLLOUT_TIME;
    if (phase < taxiIn) {
      const p = alongPath(paths.in, phase/taxiIn*inLength);
      poseAircraft(plane, p.x, Y_TARMAC, p.z, p.dx, p.dz, 0);
      return;
    }
    phase -= taxiIn;
    if (phase < dwell) {
      poseAircraft(plane, onStand.x, Y_TARMAC, onStand.z, standDx, standDz, 0);
      return;
    }
    phase -= dwell;
    if (phase < PUSH_TIME) {
      // pushed back off the stand: it moves out to the taxiway still facing the terminal, because the tug is doing the work
      const p = alongPath(paths.push, phase/PUSH_TIME*pushLength);
      poseAircraft(plane, p.x, Y_TARMAC, p.z, -p.dx, -p.dz, 0);
      return;
    }
    phase -= PUSH_TIME;
    if (phase < taxiOut) {
      const p = alongPath(paths.out, phase/taxiOut*outLength);
      poseAircraft(plane, p.x, Y_TARMAC, p.z, p.dx, p.dz, 0);
      return;
    }
    phase -= taxiOut;
    if (phase < HOLD_TIME) {
      const p = onRunway(leave, holdShort);
      poseAircraft(plane, p.x, Y_TARMAC, p.z, outDx, outDz, 0);
      return;
    }
    phase -= HOLD_TIME;
    if (phase < ROLL_TIME) {
      const u = phase/ROLL_TIME, p = onRunway(leave, holdShort + liftoff*u*u);
      // the nose comes up over the last of the roll, just before the wheels leave
      poseAircraft(plane, p.x, Y_TARMAC, p.z, outDx, outDz, LIFTOFF_PITCH*smooth((u - 0.75)/0.25));
      return;
    }
    phase -= ROLL_TIME;
    if (phase < climbTime) {
      // up off the runway, slowly at first and ever more steeply into the cloud, fading out as it goes; the nose eases
      // from the attitude it left the ground at to the climbing one, and on up if the path steepens past it
      const w = phase/climbTime, p = onRunway(leave, holdShort + liftoff + glideRun*phase/CLIMB_TIME);
      const climb = Math.atan(cloudTop*riseSlope(w)/(glideRun*climbTime/CLIMB_TIME));
      const pitch = LIFTOFF_PITCH + (CLIMB_PITCH - LIFTOFF_PITCH)*smooth(phase/CLIMB_ROTATE_TIME);
      poseAircraft(plane, p.x, Y_TARMAC + cloudTop*rise(w), p.z, outDx, outDz, Math.max(pitch, Math.min(climb, MAX_PATH_PITCH)));
      return 1 - smooth((phase - CLIMB_TIME)/CLIMB_OUT_TIME);
    }
    plane.visible = false;
  };
  const fly = (t) => fadeAircraft(plane, pose(t) ?? 1);
  // start its round again from the moment it settles on its stand, as of time `t`
  fly.dockAt = (t) => { shift = t - (APPROACH_TIME + ROLLOUT_TIME + taxiIn); };
  // start its round again from the top of its descent, as of time `t`
  fly.descendFrom = (t) => { shift = t; };
  return fly;
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
  const roadSide = street ? Math.sign((street.x - frame.center.x)*frame.nx + (street.z - frame.center.z)*frame.nz) || 1 : 1;
  // the terminal has its forecourt out toward the road and its apron in toward the runway, which is how a real one sits
  // and — because the road comes at the airport from outside — puts the two the right way round at once. But the road
  // side is only a preference: when the room is all on the far side, or off toward one end, the buildings go there
  // instead of not at all. Mid-runway on the road side first, then sliding out along it, then the same across the runway.
  let side = roadSide;
  const spots = [roadSide, -roadSide].flatMap(sd => [0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45].map(f => ({ side: sd, s: f*L })));

  const standList = []; // every stand on the field, whether it's worked by the schedule or just sat on
  let taxiFrom = null;
  if (tier.terminal && s.airportTerminal !== false) {
    let box = null;
    for (const spot of spots) {
      const taxiW = spot.side*(W + tier.width*0.4 + 7);
      const apronMid = taxiW + spot.side*(9 + tier.apron/2);
      box = fitInFrame(frame, inside, { s: spot.s, w: apronMid + spot.side*(tier.apron/2 + tier.terminal/2),
        nearW: taxiW + spot.side*(9 + tier.width*0.5 + tier.terminal/2), // as close in as it can come and still leave an apron
        halfLen: Math.min(L*0.5, tier.id === 'international' ? 75 : 38), halfWid: tier.terminal/2 });
      if (box) { side = spot.side; break; }
    }
    const taxiW = side*(W + tier.width*0.4 + 7);
    if (box) {
      // How far the stands reach along the apron, which is not the same question as how long the terminal is: a zone
      // narrow across the runway squeezes the terminal in both directions at once, and a stubby terminal with open
      // ground either side of it should still get its second stand. So the reach is walked outward until it runs off
      // the zone, and the apron is then paved to match.
      const standW = box.w - side*(box.halfWid + tier.width*0.45);
      // and never so far that a stand ends up level with the runway end, where there would be no room to turn off beyond it
      const widest = Math.min(tier.width*3.6, Math.max(0, 2*(L - tier.width*1.8 - Math.abs(box.s))));
      const step = tier.width*0.45;
      let spread = Math.min(box.halfLen*1.8, widest);
      while (spread + step <= widest) {
        const out = spread + step, ends = [frame.at(box.s + out/2, standW), frame.at(box.s - out/2, standW)];
        if (!ends.every(p => inside(p.x, p.z))) break;
        spread = out;
      }
      // the taxiway, the apron in front of the terminal, and the terminal itself
      const apronBox = { s: box.s, w: (box.w - side*box.halfWid + taxiW)/2, halfLen: Math.max(box.halfLen*1.15, spread/2 + tier.width*0.6), halfWid: Math.abs(box.w - side*box.halfWid - taxiW)/2 };
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
      // the stands: spread evenly along the apron, nose in to the terminal, and never packed closer than a wingspan
      const stands = Math.max(1, Math.min(tier.stands || 1, Math.floor(spread/(tier.width*1.05))));
      for (let k=0;k<stands;k++) standList.push({ s: box.s + ((k + 0.5)/stands - 0.5)*spread, w: standW });
      taxiFrom = taxiW;
    }
  }
  if (tier.hangars && s.airportTerminal !== false) {
    // a grass strip gets a pair of hangars beside it instead, and light aircraft parked on the grass: one toward each end,
    // each slid along the strip until it finds room, on whichever side has room for more of them (the road side on a tie)
    const hangarAt = (sd, end) => {
      for (const f of [0.32, 0.2, 0.45, 0.1, 0.58]) {
        const box = fitInFrame(frame, inside, { s: end*L*f, w: sd*(W + tier.width*CLEARWAY + 16), nearW: sd*(W + tier.width*CLEARWAY + 11), halfLen: 11, halfWid: 7 });
        if (box) return box;
      }
      return null;
    };
    // (and on a short strip the two slide into each other, so the second only stands if it clears the first)
    const [near, far] = [roadSide, -roadSide].map(sd => [-1, 1].map(end => hangarAt(sd, end)).filter(Boolean)
      .filter((box, k, all) => k === 0 || Math.abs(box.s - all[0].s) > box.halfLen + all[0].halfLen + 2));
    const boxes = far.length > near.length ? far : near;
    side = far.length > near.length ? -roadSide : roadSide;
    boxes.forEach(box => {
      pave(tarmac, frameRect(frame, { ...box, halfLen: box.halfLen*1.2, halfWid: box.halfWid*1.9 }), free);
      zone.buildingsGroup.add(buildHangar(frame, box, rng));
      // the aircraft stands on the apron outside the door, the same way round as one at a terminal
      standList.push({ s: box.s, w: box.w - side*(box.halfWid + tier.width*0.45) });
    });
  }

  // ---- the aircraft, which are the most alive thing on the zone
  zone.airportAnim = null;
  zone.airportFlights = [];
  // where the camera falls back to while the aircraft it was watching is away over the horizon (see updateAirports)
  zone.airportField = { x: frame.center.x, z: frame.center.z, radius: Math.max(60, chord.length*0.6) };
  if (s.airportAircraft !== false) {
    if (tier.pad) {
      const heli = buildHelicopter(tier.width*0.55, rng);
      zone.buildingsGroup.add(heli);
      const extent = Math.max(L*2, 60);
      zone.airportAnim = makeCircuit(heli, frame.center, extent*0.7, { dx: frame.dx, dz: frame.dz });
    } else {
      const jet = tier.id !== 'airstrip';
      // without a terminal there's no taxiway either, so they use the grass just outside the runway edge
      const lane = taxiFrom != null ? taxiFrom : side*(W + tier.width*0.3);
      const usable = standList.filter(st => { const at = frame.at(st.s, st.w); return inside(at.x, at.z); });
      if (!usable.length) usable.push({ s: L*0.2, w: lane + side*tier.width*0.9 });
      usable.sort((a, b) => b.s - a.s);
      // The stands at the two ends of the apron are the ones worked, each by the aircraft using the runway end beside it.
      // Anything between them is only ever sat on — and sat on safely, because no route runs along that stretch of lane.
      const working = usable.length > 1 ? [usable[0], usable[usable.length-1]] : usable.slice(0, 1);
      const idle = usable.filter(st => !working.includes(st));
      const holdShort = -L + tier.width*0.35, touchdown = -L + tier.width*0.55;
      const reach = Math.max(...working.map(st => Math.abs(st.s)));
      // beyond the outermost stand, always: turning off short of one would mean taxiing back up the apron past it
      const turnoff = Math.min(L - tier.width*0.4, Math.max(reach + tier.width*1.4, touchdown + chord.length*0.45));
      // one working stand means one aircraft, and it may as well keep the runway the same way round each time
      const routes = working.map((st, k) => {
        const arrive = working.length > 1 ? (k === 0 ? 1 : -1) : 1, leave = working.length > 1 ? -arrive : 1;
        return { arrive, leave,
          in: [frame.at(arrive*turnoff, 0), frame.at(arrive*turnoff, lane), frame.at(st.s, lane), frame.at(st.s, st.w)],
          push: [frame.at(st.s, st.w), frame.at(st.s, lane)],
          out: [frame.at(st.s, lane), frame.at(leave*(holdShort + tier.width*0.9), lane), frame.at(leave*holdShort, 0)] };
      });
      // one schedule for the whole field, sized off the longest taxi on it, so the aircraft keep step with each other
      const sched = flightSchedule(Math.max(...routes.map(r => pathLength(r.in))),
        Math.max(...routes.map(r => pathLength(r.out))), routes.length);
      zone.airportFlights = routes.map((route, k) => {
        const plane = buildAircraft(tier.width*0.8, rng, jet);
        zone.buildingsGroup.add(plane);
        // half a cycle apart: as one lands the other is already sitting on its stand, waiting its turn to go
        const fly = makeFlight(plane, sched, route, frame, { touchdown, turnoff, holdShort, arrive: route.arrive, leave: route.leave },
          k*sched.cycle/routes.length);
        return makeTrackedFlight(zone, plane, fly, tier, k);
      });
      idle.forEach(st => {
        const at = frame.at(st.s, st.w);
        const parked = buildAircraft(tier.width*0.8, rng, jet);
        poseAircraft(parked, at.x, Y_TARMAC, at.z, side*frame.nx, side*frame.nz, 0);
        zone.buildingsGroup.add(parked);
      });
      const flights = zone.airportFlights;
      zone.airportAnim = (t, dt) => flights.forEach(flight => flight.update(t, dt));
    }
    zone.airportAnim(0, 0); // posed once where they stand, so a zone that's never updated (a carousel thumbnail) still shows them
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
// ============================================================ WATCHING AND FLYING ============================================================
// A scheduled aircraft can be clicked in World mode like a car or a carriage: the camera stays on it, a card names it
// (built above), and from that card's picture you can take the controls off it — the one thing a carriage can't
// do, and the reason an aircraft is wrapped in a record here rather than left as the bare closure the schedule makes.
//
// A flight is in one of three states, and `update` is where that is decided:
// - on schedule, which is all any of them did before this: the closure poses it from the clock
// - hand-flown, off the schedule entirely, moved by the keys held (flyByHand)
// - returning, let go of and flying itself back to the airfield (see stopFlying), where it rejoins the schedule
//   (rejoinSchedule) and eases from wherever it is to wherever the schedule says it should be by now (handBack)
//
// What never changes is the clock its schedule reads. Taking one off for a while and giving it back doesn't shift its
// place in the round, so the separation the two of them keep on the runway survives being interfered with — the aircraft
// you let go of has to fit itself back around the one that carried on.

/**
 * Wraps a scheduled flight in the record the camera, the card and the controls all address it by.
 * @param {object} zone
 * @param {THREE.Group} plane
 * @param {(t: number) => void} fly Poses it on its schedule.
 * @param {object} tier The airfield's tier, for the size the aircraft flies at.
 * @param {number} index Its place in the zone's flights, which is what a follow remembers it by.
 */
function makeTrackedFlight(zone, plane, fly, tier, index) {
  const flight = { zone, plane, fly, index, size: tier.width*0.8, hand: null, returning: null, handback: null, wreckedUntil: null };
  flight.update = (t, dt) => {
    if (flight.wreckedUntil) {
      if (t < flight.wreckedUntil) { plane.visible = false; return; }
      flight.wreckedUntil = null;
      fly.descendFrom?.(t); // a new one, coming in from the top of its descent
    }
    if (flight.hand) { flyByHand(flight, dt); return; }
    fly(t);
    if (flight.handback) handBack(flight, t);
  };
  return flight;
}

// ---- the flying itself (the model is in life/flight.js; this poses the aircraft from it)
/**
 * One frame of a hand-flown aircraft: flown by stepFlight at a scale set by its size, then posed and, while low enough,
 * struck against whoever is under it.
 * @param {object} flight
 * @param {number} dt Seconds this frame.
 * @returns {void}
 */
function flyByHand(flight, dt) {
  const hand = flight.hand, craft = { scale: flight.size/32, size: flight.size, floor: Y_TARMAC + flight.size*0.1, crashAngle: CRASH_ANGLE };
  stepFlight(hand, dt, craft, flight.returning ? autopilot(hand, returnTarget(flight), craft) : undefined);
  flight.plane.visible = true;
  poseAircraft(flight.plane, hand.x, hand.y + hand.hop, hand.z, Math.sin(hand.heading), Math.cos(hand.heading), hand.pitch - hand.dip, -hand.bank + hand.rock);
  // whoever is on the ground under it (or a car on the road) when it is low enough to touch them
  hand.speed *= 1 - (App.strikeWithAircraft?.({ x: hand.x, y: hand.y, z: hand.z, heading: hand.heading,
    halfLength: flight.size*0.5, halfWidth: flight.size*0.5, below: flight.size*0.1, above: flight.size*0.15,
    speed: hand.speed, velocity: { x: hand.vx, y: hand.vy, z: hand.vz } }) ?? 0);
  if (hand.crashed) { crashAircraft(flight); return; }
  if (flight.returning && backAtField(flight)) rejoinSchedule(flight);
}

const CRASH_ANGLE = Math.PI/4, WRECK_TIME = 25; // (how steeply it can meet the ground; seconds before a replacement is on its stand)
const BLAST_RADIUS = 0.5, BLAST_KILL_REACH = 1.5;  // (of its wingspan, the fireball's size; and how far past that anyone caught in it dies, as a multiple)
const WRECK_COLOR = new THREE.Color(0xeceff2);
/**
 * Blow up an aircraft that has hit the ground too steeply — a blast along its length, marking the ground — killing whoever
 * is within BLAST_KILL_REACH times the size of it, and take it out of the player's hands. A new one is on its stand after
 * WRECK_TIME.
 * @param {object} flight
 * @returns {void}
 */
function crashAircraft(flight) {
  const plane = flight.plane, along = { x: Math.sin(plane.rotation.y)*flight.size*0.3, z: Math.cos(plane.rotation.y)*flight.size*0.3 };
  const at = plane.position, radius = flight.size*BLAST_RADIUS*BLAST_KILL_REACH;
  // (on the ground it was over, so the scorch marks lie on it)
  [-1, 0, 1].forEach(k => explodeCar({ x: at.x + along.x*k, y: Y_TARMAC, z: at.z + along.z*k }, flight.size*0.15, { paint: WRECK_COLOR }));
  App.strikeWithAircraft?.({ x: at.x, y: Y_TARMAC, z: at.z, heading: 0, halfLength: radius, halfWidth: radius, below: radius, above: radius, speed: Infinity });
  if (flown === flight) { flown = null; endFlying(); }
  // a camera on it stays where it blew up, following nothing
  if (followedFlight() === flight) { controls.goalTarget.set(at.x, Y_TARMAC + flight.size*0.2, at.z); stopFollowingPlane(); }
  flight.hand = null; flight.returning = null; flight.handback = null;
  flight.wreckedUntil = (lastFrame || 0) + WRECK_TIME;
  plane.visible = false;
}

// ---- letting go: the aircraft flies itself back to the airfield, low over it, and only then goes back on its schedule
const RETURN_NEAR = 0.8, RETURN_HEIGHT = 6, RETURN_GIVE_UP = 90; // (field radii out; wingspans up; seconds before it rejoins wherever it is)
const RETURN_HANDBACK_REACH = 2;                                  // field radii: further than this from the schedule and it just appears there
// the airfield's middle, at a low pass over it
const returnTarget = flight => { const field = flight.zone.airportField; return { x: field.x, z: field.z, y: Y_TARMAC + flight.size*1.5 }; };
function backAtField(flight) {
  const field = flight.zone.airportField, hand = flight.hand;
  if (!field || lastFrame > flight.returning.giveUpAt) return true;
  return Math.hypot(hand.x - field.x, hand.z - field.z) < field.radius*RETURN_NEAR && hand.y < Y_TARMAC + flight.size*RETURN_HEIGHT;
}

const HANDBACK_SPEED = 60, HANDBACK_MIN = 2.4, HANDBACK_MAX = 14; // how quickly it works its way back, and the seconds that takes
/**
 * The seconds after letting go, easing the aircraft from where it was left to wherever its schedule has got to. The
 * schedule has been running the whole time and has posed it already this frame, so this only has to drag it back from
 * where the hand left it — a pull that shrinks to nothing, at which point the flight is simply on schedule again.
 * @param {object} flight
 * @param {number} t Seconds.
 * @returns {void}
 */
function handBack(flight, t) {
  const back = flight.handback, u = Math.min(1, (t - back.from)/back.span);
  if (u >= 1) { flight.handback = null; return; }
  const pull = Math.pow(1 - u, 3); // (all of the way off it at first, none of it by the end)
  const plane = flight.plane;
  plane.visible = true; // (it stays in sight all the way back, even if the schedule has it away over the horizon)
  plane.position.addScaledVector(back.offset, pull);
  // the angles come round the short way, so an aeroplane pointing the other way turns rather than spins
  const turn = a => Math.atan2(Math.sin(a), Math.cos(a));
  plane.rotation.x += turn(back.rotation.x - plane.rotation.x)*pull;
  plane.rotation.y += turn(back.rotation.y - plane.rotation.y)*pull;
  plane.rotation.z += turn(back.rotation.z - plane.rotation.z)*pull;
  // the schedule's pose worked the surfaces already; this is the attitude it actually ended up at
  workSurfaces(plane, -plane.rotation.x, plane.rotation.z, plane.position.y - Y_TARMAC);
}

/**
 * Runs every frame: moves whatever's flying at each airport, and keeps the camera on the one being watched. Each zone's
 * aircraft reads its place in its cycle straight off the clock, so rebuilding a zone — or the one next to it — doesn't
 * restart anything.
 * @param {number} t Seconds.
 * @returns {void}
 */
let lastFrame = null;
export function updateAirports(t) {
  const dt = lastFrame == null ? 0 : Math.max(0, Math.min(0.1, t - lastFrame)); // (capped: a backgrounded tab shouldn't fly half a mile)
  lastFrame = t;
  frameSeconds = dt; // what the control surfaces and the undercarriage ease over (see workSurfaces)
  S.zones.forEach(zone => { if (zone.airportAnim) zone.airportAnim(t, dt); });
  updatePlaneFollow();
}

// ---- following an aircraft with the camera: a click on one in World mode keeps the view on it, with a card naming it,
// until a click elsewhere, leaving World mode, or its zone being rebuilt away lets it go. What it is remembered by is its
// zone and its place in that zone's flights rather than the object itself, so a rebuild — the zone next door being
// redrawn, say — hands the camera straight back to the same aircraft instead of dropping it.
let followed = null;          // { zoneId, index }
let flown = null;             // the flight under the player's hands, if any
const everyFlight = () => S.zones.flatMap(zone => zone.airportFlights || []);
const followedFlight = () => {
  if (!followed) return null;
  const zone = S.zones.find(z => z.id === followed.zoneId);
  return zone && zone.airportFlights ? zone.airportFlights[followed.index] || null : null;
};
// the aircraft under a point on the screen, or null
function pickPlane(clientX, clientY) {
  const shown = everyFlight().filter(f => f.plane.visible);
  if (!shown.length) return null;
  App.raycaster.setFromCamera(App.ndcOf(clientX, clientY), camera);
  const hit = App.raycaster.intersectObjects(shown.map(f => f.plane), true)[0];
  if (!hit) return null;
  let object = hit.object;
  while (object && object.name !== 'Aircraft') object = object.parent;
  return shown.find(f => f.plane === object) || null;
}
function followPlaneAt(clientX, clientY) {
  const flight = pickPlane(clientX, clientY);
  if (!flight) { stopFollowingPlane(); return; }
  followed = { zoneId: flight.zone.id, index: flight.index };
  controls.minRadius = Math.max(1.2, flight.size*0.35);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, flight.size*2.6));
  showPlaneCard(planeCardInfo(flight));
}
function stopFollowingPlane() {
  if (!followed) return;
  stopFlying();
  followed = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  hidePlaneCard();
}
// what the card says about one: its number across the whole world, so two fields don't both have a Flight #1
function planeCardInfo(flight) {
  const number = everyFlight().indexOf(flight) + 1;
  return { number, view: planeThumbnailOf(flight.plane) };
}
// The card's picture: a copy of the aircraft (sharing its geometry and materials), sitting level at the origin, and an
// isometric camera framing it — as for a carriage (see trainThumbnailOf in trains.js).
function planeThumbnailOf(plane) {
  fadeAircraft(plane, 1);
  const mesh = plane.clone();
  mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.visible = true;
  const r = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius;
  const elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = r*4;
  const view = new THREE.OrthographicCamera(-r, r, r, -r, 0.1, distance*2);
  view.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  view.lookAt(0, 0, 0);
  return { mesh, camera: view };
}

const FIELD_EASE = 0.04;
/**
 * The camera, once the aircraft have all been moved.
 *
 * A departure climbs out and then simply stops being drawn, which is the whole of how this world lets one go. So rather
 * than follow it into nothing, or drop the aircraft the moment it goes, the camera comes back down to the airfield and
 * waits there — and the same flight is still being followed, so when it turns up on final a cycle later the camera picks
 * it up again where it left off. Flying one by hand also swings the camera round behind it, the way driving does.
 * @returns {void}
 */
function updatePlaneFollow() {
  if (followed && S.interactionMode !== 'move') { stopFollowingPlane(); return; }
  const flight = followedFlight();
  // a rebuild puts a fresh set of aircraft on the zone, and the one in hand went with the old ones
  if (flown && flown !== flight) { flown = null; endFlying(); }
  if (!flight) { if (followed) stopFollowingPlane(); return; }
  if (flight.plane.visible) {
    controls.goalTarget.copy(flight.plane.position);
    if (flight === flown) chaseBehind(flight.plane.rotation.y);
    return;
  }
  // away: ease back down onto the field it flew out of, and sit there until it comes round again
  const field = flight.zone.airportField;
  if (!field) return;
  controls.goalTarget.x += (field.x - controls.goalTarget.x)*FIELD_EASE;
  controls.goalTarget.y += (Y_TARMAC - controls.goalTarget.y)*FIELD_EASE;
  controls.goalTarget.z += (field.z - controls.goalTarget.z)*FIELD_EASE;
  controls.goalRadius += (field.radius - controls.goalRadius)*FIELD_EASE;
}
/**
 * The plane card's picture: take the followed aircraft off its schedule and fly it by hand, starting from exactly where
 * and how fast it already was, so the handover is invisible.
 * @returns {void}
 */
function flyPlane() {
  const flight = followedFlight();
  if (!flight || flown === flight || flight.wreckedUntil || !startFlying(stopFlying)) return;
  flown = flight;
  flight.handback = null;
  flight.returning = null; // (taken back off the autopilot, if it was flying itself home)
  const plane = flight.plane;
  plane.visible = true;
  fadeAircraft(plane, 1); // (it may have been fading out on its climb)
  flight.hand = flight.hand || makeHand({ x: plane.position.x, y: Math.max(Y_TARMAC + flight.size*0.1, plane.position.y), z: plane.position.z,
    heading: plane.rotation.y, pitch: -plane.rotation.x, speed: cruiseSpeed(flight.size/32) });
  controls.goalRadius = Math.max(controls.minRadius, flight.size*2.2);
}
/**
 * Let go of the aircraft: it carries on under its own autopilot, back to the airfield (see backAtField).
 * @returns {void}
 */
function stopFlying() {
  if (!flown) return;
  const flight = flown;
  flown = null;
  endFlying();
  flight.returning = { giveUpAt: (lastFrame || 0) + RETURN_GIVE_UP };
}
/**
 * Give it back to the schedule, restarted so that it is sitting on its stand: note how far from there the aircraft is and
 * let that distance fall away over the next few seconds (handBack) — or, if it is a long way out, let it appear on the
 * stand. It is over the airfield when this happens. (The round is its own from here, so it no longer keeps step with the
 * other aircraft on the field.)
 * @param {object} flight
 * @returns {void}
 */
function rejoinSchedule(flight) {
  const plane = flight.plane, field = flight.zone.airportField;
  const was = plane.position.clone(), wasRotation = { x: plane.rotation.x, y: plane.rotation.y, z: plane.rotation.z };
  flight.hand = null;
  flight.returning = null;
  flight.fly.dockAt?.(lastFrame || 0); // its round starts over, from settling on its stand
  flight.fly(lastFrame || 0);
  const offset = was.sub(plane.position);
  if (field && offset.length() > field.radius*RETURN_HANDBACK_REACH) return;
  flight.handback = { from: lastFrame || 0, rotation: wasRotation, offset,
    span: Math.max(HANDBACK_MIN, Math.min(HANDBACK_MAX, offset.length()/HANDBACK_SPEED)) };
  handBack(flight, lastFrame || 0); // (this frame too, so it doesn't show the stand for one frame before easing in from where it was)
}
// (the aircraft card is handed over too, for whoever else wants to put something on it or open one)
Object.assign(App, { pickPlane, followPlaneAt, stopFollowingPlane, flyPlane, stopFlying, showPlaneCard, hidePlaneCard });

Object.assign(App, { generateAirportContent, longestChordIn, runwayNumber });
