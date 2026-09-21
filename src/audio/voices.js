import { camera } from '../core/scene.js';
import { listener, isMuted } from './sfx.js';

// ============================================================ voices
// People talking babble, Animal Crossing style: every time a speaker's mouth opens on a new syllable (see "talking" in
// life/people/people.js) a short blip plays from their head — a buzzy tone at their voice's pitch, bent a little up or
// down each syllable and sliding as it goes, through two bandpass filters set to a random vowel's formants. Each blip is
// built live, like the engine (see engine.js), and gone once it's played. Only those within HEAR_DISTANCE of the camera
// are heard, so a crowded plaza across town costs nothing.
const VOWELS = [[800, 1200], [500, 1900], [300, 2300], [500, 900], [350, 800], [650, 1600]]; // [F1, F2] in Hz: a, e, i, o, u, and something in between
const HEAR_DISTANCE = 60;          // beyond this from the camera they aren't heard at all
const REF_DISTANCE = 6;            // how near to be heard at full volume
const VOLUME = 0.22;
const BLIPS_MAX = 12;              // syllables sounding at once, past which new ones are dropped
const BEND = 0.25;                 // how far each syllable's pitch strays from the voice's, either way

let blips = 0;

/**
 * One syllable of someone's babble.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice - its pitch in Hz; how far its formants sit from an
 *   ordinary voice's (the shape of their mouth and throat: above 1 smaller and brighter, below 1 bigger and darker); and how
 *   sharp those formants ring (low breathy, high nasal and buzzy)
 * @param {number} length - seconds until their next syllable
 * @param {number} [loudness=1] - how wide their mouth opens on it, 0 to 1
 * @param {number} [mood=0] - their mood trait: the cheerier, the more their syllables lift, the glummer, the more they sag
 * @returns {void}
 */
export function babble(at, voice, length, loudness = 1, mood = 0) {
  const { pitch, formant, sharpness } = voice;
  const context = listener.context;
  if (isMuted() || context.state !== 'running' || blips >= BLIPS_MAX) return;
  const { x, y, z } = camera.position;
  if (Math.hypot(at.x - x, at.y - y, at.z - z) > HEAR_DISTANCE) return;

  const now = context.currentTime, end = now + Math.max(0.05, length*0.85);
  const f = pitch*(1 + (Math.random()*2 - 1)*BEND), slide = 1 + Math.max(-0.3, Math.min(0.3, mood*0.15 + (Math.random() - 0.5)*0.2));
  const oscillator = context.createOscillator();
  oscillator.type = 'sawtooth';
  oscillator.frequency.setValueAtTime(f, now);
  oscillator.frequency.exponentialRampToValueAtTime(f*slide, end);
  // the vowel: its two formants, moved by the voice's own
  const [f1, f2] = VOWELS[Math.floor(Math.random()*VOWELS.length)];
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(VOLUME*(0.5 + 0.5*loudness), now + 0.012);
  gain.gain.setValueAtTime(VOLUME*(0.5 + 0.5*loudness), end - 0.03);
  gain.gain.linearRampToValueAtTime(0, end);
  [[f1, 1], [f2, 0.6]].forEach(([frequency, level]) => {
    const band = context.createBiquadFilter(), bandLevel = context.createGain();
    band.type = 'bandpass';
    band.frequency.value = frequency*formant;
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
  blips++;
  oscillator.onended = () => { blips--; panner.disconnect(); };
  oscillator.start(now);
  oscillator.stop(end + 0.01);
}
