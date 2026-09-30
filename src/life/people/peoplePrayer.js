import * as THREE from 'three';
import { App } from '../../core/shared.js';
import { scene } from '../../core/scene.js';
import { controls } from '../../core/camera-controls.js';
import { followed, isDrawn, people, peopleRng, wrapAngle } from './people.js';
import { inWater } from './peopleWater.js';
import { personHeight } from './peopleTracking.js';

// ============================================================ praying
// Now and then someone stands still and glows for a while. Clicked (peopleTracking.js followPersonAt), the camera locks
// on their face (no card) and they say a prayer (speech/prayers.txt, said from people.js); once said, 1 energy (past the
// cap: ui/energy.js addEnergy) and their card comes up.
const PRAY_CHANCE = 1/8000;    // per eligible person per second
const MAX_PRAYING = 3;
const PRAY_TIME = [25, 40];   // seconds, unwatched
const WAIT_LINE = 8;          // seconds watched without a line (none to be had) before it ends anyway
const AFTER_LINE = 1.5;       // seconds held after the prayer's said
const FADE = 1;               // glow fade in/out, seconds
const VIEW_RADIUS = 2.6, VIEW_PHI = Math.PI/2 - 0.12; // camera distance (× height) and angle from above, on their face

const praying = new Set(); // (those praying)
let viewing = -1;

const glowTexture = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
// (a beam of light up into the sky from them: fades out upwards)
const BEAM_HEIGHT = 300, BEAM_WIDTH = 0.35; // (width × their height)
const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0);
const beamTexture = (() => {
  const c = document.createElement('canvas'); c.width = 1; c.height = 128;
  const g = c.getContext('2d'), r = g.createLinearGradient(0, 128, 0, 0);
  r.addColorStop(0, '#fff'); r.addColorStop(0.15, '#aaa'); r.addColorStop(1, '#000');
  g.fillStyle = r; g.fillRect(0, 0, 1, 128);
  return new THREE.CanvasTexture(c);
})();
const makeBeam = () => {
  const m = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({ color: 0xffe9a8, alphaMap: beamTexture, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.frustumCulled = false;
  scene.add(m);
  return m;
};
const makeGlow = () => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: 0xffe28a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  scene.add(s);
  return s;
};

const now = () => performance.now()/1000;
const free = (p, possessed) => !possessed && (p.mode === 'line' || p.mode === 'wander') && !p.act && !p.group && !p.follow && !p.jc && !p.crossStage
  && !p.fright && !p.stun && !p.please && !p.punched && !p.attack && !p.traits.terrified && !inWater(p);

/**
 * Start, run or end someone's prayer, each frame (before `frozen` in updatePeople, which holds them while p.pray).
 * @param {Person} p
 * @param {number} i - their index in people
 * @param {number} dt
 * @param {boolean} possessed
 * @returns {void}
 */
export function updatePrayer(p, i, dt, possessed) {
  const pray = p.pray;
  if (!pray) {
    if (praying.size < MAX_PRAYING && peopleRng() < PRAY_CHANCE*dt && free(p, possessed) && isDrawn(p)) {
      p.pray = { start: now(), until: now() + PRAY_TIME[0] + peopleRng()*(PRAY_TIME[1] - PRAY_TIME[0]), watched: false, said: false, heard: false, glow: makeGlow(), beam: makeBeam() };
      p.faceTo = null; p.wait = 0;
      praying.add(p);
    }
    return;
  }
  if (!free(p, possessed)) { endPrayer(p, i); return; }
  const t = now();
  // (the prayer's said: held a moment, then energy — see people.js for the saying)
  if (pray.said && !p.saying && !pray.heard) { pray.heard = true; pray.until = t + AFTER_LINE; }
  if (pray.watched && !pray.said && t > pray.watchedAt + WAIT_LINE) pray.until = Math.min(pray.until, t);
  if (t >= pray.until) { endPrayer(p, i); return; }
  const g = pray.glow, h = personHeight(p);
  g.visible = isDrawn(p);
  g.position.set(p.x, p.y + h*0.55, p.z);
  g.scale.setScalar(h*(1.7 + 0.08*Math.sin(t*3)));
  const fade = Math.max(0, Math.min(1, (t - pray.start)/FADE, (pray.until - t)/FADE));
  g.material.opacity = fade*(0.75 + 0.15*Math.sin(t*2.3));
  const b = pray.beam;
  b.visible = g.visible;
  b.position.set(p.x, p.y, p.z);
  b.scale.set(h*BEAM_WIDTH, BEAM_HEIGHT, h*BEAM_WIDTH);
  b.material.opacity = fade*(0.55 + 0.1*Math.sin(t*1.7));
}

function endPrayer(p, i) {
  const pray = p.pray;
  p.pray = null; praying.delete(p);
  dropGlow(pray);
  if (pray.heard) App.addEnergy?.(1, true);
  if (viewing === i && followed === i) App.followPerson(i); // (their card, now: see peopleTracking.js)
  else if (viewing === i) endPrayerView();
}

const dropGlow = pray => { scene.remove(pray.glow, pray.beam); pray.glow.material.dispose(); pray.beam.material.dispose(); };

/** Drop the prayers of anyone gone from the crowd (replaced or popped), once a frame. @returns {void} */
export function sweepPrayers() {
  for (const p of praying) if (!people.includes(p)) { dropGlow(p.pray); p.pray = null; praying.delete(p); }
  if (viewing >= people.length || (viewing >= 0 && !people[viewing].pray)) endPrayerView();
}

/** Whether someone's praying and not yet clicked on. @param {Person} p @returns {boolean} */
export const awaitsWatcher = p => !!p.pray && !p.pray.watched;

/** Lock the camera on a praying person's face, no card (from followPersonAt). @param {number} i @returns {void} */
export function watchPrayer(i) {
  const pray = people[i].pray;
  pray.watched = true; pray.watchedAt = now();
  pray.until = Infinity; // (till the prayer's said: see updatePrayer)
  viewing = i;
  controls.locked = true; // (no orbit, zoom or pan: fixed distance)
  controls.minRadius = 0.5;
}

/** Let go of the prayer view (following ended or moved on). @returns {void} */
export function endPrayerView() {
  if (viewing < 0) return;
  viewing = -1;
  controls.locked = false;
}

/** Whether the camera's on someone's prayer. @param {number} i @returns {boolean} */
export const prayerViewing = i => viewing >= 0 && viewing === i;

/** Whether this watched person's prayer is due to be said (people.js calls shoutLine 'prayers'). @param {Person} p @returns {boolean} */
export const prayerDue = p => !!p.pray?.watched && !p.pray.said && Math.abs(controls.radius - controls.goalRadius) < 0.3; // (once the camera's in on their face)

/** Aim the camera at a watched praying person's face, from in front. @param {Person} p @returns {void} */
export function aimPrayerView(p) {
  const h = personHeight(p);
  controls.goalTarget.set(p.x, p.y + h*0.9, p.z);
  controls.goalRadius = h*VIEW_RADIUS;
  controls.goalTheta = controls.theta + wrapAngle(p.heading - controls.theta);
  controls.goalPhi = VIEW_PHI;
}
