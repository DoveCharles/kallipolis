import { App } from '../core/shared.js';

// ============================================================ progress
// What a city's earned and spent — energy, money, morality points, the daily gift, identified traits, paid-for
// possession time — kept with its project (serializeProject's `progress`), not the browser, so each file has its own.
// Each part keeps its own state, read with getProgress and written with setProgress (which schedules an autosave), and
// hears a project's coming in through onProgress: given its saved value, or undefined to start fresh. Undo never
// touches it (see history.js).
//
// From before this, the browser's localStorage held one lot for every project: the first project loaded that has none
// of its own takes that over (once: MIGRATED_KEY), so nobody loses theirs.
const store = {};
const listeners = new Map(); // key → (value) => void
const LEGACY = {
  energy: ['kallipolis.energy', JSON.parse],
  money: ['kallipolis.money', Number],
  dailyGift: [['kallipolis.dailyGiftDay', 'kallipolis.dailyGiftSpin'], ([day, spin]) => ({ claimed: day, spun: spin ? JSON.parse(spin) : null })],
  moralityPoints: ['kallipolis.moralityPoints', JSON.parse],
  traitsKnown: ['kallipolis.traitsKnown', JSON.parse],
  possessPaid: ['kallipolis.possessPaidUntil', JSON.parse],
};
const MIGRATED_KEY = 'kallipolis.progressMigrated';

/** @param {string} key @returns {*} its saved value, or undefined */
export const getProgress = key => store[key];
/** @param {string} key @param {*} value - JSON-able @returns {void} */
export function setProgress(key, value) {
  store[key] = value;
  App.scheduleSave?.(1500);
}
/** @param {string} key @param {(value: *) => void} fn - called with the value a project brings (undefined: fresh) */
export function onProgress(key, fn) { listeners.set(key, fn); }
/** Everything, for a saved project. @returns {object} */
export const progressData = () => JSON.parse(JSON.stringify(store));

/**
 * A project's progress coming in (or, `data` undefined, one with none: the old browser-wide lot, the first time, else fresh).
 * @param {?object} data
 * @returns {void}
 */
export function loadProgress(data) {
  if (data == null) data = migrateLegacy() ?? {};
  Object.keys(store).forEach(key => delete store[key]);
  Object.assign(store, JSON.parse(JSON.stringify(data)));
  listeners.forEach((fn, key) => fn(store[key]));
}

function migrateLegacy() {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return null;
    localStorage.setItem(MIGRATED_KEY, '1');
    const out = {};
    Object.entries(LEGACY).forEach(([key, [names, read]]) => {
      const raw = Array.isArray(names) ? names.map(n => localStorage.getItem(n)) : localStorage.getItem(names);
      if (Array.isArray(raw) ? raw[0] == null : raw == null) return;
      try { out[key] = read(raw); } catch { /* (unreadable: left fresh) */ }
    });
    return out;
  } catch { return null; }
}
