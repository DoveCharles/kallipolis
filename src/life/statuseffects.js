// ============================================================ status effects
// Something that's on a person for a while and changes what they're like while it lasts: a coffee's pick-me-up, a
// painkiller taking the edge off, a pint wearing off, a state of mind. Every effect there is lives in EFFECTS, with its
// icon (assets/icons/status/<icon>.png), the traits it moves, and how long it lasts by default; the things that hand one
// out name it and their own length in STATUS_SOURCES below — a coffee's sip, a pill swallowed, a bite of something that
// didn't agree with them. The person's card shows one icon per status they're under, on the right of their picture, and a
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
import { formatTime } from '../core/math.js';

/**
 * Every status effect there is, by key. `icon` is the file it's drawn from in assets/icons/status/. `traits` are what it
 * does while it lasts, written as the same `{ trait = value }` an entry in a .txt file carries (see core/traits.js), so
 * they stack on top of someone's own traits rather than replacing them. `seconds` is how long it lasts when the thing
 * that gives it doesn't say. `blurb`, if given, is one more line under its name in the tooltip — for what the traits
 * can't say on their own.
 *
 * Keys are lower case, and are what a source names: see STATUS_SOURCES, and addStatus below.
 * @type {Object<string, {name: string, icon: string, seconds: number, traits: Object, blurb?: string}>}
 */
export const EFFECTS = {
  caffeinated: {
    name: 'Caffeinated',
    icon: 'coffeel',
    seconds: 180, // (three minutes: a cup from the coffee stall, sipped as they walk — see peopleHolding.js)
    traits: { speed: 1.3, chatty: 1.5 },
  },
  drunk: {
    name: 'Drunk',
    icon: 'thedrink',
    seconds: 600, // (ten minutes: a pint from the beer stall, sipped as they walk — see peopleHolding.js)
    // (the `drunk` trait is the one life/people/peopleDrunk.js reads: it weaves them as they walk and has them fall over
    // now and then, which is what a pint does once they've a few in them anyway — see TIPSY and DRUNK there)
    traits: { drunk: 1 },
    blurb: 'Unsteady on their feet',
  },
};

/**
 * What something a person comes by leaves on them, and for how long — a coffee, a pill, a pint, a night's sleep: one row
 * per source, naming the effect and the length that source gives it. Kept apart from EFFECTS (where the same effect's
 * default length sits) so one effect can come from several sources at several lengths, each as long as that source
 * should be — a strong coffee being the same caffeinated status for longer — and so a source can be anything at all.
 *
 * A source's own key is just its name: `STATUS_SOURCES.coffee`, and see peopleHolding.js's snackClip, which looks a
 * snack up here as it's finished off.
 * @type {Object<string, {status: string, seconds: number}>}
 */
export const STATUS_SOURCES = {
  coffee: { status: 'caffeinated', seconds: EFFECTS.caffeinated.seconds },
  beer: { status: 'drunk', seconds: EFFECTS.drunk.seconds },
};

/** The status effects a person is under, in the order they were put on them. */
export const statusesOf = p => (p?.status ?? []).map(entry => EFFECTS[entry.key]).filter(Boolean);

/**
 * What `effects` say between them, as `[trait, values]` pairs an entry can be built from (see combineTraits in
 * core/entries.js): one pair per trait, holding every amount that applies to it, in the order they were put on.
 * @param {Array<?{traits: Object}>} effects - the status effects
 * @returns {Array<[string, number[]]>} the pairs
 */
function traitList(effects) {
  const byTrait = new Map();
  for (const effect of effects) {
    for (const [key, value] of Object.entries(effect?.traits ?? {})) {
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
    value = combine === 'add' ? value + amount : combine === 'on' ? (amount > 0 ? 1 : value) : value*amount;
    value = Math.max(min, Math.min(max, value));
  }
  return value;
}

/** Put someone's own traits and every status they're under together into p.traits (see applyStatusTraits). */
function restack(p) {
  p.baseTraits ??= { ...p.traits };
  p.traits = applyStatusTraits(p.baseTraits, statusesOf(p));
}

/**
 * Put a status effect on someone. Its length is the source's own where it gives one (`seconds`), else the effect's
 * default. Someone already under it has its clock set to that length again — so a second cup of coffee is another three
 * minutes, not three more on the end — unless what's left of it is longer already, which is left alone (a sip of coffee
 * doesn't shorten something longer-acting, and a shorter-lived source never cuts a longer one short).
 * @param {Person} p - the person
 * @param {string} key - which effect (a key of EFFECTS)
 * @param {number} [seconds] - how long it lasts, in seconds
 * @param {number} [now] - the running people time it starts from (see updatePeople in people/people.js)
 * @returns {?object} the status they're under, or null if there's no such effect
 */
export function addStatus(p, key, seconds = null, now = 0) {
  const effect = EFFECTS[key];
  if (!effect) { console.warn(`Kallipolis: there's no status effect "${key}" — see life/statuseffects.js`); return null; }
  if (!p) return null;
  const length = seconds ?? effect.seconds, until = now + length;
  const had = (p.status ??= []).find(entry => entry.key === key);
  if (had) {
    if (until > had.until) { had.until = until; had.seconds = length; had.since = now; }
    return had;
  }
  const status = { key, since: now, until, seconds: length };
  p.status.push(status);
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
    const left = p.status.filter(entry => entry.until > now);
    if (left.length === p.status.length) continue;
    p.status = left;
    restack(p);
  }
}

/**
 * A status effect as lines for the menu its icon opens on a card (see setEffects in ui/entity-card.js): its name, what
 * it's doing to them, and how long it has to run — the same wording a love's or hate's modifiers are listed in.
 *
 * The time is the last line, as the largest unit that says anything about it and the one below it — "3m 19s", "5hr 14m"
 * (see formatTime in core/math.js). Which length is used is up to the caller: the effect's default where only the effect
 * is known (what it *would* last), the person's own where it came from a source that gives its own, or what's left of it
 * — the two are one and the same where the status has just gone on, and only `remaining` makes a tick-by-tick countdown
 * possible, since the lines can then be put together again as the clock runs without anything having to change about the
 * status itself.
 * @param {string} key - which effect
 * @param {?number} [seconds] - how long it was given, where that's known (see addStatus)
 * @param {?number} [remaining] - how long it has left, if that's the number worth saying
 * @returns {string[]} the lines, the first its name; empty if there's no such effect
 */
export function statusLines(key, seconds = null, remaining = null) {
  const effect = EFFECTS[key];
  if (!effect) return [];
  return [effect.name, ...modifierLines(traitList([effect])), ...(effect.blurb ? [effect.blurb] : []),
    formatTime(remaining ?? seconds ?? effect.seconds)];
}
