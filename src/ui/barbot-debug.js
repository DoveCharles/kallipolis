import { openWindow } from './w3-window.js';
import { BARBOT_TUNING, sizeBarbot, rememberBarbotTuning } from '../buildings/barbot.js';

// ============================================================ the bar bot (debug)
// View > Bar Bot (debug): sliders for how far behind the pub's counter the bar bot stands and how tall it is
// (BARBOT_TUNING in buildings/barbot.js), seen as they're moved in whichever pub the view's in. Remembered in the browser;
// the values to paste back into the code are shown at the bottom.
const SLIDERS = [
  ['behind', 'Behind bar (m)', 0, 1.2, 0.01],
  ['height', 'Size (m tall)', 0.6, 3, 0.01],
];
const round = x => Math.round(x*100)/100;
const values = () => `export const BARBOT_TUNING = { behind: ${round(BARBOT_TUNING.behind)}, height: ${round(BARBOT_TUNING.height)} };`;

/** Open the bar bot debug window, or bring it to the front. */
export function openBarbotDebug() {
  openWindow({ id: 'barbot-debug', title: 'Bar Bot (debug)', width: 300, onClose: rememberBarbotTuning, fill: body => {
    body.innerHTML = SLIDERS.map(([key, label, min, max, step]) => `<div class="slider-row">
      <div class="row"><label for="bb-${key}">${label}</label><span class="val" id="bb-${key}-val">${round(BARBOT_TUNING[key])}</span></div>
      <input type="range" id="bb-${key}" min="${min}" max="${max}" step="${step}" value="${BARBOT_TUNING[key]}"></div>`).join('')
      + `<textarea id="bb-out" readonly rows="2" style="width:100%;box-sizing:border-box;font:11px monospace;margin-top:6px"></textarea>
      <button id="bb-copy">Copy</button>`;
    const out = body.querySelector('#bb-out');
    out.value = values();
    for (const [key] of SLIDERS) {
      const input = body.querySelector(`#bb-${key}`);
      input.addEventListener('input', () => {
        BARBOT_TUNING[key] = +input.value;
        body.querySelector(`#bb-${key}-val`).textContent = round(+input.value);
        sizeBarbot();
        out.value = values();
      });
      input.addEventListener('change', rememberBarbotTuning);
    }
    body.querySelector('#bb-copy').addEventListener('click', () => navigator.clipboard?.writeText(out.value));
  } });
}
