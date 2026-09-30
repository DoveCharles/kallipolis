import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HEIGHT, HEAD_UP, botFace, newFace, waiterBody } from './barbot.js';
import { TOON_RAMP } from '../core/toon.js';
import { hasBubble, speechBubble } from '../ui/speech-bubbles.js';

// ============================================================ the waiter bot
// Every restaurant has a waiter: the bar bot's model dressed for it (a tux and a moustache, no pint: see dressBot in
// barbot.js), stood behind the host stand. This is its body — sliding about the room (in the world's terms, turning to
// face the way it goes), its poses, its face and voice (botFace), and the plates it carries; what it does, and when, is
// life/people/peopleWaiter.js. Its plates ride on its hands (ArmIK.L/R), kept upright; carrying, PlateLeft/PlateRight is
// held at its first frame, then played through to set one down, the plate going onto the table DROP_AT in. With two, the
// clips are split by arm so each can play on its own (see split). Picking an empty plate up off a table (left there by
// whoever ate off it: waiterLeave) plays the same clip backwards. It swings the kitchen doors' leaves open the way it's
// going through (waiterDoorWay), and says a line in a bubble now and then (waiterSay). A mirrored room (see interior.js)
// is minded: yaws go to and from the room's terms through its matrix.
const SPEED = 2.7;          // m/s
const TURN = 14;            // rad/s
const FACING = 0.3;         // rad off the way it's going it still moves (slower the further off)
const FADE = 0.35;          // s, between poses
const HEAD_REACH = 1.1;     // rad, the most its head swivels either way
const HEAD_EASE = 5;        // the head's swivel, eased per second
const DROP_AT = 20/24;      // s into PlateLeft/Right: the plate's on the table
const PLATE_UP = 0.13;      // m, the plate above its hand
const BEHIND = 0.6;         // m behind the host stand
const DOOR_OUT = 0.8, DOOR_IN = 2.3; // m in front of the kitchen doors, and through them
const DISH = { spaghetti: 0.26, slice: 0.17, tray: 0.36, plate: 0.24 }; // m, as the diners' (see peopleHolding.js)
const SWING = 1.4, SWING_K = 90, SWING_DAMP = 7; // the kitchen doors: rad open at most, and their spring
const SAY_TIME = 1.8;       // s a line's said for

/** The waiter as the people it talks to see it: where its head is (see BARBOT in barbot.js). */
export const WAITER = { x: 0, y: 0, z: 0, traits: { talkative: 1 }, lookAt: null, phrase: null, isBarbot: true };

let w = null;               // its body (see makeBot in barbot.js), and { hand, reach, dishes } once rigged
let group = null, local = null; // the restaurant's furniture, and its stand and door in the room's terms
const s = { x: 0, z: 0, yaw: 0, face: null, route: [], hidden: false, asleep: false, occupied: false, up: false, snap: true,
  head: 0, target: null, talking: false, base: 'DefaultPose', pace: 1, carry: { L: null, R: null }, serve: null,
  doorWay: 0, swing: 0, swingV: 0, say: null, ...newFace() };
let lastTime = 0, dishesLoading = null;
const leftovers = new Set(); // empty plates left on tables
const v = new THREE.Vector3(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), headTurn = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);

// the body, scaled, with its hands found, the plate clips split by arm, and where each hand is as it sets a plate down
function rig() {
  if (w?.hand) return w;
  const body = waiterBody();
  if (!body) return null;
  w = body;
  w.root.scale.setScalar(HEIGHT/w.height);
  w.hand = { L: bone('ArmIK', 'L'), R: bone('ArmIK', 'R') };
  const arm = side => new RegExp(`^(Arm\\d*|ArmIK|Hand)\\.?${side}\\.`);
  for (const [side, other] of [['L', 'R'], ['R', 'L']]) {
    const clip = w.actions[`Plate${side === 'L' ? 'Left' : 'Right'}`]?.getClip();
    if (!clip) continue;
    const split = (name, keep) => { w.actions[name] = w.mixer.clipAction(new THREE.AnimationClip(name, clip.duration, clip.tracks.filter(keep))); };
    split(`${side}arm`, t => arm(side).test(t.name));           // (just that arm)
    split(`${side}rest`, t => !arm(other).test(t.name));        // (all but the other arm)
  }
  w.reach = {};
  for (const side of ['L', 'R']) {
    const a = w.actions[`Plate${side === 'L' ? 'Left' : 'Right'}`];
    if (!a || !w.hand[side]) continue;
    a.reset().play(); a.paused = true; a.time = DROP_AT;
    w.mixer.update(0);
    w.root.updateMatrixWorld(true);
    w.hand[side].getWorldPosition(v);
    w.reach[side] = { x: v.x, z: v.z };
    a.stop();
  }
  w.mixer.update(0);
  w.dishes = { L: new THREE.Group(), R: new THREE.Group() };
  for (const side of ['L', 'R']) for (const name of ['plate', 'tray']) w.dishes[side].add(empty(name));
  loadDishes();
  return w;
}
const toon = m => Object.assign(new THREE.MeshToonMaterial({ name: m.name, color: m.color, gradientMap: TOON_RAMP }), { defines: { ROOM_LAMP: '', ROOM_GLOW: '' } });
// an empty plate or pizza tray, its bottom at its origin
function empty(name) {
  const h = name === 'tray' ? 0.008 : 0.012;
  const o = new THREE.Mesh(new THREE.CylinderGeometry(DISH[name]/2, DISH[name]/2*0.85, h, 20), toon({ name, color: new THREE.Color(name === 'tray' ? 0xb0b4b8 : 0xf8f8f2) }));
  o.geometry.translate(0, h/2, 0);
  o.castShadow = true;
  o.name = name;
  return o;
}
function bone(name, side) {
  let found = null;
  w.rig.traverse(o => { if (o.isBone && (o.name === name + side || o.name === `${name}.${side}`)) found = o; });
  return found;
}
// spaghetti, and a pizza (a tray and eight slices), from the restaurant's model, for each hand
function loadDishes() {
  dishesLoading ??= new GLTFLoader().loadAsync('assets/models/Restaurant.glb').then(gltf => {
    const node = name => {
      const o = gltf.scene.getObjectByName(name);
      if (!o) return null;
      o.position.set(0, 0, 0);
      o.traverse(m => { if (m.isMesh) { m.material = toon(m.material); m.castShadow = true; } });
      return o;
    };
    const pasta = node('Spaghetti'), slice = node('PizzaSlice');
    const made = {};
    if (pasta) {
      const box = new THREE.Box3().setFromObject(pasta), size = box.getSize(v), k = DISH.spaghetti/Math.max(size.x, size.z);
      pasta.scale.multiplyScalar(k);
      const mid = box.getCenter(new THREE.Vector3());
      pasta.position.set(-mid.x*k, -box.min.y*k, -mid.z*k);
      made.spaghetti = new THREE.Group().add(pasta);
    }
    if (slice) {
      // (its tip at its origin: turned round it, eight make a pizza)
      const size = new THREE.Box3().setFromObject(slice).getSize(v), k = DISH.slice/Math.max(size.x, size.z);
      slice.scale.multiplyScalar(k);
      const pizza = new THREE.Group();
      pizza.add(new THREE.Mesh(new THREE.CylinderGeometry(DISH.tray/2, DISH.tray/2, 0.008, 20), toon({ name: 'Tray', color: new THREE.Color(0xb0b4b8) })));
      pizza.children[0].position.y = 0.004;
      for (let n = 0; n < 8; n++) {
        const piece = slice.clone();
        piece.rotation.y += n*Math.PI/4;
        piece.position.y = 0.008;
        pizza.add(piece);
      }
      made.pizza = pizza;
    }
    for (const side of ['L', 'R']) for (const [name, dish] of Object.entries(made)) {
      const copy = side === 'L' ? dish : dish.clone();
      copy.name = name;
      copy.visible = false;
      w.dishes[side].add(copy);
    }
  }).catch(err => console.warn('Kallipolis: the waiter\'s dishes failed to load', err));
}

/**
 * Put the waiter behind this restaurant's host stand, in `group` (its furniture, in the room's terms).
 * @param {THREE.Group} into
 * @param {{x: number, z: number, angle: number}} stand - the host stand, facing the way in
 * @param {?{x: number, z: number, angle: number, leaves: ?THREE.Group[]}} door - the kitchen doors, facing into the room, and
 *   their leaves' pivots (userData.side: 1 right, -1 left)
 */
export function placeWaiterbot(into, stand, door) {
  if (!rig()) return;
  group = into;
  const f = { x: Math.sin(stand.angle), z: Math.cos(stand.angle) };
  local = { stand: { x: stand.x - f.x*BEHIND, z: stand.z - f.z*BEHIND, angle: stand.angle }, stand0: stand, door };
  group.add(w.root, w.dishes.L, w.dishes.R);
  leftovers.forEach(o => o.removeFromParent());
  leftovers.clear();
  Object.assign(s, { route: [], face: null, hidden: false, snap: true, target: null, talking: false, base: 'DefaultPose', pace: 1, carry: { L: null, R: null }, serve: null, doorWay: 0, swing: 0, swingV: 0, say: null });
  s.placed = false; // (put at its stand, in the world's terms, the first frame the room's in place)
}

// ---- in the world's terms
const toWorld = (x, z) => { group.updateMatrixWorld(); const p = group.localToWorld(v.set(x, 0, z)); return { x: p.x, y: p.y, z: p.z }; };
const yawToWorld = a => { group.updateMatrixWorld(); v.set(Math.sin(a), 0, Math.cos(a)).transformDirection(group.matrixWorld); return Math.atan2(v.x, v.z); };
const yawToLocal = a => { group.updateMatrixWorld(); v.set(Math.sin(a), 0, Math.cos(a)).transformDirection(m4.copy(group.matrixWorld).invert()); return Math.atan2(v.x, v.z); };
const mirrored = () => group.matrixWorld.determinant() < 0;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
/** Whether the waiter's up, in the restaurant the view's in. */
export const waiterUp = () => !!w?.hand && s.up && !!group && w.root.parent === group;
/** Anyone's in the restaurant. */
export const waiterBusy = () => s.occupied;
/** Where it is, in the world, and which way it faces. */
export const waiterAt = () => ({ x: s.x, y: toWorld(0, 0).y, z: s.z, yaw: s.yaw });
/** Where it waits, behind the host stand, and which way it faces there; and the host stand itself. */
export function waiterStand() {
  const at = toWorld(local.stand.x, local.stand.z), stand = toWorld(local.stand0.x, local.stand0.z);
  return { ...at, yaw: yawToWorld(local.stand.angle), host: stand };
}
/** The kitchen doors: in front of them (`out`), through them (`in`), and the way through, in the world; or null. */
export function waiterDoor() {
  const d = local?.door;
  if (!d) return null;
  const f = { x: Math.sin(d.angle), z: Math.cos(d.angle) };
  return { out: toWorld(d.x + f.x*DOOR_OUT, d.z + f.z*DOOR_OUT), at: toWorld(d.x, d.z), in: toWorld(d.x - f.x*DOOR_IN, d.z - f.z*DOOR_IN), yaw: yawToWorld(d.angle + Math.PI) };
}
/** Walk a route (world points), facing `face` (a yaw) once there, if given. */
export function waiterGo(route, face = null) { s.route = route.map(p => ({ x: p.x, z: p.z })); s.face = face; }
export const waiterMoving = () => s.route.length > 0 || (s.face != null && Math.abs(wrap(s.face - s.yaw)) > 0.05);
/** Stood still, turn to face `yaw`. */
/** How fast it walks, as a share of SPEED (slowed for someone following it). */
export function waiterPace(k) { s.pace = k; }
export function waiterTurn(yaw) { s.face = yaw; }
/** Its pose when it's not carrying anything: 'DefaultPose' or 'Waiting'. */
export function waiterPose(name) { s.base = name; }
/** Look at someone (anything with x and z), or straight ahead. */
export function waiterLook(at) { s.target = at; }
export function waiterTalk(on) { s.talking = on; }
export function waiterHide(on) { s.hidden = on; }
export function waiterSleep(on) { s.asleep = on; }
/** Carry a dish ('spaghetti' or 'pizza') in either hand, or nothing. */
export function waiterCarry(L, R) { s.carry = { L, R }; }
/**
 * Set down what's in one hand (`side`: 'L' or 'R'), `drop` called as it's on the table; or, with `pick` (a dish), pick
 * that up off the table into that hand, `drop` called as it's taken.
 */
export function waiterServe(side, drop, pick = null) { s.serve = { side, t: 0, drop, dropped: false, pick }; }
/** Swing the kitchen doors open towards the kitchen (1), out into the room (-1), or let them swing shut (0). */
export function waiterDoorWay(k) { s.doorWay = k; }
/** Say a line (in a bubble, babbling), looking at `to`. */
export function waiterSay(text, to = null) { s.say = { line: { text }, to, until: performance.now()/1000 + SAY_TIME }; }
/** Leave an empty dish ('plate' or 'tray') on a table, at `at` (in the world); returns it, for waiterClear. */
export function waiterLeave(dish, at) {
  const o = empty(dish);
  o.position.copy(group.worldToLocal(v.set(at.x, at.y, at.z)));
  group.add(o);
  leftovers.add(o);
  return o;
}
export function waiterClear(o) { o.removeFromParent(); leftovers.delete(o); }
export const waiterServing = () => !!s.serve;
/** Where a hand is, as it sets a plate down, from the waiter's feet (its own terms: +z ahead), in metres. */
export function waiterReach(side) {
  const at = w?.reach?.[side] ?? { x: 0, z: 0.5 };
  return group && mirrored() ? { x: -at.x, z: at.z } : at; // (mirrored, its left hand's on its right)
}

// the poses to be in: [name, 'loop' | 'hold' (at its first frame) | 'once' | 'back' (once, backwards)], the rest faded out
let posed = '';
function poses(list, fade = FADE) {
  const key = list.map(p => p.join(':')).join(' ');
  if (key === posed) return;
  posed = key;
  const want = new Map(list);
  for (const [name, a] of Object.entries(w.actions)) if (!want.has(name) && a.isScheduled()) fade ? a.fadeOut(fade) : a.stop();
  for (const [name, how] of list) {
    const a = w.actions[name];
    if (!a) continue;
    const was = a.isScheduled() && a.getEffectiveWeight() > 0;
    // (a pose already held stays held: restarted, it'd fade in from nothing — see pose in barbot.js)
    if ((how === 'loop' || how === 'hold') && a.isScheduled() && a.getEffectiveWeight() > 0 && a.paused === (how === 'hold')) { a.stopFading().setEffectiveWeight(1); continue; }
    a.reset().setLoop(how === 'loop' ? THREE.LoopRepeat : THREE.LoopOnce, how === 'loop' ? Infinity : 1);
    a.clampWhenFinished = true;
    a.timeScale = how === 'back' ? -1 : 1;
    a.play();
    if (how === 'back') a.time = a.getClip().duration;
    if (how === 'hold') { a.paused = true; a.time = 0; }
    // (one already on, restarted, stays at full weight: faded in from nothing, it'd T-pose a moment)
    if (fade && !was) a.fadeIn(fade); else a.setEffectiveWeight(1);
  }
}
function pickPoses() {
  const { L, R } = s.carry, serve = s.serve;
  if (s.asleep) return [['Sleep', 'loop']];
  if (serve) {
    const other = serve.side === 'L' ? R : L, how = serve.pick ? 'back' : 'once';
    return other ? [[`${serve.side}rest`, how], [`${serve.side === 'L' ? 'R' : 'L'}arm`, 'hold']] : [[serve.side === 'L' ? 'PlateLeft' : 'PlateRight', how]];
  }
  if (L && R) return [['Rrest', 'hold'], ['Larm', 'hold']];
  if (L) return [['PlateLeft', 'hold']];
  if (R) return [['PlateRight', 'hold']];
  return [[s.base, 'loop']];
}

/**
 * Each frame, while the room's up.
 * @param {boolean} inRestaurant - the room up is a restaurant
 * @param {boolean} occupied - anyone's in it
 */
export function updateWaiterbot(inRestaurant, occupied) {
  const now = performance.now()/1000, dt = Math.min(0.1, now - lastTime);
  lastTime = now;
  s.up = inRestaurant; s.occupied = occupied;
  if (!w?.hand || !group || !inRestaurant || w.root.parent !== group) return;
  if (w.head) w.head.quaternion.premultiply(q.copy(headTurn).invert()); // (last frame's swivel off first: see barbot.js)
  const snap = s.snap;
  s.snap = false;
  if (!s.placed) {
    const stand = waiterStand();
    Object.assign(s, { x: stand.x, z: stand.z, yaw: stand.yaw, placed: true, route: [], face: null });
  }

  // along its route, turning to face the way it's going, then whichever way it's to face
  let goal = s.face ?? s.yaw;
  if (s.route.length) {
    const next = s.route[0], dx = next.x - s.x, dz = next.z - s.z, far = Math.hypot(dx, dz);
    if (far < 0.03) s.route.shift();
    else {
      goal = Math.atan2(dx, dz);
      const off = Math.abs(wrap(goal - s.yaw));
      if (off < FACING) {
        const step = Math.min(far, SPEED*s.pace*dt*(1 - off/FACING*0.7));
        s.x += dx/far*step; s.z += dz/far*step;
      }
    }
  }
  const turn = wrap(goal - s.yaw);
  s.yaw = wrap(s.yaw + Math.sign(turn)*Math.min(Math.abs(turn), TURN*dt));
  if (!s.route.length && s.face != null && Math.abs(turn) < 0.05) s.face = null;

  // setting a plate down: onto the table DROP_AT in, and done at the clip's end
  const serve = s.serve;
  if (serve) {
    serve.t += dt;
    const length = w.actions.PlateLeft?.getClip().duration ?? 2;
    if (!serve.dropped && serve.t >= (serve.pick ? length - DROP_AT : DROP_AT)) { serve.dropped = true; s.carry[serve.side] = serve.pick; serve.drop?.(); }
    if (serve.t >= length) s.serve = null;
  }
  poses(pickPoses(), snap ? 0 : FADE);

  // its head turned to whoever it's looking at
  const saying = !!s.say && now < s.say.until && !s.hidden, target = saying && s.say.to ? s.say.to : s.target;
  const at = target && !s.asleep ? Math.max(-HEAD_REACH, Math.min(HEAD_REACH, wrap(Math.atan2(target.x - s.x, target.z - s.z) - s.yaw))) : 0;
  s.head += (at - s.head)*Math.min(1, HEAD_EASE*dt);

  const p = group.worldToLocal(v.set(s.x, toWorld(0, 0).y, s.z));
  w.root.position.set(p.x, 0, p.z);
  w.rig.rotation.y = yawToLocal(s.yaw);
  w.root.visible = !s.hidden;
  w.mixer.update(dt);
  if (w.head) w.head.quaternion.premultiply(headTurn.setFromAxisAngle(UP, mirrored() ? -s.head : s.head));
  w.root.updateMatrixWorld(true);
  if (w.head) {
    w.head.getWorldPosition(v);
    WAITER.x = v.x; WAITER.y = v.y + HEAD_UP; WAITER.z = v.z;
  }
  // the plates, on its hands, upright
  for (const side of ['L', 'R']) {
    const dishes = w.dishes[side], dish = s.carry[side];
    dishes.visible = !!dish && !s.hidden;
    if (!dishes.visible) continue;
    dishes.children.forEach(o => { o.visible = o.name === dish; });
    group.worldToLocal(w.hand[side].getWorldPosition(v));
    dishes.position.set(v.x, v.y + PLATE_UP, v.z);
    dishes.rotation.y = w.rig.rotation.y;
  }

  if (w.face) w.face.visible = !s.asleep;
  if (w.zzz) w.zzz.visible = s.asleep;
  if (w.moustache) w.moustache.visible = !s.asleep;
  botFace(w, s, WAITER, dt, now, { asleep: s.asleep, working: false, still: !!target, talking: (s.talking || saying) && !s.asleep, snap });
  if (saying || hasBubble(WAITER)) speechBubble(WAITER, { x: WAITER.x, y: WAITER.y + 0.15, z: WAITER.z }, saying ? s.say.line : null);

  // the kitchen doors, swung by it going through, and swinging to and fro a while after
  if (local.door?.leaves) {
    s.swingV += ((s.doorWay - s.swing)*SWING_K - s.swingV*SWING_DAMP)*dt;
    s.swing += s.swingV*dt;
    for (const pivot of local.door.leaves) pivot.rotation.y = -pivot.userData.side*s.swing*SWING;
  }
}
