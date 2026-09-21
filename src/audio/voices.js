import { camera } from '../core/scene.js';
import { listener, isMuted } from './sfx.js';

// ============================================================ voices
// People talking babble, Animal Crossing style: every time a speaker's mouth opens on a new syllable (see "talking" in
// life/people/people.js) a short blip plays from their head — a buzzy tone at their voice's pitch, bent a little up or
// down each syllable and sliding as it goes, through two bandpass filters set to a random vowel's formants. Most syllables
// start on a consonant (see CONSONANTS): a click or hiss of noise before the voice comes in, a hum through a closed mouth,
// or the formants gliding in from somewhere else, so it's "ba", "sho", "lee" and not just "a", "o", "ee". And it comes in
// phrases (see nextSyllable), as speech does: a few syllables at a time with a breath between, every second or third one
// stressed (longer, louder, higher), the pitch drifting down as the phrase goes on and the last syllable drawn out,
// falling — or rising, for a question. Each blip is
// built live, like the engine (see engine.js), and gone once it's played. Only those within HEAR_DISTANCE of the camera
// are heard, so a crowded plaza across town costs nothing.
const VOWELS = [[800, 1200], [500, 1900], [300, 2300], [500, 900], [350, 800], [650, 1600]]; // [F1, F2] in Hz: a, e, i, o, u, and something in between
// how each syllable can start: a stop (a click of noise at `noise` Hz, then the voice), a hiss (a longer rush of noise
// that the voice comes in under), a hum (the voice muffled with its formants at `from`, opening out), or a glide (the
// formants sliding from `from` into the vowel); or null, the vowel bare. `time` is in seconds.
const CONSONANTS = [
  { kind: 'stop', noise: 900, q: 1, level: 0.5, time: 0.03 },    // p, b
  { kind: 'stop', noise: 4000, q: 1.5, level: 0.5, time: 0.03 },  // t, d
  { kind: 'stop', noise: 2000, q: 2, level: 0.6, time: 0.035 },   // k, g
  { kind: 'hiss', noise: 6500, q: 3, level: 0.5, time: 0.06 },    // s
  { kind: 'hiss', noise: 3000, q: 2, level: 0.5, time: 0.06 },    // sh
  { kind: 'hiss', noise: 5000, q: 0.5, level: 0.2, time: 0.05 },  // f
  { kind: 'hum', from: [250, 1100], time: 0.05 },                 // m
  { kind: 'hum', from: [250, 1700], time: 0.05 },                 // n
  { kind: 'glide', from: [350, 1100], time: 0.06 },               // l
  { kind: 'glide', from: [300, 800], time: 0.06 },                // w
  { kind: 'glide', from: [250, 2300], time: 0.06 },               // y
  null, null,
];
const HEAR_DISTANCE = 60;          // beyond this from the camera they aren't heard at all
const REF_DISTANCE = 6;            // how near to be heard at full volume
const VOLUME = 0.22;
const BLIPS_MAX = 12;              // syllables sounding at once, past which new ones are dropped
const BEND = 0.1;                  // how far each syllable's pitch strays at random from where the phrase has it, either way
const DRIFT = 0.12;                // how far the pitch drifts down over a phrase: from this much above the voice's to below
const STRESS = 0.12;               // how much higher a stressed syllable is
const SYLLABLE = 0.12;             // an ordinary syllable's length, in seconds (a stressed one's longer, the last longer still)

let blips = 0;

/**
 * The next beat of someone's talk: a syllable, or a pause. Speech comes in phrases of a few syllables, with a breath
 * between, and the odd little catch within one; a phrase's syllables are stressed every `beat`, and its last one's drawn
 * out. The talker carries their phrase along as `talker.phrase` (null it when they stop, to start afresh).
 * @param {{phrase: ?object}} talker
 * @param {() => number} rng
 * @returns {{open: number, length: number, intonation?: object}} how wide their mouth opens, 0 to 1 (0, a pause), for how
 *   many seconds, and for a syllable how it sits in its phrase — to hand on to babble
 */
export function nextSyllable(talker, rng) {
  let phrase = talker.phrase;
  if (!phrase || phrase.said >= phrase.length) {
    const breath = phrase ? 0.2 + rng()*0.45 : 0; // (none before the first)
    talker.phrase = phrase = { length: 2 + Math.floor(rng()*7), said: 0, beat: 2 + Math.floor(rng()*2), question: rng() < 0.2, pace: 0.85 + rng()*0.3 };
    if (breath) return { open: 0, length: breath };
  }
  if (phrase.said > 0 && phrase.said < phrase.length - 1 && rng() < 0.08) return { open: 0, length: 0.06 + rng()*0.08 };
  const k = phrase.said++, last = phrase.said === phrase.length, stressed = k % phrase.beat === 0;
  return {
    open: stressed ? 0.75 + rng()*0.25 : 0.35 + rng()*0.4,
    length: SYLLABLE*phrase.pace*(0.8 + rng()*0.4)*(stressed ? 1.3 : 1)*(last ? 1.7 : 1),
    intonation: { through: k/Math.max(1, phrase.length - 1), stressed, last, question: phrase.question },
  };
}
let noise = null; // a second of white noise, for the consonants

function noiseBuffer(context) {
  if (noise) return noise;
  noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let k = 0; k < data.length; k++) data[k] = Math.random()*2 - 1;
  return noise;
}

/**
 * One syllable of someone's babble.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice - its pitch in Hz; how far its formants sit from an
 *   ordinary voice's (the shape of their mouth and throat: above 1 smaller and brighter, below 1 bigger and darker); and how
 *   sharp those formants ring (low breathy, high nasal and buzzy)
 * @param {number} length - seconds until their next syllable
 * @param {number} [loudness=1] - how wide their mouth opens on it, 0 to 1
 * @param {number} [mood=0] - their mood trait: the cheerier, the more their syllables lift, the glummer, the more they sag
 * @param {?{through: number, stressed: boolean, last: boolean, question: boolean}} [intonation] - how the syllable sits in
 *   its phrase (see nextSyllable): how far through it, 0 to 1; whether it's stressed; whether it's the last, and if so
 *   whether the phrase is a question
 * @returns {void}
 */
export function babble(at, voice, length, loudness = 1, mood = 0, intonation = null) {
  const { pitch, formant, sharpness } = voice;
  const context = listener.context;
  if (isMuted() || context.state !== 'running' || blips >= BLIPS_MAX) return;
  const { x, y, z } = camera.position;
  if (Math.hypot(at.x - x, at.y - y, at.z - z) > HEAR_DISTANCE) return;

  const now = context.currentTime, end = now + Math.max(0.05, length*0.85);
  const { through = 0.5, stressed = false, last = false, question = false } = intonation ?? {};
  const f = pitch*(1 + (Math.random()*2 - 1)*BEND)*(1 + DRIFT*(1 - 2*through))*(stressed ? 1 + STRESS : 1);
  // (the slide through the syllable: a phrase's end falls, or rises for a question; otherwise a little either way, lifted
  // by cheer and sagging with gloom)
  const slide = last ? (question ? 1.3 : 0.8) : 1 + Math.max(-0.2, Math.min(0.2, mood*0.1 + (Math.random() - 0.5)*0.1));
  const oscillator = context.createOscillator();
  oscillator.type = 'sawtooth';
  oscillator.frequency.setValueAtTime(f, now);
  oscillator.frequency.exponentialRampToValueAtTime(f*slide, end);
  // the vowel: its two formants, moved by the voice's own; and the consonant before it, taking up to 40% of the syllable
  const vowel = VOWELS[Math.floor(Math.random()*VOWELS.length)];
  const consonant = CONSONANTS[Math.floor(Math.random()*CONSONANTS.length)];
  const c = consonant ? Math.min(consonant.time, (end - now)*0.4) : 0;
  const level = VOLUME*(0.5 + 0.5*loudness);
  // (a stop or hiss holds the voice back till the noise is through; a hum starts it muffled)
  const voiceIn = consonant?.kind === 'stop' || consonant?.kind === 'hiss' ? now + c*0.8 : now;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.setValueAtTime(0, voiceIn);
  if (consonant?.kind === 'hum') {
    gain.gain.linearRampToValueAtTime(level*0.4, now + 0.012);
    gain.gain.setValueAtTime(level*0.4, now + c);
    gain.gain.linearRampToValueAtTime(level, now + c + 0.02);
  } else gain.gain.linearRampToValueAtTime(level, voiceIn + 0.012);
  gain.gain.setValueAtTime(level, end - 0.03);
  gain.gain.linearRampToValueAtTime(0, end);
  vowel.map((frequency, k) => [frequency, [1, 0.6][k], consonant?.from?.[k]]).forEach(([frequency, level, from]) => {
    const band = context.createBiquadFilter(), bandLevel = context.createGain();
    band.type = 'bandpass';
    band.frequency.setValueAtTime((from ?? frequency)*formant, now);
    if (from) {
      band.frequency.setValueAtTime(from*formant, now + (consonant.kind === 'hum' ? c : 0));
      band.frequency.linearRampToValueAtTime(frequency*formant, now + c + (consonant.kind === 'hum' ? 0.02 : 0));
    }
    band.Q.value = sharpness;
    bandLevel.gain.value = level*3*Math.sqrt(6/sharpness); // (a sharper band lets less through: made up for)
    oscillator.connect(band).connect(bandLevel).connect(gain);
  });
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = REF_DISTANCE;
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;
  gain.connect(panner).connect(listener.getInput());
  if (consonant?.noise) {
    // the click or hiss: a burst of noise through a band where that consonant sits, moved by the voice's formants too
    const source = context.createBufferSource(), band = context.createBiquadFilter(), hiss = context.createGain();
    source.buffer = noiseBuffer(context);
    band.type = 'bandpass';
    band.frequency.value = consonant.noise*Math.sqrt(formant);
    band.Q.value = consonant.q;
    const burst = consonant.kind === 'stop' ? Math.min(0.015, c) : c;
    hiss.gain.setValueAtTime(0, now);
    hiss.gain.linearRampToValueAtTime(level*consonant.level*4, now + Math.min(0.004, burst/3));
    hiss.gain.linearRampToValueAtTime(0, now + burst);
    source.connect(band).connect(hiss).connect(panner);
    source.start(now, Math.random()*0.9);
    source.stop(now + burst + 0.01);
  }
  blips++;
  oscillator.onended = () => { blips--; panner.disconnect(); };
  oscillator.start(now);
  oscillator.stop(end + 0.01);
}
