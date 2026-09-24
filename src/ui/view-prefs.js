// Browser preferences (localStorage, not the project's) for what shows on start and over the view:
// - hints: View > Edit Hints (the bottom #hint in Edit and Maps) and View > General Hints (the bottom #hint in World,
//   including the controls while possessing or driving). Hidden by body classes; see css/base.css.
// - Options > Game > Start in Edit mode: on, the side panel slides in once loaded; off, the app opens in World instead.
// - Options > Game > Encourage To Watch TV (S.encourageTV, off by default): on, a home shown with people in it has one of them already sat on
//   the sofa, so the TV's on straight away (see aboutTheRoom in life/people/peopleActivities.js).
import { S } from '../core/shared.js';
import { whenLoaded } from './loading.js';

const EDIT_HINTS_KEY = 'splinetopia.editHints', GENERAL_HINTS_KEY = 'splinetopia.generalHints';
const START_EDIT_KEY = 'splinetopia.startInEdit', ENCOURAGE_TV_KEY = 'splinetopia.encourageTV';
const body = document.body;
const startEditToggle = document.getElementById('s-starteditmode');

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

let startInEdit = recall(START_EDIT_KEY, true);
startEditToggle.classList.toggle('on', startInEdit);
startEditToggle.addEventListener('click', () => {
  startInEdit = !startInEdit;
  startEditToggle.classList.toggle('on', startInEdit);
  remember(START_EDIT_KEY, startInEdit);
});
S.encourageTV = recall(ENCOURAGE_TV_KEY, false);
const encourageTVToggle = document.getElementById('s-encouragetv');
encourageTVToggle.classList.toggle('on', S.encourageTV);
encourageTVToggle.addEventListener('click', () => {
  S.encourageTV = !S.encourageTV;
  encourageTVToggle.classList.toggle('on', S.encourageTV);
  remember(ENCOURAGE_TV_KEY, S.encourageTV);
});

// The page starts in Edit (core/state.js) with the panel hidden (index.html). Once everything's loaded (see loading.js),
// Edit slides the panel in; World is pressed instead when not starting in Edit.
whenLoaded(() => {
  body.classList.remove('ui-loading', 'start-edit'); // (hints slide in: css/base.css)
  if (startInEdit) body.classList.remove('w3-no-panel');
  else document.querySelector('#mode-toolbar [data-mode=move]').click();
});
