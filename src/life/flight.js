import { controls } from '../core/camera-controls.js';
import { controlInput, flying } from './possession.js';

// ============================================================ hand flying
// The flying model shared by everything the player can take the controls of in the air (an aircraft in zones/airport.js;
// a bee hovers instead, in life/bees.js): stepFlight moves its `hand` state on a frame from the keys held, and the caller poses whatever
// it is from that state. To make something else flyable, give it a hand (makeHand), a craft description and a pose.
// The tuning below is for an international jet at scale 1.
const FLY_SPEED = 46, FLY_SPEED_MIN = 22, FLY_SPEED_MAX = 105;   // units a second, at the size an international jet is
const FLY_POWER = 26, FLY_DRAG = 14, FLY_GRAVITY = 40;           // how hard the throttle, the air and the weight pull on that speed
const FLY_PITCH_RATE = 0.9, FLY_BANK_RATE = 2.2, FLY_TURN = 1.1; // radians a second: the nose, the wings, and how fast a full bank comes round
const FLY_PITCH_MAX = 0.85, FLY_BANK_MAX = 1.05, FLY_LEVEL = 1.4; // how far it will go, and how briskly a stall or the ground straightens it
const FLY_CEILING = 900, FLY_STALL = 0.7;                         // and where the air runs out, and the speed below which the nose drops
const FLY_CONTROL_LAG = 0.25, FLY_MOMENTUM = 0.35;                // seconds: the weight behind the stick, and how long the flight path trails the nose
const FLY_RIGHTING = 0.75, FLY_TRIM = 0.8, FLY_BITE_MIN = 0.4;    // let go, how keenly it rolls level and trims out; and how heavy the stick goes when slow
const FLY_ROLLING = 0.6, FLY_GROUND_TURN = 0.9;                   // on the ground: the share of its speed the wheels lose a second, and the fastest it steers round (radians a second)
/**
 * One frame of a hand-flown aircraft from the keys held (controlInput). W and S put the nose down and up, A and D drop a
 * wing — and it is the dropped wing that turns it, the way a real one turns, so a bank held over comes round a circle
 * rather than sliding sideways. Shift is power and space is the airbrake. Climbing bleeds speed off and diving puts it
 * back on, and too slow a climb drops the nose by itself. On the ground it steers like a car instead: A and D turn it as
 * fast as its speed allows, and it rolls to a stop when left alone, until it has the speed to lift the nose (S) and go.
 *
 * What the keys ask for is a rate — how fast to roll, how fast to raise the nose — and the aeroplane takes a moment
 * (FLY_CONTROL_LAG) to get there and the same moment to stop again, so a tap eases the wings over instead of snapping
 * them and there is some weight behind the stick. The slower it flies the less the air does for it, so the controls go
 * heavy towards the stall. Let go and it rights itself the way a stable aeroplane does — the bank falling away and the
 * nose trimming out over a few seconds — rather than being hauled level, so it can be left alone for a moment without
 * falling out of the sky, but a bank held and released still settles gently instead of springing back.
 *
 * It carries its own momentum too: the flight path trails the nose by FLY_MOMENTUM rather than following it exactly, so
 * a turn swings through and a sharp pull slides a little before it bites, which is most of what makes it feel heavy.
 *
 * It cannot go under the ground: the ground stops it, levels it and lets it run along like a landing, which is friendlier
 * than a crash and means a bad approach just ends with a bump.
 * @param {object} hand Its state, from makeHand; moved on in place.
 * @param {number} dt Seconds this frame.
 * @param {object} craft What it is flying: `scale` multiplies the speeds and forces, which are written for an international
 *   jet (a light one flies smaller and slower); `size` sets how wide a circle it steers on the ground; `floor`
 *   is the height of the ground under it; `ceiling` where the air runs out; `crashAngle` how steeply (radians) it can meet
 *   the ground before it is wrecked (never, if left out).
 * @param {{forward: number, right: number, run: boolean, brake: boolean}} [input] What is being asked of it: the keys held
 *   unless given (see autopilot).
 * @returns {void}
 */
export function stepFlight(hand, dt, { scale, size, floor, ceiling = FLY_CEILING, crashAngle = Infinity }, input = controlInput()) {
  const { forward, right, run, brake } = input;
  const toward = (v, goal, rate) => v + Math.max(-rate*dt, Math.min(rate*dt, goal - v));
  const ease = (v, goal, seconds) => v + (goal - v)*(1 - Math.exp(-dt/seconds)); // (frame-rate independent, unlike a flat fraction)
  const cruise = FLY_SPEED*scale, stall = FLY_SPEED_MIN*scale;
  // on its wheels, and not lifting off: it drives like a car (A and D steer it, and only while it is moving; shift is
  // power and space the brake, and left alone it rolls to a stop) until the nose comes up and it leaves the ground
  const grounded = hand.y <= floor + size*0.02 && (hand.pitch <= 0.05 || hand.speed < stall/FLY_STALL); // (too slow to lift off, however far the nose is up)
  // how much the air is doing for it: full authority at cruise, heavy and vague down at the stall
  const bite = Math.max(FLY_BITE_MIN, Math.min(1, hand.speed/cruise));
  // the stick, as a rate rather than an attitude. W dives and S climbs, the way round a stick is: pushed forward the
  // nose drops. Let go, what it asks for instead is its own way back — a roll out of the bank and a nose back to trim,
  // both of them gentler the nearer it already is, so it rolls level rather than being snapped there.
  const askedPitch = (forward ? -forward*FLY_PITCH_RATE : -hand.pitch*FLY_TRIM)*bite;
  const askedBank = (right ? -right*FLY_BANK_RATE : -hand.bank*FLY_RIGHTING)*bite;
  // ...and the aeroplane takes a moment to reach the rate asked of it, and the same moment to stop again
  hand.pitchRate = ease(hand.pitchRate, askedPitch, FLY_CONTROL_LAG);
  hand.bankRate = ease(hand.bankRate, askedBank, FLY_CONTROL_LAG);
  hand.pitch += hand.pitchRate*dt;
  hand.bank += hand.bankRate*dt;
  if (grounded) { hand.bank = 0; hand.bankRate = 0; } // (the stick steers the wheels, not the wings)
  // as far over as it goes: the stop holds it there rather than the rate winding on against it
  if (Math.abs(hand.pitch) > FLY_PITCH_MAX) { hand.pitch = Math.sign(hand.pitch)*FLY_PITCH_MAX; hand.pitchRate = 0; }
  if (Math.abs(hand.bank) > FLY_BANK_MAX) { hand.bank = Math.sign(hand.bank)*FLY_BANK_MAX; hand.bankRate = 0; }
  // too slow to hold the nose up, and it drops whatever the stick says — further in, the faster it falls
  const sinking = Math.max(0, 1 - hand.speed/(stall/FLY_STALL));
  if (sinking > 0 && hand.pitch > -0.35) { hand.pitch = toward(hand.pitch, -0.35, FLY_LEVEL*sinking); hand.pitchRate = Math.min(hand.pitchRate, 0); }
  // speed: the throttle against the drag, less whatever the climb is costing (or the dive paying back)
  const throttle = (brake ? -FLY_POWER : run ? FLY_POWER : 0)*scale;
  hand.thrust = brake ? 0.2 : run ? 1 : grounded ? 0.3 : 0.6; // (how hard the engines are working, for their sound: see audio/aircraft.js)
  const power = throttle + (grounded ? -hand.speed*FLY_ROLLING : (cruise - hand.speed)*FLY_DRAG/cruise);
  hand.speed = Math.max(grounded ? 0 : stall*0.6, Math.min(FLY_SPEED_MAX*scale,
    hand.speed + (power - Math.sin(hand.pitch)*FLY_GRAVITY*scale)*dt));
  if (grounded) {
    // steered like a car: the wheels turn it as fast as its speed allows, a wide circle for a big aircraft
    hand.heading -= right*Math.min(FLY_GROUND_TURN, hand.speed/(size*0.8))*dt;
  } else {
    // the bank is what turns it, and the turn is sharper the slower it is going
    hand.heading += Math.sin(hand.bank)*FLY_TURN*dt*Math.min(2, cruise/Math.max(1, hand.speed));
  }
  // where it is pointing, and then where it is actually going — which trails the nose rather than being it, so the
  // aeroplane swings through a turn and slides for a moment before a pull takes effect
  const level = Math.cos(hand.pitch)*hand.speed;
  // (on its wheels it goes where it points, with no sliding)
  hand.vx = grounded ? Math.sin(hand.heading)*level : ease(hand.vx, Math.sin(hand.heading)*level, FLY_MOMENTUM);
  hand.vz = grounded ? Math.cos(hand.heading)*level : ease(hand.vz, Math.cos(hand.heading)*level, FLY_MOMENTUM);
  hand.vy = ease(hand.vy, Math.sin(hand.pitch)*hand.speed, FLY_MOMENTUM);
  hand.x += hand.vx*dt;
  hand.y += hand.vy*dt;
  hand.z += hand.vz*dt;
  // the ground underneath and the thin air above
  if (hand.y <= floor) {
    if (!hand.onGround && hand.vy < -TOUCHDOWN_SINK*scale) {
      // meeting the ground hard enough to bounce — or, if it came in past `crashAngle` (steeper than that on the way
      // down, nose or wing that far over), to be wrecked: hand.crashed, for whoever poses it to blow it up
      hand.sinceTouchdown = 0;
      const descent = Math.atan2(-hand.vy, Math.hypot(hand.vx, hand.vz));
      hand.crashed = Math.max(descent, Math.abs(hand.pitch), Math.abs(hand.bank)) > crashAngle;
    }
    hand.onGround = true;
    hand.y = floor;
    hand.vy = Math.max(0, hand.vy);
    hand.pitch = Math.max(hand.pitch, 0);
    hand.bank = toward(hand.bank, 0, FLY_LEVEL*3); // (a wing tip can't stay in the tarmac, however gentle the air is)
    hand.bankRate = 0;
  } else hand.onGround = false;
  if (hand.y > ceiling) { hand.y = ceiling; hand.vy = Math.min(0, hand.vy); hand.pitch = Math.min(hand.pitch, 0); }
  // the bounce of a touchdown, to be added to how it is posed: up by `hop`, wings rocked by `rock`, nose down by `dip`
  // (never taking the nose below level)
  hand.sinceTouchdown += dt;
  const bounce = touchdownBounce(hand.sinceTouchdown, size);
  hand.hop = bounce.hop; hand.rock = bounce.rock; hand.dip = Math.min(bounce.dip, Math.max(0, hand.pitch));
}

const TOUCHDOWN_SINK = 1; // how fast, at scale 1, it has to be dropping onto the ground for it to bounce
const BOUNCE_HEIGHT = 0.02, BOUNCE_TIME = 0.4, BOUNCE_ROLL = 0.06, BOUNCE_PITCH = 0.08; // (of the craft's size; seconds; radians; radians)
/**
 * How a craft is jolted for BOUNCE_TIME seconds after touching down: hopping up and back down, its wings rocking one way
 * and the other and its nose dipping and coming back up. All zero once the bounce is over.
 * @param {number} since - seconds since it touched down
 * @param {number} size - the craft's size (its wingspan), which the hop is a fraction of
 * @returns {{hop: number, rock: number, dip: number}} height gained, roll added, and pitch taken off, in world units and radians
 */
export function touchdownBounce(since, size) {
  if (!(since >= 0 && since < BOUNCE_TIME)) return { hop: 0, rock: 0, dip: 0 };
  const through = since/BOUNCE_TIME;
  return { hop: Math.sin(Math.PI*through)*BOUNCE_HEIGHT*size, rock: Math.sin(2*Math.PI*through)*BOUNCE_ROLL, dip: Math.sin(Math.PI*through)*BOUNCE_PITCH };
}

/**
 * A craft's state as the controls take it over, already going where it was pointing so the handover is invisible.
 * @param {{x: number, y: number, z: number, heading: number, pitch?: number, speed: number}} from
 * @returns {object} the hand to give stepFlight
 */
export function makeHand({ x, y, z, heading, pitch = 0, speed }) {
  return { x, y, z, heading, pitch, bank: 0, speed, pitchRate: 0, bankRate: 0, onGround: false, crashed: false, sinceTouchdown: Infinity, hop: 0, rock: 0, dip: 0,
    vx: Math.sin(heading)*Math.cos(pitch)*speed, vy: Math.sin(pitch)*speed, vz: Math.cos(heading)*Math.cos(pitch)*speed };
}

/** The speed a craft of this scale settles to with nothing held. */
export const cruiseSpeed = scale => FLY_SPEED*scale;

const CHASE_HOLD = 1500, CHASE_EASE = 0.3, CHASE_PHI = 1.15; // (ms the mouse holds the camera; the share of the way back it's asked for each frame; how high it sits)
/**
 * Ease the camera round behind a craft that is heading `heading`, unless the mouse has swung it somewhere lately. Call
 * each frame while it is being flown.
 * @param {number} heading
 * @returns {void}
 */
export function chaseBehind(heading) {
  if (performance.now() - flying.lookedAt < CHASE_HOLD) return;
  const behind = heading + Math.PI;
  controls.goalTheta = controls.theta + CHASE_EASE*Math.atan2(Math.sin(behind - controls.theta), Math.cos(behind - controls.theta));
  controls.goalPhi = controls.phi + CHASE_EASE*(CHASE_PHI - controls.phi);
}

const AUTO_BANK_MAX = 0.7, AUTO_CLIMB_MAX = 0.3, AUTO_GAIN = 3; // (radians; radians; the stick asked for per radian out)
/**
 * The input that flies a craft toward a point: banks toward its bearing, climbs or descends toward its height, and holds
 * cruising speed. Give it to stepFlight in place of the keys.
 * @param {object} hand
 * @param {{x: number, y: number, z: number}} target
 * @param {{scale: number}} craft - as for stepFlight
 * @returns {{forward: number, right: number, run: boolean, brake: boolean}}
 */
export function autopilot(hand, { x, y, z }, { scale }) {
  const dx = x - hand.x, dz = z - hand.z, cruise = FLY_SPEED*scale;
  const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));
  const headingError = Math.atan2(Math.sin(Math.atan2(dx, dz) - hand.heading), Math.cos(Math.atan2(dx, dz) - hand.heading));
  const wantBank = clamp(headingError*1.5, AUTO_BANK_MAX);
  const wantPitch = clamp(Math.atan2(y - hand.y, Math.max(1, Math.hypot(dx, dz))), AUTO_CLIMB_MAX);
  return { right: -clamp((wantBank - hand.bank)*AUTO_GAIN, 1), forward: -clamp((wantPitch - hand.pitch)*AUTO_GAIN, 1),
    run: hand.speed < cruise*0.9, brake: hand.speed > cruise*1.25 };
}
