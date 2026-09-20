import { App } from '../core/shared.js';
import { carThumbnailScene } from './traffic.js';
import { makeThumbnailDrawer } from './thumbnail.js';
import { makeCard } from '../ui/entity-card.js';
import { garbles, garbled } from '../ui/garble.js';
import { hashNameToNumber } from '../core/math.js';

// ============================================================ car card
// Who's behind the wheel, in a card at the bottom right while the camera follows a vehicle (see "following a car" in
// traffic.js): its name (its type's and a number of its own, among others like it — see designNumbers in traffic.js), its
// mood, and what it loves and hates — all from assets/cars.txt, by its type (see car-types.js). The card itself is the
// shared one in ui/entity-card.js.
let shown = -1; // whoever the card is showing, for its thumbnail and its Kill button
const card = makeCard({
  id: 'car-card',
  title: 'Vehicle',
  onClose: () => App.stopFollowingCar(),
  // the thumbnail itself: behind the wheel (see "driving a car" in traffic.js)
  thumb: { title: 'Drive it', onClick: () => { if (shown >= 0) App.driveCar(shown); } },
  // the Kill button, under the thumbnail: it blows up on the spot (see killCar in traffic.js), and the card goes
  kill: { title: 'Blow it up', onClick: () => { if (shown >= 0) App.killCar(shown); } },
});

function showCarCard(i, info) {
  shown = i;
  // `info` is what the car's type says (see car-types.js), traits and all: the card itself turns those into its rows.
  // A car with the scramble or keysmash trait (a texting driver, say) has its loves, hates and headings garbled (see
  // ui/garble.js), differently from another with the same trait since its own name seeds it.
  const { traits } = info, seed = hashNameToNumber(info.name || '', 3);
  card.relabel(garbles(traits) ? text => garbled(text, traits, seed) : null);
  card.show({ ...info, loves: garbled(info.loves, traits, seed), hates: garbled(info.hates, traits, seed) });
  drawCarThumbnail(i);
}
function hideCarCard() {
  shown = -1;
  card.hide();
}

// the thumbnail: an isometric-angled view of the car's own design (see carThumbnailScene), drawn once when the card opens
const drawThumbnail = makeThumbnailDrawer(card.canvas);
function drawCarThumbnail(i) { drawThumbnail(carThumbnailScene(i)); } // (no thumbnail of a box car, before the models have loaded)

Object.assign(App, { showCarCard, hideCarCard });
