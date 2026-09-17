import { App } from '../core/shared.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';

// ============================================================ train card
// Which carriage the camera's following (see "following a carriage" in trains.js), in a card at the bottom right like the
// car card: its name and mood, a picture of it, and what it enjoys and hates — the same for every train — and who's riding it. No Kill button: trains can't be killed.
const card = document.getElementById('train-card');
document.getElementById('train-card-close').addEventListener('click', () => App.stopFollowingTrain());
const drawThumbnail = makeThumbnailDrawer(document.getElementById('tc-thumb'));
// `info.view` is the carriage's thumbnail (see trainThumbnailOf in trains.js)
function showTrainCard(info) {
  document.getElementById('tc-name').textContent = info.name;
  document.getElementById('tc-mood').textContent = info.mood;
  card.hidden = false;
  drawThumbnail(info.view);
}
function hideTrainCard() {
  card.hidden = true;
}

// who's riding the followed carriage (see "riding the trains" in people.js): their names, one a line — the one at
// `tracked` (the person the camera came aboard with, if any) highlighted
function setTrainCardPassengers(names, tracked = -1) {
  const list = document.getElementById('tc-passengers');
  list.textContent = names.length ? '' : 'None';
  names.forEach((name, i) => {
    const row = document.createElement('div');
    row.textContent = name;
    if (i === tracked) row.className = 'tc-tracked';
    list.appendChild(row);
  });
}

Object.assign(App, { showTrainCard, hideTrainCard, setTrainCardPassengers });
