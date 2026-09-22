import { listener, playBufferAt } from './sfx.js';

// ============================================================ office ambience
// While the view's in an office with anyone in it (see buildings/interior.js), now and then: the printer starting up and
// running a page or few through, a desk phone trilling a few times before someone picks up, a beep from something on a
// desk, and the soft two-note chime of an email come in. Each is written out sample by sample once, as it's first needed,
// and played from where it would be: the printer from the printer, the rest from one desk or another. What's in the room
// goes straight to the ear (see heardFrom in sfx.js), so they're as clear as the typing.
//
// Each comes round at random, about every `every` seconds (between half and half again as long), a busier office — more
// people in it — sooner for the phones, beeps and emails, up to twice as often with a dozen or more.
const SOUNDS = {
  printer: { every: 60, volume: 0.35 },
  phone: { every: 240, volume: 0.22 }, // (much the rarest)
  beep: { every: 30, volume: 0.12 },
  email: { every: 25, volume: 0.16 },
};
const REF_DISTANCE = 2, HEAR_DISTANCE = 14;
const RATE = listener.context.sampleRate;

/**
 * Write a sound out into an AudioBuffer.
 * @param {number} seconds - how long it is
 * @param {function(number, number): number} sample - its value at a time (in seconds), given a fresh random number in [-1, 1)
 * @returns {AudioBuffer}
 */
function render(seconds, sample) {
  const length = Math.ceil(seconds*RATE), buffer = listener.context.createBuffer(1, length, RATE), data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = sample(i/RATE, Math.random()*2 - 1);
  // (faded in and out over a few milliseconds either end, so nothing clicks)
  const edge = Math.min(length/2, Math.round(0.004*RATE));
  for (let i = 0; i < edge; i++) { data[i] *= i/edge; data[length - 1 - i] *= i/edge; }
  return buffer;
}
const TAU = Math.PI*2;
const clamp01 = v => Math.max(0, Math.min(1, v));
/** 0 to 1 and back: up over `rise` seconds from `from`, held, down over `fall` seconds to `to`. */
const envelope = (t, from, to, rise, fall) => clamp01((t - from)/rise)*clamp01((to - t)/fall);

// The printer: its motor winding up to a hum and a whine, a page fed through at a time (a shuffle of paper and the rollers
// rattling as it goes), then winding down again. `pages` of them.
function printer(pages) {
  const start = 0.6, page = 1.4, gap = 0.35, end = start + pages*(page + gap) + 0.3, length = end + 0.7;
  let phase = 0, noise = 0, rattle = 0;
  return render(length, (t, r) => {
    const spin = envelope(t, 0, end + 0.6, start, 0.7);
    // (the motor: a low buzz, rising in pitch as it comes up to speed, with a whine a few octaves over it)
    phase += TAU*(70 + 40*spin)/RATE;
    const motor = (Math.sin(phase) + 0.5*Math.sin(2*phase) + 0.25*Math.sin(3*phase))*0.25 + 0.05*Math.sin(phase*13.3);
    // the paper: noise, softened, swelling through each page, with the rollers' quick rattle
    const into = (t - start) % (page + gap), feeding = t > start && t < end - 0.3 && into < page;
    noise += (r - noise)*0.25;
    rattle = feeding ? 0.5 + 0.5*Math.sin(TAU*28*t) : 0;
    const paper = feeding ? noise*(0.35 + 0.35*rattle)*Math.sin(Math.PI*into/page) : 0;
    // and a clunk as each page is picked up
    const pick = t > start && into < 0.05 ? r*0.6*(1 - into/0.05) : 0;
    return (motor*spin + paper + pick)*0.8;
  });
}

// A desk phone: an electronic trill, two tones swapped a couple of dozen times a second, a second and a half at a time
// with a gap between — `rings` of them, the last one cut short as it's picked up.
function phone(rings) {
  const on = 1.5, off = 1.5, length = rings*(on + off) - off - 0.6;
  return render(length, t => {
    const at = t % (on + off);
    if (at > on || t > length) return 0;
    const tone = Math.floor(t*16) % 2 ? 1250 : 1000;
    return Math.sin(TAU*tone*t)*0.5*envelope(at, 0, on, 0.01, 0.02);
  });
}

// A beep: one short square-ish tone, or two, from something on a desk.
function beep(times, pitch) {
  const one = 0.11, gap = 0.08, length = times*(one + gap);
  return render(length, t => {
    const at = t % (one + gap);
    if (at > one) return 0;
    const wave = Math.sin(TAU*pitch*t), squared = Math.sign(wave)*Math.pow(Math.abs(wave), 0.4);
    return squared*0.35*envelope(at, 0, one, 0.003, 0.01);
  });
}

// An email come in: two soft bell notes, a fifth apart, the second ringing on.
function email(low) {
  const high = low*1.5, length = 1.2;
  const bell = (t, f) => t < 0 ? 0 : (Math.sin(TAU*f*t) + 0.3*Math.sin(TAU*f*2.01*t)*Math.exp(-t*12))*Math.exp(-t*5)*clamp01(t/0.004);
  return render(length, t => 0.35*(bell(t, low) + bell(t - 0.13, high)));
}

// a few takes on each, built the first time they're wanted
const MAKERS = {
  printer: () => [1, 2, 3].map(printer),
  phone: () => [2, 3, 4].map(phone),
  beep: () => [[1, 1900], [2, 1900], [1, 2600], [2, 1400], [3, 3100]].map(([times, pitch]) => beep(times, pitch)),
  email: () => [660, 740, 880].map(email),
};
const takes = {};
const due = {};

/**
 * The office's sounds for a frame, while the view's in an occupied office: any that have come round played.
 * @param {{printer: ?{x: number, y: number, z: number}, desks: {x: number, y: number, z: number}[], centre: {x: number, y: number, z: number}, people: number}} office
 *   - where the printer is (if there is one), the desks, the middle of the room, and how many are in it
 * @returns {void}
 */
export function officeAmbience(office) {
  const now = performance.now()/1000;
  const busy = 1 + Math.min(1, office.people/12);
  for (const [name, { every, volume }] of Object.entries(SOUNDS)) {
    const often = name === 'printer' ? every : every/busy;
    // (the first of each some way off, not all at once the moment the room's entered)
    due[name] ??= now + often*Math.random();
    if (now < due[name]) continue;
    due[name] = now + often*(0.5 + Math.random());
    const at = name === 'printer' ? office.printer : office.desks[Math.floor(Math.random()*office.desks.length)] ?? office.centre;
    if (!at) continue;
    takes[name] ??= MAKERS[name]();
    const list = takes[name];
    playBufferAt(list[Math.floor(Math.random()*list.length)], at, volume, REF_DISTANCE, HEAR_DISTANCE);
  }
}
/** Put every sound's next time off again (on going into an office): none of them the moment the room's entered. */
export function resetOfficeAmbience() {
  for (const name in due) delete due[name];
}
