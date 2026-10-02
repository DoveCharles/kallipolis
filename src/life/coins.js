import * as THREE from 'three';
import { scene, camera, sunOffset } from '../core/scene.js';
import { ear, playSound } from '../audio/sfx.js';
import { groundBelow } from '../core/ground-probe.js';
import { App, S, worldNow } from '../core/shared.js';
import { addMoney } from '../ui/money.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';
import { NO_GROUND_FALLBACK } from './giblets.js';
import { possession, flying } from './possession.js';
import { drivenCar } from './traffic/driving.js';
import { feel, isGone, people, standingOf } from './people/people.js';

// Coins dropped by the dead (their wallet, see newPerson in people/people.js): thrown out, land, and when the pointer
// passes over one it curves up behind the money indicator (#morality-meter .money), spinning and glinting, and pays out
// as it leaves the top of the screen. Also picked up by being near:
// - passers-by, into their wallet: from a fresh death (RECENT) only the evil (not innocent: standingOf) take it, the rest
//   refuse and say so (felt 'leftmoney'); the evil gloat ('lootedbody'); older coins are just found ('foundmoney')
// - whatever's possessed: a person into their wallet; a car or anything flown, up to the money indicator as hovered
// Left out of view, coins go (LOST_AFTER, sooner the further off) into the world's lost change (progress 'lostChange').
const KINDS = [
  { value: 100, color: 0xe8b830 }, // gold
  { value: 10, color: 0xc8ccd4 },  // silver
  { value: 1, color: 0xb8683a },   // copper
];
const RADIUS = 0.12, THICK = 0.03, GRAVITY = 9.8, MAX_COINS = 300;
const RECENT = 90, PILE_REACH = 4, NOTICE = 1.6, TAKE_REACH = 0.7, CHECK_EVERY = 0.2, GRAB_TIME = 0.3; // (s; m, at people size 1)
const CAR_REACH = 2.2, FLY_REACH = 1.5, UP_REACH = 1.2; // (how near a driven car or anything flown, and how far above)
const LOST_AFTER = 120, LOST_NEAR = 30, LOST_FALLOFF = 60, LOST_MIN = 0.3; // (s out of view; m from the camera)
const HOVER_PX = 44, FLY_TIME = 1.1, SPIN = 14, END_PX = 12, CURVE = 5;
// resting clear of park grass shells (GRASS_SHELL_HEIGHT 0.03, zones/surface-detail.js)
const LIFT = 0.04, WOBBLE_TIME = 1.6, FLIP_CHANCE = 0.4, TILT = 0.35, WHIRL = 25;
const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, THICK, 20);
const materials = KINDS.map(k => new THREE.MeshStandardMaterial({ color: k.color, metalness: 0.75, roughness: 0.28,
  polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10 })); // (over blood splats -7 and chunks -6: giblets.js)

const coins = [], piles = [];
let lostChange = Number(getProgress('lostChange')) || 0;
// What's saved counts the coins still lying about as lost too: they aren't kept with the project, so a world saved with
// them out (or left for another project, which clears them) has them in its lost change; lostChange itself is what's
// really gone in this session.
const syncLost = () => setProgress('lostChange', lostChange + coins.reduce((sum, c) => sum + KINDS[c.kind].value, 0));
// (a project's coming in: its own lost change; the old one's coins, already in its saved figure, cleared)
onProgress('lostChange', v => { while (coins.length) removeCoin(0, false, false); lostChange = Number(v) || 0; });
App.lostChange = () => lostChange;
const pointer = { x: -1e4, y: -1e4 };
window.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; });
const moneyEl = document.querySelector('#morality-meter .money');
const WHITE = new THREE.Color(0xffffff), v = new THREE.Vector3(), n = new THREE.Vector3(), h = new THREE.Vector3(), axis = new THREE.Vector3();
const spinQ = new THREE.Quaternion(), yawQ = new THREE.Quaternion();
const FLAT_TO_VIEW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI/2), Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

/**
 * Throw a wallet's worth of coins out from `at`: fewest coins (gold 100, silver 10, copper 1).
 * @param {{x: number, y: number, z: number}} at @param {number} amount
 */
export function dropCoins(at, amount) {
  amount = Math.floor(amount);
  const ground = groundBelow(at.x, at.y + 1, at.z, NO_GROUND_FALLBACK);
  const pile = { x: at.x, z: at.z, born: worldNow(), count: 0, refused: new Set(), took: new Set() }; // (refused/took: person ids, said once each)
  piles.push(pile);
  for (let k = 0; k < KINDS.length; k++) {
    for (let n = Math.floor(amount / KINDS[k].value); n > 0; n--) {
      if (coins.length >= MAX_COINS) removeCoin(0, true);
      pile.count++;
      const mesh = new THREE.Mesh(geometry, materials[k].clone());
      mesh.material.emissive.setHex(KINDS[k].color).lerp(WHITE, 0.5); mesh.material.emissiveIntensity = 0;
      mesh.name = 'Coin'; // (not ground: core/ground-probe.js)
      mesh.position.set(at.x, at.y + 1, at.z);
      scene.add(mesh);
      const a = Math.random()*Math.PI*2, s = 0.3 + Math.random()*0.7;
      coins.push({ mesh, kind: k, pile, unseen: 0, state: 'fall', ground, vx: Math.sin(a)*s, vy: 3 + Math.random()*2, vz: Math.cos(a)*s,
        tumble: new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(12), born: worldNow(), bounced: false });
    }
    amount %= KINDS[k].value;
  }
  syncLost();
}

// a spinning coin's quiet rattle
const tinkle = (at, volume) => playSound('coinspin', at, volume);

// the money indicator shaking as a coin's paid in
function shakeMoney() {
  moneyEl?.animate([{ transform: 'translate(0, 0)' }, { transform: 'translate(-3px, 1px) rotate(-2deg)' }, { transform: 'translate(3px, -1px) rotate(2deg)' },
    { transform: 'translate(-2px, -1px) rotate(-1deg)' }, { transform: 'translate(2px, 1px) rotate(1deg)' }, { transform: 'translate(0, 0)' }], { duration: 300 });
}

// (lost: gone unclaimed, into the world's lost change)
function removeCoin(i, lost, sync = true) {
  const c = coins[i];
  if (lost) lostChange += KINDS[c.kind].value;
  if (--c.pile.count <= 0 && piles.includes(c.pile)) piles.splice(piles.indexOf(c.pile), 1);
  scene.remove(c.mesh);
  c.mesh.material.dispose();
  coins.splice(i, 1);
  if (sync) syncLost();
}

// a screen point (px) `dist` along the camera's ray through it, into `out`
function worldAt(sx, sy, dist, out) {
  out.set(sx/innerWidth*2 - 1, 1 - sy/innerHeight*2, 0.5).unproject(camera).sub(camera.position).normalize();
  return out.multiplyScalar(dist).add(camera.position);
}
const expo = (f, k) => (Math.exp(k*f) - 1)/(Math.exp(k) - 1);

// the coin flying up to the money indicator (hovered, or picked up by a car or anything flown)
function startFly(c, sx, sy) {
  const m = c.mesh;
  c.state = 'fly';
  // each its own way up, so a pile goes as a stream: a short wait, its own time, curve, lean and spin
  c.flyT = -Math.random()*0.25; c.flyTime = FLY_TIME*(0.8 + Math.random()*0.5); c.curve = CURVE*(0.7 + Math.random()*0.6);
  c.xPow = 2 + Math.random()*2; c.dx = (Math.random() - 0.5)*30; c.sway = (Math.random() - 0.5)*120; c.spinRate = SPIN*(0.7 + Math.random()*0.6); c.sx = sx; c.sy = sy; c.dist = m.position.distanceTo(camera.position); c.spin = 0;
  const startPx = RADIUS*2/(2*c.dist*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2))*innerHeight;
  c.endScale = 0.5 + 0.5*END_PX/Math.max(1, startPx); // (halfway between its size there and END_PX)
  playSound('coin', ear);
  // (drawn last, over everything: in the see-through pass, after faded paths and the like, which would otherwise paint over it)
  Object.assign(m.material, { transparent: true, depthTest: false, depthWrite: false, needsUpdate: true }); m.renderOrder = 999;
}
// the coin taken by person p, into their wallet: drawn into them
function startGrab(c, p) {
  c.state = 'grab'; c.grabber = p; c.grabT = 0; c.from = c.mesh.position.clone();
  playSound('coinspin', c.mesh.position, 0.6);
}
// what's possessed, if anything, and how near it picks coins up: a person, a driven car, or anything flown
function collector() {
  const p = possession.index >= 0 ? people[possession.index] : null;
  if (p) return { x: p.x, y: p.y, z: p.z, reach: TAKE_REACH*S.peopleSize, person: p };
  if (drivenCar) return { x: drivenCar.x, y: drivenCar.y ?? null, z: drivenCar.z, reach: CAR_REACH };
  const at = flying.active ? flying.at?.() : null;
  return at ? { x: at.x, y: at.y, z: at.z, reach: FLY_REACH } : null;
}
const near = (c, x, y, z, reach) => (c.mesh.position.x - x)**2 + (c.mesh.position.z - z)**2 < reach*reach && (y == null || Math.abs(c.floor - y) < UP_REACH + reach);
// passers-by near a pile: refuse fresh coins (unless evil) or take what's in reach (see the top of this file)
let checkIn = 0;
function passersBy(t) {
  if (!piles.length) return;
  const reach = TAKE_REACH*S.peopleSize, notice = NOTICE*S.peopleSize, around = PILE_REACH*S.peopleSize;
  for (const pile of piles) {
    const recent = t - pile.born < RECENT;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (i === possession.index || isGone(p) || p.indoors || Math.abs(p.x - pile.x) > around || Math.abs(p.z - pile.z) > around) continue;
      const evil = standingOf(p) !== 'innocent';
      for (const c of coins) {
        if (c.pile !== pile || c.state !== 'rest') continue;
        if (recent && !evil) {
          if (!pile.refused.has(p.id) && near(c, p.x, p.y, p.z, notice)) { pile.refused.add(p.id); feel(p, 'leftmoney'); }
          continue;
        }
        if (!near(c, p.x, p.y, p.z, reach)) continue;
        startGrab(c, p);
        if (!pile.took.has(p.id)) { pile.took.add(p.id); feel(p, recent ? 'lootedbody' : 'foundmoney'); }
      }
    }
  }
}

let last = 0;
/** Each frame (main.js). @param {number} t - seconds */
export function updateCoins(t) {
  const dt = Math.min(0.05, last ? t - last : 0); last = t;
  if (!coins.length) return;
  // (hovering only with the pointer free: while something's possessed, it picks coins up by going near them)
  const locked = !!document.pointerLockElement;
  const px = locked ? -1e4 : pointer.x, py = locked ? -1e4 : pointer.y;
  if ((checkIn -= dt) <= 0) { checkIn = CHECK_EVERY; passersBy(t); }
  const by = collector();
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i], m = c.mesh;
    if (c.state === 'fall') {
      c.vy -= GRAVITY*dt;
      m.position.x += c.vx*dt; m.position.y += c.vy*dt; m.position.z += c.vz*dt;
      m.rotation.x += c.tumble.x*dt; m.rotation.y += c.tumble.y*dt; m.rotation.z += c.tumble.z*dt;
      const floor = c.ground + LIFT + THICK/2;
      if (m.position.y <= floor && c.vy < 0) {
        m.position.y = floor;
        if (!c.bounced && c.vy < -2) { c.bounced = true; c.vy *= -0.3; c.vx *= 0.4; c.vz *= 0.4; c.tumble.multiplyScalar(0.3); }
        else Object.assign(c, { state: 'rest', floor, stage: 'flat', hy: 0, hv: 0, bounces: 0, hopIn: 0.25 + Math.random(), wt: 0, air: 0, airTime: 1, flip: 0, flipRate: 0, prec: Math.random()*6, yaw: Math.random()*6 });
      }
    }
    if (c.state === 'rest') {
      // a cycle, one fluid movement: flat and still; hops up (now and then extra high, with a flip), tipping over as it
      // rises and circling ever faster till it lands, fastest then; then wobbles down flush, slowing to a stop
      let tilt = 0;
      if (c.stage === 'flat' && (c.hopIn -= dt) <= 0) {
        c.stage = 'air'; c.air = 0;
        const high = Math.random() < FLIP_CHANCE;
        c.hv = high ? 3 + Math.random() : 1.2 + Math.random()*0.6;
        c.airTime = 2*c.hv/GRAVITY;
        c.flip = 0; c.flipRate = high ? Math.PI*2/c.airTime : 0;
      } else if (c.stage === 'air') {
        c.hv -= GRAVITY*dt; c.hy += c.hv*dt; c.flip += c.flipRate*dt;
        const a = Math.min(1, (c.air += dt)/c.airTime);
        tilt = TILT*Math.min(1, a*2)**2*(3 - 2*Math.min(1, a*2)); // (tipped over by the top of the hop)
        c.prec += dt*WHIRL*a**1.5;
        if (c.hy <= 0) { c.hy = 0; c.flip = c.flipRate = 0; c.stage = 'wobble'; c.wt = 0; tinkle(m.position, 0.35); }
      } else if (c.stage === 'wobble') {
        const u = Math.min(1, c.wt += dt/WOBBLE_TIME);
        tilt = TILT*(1 - u)**1.5;
        c.prec += dt*WHIRL*(1 - u);
        if (Math.random() < dt*8*(1 - u)) tinkle(m.position, 0.2*(1 - u) + 0.05); // (rattling as it whirls)
        if (u >= 1) { c.stage = 'flat'; c.hopIn = 0.5 + Math.random()*1.25; }
      }
      yawQ.setFromAxisAngle(Y, c.yaw);
      m.quaternion.setFromAxisAngle(axis.set(Math.cos(c.prec), 0, Math.sin(c.prec)), tilt).multiply(yawQ).multiply(spinQ.setFromAxisAngle(X, c.flip));
      m.position.y = c.floor + c.hy + RADIUS*Math.sin(tilt);
      // glints as its face turns toward the view (and the sun)
      n.set(0, 1, 0).applyQuaternion(m.quaternion);
      h.copy(camera.position).sub(m.position).normalize().multiplyScalar(2).add(v.copy(sunOffset).normalize()).normalize();
      m.material.emissiveIntensity = Math.max(0, n.dot(h))**40*1.2;
      v.copy(m.position).project(camera);
      const seen = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
      // (out of view a while: gone, into the lost change; sooner the further off, almost at once a long way away)
      if (seen) c.unseen = 0;
      else {
        const d = m.position.distanceTo(camera.position);
        if ((c.unseen += dt) > Math.max(LOST_MIN, LOST_AFTER*Math.min(1, Math.exp(-(d - LOST_NEAR)/LOST_FALLOFF)))) { removeCoin(i, true); continue; }
      }
      const sx = (v.x + 1)/2*innerWidth, sy = (1 - v.y)/2*innerHeight;
      if (by && near(c, by.x, by.y, by.z, by.reach)) { if (by.person) startGrab(c, by.person); else startFly(c, sx, sy); }
      else if (seen && (sx - px)**2 + (sy - py)**2 < HOVER_PX*HOVER_PX) startFly(c, sx, sy);
      continue;
    }
    if (c.state === 'grab') {
      // (drawn into whoever took it, shrinking, then in their wallet)
      const p = c.grabber, f = Math.min(1, (c.grabT += dt)/GRAB_TIME);
      v.set(p.x, p.y + 0.9*p.height*S.peopleSize, p.z);
      m.position.lerpVectors(c.from, v, f*f);
      m.position.y += Math.sin(Math.PI*f)*0.3;
      m.scale.setScalar(1 - 0.8*f);
      m.rotation.y += dt*20;
      if (f >= 1) {
        p.wallet = (p.wallet ?? 0) + KINDS[c.kind].value;
        if (people.indexOf(p) === possession.index) playSound('coin', ear, 0.5);
        removeCoin(i, false);
      }
      continue;
    }
    if (c.state === 'fly') {
      if ((c.flyT += dt/c.flyTime) < 0) continue;
      const f = Math.min(1, c.flyT);
      const box = moneyEl?.getBoundingClientRect();
      const tx = (box ? box.left + box.width/2 : innerWidth/2) + c.dx;
      const endY = -60; // (off the top)
      // across first, then shooting up: an exponential curve (x eases out, y grows exponentially)
      const sx = c.sx + (tx - c.sx)*(1 - (1 - f)**c.xPow) + c.sway*Math.sin(Math.PI*f), sy = c.sy + (endY - c.sy)*expo(f, c.curve);
      worldAt(sx, sy, c.dist, m.position);
      m.scale.setScalar(1 + (c.endScale - 1)*f);
      c.spin += c.spinRate*dt*(1 + f);
      spinQ.setFromAxisAngle(Y, c.spin);
      m.quaternion.copy(camera.quaternion).multiply(spinQ).multiply(FLAT_TO_VIEW);
      const glint = Math.abs(Math.cos(c.spin))**24; // (a flash each time the face turns to the view)
      m.material.emissiveIntensity = glint*1.2;
      if (f >= 1 || sy < -30) { addMoney(KINDS[c.kind].value); shakeMoney(); removeCoin(i, false); }
    }
  }
}
