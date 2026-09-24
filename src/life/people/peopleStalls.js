import { S } from '../../core/shared.js';
import { headingTo, people, peopleNav, peopleRng, walkableUpTo, wrapAngle } from './people.js';
import { endActivity } from './peopleActivities.js';
import { walkwayPoint } from './peoplePathing.js';
import { giveSnack } from './peopleHolding.js';

// ============================================================ buying from a stall
// A hot dog stand or a coffee stall put down among the objects (see objects/object-types.js) sells to whoever is passing:
// someone walking by on a walkway nearby now and then steps off to it, and someone hanging about in a plaza or park goes
// over to one there. They walk up to its front, turn to it, wait a moment while it's made, and leave with a hot dog or a
// coffee in hand (see A SNACK in peopleHolding.js) — back onto their walkway where they left it, or off about the hangout.
//
// While they're at it their activity (p.act) is 'buy', so nobody stops them for a chat, and what they're buying is kept
// on p.buy.
const STALLS = { hotdog: { item: 'hotdog', front: 0.9 }, coffee: { item: 'coffee', front: 1.25 } }; // (how far in front of it a customer stands, in metres)
const CUSTOMER_SLOTS = [0, -0.7, 0.7]; // where along its front a customer stands, in metres: in the middle, then either side
const WALKWAY_REACH = 7;   // how far off a walkway someone will go to one (at people size 1)
const HANGOUT_REACH = 25;  // how far across a hangout
const WALKWAY_RATE = 0.06; // the chance a second someone near enough steps off their walkway to one
const SERVE_TIME = [2.5, 5];     // seconds waiting at the front
const GIVE_UP = 25;              // seconds to get there before they give up
const SNACK_COOLDOWN = [60, 180]; // seconds after one before they'd buy another

const stallOf = id => S.objects.find(o => o.id === id && STALLS[o.type]) ?? null;
/** Where a customer of `o` stands in slot `k`, and the way they face to be served. */
function frontOf(o, k) {
  const sin = Math.sin(o.rotY), cos = Math.cos(o.rotY), out = STALLS[o.type].front*o.scale, along = CUSTOMER_SLOTS[k]*o.scale;
  const at = { x: o.x + sin*out + cos*along, z: o.z + cos*out - sin*along };
  return { ...at, facing: headingTo(at, o) };
}
/** A free place at a stall's front, if there is one. */
function freeSlot(o, p) {
  for (let k=0;k<CUSTOMER_SLOTS.length;k++) if (!people.some(q => q !== p && q.act === 'buy' && q.stage !== 'back' && q.buy?.stall === o.id && q.buy.slot === k)) return k;
  return -1;
}
/** Whether someone would buy anything just now. */
const wantsOne = p => !p.snack && !p.act && !(p.snackCooldown > 0) && !p.fright && !p.stun && !p.please && !p.attack && !p.punched && !p.oneShot;

/**
 * The nearest stall someone could walk straight to, with a free place at its front.
 * @param {object} p - the person
 * @param {number} reach - how far they'd go
 * @param {function} canWalk - whether the walk there, to {x, z}, is clear
 * @returns {?{o: object, slot: number, at: object}}
 */
function nearestStall(p, reach, canWalk) {
  let best = null, bestD = reach*S.peopleSize;
  for (const o of S.objects) {
    if (!STALLS[o.type]) continue;
    const d = Math.hypot(o.x - p.x, o.z - p.z);
    if (d >= bestD) continue;
    const slot = freeSlot(o, p);
    if (slot < 0) continue;
    const at = frontOf(o, slot);
    if (!canWalk(at)) continue;
    best = { o, slot, at };
    bestD = d;
  }
  return best;
}
function startBuying(p, { o, slot }) {
  p.act = 'buy';
  p.stage = 'go';
  p.timer = GIVE_UP;
  p.buy = { stall: o.id, slot, item: STALLS[o.type].item };
}

/**
 * Someone hanging about in a hangout going over to a stall in it, if there's one (see the wander choices in people.js).
 * @param {object} p - the person
 * @param {Hangout} area - where they are
 * @returns {boolean} whether they're off to one
 */
export function goBuy(p, area) {
  if (!wantsOne(p)) return false;
  const stall = nearestStall(p, HANGOUT_REACH, at => walkableUpTo(area, p, at.x, at.z).clear);
  if (!stall) return false;
  startBuying(p, stall);
  return true;
}
/** Whether there's a stall in a hangout at all, for weighing up going to one. */
export const hasStallIn = area => S.objects.some(o => STALLS[o.type] && area.inside(o.x, o.z));

/**
 * Now and then, someone on a walkway stepping off it to a stall close by — so long as the way there crosses no road.
 * Called each frame for everyone walking a walkway.
 * @param {object} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {boolean} whether they're off to one
 */
export function maybeBuyOnWalkway(p, dt) {
  if (peopleRng() > dt*WALKWAY_RATE || !wantsOne(p) || p.jc || p.crossStage) return false;
  const stall = nearestStall(p, WALKWAY_REACH, at => {
    const steps = Math.max(2, Math.ceil(Math.hypot(at.x - p.x, at.z - p.z)/0.5));
    for (let k=1;k<=steps;k++) if (peopleNav.onPavement(p.x + (at.x - p.x)*k/steps, p.z + (at.z - p.z)*k/steps)) return false;
    return true;
  });
  if (!stall) return false;
  startBuying(p, stall);
  return true;
}

/**
 * Where someone buying from a stall heads this frame: to its front, standing there to be served, and — off a walkway —
 * back to where they left it.
 * @param {object} p - the person
 * @param {number} dt - seconds since the last frame
 * @param {number} y - the height of the ground they walk on
 * @returns {?{x: number, y: number, z: number}} where to head (null to stay put)
 */
export function updateBuying(p, dt, y) {
  const buy = p.buy, o = buy ? stallOf(buy.stall) : null;
  if (p.stage !== 'back' && !o) return doneBuying(p); // (taken away while they were at it)
  const at = o ? frontOf(o, buy.slot) : null;
  switch (p.stage) {
    case 'go':
      p.timer -= dt;
      if (p.timer <= 0) return doneBuying(p); // can't get there
      if (Math.hypot(at.x - p.x, at.z - p.z) > 0.2*S.peopleSize) return { x: at.x, y, z: at.z };
      p.stage = 'turn';
      // falls through
    case 'turn':
      p.faceTo = at.facing;
      if (Math.abs(wrapAngle(at.facing - p.heading)) > 0.15) return null;
      p.stage = 'wait';
      p.timer = SERVE_TIME[0] + peopleRng()*(SERVE_TIME[1] - SERVE_TIME[0]);
      // falls through
    case 'wait':
      p.faceTo = at.facing;
      p.timer -= dt;
      if (p.timer > 0) return null;
      giveSnack(p, buy.item);
      p.snackCooldown = SNACK_COOLDOWN[0] + peopleRng()*(SNACK_COOLDOWN[1] - SNACK_COOLDOWN[0]);
      return doneBuying(p);
    case 'back': {
      const back = walkwayPoint(p);
      if (Math.hypot(back.x - p.x, back.z - p.z) > 0.3*S.peopleSize) return back;
      endActivity(p);
      p.buy = null;
      return back;
    }
  }
  return null;
}
// Bought one (or given up): back to the walkway, or off about the hangout.
function doneBuying(p) {
  if (p.mode === 'line') { p.stage = 'back'; p.faceTo = null; return null; }
  endActivity(p);
  p.buy = null;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; p.wait = 0.5 + peopleRng()*2; }
  return null;
}
