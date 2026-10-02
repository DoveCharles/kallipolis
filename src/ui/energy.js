import { App, S } from '../core/shared.js';
import { gainPop, tickUp } from './money.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Energy: regenerates to ENERGY_MAX (addEnergy's `over` can pass it), one back every REGEN_MS, kept with the project (project/progress.js).
// Shown in #morality-meter's .energy: the count.
export const ENERGY_MAX = 10;
const REGEN_MS = 20 * 60 * 1000;

// { n: energy, t: when the current regen started } — a project's, or full
const fresh = v => v && Number.isFinite(v.n) && Number.isFinite(v.t) ? { n: v.n, t: v.t } : { n: ENERGY_MAX, t: Date.now() };
let s = fresh(getProgress('energy'));
const save = () => setProgress('energy', { ...s });

// credit whatever has regenerated since s.t
function settle() {
  const now = Date.now();
  if (s.n >= ENERGY_MAX) { s.t = now; return; } // (over the cap is kept: see addEnergy)
  const gained = Math.floor((now - s.t) / REGEN_MS);
  if (gained <= 0) return;
  s.n = Math.min(ENERGY_MAX, s.n + gained);
  s.t = s.n >= ENERGY_MAX ? now : s.t + gained * REGEN_MS;
  save();
}

/** Energy now. @returns {number} */
export function energy() { settle(); return s.n; }

/** Spend energy if there's enough (always, with Options > Dev > Infinite energy); flashes the count if not. @param {number} [k] @returns {boolean} */
export function spendEnergy(k = 1) {
  if (S.devInfiniteEnergy) return true;
  settle();
  if (s.n < k) { flashEmpty(); return false; }
  if (s.n >= ENERGY_MAX) s.t = Date.now(); // regen clock starts on leaving full
  s.n -= k;
  save(); render();
  return true;
}

/** Whether there's `k` energy to spend (flashing the count if not), without spending it. @param {number} [k] @returns {boolean} */
export function hasEnergy(k = 1) {
  if (S.devInfiniteEnergy || energy() >= k) return true;
  flashEmpty(); return false;
}

/** Give energy back, up to ENERGY_MAX (past it with `over`: a prayer, see life/people/peoplePrayer.js). @param {number} [k] @param {boolean} [over] @returns {void} */
export function addEnergy(k = 1, over = false) {
  settle();
  s.n = over ? s.n + k : Math.max(s.n, Math.min(ENERGY_MAX, s.n + k));
  if (s.n >= ENERGY_MAX) s.t = Date.now();
  save(); render();
}

const el = document.querySelector('#morality-meter .energy');
// anything marked data-energy (it costs energy) lights the count up while hovered
document.addEventListener('pointerover', e => el.classList.toggle('energy-hover', !!e.target.closest?.('[data-energy]')));
function flashEmpty() { el.classList.remove('energy-empty'); void el.offsetWidth; el.classList.add('energy-empty'); }
const nEl = el.querySelector('.energy-n');
const pad3 = n => String(Math.floor(n)).padStart(3, '0'); // (shown as 007, like the morality points)
function render() {
  settle();
  if (revealed) {
    if (shownN !== null && s.n > shownN) gainPop(el, s.n - shownN, '#d8c070');
    shownN = s.n; nEl.textContent = pad3(s.n);
  }
  document.body.classList.toggle('energy-out', !S.devInfiniteEnergy && s.n <= 0); // (greys out whatever costs energy)
}
// (0 until revealEnergy, then ticked up with the money and morality points: see morality.js)
let revealed = false, shownN = null; // (shownN: what the count last read, to see it go up)
/** Show the real count, ticking up to it. @returns {void} */
export function revealEnergy() {
  tickUp(v => { nEl.textContent = pad3(v); }, () => energy());
  setTimeout(() => { revealed = true; shownN = energy(); render(); }, 800);
}
setInterval(render, 1000);
render();
// another tab changed it
// a project's coming in (no gain shown for it)
onProgress('energy', v => { s = fresh(v); if (revealed) shownN = s.n; render(); });

Object.assign(App, { energy, spendEnergy, hasEnergy, addEnergy });
