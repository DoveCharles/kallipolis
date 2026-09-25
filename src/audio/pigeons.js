import { camera } from '../core/scene.js';
import { listener, playBufferAt, ear } from './sfx.js';

// ============================================================ pigeons
// The pigeons' two sounds (see life/pigeons.js), synthesized once and played near the camera only:
// - a coo: always the same call, "cu-cu-Uu", two short soft notes and a long one that jumps up and slides down
//   again, muffled (it's sung with the beak shut);
// - a flutter: the clatter of wings as one takes off, a quick run of dry claps dying away.
const HEAR_DISTANCE = 14, REF_DISTANCE = 1.5;
const COO_VOLUME = 0.2, FLUTTER_VOLUME = 0.28;
const VARIANTS = 3;
const SOUNDS_MAX_PER_SECOND = 6; // a whole flock going up at once is a clatter, not a roar

let coos = null, flutters = null;
let budget = SOUNDS_MAX_PER_SECOND, budgetAt = 0;

function buffer(seconds, fill) {
  const ctx = listener.context, rate = ctx.sampleRate, n = Math.round(seconds*rate);
  const b = ctx.createBuffer(1, n, rate), data = b.getChannelData(0);
  fill(data, rate);
  let peak = 0;
  for (let i=0;i<n;i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i=0;i<n;i++) data[i] /= peak;
  return b;
}

// The call's notes as [start, length, pitch at the start, pitch at its peak, pitch at the end, when it peaks]
// (seconds, Hz, and a share of the note): cu, cu, then the long Uu, which jumps straight up, holds, then slides down, but not as low as the cu's.
const COO_NOTES = [
  [0.00, 0.055, 290, 300, 280, 0.25],
  [0.08, 0.055, 290, 300, 280, 0.25],
  [0.155, 0.29, 390, 390, 330, 0.3],
];
const COO_ROLL = 26, COO_ROLL_DEPTH = 0.7; // the purr in its throat: how fast its loudness shudders, and how deep
const COO_GROWL = 0.1;   // how much of the tone an octave down there is, for a fuller, throatier sound
const COO_MUFFLE = 0.035; // the lowpass over it all, as a share of each sample let through: lower is more muffled
// The hollow "oo" of its puffed-up throat: a broad bump in the range the call is in, after the lowpass.
const COO_HOLLOW = 500, COO_HOLLOW_Q = 0.9, COO_HOLLOW_DB = 9; // Hz, how broad (lower is broader), how much
// A soft puff of air at the start of each note, before the tone: seconds, and how loud beside the call.
const COO_BREATH = 0.025, COO_BREATH_MIX = 0.25;

// each note a soft tone, a touch of its octave and a little of the octave below, shuddering with a purr; all of it
// darkened twice over, a puff of breath at the start of each note, then the hollow of its throat
function makeCoo() {
  return buffer(0.5, (data, rate) => {
    COO_NOTES.forEach(([at, len, f0, peak, f1, top]) => {
      let phase = 0;
      const start = Math.round(at*rate), n = Math.round(len*rate);
      for (let i=0;i<n;i++) {
        const k = i/n, f = k < top ? f0 + (peak - f0)*k/top : peak + (f1 - peak)*(k - top)/(1 - top);
        phase += 2*Math.PI*f/rate;
        const envelope = Math.min(1, k*(len < 0.1 ? 6 : 8))*(1 - k)**(len < 0.1 ? 1.2 : 0.8);
        const roll = 1 - COO_ROLL_DEPTH*(0.5 + 0.5*Math.sin(2*Math.PI*COO_ROLL*i/rate));
        data[start + i] += envelope*roll*(Math.sin(phase) + 0.3*Math.sin(2*phase) + COO_GROWL*Math.sin(phase/2));
      }
    });
    let a = 0, b = 0;
    for (let i=0;i<data.length;i++) { a += COO_MUFFLE*(data[i] - a); b += COO_MUFFLE*(a - b); data[i] = b; }
    // the breath: darkened noise, swelling and dying away over its first moments
    let loudest = 0;
    for (let i=0;i<data.length;i++) loudest = Math.max(loudest, Math.abs(data[i]));
    COO_NOTES.forEach(([at, len]) => {
      const start = Math.round(at*rate), n = Math.round(Math.min(COO_BREATH, len*0.5)*rate);
      let lp = 0;
      for (let i=0;i<n && start + i < data.length;i++) {
        lp += 0.12*((Math.random()*2 - 1) - lp);
        data[start + i] += lp*Math.sin(Math.PI*i/n)*COO_BREATH_MIX*loudest*4; // (×4: the lowpass leaves the noise quiet)
      }
    });
    // the hollow: a peaking biquad
    const w = 2*Math.PI*COO_HOLLOW/rate, A = 10**(COO_HOLLOW_DB/40), alpha = Math.sin(w)/(2*COO_HOLLOW_Q), a0 = 1 + alpha/A;
    const b0 = (1 + alpha*A)/a0, b1 = -2*Math.cos(w)/a0, b2 = (1 - alpha*A)/a0, a1 = b1, a2 = (1 - alpha/A)/a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i=0;i<data.length;i++) {
      const x = data[i], y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; data[i] = y;
    }
  });
}

// wingbeats: a dozen short bursts of darkened noise, quicker and softer as it gets going
function makeFlutter() {
  return buffer(0.7, (data, rate) => {
    let t = 0, beat = 0, lp = 0;
    while (t < 0.62) {
      const start = Math.round(t*rate), n = Math.round(0.03*rate), loud = Math.exp(-beat*0.18);
      for (let i=0;i<n && start + i < data.length;i++) {
        lp += 0.35*((Math.random()*2 - 1) - lp); // (a one-pole lowpass: a clap of feathers, not a hiss)
        data[start + i] += lp*loud*Math.exp(-i/(0.008*rate));
      }
      t += 0.075 - Math.min(0.03, beat*0.004);
      beat++;
    }
  });
}

function allowed(at) {
  const { x, y, z } = ear;
  if (Math.hypot(at.x - x, at.y - y, at.z - z) > HEAR_DISTANCE) return false;
  const now = performance.now()/1000;
  budget = Math.min(SOUNDS_MAX_PER_SECOND, budget + (now - budgetAt)*SOUNDS_MAX_PER_SECOND);
  budgetAt = now;
  if (budget < 1) return false;
  budget--;
  return true;
}

/** A pigeon at `at` coos. */
export function coo(at) {
  if (!allowed(at)) return;
  coos ??= makeCoo(); // (one call: every pigeon's is the same, only a shade higher or lower)
  playBufferAt(coos, at, COO_VOLUME, REF_DISTANCE, HEAR_DISTANCE, 0.96 + Math.random()*0.08, [], 'ambience');
}

/** A pigeon at `at` takes off. */
export function flutter(at) {
  if (!allowed(at)) return;
  flutters ??= Array.from({ length: VARIANTS }, makeFlutter);
  playBufferAt(flutters[Math.floor(Math.random()*flutters.length)], at, FLUTTER_VOLUME, REF_DISTANCE, HEAR_DISTANCE, 0.9 + Math.random()*0.25, [], 'ambience');
}
