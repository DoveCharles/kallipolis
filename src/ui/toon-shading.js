import { setPeopleToon } from '../life/people/peopleModel.js';

// Display > Toon people: people, their hair and clothes drawn in bands of light (see setPeopleToon) or smoothly lit.
// A browser preference in localStorage, like flat shading; on unless turned off.
const TOON_KEY = 'splinetopia.toonPeople';
const toggle = document.getElementById('s-toonpeople');
let toon = true;

function setToon(on, save) {
  toon = on;
  toggle.classList.toggle('on', on);
  setPeopleToon(on);
  if (save) try { localStorage.setItem(TOON_KEY, on ? '1' : '0'); } catch (err) { /* storage blocked */ }
}

toggle.addEventListener('click', () => setToon(!toon, true));
let saved = null;
try { saved = localStorage.getItem(TOON_KEY); } catch (err) { /* storage blocked */ }
setToon(saved !== '0', false);
