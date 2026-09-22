import { camera } from '../core/scene.js';
import { S } from '../core/shared.js';
import { listener, outdoors } from './sfx.js';

// ============================================================ the shuttles
// The shuttles gliding through their solenoid tubes (see updateTrainShuttles in trains/trains.js), which ought to sound
// like nothing on the roads: no engine, no wheels, just the field. Each is a loop synthesized live like the engines (see
// engine.js): a pure low hum with a pair of slightly detuned tones an octave up beating against it, and a clean whine
// high above in a fifth, all climbing with the speed — the whine only sings out once it's going. Everything throbs as
// the carriage passes through each turn of the coil, "vwom… vwom", faster and faster until it's a flutter at full speed.
// Sat in a station it idles on a quiet hum.
//
// Setting off it whirs up like an electric motor spinning to speed, and pulling into a station it chimes, a soft rising arpeggio.
// There are SHUTTLES_MAX loops, handed each frame to the nearest carriages within HEAR_DISTANCE.
const HUM_HZ = 45, TOP_HZ = 135;           // the hum at a standstill and at full speed
const TOP_SPEED = 67;                      // units a second at the fastest point of a run (see TRAIN_SHUTTLE_SPEED)
const WHINE = 12, WHINE_FIFTH = 18;        // the whine's two tones against the hum
const VOLUME = 0.1, IDLE = 0.35;           // at full speed, and sat still against that
const REF_DISTANCE = 15, HEAR_DISTANCE = 110;
const SHUTTLES_MAX = 3;
const MOVING = 0.5;                        // units a second past which it counts as going
const CHIME = [660, 880, 1320], CHIME_GAP = 0.13, CHIME_RING = 0.9, CHIME_VOLUME = 0.12;
const WHIR_FROM = 35, WHIR_TO = 190, WHIR_TIME = 1.8, WHIR_VOLUME = 0.07;
const WHIR_WINDINGS = 6, WHIR_MAINS = 100; // the windings' whine against the motor's tone, and the mains buzz (hertz)

const shuttles = []; // { out, level, oscillators, whine, throb, panner, lineId }
const heard = new Map(); // line id -> { x, y, z, speed, moving } as of last frame

function makeShuttle() {
  const context = listener.context;
  const out = context.createGain();
  out.gain.value = 0;
  // (the throb: a gain taken down and back each time the carriage passes a turn of the coil)
  const throb = context.createGain(), lfo = context.createOscillator(), depth = context.createGain();
  lfo.frequency.value = 0.1;
  depth.gain.value = 0;
  lfo.connect(depth).connect(throb.gain);
  lfo.start();
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = REF_DISTANCE;
  throb.connect(out).connect(panner).connect(outdoors);
  const layer = (type, level) => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = type;
    gain.gain.value = level;
    oscillator.connect(gain).connect(throb);
    oscillator.start();
    return { oscillator, gain };
  };
  const oscillators = [[1, 'sine', 0.6], [2, 'triangle', 0.18], [2.013, 'triangle', 0.18]].map(([ratio, type, level]) => ({ ratio, ...layer(type, level) }));
  const whine = [[WHINE, 0], [WHINE_FIFTH, 0]].map(([ratio]) => ({ ratio, ...layer('sine', 0) }));
  return { out, throb, lfo, depth, oscillators, whine, panner, lineId: null };
}

// A one-off sound at `at`, through its own panner, over `seconds`: `build` wires its sources into the gain it's handed.
function oneShot(at, seconds, build) {
  const context = listener.context;
  if (context.state !== 'running') return;
  const panner = context.createPanner(), gain = context.createGain();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = REF_DISTANCE;
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;
  gain.connect(panner).connect(outdoors);
  const sources = build(gain, context.currentTime);
  sources[sources.length - 1].onended = () => panner.disconnect();
  sources.forEach(s => s.stop(context.currentTime + seconds + 0.05));
}

// the chime of a carriage pulling in: three soft notes rising, each with a twin a few hertz off for a shimmer
function chime(at) {
  oneShot(at, CHIME_GAP*CHIME.length + CHIME_RING, (gain, now) => CHIME.flatMap((hz, k) => [0, 3].map(off => {
    const context = listener.context, oscillator = context.createOscillator(), note = context.createGain();
    const start = now + k*CHIME_GAP;
    oscillator.frequency.value = hz + off;
    note.gain.setValueAtTime(0, now);
    note.gain.setValueAtTime(0, start);
    note.gain.linearRampToValueAtTime(CHIME_VOLUME/2, start + 0.01);
    note.gain.exponentialRampToValueAtTime(0.0005, start + CHIME_RING);
    oscillator.connect(note).connect(gain);
    oscillator.start(now);
    return oscillator;
  })));
}

// the whir of a carriage setting off, like an electric motor spinning up: a buzzy pair of tones a hair apart climbing
// quick then easing off as they reach speed, through a lowpass that opens as they go; the thin whine of the windings
// a few harmonics above them; a steady mains buzz under it all for the whole thing; and a faint flutter quickening
// with the spin. It swells in and then fades away under the hum.
function whir(at) {
  oneShot(at, WHIR_TIME, (gain, now) => {
    const context = listener.context, end = now + WHIR_TIME, spin = WHIR_TIME/3.5;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(WHIR_VOLUME, now + 0.3);
    gain.gain.setValueAtTime(WHIR_VOLUME, end - 0.7);
    gain.gain.linearRampToValueAtTime(0, end);
    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 4;
    tone.frequency.setValueAtTime(WHIR_FROM*5, now);
    tone.frequency.setTargetAtTime(WHIR_TO*6, now, spin);
    const flutter = context.createGain(), rotor = context.createOscillator(), depth = context.createGain();
    flutter.gain.value = 0.85;
    rotor.frequency.setValueAtTime(WHIR_FROM/4, now);
    rotor.frequency.setTargetAtTime(WHIR_TO/4, now, spin);
    depth.gain.value = 0.15;
    rotor.connect(depth).connect(flutter.gain);
    tone.connect(flutter).connect(gain);
    rotor.start(now);
    const layer = (type, from, to, level, into) => {
      const oscillator = context.createOscillator(), g = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(from, now);
      if (to !== from) oscillator.frequency.setTargetAtTime(to, now, spin);
      g.gain.value = level;
      oscillator.connect(g).connect(into);
      oscillator.start(now);
      return oscillator;
    };
    return [rotor,
      layer('sawtooth', WHIR_FROM, WHIR_TO, 0.5, tone),
      layer('square', WHIR_FROM*1.006, WHIR_TO*1.006, 0.25, tone),
      layer('sine', WHIR_FROM*WHIR_WINDINGS, WHIR_TO*WHIR_WINDINGS, 0.06, flutter),
      layer('square', WHIR_MAINS, WHIR_MAINS, 0.12, tone)];
  });
}

/**
 * One frame of the shuttles' sound: hand the loops to the nearest carriages, set each one's pitch and throb from how fast
 * it's going, and whir up or chime as they set off or pull in.
 * @param {{lineId: string, object: THREE.Object3D, arrived: boolean}[]} carriages - every shuttle, as trains.js keeps them
 * @param {number} dt - seconds since last frame
 * @returns {void}
 */
export function updateShuttleSounds(carriages, dt) {
  const { x, y, z } = camera.position;
  const near = [];
  for (const s of carriages) {
    const at = s.object.position, was = heard.get(s.lineId);
    const speed = was && dt > 0 ? Math.min(TOP_SPEED*1.5, Math.hypot(at.x - was.x, at.y - was.y, at.z - was.z)/dt) : 0;
    const moving = speed > MOVING, d = Math.hypot(at.x - x, at.y - y, at.z - z);
    if (d <= HEAR_DISTANCE && s.object.visible && was) {
      if (moving && !was.moving) whir(at);
      if (s.arrived) chime(at);
    }
    heard.set(s.lineId, { x: at.x, y: at.y, z: at.z, speed, moving });
    if (d <= HEAR_DISTANCE && s.object.visible) near.push({ s, d, speed });
  }
  near.sort((a, b) => a.d - b.d).splice(SHUTTLES_MAX);
  if (!near.length && !shuttles.some(e => e.lineId)) return;
  while (shuttles.length < Math.min(SHUTTLES_MAX, near.length)) shuttles.push(makeShuttle());
  const now = listener.context.currentTime;
  shuttles.forEach(e => { if (e.lineId && !near.some(n => n.s.lineId === e.lineId)) e.lineId = null; });
  near.forEach(n => { if (!shuttles.some(e => e.lineId === n.s.lineId)) shuttles.find(e => !e.lineId).lineId = n.s.lineId; });
  for (const e of shuttles) {
    const n = e.lineId && near.find(m => m.s.lineId === e.lineId);
    if (!n) { e.out.gain.setTargetAtTime(0, now, 0.2); continue; }
    const v = Math.min(1.2, n.speed/TOP_SPEED), hz = HUM_HZ + (TOP_HZ - HUM_HZ)*v;
    e.oscillators.forEach(({ oscillator, ratio }) => oscillator.frequency.setTargetAtTime(hz*ratio, now, 0.05));
    e.whine.forEach(({ oscillator, gain, ratio }, k) => {
      oscillator.frequency.setTargetAtTime(hz*ratio, now, 0.05);
      gain.gain.setTargetAtTime((k ? 0.04 : 0.08)*v*v, now, 0.1);
    });
    // (a turn of the coil every 10/TRAIN_COIL_TURNS_PER_10 units: the throb's as fast as the carriage passes them)
    const throbs = n.speed*(S.TRAIN_COIL_TURNS_PER_10 ?? 1)/10, deep = 0.35*Math.min(1, v*3);
    e.lfo.frequency.setTargetAtTime(Math.max(0.1, throbs), now, 0.05);
    e.depth.gain.setTargetAtTime(deep, now, 0.1);
    e.throb.gain.setTargetAtTime(1 - deep, now, 0.1);
    e.out.gain.setTargetAtTime(VOLUME*(IDLE + (1 - IDLE)*Math.min(1, v)), now, 0.1);
    const at = n.s.object.position;
    e.panner.positionX.value = at.x; e.panner.positionY.value = at.y; e.panner.positionZ.value = at.z;
  }
}
