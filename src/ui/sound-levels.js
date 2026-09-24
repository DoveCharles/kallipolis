import { setLevel, levelOf } from '../audio/sfx.js';
import { openWindow } from './w3-window.js';

// ============================================================ sound levels
// Options > Sound levels (see ui/win3-menu.js) opens a little window of sliders: the master level over every sound, and
// one each for the people, the traffic and the city's ambience (the kinds in audio/sfx.js's LEVEL_KINDS). It stays open
// while the city plays on (ui/w3-window.js), so a change is heard as it's made. Like mute
// (ui/sound.js), the levels are the browser's preference, remembered in localStorage rather than saved with the project.
const STORAGE_KEY = 'splinetopia.soundLevels';
const SLIDERS = [
  { kind: 'master', label: 'Master' },
  { kind: 'peds', label: 'Peds' },
  { kind: 'traffic', label: 'Traffic' },
  { kind: 'ambience', label: 'Ambience' },
];

let remembered = {};
try { remembered = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}; } catch (err) { /* storage blocked or garbled: every level full */ }
for (const { kind } of SLIDERS) if (typeof remembered[kind] === 'number') setLevel(kind, Math.min(1, Math.max(0, remembered[kind])));
function remember() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(SLIDERS.map(({ kind }) => [kind, levelOf(kind)])))); }
  catch (err) { /* storage blocked: it just isn't remembered */ }
}

/** Open the Sound levels window, or bring it to the front if it's open already. */
export function openSoundLevels() {
  openWindow({ id: 'sound-levels', title: 'Sound Levels', width: 280, onClose: remember, fill: body => {
    body.innerHTML = SLIDERS.map(({ kind, label }) => `<div class="slider-row">
      <div class="row"><label for="level-${kind}">${label}</label><span class="val" id="level-${kind}-val"></span></div>
      <input type="range" id="level-${kind}" min="0" max="100" step="1"></div>`).join('');
    for (const { kind } of SLIDERS) {
      const input = body.querySelector(`#level-${kind}`), val = body.querySelector(`#level-${kind}-val`);
      input.value = Math.round(levelOf(kind)*100);
      val.textContent = input.value;
      input.addEventListener('input', () => { setLevel(kind, input.value/100); val.textContent = input.value; });
      input.addEventListener('change', remember);
    }
  } });
}
