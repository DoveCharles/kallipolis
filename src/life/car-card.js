import { App } from '../core/shared.js';
import { carThumbnailScene } from './traffic.js';
import { makeThumbnailDrawer } from './thumbnail.js';

// ============================================================ car card
// Who's behind the wheel, in a card at the bottom right while the camera follows a vehicle (see "following a car" in
// traffic.js): its name (its model and a number of its own, among others like it — see designNumbers in traffic.js), its
// mood (what kind of vehicle it is, as an emoji), and what it enjoys and hates — the same for every one of them.
let shown = -1; // whoever the card is showing, for its Kill button
const card = document.getElementById('car-card');
document.getElementById('car-card-close').addEventListener('click', () => App.stopFollowingCar());
// the Kill button, under the thumbnail: it blows up on the spot (see killCar in traffic.js), and the card goes
document.getElementById('cc-kill').addEventListener('click', () => { if (shown >= 0) App.killCar(shown); });
function showCarCard(i, info) {
  shown = i;
  document.getElementById('cc-name').textContent = info.name;
  document.getElementById('cc-mood').textContent = info.mood;
  document.getElementById('cc-enjoys').textContent = 'Beep beep';
  document.getElementById('cc-hates').textContent = 'Honkkkk';
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
