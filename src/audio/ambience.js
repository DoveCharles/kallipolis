import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { listener, isMuted } from './sfx.js';
import { trafficNearby } from './engine.js';
import { isInsideBuilding } from '../buildings/interior.js';

// ============================================================ ambience
// The city's background: a low hum of traffic, as loud as there are cars about the camera (see trafficNearby in
// engine.js), not coming from anywhere in particular; and, by day, birds singing now and then from somewhere round the
// camera — each a short phrase of whistled notes, of one of a few kinds of song — or at night, crickets. Neither sings in
// rain or snow, and fewer are heard the higher the camera's gone. When it rains there's the rain: a steady wash of hiss,
// and drops pattering close by now and then, both as heavy as the rain is, and muffled (and the drops gone) from inside a
// building. All of it synthesized live, like the engines.
const HUM_VOLUME = 0.03;
const HUM_LOW = 250, HUM_HIGH = 1400; // the band of the hum, in Hz
const HUM_FULL = 12;              // how much traffic nearby (see trafficNearby) makes the hum half as loud as it gets
const BIRD_GAP = 2.5, CRICKET_GAP = 0.9; // mean seconds between one singing and the next, at street level
const QUIET_ABOVE = 250;          // how high the camera goes before it hears no birds or crickets at all
const SONG_VOLUME = 0.12, CRICKET_VOLUME = 0.05;
const SONG_REF_DISTANCE = 12;
const RAIN_VOLUME = 0.1;          // the wash of rain, at its heaviest
const RAIN_HIGH = 7000, RAIN_HIGH_INSIDE = 700; // how high the wash reaches, outside and heard through a building's walls
const DROP_VOLUME = 0.06, DROPS_PER_SECOND = 16; // single drops pattering close by, at the heaviest

let hum = null; // { gain } once made
let nextSong = 0;
let rain = null; // { gain, high, buffer } once made
let lastT = 0;

// a couple of seconds of white noise, its ends faded into each other so it loops without a click
function noiseLoop(context, seconds) {
  const length = context.sampleRate*seconds, blend = context.sampleRate*0.1;
  const buffer = context.createBuffer(1, length, context.sampleRate), data = buffer.getChannelData(0);
  for (let k = 0; k < length; k++) data[k] = Math.random()*2 - 1;
  for (let k = 0; k < blend; k++) { const w = k/blend; data[k] = data[k]*w + data[length - blend + k]*(1 - w); }
  return { buffer, loopEnd: (length - blend)/context.sampleRate };
}

// the wash: white noise with its lows cut, so it hisses rather than roars
function makeRain() {
  const context = listener.context, { buffer, loopEnd } = noiseLoop(context, 2);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopEnd = loopEnd;
  const low = context.createBiquadFilter(), high = context.createBiquadFilter(), gain = context.createGain();
  low.type = 'highpass';
  low.frequency.value = 500;
  high.type = 'lowpass';
  high.frequency.value = RAIN_HIGH;
  gain.gain.value = 0;
  source.connect(low).connect(high).connect(gain).connect(listener.getInput());
  source.start();
  return { gain, high, buffer };
}

// one drop landing near the camera: a tick of noise and, sometimes, a little falling plink as it hits a puddle
function patter(when) {
  const context = listener.context, at = somewhereAround(2, 12, 0, 1);
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = 3;
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;
  panner.connect(listener.getInput());
  const volume = DROP_VOLUME*(0.4 + Math.random()*0.6);
  const source = context.createBufferSource(), band = context.createBiquadFilter(), tick = context.createGain();
  source.buffer = rain.buffer;
  band.type = 'bandpass';
  band.frequency.value = 1500 + Math.random()*4000;
  band.Q.value = 1.5;
  tick.gain.setValueAtTime(volume*3, when);
  tick.gain.exponentialRampToValueAtTime(0.001, when + 0.02);
  source.connect(band).connect(tick).connect(panner);
  source.onended = () => panner.disconnect();
  source.start(when, Math.random()*1.5);
  source.stop(when + 0.03);
  if (Math.random() < 0.3) {
    const f = 1200 + Math.random()*2500;
    whistle(at, when, [[0, 0.018, f, f*0.55]], volume*0.6, 3);
  }
}

// a few seconds of reddish noise (random steps that drift back, so more wash than hiss), evened out to a set loudness, and
// looped through a band of HUM_LOW to HUM_HIGH Hz: the far-off whoosh of tyres on tarmac more than the rumble of engines
function makeHum() {
  const context = listener.context, length = context.sampleRate*3;
  const buffer = context.createBuffer(1, length, context.sampleRate), data = buffer.getChannelData(0);
  let last = 0, power = 0;
  for (let k = 0; k < length; k++) { last = (last + 0.1*(Math.random()*2 - 1))/1.1; data[k] = last; power += last*last; }
  const scale = 0.3/Math.sqrt(power/length);
  for (let k = 0; k < length; k++) data[k] *= scale;
  // (fade the ends into each other so the loop doesn't click)
  const blend = context.sampleRate*0.1;
  for (let k = 0; k < blend; k++) { const w = k/blend; data[k] = data[k]*w + data[length - blend + k]*(1 - w); }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopEnd = (length - blend)/context.sampleRate;
  const high = context.createBiquadFilter(), low = context.createBiquadFilter(), gain = context.createGain();
  high.type = 'highpass';
  high.frequency.value = HUM_LOW;
  low.type = 'lowpass';
  low.frequency.value = HUM_HIGH;
  gain.gain.value = 0;
  source.connect(high).connect(low).connect(gain).connect(listener.getInput());
  source.start();
  return { gain };
}

// A tone played through a panner at `at`: `notes` is [[start, length, from Hz, to Hz]], seconds after `when`.
function whistle(at, when, notes, volume, refDistance = SONG_REF_DISTANCE) {
  const context = listener.context;
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = refDistance;
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;
  panner.connect(listener.getInput());
  const oscillator = context.createOscillator(), gain = context.createGain();
  oscillator.type = 'sine';
  gain.gain.value = 0;
  oscillator.connect(gain).connect(panner);
  let end = when;
  for (const [start, length, from, to] of notes) {
    const a = when + start, b = a + length;
    oscillator.frequency.setValueAtTime(from, a);
    oscillator.frequency.exponentialRampToValueAtTime(to, b);
    gain.gain.setValueAtTime(0, a);
    gain.gain.linearRampToValueAtTime(volume, a + Math.min(0.01, length/3));
    gain.gain.linearRampToValueAtTime(0, b);
    end = Math.max(end, b);
  }
  oscillator.onended = () => panner.disconnect();
  oscillator.start(when);
  oscillator.stop(end + 0.05);
}

// the kinds of song: each gives the notes of one phrase
const SONGS = [
  // chirps: a few quick falling notes
  () => { const f = 3000 + Math.random()*2000, n = 2 + Math.floor(Math.random()*4);
    return Array.from({ length: n }, (_, k) => [k*(0.1 + Math.random()*0.05), 0.06, f*(1 + Math.random()*0.1), f*0.7]); },
  // a trill: many tiny notes in a rush
  () => { const f = 4000 + Math.random()*1500, n = 8 + Math.floor(Math.random()*10), gap = 0.03 + Math.random()*0.015;
    return Array.from({ length: n }, (_, k) => [k*gap, gap*0.7, f, f*1.15]); },
  // a whistle: two long notes, one sliding up, then one down — wee-oo
  () => { const f = 2200 + Math.random()*1200;
    return [[0, 0.22, f*0.8, f*1.2], [0.3, 0.3, f*1.25, f*0.75]]; },
  // a call and answer: a note held, then a quick double
  () => { const f = 2600 + Math.random()*1500;
    return [[0, 0.18, f, f*1.02], [0.26, 0.05, f*1.3, f*1.2], [0.34, 0.05, f*1.3, f*1.2]]; },
];
// a cricket: three short pulses at one pitch
const cricket = () => { const f = 4200 + Math.random()*700; return [0, 0.045, 0.09].map(start => [start, 0.025, f, f]); };

// somewhere round the camera (by default off in the trees and gutters): `near` to `far` away, `low` to `high` up
function somewhereAround(near = 15, far = 70, low = 2, high = 10) {
  const { x, z } = camera.position, angle = Math.random()*Math.PI*2, d = near + Math.random()*(far - near);
  return { x: x + Math.cos(angle)*d, y: low + Math.random()*(high - low), z: z + Math.sin(angle)*d };
}

/**
 * One frame of the city's background sound.
 * @param {number} t - seconds
 * @returns {void}
 */
export function updateAmbience(t) {
  const context = listener.context;
  if (context.state !== 'running') return;
  hum ??= makeHum();
  const traffic = trafficNearby();
  hum.gain.gain.setTargetAtTime(HUM_VOLUME*traffic/(traffic + HUM_FULL), context.currentTime, 0.5);
  const dt = Math.min(0.1, Math.max(0, t - lastT));
  lastT = t;

  // the rain: even light rain is heard (hence the root), less so from high above, and muffled from indoors
  const pouring = S.weatherRain ?? 0, inside = isInsideBuilding();
  rain ??= makeRain();
  const overhead = Math.max(0.3, 1 - camera.position.y/QUIET_ABOVE);
  rain.gain.gain.setTargetAtTime(RAIN_VOLUME*Math.sqrt(pouring)*overhead*(inside ? 0.6 : 1), context.currentTime, 0.4);
  rain.high.frequency.setTargetAtTime(inside ? RAIN_HIGH_INSIDE : RAIN_HIGH, context.currentTime, 0.1);
  if (pouring > 0 && !inside && !isMuted()) {
    const drops = DROPS_PER_SECOND*pouring*overhead*overhead*dt;
    for (let k = Math.floor(drops) + (Math.random() < drops % 1 ? 1 : 0); k > 0; k--) patter(context.currentTime + Math.random()*dt);
  }

  if (isMuted() || t < nextSong) return;
  const day = S.sunElevation > 2, night = S.sunElevation < -4, wet = (S.weatherRain ?? 0) > 0.2 || (S.weatherSnow ?? 0) > 0.2;
  const near = Math.max(0, 1 - camera.position.y/QUIET_ABOVE);
  const gap = day ? BIRD_GAP : CRICKET_GAP;
  nextSong = t + gap*(0.3 + Math.random()*1.4)/Math.max(0.2, near);
  if (wet || near <= 0 || !(day || night)) return;
  if (day) whistle(somewhereAround(), context.currentTime, SONGS[Math.floor(Math.random()*SONGS.length)](), SONG_VOLUME);
  else whistle(somewhereAround(), context.currentTime, cricket(), CRICKET_VOLUME);
}
