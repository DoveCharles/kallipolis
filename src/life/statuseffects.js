// ============================================================ status effects
// Something that's on a person for a while and changes what they're like while it lasts: a coffee's pick-me-up, a
// painkiller taking the edge off, a pint wearing off, a state of mind. Every effect there is lives in EFFECTS, with its
// icon (assets/icons/status/<icon>.png), the traits it moves, and how long it lasts by default; the things that hand one
// out name it and their own length in STATUS_SOURCES below — a coffee's sip, a pill swallowed, a bite of something that
// didn't agree with them. The person's card shows one icon per status they're under, on the left of their picture, and a
// click on one opens what it's doing to them, in the same little menu a love's or hate's modifiers open in (see setEffects
// in ui/entity-card.js).
//
// A status doesn't change who someone is: what they were picked out as in people/*.txt stays on p.baseTraits, and p.traits
// is that with every status stacked over it (see applyStatusTraits). The traits stack exactly as an entry's do in
// core/entries.js (a multiplier multiplies, an amount adds, a switch turns on) and are kept to each trait's range
// (core/traits.js) as they go, so a status can never take someone outside what a trait is allowed to be. refreshTraits in
// people/people.js picks both again whenever people/*.txt loads.
//
// The clock is the running people time the caller passes in (`now`, from updatePeople in people/people.js), so this file
// needs nothing of the renderer or the crowd to work out what a status does.
//
// What a trait then does is up to whoever reads it: `speed` in updatePeople (people/people.js) and `chatty` in startChat
// (people/peopleActivities.js), so caffeinated is a brisk, talkative three minutes.
import { TRAITS, modifierLines } from '../core/traits.js';
import { combineTraits } from '../core/entries.js';

/**
 * Every status effect there is, by key. `icon` is the file it's drawn from in assets/icons/status/. `traits` are what it
 * does while it lasts, written as the same `{ trait = value }` an entry in a .txt file carries (see core/traits.js), so
 * they stack on top of someone's own traits rather than replacing them. `seconds` is how long it lasts when the thing
 * that gives it doesn't say.
 *
 * `levels`, if given, is how high it goes: at level L an amount is L times level 1's and a multiplier is
 * raised to the power L (see effectOf), kept to the trait's range.
 * Keys are lower case, and are what a gift (assets/text/gifts.txt, `key:level` after its @) names.
 * @type {Object<string, {name: string, icon: string, seconds: number, traits: Object, levels?: number}>}
 */
export const EFFECTS = {
  caffeinated: {
    name: 'Caffeinated', icon: 'coffeel', seconds: 180, levels: 3,
    traits: { speed: 1.5, chatty: 1.5, fidgety: 2 },
  },
  drunk: {
    name: 'Drunk', icon: 'thedrink', seconds: 600, levels: 3,
    // (the `drunk` trait, 0-1 and added up, is what life/people/peopleDrunk.js reads: 0.5 weaves them and has them fall over)
    traits: { drunk: 0.3, chatty: 3, talkative: 2, alcoholic: 4, aggression: 2 },
  },
  full: { name: 'Full', icon: 'hotdog', seconds: 120, traits: { mood: 0.2, happy: 0.2 } },
  comforted: { name: 'Comforted', icon: 'choc', seconds: 180, traits: { sad: -0.5, mood: 0.3, happy: 0.3 } },
  treated: { name: 'Treated', icon: 'icecream', seconds: 180, traits: { happy: 0.4, mood: 0.3 } },
  sugarrush: { name: 'Sugar rush', icon: 'sweetie', seconds: 60, traits: { speed: 1.2, fidgety: 3 } },
  wired: { name: 'Wired', icon: 'energydrink', seconds: 180, traits: { speed: 2, fidgety: 4, blinks: 0.3, aggression: 2 } },
  blazed: { name: 'Blazed', icon: 'leafl', seconds: 600, traits: { blazed: 1, speed: 0.6, lounging: 5, patience: 4, chatty: 2, aggression: 0.3 } },
  buzzing: { name: 'Buzzing', icon: 'adderall', seconds: 300, traits: { speed: 3, chatty: 6, talkative: 6, blinks: 5, mood: 0.5, fidgety: 12, happy: 0.9, aggression: 10, erratic: 0.3 } },
  backwards: { name: 'Backwards', icon: 'magicbroth', seconds: 60, traits: { backwards: 1 } },
  // (shown only, while bloodlusting: its traits are the bloodlust trait's own — see person-card.js statusListFor)
  bloodlust: { name: 'Bloodlust', icon: 'bloodlustt', seconds: 0, traits: {} },
};

/** How much of the time a top-up overlaps turns into overflow, a level above the dose (see addStatus). */
const OVERFILL = 0.25;

/** How many levels an effect has. */
export const tiersOf = key => EFFECTS[key]?.levels ?? 1;
/** An effect at a level (1 up, kept to its levels): its traits scaled by the level. */
export function effectOf(key, level = 1) {
  const effect = EFFECTS[key];
  if (!effect) return null;
  level = Math.max(1, Math.min(tiersOf(key), level));
  if (level === 1) return effect;
  const traits = Object.fromEntries(Object.entries(effect.traits ?? {}).map(([k, v]) => {
    const combine = TRAITS[k]?.combine;
    return [k, combine === 'add' ? v*level : combine === 'on' || combine === 'set' ? v : v**level];
  }));
  return { ...effect, traits };
}

/**
 * What a snack (coffee, beer, hotdog) leaves on them each mouthful: filled from the gift that hands it over in
 * assets/text/gifts.txt (life/gifts.js), so peopleHolding.js's snackClip treats one bought from a stall the same.
 * @type {Object<string, Array<{status: string, level: number, seconds: number}>>}
 */
export const STATUS_SOURCES = {};

/** The status effects a person is under, in the order they were put on them. */
export const statusesOf = p => (p?.status ?? []).map(entry => effectOf(entry.key, entry.level)).filter(Boolean);

/**
 * What `effects` say between them, as `[trait, values]` pairs an entry can be built from (see combineTraits in
 * core/entries.js): one pair per trait, holding every amount that applies to it, in the order they were put on.
 * @param {Array<?{traits: Object}>} effects - the status effects
 * @returns {Array<[string, number[]]>} the pairs
 */
function traitList(effects) {
  const byTrait = new Map();
  for (const effect of effects) {
    // (an effect's traits are { trait: value }; a gift's are the [trait, value] pairs its line was read into — see gifts.js)
    const pairs = Array.isArray(effect?.traits) ? effect.traits : Object.entries(effect?.traits ?? {});
    for (const [key, value] of pairs) {
      if (!TRAITS[key] || !Number.isFinite(value)) continue; // (a mistyped trait in an effect is ignored, as it is in a file)
      if (!byTrait.has(key)) byTrait.set(key, []);
      byTrait.get(key).push(value);
    }
  }
  return [...byTrait];
}

/**
 * Someone's traits with `effects` stacked over their own, kept to each trait's range (see core/traits.js).
 * @param {Object} baseTraits - who they are, before any status
 * @param {Array<?object>} effects - the status effects they're under
 * @returns {Object} their traits as they are just now
 */
export function applyStatusTraits(baseTraits, effects) {
  const pairs = traitList(effects);
  if (!pairs.length) return { ...baseTraits };
  const traits = combineTraits([{ traits: pairs }], TRAITS, baseTraits);
  // (what a status moves is what the stack came to, clamped to the trait's range; a trait no status moves is left exactly
  // as it was, even if it starts out past its own range: see combineTraits and traitLines)
  pairs.forEach(([key, values]) => { traits[key] = stackTrait(key, values, baseTraits); });
  return traits;
}
/** One trait with every amount that applies to it — `[key, values]` out of traitList — stacked and kept to its range. */
function stackTrait(key, values, baseTraits) {
  const { min, max } = TRAITS[key];
  let value = baseTraits[key];
  for (const amount of values) {
    const { combine } = TRAITS[key];
    value = combine === 'add' ? value + amount : combine === 'on' ? (amount > 0 ? 1 : value) : combine === 'set' ? amount : value*amount;
    value = Math.max(min, Math.min(max, value));
  }
  return value;
}

/**
 * Put someone's own traits, the keepsakes in their pockets and every status they're under together into p.traits (see
 * applyStatusTraits): a keepsake stacks just as a status does, for as long as they carry it (see life/gifts.js).
 * @param {Person} p - the person
 * @returns {void}
 */
export function restackTraits(p) {
  p.baseTraits ??= { ...p.traits };
  p.traits = applyStatusTraits(p.baseTraits, [...(p.pockets ?? []), ...statusesOf(p)]);
}
const restack = restackTraits;

/**
 * Put a status effect on someone, for `seconds` (else the effect's default) at `level`. A status is a run of stages,
 * highest level first ({level, until}). Topping one up, over the dose's own length from now (its window): each moment
 * runs at the higher of what was there and the dose; the time the dose overlaps what was there, ×OVERFILL, turns window
 * time below the dose's level + 1 up to it, lowest first (never adding time; any with nothing left to turn up is lost);
 * what ran past the window stays. So the status is as long as the longer of the two. Levels are kept to the effect's.
 * @param {Person} p - the person
 * @param {string} key - which effect (a key of EFFECTS)
 * @param {number} [seconds] - how long it lasts, in seconds
 * @param {number} [now] - the running people time it starts from (see updatePeople in people/people.js)
 * @param {number} [level] - which level (1 up)
 * @returns {?object} the status they're under, or null if there's no such effect
 */
export function addStatus(p, key, seconds = null, now = 0, level = 1) {
  const effect = EFFECTS[key];
  if (!effect) { console.warn(`Kallipolis: there's no status effect "${key}" — see life/statuseffects.js`); return null; }
  if (!p) return null;
  const top = tiersOf(key), clampLevel = l => Math.max(1, Math.min(top, l));
  const length = seconds ?? effect.seconds, dose = clampLevel(level), over = clampLevel(dose + 1);
  const had = (p.status ??= []).find(entry => entry.key === key);
  // (what was there, as spans from now)
  let from = 0;
  const old = (had?.stages ?? []).map(stage => { const span = { level: stage.level, start: from, end: Math.max(from, stage.until - now) }; from = span.end; return span; });
  const window = [], past = [];
  let overlap = 0;
  for (const span of old) {
    if (span.start < length) {
      const len = Math.min(span.end, length) - span.start;
      window.push({ level: Math.max(span.level, dose), len });
      overlap += len;
    }
    if (span.end > length) past.push({ level: span.level, len: span.end - Math.max(span.start, length) });
  }
  if (from < length) window.push({ level: dose, len: length - from });
  // (the overflow, turning window time up, lowest first)
  let overflow = overlap*OVERFILL;
  for (const piece of [...window].sort((x, y) => x.level - y.level)) {
    if (overflow <= 0 || piece.level >= over) break;
    const turned = Math.min(piece.len, overflow);
    piece.len -= turned;
    overflow -= turned;
    window.push({ level: over, len: turned });
  }
  const pieces = [...window, ...past].filter(piece => piece.len > 0).sort((x, y) => y.level - x.level);
  const stages = [];
  let at = now;
  for (const piece of pieces) {
    at += piece.len;
    const last = stages[stages.length - 1];
    if (last?.level === piece.level) last.until = at; else stages.push({ level: piece.level, until: at });
  }
  const status = had ?? { key };
  Object.assign(status, { stages, level: stages[0].level, until: at, since: now, seconds: at - now });
  if (!had) p.status.push(status);
  restack(p);
  return status;
}

/**
 * Take a status effect off someone before its time runs out (a cure, an antidote).
 * @param {Person} p - the person
 * @param {string} key - which effect
 * @returns {void}
 */
export function removeStatus(p, key) {
  if (!p?.status?.length) return;
  const left = p.status.filter(entry => entry.key !== key);
  if (left.length === p.status.length) return;
  p.status = left;
  restack(p);
}

/** Whether someone is under a status effect just now. */
export const hasStatus = (p, key) => !!p?.status?.some(entry => entry.key === key);

/**
 * Run down everyone's status effects, putting their traits back when one ends. Called each frame by updatePeople in
 * people/people.js, before anything reads a trait.
 * @param {Person[]} people - the crowd
 * @param {number} now - the running people time (see updatePeople)
 * @returns {void}
 */
export function updateStatusEffects(people, now) {
  for (const p of people) {
    if (!p.status?.length) continue;
    let changed = false;
    for (const entry of p.status) {
      while (entry.stages.length > 1 && entry.stages[0].until <= now) { entry.stages.shift(); entry.level = entry.stages[0].level; changed = true; }
    }
    const left = p.status.filter(entry => entry.until > now);
    if (left.length === p.status.length && !changed) continue;
    p.status = left;
    restack(p);
  }
}

/**
 * A status effect as lines for the tip its icon opens on a card (see setEffects in ui/entity-card.js), or a gift's: its
 * name and what it does at `level`, worded as a love's or hate's modifiers are. (Its time is the tip's meter.)
 * @param {string} key - which effect
 * @param {number} [level] - which level
 * @returns {string[]} the lines, the first its name; empty if there's no such effect
 */
export function statusLines(key, level = 1) {
  const effect = effectOf(key, level);
  return effect ? [effect.name, ...modifierLines(traitList([effect]))] : [];
}
