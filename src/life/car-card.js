import { App } from '../core/shared.js';
import { carThumbnailScene } from './traffic.js';
import { makeThumbnailDrawer } from './thumbnail.js';

// ============================================================ car card
// Who's behind the wheel, in a card at the bottom right while the camera follows a vehicle (see "following a car" in
// traffic.js): its name (its type's and a number of its own, among others like it — see designNumbers in traffic.js), its
// mood, and what it loves and hates — all from assets/cars.txt, by its type (see car-types.js).
let shown = -1; // whoever the card is showing, for its Kill button
const card = document.getElementById('car-card');
document.getElementById('car-card-close').addEventListener('click', () => App.stopFollowingCar());
// the thumbnail itself: behind the wheel (see "driving a car" in traffic.js)
document.getElementById('cc-thumb').addEventListener('click', () => { if (shown >= 0) App.driveCar(shown); });
// the Kill button, under the thumbnail: it blows up on the spot (see killCar in traffic.js), and the card goes
document.getElementById('cc-kill').addEventListener('click', () => { if (shown >= 0) App.killCar(shown); });
function showCarCard(i, info) {
  shown = i;
  document.getElementById('cc-name').textContent = info.name;
  document.getElementById('cc-mood').textContent = info.mood;
  document.getElementById('cc-loves').textContent = info.loves;
  document.getElementById('cc-hates').textContent = info.hates;
  card.hidden = false;
  drawCarThumbnail(i);
}
function hideCarCard() {
  shown = -1;
  card.hidden = true;
}

// the thumbnail: an isometric-angled view of the car's own design (see carThumbnailScene), drawn once when the card opens
const drawThumbnail = makeThumbnailDrawer(document.getElementById('cc-thumb'));
function drawCarThumbnail(i) { drawThumbnail(carThumbnailScene(i)); } // (no thumbnail of a box car, before the models have loaded)

Object.assign(App, { showCarCard, hideCarCard });
