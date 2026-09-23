import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { groundBelow } from '../../core/ground-probe.js';
import { NO_GROUND_FALLBACK, fallStep, gibGone, gibSink, isNear, landingGround } from '../giblets.js';
import { gibPartCentre } from './peopleModel.js';

// A dead person's own body parts, thrown apart: the parts personModel.gibs holds (see buildGibMeshes in
// peopleModel.js), each starting exactly where it was on them, in the pose they died in, then tumbling and falling
// like any other gib (fallStep in giblets.js). Up to GIB_BODIES_MAX bodies at once; the oldest makes way.
//
// A body keeps the same instance in every part mesh for as long as it lasts (its gib column), so a part lying still
// is written once and left alone; only parts that are moving, sinking or coming back into range are rewritten.

const PART_THROW = [1, 3.5], PART_LAUNCH = [2, 6], PART_SPIN = [2, 8]; // outward and upward speed (m/s) and spin (rad/s), before momentum
const REST_LIFT_SHARE = 0.5; // how far above the ground a part's middle rests, against its thinnest side (a long limb lies flat)
const SPLASH_SHARE = 0.5; // how big the droplet a part makes going under water is, against its radius

const bodies = []; // oldest first: { column, born, pieces }
const targets = new Set(); // every part mesh a body has used
let model = null, lastTime = null, highestColumn = -1;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

const random = ([lo, hi]) => lo + Math.random()*(hi - lo);
const personMatrix = new THREE.Matrix4(), centre = new THREE.Vector3(), extent = new THREE.Vector3(), placed = new THREE.Matrix4();
const position = new THREE.Vector3(), scale = new THREE.Vector3(), turn = new THREE.Quaternion();

// clear a body's instances out of every part mesh
function removeBody(body) {
  body.pieces.forEach(piece => hide(piece));
}
function hide(piece) {
  piece.target.mesh.setMatrixAt(piece.column, HIDDEN);
  piece.target.dirty = true;
}
function freeColumn() {
  if (bodies.length >= model.gibs.capacity) { const oldest = bodies.shift(); removeBody(oldest); return oldest.column; }
  const used = new Set(bodies.map(body => body.column));
  for (let c=0;c<model.gibs.capacity;c++) if (!used.has(c)) return c;
  return 0;
}

/**
 * Throw person `i`'s body parts, hair and whatever else they wore apart.
 * @param {object} personModel - the loaded person model (see buildPersonModel)
 * @param {number} i - their slot in the crowd
 * @param {{x: number, y: number, z: number}} at - where their feet were
 * @param {?{x: number, y: number, z: number}} momentum - the velocity of whatever hit them, which the parts keep
 * @returns {boolean} whether any were thrown (not when gibs are off, they're too far away, or they weren't drawn)
 */
export function throwBodyParts(personModel, i, at, momentum = null) {
  if (!personModel?.gibs || !S.showGibs || S.gibAmount <= 0 || !isNear(at)) return false;
  personModel.mesh.getMatrixAt(i, personMatrix);
  if (personMatrix.getMaxScaleOnAxis() < 1e-6) return false;
  model = personModel;
  const t = performance.now()/1000, column = freeColumn(), o = i*4;
  model.gibs.snapshot(i, column);
  const body = { column, born: t, pieces: [] };
  highestColumn = Math.max(highestColumn, column);
  const worn = [...model.gibs.parts];
  model.wornLayers.forEach(layer => { const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null; if (style?.gib) worn.push(style.gib); });
  const anim = model.anim.array.subarray(o, o + 4), look = model.look.array.subarray(o, o + 4), eyes = model.eyes.array.subarray(o, o + 4);
  const worldScale = personMatrix.getMaxScaleOnAxis();
  const groundAt = (x, z) => groundBelow(x, at.y, z, NO_GROUND_FALLBACK), fromGround = groundAt(at.x, at.z);
  worn.forEach(target => {
    // (its pose, look and looks, set once for the body's column)
    target.anim.array.set(anim, column*4); target.look.array.set(look, column*4); target.eyes.array.set(eyes, column*4);
    target.person.array[column] = column;
    target.anim.needsUpdate = target.look.needsUpdate = target.eyes.needsUpdate = target.person.needsUpdate = true;
    const radius = gibPartCentre(target.samples, model.boneData, model.boneWidth, anim, centre, extent)*worldScale;
    const thinnest = Math.min(extent.x, extent.y, extent.z)*worldScale;
    centre.applyMatrix4(personMatrix);
    // thrown out from their middle, or anywhere at all if it was right in the middle
    let dx = centre.x - at.x, dz = centre.z - at.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) { const angle = Math.random()*Math.PI*2; dx = Math.cos(angle); dz = Math.sin(angle); } else { dx /= d; dz /= d; }
    const outward = random(PART_THROW);
    const piece = { target, column, shown: false, x: centre.x, y: centre.y, z: centre.z,
      vx: dx*outward + (momentum?.x ?? 0), vy: random(PART_LAUNCH) + (momentum?.y ?? 0), vz: dz*outward + (momentum?.z ?? 0),
      quaternion: new THREE.Quaternion(), spinAxis: new THREE.Vector3().randomDirection(), spin: random(PART_SPIN),
      size: radius, lift: thinnest*REST_LIFT_SHARE, resting: false, ground: fromGround,
      base: new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z).multiply(personMatrix) };
    piece.ground = landingGround(piece, fromGround, groundAt);
    body.pieces.push(piece);
    if (!targets.has(target)) { // (a mesh's instances start as the identity, drawn at the origin: hide them all first)
      for (let c=0;c<model.gibs.capacity;c++) target.mesh.setMatrixAt(c, HIDDEN);
      targets.add(target);
    }
  });
  bodies.push(body);
  return true;
}

/**
 * Move and draw every body part. Call once a frame.
 * @param {number} t - the time, in seconds
 * @returns {void}
 */
export function updateBodyParts(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  if (!model) return;
  if (!S.showGibs || S.gibAmount <= 0) { bodies.forEach(removeBody); bodies.length = 0; }
  while (bodies.length && gibGone(t, bodies[0].born)) removeBody(bodies.shift());
  bodies.forEach(body => {
    const sink = gibSink(t, body.born);
    for (let k = body.pieces.length - 1; k >= 0; k--) {
      const piece = body.pieces[k];
      if (!isNear(piece)) { if (piece.shown) { hide(piece); piece.shown = false; } continue; }
      if (!fallStep(piece, dt, t, piece.lift, piece.size*SPLASH_SHARE)) { hide(piece); body.pieces.splice(k, 1); continue; }
      if (piece.resting && !sink && piece.shown) continue; // (lying still: already where it's drawn)
      placed.compose(position.set(piece.x, piece.y - sink*piece.size, piece.z), turn.copy(piece.quaternion), scale.setScalar(1 - sink)).multiply(piece.base);
      piece.target.mesh.setMatrixAt(piece.column, placed);
      piece.target.dirty = piece.shown = true;
    }
  });
  targets.forEach(target => {
    target.mesh.count = highestColumn + 1;
    target.mesh.visible = bodies.length > 0;
    if (target.dirty) { target.mesh.instanceMatrix.needsUpdate = true; target.dirty = false; }
  });
}
