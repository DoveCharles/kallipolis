import { S, App } from '../core/shared.js';
import { mulberry32 } from '../core/math.js';
import { listener, isMuted } from '../audio/sfx.js';
import { openWindow } from './w3-window.js';
import { toUi } from './ui-scale.js';

// The daily gift button (left of the identify button) opens the Daily Gift window. Once the gift's claimed there
// (claimDailyGift), it's locked till local midnight: pressed in and greyed, hovering says how long till the next, and a
// click shakes it red. Options > Dev > Infinite daily gifts never locks it.
const KEY = 'kallipolis.dailyGiftDay';
const button = document.getElementById('btn-daily-gift');
const dayOf = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
let claimed = null;
try { claimed = localStorage.getItem(KEY); } catch {}
const usedToday = () => !S.devInfiniteGifts && claimed === dayOf(new Date());

// how long till midnight, as h:mm:ss
function untilNext() {
  const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const left = Math.ceil((next - now) / 1000), pad = n => String(n).padStart(2, '0');
  return `${Math.floor(left / 3600)}:${pad(Math.floor(left / 60) % 60)}:${pad(left % 60)}`;
}

// the tip under the button, while it's used and hovered (or just clicked)
const tip = document.createElement('div');
tip.className = 'dg-tip';
tip.hidden = true;
document.body.append(tip);
let tipTimer = null;
function showTip() {
  if (!usedToday()) return;
  const box = button.getBoundingClientRect();
  tip.style.left = toUi(box.left + box.width / 2) + 'px';
  tip.style.top = toUi(box.bottom + 4) + 'px';
  const draw = () => { tip.textContent = `Next gift in ${untilNext()}`; if (!usedToday()) hideTip(); };
  draw();
  tip.hidden = false;
  clearInterval(tipTimer);
  tipTimer = setInterval(draw, 1000);
}
function hideTip() { tip.hidden = true; clearInterval(tipTimer); tipTimer = null; }

function refresh() { button.classList.toggle('dg-used', usedToday()); }
button.addEventListener('pointerenter', showTip);
button.addEventListener('pointerleave', hideTip);
button.addEventListener('click', () => {
  if (usedToday()) {
    button.classList.remove('dg-refused'); void button.offsetWidth; button.classList.add('dg-refused');
    showTip();
    return;
  }
  openDailyGift();
});
setInterval(refresh, 1000); // (back at midnight, or the dev toggle flipped)
refresh();

// ---------------------------------------------------------- the window: a reel of rewards
// REWARDS as a list banded like a card's loves and hates, coloured by rarity, VISIBLE of them at a time with an arrow at
// the middle one. Spin sends it rushing down (looping round at the top, ticking as each passes the bottom), slowing to a
// stop on a reward, confetti; Spin then reads Claim, which pays it and locks the button till midnight. What was spun is
// kept for the day (SPIN_KEY), so closing the window and opening it again can't spin twice.
const RARITIES = {
  crap: { label: 'CRAP', count: 1, energy: 1 },
  common: { label: 'Common', count: 10, energy: 10 },
  rare: { label: 'Rare', count: 5, energy: 20 },
  epic: { label: 'Epic', count: 2, energy: 50 },
  legendary: { label: 'Legendary', count: 1, energy: 250 },
};
// the reel: every reward, in a fixed shuffled order (the same each day)
const REWARDS = (() => {
  const list = Object.entries(RARITIES).flatMap(([rarity, r]) => Array.from({ length: r.count }, () => rarity));
  const rng = mulberry32(20260930);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng()*(i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
})();
const VISIBLE = 9, MIDDLE = 4, ROW_H = 22;
const SPIN_MS = 6000, SPIN_LOOPS = 3; // how long it spins, and how many times round the reel at least
const SPIN_KEY = 'kallipolis.dailyGiftSpin';
const mod = (n, m) => ((n % m) + m) % m;

let spun = null; // { day, slot }: today's spin, if there's been one
try { spun = JSON.parse(localStorage.getItem(SPIN_KEY)); } catch {}
const spunToday = () => spun && spun.day === dayOf(new Date()) && REWARDS[spun.slot] ? spun : null;

// the tick as each reward passes: a click of filtered noise with a little knock under it, through the master volume
let lastTick = 0, clickBuffer = null;
function tick() {
  const context = listener.context;
  if (context.state === 'suspended') context.resume();
  const now = context.currentTime;
  if (isMuted() || now - lastTick < 0.03) return;
  lastTick = now;
  if (!clickBuffer) { // (4ms of noise, dying away fast)
    clickBuffer = context.createBuffer(1, Math.ceil(context.sampleRate*0.004), context.sampleRate);
    const data = clickBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random()*2 - 1)*Math.pow(1 - i/data.length, 2);
  }
  const click = context.createBufferSource(), band = context.createBiquadFilter(), gain = context.createGain();
  click.buffer = clickBuffer;
  band.type = 'bandpass'; band.frequency.value = 2500 + Math.random()*600; band.Q.value = 1.5;
  gain.gain.value = 0.8;
  click.connect(band).connect(gain).connect(listener.getInput());
  const knock = context.createOscillator(), knockGain = context.createGain();
  knock.frequency.value = 900 + Math.random()*100;
  knockGain.gain.setValueAtTime(0.175, now);
  knockGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
  knock.connect(knockGain).connect(listener.getInput());
  click.start(now); knock.start(now); knock.stop(now + 0.03);
}

// confetti, bursting from the middle of `box`
const CONFETTI = ['#e5484d', '#3ddc97', '#5aa2ff', '#ffc30b', '#b77cf0', '#ffffff'];
function confetti(box) {
  const r = box.getBoundingClientRect(), x = toUi(r.left + r.width/2), y = toUi(r.top + r.height/2);
  for (let i = 0; i < 60; i++) {
    const bit = document.createElement('div'), angle = Math.random()*Math.PI*2, speed = 80 + Math.random()*160;
    bit.className = 'dg-confetti';
    bit.style.left = x + 'px'; bit.style.top = y + 'px';
    bit.style.background = CONFETTI[i % CONFETTI.length];
    document.body.append(bit);
    const dx = Math.cos(angle)*speed, dy = Math.sin(angle)*speed - 120;
    bit.animate([
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy + 260}px) rotate(${Math.random()*720 - 360}deg)`, opacity: 0 },
    ], { duration: 1200 + Math.random()*600, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => bit.remove();
  }
}

/** Take today's gift: locks the button till midnight. @returns {void} */
export function claimDailyGift() {
  claimed = dayOf(new Date());
  try { localStorage.setItem(KEY, claimed); } catch {}
  spun = null;
  try { localStorage.removeItem(SPIN_KEY); } catch {}
  refresh();
}

/** The Daily Gift window: the reel, and Spin (then Claim). @returns {void} */
export function openDailyGift() {
  if (document.getElementById('daily-gift')) { openWindow({ id: 'daily-gift' }); return; } // (just brought forward)
  let frame = 0;
  const win = openWindow({ id: 'daily-gift', title: 'Daily Gift', width: 300, noOk: true,
    onClose: () => cancelAnimationFrame(frame),
    fill: body => {
      body.innerHTML = `<div class="dg-reel" style="height:${VISIBLE*ROW_H}px"><div class="dg-arrow dg-arrow-l"></div><div class="dg-arrow dg-arrow-r"></div></div>
        <div class="dg-result"></div>
        <div class="w3-dialog-buttons"><button class="btn dg-spin">Spin</button><!-- (not w3-default: openWindow would make it close the window) --></div>`;
    } });
  const reel = win.querySelector('.dg-reel'), result = win.querySelector('.dg-result'), spin = win.querySelector('.dg-spin');
  // a row for each spot on screen, plus one coming in at the top
  const rows = Array.from({ length: VISIBLE + 1 }, () => {
    const row = document.createElement('div');
    row.className = 'dg-row';
    row.innerHTML = '<span class="dg-label"></span><span class="dg-value"></span>';
    reel.append(row);
    return row;
  });
  // the reel at `p` rows down: the reward at spot j is REWARDS[j - floor(p)], each row slid down by what's left over
  let shownAt = null;
  function draw(p) {
    const k = Math.floor(p), frac = p - k;
    rows.forEach((row, n) => {
      const j = n - 1, rarity = REWARDS[mod(j - k, REWARDS.length)], r = RARITIES[rarity];
      row.style.transform = `translateY(${(j + frac)*ROW_H}px)`;
      if (row.dataset.rarity !== rarity) {
        row.dataset.rarity = rarity;
        row.className = 'dg-row dg-' + rarity;
        row.firstChild.textContent = r.label;
        row.lastChild.innerHTML = `${r.energy} energy <img class="meter-icon" src="assets/icons/energy.png" alt="">`;
      }
      row.classList.toggle('dg-alt', mod(j - k, 2) === 1);
    });
    if (shownAt !== null && k !== shownAt) tick(); // (a reward past the bottom)
    shownAt = k;
  }
  function land(slot) {
    const rarity = REWARDS[slot], r = RARITIES[rarity];
    rows.forEach(row => row.classList.toggle('dg-win', Math.round(parseFloat(row.style.transform.slice(11))/ROW_H) === MIDDLE));
    result.innerHTML = `<span class="dg-${rarity}-text">${r.label}!</span> ${r.energy} energy`;
    spin.textContent = 'Claim';
    spin.disabled = false;
    spin.onclick = () => { App.addEnergy?.(r.energy, true); claimDailyGift(); win.close(); };
  }
  const done = spunToday();
  if (done) { draw(mod(MIDDLE - done.slot, REWARDS.length)); land(done.slot); return; }
  draw(0);
  spin.onclick = () => {
    spin.disabled = true;
    const slot = Math.floor(Math.random()*REWARDS.length); // (each reward as likely as any other: rarity is how many there are)
    spun = { day: dayOf(new Date()), slot };
    try { localStorage.setItem(SPIN_KEY, JSON.stringify(spun)); } catch {}
    // round SPIN_LOOPS times and on to where `slot` sits at the middle: easing out, as a wheel slows
    const end = SPIN_LOOPS*REWARDS.length + mod(MIDDLE - slot, REWARDS.length), start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start)/SPIN_MS), eased = 1 - Math.pow(1 - t, 4);
      draw(end*eased);
      if (t < 1) { frame = requestAnimationFrame(step); return; }
      land(slot);
      confetti(reel);
    };
    frame = requestAnimationFrame(step);
  };
}
