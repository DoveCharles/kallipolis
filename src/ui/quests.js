import { App, S } from '../core/shared.js';
import { camera } from '../core/scene.js';
import { openWindow } from './w3-window.js';
import { stillLoading } from './loading.js';
import { standingOf } from '../life/people/people.js';
import { getTrainStations } from '../trains/trains.js';
import { getProgress, setProgress, onProgress } from '../project/progress.js';

// Quests (toolbar button left of the daily gift): TIMED_MAX timed ones (do N things before the clock runs out, which
// only runs while the world does), up to REQUEST_MAX requests from real peds (build them something), up to BOUNTY_MAX
// bounties (smite a named villain in time) and ACHIEVEMENTS (once each, ever). Each pays energy.
// Kept with the project (project/progress.js). Events come in through App.questEvent (people.js, peopleTracking.js,
// person-card.js, traffic/follow.js); requests are checked by counting what's built.
const TIMED_MAX = 3, REQUEST_MAX = 5;
const TIMED_GAP = [20, 90], REQUEST_GAP = [45, 180]; // seconds of world time before the next comes in
const BOUNTY_MAX = 2, BOUNTY_GAP = [90, 240], BOUNTY_MINS = 8, BOUNTY_REWARD = 3;
const DONE_SHOW = 6; // seconds a finished or failed quest stays listed

const alive = p => p && p.mode !== 'dead' && p.mode !== 'none' && p.mode !== 'drowning';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pick = a => a[Math.floor(Math.random()*a.length)];
const between = ([a, b]) => a + Math.random()*(b - a);

// ---- timed: `on` the event counted, `match` who counts (find: each person once), `n` the goal's range, `mins` the time
const TIMED = [
  { key: 'vampires', on: 'kill', match: p => p.traits.vampire, n: [2, 6], mins: 10, text: n => `Smite ${plural(n, 'vampire')}` },
  { key: 'villains', on: 'kill', match: p => standingOf(p) === 'villainous', n: [3, 8], mins: 10, text: n => `Rid the city of ${plural(n, 'villain')}` },
  { key: 'zombies', on: 'kill', match: p => p.traits.zombie, n: [2, 5], mins: 8, text: n => `Put down ${plural(n, 'zombie')}` },
  { key: 'bloodlust', on: 'kill', match: p => p.traits.bloodlust, n: [1, 3], mins: 6, text: n => `Stop ${plural(n, 'bloodlusting ped')}` },
  { key: 'innocents', on: 'kill', match: p => standingOf(p) === 'innocent', n: [3, 6], mins: 5, text: n => `Sacrifice ${plural(n, 'innocent')}` },
  { key: 'drunk', on: 'find', match: p => p.traits.drunk > 0, n: [2, 5], mins: 5, text: n => `Find ${plural(n, 'drunk ped')}` },
  { key: 'blazed', on: 'find', match: p => p.traits.blazed, n: [2, 4], mins: 5, text: n => `Find ${plural(n, 'blazed ped')}` },
  { key: 'nude', on: 'find', match: p => p.traits.nude, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'nudist')}` },
  { key: 'backwards', on: 'find', match: p => p.traits.backwards, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'ped')} walking backwards` },
  { key: 'upsidedown', on: 'find', match: p => p.traits.upsidedown, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'ped')} with ${n === 1 ? 'their head' : 'heads'} on upside down` },
  { key: 'sick', on: 'find', match: p => p.traits.sick, n: [2, 4], mins: 5, text: n => `Find ${plural(n, 'sick ped')}` },
  { key: 'findzombies', on: 'find', match: p => p.traits.zombie, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'zombie')}` },
  { key: 'findvampires', on: 'find', match: p => p.traits.vampire, n: [1, 3], mins: 6, text: n => `Find ${plural(n, 'vampire')}` },
  { key: 'ghosts', on: 'find', match: p => p.traits.ghost, n: [1, 3], mins: 6, text: n => `Find ${plural(n, 'ghost')}` },
  { key: 'twins', on: 'find', match: p => p.traits.twins, n: [1, 2], mins: 6, text: n => `Find ${plural(n, 'pair')} of twins` },
  { key: 'old', on: 'find', match: p => p.age >= 80, n: [2, 5], mins: 5, text: n => `Find ${plural(n, 'ped')} aged 80 or over` },
  { key: 'kids', on: 'find', match: p => p.age <= 12, n: [2, 5], mins: 5, text: n => `Find ${plural(n, 'child', 'children')}` },
  { key: 'crying', on: 'find', match: p => p.traits.crying > 0.2, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'ped')} in tears` },
  { key: 'fuming', on: 'find', match: p => p.traits.fuming > 0.2, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'fuming ped')}` },
  { key: 'lovestruck', on: 'find', match: p => p.traits.lovestruck > 0.2, n: [1, 3], mins: 5, text: n => `Find ${plural(n, 'lovestruck ped')}` },
  { key: 'sleepy', on: 'find', match: p => p.traits.drowsy > 0.3, n: [2, 4], mins: 5, text: n => `Find ${plural(n, 'sleepy ped')}` },
  { key: 'gifts', on: 'gift', n: [2, 5], mins: 5, text: n => `Give ${plural(n, 'gift')}` },
  { key: 'cars', on: 'car', n: [2, 6], mins: 5, text: n => `Destroy ${plural(n, 'car')}` },
];
const timedOf = key => TIMED.find(d => d.key === key);
const rewardOf = (def, n) => Math.max(1, Math.min(4, Math.round(n*(def.on === 'find' ? 0.5 : 0.6))));

// ---- requests: `count` what there is now (built when it's gone up by `more`, default 1)
const zones = type => () => S.zones.filter(z => z.zoneType === type).length;
const objects = (type, more = 1) => ({ count: () => S.objects.filter(o => o.type === type).length, more });
const REQUESTS = [
  { key: 'train', count: () => S.roadLines.filter(l => l.kind === 'train').length, lines: ['Can we have more trains?', 'Another train line would be lovely.', 'The trains are always packed. Build another!'] },
  { key: 'station', count: () => getTrainStations().size, lines: ['We need a train station nearer us.', 'Another station, please — my feet hurt.'] },
  { key: 'road', count: () => S.roadLines.filter(l => l.kind !== 'train').length, lines: ['The traffic is awful. More roads!', 'Can we have a new road?'] },
  { key: 'park', count: zones('park'), lines: ['We need another park.', 'Somewhere green to sit, please?', 'My dog needs a park.'] },
  { key: 'plaza', count: zones('plaza'), lines: ['A plaza to hang about in?', 'Can we have a square to meet people in?'] },
  { key: 'beach', count: zones('beach'), lines: ['Can we have a beach?', 'I want to lie on some sand.'] },
  { key: 'water', count: zones('water'), lines: ['A lake would be nice.', 'I want to go swimming. Some water?'] },
  { key: 'suburbs', count: zones('suburbs'), lines: ["More houses! I can't afford the rent.", 'Somewhere quiet to live, please.'] },
  { key: 'town', count: zones('town'), lines: ['The town needs more shops.', 'Build up the town centre!'] },
  { key: 'industrial', count: zones('industrial'), lines: ['Jobs! Build some industry.', 'We need factories for work.'] },
  { key: 'farmland', count: zones('farmland'), lines: ['Fresh veg, please — some farmland?', 'I miss the countryside.'] },
  { key: 'airport', count: zones('airport'), lines: ['I want to fly somewhere. An airport?', 'Build an airport, I need a holiday.'] },
  { key: 'marina', count: zones('marina'), lines: ['A marina for my boat?', 'Where am I meant to moor my yacht?'] },
  { key: 'carpark', count: zones('carpark'), lines: ['There is nowhere to park!', 'A car park, please.'] },
  { key: 'mall', count: () => zones('mall')() + (S.malls?.length ?? 0), lines: ['Can we have a mall?', 'I want to go shopping somewhere dry.'] },
  { key: 'bench', ...objects('bench', 3), lines: ['Somewhere to sit would be nice. More benches?', 'My legs are tired. Benches!'] },
  { key: 'lamp', ...objects('lamp', 3), lines: ["It's so dark at night. More lamp posts!", "I can't see where I'm going at night."] },
  { key: 'bin', ...objects('bin', 2), lines: ['Litter everywhere. More bins!', 'Where do I put my rubbish?'] },
  { key: 'statue', ...objects('statue'), lines: ['A statue would brighten the place up.', 'Put up a statue of someone great. Me, ideally.'] },
  { key: 'coffee', ...objects('coffee'), lines: ['Where can I get a coffee round here?', 'I need caffeine. A coffee stall?'] },
  { key: 'hotdog', ...objects('hotdog'), lines: ["I'm starving. A hot dog stand?", 'Can we have a hot dog stand?'] },
  { key: 'beer', ...objects('beer'), lines: ['I could murder a pint. A beer stall?', 'More beer, please.'] },
  { key: 'stall', ...objects('stall'), lines: ['A market would be lovely.', 'Can we have a market stall?'] },
  { key: 'postbox', ...objects('postbox'), lines: ['I need to post a letter.', 'Where is the nearest postbox?'] },
  { key: 'phonebox', ...objects('phonebox'), lines: ['My phone died. A phone box?', 'Can we have a phone box?'] },
  { key: 'noticeboard', ...objects('noticeboard'), lines: ['My cat is lost. A notice board?', 'Somewhere to put up posters, please.'] },
  { key: 'medbooth', ...objects('medbooth'), lines: ['I keep getting hurt. A med booth?', 'We need a med booth nearby.'] },
  { key: 'seraphring', ...objects('seraphring'), lines: ["I don't feel safe. Something to keep the villains away?", 'Protect us from the vampires!'] },
];
const requestOf = key => REQUESTS.find(d => d.key === key);

// ---- bounties: what they're wanted for
const CRIMES = ['murder', 'arson', 'stealing pensions', 'kicking pigeons', 'jaywalking (and murder)', 'tax evasion', 'grave robbing',
  'running a pyramid scheme', 'poisoning the water', 'kidnapping a mayor', 'robbing the bank', 'littering, violently'];
const crimeOf = p => p.traits.vampire ? 'biting necks' : pick(CRIMES);

// ---- achievements: `have` how far along, `n` the goal (stat ones count s.stats)
const stat = (key, n) => ({ n, have: () => s.stats[key] ?? 0 });
const ZONE_TYPES = ['park', 'plaza', 'beach', 'water', 'suburbs', 'town', 'industrial', 'farmland', 'airport', 'marina', 'carpark'];
const ACHIEVEMENTS = [
  { key: 'firstblood', name: 'First Blood', text: 'Smite a ped', reward: 1, ...stat('kill', 1) },
  { key: 'reaper', name: 'Grim Reaper', text: 'Smite 100 peds', reward: 5, ...stat('kill', 100) },
  { key: 'vamp10', name: 'Vampire Hunter', text: 'Smite 10 vampires', reward: 3, ...stat('vampire', 10) },
  { key: 'vamp50', name: 'Van Helsing', text: 'Smite 50 vampires', reward: 6, ...stat('vampire', 50) },
  { key: 'villain25', name: 'Scourge of Villainy', text: 'Smite 25 villains', reward: 4, ...stat('villain', 25) },
  { key: 'innocent25', name: 'Monster', text: 'Smite 25 innocents', reward: 4, ...stat('innocent', 25) },
  { key: 'cars25', name: 'Wrecker', text: 'Destroy 25 cars', reward: 3, ...stat('car', 25) },
  { key: 'gifts25', name: 'Generous', text: 'Give 25 gifts', reward: 3, ...stat('gift', 25) },
  { key: 'timed10', name: 'Quester', text: 'Finish 10 timed quests', reward: 3, ...stat('timed', 10) },
  { key: 'timed50', name: 'Hero of Kallipolis', text: 'Finish 50 timed quests', reward: 8, ...stat('timed', 50) },
  { key: 'requests10', name: 'Public Servant', text: 'Grant 10 requests', reward: 3, ...stat('requests', 10) },
  { key: 'requests50', name: 'Beloved Leader', text: 'Grant 50 requests', reward: 8, ...stat('requests', 50) },
  { key: 'bounty1', name: 'Dead or Alive', text: 'Claim a bounty', reward: 1, ...stat('bounties', 1) },
  { key: 'bounty10', name: 'Bounty Hunter', text: 'Claim 10 bounties', reward: 5, ...stat('bounties', 10) },
  { key: 'zones', name: 'Urban Planner', text: 'Build one of every kind of zone', reward: 5, n: ZONE_TYPES.length, have: () => ZONE_TYPES.filter(t => S.zones.some(z => z.zoneType === t)).length },
  { key: 'trains', name: 'Choo Choo', text: 'Run 5 train lines', reward: 3, n: 5, have: () => S.roadLines.filter(l => l.kind === 'train').length },
  { key: 'objects', name: 'Street Furniture', text: 'Place 50 objects', reward: 3, n: 50, have: () => S.objects.length },
  { key: 'pop500', name: 'Town', text: 'Have 500 peds out at once', reward: 3, n: 500, have: () => out().length },
  { key: 'pop1000', name: 'Metropolis', text: 'Have 1000 peds out at once', reward: 5, n: 1000, have: () => out().length },
];

// ---- state: { timed: [{key, n, got, seen?, left, reward, end?}], requests: [{key, line, id, name, base, reward, thumb?, end?}],
// bounties: [{id, name, crime, left, reward, thumb?, end?}], nextTimed, nextRequest, nextBounty, stats: {key: count}, achieved: {key: Date.now} }
const live = (list, ok = () => true) => Array.isArray(list) ? list.filter(q => q && ok(q) && !q.end) : [];
const fresh = v => ({ timed: live(v?.timed, q => timedOf(q.key)), requests: live(v?.requests, q => requestOf(q.key)), bounties: live(v?.bounties),
  nextTimed: v?.nextTimed ?? 3, nextRequest: v?.nextRequest ?? between(REQUEST_GAP)/3, nextBounty: v?.nextBounty ?? between(BOUNTY_GAP)/2,
  stats: { ...v?.stats }, achieved: { ...v?.achieved } });
let s = fresh(getProgress('quests'));
const save = () => setProgress('quests', s);
onProgress('quests', v => { s = fresh(v); render(); });

const out = () => (App.people || []).filter(p => alive(p) && !p.indoors && !p.train);
function newTimed() {
  const crowd = out(), have = new Set(s.timed.map(q => q.key));
  const options = TIMED.filter(d => !have.has(d.key)).map(d => {
    const there = d.match ? crowd.filter(d.match).length : Infinity;
    const n = Math.min(Math.round(between(d.n)), there);
    return n >= 1 ? { d, n } : null;
  }).filter(Boolean);
  if (!options.length) return;
  const { d, n } = pick(options);
  s.timed.push({ key: d.key, n, got: 0, seen: d.on === 'find' ? [] : undefined, left: d.mins*60, reward: rewardOf(d, n) });
}
function newRequest() {
  const have = new Set(s.requests.map(q => q.key)), asked = new Set(s.requests.map(q => q.id));
  const d = pick(REQUESTS.filter(r => !have.has(r.key)));
  // someone near the camera, so they can be seen (and their face drawn)
  const near = out().filter(p => !asked.has(p.id) && p.name)
    .sort((a, b) => (a.x - camera.position.x)**2 + (a.z - camera.position.z)**2 - (b.x - camera.position.x)**2 - (b.z - camera.position.z)**2).slice(0, 20);
  if (!d || !near.length) return;
  const p = pick(near);
  const q = { key: d.key, line: pick(d.lines), id: p.id, name: p.name, base: d.count(), reward: d.more > 1 ? 2 : 1 };
  s.requests.push(q);
  thumbFor(q);
}
function newBounty() {
  const wanted = new Set(s.bounties.map(q => q.id));
  const villains = out().filter(p => p.name && !wanted.has(p.id) && standingOf(p) === 'villainous');
  if (!villains.length) return;
  const p = pick(villains);
  s.bounties.push({ id: p.id, name: p.name, crime: crimeOf(p), left: BOUNTY_MINS*60, reward: BOUNTY_REWARD });
}
const snapping = new Set(); // (ids whose face is being drawn)
function thumbFor(q) {
  const i = (App.people || []).findIndex(p => p?.id === q.id);
  if (i < 0 || !App.snapHeadshot || snapping.has(q.id)) return;
  snapping.add(q.id);
  App.snapHeadshot(i).then(url => { snapping.delete(q.id); if (!url) return; q.thumb = url; save(); render(); });
}

const count = (key, k = 1) => { s.stats[key] = (s.stats[key] ?? 0) + k; };
function finish(q, won, list) {
  q.end = { won, at: performance.now() };
  if (won) { App.addEnergy?.(q.reward, true); count(list); flash(); }
  save(); render();
}

/** Something happened that a timed quest might count. @param {'kill'|'find'|'gift'|'car'} on @param {{p?: object, by?: string}} [e] */
function questEvent(on, e = {}) {
  if (on === 'kill' && e.by !== 'player') return;
  if (on === 'kill') {
    count('kill');
    if (e.p.traits.vampire) count('vampire');
    const standing = standingOf(e.p);
    if (standing !== 'guilty') count(standing === 'villainous' ? 'villain' : 'innocent');
    s.bounties.forEach(q => { if (!q.end && q.id === e.p.id) finish(q, true, 'bounties'); });
  } else if (on === 'car' || on === 'gift') count(on);
  let changed = false;
  s.timed.forEach(q => {
    const d = timedOf(q.key);
    if (q.end || d.on !== on || (d.match && !(e.p && d.match(e.p)))) return;
    if (q.seen) { if (q.seen.includes(e.p.id)) return; q.seen.push(e.p.id); }
    q.got++; changed = true;
    if (q.got >= q.n) finish(q, true, 'timed');
  });
  if (changed) { save(); render(); }
}

// ---- the clock: once a second, counted only while the world runs
let last = performance.now();
setInterval(() => {
  const now = performance.now(), dt = (now - last)/1000;
  last = now;
  const ended = q => q.end && now - q.end.at > DONE_SHOW*1000;
  const before = s.timed.length + s.requests.length + s.bounties.length;
  s.timed = s.timed.filter(q => !ended(q)); s.requests = s.requests.filter(q => !ended(q)); s.bounties = s.bounties.filter(q => !ended(q));
  let changed = s.timed.length + s.requests.length + s.bounties.length !== before;
  if (S.interactionMode === 'move' && !stillLoading() && App.people?.length) {
    s.timed.forEach(q => { if (!q.end && (q.left -= dt) <= 0) { q.left = 0; finish(q, false, 'timed'); } });
    s.bounties.forEach(q => { if (!q.end && (q.left -= dt) <= 0) { q.left = 0; finish(q, false, 'bounties'); } });
    const n = s.timed.length + s.requests.length + s.bounties.length;
    if (s.timed.filter(q => !q.end).length < TIMED_MAX && (s.nextTimed -= dt) <= 0) { for (let k = s.timed.length ? 1 : TIMED_MAX; k > 0; k--) newTimed(); s.nextTimed = between(TIMED_GAP); } // (all at once to start)
    if (s.requests.filter(q => !q.end).length < REQUEST_MAX && (s.nextRequest -= dt) <= 0) { newRequest(); s.nextRequest = between(REQUEST_GAP); }
    if (s.bounties.filter(q => !q.end).length < BOUNTY_MAX && (s.nextBounty -= dt) <= 0) { newBounty(); s.nextBounty = between(BOUNTY_GAP); }
    if (s.timed.length + s.requests.length + s.bounties.length !== n) changed = true;
    else tickTimes(); // (just the clocks: saved with s's next save, the store holding s itself)
  }
  // requests: built yet? (checked in edit mode too: that's where it's built), or the asker gone
  s.requests.forEach(q => {
    if (q.end) return;
    const d = requestOf(q.key);
    if (d.count() >= q.base + (d.more ?? 1)) { finish(q, true, 'requests'); return; }
    const p = (App.people || []).find(x => x?.id === q.id);
    if (!alive(p)) finish(q, false, 'requests');
    else if (!q.thumb) thumbFor(q);
  });
  // bounties: dead by some other hand, or gone
  s.bounties.forEach(q => {
    if (q.end) return;
    const p = (App.people || []).find(x => x?.id === q.id);
    if (!alive(p)) { q.beaten = true; finish(q, false, 'bounties'); }
    else if (!q.thumb) thumbFor(q);
  });
  // achievements
  ACHIEVEMENTS.forEach(a => {
    if (s.achieved[a.key] || a.have() < a.n) return;
    s.achieved[a.key] = Date.now(); App.addEnergy?.(a.reward, true); flash(); changed = true;
  });
  if (changed) { save(); render(); }
}, 1000);

// ---------------------------------------------------------- the window: kinds down the left, their quests on the right
const KINDS = [{ key: 'timed', name: 'Timed' }, { key: 'requests', name: 'Requests' }, { key: 'bounties', name: 'Bounties' }, { key: 'achievements', name: 'Goals' }];
let win = null, kind = 'timed';
const button = document.getElementById('btn-quests');
const setIcon = open => { const img = button?.querySelector('img'); if (img) img.src = `assets/icons/quests${open ? '-open' : ''}.png`; button?.classList.toggle('on', open); };
function flash() { if (win) return; button?.classList.remove('qs-new'); void button?.offsetWidth; button?.classList.add('qs-new'); }
const clock = t => `${Math.floor(t/60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const energyIcon = '<img class="meter-icon" src="assets/icons/energy.png" alt="energy">';
const esc = t => String(t).replace(/[&<>"]/g, c => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

function tickTimes() {
  if (!win) return;
  if (kind === 'achievements') { render(); return; }
  if (kind !== 'timed' && kind !== 'bounties') return;
  win.list.querySelectorAll('.qs-quest').forEach((row, i) => { const q = s[kind][i]; if (q && !q.end) row.querySelector('.qs-time').textContent = clock(q.left); });
}
const thumb = q => `<div class="qs-thumb">${q.thumb ? `<img src="${q.thumb}" alt="">` : ''}</div>`;
function render() {
  if (!win) return;
  win.kinds.forEach(b => {
    const k = b.dataset.kind, n = k === 'achievements' ? Object.keys(s.achieved).length : s[k].filter(q => !q.end).length;
    b.classList.toggle('qs-on', k === kind);
    b.querySelector('.qs-n').textContent = k === 'achievements' ? `(${n}/${ACHIEVEMENTS.length})` : n ? `(${n})` : '';
  });
  if (kind === 'achievements') {
    const got = a => !!s.achieved[a.key];
    win.list.innerHTML = [...ACHIEVEMENTS].sort((a, b) => got(b) - got(a)).map(a => {
      const have = Math.min(a.have(), a.n);
      return `<div class="qs-quest qs-ach${got(a) ? ' qs-won' : ''}"><div class="qs-row"><b>${a.name}</b><span class="qs-reward">${got(a) ? '✓' : `+${a.reward}${energyIcon}`}</span></div>
        <div class="qs-row"><span class="qs-line">${a.text}</span></div>
        ${got(a) ? '' : `<div class="qs-row"><div class="qs-bar"><div style="width:${100*have/a.n}%"></div></div><span>${have}/${a.n}</span></div>`}</div>`;
    }).join('');
    return;
  }
  const list = s[kind];
  const EMPTY = { timed: 'No quests yet. Check back soon.', requests: 'Nobody wants anything. Yet.', bounties: 'No one is wanted. Yet.' };
  if (!list.length) { win.list.innerHTML = `<div class="qs-empty">${EMPTY[kind]}</div>`; return; }
  win.list.innerHTML = list.map((q, i) => {
    const state = q.end ? (q.end.won ? ' qs-won' : ' qs-lost') : '';
    const reward = `<span class="qs-reward">+${q.reward}${energyIcon}</span>`;
    if (kind === 'timed') {
      const d = timedOf(q.key);
      const status = q.end ? (q.end.won ? 'Done!' : 'Out of time') : clock(q.left);
      return `<div class="qs-quest${state}"><div class="qs-row"><b>${esc(d.text(q.n))}</b>${reward}</div>
        <div class="qs-row"><div class="qs-bar"><div style="width:${100*q.got/q.n}%"></div></div><span>${q.got}/${q.n}</span><span class="qs-time">${status}</span></div></div>`;
    }
    if (kind === 'bounties') {
      const status = q.end ? (q.end.won ? 'Claimed!' : q.beaten ? 'Someone beat you to it' : 'Got away') : clock(q.left);
      return `<div class="qs-quest qs-request qs-bounty${state}" data-i="${i}">${thumb(q)}
        <div class="qs-body"><div class="qs-row"><b>WANTED: ${esc(q.name)}</b>${reward}</div>
        <div class="qs-line">for ${esc(q.crime)}</div><div class="qs-time">${status}</div></div></div>`;
    }
    const status = q.end ? (q.end.won ? 'Built — thanks!' : 'Gone') : '';
    return `<div class="qs-quest qs-request${state}" data-i="${i}">${thumb(q)}
      <div class="qs-body"><div class="qs-row"><button class="qs-name" title="Find them">${esc(q.name)}</button>${reward}</div>
      <div class="qs-line">“${esc(q.line)}”</div>${status ? `<div class="qs-time">${status}</div>` : ''}</div>
      ${q.end ? '' : '<button class="qs-refuse" title="Refuse">×</button>'}</div>`;
  }).join('');
}

/** Open (or close) the Quests window. @returns {void} */
export function openQuests() {
  if (win) { win.el.close(); return; }
  const el = openWindow({ id: 'quests', title: 'Quests', width: 460, resizable: true, noOk: true,
    fill: body => {
      body.innerHTML = `<div class="qs"><div class="qs-kinds">${KINDS.map(k => `<div class="qs-kind" role="button" data-kind="${k.key}">${k.name} <span class="qs-n"></span></div>`).join('')}</div><div class="qs-list"></div></div>`;
      win = { kinds: [...body.querySelectorAll('.qs-kind')], list: body.querySelector('.qs-list') };
      win.kinds.forEach(b => b.addEventListener('click', () => { kind = b.dataset.kind; render(); }));
      win.list.addEventListener('click', e => {
        const row = e.target.closest('.qs-request'), q = row && s[kind][row.dataset.i];
        if (!q) return;
        if (e.target.closest('.qs-refuse')) { s.requests.splice(s.requests.indexOf(q), 1); save(); render(); }
        else if (e.target.closest('.qs-name')) { const i = App.people.findIndex(p => p?.id === q.id); if (i >= 0 && alive(App.people[i])) App.followPerson(i); }
      });
    },
    onClose: () => { win = null; setIcon(false); } });
  win.el = el;
  button?.classList.remove('qs-new');
  setIcon(true);
  render();
}
button?.addEventListener('click', openQuests);

Object.assign(App, { questEvent });
