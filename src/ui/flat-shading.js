import { scene } from '../core/scene.js';

// Display > Flat shading: every lit material in the scene drawn with faceted (per-face) normals. Flat shading is a
// per-material flag, so while on, the scene is swept every SWEEP_MS for materials not yet flattened (models load late,
// and roads/zones rebuild theirs on every edit); each material's own setting is kept and restored when turned off.
// A browser preference in localStorage, like pixelation.
const FLAT_KEY = 'splinetopia.flatShading';
const SWEEP_MS = 500;
const toggle = document.getElementById('s-flatshade');
const originalFlat = new WeakMap(); // material -> its own flatShading, for every material this has changed
let flat = false, sweepTimer = 0;

const canFlatten = mat => mat && 'flatShading' in mat && !mat.isShaderMaterial;
function forEachMaterial(visit) {
  scene.traverse(obj => {
    if (!obj.material) return;
    for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) if (canFlatten(mat)) visit(mat);
  });
}
function flattenAll() {
  forEachMaterial(mat => {
    if (originalFlat.has(mat) || mat.flatShading) return;
    originalFlat.set(mat, mat.flatShading);
    mat.flatShading = true;
    mat.needsUpdate = true;
  });
}
function restoreAll() {
  forEachMaterial(mat => {
    if (!originalFlat.has(mat)) return;
    mat.flatShading = originalFlat.get(mat);
    mat.needsUpdate = true;
    originalFlat.delete(mat);
  });
}
function setFlatShading(on, save) {
  flat = on;
  toggle.classList.toggle('on', on);
  clearInterval(sweepTimer);
  if (on) { flattenAll(); sweepTimer = setInterval(flattenAll, SWEEP_MS); }
  else restoreAll();
  if (save) try { localStorage.setItem(FLAT_KEY, on ? '1' : '0'); } catch (err) { /* storage blocked */ }
}

toggle.addEventListener('click', () => setFlatShading(!flat, true));
let saved = null;
try { saved = localStorage.getItem(FLAT_KEY); } catch (err) { /* storage blocked */ }
setFlatShading(saved === '1', false);
