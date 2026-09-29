import * as THREE from 'three';
import { camera } from '../core/scene.js';
import { pubSongTitle, skipPubSong } from '../audio/pub-music.js';
import { roomHolds, roomKind } from './interior.js';

// ============================================================ the jukebox
// Every pub has a jukebox (the Jukebox piece in assets/models/Pub.glb, stood against a wall by furnishPub in
// interior.js). With the pointer over it, a label floats over its top with the song the pub's on (see
// audio/pub-music.js); a click puts the next one on (skipPubSong). Its arch of lit tubes slowly runs through the colours.
const HUE_SPEED = 0.05;         // times round the colours a second
const LABEL_UP = 0.25;          // how far over its top the label is

let box = null, boxKey = null, tubes = [], hovered = false;
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), top = new THREE.Vector3();

/**
 * The pub's jukebox, just put in the room (or none, the room refurnished without one).
 * @param {THREE.Object3D|null} object - it, as placed
 * @param {string} [key] - the pub's building key
 * @returns {void}
 */
export function placeJukebox(object, key) {
  box = object; boxKey = key; hovered = false;
  tubes = [];
  object?.traverse(o => { if (o.isMesh && o.material.name === 'GlowTube' && !tubes.includes(o.material)) tubes.push(o.material); });
}

// the jukebox, if the view's in the pub it's in
const shown = () => box && roomKind() === 'pub' && roomHolds(boxKey) ? box : null;

/**
 * Whether the jukebox is under a point on the screen.
 * @param {number} x - client x
 * @param {number} y - client y
 * @returns {boolean}
 */
export function jukeboxAt(x, y) {
  const it = shown();
  if (!it) return false;
  pointer.set(x/window.innerWidth*2 - 1, -y/window.innerHeight*2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(it, true).length > 0;
}

/**
 * The pointer's moved: the label shown over the jukebox while it's over it.
 * @returns {boolean} whether it's over it
 */
export function hoverJukebox(x, y) {
  return hovered = jukeboxAt(x, y);
}

/**
 * A click at a point on the screen: if it's on the jukebox, the next song's put on.
 * @returns {boolean} whether it was
 */
export function clickJukebox(x, y) {
  if (!jukeboxAt(x, y)) return false;
  skipPubSong(boxKey);
  hovered = true;
  return true;
}

// the label: page text over the view, as the Press E one is (.use-label: see people/peopleTracking.js)
const label = document.createElement('div');
label.className = 'use-label';
label.hidden = true;
(document.getElementById('canvas-wrap') ?? document.body).appendChild(label);
let labelText = '';

/**
 * Each frame: the tubes' colour, and the label kept over the jukebox with the song that's on.
 * @returns {void}
 */
export function updateJukebox() {
  const it = shown();
  if (it) for (const material of tubes) material.emissive.setHSL((performance.now()/1000*HUE_SPEED) % 1, 0.85, 0.55);
  if (!it || !hovered) { label.hidden = true; return; }
  const box3 = new THREE.Box3().setFromObject(it);
  top.set((box3.min.x + box3.max.x)/2, box3.max.y + LABEL_UP, (box3.min.z + box3.max.z)/2).project(camera);
  if (top.z > 1) { label.hidden = true; return; }
  const title = pubSongTitle(boxKey);
  const text = title ? `♪ ${title}` : 'Jukebox';
  if (text !== labelText) label.textContent = labelText = text;
  label.hidden = false;
  label.style.left = `${(top.x + 1)/2*window.innerWidth}px`;
  label.style.top = `${(1 - top.y)/2*window.innerHeight}px`;
}
