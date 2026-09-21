import { setMuted, isMuted } from '../audio/sfx.js';

// ============================================================ sound toggle
// The speaker button over the view, by undo and redo, mutes every sound (see audio/sfx.js). Like the Windows 3.0 look,
// it's the browser's preference rather than part of the project, so it's remembered in localStorage rather than saved
// with the project.
const STORAGE_KEY = 'splinetopia.muted';
const SPEAKER = '<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/>';
const ICONS = {
  on: SPEAKER + '<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  off: SPEAKER + '<path d="m16 9 6 6M22 9l-6 6"/>',
};
const button = document.getElementById('btn-sound');
function setSound(on) {
  setMuted(!on);
  button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[on ? 'on' : 'off']}</svg>`;
  button.title = on ? 'Mute' : 'Unmute';
  try { localStorage.setItem(STORAGE_KEY, on ? '0' : '1'); } catch (err) { /* storage blocked: it just isn't remembered */ }
}
let remembered = null;
try { remembered = localStorage.getItem(STORAGE_KEY); } catch (err) { /* as above */ }
setSound(remembered !== '1');
button.addEventListener('click', () => setSound(isMuted()));
