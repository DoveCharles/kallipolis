import { addMoney } from '../ui/money.js';
import { worldNow } from '../core/shared.js';

// What people pay at stalls and shops, out of their wallet (p.wallet: see newPerson in people/people.js), and the
// business tax the player takes of it.
export const PRICE = 4, TAX = 0.5;
const BROKE_GAP = 45; // (seconds between someone grumbling about being too poor)

/** Whether someone has the money. @param {object} p @param {number} [price] */
export const canAfford = (p, price = PRICE) => (p.wallet ?? 0) >= price;

const RICH = 100, POOR_WILL = 0.15; // (£ at which money stops putting them off; how keen the skint still are)
/** How keen someone is to buy: their shopping trait, less the less money they have. @param {object} p @returns {number} */
export const spendWill = p => p.traits.shopping*(POOR_WILL + (1 - POOR_WILL)*Math.min(1, (p.wallet ?? 0)/RICH));
/** How drawn to a mall: as spendWill, but none for anyone who can't afford anything. @param {object} p @returns {number} */
export const mallWill = p => canAfford(p) ? spendWill(p) : 0;

/**
 * Someone paying, if they can: out of their wallet, TAX of it to the player.
 * @param {object} p @param {number} [price] @returns {boolean} whether they paid
 */
export function pay(p, price = PRICE) {
  if (!canAfford(p, price)) return false;
  p.wallet -= price;
  addMoney(Math.round(price*TAX));
  return true;
}

/**
 * Someone who couldn't pay: felt 'broke' (for what they say: {felt = broke} in life/speech-text.js), now and then.
 * @param {object} p @param {(p: object, what: string) => void} feel - people.js feel
 */
export function tooPoor(p, feel) {
  const now = worldNow();
  if (p.felt?.what === 'broke' && now - p.felt.at < BROKE_GAP) return;
  feel(p, 'broke');
}
