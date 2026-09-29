import { TRAITS } from '../../core/traits.js';
import { peopleRng } from './people.js';

// ============================================================ crazy
// Someone with the crazy trait (0 to 1) has a few of their traits pushed about every CRAZY_EVERY seconds: 1 to
// CRAZY_MAX_PICKS traits, any in the table, each towards its max or its min, crazy ÷ how many were picked of the way
// there (crazy 1 with one trait: all the way). The shifts are undone before the next lot, so nothing drifts; what's on
// their card stays as it was. Multipliers move by ratio (halfway from ×1 to ×20 is ×4.5), added traits in a line.
const CRAZY_EVERY = 15;
const CRAZY_MAX_PICKS = 5;
const CRAZY_FLOOR = 0.02; // a multiplier's lowest, as a share of its base, while moving by ratio towards a min of 0
// never pushed about: switches (a roll could make someone a vampire, or explode), and those that would look broken or
// can't be undone neatly, or only mark how an entry's listed
const LEFT_ALONE = ['size', 'agemult', 'health', 'crazy', 'normal', 'legendary', 'terrible', 'solo', 'nickname', 'keysmash'];
const PUSHABLE = Object.keys(TRAITS).filter(key => TRAITS[key].combine !== 'on' && !LEFT_ALONE.includes(key) && TRAITS[key].max > TRAITS[key].min);

function undo(p) {
  const shift = p.crazyShift;
  p.crazyShift = null;
  if (!shift || shift.traits !== p.traits) return; // (their traits were worked out afresh since: nothing to undo)
  Object.entries(shift.was).forEach(([key, value]) => { p.traits[key] = value; });
}

function push(value, key, share, up) {
  const t = TRAITS[key], end = up ? t.max : t.min;
  if (share >= 1) return end;
  if (t.combine === 'add' || t.base <= 0) return value + (end - value)*share;
  const from = Math.max(value, t.base*CRAZY_FLOOR), to = Math.max(end, t.base*CRAZY_FLOOR);
  return from*Math.pow(to/from, share);
}

/**
 * Each frame for someone who's crazy (or was): every CRAZY_EVERY seconds, undo the last shifts and make new ones.
 * @param {Person} p
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateCrazy(p, dt) {
  if (p.crazyShift && p.crazyShift.traits !== p.traits) p.crazyShift = null; // (worked out afresh: the shifts went with the old)
  if ((p.crazyIn = (p.crazyIn ?? peopleRng()*CRAZY_EVERY) - dt) > 0) return;
  p.crazyIn = CRAZY_EVERY*(0.75 + peopleRng()*0.5);
  undo(p);
  const level = p.traits.crazy ?? 0;
  if (level <= 0) return;
  const picks = 1 + Math.floor(peopleRng()*CRAZY_MAX_PICKS), share = level/picks, was = {};
  const pool = PUSHABLE.slice();
  for (let k = 0; k < picks && pool.length; k++) {
    const key = pool.splice(Math.floor(peopleRng()*pool.length), 1)[0];
    was[key] = p.traits[key];
    p.traits[key] = push(p.traits[key], key, share, peopleRng() < 0.5);
  }
  p.crazyShift = { traits: p.traits, was };
}
