import { openWindow } from './w3-window.js';
import { WATER_TUNE, refreshWaterMaterials } from '../water/water.js';

// ============================================================ water (debug)
// View > Water (debug): a slider or colour picker for every WATER_TUNE value (water/water.js), applied live. Nothing is
// kept: the values to paste back into the code are shown at the bottom.
const TUNED = Object.fromEntries(Object.entries(WATER_TUNE).map(([k, u]) => [k, u.value.isColor ? u.value.clone() : u.value]));
const round = x => Math.round(x*1000)/1000;

// [key, min, max, step], under headings
const SLIDERS = {
  'Shallows': [['shallowWidth', 1, 30, 0.1], ['shallowMix', 0, 1, 0.01], ['bands', 1, 12, 1]],
  'Weed': [['weedFrom', 0, 1, 0.01], ['weedMix', 0, 1, 0.01], ['weedPatch', 0, 1, 0.01]],
  'Sand under water': [['sandWidth', 0, 12, 0.1], ['sandMix', 0, 1, 0.01]],
  'Halo': [['haloWidth', 0.5, 6, 0.05], ['haloMix', 0, 1, 0.01]],
  'Foam': [['wobble', 0, 2, 0.01], ['lip', 0, 1.5, 0.01], ['foamReach', 0, 3, 0.01], ['foamSwell', 0, 3, 0.01],
    ['swellSpeed', 0, 4, 0.01], ['laceScale', 0.2, 8, 0.05], ['laceHoles', 0, 1, 0.01]],
  'Rings': [['ringSpeed', 0, 0.5, 0.005], ['ringReach', 0, 10, 0.05], ['ringWidth', 0, 0.5, 0.005], ['ringBreak', 0, 1, 0.01], ['ringMix', 0, 1, 0.01]],
  'Wind Waker foam': [['wwAmount', 0, 1, 0.01], ['wwScale', 0.5, 15, 0.1], ['wwWidth', 0, 0.3, 0.005], ['wwSoft', 0, 0.4, 0.005], ['wwRound', 0, 0.4, 0.005], ['wwWarp', 0, 3, 0.01], ['wwBreak', 0, 1, 0.01], ['wwSpeed', 0, 3, 0.01],
    ['wwDrift', 0, 0.5, 0.005], ['wwCover', 0, 1, 0.01]],
  'Glints': [['glint', 0, 6, 0.05], ['glintScale', 0.3, 20, 0.1], ['glintSize', 0.1, 6, 0.05], ['glintSpeed', 0, 6, 0.05]],
  'Surface': [ ['ripple', 0, 5, 0.05], ['facets', 1, 20, 1], ['roughness', 0, 1, 0.01], ['reflection', 0, 3, 0.01]],
  'Walls': [['wetHeight', 0, 1.2, 0.01], ['wetWave', 0, 0.3, 0.005], ['copeHeight', 0, 0.6, 0.01]],
};
const COLORS = ['deep', 'shallow', 'weed', 'sandTint', 'halo', 'foam', 'glintColor', 'wet', 'coping'];

const values = () => '// WATER_TUNE (water/water.js)\n' + Object.entries(WATER_TUNE).map(([k, u]) => {
  if (k === 'deep') return `deep: #${u.value.getHexString()} (WATER_COLOR)`;
  return u.value.isColor ? `${k}: rgb(${round(u.value.r)}, ${round(u.value.g)}, ${round(u.value.b)})` : `${k}: num(${round(u.value)})`;
}).join(', ');

function fill(body) {
  const line = 'display:grid;grid-template-columns:84px 1fr 42px;align-items:center;gap:4px;margin:1px 0';
  const head = t => `<div style="font-weight:bold;margin:6px 0 2px">${t}</div>`;
  body.innerHTML = '<div style="max-height:70vh;overflow:auto;padding-right:4px">'
    + head('Colours') + COLORS.map(k => `<div style="${line}"><label for="wd-${k}">${k}</label>
      <input type="color" id="wd-${k}" value="#${WATER_TUNE[k].value.getHexString()}" style="margin:0;min-width:0;height:18px"><span></span></div>`).join('')
    + Object.entries(SLIDERS).map(([title, list]) => head(title) + list.map(([k, min, max, step]) =>
      `<div style="${line}"><label for="wd-${k}">${k}</label><input type="range" id="wd-${k}" min="${min}" max="${max}" step="${step}" value="${WATER_TUNE[k].value}" style="margin:0;min-width:0">
      <span id="wd-${k}-val" style="text-align:right">${round(WATER_TUNE[k].value)}</span></div>`).join('')).join('')
    + `</div><textarea id="wd-out" readonly rows="4" style="width:100%;box-sizing:border-box;font:11px monospace;margin-top:6px"></textarea>
    <button id="wd-copy">Copy</button> <button id="wd-reset">Reset</button>`;
  const out = body.querySelector('#wd-out'), show = () => { out.value = values(); };
  COLORS.forEach(k => body.querySelector(`#wd-${k}`).addEventListener('input', e => { WATER_TUNE[k].value.set(e.target.value); show(); }));
  Object.values(SLIDERS).flat().forEach(([k]) => {
    const input = body.querySelector(`#wd-${k}`);
    input.addEventListener('input', () => {
      WATER_TUNE[k].value = +input.value;
      body.querySelector(`#wd-${k}-val`).textContent = round(+input.value);
      refreshWaterMaterials();
      show();
    });
  });
  body.querySelector('#wd-copy').addEventListener('click', () => navigator.clipboard?.writeText(out.value));
  body.querySelector('#wd-reset').addEventListener('click', () => {
    for (const k in TUNED) { if (TUNED[k].isColor) WATER_TUNE[k].value.copy(TUNED[k]); else WATER_TUNE[k].value = TUNED[k]; }
    refreshWaterMaterials();
    fill(body);
  });
  show();
}

/** Open the water debug window, or bring it to the front. */
export function openWaterDebug() {
  const win = openWindow({ id: 'water-debug', title: 'Water (debug)', width: 300, fill });
  win.style.transform = 'none';
  win.style.left = (innerWidth - win.offsetWidth - 10) + 'px';
  win.style.top = '60px';
}
