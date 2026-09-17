import { S, App } from '../core/shared.js';
import { renderer } from '../core/scene.js';

// ============================================================ taking control
// Taking over whoever or whatever the camera's following, from its card — the keys held, the mouse, and the note across
// the top of the view saying how to stop; people.js and traffic.js do the walking, the driving and the camera from what's
// here. Esc lets go, leaving the camera following as before; anything that stops the camera following lets go too.
// - someone (clicking the person card's headshot): the view from their eyes, WASD to walk them about (shift to run), the
//   mouse to look around — the pointer locked to the view while it does, or dragged, where the browser won't lock it
//   (Esc also frees a locked pointer, which is taken as Esc)
// - a car (clicking the car card's picture): the view from behind it, WASD to drive (shift for a boost, space to brake),
//   dragging to look around it (the camera swinging back behind once you've let go a moment), the wheel to zoom
const dom = renderer.domElement;
const hint = document.getElementById('possess-hint'), hintTitle = document.getElementById('ph-title'), hintSub = document.getElementById('ph-sub');
export const possession = { index: -1, yaw: 0, pitch: 0 };
export const driving = { active: false, dragging: false, lookedAt: -Infinity }; // (lookedAt: when the camera was last let go of)
const held = new Set();
const PITCH_MAX = 1.35, LOOK_SPEED = 0.0025;
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
  dom.requestPointerLock?.()?.catch?.(() => {}); // (a click is what lets it lock, and this runs from one)
  return true;
}
export function endPossession() {
  if (possession.index < 0) return;
  possession.index = -1;
  held.clear();
  hint.hidden = true;
  if (document.pointerLockElement === dom) document.exitPointerLock();
}
export function startDriving() {
  if (!S.peopleEnabled || S.interactionMode !== 'move') return false;
  driving.active = true;
  driving.dragging = false, driving.lookedAt = -Infinity;
  held.clear();
  showHint('Press <kbd>Esc</kbd> to stop driving', 'W/S to drive · A/D to steer · Shift to boost · Space to brake · drag to look around · scroll to zoom');
  return true;
}
export function endDriving() {
  if (!driving.active) return;
  driving.active = false;
  held.clear();
  hint.hidden = true;
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
document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== dom && isPossessing()) App.unpossessPerson(); });
// clicking the view while possessing someone picks no one, but locks the pointer to it (again) — driving, it's left to
// orbit the camera as usual (input.js picking no one either, while driving)
dom.addEventListener('pointerdown', (e) => {
  if (!isPossessing()) return;
  e.stopImmediatePropagation();
  if (isPossessing() && document.pointerLockElement !== dom) dom.requestPointerLock?.()?.catch?.(() => {});
}, true);
dom.addEventListener('pointerdown', () => { if (driving.active) driving.dragging = true; });
window.addEventListener('pointerup', () => { if (driving.dragging) { driving.dragging = false; driving.lookedAt = performance.now(); } });
window.addEventListener('mousemove', (e) => {
  if (!isPossessing()) return;
  if (document.pointerLockElement !== dom && !(e.buttons & 1 && e.target === dom)) return;
  possession.yaw -= e.movementX*LOOK_SPEED;
  possession.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, possession.pitch - e.movementY*LOOK_SPEED));
});
dom.addEventListener('wheel', (e) => { if (isPossessing()) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true, passive: false });

Object.assign(App, { isPossessing, isDriving: () => driving.active });
