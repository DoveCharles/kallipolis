import * as THREE from 'three';
import { camera } from '../core/scene.js';
import { listener, outdoorsOf, inside } from './sfx.js';

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
// Far off, it's the air that shapes it: the highs are soaked up the further it has to come (the whine and hiss go first,
// leaving the low roll of the roar, with its bass lifted), the rumble swells and fades as the air it crosses churns, and
// the echo off the ground, a few milliseconds behind, sweeps a comb through it as the aircraft's height and distance
// change — the "whooshing" of an airliner heard from miles away.
const VOLUME = 0.16;
const HEAR_DISTANCE = 1500;
const AIRCRAFT_MAX = 4;
const SPOOL = 0.8;       // seconds the engines take to follow the thrust (a third of the way, that is)
const CHOP_HZ = 11;      // a helicopter's blade passes a second
const AIR = 250;         // distance over which the air takes the top off: most of the way to a rumble by here
const AIR_FLOOR = 180;   // the lowpass, in hertz, from right across town
const ROLL = 0.55;       // how deeply the rumble swells and fades when heard from far off
const SOUND_SPEED = 343; // for the ground echo's delay (a unit is about a metre)
const EAR = 1.7;         // how high the ear is at the least
const KINDS = {
  //         roar: how loud, and its lowpass at idle and at full power; whine: how loud, and its pitch at idle and at full;
  //         buzz: likewise; chop: how deep; how near to be heard at full volume; and how much louder at full power than
  //         idling (a jet taking off, climbing out or coming in to land is heard right across town)
  jet:  { roar: [0.9, 250, 2200], whine: [0.06, 900, 3000], buzz: [0, 0, 0], chop: 0, near: 90, loud: 2.2 },
  prop: { roar: [0.3, 400, 900], whine: [0, 0, 0], buzz: [0.5, 55, 110], chop: 0, near: 25, loud: 1 },
  heli: { roar: [0.8, 500, 800], whine: [0.03, 1200, 1500], buzz: [0, 0, 0], chop: 0.75, near: 20, loud: 1 },
};

const voices = []; // { out, roar, roarFilter, whines, buzz, buzzFilter, buzzGain, chop, chopDepth, rollDepth, bass, air,
                   //   air2, echo, echoGain, panner, object }
let noise = null, drift = null;
const where = new THREE.Vector3();

function noiseBuffer(context) {
  if (!noise) {
    noise = context.createBuffer(1, context.sampleRate*2, context.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random()*2 - 1;
  }
  return noise;
}

// A slow wander between -1 and 1, a new point every quarter second eased between, looping without a seam: for the
// swelling and fading of a distant rumble.
function driftBuffer(context) {
  if (!drift) {
    const seconds = 16, step = 0.25, points = Array.from({ length: seconds/step }, () => Math.random()*2 - 1);
    drift = context.createBuffer(1, context.sampleRate*seconds, context.sampleRate);
    const data = drift.getChannelData(0), per = context.sampleRate*step;
    for (let i = 0; i < data.length; i++) {
      const k = Math.floor(i/per), t = (i/per - k), a = points[k], b = points[(k + 1) % points.length];
      data[i] = a + (b - a)*(1 - Math.cos(Math.PI*t))/2;
    }
  }
  return drift;
}

function makeVoice() {
  const context = listener.context;
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
  // (then the air: the rumble's roll, the bass lifted and the top taken off with distance, and the ground's echo)
  const roll = context.createGain(), rollSource = context.createBufferSource(), rollDepth = context.createGain();
  rollSource.buffer = driftBuffer(context);
  rollSource.loop = true;
  rollSource.playbackRate.value = 0.7 + Math.random()*0.6;
  rollDepth.gain.value = 0;
  rollSource.connect(rollDepth).connect(roll.gain);
  rollSource.start(0, Math.random()*16);
  const bass = context.createBiquadFilter(), air = context.createBiquadFilter(), air2 = context.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 160;
  bass.gain.value = 0;
  [air, air2].forEach(f => { f.type = 'lowpass'; f.Q.value = 0.5; f.frequency.value = 20000; });
  const echo = context.createDelay(0.1), echoGain = context.createGain();
  echoGain.gain.value = 0;
  chop.connect(out).connect(roll).connect(bass).connect(air).connect(air2).connect(panner).connect(outdoorsOf('traffic'));
  air2.connect(echo).connect(echoGain).connect(panner);
  const source = context.createBufferSource(), roarFilter = context.createBiquadFilter(), roar = context.createGain();
  source.buffer = noiseBuffer(context);
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
  return { out, roar, roarFilter, whines, buzz, buzzFilter, buzzGain, chop, chopDepth, rollDepth, bass, air, air2, echo, echoGain, panner, object: null };
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
    v.out.gain.setTargetAtTime(n.thrust > 0 ? VOLUME*(0.35 + (kind.loud - 0.35)*p*p) : 0, now, SPOOL);
    // (the air between: how far it's come, as a fraction of the way to being all rumble)
    const far = 1 - Math.exp(-n.d/AIR), top = AIR_FLOOR + (20000 - AIR_FLOOR)*Math.exp(-n.d/AIR*1.4);
    v.air.frequency.setTargetAtTime(top, now, 0.2);
    v.air2.frequency.setTargetAtTime(top*1.6, now, 0.2);
    v.bass.gain.setTargetAtTime(9*far, now, 0.2);
    v.rollDepth.gain.setTargetAtTime(ROLL*far*far, now, 0.3);
    const ear = Math.max(EAR, camera.position.y), height = Math.max(0, n.at.y);
    const bounce = Math.hypot(n.at.x - camera.position.x, n.at.z - camera.position.z, height + ear) - n.d;
    v.echo.delayTime.setTargetAtTime(Math.min(0.09, Math.max(0.0003, bounce/SOUND_SPEED)), now, 0.1);
    v.echoGain.gain.setTargetAtTime(0.8*far, now, 0.3);
    v.panner.positionX.value = n.at.x; v.panner.positionY.value = n.at.y; v.panner.positionZ.value = n.at.z;
  }
}

// The cabin chime: the "bing-bong" over the speakers once an airliner's up, two soft bell notes falling a third, each a
// pure tone with a faint clang above it and a twin a few hertz off for a shimmer, muffled a little by the speaker. It's
// heard from on board, so it's not placed anywhere.
const CHIME = [988, 784], CHIME_GAP = 0.6, CHIME_RING = 1.6, CHIME_VOLUME = 0.12;
/**
 * The cabin's "bing-bong", as heard on board.
 * @returns {void}
 */
export function cabinChime() {
  const context = listener.context;
  if (context.state !== 'running') return;
  const now = context.currentTime, speaker = context.createBiquadFilter(), gain = context.createGain();
  speaker.type = 'lowpass';
  speaker.frequency.value = 3000;
  gain.gain.value = CHIME_VOLUME;
  speaker.connect(gain).connect(inside('traffic')); // (on board: never through the walls)
  const oscillators = CHIME.flatMap((hz, k) => [[1, 0, 1], [1, 2.5, 0.8], [2.76, 0, 0.08]].map(([ratio, off, level]) => {
    const oscillator = context.createOscillator(), note = context.createGain(), start = now + k*CHIME_GAP;
    oscillator.frequency.value = hz*ratio + off;
    note.gain.setValueAtTime(0, now);
    note.gain.setValueAtTime(0, start);
    note.gain.linearRampToValueAtTime(level/2, start + 0.006);
    note.gain.exponentialRampToValueAtTime(0.0005*level, start + CHIME_RING*(ratio > 2 ? 0.3 : 1));
    oscillator.connect(note).connect(speaker);
    oscillator.start(now);
    oscillator.stop(start + CHIME_RING + 0.05);
    return oscillator;
  }));
  oscillators[oscillators.length - 1].onended = () => gain.disconnect();
}

// The tyres touching down: a chirp from each side of the main gear a moment apart, "errk-errk" — a rush of noise through a
// narrow band sweeping down, with a thin squeal in it — louder and lower for a bigger aircraft.
const CHIRPS = [[0, 1], [0.09, 0.7]]; // [seconds after touching down, how loud]
const CHIRP_TIME = 0.2, CHIRP_VOLUME = 0.35, CHIRP_NEAR = 40, CHIRP_HZ = 2200;
/**
 * The chirp of an aircraft's tyres meeting the runway.
 * @param {{x: number, y: number, z: number}} at - where it touched down
 * @param {number} size - its wingspan
 * @returns {void}
 */
export function tyreChirp(at, size) {
  const context = listener.context;
  if (context.state !== 'running' || Math.hypot(at.x - camera.position.x, at.y - camera.position.y, at.z - camera.position.z) > HEAR_DISTANCE) return;
  const now = context.currentTime, hz = CHIRP_HZ/Math.sqrt(Math.max(0.5, size/20));
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = CHIRP_NEAR;
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;
  panner.connect(outdoorsOf('traffic'));
  const sources = CHIRPS.flatMap(([after, level]) => {
    const start = now + after, end = start + CHIRP_TIME*(0.8 + Math.random()*0.4);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(CHIRP_VOLUME*level, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    gain.connect(panner);
    const source = context.createBufferSource(), band = context.createBiquadFilter();
    source.buffer = noiseBuffer(context);
    band.type = 'bandpass';
    band.Q.value = 6;
    band.frequency.setValueAtTime(hz*1.1, start);
    band.frequency.exponentialRampToValueAtTime(hz*0.7, end);
    source.connect(band).connect(gain);
    source.start(start, Math.random());
    source.stop(end + 0.02);
    const squeal = context.createOscillator(), squealLevel = context.createGain();
    squeal.frequency.setValueAtTime(hz*0.85, start);
    squeal.frequency.exponentialRampToValueAtTime(hz*0.6, end);
    squealLevel.gain.value = 0.15;
    squeal.connect(squealLevel).connect(gain);
    squeal.start(start);
    squeal.stop(end + 0.02);
    return [source, squeal];
  });
  sources[sources.length - 1].onended = () => panner.disconnect();
}
