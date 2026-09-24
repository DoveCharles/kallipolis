import * as THREE from 'three';
import { S, App } from '../../core/shared.js';
import { scene, computeWindowGlowFactor, Y_ROAD } from '../../core/scene.js';
import { controls } from '../../core/camera-controls.js';
import { navRebuildOnHold } from '../../roads/roads.js';
import { placeKey, signalState } from '../../roads/markings.js';
import { updateEngines } from '../../audio/engine.js';
import { carTypeOf } from '../car-types.js';
import { BLAST_THROW, burnFuse, DETONATION_REACH, isLying, runOverPeople, stepKick, strikeWithAircraft, wreckedCars } from './collisions.js';
import { driveByHand, driveCar, drivenCar, goingUnder, overOpenWater, riseCar, sinkCar, startSinking, stopDriving, updateFloating } from './driving.js';
import { chaseCamera, drownCar, followCar, followCarAt, followedCar, killCar, pickCar, smiteCar, stopFollowingCar } from './follow.js';
import { ROUTE_SAMPLE, buildTrafficNav, carsNearby, carsWhere, checkYield, driveAlong, junctionAhead, laneLength, lanePoint, newCar, reseatCar, routePoint, spawnCar } from './lanes.js';
import { carHoloTimeUniform, carPlate } from './materials.js';
import { carMeshes, carParts, designNumbers } from './models.js';
import { CAR_REAR_AXLE, carHeight, carLength, engineOf, placeCar, placing, turnWheels } from './placing.js';
import { buildCarGrid, CAR_BRAKE, CAR_STOP_GAP, forCarsNear, gapAhead, GIVE_UP_AFTER, lyingAhead, uTurnBlocked, waitOrGiveUp } from './spacing.js';
import { updateSpecialTraits } from './special.js';
import { CAR_SPEED, TRAFFIC_MAX, TURN_SAFE_ANGLE, cars, trafficRng } from './state.js';
import { waitToTurn } from './turns.js';
export { loadCarModels } from './models.js';
export { forEachHeadlight } from './placing.js';
export { carThumbnailScene } from './follow.js';

// ============================================================ TRAFFIC ============================================================
// Cars, drawn with the people and scaled by the same speed and size settings. A car drives one sidewalk road line in one of
// two lanes (`lane` either side of the centerline, buildTrafficNav): it turns onto a linked line at some junctions and at
// its line's end (driveAlong, pickTurn), U-turns at dead ends (routePoint), slows approaching a junction and holds its gap
// to the car ahead. A road takes at most one car per TRAFFIC_LANE_PER_CAR of lane, however high the slider goes. A car
// draws as a design from assets/models/Cars.glb picked at random, or as the box car until that has loaded.
// This file runs each frame's update (updateTraffic); the rest of src/life/traffic/: state (shared settings), models and
// materials (how a car looks), lanes, turns and spacing (where it drives), placing (drawing and size), driving (by hand,
// water), collisions, special (legendary/terrible) and follow (camera, card, taking cars out).

// Debug wireframe (World → Peds → Roadsafety radius (debug)): a box of carHitbox around each car, off by default and
// written only while the toggle is on (see placeCar).
export const carHitboxDebugMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd23d, wireframe: true }), TRAFFIC_MAX);
carHitboxDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
carHitboxDebugMesh.count = 0;
carHitboxDebugMesh.frustumCulled = false;
carHitboxDebugMesh.visible = false;
carHitboxDebugMesh.name = 'CarHitboxDebug';
scene.add(carHitboxDebugMesh);
/**
 * Set car.traits from its type's entries in assets/cars.txt (see carTypeOf), once per design and number. Cars without a
 * design have no traits; the readers below treat a missing trait as 1.
 * @param {object} car
 * @returns {void}
 */
function refreshCarTraits(car) {
  const key = car.design + ':' + car.number;
  if (car.traitsKey === key) return;
  car.traitsKey = key;
  const type = carTypeOf(carMeshes[car.design].name, car.number);
  car.traits = type.traits;
  // legendary/terrible are 'on' traits (core/traits.js) — combineTraits caps the aggregate at 1 even when several of a
  // car's loves/hates are individually marked legendary or terrible, so updateSpecialTraits' net level can't read the
  // real count from car.traits. Tallied here instead from each love/hate entry's own tier (type.lovesTier/hatesTier,
  // from carTypeOf/core/type-text.js).
  const tiers = [...(type.lovesTier || []), ...(type.hatesTier || [])];
  car.legendaryCount = tiers.filter(tier => tier === 'legendary').length;
  car.terribleCount = tiers.filter(tier => tier === 'terrible').length;
}
/**
 * One frame of traffic: show or hide the car meshes with the people; rebuild the lanes if the roads have changed and
 * re-seat the cars on them (reseatCar); make the car count match S.trafficAmount, capped by TRAFFIC_MAX and the roads'
 * capacity; give a design to any car without one; sort each lane's cars into `ahead` order; then drive every car —
 * chosen speed, steering, route, wheels, placement, and running over anyone in its way.
 * @param {number} t - seconds since page load
 * @returns {void}
 */
export function updateTraffic(t) {
  if (followedCar >= 0 && (!S.peopleEnabled || S.interactionMode !== 'move')) stopFollowingCar();
  const dt = S.lastTrafficTime == null ? 0 : Math.min(0.1, Math.max(0, t - S.lastTrafficTime));
  S.lastTrafficTime = t;
  carHoloTimeUniform.value = t;
  carParts.all.forEach(mesh => { mesh.visible = S.peopleEnabled; });
  carMeshes.forEach(cm => { cm.mesh.visible = S.peopleEnabled; });
  if (!S.peopleEnabled) { updateEngines([], null, null, dt); return; }
  if (!S.trafficNav || (S.trafficNavDirty && t - S.trafficNavBuiltAt > 0.25 && !navRebuildOnHold())) {
    S.trafficNavDirty = false;
    S.trafficNavBuiltAt = t;
    S.trafficNav = buildTrafficNav();
    cars.forEach(car => { if (car !== drivenCar) reseatCar(car); });
  }
  const wanted = Math.min(TRAFFIC_MAX, Math.round(S.trafficAmount), S.trafficNav.capacity);
  while (cars.length < wanted) { const car = newCar(); spawnCar(car); cars.push(car); }
  if (cars.length > wanted) cars.length = wanted;
  if (followedCar >= cars.length) stopFollowingCar();
  carParts.all.forEach(mesh => { mesh.count = cars.length; });
  // who's in front of whom: cars in the same lane going the same way, in order along it
  const lanes = new Map();
  cars.forEach(car => {
    if (car.li < 0 && S.trafficNav.lines.length) spawnCar(car);
    car.ahead = null;
    if (car.li < 0 || car === drivenCar) return; // (the one being driven isn't in any lane — see "driving a car")
    const key = car.li*2 + (car.dir > 0 ? 1 : 0);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(car);
  });
  lanes.forEach(list => {
    list.sort((a, b) => (a.u - b.u)*a.dir);
    for (let k=0;k<list.length-1;k++) list[k].ahead = list[k+1];
    if (list.length > 1 && S.trafficNav.lines[list[0].li].loop) list[list.length-1].ahead = list[0]; // (round the loop)
  });
  buildCarGrid();
  const lying = App.people.filter(isLying); // (anyone on the ground, for cars to stop for: see lyingAhead)
  const { matrix } = placing;
  const designCounts = carMeshes.map(() => 0);
  cars.forEach((car, i) => {
    if (car.li < 0) { matrix.makeScale(0, 0, 0); carParts.body.setMatrixAt(i, matrix); if (S.showRoadsafetyDebug) carHitboxDebugMesh.setMatrixAt(i, matrix); return; }
    if (car.design == null && carMeshes.length) {
      car.design = Math.floor(trafficRng()*carMeshes.length);
      car.length = carMeshes[car.design].length;
      car.number = ++designNumbers[car.design];
      car.plate =  carPlate(car);
    }
    if (car.design != null) refreshCarTraits(car);
    if (car === drivenCar) { if (goingUnder(car)) sinkCar(car, dt); else { driveByHand(car, dt); if (car.sinking?.rising) riseCar(car, dt); } turnWheels(car, dt); updateSpecialTraits(car, t, dt); placeCar(car, i, designCounts); return; }
    if (car.fuse != null) { burnFuse(car, dt); placeCar(car, i, designCounts); return; } // (about to blow: it neither drives nor turns)
    if (goingUnder(car)) { sinkKnockedCar(car, dt); turnWheels(car, dt); updateSpecialTraits(car, t, dt); placeCar(car, i, designCounts); return; }
    // cruise, but ease off for the car in front and slow down into junctions
    const cruise = CAR_SPEED*S.peopleSpeed*(car.traits?.speed ?? 1);
    let target = cruise;
    if (car.ahead) {
      // (along each car's own lane rather than the road, since a lane runs quicker round the inside of a bend)
      const nav = S.trafficNav.lines[car.li], along = (laneLength(nav, car.dir, car.ahead.u) - laneLength(nav, car.dir, car.u))*car.dir;
      const gap = (along < 0 ? along + laneLength(nav, car.dir, nav.total) : along) - (carLength(car) + carLength(car.ahead))/2; // (round a loop)
      target = Math.min(target, Math.max(0, (gap - 2*S.peopleSize)*1.2*S.peopleSpeed));
    }
    // (and for whichever other car gapAhead finds in its way, in its lane or not)
    const block = gapAhead(car);
    if (block.gap < Infinity) target = Math.min(target, Math.max(0, (block.gap - CAR_STOP_GAP*S.peopleSize)*1.2*S.peopleSpeed));
    waitOrGiveUp(car, block.by, dt);
    const lyingGap = lyingAhead(car, lying); // (and for anyone lying in the road it's noticed, however long they're there)
    if (lyingGap != null) target = Math.min(target, Math.max(0, lyingGap*1.5*S.peopleSpeed));
    const ahead = junctionAhead(car, 8);
    // (and, coming up to a dead end within 12 sizes of it, stays short of the end while another car sits where it would
    // come round into — but only for 2*GIVE_UP_AFTER seconds, since that car may be queued behind this car's own lane)
    const uTurnWait = ahead && ahead.deadEnd && ahead.dist < 12*S.peopleSize && uTurnBlocked(car);
    car.uTurnWaited = uTurnWait ? car.uTurnWaited + (car.speed < 0.3 ? dt : 0) : 0;
    if (uTurnWait && car.uTurnWaited < GIVE_UP_AFTER*2) {
      target = Math.min(target, Math.max(0, (ahead.dist - carLength(car)*0.5)*1.5*S.peopleSpeed));
    }
    if (ahead && ahead.dist < 10) target = Math.min(target, cruise*(0.45 + 0.055*ahead.dist));
    // stop for a red light — or an amber one there's still room to stop for — with the front bumper at the stop line
    const junction = ahead && S.roadJunctionByPlace.get(placeKey(ahead.x, ahead.z));
    const stopAt = junction ? junction.r + 3.2 + carLength(car)*0.5 : carLength(car)*0.5 + S.peopleSize;
    if (junction) {
      const lane = lanePoint(car), tx = Math.sin(lane.heading), tz = Math.cos(lane.heading);
      const arm = junction.arms.reduce((best, a) => -(a.x*tx + a.z*tz) > -(best.x*tx + best.z*tz) ? a : best, junction.arms[0]); // the arm it's coming in on
      const state = signalState(junction, arm.phase, t);
      if (state !== 2 && ahead.dist > stopAt - 0.5 && (state === 0 || ahead.dist > stopAt + 3)) {
        target = Math.min(target, Math.max(0, (ahead.dist - stopAt)*1.5*S.peopleSpeed));
      }
    }
    // (and at the stop line while the road it's turning onto is full — see "not filling up dead ends")
    if (ahead && !ahead.deadEnd && ahead.dist < 30*S.peopleSize && waitToTurn(car, ahead, dt) && ahead.dist > stopAt - 0.5) {
      target = Math.min(target, Math.max(0, (ahead.dist - stopAt)*1.5*S.peopleSpeed));
    }
    if (checkYield(car, dt) || car.kick) target = 0; // (or knocked off its route, and waiting to be back on it)
    car.speed += Math.max(-CAR_BRAKE*(car.traits?.braking ?? 1)*S.peopleSpeed*dt, Math.min(5*S.peopleSpeed*dt, target - car.speed));
    // (its point on the route is further than u along the middle of the road round the outside of a bend, a U or a turn
    // across a junction, and nearer round the inside, so it's driven as much further as holds its speed steady)
    const back = CAR_REAR_AXLE*carLength(car);
    let travel = car.speed*dt;
    if (travel > 0) {
      const here = routePoint(car, back), on = routePoint(car, back + ROUTE_SAMPLE);
      const moved = Math.hypot(on.x - here.x, on.z - here.z);
      if (moved > 1e-6) travel *= Math.max(0.25, Math.min(4, ROUTE_SAMPLE/moved));
    }
    driveAlong(car, travel);
    // its front axle is put on its route (see routePoint) and its back axle, CAR_REAR_AXLE of its length behind, follows
    // it round, so the back end cuts in on a bend
    let knocked = null; // (how a knocked car is moving)
    if (car.kick) { car.x -= car.kick.x; car.z -= car.kick.z; knocked = stepKick(car, dt); } // (knocked off its route by a bump: the offset is taken off while it's put back on it, so it can't turn it round)
    const front = routePoint(car, back);
    const pullX = front.x - (car.x - back*Math.sin(car.heading)), pullZ = front.z - (car.z - back*Math.cos(car.heading));
    if (car.kick) { // (off its route: it keeps the heading the knock left it, turning only to face the way back)
      car.heading = car.kick.heading;
      car.x = front.x - back*Math.sin(car.heading) + car.kick.x;
      car.z = front.z - back*Math.cos(car.heading) + car.kick.z;
    } else if (Math.hypot(pullX, pullZ) > 1e-6) {
      car.heading = Math.atan2(pullX, pullZ);
      car.x = front.x - back*Math.sin(car.heading);
      car.z = front.z - back*Math.cos(car.heading);
    }
    if (car.kick || car.floatDrop > 0) knockedIntoWater(car, knocked, dt);
    if (car.sinking?.rising) riseCar(car, dt);
    const lane = lanePoint(car), offLane = Math.abs(Math.atan2(Math.sin(lane.heading - car.heading), Math.cos(lane.heading - car.heading)));
    if (knocked && Math.hypot(knocked.x, knocked.z) > 0.3) runOverPeople(car, knocked);
    else if (car.speed > 0.3 && offLane < TURN_SAFE_ANGLE) runOverPeople(car);
    turnWheels(car, dt);
    updateSpecialTraits(car, t, dt);
    placeCar(car, i, designCounts);
  });
  // (each car that has burnt out blows up, and any car near it too — as an ordinary explosion, so they set nothing else off)
  const burntOut = wreckedCars.splice(0), blasted = new Set(burntOut);
  const reach = DETONATION_REACH*S.peopleSize;
  burntOut.forEach(car => App.people.forEach((p, i) => { // (people in the blast die, thrown clear of it)
    const dx = p.x - car.x, dz = p.z - car.z, d = Math.hypot(dx, dz);
    if (!p.indoors && d <= reach && Math.abs(p.y - Y_ROAD) <= reach) App.killPerson(i, 'player', { x: dx/(d || 1)*BLAST_THROW, y: 0, z: dz/(d || 1)*BLAST_THROW });
  }));
  burntOut.forEach(car => forCarsNear(car.x, car.z, reach, other => { if (Math.hypot(other.x - car.x, other.z - car.z) <= reach) blasted.add(other); }));
  if (drivenCar && blasted.has(drivenCar)) { const driven = drivenCar; stopDriving(); blasted.add(driven); } // (the driver is thrown out of it, and it goes too)
  blasted.forEach(car => { const i = cars.indexOf(car); if (i >= 0) killCar(i); });
  for (let i = cars.length - 1; i >= 0; i--) if (cars[i] !== drivenCar && cars[i].sinking?.under) drownCar(i); // (knocked in and gone under)
  if (drivenCar?.sinking?.under) { const driven = drivenCar, at = { x: driven.x, z: driven.z }; stopDriving(); Object.assign(driven, at); drownCar(cars.indexOf(driven)); } // (gone under: it sinks away quietly, with a splash, rather than blowing up)
  updateEngines(cars, drivenCar, engineOf, dt);
  carHitboxDebugMesh.visible = S.showRoadsafetyDebug;
  if (S.showRoadsafetyDebug) { carHitboxDebugMesh.count = cars.length; carHitboxDebugMesh.instanceMatrix.needsUpdate = true; }
  carParts.matrix.needsUpdate = true;
  const glowFactor = computeWindowGlowFactor(S.sunElevation);
  carMeshes.forEach((cm, d) => {
    cm.mesh.count = designCounts[d];
    cm.mesh.instanceMatrix.needsUpdate = true;
    cm.paint.needsUpdate = true;
    cm.wheels.needsUpdate = true;
    cm.plates.needsUpdate = true;
    cm.holo.needsUpdate = true;
    cm.rust.needsUpdate = true;
    cm.glowUniform.value = glowFactor;
  });
  // the camera onto whoever it's following, at about their roof — and driving it, round behind it
  if (followedCar >= 0) { const car = cars[followedCar]; controls.goalTarget.set(car.x, Y_ROAD + carHeight(car)*(drivenCar ? 1.1 : 0.6), car.z); }
  if (drivenCar) chaseCamera(drivenCar);
}
/**
 * A car knocked off its lane (car.kick), each frame: floated if it has the aqua trait (updateFloating, which also lets
 * a floated car settle back once it's on the road again), else sent down (startSinking) once its centre is over open
 * water — carried on along its heading at the speed the knock left it going that way.
 * @param {object} car
 * @param {?{x: number, z: number}} knocked - how the knock is moving it, from stepKick
 * @param {number} dt
 * @returns {void}
 */
function knockedIntoWater(car, knocked, dt) {
  if (car.traits?.aqua) { updateFloating(car, dt); return; }
  if (!car.kick || goingUnder(car) || !overOpenWater(car.x, car.z)) return;
  startSinking(car);
  car.speed = knocked ? knocked.x*Math.sin(car.heading) + knocked.z*Math.cos(car.heading) : 0;
  Object.assign(car.kick, { vx: 0, vz: 0, speed: 0, driving: 0 });
}
/**
 * One frame of a knocked car going down (sinkCar), its knock's offset from its route moved with it, so that if it's
 * carried back over land (sinking.rising) it carries on from there, climbing out and driving back to its lane.
 * @param {object} car
 * @param {number} dt
 * @returns {void}
 */
function sinkKnockedCar(car, dt) {
  const x = car.x, z = car.z;
  sinkCar(car, dt);
  if (car.kick) { car.kick.x += car.x - x; car.kick.z += car.z - z; car.kick.heading = car.heading; }
}

Object.assign(App, { pickCar, followCarAt, followCar, stopFollowingCar, driveCar, stopDriving, killCar, smiteCar, strikeWithAircraft, carsNearby, carsWhere });
