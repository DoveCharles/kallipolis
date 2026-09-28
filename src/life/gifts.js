import { entryOf } from '../core/entries.js';
import { TRAITS, modifierLines } from '../core/traits.js';
import { formatTime } from '../core/math.js';
import { EFFECTS, STATUS_SOURCES, addStatus, restackTraits, statusLines } from './statuseffects.js';
import { cheerierMood, profileOf } from './profiles.js';
import { feel, lastPeopleTime, personModel } from './people/people.js';
import { giveSnack } from './people/peopleHolding.js';

// ============================================================ gifts
// What the Gift button on someone's card can give them (see the Pockets tab in person-card.js), read from
// assets/text/gifts.txt: one gift a line, an emoji and a name, what's special about it after an @, and its {traits}.
//
// A keepsake goes into their pockets (p.pockets, POCKET_SLOTS at most) and stays there, its traits stacked over theirs
// for as long as they carry it just as a status's are (see restackTraits in statuseffects.js) — until it's taken back.
// A consumable is had straight away: a snack from the stalls put in their hand (peopleHolding.js's giveSnack), and/or its
// traits on them for a while, as a status effect of its own (added to EFFECTS as the file loads, its emoji for an icon).
// A gift that `cheer`s lifts a sad or angry mood to a happier one for good (p.moodNow: see cheerierMood in profiles.js).
// A gift they `wear` goes on them (the people model's putOn: sunglasses), and anyone already wearing it starts out
// with one in their pockets (stockPockets).
//
// Being given anything is felt (people.js feel): 'gifted', or 'cheered' where it lifted their mood — for speech's
// {felt = gifted} / {felt = cheered} (see speech-text.js FEELINGS and assets/text/speech/reactions.txt).

const GIFTS_URL = 'assets/text/gifts.txt';
export const POCKET_SLOTS = 6;
const SNACK_ITEMS = ['coffee', 'beer', 'hotdog'];
const TIME = /^(\d*\.?\d+)(s|m|h)$/i, SECONDS = { s: 1, m: 60, h: 3600 };

/**
 * Every gift there is, in the file's order: { emoji, name, kind: 'keepsake'|'consumable', traits: [[trait, value]],
 * seconds, snack, cheer, wear, status } — `status` the key of a consumable's own status effect in EFFECTS.
 * @type {object[]}
 */
export const GIFTS = [];
let loaded = false;
const listeners = [];
/** Call `listener` once gifts.txt has loaded (straight away if it has). */
export function onGiftsLoaded(listener) { if (loaded) listener(); else listeners.push(listener); }
export const giftsLoaded = () => loaded;

const warned = new Set();
const warnOnce = message => { if (!warned.has(message)) { warned.add(message); console.warn(message); } };

// One line of the file as a gift, or null if it isn't one.
function giftOf(line, kind) {
  const entry = entryOf(line, { traits: TRAITS, file: 'gifts.txt' });
  const [head, tail = ''] = entry.text.split(/\s+@\s*/);
  const space = head.search(/\s/);
  if (space < 0) { warnOnce(`Kallipolis: in gifts.txt, "${line}" needs an emoji and then a name`); return null; }
  const gift = { emoji: head.slice(0, space), name: head.slice(space).trim(), kind, traits: entry.traits,
    seconds: null, snack: null, cheer: false, wear: null, status: null };
  tail.split(/[\s,]+/).filter(Boolean).forEach(word => {
    const time = word.match(TIME), lower = word.toLowerCase();
    if (time) gift.seconds = parseFloat(time[1])*SECONDS[time[2].toLowerCase()];
    else if (SNACK_ITEMS.includes(lower)) gift.snack = lower;
    else if (lower === 'cheer') gift.cheer = true;
    else if (lower.startsWith('wear=')) gift.wear = word.slice(5);
    else warnOnce(`Kallipolis: in gifts.txt, "${word}" (after "${gift.name}") isn't something a gift can be — see the notes at its top`);
  });
  // a consumable with traits and a time has them as a status effect of its own
  if (kind === 'consumable' && gift.seconds && gift.traits.length) {
    gift.status = 'gift: ' + gift.name.toLowerCase();
    EFFECTS[gift.status] = { name: gift.name, emoji: gift.emoji, seconds: gift.seconds, traits: gift.traits };
  }
  return gift;
}

fetch(GIFTS_URL)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .then(text => {
    let kind = null;
    text.split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const heading = line.match(/^\[([^[\]]+)\]$/);
      if (heading) { const name = heading[1].trim().toLowerCase(); kind = name === 'keepsakes' ? 'keepsake' : name === 'consumables' ? 'consumable' : null; return; }
      if (!kind) return;
      const gift = giftOf(line, kind);
      if (gift) GIFTS.push(gift);
    });
  })
  .catch(err => console.warn(`Kallipolis: ${GIFTS_URL} failed to load; there's nothing to give`, err))
  .finally(() => { loaded = true; listeners.splice(0).forEach(listener => listener()); });

/**
 * What a gift does, for its tip in the Gift window or on the Pockets tab: its name, its trait lines as a love's or hate's
 * are listed (modifierLines) — a coffee's or a pint's those of the status it leaves as it goes down — and what else it does.
 * @param {object} gift - one of GIFTS
 * @returns {{name: string, traits: string[], notes: string[]}} the tip
 */
export function giftLines(gift) {
  const traits = [], notes = [];
  const leaves = gift.snack && STATUS_SOURCES[gift.snack];
  if (leaves) {
    traits.push(...statusLines(leaves.status, leaves.seconds).slice(1, -1));
    notes.push(`${EFFECTS[leaves.status].name} for ${formatTime(leaves.seconds)}`);
  }
  traits.push(...modifierLines(gift.traits));
  if (gift.cheer) notes.push('Cheers up a sad or angry mood');
  if (gift.wear) notes.push('They put them on');
  if (gift.kind === 'keepsake') notes.push('Kept in their pockets');
  else if (gift.seconds && gift.traits.length) notes.push(`Lasts ${formatTime(gift.seconds)}`);
  return { name: gift.name, traits, notes };
}

/** Whether someone's pockets have room for another keepsake. */
export const pocketsFull = p => (p?.pockets?.length ?? 0) >= POCKET_SLOTS;

/**
 * Give someone a gift: into their pockets, or had there and then (see the top of this file).
 * @param {Person} p - who it's for
 * @param {number} i - their place in the crowd (for what they wear)
 * @param {object} gift - one of GIFTS
 * @returns {{given: boolean, cheered: boolean}} whether it was given (not with full pockets, or to the dead), and
 *   whether it lifted their mood
 */
export function giveGift(p, i, gift) {
  if (!p || p.mode === 'dead') return { given: false, cheered: false };
  const now = lastPeopleTime ?? 0;
  if (gift.kind === 'keepsake') {
    if (pocketsFull(p)) return { given: false, cheered: false };
    (p.pockets ??= []).push(gift);
    if (gift.wear && personModel) {
      const before = personModel.putOn(i, gift.wear);
      // (what they had on before, for when the last of them is taken back — unless they had these on already)
      if (before !== undefined && before !== gift.wear && !(gift.wear in (p.woreBefore ??= {}))) p.woreBefore[gift.wear] = before;
    }
    restackTraits(p);
  } else {
    if (gift.snack) giveSnack(p, gift.snack);
    if (gift.status) addStatus(p, gift.status, gift.seconds, now);
  }
  let cheered = false;
  if (gift.cheer) {
    const lifted = cheerierMood(profileOf(p.id, p.isMan, p.moodNow).mood);
    if (lifted) { p.moodNow = lifted.text; p.traitsKey = ''; cheered = true; } // (their traits worked out again: see refreshTraits)
  }
  feel(p, cheered ? 'cheered' : 'gifted');
  return { given: true, cheered };
}

/**
 * Take a keepsake back out of someone's pockets, and its traits off them — and, if it was the last of something they
 * wear, it off them too, back to whatever they had on before.
 * @param {Person} p - the person
 * @param {number} i - their place in the crowd
 * @param {number} slot - which pocket
 * @returns {?object} the gift taken, or null
 */
export function takeBack(p, i, slot) {
  const gift = p?.pockets?.[slot];
  if (!gift) return null;
  p.pockets.splice(slot, 1);
  if (gift.wear && personModel && !p.pockets.some(other => other.wear === gift.wear)) {
    personModel.takeOff(i, gift.wear, p.woreBefore?.[gift.wear] ?? null);
    if (p.woreBefore) delete p.woreBefore[gift.wear];
  }
  restackTraits(p);
  return gift;
}

/**
 * What someone has on them already when they're first seen: one of every keepsake they're wearing (the sunglasses on
 * their face are in their pockets too). Once each, when the people model and gifts.txt are both in (each frame from
 * updatePeople in people.js until then).
 * @param {Person} p - the person
 * @param {number} i - their place in the crowd
 * @returns {void}
 */
export function stockPockets(p, i) {
  if (p.pocketsStocked || !personModel || !loaded) return;
  p.pocketsStocked = true;
  const worn = GIFTS.filter(gift => gift.kind === 'keepsake' && gift.wear && personModel.wears(i, gift.wear));
  if (!worn.length) return;
  p.pockets ??= [];
  worn.forEach(gift => { if (!pocketsFull(p)) p.pockets.push(gift); });
  restackTraits(p);
}
