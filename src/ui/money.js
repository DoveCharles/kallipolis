import { App, S } from '../core/shared.js';

// Money: a count kept in localStorage, shown in #morality-meter's .money.
const KEY = 'kallipolis.money';
let n = 0;
try { n = Number(localStorage.getItem(KEY)) || 0; } catch {}

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
const render = () => { if (revealed) show(n); };

// A count ticking up from 0 to `target()` in uneven steps (0, 8, 20, 50, 70, 82, 90 of 90), the last step reading the
// target again in case it moved meanwhile. @param {(v: number) => void} set @param {() => number} target
const TICK_STEPS = [0, 0.09, 0.22, 0.55, 0.78, 0.91, 1], TICK_MS = 110;
export function tickUp(set, target) {
  const to = target();
  TICK_STEPS.forEach((f, i) => setTimeout(() => set(f === 1 ? target() : Math.floor(to*f)), i*TICK_MS));
}
/** Show the real money, ticking up to it. @returns {void} */
export function revealMoney() { tickUp(show, () => n); setTimeout(() => { revealed = true; render(); }, TICK_STEPS.length*TICK_MS); }

/** Money now. @returns {number} */
export const money = () => n;

/** Add (or, negative, spend) money; refuses to go below 0. @param {number} k @returns {boolean} */
export function addMoney(k) {
  if (k < 0 && S.devFreePurchases) return true; // (Options > Dev > Free purchases)
  if (n + k < 0) return false;
  n += k;
  try { localStorage.setItem(KEY, String(n)); } catch {}
  render();
  return true;
}

render();
window.addEventListener('storage', e => { if (e.key === KEY) { n = Number(e.newValue) || 0; render(); } });
Object.assign(App, { money, addMoney });
