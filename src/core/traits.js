// Every trait an entry in any .txt file can carry, as [trait = value] (see core/entries.js). All kinds of thing share this
// table; a trait only has an effect where code reads it, so a car can carry `aggression` without anything happening until
// car code uses it. A name missing from here is treated as a typo and ignored with a console warning.
// Fields: `base` the starting value, `min`/`max` the range it is kept to, `combine` how entries stack — omitted multiplies,
// 'add' adds, 'on' switches on if any entry sets it. `hidden` keeps it out of a card's modifier drop-downs (see modifierLines). People's starting values can be overridden by the trait table at the top
// of assets/text/people/about.txt.
export const TRAITS = {
  // people (see life/people/)
  speed: { base: 1, min: 0.1, max: 6 },
  boost:     { base: 1, min: 0.1, max: 6 }, // multiplies the boost of running (people); for cars, scales what boosting adds (see boostMultiplier in life/traffic/driving.js)
  braking:   { base: 1, min: 0.1, max: 6 }, // multiplies how hard a car brakes
  control:   { base: 1, min: 0.1, max: 6 }, // multiplies how sharply a driven car steers; the lower, the harder it pulls to one side on its own (see driftTurn in life/traffic/driving.js)
  weight:    { base: 1, min: 0.1, max: 10 }, // how much a car crashing into it slows down: see slowedBy in life/traffic/collisions.js
  recovery:   { base: 1, min: 0.1, max: 10}, //how fast a car recovers from a burnt out engine, how likely they are to burn out
  health:    { base: 1, min: 0.01, max: 10}, //health multiplier
  maxboost:  { base: 1, min: 0.01, max: 10 }, // how many seconds of boost a car holds: multiplies BOOST_MAX_BASE (see boostMax in life/traffic/driving.js)
  recharge:  { base: 1, min: 0, max: 10 }, // how fast a car's boost refills: multiplies BOOST_RECHARGE_RATE (see rechargeBoost in life/traffic/driving.js)
  size:      { base: 1, min: 0.3, max: 3 }, // scales how big something's drawn: a person's height (see people.js) or a car's whole body, engine note and wheels (see carScale in life/traffic/placing.js)
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
  // how much a mood shows beyond the eyes (see life/people/peopleEmotes.js): tears falling from them, a blush under them,
  // love hearts floating off the head, a red face with puffs of steam off it (or snorted from the nose), eyes held half
  // shut with Zs drifting up, sweat running down or flung off, a blue face and breath fogging, sparkles, confetti and music
  // notes — 😢 😭 😊 🥰 😍 😠 😤 😴 😅 😱 🥶 🤩 🥳 🎵 in people/moods.txt
  crying:    { base: 0, min: 0, max: 1, combine: 'add' },
  welling:   { base: 0, min: 0, max: 1, combine: 'add' },
  blushing:  { base: 0, min: 0, max: 1, combine: 'add' },
  lovestruck:{ base: 0, min: 0, max: 1, combine: 'add' },
  fuming:    { base: 0, min: 0, max: 1, combine: 'add' },
  huffing:   { base: 0, min: 0, max: 1, combine: 'add' },
  drowsy:    { base: 0, min: 0, max: 1, combine: 'add' },
  drooling:  { base: 0, min: 0, max: 1, combine: 'add' },
  skeptical: { base: 0, min: 0, max: 1, combine: 'add' },
  goofy:     { base: 0, min: 0, max: 1, combine: 'add' },
  sweating:  { base: 0, min: 0, max: 1, combine: 'add' },
  panicking: { base: 0, min: 0, max: 1, combine: 'add' },
  freezing:  { base: 0, min: 0, max: 1, combine: 'add' },
  starstruck:{ base: 0, min: 0, max: 1, combine: 'add' },
  partying:  { base: 0, min: 0, max: 1, combine: 'add' },
  singing:   { base: 0, min: 0, max: 1, combine: 'add' },
  backwards: { base: 0, min: 0, max: 1, combine: 'on' },
  upsidedown:{ base: 0, min: 0, max: 1, combine: 'on' }, // their head the wrong way up, hair and all (🙃: see personLook in life/people/peopleModel.js)
  evil:      { base: 0, min: -1, max: 1, combine: 'add', hidden: true },
  aggression:{ base: 1, min: 0, max: 100 },
  bloodlust: { base: 0, min: 0, max: 1, combine: 'on' }, // covered in blood, twice as fast and out to punch everyone (see life/people/peopleBlood.js); a car gets 10% of its boost back per person it kills (bloodlustBoost in life/traffic/collisions.js)
  agemult:   { base: 1, min: 0.1, max: 1000, hidden: true }, // no upper limit in practice, for vampiric / immortal types
  dodge:     { base: 0, min: 0, max: 1, combine: 'add' }, // the chance of leaping clear of a punch, then going after whoever threw it (see dodgePunch in life/people/peopleActivities.js)
  blazed:    { base: 0, min: 0, max: 1, combine: 'on' }, // the whites of their eyes a little red (see BLAZED_EYE_RED in life/people/people.js)
  sick:      { base: 0, min: 0, max: 1, combine: 'on' }, // their skin goes a sickly green (SICK_SKIN_COLOR in life/people/people.js) — the 🤢 mood in people/moods.txt gives it
  zombie:    { base: 0, min: 0, max: 1, combine: 'on' }, // their skin goes a dead blue-grey (ZOMBIE_SKIN_COLOR in life/people/people.js) — the 🧟 mood in people/moods.txt gives it
  vampire:   { base: 0, min: 0, max: 1, combine: 'on', hidden: true }, // also brings everything in TRAIT_MACROS.vampire; pales the skin with age (see life/people/people.js)
  ageless:   { base: 0, min: 0, max: 1, combine: 'on' }, //hair doesn't grey with age
  nickname:  { base: 0, min: 0, max: 1, combine: 'on' },
  bleach:    { base: 0, min: 0, max: 1, combine: 'on' },//turns hair white - TODO: clothes too
  solo:      { base: 0, min: 0, max: 1, combine: 'on' }, // on a love or hate: the only one of its kind that thing has (see addEntries)
  scramble: {base: 0, min: 0, max: 1, combine: 'on'}, //scrambles text in card
  keysmash: {base: 0, min: 0, max: 1, combine: 'on'}, //keysmashes text in card
  lowercase: {base: 0, min: 0, max: 1, combine: 'on'}, //makes all text in card lowercase
  capitalise: {base: 0, min: 0, max: 1, combine: 'on'}, //capitalise the first letter in every word
  legendary: { base: 0, min: 0, max: 1, combine: 'on' }, //marks trait as legendary
  terrible: { base: 0, min: 0, max: 1, combine: 'on' }, //marks trait as terrible
  headsize: { base: 1, min: 0.2, max: 4 }, // multiplies the head (hair and all), scaled about the neck (see personLook in life/people/peopleModel.js)
  nude: { base: 0, min: 0, max: 1, combine: 'on' }, // no clothes, never changes into any; a mosaic censor over them (life/people/peopleCensor.js)
  smells: { base: 0, min: 0, max: 1, combine: 'on' }, //people keep clear and leave circles it sits in (life/people/peopleSmell.js); cars pull over to let it by (life/traffic/pullover.js)
  respawn: {base: 0, min: 0, max: 1, combine: 'on'}, //resist death one time: the body stays whole (a car still explodes), shakes, then lightning revives it (see life/revive.js)
  drunk: {base: 0, min: 0, max: 1, combine: 'add'} ,//0-1, added up; people at 0.5 weave and fall over as a few pints in, more at 1 (life/people/peopleDrunk.js). cars (any amount): control ×0.5 and steering swapped for 1-3s every 3-10s (see drunkSteer in life/traffic/driving.js); AI cars veer off their lane now and then (drunkVeer in life/traffic/collisions.js)
  unstable: {base: 0, min: 0, max: 1, combine: 'add'}, //chance to be hurt X5 more than usual
  hatespossessed: {base: 0, min: 0, max: 1, combine: 'on'}, //possessed: rants (held vowels, consonant noises, swears), runs as if W and Shift are held, HATES_POSSESSED_SPEED faster, view widened (possession.js) (life/possession.js controlInput, audio/dictionary.js aaa)
  terrified: {base: 0, min: 0, max: 1, combine: 'on'}, //flees forever, always at a run and ranting (audio/dictionary.js aaa, no swears) (see updatePeople in life/people/people.js); possessed, as hatespossessed without swears (possession.js rushed)
  explosive: {base: 0, min: 0, max: 1, combine: 'on'}, //blow up on death, killing bystanders; if already blowing up, explosion becomes much bigger (see blasts in life/traffic/state.js)
  perception: { base: 1, min: 0, max: 5 }, // how likely a car is to notice someone lying in the road ahead and stop for them: 95% at 1, under half at 0.5 (see noticeChance in life/traffic/spacing.js)
  avoiddeadends: { base: 0, min: 0, max: 1, combine: 'on', hidden: true }, // cars: never turns into a dead end or a road that only leads to them, where there's any other way (see waysOn in life/traffic/turns.js) — buses
  aqua: {base: 0, min: 0, max: 1, combine: 'on'}, //people: as waterwalking, but swim — sunk to their shoulders on open water (life/people/peopleWater.js); a car with it drives straight over open water instead of sinking (see driveByHand in life/traffic/driving.js)
  waterwalking: {base: 0, min: 0, max: 1, combine: 'on'}, //people walk on water as on ground, feet at its surface, and path over it in hangouts (life/people/peopleWater.js)
  outlaw: {base: 1, min: 0, max: 20}, //likelihood to break the law
  stimulants: {base: 1, min: 0, max: 20}, //desire for stimulants
  alcoholic: {base: 1, min: 0, max: 20}, //desire for alcohol
  stoner: {base: 1, min: 0, max: 20}, //desire for puff puff
  psychs: {base: 1, min: 0, max: 20}, //desire for psychs
  smoker: {base: 1, min: 0, max: 20}, //desire to smoke normal
  painkillers: {base: 1, min: 0, max: 20}, //desire for drugs that take the edge off
  nerd: {base: 1, min: 0, max: 20}, //chance to bring up deep stuff & trivia
  conservative: {base: 0, min: -1, max: 1, combine: 'add'}, //communist to fascist, -1 left, 1 right
  crazy: { base: 0, min: 0, max: 1, combine: 'add' }, // every so often, a few random traits pushed towards their extremes for a while (see life/people/peopleCrazy.js)
  normal: { base: 1, min: 1, max: 20 }, // pulls every other trait back towards its start: Chatty ×3 with Normal ×2 is Chatty ×1.5; mood +0.4 is +0.2 (see combineTraits in core/entries.js)
};

// Shorthands: a trait named here counts as if the traits listed were written beside it, at the same amounts and stacking
// the same way. Written as the text that goes inside [brackets]; edit the string to change what a shorthand brings. The
// shorthand's own trait stays on the thing, so code can tell what it is. Shorthands are not expanded inside each other.
export const TRAIT_MACROS = {
  vampire: 'agemult = 4.5, evil = 0.5, ageless, aggression = 50, speed = 1.2, bloodlust, dodge = 0.5, limit = 1a, respawn',
};

// Traits that only mark how an entry is listed or picked, with no effect of their own — left out of modifierLines.
const MARKER_TRAITS = ['legendary', 'terrible', 'solo'];
// An entry carrying any of these shows no modifiers at all (its shorthand's traits included), so it gets no drop-down.
const SECRET_TRAITS = ['vampire'];

/**
 * One entry's own traits as lines for the modifier drop-down under it on a card ("Speed ×1.2", "Mood +0.5", "Vampire").
 * Multiplied traits read ×, added ones +/−, switches just their name; markers, `hidden` traits and switches set off are left out,
 * and an entry with a SECRET_TRAITS trait has none.
 *
 * A value may be a list of amounts where several apply to the one trait — what a status effect builds up (see
 * life/statuseffects.js) — and they're shown as the one figure they come to between them (two ×1.3s reading ×1.69).
 * @param {Array<[string, number|number[]]>} entryTraits - an entry's [trait, value] pairs (see entryOf in core/entries.js)
 * @param {object} [table] - the trait table they come from
 * @returns {string[]} one line per modifier
 */
export function modifierLines(entryTraits, table = TRAITS) {
  const amounts = value => Array.isArray(value) ? value : [value];
  const switchedOn = value => amounts(value).some(amount => amount > 0);
  if (entryTraits.some(([key, value]) => SECRET_TRAITS.includes(key) && switchedOn(value))) return [];
  return entryTraits
    .filter(([key, value]) => table[key] && !table[key].hidden && !MARKER_TRAITS.includes(key)
      && !(table[key].combine === 'on' && !switchedOn(value)))
    .map(([key, value]) => {
      const name = key[0].toUpperCase() + key.slice(1), { combine } = table[key];
      const amount = Math.round(amounts(value).reduce((total, one) => combine === 'add' ? total + one : total*one, combine === 'add' ? 0 : 1)*100)/100;
      if (combine === 'on') return name;
      if (combine === 'add') return `${name} ${amount < 0 ? '−' + -amount : '+' + amount}`;
      return `${name} ×${amount}`;
    });
}

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
