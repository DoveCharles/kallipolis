import { camera } from '../core/scene.js';
import { listener, outdoorsOf } from './sfx.js';
import { makeEngineVoice, setEngineKind, setEngineVoice, kindOfDesign } from './engine-voice.js';

// ============================================================ engines
// The engines of the cars near the camera (see updateTraffic in life/traffic/traffic.js), each an engine voice (engine-voice.js)
// of the kind its design has: a four-pot for an ordinary car, a V8 for a pickup, a diesel for a bus. The revs rise
// through each gear's GEAR_SPEED and drop back at the change up, when the throttle lifts for a moment (SHIFT_TIME), so it
// goes through the gears as it speeds up. A bigger car's engine is lower, and every car's a little different.
//
// There are ENGINES_MAX engines, handed each frame to the nearest cars within HEAR_DISTANCE: the driven car always has one.
// An engine fades out as its car goes, and in again on the next.
const GEAR_SPEED = 8, GEARS = 4;       // units a second each gear covers; in top gear the revs go on climbing over 2.5 times that
const SHIFT_REVS = 0.35;               // where the revs drop back to on changing up, 0 (idle) to 1 (redline)
const SHIFT_TIME = 0.15;               // seconds the throttle's lifted for a change up
const REVS_RATE = 3;                   // how fast the revs follow, per second
const VOLUME = 0.09, TRAFFIC_VOLUME = 0.5; // the driven car's, and everyone else's against it
const REF_DISTANCE = 10, HEAR_DISTANCE = 90;
const ENGINES_MAX = 6;

const engines = []; // { voice, panner, car, revs, lastSpeed, gear, shift }
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
  const panner = listener.context.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = REF_DISTANCE;
  panner.connect(outdoorsOf('traffic'));
  return { voice: makeEngineVoice(listener.context, panner), panner, car: null, revs: 0, lastSpeed: 0, gear: 0, shift: 0 };
}

/**
 * One frame of the engines: hand them to the nearest cars, and set each one's pitch, tone and loudness from its car.
 * @param {object[]} cars - every car, each with x, z and speed (the driven car with throttle too, 0 to 1: how hard the
 *   accelerator's pressed; everyone else's is judged from how they're speeding up)
 * @param {?object} driven - the car being driven, if any, which always gets an engine
 * @param {(car: object) => {y: number, size: number, running: boolean, design: ?string}} about - how high its engine is, how
 *   big it is against an ordinary car, whether its engine's running (not stalled, sinking or burning), and its design's name
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
    free.gear = 0;
    free.shift = 0;
    setEngineKind(free.voice, kindOfDesign(about(car).design));
  });
  for (const e of engines) {
    if (!e.car) { e.voice.kind && setEngineVoice(e.voice, { revs: e.revs, throttle: 0, volume: 0, dt }); continue; }
    const car = e.car, { y, size, running } = about(car), s = Math.abs(car.speed);
    // (anyone else's throttle: some just to keep moving, more the harder they're speeding up)
    let throttle = car === driven ? car.throttle ?? 0 : Math.min(1, (s > 0.5 ? 0.25 : 0) + Math.max(0, (s - e.lastSpeed)/Math.max(dt, 1e-3))/4);
    e.lastSpeed = s;
    const gear = Math.min(GEARS - 1, Math.floor(s/GEAR_SPEED)), top = gear === GEARS - 1;
    if (gear > e.gear && throttle > 0.1) e.shift = SHIFT_TIME;
    e.gear = gear;
    e.shift = Math.max(0, e.shift - dt);
    if (e.shift) throttle *= 0.15;
    const through = Math.min(1, (s - gear*GEAR_SPEED)/(GEAR_SPEED*(top ? 2.5 : 1))); // (how far through this gear)
    const floor = gear ? SHIFT_REVS : 0;
    // (revving at a standstill, or with the wheels held back, still lifts the revs a little)
    const goal = running ? Math.max(floor + (1 - floor)*through, throttle*0.3) : 0;
    e.revs += (goal - e.revs)*Math.min(1, REVS_RATE*dt*(goal < e.revs - 0.2 ? 4 : 1)); // (a change up drops the revs quickly)
    if (!voiceOf.has(car)) voiceOf.set(car, 0.9 + Math.random()*0.2);
    const volume = (car === driven ? VOLUME : VOLUME*TRAFFIC_VOLUME)*(0.6 + 0.4*throttle);
    setEngineVoice(e.voice, { revs: e.revs, throttle, volume: running ? volume : 0, pitch: voiceOf.get(car), size, dt });
    e.panner.positionX.value = car.x; e.panner.positionY.value = y; e.panner.positionZ.value = car.z;
  }
}
