import { App, S } from '../core/shared.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Card Tech (View > Card Tech): the tech tree as a hand of cards on Klondike felt, filling everything under the toolbar
// (S.techOpen pauses the world, as ui/tech-tree.js). Draw 4 face down (Inspiration, not in yet), pick one by its suit:
// it flips into the grid (+1 to its suit). Choose one of its two options and lock it in (energy, time: +1/−1 to two
// suits when done). Only one card not locked in at a time; burn a card to refund it plus BURN_BONUS (undoes its points,
// back in the pool). Suits are drawn by plus/minus weight. Real time; kept with the project (progress 'cards').
// Placeholder: options do nothing yet.
const LOCK_COST = 5, LOCK_SECS = 10, BURN_BONUS = 5, REDRAW_COST = 5, DRAW_N = 4, BASE = 5; // (LOCK_SECS: an hour once tested)
const SUITS = {
  Wisdom: { color: '#8560FF', axis: 'Education v Simplicity' },
  Health: { color: '#FF60B5', axis: 'Welfare v Brutality' },
  Desire: { color: '#FF606E', axis: 'Vice v Temperance' },
  Justice: { color: '#60FFD8', axis: 'Order v Anarchy' },
  Artistry: { color: '#60FF81', axis: 'Culture v Conformity' },
  Wealth: { color: '#FFF060', axis: 'Communalism v Wall Street' },
  Nature: { color: '#9DFF60', axis: 'Animals v Industry' },
  Mysticism: { color: '#BD60FF', axis: 'Benevolence v Wrath' },
};
const SUIT_KEYS = Object.keys(SUITS);
const opt = (name, plus, minus, ...text) => ({ name, plus, minus, text });
const CARDS = [
  { key: 'schooling', suit: 'Wisdom', name: 'Schooling', options: [opt('Academies', 'Wisdom', 'Wealth', 'Can build academies.', 'Educated peds work faster.'), opt('Apprenticeships', 'Wealth', 'Wisdom', 'Peds learn trades on the job.', 'Shops open sooner.')] },
  { key: 'machines', suit: 'Wisdom', name: 'Machines', options: [opt('Automation', 'Wealth', 'Health', 'Factories need fewer workers.', 'Idle peds grow restless.'), opt('Craftsmanship', 'Artistry', 'Wisdom', 'Handmade goods sell for more.')] },
  { key: 'medicine', suit: 'Health', name: 'Medicine', options: [opt('Hospitals', 'Health', 'Wealth', 'Can build hospitals.', 'The sick recover faster.'), opt('Folk Remedies', 'Mysticism', 'Health', 'Peds pray for the sick.', 'Sometimes it works.')] },
  { key: 'fear', suit: 'Health', name: 'Fear', options: [opt('Watchful Eyes', 'Justice', 'Health', 'Peds behave when they feel watched.', 'Stress rises.'), opt('Open Arms', 'Health', 'Justice', 'Peds forgive each other more easily.')] },
  { key: 'nightlife', suit: 'Desire', name: 'Nightlife', options: [opt('Pubs Till Late', 'Desire', 'Health', 'Pubs stay open later.', 'More drunks.'), opt('Curfew', 'Justice', 'Desire', 'Streets empty after dark.')] },
  { key: 'courtship', suit: 'Desire', name: 'Courtship', options: [opt('Matchmakers', 'Desire', 'Wisdom', 'Peds fall in love more often.'), opt('Etiquette', 'Artistry', 'Desire', 'Peds bow and say please.', 'Fewer fights.')] },
  { key: 'policing', suit: 'Justice', name: 'Policing', options: [opt('Patrols', 'Justice', 'Desire', 'Can build police stations.', 'Crime falls.'), opt('Neighbourhood Watch', 'Health', 'Justice', 'Peds look out for one another.')] },
  { key: 'punishment', suit: 'Justice', name: 'Punishment', options: [opt('Stocks', 'Justice', 'Health', 'Villains are pilloried in the plaza.', 'Peds throw fruit.'), opt('Reform', 'Wisdom', 'Justice', 'Villains can turn innocent over time.')] },
  { key: 'monuments', suit: 'Artistry', name: 'Monuments', options: [opt('Statues', 'Artistry', 'Wealth', 'Statues inspire nearby peds.'), opt('Billboards', 'Wealth', 'Artistry', 'Ads earn money but spoil the view.')] },
  { key: 'cuisine', suit: 'Artistry', name: 'Cuisine', options: [opt('Street Food', 'Desire', 'Health', 'More food stalls.', 'Peds snack all day.'), opt('Fine Dining', 'Artistry', 'Wealth', 'Restaurants inspire their diners.')] },
  { key: 'markets', suit: 'Wealth', name: 'Markets', options: [opt('Free Trade', 'Wealth', 'Nature', 'Shops earn more.', 'Industry spreads.'), opt('Co-operatives', 'Health', 'Wealth', 'Shops share profits with workers.')] },
  { key: 'banking', suit: 'Wealth', name: 'Banking', options: [opt('Interest', 'Wealth', 'Desire', 'Money grows while you sleep.'), opt('Debt Jubilee', 'Desire', 'Wealth', 'Debts are forgiven.', 'Peds celebrate.')] },
  { key: 'leisure', suit: 'Nature', name: 'Natural Leisure', options: [opt('Golf Courses', 'Wealth', 'Nature', 'Can build golf courses.', 'Make money based on adjacent nature, lessen adjacent nature.'), opt('Reserves', 'Nature', 'Wealth', 'Can build reserves.', 'Increases beauty of adjacent nature.')] },
  { key: 'farming', suit: 'Nature', name: 'Farming', options: [opt('Livestock', 'Wealth', 'Nature', 'Farms raise animals for market.', 'It smells.'), opt('Orchards', 'Nature', 'Wealth', 'Fruit trees line the fields.', 'Birds return.')] },
  { key: 'legacy', suit: 'Mysticism', name: 'Legacy', options: [opt('Earth to Earth', 'Nature', 'Health', 'Deaths add to environmental beauty.', 'People can pray in any park.'), opt('Preserved in Stone', 'Artistry', 'Desire', 'Can build graveyards.', 'Graveyards provide prayer depending on adjacent beauty.')] },
  { key: 'revelation', suit: 'Mysticism', name: 'Revelation', options: [opt('Miracles', 'Mysticism', 'Wisdom', 'Peds see signs in everything.'), opt('Doubt', 'Wisdom', 'Mysticism', 'Peds question the heavens.', 'Fewer prayers.')] },
];
const cardOf = key => CARDS.find(c => c.key === key);
const icon = (suit, kind = 'colour') => `assets/icons/tech/${kind}/${suit}.png`;
const energyIcon = '<img class="meter-icon" src="assets/icons/energy.png" alt="energy">';

// ---- state: { w: {suit: [plus, minus]}, hand: [{key, opt?, paid?, ends?, done?}], draw: [key]|null }
const fresh = v => ({
  w: Object.fromEntries(SUIT_KEYS.map(k => [k, Array.isArray(v?.w?.[k]) ? [...v.w[k]] : [BASE, BASE]])),
  hand: Array.isArray(v?.hand) ? v.hand.filter(h => cardOf(h?.key)) : [],
  draw: Array.isArray(v?.draw) ? v.draw.filter(cardOf) : null,
});
let s = fresh(getProgress('cards'));
const save = () => setProgress('cards', s);
onProgress('cards', v => { s = fresh(v); picked = null; render(); });

const held = () => new Set(s.hand.map(h => h.key));
const pool = (except = new Set()) => CARDS.filter(c => !held().has(c.key) && !except.has(c.key));
const pending = () => s.hand.find(h => !h.done);
const leftOf = h => h.done ? 0 : h.ends ? Math.max(0, (h.ends - Date.now())/1000) : LOCK_SECS;
const fmt = secs => { secs = Math.ceil(secs); const m = Math.floor(secs/60), x = secs%60; return m >= 60 ? `${Math.floor(m/60)} hr${m%60 ? ` ${m%60} m` : ''}` : m ? `${m} m${x ? ` ${x} s` : ''}` : `${x} s`; };
const shift = (suit, i, by) => { s.w[suit][i] = Math.max(1, s.w[suit][i] + by); };
// chance of each suit: plus/minus over the total, among suits with cards left (except: cards already out)
function odds(except) {
  const left = new Set(pool(except).map(c => c.suit));
  const wt = Object.fromEntries(SUIT_KEYS.map(k => [k, left.has(k) ? s.w[k][0]/s.w[k][1] : 0]));
  const sum = Object.values(wt).reduce((a, b) => a + b, 0);
  return Object.fromEntries(SUIT_KEYS.map(k => [k, sum ? wt[k]/sum : 0]));
}
function dealOne(except) {
  const o = odds(except); let r = Math.random(), suit = SUIT_KEYS.find(k => o[k] > 0);
  for (const k of SUIT_KEYS) { if (o[k] > 0 && (r -= o[k]) <= 0) { suit = k; break; } }
  const list = pool(except).filter(c => c.suit === suit);
  return list[Math.floor(Math.random()*list.length)];
}
function deal() {
  const out = new Set();
  for (let i = 0; i < DRAW_N; i++) { const c = dealOne(out); if (!c) break; out.add(c.key); }
  s.draw = [...out]; save(); render(); animateDeal();
}
const canDraw = () => !s.draw && !pending() && pool().length > 0;
function redraw() { if (!s.draw || !App.spendEnergy?.(REDRAW_COST)) return; deal(); }

function pick(i) {
  const key = s.draw?.[i]; if (!key) return;
  const slots = [...root.querySelectorAll('.ct-slot .ct-card')].map(el => el.getBoundingClientRect());
  s.hand.push({ key }); shift(cardOf(key).suit, 0, 1);
  const others = s.draw.map((k, j) => ({ k, r: slots[j] })).filter((_, j) => j !== i);
  s.draw = null; picked = key; save();
  waiting = true; render();
  flyIn(key, slots[i]);
  flyBack(others).then(() => { waiting = false; render(); });
}
function lockIn(h) {
  if (h.ends || h.done || h.opt == null) return;
  if (!h.paid) { if (!App.spendEnergy?.(LOCK_COST)) return; h.paid = true; }
  h.ends = Date.now() + LOCK_SECS*1000; save(); render();
}
function finish(h) {
  const c = cardOf(h.key), o = c.options[h.opt];
  h.done = true; delete h.ends; shift(o.plus, 0, 1); shift(o.minus, 1, 1);
  notify(`${c.name}: ${o.name} is locked in`); save();
}
function burn(h) {
  const c = cardOf(h.key);
  shift(c.suit, 0, -1);
  if (h.done) { const o = c.options[h.opt]; shift(o.plus, 0, -1); shift(o.minus, 1, -1); }
  s.hand = s.hand.filter(x => x !== h);
  App.addEnergy?.((h.paid ? LOCK_COST : 0) + BURN_BONUS, true);
  if (picked === h.key) picked = null;
  save(); render();
}

// ---- DOM
const root = document.createElement('div');
root.id = 'card-tech'; root.hidden = true;
root.innerHTML = `<div class="ct-main"><div class="ct-top"><div class="ct-odds"></div><div class="ct-table">
    <div class="ct-deck" title="The deck"></div><div class="ct-draw"></div></div></div><div class="ct-sortbar">Sort: <select class="ct-sort"><option value="got">Order drawn</option><option value="new">Newest first</option>
    <option value="suit">Suit</option><option value="name">Name</option></select>
    <label><input type="checkbox" class="ct-rows"> One row per suit</label></div><div class="ct-grid"></div></div>
  <div class="tt-side ct-side" hidden></div>`;
document.body.append(root);
const $ = sel => root.querySelector(sel);
const oddsEl = $('.ct-odds'), drawEl = $('.ct-draw'), grid = $('.ct-grid'), side = $('.ct-side'), deck = $('.ct-deck');
let picked = null, waiting = false;
// sorting (a browser pref, not the project's)
const PREF = 'kallipolis.cardTechSort';
let view = { sort: 'got', rows: false };
try { view = { ...view, ...JSON.parse(localStorage.getItem(PREF)) }; } catch (err) {}
$('.ct-sort').value = view.sort; $('.ct-rows').checked = view.rows;
root.querySelector('.ct-sortbar').addEventListener('change', () => {
  view = { sort: $('.ct-sort').value, rows: $('.ct-rows').checked };
  try { localStorage.setItem(PREF, JSON.stringify(view)); } catch (err) {}
  render();
});
function sorted() {
  const list = s.hand.slice(), name = h => cardOf(h.key).name, suit = h => SUIT_KEYS.indexOf(cardOf(h.key).suit);
  if (view.sort === 'new') list.reverse();
  else if (view.sort === 'name') list.sort((a, b) => name(a).localeCompare(name(b)));
  else if (view.sort === 'suit') list.sort((a, b) => suit(a) - suit(b) || name(a).localeCompare(name(b)));
  return list;
}

const back = suit => `<div class="ct-back" style="--suit:${SUITS[suit].color}"><img src="${icon(suit, 'white')}" alt="${suit}"></div>`;
function cardHtml(h) {
  const c = cardOf(h.key), frac = h.done ? 1 : h.ends ? 1 - leftOf(h)/LOCK_SECS : 0;
  const row = (o, i) => `<div class="ct-opt"><span class="ct-box">${h.done && h.opt === i ? '&#x2715;' : ''}</span>${o.name}</div>`;
  return `<div class="ct-card${picked === h.key ? ' on' : ''}${h.done ? ' done' : ''}" data-key="${h.key}" style="--suit:${SUITS[c.suit].color}">
    <div class="ct-front"><div class="ct-name">${c.name}</div><div class="ct-photo"></div>
      <div class="ct-opts">${c.options.map(row).join('')}</div>${h.ends ? `<div class="ct-bar"><div style="width:${frac*100}%"></div></div>` : ''}</div>
    ${back(c.suit)}</div>`;
}
const pts = (suit, sign) => `<span class="ct-pt">${sign}1 <img src="${icon(suit)}" alt="">${suit}</span>`;
function sideHtml(h) {
  const c = cardOf(h.key), su = SUITS[c.suit], locked = h.ends || h.done;
  const opts = c.options.map((o, i) => `<button class="ct-choice${h.opt === i ? ' on' : ''}" data-opt="${i}" ${locked && h.opt !== i ? 'disabled' : ''}>
    <b>${o.name}</b><span class="ct-pts">${pts(o.plus, '+')}${pts(o.minus, '&minus;')}</span>${o.text.map(t => `<span>${t}</span>`).join('')}</button>`).join('');
  const frac = h.done ? 1 : h.ends ? 1 - leftOf(h)/LOCK_SECS : 0;
  const label = h.done ? 'Locked in' : h.ends ? 'Locking in...' : h.opt == null ? 'Choose an option' : 'Lock in!';
  return `<div class="tt-pic ct-pic" style="--suit:${su.color}"></div>
    <div class="tt-name">${c.name}</div>
    <div class="ct-suit"><img src="${icon(c.suit)}" alt="">${c.suit} &middot; ${su.axis}</div>
    <div class="ct-choices">${opts}</div>
    <div class="tt-side-cost">${h.paid ? 'Paid' : `${LOCK_COST} ${energyIcon}`}</div>
    <button class="btn tt-get ct-lock" ${locked || h.opt == null ? 'disabled' : ''}>${label}</button>
    <div class="tt-side-time">${h.done ? 'Ready' : fmt(leftOf(h)) + (h.ends ? ' left' : '')}</div>
    <div class="tt-bar"><div style="width:${frac*100}%"></div></div>
    <button class="btn ct-burn">Burn (+${(h.paid ? LOCK_COST : 0) + BURN_BONUS} ${energyIcon})</button>`;
}
function render() {
  if (root.hidden) return;
  const o = odds(new Set(s.draw ?? []));
  oddsEl.innerHTML = SUIT_KEYS.map(k => `<div class="ct-odd${o[k] ? '' : ' out'}" title="${k}: ${SUITS[k].axis}"><img src="${icon(k)}" alt="${k}">
    <span>${s.w[k][0]}/${s.w[k][1]}</span><span>&ndash; ${(o[k]*100).toFixed(1)}%</span></div>`).join('');
  const p = pending();
  drawEl.innerHTML = s.draw
    ? `<div class="ct-slots">${s.draw.map((k, i) => `<div class="ct-slot" data-i="${i}"><div class="ct-card down">${back(cardOf(k).suit)}</div></div>`).join('')}</div>
      <button class="btn ct-redraw">Redraw (${REDRAW_COST} ${energyIcon})</button>`
    : waiting ? '' : `<button class="btn ct-deal" ${canDraw() ? '' : 'disabled'}>Draw cards (1 Inspiration)</button>
      ${p ? `<div class="ct-note">Lock in or burn ${cardOf(p.key).name} to draw again</div>` : !pool().length ? '<div class="ct-note">No cards left</div>' : ''}`;
  const list = sorted();
  grid.classList.toggle('ct-by-suit', view.rows);
  grid.innerHTML = !view.rows ? list.map(cardHtml).join('') : SUIT_KEYS.map(k => {
    const row = list.filter(x => cardOf(x.key).suit === k);
    return row.length ? `<div class="ct-row"><div class="ct-row-head"><img src="${icon(k)}" alt="">${k}</div><div class="ct-row-cards">${row.map(cardHtml).join('')}</div></div>` : '';
  }).join('');
  const h = s.hand.find(x => x.key === picked);
  side.hidden = !h;
  if (h) side.innerHTML = sideHtml(h);
}
// running lock-in: time and bars only (no rebuild, so a click isn't lost)
function refresh() {
  const h = s.hand.find(x => x.ends); if (!h || root.hidden) return;
  const left = leftOf(h), pct = (1 - left/LOCK_SECS)*100 + '%';
  const bar = grid.querySelector(`[data-key="${h.key}"] .ct-bar > div`); if (bar) bar.style.width = pct;
  if (picked === h.key) { side.querySelector('.tt-side-time').textContent = fmt(left) + ' left'; side.querySelector('.tt-bar > div').style.width = pct; }
}

// ---- animation (WAAPI): cards fly from the deck, the chosen one flips into the grid, the rest fly back
const P = 'perspective(900px)';
const delta = (from, to) => [from.left - to.left, from.top - to.top];
function animateDeal() {
  const d = deck.getBoundingClientRect();
  root.querySelectorAll('.ct-slot .ct-card').forEach((el, i) => {
    const [dx, dy] = delta(d, el.getBoundingClientRect());
    el.animate([{ transform: `${P} translate(${dx}px, ${dy}px) rotateY(180deg)` }, { transform: `${P} rotateY(180deg)` }],
      { duration: 350, delay: i*90, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
  });
}
function flyIn(key, from) {
  const el = grid.querySelector(`[data-key="${key}"]`); if (!el || !from) return;
  el.scrollIntoView({ block: 'nearest' });
  const [dx, dy] = delta(from, el.getBoundingClientRect());
  el.animate([{ transform: `${P} translate(${dx}px, ${dy}px) rotateY(180deg)` }, { transform: `${P} translate(${dx/2}px, ${dy/2}px) rotateY(90deg) scale(1.1)`, offset: 0.5 }, { transform: `${P} rotateY(0)` }],
    { duration: 600, easing: 'ease-in-out' });
}
function flyBack(list) {
  const d = deck.getBoundingClientRect();
  return Promise.all(list.map(({ k, r }, i) => {
    if (!r) return null;
    const el = document.createElement('div');
    el.className = 'ct-card down ct-flying';
    el.innerHTML = back(cardOf(k).suit);
    Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px' });
    root.append(el);
    const [dx, dy] = delta(d, r);
    return el.animate([{ transform: `${P} rotateY(180deg)` }, { transform: `${P} translate(${dx}px, ${dy}px) rotateY(180deg)` }],
      { duration: 400, delay: 150 + i*80, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'both' }).finished.then(() => el.remove());
  }));
}

// ---- input
root.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('.ct-deal')) { if (canDraw()) deal(); return; }
  if (t.closest('.ct-redraw')) { redraw(); return; }
  const slot = t.closest('.ct-slot'); if (slot) { pick(+slot.dataset.i); return; }
  const h = s.hand.find(x => x.key === picked);
  const choice = t.closest('.ct-choice');
  if (choice && h) { if (!h.ends && !h.done) { h.opt = +choice.dataset.opt; save(); render(); } return; }
  if (t.closest('.ct-lock') && h) { lockIn(h); return; }
  if (t.closest('.ct-burn') && h) { burn(h); return; }
  if (t.closest('.ct-side, .ct-sortbar')) return;
  const card = t.closest('.ct-grid .ct-card');
  picked = card ? card.dataset.key : null; render();
});

setInterval(() => {
  const h = s.hand.find(x => x.ends);
  if (h && leftOf(h) <= 0) { finish(h); render(); } else refresh();
}, 500);

function notify(text) {
  const n = document.createElement('div');
  n.className = 'tt-notice';
  n.innerHTML = `<div class="tt-titlebar">Card Tech</div><div class="tt-notice-body">${text}</div>`;
  n.addEventListener('click', () => { n.remove(); openCardTech(); });
  document.body.append(n);
  setTimeout(() => n.remove(), 5000);
}

// ---- open / close
function setOpen(on) {
  if (on && !document.getElementById('tech-tree')?.hidden) document.getElementById('btn-tech')?.click(); // (one at a time)
  if (on) App.closeGoodTree?.();
  root.hidden = !on;
  S.techOpen = on;
  document.body.classList.toggle('tech-open', on);
  render();
}
export const openCardTech = () => setOpen(true);
export const toggleCardTech = () => setOpen(root.hidden);
export const cardTechOpen = () => !root.hidden;
App.closeCardTech = () => { if (!root.hidden) setOpen(false); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden && !e.defaultPrevented) setOpen(false); });
