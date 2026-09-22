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

/**
 * Someone's melody.
 * @param {{melody?: number}} voice - its melody, an index into MELODIES (none, the first)
 * @returns {{name: string, shape: (through: number, k: number) => number, fall: number}}
 */
export const melodyOf = voice => MELODIES[voice.melody ?? 0] ?? MELODIES[0];
