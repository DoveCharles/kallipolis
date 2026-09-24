import * as THREE from 'three';
import { App, S } from '../../core/shared.js';
import { isOpenWater } from '../../water/water.js';
import { peopleNav } from './people.js';
import { reseatPerson } from './peoplePathing.js';

// ============================================================ getting off the road
// Someone knocked flat out on the road (onPavement: the carriageway and its kerb), once they've lain there their usual
// while, doesn't get up where they are: they crawl, slowly, to the nearest ground off it — never into open water — and get
// up there (punched.stage 'crawl', between 'down' and 'rise': see updatePunched in peopleActivities.js). Cars stop for
// them meanwhile, if they notice (see lyingAhead in life/traffic/spacing.js). Anyone a car knocks down is wary of the
// road for a while after (roadWaryUntil): they want a wider berth before crossing (see crossingClear in peoplePathing.js).
// None of it goes by roadsafety.

const CRAWL_SPEED = 0.3; // (units a second, at people size 1)
const CRAWL_REACH = 20, CRAWL_STEP = 0.5, CRAWL_IN = 0.5; // (how far off the road is looked for, in what steps, and how far onto the ground they crawl)
const CRAWL_LIFT = 0.28; // (how far above the ground someone crawling face down is drawn from, at people size and height 1)
const CRAWL_WOBBLE = 0.08, CRAWL_WOBBLES_PER_SECOND = 1.2; // (how far they swing side to side as they drag themselves, in radians, and how often)
const ROAD_WARY_TIME = 45, ROAD_WARY_RADIUS = 2; // (seconds wary after a car knocks them down; how many times the usual berth they want before crossing)

const onRoad = (x, z) => !!peopleNav?.onPavement(x, z);
const offRoad = (x, z) => !onRoad(x, z) && !isOpenWater(x, z, [S.roadFootprint, S.pathFootprint]);

/**
 * Start someone who's lain their while crawling off the road, if they're on it and there's somewhere off it in reach.
 * @param {Person} p - the person, knocked down (p.punched)
 * @returns {boolean} whether they're crawling (else they get up where they are)
 */
export function crawlOffRoad(p) {
  if (p.mode === 'possessed' || !onRoad(p.x, p.z)) return false;
  const to = nearestOffRoad(p.x, p.z);
  if (!to) return false;
  // (the Fallen pose lies head behind them: turned half round, and face down (see turnCrawling), they crawl head first)
  Object.assign(p.punched, { stage: 'crawl', to, heading: Math.atan2(to.x - p.x, to.z - p.z) + Math.PI, crawlTime: 0 });
  return true;
}

/** The nearest point off the road and out of the water, a little way onto that ground, or null if there's none in reach. */
function nearestOffRoad(x, z) {
  for (let r = CRAWL_STEP; r <= CRAWL_REACH; r += CRAWL_STEP) {
    const steps = Math.max(8, Math.ceil(2*Math.PI*r/CRAWL_STEP));
    for (let k = 0; k < steps; k++) {
      const a = k/steps*Math.PI*2, dx = Math.sin(a), dz = Math.cos(a);
      if (offRoad(x + dx*r, z + dz*r)) return { x: x + dx*(r + CRAWL_IN), z: z + dz*(r + CRAWL_IN) };
    }
  }
  return null;
}

/**
 * One frame of crawling: dragged slowly toward the ground off the road, still lying, swinging a little side to side;
 * getting up once they're there.
 * @param {Person} p - the person
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateCrawl(p, dt) {
  const k = p.punched, dx = k.to.x - p.x, dz = k.to.z - p.z, d = Math.hypot(dx, dz), step = CRAWL_SPEED*S.peopleSize*dt;
  k.crawlTime += dt;
  if (d <= step) { p.x = k.to.x; p.z = k.to.z; }
  else { p.x += dx/d*step; p.z += dz/d*step; }
  p.heading = k.heading + Math.sin(k.crawlTime*CRAWL_WOBBLES_PER_SECOND*Math.PI*2)*CRAWL_WOBBLE;
  if (d <= step) {
    p.heading = k.heading + Math.PI; // (getting up facing the way they crawled)
    k.stage = 'rise'; p.pose = 'Idle';
    if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; }
    else if (p.mode === 'line' || p.mode === 'leaving') { p.mode = 'line'; reseatPerson(p); } // (onto the nearest walkway on this side, not back across to the one they were on)
  }
}

const facedown = new THREE.Quaternion(), lengthways = new THREE.Vector3(0, 0, 1);
/**
 * Turn someone crawling face down, on top of their heading (their Fallen pose turned over about its length). Returns how
 * far above p.y to draw them, so they lie on the ground rather than under it, or null when they're not crawling.
 * @param {Person} p - the person
 * @param {THREE.Quaternion} rotation - their heading, turned further in place
 * @returns {?number}
 */
export function turnCrawling(p, rotation) {
  if (p.punched?.stage !== 'crawl') return null;
  rotation.multiply(facedown.setFromAxisAngle(lengthways, Math.PI));
  return CRAWL_LIFT*p.height*S.peopleSize;
}

/** Mark someone a car has just knocked down as wary of the road for a while. */
function knockedByCar(p) {
  p.roadWaryUntil = performance.now()/1000 + ROAD_WARY_TIME;
}
/**
 * How many times the usual berth someone wants from cars before crossing: more for a while after a car knocked them down.
 * @param {Person} p - the person
 * @returns {number}
 */
export const roadWariness = p => (p.roadWaryUntil ?? 0) > performance.now()/1000 ? ROAD_WARY_RADIUS : 1;

Object.assign(App, { knockedByCar });
