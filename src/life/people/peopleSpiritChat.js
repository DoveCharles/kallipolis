import { S } from '../../core/shared.js';
import { sayLine, lineMouth, stopLine } from '../../audio/dictionary.js';
import { speechBubble, hasBubble } from '../../ui/speech-bubbles.js';
import { LOOK_MAX_TURN } from './peopleModel.js';

// The spirits trait's shoulder ghosts (peopleSpirits.js) talk with whoever they're on, while that person's on their own:
// the three as one conversation (a stand-in group, never in the crowd's groups, so anyone can still start a chat with
// them, which ends this one). Each spirit is a stand-in person made from them (Object.create), with its own traits —
// gold good and happy, purple evil and angry — said in their voice, higher, with a bubble over its shoulder and its own
// mouth (instanceSpirit in the spirit shader). The person turns to whichever is talking, or they're talking to.

const TRY_EVERY = 0.4;      // seconds between tries at a line (sayLine has its own chance and gaps)
const SPIRIT_PITCH = 1.4;   // their voices, × the person's pitch
const SPIRIT_SIDE = 0.18, SPIRIT_RISE = -0.05; // where their bubbles point: out to the side and above the person's, × the person's height
const GAZE = 0.9;           // how far round the person turns to a spirit, × LOOK_MAX_TURN
const SPIRITS = [ // side: 1 their left (as peopleSpirits.js); k: the instanceSpirit component that's its mouth
  { key: 'gold', side: -1, k: 0, traits: { mood: 1, evil: -1, happy: 1, angry: 0, sad: 0 } },
  { key: 'purple', side: 1, k: 1, traits: { mood: -0.5, evil: 1, angry: 1, happy: 0 } },
];

/**
 * Each frame, for anyone who might have spirits: start, carry on or end their talk with them.
 * @param {object} p - the person
 * @param {number} i - their index
 * @param {number} dt - seconds since last frame
 * @param {object} o
 * @param {boolean} o.free - on their own and able to talk (not possessed, fleeing, frozen, ranting; drawn)
 * @param {{pitch: number}} o.voice - their voice (voiceOf)
 * @param {{x: number, y: number, z: number}} o.head - their head
 * @param {?{x: number, y: number, z: number}} o.bubble - where their bubble points, or null if bubbles aren't shown for them
 * @param {Float32Array} [o.mouths] - instanceSpirit's array (two per person: gold's mouth, purple's)
 * @returns {void}
 */
export function updateSpiritChat(p, i, dt, { free, voice, head, bubble, mouths }) {
  const chat = p.spiritChat;
  if (!p.traits.spirits || !free) {
    if (chat?.on) endChat(p, chat, mouths, i);
    return;
  }
  const c = chatOf(p), t = performance.now()/1000;
  c.on = true;
  // (spirit traits follow the person's: rebuilt when theirs are)
  if (c.traits !== p.traits) { c.traits = p.traits; c.spirits.forEach((s, k) => { s.traits = { ...p.traits, ...SPIRITS[k].traits, spirits: 0 }; }); }
  for (const s of c.spirits) {
    if (s.saying) { const mouth = lineMouth(s.saying); s.talkTo = mouth < 0 ? 0 : mouth; if (mouth < 0) s.saying = null; } else s.talkTo = 0;
    s.talk += (s.talkTo - s.talk)*Math.min(1, dt*20);
    if (mouths) mouths[i*2 + s.k] = s.talk;
    if (bubble && (s.saying || hasBubble(s))) speechBubble(s, spotOf(p, s, bubble), s.saying);
  }
  if (p.saying !== c.ownLine) c.ownLine = null; // (theirs ended, or something else took over)
  const speaker = c.spirits.find(s => s.saying) ?? (c.ownLine ? p : null);
  // (turned to whoever's talking, or who they're talking to)
  const facing = speaker && speaker !== p ? speaker : speaker === p ? c.ownTo : null;
  p.spiritGaze = facing ? facing.side*GAZE*LOOK_MAX_TURN : null;
  if (speaker || p.saying || t < c.nextTry) return;
  c.nextTry = t + TRY_EVERY;
  // (a reply's due from whoever was spoken to, else anyone but who spoke; a fresh line from anyone)
  const talk = c.talk && t < c.talk.expires ? c.talk : null;
  const who = talk ? talk.to ?? any(c.members.filter(m => m !== talk.by)) : any(c.members);
  const to = who === p ? any(c.spirits) : Math.random() < 0.7 ? p : c.spirits.find(s => s !== who);
  if (who === p) {
    const was = [p.group, p.lookAt];
    p.group = c; p.lookAt = to;
    const line = sayLine(head, voice, i, p);
    [p.group, p.lookAt] = was;
    if (line) { p.saying = c.ownLine = line; p.shouting = true; c.ownTo = to; } // (shouting: people.js plays it out as a line outside any group)
  } else {
    who.lookAt = to;
    who.saying = sayLine(bubble ? spotOf(p, who, bubble) : head, { ...voice, pitch: voice.pitch*SPIRIT_PITCH }, i*3 + 1 + who.k, who);
  }
}

// their stand-in group and spirits, made the first time
function chatOf(p) {
  if (p.spiritChat) return p.spiritChat;
  const c = { kind: 'spirits', members: [p], talk: null, quietUntil: 0, nextTry: 0, on: false, traits: null, ownLine: null, ownTo: null };
  c.spirits = SPIRITS.map(({ key, side, k }) => Object.assign(Object.create(p), {
    spiritOf: p, spirit: key, side, k, group: c, saying: null, talk: 0, talkTo: 0, lookAt: null, greetTo: null, closing: false, choosing: null, seen: null, felt: null,
  }));
  c.members.push(...c.spirits);
  return p.spiritChat = c;
}

function endChat(p, c, mouths, i) {
  c.on = false; c.talk = null; c.ownLine = null; p.spiritGaze = null;
  c.spirits.forEach(s => { stopLine(s.saying); s.saying = null; s.talk = 0; if (mouths) mouths[i*2 + s.k] = 0; });
}

// over a spirit's shoulder: out to that side of where the person's bubble points, a little higher
function spotOf(p, s, at) {
  const h = 1.75*p.height*S.peopleSize, out = s.side*SPIRIT_SIDE*h;
  return { x: at.x + Math.cos(p.heading)*out, y: at.y + SPIRIT_RISE*h, z: at.z - Math.sin(p.heading)*out };
}

const any = list => list[Math.floor(Math.random()*list.length)];
