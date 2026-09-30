import { people, peopleRng, pickFrom } from './people.js';
import { freeSeat, leaveGroup, standingSpot, takeSeat } from './peopleActivities.js';
import { plateSpot, serveMeal } from './peopleHolding.js';
import { roomRoute, roomSeats, roomVisit, roomWalkable } from '../../buildings/interior.js';
import { WAITER, waiterAt, waiterBusy, waiterCarry, waiterClear, waiterDoor, waiterDoorWay, waiterLeave, waiterSay, waiterGo, waiterHide, waiterLook, waiterMoving, waiterPace, waiterPose, waiterReach,
  waiterServe, waiterServing, waiterSleep, waiterStand, waiterTalk, waiterTurn, waiterUp } from '../../buildings/waiterbot.js';

// ============================================================ the waiter's round
// What the restaurant's waiter (buildings/waiterbot.js) does, and the diners with it. Whoever comes in to eat queues by
// the host stand (queueForTable); the waiter has a word with them (babble only: a group with `babble` set), shows them to
// a table, and leaves them to sit down. A little later it's back at the table in its Waiting pose to take the order: it
// babbles (looking at each of them), each of them babbles in turn, it babbles once more, and it goes off through the
// kitchen doors and back out. Once the food's cooked it fetches it, up to a plate in each hand (more at the table, more
// trips), sets each down in front of whoever ordered it, and the meal's theirs (servedMeal). Idle, it waits behind the
// stand; with nobody in, it sleeps there. Whoever's eaten leaves their empty plate on the table as they get up (leavePlate),
// and once they've gone it clears them, two at a time, off to the kitchen; and it thanks whoever leaves past the stand. Its jobs are generators, run a frame at a time (runWaiter).
const ORDER_AFTER = [6, 14];   // s after sitting down before it comes for the order
const COOK = [14, 28];         // s the kitchen takes
const KITCHEN_STAY = 2.5;      // s it's out of sight through the doors
const MEAL_GIVE_UP = 240;      // s a diner waits before the food just comes (see sitting in peopleActivities.js)
const FOLLOW_GAP = 1.1;        // m behind the waiter someone it's showing to a table keeps
const CLEAR_AFTER = 4;         // s after someone's got up before it clears their plate
const THANK_NEAR = 1.6;        // m from the host stand someone leaving is thanked
const QUEUE_GIVE_UP = 90;      // s someone queues before giving up and wandering off

let visit = null, job = null, dt = 0, clock = 0;
const queue = [], diners = [], dirty = []; // dirty: { at, dish, thing, table, from }
let inKitchen = false;
// diners: { p, seat, table, state: 'wait' | 'ordered' | 'fetching', orderAt, dish, readyAt }
const between = ([lo, hi]) => lo + peopleRng()*(hi - lo);

/** Whether diners go through the waiter here: it's up in the restaurant the view's in. */
export const waiterOn = () => waiterUp();

/**
 * Send someone to queue by the host stand, if there's a seat they'd sit on.
 * @param {Person} p - someone in the restaurant (p.inRoom set)
 * @param {?object} [from] - where they're walking from, if not where they are (the doorway, coming in)
 * @returns {boolean} whether they're queueing
 */
export function queueForTable(p, from = null) {
  if (!waiterOn() || queue.includes(p) || !freeSeat(p)) return false;
  const stand = waiterStand(), f = { x: Math.sin(stand.yaw), z: Math.cos(stand.yaw) }, s = { x: -f.z, z: f.x };
  let spot = null;
  for (const side of [0, 0.5, -0.5]) {
    const far = 0.85 + 0.55*queue.length, x = stand.host.x + f.x*far + s.x*side, z = stand.host.z + f.z*far + s.z*side;
    if (roomWalkable(x, z)) { spot = { x, y: p.y, z }; break; }
  }
  if (!spot) return false;
  const start = from ?? p, route = roomRoute(start, spot);
  if (!route) return false;
  queue.push(p);
  p.inRoom.host = { route: from ? [from, ...route] : route, waited: 0 };
  p.inRoom.route = null;
  p.faceTo = null;
  return true;
}
/**
 * Someone queueing for a table, for a frame: over to the host stand, then waiting there, facing it.
 * @returns {?{x: number, z: number}} where to walk to, or null
 */
export function waitForTable(p, here, delta) {
  const host = here.host;
  if (host.follow) {
    // (shown to a table: after the waiter, a step or so behind, the way round things worked out afresh as it goes)
    const w = waiterAt();
    if (Math.hypot(w.x - p.x, w.z - p.z) < FOLLOW_GAP) { host.route = null; p.faceTo = Math.atan2(w.x - p.x, w.z - p.z); return null; }
    p.faceTo = null;
    if ((host.replan -= delta) <= 0 || !host.route?.length) {
      host.replan = 0.4;
      const to = { x: w.x, y: p.y, z: w.z };
      host.route = roomRoute(p, to) ?? [to];
    }
    if (Math.hypot(host.route[0].x - p.x, host.route[0].z - p.z) < 0.2) host.route.shift();
    return host.route[0] ?? null;
  }
  if (host.route?.length) {
    const next = host.route[0];
    if (Math.hypot(next.x - p.x, next.z - p.z) >= 0.2) return next;
    host.route.shift();
    if (host.route.length) return host.route[0];
    host.route = null;
  }
  const stand = waiterStand().host;
  p.faceTo = Math.atan2(stand.x - p.x, stand.z - p.z);
  if ((host.waited += delta) > QUEUE_GIVE_UP) { here.host = null; here.wait = 1; }
  return null;
}
/** Someone the waiter showed to a table, sat down: waiting for it to take their order. */
export function awaitWaiter(p, seat) {
  p.inRoom.led = false;
  p.inRoom.meal = 'wait';
  p.inRoom.mealBy = MEAL_GIVE_UP;
  diners.push({ p, seat, table: seat.table, state: 'wait', orderAt: clock + between(ORDER_AFTER), dish: null, readyAt: 0 });
}
/** A diner's food set down in front of them: spaghetti (with a fork), or a pizza eaten a slice at a time. */
export function servedMeal(p, dish = peopleRng() < 0.5 ? 'pizza' : 'spaghetti') {
  const here = p.inRoom;
  if (!here?.seat?.diner) return;
  here.meal = null;
  here.dined = dish; here.ate = false;
  p.pose = dish === 'pizza' ? 'Sit1' : 'Eating';
  serveMeal(p, here.seat.diner.top, dish);
  here.timer = (20 + peopleRng()*60)*p.traits.patience;
}

/** Someone getting up from a meal the waiter's to clear away: their empty plate left on the table (from standUp). */
export function leavePlate(p) {
  const here = p.inRoom, dish = here?.dined;
  if (!dish || !here.seat?.diner || here.visit !== roomVisit() || !waiterOn()) return;
  here.dined = null;
  const at = plateSpot(p);
  at.y = here.seat.diner.top;
  const plate = dish === 'pizza' ? 'tray' : 'plate';
  dirty.push({ at, dish: plate, thing: waiterLeave(plate, at), table: here.seat.table, from: clock + CLEAR_AFTER });
}

// ---- the waiter's jobs
const inRoom = p => p.inRoom?.visit === visit;
const queued = p => inRoom(p) && !!p.inRoom.host;
const seated = d => inRoom(d.p) && d.p.inRoom.seat === d.seat && !!d.p.inRoom.meal;
const held = seat => !!seat.by && seat.by.inRoom?.seat === seat && seat.by.inRoom.visit === roomVisit();

/**
 * Run the waiter for a frame (from updateGroups in peopleActivities.js).
 * @param {number} delta - seconds since the last frame
 */
export function runWaiter(delta) {
  dt = delta;
  clock += delta;
  if (!waiterOn()) { job = null; return; }
  if (visit !== roomVisit()) { visit = roomVisit(); job = null; queue.length = 0; diners.length = 0; dirty.length = 0; inKitchen = false; }
  thank();
  for (let k = queue.length - 1; k >= 0; k--) if (!queued(queue[k])) queue.splice(k, 1);
  for (let k = diners.length - 1; k >= 0; k--) if (diners[k].state !== 'fetching' && !seated(diners[k])) diners.splice(k, 1);
  job ??= nextJob();
  try { if (job.next().done) job = null; }
  catch (e) { // (a job gone wrong: dropped, food and all, rather than carried into the next)
    console.error(e);
    job = null;
    waiterCarry(null, null); waiterPose('DefaultPose'); waiterPace(1); waiterHide(false); waiterDoorWay(0); inKitchen = false;
    diners.forEach(d => { if (d.state === 'fetching') d.state = 'ordered'; });
  }
}
function nextJob() {
  const ready = diners.find(d => d.state === 'ordered' && clock >= d.readyAt);
  if (ready) return deliver(ready.table);
  if (queue.length) return greet(queue[0]);
  const due = diners.find(d => d.state === 'wait' && clock >= d.orderAt);
  if (due) return order(due.table);
  const plate = dirty.find(d => clock >= d.from);
  if (plate) return clear(plate);
  return idle();
}
// 'Thank you for coming!' to whoever's leaving past the host stand
function thank() {
  if (inKitchen) return;
  const host = waiterStand().host;
  for (const p of people) {
    const here = p.inRoom;
    if (!here?.leaving || here.thanked || here.visit !== visit || Math.hypot(p.x - host.x, p.z - host.z) > THANK_NEAR) continue;
    here.thanked = true;
    waiterSay('Thank you for coming!', p);
    return;
  }
}

function* wait(t) { while ((t -= dt) > 0) yield; }
// walk to `spot` ({ x, z }, and `yaw` to face once there; its own `route`, if it has one)
function* goTo(spot) {
  const from = waiterAt();
  if (Math.hypot(spot.x - from.x, spot.z - from.z) > 0.05) waiterGo(spot.route ?? roomRoute(from, { ...spot, y: from.y }) ?? [spot], spot.yaw ?? null);
  else if (spot.yaw != null) waiterTurn(spot.yaw);
  while (waiterMoving()) yield;
}
// a word with some diners: the waiter, or one of them, babbling a while, the rest looking at them
function chat(members) {
  const g = { kind: 'waiter', babble: true, sat: true, members: [], speaker: null };
  for (const p of members) {
    if (p.group) leaveGroup(p);
    p.group = g; p.lookAt = WAITER; p.chatCooldown = Math.max(p.chatCooldown ?? 0, 10);
    g.members.push(p);
  }
  return g;
}
function* say(g, who, t) {
  g.speaker = who;
  waiterTalk(who === WAITER);
  if (who !== WAITER) waiterLook(who);
  g.members.forEach(m => { m.lookAt = m === who || who === WAITER ? WAITER : who; });
  while ((t -= dt) > 0 && g.members.length) yield;
  waiterTalk(false);
  g.speaker = null;
}
function endChat(g) {
  waiterTalk(false);
  g.speaker = null;
  for (const p of g.members.splice(0)) if (p.group === g) { p.group = null; p.lookAt = null; }
}

// behind the host stand: awake while anyone's in, asleep once they've all gone
function* idle() {
  const stand = waiterStand(), at = waiterAt();
  waiterLook(null);
  waiterPose('DefaultPose');
  if (Math.hypot(stand.x - at.x, stand.z - at.z) > 0.1) { waiterSleep(false); yield* goTo(stand); return; }
  if (Math.abs(stand.yaw - at.yaw) > 0.05) waiterTurn(stand.yaw);
  waiterSleep(!waiterBusy());
  yield;
}
// greeting whoever's first in the queue, and showing them to a table
function* greet(p) {
  waiterSleep(false);
  yield* goTo(waiterStand());
  waiterLook(p);
  for (let t = 0; t < 12 && queued(p) && p.inRoom.host.route; t += dt) yield;
  if (!queued(p)) return;
  const g = chat([p]);
  yield* say(g, WAITER, between([1.2, 2]));
  yield* say(g, p, between([1, 2.5]));
  yield* say(g, WAITER, between([0.8, 1.4]));
  endChat(g);
  queue.splice(queue.indexOf(p), 1);
  const seat = queued(p) ? pickSeat() : null;
  waiterLook(null);
  if (!seat) { if (p.inRoom) { p.inRoom.host = null; p.inRoom.wait = 1; } return; }
  const here = p.inRoom;
  takeSeat(p, seat);
  here.host = { follow: true, route: null, replan: 0 }; // (after it, to the table: see waitForTable)
  const spot = tableSpot(seat.table), from = waiterAt();
  waiterGo(roomRoute(from, { ...spot, y: from.y }) ?? [spot], spot.yaw);
  while (waiterMoving()) { // (not leaving them behind)
    const gap = Math.hypot(p.x - waiterAt().x, p.z - waiterAt().z);
    waiterPace(here.host?.follow ? Math.max(0, Math.min(1, (3 - gap)/1.2)) : 1);
    yield;
  }
  waiterPace(1);
  waiterLook(p);
  for (let t = 0; t < 20 && here.host?.follow && Math.hypot(p.x - waiterAt().x, p.z - waiterAt().z) > FOLLOW_GAP + 0.3; t += dt) yield;
  if (here.host?.follow) {
    const stand = standingSpot(p, seat);
    Object.assign(here, { host: null, route: roomRoute(p, stand) ?? [stand], stage: 'go', timer: 40, led: true });
    p.faceTo = null;
  }
  for (let t = 0; t < 12 && here.seat === seat && here.stage !== 'sit'; t += dt) yield;
  waiterLook(null);
}
// taking a table's order, then off to the kitchen with it
function* order(table) {
  yield* goTo(tableSpot(table));
  const ds = diners.filter(d => d.table === table && d.state === 'wait' && seated(d));
  if (ds.length) {
    waiterPose('Waiting');
    const g = chat(ds.map(d => d.p));
    g.speaker = WAITER;
    waiterTalk(true);
    for (const m of [...g.members]) { waiterLook(m); yield* wait(between([0.6, 1.1])); }
    for (const m of [...g.members]) if (g.members.includes(m)) yield* say(g, m, between([1.2, 3]));
    yield* say(g, WAITER, between([0.8, 1.5]));
    endChat(g);
    for (const d of ds) Object.assign(d, { state: 'ordered', dish: peopleRng() < 0.5 ? 'pizza' : 'spaghetti', readyAt: clock + between(COOK) });
  }
  waiterLook(null);
  waiterPose('DefaultPose');
  yield* kitchen(() => {});
}
// fetching a table's food, a plate in each hand, and setting each down
function* deliver(table) {
  const take = diners.filter(d => d.table === table && d.state === 'ordered' && clock >= d.readyAt).slice(0, 2);
  take.forEach(d => { d.state = 'fetching'; });
  waiterLook(null);
  yield* kitchen(() => waiterCarry(take[0].dish, take[1]?.dish ?? null));
  for (const [k, d] of take.entries()) {
    const side = k ? 'R' : 'L';
    if (seated(d)) {
      yield* goTo(serveSpot(plateSpot(d.p), side));
      waiterLook(d.p);
      waiterServe(side, () => { if (seated(d)) servedMeal(d.p, d.dish); });
      while (waiterServing()) yield;
      waiterLook(null);
    }
    d.state = 'served';
    diners.splice(diners.indexOf(d), 1);
  }
  waiterCarry(null, null);
}
// clearing empty plates away, one in each hand, from the table `first`'s on, then off to the kitchen with them
function* clear(first) {
  const take = [first, ...dirty.filter(d => d !== first && d.table === first.table && clock >= d.from)].slice(0, 2);
  take.forEach(d => dirty.splice(dirty.indexOf(d), 1));
  waiterLook(null);
  waiterPose('DefaultPose');
  for (const [k, d] of take.entries()) {
    const side = k ? 'R' : 'L';
    yield* goTo(serveSpot(d.at, side));
    waiterLook(d.at);
    waiterServe(side, () => waiterClear(d.thing), d.dish);
    while (waiterServing()) yield;
    waiterLook(null);
  }
  yield* kitchen(() => waiterCarry(null, null));
}
// through the kitchen doors (swinging them open the way it's going), out of sight a moment beyond (`inside` called then), and
// back out
function* kitchen(inside) {
  const door = waiterDoor();
  if (!door) { yield* wait(KITCHEN_STAY); inside(); return; }
  yield* goTo({ ...door.out, yaw: door.yaw });
  const through = () => { const at = waiterAt(); return Math.hypot(door.in.x - at.x, door.in.z - at.z) < Math.hypot(door.in.x - door.at.x, door.in.z - door.at.z); };
  waiterDoorWay(1);
  waiterGo([door.in]);
  while (waiterMoving()) { if (through()) waiterDoorWay(0); yield; } // (out of sight past the passage's back: see kitchenWay in interior.js)
  waiterHide(true);
  waiterDoorWay(0);
  inKitchen = true;
  yield* wait(KITCHEN_STAY);
  inside();
  waiterHide(false);
  waiterDoorWay(-1);
  yield* wait(0.15);
  waiterGo([door.out]);
  while (waiterMoving()) { if (!through()) inKitchen = false; yield; }
  waiterDoorWay(0);
  inKitchen = false;
}

// a free seat at a table: now and then with others already there, else at an empty table
function pickSeat() {
  const seats = roomSeats().filter(seat => seat.diner && seat.table != null), free = seats.filter(seat => !held(seat));
  if (!free.length) return null;
  const busy = new Set(seats.filter(held).map(seat => seat.table));
  const joining = free.filter(seat => busy.has(seat.table)), empty = free.filter(seat => !busy.has(seat.table));
  return pickFrom(joining.length && (!empty.length || peopleRng() < 0.35) ? joining : empty);
}
// somewhere to stand by a table, facing it: clear of its seats, nearest the waiter
function tableSpot(table) {
  const seats = roomSeats().filter(seat => seat.table === table), at = waiterAt();
  const c = { x: 0, z: 0 };
  seats.forEach(seat => { c.x += seat.x/seats.length; c.z += seat.z/seats.length; });
  let best = null;
  for (let r = 0.9; r <= 1.6 && !best; r += 0.15) for (let k = 0; k < 16; k++) {
    const a = k*Math.PI/8, x = c.x + Math.sin(a)*r, z = c.z + Math.cos(a)*r;
    if (!roomWalkable(x, z) || seats.some(seat => Math.hypot(seat.x - x, seat.z - z) < 0.45)) continue;
    const d = Math.hypot(x - at.x, z - at.z);
    if (!best || d < best.d) best = { x, z, d, yaw: Math.atan2(c.x - x, c.z - z) };
  }
  return best ?? { x: c.x, z: c.z + 1, yaw: Math.PI };
}
// where to stand so the hand (`side`) setting a plate down (or picking one up) lands on `plate` (in the world): round it,
// the nearest that can be got to, clear of the seats
function serveSpot(plate, side) {
  const reach = waiterReach(side), at = waiterAt();
  let best = null;
  for (let k = 0; k < 24; k++) {
    const yaw = k*Math.PI/12, c = Math.cos(yaw), s = Math.sin(yaw);
    const x = plate.x - (reach.x*c + reach.z*s), z = plate.z - (-reach.x*s + reach.z*c);
    if (roomSeats().some(seat => Math.hypot(seat.x - x, seat.z - z) < 0.4)) continue;
    const route = roomRoute(at, { x, y: at.y, z });
    if (!route) continue;
    let d = 0, from = at;
    for (const q of route) { d += Math.hypot(q.x - from.x, q.z - from.z); from = q; }
    if (!best || d < best.d) best = { x, z, yaw, d, route };
  }
  if (best) return best;
  const yaw = Math.atan2(plate.x - at.x, plate.z - at.z), c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: plate.x - (reach.x*c + reach.z*s), z: plate.z - (-reach.x*s + reach.z*c), yaw };
}
