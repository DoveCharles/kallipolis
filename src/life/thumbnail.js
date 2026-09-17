import * as THREE from 'three';
import { renderer } from '../core/scene.js';

// ============================================================ card thumbnails
// The picture on the car and train cards: a view of one mesh ({ mesh, camera }, or null for a blank), lit on its own and
// drawn once into a canvas when the card opens rather than every frame — unlike a person, a car or a carriage doesn't
// pose, so there's nothing to keep redrawing. Each canvas gets its own drawer, and its own little scene to draw in.
const THUMB_SIZE = 120;
const thumbTarget = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE);
const thumbPixels = new Uint8Array(THUMB_SIZE*THUMB_SIZE*4), clearColor = new THREE.Color();

export function makeThumbnailDrawer(canvas) {
  const thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 6, 4);
  thumbScene.add(keyLight);
  const context = canvas.getContext('2d'), image = context.createImageData(THUMB_SIZE, THUMB_SIZE);
  let meshInScene = null;
  return function drawThumbnail(view) {
    context.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    if (!view) return;
    if (meshInScene !== view.mesh) {
      if (meshInScene) thumbScene.remove(meshInScene);
      thumbScene.add(view.mesh);
      meshInScene = view.mesh;
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
    for (let y=0;y<THUMB_SIZE;y++) image.data.set(thumbPixels.subarray((THUMB_SIZE - 1 - y)*rowBytes, (THUMB_SIZE - y)*rowBytes), y*rowBytes);
    context.putImageData(image, 0, 0);
  };
}
