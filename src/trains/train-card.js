import { App } from '../core/shared.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';

// ============================================================ train card
// Which carriage the camera's following (see "following a carriage" in trains.js), in a card at the bottom right like the
// car card: its name and mood, a picture of it, and what it enjoys and hates — the same for every train. No Kill button: trains can't be killed.
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

Object.assign(App, { showTrainCard, hideTrainCard });
