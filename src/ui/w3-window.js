// ============================================================ little windows
// A window over the view in the Windows 3.0 look, for the Options menu's Sound levels (ui/sound-levels.js) and settings
// (ui/settings-windows.js): a title bar with a control-menu box, whatever's put in it, and OK. It doesn't block anything
// — the city plays on, so a change is seen or heard as it's made — starts in the middle, is dragged about by its title
// bar (and, if it's resizable, sized by its border), and closes from its box, OK, Esc or Enter. It takes the navy title bar when it opens or is clicked (the active
// window: see ui/win3-menu.js). The styles are in css/win3.css (.w3-window).
const open = {}; // id -> the window's element, while it's open

/**
 * Open a window, or bring it to the front if it's open already.
 * @param {{id: string, title: string, fill: function(HTMLElement): void, onClose?: function(): void, width?: number, resizable?: boolean}} spec -
 *   fill puts the window's content into the element it's handed; onClose runs as it closes; resizable lets its border be
 *   dragged to size it, its content scrolling to fit
 * @returns {HTMLElement} the window
 */
export function openWindow({ id, title, fill, onClose, width, resizable }) {
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
  if (resizable) sizeByBorder(win);
  document.body.append(win);
  open[id] = win;
  activate(win);
  return win;
}
/** Close every window that's open (as the view narrows to a phone, say). */
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

// sized by dragging its border, as Windows 3.0's windows were: a side sizes one way, and the notched stretch of border
// at a corner (see --w3-ridges in css/win3.css) both ways; kept on screen and no smaller than there's room for
const BORDER = 4, CORNER = 24, MIN_W = 260, MIN_H = 140;
function sizeByBorder(el) {
  const sidesAt = e => {
    const r = el.getBoundingClientRect();
    const l = e.clientX - r.left, rt = r.right - e.clientX, t = e.clientY - r.top, b = r.bottom - e.clientY;
    if (Math.min(l, rt, t, b) >= BORDER) return null;
    const onX = l < BORDER || rt < BORDER, onY = t < BORDER || b < BORDER;
    return { l: l < BORDER || (onY && l < CORNER), r: rt < BORDER || (onY && rt < CORNER),
      t: t < BORDER || (onX && t < CORNER), b: b < BORDER || (onX && b < CORNER) };
  };
  const cursorOf = s => !s ? '' : (s.l && s.t) || (s.r && s.b) ? 'nwse-resize' : (s.r && s.t) || (s.l && s.b) ? 'nesw-resize'
    : s.l || s.r ? 'ew-resize' : 'ns-resize';
  el.addEventListener('pointermove', e => { if (!e.buttons) el.style.cursor = cursorOf(sidesAt(e)); });
  el.addEventListener('pointerdown', e => {
    const s = sidesAt(e);
    if (!s) return;
    e.preventDefault();
    const box = el.getBoundingClientRect();
    el.classList.add('w3-sized');
    const move = m => {
      let { left, top, right, bottom } = box;
      if (s.l) left = Math.max(0, Math.min(right - MIN_W, m.clientX));
      if (s.r) right = Math.min(innerWidth, Math.max(left + MIN_W, m.clientX));
      if (s.t) top = Math.max(0, Math.min(bottom - MIN_H, m.clientY));
      if (s.b) bottom = Math.min(innerHeight, Math.max(top + MIN_H, m.clientY));
      Object.assign(el.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px', transform: 'none' });
    };
    move({ clientX: s.l ? box.left : box.right, clientY: s.t ? box.top : box.bottom });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
