import { S, App } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { serializeProject, loadProjectFromData } from './save-load.js';
import { loadProgress } from './progress.js';
import { modelsLoaded, loadingTask } from '../ui/loading.js';
import { serializeCrowd } from '../life/people/peopleKeep.js';
import { serializeCars } from '../life/traffic/carKeep.js';
import { onFavoritesChanged } from '../ui/favorites.js';

// ============================================================ autosave
// The project (everything a saved project file holds, map images and all) and where the camera is are kept in the
// browser — in IndexedDB, which has room for map images where localStorage doesn't — and put back when the page next
// opens, so a refresh loses nothing. It's saved a moment after anything's changed (the same moments undo takes a step,
// and after zooming), and whenever the tab's hidden or closed. Clear empties it along with the scene; Save/Load project
// still read and write files.
// Who's in the crowd and on the roads (life/people/peopleKeep.js, life/traffic/carKeep.js) is kept under keys of their own,
// so they can be saved often without writing the map images again: with the project, CROWD_DELAY after a death, a car
// destroyed or (un)hearting, and every CROWD_EVERY.
const DB_NAME = 'splinetopia', STORE_NAME = 'autosave', RECORD_KEY = 'current', CROWD_KEY = 'crowd', TRAFFIC_KEY = 'traffic';
const CROWD_DELAY = 3000, CROWD_EVERY = 45000; // ms
let ready = false, restoring = false, saveTimer = null, crowdTimer = null, warned = false;
navigator.storage?.persist?.().catch(() => {}); // (asks the browser not to clear it under disk pressure)
// (index.html?blank: an empty scene, never saved — for tools/ped-maker.html)
// (and index.html?join=CODE: a guest in someone else's city — see net/net.js)
const BLANK = ['blank', 'join'].some(key => new URLSearchParams(location.search).has(key));

const database = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}).catch(err => { console.warn('Kallipolis: the browser won\'t keep an autosave (IndexedDB unavailable)', err); return null; });
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
  const project = serializeProject();
  delete project.crowd; delete project.traffic; // (their own keys: saveCrowd)
  saveCrowd();
  const record = {
    savedAt: Date.now(),
    project,
    camera: { target: controls.goalTarget.toArray(), radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi },
  };
  try {
    await inStore('readwrite', store => store.put(record, RECORD_KEY));
  } catch (err) {
    if (!warned) { warned = true; console.warn('Kallipolis: autosave failed', err); }
  }
}
async function saveCrowd() {
  clearTimeout(crowdTimer);
  crowdTimer = null;
  if (!ready || restoring) return;
  const crowd = serializeCrowd(), traffic = serializeCars();
  try { await inStore('readwrite', store => { store.put(traffic, TRAFFIC_KEY); return store.put(crowd, CROWD_KEY); }); }
  catch (err) { if (!warned) { warned = true; console.warn('Kallipolis: autosave failed', err); } }
}
const crowdChanged = () => { if (ready && !crowdTimer) crowdTimer = setTimeout(saveCrowd, CROWD_DELAY); };
onFavoritesChanged(crowdChanged);
setInterval(() => { if (S.peopleEnabled && !document.hidden) saveCrowd(); }, CROWD_EVERY);
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

// on opening: the last autosave, if there is one (nothing's saved over it until it's back) — once the models are in, so
// it's built with them the first time (see ui/loading.js)
loadingTask('Building the city...', (async () => {
  let restoredCleanly = false;
  if (BLANK) return;
  try {
    const record = await inStore('readonly', store => store.get(RECORD_KEY));
    if (record && record.project && record.project.roads && record.project.zones) {
      restoring = true;
      const crowd = await inStore('readonly', store => store.get(CROWD_KEY));
      if (crowd) record.project.crowd = crowd;
      const traffic = await inStore('readonly', store => store.get(TRAFFIC_KEY));
      if (traffic) record.project.traffic = traffic;
      await modelsLoaded;
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
    else loadProgress(undefined); // (no project yet: the old browser-wide progress, or fresh — see progress.js)
    restoredCleanly = true; // restored, or there was nothing to restore
  } catch (err) {
    // A failed restore leaves the scene half-loaded: autosaving now would destroy the very
    // record that failed to load, so stay off for this session and say so.
    console.warn('Kallipolis: couldn\'t restore the autosave — autosave is off for this session so the saved project is not overwritten. Reload to try again.', err);
  } finally {
    restoring = false;
    ready = restoredCleanly;
  }
})(), 5);

Object.assign(App, { saveNow: save, crowdChanged, scheduleSave });
