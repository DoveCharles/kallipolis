import * as THREE from 'three';
import { App } from '../core/shared.js';
import { scene, renderer } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { HEADSHOT_LAYER } from './people.js';

// ============================================================ person card
// Who someone is, in a card at the bottom right while the camera follows them (see "following someone" in people.js): their
// name, age and mood, and one thing they enjoy and one they hate. What those are picked from is in assets/people.txt, to be
// edited freely; each person's picks are fixed by their place in the crowd, so they're the same person every time.
const PEOPLE_TEXT_URL = 'assets/people.txt';
// the lists, by their headings in people.txt — these stand in until it's loaded, or if it can't be
const lists = { 'boy names': ['Dave'], 'girl names': ['Linda'], 'moods': ['🙂'], 'enjoys': ['A nice walk'], 'hates': ['Puddles'] };
let shown = null; // { index, isMan } of whoever the card is showing
const card = document.getElementById('person-card');
document.getElementById('person-card-close').addEventListener('click', () => App.stopFollowingPerson());

// people.txt: a [heading] starts each list, one entry per line after it; blank lines and lines starting with # are skipped
function parsePeopleText(text) {
  const parsed = {};
  let current = null;
  text.split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const heading = line.match(/^\[(.+)\]$/);
    if (heading) { current = heading[1].trim().toLowerCase(); parsed[current] = []; return; }
    if (current) parsed[current].push(line);
  });
  return parsed;
}
fetch(PEOPLE_TEXT_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => {
    const parsed = parsePeopleText(text);
    Object.keys(lists).forEach(key => { if (parsed[key] && parsed[key].length) lists[key] = parsed[key]; });
    if (shown) showPersonCard(shown.index, shown.isMan);
  })
  .catch(err => console.warn('Blockout: assets/people.txt failed to load; people get placeholder names', err));

// someone's name, age, mood, and what they enjoy and hate — a man's name from the boy names and a woman's from the girl names
// (either, for the cuboid people, who have no sex)
function profileOf(index, isMan) {
  const rng = mulberry32(48271 + index*7919);
  const pick = list => list[Math.floor(rng()*list.length)];
  const man = isMan == null ? rng() < 0.5 : isMan;
  return { name: pick(lists[man ? 'boy names' : 'girl names']), age: 18 + Math.floor(rng()*65), mood: pick(lists.moods),
    enjoys: pick(lists.enjoys), hates: pick(lists.hates) };
}
function showPersonCard(index, isMan) {
  shown = { index, isMan };
  const profile = profileOf(index, isMan);
  ['name', 'age', 'mood', 'enjoys', 'hates'].forEach(key => { document.getElementById('pc-' + key).textContent = profile[key]; });
  // (no headshot of a cuboid person, before the people model has loaded)
  headshotContext.clearRect(0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE);
  headshotCanvas.hidden = isMan == null;
  headshotDrawnAt = -Infinity;
  lightsOnLayer = false;
  card.hidden = false;
}

// ---- the headshot: a live close-up of their face, beside their name — drawn a few times a second (people.js hands over
// where their head is and which way it faces) from a camera just in front of it that sees only the people, on a clear
// background, into a little render target of its own, whose pixels are copied onto the card's canvas
const HEADSHOT_SIZE = 120; // pixels across (shown half that, sharp on high-density screens)
const HEADSHOT_INTERVAL = 1/15;
const headshotTarget = new THREE.WebGLRenderTarget(HEADSHOT_SIZE, HEADSHOT_SIZE);
const headshotCamera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
headshotCamera.layers.set(HEADSHOT_LAYER);
const headshotCanvas = document.getElementById('pc-headshot');
const headshotContext = headshotCanvas.getContext('2d'), headshotImage = headshotContext.createImageData(HEADSHOT_SIZE, HEADSHOT_SIZE);
const headshotPixels = new Uint8Array(HEADSHOT_SIZE*HEADSHOT_SIZE*4), clearColor = new THREE.Color();
let headshotDrawnAt = -Infinity, lightsOnLayer = false;
// `view`: { head, forward, up, distance } in the world
function drawPersonHeadshot(view) {
  const now = performance.now()/1000;
  if (!shown || headshotCanvas.hidden || now - headshotDrawnAt < HEADSHOT_INTERVAL) return;
  headshotDrawnAt = now;
  // the lights light them there too (put on the layer each time the card opens, to catch any added since)
  if (!lightsOnLayer) { scene.traverse(o => { if (o.isLight) o.layers.enable(HEADSHOT_LAYER); }); lightsOnLayer = true; }
  headshotCamera.position.copy(view.head).addScaledVector(view.forward, view.distance);
  headshotCamera.up.copy(view.up);
  headshotCamera.lookAt(view.head);
  headshotCamera.near = view.distance*0.3;
  headshotCamera.updateProjectionMatrix();
  // drawn with the shadows as the view last drew them, and a clear background, then everything put back
  const target = renderer.getRenderTarget(), shadows = renderer.shadowMap.autoUpdate, clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(headshotTarget);
  renderer.render(scene, headshotCamera);
  renderer.readRenderTargetPixels(headshotTarget, 0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE, headshotPixels);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clearColor, clearAlpha);
  renderer.shadowMap.autoUpdate = shadows;
  // (the render target's rows run bottom to top)
  const rowBytes = HEADSHOT_SIZE*4;
  for (let y=0;y<HEADSHOT_SIZE;y++) headshotImage.data.set(headshotPixels.subarray((HEADSHOT_SIZE - 1 - y)*rowBytes, (HEADSHOT_SIZE - y)*rowBytes), y*rowBytes);
  headshotContext.putImageData(headshotImage, 0, 0);
}
function hidePersonCard() {
  shown = null;
  card.hidden = true;
}

Object.assign(App, { showPersonCard, hidePersonCard, drawPersonHeadshot });
