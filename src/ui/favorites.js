import { App, S } from '../core/shared.js';

// ============================================================ favorites
// Whatever the player has hearted on its card (see the heart in ui/entity-card.js) — a person, a car, a bee, a building,
// anything with a card — listed in a little window under the ♥ button beside undo and redo, each with the picture its
// card had when it was hearted. Clicking one there has the camera follow it again, the way a click on it in the world
// would.
//
// Each favorite is { key, kind, name, thumb, follow }: `key` is whatever tells that one thing apart from the rest of its
// kind (an index, a line id, the object itself), `kind` is its name among the things the camera follows (see FOLLOWABLE
// in editor/input.js), and `follow` finds it again and follows it, handing back false if it's no longer there to follow
// (a car that's been blown up, a building whose zone has gone). Most last as long as the page does; a kind that can be
// found again in a reloaded city (a person: see life/person-card.js) gives its entries `saved`, what finding it again
// takes, and they're kept in the project (see savedFavorites and restoreFavorites), so they're still there after a reload.
// An entry that `spares` its thing takes the Smite button off its card while it's hearted (see ui/entity-card.js).
//
// A hearted person is kept: never let go of when the crowd thins (see updatePeople in life/people/people.js), and never
// killed, by a car or anything else (killPerson, and runOverPeople in life/traffic.js, which knocks them down instead).
const favorites = new Map();
const listeners = [];

export const isFavorite = key => favorites.has(key);
// the key a person's favorite goes by: their place in the crowd, which is who they are (see profileOf in life/profiles.js)
export const personKey = i => 'person:' + i;
export const isFavoritePerson = i => favorites.has(personKey(i));
// the places in the crowd of everyone hearted, highest first (kept up to date, as the crowd asks every frame)
let keptPeople = [];
export const favoritePeople = () => keptPeople;
function changed() {
  keptPeople = [...favorites.values()].filter(fav => fav.kind === 'Person').map(fav => fav.saved.index).sort((a, b) => b - a);
  render();
  listeners.forEach(fn => fn());
}
// `entry` as above, less its picture and name, which are passed in as they are at the moment it's hearted
export function toggleFavorite(entry, name, thumb) {
  if (favorites.has(entry.key)) favorites.delete(entry.key);
  else favorites.set(entry.key, { ...entry, name, thumb, gone: false });
  changed();
}
// told whenever something's hearted or unhearted, from a card or from the list
export const onFavoritesChanged = fn => listeners.push(fn);

// ---- kept in the project: the entries that can be found again, as { kind, kindLabel, name, thumb, ...saved }. Each such
// kind says how to make its entry again from that (see reviveFavoritesAs), and loading a project puts back its own of
// those kinds in place of whatever was hearted before (see loadProjectFromData in project/save-load.js).
const revivers = {};
// `revive(saved)` hands back the entry, { key, kind, follow, saved, ... }, as the card would have given it
export const reviveFavoritesAs = (kind, revive) => { revivers[kind] = revive; };
export function savedFavorites() {
  return [...favorites.values()].filter(fav => fav.saved && revivers[fav.kind])
    .map(fav => ({ kind: fav.kind, kindLabel: fav.kindLabel, name: fav.name, thumb: fav.thumb, ...fav.saved }));
}
export function restoreFavorites(list) {
  favorites.forEach((fav, key) => { if (revivers[fav.kind]) favorites.delete(key); });
  (Array.isArray(list) ? list : []).forEach(item => {
    const revive = revivers[item?.kind];
    if (!revive) return;
    const entry = revive(item);
    if (entry) favorites.set(entry.key, { ...entry, kindLabel: item.kindLabel || item.kind, name: item.name || item.kindLabel || item.kind, thumb: item.thumb || null, gone: false });
  });
  changed();
}
// ---- the button and its window
const button = document.getElementById('btn-favorites');
const panel = document.getElementById('favorites-panel');
const list = panel.querySelector('.fav-list');

function render() {
  list.textContent = '';
  if (!favorites.size) {
    const empty = document.createElement('div');
    empty.className = 'fav-empty';
    empty.textContent = 'Nothing yet. Heart something on its card to keep it here.';
    list.append(empty);
    return;
  }
  favorites.forEach(fav => {
    const row = document.createElement('button');
    row.className = 'fav-row' + (fav.gone ? ' fav-gone' : '');
    row.title = fav.gone ? 'Not to be found any more' : 'Follow';
    const img = document.createElement('img');
    img.className = 'fav-thumb';
    img.alt = '';
    if (fav.thumb) img.src = fav.thumb;
    const text = document.createElement('span');
    text.className = 'fav-text';
    const name = document.createElement('span');
    name.className = 'fav-name';
    name.textContent = fav.name;
    const kind = document.createElement('span');
    kind.className = 'fav-kind';
    kind.textContent = fav.gone ? fav.kindLabel + ' · gone' : fav.kindLabel;
    text.append(name, kind);
    row.append(img, text);
    row.addEventListener('click', () => followFavorite(fav));
    list.append(row);
  });
}

function followFavorite(fav) {
  // the camera only follows things in World mode
  if (S.interactionMode !== 'move') document.querySelector('#mode-toolbar .tool-btn[data-mode="move"]')?.click();
  App.letGoOfAllBut(fav.kind);
  fav.gone = !fav.follow();
  render();
  if (!fav.gone) setOpen(false);
}

function setOpen(open) {
  panel.hidden = !open;
  button.classList.toggle('on', open);
}
button.addEventListener('click', () => setOpen(panel.hidden));
// a click anywhere else puts it away
document.addEventListener('pointerdown', e => {
  if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) setOpen(false);
});
render();
