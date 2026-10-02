// ============================================================ accents
// How someone's real words come out (audio/speech.js): SAM's American phonemes rewritten per accent — sounds swapped,
// dropped or added, vowels given their own formants (p.f, p.to: null for a pure vowel) — and, for some, the stress moved.
// Babble's unaffected. Picked per person in people.js voiceOf (ACCENT_SHARE); none is plain SAM.
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
// French stresses each word's last vowel, and nothing else in it
const LAST_STRESS = new Set(['french']);

export const ACCENTS = ['none', ...Object.keys(RULES)];
/** Share of people with each accent; the rest have none. */
export const ACCENT_SHARE = { cockney: 0.15, scottish: 0.15, french: 0.1, german: 0.1 };
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
