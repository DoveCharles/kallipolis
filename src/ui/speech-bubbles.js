import * as THREE from 'three';
import { camera, renderer } from '../core/scene.js';
import { S } from '../core/shared.js';

// ============================================================ speech bubbles
// A bubble over the head of anyone saying a real line (see audio/dictionary.js), with the line in it. It stays up while
// they say it and LINGER seconds after, and is only replaced by the next line they say. It's page text laid over the
// view, so it always faces the camera and stays the same size on screen; it fades out as the camera pulls back.
// With Options > Speech > Babble bubbles on (S.babbleBubbles), each phrase of babble gets one too, in made-up words.
const FADE_END = 35;      // camera distance at which a bubble's gone, unless set by Options > Speech > Bubble distance (S.bubbleDistance)
const FADE_FROM = 12/35;  // the share of that distance at which it starts fading
const LINGER = 1.5;    // seconds a bubble stays up after its line's done
const FADE_OUT = 0.5;  // the last of which it spends fading away (a new line replacing it shows at once)

// (in the view's own layer, before the rest of the page, so the menus, toolbars and cards all draw over them)
const layer = document.getElementById('canvas-wrap') ?? document.body;
const bubbles = new Map(); // speaker → { element, line, at: THREE.Vector3, doneAt, seen }
const projected = new THREE.Vector3();

/**
 * Whether someone has a bubble up (so it's kept following them after their line).
 * @param {object} who - the speaker
 * @returns {boolean}
 */
export const hasBubble = who => bubbles.has(who);

/**
 * Keep someone's bubble over them; call each frame while they're saying a line or still have a bubble up.
 * @param {object} who - the speaker
 * @param {{x: number, y: number, z: number}} at - where the bubble's tail points (just over their head)
 * @param {?object} line - the line they're saying (as sayLine returned; its `text` is shown), or null once done
 * @returns {void}
 */
export function speechBubble(who, at, line) {
  let bubble = bubbles.get(who);
  if (!bubble) {
    if (!line) return;
    const element = document.createElement('div');
    element.className = 'speech-bubble';
    layer.appendChild(element);
    bubbles.set(who, bubble = { element, line: null, at: new THREE.Vector3(), doneAt: 0, seen: false });
  }
  if (line && line !== bubble.line) {
    bubble.line = line;
    bubble.element.textContent = line.text;
    bubble.element.classList.toggle('thought', !!line.thought); // (a thought, not said: see thoughtOf in life/people/people.js)
  }
  bubble.doneAt = line ? 0 : bubble.doneAt || performance.now();
  bubble.at.set(at.x, at.y, at.z);
  bubble.seen = true;
}

const ONSETS = ['b', 'd', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'w', 'y', 'bl', 'sh', 'ch'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'o', 'ee', 'oo'];
const pickFrom = list => list[Math.floor(Math.random()*list.length)];

/**
 * Made-up words for a phrase of babble (see nextSyllable in audio/voices.js): one syllable per syllable said, a new word
 * at each stress, capitalised, ending ? for a question.
 * @param {{length: number, beat: number, question: boolean}} phrase
 * @returns {{text: string, phrase: object}} a line to show with speechBubble
 */
export function babbleLine(phrase) {
  const words = [];
  for (let k = 0; k < phrase.length; k++) {
    const syllable = pickFrom(ONSETS) + pickFrom(VOWELS);
    if (k % phrase.beat === 0) words.push(syllable); else words[words.length - 1] += syllable;
  }
  const text = words.join(' ');
  return { text: text[0].toUpperCase() + text.slice(1) + (phrase.question ? '?' : '...'), phrase };
}

/**
 * Place every bubble on screen for this frame (after the camera's settled), removing those that have lingered long
 * enough or whose speaker wasn't kept up this frame.
 * @returns {void}
 */
export function updateSpeechBubbles() {
  if (!bubbles.size) return;
  const view = renderer.domElement.getBoundingClientRect(), now = performance.now();
  for (const [who, bubble] of bubbles) {
    if (!bubble.seen || (bubble.doneAt && now - bubble.doneAt > LINGER*1000)) { bubble.element.remove(); bubbles.delete(who); continue; }
    bubble.seen = false;
    const fadeEnd = S.bubbleDistance ?? FADE_END, fadeStart = fadeEnd*FADE_FROM;
    const ending = bubble.doneAt ? Math.min(1, (LINGER*1000 - (now - bubble.doneAt))/(FADE_OUT*1000)) : 1;
    const fade = ending*(1 - (camera.position.distanceTo(bubble.at) - fadeStart)/(fadeEnd - fadeStart));
    projected.copy(bubble.at).project(camera);
    const onScreen = projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2;
    bubble.element.style.opacity = onScreen ? String(Math.max(0, Math.min(1, fade))) : '0';
    if (!onScreen) continue;
    bubble.element.style.left = `${view.left + (projected.x + 1)/2*view.width}px`;
    bubble.element.style.top = `${view.top + (1 - projected.y)/2*view.height}px`;
  }
}
