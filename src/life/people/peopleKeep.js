import { S } from '../../core/shared.js';
import { people, personModel } from './people.js';
import { isFavoritePerson } from '../../ui/favorites.js';
import { profileOf, pinProfile } from '../profiles.js';

// ============================================================ the crowd kept between sessions
// Who's in the crowd, in slot order, saved as { v, people: [{ id, moodNow?, at?, kept? }] } — `at` where they were
// ([x, y, z, heading]: put back there, on the nearest walkway or in the hangout it's in — see placeKept in people.js) (project/autosave.js keeps it
// under its own key; a saved project file carries it as `crowd`). The dead aren't in it, so they never come back. Each
// is otherwise re-made from their id. The hearted also carry `kept`: their profile and look as they were (see lookOf in
// peopleModel.js), so list or model updates that would change what their id rolls don't change them.

let waiting = []; // saved people not yet back in the crowd, in slot order (see nextKept)
let reset = false; // a crowd's come in: clear the current one first (see takeReset)
const pinnedLooks = new Map(); // id → kept look
export const pinnedLookOf = id => pinnedLooks.get(id);

const alive = p => p.mode !== 'dead' || p.benched || isFavoritePerson(p.id) || !!p.punched?.revive;
const round = v => Math.round(v*100)/100;

/** The next saved person to put back in the crowd, or null. @param {Set<number>} present - ids already in it */
export function nextKept(present) {
  while (waiting.length) { const kp = waiting.shift(); if (!present.has(kp.id)) return kp; }
  return null;
}
/** Saved person `id` taken out of the queue (a hearted one wanted now), or just { id }. */
export function takeKept(id) {
  const at = waiting.findIndex(kp => kp.id === id);
  return at < 0 ? { id } : waiting.splice(at, 1)[0];
}
/** Whether the current crowd should be cleared for one that's come in (once). */
export const takeReset = () => { const r = reset; reset = false; return r; };

function keptOf(p, i) {
  if (p.miniOf) return null;
  const isMan = personModel ? personModel.isMan[i] === 1 : null;
  const { traits, ...profile } = profileOf(p.id, isMan, p.moodNow);
  const look = personModel?.lookOf(i) ?? pinnedLooks.get(p.id) ?? null;
  return { moodNow: p.moodNow ?? null, profile: { ...profile, traits }, look };
}

export function serializeCrowd() {
  const list = [];
  people.forEach((p, i) => {
    if (p.miniOf || !alive(p)) return;
    const entry = { id: p.id };
    if (p.moodNow != null) entry.moodNow = p.moodNow;
    if (!p.benched && p.mode !== 'none' && p.mode !== 'dead' && [p.x, p.y, p.z, p.heading].every(Number.isFinite)) entry.at = [round(p.x), round(p.y), round(p.z), round(p.heading)];
    if (isFavoritePerson(p.id)) { const kept = keptOf(p, i); if (kept) entry.kept = kept; }
    list.push(entry);
  });
  waiting.forEach(kp => list.push(kp.kept && !isFavoritePerson(kp.id) ? { ...kp, kept: undefined } : kp));
  return { v: 1, people: list };
}

/** Put back a saved crowd (null: leave the current one). */
export function restoreCrowd(data) {
  if (!data || !Array.isArray(data.people)) { waiting = []; reset = true; return; } // (none saved: a fresh crowd, not this city's left standing in the new one)
  const seen = new Set();
  waiting = data.people.filter(kp => Number.isInteger(kp?.id) && kp.id > 0 && !seen.has(kp.id) && seen.add(kp.id));
  waiting.forEach(kp => {
    if (!kp.kept) return;
    pinProfile(kp.id, kp.kept);
    if (kp.kept.look) pinnedLooks.set(kp.id, kp.kept.look);
  });
  S.peopleIdSeq = Math.max(S.peopleIdSeq, ...waiting.map(kp => kp.id + 1));
  reset = true;
}
