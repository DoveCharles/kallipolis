import * as THREE from 'three';
import { App } from '../core/shared.js';
import { scene, renderer } from '../core/scene.js';
import { HEADSHOT_LAYER, personModel, isGone, inRoom, lastPeopleTime } from './people/people.js';
import { personDoing } from './people/peopleTracking.js';
import { bloodLeft, isBloodlusting } from './people/peopleBlood.js';
import { profileOf, onProfilesLoaded } from './profiles.js';
import { strikeLightning } from './lightning.js';
import { makeCard } from '../ui/entity-card.js';
import { personKey, reviveFavoritesAs } from '../ui/favorites.js';
import { garbles, garbled, garbledEntry, cased } from '../ui/garble.js';
import { ranked } from './people/peopleRelations.js';
import { recentLines, onLineLogged } from './people/peopleSaid.js';
import { GIFTS, POCKET_SLOTS, giftLines, giftsLoaded, giveGift, heldSnack, onGiftsLoaded, pocketsFull, takeBack } from './gifts.js';
import { openWindow } from '../ui/w3-window.js';
import { traitKey } from '../ui/traits-known.js';
import { IS_TOUCH } from '../core/device.js';

// ============================================================ person cards
// Who someone is, in a card at the bottom right while the camera follows them (see "following someone" in people.js): their
// name, age, mood, loves and hates, from assets/text/people/*.txt (see profiles.js). The same person always gets the same
// card. The card itself is the shared one in ui/entity-card.js; people are the one kind of thing whose text doesn't come
// from a [section] file, since people/*.txt does rather more (weighted lines, traits) than the rest.
//
// Up to two are open: a name clicked in the Social tab opens the other beside it. The camera follows the focused one;
// clicking a card focuses it (App.followPerson), and closing the focused one hands focus to the other.
// (someone with the scramble or keysmash trait has the text on their card garbled, name and age aside, and the casing
// traits reach all of it, their name included: lowercase sets the lot in lower case, capitalise gives every word a
// capital; a love or hate starts with a capital by default: see ui/garble.js)

const HEADSHOT_SIZE = 120; // pixels across (shown half that, sharp on high-density screens)
const HEADSHOT_INTERVAL = 1/15, OTHER_HEADSHOT_INTERVAL = 1/4; // (the unfocused card's face is redrawn less often)
const OTHER_POLL = 500; // ms between the unfocused card's status checks
const BESIDE_GAP = 10; // px between the two cards
const FACE_WAIT = 0.5; // seconds a card newly filled waits for its headshot before showing without it
const SOCIAL_TOP = 3, SOCIAL_REFRESH = 1000;
const clearColor = new THREE.Color();

const windows = [makePersonWindow('person-card'), makePersonWindow('person-card-2')];
let focused = null; // the window the camera follows
let keepOnHide = null; // (a window left open through stopFollowingPerson: see closeWindow)
const openWindows = () => windows.filter(w => w.shown);
const otherThan = w => windows.find(x => x !== w);

function makePersonWindow(id) {
  const w = { shown: null }; // shown: { index, id, isMan, traits, seed, beside }
  const card = w.card = makeCard({
    id,
    title: 'Ped',
    health: true,
    tabs: ['Overview', 'Pockets', 'Needs', 'Social'],
    effects: true,
    onClose: () => closeWindow(w),
    // the headshot itself: into their head (see possession.js)
    thumb: { title: 'Possess them', onClick: () => { if (w.shown) App.possessPerson(w.shown.index); } },
    // the Smite button, under their headshot: a bolt of lightning comes down on them (see lightning.js) and they explode
    // (see killPerson in people.js), and the card goes
    kill: { title: 'Strike them down', onClick: () => {
      const p = personOf(w);
      if (!p || !App.spendEnergy()) return; // (1 energy: see ui/energy.js)
      strikeLightning({ x: p.x, y: p.y, z: p.z });
      App.killPerson(w.shown.index);
    } },
  });
  // clicking anywhere on it (but its close box) focuses its person
  card.el.addEventListener('pointerdown', e => {
    if (!w.shown || w === focused || e.target.closest('.win3-sysbox, .card-close')) return;
    if (w.shown.beside) App.followPersonInside(w.shown.index); else App.followPerson(w.shown.index);
  });
  card.setEffects([]); // (no statuses until they pick one up: see refreshCardStatus)

  // ---- the headshot: a live close-up of their face, beside their name — drawn a few times a second (people.js hands over
  // where their head is and which way it faces) from a camera just in front of it that sees only the people, on a clear
  // background, into a render target of its own, copied onto the card's canvas once the GPU has the pixels (read back
  // asynchronously: a plain readPixels waits for the whole frame to finish drawing)
  headshotParts(w, card);

  // ---- the Social tab: top friends and enemies (peopleRelations.js), re-ranked every SOCIAL_REFRESH while open, and their
  // recent lines (peopleSaid.js), newest first, updated as they're said. A name opens that person in the other card.
  const pane = card.tabPane('social');
  pane.innerHTML = '<div class="pc-rel"><div class="pc-rel-col pc-rel-friends"><div class="pc-rel-head">Friends</div></div>'
    + '<div class="pc-rel-col pc-rel-enemies"><div class="pc-rel-head">Enemies</div></div></div>'
    + '<div class="pc-said"><div class="pc-said-head">Recent thoughts</div><div class="pc-said-list"></div></div>';
  const slots = col => Array.from({ length: SOCIAL_TOP }, () => {
    const slot = document.createElement('div');
    slot.className = 'pc-rel-name';
    slot.addEventListener('click', () => { if (slot.person) openBeside(w, slot.person); });
    pane.querySelector(col).append(slot);
    return slot;
  });
  w.friendSlots = slots('.pc-rel-friends'); w.enemySlots = slots('.pc-rel-enemies');
  w.saidList = pane.querySelector('.pc-said-list');
  w.socialTimer = null; w.socialShown = '';
  card.onTab(() => refreshSocial(w));

  // ---- the Pockets tab: a slot per keepsake they carry (POCKET_SLOTS, a dash in each empty one), what the one under the
  // pointer does beneath them, and the Gift button, which opens the Gift window (see gifts.js). Clicking a keepsake takes
  // it back.
  const pockets = card.tabPane('pockets');
  pockets.innerHTML = '<div class="pc-wallet"></div><div class="pc-pockets"></div><div class="pc-pocket-info"></div>'
    + '<div class="pc-pocket-foot"><button class="btn pc-gift" title="Give them something">Gift…</button></div>';
  w.pocketSlots = Array.from({ length: POCKET_SLOTS }, (_, slot) => {
    const button = document.createElement('button');
    button.className = 'pc-pocket';
    button.addEventListener('pointerenter', () => showPocket(w, slot));
    button.addEventListener('focus', () => showPocket(w, slot));
    button.addEventListener('pointerleave', () => showPocket(w, -1));
    button.addEventListener('click', () => {
      const p = personOf(w), offset = heldSnack(p) ? 1 : 0;
      if (!p || slot < offset || !takeBack(p, w.shown.index, slot - offset)) return;
      refreshPockets(w);
      showPocket(w, -1);
    });
    pockets.querySelector('.pc-pockets').append(button);
    return button;
  });
  w.walletEl = pockets.querySelector('.pc-wallet');
  w.pocketInfo = pockets.querySelector('.pc-pocket-info');
  pockets.querySelector('.pc-gift').addEventListener('click', () => openGifts(w));
  w.pocketsShown = null;
  card.onTab(() => refreshPockets(w));
  return w;
}

function headshotParts(w, card) {
  w.target = new THREE.WebGLRenderTarget(HEADSHOT_SIZE, HEADSHOT_SIZE);
  w.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  w.camera.layers.set(HEADSHOT_LAYER);
  w.canvas = card.canvas;
  w.context = w.canvas.getContext('2d');
  w.image = w.context.createImageData(HEADSHOT_SIZE, HEADSHOT_SIZE);
  w.pixels = new Uint8Array(HEADSHOT_SIZE*HEADSHOT_SIZE*4);
  w.drawnAt = -Infinity; w.lightsOnLayer = false; w.reading = false;
}

// whoever's in the window's slot, if it's still the person it opened on (see peopleIdSeq in people.js)
function personOf(w) {
  const p = w.shown && App.people[w.shown.index];
  return p && p.id === w.shown.id ? p : null;
}
const isManAt = i => personModel ? personModel.isMan[i] === 1 : null;

// Fills window `w` with the person at `index`. `beside`: picked in a building's room, so the card sits to the left of the
// building's, without its Smite button (see followPersonInside in people/peopleTracking.js)
function fill(w, index, isMan, beside = false) {
  const { card } = w;
  // whoever's actually standing in that slot right now, not the slot itself — see peopleIdSeq in people.js
  const id = App.people[index]?.id ?? index, profile = profileOf(id, isMan, App.people[index]?.moodNow);
  const { traits } = profile, again = w.shown?.index === index; // (again: people/*.txt just loaded, under an open card)
  // (someone else already up in it: a still copy of them stays over it till the new face is in — see revealFace)
  const ghost = w.ghost ?? (!again && w.shown && !card.el.hidden && card.el.style.visibility !== 'hidden' ? ghostOf(w) : null);
  w.ghost = null;
  w.shown ={ index, id, isMan, traits, seed: profile.age, beside };
  card.el.classList.toggle('pc-beside', beside);
  card.relabel(garbles(traits) ? text => garbled(text, traits, profile.age) : null); // (the headings too: "Loves", "Hates", the title...)
  // loves and hates are lists: one line per entry, and an empty list hides its row. The traits aren't shown: they're what
  // the person does, not what the card says about them. The name is never scrambled, but the casing traits reach it: the
  // lowercase trait sets theirs in lower case with the rest of the card, the capitalise trait gives every word a capital —
  // on the card only, never in the profile itself.
  const name = cased(profile.name, traits); // (the same, as the card's Name row and as its title bar: see setTitle below)
  card.show({ name, age: profile.age, mood: profile.mood,
    loves: garbledEntry(profile.loves, traits, profile.age), hates: garbledEntry(profile.hates, traits, profile.age),
    lovesTier: profile.lovesTier, hatesTier: profile.hatesTier, lovesMods: profile.lovesMods, hatesMods: profile.hatesMods,
    lovesKeys: profile.lovesBase.map(t => t && traitKey('love', t)), hatesKeys: profile.hatesBase.map(t => t && traitKey('hate', t)) });
  // the window's title bar names whoever's in it, rather than the kind of thing the card shows (which is what the cars',
  // the buildings' and the rest keep there): the same name its Name row has, cased by their traits. A garble (scramble
  // or keysmash) reaches it as it reaches the card's other headings, though never the Name row itself.
  // (The favorites keep "Ped" as what they call them: see the heart in ui/entity-card.js.)
  card.setTitle(name);
  // (no headshot of a cuboid person, before the people model has loaded)
  w.context.clearRect(0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE);
  w.canvas.hidden = isMan == null;
  w.drawnAt = -Infinity;
  w.lightsOnLayer = false;
  if (again) setDoing(w, w.doing, w.away); else setDoing(w, null);
  // (kept invisible, laid out, till the headshot's in — copyHeadshot — or FACE_WAIT)
  revealFace(w);
  if (!again && !w.canvas.hidden) {
    card.el.style.visibility = 'hidden'; w.ghost = ghost;
    w.faceTimer = setTimeout(() => revealFace(w), FACE_WAIT*1000);
  } else ghost?.remove();
  if (App.people[index]) card.setFavorite(personFavorite(App.people[index].id));
  card.bindHealth(App.people[index] ?? null, 'person');
  w.socialShown = '';
  refreshSocial(w);
  w.pocketsShown = null;
  refreshPockets(w);
  if (giftWindow?.w === w && giftWindow.id !== id) giftWindow.close(); // (the Gift window was for whoever was here before)
}
function revealFace(w) {
  clearTimeout(w.faceTimer); w.faceTimer = null;
  w.card.el.style.visibility = '';
  w.ghost?.remove(); w.ghost = null;
}
// a still copy of the card as it is, fixed where it is, headshot and all
function ghostOf(w) {
  const el = w.card.el, r = el.getBoundingClientRect(), ghost = el.cloneNode(true);
  ghost.removeAttribute('id'); ghost.classList.add('card-ghost'); // (its title bar kept as it was: see win3-menu.js setActive)
  Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
    right: 'auto', bottom: 'auto', margin: '0', transform: 'none', translate: 'none', pointerEvents: 'none', visibility: '' });
  ghost.querySelector('canvas.pc-thumb')?.getContext('2d').drawImage(w.canvas, 0, 0);
  el.after(ghost);
  return ghost;
}
function hideWindow(w) {
  revealFace(w);
  if (giftWindow?.w === w) giftWindow.close();
  w.shown = null;
  w.placedBeside = false;
  w.card.hide();
  refreshSocial(w);
  if (focused === w) focused = null;
}

// (followPerson/followPersonInside): a person already in a window just takes the focus; anyone else fills the focused one
function showPersonCard(index, isMan, beside = false) {
  const open = windows.find(w => w.shown?.index === index && personOf(w));
  if (open) { open.card.el.classList.toggle('pc-beside', beside); open.shown.beside = beside; focusWindow(open); return; }
  const w = focused ?? openWindows()[0] ?? windows[0];
  fill(w, index, isMan, beside);
  focusWindow(w);
}
function focusWindow(w) {
  focused = w;
  syncOtherPoll();
}
function hidePersonCard() {
  windows.forEach(w => { if (w !== keepOnHide) hideWindow(w); });
}
// the × on a window: the other (if open) takes over the camera, and takes the closed one's place if that wasn't itself
// opened beside; else the camera's let go
function closeWindow(w) {
  const other = otherThan(w);
  if (other.shown && !w.placedBeside) takePlace(other, w);
  if (w !== focused || !other.shown || !personOf(other)) { if (w === focused) App.stopFollowingPerson(); else hideWindow(w); syncOtherPoll(); return; }
  keepOnHide = other;
  App.stopFollowingPerson();
  keepOnHide = null;
  if (other.shown.beside) App.followPersonInside(other.shown.index); else App.followPerson(other.shown.index);
}
// a name in `from`'s Social tab: that person in the other window, beside `from`
function openBeside(from, person) {
  const index = App.people.indexOf(person);
  if (index < 0 || windows.some(w => personOf(w) === person)) return;
  const w = otherThan(from), wasOpen = !!w.shown;
  fill(w, index, isManAt(index));
  if (!wasOpen) { placeBeside(w.card.el, from.card.el); w.placedBeside = true; }
  from.card.el.dispatchEvent(new Event('card-show', { bubbles: true })); // (`from` stays the active window: see win3-menu.js)
  syncOtherPoll();
}
// `w` slides (RESIZE-style translate, no layout per frame) into where `from` is: its dragged place, or the default one
const SNAP_TIME = 180;
function takePlace(w, from) {
  const el = w.card.el, place = from.card.el.style, before = el.getBoundingClientRect();
  if (place.left || place.top || place.right || place.bottom || place.transform) {
    Object.assign(el.style, { left: place.left, top: place.top, right: place.right, bottom: place.bottom, transform: place.transform });
  } else w.card.resetPlace();
  el.classList.toggle('pc-beside', from.card.el.classList.contains('pc-beside'));
  w.placedBeside = false;
  const after = el.getBoundingClientRect();
  el.animate([{ translate: `${before.left - after.left}px ${before.bottom - after.bottom}px` }, { translate: '0 0' }], { duration: SNAP_TIME, easing: 'ease-out' });
}
// to the left of `anchor`, bottoms lined up (to its right if there's no room)
function placeBeside(el, anchor) {
  const a = anchor.getBoundingClientRect(), width = el.offsetWidth;
  const left = a.left - BESIDE_GAP - width >= 0 ? a.left - BESIDE_GAP - width : Math.min(a.right + BESIDE_GAP, innerWidth - width);
  Object.assign(el.style, { left: left + 'px', right: 'auto', top: 'auto', bottom: innerHeight - a.bottom + 'px' });
}

// ---- what they're up to (see personDoing in people/peopleTracking.js), and whether they're `away` — indoors, out of
// sight, so the headshot greys over. The focused window is told (setPersonCardDoing, from showFollowedDoing); the other
// checks every OTHER_POLL, and closes if its person's gone.
function setDoing(w, doing, away = false) {
  w.doing = doing; w.away = away;
  w.card.set('status', doing == null ? null : garbled(doing, w.shown?.traits ?? {}, w.shown?.seed));
  w.canvas.classList.toggle('pc-away', away);
}
function setPersonCardDoing(doing, away = false) { if (focused) setDoing(focused, doing, away); }

// ---- the status icons, in the column left of the picture (see setEffects in ui/entity-card.js): one per status effect
// they're under just now, the one with the least time left at the top, and a dash in every slot no status has taken — so
// the column always reads as a column of slots, whatever they're under (life/statuseffects.js).
// Each icon is handed a `left`: how many seconds its status has *now*, read off the running clock. That's what its tip
// says when the pointer rests on it, and the tip asks afresh on every pointer move — so a countdown in it runs, rather
// than only being right when the column was drawn.
// The column itself is redrawn as the statuses change — one starting or ending, the order swapping, or a whole second of
// one's clock going by — so a tip that's open still has the right icon under the pointer, and not so often that an open
// menu is rebuilt needlessly.
const STATUS_SLOTS = 4; // how many places the column has: a slot per status, then a dash for each left over
// a status's meter (see the tip in ui/entity-card.js): its length since its last top-up, and its stages still to run
function meterOf(entry) {
  let at = lastPeopleTime ?? 0;
  const stages = (entry.stages ?? []).filter(stage => stage.until > at).map(stage => { const seconds = stage.until - at; at = stage.until; return { level: stage.level, seconds }; });
  return { total: entry.seconds, stages };
}
function statusListFor(p, now) {
  const list = (p?.status ?? [])
    .map(entry => ({ status: entry.key, level: entry.level ?? 1, meter: () => meterOf(entry), remaining: Math.max(0, entry.until - now), left: () => Math.max(0, entry.until - (lastPeopleTime ?? 0)) }));
  // (bloodlust isn't a status, but shows as one while it lasts: see statuseffects.js EFFECTS.bloodlust)
  if (p && isBloodlusting(p)) {
    p.lustPeak = Math.max(p.lustPeak ?? 0, bloodLeft(p)); // (its bar's length: the most blood they've had on them since it began)
    list.push({ status: 'bloodlust', level: 1, remaining: bloodLeft(p), left: () => bloodLeft(p), meter: () => ({ total: p.lustPeak, stages: [{ level: 1, seconds: bloodLeft(p) }] }) });
  } else if (p) p.lustPeak = 0;
  return list
    .sort((a, b) => a.remaining - b.remaining);
}
function refreshCardStatus(w, now) {
  const list = statusListFor(personOf(w), now);
  const key = list.map(item => `${item.status}${item.level}:${Math.round(item.remaining)}`).join(',');
  if (key === w.statusShown) return;
  w.statusShown = key;
  w.card.setEffects(list, STATUS_SLOTS); // (a slot per status, then dashes for the places left over)
}
// (drawn for every open card, every frame: with no statuses at all that's the dashes and nothing else — see setEffects —
// so a card always shows its status column, whether anyone's under anything or not. Redrawing is held off unless the
// statuses, their order or their whole seconds have changed, so an open menu isn't rebuilt under the pointer.)
function refreshCardStatuses() {
  const now = lastPeopleTime ?? 0;
  openWindows().forEach(w => { refreshCardStatus(w, now); refreshPockets(w); });
}

let otherPoll = null;
function syncOtherPoll() {
  const want = openWindows().some(w => w !== focused);
  if (want && !otherPoll) otherPoll = setInterval(pollOthers, OTHER_POLL);
  if (!want && otherPoll) { clearInterval(otherPoll); otherPoll = null; }
}
function pollOthers() {
  openWindows().forEach(w => {
    if (w === focused) return;
    const p = personOf(w);
    if (!p || p.mode === 'dead') { hideWindow(w); syncOtherPoll(); return; }
    const doing = personDoing(p), away = isGone(p) && !!p.indoors && !inRoom(p);
    if (doing !== w.doing || away !== w.away) setDoing(w, doing, away);
  });
}

// ---- headshots (called from updatePeople in people.js with the person alone on the model): `index` defaults to the
// followed person's; otherHeadshotIndex says which unfocused window's person is due a redraw, if any
function drawPersonHeadshot(view, index = focused?.shown?.index) {
  const w = windows.find(x => x.shown?.index === index) ?? (look.shown?.index === index ? look : null);
  if (!w || w.canvas.hidden || w.reading) return;
  const now = performance.now()/1000;
  if (now - w.drawnAt < (w === focused ? HEADSHOT_INTERVAL : OTHER_HEADSHOT_INTERVAL)) return;
  w.drawnAt = now;
  // the lights light them there too (put on the layer each time the card opens, to catch any added since)
  if (!w.lightsOnLayer) { scene.traverse(o => { if (o.isLight) o.layers.enable(HEADSHOT_LAYER); }); w.lightsOnLayer = true; }
  const camera = w.camera;
  camera.position.copy(view.head).addScaledVector(view.forward, view.distance);
  camera.up.copy(view.up);
  camera.lookAt(view.head);
  camera.near = view.distance*0.3;
  camera.updateProjectionMatrix();
  // drawn with the shadows as the view last drew them, and a clear background, then everything put back
  const target = renderer.getRenderTarget(), shadows = renderer.shadowMap.autoUpdate, clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(w.target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clearColor, clearAlpha);
  renderer.shadowMap.autoUpdate = shadows;
  w.reading = true; w.readingFor = w.shown.index;
  renderer.readRenderTargetPixelsAsync(w.target, 0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE, w.pixels)
    .then(() => copyHeadshot(w), () => {}).finally(() => { w.reading = false; });
}
function otherHeadshotIndex() {
  const now = performance.now()/1000;
  const w = [...openWindows(), ...(look.shown ? [look] : [])]
    .find(x => x !== focused && !x.reading && !x.canvas.hidden && now - x.drawnAt >= OTHER_HEADSHOT_INTERVAL && (x === look || personOf(x)));
  return w ? w.shown.index : -1;
}
function copyHeadshot(w) {
  if (!w.shown || w.readingFor !== w.shown.index) return; // (a face read for whoever it showed before)
  // (an empty frame — someone off screen isn't drawn: see personOnScreen in peopleModel.js — keeps the last face)
  let seen = false;
  for (let k = 3; k < w.pixels.length && !seen; k += 4) seen = w.pixels[k] > 0;
  if (!seen) return;
  // (the render target's rows run bottom to top)
  const rowBytes = HEADSHOT_SIZE*4;
  for (let y=0;y<HEADSHOT_SIZE;y++) w.image.data.set(w.pixels.subarray((HEADSHOT_SIZE - 1 - y)*rowBytes, (HEADSHOT_SIZE - y)*rowBytes), y*rowBytes);
  if (w === look && look.index !== w.shown.index) { look.faceReady = true; return; } // (the look card's next person: shown with it)
  w.context.putImageData(w.image, 0, 0);
  if (w.faceTimer) revealFace(w);
}

// ---- the Social tab's drawing
const socialOpen = w => !!w.shown && w.card.activeTab() === 'social';
function refreshSocial(w) {
  const open = socialOpen(w);
  if (open && !w.socialTimer) w.socialTimer = setInterval(() => drawRelations(w), SOCIAL_REFRESH);
  if (!open && w.socialTimer) { clearInterval(w.socialTimer); w.socialTimer = null; }
  if (open) { drawRelations(w); drawLines(w); }
}
function drawRelations(w) {
  const p = personOf(w);
  const byId = new Map(App.people.map(q => [q.id, q]));
  const { friends, enemies } = p ? ranked(p, byId, SOCIAL_TOP) : { friends: [], enemies: [] };
  const key = [...friends, ...enemies].map(r => r.person.id + ':' + Math.round(r.score)).join(',') + '|' + friends.length;
  if (key === w.socialShown) return;
  w.socialShown = key;
  const fillSlots = (slots, list) => slots.forEach((slot, i) => {
    const rel = list[i], name = document.createElement('span'), points = document.createElement('span');
    name.className = 'pc-rel-who'; points.className = 'pc-rel-points';
    name.textContent = rel?.person.name ?? '—';
    if (rel) { const score = Math.round(rel.score); points.textContent = (score > 0 ? '+' : '') + score; }
    slot.replaceChildren(name, points);
    slot.person = rel?.person ?? null;
    slot.title = rel ? rel.person.name + ' — open their window' : '';
    slot.classList.toggle('pc-rel-empty', !rel);
  });
  fillSlots(w.friendSlots, friends);
  fillSlots(w.enemySlots, enemies);
}
function drawLines(w) {
  const lines = recentLines(personOf(w));
  w.saidList.replaceChildren(...lines.slice().reverse().map(({ text, thought }) => {
    const line = document.createElement('div');
    line.className = 'pc-said-line' + (thought ? ' pc-said-thought' : '');
    line.textContent = thought ? text : '“' + text + '”';
    return line;
  }));
  if (!lines.length) w.saidList.textContent = 'Nothing yet';
}
onLineLogged(p => windows.forEach(w => { if (socialOpen(w) && p === personOf(w)) drawLines(w); }));

// ---- the Pockets tab's drawing: redrawn only when what's in them has changed (checked each frame while it's open, from
// refreshCardStatuses — so the sunglasses someone came in turn up, and whatever's given or taken back)
const pocketsOpen = w => !!w.shown && w.card.activeTab() === 'pockets';
// what's in their pockets, slot by slot: the snack in their hand first ({gift, sips}), then their keepsakes ({gift})
function pocketItems(p) {
  const snack = heldSnack(p);
  return [...(snack ? [{ gift: snack, sips: p.snack.mouthfuls }] : []), ...(p?.pockets ?? []).map(gift => ({ gift }))];
}
function refreshPockets(w) {
  if (!pocketsOpen(w)) return;
  const carried = pocketItems(personOf(w));
  const wallet = personOf(w)?.wallet ?? 0;
  const key = wallet + ':' + carried.map(item => item.gift.name + (item.sips ?? '')).join('|');
  if (key === w.pocketsShown) return;
  w.pocketsShown = key;
  w.walletEl.textContent = `👛 Wallet: £${wallet}`;
  w.pocketSlots.forEach((button, slot) => {
    const item = carried[slot];
    if (item?.sips != null) {
      const count = document.createElement('span');
      count.className = 'pc-pocket-count';
      count.textContent = item.sips;
      button.replaceChildren(item.gift.emoji, count);
    } else button.textContent = item ? item.gift.emoji : '–';
    button.classList.toggle('pc-pocket-empty', !item);
    button.disabled = !item;
    button.title = item ? (item.sips != null ? 'Having it' : 'Take it back') : '';
  });
  showPocket(w, w.pocketHover != null && carried[w.pocketHover] ? w.pocketHover : -1); // (a hovered snack's sips kept current)
}
// what's in pocket `slot` beneath them (-1: what the tab's for)
function showPocket(w, slot) {
  const items = pocketItems(personOf(w)), item = slot >= 0 ? items[slot] : null;
  w.pocketHover = item ? slot : null;
  if (item) {
    const lines = giftLines(item.gift);
    if (item.sips != null) lines.notes = [`${item.sips} ${item.gift.snack === 'hotdog' ? 'bite' : 'sip'}${item.sips === 1 ? '' : 's'} left`, ...lines.notes];
    tipLines(w.pocketInfo, lines);
    return;
  }
  const empty = !items.length;
  w.pocketInfo.replaceChildren(empty ? 'Nothing in their pockets.' : 'Point at something to see what it does; click it to take it back.');
  w.pocketInfo.classList.add('pc-pocket-hint');
}
// a gift's tip (giftLines in gifts.js) into `el`: its name in bold, its traits run together on a line, then the rest
function tipLines(el, { name, traits, notes }) {
  el.classList.remove('pc-pocket-hint');
  const line = (className, text) => { const div = document.createElement('div'); div.className = className; div.textContent = text; return div; };
  el.replaceChildren(line('pc-gift-name', name), ...(traits.length ? [line('pc-gift-traits', traits.join(' · '))] : []),
    ...notes.map(note => line('pc-gift-note', note)));
}

// ---- the Gift window: every gift in assets/text/gifts.txt as an emoji button, keepsakes then consumables, and under them
// what the one under the pointer (or keyboard focus) does. A click gives it; on a touch screen, where there's no pointer
// to rest on one, the first tap shows what it does and a second gives it. It's for whoever's card it was opened from,
// and goes when that card closes or moves on to someone else.
let giftWindow = null; // { w, id, close, info } while it's open
function openGifts(w) {
  const p = personOf(w);
  if (!p) return;
  giftWindow?.close();
  const name = App.people[w.shown.index]?.name ?? 'them';
  const win = openWindow({ id: 'gift-window', title: 'Gift', width: 320, onClose: () => { giftWindow = null; }, fill: body => {
    body.innerHTML = `<div class="gift-to"></div><div class="gift-lists"></div><div class="gift-info"></div>`;
    body.querySelector('.gift-to').textContent = `Something for ${name}`;
    const lists = body.querySelector('.gift-lists'), info = body.querySelector('.gift-info');
    let picked = null;
    const hint = text => { info.replaceChildren(text); info.classList.add('pc-pocket-hint'); };
    const idle = () => hint(IS_TOUCH ? 'Tap a gift to see what it does, and again to give it.' : 'Point at a gift to see what it does; click to give it.');
    const draw = () => {
      lists.replaceChildren();
      if (!GIFTS.length) { lists.textContent = giftsLoaded() ? 'There\'s nothing to give (see assets/text/gifts.txt).' : 'Loading…'; return; }
      [['keepsake', 'Keepsakes'], ['consumable', 'Consumables']].forEach(([kind, heading]) => {
        const kindGifts = GIFTS.filter(gift => gift.kind === kind);
        if (!kindGifts.length) return;
        const head = document.createElement('div');
        head.className = 'gift-head';
        head.textContent = heading;
        const grid = document.createElement('div');
        grid.className = 'gift-grid';
        kindGifts.forEach(gift => {
          const button = document.createElement('button');
          button.className = 'btn gift-pick';
          button.dataset.energy = '';
          button.textContent = gift.emoji;
          button.setAttribute('aria-label', gift.name);
          const show = () => tipLines(info, giftLines(gift));
          button.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') show(); });
          button.addEventListener('focus', show);
          button.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && picked !== gift) idle(); });
          button.addEventListener('click', () => {
            if (IS_TOUCH && picked !== gift) { picked = gift; lists.querySelectorAll('.gift-pick').forEach(b => b.classList.toggle('on', b === button)); show(); return; }
            give(gift);
          });
          grid.append(button);
        });
        lists.append(head, grid);
      });
    };
    const give = gift => {
      const q = personOf(w);
      if (!q) { giftWindow?.close(); return; }
      if (gift.kind === 'keepsake' && pocketsFull(q)) { hint(`${name}'s pockets are full: take something back first.`); return; }
      if (!App.hasEnergy()) return; // (1 energy: see ui/energy.js)
      const { given, cheered } = giveGift(q, w.shown.index, gift);
      if (!given) return;
      App.spendEnergy();
      hint(`${gift.emoji} Given to ${name}.` + (cheered ? ' That cheered them up!' : ''));
      w.pocketsShown = null;
      refreshPockets(w);
      if (cheered) w.card.set('mood', garbled(profileOf(q.id, w.shown.isMan, q.moodNow).mood, w.shown.traits, w.shown.seed));
    };
    idle();
    draw();
    if (!giftsLoaded()) onGiftsLoaded(draw);
  } });
  giftWindow = { w, id: p.id, close: () => win.close() };
}

// (once people/*.txt has loaded, the cards show what it says)
onProfilesLoaded(() => openWindows().forEach(w => fill(w, w.shown.index, w.shown.isMan, w.shown.beside)));

// a person as a favorite: kept in the project by their id, not their place in the crowd (see peopleIdSeq in
// life/people/people.js) — they're never killed while hearted (see ui/favorites.js), so wherever they're currently
// standing is found again by searching for their id, not assumed to be a fixed slot.
// `kindLabel`: what the favorites list says they are — the card's own kind, since its title bar is their name (see fill).
function personFavorite(id) {
  return { key: personKey(id), kind: 'Person', kindLabel: 'Ped', saved: { id }, spares: true,
    follow: () => { const i = App.people.findIndex(q => q.id === id); if (i < 0) return false; App.followPerson(i); return true; } };
}
// `saved.index` is a save from before people had their own persistent id, back when their place in the crowd was who
// they were: treating that old slot number as their id is the closest guess at reviving the right person
reviveFavoritesAs('Person', saved => Number.isInteger(saved.id) ? personFavorite(saved.id)
  : Number.isInteger(saved.index) && saved.index >= 0 ? personFavorite(saved.index) : null);

// ---- the look card: possessing someone, whoever they're looking at (updatePossessedTarget in people/peopleTracking.js)
// gets a plain card — the Overview and headshot only, no tabs or Smite — above the possessed person's own. A new person
// waits for their headshot (look.shown: who it's drawing; look.index: who the card shows), or FACE_WAIT at most.

const look = { card: makeCard({ id: 'person-look', title: 'Ped', health: true, onClose: () => { look.dismissed = look.shown?.index ?? -1; hideLook(); } }),
  index: -1, id: null, dismissed: -1, doing: undefined, shown: null, wantId: null, wantSince: 0, faceReady: false };
headshotParts(look, look.card);
look.card.el.classList.add('pc-look');
function hideLook() {
  if (!look.shown) return;
  look.index = -1; look.shown = null; look.faceReady = false;
  look.card.hide(); look.card.bindHealth(null);
}
function showLookCard(index) {
  const p = index >= 0 ? App.people[index] : null, anchor = focused?.card.el, now = performance.now()/1000;
  if (look.dismissed !== index) look.dismissed = -1;
  if (!p || index === look.dismissed || !anchor || anchor.hidden) { hideLook(); return; }
  if (look.shown?.index !== index || look.wantId !== p.id) {
    look.shown = { index }; look.wantId = p.id; look.wantSince = now; look.faceReady = false; look.drawnAt = -Infinity;
  }
  if (look.index !== index || look.id !== p.id) {
    if (!look.faceReady && now - look.wantSince < FACE_WAIT) return;
    const profile = profileOf(p.id, isManAt(index), p.moodNow), { traits } = profile, name = cased(profile.name, traits);
    look.index = index; look.id = p.id; look.traits = traits; look.seed = profile.age; look.doing = undefined;
    if (look.faceReady) look.context.putImageData(look.image, 0, 0); else look.context.clearRect(0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE);
    look.card.relabel(garbles(traits) ? text => garbled(text, traits, profile.age) : null);
    look.card.show({ name, age: profile.age, mood: profile.mood,
      loves: garbledEntry(profile.loves, traits, profile.age), hates: garbledEntry(profile.hates, traits, profile.age),
      lovesTier: profile.lovesTier, hatesTier: profile.hatesTier, lovesMods: profile.lovesMods, hatesMods: profile.hatesMods,
      lovesKeys: profile.lovesBase.map(t => t && traitKey('love', t)), hatesKeys: profile.hatesBase.map(t => t && traitKey('hate', t)) });
    look.card.setTitle(name);
    look.card.bindHealth(p, 'person');
  }
  const doing = personDoing(p);
  if (doing !== look.doing) { look.doing = doing; look.card.set('status', garbled(doing, look.traits, look.seed)); }
  const a = anchor.getBoundingClientRect(), el = look.card.el;
  Object.assign(el.style, { left: a.left + 'px', right: 'auto', top: 'auto', bottom: innerHeight - a.top + BESIDE_GAP + 'px' });
}

Object.assign(App, { showLookCard, showPersonCard,hidePersonCard, drawPersonHeadshot, otherHeadshotIndex, setPersonCardDoing, refreshCardStatuses });
