// ============================================================ an engine's voice
// The sound of one engine, apart from which car it's in or where (engine.js hands these out to the cars near the camera,
// and tools/engine.html plays them on their own). An engine's note is the cylinders firing: strongest at the firing rate
// and its harmonics, with a little of the slower beat of one whole turn of the crank under it where the cylinders don't
// fire quite evenly. Each KIND of engine is a waveform built from just those harmonics (a PeriodicWave, so it's a steady
// note rather than a string of separate pops, which at these low rates sounds more like a bottom than an engine), played
// on two oscillators a hair apart so it beats a little. It's pushed through a soft clipper, harder the more the throttle's
// pressed, then through the fixed resonances of the exhaust and a lowpass that opens as the throttle's pressed and the
// revs climb. A diesel has the clatter of its injectors on top.
const BASE_HZ = 100;          // firings a second the clatter loop holds at a playbackRate of 1
const DETUNE = 1.004;         // the second oscillator against the first
const SHAPER_STEEPNESS = 2.5;
const LEVEL = 0.4;            // (brings the whole down to about where the old oscillators sat)

/**
 * The kinds of engine: `cylinders` firing each turn of the crank (two turns, really); `idle` and `redline` the firings
 * a second at tickover and at the top of a gear; `roll` how fast its harmonics fall away (lower, brighter); `lump` how
 * much of the turn's slower beat there is between the firings (0 a smooth turbine); `burble` a V8's beat at half the
 * firing rate, bank against bank; `clatter` a diesel's injector knock; `exhaust` the pipe's two resonances in Hz; `drive`
 * how hard the throttle pushes the clipper (more, raspier).
 */
export const KINDS = {
  three:  { cylinders: 3, idle: 78,  redline: 270, roll: 1.25, lump: 0.22, burble: 0,    clatter: 0,    exhaust: [420, 1500], drive: 1.2 },
  four:   { cylinders: 4, idle: 85,  redline: 300, roll: 1.3,  lump: 0.14, burble: 0,    clatter: 0,    exhaust: [380, 1300], drive: 1.0 },
  six:    { cylinders: 6, idle: 95,  redline: 330, roll: 1.45, lump: 0.06, burble: 0,    clatter: 0,    exhaust: [340, 1100], drive: 0.8 },
  v8:     { cylinders: 8, idle: 88,  redline: 300, roll: 1.35, lump: 0.1,  burble: 0.45, clatter: 0,    exhaust: [300, 900],  drive: 1.4 },
  sports: { cylinders: 8, idle: 115, redline: 480, roll: 1.1,  lump: 0.08, burble: 0.3,  clatter: 0,    exhaust: [520, 2200], drive: 2.2 },
  diesel: { cylinders: 6, idle: 68,  redline: 175, roll: 1.2,  lump: 0.12, burble: 0,    clatter: 0.22, exhaust: [300, 1700], drive: 0.7 },
};
/** Which kind of engine each vehicle design has (by its name in Cars.glb, lowercased), `four` for any not listed. */
const KIND_OF_DESIGN = {
  sportscar: 'sports', canyonero: 'v8', pickuptruck: 'v8', policecar: 'v8', ambulance: 'six', van: 'six', sedan: 'six',
  taxi: 'four', familycar: 'four', twingo: 'three',
  truck: 'diesel', bus: 'diesel',
};
export const kindOfDesign = name => KIND_OF_DESIGN[(name || '').toLowerCase().replace(/[^a-z]/g, '')] ?? 'four';

const waves = new Map(), clatters = new Map(); // `${sampleRate}:${kind}` -> PeriodicWave; sampleRate -> AudioBuffer

// A random number generator seeded by the kind's name, so a kind sounds the same every time.
function seeded(text) {
  let s = [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761), 1) >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0)/4294967296; };
}

// A kind's waveform, one turn of the crank long: its n-th harmonic is n/cylinders of the firing rate.
function waveOf(context, kind) {
  const key = context.sampleRate + ':' + kind;
  if (waves.has(key)) return waves.get(key);
  const k = KINDS[kind], random = seeded(kind), count = Math.min(400, k.cylinders*28);
  const real = new Float32Array(count + 1), imag = new Float32Array(count + 1);
  for (let n = 1; n <= count; n++) {
    const order = n/k.cylinders; // (against the firing rate)
    let amp;
    if (n % k.cylinders === 0) amp = 1/order**k.roll;                                         // (the firing, and its harmonics)
    else if (k.burble && n % (k.cylinders/2) === 0) amp = k.burble/(order + 0.5)**k.roll;     // (bank against bank)
    else amp = k.lump*(0.5 + random())/(order + 0.5)**(k.roll + 0.3);                          // (the unevenness of the turn)
    const phase = random()*2*Math.PI;
    real[n] = amp*Math.cos(phase); imag[n] = amp*Math.sin(phase);
  }
  const wave = context.createPeriodicWave(real, imag);
  waves.set(key, wave);
  return wave;
}

// A diesel's injector clatter: a sharp tick of noise, once a firing, looped.
function clatterOf(context) {
  if (clatters.has(context.sampleRate)) return clatters.get(context.sampleRate);
  const rate = context.sampleRate, length = Math.round(rate/BASE_HZ), random = seeded('clatter');
  const buffer = context.createBuffer(1, length, rate), data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (random()*2 - 1)*Math.exp(-i/rate/0.0007);
  clatters.set(rate, buffer);
  return buffer;
}

let shaperCurve = null;
function curve() {
  if (shaperCurve) return shaperCurve;
  shaperCurve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i/511.5 - 1; shaperCurve[i] = Math.tanh(SHAPER_STEEPNESS*x)/Math.tanh(SHAPER_STEEPNESS); }
  return shaperCurve;
}

/**
 * A new engine voice, silent until given a kind with setEngineKind and set with setEngineVoice, playing into `destination`.
 * @param {BaseAudioContext} context
 * @param {AudioNode} destination
 * @returns {object}
 */
export function makeEngineVoice(context, destination) {
  const drive = context.createGain(), shaper = context.createWaveShaper(), low = context.createBiquadFilter();
  const pipe = context.createBiquadFilter(), pipe2 = context.createBiquadFilter(), filter = context.createBiquadFilter(), out = context.createGain();
  const clatter = context.createGain(), clatterBand = context.createBiquadFilter();
  shaper.curve = curve();
  shaper.oversample = '2x';
  low.type = 'highpass'; low.frequency.value = 55;
  pipe.type = 'peaking'; pipe.Q.value = 1; pipe.gain.value = 4;
  pipe2.type = 'peaking'; pipe2.Q.value = 1.5; pipe2.gain.value = 3;
  filter.type = 'lowpass'; filter.Q.value = 0.7; filter.frequency.value = 600;
  clatterBand.type = 'highpass'; clatterBand.frequency.value = 1800;
  clatter.gain.value = 0;
  out.gain.value = 0;
  drive.connect(shaper).connect(low).connect(pipe).connect(pipe2).connect(filter).connect(out).connect(destination);
  clatter.connect(clatterBand).connect(out);
  const oscillators = [1, DETUNE].map((ratio, i) => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    gain.gain.value = i ? 0.45 : 1;
    oscillator.connect(gain).connect(drive);
    return { oscillator, ratio, started: false };
  });
  return { context, drive, pipe, pipe2, filter, out, clatter, oscillators, tick: null, kind: null, wobble: Math.random()*10 };
}

/**
 * Point an engine voice at a kind of engine (the voice drops quiet if it's a different one, to fade in again).
 * @param {object} voice - from makeEngineVoice
 * @param {string} kind - one of KINDS
 */
export function setEngineKind(voice, kind) {
  if (voice.kind === kind) return;
  const { context } = voice, now = context.currentTime;
  for (const o of voice.oscillators) {
    o.oscillator.setPeriodicWave(waveOf(context, kind));
    if (!o.started) { o.oscillator.start(); o.started = true; }
  }
  if (KINDS[kind].clatter && !voice.tick) {
    voice.tick = context.createBufferSource();
    voice.tick.buffer = clatterOf(context);
    voice.tick.loop = true;
    voice.tick.connect(voice.clatter);
    voice.tick.start();
  }
  voice.out.gain.cancelScheduledValues(now);
  voice.out.gain.setValueAtTime(0, now);
  voice.kind = kind;
}

/**
 * One frame of an engine voice.
 * @param {object} voice - from makeEngineVoice, given a kind with setEngineKind
 * @param {{revs: number, throttle: number, volume: number, pitch?: number, size?: number, dt?: number}} how - revs from 0
 *   (tickover) to 1 (redline), throttle 0 to 1, loudness (0 for off), pitch against the kind's own (a car's own voice),
 *   size against an ordinary car's (bigger, lower), and seconds since the last frame
 */
export function setEngineVoice(voice, { revs, throttle, volume, pitch = 1, size = 1, dt = 1/60 }) {
  const k = KINDS[voice.kind], now = voice.context.currentTime, scale = pitch/Math.max(0.5, size)**0.3;
  // (a little hunting about at tickover, gone as the revs climb)
  voice.wobble += dt*(2 + 3*revs);
  const hunt = 1 + 0.015*(1 - revs)*Math.sin(voice.wobble)*Math.sin(voice.wobble*0.37 + 1);
  const firing = (k.idle + (k.redline - k.idle)*revs)*scale*hunt;
  for (const { oscillator, ratio } of voice.oscillators) oscillator.frequency.setTargetAtTime(firing/k.cylinders*ratio, now, 0.03);
  if (voice.tick) voice.tick.playbackRate.setTargetAtTime(firing/BASE_HZ, now, 0.03);
  voice.clatter.gain.setTargetAtTime(k.clatter*(0.6 + 0.4*throttle), now, 0.05);
  voice.drive.gain.setTargetAtTime(0.5 + k.drive*throttle*(0.4 + 0.6*revs), now, 0.05);
  const exhaust = 1/Math.max(0.5, size)**0.3;
  voice.pipe.frequency.setTargetAtTime(k.exhaust[0]*exhaust, now, 0.1);
  voice.pipe2.frequency.setTargetAtTime(k.exhaust[1]*exhaust, now, 0.1);
  voice.filter.frequency.setTargetAtTime((500 + 1300*throttle + 2800*revs)*scale, now, 0.05);
  voice.out.gain.setTargetAtTime(volume*LEVEL, now, volume ? 0.08 : 0.3);
}
