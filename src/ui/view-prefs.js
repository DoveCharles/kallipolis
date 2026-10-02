// Browser preferences (localStorage, not the project's) for what shows on start and over the view:
// - hints: View > Edit Hints (the bottom #hint in Edit and Maps) and View > General Hints (the bottom #hint in World,
//   including the controls while possessing or driving). Hidden by body classes; see css/base.css.
// - Options > Game > Start in Mode (Last Used by default, Edit, Game): Edit slides the side panel in once loaded; Game
//   opens in World instead; Last Used is whichever of the two was last pressed (index.html reads the same keys early).
// - Options > Game > Encourage To Watch TV (S.encourageTV, off by default): on, a home shown with people in it has one of them already sat on
//   the sofa, so the TV's on straight away (see aboutTheRoom in life/people/peopleActivities.js).
// - Options > Game > Dialogue Choices (S.dialogueChoices, on): for the possessed person (whose lines go in a box low on screen, not
//   a bubble), a reply with several options lists them to pick (see ownLine in ui/speech-bubbles.js).
// - Options > Display > Show Profile On Look (S.lookCard, on): possessing someone, whoever they look at gets a card
//   (showLookCard in life/person-card.js).
// - Options > Game > Free Camera Indoors (S.freeRoomCamera, on by default): inside a building, orbit, pan and zoom freely
//   within the room rather than riding round its walls (see freeRoom in buildings/interior.js).
// - Options > Display > FX > Dithered See-Through (S.ditherSeeThrough, on by default): buildings near the camera fade by a
//   dither rather than blending (see buildings/see-through.js).
// - Options > Speech > Chat speed (S.chatSpeed, 1 by default): how often real lines are said (see audio/dictionary.js).
// - Options > Speech > Hearing distance (S.hearDistance, 40): how far off talk is heard (see audio/voices.js).
// - Options > Speech > Babble only as fallback (S.babbleFallbackOnly, off): people say real lines whenever one can be
//   had, babbling only when none can (see linePause in audio/dictionary.js).
// - Options > Speech > Bubble distance (S.bubbleDistance, 35) and Babble bubbles (S.babbleBubbles, off): see ui/speech-bubbles.js.
import { S, App } from '../core/shared.js';
import { whenLoaded } from './loading.js';

const EDIT_HINTS_KEY = 'splinetopia.editHints', GENERAL_HINTS_KEY = 'splinetopia.generalHints';
const START_MODE_KEY = 'splinetopia.startMode', LAST_MODE_KEY = 'splinetopia.lastMode', OLD_START_EDIT_KEY = 'splinetopia.startInEdit';
const ENCOURAGE_TV_KEY = 'splinetopia.encourageTV', DIALOGUE_CHOICES_KEY = 'splinetopia.dialogueChoices', LOOK_CARD_KEY = 'splinetopia.lookCard';
const CHAT_SPEED_KEY = 'splinetopia.chatSpeed', BUBBLE_DISTANCE_KEY = 'splinetopia.bubbleDistance';
const HEAR_DISTANCE_KEY = 'splinetopia.hearDistance', FREE_ROOM_CAMERA_KEY = 'splinetopia.freeRoomCamera';
const BABBLE_BUBBLES_KEY = 'splinetopia.babbleBubbles', BABBLE_FALLBACK_KEY = 'splinetopia.babbleFallbackOnly';
const DITHER_SEE_THROUGH_KEY = 'splinetopia.ditherSeeThrough';
const body = document.body;
const startModeSelect = document.getElementById('s-startmode');

function remember(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (err) { /* storage blocked */ } }
// a saved preference, or `fallback` if there's none
function recall(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch (err) { return fallback; }
}

function hintsSetter(key, hiddenClass) {
  const shown = () => !body.classList.contains(hiddenClass);
  const set = (on, save) => { body.classList.toggle(hiddenClass, !on); if (save) remember(key, on); };
  set(recall(key, true), false);
  return { shown, toggle: () => set(!shown(), true) };
}
export const editHints = hintsSetter(EDIT_HINTS_KEY, 'no-edit-hints');
export const generalHints = hintsSetter(GENERAL_HINTS_KEY, 'no-general-hints');

function recallText(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (err) { return fallback; } }
function rememberText(key, value) { try { localStorage.setItem(key, value); } catch (err) { /* storage blocked */ } }
startModeSelect.value = recallText(START_MODE_KEY, 'last');
startModeSelect.addEventListener('change', () => rememberText(START_MODE_KEY, startModeSelect.value));
const lastMode = recallText(LAST_MODE_KEY, recall(OLD_START_EDIT_KEY, true) ? 'edit' : 'game');
const startInEdit = (startModeSelect.value === 'last' ? lastMode : startModeSelect.value) !== 'game';
// (Edit or World pressed: remembered for Last Used)
document.querySelectorAll('#mode-toolbar [data-mode=node], #mode-toolbar [data-mode=move]').forEach(button =>
  button.addEventListener('click', () => rememberText(LAST_MODE_KEY, button.dataset.mode === 'node' ? 'edit' : 'game')));
S.encourageTV = recall(ENCOURAGE_TV_KEY, false);
const encourageTVToggle = document.getElementById('s-encouragetv');
encourageTVToggle.classList.toggle('on', S.encourageTV);
encourageTVToggle.addEventListener('click', () => {
  S.encourageTV = !S.encourageTV;
  encourageTVToggle.classList.toggle('on', S.encourageTV);
  remember(ENCOURAGE_TV_KEY, S.encourageTV);
});
S.dialogueChoices = recall(DIALOGUE_CHOICES_KEY, true);
const dialogueChoicesToggle = document.getElementById('s-dialoguechoices');
dialogueChoicesToggle.classList.toggle('on', S.dialogueChoices);
dialogueChoicesToggle.addEventListener('click', () => {
  S.dialogueChoices = !S.dialogueChoices;
  dialogueChoicesToggle.classList.toggle('on', S.dialogueChoices);
  remember(DIALOGUE_CHOICES_KEY, S.dialogueChoices);
});
S.lookCard = recall(LOOK_CARD_KEY, true);
const lookCardToggle = document.getElementById('s-lookcard');
lookCardToggle.classList.toggle('on', S.lookCard);
lookCardToggle.addEventListener('click', () => {
  S.lookCard = !S.lookCard;
  lookCardToggle.classList.toggle('on', S.lookCard);
  remember(LOOK_CARD_KEY, S.lookCard);
});
S.freeRoomCamera = recall(FREE_ROOM_CAMERA_KEY, true);
const freeRoomCameraToggle = document.getElementById('s-freeroomcamera');
freeRoomCameraToggle.classList.toggle('on', S.freeRoomCamera);
freeRoomCameraToggle.addEventListener('click', () => {
  S.freeRoomCamera = !S.freeRoomCamera;
  freeRoomCameraToggle.classList.toggle('on', S.freeRoomCamera);
  remember(FREE_ROOM_CAMERA_KEY, S.freeRoomCamera);
});
S.ditherSeeThrough = recall(DITHER_SEE_THROUGH_KEY, true);
const ditherToggle = document.getElementById('s-ditherseethrough');
ditherToggle.classList.toggle('on', S.ditherSeeThrough);
ditherToggle.addEventListener('click', () => {
  S.ditherSeeThrough = !S.ditherSeeThrough;
  ditherToggle.classList.toggle('on', S.ditherSeeThrough);
  remember(DITHER_SEE_THROUGH_KEY, S.ditherSeeThrough);
  App.resetSeeThrough?.();
});

// a slider saved to `key`, setting S[field] (the slider's own value by default)
function prefSlider(name, key, field) {
  const slider = document.getElementById(`s-${name}`), shown = document.getElementById(`dv-${name}`);
  let saved = null;
  try { saved = parseFloat(localStorage.getItem(key)); } catch (err) { /* storage blocked */ }
  S[field] = saved > 0 ? saved : parseFloat(slider.value);
  slider.value = shown.textContent = String(S[field]);
  slider.addEventListener('input', () => {
    S[field] = parseFloat(slider.value);
    shown.textContent = String(S[field]);
    try { localStorage.setItem(key, String(S[field])); } catch (err) { /* storage blocked */ }
  });
}
prefSlider('chatspeed', CHAT_SPEED_KEY, 'chatSpeed');
prefSlider('bubbledistance', BUBBLE_DISTANCE_KEY, 'bubbleDistance');
prefSlider('heardistance', HEAR_DISTANCE_KEY, 'hearDistance');
// a toggle switch saved to `key`, setting S[field]
function prefToggle(id, key, field, fallback) {
  const toggle = document.getElementById(id);
  S[field] = recall(key, fallback);
  toggle.classList.toggle('on', S[field]);
  toggle.addEventListener('click', () => {
    S[field] = !S[field];
    toggle.classList.toggle('on', S[field]);
    remember(key, S[field]);
  });
}
prefToggle('s-babblefallback', BABBLE_FALLBACK_KEY, 'babbleFallbackOnly', false);
// Options > Dev (see ui/energy.js, ui/money.js, ui/morality.js)
prefToggle('s-infiniteenergy', 'kallipolis.dev.infiniteEnergy', 'devInfiniteEnergy', false);
prefToggle('s-freepurchases', 'kallipolis.dev.freePurchases', 'devFreePurchases', false);
prefToggle('s-infinitegifts', 'kallipolis.dev.infiniteGifts', 'devInfiniteGifts', false);
// Options > Dev > Sandbox city: the city's play mode, saved with it (S.playMode, scene.playMode in project/save-load.js) —
// a sandbox's undo reaches back past time in the world; a game's stops where the world last ran (see project/history.js)
S.playMode ??= 'sandbox';
const sandboxToggle = document.getElementById('s-sandbox');
const syncPlayMode = () => sandboxToggle.classList.toggle('on', S.playMode !== 'game');
sandboxToggle.addEventListener('click', () => { S.playMode = S.playMode === 'game' ? 'sandbox' : 'game'; syncPlayMode(); App.scheduleSave?.(500); });
syncPlayMode();
App.syncPlayMode = syncPlayMode;
S.babbleBubbles = recall(BABBLE_BUBBLES_KEY, false);
const babbleBubblesToggle = document.getElementById('s-babblebubbles');
babbleBubblesToggle.classList.toggle('on', S.babbleBubbles);
babbleBubblesToggle.addEventListener('click', () => {
  S.babbleBubbles = !S.babbleBubbles;
  babbleBubblesToggle.classList.toggle('on', S.babbleBubbles);
  remember(BABBLE_BUBBLES_KEY, S.babbleBubbles);
});

// The page starts in Edit (core/state.js) with the panel hidden (index.html). Once everything's loaded (see loading.js),
// Edit slides the panel in; World is pressed instead when not starting in Edit.
whenLoaded(() => {
  body.classList.remove('ui-loading', 'start-edit'); // (hints slide in: css/base.css)
  if (startInEdit) body.classList.remove('w3-no-panel');
  else document.querySelector('#mode-toolbar [data-mode=move]').click();
});
