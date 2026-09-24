// Browser preferences (localStorage, not the project's) for what shows on start and over the view:
// - hints: View > Edit Hints (the bottom #hint in Edit and Maps) and View > General Hints (the bottom #hint in World,
//   including the controls while possessing or driving). Hidden by body classes; see css/base.css.
// - Options > Game > Start in Edit mode: on, the side panel slides in once loaded; off, the app opens in World instead.
const EDIT_HINTS_KEY = 'splinetopia.editHints', GENERAL_HINTS_KEY = 'splinetopia.generalHints';
const START_EDIT_KEY = 'splinetopia.startInEdit';
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
// The page starts in Edit (core/state.js) with the panel hidden (index.html). Once loaded and a frame has been drawn, Edit
// slides the panel in; World is pressed instead when not starting in Edit.
function whenReady(run) {
  const afterFrame = () => requestAnimationFrame(() => requestAnimationFrame(run));
  if (document.readyState === 'complete') afterFrame(); else window.addEventListener('load', afterFrame, { once: true });
}
whenReady(() => {
  if (startInEdit) body.classList.remove('w3-no-panel');
  else document.querySelector('#mode-toolbar [data-mode=move]').click();
});
