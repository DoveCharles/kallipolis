// ============================================================ health
// Hit points for anything that can be hurt. Each kind registers once (registerHealthKind) with its maximum and how it
// dies; its spawn calls resetHealth. Anything that hurts calls damage(entity, amount, source); at 0 the kind's `die` runs.
// Health lives on the entity as `entity.health = { kind, hp, max }`, made on first use if a spawn missed it.

const kinds = new Map();      // kind → { max, die, alive }
const listeners = new Set();  // (entity) => void, on any change

/**
 * @param {string} kind
 * @param {{ max: number | ((entity: object) => number), die: (entity: object, source: any) => void,
 *   alive?: (entity: object) => boolean }} spec  `alive`, checked after `die`: true means it survived (hearted, respawn
 *   trait…), so its health is put back to full.
 */
export function registerHealthKind(kind, { max, die, alive = () => false }) {
  kinds.set(kind, { max: typeof max === 'function' ? max : () => max, die, alive });
}

/** Full health for a (re)spawned entity of `kind`. */
export function resetHealth(entity, kind) {
  const max = kinds.get(kind)?.max(entity) ?? 1;
  entity.health = { kind, hp: max, max };
  notify(entity);
}

/** The entity's health record, made at full if it has none yet. */
export function healthOf(entity, kind) {
  if (!entity.health || (kind && entity.health.kind !== kind)) resetHealth(entity, kind);
  return entity.health;
}

// The unstable trait: its value is the chance a hit does UNSTABLE_MULTIPLIER times the damage, and at least
// UNSTABLE_MIN_SHARE of the entity's max health.
const UNSTABLE_MULTIPLIER = 5, UNSTABLE_MIN_SHARE = 0.2;
function unstableHit(entity, amount) {
  const chance = entity.traits?.unstable ?? 0;
  if (amount <= 0 || chance <= 0 || Math.random() >= chance) return amount;
  return Math.max(amount*UNSTABLE_MULTIPLIER, UNSTABLE_MIN_SHARE*entity.health.max);
}

/** Take `amount` hit points (negative heals). At 0 the kind's `die` runs. */
export function damage(entity, amount, source = null) {
  const h = entity?.health;
  if (!h || h.hp <= 0) return;
  amount = unstableHit(entity, amount);
  h.hp = Math.max(0, Math.min(h.max, h.hp - amount));
  notify(entity);
  if (h.hp > 0) return;
  const kind = kinds.get(h.kind);
  kind?.die(entity, source);
  if (kind?.alive(entity)) resetHealth(entity, h.kind);
}

export const heal = (entity, amount) => damage(entity, -amount);

/** 0 to 1; 1 for anything without health. */
export const healthFraction = entity => entity?.health ? entity.health.hp / entity.health.max : 1;

/** Calls `fn(entity)` whenever any entity's health changes. Returns an unsubscribe function. */
export function onHealthChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(entity) { listeners.forEach(fn => fn(entity)); }
