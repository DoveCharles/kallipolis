// ============================================================ melodies
// The tune someone talks in, the same every time they open their mouth, babble or real words alike (see audio/voices.js
// and audio/speech.js) — as Tomodachi Life gives each Mii's voice its own: one starts low and climbs, one sings up and down
// syllable by syllable, one never budges. Each is a shape over a phrase: how far above or below their own pitch they are
// (as a fraction of it) `through` it, 0 to 1, on syllable `k`; and how far its last syllable falls away, as a statement's
// does (0 not at all, 1 the whole way). A question still rises at the end, whatever the tune.
export const MELODIES = [
  { name: 'settling', shape: u => 0.12*(1 - 2*u), fall: 1 },                         // drifting down, as most speech does
  { name: 'climbing', shape: u => -0.22 + 0.5*u, fall: 0 },                          // low, getting higher to the end
  { name: 'tumbling', shape: u => 0.32 - 0.5*u, fall: 0.5 },                         // high, dropping all the way
  { name: 'hill', shape: u => -0.14 + 0.42*Math.sin(Math.PI*u), fall: 0.5 },         // up over the middle and down again
  { name: 'dip', shape: u => 0.22 - 0.38*Math.sin(Math.PI*u), fall: 0 },             // sagging in the middle, back up
  { name: 'singsong', shape: (u, k) => (k % 2 ? 0.22 : -0.08) - 0.12*u, fall: 0.5 }, // up, down, up, down
  { name: 'wobbly', shape: u => 0.2*Math.sin(u*Math.PI*4), fall: 0.5 },             // wavering up and down twice over
  { name: 'flat', shape: () => 0, fall: 0 },                                         // one note, like a robot
];

// sung, not spoken (a preset's voice only: see people/presets.js): each syllable held on the next note of TUNE (semitones
// over their pitch), with vibrato and no wander (audio/speech.js, audio/voices.js)
const TUNE = [0, 4, 7, 9, 7, 4, 2, 4, 0, 7, 12, 9, 7, 4, 2, 0];
export const SUNG = { name: 'sung', sung: true, shape: (u, k) => 2**(TUNE[k % TUNE.length]/12) - 1, fall: 0 };

// an accent's tune, in place of their own (audio/accents.js): Welsh lilts, up and down, ending up; Irish lifts; Australian rises at the end; Manc drones
export const ACCENT_MELODIES = {
  irish: { name: 'irish', shape: u => 0.26*Math.sin(Math.PI*0.9*u) - 0.06, fall: 0.3 }, // up through the middle, down a little
  australian: { name: 'australian', shape: u => 0.08*(1 - 2*u) + 0.4*Math.max(0, (u - 0.7)/0.3)**2, fall: 0 }, // ends up, statements too
  manc: { name: 'manc', shape: u => 0.03 - 0.08*u + 0.14*Math.sin(Math.PI*Math.max(0, (u - 0.7)/0.3)), fall: 0.3 }, // level and low, a lazy lift on the last word
  welsh: { name: 'welsh', shape: (u, k) => 0.2*Math.sin(Math.PI*1.6*u) - 0.06 + (k % 2 ? 0.07 : -0.03), fall: 0 },
};

/**
 * Someone's melody.
 * @param {{melody?: number|string}} voice - its melody, an index into MELODIES (none, the first), or 'sung'
 * @returns {{name: string, shape: (through: number, k: number) => number, fall: number}}
 */
export const melodyOf = voice => voice.melody === 'sung' ? SUNG : ACCENT_MELODIES[voice.accent] ?? MELODIES[voice.melody ?? 0] ?? MELODIES[0];
