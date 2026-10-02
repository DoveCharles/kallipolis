import { scramble, keySmash } from '../core/math.js';

// ============================================================ garbled card text
// Anything with the scramble trait has the words on its card jumbled, anything with keysmash has them typed with fat
// fingers (see scramble and keySmash in core/math.js), anything with lowercase has the whole card set in lower case, and
// anything with capitalise has every word on it start with a capital — their name included either way (see `cased`); any
// of them can apply at once. Cards call these on the text they show (person-card.js, car-card.js) — and every love and
// hate through `garbledEntry`, which starts it with a capital by default (see below) — and a speaker's speech bubble is
// cased by `cased` as well (speech-bubbles.js). A mood is never garbled: it's an emoji, which any of them would break.
const SCRAMBLE_STRENGTH = 0.05, KEYSMASH_STRENGTH = 0.15;

/** Whether these traits garble text at all. */
export const garbles = traits => traits.scramble > 0 || traits.keysmash > 0 || traits.lowercase > 0 || traits.capitalise > 0;

/** `text` with its first letter capitalised, if it starts with one — a leading number or quote is left as it is. (A love
 * or hate on a card starts this way, see garbledEntry, and so does a company's name on a building's card: see officeName
 * in buildings/building-types.js.) */
export const capitalised = text => /^[a-z]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;

// Every word's first letter capitalised: words are split on spaces and hyphens, and an opening quote or bracket goes with
// the word it opens — so "flat-pack" reads "Flat-Pack", "don't" stays "Don't", and `"expresso" (hot)` reads `"Expresso" (Hot)`.
// (The capitalise trait's own casing, and what a `[colours: capitalise]` call asks for: see fill in life/speech-text.js.)
export const capitalisedWords = text => text.replace(/(^|[\s(–—\-])(["'(]*)([a-z])/g,
  (all, before, opener, letter) => before + opener + letter.toUpperCase());

/**
 * Text a card shows as it is written — a name, which is never scrambled — cased by the thing's traits: all in lower case
 * with the lowercase trait, every word's first letter raised with capitalise, else untouched. Scramble and keysmash leave
 * a name alone, so these two are the only ones that reach it. Lowercase has the last word, should something carry both.
 * @param {string} text - What's shown.
 * @param {object} traits - The traits the thing has (see core/traits.js).
 * @returns {string} The same text, cased as the traits ask.
 */
/** Fill an element with a line's text, **word** in bold (as the loading tips): the asterisks never shown.
 * @param {HTMLElement} el @param {string} text @returns {void} */
export function setBolded(el, text) {
  el.replaceChildren(...String(text).split('**').map((part, i) => {
    if (!(i % 2)) return part;
    const b = document.createElement('b'); b.textContent = part; return b;
  }));
}

export const cased = (text, traits) => traits.lowercase > 0 ? String(text).toLowerCase()
  : traits.capitalise > 0 ? capitalisedWords(String(text)) : text;

/**
 * Text as it reads on the card of something with these traits.
 * @param {string|number|Array<string|number>|null} text - What's shown; a list is garbled item by item.
 * @param {object} traits - The traits the thing has (see core/traits.js).
 * @param {number} seed - Makes things with the same traits come out differently.
 * @returns {string|Array<string>|null} The same shape it came in as.
 */
export function garbled(text, traits, seed) {
  if (text == null || text === '') return text;
  if (Array.isArray(text)) return text.map(item => garbled(item, traits, seed));
  let said = String(text);
  if (traits.scramble > 0) said = scramble(said, SCRAMBLE_STRENGTH, false, 3, seed, true);
  if (traits.keysmash > 0) said = keySmash(said, KEYSMASH_STRENGTH, false, seed);
  // (last, so the card's casing has the final say over the capital scramble puts back on the first letter)
  return cased(said, traits);
}

/**
 * A love or hate as its card reads it: `garbled`, then starting with a capital by default — "beeeep beeeeeeep" reads
 * "Beeeep beeeeeeep". The casing traits have already had their say by then, so a love or hate of something with either
 * comes back as it asked: all lower, or with every word's first letter raised.
 * @param {string|Array<string>|null} text - The entry, or a list of them.
 * @param {object} traits - The traits the thing has (see core/traits.js).
 * @param {number} seed - Makes things with the same traits come out differently.
 * @returns {string|Array<string>|null} The same shape it came in as.
 */
export function garbledEntry(text, traits, seed) {
  if (Array.isArray(text)) return text.map(item => garbledEntry(item, traits, seed));
  const said = garbled(text, traits, seed);
  if (typeof said !== 'string' || traits.lowercase > 0 || traits.capitalise > 0) return said;
  return capitalised(said);
}
