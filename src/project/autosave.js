import { S, App } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { serializeProject, loadProjectFromData } from './save-load.js';

// ============================================================ autosave
// The project (everything a saved project file holds, map images and all) and where the camera is are kept in the
// browser — in IndexedDB, which has room for map images where localStorage doesn't — and put back when the page next
// opens, so a refresh loses nothing. It's saved a moment after anything's changed (the same moments undo takes a step,
// and after zooming), and whenever the tab's hidden or closed. Clear empties it along with the scene; Save/Load project
// still read and write files.
const DB_NAME = 'splinetopia', STORE_NAME = 'autosave', RECORD_KEY = 'current';
let ready = false, restoring = false, saveTimer = null, warned = false;

const database = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}).catch(err => { console.warn('Blockout: the browser won\'t keep an autosave (IndexedDB unavailable)', err); return null; });
// runs `action` on the store, resolving with its request's result once the transaction's done
async function inStore(mode, action) {
  const db = await database;
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode), request = action(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!ready || restoring) return;
  const record = {
    savedAt: Date.now(),
    project: serializeProject(),
    camera: { target: controls.goalTarget.toArray(), radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi },
  };
  try {
    await inStore('readwrite', store => store.put(record, RECORD_KEY));
  } catch (err) {
    if (!warned) { warned = true; console.warn('Blockout: autosave failed', err); }
  }
}
function scheduleSave(delay) {
  if (!ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, delay);
}
['pointerup', 'keyup', 'change', 'drop', 'dragend'].forEach(type => window.addEventListener(type, () => scheduleSave(1000), true));
window.addEventListener('input', () => scheduleSave(1500), true);
window.addEventListener('wheel', () => scheduleSave(1500), { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
window.addEventListener('pagehide', save);

// on opening: the last autosave, if there is one (nothing's saved over it until it's back)
(async () => {
  let restoredCleanly = false;
  try {
    const record = await inStore('readonly', store => store.get(RECORD_KEY));
    if (record && record.project && record.project.roads && record.project.zones) {
      restoring = true;
      await loadProjectFromData(record.project);
      const camera = record.camera;
      if (camera && Array.isArray(camera.target)) {
        controls.goalTarget.fromArray(camera.target);
        if (Number.isFinite(camera.radius)) controls.goalRadius = camera.radius;
        if (Number.isFinite(camera.theta)) controls.goalTheta = camera.theta;
        if (Number.isFinite(camera.phi)) controls.goalPhi = camera.phi;
      }
      App.resetHistory(); // (the restored project is where undo starts from, not a step to undo)
    }
    restoredCleanly = true; // restored, or there was nothing to restore
  } catch (err) {
    // A failed restore leaves the scene half-loaded: autosaving now would destroy the very
    // record that failed to load, so stay off for this session and say so.
    console.warn('Blockout: couldn\'t restore the autosave — autosave is off for this session so the saved project is not overwritten. Reload to try again.', err);
  } finally {
    restoring = false;
    ready = restoredCleanly;
  }
})();

Object.assign(App, { saveNow: save });
