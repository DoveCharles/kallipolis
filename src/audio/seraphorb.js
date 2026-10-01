import { listener, outdoorsOf, ear, loopPanning, placePanner, makePanner } from './sfx.js';

// ============================================================ the Seraphorb's hum
// Each orb near the camera (see life/seraphorb.js): a low throbbing hum — sines on a root, fifth and octave, and a
// soft sawtooth through a lowpass — its loudness pulsed by a slow sine. Chasing a villain it's CHASE_PITCH higher and
// throbs faster; charging in its ring, it's quieter and slower. Nearest VOICES_MAX orbs get one.
const HEAR = 60, REF = 3;
const VOICES_MAX = 2;
const HUM_HZ = 55, HUM_VOLUME = 0.07;
const CHASE_PITCH = 1.6, SMITE_PITCH = 2.1;  // × HUM_HZ chasing, and hovering over them about to strike
const THROB_HZ = 1.4, CHASE_THROB_HZ = 3.5;  // pulses a second
const PARTIALS = [[1, 0.6], [1.5, 0.25], [2, 0.3], [3.01, 0.08]]; // × pitch, loudness

const voices = []; // { orb, out, oscs, saw, lowpass, throb, depth }

function makeVoice() {
  const context = listener.context;
  const p = makePanner(context, loopPanning());
  p.distanceModel = 'linear'; p.refDistance = REF; p.maxDistance = HEAR;
  p.connect(outdoorsOf('peds'));
  const gain = value => { const g = context.createGain(); g.gain.value = value; return g; };
  const started = [];
  const osc = (type, hz) => { const o = context.createOscillator(); o.type = type; o.frequency.value = hz; started.push(o); return o; };
  const out = gain(0), pulse = gain(0.6);
  pulse.connect(out).connect(p);
  const oscs = PARTIALS.map(([times, loud]) => { const o = osc('sine', HUM_HZ*times); o.connect(gain(loud)).connect(pulse); return [o, times]; });
  const saw = osc('sawtooth', HUM_HZ), lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass'; lowpass.frequency.value = HUM_HZ*4; lowpass.Q.value = 4;
  saw.connect(lowpass).connect(gain(0.2)).connect(pulse);
  // the throb: a sine on the pulse's loudness
  const throb = osc('sine', THROB_HZ), depth = gain(0.4);
  throb.connect(depth).connect(pulse.gain);
  started.forEach(o => o.start());
  return { orb: null, panner: p, out, oscs, saw, lowpass, throb, depth };
}

/**
 * The orbs' hum, each frame.
 * @param {{orb: object, x: number, y: number, z: number, chasing: boolean, smiting: boolean, charging: boolean}[]} orbs
 * @returns {void}
 */
export function updateSeraphorbSounds(orbs) {
  const { x, y, z } = ear;
  const near = orbs
    .map(o => ({ o, d: Math.hypot(o.x - x, o.y - y, o.z - z) }))
    .filter(n => n.d <= HEAR)
    .sort((a, b) => a.d - b.d).slice(0, VOICES_MAX).map(n => n.o);
  if (!near.length && !voices.some(v => v.orb)) return;
  while (voices.length < Math.min(VOICES_MAX, near.length)) voices.push(makeVoice());
  const now = listener.context.currentTime;
  voices.forEach(v => { if (v.orb && !near.some(o => o.orb === v.orb)) v.orb = null; });
  near.forEach(o => { if (!voices.some(v => v.orb === o.orb)) voices.find(v => !v.orb).orb = o.orb; });
  for (const v of voices) {
    const o = v.orb && near.find(n => n.orb === v.orb);
    if (!o) { v.out.gain.setTargetAtTime(0, now, 0.2); continue; }
    placePanner(v.panner, o.x, o.y, o.z);
    const hz = HUM_HZ*(o.smiting ? SMITE_PITCH : o.chasing ? CHASE_PITCH : 1);
    for (const [osc, times] of v.oscs) osc.frequency.setTargetAtTime(hz*times, now, 0.3);
    v.saw.frequency.setTargetAtTime(hz, now, 0.3);
    v.lowpass.frequency.setTargetAtTime(hz*(o.chasing || o.smiting ? 6 : 4), now, 0.3);
    v.throb.frequency.setTargetAtTime(o.smiting ? CHASE_THROB_HZ*2 : o.chasing ? CHASE_THROB_HZ : THROB_HZ*(o.charging ? 0.6 : 1), now, 0.3);
    v.out.gain.setTargetAtTime(HUM_VOLUME*(o.charging ? 0.4 : o.chasing || o.smiting ? 1.3 : 1), now, 0.2);
  }
}
