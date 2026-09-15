import { App } from '../core/shared.js';

// ============================================================ Windows 3.0 look
// A checkbox in World settings dresses the UI up as Windows 3.0 — the styles are all in style.css, under html.win3. It's the
// browser's preference rather than part of the project, so it's remembered in localStorage (and put on the page by a small
// script in index.html's head, before anything's drawn) rather than saved with the project or undone.
const STORAGE_KEY = 'splinetopia.win3';
const toggle = document.getElementById('s-win3');
function setWin3(on) {
  document.documentElement.classList.toggle('win3', on);
  toggle.classList.toggle('on', on);
  try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (err) { /* storage blocked: it just isn't remembered */ }
}
toggle.classList.toggle('on', document.documentElement.classList.contains('win3'));
toggle.addEventListener('click', () => setWin3(!document.documentElement.classList.contains('win3')));

// the title bars' buttons: on the panel, minimize folds it up to its title bar, and maximize — or the control-menu box — opens
// it out again; on the person card, the control-menu box closes it, as double-clicking one closed a window
const panel = document.getElementById('panel');
panel.querySelector('.win3-min').addEventListener('click', () => panel.classList.add('win3-minimized'));
panel.querySelector('.win3-max').addEventListener('click', () => panel.classList.remove('win3-minimized'));
panel.querySelector('.win3-sysbox').addEventListener('click', () => panel.classList.toggle('win3-minimized'));
document.querySelector('#person-card .win3-sysbox').addEventListener('click', () => App.stopFollowingPerson());
