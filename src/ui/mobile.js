import { S, App } from '../core/shared.js';
import { IS_TOUCH, isNarrow } from '../core/device.js';
import { setControlHeld } from '../life/possession.js';
import { cards } from './entity-card.js';

// ============================================================ the controls a finger needs
// Everything here is for phones and tablets, and none of it appears on a machine with a mouse. It stands in for the parts
// of the app a keyboard and a right button do on the desktop:
// - ✛ along the top holds cmd down (inserting a node into a path, or branching off one) — src/editor/input.js reads it
//   as S.touchAdd; a long press on the view is the right button, and two fingers pan and pinch (also input.js)
// - Move / Rotate / Scale under the Maps list stand in for G / R / S, setting S.touchMapMode so the image is dragged about
//   rather than clicked twice
// - a thumbstick and a few buttons stand in for WASD, and for the click that throws a punch, while someone's being
//   walked or driven about
// - on a narrow screen the side panel becomes a sheet along the bottom, which ☰ slides up and down
const panel = document.getElementById('panel');
const addBtn = document.getElementById('btn-touch-add');
const panelToggle = document.getElementById('btn-panel-toggle');
const mapTools = document.getElementById('map-touch-tools');
const drive = document.getElementById('touch-drive');
const stick = document.getElementById('touch-stick'), knob = document.getElementById('touch-stick-knob');
const runBtn = document.getElementById('touch-run'), brakeBtn = document.getElementById('touch-brake');
const punchBtn = document.getElementById('touch-punch');

// ============================================================ the panel as a bottom sheet
// Only on a narrow screen: a tablet held either way has room for the panel where it always was. It starts open, because a
// panel that isn't there is a panel nobody finds, and it's remembered after that.
const PANEL_KEY = 'splinetopia.panelOpen';
let panelOpen = true;
try { panelOpen = localStorage.getItem(PANEL_KEY) !== '0'; } catch (err) { /* storage blocked: it just isn't remembered */ }
function setPanelOpen(open) {
  panelOpen = open;
  document.body.classList.toggle('panel-open', open);
  panelToggle.classList.toggle('on', open);
  try { localStorage.setItem(PANEL_KEY, open ? '1' : '0'); } catch (err) { /* as above */ }
}
panelToggle.addEventListener('click', () => setPanelOpen(!panelOpen));
// the win3 look folds the panel up to its title bar rather than sliding it away; tapping that title bar does both
panel.querySelector('.win3-titlebar')?.addEventListener('dblclick', () => { if (isNarrow()) setPanelOpen(!panelOpen); });

// A card for whoever's being followed sits at the bottom of the screen, which is where the sheet is, so opening one folds
// the sheet away. Watching the cards' hidden attribute saves every one of them having to know about this.
const cardWatcher = new MutationObserver((records) => {
  if (!isNarrow() || !panelOpen) return;
  if (records.some(r => !r.target.hidden)) setPanelOpen(false);
});
cards.forEach(c => cardWatcher.observe(c.el, { attributes: true, attributeFilter: ['hidden'] }));

// ============================================================ ✛ — shift, held down
addBtn.addEventListener('click', () => {
  S.touchAdd = !S.touchAdd;
  addBtn.classList.toggle('on', S.touchAdd);
});

// ============================================================ Maps: G / R / S as buttons
mapTools?.querySelectorAll('.map-touch-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mapMode;
    S.touchMapMode = S.touchMapMode === mode ? null : mode;
    mapTools.querySelectorAll('.map-touch-btn').forEach(b => b.classList.toggle('on', b.dataset.mapMode === S.touchMapMode));
  });
});

// ============================================================ the thumbstick
// The keys it holds down are the ones controlInput() reads, so a stick pushed forward and left is w and a both held: the
// walking and the driving don't have to know it isn't a keyboard.
const STICK_RADIUS = 34, DEAD_ZONE = 0.3; // (34px is as far as the knob goes before it would push past the 124px ring around it)
let stickPointer = null;
function stickTo(x, y) {
  const r = stick.getBoundingClientRect();
  let dx = (x - (r.left + r.width/2)) / STICK_RADIUS, dy = (y - (r.top + r.height/2)) / STICK_RADIUS;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  knob.style.transform = `translate(${dx*STICK_RADIUS}px, ${dy*STICK_RADIUS}px)`;
  setControlHeld('w', dy < -DEAD_ZONE);
  setControlHeld('s', dy > DEAD_ZONE);
  setControlHeld('a', dx < -DEAD_ZONE);
  setControlHeld('d', dx > DEAD_ZONE);
}
function releaseStick() {
  stickPointer = null;
  knob.style.transform = '';
  ['w', 'a', 's', 'd'].forEach(k => setControlHeld(k, false));
}
stick.addEventListener('pointerdown', (e) => {
  if (!IS_TOUCH) return;
  e.preventDefault(); e.stopPropagation(); // (not a finger looking around, and not one the view should see)
  stickPointer = e.pointerId;
  stick.setPointerCapture(e.pointerId);
  stickTo(e.clientX, e.clientY);
});
stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickPointer) stickTo(e.clientX, e.clientY); });
stick.addEventListener('pointerup', (e) => { if (e.pointerId === stickPointer) releaseStick(); });
stick.addEventListener('pointercancel', (e) => { if (e.pointerId === stickPointer) releaseStick(); });

// shift and space, held for as long as the button is
function holdButton(btn, key) {
  const down = (e) => { if (!IS_TOUCH) return; e.preventDefault(); e.stopPropagation(); btn.classList.add('on'); setControlHeld(key, true); };
  const up = () => { btn.classList.remove('on'); setControlHeld(key, false); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
}
holdButton(runBtn, 'shift');
holdButton(brakeBtn, 'space');

// Punch stands in for the click that throws one (src/life/possession.js): a tap on the view is already a finger looking
// around, so there's none to spare for it. It's a tap rather than a hold — one punch a press.
punchBtn.addEventListener('pointerdown', (e) => {
  if (!IS_TOUCH) return;
  e.preventDefault(); e.stopPropagation(); // (as the stick: not a finger looking around, and not one the view should see)
  punchBtn.classList.add('on');
  App.punchFromPossession?.();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => punchBtn.addEventListener(ev, () => punchBtn.classList.remove('on')));

// The controls are up for exactly as long as something's being walked, driven or flown about, which is exactly as long as
// the note across the top of the view is (src/life/possession.js) — so that's what says when to show them. On a device
// that isn't touch (see core/device.js) they never show, and the handlers above ignore them.
const possessHint = document.getElementById('possess-hint');
function syncDrive() {
  const on = IS_TOUCH && !possessHint.hidden && !App.isRiding?.(); // (riding a train there's nothing to hold down: see possession.js)
  if (!on && !drive.hidden) releaseStick();
  drive.hidden = !on;
  brakeBtn.hidden = !App.isDriving?.() && !App.isFlying?.(); // (it slows an aircraft down as it brakes a car)
  punchBtn.hidden = !App.isPossessing?.(); // (there's nobody to punch from a car)
}
new MutationObserver(syncDrive).observe(possessHint, { attributes: true, attributeFilter: ['hidden'] });

// ============================================================ getting going
// Which of these show themselves is left to css/base.css: the ✛ to html.touch, the ☰ to a narrow window (so a desktop one
// dragged narrow gets the sheet too). Only the panel's state has to be set here.
if (mapTools) mapTools.hidden = !IS_TOUCH;
setPanelOpen(panelOpen);
syncDrive();
