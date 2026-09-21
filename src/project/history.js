import { S, App } from '../core/shared.js';
import { selectItem } from '../ui/panels.js';
import { cancelActiveDrawing } from '../editor/tools.js';
import { serializeProject, loadProjectFromData } from './save-load.js';

// ============================================================ undo / redo
// History is a stack of project snapshots — the same JSON a saved project holds, less the map images (they're big, and
// importing, moving or removing map images isn't something undo covers). Whenever an interaction finishes — a pointer
// or key released, a dropdown or color changed, a zone dropped in the list — and shortly after a slider stops moving, a
// new snapshot is compared with the last one, so a whole drag or slide is one step; if anything changed, the last
// snapshot goes on the undo stack. Undo and redo restore a snapshot through the project loader, leaving the map images
// alone and keeping the selection if what was selected still exists. Undo while drawing just cancels the drawing.
const HISTORY_LIMIT = 100;
const undoStack = [], redoStack = [];
let historyCurrent = null, historyTimer = null, historyRestoring = false;
function historySnapshot() {
  const data = serializeProject();
  delete data.exportedAt; delete data.mapImages; delete data.mapImageSeq; delete data.favorites; // (hearting isn't a step to undo)
  // with the day/night cycle running, the clock and the sun it moves change constantly — they aren't steps to undo
  if (data.scene.dayNight && data.scene.dayNight.enabled) { delete data.scene.dayNight.time; delete data.scene.sunElevation; delete data.scene.sunAzimuth; }
  return JSON.stringify(data);
}
function syncHistoryButtons() {
  document.getElementById('btn-undo').disabled = !undoStack.length;
  document.getElementById('btn-redo').disabled = !redoStack.length;
}
export function commitHistory() {
  clearTimeout(historyTimer);
  historyTimer = null;
  if (historyRestoring || S.activeRoadLine || S.activeZone) return; // mid-restore, or mid-drawing: the step is taken once it's done
  const snapshot = historySnapshot();
  if (historyCurrent !== null && snapshot !== historyCurrent) {
    undoStack.push(historyCurrent);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  historyCurrent = snapshot;
  syncHistoryButtons();
}
// starts history over from the project as it is now (after the autosave's put back, say), with nothing to undo or redo
export function resetHistory() {
  clearTimeout(historyTimer);
  historyTimer = null;
  undoStack.length = 0;
  redoStack.length = 0;
  historyCurrent = historySnapshot();
  syncHistoryButtons();
}
function scheduleHistory(delay) {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, delay);
}
// after the app's own handlers have run
window.addEventListener('pointerup', () => scheduleHistory(60), true);
window.addEventListener('keyup', () => scheduleHistory(60), true);
window.addEventListener('change', () => scheduleHistory(60), true);
window.addEventListener('drop', () => scheduleHistory(60), true);
window.addEventListener('dragend', () => scheduleHistory(60), true);
window.addEventListener('input', () => scheduleHistory(500), true);
async function restoreHistory(snapshot) {
  historyRestoring = true;
  const kept = { ...S.selection };
  await loadProjectFromData(JSON.parse(snapshot), { keepMaps: true });
  const stillThere = kept.type === 'zone' ? S.zones.some(z => z.id === kept.id) : kept.type ? S.roadLines.some(l => l.networkId === kept.id) : false;
  if (stillThere) selectItem(kept.type, kept.id, true);
  historyCurrent = historySnapshot(); // as the restored project serializes now
  historyRestoring = false;
  syncHistoryButtons();
}
function undo() {
  if (historyRestoring) return;
  if (S.activeRoadLine || S.activeZone) { cancelActiveDrawing(); return; }
  commitHistory(); // anything not yet taken as a step becomes one first
  if (!undoStack.length) return;
  redoStack.push(historyCurrent);
  restoreHistory(undoStack.pop());
}
function redo() {
  if (historyRestoring || S.activeRoadLine || S.activeZone) return;
  commitHistory();
  if (!redoStack.length) return;
  undoStack.push(historyCurrent);
  restoreHistory(redoStack.pop());
}

Object.assign(App, { scheduleHistory, resetHistory, undo, redo });
