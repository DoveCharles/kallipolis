import { camera } from '../core/scene.js';
import { listener } from './sfx.js';

// ============================================================ buzzing
// The buzz of the bees flying near the camera (see updateBees in life/bees.js), a loop synthesized live like the engines
// (see engine.js): a sawtooth through a bandpass, its pitch wavering a little as a real bee's does and rising the faster it
// flies, its loudness fluttering with the wingbeats. A smaller bee buzzes higher, and an angry one higher and louder still.
// Bees are small, so they're heard only close up: each fades to nothing by HEAR_DISTANCE. There are BUZZES_MAX buzzes,
// handed each frame to the nearest bees in the air; a bee sat on a flower or in its hive is quiet.
const BUZZ_HZ = 220;              // an ordinary bee's pitch, cruising
const HEAR_DISTANCE = 6, REF_DISTANCE = 0.6;
const VOLUME = 0.12;
const BUZZES_MAX = 4;
const WAVER_HZ = 6, WAVER = 0.03;  // how fast and how far (against its pitch) the buzz wavers
const FLUTTER_HZ = 13;             // wingbeats a second, heard as a flutter in its loudness

const buzzes = []; // { out, oscillator, filter, panner, bee }

function makeBuzz() {
  const context = listener.context;
  const oscillator = context.createOscillator(), filter = context.createBiquadFilter(), out = context.createGain();
  oscillator.type = 'sawtooth';
  oscillator.frequency.value = BUZZ_HZ;
  filter.type = 'bandpass';
  filter.frequency.value = 900;
  filter.Q.value = 0.8;
  out.gain.value = 0;
  // (the waver: a slow wobble on its pitch; the flutter: a quick one on its loudness, a quarter of the way down and back)
  const waver = context.createOscillator(), waverDepth = context.createGain();
  waver.frequency.value = WAVER_HZ*(0.8 + Math.random()*0.4);
  waverDepth.gain.value = BUZZ_HZ*WAVER;
  waver.connect(waverDepth).connect(oscillator.frequency);
  const flutter = context.createOscillator(), flutterDepth = context.createGain(), level = context.createGain();
  flutter.frequency.value = FLUTTER_HZ;
  flutterDepth.gain.value = 0.25;
  level.gain.value = 0.75;
  flutter.connect(flutterDepth).connect(level.gain);
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'linear';
  panner.refDistance = REF_DISTANCE;
  panner.maxDistance = HEAR_DISTANCE;
  oscillator.connect(filter).connect(level).connect(out).connect(panner).connect(listener.getInput());
  [oscillator, waver, flutter].forEach(o => o.start());
  return { out, oscillator, filter, panner, bee: null };
}

/**
 * One frame of the buzzing: hand the buzzes to the nearest bees in the air, and set each one's pitch and loudness.
 * @param {{bee: object, x: number, y: number, z: number, speed: number, size: number, angry: boolean}[]} flying - every
 *   bee in the air: where it is, how fast it's going against its usual cruising speed, how big it is against an ordinary
 *   bee, and whether it's out for revenge
 * @returns {void}
 */
export function updateBuzzes(flying) {
  const { x, y, z } = camera.position;
  const near = flying
    .map(f => ({ f, d: Math.hypot(f.x - x, f.y - y, f.z - z) }))
    .filter(n => n.d <= HEAR_DISTANCE)
    .sort((a, b) => a.d - b.d).slice(0, BUZZES_MAX).map(n => n.f);
  if (!near.length && !buzzes.some(b => b.bee)) return;
  while (buzzes.length < Math.min(BUZZES_MAX, near.length)) buzzes.push(makeBuzz());
  const now = listener.context.currentTime;
  // (as with the engines: a bee that had a buzz keeps it, and those new to one take over the ones let go)
  buzzes.forEach(b => { if (b.bee && !near.some(f => f.bee === b.bee)) b.bee = null; });
  near.forEach(f => { if (!buzzes.some(b => b.bee === f.bee)) buzzes.find(b => !b.bee).bee = f.bee; });
  for (const b of buzzes) {
    const f = b.bee && near.find(n => n.bee === b.bee);
    if (!f) { b.out.gain.setTargetAtTime(0, now, 0.1); continue; }
    const hz = BUZZ_HZ*(0.85 + 0.3*Math.min(1.5, f.speed))*(f.angry ? 1.25 : 1)/Math.sqrt(Math.max(0.5, f.size));
    b.oscillator.frequency.setTargetAtTime(hz, now, 0.05);
    b.filter.frequency.setTargetAtTime(hz*4, now, 0.05);
    b.out.gain.setTargetAtTime(VOLUME*(f.angry ? 1.5 : 1), now, 0.08);
    b.panner.positionX.value = f.x; b.panner.positionY.value = f.y; b.panner.positionZ.value = f.z;
  }
}
