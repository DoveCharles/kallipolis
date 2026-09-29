import { listener, outdoorsOf, ear } from './sfx.js';

// ============================================================ the MedBot's noises
// The MedBots near the camera (see life/medbot.js), each a set of loops synthesized live like the bees' buzz (buzz.js):
//  - her conveyor-belt boots: a low whirring motor (a sawtooth and a square a fifth up, through a lowpass) over the hiss
//    of the belt (noise through a bandpass), rattling with the treads as they go round; rolling about it's MOTOR_HZ,
//    rushing it's SPEED_PITCH times that and SPEED_LOUDER times as loud. Still, she's quiet.
//  - her siren while she rushes to someone hurt: a slow wail, woooo-woooo, rising and falling around SIREN_HZ; heard much
//    further off than the rest (SIREN_HEAR).
//  - healing: a soft major chord swelling in and shimmering, with chimes strummed up the C major scale over it, slowly,
//    the one strum lasting the whole heal, as the hearts fly off; and under it, every RUSTLE_EVERY or so, the noises of
//    dressings going on: a rustle of gauze, a swish of a bandage wrapped round, a rip of tape or velcro (rustle).
// There are VOICES_MAX of these, handed each frame to the nearest bots, as the buzzes are to bees.
const HEAR = 22, REF = 1.5;             // her boots and the healing: heard close up
const SIREN_HEAR = 70, SIREN_REF = 4;   // the siren: from right across a plaza
const VOICES_MAX = 2;
const MOTOR_HZ = 165, MOTOR_VOLUME = 0.05;
const SPEED_PITCH = 1.9, SPEED_LOUDER = 2;
const TREAD_HZ = 9;                     // the treads' rattle a second at her rolling speed (faster when she's faster)
const SIREN_HZ = 760, SIREN_SWING = 330, SIREN_RATE = 0.55, SIREN_VOLUME = 0.05; // centre, ± Hz, wails a second
const CHORD = [523.25, 659.25, 783.99, 1046.5]; // C major, C5 up to C6
const HEAL_VOLUME = 0.008;
const SCALE = [523.25, 587.33, 659.25, 698.46, 783.99, 880, 987.77, // C major, two octaves: C5 up to C7
  1046.5, 1174.7, 1318.5, 1396.9, 1568, 1760, 1975.5, 2093];
const CHIME_VOLUME = 0.04, CHIME_RING = 0.9;
const RUSTLE_EVERY = [0.12, 0.45], RUSTLE_VOLUME = 0.055;

const voices = []; // { bot, motor, siren, healing, ... }
let noise = null;

function noiseBuffer(context) {
  const buffer = context.createBuffer(1, context.sampleRate*2, context.sampleRate), data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random()*2 - 1;
  return buffer;
}
function panner(context, ref, max) {
  const p = context.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'linear';
  p.refDistance = ref;
  p.maxDistance = max;
  return p;
}
function makeVoice() {
  const context = listener.context, out = outdoorsOf('peds');
  noise ??= noiseBuffer(context);
  const near = panner(context, REF, HEAR), far = panner(context, SIREN_REF, SIREN_HEAR);
  near.connect(out); far.connect(out);
  const started = [];
  const osc = (type, hz) => { const o = context.createOscillator(); o.type = type; o.frequency.value = hz; started.push(o); return o; };
  const gain = value => { const g = context.createGain(); g.gain.value = value; return g; };

  // the motor: its pitch follows `pitch` (a constant the whole motor's frequencies hang off)
  const saw = osc('sawtooth', MOTOR_HZ), square = osc('square', MOTOR_HZ*1.5);
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass'; lowpass.frequency.value = MOTOR_HZ*6; lowpass.Q.value = 2;
  const belt = context.createBufferSource();
  belt.buffer = noise; belt.loop = true; started.push(belt);
  const hiss = context.createBiquadFilter();
  hiss.type = 'bandpass'; hiss.frequency.value = 2200; hiss.Q.value = 1.5;
  const tread = osc('square', TREAD_HZ), treadDepth = gain(0.3), rattle = gain(0.7);
  tread.connect(treadDepth).connect(rattle.gain);
  const motor = gain(0);
  saw.connect(lowpass); square.connect(gain(0.4)).connect(lowpass);
  lowpass.connect(rattle);
  belt.connect(hiss).connect(gain(0.35)).connect(rattle);
  rattle.connect(motor).connect(near);

  // the siren: a triangle wailing up and down (a slow sine on its pitch)
  const wail = osc('triangle', SIREN_HZ), swing = osc('sine', SIREN_RATE), swingDepth = gain(SIREN_SWING);
  swing.connect(swingDepth).connect(wail.frequency);
  const sirenTone = context.createBiquadFilter();
  sirenTone.type = 'lowpass'; sirenTone.frequency.value = 2400;
  const siren = gain(0);
  wail.connect(sirenTone).connect(siren).connect(far);

  // the healing chord, shimmering (a quick wobble on its loudness)
  const healing = gain(0), shimmer = gain(0.75), wobble = osc('sine', 5.5), wobbleDepth = gain(0.25);
  wobble.connect(wobbleDepth).connect(shimmer.gain);
  CHORD.forEach((hz, i) => osc('sine', hz*(1 + (i - 1.5)*0.002)).connect(gain(1/CHORD.length)).connect(shimmer));
  shimmer.connect(healing).connect(near);

  started.forEach(o => o.start());
  return { bot: null, near, far, motor, saw, square, lowpass, hiss, tread, siren, healing, notes: 0, nextRustle: 0 };
}

// A noise of dressings going on, one of three at random: all noise, shaped by its filter and loudness.
function rustle(v, now) {
  const context = listener.context, source = context.createBufferSource(), filter = context.createBiquadFilter();
  const g = context.createGain(), kind = Math.random();
  source.buffer = noise;
  filter.type = 'bandpass';
  g.gain.setValueAtTime(0, now);
  let length;
  if (kind < 0.5) { // gauze: a short crinkly rustle, crackling (its loudness jumping about)
    length = 0.06 + Math.random()*0.16;
    filter.frequency.value = 1800 + Math.random()*1500; filter.Q.value = 1.2;
    for (let at = 0; at < length; at += 0.012) g.gain.setValueAtTime(RUSTLE_VOLUME*(0.3 + Math.random()*0.7)*(1 - at/length), now + at);
  } else if (kind < 0.8) { // a bandage wrapped round: a swish, its pitch swept up and back down
    length = 0.25 + Math.random()*0.2;
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(2200, now + length*0.5);
    filter.frequency.exponentialRampToValueAtTime(1200, now + length);
    g.gain.linearRampToValueAtTime(RUSTLE_VOLUME*0.8, now + length*0.45);
  } else { // tape or velcro torn off: a buzzy rip, fast pulses of noise
    length = 0.12 + Math.random()*0.1;
    filter.frequency.value = 1300; filter.Q.value = 1;
    const pulse = 1/(70 + Math.random()*50);
    for (let at = 0; at < length; at += pulse) {
      g.gain.setValueAtTime(RUSTLE_VOLUME*1.2, now + at);
      g.gain.setValueAtTime(RUSTLE_VOLUME*0.1, now + at + pulse*0.5);
    }
  }
  g.gain.linearRampToValueAtTime(0, now + length);
  source.connect(filter).connect(g).connect(v.near);
  source.start(now, Math.random()*1.5, length + 0.05);
  source.onended = () => g.disconnect();
}

function chime(v, hz, now) {
  const context = listener.context, o = context.createOscillator(), g = context.createGain();
  o.type = 'sine';
  o.frequency.value = hz;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(CHIME_VOLUME, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + CHIME_RING);
  o.connect(g).connect(v.near);
  o.start(now); o.stop(now + CHIME_RING + 0.05);
  o.onended = () => g.disconnect();
}

/**
 * One frame of the MedBots' noises: hand the voices to the nearest bots, and set what each is making.
 * @param {{bot: object, x: number, y: number, z: number, speed: number, rushing: boolean, healing: boolean, healed: number}[]}
 *   bots - every bot out of her booth: where she is, how fast she's going against her rolling speed (0 still, 1 rolling about,
 *   more rushing), whether she's rushing to someone hurt, whether she's healing someone and how far
 *   through the heal she is (0 to 1)
 * @returns {void}
 */
export function updateMedBotSounds(bots) {
  const { x, y, z } = ear;
  const near = bots
    .map(b => ({ b, d: Math.hypot(b.x - x, b.y - y, b.z - z) }))
    .filter(n => n.d <= (n.b.rushing ? SIREN_HEAR : HEAR))
    .sort((a, b) => a.d - b.d).slice(0, VOICES_MAX).map(n => n.b);
  if (!near.length && !voices.some(v => v.bot)) return;
  while (voices.length < Math.min(VOICES_MAX, near.length)) voices.push(makeVoice());
  const now = listener.context.currentTime;
  voices.forEach(v => { if (v.bot && !near.some(b => b.bot === v.bot)) v.bot = null; });
  near.forEach(b => { if (!voices.some(v => v.bot === b.bot)) voices.find(v => !v.bot).bot = b.bot; });
  for (const v of voices) {
    const b = v.bot && near.find(n => n.bot === v.bot);
    if (!b) { [v.motor, v.siren, v.healing].forEach(g => g.gain.setTargetAtTime(0, now, 0.15)); continue; }
    for (const p of [v.near, v.far]) { p.positionX.value = b.x; p.positionY.value = b.y + 0.8; p.positionZ.value = b.z; }
    // (her boots: the faster, the higher and louder, rushing most of all)
    const fast = b.rushing ? 1 : 0, pitch = MOTOR_HZ*(0.8 + 0.2*Math.min(1, b.speed))*(fast ? SPEED_PITCH : 1);
    v.saw.frequency.setTargetAtTime(pitch, now, 0.12);
    v.square.frequency.setTargetAtTime(pitch*1.5, now, 0.12);
    v.lowpass.frequency.setTargetAtTime(pitch*6, now, 0.12);
    v.hiss.frequency.setTargetAtTime(2200*(fast ? 1.6 : 1), now, 0.12);
    v.tread.frequency.setTargetAtTime(TREAD_HZ*Math.max(0.3, b.speed), now, 0.12);
    const rolling = Math.min(1, b.speed/0.3);
    v.motor.gain.setTargetAtTime(MOTOR_VOLUME*rolling*(fast ? SPEED_LOUDER : 1), now, 0.08);
    v.siren.gain.setTargetAtTime(b.rushing ? SIREN_VOLUME : 0, now, b.rushing ? 0.05 : 0.4);
    v.healing.gain.setTargetAtTime(b.healing ? HEAL_VOLUME : 0, now, b.healing ? 0.3 : 0.25);
    // (one strum up the scale over the whole heal: each note as the heal gets that far through)
    const notes = b.healing ? Math.min(SCALE.length, Math.floor(b.healed*SCALE.length) + 1) : 0;
    if (notes < v.notes) v.notes = 0;
    while (v.notes < notes) chime(v, SCALE[v.notes++], now);
    if (b.healing && now >= v.nextRustle) {
      rustle(v, now);
      v.nextRustle = now + RUSTLE_EVERY[0] + Math.random()*(RUSTLE_EVERY[1] - RUSTLE_EVERY[0]);
    }
  }
}
