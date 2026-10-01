import { S } from '../../core/shared.js';
import { benchPerson, headingTo, isGone, newPerson, people, personModel, PEOPLE_MAX } from './people.js';
import { spawnPerson } from './peoplePathing.js';
import { goAfter } from './peopleActivities.js';
import { registerMini } from '../profiles.js';

// The piper trait: someone followed about by MINI_COUNT minis of themselves — real people in the crowd (their own slots,
// past its count: people.js keeps them off the bench), each copying their look (copyLook in peopleModel.js) and their
// profile (registerMini in profiles.js: shrunk with a big head, "Mini Dave #2"). Each walks its spot in FORMATION
// behind them (miniSpot, as a follower: p.follow), looking at them; they move, fall and get up on their own. Anyone of the
// family punched by someone else, the minis all go after whoever did it. A mini killed comes back after MINI_RESPAWN; all
// of them go (benched) when their leader does, or loses the trait.

const MINI_COUNT = 3;
const MINI_RESPAWN = 20;   // seconds a dead mini lies there before another takes its place
// each mini's spot: how far back from them and how far to their side (+ their left), × their height — two in front, one behind
const FORMATION = [{ back: 0.4, side: -0.2 }, { back: 0.4, side: 0.2 }, { back: 0.75, side: 0 }];
const FLEE_RING = 0.45, FLEE_LAP = 1.6; // frightened, running round them: how far out (× their height), and seconds a lap
const SETTLE = 0.15;       // stopped, a mini this close to its spot (× their height) stands still, turned to them
const FOLLOW_MODES = ['line', 'wander', 'leaving'];

const leading = p => p.traits.piper && !p.miniOf && !p.benched && p.mode !== 'dead' && !isGone(p);

/**
 * Each frame: every piper's minis made (or made again), set following, and sent after anyone who punches one of them.
 * @param {number} dt - seconds since the last frame
 * @param {number} wanted - how many people the crowd's meant to have (minis take the slots past it)
 * @returns {void}
 */
export function updateMinis(dt, wanted) {
  if (!personModel) return;
  // (minis of nobody — their leader gone, off the bench, or without the trait — go)
  people.forEach((m, j) => {
    if (!m.miniOf || m.benched) return;
    const L = m.miniOf;
    if (!people.includes(L) || L.benched || !L.traits.piper || L.miniOf) { m.miniOf = null; m.follow = null; m.act = null; benchPerson(j); }
  });
  people.forEach((L, i) => {
    if (!leading(L)) return;
    const minis = L.minis ??= [];
    for (let k = 0; k < MINI_COUNT; k++) {
      let m = minis[k];
      if (m && (m.miniOf !== L || !people.includes(m))) m = minis[k] = null;
      if (m?.mode === 'dead' && (m.deadFor = (m.deadFor ?? 0) + dt) < MINI_RESPAWN) continue;
      if (!m || m.mode === 'dead') { minis[k] = makeMini(L, i, k, m, wanted); continue; }
      keepFollowing(m, L);
    }
    avenge(L, minis);
  });
}

// a new mini of L's (in place of `old`, if it's one that died), next to them
function makeMini(L, i, k, old, wanted) {
  let j = old ? people.indexOf(old) : -1;
  if (j < 0) j = people.findIndex((q, n) => n >= wanted && q.benched && !q.miniOf);
  if (j < 0 && people.length >= PEOPLE_MAX) return null;
  const m = newPerson();
  Object.assign(m, { miniOf: L, miniIndex: k, skinBase: L.skinBase ? [...L.skinBase] : undefined, walletBase: 0, wallet: 0 }); // (penniless)
  registerMini(m.id, L.id, k + 1);
  if (j < 0) { j = people.length; people.push(m); } else people[j] = m;
  personModel.copyLook(i, j);
  spawnPerson(m);
  const spot = FORMATION[k], tall = 1.7*L.height*S.peopleSize, fx = Math.sin(L.heading), fz = Math.cos(L.heading);
  Object.assign(m, { x: L.x - fx*spot.back*tall + fz*spot.side*tall, y: L.y, z: L.z - fz*spot.back*tall - fx*spot.side*tall, heading: L.heading });
  keepFollowing(m, L);
  return m;
}

// back in formation once they're free (frightened too: they run round them instead — see miniSpot): following, and looking at them
function keepFollowing(m, L) {
  const free = !m.punched && !m.attack && !m.stun && !m.please && !m.oneShot && !m.inRoom && !m.train && !m.indoors && m.mode !== 'possessed';
  if (!free) return;
  if (m.follow !== L) Object.assign(m, { follow: L, act: 'walk', group: null, faceTo: null });
  m.lookAt = L;
}

// someone of the family punched by anyone else: every free mini goes after them
function avenge(L, minis) {
  for (const x of [L, ...minis]) {
    const hit = x?.punched;
    if (!hit || hit.stage === 'marked' || hit === x.avenged) continue;
    x.avenged = hit;
    const by = hit.by;
    if (!by?.traits || !people.includes(by) || by === L || by.miniOf === L || isGone(by)) continue;
    for (const m of minis) {
      if (!m || m === x || m.mode === 'dead' || m.punched || m.attack || m.traits.pacifist) continue;
      Object.assign(m, { follow: null, act: null });
      goAfter(m, by, true);
    }
  }
}

/**
 * Where a mini (following its leader: p.follow) should be: its spot in FORMATION behind them, going where they go. Stopped,
 * close to it, it stays put, turned to them; with them somewhere it can't go (indoors, on a train), it waits.
 * @param {object} p - the mini
 * @returns {?{x: number, y: number, z: number}} where to head (null to stay put)
 */
export function miniSpot(p) {
  const L = p.follow, spot = FORMATION[p.miniIndex] ?? FORMATION[0], tall = 1.7*L.height*S.peopleSize;
  if (FOLLOW_MODES.includes(L.mode)) Object.assign(p, { mode: L.mode, li: L.li, u: L.u, seg: L.seg, dir: L.dir, area: L.area, exit: L.exit, lat: L.lat });
  else if (L.mode !== 'possessed') { p.faceTo = headingTo(p, L); return null; }
  if (p.fright?.stage === 'flee') { // (frightened: running round and round them, spaced out)
    const a = performance.now()/1000*2*Math.PI/FLEE_LAP + p.miniIndex*2*Math.PI/3;
    return { x: L.x + Math.sin(a)*FLEE_RING*tall, y: L.y, z: L.z + Math.cos(a)*FLEE_RING*tall };
  }
  const fx = Math.sin(L.heading), fz = Math.cos(L.heading);
  const at = { x: L.x - fx*spot.back*tall + fz*spot.side*tall, y: L.y, z: L.z - fz*spot.back*tall - fx*spot.side*tall };
  if (!L.moving && Math.hypot(at.x - p.x, at.z - p.z) < SETTLE*tall) { p.faceTo = headingTo(p, L); return null; }
  return at;
}
