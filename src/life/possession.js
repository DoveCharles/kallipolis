import { S, App } from '../core/shared.js';
import { renderer } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';

// ============================================================ taking control
// Taking over whoever or whatever the camera's following, from its card — the keys held, the mouse, and the note across
// the top of the view saying how to stop; people.js and traffic.js do the walking, the driving and the camera from what's
// here. Esc lets go, leaving the camera following as before; anything that stops the camera following lets go too.
// Either way the mouse looks around — the pointer locked to the view while it does, or dragged, where the browser won't
// lock it (Esc also frees a locked pointer, which is taken as Esc).
// - someone (clicking the person card's headshot): the view from their eyes, WASD to walk them about (shift to run)
// - a car (clicking the car card's picture): the view from behind it, WASD to drive (shift for a boost, space to brake),
//   the mouse swinging the camera round it (and back behind, a moment after it's left alone), the wheel to zoom
const dom = renderer.domElement;
const hint = document.getElementById('possess-hint'), hintTitle = document.getElementById('ph-title'), hintSub = document.getElementById('ph-sub');
export const possession = { index: -1, yaw: 0, pitch: 0 };
export const driving = { active: false, lookedAt: -Infinity }; // (lookedAt: when the mouse last swung the camera round)
const held = new Set();
const PITCH_MAX = 1.35, LOOK_SPEED = 0.0025, ORBIT_PHI_MIN = 0.3, ORBIT_PHI_MAX = 1.5; // (driving: the camera not quite overhead, nor lower than about level with the car)
const KEY_NAMES = { arrowup: 'w', arrowleft: 'a', arrowdown: 's', arrowright: 'd', ' ': 'space' };
const CONTROL_KEYS = ['w', 'a', 's', 'd', 'shift', 'space'];

function showHint(title, sub) {
  hintTitle.innerHTML = title;
  hintSub.textContent = sub;
  hint.hidden = false;
}
// (whether it could: only in World mode)
export function startPossession(i, heading) {
  if (!S.peopleEnabled || S.interactionMode !== 'move') return false;
  possession.index = i;
  possession.yaw = heading;
  possession.pitch = -0.1;
  held.clear();
  showHint('Press <kbd>Esc</kbd> to exit first person', 'WASD to walk · Shift to run · mouse to look');
  lockPointer(); // (a click is what lets it lock, and this runs from one)
  return true;
}
function lockPointer() { if (document.pointerLockElement !== dom) dom.requestPointerLock?.()?.catch?.(() => {}); }
function unlockPointer() { if (document.pointerLockElement === dom) document.exitPointerLock(); }
export function endPossession() {
  if (possession.index < 0) return;
  possession.index = -1;
  held.clear();
  hint.hidden = true;
  unlockPointer();
}
export function startDriving() {
  if (!S.peopleEnabled || S.interactionMode !== 'move') return false;
  driving.active = true;
  driving.lookedAt = -Infinity;
  held.clear();
  showHint('Press <kbd>Esc</kbd> to stop driving', 'W/S to drive · A/D to steer · Shift to boost · Space to brake · mouse to look around · scroll to zoom');
  lockPointer();
  return true;
}
export function endDriving() {
  if (!driving.active) return;
  driving.active = false;
  held.clear();
  hint.hidden = true;
  unlockPointer();
}
const isPossessing = () => possession.index >= 0;
const inControl = () => isPossessing() || driving.active;

// what you're asking for, relative to where you're looking (or the way the car points): { forward, right, run, brake }
export function controlInput() {
  return { forward: (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0), right: (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0),
    run: held.has('shift'), brake: held.has('space') };
}

const keyName = e => { const key = e.key.toLowerCase(); return KEY_NAMES[key] || key; };
window.addEventListener('keydown', (e) => {
  if (!inControl() || (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName))) return;
  const key = keyName(e);
  if (key === 'escape') {
    e.stopImmediatePropagation();
    if (isPossessing()) App.unpossessPerson(); else App.stopDriving();
    return;
  }
  if (CONTROL_KEYS.includes(key)) { held.add(key); e.preventDefault(); } // (no scrolling, or pressing a focused button)
}, true);
window.addEventListener('keyup', (e) => held.delete(keyName(e)));
window.addEventListener('blur', () => held.clear());
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === dom) return;
  if (isPossessing()) App.unpossessPerson(); else if (driving.active) App.stopDriving();
});
// clicking the view while in control picks no one, but locks the pointer to it (again)
dom.addEventListener('pointerdown', (e) => {
  if (!inControl()) return;
  e.stopImmediatePropagation();
  lockPointer();
}, true);
window.addEventListener('mousemove', (e) => {
  if (!inControl() || (document.pointerLockElement !== dom && !(e.buttons & 1 && e.target === dom))) return;
  if (driving.active) {
    controls.orbit(e.movementX, e.movementY);
    controls.goalPhi = Math.max(ORBIT_PHI_MIN, Math.min(ORBIT_PHI_MAX, controls.goalPhi));
    driving.lookedAt = performance.now();
    return;
  }
  possession.yaw -= e.movementX*LOOK_SPEED;
  possession.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, possession.pitch - e.movementY*LOOK_SPEED));
});
dom.addEventListener('wheel', (e) => { if (isPossessing()) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true, passive: false });

Object.assign(App, { isPossessing, isDriving: () => driving.active });
