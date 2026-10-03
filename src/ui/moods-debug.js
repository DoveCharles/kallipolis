import { openWindow } from './w3-window.js';
import { people, followed, isDrawn, isGone } from '../life/people/people.js';
import { followPerson } from '../life/people/peopleTracking.js';
import { moodEntries } from '../life/profiles.js';

// ============================================================ moods (debug)
// View > Moods (debug): puts whoever the camera's following (or, following no one, the first person drawn, who it then
// follows) in any mood from people/moods.txt, with ◀ ▶ to step through them, so what each shows (tears, a blush, steam,
// an upside-down head…: see life/people/peopleEmotes.js) can be looked at. Only the moods that show something beyond the
// eyes are listed unless "all" is ticked. Closing the window gives them back the mood they had.
const EMOTE_TRAITS = ['crying', 'welling', 'drooling', 'skeptical', 'goofy', 'blushing', 'lovestruck', 'fuming', 'huffing', 'drowsy', 'sweating', 'panicking', 'freezing',
  'starstruck', 'partying', 'singing', 'upsidedown'];
let target = null, theirOwn, all = false, at = 0;

// (a mood's traits are [name, value] pairs, the value left off for one that's just switched on)
const shows = entry => (entry.traits ?? []).some(([name]) => EMOTE_TRAITS.includes(name));
const moods = () => moodEntries().filter(entry => all || shows(entry));

/** Put the target in the mood at `at` in the list (their traits worked out again: see refreshTraits in people.js). */
function apply(body) {
  const list = moods();
  if (!target || !list.length) return;
  at = (at + list.length) % list.length;
  target.moodNow = list[at].text;
  target.traitsKey = '';
  body.querySelector('#md-mood').value = String(at);
  body.querySelector('#md-traits').textContent = (list[at].traits ?? []).map(([k, v]) => v == null || v === true ? k : `${k} ${v}`).join(', ') || '(no traits)';
}

function pick() {
  const i = followed >= 0 && people[followed] ? followed : people.findIndex(isDrawn);
  if (i < 0) return;
  target = people[i];
  theirOwn = target.moodNow;
  if (followed !== i) followPerson(i);
}

function giveBack() {
  if (target) { target.moodNow = theirOwn; target.traitsKey = ''; }
  target = null;
}

function fill(body) {
  const list = moods();
  body.innerHTML = `<div class="row" style="display:flex;gap:4px;align-items:center">
      <button id="md-prev">◀</button>
      <select id="md-mood" style="flex:1;font-size:16px">${list.map((entry, n) => `<option value="${n}">${entry.text}</option>`).join('')}</select>
      <button id="md-next">▶</button></div>
    <div id="md-traits" style="font:11px monospace;margin:6px 0;min-height:2.6em"></div>
    <label><input type="checkbox" id="md-all"${all ? ' checked' : ''}> all moods</label>
    ${target ? `<div style="margin-top:4px">On ${target.name ?? 'someone'}.</div>` : '<div>No one to show: turn people on first.</div>'}`;
  body.querySelector('#md-prev').addEventListener('click', () => { at--; apply(body); });
  body.querySelector('#md-next').addEventListener('click', () => { at++; apply(body); });
  body.querySelector('#md-mood').addEventListener('change', e => { at = +e.target.value; apply(body); });
  body.querySelector('#md-all').addEventListener('change', e => { all = e.target.checked; at = 0; fill(body); });
  apply(body);
}

/** Open the moods debug window, or bring it to the front. */
export function openMoodsDebug() {
  if (!target) pick();
  const win = openWindow({ id: 'moods-debug', title: 'Moods (debug)', width: 240, onClose: giveBack, fill });
  win.style.transform = 'none';
  win.style.left = (innerWidth - win.offsetWidth - 10) + 'px';
  win.style.top = '60px';
}

/** View > Find Headphones (debug): follows the next person in the 🎵 mood (headphones on: see people.js), or, with no
 * one in it, puts the followed (or first drawn) person in it. */
export function findHeadphones() {
  const n = people.length, from = followed >= 0 ? followed : -1;
  for (let k = 1; k <= n; k++) {
    const i = (from + k + n) % n;
    if (people[i]?.traits?.singing > 0 && !isGone(people[i])) { followPerson(i); return; }
  }
  const i = followed >= 0 && people[followed] ? followed : people.findIndex(isDrawn), entry = moodEntries().find(e => (e.traits ?? []).some(([name]) => name === 'singing'));
  if (i < 0 || !entry) return;
  people[i].moodNow = entry.text; people[i].traitsKey = '';
  if (followed !== i) followPerson(i);
}
