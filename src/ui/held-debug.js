import { S } from '../core/shared.js';
import { openWindow } from './w3-window.js';
import { controls } from '../core/camera-controls.js';
import { people, personModel, isDrawn, followed } from '../life/people/people.js';
import { EAT_POSES, EAT_SHOWN, PERSON_BAKE_FPS, SNACK_HOLD } from '../life/people/peopleModel.js';
import { CIG_FIRE, ITEMS, PLATE_AT, dropSnack, exhale, giveSnack, hold, letGo, updateHeld } from '../life/people/peopleHolding.js';

// ============================================================ held items (debug)
// View > Held Items (debug): sliders for where a hot dog, a coffee or a pint sits in the hand (ITEMS in peopleHolding.js) and
// where the hand holding it goes (SNACK_HOLD in peopleModel.js), carried or up at the mouth. While it's open the crowd is
// held still (S.peopleFrozen) and one person stands in the first frame of IdleHotdog, IdleCoffeeBite… with the camera
// on them, everyone else folded away (personModel.only); a hand slider bakes that one clip again (personModel.rebakeClip). Nothing is kept: the values to paste back
// into the code are shown at the bottom.
const KINDS = { hotdog: 'Hotdog', slice: 'Hotdog', skewer: 'Skewer', coffee: 'Coffee', beer: 'Beer', cig: 'Cig', umbrella: 'Umbrella' };
const NO_BITE = ['umbrella']; // (no Bite clip; its sliders move the whole thing, ITEMS' own at/turn/size)
// (held in the hand through Eating, not a snack: one loc/rot/size for all its parts, and Eating's four poses (EAT_POSES),
// one at a time in EatingPaused, or the whole loop played)
const TOOLS = { fork: 'Eating', chopsticks: 'Eating' };
let item = 'cig', biting = false, pinned = null, minRadius = null, playing = false, shown = null;

const clipName = () => TOOLS[item] ? (playing ? 'Eating' : 'EatingPaused') : 'Idle' + KINDS[item] + (biting && !NO_BITE.includes(item) ? 'Bite' : '');
// what they're given: a snack, or a tool into the right hand
function give() {
  for (const t of [...Object.keys(TOOLS), 'plate']) letGo(pinned, t);
  if (TOOLS[item]) { dropSnack(pinned); hold(pinned, item, { hand: 'R' }); hold(pinned, 'plate', { at: PLATE_AT }); } else giveSnack(pinned, item);
}
const round = x => Math.round(x*1000)/1000;
// one size slider: scales x/y/z together, keeping their ratios
const sizeSlider = part => ['size', () => Math.max(...part.size), v => { const k = v/Math.max(...part.size); part.size.forEach((s, i) => { part.size[i] = s*k; }); }, 0.002, 0.4, 0.001];

/** Hold the pinned person in the first frame of the clip, everything they wear with them, and draw what they hold. */
function holdStill() {
  controls.minRadius = 0.3; // (every frame: following or clicking someone resets it)
  const i = people.indexOf(pinned), clip = personModel?.clips[clipName()];
  if (i < 0 || !clip) { personModel.only.value = -1; updateHeld(); return; }
  pinned.clipA = pinned.clipB = clip;
  pinned.fade = 1;
  pinned.oneShot = null;
  if (pinned.snack) { pinned.snack.next = 1e9; pinned.snack.held.glow = biting ? 1 : 0; } // (no bites while it's being looked at; a cig lit at the lips)
  const o = i*4, anim = personModel.anim.array;
  anim[o] = anim[o+1] = clip.start + (playing ? Math.floor(performance.now()/1000*PERSON_BAKE_FPS) % clip.frames : 0); anim[o+2] = 1; anim[o+3] = 0;
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
  if (pinned) for (const t of [...Object.keys(TOOLS), 'plate']) letGo(pinned, t);
  if (EAT_SHOWN.pose) { EAT_SHOWN.pose = 0; personModel?.rebakeClip('EatingPaused'); }
  playing = false;
  if (pinned?.snack) pinned.snack.next = 2;
  pinned = null;
}

// a slider: [label, get, set, min, max, step]
function sliders() {
  const tool = ITEMS[item];
  if (TOOLS[item]) {
    const pose = () => EAT_POSES[EAT_SHOWN.pose], rebake = () => personModel?.rebakeClip(playing ? 'Eating' : 'EatingPaused');
    const xyz = (label, get, min, max, step) => ['x', 'y', 'z'].map((a, i) => [label + ' ' + a, () => get()[i], v => { get()[i] = v; rebake(); }, min, max, step]);
    return [['Pose: 1 hold, 2 over plate, 3 pick, 4 mouth'], ['pose', () => EAT_SHOWN.pose + 1, v => { EAT_SHOWN.pose = v - 1; rebake(); shown?.(); }, 1, 4, 1],
      ['Item'],
      ...['x', 'y', 'z'].map((a, i) => ['loc ' + a, () => tool.at[i], v => { tool.at[i] = v; }, -0.2, 0.3, 0.001]),
      ...['x', 'y', 'z'].map((a, i) => ['rot ' + a, () => tool.turn[i], v => { tool.turn[i] = v; }, -3.14, 3.14, 0.01]),
      ['size', () => tool.size, v => { tool.size = v; }, 0.1, 3, 0.01],
      [pose().mouth ? 'Hand.R (from the mouth)' : 'Hand.R'],
      ...xyz('loc', () => pose().at, -0.6, 0.6, 0.005),
      ...(pose().mouth ? [['reach', () => pose().reach, v => { pose().reach = v; rebake(); }, 0, 0.3, 0.005]] : []),
      ...xyz('rot', () => pose().rot, -3.14, 3.14, 0.01),
      ['Elbow.R'],
      ...xyz('loc', () => pose().elbowAt, -0.5, 0.5, 0.002),
      ...xyz('rot', () => pose().elbowTurn, -3.14, 3.14, 0.01)];
  }
  const part = ITEMS[item].parts[0], hold = () => SNACK_HOLD[KINDS[item]][biting && !NO_BITE.includes(item) ? 'bite' : 'carry'];
  const vec = (label, get, i, min, max, step, then) => [label, () => get()[i], v => { get()[i] = v; then?.(); }, min, max, step];
  const rebake = () => personModel?.rebakeClip(clipName());
  const xyz = (label, get, min, max, step, then) => ['x', 'y', 'z'].map((a, i) => vec(label + ' ' + a, get, i, min, max, step, then));
  const whole = NO_BITE.includes(item);
  return [
    ['Item'],
    ...xyz('loc', () => whole ? tool.at : part.at, -0.2, 0.2, 0.001),
    ...xyz('rot', () => whole ? tool.turn : (part.turn ??= [0, 0, 0]), -3.14, 3.14, 0.01),
    whole ? ['size', () => tool.size, v => { tool.size = v; }, 0.1, 3, 0.01] : sizeSlider(part),
    [biting ? 'Hand.R (at the mouth)' : 'Hand.R'],
    ...xyz('loc', () => hold().at, -0.6, 0.6, 0.005, rebake),
    ...(biting ? [['reach', () => hold().reach, v => { hold().reach = v; rebake(); }, 0, 0.3, 0.005]] : []),
    ...xyz('rot', () => hold().rot, -3.14, 3.14, 0.01, rebake),
    ['Elbow.R'],
    ...xyz('loc', () => hold().elbowAt ?? [0, 0, 0], -0.5, 0.5, 0.002, rebake),
    ...xyz('rot', () => (hold().elbowTurn ??= [0, 0, 0]), -3.14, 3.14, 0.01, rebake),
    ...(item === 'cig' ? ['dim', 'lit'].flatMap(k => [[`Fire ${k}`], ...['r', 'g', 'b'].map(c => [c, () => CIG_FIRE[k][c], v => { CIG_FIRE[k][c] = v; }, 0, k === 'lit' ? 8 : 2, 0.01])]) : []),
  ];
}

function values() {
  if (TOOLS[item]) {
    const list = a => `[${a.map(round).join(', ')}]`;
    const t = ITEMS[item];
    const pose = h => `{ at: ${list(h.at)}, ${h.mouth ? `reach: ${round(h.reach)}, ` : ''}rot: ${list(h.rot)}, elbowAt: ${list(h.elbowAt)}, elbowTurn: ${list(h.elbowTurn)}${h.mouth ? ', mouth: true' : ''} },`;
    return `// ITEMS.${item} (peopleHolding.js)\nat: ${list(t.at)}, turn: ${list(t.turn)}, size: ${round(t.size)}\n// EAT_POSES (peopleModel.js)\n${EAT_POSES.map(pose).join('\n')}`;
  }
  const part = ITEMS[item].parts[0], hold = SNACK_HOLD[KINDS[item]], list = a => `[${a.map(round).join(', ')}]`;
  if (NO_BITE.includes(item)) { const t = ITEMS[item], h = hold.carry; return `// ITEMS.${item} (peopleHolding.js)\nat: ${list(t.at)}, turn: ${list(t.turn)}, size: ${round(t.size)}\n// SNACK_HOLD.${KINDS[item]} (peopleModel.js)\ncarry: { at: ${list(h.at)}, rot: ${list(h.rot)}${h.elbowAt ? `, elbowAt: ${list(h.elbowAt)}` : ''}${h.elbowTurn ? `, elbowTurn: ${list(h.elbowTurn)}` : ''} },`; }
  const side = h => `{ at: ${list(h.at)}, ${h.reach != null ? `reach: ${round(h.reach)}, ` : ''}rot: ${list(h.rot)}${h.elbowAt ? `, elbowAt: ${list(h.elbowAt)}` : ''}${h.elbowTurn ? `, elbowTurn: ${list(h.elbowTurn)}` : ''} }`;
  return `// ITEMS.${item} (peopleHolding.js)\n{ shape: '${part.shape}', size: ${list(part.size)}, at: ${list(part.at)}${part.turn ? `, turn: ${list(part.turn)}` : ''}${part.eaten ? ', eaten: true' : ''} },\n`
    + `// SNACK_HOLD.${KINDS[item]} (peopleModel.js)\ncarry: ${side(hold.carry)},\nbite: ${side(hold.bite)},`
    + (item === 'cig' ? `\n// CIG_FIRE (peopleHolding.js)\n{ dim: new THREE.Color(${CIG_FIRE.dim.toArray().map(round).join(', ')}), lit: new THREE.Color(${CIG_FIRE.lit.toArray().map(round).join(', ')}) }` : '');
}

function fill(body) {
  body.innerHTML = `<div class="row"><label>Item</label><select id="hd-item">${[...Object.keys(KINDS), ...Object.keys(TOOLS)].map(k => `<option value="${k}"${k === item ? ' selected' : ''}>${k}</option>`).join('')}</select>
    ${TOOLS[item] || NO_BITE.includes(item) ? '' : `<label><input type="checkbox" id="hd-bite"${biting ? ' checked' : ''}> at the mouth</label>`}</div>
    <div id="hd-sliders" style="max-height:45vh;overflow-y:auto"></div>
    <textarea id="hd-out" readonly rows="5" style="width:100%;box-sizing:border-box;font:11px monospace;margin-top:6px"></textarea>
    <button id="hd-copy">Copy</button>${TOOLS[item] ? ` <button id="hd-play">${playing ? 'Stop' : 'Play'}</button>` : ''}${item === 'cig' ? ' <button id="hd-smoke">Smoke</button>' : ''}${pinned ? '' : ' <span>No one to pose: turn people on first.</span>'}`;
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
  body.querySelector('#hd-play')?.addEventListener('click', () => { if (!playing) personModel?.rebakeClip('Eating'); playing = !playing; fill(body); });
  // (another pose: the same sliders, refilled in place so the pose slider keeps its drag; or redrawn, reach come or gone)
  const count = sliders().length;
  shown = () => {
    const now = sliders();
    if (now.length !== count) return fill(body);
    now.forEach(([, get], n) => { const input = list.querySelector(`#hd-${n}`); if (input && get) { input.value = get(); list.querySelector(`#hd-${n}-val`).textContent = round(get()); } });
    show();
  };
  body.querySelector('#hd-smoke')?.addEventListener('click', () => { if (pinned) for (let k = 0; k < 10; k++) setTimeout(() => exhale(pinned), k*50); });
  show();
}

/** Open the held-items debug window, or bring it to the front. */
export function openHeldDebug() {
  if (EAT_POSES.some(pose => pose.tip)) personModel?.rebakeClip('Eating'); // (its poses made holds, for the sliders)
  if (!pinned) pin();
  const win = openWindow({ id: 'held-debug', title: 'Held Items (debug)', width: 300, onClose: unpin, fill });
  win.style.transform = 'none';
  win.style.left = (innerWidth - win.offsetWidth - 10) + 'px';
  win.style.top = '60px';
}
