import { S } from '../../core/shared.js';
import { mulberry32 } from '../../core/math.js';

// Settings and state every traffic module shares: limits, speeds, the paint palette, the cars array and the traffic
// RNG. Imports nothing from its siblings, so any of them can read it while loading.
export const TRAFFIC_MAX = 1000;          // the most cars, and the instance count the car meshes and buffers are sized for
export const CAR_SPEED = 9;               // world units per second at speed 1
export const TRAFFIC_LANE_PER_CAR = 16;   // lane length, in world units, that a road needs per car it takes
export const PED_YIELD_RADIUS = 10, PED_YIELD_CHANCE = 0.5; // how far ahead a car notices someone waiting in the road, and how often it stops for them (divided by its aggression trait: see checkYield)
export const TURN_SAFE_ANGLE = 0.35; // ~20°: while its heading is off its lane's by more than this — swinging round a corner or a dead-end U-turn (see routePoint) — a car runs nobody over, though it's still a hazard for a ped's roadsafety check
export const CAR_PAINTS = [ // [color, how common]: the PICO-8 palette
  [0x000000, 1], [0x1d2b53, 1], [0x7e2553, 1], [0x008751, 1], [0xab5236, 1], [0x5f574f, 1], [0xc2c3c7, 1], [0xfff1e8, 1],
  [0xff004d, 1], [0xffa300, 1], [0xffec27, 1], [0x00e436, 1], [0x29adff, 1], [0x83769c, 1], [0xff77a8, 1], [0xffccaa, 1]];
S.trafficAmount = 150, S.trafficNav = null, S.trafficNavBuiltAt = -Infinity, S.lastTrafficTime = null; // cars asked for; the lanes, grid and capacity (see buildTrafficNav); when they were built; the last update's time
export const cars = [];
// Blasts waiting to go off on the next traffic update, as { x, y, z, scale } — scale × DETONATION_REACH is how far they kill
// (see updateTraffic). Explosive cars and people add to it as they die, so chains of them go off a frame apart.
export const blasts = [];
export const EXPLOSIVE_SCALE = 3; // how much bigger an explosive car's blast is, reach and fireball
export const PERSON_BLAST_SCALE = 0.5; // an explosive person's (or bee's) blast, against a car's
// What a blast does to whatever's `d` from its middle: BLAST_DAMAGE × its scale at the middle, falling off in a straight
// line to nothing at its reach (see updateTraffic).
export const BLAST_DAMAGE = 250;
export const blastDamageAt = (scale, d, reach) => BLAST_DAMAGE*scale*Math.max(0, 1 - d/reach);
export const trafficRng = mulberry32(31337);
