import { S, App } from '../core/shared.js';
import { renderer } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { IS_TOUCH } from '../core/device.js';

// ============================================================ taking control
// Taking over whoever or whatever the camera's following, from its card — the keys held, the mouse, and the note across
// the bottom of the view saying how to stop; people.js and traffic/ do the walking, the driving and the camera from what's
// here. Esc lets go, leaving the camera following as before; anything that stops the camera following lets go too.
// Either way the mouse looks around — the pointer locked to the view while it does, or dragged, where the browser won't
// lock it (Esc also frees a locked pointer, which is taken as Esc).
// - someone (clicking the person card's headshot): the view from their eyes, WASD to walk them about (shift to run), and
//   a click to swing a fist at whoever's in front of them (people.js lands it)
// - a car (clicking the car card's picture): the view from behind it, WASD to drive (shift for a boost, space to brake),
//   the mouse swinging the camera round it (and back behind, a moment after it's left alone), the wheel to zoom
// - an aircraft or a bee (clicking its card's picture): the same view from behind, but the keys work a stick rather than a
//   wheel — W/S put the nose down and up, and A/D bank it round, since a thing in the air turns by leaning rather than
//   by steering (life/flight.js does the flying, and zones/airport.js and life/bees.js pose what's flown)
// - a train carriage (clicking the train card's Enter): a seat inside it, going where it goes — no keys at all, and the
//   pointer left free, since a passenger drives nothing and the seat itself is dialled in from two sliders that need a
//   cursor to drag (trains/trains.js puts the view in the carriage). A drag across the view looks around.
// On touch there's no pointer to lock and no keys to hold: a finger dragged across the view looks around instead, and the
// thumbstick and buttons src/ui/mobile.js puts on screen are held down in place of WASD — one of them the click, since
// a tap on the view is already the start of a look.
const dom = renderer.domElement;
const hint = document.getElementById('possess-hint');
const hintExit = document.getElementById('ph-exit');
export const possession = { index: -1, yaw: 0, pitch: 0 };
export const driving = { active: false, lookedAt: -Infinity }; // (lookedAt: when the mouse last swung the camera round)
export const flying = { active: false, lookedAt: -Infinity, release: null }; // the same, for anything flown (release: what lets go of it)
// Sitting inside something that's carrying you along (a train carriage: see trains.js) — the view pinned to a spot that
// moves with it, the mouse the only thing that does anything: a tripod rather than a set of controls.
export const riding = { active: false, release: null }; // (release: what puts the view back outside)
const held = new Set();
const PITCH_MAX = 1.35, LOOK_SPEED = 0.0025, ORBIT_PHI_MIN = 0.3, ORBIT_PHI_MAX = 1.5; // (driving: the camera not quite overhead, nor lower than about level with the car)
const KEY_NAMES = { arrowup: 'w', arrowleft: 'a', arrowdown: 's', arrowright: 'd', ' ': 'space' };
const CONTROL_KEYS = ['w', 'a', 's', 'd', 'shift', 'space'];

// The how-to goes in the bottom hint (see updateHint in editor/tools.js), with the rest of the tool tips; #possess-hint
// along the top stays only as the touch Exit button, and as the flag mobile.js watches for when to put the stick up.
function showHint(title, sub) {
  App.possessionHint = `${title} · ${sub}`;
  App.updateHint();
  hint.hidden = false;
  hintExit.hidden = !IS_TOUCH; // no Esc to press: the way out is a button
}
function hideHint() {
  App.possessionHint = null;
  App.updateHint();
  hint.hidden = true;
}
// (whether it could: only in World mode)
export function startPossession(i, heading) {
  if (!S.peopleEnabled || S.interactionMode !== 'move') return false;
  possession.index = i;
  possession.yaw = heading;
  possession.pitch = -0.1;
  held.clear();
  showHint(IS_TOUCH ? 'First person' : 'Press <kbd>Esc</kbd> to exit first person',
    IS_TOUCH ? 'Stick to walk · Run to run · Punch to swing · drag to look'
              : 'WASD to walk · Shift to run · click to punch · mouse to look');
  lockPointer(); // (a click is what lets it lock, and this runs from one)
  return true;
}
function lockPointer() { if (document.pointerLockElement !== dom) dom.requestPointerLock?.()?.catch?.(() => {}); }
function unlockPointer() { if (document.pointerLockElement === dom) document.exitPointerLock(); }
export function endPossession() {
  if (possession.index < 0) return;
  possession.index = -1;
  held.clear();
  lookPointer = null; pressedAt = null;
  hideHint();
  unlockPointer();
}
export function startDriving() {
  if (!S.peopleEnabled || S.interactionMode !== 'move') return false;
  driving.active = true;
  driving.lookedAt = -Infinity;
  held.clear();
  showHint(IS_TOUCH ? 'Driving' : 'Press <kbd>Esc</kbd> to stop driving',
    IS_TOUCH ? 'Stick to drive and steer · Run to boost · drag to look around'
             : 'W/S to drive · A/D to steer · Shift to boost · Space to brake · mouse to look around · scroll to zoom');
  lockPointer();
  return true;
}
export function endDriving() {
  if (!driving.active) return;
  driving.active = false;
  held.clear();
  lookPointer = null; pressedAt = null;
  hideHint();
  unlockPointer();
}
const FLYING_KEYS = 'W/S to dive and climb · A/D to bank · Shift for power · Space to slow';
const FLYING_TOUCH = 'Stick to fly it · Run for power · Brake to slow';
/**
 * @param {() => void} release - called to let go of whatever is being flown, when Esc or the exit button asks
 * @param {{keys?: string, touch?: string}} [hint] - how it is flown, if not like an aeroplane (the start of the hint's line)
 */
export function startFlying(release, { keys = FLYING_KEYS, touch = FLYING_TOUCH } = {}) {
  // (no people check, unlike the two above: an aircraft flies its schedule whether or not the town has anyone in it,
  // so its card is there to be clicked either way, and "Fly it" shouldn't be a button that does nothing)
  if (S.interactionMode !== 'move') return false;
  flying.active = true;
  flying.release = release;
  flying.lookedAt = -Infinity;
  held.clear();
  showHint(IS_TOUCH ? 'Flying' : 'Press <kbd>Esc</kbd> to stop flying',
    IS_TOUCH ? touch + ' · drag to look around' : keys + ' · mouse to look around · scroll to zoom');
  lockPointer();
  return true;
}
export function endFlying() {
  if (!flying.active) return;
  flying.active = false;
  held.clear();
  lookPointer = null; pressedAt = null;
  hideHint();
  unlockPointer();
}
/**
 * Sit the view inside something being carried along: it looks where the mouse points and nothing else (no WASD — there
 * are no controls aboard). `heading` is the way it faces to start with, and `release` is what puts it back outside.
 * @param {number} heading
 * @param {() => void} release
 */
export function startRiding(heading, release) {
  if (S.interactionMode !== 'move') return false;
  riding.active = true;
  riding.release = release;
  possession.yaw = heading;
  possession.pitch = 0;
  held.clear();
  showHint(IS_TOUCH ? 'Aboard' : 'Press <kbd>Esc</kbd> to get off', 'Drag to look around');
  // (the pointer isn't taken, unlike the other three: the seat is dialled in from sliders that need a cursor to drag)
  return true;
}
export function endRiding() {
  if (!riding.active) return;
  riding.active = false;
  riding.release = null;
  held.clear();
  lookPointer = null; pressedAt = null;
  hideHint();
  unlockPointer();
}
const isPossessing = () => possession.index >= 0;
const inControl = () => isPossessing() || driving.active || flying.active || riding.active;
// whichever hold on the world is the live one, let go of — only ever one at a time
function releaseControl() {
  if (isPossessing()) App.unpossessPerson();
  else if (flying.active) flying.release?.();
  else if (riding.active) riding.release?.();
  else App.stopDriving();
}
hintExit.addEventListener('click', releaseControl);

// the on-screen controls holding a key down in place of a finger on a keyboard (src/ui/mobile.js)
export function setControlHeld(key, down) {
  if (!CONTROL_KEYS.includes(key)) return;
  if (down) held.add(key); else held.delete(key);
}

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
    releaseControl();
    return;
  }
  if (CONTROL_KEYS.includes(key)) { held.add(key); e.preventDefault(); } // (no scrolling, or pressing a focused button)
}, true);
window.addEventListener('keyup', (e) => held.delete(keyName(e)));
window.addEventListener('blur', () => held.clear());
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === dom) return;
  if (inControl()) releaseControl();
});
// Clicking the view while in control picks no one. Possessing someone, the left button throws a punch; driving, and
// wherever the pointer won't lock, it goes on locking the pointer to the view instead. On touch it starts looking around.
const CLICK_SLOP = 5; // how far a press can move and still be a click rather than a drag, in pixels
let lookPointer = null; // the finger doing the looking: { id, x, y }
let pressedAt = null;   // where a left press landed while the pointer wasn't locked: see the pointerup below
dom.addEventListener('pointerdown', (e) => {
  if (!inControl()) return;
  e.stopImmediatePropagation();
  if (e.pointerType !== 'mouse') {
    if (!lookPointer) lookPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return; // (the right button is nothing in here)
  if (document.pointerLockElement === dom) { if (isPossessing()) App.punchFromPossession(); return; }
  pressedAt = { x: e.clientX, y: e.clientY };
  if (!riding.active) lockPointer();
}, true);
// Where the pointer wouldn't lock — a browser that won't, or one holding the request off for a moment after the last Esc
// — the mouse looks around by dragging, so the punch can't be thrown on the press: it's a press that didn't drag, and
// that didn't win the lock either (the click that locks the pointer back to the view only does that).
window.addEventListener('pointerup', (e) => {
  if (!pressedAt) return;
  const moved = Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y);
  pressedAt = null;
  if (moved < CLICK_SLOP && isPossessing() && document.pointerLockElement !== dom) App.punchFromPossession();
});
function look(dx, dy) {
  // behind the wheel or at the controls, the mouse swings the camera round rather than turning a head
  const chase = driving.active ? driving : flying.active ? flying : null;
  if (chase) {
    controls.orbit(dx, dy);
    controls.goalPhi = Math.max(ORBIT_PHI_MIN, Math.min(ORBIT_PHI_MAX, controls.goalPhi));
    chase.lookedAt = performance.now();
    return;
  }
  possession.yaw -= dx*LOOK_SPEED;
  possession.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, possession.pitch - dy*LOOK_SPEED));
}
window.addEventListener('mousemove', (e) => {
  if (!inControl() || (document.pointerLockElement !== dom && !(e.buttons & 1 && e.target === dom))) return;
  look(e.movementX, e.movementY);
});
// A dragged finger looks around. movementX/movementY are no use for that — Safari leaves them at zero for touch — so the
// distance is measured from where the finger was last.
window.addEventListener('pointermove', (e) => {
  if (!lookPointer || e.pointerId !== lookPointer.id) return;
  look(e.clientX - lookPointer.x, e.clientY - lookPointer.y);
  lookPointer.x = e.clientX; lookPointer.y = e.clientY;
});
const endLook = (e) => { if (lookPointer && e.pointerId === lookPointer.id) lookPointer = null; };
window.addEventListener('pointerup', endLook);
window.addEventListener('pointercancel', endLook);
dom.addEventListener('wheel', (e) => { if (isPossessing() || riding.active) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true, passive: false });

Object.assign(App, { isPossessing, isDriving: () => driving.active, isFlying: () => flying.active, isRiding: () => riding.active });
