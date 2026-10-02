import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { listener, playBufferAt, muffler, ear, isMuted } from './sfx.js';
import { lineSound, lineLength, phonemesOf, SAMPLE_RATE, MOUTH_FRAME } from './speech.js';
import { accented } from './accents.js';
import { loudnessOf, hearDistance, hearRef, edgeFade } from './voices.js';
import { speechReady, pickCall, pickReply, pickReplyChoices, pickReaction, pickCloser, pickGreeting, pickShout, pickWord, hasNews } from '../life/speech-text.js';

// ============================================================ real words
// Now and then someone talking near the camera says something real in among their babble (see audio/voices.js): a line
// from the speech files (see life/speech-text.js and assets/text/speech/), picked to suit them. It's said in their own
// babble voice, worked out into its sounds and synthesized off the page (see audio/speech.js, speech-worker.js), set down where they stand
// and heard from that side, and quieter the further off, and as loud as they babble. Up to MAX_LINES are said at
// once (any number with Options > Speech > Babble only as fallback), and each conversation waits LINE_GAP after a line before opening another. While they're saying it, their mouth opens as wide as the line's loud.
// A line with replies waits for one: the next in their group to speak (within REPLY_WINDOW) says a reply, picked for
// them, and so on down the conversation (group.talk). Someone who's just seen a death says something about it first.
const LINE_CHANCE = 0.15;   // at the start of each phrase of babble (× chat speed, Options > Speech: S.chatSpeed)
const LINE_GAP = 3;         // seconds after a line ends before its conversation opens another (÷ chat speed)
const LINE_START_GAP = 0.15; // seconds between any two lines starting (a burst of them to synthesize at once)
const CROWD_EASY = 3;       // lines at once before each is made quieter (by the square root of how many more), so a crowd doesn't clip
const MAX_LINES = 4;        // real lines said at once, at most (each is synthesized as it starts) — no limit with babble only as fallback
const REPLY_WINDOW = 6;     // seconds after a line ends that a reply to it can still come (started again while only the line limit holds it up)
const CHOICE_WAIT = 60;     // seconds a conversation waits for the possessed person's picked reply (Options > Game > Dialogue Choices)
const MATCH = 1;            // how loud a real line is next to the speaker's own babble (see loudnessOf in audio/voices.js)
const MUFFLE = 1.4; // (as for babble; beyond its hearDistance they only babble)
const MAKING_MAX = 2;       // seconds a line waits to be made before it's given up on
const SILENT_LINE = 1.5;    // seconds a line with nothing to sound out ("...") is held for

let lastStart = -Infinity;
const speaking = new Set(); // { source, start, length, mouth: Float32Array, text, quiet } for each line being said (source and mouth null while it's made)
// (a conversation's gap is kept on its group — or on the speaker, with none — as quietUntil)
const quietOf = person => person.group ?? person;

const chatSpeed = () => S.chatSpeed ?? 1;

/**
 * At the start of a phrase of someone's babble, maybe have them say a real line instead: about a death they've just
 * seen; else a reply, if the last line in their group is waiting for one; else, now and then, a new one.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice - their voice, as for babble
 * @param {number} who - a number of their own, so the same person always sounds the same
 * @param {object} person - the speaker (traits, loves, hates, group)
 * @returns {?object} the line being said (for lineMouth and stopLine; `text` is what's said); or null, for them to babble on
 */
export function sayLine(at, voice, who, person) {
  const context = listener.context, now = context.currentTime;
  resumeTalk(person.group, now);
  if ((!S.babbleFallbackOnly && speaking.size >= MAX_LINES) || !speechReady() || now - lastStart < LINE_START_GAP) {
    // (a reply held up only by the line limit keeps its place: its window starts again, so a busy scene ends no dialogue)
    const due = person.group?.talk;
    if (due && due.by !== person && (!due.to || due.to === person) && now < due.until && Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) <= hearDistance()) {
      const more = Math.max(0, now + REPLY_WINDOW - due.until);
      due.until += more; due.expires += more;
    }
    return null;
  }
  if (Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) > hearDistance()) return null;
  const group = person.group, talk = group?.talk;
  // (a death they've just seen comes first, straight away: see pickReaction)
  // (who they're talking to, for other. tags: whoever said the line they're replying to, else whoever they're facing)
  const facing = group?.members.includes(person.lookAt) ? person.lookAt : null;
  let said = pickReaction(person, facing);
  // (someone's just joined their circle: see welcome in life/people/peopleActivities.js)
  const greet = person.greetTo;
  let greeted = false, replying = false;
  if (greet && (performance.now()/1000 > greet.until || !group?.members.includes(greet.who))) person.greetTo = null;
  else if (!said && greet) { said = pickGreeting(person, greet.who); person.greetTo = null; greeted = !!said; }
  // (a dialogue stays between the two it started with: only whoever was spoken to answers — see takeTurns)
  if (!said && talk && talk.by !== person && (!talk.to || talk.to === person) && now < talk.until) {
    // (possessed, with Options > Game > Dialogue Choices: several replies wait for the player's pick — person.choosing,
    // shown by ui/speech-bubbles.js ownLine — the dialogue held till then)
    if (S.dialogueChoices && person.mode === 'possessed') {
      const choosing = person.choosing?.talk === talk ? person.choosing : null;
      if (choosing && choosing.picked == null) return null;
      const options = choosing ? null : pickReplyChoices(talk.replies, person, talk.vars, talk.by);
      if (options?.length > 1) {
        person.choosing = { talk, options, index: 0, picked: null };
        talk.to = person; talk.until = now + CHOICE_WAIT; talk.expires = performance.now()/1000 + CHOICE_WAIT;
        return null;
      }
      said = choosing ? choosing.options[choosing.picked] : options[0] ?? null;
      person.choosing = null; group.talk = null; replying = !!said;
    } else { said = pickReply(talk.replies, person, talk.vars, talk.by); group.talk = null; replying = !!said; }
  }
  // (a conversation whose time is up wants a closer, or someone leaving a circle does: see updateGroups and the circle's
  // 'sit' stage in life/people/peopleActivities.js)
  if (!said && (group?.wantsEnd || person.closing)) said = pickCloser(person, facing);
  if (!said) {
    // (no new call over a dialogue under way, or one held: it'd cut in — see resumeTalk)
    if ((group?.talk && now < group.talk.until) || group?.held?.length) return null;
    // (with Options > Speech > Babble only as fallback, every phrase tries for a real line: see linePause)
    if (now < (quietOf(person).quietUntil ?? 0) || (!S.babbleFallbackOnly && Math.random() >= LINE_CHANCE*chatSpeed())) return null;
    said = pickCall(person, facing);
  }
  if (!said) return null;
  const line = voiceLine(said, at, voice, who, person);
  if (line && group && said.score) group.score = (group.score ?? 0) + said.score; // (see {score}: how the conversation's going)
  if (line && group) {
    const pending = talk && now < talk.until && group.talk === talk;
    const next = said.replies.length && !said.end ? { replies: said.replies, vars: said.vars, by: person, to: replying ? talk.by : greeted ? greet.who : facing,
      until: now + line.length + REPLY_WINDOW, expires: performance.now()/1000 + line.length + REPLY_WINDOW } : null;
    // (a line between a dialogue's lines — a greeting for a newcomer, a reaction: the dialogue's held while any exchange
    // it starts runs, then picked up by the two who were in it: resumeTalk)
    if (pending && !replying) {
      if (next) { (group.held ??= []).push(talk); group.talk = next; }
      else { talk.until += line.length; talk.expires += line.length; }
    } else group.talk = next;
  }
  return line;
}

// A dialogue held for a line between (see sayLine) picked up again once that exchange is over and no one in the group is
// mid-line: its answer's due afresh from whoever it was waiting on. Dropped if either of the two has left.
function resumeTalk(group, now) {
  if (!group?.held?.length || (group.talk && now < group.talk.until)) return;
  for (const line of speaking) if (group.members.includes(line.by)) return;
  const talk = group.held.pop();
  if (!group.members.includes(talk.by) || (talk.to && !group.members.includes(talk.to))) { group.talk = null; return; }
  group.talk = { ...talk, until: now + REPLY_WINDOW, expires: performance.now()/1000 + REPLY_WINDOW };
}

/**
 * Someone calling something out, outside any conversation — as they run from something (fleeing.txt: see
 * beginFleeing in life/people/people.js) — within the same limits as any line.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice - their voice
 * @param {number} who - a number of their own
 * @param {object} person - the speaker
 * @param {string} category - the speech category to call out from
 * @param {boolean} [full] - at full volume, past the line limit (a watched prayer: see life/people/peoplePrayer.js)
 * @returns {?object} the line being said, as sayLine's; or null if one can't be had just now
 */
export function shoutLine(at, voice, who, person, category, full = false) {
  const now = listener.context.currentTime;
  if (!speechReady() || (!full && ((!S.babbleFallbackOnly && speaking.size >= MAX_LINES) || now - lastStart < LINE_START_GAP))) return null;
  if (Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) > hearDistance()) return null;
  const said = pickShout(person, category);
  return said ? voiceLine(said, at, voice, who, person, full) : null;
}

/**
 * Someone on their own reacting to what they've just seen or felt (reactions.txt): said aloud, unless the line's tagged
 * {thought} or they're out of hearing, when it's a thought instead. Waits (null) while too many lines are going or one's
 * just started, so its turn comes round.
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice
 * @param {number} who
 * @param {object} person
 * @returns {?object} a line being said, or { text, thought: true }, or null
 */
export function reactAloud(at, voice, who, person) {
  const now = listener.context.currentTime, heard = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) <= hearDistance();
  if (!hasNews(person) || (heard && ((!S.babbleFallbackOnly && speaking.size >= MAX_LINES) || now - lastStart < LINE_START_GAP))) return null;
  const said = pickReaction(person);
  if (!said) return null;
  if (said.thought || !heard) return { text: said.text, thought: true };
  return voiceLine(said, at, voice, who, person) ?? { text: said.text, thought: true };
}

// A picked line set making in the speaker's voice, to play where they are once it's made: the line (for lineMouth and
// stopLine; its length known now, its sound and start once made), or null.
function voiceLine(said, at, voice, who, person, full = false) {
  const context = listener.context, now = context.currentTime, text = said.text, mood = person.traits?.mood ?? 0, speed = person.traits?.speed ?? 1;
  if (isMuted() || context.state !== 'running') return null;
  const clauses = accented(phonemesOf(text), voice.accent), length = lineLength(clauses, { mood, who, speed });
  if (!length) { // (nothing to sound out, "...": a silent beat, its bubble up and mouth shut, so the conversation goes on)
    const line = { source: null, start: now, length: SILENT_LINE, mouth: new Float32Array(0), text, quiet: quietOf(person), end: said.end, by: person };
    speaking.add(line);
    lastStart = now;
    return line;
  }
  const crowd = full ? 1 : edgeFade(at)/Math.sqrt(Math.max(1, (speaking.size + 1)/CROWD_EASY)); // (and fading towards the hearing distance: see edgeFade)
  // (a line tagged {end} ends its conversation once it's said: see finish)
  const line = { source: null, start: now, length, mouth: null, text, quiet: quietOf(person), end: said.end, by: person };
  speaking.add(line);
  lastStart = now;
  synth(voice, { mood, who, speed, clauses }, sound => {
    if (!speaking.has(line)) return; // (stopped while it was made)
    if (!sound || !(line.source = playSound(sound, at, voice, crowd))) { finish(line); return; }
    line.mouth = sound.mouth;
    line.start = context.currentTime;
  });
  return line;
}
const playSound = ({ buffer, rms }, at, voice, scale) =>
  playBufferAt(buffer, at, rms ? MATCH*loudnessOf(voice)/rms*scale : 0, hearRef(), hearDistance(), 1, [muffler(at, hearRef(), MUFFLE)], 'peds');

// A line made in a voice (speech.js lineSound) in speech-worker.js, handed to `done` as { buffer, mouth, rms }, or null.
// (Made here, all at once, if there's no worker: a stall of a few to tens of milliseconds a line.)
let worker = null, workerFailed = false, jobs = 0;
const waiting = new Map(); // job id → its done, and what it was for (to make here if the worker fails)
function synth(voice, options, done) {
  if (!workerFailed) try {
    worker ??= Object.assign(new Worker(new URL('./speech-worker.js', import.meta.url), { type: 'module' }), {
      onmessage: ({ data: { id, sound } }) => { const job = waiting.get(id); waiting.delete(id); job?.done(bufferOf(sound)); },
      onerror: () => { workerFailed = true; waiting.forEach(job => job.done(bufferOf(lineSound(job.voice, job.options)))); waiting.clear(); },
    });
    waiting.set(++jobs, { done, voice, options });
    worker.postMessage({ id: jobs, voice, options });
    return;
  } catch { workerFailed = true; }
  done(bufferOf(lineSound(voice, options)));
}
function bufferOf(sound) {
  if (!sound) return null;
  const buffer = listener.context.createBuffer(1, sound.samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(sound.samples);
  return { buffer, mouth: sound.mouth, rms: sound.rms };
}

/**
 * Rushed (possession.js rushed), possessed: a stream of drawn-out "aa"s, random consonant noises and [swears] in their voice,
 * outside any conversation.
 * @param {object} person
 * @param {{x: number, y: number, z: number}} at - their head
 * @param {{pitch: number, formant: number, sharpness: number}} voice
 * @param {number} who
 * @param {boolean} swears - whether [swears] come into it (hatespossessed; not terrified)
 * @returns {number} how wide their mouth is, 0 to 1
 */
export function aaa(person, at, voice, who, swears) {
  const now = listener.context.currentTime, a = person.aaa;
  if (a && !a.mouth && now - a.start < MAKING_MAX) return 0; // (still being made)
  if (a?.mouth && now - a.start < a.length) return Math.min(1, a.mouth[Math.floor((now - a.start)/MOUTH_FRAME)] ?? 0);
  if (isMuted() || listener.context.state !== 'running') return 0;
  const made = person.aaa = { mouth: null, start: now, length: 0 };
  synth(voice, { mood: person.traits?.mood ?? 0, speed: person.traits?.speed ?? 1, who, clauses: rant(swears) }, sound => {
    if (person.aaa !== made) return;
    if (!sound) { person.aaa = null; return; }
    playSound(sound, at, voice, edgeFade(at));
    Object.assign(made, { mouth: sound.mouth, start: listener.context.currentTime, length: sound.buffer.duration });
  });
  return 0;
}
const RANT_CONSONANTS = ['B', 'D', 'G', 'K', 'P', 'T', 'M', 'N', '/H', 'F', 'S', 'SH', 'CH', 'J', 'V', 'Z', 'R', 'L', 'W'];
const RANT_VOWELS = ['AA', 'AA', 'AE', 'AH', 'AO', 'EH', 'IY', 'UW'];
const SWEAR_CHANCE = 0.6, RANT_PACE = 3; // (RANT_PACE: how many times faster than speech the nonsense is; swears at normal speed)
const any = list => list[Math.floor(Math.random()*list.length)];
// One burst of ranting, as speakText clauses: 3-6 pieces, each a [swears] or a consonant into a held vowel (sometimes stuttered), at RANT_PACE.
function rant(swears) {
  const clauses = [], n = 3 + Math.floor(Math.random()*4);
  for (let k = 0; k < n; k++) {
    const swear = swears && Math.random() < SWEAR_CHANCE && speechReady() && pickWord('swears', Math.random);
    if (swear) { clauses.push(...phonemesOf(swear + '!')); continue; }
    const c = any(RANT_CONSONANTS), v = any(RANT_VOWELS), phonemes = [];
    for (let s = Math.random() < 0.3 ? 1 + Math.floor(Math.random()*3) : 0; s > 0; s--) phonemes.push({ name: c, stress: 0, word: 0 }, { name: 'AX', stress: 0, word: 0, ms: 20 });
    phonemes.push({ name: c, stress: 0, word: 0 }, { name: v, stress: 1, word: 0, ms: 50 + Math.random()*500 });
    clauses.push({ phonemes, end: any(['!', '!', ',', '-', '?']), pace: RANT_PACE });
  }
  return clauses;
}

/**
 * How wide someone saying a line has their mouth open just now.
 * @param {object} line - as sayLine returned
 * @returns {number} 0 to 1; or -1, once the line's done
 */
export function lineMouth(line) {
  const t = listener.context.currentTime - line.start;
  if (!speaking.has(line) || t >= (line.mouth ? line.length : MAKING_MAX)) { finish(line); return -1; }
  if (!line.mouth) return 0; // (still being made)
  return Math.min(1, line.mouth[Math.floor(t/MOUTH_FRAME)] ?? 0);
}

/**
 * Stop a line partway, when whoever's saying it stops talking.
 * @param {?object} line - as sayLine returned
 * @returns {void}
 */
export function stopLine(line) {
  if (!line || !speaking.has(line)) return;
  try { line.source?.stop(); } catch { /* (already ended) */ }
  finish(line);
}

function finish(line) {
  if (!speaking.delete(line)) return;
  line.quiet.quietUntil = listener.context.currentTime + LINE_GAP/chatSpeed();
  if (line.end && line.quiet.members?.includes(line.by)) line.quiet.ending = { how: line.end, by: line.by };
}

/**
 * Whether someone who didn't get a real line should stay quiet rather than babble: with Options > Speech > Babble only
 * as fallback on, while the gap after their conversation's last line (LINE_GAP) runs out — babble's only for when no
 * line can be had.
 * @param {object} person
 * @returns {boolean}
 */
export function linePause(person) {
  const now = listener.context.currentTime;
  if (person.group?.wantsEnd || person.closing || person.greetTo) return true;
  const talk = person.group?.talk;
  if (talk?.to === person && now < talk.until) return true; // (their answer's due: no babble to hold it up — see sayLine) // (their goodbye's due: no babble while they wait for a chance to say it)
  return !!S.babbleFallbackOnly && (now < (quietOf(person).quietUntil ?? 0) || now - lastStart < LINE_START_GAP);
}
