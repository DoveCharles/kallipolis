import { TRAITS } from '../../core/traits.js';
import { peopleRng } from './people.js';

// ============================================================ erratic
// Someone with the erratic trait (0 to 1) has a few of their traits pushed about every ERRATIC_EVERY seconds: 1 to
// ERRATIC_MAX_PICKS traits, any in the table, each towards its max or its min, erratic ÷ how many were picked of the way
// there (erratic 1 with one trait: all the way). The shifts are undone before the next lot, so nothing drifts; what's on
// their card stays as it was. Multipliers move by ratio (halfway from ×1 to ×20 is ×4.5), added traits in a line.
const ERRATIC_EVERY = 15;
const ERRATIC_MAX_PICKS = 5;
const ERRATIC_FLOOR = 0.02; // a multiplier's lowest, as a share of its base, while moving by ratio towards a min of 0
// never pushed about: switches (a roll could make someone a vampire, or explode), and those that would look broken or
// can't be undone neatly, or only mark how an entry's listed
const LEFT_ALONE = ['size', 'agemult', 'health', 'erratic', 'normal', 'legendary', 'terrible', 'solo', 'nickname', 'keysmash'];
const PUSHABLE = Object.keys(TRAITS).filter(key => TRAITS[key].combine !== 'on' && TRAITS[key].combine !== 'set' && !LEFT_ALONE.includes(key) && TRAITS[key].max > TRAITS[key].min);

function undo(p) {
  const shift = p.erraticShift;
  p.erraticShift = null;
  if (!shift || shift.traits !== p.traits) return; // (their traits were worked out afresh since: nothing to undo)
  Object.entries(shift.was).forEach(([key, value]) => { p.traits[key] = value; });
}

function push(value, key, share, up) {
  const t = TRAITS[key], end = up ? t.max : t.min;
  if (share >= 1) return end;
  if (t.combine === 'add' || t.base <= 0) return value + (end - value)*share;
  const from = Math.max(value, t.base*ERRATIC_FLOOR), to = Math.max(end, t.base*ERRATIC_FLOOR);
  return from*Math.pow(to/from, share);
}

/**
 * Each frame for someone with the erratic trait (or who was): every ERRATIC_EVERY seconds, undo the last shifts and make new ones.
 * @param {Person} p
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateErratic(p, dt) {
  if (p.erraticShift && p.erraticShift.traits !== p.traits) p.erraticShift = null; // (worked out afresh: the shifts went with the old)
  if ((p.erraticIn = (p.erraticIn ?? peopleRng()*ERRATIC_EVERY) - dt) > 0) return;
  p.erraticIn = ERRATIC_EVERY*(0.75 + peopleRng()*0.5);
  undo(p);
  const level = p.traits.erratic ?? 0;
  if (level <= 0) return;
  const picks = 1 + Math.floor(peopleRng()*ERRATIC_MAX_PICKS), share = level/picks, was = {};
  const pool = PUSHABLE.slice();
  for (let k = 0; k < picks && pool.length; k++) {
    const key = pool.splice(Math.floor(peopleRng()*pool.length), 1)[0];
    was[key] = p.traits[key];
    p.traits[key] = push(p.traits[key], key, share, peopleRng() < 0.5);
  }
  p.erraticShift = { traits: p.traits, was };
}
