import { scramble, keySmash } from '../core/math.js';

// ============================================================ garbled card text
// Anything with the scramble trait has the words on its card jumbled, and anything with keysmash has them typed with fat
// fingers (see scramble and keySmash in core/math.js); both can apply at once. Cards call these on the text they show
// (person-card.js, car-card.js). A mood is never garbled: it's an emoji, which either would break.
const SCRAMBLE_STRENGTH = 0.05, KEYSMASH_STRENGTH = 0.15;

/** Whether these traits garble text at all. */
export const garbles = traits => traits.scramble > 0 || traits.keysmash > 0;

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
  return said;
}
