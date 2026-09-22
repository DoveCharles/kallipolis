import SamJs from 'sam-js';
import { melodyOf } from './melodies.js';

// ============================================================ speech
// Babble's voice (see audio/voices.js) saying real words: the line said in audio/dictionary.js. SAM (sam-js) only works
// the words out into sounds here — its phonemes, with the stressed vowels marked — and the voice is made from them the way
// babble's is, a sawtooth at the speaker's pitch through formants moved by their mouth and throat, ringing as sharply as
// theirs, but done properly enough to be understood: a formant synth after Klatt's (1980), rendered as samples in one go.
//
// What makes it followable, roughly in order: the formants glide continuously from one sound to the next rather than
// jumping, as a mouth does, and those glides are most of how a consonant's heard (F2 swinging down into a "b", up into a
// "g" before "ee"); the timing's speech's own, stressed vowels long and unstressed ones clipped, a vowel longer before a
// voiced consonant and the last word of a clause drawn out; a third formant (without it "r" and "l" are the same); and
// each class of sound built as it's made: a stop is a silence (or a low buzz, if it's voiced) then a click of noise where
// that consonant sits and, if it's voiceless, a puff of breath through the coming vowel's formants; a fricative is noise
// through its own band ("s" high, "sh" lower, "f" and "th" faint and wide), buzzing under it if it's voiced; a nasal is
// the voice muffled, with a dip in its low end; "h" is breath through the next vowel's mouth. And the pitch goes as
// babble's does: through each clause in the speaker's own melody (see audio/melodies.js), lifted on its stressed
// syllables, falling at the end, or rising for a question.
export const SAMPLE_RATE = 22050;
const T = 1/SAMPLE_RATE;
const FRAME = 0.005;            // seconds between updates of the voice's settings
const TEMPO = 0.9;              // how much longer than Klatt's own durations it takes (under 1, brisker)
const STRESS = 0.14;            // how much higher a stressed syllable is (babble's STRESS, a touch more)
const JITTER = 0.03;            // how far each syllable's pitch strays at random, either way
const PAUSE = { ',': 0.18, '-': 0.15, '.': 0.32, '?': 0.32, '!': 0.32 }; // seconds of quiet after each
const BANDWIDTHS = [60, 90, 150, 250]; // Hz, of F1 to F4, for a voice of middling sharpness (6), wider the breathier
const F4 = 3500;                // Hz, the fourth formant, which barely moves
const ASPIRATION = 0.35;        // breath, next to the voice
const NASAL = [270, 450];       // Hz, the nasal pole, and the zero that pairs with it in an "m", "n" or "ng" (moved off it otherwise)

// ------------------------------------------------------------ the sounds
// Each of SAM's phonemes: its kind, formants [F1, F2, F3] in Hz (a diphthong's glide from one set to another), and its
// duration in ms, as it is when stressed and at its shortest (Klatt's inherent and minimum). Their formants are a man's:
// the voice's formant scales them.
const PHONEMES = {
  IY: { kind: 'vowel', f: [280, 2250, 2950], dur: [155, 55] },
  IH: { kind: 'vowel', f: [400, 1950, 2550], dur: [135, 40] },
  EH: { kind: 'vowel', f: [550, 1800, 2500], dur: [150, 70] },
  AE: { kind: 'vowel', f: [680, 1720, 2420], dur: [230, 80] },
  AA: { kind: 'vowel', f: [730, 1100, 2450], dur: [240, 100] },
  AH: { kind: 'vowel', f: [620, 1200, 2450], dur: [140, 60] },
  AO: { kind: 'vowel', f: [580, 880, 2420], dur: [240, 100] },
  UH: { kind: 'vowel', f: [450, 1050, 2250], dur: [160, 60] },
  AX: { kind: 'vowel', f: [500, 1400, 2400], dur: [120, 55] },
  IX: { kind: 'vowel', f: [400, 1800, 2500], dur: [90, 45] },
  ER: { kind: 'vowel', f: [480, 1330, 1650], dur: [180, 80] },
  UX: { kind: 'vowel', f: [350, 1450, 2250], dur: [150, 60] },
  OH: { kind: 'vowel', f: [520, 900, 2400], dur: [180, 80] },
  EY: { kind: 'vowel', f: [500, 1850, 2500], to: [330, 2150, 2850], dur: [190, 100] },
  AY: { kind: 'vowel', f: [720, 1180, 2500], to: [420, 1950, 2600], dur: [250, 150] },
  OY: { kind: 'vowel', f: [560, 880, 2400], to: [420, 1900, 2550], dur: [280, 150] },
  AW: { kind: 'vowel', f: [720, 1250, 2500], to: [450, 1000, 2350], dur: [260, 100] },
  OW: { kind: 'vowel', f: [540, 960, 2400], to: [380, 820, 2300], dur: [220, 80] },
  UW: { kind: 'vowel', f: [360, 1100, 2300], to: [300, 880, 2250], dur: [210, 70] },
  L: { kind: 'liquid', f: [330, 1050, 2600], dur: [80, 40] },
  LX: { kind: 'liquid', f: [450, 850, 2550], dur: [80, 40] },
  R: { kind: 'liquid', f: [320, 1050, 1400], dur: [80, 30] },
  RX: { kind: 'liquid', f: [420, 1250, 1600], dur: [80, 30] },
  W: { kind: 'liquid', f: [290, 650, 2200], dur: [80, 60] },
  WX: { kind: 'liquid', f: [350, 800, 2300], dur: [60, 40] },
  Y: { kind: 'liquid', f: [260, 2100, 3000], dur: [80, 40] },
  YX: { kind: 'liquid', f: [300, 2100, 2900], dur: [60, 40] },
  M: { kind: 'nasal', place: 'lips', dur: [70, 50] },
  N: { kind: 'nasal', place: 'gum', dur: [60, 30] },
  NX: { kind: 'nasal', place: 'soft', dur: [95, 45] },
  P: { kind: 'stop', place: 'lips', dur: [65, 45] },
  B: { kind: 'stop', place: 'lips', voiced: true, dur: [60, 40] },
  T: { kind: 'stop', place: 'gum', dur: [55, 35] },
  D: { kind: 'stop', place: 'gum', voiced: true, dur: [50, 30] },
  K: { kind: 'stop', place: 'soft', dur: [60, 40] },
  KX: { kind: 'stop', place: 'soft', dur: [60, 40] },
  G: { kind: 'stop', place: 'soft', voiced: true, dur: [55, 40] },
  GX: { kind: 'stop', place: 'soft', voiced: true, dur: [55, 40] },
  DX: { kind: 'flap', place: 'gum', dur: [25, 20] },
  Q: { kind: 'glottal', dur: [45, 30] },
  S: { kind: 'fric', place: 'gum', noise: [5500, 3000, 0.5], dur: [105, 60] },
  Z: { kind: 'fric', place: 'gum', voiced: true, noise: [5500, 3000, 0.3], dur: [75, 40] },
  SH: { kind: 'fric', place: 'palate', noise: [2800, 2000, 0.55], dur: [105, 80] },
  ZH: { kind: 'fric', place: 'palate', voiced: true, noise: [2800, 2000, 0.3], dur: [70, 40] },
  F: { kind: 'fric', place: 'lips', noise: [4000, 6000, 0.12], dur: [100, 80] },
  V: { kind: 'fric', place: 'lips', voiced: true, noise: [4000, 6000, 0.08], dur: [60, 40] },
  TH: { kind: 'fric', place: 'teeth', noise: [5000, 6000, 0.1], dur: [90, 60] },
  DH: { kind: 'fric', place: 'teeth', voiced: true, noise: [5000, 6000, 0.06], dur: [50, 30] },
  CH: { kind: 'affricate', place: 'palate', noise: [2800, 2000, 0.55], dur: [70, 50] },
  J: { kind: 'affricate', place: 'palate', voiced: true, noise: [2800, 2000, 0.3], dur: [70, 50] },
  '/H': { kind: 'h', dur: [60, 30] },
  '/X': { kind: 'h', dur: [60, 30] },
  HW: { kind: 'h', f: [290, 650, 2200], dur: [50, 30] },
};
// SAM's syllabic consonants, said as a schwa and the consonant; and its "wh", a breathed "w" into a voiced one
const SYLLABIC = { UL: ['AX', 'L'], UM: ['AX', 'M'], UN: ['AX', 'N'], WH: ['HW', 'W'] };
// where each place in the mouth pulls the formants as the tongue or lips close there (the soft palate's depends on the
// vowel beside it: see locus); and the click a stop makes as it opens there [Hz, bandwidth, level, seconds]
const LOCI = { lips: [250, 850, 2200], gum: [250, 1750, 2650], palate: [280, 1950, 2450], teeth: [280, 1450, 2600] };
const BURSTS = { lips: [1100, 1600, 0.35, 0.008], gum: [4200, 2500, 0.6, 0.01], soft: [0, 900, 0.6, 0.02] };

const locus = (place, vowel) => {
  if (place !== 'soft') return LOCI[place];
  // (a "k" or "g" meets the vowel where its F2 is, near enough: high before "ee", low before "oo", with F3 close by)
  const f2 = 0.6*(vowel?.[1] ?? 1500) + 900;
  return [250, f2, f2 + 350];
};

/**
 * SAM's phonemes for some text, split into clauses, each a list of { name, stress, word } (stress 0 none, 1 stressed, 2
 * lightly, where SAM left a word unmarked; word, which word of the clause it's in) and the punctuation it ends on.
 * @param {string} text
 * @returns {{phonemes: object[], end: string}[]}
 */
export function phonemesOf(text) {
  const spelled = SamJs.convert(text);
  if (!spelled) return [];
  const clauses = [];
  let clause = { phonemes: [], end: '.' }, word = 0;
  for (let i = 0; i < spelled.length;) {
    const c = spelled[i], two = spelled.slice(i, i + 2);
    if (c === ' ') { word++; i++; continue; }
    if (PAUSE[c] !== undefined) {
      if (clause.phonemes.length) { clause.end = c; clauses.push(clause); }
      clause = { phonemes: [], end: '.' }; word = 0; i++; continue;
    }
    if (c >= '1' && c <= '9') {
      const last = clause.phonemes.at(-1);
      if (last && PHONEMES[last.name]?.kind === 'vowel') last.stress = 1;
      i++; continue;
    }
    const name = PHONEMES[two] || SYLLABIC[two] ? two : PHONEMES[c] ? c : null;
    i += name?.length ?? 1;
    if (!name) continue;
    for (const part of SYLLABIC[name] ?? [name]) clause.phonemes.push({ name: part, stress: 0, word });
  }
  if (clause.phonemes.length) clauses.push(clause);
  // (SAM marks stress only where its rules know it: a word it's left unmarked gets its first vowel lightly stressed, if
  // it's more than a little word)
  for (const { phonemes } of clauses) {
    const words = Map.groupBy(phonemes, p => p.word);
    for (const list of words.values()) {
      const vowels = list.filter(p => PHONEMES[p.name].kind === 'vowel');
      if (vowels.length && !vowels.some(v => v.stress) && (vowels.length > 1 || list.length > 3)) vowels[0].stress = 2;
    }
  }
  return clauses;
}

// ------------------------------------------------------------ the plan
// The line laid out in time as segments, each { start, dur, f: frac => [F1, F2, F3], trans (seconds of its end given to
// gliding to or from its neighbour), voice, breath (how much of each), noise ([Hz, bandwidth, level] of its hiss, or
// null), nasal, muffle (how much wider F2 and F3 go), burst (a stop's click at its start, or null), accent (a stressed
// vowel's pitch lift), clause }.
function plan(clauses, tempo) {
  const segments = [];
  const push = s => { s.start = segments.length ? segments.at(-1).start + segments.at(-1).dur : 0; segments.push(s); return s; };
  const still = f => () => f;
  clauses.forEach((clause, c) => {
    const list = clause.phonemes;
    const lastVowel = list.findLastIndex(p => PHONEMES[p.name].kind === 'vowel');
    const vowelNear = (i, step) => {
      for (let j = i + step; j >= 0 && j < list.length; j += step) if (PHONEMES[list[j].name].kind === 'vowel') return PHONEMES[list[j].name];
      return null;
    };
    list.forEach((p, i) => {
      const ph = PHONEMES[p.name], prev = list[i - 1], next = list[i + 1];
      const nextPh = next && PHONEMES[next.name], prevPh = prev && PHONEMES[prev.name];
      const [inherent, least] = ph.dur;
      const finalStretch = i >= lastVowel && lastVowel >= 0 ? (i === lastVowel ? 1.4 : 1.2) : 1;
      let dur;
      if (ph.kind === 'vowel') {
        dur = p.stress === 1 ? inherent : p.stress === 2 ? least + 0.75*(inherent - least) : least + 0.4*(inherent - least);
        // (longer before a voiced consonant, shorter before a voiceless one, as English does)
        if (nextPh && nextPh.kind !== 'vowel') dur *= nextPh.voiced || nextPh.kind === 'nasal' || nextPh.kind === 'liquid' ? 1.15 : nextPh.kind === 'stop' || nextPh.kind === 'fric' ? 0.85 : 1;
      } else {
        const stressedNext = nextPh?.kind === 'vowel' && next.stress;
        dur = stressedNext ? inherent : (inherent + least)/2;
        // (consonants in a cluster squeeze each other)
        if ((prevPh && prevPh.kind !== 'vowel') || (nextPh && nextPh.kind !== 'vowel')) dur *= 0.85;
      }
      dur *= finalStretch*tempo/1000;
      const after = vowelNear(i, 1), before = vowelNear(i, -1);
      const base = { voice: 0, breath: 0, noise: null, nasal: false, muffle: 1, burst: null, accent: 0, clause: c, trans: 0.02 };
      if (ph.kind === 'vowel') {
        const from = ph.f, to = ph.to;
        push({ ...base, dur, voice: p.stress ? 1 : 0.8, accent: p.stress === 1 ? 1 : p.stress === 2 ? 0.5 : 0, trans: 0.05, vowel: true,
          f: to ? frac => { const u = smooth((frac - 0.2)/0.65); return from.map((v, k) => v + (to[k] - v)*u); } : still(from) });
      } else if (ph.kind === 'liquid') {
        push({ ...base, dur, voice: 0.7, trans: 0.045, f: still(ph.f) });
      } else if (ph.kind === 'nasal') {
        push({ ...base, dur, voice: 0.55, nasal: true, muffle: 2.5, trans: 0.012, f: still(locus(ph.place, (after ?? before)?.f)) });
      } else if (ph.kind === 'stop' || ph.kind === 'affricate') {
        const place = ph.kind === 'affricate' ? 'palate' : ph.place;
        const loc = locus(place, (after ?? before)?.f);
        const released = !(nextPh && (nextPh.kind === 'stop' || nextPh.kind === 'affricate'));
        const closure = ph.kind === 'affricate' ? dur*0.55 : dur;
        push({ ...base, dur: closure, voice: ph.voiced ? 0.12 : 0, muffle: 4, trans: 0.005, f: still(loc) });
        if (ph.kind === 'affricate') {
          push({ ...base, dur: dur*0.6, voice: ph.voiced ? 0.3 : 0, noise: ph.noise, trans: 0.02, f: still(loc) });
        } else if (released) {
          const [bf, bw, level, length] = BURSTS[ph.place];
          const burst = [bf || (loc[1] + loc[2])/2, bw, next ? level : level*0.6, length];
          const target = after?.f ?? loc;
          const toward = frac => loc.map((v, k) => v + (target[k] - v)*0.6*frac);
          if (ph.voiced) push({ ...base, dur: 0.012, voice: 0.3, burst, trans: 0.005, f: toward });
          else {
            // (a puff of breath before the voice comes in: long before a stressed vowel, barely any after an "s")
            const puff = prev?.name === 'S' ? 0.012 : nextPh?.kind === 'vowel' && next.stress ? 0.055 : nextPh ? 0.035 : 0.03;
            push({ ...base, dur: puff*tempo, breath: next ? 1 : 0.5, burst, trans: 0.005, f: toward });
          }
        }
      } else if (ph.kind === 'fric') {
        push({ ...base, dur, voice: ph.voiced ? 0.35 : 0, noise: ph.noise, muffle: ph.voiced ? 2 : 1, trans: 0.02,
          f: still(locus(ph.place, (after ?? before)?.f)) });
      } else if (ph.kind === 'flap') {
        push({ ...base, dur, voice: 0.35, muffle: 2, trans: 0.01, f: still(locus(ph.place)) });
      } else if (ph.kind === 'glottal') {
        push({ ...base, dur, trans: 0.005, f: still((before ?? after ?? PHONEMES.AX).f) });
      } else if (ph.kind === 'h') {
        // (breath through the mouth of whatever comes next)
        const f = ph.f ?? (nextPh?.f ?? (after ?? PHONEMES.AX).f);
        push({ ...base, dur, breath: 0.8, trans: 0.005, f: still(f) });
      }
    });
    const tail = segments.at(-1);
    if (tail) push({ ...base0(c), dur: (c < clauses.length - 1 ? PAUSE[clause.end] : 0.06)*tempo, f: frac => tail.f(1) });
  });
  return segments;
}
const base0 = clause => ({ voice: 0, breath: 0, noise: null, nasal: false, muffle: 1, burst: null, accent: 0, clause, trans: 0 });
const smooth = u => { u = Math.max(0, Math.min(1, u)); return u*u*(3 - 2*u); };

// Where the formants are at time t: each segment's own, glided into its neighbours' over the windows at its ends.
function formantsAt(segments, i, t) {
  const s = segments[i], prev = segments[i - 1], next = segments[i + 1];
  const edge = (a, b, boundary) => {
    const wa = Math.min(a.trans, 0.45*a.dur), wb = Math.min(b.trans, 0.45*b.dur);
    const u = (t - (boundary - wa))/(wa + wb || 1);
    const from = a.f(1 - wa/a.dur), to = b.f(wb/b.dur);
    return from.map((v, k) => v + (to[k] - v)*u);
  };
  if (prev && t < s.start + Math.min(s.trans, 0.45*s.dur)) return edge(prev, s, s.start);
  if (next && t > s.start + s.dur - Math.min(s.trans, 0.45*s.dur)) return edge(s, next, s.start + s.dur);
  return s.f((t - s.start)/s.dur);
}
// How much of something (voice, breath, hiss) there is at time t: each segment's own, ramped over a few ms at its ends.
function levelAt(segments, i, t, of, ramp = 0.006) {
  const s = segments[i], v = of(s);
  const prev = segments[i - 1], next = segments[i + 1];
  if (prev && t < s.start + ramp) return of(prev) + (v - of(prev))*(0.5 + (t - s.start)/(2*ramp));
  if (next && t > s.start + s.dur - ramp) return v + (of(next) - v)*(0.5 - (s.start + s.dur - t)/(2*ramp));
  return v;
}

// ------------------------------------------------------------ the sound
// A resonator (Klatt's): rings at F, as wide as BW, passing the lows untouched. As an antiresonator it takes a notch out
// instead.
function resonator() {
  let a = 1, b = 0, c = 0, y1 = 0, y2 = 0, x1 = 0, x2 = 0;
  return {
    set(F, BW) {
      F = Math.min(F, 0.45*SAMPLE_RATE);
      const r = Math.exp(-Math.PI*BW*T);
      c = -r*r; b = 2*r*Math.cos(2*Math.PI*F*T); a = 1 - b - c;
    },
    run(x) { const y = a*x + b*y1 + c*y2; y2 = y1; y1 = y; return y; },
    notch(x) { const y = (x - b*x1 - c*x2)/a; x2 = x1; x1 = x; return y; },
  };
}
// A band of noise, peaking at 1 at its centre whatever its width.
function band() {
  let b0 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    set(F, BW) {
      F = Math.min(F, 0.45*SAMPLE_RATE);
      const w = 2*Math.PI*F*T, alpha = Math.sin(w)*Math.sinh(Math.log(2)/2*(BW/F)*w/Math.sin(w)), n = 1 + alpha;
      b0 = alpha/n; a1 = -2*Math.cos(w)/n; a2 = (1 - alpha)/n;
    },
    run(x) { const y = b0*(x - x2) - a1*y1 - a2*y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; },
  };
}

/**
 * A line of text said in someone's babble voice.
 * @param {string} text
 * @param {{pitch: number, formant: number, sharpness: number, melody?: number}} voice - as for babble
 * @param {{mood?: number, who?: number}} [options] - their mood trait (the cheerier, the quicker), and a number of their
 *   own, so the same person always talks at the same pace
 * @returns {?Float32Array} its samples, at SAMPLE_RATE; or null, if there's nothing to say
 */
export function speakText(text, voice, { mood = 0, who = 0 } = {}) {
  const clauses = phonemesOf(text);
  if (!clauses.length) return null;
  const tempo = TEMPO/(1 + mood*0.08 + ((who*7) % 11 - 5)*0.015);
  const segments = plan(clauses, tempo);
  const end = segments.at(-1).start + segments.at(-1).dur;
  const samples = new Float32Array(Math.ceil(end*SAMPLE_RATE));
  const { pitch, formant = 1, sharpness = 6 } = voice;
  const width = Math.max(0.6, Math.min(1.8, 6/sharpness)); // (a sharper voice's formants ring narrower)
  const pitchOf = pitchContour(segments, clauses, pitch, melodyOf(voice));

  const formants = [0, 1, 2, 3].map(resonator), nasalPole = resonator(), nasalZero = resonator();
  const hiss = band(), click = band();
  const frame = Math.round(FRAME*SAMPLE_RATE);
  let i = 0, phase = 0, burst = null, f0 = pitch, voicedNoise = false;
  // (how much voice, breath and hiss: set each frame, and followed smoothly between, as a step would click)
  const levels = [0, 0, 0], targets = [0, 0, 0], follow = 1 - Math.exp(-T/0.002);
  const bursts = segments.filter(s => s.burst).map(s => ({ at: s.start, band: s.burst }));
  let nextBurst = 0;
  for (let n = 0; n < samples.length; n++) {
    const t = n*T;
    if (n % frame === 0) {
      while (i < segments.length - 1 && t >= segments[i].start + segments[i].dur) i++;
      const s = segments[i], [F1, F2, F3] = formantsAt(segments, i, t);
      const muffle = levelAt(segments, i, t, x => x.muffle, 0.01);
      formants[0].set(F1*formant, BANDWIDTHS[0]*width*(s.nasal ? 1.6 : 1));
      formants[1].set(F2*formant, BANDWIDTHS[1]*width*muffle);
      formants[2].set(F3*formant, BANDWIDTHS[2]*width*muffle);
      formants[3].set(F4*formant, BANDWIDTHS[3]*width*muffle);
      nasalPole.set(NASAL[0]*formant, 100);
      nasalZero.set((levelAt(segments, i, t, x => x.nasal ? NASAL[1] : NASAL[0], 0.01))*formant, 100);
      targets[0] = levelAt(segments, i, t, x => x.voice);
      targets[1] = levelAt(segments, i, t, x => x.breath);
      targets[2] = levelAt(segments, i, t, x => x.noise?.[2] ?? 0, 0.012);
      if (s.noise) hiss.set(s.noise[0]*Math.sqrt(formant), s.noise[1]);
      voicedNoise = s.voice > 0.2;
      f0 = pitchOf(t);
      if (nextBurst < bursts.length && t >= bursts[nextBurst].at) {
        burst = { ...bursts[nextBurst++], start: t };
        click.set(burst.band[0]*Math.sqrt(formant), burst.band[1]);
      }
    }
    for (let k = 0; k < 3; k++) levels[k] += (targets[k] - levels[k])*follow;
    const [voiceLevel, breath, noiseLevel] = levels;
    // the voice: a sawtooth, as babble's (its steps smoothed so they don't alias)
    const dt = f0*T;
    phase += dt;
    if (phase >= 1) phase -= 1;
    let saw = 2*phase - 1;
    if (phase < dt) { const u = phase/dt; saw -= u + u - u*u - 1; } else if (phase > 1 - dt) { const u = (phase - 1)/dt; saw -= u*u + u + u + 1; }
    const white = Math.random()*2 - 1;
    // through the mouth: the voice, and any breath, through the nasal pair and the formants in turn
    let x = voiceLevel*saw + breath*ASPIRATION*white;
    x = nasalZero.notch(nasalPole.run(x));
    for (const r of formants) x = r.run(x);
    let y = x*0.3;
    // the hiss, pulsing with the voice if it's voiced; and a stop's click
    if (noiseLevel) y += hiss.run(white)*noiseLevel*(voicedNoise ? (phase < 0.5 ? 1 : 0.4) : 1);
    if (burst) {
      const since = t - burst.start, [, , level, length] = burst.band;
      if (since > length) burst = null;
      else y += click.run(white)*level*Math.min(1, since/0.001)*(1 - since/length);
    }
    samples[n] = y;
  }
  // (made as loud as a line should be, softly held back from clipping, and faded at its ends)
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak ? 0.9/peak : 1, fade = Math.round(0.01*SAMPLE_RATE);
  for (let n = 0; n < samples.length; n++) {
    samples[n] = Math.tanh(samples[n]*gain*1.2)/Math.tanh(1.2)*Math.min(1, n/fade, (samples.length - n)/fade);
  }
  return samples;
}

// The pitch through the line, as babble's through a phrase: each clause in the speaker's melody, lifted on stressed
// syllables and wandering a little on each, and at the clause's end falling as far as the melody lets it, or rising for a
// question, a little for a clause to follow; the lot livelier with an exclamation. Smoothed, as a voice can't jump.
function pitchContour(segments, clauses, pitch, melody) {
  const step = 0.01, end = segments.at(-1).start + segments.at(-1).dur;
  const raw = new Float32Array(Math.ceil(end/step) + 1);
  const spans = clauses.map((_, c) => {
    const own = segments.filter(s => s.clause === c && (s.voice || s.breath));
    return own.length ? [own[0].start, own.at(-1).start + own.at(-1).dur] : [0, 1];
  });
  const lastVowels = clauses.map((_, c) => segments.findLast(s => s.clause === c && s.vowel));
  const wobble = new Map(segments.filter(s => s.vowel).map(s => [s, (Math.random()*2 - 1)*JITTER]));
  // (which syllable of its clause each vowel is, for a melody that goes syllable by syllable)
  const syllable = new Map(), counts = clauses.map(() => 0);
  for (const s of segments) if (s.vowel) syllable.set(s, counts[s.clause]++);
  let nth = 0;
  let i = 0;
  for (let k = 0; k < raw.length; k++) {
    const t = k*step;
    while (i < segments.length - 1 && t >= segments[i].start + segments[i].dur) i++;
    const s = segments[i], [from, to] = spans[s.clause], ending = clauses[s.clause].end, lively = ending === '!' ? 1.6 : 1;
    const through = Math.max(0, Math.min(1, (t - from)/(to - from || 1)));
    if (s.vowel) nth = syllable.get(s);
    let f = pitch*(1 + melody.shape(through, nth))*(ending === '!' ? 1.08 : 1);
    if (s.accent) f *= 1 + STRESS*lively*s.accent*Math.sin(Math.PI*Math.min(1, (t - s.start)/s.dur*0.8 + 0.2));
    if (s.vowel) f *= 1 + wobble.get(s);
    const last = lastVowels[s.clause];
    if (last && t >= last.start) {
      const u = Math.min(1, (t - last.start)/(last.dur || 1));
      f *= ending === '?' ? 1 + 0.3*u : ending === ',' || ending === '-' ? 1 + 0.06*u : 1 - 0.2*melody.fall*u;
    }
    raw[k] = f;
  }
  const smoothed = new Float32Array(raw.length);
  let v = raw[0];
  for (let k = 0; k < raw.length; k++) smoothed[k] = v += (raw[k] - v)*0.35;
  return t => { const k = Math.min(raw.length - 1, t/step), j = Math.floor(k); return smoothed[j] + ((smoothed[j + 1] ?? smoothed[j]) - smoothed[j])*(k - j); };
}
