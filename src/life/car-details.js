import { cars } from './traffic/traffic.js';
import { canRespawn } from './revive.js';
import { toUi } from '../ui/ui-scale.js';

// ============================================================ car Details window
// A folding window just above the car card (car-card.js): a bar per driving stat, full at the highest any car on the road
// has. Dark grey is the car's own (its type and mood: car.baseTraits, see core/type-text.js); on top, what its loves and
// hates change — green for the rise, red for the part lost. The last cell lists its switches: A aqua, R: respawns left,
// D drunk, S smells, B bloodlust, U: chance unstable, E explosive. Folded state is remembered per browser.
const STATS = [
  ['speed', 'Speed'], ['boost', 'Boost'], ['recharge', 'Recharge'], ['maxboost', 'Max Boost'], ['control', 'Control'],
  ['braking', 'Brakes'], ['weight', 'Weight'], ['health', 'Health'], ['recovery', 'Recovery'],
];
const OPEN_KEY = 'splinetopia.carDetailsOpen';
const GAP = 6; // px between it and the card
const REFRESH_EVERY = 1000; // ms between redraws while shown (other cars come and go; respawns get used)

const el = document.createElement('div');
el.id = 'car-details';
el.className = 'entity-card car-details';
el.hidden = true;
el.innerHTML = '<div class="win3-titlebar"><div class="win3-title">Details</div>'
  + '<button class="win3-min" title="Maximize"></button><button class="win3-max" title="Minimize"></button></div>'
  + '<div class="cd-grid"></div>';
document.body.append(el);
const grid = el.querySelector('.cd-grid');
const bars = STATS.map(([key, label]) => {
  const cell = document.createElement('div');
  cell.className = 'cd-cell';
  cell.innerHTML = `<span class="cd-label">${label}</span><div class="cd-bar"><span class="cd-own"></span><span class="cd-up"></span><span class="cd-down"></span></div>`;
  grid.append(cell);
  const [own, up, down] = cell.querySelectorAll('.cd-bar > span');
  return { key, label, cell, own, up, down };
});
const flags = document.createElement('div');
flags.className = 'cd-cell cd-flags';
grid.append(flags);

let open = true;
try { open = localStorage.getItem(OPEN_KEY) !== '0'; } catch (err) { /* storage blocked */ }
function setOpen(on) {
  open = on;
  el.classList.toggle('win3-minimized', !open);
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (err) { /* storage blocked */ }
}
setOpen(open);
// (▲ opens it out and ▼ folds it, as the arrows point)
el.querySelector('.win3-min').addEventListener('click', () => setOpen(true));
el.querySelector('.win3-max').addEventListener('click', () => setOpen(false));

let shownCar = null, cardEl = null, timer = 0;
// sits GAP above the card, whatever the card's height, and wherever it's been dragged to (see ui/entity-card.js)
function place() {
  if (!cardEl || cardEl.hidden) return;
  const box = cardEl.getBoundingClientRect();
  el.style.bottom = toUi(window.innerHeight - box.top) + GAP + 'px';
  el.style.right = cardEl.style.right === 'auto' ? toUi(window.innerWidth - box.right) + 'px' : '';
}
window.addEventListener('card-move', place);
const watchCard = new ResizeObserver(place);
window.addEventListener('resize', place);

const pct = (value, top) => Math.max(0, Math.min(100, value/top*100)) + '%';
function render() {
  const car = shownCar;
  if (!car) return;
  const now = car.traits ?? {}, base = car.baseTraits ?? now;
  bars.forEach(bar => {
    const mine = now[bar.key] ?? 1, own = base[bar.key] ?? mine;
    const top = cars.reduce((most, c) => Math.max(most, c.traits?.[bar.key] ?? 0, c.baseTraits?.[bar.key] ?? 0), Math.max(mine, own)) || 1;
    bar.own.style.width = pct(Math.min(mine, own), top);
    bar.up.style.left = pct(own, top);
    bar.up.style.width = pct(Math.max(0, mine - own), top);
    bar.down.style.left = pct(mine, top);
    bar.down.style.width = pct(Math.max(0, own - mine), top);
    bar.cell.title = `${bar.label} ${+mine.toFixed(2)}` + (mine !== own ? ` (own ${+own.toFixed(2)})` : '');
  });
  flags.textContent = [
    now.aqua && 'A',
    now.respawn && `R: ${canRespawn(car) ? 1 : 0}`,
    now.drunk && 'D',
    now.smells && 'S',
    now.bloodlust && 'B',
    now.unstable > 0 && `U: ${+now.unstable.toFixed(2)}`,
    now.explosive && 'E',
  ].filter(Boolean).join('  ');
}

/**
 * Show the Details window for `car`, above `card` (the car card's element).
 * @param {object} car
 * @param {HTMLElement} card
 * @returns {void}
 */
export function showCarDetails(car, card) {
  shownCar = car;
  if (cardEl !== card) { if (cardEl) watchCard.unobserve(cardEl); cardEl = card; watchCard.observe(card); }
  el.hidden = false;
  render();
  place();
  clearInterval(timer);
  timer = setInterval(render, REFRESH_EVERY);
}
/** Hide the Details window. */
export function hideCarDetails() {
  shownCar = null;
  el.hidden = true;
  clearInterval(timer);
}
