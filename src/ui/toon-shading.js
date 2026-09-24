import { setToon as setRamp } from '../core/toon.js';

// Display > Toon characters: people (their hair and clothes too) and bees drawn in bands of light (see core/toon.js) or smoothly lit.
// A browser preference in localStorage, like flat shading; on unless turned off.
const TOON_KEY = 'splinetopia.toonPeople';
const toggle = document.getElementById('s-toonpeople');
let toon = true;

function setToon(on, save) {
  toon = on;
  toggle.classList.toggle('on', on);
  setRamp(on);
  if (save) try { localStorage.setItem(TOON_KEY, on ? '1' : '0'); } catch (err) { /* storage blocked */ }
}

toggle.addEventListener('click', () => setToon(!toon, true));
let saved = null;
try { saved = localStorage.getItem(TOON_KEY); } catch (err) { /* storage blocked */ }
setToon(saved !== '0', false);
