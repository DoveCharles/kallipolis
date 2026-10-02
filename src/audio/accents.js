// ============================================================ accents
// How someone's real words come out (audio/speech.js): SAM's American phonemes rewritten per accent — sounds swapped,
// dropped or added, vowels given their own formants (p.f, p.to: null for a pure vowel) — and, for some, the stress moved.
// Babble keeps only the accent's tune (audio/melodies.js ACCENT_MELODIES). Picked per person in people.js voiceOf (ACCENT_SHARE); none is plain SAM.
const VOWELS = new Set(['IY', 'IH', 'EH', 'AE', 'AA', 'AH', 'AO', 'UH', 'AX', 'IX', 'ER', 'UX', 'OH', 'EY', 'AY', 'OY', 'AW', 'OW', 'UW']);
const isVowel = p => !!p && VOWELS.has(p.name);
const as = (p, name, more) => ({ ...p, name, ...more });
const extra = (p, name) => ({ name, stress: 0, word: p.word });

// Each rule: (phoneme, prev, next, {start, end} of its word) → it changed, a list in its place, null to drop it, or
// undefined to keep it
const RULES = {
  cockney(p, prev, next, { start, end }) {
    switch (p.name) {
      case '/H': return null;                                       // 'ouse
      case 'TH': return as(p, 'F');                                 // fink
      case 'DH': return as(p, start ? 'D' : 'V');                   // dat, muvver
      case 'DX': return as(p, 'Q');                                 // wa'er
      case 'T': return isVowel(prev) && (end || isVowel(next)) ? as(p, 'Q') : undefined;
      case 'R': case 'RX': return isVowel(next) ? undefined : null; // no r after a vowel
      case 'LX': return end || !isVowel(next) ? as(p, 'WX') : undefined; // miwk
      case 'ER': return { ...p, f: [520, 1400, 2450] };
      case 'EY': return { ...p, f: [680, 1350, 2450], to: [420, 1950, 2600] }; // mate → mite
      case 'AY': return { ...p, f: [600, 950, 2400], to: [420, 1900, 2550] };  // like → loike
      case 'OW': return { ...p, f: [680, 1250, 2450], to: [450, 1050, 2350] }; // no → now
      case 'IY': return { ...p, f: [420, 1900, 2550], to: [280, 2250, 2950] }; // bee → bəi
    }
  },
  scottish(p, prev, next, { end }) {
    switch (p.name) {
      case 'R': case 'RX': return as(p, 'DX');                       // tapped r, after a vowel too
      case 'ER': return [as(p, 'EH', { f: [500, 1700, 2450] }), extra(p, 'DX')];
      case 'DX': return as(p, 'Q');
      case 'T': return isVowel(prev) && (end || isVowel(next)) ? as(p, 'Q') : undefined;
      case 'EY': return { ...p, f: [430, 2000, 2600], to: null };    // pure "e"
      case 'OW': return { ...p, f: [450, 850, 2350], to: null };     // pure "o"
      case 'AW': return as(p, 'UW', { f: [330, 1400, 2250], to: null }); // hoose
      case 'UW': return { ...p, f: [330, 1500, 2250], to: null };    // fronted "oo"
      case 'AY': return { ...p, f: [580, 1350, 2450], to: [400, 2000, 2600] };
      case 'AE': return { ...p, f: [720, 1300, 2450] };
    }
  },
  welsh(p, prev, next, { end }) {
    // (a consonant after a stressed vowel, before another, held long: "mun-ney")
    const held = isVowel(prev) && prev.stress === 1 && isVowel(next) && !isVowel(p) && !end && prev.word === p.word;
    switch (p.name) {
      case 'DX': return held ? [as(p, 'T'), as(p, 'T')] : as(p, 'T');
      case 'R': case 'RX': return isVowel(next) ? as(p, 'DX') : null; // tapped, none after a vowel
      case 'ER': return { ...p, f: [500, 1600, 2450] };
      case 'EY': return { ...p, f: [430, 2000, 2600], to: null };    // pure "e"
      case 'OW': return { ...p, f: [450, 850, 2350], to: null };     // pure "o"
      case 'AY': return { ...p, f: [600, 1300, 2450], to: [420, 1950, 2600] };
      case 'AH': return { ...p, f: [520, 1350, 2450] };
    }
    if (held) return [p, p];
  },
  irish(p) {
    switch (p.name) {
      case 'TH': return as(p, 'T');                                  // tink
      case 'DH': return as(p, 'D');                                  // dat
      case 'DX': return as(p, 'T');                                  // a crisp "t", not a flap
      case 'LX': return as(p, 'L');                                  // clear "l" throughout
      case 'EY': return { ...p, f: [430, 2000, 2600], to: null };    // pure "e"
      case 'OW': return { ...p, f: [450, 850, 2350], to: null };     // pure "o"
      case 'AY': return { ...p, f: [600, 1000, 2400], to: [420, 1900, 2550] }; // noice
      case 'AE': return { ...p, f: [720, 1350, 2450] };
    }
  },
  australian(p, prev, next) {
    switch (p.name) {
      case 'R': case 'RX': return isVowel(next) ? undefined : null; // no r after a vowel
      case 'ER': return { ...p, f: [520, 1450, 2450] };
      case 'EY': return { ...p, f: [650, 1500, 2450], to: [400, 2000, 2600] }; // mate → mite
      case 'AY': return { ...p, f: [650, 950, 2400], to: [420, 1900, 2550] };  // like → loike
      case 'IY': return { ...p, f: [420, 1900, 2550], to: [280, 2250, 2950] }; // bee → bəi
      case 'OW': return { ...p, f: [600, 1250, 2450], to: [420, 1400, 2300] }; // no → naʉ
      case 'AW': return { ...p, f: [700, 1700, 2450], to: [450, 1000, 2350] }; // how → hæo
      case 'UW': return { ...p, f: [330, 1500, 2250], to: [300, 1600, 2250] }; // fronted "oo"
      case 'AE': return { ...p, f: [600, 1800, 2500] };                        // raised "a"
    }
  },
  manc(p, prev, next, { end }) {
    // (a drawl: stressed vowels long, a word's last longer still)
    const long = isVowel(p) ? (p.stress === 1 ? 1.4 : 1) * (end ? 1.3 : 1) : undefined;
    const drawn = more => ({ ...p, long, ...more });
    switch (p.name) {
      case '/H': return null;                                       // 'ouse
      case 'DX': return as(p, 'Q');                                 // wa'er
      case 'T': return isVowel(prev) && (end || isVowel(next)) ? as(p, 'Q') : undefined;
      case 'R': case 'RX': return isVowel(next) ? undefined : null; // no r after a vowel
      case 'NX': return end ? prev?.stress === 1 ? [p, extra(p, 'G')] : as(p, 'N') : undefined; // sing-g, but singin'
      case 'AH': return as(p, 'UH', { f: [360, 900, 2250], long: (long ?? 1)*1.2 }); // buns like boons
      case 'AX': case 'ER': return end ? drawn({ name: 'AH', f: [680, 1250, 2450] }) : drawn({ f: [500, 1500, 2450] }); // lettah, werk
      case 'EY': return drawn({ f: [450, 1950, 2550], to: null });  // a long pure "e"
      case 'OW': return drawn({ f: [520, 850, 2400], to: null });   // a long "aw" for "oh"
      case 'AY': return drawn({ f: [720, 1000, 2450], to: [450, 1800, 2550] }); // shoine, drawn out
      case 'IY': return end ? drawn({ name: 'EH', f: [520, 1800, 2500] }) : drawn(); // happeh
    }
    if (long) return drawn();
  },
  japanese(p, prev, next, { end }) {
    const sound = japaneseSound(p, next);
    if (sound === null) return null;
    const said = sound ?? p;
    if (isVowel(said) || said.name === 'N' || said.name === 'Q') return said;
    if (said.name === 'M') return end || !isVowel(next) ? as(said, 'N') : said; // only "n" closes a syllable
    if (!end && (isVowel(next) || GLIDES.has(next?.name) || GLIDES.has(said.name))) return said;
    // (a vowel after any other consonant with none after it: desuku, sutoriito)
    const v = said.name === 'T' || said.name === 'D' ? 'OH' : said.name === 'CH' || said.name === 'J' || said.name === 'SH' ? 'IY' : 'UH';
    return [said, { name: v, stress: 0, word: p.word, ...(v === 'UH' ? JAPANESE_U : {}) }];
  },
  french(p, prev, next) {
    switch (p.name) {
      case '/H': return null;
      case 'TH': return as(p, 'S');                                  // sink
      case 'DH': return as(p, 'Z');                                  // ze
      case 'R': case 'RX': return as(p, 'RU');                       // throat r
      case 'ER': return [as(p, 'EH', { f: [480, 1500, 2400] }), extra(p, 'RU')];
      case 'DX': return as(p, 'T');
      case 'IH': return as(p, 'IY');                                 // sheep for ship
      case 'UH': return as(p, 'UW', { to: null });
      case 'AE': return { ...p, f: [700, 1450, 2450] };
      case 'EY': return { ...p, f: [430, 2000, 2600], to: null };
      case 'OW': return { ...p, f: [430, 800, 2350], to: null };
      case 'UW': return { ...p, to: null };
    }
  },
  german(p, prev, next, word) {
    const said = germanSound(p, prev, next, word);
    return word.start && isVowel(p) ? [extra(p, 'Q'), ...[said ?? p].flat()] : said; // a hard start to a vowel
  },
};
function germanSound(p, prev, next, { start, end }) {
  const voiced = isVowel(next) && !end;
  switch (p.name) {
    case 'W': case 'WX': return as(p, 'V');                        // vat
    case 'TH': return as(p, 'S');
    case 'DH': return as(p, 'Z');
    case 'J': return as(p, 'CH');
    case 'B': return end ? as(p, 'P') : undefined;                 // finals unvoiced
    case 'D': return end ? as(p, 'T') : undefined;
    case 'G': case 'GX': return end ? as(p, 'K') : undefined;
    case 'Z': return end ? as(p, 'S') : undefined;
    case 'V': return end ? as(p, 'F') : undefined;
    case 'S': return start && voiced ? as(p, 'Z') : undefined;     // zo
    case 'R': case 'RX': return isVowel(prev) && !isVowel(next) ? as(p, 'AX', { stress: 0 }) : as(p, 'RU');
    case 'ER': return as(p, 'AX', { f: [550, 1300, 2400] });
    case 'DX': return as(p, 'T');
    case 'AE': return as(p, 'EH');
    case 'EY': return { ...p, f: [430, 2000, 2600], to: null };
    case 'OW': return { ...p, f: [430, 800, 2350], to: null };
  }
}
// A voice made to suit its accent (people.js voiceOf): Manc's nasal
export const accentVoice = v => v.accent === 'manc' ? { ...v, sharpness: Math.max(v.sharpness, 10) } : v;
const GLIDES = new Set(['Y', 'YX', 'W', 'WX']);
const JAPANESE_U = { f: [350, 1300, 2300], to: null }; // unrounded "u"
const BEFORE_I = { S: 'SH', T: 'CH', D: 'J', Z: 'J' };   // shi, chi, ji
// five vowels, evenly timed (every one lightly stressed); r and l one tap; no th, v or ng
function japaneseSound(p, next) {
  const even = { stress: 2 };
  switch (p.name) {
    case 'TH': return as(p, 'S');
    case 'DH': return as(p, 'Z');
    case 'V': return as(p, 'B');
    case 'R': case 'RX': case 'L': case 'LX': return as(p, 'DX');
    case 'NX': return as(p, 'N');
    case 'S': case 'T': case 'D': case 'Z': return next?.name === 'IY' || next?.name === 'IH' ? as(p, BEFORE_I[p.name]) : undefined;
    case 'AE': case 'AH': case 'AA': case 'AX': return as(p, 'AA', even);
    case 'AO': return as(p, 'OH', { ...even, long: 1.3 });
    case 'ER': return as(p, 'AA', { ...even, long: 1.5 });  // "aa"
    case 'IH': case 'IX': case 'IY': return as(p, 'IY', even);
    case 'UH': case 'UW': case 'UX': return as(p, 'UH', { ...even, ...JAPANESE_U });
    case 'EH': return { ...p, ...even };
    case 'EY': return as(p, 'EH', { ...even, long: 1.4 });  // a long "e"
    case 'OW': return as(p, 'OH', { ...even, long: 1.4 });  // a long "o"
    case 'AY': case 'AW': case 'OY': return { ...p, ...even };
  }
}
// French stresses each word's last vowel, and nothing else in it
const LAST_STRESS = new Set(['french']);

export const ACCENTS = ['none', ...Object.keys(RULES)];
/** Share of people with each accent; the rest have none. */
export const ACCENT_SHARE = { cockney: 0.1, scottish: 0.08, french: 0.08, german: 0.08, welsh: 0.08, irish: 0.08, australian: 0.08, manc: 0.08 }; // (japanese: Miku's only, people/presets.js)
/** An accent for a roll u in [0, 1). */
export function accentFor(u) {
  for (const [name, share] of Object.entries(ACCENT_SHARE)) if ((u -= share) < 0) return name;
  return 'none';
}

/**
 * phonemesOf's clauses said in an accent (new lists; the old left alone).
 * @param {{phonemes: object[], end: string}[]} clauses
 * @param {string} [accent]
 */
export function accented(clauses, accent) {
  const rule = RULES[accent];
  if (!rule) return clauses;
  return clauses.map(clause => {
    const list = clause.phonemes, out = [];
    list.forEach((p, i) => {
      const prev = list[i - 1], next = list[i + 1];
      const said = rule(p, prev, next, { start: prev?.word !== p.word, end: next?.word !== p.word });
      if (said === null) return;
      out.push(...[said ?? p].flat().map(q => ({ ...q })));
    });
    if (LAST_STRESS.has(accent)) {
      for (const words of Map.groupBy(out.filter(isVowel), p => p.word).values()) {
        if (words.length < 2) continue;
        words.forEach((v, k) => { v.stress = k === words.length - 1 ? 1 : 0; });
      }
    }
    return { ...clause, phonemes: out };
  });
}
