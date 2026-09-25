import { S, App } from '../../core/shared.js';
import { Y_ROAD } from '../../core/scene.js';
import { controls } from '../../core/camera-controls.js';
import { isOpenWater, WATER_LEVEL } from '../../water/water.js';
import { splashCar, aquaWake, boostWake, puffSmoke, tyreSmoke, driftSmoke, engineSmoke } from '../giblets.js';
import { controlInput, startDriving, endDriving } from '../possession.js';
import { STALL_SMOKE_EVERY, bumpIntoCars, hitBuildings, runOverPeople, seatKickedCar } from './collisions.js';
import { followedCar } from './follow.js';
import { spawnCar } from './lanes.js';
import { carHeight, carLength, carModelOf, carScale, carWidth, turnCar } from './placing.js';
import { cars } from './state.js';

// ============================================================ DRIVING ============================================================
// (possession.js): the followed car is taken off its line and steered by hand anywhere, with the camera
// swung round behind it. Other cars hold back for it as for any car, and it runs over anyone it touches (runOverPeople).
// Letting go puts it back on the nearest lane, facing whichever way along it its heading most nearly matches.
export const DRIVE_TOP_SPEED = 20, DRIVE_REVERSE_SPEED = 7;
const BOOST_EXTRA = 0.6; // (the share of its top speed and acceleration boosting adds, times the car's boost trait)
/** How many times its top speed and acceleration a car has while boosting: 1 + BOOST_EXTRA × its boost trait, so any boost helps. */
export const boostMultiplier = car => 1 + BOOST_EXTRA*(car.traits?.boost ?? 1);
const BOOST_FOV = 0.5; // (the share of the boost's extra speed the view widens by while the driven car boosts: see boostFovScale)
export const DRIVE_ACCEL = 10, DRIVE_BRAKE = 28, DRIVE_COAST = 4, DRIVE_TURN = 2.2; // per second (the turn in radians)
// how fast steerHeld goes over to full lock and back, per second — and the speed above walking pace at which the car
// turns half as sharply as at a crawl, a third as sharply at twice that speed, and so on
const DRIVE_STEER_RATE = 5, DRIVE_TURN_FADE = 12;
// kart drift: pressing run and brake together above DRIFT_MIN_SPEED hops the car; the side steered to by the hop's end locks
// the drift that way until either key's let go. Speed is held and no boost is spent. Steering into the drift tightens it
// to DRIFT_LOCK + DRIFT_RANGE, away widens it to DRIFT_LOCK − DRIFT_RANGE (full lock = 1); the body is drawn yawed DRIFT_YAW
// into the turn (car.driftYaw, drawn only — see placeCar).
const DRIFT_MIN_SPEED = 4, DRIFT_LOCK = 1, DRIFT_RANGE = 0.3, DRIFT_YAW = 0.35, DRIFT_YAW_RATE = 3; // (units/s; steer shares; radians; radians/s)
const DRIFT_RECHARGE = 0.35; // (share of the usual boost recharge while drifting)
const HOP_TIME = 0.3, HOP_HEIGHT = 0.15; // (seconds in the air; peak height, times the car's height)
const BOOST_MAX_BASE = 6; // (seconds of boost a car can draw on before it runs out, at the maxboost trait's base value of 1 — see core/traits.js)
const BOOST_RECHARGE_RATE = 0.5; // (seconds of boost regained per second while not boosting, at the recharge trait's base value of 1 — slower than it's spent)
/** How many seconds of boost a car has to spend in total: BOOST_MAX_BASE times its own maxboost trait. */
export const boostMax = car => BOOST_MAX_BASE*(car.traits?.maxboost ?? 1);
export const BOOST_UNLOCK = 1/3; // (the share of its boostMax a car that's run dry must refill before it can boost again)
/** Refill a car's boost (car.boostLeft) for `dt` seconds, by its recharge trait, up to boostMax — driven or not; unlocked (car.boostLocked) again once past BOOST_UNLOCK of it. */
export function rechargeBoost(car, dt) {
  if (car.boostLeft == null) return;
  car.boostLeft = Math.min(boostMax(car), car.boostLeft + BOOST_RECHARGE_RATE*(car.traits?.recharge ?? 1)*dt);
  if (car.boostLeft >= BOOST_UNLOCK*boostMax(car)) car.boostLocked = false;
}
export let drivenCar = null;
/**
 * Take the followed car for driving, if startDriving allows it and it is on a line; drops anyone it was yielding to.
 * @param {number} i - index in cars
 * @returns {void}
 */
export function driveCar(i) {
  const car = cars[i];
  if (i !== followedCar || !car || car.li < 0 || car.fuse != null || drivenCar === car || !startDriving()) return;
  drivenCar = car;
  App.setCarBoostShown(true);
  car.yieldFor = null;
  car.throttle = 0;
  controls.goalRadius = Math.max(controls.minRadius, carLength(car)*2.2);
}
/**
 * Put the driven car back in traffic: its speed floored at 0, and set to drive back to the nearest point of any line (see
 * seatKickedCar), in whichever direction along that line its heading most nearly matches — or spawned afresh if the roads are empty.
 * Also snaps it back dry (car.floatPhase etc, see updateFloating) if it was floating: nothing eases that back out for
 * an unpossessed car — updateFloating only ever runs for the one actually being driven — so left alone it would stay
 * sunk (and mid-bob) forever once AI control takes it back over dry land.
 * @returns {void}
 */
export function stopDriving() {
  if (!drivenCar) return;
  const car = drivenCar;
  drivenCar = null;
  endKartDrift(car);
  App.setCarBoostShown(false);
  endDriving();
  car.speed = Math.max(0, car.speed);
  car.floatPhase = 0; car.floatDrop = 0; car.floatBobPhase = 0; car.floatWasWet = false;
  // it drives back to the nearest lane, as a knocked car does
  car.kick = { x: 0, z: 0, vx: 0, vz: 0, heading: car.heading, goal: null, seated: false, blocked: false, speed: 0, driving: 0 };
  if (!seatKickedCar(car, car.x, car.z)) { car.kick = null; spawnCar(car); }
}
/**
 * One frame of the driven car, from the keys held (controlInput): brake, forward at top speed (boosted by run, so long as
 * its boost — boostMax — isn't spent), reverse, or coast down to a standstill; steerHeld eased
 * toward `right`; the turn scaled by speed up to a walking pace and fading above it, and reversed when going backwards;
 * then moved along its heading and bumped into any car it has run into (which may stop it, or wreck them). Driven out
 * over open water it starts sinking (overOpenWater, sinkCar) — unless it has the aqua trait, which instead floats it
 * (updateFloating): settling a little into the water and hopping back out onto land, smoothly, rather than sinking.
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function driveByHand(car, dt) {
  const input = controlInput(), { right, run, brake } = input;
  // a stalled engine gives no drive, and smokes from the bonnet
  const stalled = car.stall > 0, forward = stalled ? 0 : input.forward;
  if (stalled) {
    car.stall -= dt;
    if ((car.stallSmoke = (car.stallSmoke ?? 0) - dt) <= 0) {
      car.stallSmoke = STALL_SMOKE_EVERY;
      const nose = carLength(car)/2;
      engineSmoke({ x: car.x + Math.sin(car.heading)*nose, y: Y_ROAD, z: car.z + Math.cos(car.heading)*nose }, carHeight(car));
    }
  }
  // boosting (run held, driving forward) draws down its boost (boostMax); not boosting, it recharges (rechargeBoost, as
  // every car does undriven). Run dry, it's locked out until back past BOOST_UNLOCK of its max — trying meanwhile flashes the
  // meter. The card's boost meter (App.setCarBoost) is kept in step with it here.
  const max = boostMax(car);
  car.boostLeft ??= max;
  const drifting = kartDrift(car, run && brake && !stalled, right, dt);
  const wants = run && forward > 0 && !drifting, boosting = wants && car.boostLeft > 0 && !car.boostLocked;
  if (boosting) { car.boostLeft = Math.max(0, car.boostLeft - dt); if (car.boostLeft <= 0) car.boostLocked = true; }
  else rechargeBoost(car, drifting ? dt*DRIFT_RECHARGE : dt);
  if (drifting && !car.hop) boostSmoke(car, dt, driftSmoke);
  else if (boosting && car.speed > 1) boostSmoke(car, dt);
  App.setCarBoost(car.boostLeft, max, car.boostLocked, wants && !boosting);
  // its speed and boost traits scale the top speed and the boost (see cars.txt)
  const boost = boosting ? boostMultiplier(car) : 1;
  car.boostingNow = boosting; // (for the view: see boostFovScale)
  const top = DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost;
  const braking = DRIVE_BRAKE*(car.traits?.braking ?? 1);
  car.throttle = brake && !drifting ? 0 : Math.abs(forward); // (for the engine's sound)
  const toward = (v, goal, rate) => v + Math.max(-rate*dt, Math.min(rate*dt, goal - v));
  if (drifting) {} // (speed held)
  else if (brake) car.speed = toward(car.speed, 0, braking);
  else if (forward > 0) car.speed = toward(car.speed, top, car.speed < 0 ? braking : DRIVE_ACCEL*boost);
  else if (forward < 0) car.speed = toward(car.speed, -DRIVE_REVERSE_SPEED, car.speed > 0 ? braking : DRIVE_ACCEL*0.6);
  else car.speed = toward(car.speed, 0, DRIVE_COAST);
  // steering turns it at up to DRIVE_TURN radians a second, less the slower it's going below 4 units a second, and less
  // the faster above that (1/(1 + speed/DRIVE_TURN_FADE)); steerHeld is eased toward the key rather than jumping
  const was = { x: car.x, z: car.z, heading: car.heading };
  const steerGoal = car.driftDir ? car.driftDir*(DRIFT_LOCK + DRIFT_RANGE*right*car.driftDir) : right*drunkSteer(car, dt);
  car.steerHeld = toward(car.steerHeld, steerGoal, DRIVE_STEER_RATE);
  car.driftYaw = toward(car.driftYaw ?? 0, -(car.driftDir ?? 0)*DRIFT_YAW, DRIFT_YAW_RATE);
  const rolling = Math.max(-1, Math.min(1, car.speed/4))/(1 + Math.abs(car.speed)/DRIVE_TURN_FADE);
  const pace = car.speed < 0 && forward >= 0 ? Math.abs(rolling) : rolling; // (steering flips going backwards only when reversing on purpose — not when thrown back off a car, which read as the controls swapping)
  turnCar(car, (-car.steerHeld*DRIVE_TURN*controlOf(car) + driftTurn(car, dt))*dt*pace);
  car.x += Math.sin(car.heading)*car.speed*dt;
  car.z += Math.cos(car.heading)*car.speed*dt;
  bumpIntoCars(car, was);
  hitBuildings(car, was, dt);
  if (Math.abs(car.speed) > 0.3) runOverPeople(car);
  if (car.traits?.aqua) updateFloating(car, dt);
  else if (overOpenWater(car.x, car.z)) startSinking(car);
}
/**
 * The driven car's kart drift this frame (see DRIFT_MIN_SPEED): starts the hop (car.hop, seconds into it; car.hopY, drawn
 * height — see placeCar) when the keys go down, locks car.driftDir (±1, the steering side) once steered during or by the
 * end of the hop, and ends it when the keys are let go or the car slows below DRIFT_MIN_SPEED.
 * @param {object} car
 * @param {boolean} held - run and brake both held
 * @param {number} right - steering input, -1 to 1
 * @param {number} dt
 * @returns {boolean} whether speed is being held (hopping or drifting)
 */
function kartDrift(car, held, right, dt) {
  const pressed = held && !car.driftKeys;
  car.driftKeys = held;
  if (pressed && car.speed > DRIFT_MIN_SPEED) car.hop = dt;
  const active = held && car.speed > DRIFT_MIN_SPEED && (car.hop || car.driftDir);
  if (!active) { car.hop = 0; car.hopY = 0; car.driftDir = 0; return false; }
  if (car.hop) {
    if (!car.driftDir && right) car.driftDir = Math.sign(right);
    car.hop += dt;
    if (car.hop >= HOP_TIME) { car.hop = 0; car.hopY = 0; if (!car.driftDir) return false; rearWheels(car, at => puffSmoke(at, carHeight(car), 8)); }
    else car.hopY = HOP_HEIGHT*carHeight(car)*Math.sin(Math.PI*car.hop/HOP_TIME);
  }
  return true;
}
/** Clear a car's kart drift (see kartDrift). */
function endKartDrift(car) {
  car.hop = 0; car.hopY = 0; car.driftDir = 0; car.driftYaw = 0; car.driftKeys = false;
}

// ---- drift: now and then the driven car pulls to one side on its own, eased in and out over DRIFT_TIME. How hard and
// how often grow with the inverse cube of its control (controlOf): at 1 a pull of a degree or two, at 0.5 an obvious swerve,
// at 0.3 stronger than its (equally weakened) steering can fight. The biggest pull is DRIFT_TURN × DRIFT_SIZE[1] / control³: 0.075 rad/s at
// control 1, 0.009 at 2, 0.6 at 0.5, 2.8 at 0.3.
const DRIFT_TURN = 0.05, DRIFT_CHANCE = 0.25, DRIFT_TIME = [0.4, 1.2], DRIFT_SIZE = [0.5, 1.5]; // (radians a second at control 1; pulls a second at control 1; seconds a pull lasts; each pull's size, times DRIFT_TURN)
// drunk: control halved on top of the control trait, and every DRUNK_EVERY seconds the steering swaps sides for DRUNK_FOR
const DRUNK_CONTROL = 0.5, DRUNK_EVERY = [3, 10], DRUNK_FOR = [1, 3];
const between = ([least, most]) => least + Math.random()*(most - least);
/** A car's control, as its steering and drift read it: the control trait, halved if drunk. */
const controlOf = car => (car.traits?.control ?? 1)*(car.traits?.drunk ? DRUNK_CONTROL : 1);
/**
 * Count down a drunk car's swapped steering, each frame.
 * @param {object} car
 * @param {number} dt
 * @returns {number} -1 while its steering is swapped, else 1
 */
function drunkSteer(car, dt) {
  if (!car.traits?.drunk) return 1;
  const d = car.drunk ??= { swapped: false, timer: between(DRUNK_EVERY) };
  if ((d.timer -= dt) <= 0) { d.swapped = !d.swapped; d.timer = between(d.swapped ? DRUNK_FOR : DRUNK_EVERY); }
  return d.swapped ? -1 : 1;
}
/**
 * The driven car's drift this frame, starting a new pull at random when there isn't one.
 * @param {object} car
 * @param {number} dt
 * @returns {number} radians a second to turn it by, on top of the steering
 */
function driftTurn(car, dt) {
  const severity = 1/Math.max(0.1, controlOf(car))**3, pull = car.drift;
  if (!pull) {
    if (Math.random() < DRIFT_CHANCE*Math.sqrt(severity)*dt) car.drift = { t: 0, time: DRIFT_TIME[0] + Math.random()*(DRIFT_TIME[1] - DRIFT_TIME[0]), size: (Math.random() < 0.5 ? -1 : 1)*(DRIFT_SIZE[0] + Math.random()*(DRIFT_SIZE[1] - DRIFT_SIZE[0])) };
    return 0;
  }
  if ((pull.t += dt) >= pull.time) { car.drift = null; return 0; }
  return pull.size*DRIFT_TURN*severity*Math.sin(Math.PI*pull.t/pull.time);
}
// ---- the driven car in the water: driven off the land (or off the side of a bridge) and over water — a water zone or a
// river — it drops through the surface, nose first, carried on a little by its speed, and blows up once it's under
const SINK_GRAVITY = 20, SINK_DRAG = 1.5, SINK_PITCH = 0.7, SINK_PITCH_RATE = 2.5; // (units a second squared; the share of its speed the water takes each second; how far its nose goes down, in radians, and how fast)
/** How many times its usual angle the view is while the driven car boosts (eased to by updateInteriorCamera in buildings/interior.js). */
const boostFovScale = () => drivenCar?.boostingNow ? 1 + BOOST_FOV*(boostMultiplier(drivenCar) - 1) : 1;
Object.assign(App, { boostFovScale });

/**
 * Whether a point is over open water for a car: in the visible water with no road across it (a bridge's deck, sidewalks
 * and all) to hold it up. Only a car's centre is tested, so it goes in once that's past the edge.
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function overOpenWater(x, z) {
  return isOpenWater(x, z, [S.roadFootprint]);
}
/** Start a car going down (see sinkCar), carrying on from a part-risen one's own drop and pitch. */
export function startSinking(car) {
  car.sinking = { drop: car.sinking?.drop ?? 0, fall: 0, pitch: car.sinking?.pitch ?? 0, under: false };
}
// Where a car's water particles (splashCar, aquaWake) should come from: one point at its centre for an ordinary car,
// short enough that a single spot reads fine — but a bus is long enough that one point there just looks like an
// oversized gusher in the middle, so it gets one spot at each set of wheels instead (front axle and rear axle), each
// splashing and trickling at the ordinary rate, so the water disturbs evenly along its length rather than piling up
// in one place. (Its boost wake stays a single trail off the very back regardless — see boostSmoke, below.)
function waterAxleSpots(car) {
  const cm = carModelOf(car);
  if (!cm?.wheelbase || !/bus/i.test(cm.name ?? '')) return [{ x: car.x, z: car.z }];
  const half = cm.wheelbase*carScale(car)/2, sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  return [{ x: car.x + sin*half, z: car.z + cos*half }, { x: car.x - sin*half, z: car.z - cos*half }];
}
// ---- an aqua car floating on open water: unlike an ordinary car sinking (above), it settles in a little rather than
// going under, and hops back out — quicker than it settled in — once it's back over land or a bridge, landing with its
// own puff of dry dust, like any other landing (no water in it) — with its own splash the moment it first touches
// down, bobbing the whole time it's settled, and its own wake (aquaWake) trickling out from under it.
const FLOAT_DEPTH_SHARE = 0.5, FLOAT_SETTLE_TIME = 0.8, FLOAT_RISE_TIME = 0.35; // (how much of its own height it sinks into the water it's floating on, as a share; how many seconds it takes to settle in; how many quicker it takes to hop back out)
const FLOAT_BOB_AMPLITUDE = 0.05, FLOAT_BOB_PERIOD = 0.9; // (how much of its height it rises and falls on top of that settled depth; how many seconds one full up-and-down cycle takes)
const FLOAT_LAND_SMOKE_PUFFS = 6; // dust puffs (puffSmoke, life/giblets.js) the moment it's fully back on dry ground — plain smoke, not the splash's spray and foam
/**
 * Ease an aqua car (see the trait, core/traits.js) into or out of floating this frame: car.floatPhase (0 dry, 1 settled)
 * moves toward 1 while it's over open water (overOpenWater) and toward 0 once it's back over land or a bridge, the
 * first crossing the whole way in FLOAT_SETTLE_TIME seconds and the second in the shorter FLOAT_RISE_TIME — it drops
 * in gently but hops back out smartly. car.floatDrop — read by placeCar, alongside a sinking car's own drop — is that
 * phase run through a cubic ease (smoothstep, the same curve shaders here use) so it sinks in and hops out along a
 * soft S-curve rather than snapping or drifting at a constant speed, times FLOAT_DEPTH_SHARE of its height, plus a
 * gentle sinusoidal bob (car.floatBobPhase, its own running clock, started at a random point so a fleet of aqua cars
 * doesn't bob in unison) once it's actually settled in — both scaled by the same eased phase, so floatDrop (and so the
 * car's height) correctly eases all the way back to 0, full height, as it leaves rather than leaving it sunk or
 * mid-bob. The moment it first goes from dry to over water (car.floatWasWet flipping false to true) it throws one
 * splashCar burst at each of waterAxleSpots' points, like a car going under, and resets ready to do it again next time
 * it's dry (car.floatWasWet back to false) in between; the moment phase finishes easing back to exactly 0 after
 * having been above it, it throws a plain dust puff (puffSmoke, FLOAT_LAND_SMOKE_PUFFS) instead, landing on the
 * ground rather than splashing into it. While it's on the water at all, it throws its own continuous wake too
 * (aquaWake, life/giblets.js), again once per spot.
 * @param {object} car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function updateFloating(car, dt) {
  const goal = overOpenWater(car.x, car.z) ? 1 : 0, height = carHeight(car), spots = waterAxleSpots(car);
  if (goal === 1 && !car.floatWasWet) { spots.forEach(spot => splashCar({ x: spot.x, y: WATER_LEVEL, z: spot.z }, height)); car.floatWasWet = true; }
  else if (goal === 0) car.floatWasWet = false;
  const rate = 1/(goal === 1 ? FLOAT_SETTLE_TIME : FLOAT_RISE_TIME), was = car.floatPhase ?? 0;
  const phase = car.floatPhase = Math.max(0, Math.min(1, was + Math.max(-rate*dt, Math.min(rate*dt, goal - was))));
  if (was > 0 && phase === 0) puffSmoke({ x: car.x, y: Y_ROAD, z: car.z }, height, FLOAT_LAND_SMOKE_PUFFS); // back on dry ground: a plain dust puff, no water in it
  const eased = phase*phase*(3 - 2*phase); // smoothstep
  car.floatBobPhase = (car.floatBobPhase ?? Math.random()*Math.PI*2) + dt*(Math.PI*2/FLOAT_BOB_PERIOD);
  const bob = eased*FLOAT_BOB_AMPLITUDE*height*Math.sin(car.floatBobPhase);
  car.floatDrop = eased*FLOAT_DEPTH_SHARE*height + bob;
  if (eased > 0) spots.forEach(spot => aquaWake({ x: spot.x, y: WATER_LEVEL, z: spot.z }, height, carWidth(car), car.heading, dt));
}
/**
 * One frame of a driven car going down in the water: the keys do nothing now; it runs on along its heading as the water
 * slows it, falls faster and faster, and tips its nose down (or its tail, going backwards) — until it's a car's height
 * below the surface, when it's marked `under` for updateTraffic to blow up. If its centre is carried back over land
 * before it's reached the surface, it's marked `rising` instead (see riseCar).
 * @param {object} car - the driven car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function sinkCar(car, dt) {
  const sink = car.sinking;
  car.boostingNow = false;
  endKartDrift(car);
  car.speed *= 1 - Math.min(1, SINK_DRAG*dt);
  car.x += Math.sin(car.heading)*car.speed*dt;
  car.z += Math.cos(car.heading)*car.speed*dt;
  sink.fall += SINK_GRAVITY*dt;
  sink.drop += sink.fall*dt;
  const goal = SINK_PITCH*(car.speed < 0 ? -1 : 1);
  sink.pitch += Math.max(-SINK_PITCH_RATE*dt, Math.min(SINK_PITCH_RATE*dt, goal - sink.pitch));
  if (sink.drop >= Y_ROAD - WATER_LEVEL + carHeight(car)) sink.under = true;
  else if (sink.drop < Y_ROAD - WATER_LEVEL && !overOpenWater(car.x, car.z)) Object.assign(sink, { rising: true, fall: 0, from: Math.max(sink.drop, 1e-3), shakeTime: 0 });
}
// ---- a driven car back over land before it's touched the water: it's driven as normal again while it climbs back up
const RISE_RATE = 12, RISE_ROLL = 0.06, RISE_SHAKES_PER_SECOND = 9, RISE_DONE = 0.005; // (the share of what's left it climbs each second, exponentially; how far it rocks, in radians, at the start; full rocks a second; how close to the road counts as back up)
/** Whether a car is going under the water rather than climbing back out of it (see sinkCar, riseCar). */
export const goingUnder = car => car.sinking && !car.sinking.rising;
/**
 * One frame of a driven car climbing back up onto land (see sinkCar): its drop and pitch eased out quickly, while it
 * rocks side to side about its length axis (sinking.roll, read by placeCar) — dying away as it nears the road. Once up,
 * car.sinking is cleared.
 * @param {object} car - the driven car
 * @param {number} dt - seconds this frame
 * @returns {void}
 */
export function riseCar(car, dt) {
  const sink = car.sinking, k = 1 - Math.exp(-RISE_RATE*dt);
  sink.drop -= sink.drop*k;
  sink.pitch -= sink.pitch*k;
  sink.shakeTime += dt;
  sink.roll = RISE_ROLL*Math.sqrt(sink.drop/sink.from)*Math.sin(sink.shakeTime*RISE_SHAKES_PER_SECOND*Math.PI*2);
  if (sink.drop < RISE_DONE) car.sinking = null;
}
/** Small black smoke from a boosting car's rear tyres — or, sitting on water (car.floatDrop > 0), a big wake thrown up off its back instead (boostWake, life/giblets.js), tyre smoke making no sense there. `smoke` is what the tyres give off (driftSmoke while drifting). */
export function boostSmoke(car, dt, smoke = tyreSmoke) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  if (car.floatDrop > 0) {
    const back = carLength(car)*0.45;
    boostWake({ x: car.x - sin*back, y: WATER_LEVEL, z: car.z - cos*back }, carHeight(car), car.heading, dt);
    return;
  }
  rearWheels(car, at => smoke(at, carHeight(car), dt));
}
/** Call `fn` with each rear tyre's ground point. */
function rearWheels(car, fn) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading), back = carLength(car)*0.3, side = carWidth(car)*0.4;
  [-1, 1].forEach(end => fn({ x: car.x - sin*back + cos*side*end, y: Y_ROAD, z: car.z - cos*back - sin*side*end }));
}
