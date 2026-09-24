import { S, App } from '../../core/shared.js';
import { Y_ROAD } from '../../core/scene.js';
import { controls } from '../../core/camera-controls.js';
import { getVisibleWaterRegion, WATER_LEVEL } from '../../water/water.js';
import { splashCar, aquaWake, boostWake, puffSmoke, tyreSmoke, engineSmoke } from '../giblets.js';
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
export const DRIVE_TOP_SPEED = 20, DRIVE_BOOST = 1.6, DRIVE_REVERSE_SPEED = 7;
export const DRIVE_ACCEL = 10, DRIVE_BRAKE = 28, DRIVE_COAST = 4, DRIVE_TURN = 2.2; // per second (the turn in radians)
// how fast steerHeld goes over to full lock and back, per second — and the speed above walking pace at which the car
// turns half as sharply as at a crawl, a third as sharply at twice that speed, and so on
const DRIVE_STEER_RATE = 5, DRIVE_TURN_FADE = 12;
const BOOST_ENERGY_BASE = 6; // (seconds of boost a car can draw on before it runs out, at the energy trait's base value of 1 — see the trait, core/traits.js)
const BOOST_RECHARGE_RATE = 0.5; // (seconds of boost regained per second while not boosting — slower than it's spent, so it recharges gradually)
/** How many seconds of boost a car has to spend in total: BOOST_ENERGY_BASE times its own energy trait. */
export const boostEnergyMax = car => BOOST_ENERGY_BASE*(car.traits?.energy ?? 1);
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
  endDriving();
  car.speed = Math.max(0, car.speed);
  car.floatPhase = 0; car.floatDrop = 0; car.floatBobPhase = 0; car.floatWasWet = false;
  // it drives back to the nearest lane, as a knocked car does
  car.kick = { x: 0, z: 0, vx: 0, vz: 0, heading: car.heading, goal: null, seated: false, blocked: false, speed: 0, driving: 0 };
  if (!seatKickedCar(car, car.x, car.z)) { car.kick = null; spawnCar(car); }
}
/**
 * One frame of the driven car, from the keys held (controlInput): brake, forward at top speed (boosted by run, so long as
 * its energy trait's own budget — boostEnergyMax — isn't spent), reverse, or coast down to a standstill; steerHeld eased
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
  // boosting (run held, driving forward) draws down its energy trait's own budget (boostEnergyMax); not boosting, it
  // slowly recharges instead (BOOST_RECHARGE_RATE), either way no further than its own full and empty. The card's boost
  // meter (App.setCarBoost) is kept in step with it here, every frame it's actually driven.
  const energyMax = boostEnergyMax(car);
  car.energy ??= energyMax;
  const boosting = run && forward > 0 && car.energy > 0;
  car.energy = boosting ? Math.max(0, car.energy - dt) : Math.min(energyMax, car.energy + BOOST_RECHARGE_RATE*dt);
  if (boosting && car.speed > 1) boostSmoke(car, dt);
  App.setCarBoost(car.energy, energyMax);
  // its speed and boost traits scale the top speed and the boost (see cars.txt)
  const boost = boosting ? DRIVE_BOOST*(car.traits?.boost ?? 1) : 1;
  const top = DRIVE_TOP_SPEED*(car.traits?.speed ?? 1)*boost;
  const braking = DRIVE_BRAKE*(car.traits?.braking ?? 1);
  car.throttle = brake ? 0 : Math.abs(forward); // (for the engine's sound)
  const toward = (v, goal, rate) => v + Math.max(-rate*dt, Math.min(rate*dt, goal - v));
  if (brake) car.speed = toward(car.speed, 0, braking);
  else if (forward > 0) car.speed = toward(car.speed, top, car.speed < 0 ? braking : DRIVE_ACCEL*boost);
  else if (forward < 0) car.speed = toward(car.speed, -DRIVE_REVERSE_SPEED, car.speed > 0 ? braking : DRIVE_ACCEL*0.6);
  else car.speed = toward(car.speed, 0, DRIVE_COAST);
  // steering turns it at up to DRIVE_TURN radians a second, less the slower it's going below 4 units a second, and less
  // the faster above that (1/(1 + speed/DRIVE_TURN_FADE)); steerHeld is eased toward the key rather than jumping
  const was = { x: car.x, z: car.z, heading: car.heading };
  car.steerHeld = toward(car.steerHeld, right, DRIVE_STEER_RATE);
  const pace = Math.max(-1, Math.min(1, car.speed/4))/(1 + Math.abs(car.speed)/DRIVE_TURN_FADE);
  turnCar(car, -car.steerHeld*DRIVE_TURN*(car.traits?.control ?? 1)*dt*pace);
  car.x += Math.sin(car.heading)*car.speed*dt;
  car.z += Math.cos(car.heading)*car.speed*dt;
  bumpIntoCars(car, was);
  hitBuildings(car, was, dt);
  if (Math.abs(car.speed) > 0.3) runOverPeople(car);
  if (car.traits?.aqua) updateFloating(car, dt);
  else if (overOpenWater(car.x, car.z)) car.sinking = { drop: car.sinking?.drop ?? 0, fall: 0, pitch: car.sinking?.pitch ?? 0, under: false }; // (carries on from a part-risen car's own drop and pitch)
}
// ---- the driven car in the water: driven off the land (or off the side of a bridge) and over water — a water zone or a
// river — it drops through the surface, nose first, carried on a little by its speed, and blows up once it's under
const SINK_GRAVITY = 20, SINK_DRAG = 1.5, SINK_PITCH = 0.7, SINK_PITCH_RATE = 2.5; // (units a second squared; the share of its speed the water takes each second; how far its nose goes down, in radians, and how fast)
let openWater = { region: null, roads: null, inWater: null, onRoad: null };
/**
 * Whether a point is over water with no road across it to hold a car up: in the visible water (water zones and rivers,
 * less beach slope above the waterline — getVisibleWaterRegion), and not on the road footprint (a bridge's deck,
 * sidewalks and all). Only the car's centre is tested, so it goes in once that's past the edge. The two region
 * testers are rebuilt whenever either region is.
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
function overOpenWater(x, z) {
  const region = getVisibleWaterRegion(), roads = S.roadFootprint;
  if (!region.length) return false;
  if (openWater.region !== region || openWater.roads !== roads)
    openWater = { region, roads, inWater: App.createRegionTester(region), onRoad: App.createRegionTester(roads) };
  return openWater.inWater(x, z) && !openWater.onRoad(x, z);
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
function updateFloating(car, dt) {
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
/** Small black smoke from a boosting car's rear tyres — or, sitting on water (car.floatDrop > 0), a big wake thrown up off its back instead (boostWake, life/giblets.js), tyre smoke making no sense there. */
export function boostSmoke(car, dt) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  if (car.floatDrop > 0) {
    const back = carLength(car)*0.45;
    boostWake({ x: car.x - sin*back, y: WATER_LEVEL, z: car.z - cos*back }, carHeight(car), car.heading, dt);
    return;
  }
  const back = carLength(car)*0.3, side = carWidth(car)*0.4;
  [-1, 1].forEach(end => tyreSmoke({ x: car.x - sin*back + cos*side*end, y: Y_ROAD, z: car.z - cos*back - sin*side*end }, carHeight(car), dt));
}
