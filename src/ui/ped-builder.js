import * as THREE from 'three';
import { App, S } from '../core/shared.js';
import { setImgIcon } from './pixel-icons.js';
import { scene, renderer, headshotLight } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { HEADSHOT_LAYER, PEOPLE_MAX, personModel, modelScale, addPerson, people } from '../life/people/people.js';
import { PERSON_BAKE_FPS, PERSON_TRAIT_COLORS, PERSON_CLOTHING_ROW, PERSON_FACE_ROW } from '../life/people/peopleModel.js';
import { OUTFITS, OUTFIT_COLUMNS } from '../life/people/outfits.js';
import { profileOf, moodEntries, peopleTraitEntries, registerCustom } from '../life/profiles.js';
import { pinLook } from '../life/people/peopleKeep.js';
import { openWindow } from './w3-window.js';

// ============================================================ Ped Builder
// Toolbar button → a window with one ped to customise: who they are (profiles.js customs) and how they look, written
// straight into a slot past the crowd (SLOT), posed far below the world and drawn on its own into the window's picture
// (people.js calls posePedBuilder / drawPedBuilder). Add to World: a fresh id wearing that look (peopleKeep.js pinLook),
// born in the crowd near the view (people.js addPerson); saved with the crowd.

const SLOT = PEOPLE_MAX - 1;
const AT = new THREE.Vector3(0, -5000, 0); // (where the ped's posed: out of every view but the picture's)
const W = 256, H = 384; // first picture size (then the canvas's own)
const LOVE_SLOTS = 4;
const BODY = [['Breast', 0, 0], ['Waist', 0, 1], ['Hips', 0, 2], ['Weight', 0, 3], ['Butt', 1, 0], ['Shoulders', 1, 3]];
const FACE = [['Chin Width', PERSON_FACE_ROW, 0], ['Chin Height', PERSON_FACE_ROW, 1], ['Eye Top', PERSON_FACE_ROW, 2], ['Eye Bottom', PERSON_FACE_ROW, 3], ['Eye Shape', 1, 2]];
const COLOURS = ['Skin', 'Eyes', 'Hair', 'Hat', 'Top', 'Pants', 'Shoes', 'Skirt', 'Glasses'];
const LAYERS = ['Hair / hat', 'Facial hair', 'Glasses', 'Skirt', 'Jeans'];
const NUMBERED = [0, 1, 3]; // (worn layers shown by number: hair / hat, facial hair, skirt)
const BANDS = [['Sleeves', 3], ['Tummy', 2], ['Legs', 2]];
const OUTFIT_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('OutfitRed'), OUTFIT_COL_ROW = 2 + PERSON_TRAIT_COLORS.indexOf('OutfitGreen');

let win = null, body = null, ped = null, view = null;
const texel = row => (row*PEOPLE_MAX + SLOT)*4;
const traits = () => personModel.traitData;
const dirty = () => { personModel.traitTexture.needsUpdate = true; };
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// a fresh random ped: a throwaway id's look and profile, as the crowd would roll them
function roll() {
  const seed = 1e9 + Math.floor(Math.random()*1e9);
  personModel.assignAppearance(SLOT, seed);
  const pr = profileOf(seed, personModel.isMan[SLOT] === 1);
  ped = { ...ped, name: pr.name, age: pr.age, mood: pr.mood, height: 0.85 + Math.random()*0.27,
    loves: (pr.lovesBase ?? []).filter(Boolean).slice(0, LOVE_SLOTS), hates: (pr.hatesBase ?? []).filter(Boolean).slice(0, LOVE_SLOTS) };
}

// ---- posing (people.js, before the crowd's copies are refilled) and drawing (with the headshots)
App.pedBuilderSlots = () => win && personModel ? [SLOT] : [];
App.posePedBuilder = () => {
  if (!win || !personModel) return;
  const M = personModel, clip = M.clips.Idle;
  ped.time += 1/60;
  const s = modelScale({ height: ped.height });
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(AT.x, AT.y - M.minY*s, AT.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ped.heading), new THREE.Vector3(s, s, s));
  M.mesh.setMatrixAt(SLOT, matrix);
  const o = SLOT*4, row = clip.start + (ped.time*PERSON_BAKE_FPS) % clip.frames;
  M.anim.array.set([row, row, 1, 0], o);
  M.look.array.set([0, 0, 0, ped.emotion], o);
  M.eyes.array.set(ped.eyes, o);
  M.pupil.array.set([0, 0], SLOT*2);
  for (const layer of M.wornLayers) {
    const style = layer.of[SLOT] >= 0 ? layer.styles[layer.of[SLOT]] : null;
    if (!style?.mesh) continue;
    const at = layer.slot[SLOT];
    matrix.toArray(style.mesh.instanceMatrix.array, at*16);
    style.anim.array.set(M.anim.array.subarray(o, o + 4), at*4);
    style.look.array.set(M.look.array.subarray(o, o + 4), at*4);
    style.eyes.array.set(M.eyes.array.subarray(o, o + 4), at*4);
    style.pupil.array.set([0, 0], at*2);
  }
};
App.drawPedBuilder = () => {
  if (!win || !personModel || !view || view.reading) return;
  const now = performance.now()/1000;
  const ease = 1 - Math.exp(-12*Math.min(0.1, now - view.drawnAt)); // (pan and zoom glide to where they're sent)
  view.drawnAt = now;
  view.y += (view.goalY - view.y)*ease; view.zoom += (view.goalZoom - view.zoom)*ease;
  fit(view);
  if (!view.lit) { scene.traverse(o => { if (o.isLight) o.layers.enable(HEADSHOT_LAYER); }); view.lit = true; }
  const tall = 1.7*ped.height*S.peopleSize, cam = view.camera;
  const away = tall*2.4/view.zoom;
  cam.position.set(AT.x, AT.y + tall*view.y, AT.z + away);
  cam.lookAt(AT.x, AT.y + tall*view.y, AT.z);
  cam.near = away*0.2; cam.far = away + tall*3;
  cam.updateProjectionMatrix();
  const target = renderer.getRenderTarget(), shadows = renderer.shadowMap.autoUpdate, clearAlpha = renderer.getClearAlpha(), clear = new THREE.Color();
  renderer.getClearColor(clear);
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(view.target);
  personModel.only.value = SLOT;
  headshotLight(true);
  renderer.info.render.frame++; // (else last frame's instance data: see person-card.js)
  renderer.render(scene, cam);
  headshotLight(false);
  personModel.only.value = -1;
  renderer.setRenderTarget(target);
  renderer.setClearColor(clear, clearAlpha);
  renderer.shadowMap.autoUpdate = shadows;
  view.reading = true;
  const v = view;
  const { w, h } = v;
  renderer.readRenderTargetPixelsAsync(v.target, 0, 0, w, h, v.pixels).then(() => {
    if (v.w !== w || v.h !== h) return; // (resized meanwhile)
    const rowBytes = w*4;
    for (let y = 0; y < h; y++) v.image.data.set(v.pixels.subarray((h - 1 - y)*rowBytes, (h - y)*rowBytes), y*rowBytes);
    v.context.putImageData(v.image, 0, 0);
  }, () => {}).finally(() => { v.reading = false; });
};

// the picture rendered at the canvas's shown size, so it's never stretched
function fit(v) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = Math.max(16, Math.round(v.canvas.clientWidth*dpr)), h = Math.max(16, Math.round(v.canvas.clientHeight*dpr));
  if (w === v.w && h === v.h) return;
  v.w = v.canvas.width = w; v.h = v.canvas.height = h;
  v.target.setSize(w, h);
  v.image = v.context.createImageData(w, h); v.pixels = new Uint8Array(w*h*4);
  v.camera.aspect = w/h;
}

// ---- the controls
function build() {
  const M = personModel, t = traits(), h = [], on = [];
  let n = 0;
  const id = () => 'pb' + n++;
  const head = title => h.push(`<div class="pb-head">${title}</div>`);
  const row = (label, control) => h.push(`<div class="pb-row"><span>${label}</span>${control}</div>`);
  const range = (label, min, max, step, get, set) => {
    const k = id(); row(label, `<input type="range" id="${k}" min="${min}" max="${max}" step="${step}" value="${get()}">`);
    on.push([k, 'input', e => set(+e.target.value)]);
  };
  const select = (label, options, get, set) => {
    const k = id(); row(label, `<select id="${k}" class="select-input">${options.map(([v, text]) => `<option value="${esc(v)}"${String(v) === String(get()) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>`);
    on.push([k, 'change', e => set(e.target.value)]);
  };
  const check = (label, get, set) => { const k = id(); row(label, `<input type="checkbox" id="${k}"${get() ? ' checked' : ''}>`); on.push([k, 'change', e => set(e.target.checked)]); };
  const trait = (label, r, k) => range(label, -1, 1, 0.01, () => t[texel(r) + k], v => { t[texel(r) + k] = v; dirty(); });

  head('Who');
  { const k = id(); row('Name', `<input type="text" id="${k}" class="text-input" value="${esc(ped.name)}">`); on.push([k, 'input', e => { ped.name = e.target.value; }]); }
  select('Sex', [[1, 'Male'], [0, 'Female']], () => M.isMan[SLOT], v => { M.isMan[SLOT] = +v; t[texel(1) + 1] = +v; dirty(); });
  { const k = id(); row('Age', `<input type="number" id="${k}" class="text-input" min="18" max="120" value="${ped.age}">`); on.push([k, 'input', e => { ped.age = Math.max(18, +e.target.value || 18); }]); }
  select('Mood', moodEntries().map(e => [e.text, e.text]), () => ped.mood, v => { ped.mood = v; });
  const { love, hate } = peopleTraitEntries();
  [['Loves', love, 'loves'], ['Hates', hate, 'hates']].forEach(([label, list, key]) => {
    for (let k = 0; k < LOVE_SLOTS; k++) select(k ? '' : label, [['', '(none)'], ...list.map(e => [e.text, e.text])], () => ped[key][k] ?? '', v => { ped[key][k] = v; });
  });

  head('Body');
  range('Height', 0.6, 1.4, 0.01, () => ped.height, v => { ped.height = v; });
  BODY.forEach(([label, r, k]) => trait(label, r, k));

  head('Face');
  FACE.forEach(([label, r, k]) => trait(label, r, k));

  head('Makeup');
  // (the clothing row's fourth number: bits 0–2 the lashes worn, bit 3 set for no lipstick)
  const lash = () => texel(PERSON_CLOTHING_ROW) + 3;
  const lashes = id();
  row('Lashes', `<span class="pb-bands" id="${lashes}">${[0, 1, 2].map(b => `<input type="checkbox" data-b="${b}"${(t[lash()] >> b) & 1 ? ' checked' : ''}>`).join('')}</span>`);
  on.push([lashes, 'change', e => { const b = +e.target.dataset.b; t[lash()] = e.target.checked ? t[lash()] | (1 << b) : t[lash()] & ~(1 << b); dirty(); }]);
  check('Lipstick', () => !((t[lash()] >> 3) & 1), v => { t[lash()] = v ? t[lash()] & ~8 : t[lash()] | 8; dirty(); });

  head('Colours');
  COLOURS.forEach(part => {
    const r = texel(2 + PERSON_TRAIT_COLORS.indexOf(part)), k = id();
    row(part, `<input type="color" id="${k}" value="#${new THREE.Color(t[r], t[r + 1], t[r + 2]).getHexString()}">`);
    on.push([k, 'input', e => { const c = new THREE.Color(e.target.value); t.set([c.r, c.g, c.b], r); dirty(); }]);
  });

  head('Clothes');
  // [<] name [>]: steps through a list of [value, text]
  const stepper = (label, options, get, set) => {
    const k = id(), at = () => Math.max(0, options.findIndex(([v]) => String(v) === String(get())));
    row(label, `<span class="pb-step" id="${k}"><button class="btn" data-d="-1">&lt;</button><span>${esc(options[at()][1])}</span><button class="btn" data-d="1">&gt;</button></span>`);
    on.push([k, 'click', e => {
      const d = +e.target.closest('button')?.dataset.d;
      if (!d) return;
      e.preventDefault();
      set(options[(at() + d + options.length) % options.length][0]);
      e.currentTarget.querySelector('span').textContent = options[at()][1];
    }]);
  };
  M.wornLayers.forEach((layer, l) => stepper(LAYERS[l] ?? 'Layer ' + l, [[-1, '(none)'], ...layer.styles.map((st, k) => [k, NUMBERED.includes(l) ? String(k + 1) : st.name.replace(/_[GB]+$/, '')])], () => layer.of[SLOT], v => {
    const was = layer.of[SLOT];
    if (+v >= 0) { if (M.putOn(SLOT, layer.styles[+v].name) === undefined) say('No room for that style'); }
    else if (was >= 0) M.takeOff(SLOT, layer.styles[was].name);
  }));
  stepper('Outfit', [[0, '(none)'], ...OUTFITS.map((o, k) => [k + 1, o.name])], () => t[texel(OUTFIT_ROW) + 3], v => {
    t[texel(OUTFIT_ROW) + 3] = +v; t[texel(OUTFIT_COL_ROW) + 3] = +v ? OUTFIT_COLUMNS[+v - 1] : 0; dirty();
  });
  // one box per band of cloth, filled from the left: ticking one covers to there, unticking it bares from there
  const band = k => texel(PERSON_CLOTHING_ROW) + k;
  BANDS.forEach(([label, count], k) => {
    const b = id();
    row(label, `<span class="pb-bands" id="${b}">${Array.from({ length: count }, (_, n) => `<input type="checkbox" data-n="${n}"${t[band(k)] > n + 1 ? ' checked' : ''}>`).join('')}</span>`);
    on.push([b, 'change', e => {
      const n = +e.target.dataset.n;
      t[band(k)] = e.target.checked ? n + 2 : n + 1; dirty();
      e.currentTarget.querySelectorAll('input').forEach((box, m) => { box.checked = t[band(k)] > m + 1; });
    }]);
  });

  body.querySelector('.pb-controls').innerHTML = h.join('');
  on.forEach(([k, type, fn]) => body.querySelector('#' + k).addEventListener(type, fn));
}

function say(text) { const el = body?.querySelector('.pb-status'); if (el) el.textContent = text; }

function addToWorld() {
  if (S.netGuest) { say("Guests can't add peds"); return; }
  const id = S.peopleIdSeq++;
  const pick = list => [...new Set(list.filter(Boolean))];
  registerCustom(id, { name: ped.name.trim() || undefined, age: ped.age, mood: ped.mood, loves: pick(ped.loves), hates: pick(ped.hates), height: ped.height });
  pinLook(id, personModel.lookOf(SLOT));
  const t = controls.goalTarget;
  const j = addPerson(id, [t.x, 0, t.z, Math.random()*Math.PI*2]);
  if (j < 0) { say('No room in the crowd'); return; }
  say(`${ped.name || 'They'} joined the world`);
  setTimeout(() => { if (people[j]?.id === id) App.followPerson?.(j); }, 500);
}

function close() {
  const M = personModel;
  if (M) M.wornLayers.forEach(layer => { if (layer.of[SLOT] >= 0) M.takeOff(SLOT, layer.styles[layer.of[SLOT]].name); }); // (its styles' room back)
  view?.target.dispose();
  win = body = view = null;
  setIcon(false);
}

const button = document.getElementById('btn-ped-builder');
const setIcon = open => { setImgIcon(button?.querySelector('img'), open ? 'ped-builder-open' : 'ped-builder'); button?.classList.toggle('on', open); };

/** Open the Ped Builder. @returns {void} */
export function openPedBuilder() {
  if (win) { win.close(); return; }
  win = openWindow({ id: 'ped-builder', title: 'Ped Builder', width: 750, resizable: true, noOk: true, onClose: close,
    fill: el => {
      body = el;
      el.innerHTML = `<div class="pb"><div class="pb-controls">Loading peds…</div>
        <div class="pb-side"><canvas class="pb-view" width="${W}" height="${H}"></canvas>
        <div class="pb-buttons"><button class="btn pb-random">Random</button><button class="btn pb-add">Add to World</button></div><div class="pb-status"></div></div></div>`;
    } });
  setIcon(true);
  const canvas = body.querySelector('.pb-view'), context = canvas.getContext('2d');
  view = { target: new THREE.WebGLRenderTarget(W, H), camera: new THREE.PerspectiveCamera(30, W/H, 0.01, 100), canvas, context,
    image: context.createImageData(W, H), pixels: new Uint8Array(W*H*4), w: W, h: H, drawnAt: performance.now()/1000, y: 0.5, goalY: 0.5, zoom: 1, goalZoom: 1, reading: false, lit: false };
  view.camera.layers.set(HEADSHOT_LAYER);
  ped = { heading: 0.4, time: 0, emotion: 0, eyes: [0, 0, 0, 0] };
  // (drag the picture across to turn them, up and down to look up and down them; scroll to zoom)
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    let x = e.clientX, y = e.clientY;
    const move = m => {
      ped.heading += (m.clientX - x)*0.02;
      view.goalY = Math.min(1.1, Math.max(0, view.goalY + (m.clientY - y)*0.004/view.goalZoom));
      x = m.clientX; y = m.clientY;
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', move), { once: true });
  });
  canvas.addEventListener('wheel', e => { e.preventDefault(); view.goalZoom = Math.min(6, Math.max(0.6, view.goalZoom*Math.exp(-e.deltaY*0.002))); }, { passive: false });
  body.querySelector('.pb-random').addEventListener('click', () => { roll(); build(); });
  body.querySelector('.pb-add').addEventListener('click', addToWorld);
  const ready = () => {
    if (!win) return;
    if (!personModel) { setTimeout(ready, 300); return; }
    if (!S.peopleEnabled) say('Turn peds on to see them');
    roll(); build();
  };
  ready();
}
button?.addEventListener('click', openPedBuilder);
