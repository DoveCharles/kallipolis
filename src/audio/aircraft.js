import * as THREE from 'three';
import { camera } from '../core/scene.js';
import { listener } from './sfx.js';

// ============================================================ aircraft
// The aircraft about the airfields (see updateAirports in zones/airport.js): loops synthesized live like the engines (see
// engine.js), each built from the same few layers mixed differently for what it is —
// - a jet: a roar of noise, darker at idle and opening out as it's run up, under the whine of its turbines, two tones
//   a little off a fifth apart that climb with the power
// - a propeller aeroplane: the buzz of its engine, a sawtooth muffled more or less with the throttle, with a little of
//   the roar for the air it's pushing
// - a helicopter: the roar chopped up by its blades into a "whup-whup-whup", over a thin turbine whine
// How hard it's working (its thrust, 0 to 1) comes from wherever it is in its round — silent on its stand, spooling up
// through the pushback, a grumble taxiing, the full roar down the runway and away, the reversers on landing — or from
// the keys, for one being flown by hand. The pitch and loudness follow that slowly, as a turbine spools, not at once.
// There are AIRCRAFT_MAX loops, handed each frame to the nearest aircraft within HEAR_DISTANCE; they carry a long way.
const VOLUME = 0.16;
const HEAR_DISTANCE = 600;
const AIRCRAFT_MAX = 4;
const SPOOL = 0.8;       // seconds the engines take to follow the thrust (a third of the way, that is)
const CHOP_HZ = 11;      // a helicopter's blade passes a second
const KINDS = {
  //         roar: how loud, and its lowpass at idle and at full power; whine: how loud, and its pitch at idle and at full;
  //         buzz: likewise; chop: how deep; and how near to be heard at full volume
  jet:  { roar: [0.9, 250, 2200], whine: [0.06, 900, 3000], buzz: [0, 0, 0], chop: 0, near: 30 },
  prop: { roar: [0.3, 400, 900], whine: [0, 0, 0], buzz: [0.5, 55, 110], chop: 0, near: 25 },
  heli: { roar: [0.8, 500, 800], whine: [0.03, 1200, 1500], buzz: [0, 0, 0], chop: 0.75, near: 20 },
};

const voices = []; // { out, roar, roarFilter, whines, buzz, buzzFilter, buzzGain, chop, chopDepth, panner, object }
let noise = null;
const where = new THREE.Vector3();

function makeVoice() {
  const context = listener.context;
  if (!noise) {
    noise = context.createBuffer(1, context.sampleRate*2, context.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random()*2 - 1;
  }
  const out = context.createGain();
  out.gain.value = 0;
  // (the chop: a gain taken most of the way down and back at each blade pass, for a helicopter; left open for the rest)
  const chop = context.createGain(), lfo = context.createOscillator(), chopDepth = context.createGain();
  lfo.frequency.value = CHOP_HZ;
  chopDepth.gain.value = 0;
  lfo.connect(chopDepth).connect(chop.gain);
  lfo.start();
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  chop.connect(out).connect(panner).connect(listener.getInput());
  const source = context.createBufferSource(), roarFilter = context.createBiquadFilter(), roar = context.createGain();
  source.buffer = noise;
  source.loop = true;
  roarFilter.type = 'lowpass';
  roarFilter.Q.value = 0.7;
  roar.gain.value = 0;
  source.connect(roarFilter).connect(roar).connect(chop);
  source.start(0, Math.random()*2);
  const whines = [1, 1.51].map(ratio => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(chop);
    oscillator.start();
    return { oscillator, gain, ratio };
  });
  const buzz = context.createOscillator(), buzzFilter = context.createBiquadFilter(), buzzGain = context.createGain();
  buzz.type = 'sawtooth';
  buzzFilter.type = 'lowpass';
  buzzGain.gain.value = 0;
  buzz.connect(buzzFilter).connect(buzzGain).connect(chop);
  buzz.start();
  return { out, roar, roarFilter, whines, buzz, buzzFilter, buzzGain, chop, chopDepth, panner, object: null };
}

/**
 * One frame of the aircraft's sound: hand the loops to the nearest, and set each one's roar, whine, buzz and chop from
 * what it is and how hard it's working.
 * @param {{object: THREE.Object3D, kind: 'jet'|'prop'|'heli', thrust: number}[]} flying - every aircraft to be heard
 * @returns {void}
 */
export function updateAircraftSounds(flying) {
  const near = flying
    .map(f => { f.object.getWorldPosition(where); return { ...f, at: where.clone(), d: where.distanceTo(camera.position) }; })
    .filter(n => n.d <= HEAR_DISTANCE)
    .sort((a, b) => a.d - b.d).slice(0, AIRCRAFT_MAX);
  if (!near.length && !voices.some(v => v.object)) return;
  while (voices.length < Math.min(AIRCRAFT_MAX, near.length)) voices.push(makeVoice());
  const now = listener.context.currentTime;
  voices.forEach(v => { if (v.object && !near.some(n => n.object === v.object)) v.object = null; });
  near.forEach(n => {
    if (voices.some(v => v.object === n.object)) return;
    const free = voices.find(v => !v.object);
    free.object = n.object;
    free.out.gain.cancelScheduledValues(now);
    free.out.gain.setValueAtTime(0, now); // (a voice taken over starts from silence rather than the last one's roar)
  });
  for (const v of voices) {
    const n = v.object && near.find(m => m.object === v.object);
    if (!n) { v.out.gain.setTargetAtTime(0, now, 0.3); continue; }
    const kind = KINDS[n.kind] ?? KINDS.jet, p = Math.max(0, Math.min(1, n.thrust));
    const span = ([level, idle, full]) => [level, idle + (full - idle)*p];
    const [roar, cutoff] = span(kind.roar), [whine, whineHz] = span(kind.whine), [buzz, buzzHz] = span(kind.buzz);
    v.roar.gain.setTargetAtTime(roar*(0.4 + 0.6*p*p), now, SPOOL);
    v.roarFilter.frequency.setTargetAtTime(cutoff, now, SPOOL);
    v.whines.forEach(({ oscillator, gain, ratio }, k) => {
      oscillator.frequency.setTargetAtTime(Math.max(1, whineHz*ratio), now, SPOOL);
      gain.gain.setTargetAtTime(whine*(k ? 0.5 : 1), now, SPOOL);
    });
    v.buzz.frequency.setTargetAtTime(Math.max(1, buzzHz), now, SPOOL/2);
    v.buzzFilter.frequency.setTargetAtTime(300 + 1200*p, now, SPOOL/2);
    v.buzzGain.gain.setTargetAtTime(buzz, now, SPOOL/2);
    v.chopDepth.gain.setTargetAtTime(kind.chop/2, now, 0.1);
    v.chop.gain.setTargetAtTime(1 - kind.chop/2, now, 0.1);
    v.panner.refDistance = kind.near;
    v.out.gain.setTargetAtTime(n.thrust > 0 ? VOLUME*(0.35 + 0.65*p) : 0, now, SPOOL);
    v.panner.positionX.value = n.at.x; v.panner.positionY.value = n.at.y; v.panner.positionZ.value = n.at.z;
  }
}
