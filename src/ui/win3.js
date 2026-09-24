// ============================================================ Windows 3.0 look
// The UI is dressed up as Windows 3.0 — the styles are all in css/win3.css, under html.win3 (set in index.html; it's the
// only look there is).
// the title bars' buttons: on the panel, minimize (▲ here, though Windows 3.0 drew it ▼) folds it up to its title bar, and maximize (▼) — or the control-menu box — opens
// it out again. (The cards for whoever's being followed close from their control-menu box, as double-clicking one closed
// a window — wired up by makeCard in ui/entity-card.js, along with the rest of a card.)
const panel = document.getElementById('panel');
panel.querySelector('.win3-min').addEventListener('click', () => panel.classList.add('win3-minimized'));
panel.querySelector('.win3-max').addEventListener('click', () => panel.classList.remove('win3-minimized'));
panel.querySelector('.win3-sysbox').addEventListener('click', () => panel.classList.toggle('win3-minimized'));
