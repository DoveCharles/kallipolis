import * as THREE from 'three';
import { App } from '../core/shared.js';
import { renderer } from '../core/scene.js';
import { carThumbnailScene } from './traffic.js';

// ============================================================ car card
// Who's behind the wheel, in a card at the bottom right while the camera follows a vehicle (see "following a car" in
// traffic.js): its name (its model and a number of its own, among others like it — see designNumbers in traffic.js), its
// mood (what kind of vehicle it is, as an emoji), and what it enjoys and hates — the same for every one of them.
const card = document.getElementById('car-card');
document.getElementById('car-card-close').addEventListener('click', () => App.stopFollowingCar());
function showCarCard(i, info) {
  document.getElementById('cc-name').textContent = info.name;
  document.getElementById('cc-mood').textContent = info.mood;
  document.getElementById('cc-enjoys').textContent = 'Beep beep';
  document.getElementById('cc-hates').textContent = 'Honkkkk';
  card.hidden = false;
  drawCarThumbnail(i);
}
function hideCarCard() {
  card.hidden = true;
}

// ---- the thumbnail: an isometric-angled view of the car's own design (see carThumbnailScene), drawn once when the card
// opens rather than every frame — unlike a person, a car doesn't pose, so there's nothing to keep redrawing.
const THUMB_SIZE = 120;
const thumbTarget = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE);
const thumbScene = new THREE.Scene();
thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
const thumbKeyLight = new THREE.DirectionalLight(0xffffff, 1.8);
thumbKeyLight.position.set(3, 6, 4);
thumbScene.add(thumbKeyLight);
const thumbCanvas = document.getElementById('cc-thumb');
const thumbContext = thumbCanvas.getContext('2d'), thumbImage = thumbContext.createImageData(THUMB_SIZE, THUMB_SIZE);
const thumbPixels = new Uint8Array(THUMB_SIZE*THUMB_SIZE*4), clearColor = new THREE.Color();
let thumbMeshInScene = null;
function drawCarThumbnail(i) {
  const view = carThumbnailScene(i);
  thumbContext.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  if (!view) return; // (no thumbnail of a box car, before the models have loaded)
  if (thumbMeshInScene !== view.mesh) {
    if (thumbMeshInScene) thumbScene.remove(thumbMeshInScene);
    thumbScene.add(view.mesh);
    thumbMeshInScene = view.mesh;
  }
  const target = renderer.getRenderTarget(), clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(thumbTarget);
  renderer.render(thumbScene, view.camera);
  renderer.readRenderTargetPixels(thumbTarget, 0, 0, THUMB_SIZE, THUMB_SIZE, thumbPixels);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clearColor, clearAlpha);
  // (the render target's rows run bottom to top)
  const rowBytes = THUMB_SIZE*4;
  for (let y=0;y<THUMB_SIZE;y++) thumbImage.data.set(thumbPixels.subarray((THUMB_SIZE - 1 - y)*rowBytes, (THUMB_SIZE - y)*rowBytes), y*rowBytes);
  thumbContext.putImageData(thumbImage, 0, 0);
}

Object.assign(App, { showCarCard, hideCarCard });
