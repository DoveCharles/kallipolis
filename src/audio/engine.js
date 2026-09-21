import { camera } from '../core/scene.js';
import { listener } from './sfx.js';

// ============================================================ engines
// The engines of the cars near the camera (see updateTraffic in life/traffic.js): loops synthesized live rather than built
// up front, since their pitch and tone follow each car frame by frame. Two slightly detuned sawtooths and a square an
// octave up give an engine its buzz, and a lowpass filter muffles it, opening up as the throttle's pressed and the revs
// climb. The revs rise through each gear's GEAR_SPEED and drop back at the change up, so it goes through the gears as it
// speeds up. A bigger car's engine is lower, and every car's a little different.
//
// There are ENGINES_MAX engines, handed each frame to the nearest cars within HEAR_DISTANCE: the driven car always has one.
// An engine fades out as its car goes, and in again on the next.
const IDLE_HZ = 75, REDLINE_HZ = 230;  // pitch at tickover and at the top of a gear, for an ordinary car
const GEAR_SPEED = 8, GEARS = 4;       // units a second each gear covers; in top gear the revs go on climbing over 2.5 times that
const SHIFT_REVS = 0.35;               // where the revs drop back to on changing up, 0 (idle) to 1 (redline)
const REVS_RATE = 3;                   // how fast the revs follow, per second
const VOLUME = 0.08, TRAFFIC_VOLUME = 0.5; // the driven car's, and everyone else's against it
const REF_DISTANCE = 10, HEAR_DISTANCE = 90;
const ENGINES_MAX = 6;
const LAYERS = [['sawtooth', 1, 0.5], ['sawtooth', 1.012, 0.4], ['square', 2, 0.12]]; // [wave, pitch against the fundamental, level]

const engines = []; // { out, filter, panner, oscillators, car, revs, lastSpeed }
const voiceOf = new WeakMap(); // car -> its engine's pitch against an ordinary car's
const HUM_REACH = 60; // (how far off a car counts for half as much toward trafficNearby)
let traffic = 0;

/**
 * How much traffic there is about the camera, for the city's hum (see ambience.js): every car counting for less the further
 * off it is, as of the last updateEngines.
 * @returns {number}
 */
export const trafficNearby = () => traffic;

function makeEngine() {
  const context = listener.context;
  const out = context.createGain();
  out.gain.value = 0;
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 3;
  filter.frequency.value = 500;
  const panner = context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = REF_DISTANCE;
  filter.connect(out).connect(panner).connect(listener.getInput());
  const oscillators = LAYERS.map(([type, ratio, level]) => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = IDLE_HZ*ratio;
    gain.gain.value = level;
    oscillator.connect(gain).connect(filter);
    oscillator.start();
    return { oscillator, ratio };
  });
  return { out, filter, panner, oscillators, car: null, revs: 0, lastSpeed: 0 };
}

/**
 * One frame of the engines: hand them to the nearest cars, and set each one's pitch, tone and loudness from its car.
 * @param {object[]} cars - every car, each with x, z and speed (the driven car with throttle too, 0 to 1: how hard the
 *   accelerator's pressed; everyone else's is judged from how they're speeding up)
 * @param {?object} driven - the car being driven, if any, which always gets an engine
 * @param {(car: object) => {y: number, size: number, running: boolean}} about - how high its engine is, how big it is
 *   against an ordinary car, and whether its engine's running (not stalled, sinking or burning)
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function updateEngines(cars, driven, about, dt) {
  const { x, z } = camera.position;
  traffic = 0;
  const near = cars
    .map(car => { const d = Math.hypot(car.x - x, car.z - z); traffic += 1/(1 + (d/HUM_REACH)**2); return { car, d: car === driven ? -1 : d }; })
    .filter(n => n.d <= HEAR_DISTANCE)
    .sort((a, b) => a.d - b.d).slice(0, ENGINES_MAX).map(n => n.car);
  if (!near.length && !engines.some(e => e.car)) return;
  while (engines.length < Math.min(ENGINES_MAX, near.length)) engines.push(makeEngine());
  const now = listener.context.currentTime;
  // the cars that had an engine and still do keep it; the rest go, and those new to it take over the ones going
  engines.forEach(e => { if (e.car && !near.includes(e.car)) e.car = null; });
  near.forEach(car => {
    if (engines.some(e => e.car === car)) return;
    const free = engines.find(e => !e.car);
    free.car = car;
    free.revs = 0;
    free.lastSpeed = Math.abs(car.speed);
  });
  for (const e of engines) {
    if (!e.car) { e.out.gain.setTargetAtTime(0, now, 0.15); continue; }
    const car = e.car, { y, size, running } = about(car), s = Math.abs(car.speed);
    // (anyone else's throttle: some just to keep moving, more the harder they're speeding up)
    const throttle = car === driven ? car.throttle ?? 0 : Math.min(1, (s > 0.5 ? 0.25 : 0) + Math.max(0, (s - e.lastSpeed)/Math.max(dt, 1e-3))/4);
    e.lastSpeed = s;
    const gear = Math.min(GEARS - 1, Math.floor(s/GEAR_SPEED)), top = gear === GEARS - 1;
    const through = Math.min(1, (s - gear*GEAR_SPEED)/(GEAR_SPEED*(top ? 2.5 : 1))); // (how far through this gear)
    const floor = gear ? SHIFT_REVS : 0;
    // (revving at a standstill, or with the wheels held back, still lifts the revs a little)
    const goal = running ? Math.max(floor + (1 - floor)*through, throttle*0.3) : 0;
    e.revs += (goal - e.revs)*Math.min(1, REVS_RATE*dt*(goal < e.revs - 0.2 ? 4 : 1)); // (a change up drops the revs quickly)
    if (!voiceOf.has(car)) voiceOf.set(car, 0.85 + Math.random()*0.3);
    const hz = (IDLE_HZ + (REDLINE_HZ - IDLE_HZ)*e.revs)*voiceOf.get(car)/Math.sqrt(Math.max(0.5, size));
    e.oscillators.forEach(({ oscillator, ratio }) => oscillator.frequency.setTargetAtTime(hz*ratio, now, 0.03));
    e.filter.frequency.setTargetAtTime(400 + 900*throttle + 1800*e.revs, now, 0.05);
    const volume = (car === driven ? VOLUME : VOLUME*TRAFFIC_VOLUME)*(0.55 + 0.45*throttle);
    e.out.gain.setTargetAtTime(running ? volume : 0, now, running ? 0.08 : 0.3);
    e.panner.positionX.value = car.x; e.panner.positionY.value = y; e.panner.positionZ.value = car.z;
  }
}
