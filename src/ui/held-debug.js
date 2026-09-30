import { S } from '../core/shared.js';
import { openWindow } from './w3-window.js';
import { controls } from '../core/camera-controls.js';
import { people, personModel, isDrawn, followed } from '../life/people/people.js';
import { SNACK_HOLD, SNACK_BEND } from '../life/people/peopleModel.js';
import { ITEMS, dropSnack, giveSnack, hold, letGo, updateHeld } from '../life/people/peopleHolding.js';

// ============================================================ held items (debug)
// View > Held Items (debug): sliders for where a hot dog, a coffee or a pint sits in the hand (ITEMS in peopleHolding.js) and
// where the hand holding it goes (SNACK_HOLD in peopleModel.js), carried or up at the mouth. While it's open the crowd is
// held still (S.peopleFrozen) and one person stands in the first frame of IdleHotdog, IdleCoffeeBite… with the camera
// on them, everyone else folded away (personModel.only); a hand slider bakes that one clip again (personModel.rebakeClip). Nothing is kept: the values to paste back
// into the code are shown at the bottom.
const KINDS = { hotdog: 'Hotdog', slice: 'Hotdog', skewer: 'Hotdog', coffee: 'Coffee', beer: 'Beer' };
// (held in the hand through another clip, not a snack: its parts' own sliders, a frame of the clip to pose in)
const TOOLS = { chopsticks: 'Eating' };
let item = 'hotdog', biting = false, pinned = null, minRadius = null, frame = 0;

const clipName = () => TOOLS[item] ?? 'Idle' + KINDS[item] + (biting ? 'Bite' : '');
// what they're given: a snack, or a tool into the right hand
function give() {
  for (const t of Object.keys(TOOLS)) letGo(pinned, t);
  if (TOOLS[item]) { dropSnack(pinned); hold(pinned, item, { hand: 'R' }); } else giveSnack(pinned, item);
}
const round = x => Math.round(x*1000)/1000;

/** Hold the pinned person in the first frame of the clip, everything they wear with them, and draw what they hold. */
function holdStill() {
  const i = people.indexOf(pinned), clip = personModel?.clips[clipName()];
  if (i < 0 || !clip) { personModel.only.value = -1; updateHeld(); return; }
  pinned.clipA = pinned.clipB = clip;
  pinned.fade = 1;
  pinned.oneShot = null;
  if (pinned.snack) pinned.snack.next = 1e9; // (no bites while it's being looked at)
  const o = i*4, anim = personModel.anim.array;
  anim[o] = anim[o+1] = clip.start + (TOOLS[item] ? Math.round(frame*clip.frames) : 0); anim[o+2] = 1; anim[o+3] = 0;
  personModel.wornLayers.forEach(layer => {
    const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
    if (style?.mesh) style.anim.array.set(anim.subarray(o, o + 4), layer.slot[i]*4);
  });
  [personModel, ...personModel.hair].forEach(part => { part.anim.needsUpdate = true; });
  personModel.only.value = i;
  updateHeld(i);
}

function pin() {
  const standing = p => isDrawn(p) && !p.act && p.pose === 'Idle';
  pinned = people[followed] ?? people.find(standing) ?? people.find(isDrawn) ?? null;
  if (!pinned) return;
  give();
  S.peopleFrozen = holdStill;
  // (the target sits half a metre to the camera's right, so they stand clear of the window at the right edge)
  const t = pinned.heading;
  controls.goalTarget.set(pinned.x + 0.5*Math.cos(t), pinned.y + 0.8*pinned.height, pinned.z - 0.5*Math.sin(t));
  // (and let it zoom right in, as following someone does, till the window's closed)
  minRadius = controls.minRadius;
  controls.minRadius = 0.3;
  controls.goalRadius = 2.4;
  controls.goalPhi = 1.3;
  controls.goalTheta = pinned.heading;
}

function unpin() {
  S.peopleFrozen = null;
  if (personModel) personModel.only.value = -1;
  if (minRadius != null) { controls.minRadius = minRadius; minRadius = null; }
  if (pinned) for (const t of Object.keys(TOOLS)) letGo(pinned, t);
  if (pinned?.snack) pinned.snack.next = 2;
  pinned = null;
}

// a slider: [label, get, set, min, max, step]
function sliders() {
  if (TOOLS[item]) return [['Pose'], ['frame', () => frame, v => { frame = v; }, 0, 1, 0.01],
    ...ITEMS[item].parts.flatMap((part, k) => [[`Part ${k + 1}`],
      ...['x', 'y', 'z'].map((a, i) => ['at ' + a, () => part.at[i], v => { part.at[i] = v; }, -0.2, 0.3, 0.001]),
      ...['x', 'y', 'z'].map((a, i) => ['turn ' + a, () => (part.turn ??= [0, 0, 0])[i], v => { part.turn[i] = v; }, -3.14, 3.14, 0.01]),
      ...['x', 'y', 'z'].map((a, i) => ['size ' + a, () => part.size[i], v => { part.size[i] = v; }, 0.002, 0.4, 0.001])])];
  const part = ITEMS[item].parts[0], hold = () => SNACK_HOLD[KINDS[item]][biting ? 'bite' : 'carry'];
  const vec = (label, get, i, min, max, step, then) => [label, () => get()[i], v => { get()[i] = v; then?.(); }, min, max, step];
  const rebake = () => personModel?.rebakeClip(clipName());
  return [
    ['Item in hand'],
    ...['x', 'y', 'z'].map((a, i) => vec('at ' + a, () => part.at, i, -0.2, 0.2, 0.001)),
    ...['x', 'y', 'z'].map((a, i) => vec('turn ' + a, () => (part.turn ??= [0, 0, 0]), i, -3.14, 3.14, 0.01)),
    ['size', () => part.size[0], v => part.size.fill(v), 0.03, 0.4, 0.001],
    [biting ? 'Hand at the mouth' : 'Hand carrying'],
    ...['x', 'y', 'z'].map((a, i) => vec('at ' + a, () => hold().at, i, -0.6, 0.6, 0.005, rebake)),
    ...(biting ? [['reach', () => hold().reach, v => { hold().reach = v; rebake(); }, 0, 0.3, 0.005]] : []),
    ...['x', 'y', 'z'].map((a, i) => vec('dir ' + a, () => hold().dir, i, -1, 1, 0.01, rebake)),
    ...['x', 'y', 'z'].map((a, i) => vec('palm ' + a, () => hold().palm, i, -1, 1, 0.01, rebake)),
    ['Elbow'],
    ...['x', 'y', 'z'].map((a, i) => vec('bend ' + a, () => (hold().bend ??= SNACK_BEND.toArray()), i, -1, 1, 0.01, rebake)),
    ['swing', () => hold().swing ?? 0, v => { hold().swing = v; rebake(); }, -3.14, 3.14, 0.01],
    ['twist', () => hold().twist ?? 0, v => { hold().twist = v; rebake(); }, -3.14, 3.14, 0.01],
  ];
}

function values() {
  if (TOOLS[item]) {
    const list = a => `[${a.map(round).join(', ')}]`;
    return `// ITEMS.${item} (peopleHolding.js)\n` + ITEMS[item].parts.map(p =>
      `{ shape: '${p.shape}', size: ${list(p.size)}, at: ${list(p.at)}${p.turn ? `, turn: ${list(p.turn)}` : ''}${p.color != null ? `, color: 0x${p.color.toString(16).padStart(6, '0')}` : ''} },`).join('\n');
  }
  const part = ITEMS[item].parts[0], hold = SNACK_HOLD[KINDS[item]], list = a => `[${a.map(round).join(', ')}]`;
  const side = h => `{ at: ${list(h.at)}, ${h.reach != null ? `reach: ${round(h.reach)}, ` : ''}dir: ${list(h.dir)}, palm: ${list(h.palm)}${h.bend ? `, bend: ${list(h.bend)}` : ''}${h.swing ? `, swing: ${round(h.swing)}` : ''}${h.twist ? `, twist: ${round(h.twist)}` : ''} }`;
  return `// ITEMS.${item} (peopleHolding.js)\n{ shape: '${part.shape}', size: ${list(part.size)}, at: ${list(part.at)}${part.turn ? `, turn: ${list(part.turn)}` : ''}${part.eaten ? ', eaten: true' : ''} },\n`
    + `// SNACK_HOLD.${KINDS[item]} (peopleModel.js)\ncarry: ${side(hold.carry)},\nbite: ${side(hold.bite)},`;
}

function fill(body) {
  body.innerHTML = `<div class="row"><label>Item</label><select id="hd-item">${[...Object.keys(KINDS), ...Object.keys(TOOLS)].map(k => `<option value="${k}"${k === item ? ' selected' : ''}>${k}</option>`).join('')}</select>
    ${TOOLS[item] ? '' : `<label><input type="checkbox" id="hd-bite"${biting ? ' checked' : ''}> at the mouth</label>`}</div>
    <div id="hd-sliders" style="max-height:45vh;overflow-y:auto"></div>
    <textarea id="hd-out" readonly rows="5" style="width:100%;box-sizing:border-box;font:11px monospace;margin-top:6px"></textarea>
    <button id="hd-copy">Copy</button>${pinned ? '' : ' <span>No one to pose: turn people on first.</span>'}`;
  const out = body.querySelector('#hd-out'), show = () => { out.value = values(); };
  const list = body.querySelector('#hd-sliders');
  // (one line a slider, label | bar | value, so the window stays short enough to drag about)
  const line = 'display:grid;grid-template-columns:48px 1fr 42px;align-items:center;gap:4px;margin:1px 0';
  list.innerHTML = sliders().map(([label, get, , min, max, step], n) => get
    ? `<div style="${line}"><label for="hd-${n}">${label}</label><input type="range" id="hd-${n}" min="${min}" max="${max}" step="${step}" value="${get()}" style="margin:0;min-width:0">
      <span class="val" id="hd-${n}-val" style="text-align:right">${round(get())}</span></div>`
    : `<div style="font-weight:bold;margin:6px 0 2px">${label}</div>`).join('');
  sliders().forEach(([, , set], n) => {
    const input = list.querySelector(`#hd-${n}`);
    if (!input) return;
    input.addEventListener('input', () => { set(+input.value); list.querySelector(`#hd-${n}-val`).textContent = round(+input.value); show(); });
  });
  body.querySelector('#hd-item').addEventListener('change', e => { item = e.target.value; if (pinned) give(); fill(body); });
  body.querySelector('#hd-bite')?.addEventListener('change', e => { biting = e.target.checked; fill(body); });
  body.querySelector('#hd-copy').addEventListener('click', () => navigator.clipboard?.writeText(out.value));
  show();
}

/** Open the held-items debug window, or bring it to the front. */
export function openHeldDebug() {
  if (!pinned) pin();
  const win = openWindow({ id: 'held-debug', title: 'Held Items (debug)', width: 300, onClose: unpin, fill });
  win.style.transform = 'none';
  win.style.left = (innerWidth - win.offsetWidth - 10) + 'px';
  win.style.top = '60px';
}
