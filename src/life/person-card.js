import * as THREE from 'three';
import { App } from '../core/shared.js';
import { scene, renderer } from '../core/scene.js';
import { HEADSHOT_LAYER } from './people.js';
import { profileOf, onProfilesLoaded } from './profiles.js';

// ============================================================ person card
// Who someone is, in a card at the bottom right while the camera follows them (see "following someone" in people.js): their
// name, age and mood, and one thing they enjoy and one they hate — picked from assets/people.txt (see profiles.js), and the
// same person every time.
let shown = null; // { index, isMan } of whoever the card is showing
const card = document.getElementById('person-card');
document.getElementById('person-card-close').addEventListener('click', () => App.stopFollowingPerson());

// the headshot itself: into their head (see possession.js)
document.getElementById('pc-headshot').addEventListener('click', () => { if (shown) App.possessPerson(shown.index); });
// the Kill button, under their headshot: they explode (see killPerson in people.js), and the card goes
document.getElementById('pc-kill').addEventListener('click', () => { if (shown) App.killPerson(shown.index); });
// (once people.txt has loaded, the card shows what it says)
onProfilesLoaded(() => { if (shown) showPersonCard(shown.index, shown.isMan); });
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
