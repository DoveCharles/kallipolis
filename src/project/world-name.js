import { getProgress, setProgress, onProgress } from './progress.js';

// ============================================================ world name
// The city's name (World window, top): in the title bar and the saved file's name. Kept in progress, so undo leaves it.
const input = document.getElementById('s-worldname');
const title = document.getElementById('world-title');

/** @returns {string} the name, '' if none */
export const worldName = () => getProgress('worldName') || '';

function show() {
  const name = worldName();
  if (document.activeElement !== input) input.value = name;
  title.textContent = name ? ' - ' + name : '';
}
input.addEventListener('input', () => { setProgress('worldName', input.value.trim()); show(); });
onProgress('worldName', show);
show();

/** For File > Save: the name to save under, asking first if there's none. @returns {Promise<?string>} null: cancelled */
export async function saveFileName() {
  if (!worldName()) {
    const { messageBox } = await import('../ui/win3-menu.js');
    const ask = messageBox('Save World', '<p>Name this world:</p><input type="text" id="w3-namebox" maxlength="40" placeholder="Unnamed world">', ['OK', 'Cancel']);
    const box = document.getElementById('w3-namebox');
    box.focus();
    if (await ask !== 'OK') return null;
    const name = box.value.trim();
    if (name) { setProgress('worldName', name); show(); }
  }
  const slug = worldName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (slug || 'kallipolis_project') + '.json';
}
