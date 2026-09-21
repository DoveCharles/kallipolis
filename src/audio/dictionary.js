import SamJs from 'sam-js';
import { camera } from '../core/scene.js';
import { listener, playBufferAt } from './sfx.js';

// ============================================================ real words
// Now and then someone talking near the camera says something real in among their babble (see audio/voices.js): a line
// from assets/dictionary.txt, a word or a whole sentence, picked at random. It's spoken by SAM, the Software Automatic
// Mouth (the Commodore 64's speech synth, 1982, ported to JavaScript as sam-js), which works the words out into sounds and
// renders them as samples right here — so, like every other sound, it's synthesized on the spot, set down where they
// stand and heard from that side, and quieter the further off. Only one person says a line at a time.
//
// SAM's voice is set from their babble's: its pitch (SAM counts it the other way, lower numbers higher), its mouth and
// throat (where its formants sit) from theirs, so a big man's lower and fuller and a small woman's higher and brighter;
// and a touch quicker the cheerier they are. While they're saying it, their mouth opens as wide as the line's loud.
const DICTIONARY_URL = 'assets/dictionary.txt';
const LINE_CHANCE = 0.15;   // at the start of each phrase of babble
const SAY_DISTANCE = 40;    // beyond this from the camera they only babble
const LINE_GAP = 3;         // seconds after a line ends before anyone says another
const VOLUME = 0.12;   // (SAM's loud and flat next to babble's filtered buzz: this brings it down level with it)
const REF_DISTANCE = 6, HEAR_DISTANCE = 60; // (as for babble)
const SAMPLE_RATE = 22050;  // SAM's
const MOUTH_FRAME = 0.05;   // seconds over which how wide the mouth is follows the line

let lines = [];
let lists = {};     // the word lists a line's [placeholders] are filled from, by name (lower-cased)
let current = null; // { source, start, length, mouth: Float32Array } for the line being said
let quietUntil = 0;

// A line on its own like [animal] starts a word list, running to the next blank line; every other line is one to say,
// and a [name] in it is filled with a random pick from that list each time it's said.
fetch(DICTIONARY_URL).then(r => r.ok ? r.text() : '').then(text => {
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (!line) { list = null; continue; }
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) list = lists[header[1].trim().toLowerCase()] = [];
    else (list ?? lines).push(line);
  }
}).catch(() => {});

const pick = list => list[Math.floor(Math.random()*list.length)];
// (a pick can have [placeholders] of its own; one naming no list is dropped rather than read out, brackets and all)
function fill(line, depth = 0) {
  return line.replace(/\[([^\]]+)\]/g, (_, name) => {
    const list = lists[name.trim().toLowerCase()];
    return list?.length && depth < 4 ? fill(pick(list), depth + 1) : '';
  }).replace(/\s+/g, ' ').trim();
}

/**
 * At the start of a phrase of someone's babble, maybe have them say a real line instead.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number}} voice - their voice, as for babble
 * @param {number} who - a number of their own, so the same person always sounds the same
 * @param {number} [mood=0] - their mood trait
 * @returns {?object} the line being said (for lineMouth and stopLine); or null, for them to babble on
 */
export function sayLine(at, voice, who, mood = 0) {
  const context = listener.context, now = context.currentTime;
  if (!lines.length || current || now < quietUntil || Math.random() >= LINE_CHANCE) return null;
  if (Math.hypot(at.x - camera.position.x, at.y - camera.position.y, at.z - camera.position.z) > SAY_DISTANCE) return null;
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  const shape = 128*voice.formant*(0.95 + ((who*13) % 7)*0.015);
  const sam = new SamJs({
    pitch: clamp(64*150/voice.pitch, 28, 110),
    mouth: clamp(shape, 90, 200),
    throat: clamp(shape*0.95, 90, 200),
    speed: clamp(72/(1 + (mood ?? 0)*0.08 + ((who*7) % 11 - 5)*0.015), 55, 95),
  });
  const samples = sam.buf32(fill(pick(lines)));
  if (!samples?.length) return null;
  const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);
  const source = playBufferAt(buffer, at, VOLUME, REF_DISTANCE, HEAR_DISTANCE);
  if (!source) return null;
  // (how loud it is through each MOUTH_FRAME, for their mouth to follow: SAM's loudest is about half)
  const frame = Math.round(MOUTH_FRAME*SAMPLE_RATE), mouth = new Float32Array(Math.ceil(samples.length/frame));
  for (let i = 0; i < samples.length; i++) mouth[Math.floor(i/frame)] = Math.max(mouth[Math.floor(i/frame)], Math.abs(samples[i])*2);
  current = { source, start: now, length: buffer.duration, mouth };
  return current;
}

/**
 * How wide someone saying a line has their mouth open just now.
 * @param {object} line - as sayLine returned
 * @returns {number} 0 to 1; or -1, once the line's done
 */
export function lineMouth(line) {
  const t = listener.context.currentTime - line.start;
  if (line !== current || t >= line.length) { finish(line); return -1; }
  return Math.min(1, line.mouth[Math.floor(t/MOUTH_FRAME)] ?? 0);
}

/**
 * Stop a line partway, when whoever's saying it stops talking.
 * @param {?object} line - as sayLine returned
 * @returns {void}
 */
export function stopLine(line) {
  if (!line || line !== current) return;
  try { line.source.stop(); } catch { /* (already ended) */ }
  finish(line);
}

function finish(line) {
  if (line !== current) return;
  current = null;
  quietUntil = listener.context.currentTime + LINE_GAP;
}
