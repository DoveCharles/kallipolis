import * as THREE from 'three';
import { renderer } from '../core/scene.js';

// ============================================================ card thumbnails
/**
 * Still pictures for the car and train cards.
 *
 * Each canvas owns its own drawer and its own throwaway scene. A thumbnail is drawn once, when its
 * card opens, rather than every frame: a car or a carriage doesn't move about within its card the way
 * a person does, so there is nothing to keep redrawing.
 *
 * @module life/thumbnail
 */

/** Edge length, in pixels, of the square each thumbnail is rendered at. */
const THUMB_SIZE = 120;
/** Offscreen target the mesh is rendered into before its pixels are read back. */
const thumbTarget = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE);
/** Reused read-back buffer and colour scratch, so drawing a thumbnail allocates nothing. */
const thumbPixels = new Uint8Array(THUMB_SIZE*THUMB_SIZE*4), clearColor = new THREE.Color();

/**
 * Build a drawer bound to one canvas.
 *
 * Every drawer is independent and reuses a single shared render target, so the returned function must
 * not be called while another drawer's render is somehow still in flight — it is a synchronous
 * read-back, so in practice this just means one thumbnail at a time.
 *
 * @param {HTMLCanvasElement} canvas Receives the finished picture.
 * @returns {(view: { mesh: THREE.Object3D, camera: THREE.Camera }|null) => void} Draws `view.mesh`
 *   through `view.camera`; pass `null` to clear the canvas to blank.
 */
export function makeThumbnailDrawer(canvas) {
  const thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  // One key light, brighter than the world's, so the mesh reads clearly at 120px.
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 6, 4);
  thumbScene.add(keyLight);
  const context = canvas.getContext('2d'), image = context.createImageData(THUMB_SIZE, THUMB_SIZE);
  let meshInScene = null;
  return function drawThumbnail(view) {
    context.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    if (!view) return;
    // The caller's mesh lives in the real scene, so it is moved into the thumbnail scene to be drawn
    // alone — hence the detach below when a different vehicle's card opens.
    if (meshInScene !== view.mesh) {
      if (meshInScene) thumbScene.remove(meshInScene);
      thumbScene.add(view.mesh);
      meshInScene = view.mesh;
    }
    // Render to the offscreen target with the main canvas's clear state saved and restored around it.
    const previousTarget = renderer.getRenderTarget(), previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(thumbTarget);
    renderer.render(thumbScene, view.camera);
    renderer.readRenderTargetPixels(thumbTarget, 0, 0, THUMB_SIZE, THUMB_SIZE, thumbPixels);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, previousClearAlpha);
    // WebGL hands rows back bottom to top, but ImageData expects them top to bottom, so flip them.
    const rowBytes = THUMB_SIZE*4;
    for (let y=0;y<THUMB_SIZE;y++) image.data.set(thumbPixels.subarray((THUMB_SIZE - 1 - y)*rowBytes, (THUMB_SIZE - y)*rowBytes), y*rowBytes);
    context.putImageData(image, 0, 0);
  };
}
