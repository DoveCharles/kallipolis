import * as THREE from 'three';
import { S } from '../core/shared.js';
import { openWindow } from './w3-window.js';
import { controls } from '../core/camera-controls.js';
import { people, personModel, isDrawn, modelScale, hairColorOf } from '../life/people/people.js';
import { haircutFx } from '../life/giblets.js';
import { roomKind, roomSeats } from '../buildings/interior.js';
import { SALONBOT_TUNE, refitSalonBots, loopSalonBot, salonBotScale, salonBotSnipping, salonBotNoise, seatedHead } from '../buildings/salonbot.js';

// ============================================================ salon bot (debug)
// View > Salon Bot (debug), in a salon: sliders for the salon bots' size and how far behind the chairs they stand
// (SALONBOT_TUNE in buildings/salonbot.js). While it's open the crowd is held still (S.peopleFrozen) with one person sat in
// the first styling chair, everyone else folded away (personModel.only), that chair's bot playing Cut over and over, and
// the camera side on to them. Nothing is kept: the values to paste back into the code are shown at the bottom.
let seat = null, sitter = null, minRadius = null, lastTime = 0, wasSnipping = false, newHairIn = 0;
const noise = {}; // (the bot's racket as it cuts: salonBotNoise)
const TUNED = { ...SALONBOT_TUNE }; // (what Reset goes back to: the values in the code)

const round = x => Math.round(x*1000)/1000;
const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

/** Hold the sitter in the chair (Sit1's first frame, as sitting in peopleActivities.js puts them), everything they wear with them. */
function holdSat() {
  const i = people.indexOf(sitter), clip = personModel?.clips.Sit1;
  if (i < 0 || !clip) { if (personModel) personModel.only.value = -1; return; }
  const s = modelScale(sitter), heading = Math.atan2(seat.nx, seat.nz), sin = Math.sin(heading), cos = Math.cos(heading);
  const offX = clip.pelvisX*s, offZ = clip.pelvisZ*s;
  rotation.setFromAxisAngle(up, heading);
  position.set(seat.x - offX*cos - offZ*sin, seat.y - clip.seatY*s - personModel.minY*s, seat.z + offX*sin - offZ*cos);
  matrix.compose(position, rotation, scale.set(s, s, s));
  personModel.mesh.setMatrixAt(i, matrix);
  personModel.mesh.instanceMatrix.needsUpdate = true;
  const o = i*4, anim = personModel.anim.array;
  anim[o] = anim[o+1] = clip.start; anim[o+2] = 1; anim[o+3] = 0;
  personModel.wornLayers.forEach(layer => {
    const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
    if (!style?.mesh) return;
    style.anim.array.set(anim.subarray(o, o + 4), layer.slot[i]*4);
    matrix.toArray(style.mesh.instanceMatrix.array, layer.slot[i]*16);
    style.mesh.instanceMatrix.needsUpdate = true;
  });
  [personModel, ...personModel.hair].forEach(part => { part.anim.needsUpdate = true; });
  personModel.only.value = i;
  // (the cloud and clippings, as the bot cuts: see haircut in peopleActivities.js)
  const now = performance.now()/1000, dt = Math.min(0.1, now - lastTime), size = sitter.height*S.peopleSize;
  lastTime = now;
  const snipping = salonBotSnipping(seat);
  if (snipping) { haircutFx(seatedHead(seat, size), size, hairColorOf(sitter), dt); salonBotNoise(noise, seatedHead(seat, size), dt); }
  // (a new haircut halfway through each cut, under the cloud, to see how the change looks)
  if (snipping && !wasSnipping) newHairIn = 0.5;
  if (newHairIn > 0 && (newHairIn -= dt) <= 0) {
    personModel.cutHair(i, sitter.id, Math.random);
    // (how many of each style to draw: updatePeople's job, but the crowd's held still)
    personModel.hair.forEach(style => { style.mesh.count = style.members.filter(m => m < people.length).length; });
  }
  wasSnipping = snipping;
}

function pin() {
  seat = roomKind() === 'salon' ? roomSeats().find(s => s.kind === 'cut' && s.salonBot) ?? null : null;
  sitter = seat ? people.find(isDrawn) ?? people[0] ?? null : null;
  if (!seat) return;
  loopSalonBot(seat.salonBot, true);
  if (!sitter) return;
  S.peopleFrozen = holdSat;
  // (side on, a little behind the chair, so the bot and the head are both in view)
  const t = Math.atan2(seat.nx, seat.nz);
  controls.goalTarget.set(seat.x - 0.35*seat.nx, seat.y + 0.3, seat.z - 0.35*seat.nz);
  minRadius = controls.minRadius;
  controls.minRadius = 0.3;
  controls.goalRadius = 2.6;
  controls.goalPhi = 1.4;
  controls.goalTheta = t + Math.PI/2;
}

function unpin() {
  if (seat?.salonBot) loopSalonBot(seat.salonBot, false);
  S.peopleFrozen = null;
  if (personModel) personModel.only.value = -1;
  if (minRadius != null) { controls.minRadius = minRadius; minRadius = null; }
  seat = sitter = null;
}

// a slider: [label, key, min, max, step]
const SLIDERS = [['scale ×', 'scale', 0.3, 1.5, 0.01], ['back (m)', 'back', -0.6, 0.6, 0.005]];

const values = () => `// SALONBOT_TUNE (buildings/salonbot.js)\n{ scale: ${round(SALONBOT_TUNE.scale)}, back: ${round(SALONBOT_TUNE.back)} }`
  + (seat ? `\n// (the bot's scale for this chair: ${round(salonBotScale(seat.salonBot.seat))})` : '');

function fill(body) {
  if (!seat) { body.innerHTML = '<span>Go inside a salon first (its models loaded), then open this again.</span>'; return; }
  const line = 'display:grid;grid-template-columns:60px 1fr 42px;align-items:center;gap:4px;margin:1px 0';
  body.innerHTML = SLIDERS.map(([label, key, min, max, step]) =>
    `<div style="${line}"><label for="sb-${key}">${label}</label><input type="range" id="sb-${key}" min="${min}" max="${max}" step="${step}" value="${SALONBOT_TUNE[key]}" style="margin:0;min-width:0">
      <span id="sb-${key}-val" style="text-align:right">${round(SALONBOT_TUNE[key])}</span></div>`).join('')
    + `<textarea id="sb-out" readonly rows="3" style="width:100%;box-sizing:border-box;font:11px monospace;margin-top:6px"></textarea>
    <button id="sb-copy">Copy</button> <button id="sb-reset">Reset</button>${sitter ? '' : ' <span>No one to sit: turn people on first.</span>'}`;
  const out = body.querySelector('#sb-out'), show = () => { out.value = values(); };
  for (const [, key] of SLIDERS) {
    const input = body.querySelector(`#sb-${key}`);
    input.addEventListener('input', () => {
      SALONBOT_TUNE[key] = +input.value;
      body.querySelector(`#sb-${key}-val`).textContent = round(+input.value);
      refitSalonBots();
      show();
    });
  }
  body.querySelector('#sb-copy').addEventListener('click', () => navigator.clipboard?.writeText(out.value));
  body.querySelector('#sb-reset').addEventListener('click', () => { Object.assign(SALONBOT_TUNE, TUNED); refitSalonBots(); fill(body); });
  show();
}

/** Open the salon bot debug window, or bring it to the front. */
export function openSalonBotDebug() {
  if (!seat) pin();
  const win = openWindow({ id: 'salonbot-debug', title: 'Salon Bot (debug)', width: 280, onClose: unpin, fill });
  win.style.transform = 'none';
  win.style.left = (innerWidth - win.offsetWidth - 10) + 'px';
  win.style.top = '60px';
}
