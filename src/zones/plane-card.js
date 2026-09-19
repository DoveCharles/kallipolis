import { App } from '../core/shared.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';

// ============================================================ plane card
// Which aircraft the camera's following (see "watching and flying" in airport.js), in a card at the bottom right like the
// train's: its name and mood, a picture of it, and what it loves and hates — from assets/planes.txt, read the same way as
// the trains' and the vehicles' files (see core/type-text.js). Clicking the picture takes the controls off it, the way
// clicking a car's picture gets you behind the wheel. No Kill button: there's nothing in here to blow up.
const planes = loadTypeText('assets/planes.txt', {
  attributes: TEXT_ROWS,
  // this stands in until planes.txt has loaded, or if it can't be
  placeholder: { default: { name: ['Flight'], mood: ['✈️'], loves: ['A tailwind'], hates: ['Holding'] } },
});
const card = makeCard({
  id: 'plane-card',
  title: 'Aircraft',
  onClose: () => App.stopFollowingPlane(),
  // the picture itself: at the controls (see "the flying itself" in airport.js)
  thumb: { title: 'Fly it', onClick: () => App.flyPlane() },
  labels: { occupants: 'Passengers' },
});
const drawThumbnail = makeThumbnailDrawer(card.canvas);

// `info.number` is the aircraft's place among all of them and `info.view` its picture (see planeThumbnailOf in airport.js)
function showPlaneCard(info) {
  const type = planes.of(null, info.number);
  card.show({ ...type, name: type.name + ' #' + info.number });
  drawThumbnail(info.view);
}
function hidePlaneCard() {
  card.hide();
}

Object.assign(App, { showPlaneCard, hidePlaneCard });
