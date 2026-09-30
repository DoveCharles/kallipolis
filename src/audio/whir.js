import { listener, heardFrom, isMuted, loopPanning } from './sfx.js';

// ============================================================ the bots' whir
// The bar bot's and the waiter bot's wheels (see buildings/barbot.js, buildings/waiterbot.js), a loop synthesized live
// like the MedBots' boots (medbot.js), roomba-ish: the drive motors' whine (two triangles, a touch over an octave apart,
// through a bandpass), rising with speed from WHINE_HZ by WHINE_RISE, over a soft rumble of the wheels on the floor
// (noise through a lowpass). One voice per bot, only while the view's in its room.
const HEAR = 14, REF = 1.2;
const VOLUME = 0.035, RUMBLE = 0.5;     // the whole whir at full speed; the rumble against the whine
const WHINE_HZ = 120, WHINE_RISE = 140;

const voices = {};
let noise = null;

function makeVoice() {
  const context = listener.context;
  if (!noise) {
    noise = context.createBuffer(1, context.sampleRate*2, context.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random()*2 - 1;
  }
  const panner = context.createPanner();
  Object.assign(panner, { panningModel: loopPanning(), distanceModel: 'linear', refDistance: REF, maxDistance: HEAR });
  const out = context.createGain();
  out.gain.value = 0;
  out.connect(panner);

  const a = context.createOscillator(), b = context.createOscillator(), band = context.createBiquadFilter();
  a.type = b.type = 'triangle';
  band.type = 'bandpass'; band.Q.value = 1.2;
  const bGain = context.createGain();
  bGain.gain.value = 0.35;
  a.connect(band); b.connect(bGain).connect(band); band.connect(out);

  const floor = context.createBufferSource(), low = context.createBiquadFilter(), rumble = context.createGain();
  floor.buffer = noise; floor.loop = true;
  low.type = 'lowpass'; low.frequency.value = 280;
  rumble.gain.value = RUMBLE;
  floor.connect(low).connect(rumble).connect(out);

  [a, b, floor].forEach(o => o.start());
  return { panner, out, a, b, band, to: null };
}

/**
 * One frame of a bot's whir.
 * @param {string} key - which bot ('bar' or 'waiter')
 * @param {?{x: number, y: number, z: number}} at - where it is, in the world; null while it's out of hearing (fades out)
 * @param {number} k - how fast it's going or turning, 0 still to 1 flat out
 * @returns {void}
 */
export function botWhir(key, at, k) {
  const context = listener.context;
  if (isMuted()) at = null;
  if ((!at && !voices[key]) || context.state !== 'running') return;
  const v = voices[key] ??= makeVoice(), now = context.currentTime;
  if (!at) { v.out.gain.setTargetAtTime(0, now, 0.1); return; }
  const to = heardFrom(at, 'peds');
  if (to !== v.to) { if (v.to) v.panner.disconnect(); v.panner.connect(to); v.to = to; }
  v.panner.positionX.value = at.x; v.panner.positionY.value = at.y + 0.3; v.panner.positionZ.value = at.z;
  k = Math.min(1, k);
  const hz = WHINE_HZ + WHINE_RISE*k;
  v.a.frequency.setTargetAtTime(hz, now, 0.15);
  v.b.frequency.setTargetAtTime(hz*2.03, now, 0.15);
  v.band.frequency.setTargetAtTime(hz*1.6, now, 0.15);
  v.out.gain.setTargetAtTime(VOLUME*Math.sqrt(k), now, k ? 0.06 : 0.12);
}
