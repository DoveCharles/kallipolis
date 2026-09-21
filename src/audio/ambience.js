import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { listener, isMuted } from './sfx.js';
import { trafficNearby } from './engine.js';

// ============================================================ ambience
// The city's background: a low hum of traffic, as loud as there are cars about the camera (see trafficNearby in
// engine.js), not coming from anywhere in particular; and, by day, birds singing now and then from somewhere round the
// camera — each a short phrase of whistled notes, of one of a few kinds of song — or at night, crickets. Neither sings in
// rain or snow, and fewer are heard the higher the camera's gone. All of it synthesized live, like the engines.
const HUM_VOLUME = 0.1;
const HUM_FULL = 12;              // how much traffic nearby (see trafficNearby) makes the hum half as loud as it gets
const BIRD_GAP = 2.5, CRICKET_GAP = 0.9; // mean seconds between one singing and the next, at street level
const QUIET_ABOVE = 250;          // how high the camera goes before it hears no birds or crickets at all
const SONG_VOLUME = 0.12, CRICKET_VOLUME = 0.05;
const SONG_REF_DISTANCE = 12;

let hum = null; // { gain } once made
let nextSong = 0;

// a couple of seconds of brown noise (random steps, drifting, so it's all rumble), looped under two lowpass filters
function makeHum() {
  const context = listener.context, length = context.sampleRate*3;
  const buffer = context.createBuffer(1, length, context.sampleRate), data = buffer.getChannelData(0);
  let last = 0;
  for (let k = 0; k < length; k++) { last = (last + 0.02*(Math.random()*2 - 1))/1.02; data[k] = last*3.5; }
  // (fade the ends into each other so the loop doesn't click)
  const blend = context.sampleRate*0.1;
  for (let k = 0; k < blend; k++) { const w = k/blend; data[k] = data[k]*w + data[length - blend + k]*(1 - w); }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopEnd = (length - blend)/context.sampleRate;
  const low = context.createBiquadFilter(), gain = context.createGain();
  low.type = 'lowpass';
  low.frequency.value = 220;
  gain.gain.value = 0;
  source.connect(low).connect(gain).connect(listener.getInput());
  source.start();
  return { gain };
}

// A tone played through a panner at `at`: `notes` is [[start, length, from Hz, to Hz]], seconds after `when`.
function whistle(at, when, notes, volume) {
  const context = listener.context;
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = SONG_REF_DISTANCE;
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

// somewhere round the camera, off in the trees and gutters
function somewhereAround() {
  const { x, z } = camera.position, angle = Math.random()*Math.PI*2, d = 15 + Math.random()*55;
  return { x: x + Math.cos(angle)*d, y: 2 + Math.random()*8, z: z + Math.sin(angle)*d };
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

  if (isMuted() || t < nextSong) return;
  const day = S.sunElevation > 2, night = S.sunElevation < -4, wet = (S.weatherRain ?? 0) > 0.2 || (S.weatherSnow ?? 0) > 0.2;
  const near = Math.max(0, 1 - camera.position.y/QUIET_ABOVE);
  const gap = day ? BIRD_GAP : CRICKET_GAP;
  nextSong = t + gap*(0.3 + Math.random()*1.4)/Math.max(0.2, near);
  if (wet || near <= 0 || !(day || night)) return;
  if (day) whistle(somewhereAround(), context.currentTime, SONGS[Math.floor(Math.random()*SONGS.length)](), SONG_VOLUME);
  else whistle(somewhereAround(), context.currentTime, cricket(), CRICKET_VOLUME);
}
