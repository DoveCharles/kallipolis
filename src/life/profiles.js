import { mulberry32 } from '../core/math.js';
import { DEFAULT_COUNTS, startingTraits, plainEntry, parseSections, combineTraits, pickCounts, addEntries, clash, tierOf, modifiersOf, limitsOf } from '../core/entries.js';
import { TRAITS } from '../core/traits.js';

const LETTERS = ['A.','B.','C.','D.','E.','F.','G.','H.','I.','J.','K.','L.','M.','N.','O.','P.','Q.','R.','S.','T.','U.','V.','W.','X.','Y.','Z.','Ñ.']
const ROMAN_NUMERALS = [ 'II', 'III','II', 'III', 'IV', 'V','VI','VII','VII','IX']

// ============================================================ who people are
// Everyone in the crowd has a name, an age, a mood, and loves and hates, picked from the lists in assets/text/people/ (one
// file per list; see PEOPLE_FILES). The picks are the same every time for the same person id (see peopleIdSeq in
// people.js — not their place in the crowd, which just changes who's currently standing in that slot), and any traits
// they carry change how that person behaves (see the list in people/about.txt, and people.js). person-card.js displays a
// profile.
// How many loves and hates each person gets is the shared spread in core/entries.js (DEFAULT_COUNTS), the same one every
// other kind falls back to.
const PEOPLE_TEXT_DIR = 'assets/text/people/';
// The files, and the [heading] each is read under: they're joined into one text in this order and read as ever by
// parseSections. about.txt has no heading of its own — it's the notes, the trait table and the [distribution]. Unisex
// names go into both the boy and girl names.
const PEOPLE_FILES = [
  { file: 'about' },
  { file: 'boynames', heading: 'Boy names' }, { file: 'unisexnames', heading: 'Boy names' },
  { file: 'girlnames', heading: 'Girl names' }, { file: 'unisexnames', heading: 'Girl names' },
  { file: 'surnames', heading: 'Surnames' }, { file: 'nicknames', heading: 'Nicknames' }, { file: 'moods', heading: 'Moods' },
  { file: 'loves', heading: 'Loves' }, { file: 'hates', heading: 'Hates' },
];
// the value everyone starts with, by trait: each trait's base until the files load, then whatever its trait table's start
// column says (see parseSections) — updated in place, so people holding it see the file's values
export const DEFAULT_TRAITS = startingTraits();
const SEXUALITY = [[0, 0.6], [0.5, 0.2], [1, 0.2]]; // [gay, share]: 60% straight, 20% bi, 20% gay
// Natural variance: each person starts these a little off their base, before their entries stack on top — up to
// TRAIT_JITTER either way (a share of the base for multipliers, that much for added traits like evil). 0 turns it off.
const TRAIT_JITTER = 0.05;
const JITTERED = ['chatty', 'talkative', 'patience', 'aggression', 'nerd', 'mood', 'evil', 'conservative', 'fidgety', 'lounging', 'nosy',
  'shopping', 'outlaw', 'stimulants', 'alcoholic', 'stoner', 'psychs', 'smoker', 'painkillers', 'erratic', 'normal'];
// (on a stream of its own, so nothing else about a person changes; kept to each trait's range)
function startOf(id, gay) {
  const start = { ...DEFAULT_TRAITS, gay };
  if (!TRAIT_JITTER) return start;
  const rng = mulberry32(52711 + id*2797);
  JITTERED.forEach(key => {
    const t = TRAITS[key];
    if (!t) return;
    const base = start[key], off = (rng()*2 - 1)*TRAIT_JITTER, value = t.combine === 'add' ? base + off : base*(1 + off); // (base: the file's start, if it sets one)
    start[key] = Math.max(t.min, Math.min(t.max, value));
  });
  return start;
}

let version = 0; // counts up each time the people files load, so what was worked out from it can be worked out again
let filesLoaded = false;
const listeners = [];
// how many loves and hates a person gets, until about.txt says (its [distribution]) — the shared spread
let counts = DEFAULT_COUNTS;

// the lists, by their headings in PEOPLE_FILES (matched the way parseSections keys them: lowercase) — these stand in until
// it's loaded, or if it can't be
const lists = { 'boy names': ['Dave'], 'girl names': ['Linda'], 'surnames': ['Smith'], 'nicknames': ['The Bug'], 'moods': ['😐'], 'loves': ['A nice walk'], 'hates': ['Puddles'] };
Object.keys(lists).forEach(key => { lists[key] = lists[key].map(plainEntry); });

// one file's text; a missing one is warned about and read as empty, so the rest still load
const readPeopleFile = file => fetch(`${PEOPLE_TEXT_DIR}${file}.txt`)
  .then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.text(); })
  .catch(err => { console.warn(`Kallipolis: ${PEOPLE_TEXT_DIR}${file}.txt failed to load; left out`, err); return ''; });

const fileNames = [...new Set(PEOPLE_FILES.map(part => part.file))];
Promise.all(fileNames.map(readPeopleFile))
  .then(texts => {
    const textOf = Object.fromEntries(fileNames.map((file, i) => [file, texts[i]]));
    // (each heading once, with every file under it one after another)
    const parts = [];
    PEOPLE_FILES.forEach(({ file, heading }) => {
      const last = parts[parts.length - 1];
      if (heading && last?.heading === heading) last.texts.push(textOf[file]);
      else parts.push({ heading, texts: [textOf[file]] });
    });
    const text = parts.map(({ heading, texts }) => (heading ? `[${heading}]\n` : '') + texts.join('\n')).join('\n');
    const { sections, starts, distribution } = parseSections(text, { file: 'people/*.txt' });
    Object.assign(DEFAULT_TRAITS, starts);
    // how many loves and hates each person gets: the file's own [distribution], or the shared spread (see DEFAULT_COUNTS)
    counts = distribution && distribution.length ? distribution : DEFAULT_COUNTS;
    Object.keys(lists).forEach(key => { const section = sections[key]; if (section && section[key] && section[key].length) lists[key] = section[key]; });
    filesLoaded = true;
    version++;
    listeners.forEach(listener => listener());
  })
  .catch(err => console.warn('Kallipolis: the people files failed to load; people get placeholder names', err));

export const profilesVersion = () => version;
// whether the people files have loaded (not the placeholders), and their love/hate entries (see ui/traits-known.js)
export const peopleListsLoaded = () => filesLoaded;
export const peopleTraitEntries = () => ({ love: lists.loves, hate: lists.hates });
/** Every mood in moods.txt, as parsed (each with its text, the emoji): for the moods debug window, ui/moods-debug.js. */
export const moodEntries = () => lists.moods;
// Fills an entry's [placeholders] for a card, once speech has loaded (life/speech-text.js hands it over): (entry, rng) →
// { card, said, words }. Until then entries show as written.
let fillEntry = null;
export function setEntryFiller(fill) {
  fillEntry = fill;
  version++;
  listeners.forEach(listener => listener());
}
// `listener` is called whenever the people files have loaded
export function onProfilesLoaded(listener) { listeners.push(listener); }
/** One way an entry with [placeholders] could read on a card, filled from `rng` (as written until speech has loaded).
 * @param {object} entry @param {1|-1} side - a love or a hate @param {() => number} [rng] @returns {string} */
export function sampleCardText(entry, side, rng = Math.random) {
  if (!fillEntry) return entry.text;
  const filled = fillEntry(entry, rng, side, [entry]);
  return filled && !filled.failed ? filled.card : entry.text;
}

// Someone's name, age, mood, loves and hates (lists; from people/loves.txt and hates.txt), and the traits those give them — a man's name from the boy names and
// a woman's from the girl names (either, for the cuboid people, who have no sex). `id` is their person id (see peopleIdSeq
// in people.js), not their place in the crowd — so the same id always comes back as the same person, wherever they're standing.
// `moodNow`, if given, is the text of a mood they've come round to since (a gift that cheered them up: see cheerierMood
// and life/gifts.js), worn in place of the one they were picked with, its traits with it.
// A piper's minis (see people/peopleMinis.js) are their leader, small and big-headed — the same profile (MINI_TRAITS
// aside), called Mini and the name the leader goes by (a nickname, else their first name), numbered.
export const MINI_TRAITS = { size: 0.2, headsize: 3.2 }; // (× the leader's)
const minis = new Map(); // a mini's id → { leaderId, n }
/** Make person `id` a mini of person `leaderId`'s, the `n`th. */
export const registerMini = (id, leaderId, n) => { minis.set(id, { leaderId, n }); };
// a preset's (see people/presets.js) ids: their own picks, but the preset's name
const presets = new Map();
/** Make person `id` preset `preset` (see people/presets.js). */
export const registerPreset = (id, preset) => { presets.set(id, preset); };
const ownProfile = (id, isMan, moodNow) => {
  const preset = presets.get(id), profile = profileFor(id, isMan, moodNow ?? preset?.mood ?? null); // (a preset's own mood till another's worn)
  if (!preset) return profile;
  const own = side => preset[side] ? { [side]: preset[side].map(([card]) => card), [side + 'Said']: preset[side].map(([, said]) => said),
    [side + 'Tier']: preset[side].map(() => null), [side + 'Mods']: preset[side].map(() => []), [side + 'Base']: preset[side].map(([card]) => card),
    [side === 'loves' ? 'lovedWords' : 'hatedWords']: [] } : {};
  return { ...profile, name: preset.name, shortName: preset.shortName, age: preset.age ?? profile.age, ...own('loves'), ...own('hates') };
};
export function profileOf(id, isMan, moodNow = null) {
  const mini = minis.get(id);
  if (!mini) return ownProfile(id, isMan, moodNow);
  const leader = ownProfile(mini.leaderId, isMan, moodNow), { traits } = leader;
  return { ...leader, name: `Mini ${leader.shortName} #${mini.n}`,
    traits: { ...traits, piper: 0, size: traits.size*MINI_TRAITS.size, headsize: (traits.headsize || 1)*MINI_TRAITS.headsize } };
}
function profileFor(id, isMan, moodNow = null) {
  const rng = mulberry32(48271 + id*7919);
  const pick = list => list[Math.floor(rng()*list.length)];
  const man = isMan == null ? rng() < 0.5 : isMan;
  const name = pick(lists[man ? 'boy names' : 'girl names']);
  let age = 18 + Math.floor(rng()*65);
  const picked = pick(lists.moods); // (picked either way, so nothing after it changes)
  const mood = (moodNow != null && lists.moods.find(entry => entry.text === moodNow)) || picked;
  const firstLove = pick(lists.loves);

  // (gives up after 50 tries, leaving no first hate, if nothing in the list goes with what they enjoy)
  let hates, incompatible = true;
  for (let tries = 0; incompatible && tries < 50; tries++) {
    hates = pick(lists.hates);
    incompatible = clash(firstLove, hates);
  }

  // The counts and any extra picks use their own random stream, so adding to the picks made on `rng` above does not change
  // the names, ages and moods of existing people. Keep new random draws for a profile on `extra`, not `rng`.
  const extra = mulberry32(90173 + id*6151);
  const [loveCount, hateCount] = pickCounts(counts, extra());
  const loves = loveCount >= 1 ? [firstLove] : [], hated = hateCount >= 1 && !incompatible ? [hates] : [];
  addEntries(loves, lists.loves, loveCount, extra, [loves, hated]);
  addEntries(hated, lists.hates, hateCount, extra, [loves, hated]);

  // (placeholders filled on their own stream, so filling doesn't change anything else picked; the words filled in bring
  // their {effect.…} traits — see fillEntry in speech-text.js)
  const fillRng = mulberry32(60013 + id*3371);
  // (side: 1 a love, -1 a hate — a hate drawn into a love, "Conversely, [hates]", brings its traits turned round)
  const held = [...loves, ...hated];
  const filledOf = side => entry => fillEntry ? fillEntry(entry, fillRng, side, held) : { card: entry.text, said: entry.said ?? entry.text, words: [], effects: [], limits: [] };
  let lovesFilled = loves.map(filledOf(1)), hatesFilled = hated.map(filledOf(-1));
  // (one nothing would fill — "Conversely, [hates]" when they hold every hate there is — is dropped, unless it's all they have)
  const unfilled = (list, filled) => filled.map((f, i) => f.failed ? i : -1).filter(i => i >= 0).reverse();
  if (loves.length + hated.length > 1) {
    unfilled(loves, lovesFilled).forEach(i => { if (loves.length + hated.length > 1) { loves.splice(i, 1); lovesFilled.splice(i, 1); } });
    unfilled(hated, hatesFilled).forEach(i => { if (loves.length + hated.length > 1) { hated.splice(i, 1); hatesFilled.splice(i, 1); } });
  }
  const withEffects = (entry, filled) => ({ ...entry, traits: [...entry.traits, ...(filled.effects ?? [])] });
  const lovesFull = loves.map((entry, i) => withEffects(entry, lovesFilled[i])), hatesFull = hated.map((entry, i) => withEffects(entry, hatesFilled[i]));
  // (who they're drawn to, on a stream of its own: SEXUALITY; a love or hate with gay = n overrides it)
  const roll = mulberry32(31337 + id*4513)();
  const gay = SEXUALITY.find(([, share], i) => roll < SEXUALITY.slice(0, i + 1).reduce((sum, [, s]) => sum + s, 0))?.[0] ?? 0;
  const traits = combineTraits([name, mood, ...lovesFull, ...hatesFull], TRAITS, startOf(id, gay));

  const nameRoll = rng();
  let nick = null; // (the nickname in their name, if any: what they go by — shortName)
  const nickname = () => (nick = pick(lists['nicknames']).text);

  let fullname = traits.nickname ? nickname() :                                    //nickname only - requires trait (twins too)
    traits.twins ? `The ${pick(lists['surnames']).text} Twins` :                                       //the twins trait: The Smith Twins
    nameRoll>0.9 ? `${name.text} '${nickname()}' ${pick(lists['surnames']).text}`: //full name w/ nickname, 10%
    nameRoll>0.3 ? `${name.text} ${pick(lists['surnames']).text}`:                                    //full name no nickname, 60%
      nameRoll>0.2? `${name.text} ${pick(LETTERS)} ${pick(lists['surnames']).text}`:                 //full name, abr middle, 10%
        nameRoll>0.115?`'${nickname()}' ${pick(lists['surnames']).text}`:           //nickname surname, 8.5%
          nameRoll>0.2?`${name.text} '${nickname()}'`:                            //forename nickname, 8.5%
            `${name.text} ${pick(ROMAN_NUMERALS)}`;                                               //forename numeral, 2%


  //unknown entities have hidden traits
  // (UNKNOWN) people hide every love, every hate, or both — never neither. A hidden side that has no entries shows a single
  // (UNKNOWN), with no tier (nothing to colour gold or dark reddish-brown while it's a mystery).
  let loveTexts = lovesFilled.map(filled => filled.card), hateTexts = hatesFilled.map(filled => filled.card);
  let loveTiers = lovesFull.map(tierOf), hateTiers = hatesFull.map(tierOf);
  let loveMods = lovesFull.map(modifiersOf), hateMods = hatesFull.map(modifiersOf);
  let loveBase = loves.map(entry => entry.text), hateBase = hated.map(entry => entry.text); // (the file's own wording, to identify by)
  if (name.text === '(UNKNOWN)') {
    fullname = '(UNKNOWN)';
    const hidden = texts => texts.length ? texts.map(() => '(UNKNOWN)') : ['(UNKNOWN)'];
    const lovesHidden = rng() > 0.5;
    const hatesHidden = !lovesHidden || rng() > 0.5;
    if (lovesHidden) { loveTexts = hidden(loveTexts); loveTiers = loveTexts.map(() => null); loveMods = loveTexts.map(() => []); loveBase = loveTexts.map(() => null); }
    if (hatesHidden) { hateTexts = hidden(hateTexts); hateTiers = hateTexts.map(() => null); hateMods = hateTexts.map(() => []); hateBase = hateTexts.map(() => null); }
  }

  age = Math.round(Math.max(18, age*traits.agemult)) //no minors!

  // `loves` and `hates` are lists of text; at most one is ever empty. `lovesTier`/`hatesTier` run alongside, entry for
  // entry (see tierOf): 'legendary' or 'terrible' or null, for the card to colour that entry's row (ui/entity-card.js).
  // `lovesMods`/`hatesMods` likewise: each entry's modifier lines (see modifiersOf) — none for a hidden (UNKNOWN) one.
  // `lovesSaid`/`hatesSaid`: the same, worded for speech (never hidden); `lovedWords`/`hatedWords`: words filled into them
  // `limits`: every limit rule their name, mood, loves and hates hold (see clash in core/entries.js), for what they'll say
  return { name: fullname, shortName: nick ?? name.text, age, mood: mood.text, loves: loveTexts, hates: hateTexts, limits: [...[name, mood, ...loves, ...hated].flatMap(limitsOf), ...[...lovesFilled, ...hatesFilled].flatMap(filled => filled.limits ?? [])],
    lovesSaid: lovesFilled.map(filled => filled.said), hatesSaid: hatesFilled.map(filled => filled.said),
    lovedWords: lovesFilled.flatMap(filled => filled.words), hatedWords: hatesFilled.flatMap(filled => filled.words), lovesTier: loveTiers, hatesTier: hateTiers, lovesMods: loveMods, hatesMods: hateMods, lovesBase: loveBase, hatesBase: hateBase, traits: traits};
}

// ---- cheering up
// How bright a mood is: its mood and happy eyes, less its sad and angry ones (😭 -2, 😐 0, 😁 1.8) — read off its traits.
const CHEER_BELOW = 0; // a mood darker than this is one a cheering gift lifts (😢, 😠, 🙄, 😑…)
const CHEERED_FROM = 0.6; // and it's lifted to one at least this bright (🙂, 😊, 😄…)
export function moodBrightness(entry) {
  const traits = Object.fromEntries(entry?.traits ?? []);
  return (traits.mood ?? 0) + (traits.happy ?? 0) - (traits.sad ?? 0) - (traits.angry ?? 0);
}
// The mood someone showing `moodText` comes round to on being cheered up: one of the bright moods in moods.txt (those it
// picks from anyway: never one only a trait gives, with choiceweight 0), or null if theirs isn't a sad or angry one.
export function cheerierMood(moodText, rng = Math.random) {
  const now = lists.moods.find(entry => entry.text === moodText);
  if (!now || moodBrightness(now) >= CHEER_BELOW) return null;
  const bright = lists.moods.filter(entry => moodBrightness(entry) >= CHEERED_FROM);
  return bright.length ? bright[Math.floor(rng()*bright.length)] : null;
}
