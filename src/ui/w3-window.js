// ============================================================ little windows
// A window over the view in the Windows 3.0 look, for the Options menu's Sound levels (ui/sound-levels.js) and settings
// (ui/settings-windows.js): a title bar with a control-menu box, whatever's put in it, and OK. It doesn't block anything
// — the city plays on, so a change is seen or heard as it's made — starts in the middle, is dragged about by its title
// bar, and closes from its box, OK, Esc or Enter. It takes the navy title bar when it opens or is clicked (the active
// window: see ui/win3-menu.js). The styles are in css/win3.css (.w3-window).
const open = {}; // id -> the window's element, while it's open

/**
 * Open a window, or bring it to the front if it's open already.
 * @param {{id: string, title: string, fill: function(HTMLElement): void, onClose?: function(): void, width?: number}} spec -
 *   fill puts the window's content into the element it's handed; onClose runs as it closes
 * @returns {HTMLElement} the window
 */
export function openWindow({ id, title, fill, onClose, width }) {
  if (open[id]) { activate(open[id]); return open[id]; }
  const win = document.createElement('div');
  win.className = 'w3-dialog w3-window';
  win.id = id;
  if (width) win.style.width = width + 'px';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', title);
  win.innerHTML = `<div class="win3-titlebar"><button class="win3-sysbox" title="Close"></button><div class="win3-title">${title}</div></div>
    <div class="w3-dialog-body"></div>
    <div class="w3-dialog-buttons"><button class="btn w3-default">OK</button></div>`;
  fill(win.querySelector('.w3-dialog-body'));
  win.close = () => {
    onClose?.();
    win.hidden = true; // (hidden first, so the active window passes back)
    win.remove();
    delete open[id];
  };
  win.querySelector('.win3-sysbox').addEventListener('click', win.close);
  win.querySelector('.w3-default').addEventListener('click', win.close);
  win.addEventListener('keydown', e => {
    if (e.key === 'Escape' || (e.key === 'Enter' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON')) { e.preventDefault(); win.close(); }
  });
  dragByTitle(win);
  document.body.append(win);
  open[id] = win;
  activate(win);
  return win;
}
/** Close every window that's open (as the Windows 3.0 look goes off, say). */
export function closeWindows() { Object.values(open).forEach(win => win.close()); }

function activate(win) {
  win.dispatchEvent(new Event('card-show', { bubbles: true }));
  win.querySelector('.w3-dialog-body input, .w3-dialog-body button, .w3-default')?.focus();
}

// dragged about by its title bar, kept on screen
function dragByTitle(el) {
  const bar = el.querySelector('.win3-titlebar');
  bar.addEventListener('pointerdown', e => {
    if (e.target !== bar && !e.target.classList.contains('win3-title')) return;
    e.preventDefault();
    const box = el.getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
    const move = m => {
      el.style.left = Math.min(innerWidth - box.width, Math.max(0, m.clientX - dx)) + 'px';
      el.style.top = Math.min(innerHeight - box.height, Math.max(0, m.clientY - dy)) + 'px';
      el.style.transform = 'none';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
