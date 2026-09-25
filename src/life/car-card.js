import { App } from '../core/shared.js';
import { carThumbnailScene } from './traffic/traffic.js';
import { BOOST_UNLOCK } from './traffic/driving.js';
import { makeThumbnailDrawer } from './thumbnail.js';
import { makeCard } from '../ui/entity-card.js';
import { garbles, garbled } from '../ui/garble.js';
import { hashNameToNumber } from '../core/math.js';
import { showCarDetails, hideCarDetails } from './car-details.js';

// ============================================================ car card
// Who's behind the wheel, in a card at the bottom right while the camera follows a vehicle (see "following a car" in
// traffic/follow.js): its name (its type's and a number of its own, among others like it — see designNumbers in traffic/models.js), its
// mood, and what it loves and hates — all from assets/text/cars.txt, by its type (see car-types.js). The card itself is the
// shared one in ui/entity-card.js.
let shown = -1; // whoever the card is showing, for its thumbnail and its Smite button
const card = makeCard({
  id: 'car-card',
  title: 'Vehicle',
  health: true,
  onClose: () => App.stopFollowingCar(),
  // the thumbnail itself: behind the wheel (see "driving a car" in traffic/driving.js)
  thumb: { title: 'Drive it', onClick: () => { if (shown >= 0) App.driveCar(shown); } },
  // the Smite button, under the thumbnail: lightning strikes it and it blows up on the spot (see smiteCar in traffic/follow.js), and the card goes
  kill: { title: 'Strike it down', onClick: () => { if (shown >= 0) App.smiteCar(shown); } },
});

function showCarCard(i, info, car) {
  shown = i;
  // `info` is what the car's type says (see car-types.js), traits and all: the card itself turns those into its rows.
  // A car with the scramble or keysmash trait (a texting driver, say) has its loves, hates and headings garbled (see
  // ui/garble.js), differently from another with the same trait since its own name seeds it.
  const { traits } = info, seed = hashNameToNumber(info.name || '', 3);
  card.relabel(garbles(traits) ? text => garbled(text, traits, seed) : null);
  card.show({ ...info, loves: garbled(info.loves, traits, seed), hates: garbled(info.hates, traits, seed) });
  drawCarThumbnail(i);
  card.setFavorite({ key: car, kind: 'Car', follow: () => App.followCar(car) });
  card.bindHealth(car, 'car');
  showCarDetails(car, card.el);
  showBoost();
}
function hideCarCard() {
  shown = -1;
  card.hide();
  hideCarDetails();
  showBoost();
}

// the thumbnail: an isometric-angled view of the car's own design (see carThumbnailScene), drawn once when the card opens
const drawThumbnail = makeThumbnailDrawer(card.canvas);
function drawCarThumbnail(i) { drawThumbnail(carThumbnailScene(i)); } // (no thumbnail of a box car, before the models have loaded)

// ---------------------------------------------------------- boost meter
// A vertical gauge (.meter.meter-vertical, src/ui/meter.css) grouped with the card by sitting right against its left
// edge (see #car-boost-meter in css/base.css) and as tall as it, shown with it only while the car's being driven
// (setCarBoostShown, from traffic/driving.js). No .meter-center: unlike the morality
// meter it has nothing to call "neutral" to mark, just 0 upward.
// Driven by the car's own maxboost trait, in seconds of boost it has to spend (see boostMax in traffic/driving.js):
// setCarBoost below is called from there — once when the card opens (showing whatever level the car already has) and
// then every frame it's actually driven, as it's spent holding run.
const boostMeter = document.createElement('div');
boostMeter.id = 'car-boost-meter';
boostMeter.className = 'meter meter-vertical';
boostMeter.hidden = true;
boostMeter.innerHTML =
  '<div class="win3-titlebar"><div class="win3-title">Boost</div></div>' +
  '<div class="meter-head"><span class="meter-title">Boost</span></div>' +
  '<div class="meter-readout">' +
    '<span class="meter-value">—</span>' +
    '<div class="meter-track"><div class="meter-bar"><div class="meter-fill"></div><div class="boost-reserve"></div></div></div>' +
  '</div>';
document.body.append(boostMeter);
const boostFill = boostMeter.querySelector('.meter-fill');
const boostValue = boostMeter.querySelector('.meter-value');
const boostReserve = boostMeter.querySelector('.boost-reserve'); // (the band below BOOST_UNLOCK of the gauge, shaded: run dry, it must refill past it)
let driving = false;
// as tall as the card: matched on showing and whenever the card changes size
const matchCard = () => { if (card.el.offsetHeight) boostMeter.style.height = card.el.offsetHeight + 'px'; };
const showBoost = () => { boostMeter.hidden = !(driving && shown >= 0); if (!boostMeter.hidden) matchCard(); };
/**
 * Show the boost meter beside the car card, or not: on while a car's being driven, off once it's let go.
 * @param {boolean} on
 * @returns {void}
 */
function setCarBoostShown(on) { driving = on; showBoost(); }
new ResizeObserver(matchCard).observe(card.el);
/**
 * Show how much boost a car has left: `left` of `max` seconds (see boostMax, traffic/driving.js), as a fraction filling
 * the gauge bottom-to-top and the seconds themselves, to one decimal place, below it. The band under BOOST_UNLOCK is
 * shaded; while `locked` it's marked so, and `refused` (boost held while locked) makes it flash.
 * @param {number} left - seconds of boost left
 * @param {number} max - seconds of boost it started with
 * @param {boolean} [locked] - run dry, and not yet refilled past BOOST_UNLOCK
 * @param {boolean} [refused] - boost is being held while locked
 * @returns {void}
 */
function setCarBoost(left, max, locked = false, refused = false) {
  boostFill.style.height = (max > 0 ? Math.max(0, Math.min(1, left/max)) : 0)*100 + '%';
  boostValue.textContent = Math.max(0, left).toFixed(1);
  boostReserve.style.height = BOOST_UNLOCK*100 + '%';
  boostMeter.classList.toggle('boost-locked', !!locked);
  boostMeter.classList.toggle('boost-refused', !!refused);
}

Object.assign(App, { showCarCard, hideCarCard, setCarBoost, setCarBoostShown });
