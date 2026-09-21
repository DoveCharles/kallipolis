import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { listener } from './sfx.js';

// ============================================================ engine
// The driven car's engine (see "driving a car" in life/traffic.js): a loop synthesized live rather than built up front,
// since its pitch and tone follow the car frame by frame. Two slightly detuned sawtooths and a square an octave down
// give it a buzz, a lowpass filter muffles it, opening up as the throttle's pressed and the revs climb. The revs rise
// through each gear's GEAR_SPEED and drop back at the change up, so it goes through the gears as it speeds up. It sits
// where the car is, like any other sound (see sfx.js).
const IDLE_HZ = 36, REDLINE_HZ = 115;   // pitch at tickover and at the top of a gear
const GEAR_SPEED = 8, GEARS = 4;        // units a second each gear covers; in top gear the revs go on climbing over twice that
const SHIFT_REVS = 0.35;                // where the revs drop back to on changing up, 0 (idle) to 1 (redline)
const REVS_RATE = 3;                    // how fast the revs follow, per second
const VOLUME = 0.35, REF_DISTANCE = 12;
const LAYERS = [['sawtooth', 1, 0.5], ['sawtooth', 1.012, 0.4], ['square', 0.5, 0.35]]; // [wave, pitch against the fundamental, level]

let engine = null; // { out, filter, oscillators, sound, revs } while a car's being driven

/**
 * Start the engine sound, at `at`.
 * @param {{x: number, y: number, z: number}} at
 * @returns {void}
 */
export function startEngine(at) {
  if (engine) return;
  const context = listener.context, now = context.currentTime;
  const out = context.createGain();
  out.gain.value = 0;
  out.gain.setTargetAtTime(VOLUME*0.55, now, 0.05);
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 4;
  filter.frequency.value = 300;
  filter.connect(out);
  const oscillators = LAYERS.map(([type, ratio, level]) => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = IDLE_HZ*ratio;
    gain.gain.value = level;
    oscillator.connect(gain).connect(filter);
    oscillator.start();
    return { oscillator, ratio };
  });
  const sound = new THREE.PositionalAudio(listener);
  sound.setNodeSource(out);
  sound.setRefDistance(REF_DISTANCE);
  sound.position.set(at.x, at.y, at.z);
  scene.add(sound);
  engine = { out, filter, oscillators, sound, revs: 0 };
}

/**
 * One frame of the engine: where the car is, how fast it's going, how hard the throttle's pressed (0 to 1), and whether
 * the engine's running at all (not stalled, not under water).
 * @param {{x: number, y: number, z: number}} at
 * @param {number} speed - units a second, either way
 * @param {number} throttle
 * @param {boolean} running
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function updateEngine(at, speed, throttle, running, dt) {
  if (!engine) return;
  const now = listener.context.currentTime, s = Math.abs(speed);
  const gear = Math.min(GEARS - 1, Math.floor(s/GEAR_SPEED)), top = gear === GEARS - 1;
  const through = Math.min(1, (s - gear*GEAR_SPEED)/(GEAR_SPEED*(top ? 2.5 : 1))); // (how far through this gear)
  const floor = gear ? SHIFT_REVS : 0;
  // (revving at a standstill, or with the wheels held back, still lifts the revs a little)
  const goal = running ? Math.max(floor + (1 - floor)*through, throttle*0.3) : 0;
  engine.revs += (goal - engine.revs)*Math.min(1, REVS_RATE*dt*(goal < engine.revs - 0.2 ? 4 : 1)); // (a change up drops the revs quickly)
  const hz = IDLE_HZ + (REDLINE_HZ - IDLE_HZ)*engine.revs;
  engine.oscillators.forEach(({ oscillator, ratio }) => oscillator.frequency.setTargetAtTime(hz*ratio, now, 0.03));
  engine.filter.frequency.setTargetAtTime(250 + 700*throttle + 1400*engine.revs, now, 0.05);
  engine.out.gain.setTargetAtTime(running ? VOLUME*(0.55 + 0.45*throttle) : 0, now, running ? 0.05 : 0.3);
  engine.sound.position.set(at.x, at.y, at.z);
}

/**
 * Stop the engine sound, fading it out.
 * @returns {void}
 */
export function stopEngine() {
  if (!engine) return;
  const { out, oscillators, sound } = engine, now = listener.context.currentTime;
  engine = null;
  out.gain.setTargetAtTime(0, now, 0.08);
  oscillators.forEach(({ oscillator }) => oscillator.stop(now + 0.5));
  setTimeout(() => { sound.disconnect(); scene.remove(sound); }, 600);
}
