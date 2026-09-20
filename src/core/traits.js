// Every trait an entry in any .txt file can carry, as [trait = value] (see core/entries.js). All kinds of thing share this
// table; a trait only has an effect where code reads it, so a car can carry `aggression` without anything happening until
// car code uses it. A name missing from here is treated as a typo and ignored with a console warning.
// Fields: `base` the starting value, `min`/`max` the range it is kept to, `combine` how entries stack — omitted multiplies,
// 'add' adds, 'on' switches on if any entry sets it. People's starting values can be overridden by the trait table at the top
// of assets/people.txt.
export const TRAITS = {
  // people (see life/people/)
  speed: { base: 1, min: 0.1, max: 6 },
  size:      { base: 1, min: 0.3, max: 3 },
  chatty:    { base: 1, min: 0, max: 10 },
  talkative: { base: 1, min: 0.05, max: 20 },
  lounging:  { base: 1, min: 0, max: 10 },
  patience:  { base: 1, min: 0.1, max: 10 },
  fidgety:   { base: 1, min: 0, max: 20 },
  nosy:      { base: 1, min: 0.05, max: 10 },
  blinks:    { base: 1, min: 0, max: 20 },
  parks:     { base: 1, min: 0, max: 8 },
  plazas:    { base: 1, min: 0, max: 8 },
  roadsafety:{ base: 1, min: 0.2, max: 3 },
  mood:      { base: 0, min: -1, max: 1, combine: 'add' },
  happy:     { base: 0, min: 0, max: 1, combine: 'add' },
  sad:       { base: 0, min: 0, max: 1, combine: 'add' },
  angry:     { base: 0, min: 0, max: 1, combine: 'add' },
  shock:     { base: 0, min: 0, max: 1, combine: 'add' },
  backwards: { base: 0, min: 0, max: 1, combine: 'on' },
  evil:      { base: 0, min: -1, max: 1, combine: 'add' },
  aggression:{ base: 1, min: 0, max: 100 },
  agemult:   { base: 1, min: 0.1, max: 1000 }, // no upper limit in practice, for vampiric / immortal types
  ageless:   { base: 0, min: 0, max: 1, combine: 'on' },
  nickname:  { base: 0, min: 0, max: 1, combine: 'on' },
  bleach:    { base: 0, min: 0, max: 1, combine: 'on' },
  // any kind
  solo:      { base: 0, min: 0, max: 1, combine: 'on' }, // on a love or hate: the only one of its kind that thing has (see addEntries)
};

/**
 * The traits that make something what it is rather than one of the crowd: the ones sitting away from their starting
 * value, as lines a card can list ("Aggression 5"). The table's order is kept, so a card reads the same way every time.
 * @param {object} traits - the traits, as core/type-text.js and profiles.js hand them over
 * @param {object} [table] - the trait table to judge them against
 * @returns {string[]} one line per trait that isn't at its starting value
 */
export function traitLines(traits, table = TRAITS) {
  return Object.entries(table)
    .filter(([key, trait]) => traits[key] !== undefined && traits[key] !== trait.base)
    .map(([key, trait]) => {
      const value = Math.round(traits[key]*100)/100;
      return `${key[0].toUpperCase()}${key.slice(1)} ${value}`;
    });
}
