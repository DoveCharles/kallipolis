import { groundKindBelow } from '../core/ground-probe.js';
import { listener, outdoorsOf, ear, loopPanning, placePanner, makePanner } from './sfx.js';

// ============================================================ the MedBot's noises
// The MedBots near the camera (see life/medbot.js), each a set of loops synthesized live like the bees' buzz (buzz.js):
//  - her conveyor-belt boots: a low whirring motor (a sawtooth and a square a fifth up, through a lowpass) over the hiss
//    of the belt (noise through a bandpass), rattling with the treads as they go round; rolling about it's MOTOR_HZ,
//    rushing it's SPEED_PITCH times that and SPEED_LOUDER times as loud. Still, she's quiet.
//  - under them, the ground she's rolling over (groundKindBelow, checked every PROBE_EVERY s): over grass, sand and dirt a
//    crunch (noise, its loudness crackling at random); over paving a skateboard's
//    roar, clack-clacking (crack) over the cracks between slabs, CRACKS a second at her rolling speed; over roads and
//    anything plain, nothing.
//  - her siren while she rushes to someone hurt: a slow wail, woooo-woooo, rising and falling around SIREN_HZ; heard much
//    further off than the rest (SIREN_HEAR).
//  - healing: a soft major-seventh chord swelling in and shimmering, with bubbly notes (each a sine blooping up to pitch)
//    strummed up the C major pentatonic, four octaves, over it, slowly, the one strum lasting the whole heal, and high twinkles sprinkled about (TWINKLE_EVERY), all
//    through an echo (ECHO) — as the hearts fly off; and under it, every RUSTLE_EVERY or so, the noises of
//    dressings going on: a rustle of gauze, a swish of a bandage wrapped round, a rip of tape or velcro (rustle).
// There are VOICES_MAX of these, handed each frame to the nearest bots, as the buzzes are to bees.
const HEAR = 22, REF = 1.5;             // her boots and the healing: heard close up
const SIREN_HEAR = 70, SIREN_REF = 4;   // the siren: from right across a plaza
const VOICES_MAX = 2;
const MOTOR_HZ = 165, MOTOR_VOLUME = 0.05;
const SPEED_PITCH = 1.9, SPEED_LOUDER = 2;
const SOFT_VOLUME = 0.035, STONE_VOLUME = 0.025, PROBE_EVERY = 0.25;
const CRACKS = 6, CRACK_VOLUME = 0.06, WHEELBASE = 0.05; // cracks a second at speed 1; s between her front and back wheels' clacks
const TREAD_HZ = 9;                     // the treads' rattle a second at her rolling speed (faster when she's faster)
const SIREN_HZ = 760, SIREN_SWING = 330, SIREN_RATE = 0.55, SIREN_VOLUME = 0.05; // centre, ± Hz, wails a second
const CHORD = [523.25, 659.25, 783.99, 987.77, 1318.5]; // Cmaj7 and a high E
const HEAL_VOLUME = 0.008;
const SCALE = [0, 1, 2, 3].flatMap(o => [0, 2, 4, 7, 9].map(n => 261.63*2**(o + n/12))).concat(4186); // C major pentatonic, C4 up to C8
const BUBBLE = { from: 0.55, over: 0.05, ring: 0.35 }; // a strummed note: blooping up from `from` × its pitch in `over` s
const BELL = [[1, 1], [2.76, 0.35], [5.4, 0.12]]; // a chime's partials: × pitch, loudness
const TWINKLE_EVERY = [0.08, 0.3], TWINKLE_VOLUME = 0.012;
const ECHO = { time: 0.23, feedback: 0.45, wet: 0.5 };
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
  const p = makePanner(context, loopPanning());
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

  // the ground: a crunch (noise, its loudness shaken by the same noise played very slowly) or a stony rumble and grit
  const loop = rate => { const n = context.createBufferSource(); n.buffer = noise; n.loop = true; n.playbackRate.value = rate; started.push(n); return n; };
  const filter = (type, hz, q) => { const f = context.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; return f; };
  const crackle = loop(0.0008), crunch = gain(0.5), soft = gain(0);
  crackle.connect(gain(0.9)).connect(crunch.gain);
  loop(1).connect(filter('bandpass', 900, 0.7)).connect(crunch).connect(soft).connect(near);
  const grain = loop(0.004), roar = gain(0.7), stone = gain(0); // (the roar's grain: its loudness shaken quickly)
  grain.connect(gain(0.3)).connect(roar.gain);
  loop(1).connect(filter('bandpass', 900, 0.6)).connect(filter('lowpass', 2800, 0.7)).connect(roar);
  roar.connect(stone).connect(near);

  // the siren: a triangle wailing up and down (a slow sine on its pitch)
  const wail = osc('triangle', SIREN_HZ), swing = osc('sine', SIREN_RATE), swingDepth = gain(SIREN_SWING);
  swing.connect(swingDepth).connect(wail.frequency);
  const sirenTone = context.createBiquadFilter();
  sirenTone.type = 'lowpass'; sirenTone.frequency.value = 2400;
  const siren = gain(0);
  wail.connect(sirenTone).connect(siren).connect(far);

  // the echo the healing sounds ring through
  const sparkle = gain(1), echo = context.createDelay(1), feedback = gain(ECHO.feedback), wet = gain(ECHO.wet);
  echo.delayTime.value = ECHO.time;
  sparkle.connect(near); sparkle.connect(echo).connect(feedback).connect(echo); echo.connect(wet).connect(near);

  // the healing chord, shimmering (a quick wobble on its loudness, and each note drifting, chorused, with its twin)
  const healing = gain(0), shimmer = gain(0.75), wobble = osc('sine', 5.5), wobbleDepth = gain(0.25);
  wobble.connect(wobbleDepth).connect(shimmer.gain);
  CHORD.forEach((hz, i) => [-1, 1].forEach(side => {
    const o = osc('sine', hz*(1 + side*0.003)), drift = osc('sine', 0.3 + i*0.07), driftDepth = gain(hz*0.002);
    drift.connect(driftDepth).connect(o.frequency);
    o.connect(gain(0.5/CHORD.length)).connect(shimmer);
  }));
  shimmer.connect(healing).connect(sparkle);

  started.forEach(o => o.start());
  return { bot: null, near, far, sparkle, nextTwinkle: 0, motor, saw, square, lowpass, hiss, tread, soft, stone, crackle, ground: null, nextProbe: 0, nextCrack: 0, siren, healing, notes: 0, nextRustle: 0 };
}

// A crack in the pavement rolled over: a hollow knock and a click, front wheels then back.
function crack(v, now, volume) {
  const context = listener.context;
  for (const at of [now, now + WHEELBASE*(0.8 + Math.random()*0.4)]) {
    const o = context.createOscillator(), knock = context.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(420 + Math.random()*80, at);
    o.frequency.exponentialRampToValueAtTime(200, at + 0.04);
    knock.gain.setValueAtTime(volume, at);
    knock.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    o.connect(knock).connect(v.near);
    o.start(at); o.stop(at + 0.1);
    o.onended = () => knock.disconnect();
    const n = context.createBufferSource(), f = context.createBiquadFilter(), click = context.createGain();
    n.buffer = noise;
    f.type = 'bandpass'; f.frequency.value = 4500; f.Q.value = 0.8;
    click.gain.setValueAtTime(volume*0.5, at);
    click.gain.exponentialRampToValueAtTime(0.0001, at + 0.025);
    n.connect(f).connect(click).connect(v.near);
    n.start(at, Math.random()*1.5, 0.03);
    n.onended = () => click.disconnect();
  }
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

// a bell: its partials rung together, the higher dying sooner
function chime(v, hz, now, volume = CHIME_VOLUME, ring = CHIME_RING) {
  const context = listener.context;
  for (const [times, loud] of BELL) {
    const o = context.createOscillator(), g = context.createGain(), dies = ring/Math.sqrt(times);
    o.type = 'sine';
    o.frequency.value = hz*times;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(volume*loud, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dies);
    o.connect(g).connect(v.sparkle);
    o.start(now); o.stop(now + dies + 0.05);
    o.onended = () => g.disconnect();
  }
}

// a bubble: a sine sliding quickly up to its pitch, and a fainter one an octave up, popping off short
function bubble(v, hz, now) {
  const context = listener.context;
  for (const [times, loud] of [[1, 1], [2, 0.2]]) {
    const o = context.createOscillator(), g = context.createGain(), f = hz*times;
    o.type = 'sine';
    o.frequency.setValueAtTime(f*BUBBLE.from, now);
    o.frequency.exponentialRampToValueAtTime(f, now + BUBBLE.over);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(CHIME_VOLUME*loud, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + BUBBLE.ring);
    o.connect(g).connect(v.sparkle);
    o.start(now); o.stop(now + BUBBLE.ring + 0.05);
    o.onended = () => g.disconnect();
  }
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
  near.forEach(b => { if (!voices.some(v => v.bot === b.bot)) { const v = voices.find(v => !v.bot); v.bot = b.bot; v.nextProbe = 0; } });
  for (const v of voices) {
    const b = v.bot && near.find(n => n.bot === v.bot);
    if (!b) { [v.motor, v.soft, v.stone, v.siren, v.healing].forEach(g => g.gain.setTargetAtTime(0, now, 0.15)); continue; }
    for (const p of [v.near, v.far]) placePanner(p, b.x, b.y + 0.8, b.z);
    // (her boots: the faster, the higher and louder, rushing most of all)
    const fast = b.rushing ? 1 : 0, pitch = MOTOR_HZ*(0.8 + 0.2*Math.min(1, b.speed))*(fast ? SPEED_PITCH : 1);
    v.saw.frequency.setTargetAtTime(pitch, now, 0.12);
    v.square.frequency.setTargetAtTime(pitch*1.5, now, 0.12);
    v.lowpass.frequency.setTargetAtTime(pitch*6, now, 0.12);
    v.hiss.frequency.setTargetAtTime(2200*(fast ? 1.6 : 1), now, 0.12);
    v.tread.frequency.setTargetAtTime(TREAD_HZ*Math.max(0.3, b.speed), now, 0.12);
    const rolling = Math.min(1, b.speed/0.3);
    v.motor.gain.setTargetAtTime(MOTOR_VOLUME*rolling*(fast ? SPEED_LOUDER : 1), now, 0.08);
    // (the ground under her, as loud as her boots are)
    if (now >= v.nextProbe) { v.ground = groundKindBelow(b.x, b.y, b.z); v.nextProbe = now + PROBE_EVERY; }
    const ground = rolling*(fast ? SPEED_LOUDER : 1);
    v.soft.gain.setTargetAtTime(v.ground === 'soft' ? SOFT_VOLUME*ground : 0, now, 0.08);
    v.stone.gain.setTargetAtTime(v.ground === 'stone' ? STONE_VOLUME*ground : 0, now, 0.08);
    if (v.ground === 'stone' && rolling > 0.5 && now >= v.nextCrack) {
      if (v.nextCrack) crack(v, now, CRACK_VOLUME*ground);
      v.nextCrack = now + (0.6 + Math.random()*0.8)/(CRACKS*Math.max(0.3, b.speed));
    } else if (v.ground !== 'stone' || rolling <= 0.5) v.nextCrack = 0;
    v.crackle.playbackRate.setTargetAtTime(0.0008*Math.max(0.3, b.speed), now, 0.12);
    v.siren.gain.setTargetAtTime(b.rushing ? SIREN_VOLUME : 0, now, b.rushing ? 0.05 : 0.4);
    v.healing.gain.setTargetAtTime(b.healing ? HEAL_VOLUME : 0, now, b.healing ? 0.3 : 0.25);
    // (one strum up the scale over the whole heal: each note as the heal gets that far through)
    const notes = b.healing ? Math.min(SCALE.length, Math.floor(b.healed*SCALE.length) + 1) : 0;
    if (notes < v.notes) v.notes = 0;
    while (v.notes < notes) bubble(v, SCALE[v.notes++], now);
    if (b.healing && now >= v.nextTwinkle) { // (a high twinkle, anywhere up the top two octaves)
      chime(v, SCALE[10 + Math.floor(Math.random()*11)], now, TWINKLE_VOLUME, 0.35);
      v.nextTwinkle = now + TWINKLE_EVERY[0] + Math.random()*(TWINKLE_EVERY[1] - TWINKLE_EVERY[0]);
    }
    if (b.healing && now >= v.nextRustle) {
      rustle(v, now);
      v.nextRustle = now + RUSTLE_EVERY[0] + Math.random()*(RUSTLE_EVERY[1] - RUSTLE_EVERY[0]);
    }
  }
}
