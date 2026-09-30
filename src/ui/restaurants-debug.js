import { App } from '../core/shared.js';
import { openWindow } from './w3-window.js';
import { buildingsInZones } from '../buildings/building-card.js';
import { buildingKey, buildingNumber, roomLayoutOf, restaurantStyleOf } from '../buildings/footprints.js';
import { buildingKindOf } from '../buildings/building-types.js';
import { sushiChef } from '../buildings/interior.js';
import { chefOrder } from '../buildings/waiterbot.js';

// View > Restaurants (debug): every restaurant, by style; click one to go inside.
const STYLES = ['italian', 'greek', 'sushi'];

function fill(body) {
  const found = { italian: [], greek: [], sushi: [] };
  for (const b of buildingsInZones()) {
    const key = buildingKey(b.zone, b.index);
    if (roomLayoutOf(buildingKindOf(b.group, b.zone), buildingNumber(key)) === 'restaurant') found[restaurantStyleOf(key)]?.push(key);
  }
  body.innerHTML = STYLES.map(s => `<div style="margin:4px 0"><b>${s}</b> (${found[s].length})<div style="display:flex;flex-wrap:wrap;gap:3px">
    ${found[s].map(k => `<button data-key="${k}">${k}</button>`).join('') || '<i>none</i>'}</div></div>`).join('')
    + '<button id="rd-refresh" style="margin-top:4px">Refresh</button> <button id="rd-chef">Chef: serve a plate</button>';
  body.querySelectorAll('[data-key]').forEach(el => el.addEventListener('click', () => {
    if (App.isInsideBuilding?.()) App.leaveBuildingInside();
    App.enterBuildingWith(el.dataset.key);
  }));
  body.querySelector('#rd-refresh').addEventListener('click', () => fill(body));
  // (a plate to a random chef's-bar stool, gone again after a while)
  body.querySelector('#rd-chef').addEventListener('click', () => {
    const spots = sushiChef()?.plates;
    if (spots?.length) chefOrder(spots[Math.floor(Math.random()*spots.length)], o => setTimeout(() => o.removeFromParent(), 8000));
  });
}

/** Open the restaurants debug window, or bring it to the front. */
export function openRestaurantsDebug() {
  const win = openWindow({ id: 'restaurants-debug', title: 'Restaurants (debug)', width: 260, fill });
  win.style.transform = 'none';
  win.style.left = (innerWidth - win.offsetWidth - 10) + 'px';
  win.style.top = '60px';
}
