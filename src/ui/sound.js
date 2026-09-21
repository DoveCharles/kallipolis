import { setMuted, isMuted } from '../audio/sfx.js';

// ============================================================ sound toggle
// The Sound switch in World settings mutes every sound (see audio/sfx.js). Like the Windows 3.0 look, it's the browser's
// preference rather than part of the project, so it's remembered in localStorage rather than saved with the project.
const STORAGE_KEY = 'splinetopia.muted';
const toggle = document.getElementById('s-sound');
function setSound(on) {
  setMuted(!on);
  toggle.classList.toggle('on', on);
  try { localStorage.setItem(STORAGE_KEY, on ? '0' : '1'); } catch (err) { /* storage blocked: it just isn't remembered */ }
}
let remembered = null;
try { remembered = localStorage.getItem(STORAGE_KEY); } catch (err) { /* as above */ }
setSound(remembered !== '1');
toggle.addEventListener('click', () => setSound(isMuted()));
