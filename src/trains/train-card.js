import { App } from '../core/shared.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';

// ============================================================ train card
// Which carriage the camera's following (see "following a carriage" in trains.js), in a card at the bottom right like the
// car card: its name and mood, a picture of it, and what it enjoys and hates — from assets/trains.txt, read the same way
// as the vehicles' and the buildings' files (see core/type-text.js) — and who's riding it. No Kill button: trains can't
// be killed.
const trains = loadTypeText('assets/trains.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'], // can have several per carriage, like people: see [distribution] in trains.txt
  // this stands in until trains.txt has loaded, or if it can't be
  placeholder: { default: { name: ['Train'], mood: ['🚆'], loves: ['Shoooom'], hates: ['Delays'] } },
});
const card = makeCard({
  id: 'train-card',
  title: 'Train',
  onClose: () => App.stopFollowingTrain(),
  labels: { occupants: 'Passengers' },
});
const drawThumbnail = makeThumbnailDrawer(card.canvas);

// `info.number` is the carriage's place among the lines and `info.view` its thumbnail (see trainThumbnailOf in trains.js)
function showTrainCard(info) {
  const type = trains.of(null, info.number);
  card.show({ ...type, name: type.name + ' #' + info.number });
  setTrainCardPassengers([]);
  drawThumbnail(info.view);
}
function hideTrainCard() {
  card.hide();
}

// who's riding the followed carriage (see "riding the trains" in people.js): their names, one a line — the one at
// `tracked` (whoever the camera came aboard with, or a name that's since been clicked) highlighted, and `onPick` told
// when a name is clicked, to get off with that one instead
function setTrainCardPassengers(names, tracked = -1, onPick = null) {
  card.setList('occupants', names, tracked, onPick && { title: 'Follow them off the train', onClick: onPick });
}

Object.assign(App, { showTrainCard, hideTrainCard, setTrainCardPassengers });
