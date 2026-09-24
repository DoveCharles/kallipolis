// View > FPS (debug): a frame-rate readout in the bottom-right corner of the view, updated twice a second from its own
// requestAnimationFrame loop (which only runs while it's shown). Kept in localStorage.
const KEY = 'splinetopia.fps';
const el = document.createElement('div');
el.id = 'fps-counter';
el.hidden = true;
document.body.appendChild(el);

let frames = 0, since = 0, raf = 0;
function tick(now) {
  frames++;
  if (now - since >= 500) {
    el.textContent = `${Math.round(frames * 1000 / (now - since))} FPS`;
    frames = 0; since = now;
  }
  raf = requestAnimationFrame(tick);
}

function set(on, save) {
  el.hidden = !on;
  cancelAnimationFrame(raf);
  if (on) { frames = 0; since = performance.now(); el.textContent = '… FPS'; raf = requestAnimationFrame(tick); }
  if (save) try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (err) { /* storage blocked */ }
}
try { set(localStorage.getItem(KEY) === '1', false); } catch (err) { /* storage blocked */ }

export const fpsCounter = { shown: () => !el.hidden, toggle: () => set(el.hidden, true) };
