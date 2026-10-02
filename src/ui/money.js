import { App, S } from '../core/shared.js';
import { toUi } from './ui-scale.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Money: a count kept with the project (project/progress.js), shown in #morality-meter's .money.
let n = Number(getProgress('money')) || 0;

const el = document.querySelector('#morality-meter .money-n');
// Cookie Clicker style, padded: £000000 to £999999, then £001.234M, £012.345B… (3 decimals, floored)
const SUFFIXES = ['M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
function moneyText(v) {
  v = Math.max(0, Math.floor(v));
  if (v < 1e6) return String(v).padStart(6, '0');
  let i = 0, x = v / 1e6;
  while (x >= 1000 && i < SUFFIXES.length - 1) { x /= 1000; i++; }
  const whole = Math.floor(x), frac = Math.floor((x - whole) * 1000);
  return `${String(whole).padStart(3, '0')}.${String(frac).padStart(3, '0')}${SUFFIXES[i]}`;
}
// (held at £000000 until revealMoney, then ticked up: see tickUp)
let revealed = false;
const show = v => { el.textContent = '£' + moneyText(v); };
let shownN = null; // (what the count last read, to see it go up)
const render = () => {
  if (!revealed) return;
  if (shownN !== null && n > shownN) gainPop(el.parentElement, n - shownN, '#6f9a5f');
  shownN = n; show(n);
};

/**
 * A count going up: `el` (its indicator) shakes, and "+n" in `color` rises from just under it and fades.
 * @param {HTMLElement} el @param {number} amount @param {string} color
 */
export function gainPop(el, amount, color) {
  el.animate([{ transform: 'translate(0, 0)' }, { transform: 'translate(-2px, 1px)' }, { transform: 'translate(2px, -1px)' },
    { transform: 'translate(-2px, -1px)' }, { transform: 'translate(2px, 1px)' }, { transform: 'translate(0, 0)' }], { duration: 250, easing: 'steps(1, end)' });
  const box = el.getBoundingClientRect(), pop = document.createElement('div');
  pop.className = 'gain-pop';
  pop.textContent = '+' + Math.round(amount);
  pop.style.color = color;
  pop.style.left = toUi(box.left + box.width/2 + 6) + 'px';
  pop.style.top = toUi(box.bottom + 2) + 'px';
  document.body.append(pop);
  pop.animate([{ transform: 'translate(-50%, 0)', opacity: 1 }, { transform: 'translate(-50%, 0)', opacity: 1, offset: 0.3 },
    { transform: 'translate(-50%, -18px)', opacity: 0 }], { duration: 1800, easing: 'ease-out' }).onfinish = () => pop.remove();
}

// A count ticking up from 0 to `target()` in uneven steps (0, 8, 20, 50, 70, 82, 90 of 90), the last step reading the
// target again in case it moved meanwhile. @param {(v: number) => void} set @param {() => number} target
const TICK_STEPS = [0, 0.09, 0.22, 0.55, 0.78, 0.91, 1], TICK_MS = 110;
export function tickUp(set, target) {
  const to = target();
  TICK_STEPS.forEach((f, i) => setTimeout(() => set(f === 1 ? target() : Math.floor(to*f)), i*TICK_MS));
}
/** Show the real money, ticking up to it. @returns {void} */
export function revealMoney() { tickUp(show, () => n); setTimeout(() => { revealed = true; shownN = n; render(); }, TICK_STEPS.length*TICK_MS); }

/** Money now. @returns {number} */
export const money = () => n;

/** Add (or, negative, spend) money; refuses to go below 0. @param {number} k @returns {boolean} */
export function addMoney(k) {
  if (k < 0 && S.devFreePurchases) return true; // (Options > Dev > Free purchases)
  if (n + k < 0) return false;
  n += k;
  setProgress('money', n);
  render();
  return true;
}

render();
onProgress('money', v => { n = Number(v) || 0; if (revealed) shownN = n; render(); }); // (a project's coming in: no gain shown)
Object.assign(App, { money, addMoney });
