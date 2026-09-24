import * as THREE from 'three';
import { App } from '../core/shared.js';
import { scene, renderer } from '../core/scene.js';
import { HEADSHOT_LAYER } from './people/people.js';
import { profileOf, onProfilesLoaded } from './profiles.js';
import { strikeLightning } from './lightning.js';
import { makeCard } from '../ui/entity-card.js';
import { personKey, reviveFavoritesAs } from '../ui/favorites.js';
import { garbles, garbled } from '../ui/garble.js';

// ============================================================ person card
// Who someone is, in a card at the bottom right while the camera follows them (see "following someone" in people.js): their
// name, age, mood, loves and hates, from assets/people.txt (see profiles.js). The same person always gets the same card. The card itself is the shared one in ui/entity-card.js; people are the one kind of thing whose
// text doesn't come from a [section] file, since people.txt does rather more (weighted lines, traits) than the rest.
let shown = null; // { index, isMan, traits, seed } of whoever the card is showing
// (someone with the scramble or keysmash trait has the text on their card garbled, name and age aside: see ui/garble.js)
const card = makeCard({
  id: 'person-card',
  title: 'Ped',
  onClose: () => App.stopFollowingPerson(),
  // the headshot itself: into their head (see possession.js)
  thumb: { title: 'Possess them', onClick: () => { if (shown) App.possessPerson(shown.index); } },
  // the Smite button, under their headshot: a bolt of lightning comes down on them (see lightning.js) and they explode
  // (see killPerson in people.js), and the card goes
  kill: { title: 'Strike them down', onClick: () => {
    const p = shown && App.people[shown.index];
    if (!p) return;
    strikeLightning({ x: p.x, y: p.y, z: p.z });
    App.killPerson(shown.index);
  } },
});
// (once people.txt has loaded, the card shows what it says)
onProfilesLoaded(() => { if (shown) showPersonCard(shown.index, shown.isMan); });
function showPersonCard(index, isMan) {
  // whoever's actually standing in that slot right now, not the slot itself — see peopleIdSeq in people.js
  const profile = profileOf(App.people[index]?.id ?? index, isMan);
  const { traits } = profile, again = shown?.index === index; // (again: people.txt just loaded, under an open card)
  shown = { index, isMan, traits, seed: profile.age };
  card.relabel(garbles(traits) ? text => garbled(text, traits, profile.age) : null); // (the headings too: "Loves", "Hates", the title...)
  // loves and hates are lists: one line per entry, and an empty list hides its row. The traits aren't shown: they're what
  // the person does, not what the card says about them.
  card.show({ name: profile.name, age: profile.age, mood: profile.mood,
    loves: garbled(profile.loves, traits, profile.age), hates: garbled(profile.hates, traits, profile.age),
    lovesTier: profile.lovesTier, hatesTier: profile.hatesTier, lovesMods: profile.lovesMods, hatesMods: profile.hatesMods });
  // (no headshot of a cuboid person, before the people model has loaded)
  headshotContext.clearRect(0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE);
  headshotCanvas.hidden = isMan == null;
  headshotDrawnAt = -Infinity;
  lightsOnLayer = false;
  if (again) setPersonCardDoing(doingNow, awayNow); else setPersonCardDoing(null);
  if (App.people[index]) card.setFavorite(personFavorite(App.people[index].id));
}
// a person as a favorite: kept in the project by their id, not their place in the crowd (see peopleIdSeq in
// life/people/people.js) — they're never killed while hearted (see ui/favorites.js), so wherever they're currently
// standing is found again by searching for their id, not assumed to be a fixed slot
function personFavorite(id) {
  return { key: personKey(id), kind: 'Person', saved: { id }, spares: true,
    follow: () => { const i = App.people.findIndex(q => q.id === id); if (i < 0) return false; App.followPerson(i); return true; } };
}
// `saved.index` is a save from before people had their own persistent id, back when their place in the crowd was who
// they were: treating that old slot number as their id is the closest guess at reviving the right person
reviveFavoritesAs('Person', saved => Number.isInteger(saved.id) ? personFavorite(saved.id)
  : Number.isInteger(saved.index) && saved.index >= 0 ? personFavorite(saved.index) : null);
// what they're up to (see personDoing in people/peopleTracking.js), and whether they're `away` — indoors, out of sight, so
// the headshot greys over
let doingNow = null, awayNow = false;
function setPersonCardDoing(doing, away = false) {
  doingNow = doing; awayNow = away;
  card.set('status', doing == null ? null : garbled(doing, shown?.traits ?? {}, shown?.seed));
  headshotCanvas.classList.toggle('pc-away', away);
}

// ---- the headshot: a live close-up of their face, beside their name — drawn a few times a second (people.js hands over
// where their head is and which way it faces) from a camera just in front of it that sees only the people, on a clear
// background, into a little render target of its own, whose pixels are copied onto the card's canvas
const HEADSHOT_SIZE = 120; // pixels across (shown half that, sharp on high-density screens)
const HEADSHOT_INTERVAL = 1/15;
const headshotTarget = new THREE.WebGLRenderTarget(HEADSHOT_SIZE, HEADSHOT_SIZE);
const headshotCamera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
headshotCamera.layers.set(HEADSHOT_LAYER);
const headshotCanvas = card.canvas;
const headshotContext = headshotCanvas.getContext('2d'), headshotImage = headshotContext.createImageData(HEADSHOT_SIZE, HEADSHOT_SIZE);
const headshotPixels = new Uint8Array(HEADSHOT_SIZE*HEADSHOT_SIZE*4), clearColor = new THREE.Color();
let headshotDrawnAt = -Infinity, lightsOnLayer = false;
// `view`: { head, forward, up, distance } in the world
function drawPersonHeadshot(view) {
  const now = performance.now()/1000;
  if (!shown || headshotCanvas.hidden || now - headshotDrawnAt < HEADSHOT_INTERVAL) return;
  headshotDrawnAt = now;
  // the lights light them there too (put on the layer each time the card opens, to catch any added since)
  if (!lightsOnLayer) { scene.traverse(o => { if (o.isLight) o.layers.enable(HEADSHOT_LAYER); }); lightsOnLayer = true; }
  headshotCamera.position.copy(view.head).addScaledVector(view.forward, view.distance);
  headshotCamera.up.copy(view.up);
  headshotCamera.lookAt(view.head);
  headshotCamera.near = view.distance*0.3;
  headshotCamera.updateProjectionMatrix();
  // drawn with the shadows as the view last drew them, and a clear background, then everything put back
  const target = renderer.getRenderTarget(), shadows = renderer.shadowMap.autoUpdate, clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(headshotTarget);
  renderer.render(scene, headshotCamera);
  renderer.readRenderTargetPixels(headshotTarget, 0, 0, HEADSHOT_SIZE, HEADSHOT_SIZE, headshotPixels);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clearColor, clearAlpha);
  renderer.shadowMap.autoUpdate = shadows;
  // (the render target's rows run bottom to top)
  const rowBytes = HEADSHOT_SIZE*4;
  for (let y=0;y<HEADSHOT_SIZE;y++) headshotImage.data.set(headshotPixels.subarray((HEADSHOT_SIZE - 1 - y)*rowBytes, (HEADSHOT_SIZE - y)*rowBytes), y*rowBytes);
  headshotContext.putImageData(headshotImage, 0, 0);
}
function hidePersonCard() {
  shown = null;
  card.hide();
}

Object.assign(App, { showPersonCard, hidePersonCard, drawPersonHeadshot, setPersonCardDoing });

