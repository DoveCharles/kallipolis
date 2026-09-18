import { App } from '../core/shared.js';
import { beeThumbnailScene, hiveThumbnailScene } from './bees.js';
import { makeThumbnailDrawer } from './thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';

// ============================================================ bee and hive cards
// The two cards for a park's bees (see life/bees.js): one for a bee the camera's following and one for a hive, both the
// shared card in ui/entity-card.js. They pair up the way a person and a building do — a bee's card says which hive it's
// in while it's home, and a hive's lists the bees indoors, under "Bees" where a building says "Inhabitants". Their text
// comes from assets/bees.txt, read like the vehicles' and the trains' files (see core/type-text.js), by [bee] or [hive].
// No Kill button on either: nothing here wants to be the thing that kills the bees.
const text = loadTypeText('assets/bees.txt', {
  attributes: TEXT_ROWS,
  // this stands in until bees.txt has loaded, or if it can't be
  placeholder: { bee: { name: ['Bee'], mood: ['🐝'], loves: ['Flowers'], hates: ['Rain'] }, default: { name: ['Hive'], mood: ['🍯'], loves: ['Flowers'], hates: ['Bears'] } },
});

const beeCard = makeCard({ id: 'bee-card', title: 'Bee', onClose: () => App.stopFollowingBee() });
const hiveCard = makeCard({ id: 'hive-card', title: 'Hive', onClose: () => App.stopFollowingHive(), labels: { occupants: 'Bees' } });
const drawBeeThumbnail = makeThumbnailDrawer(beeCard.canvas);
const drawHiveThumbnail = makeThumbnailDrawer(hiveCard.canvas);

// what a bee or a hive is called, on its own card and on the other's: its kind and its own number (see numberFor in bees.js)
export const beeName = number => text.of('bee', number).name + ' #' + number;
export const hiveName = number => text.of('hive', number).name + ' #' + number;

function showBeeCard(number) {
  beeCard.show({ ...text.of('bee', number), name: beeName(number) });
  drawBeeThumbnail(beeThumbnailScene());
}
// what it's up to: which hive it's in while it's home, the way a person's card says which building they're inside, and
// otherwise where it is in its round (see the flight states in bees.js)
function setBeeCardDoing(doing) {
  beeCard.set('status', doing);
}
function hideBeeCard() { beeCard.hide(); }

function showHiveCard(number) {
  hiveCard.show({ ...text.of('hive', number), name: hiveName(number) });
  setHiveCardBees([]);
  drawHiveThumbnail(hiveThumbnailScene());
}
// which of its bees are home, by name — the one the camera came in with, if any, picked out as a train's passengers are
function setHiveCardBees(names, tracked = -1) {
  hiveCard.setList('occupants', names, tracked);
}
function hideHiveCard() { hiveCard.hide(); }

Object.assign(App, { showBeeCard, setBeeCardDoing, hideBeeCard, showHiveCard, setHiveCardBees, hideHiveCard });
