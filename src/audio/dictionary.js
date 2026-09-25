import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { listener, playBufferAt, muffler } from './sfx.js';
import { speakText, SAMPLE_RATE } from './speech.js';
import { loudnessOf, hearDistance, hearRef } from './voices.js';

// ============================================================ real words
// Now and then someone talking near the camera says something real in among their babble (see audio/voices.js): a line
// from assets/dictionary.txt, a word or a whole sentence, picked at random. It's said in their own babble voice, worked
// out into its sounds and synthesized on the spot (see audio/speech.js), set down where they stand and heard from that
// side, and quieter the further off, and as loud as they babble. Only one person says a line at a time. While they're saying it, their mouth opens as
// wide as the line's loud.
const DICTIONARY_URL = 'assets/dictionary.txt';
const LINE_CHANCE = 0.15;   // at the start of each phrase of babble (× chat speed, Options > Speech: S.chatSpeed)
const LINE_GAP = 3;         // seconds after a line ends before anyone says another (÷ chat speed)
const MATCH = 1;            // how loud a real line is next to the speaker's own babble (see loudnessOf in audio/voices.js)
const MUFFLE = 1.4; // (as for babble; beyond its hearDistance they only babble)
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

const chatSpeed = () => S.chatSpeed ?? 1;
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
 * @param {{pitch: number, formant: number, sharpness: number}} voice - their voice, as for babble
 * @param {number} who - a number of their own, so the same person always sounds the same
 * @param {number} [mood=0] - their mood trait
 * @returns {?object} the line being said (for lineMouth and stopLine; `text` is what's said); or null, for them to babble on
 */
export function sayLine(at, voice, who, mood = 0) {
  const context = listener.context, now = context.currentTime;
  if (!lines.length || current || now < quietUntil || Math.random() >= LINE_CHANCE*chatSpeed()) return null;
  if (Math.hypot(at.x - camera.position.x, at.y - camera.position.y, at.z - camera.position.z) > hearDistance()) return null;
  const text = fill(pick(lines));
  const samples = speakText(text, voice, { mood: mood ?? 0, who });
  if (!samples?.length) return null;
  // (how loud it is through each MOUTH_FRAME, for their mouth to follow; and how loud while they're sounding, the loudest
  // half of those frames, to bring it to their babble's loudness)
  const frame = Math.round(MOUTH_FRAME*SAMPLE_RATE), mouth = new Float32Array(Math.ceil(samples.length/frame));
  const power = new Float32Array(mouth.length);
  for (let i = 0; i < samples.length; i++) {
    const k = Math.floor(i/frame);
    mouth[k] = Math.max(mouth[k], Math.abs(samples[i])*1.2);
    power[k] += samples[i]*samples[i]/frame;
  }
  const loudest = power.filter(e => e > 1e-5).sort().slice(-Math.ceil(power.length/2));
  const rms = Math.sqrt(loudest.reduce((a, b) => a + b, 0)/(loudest.length || 1));
  const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);
  const source = playBufferAt(buffer, at, rms ? MATCH*loudnessOf(voice)/rms : 0, hearRef(), hearDistance(), 1, [muffler(at, hearRef(), MUFFLE)], 'peds');
  if (!source) return null;
  current = { source, start: now, length: buffer.duration, mouth, text };
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
  quietUntil = listener.context.currentTime + LINE_GAP/chatSpeed();
}
