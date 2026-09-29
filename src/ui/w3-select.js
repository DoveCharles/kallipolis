// Every <select class="select-input"> drawn as a Windows 3.0 drop-down list (the browser's own list pops up in the
// system's style): the select stays, hidden, holding the value and firing change as before; a field with the arrow
// button stands in for it, and a list of its options pops up under that. Setting .value or .selectedIndex in code, or
// changing its options, redraws the field. Styled in css/win3.css (.w3-select, .w3-select-list).
const VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
const LIST_ROWS = 12; // (longer lists scroll)
let open = null; // { select, list, hot }

function enhance(select) {
  if (select.w3Box) return;
  const box = document.createElement('div');
  box.className = 'w3-select';
  box.tabIndex = 0;
  box.style.cssText = select.style.cssText;
  box.innerHTML = '<span class="w3-select-text"></span><span class="w3-select-arrow"></span>';
  select.after(box);
  select.classList.add('w3-enhanced');
  select.w3Box = box;
  const text = box.firstChild;
  const refresh = () => {
    text.textContent = select.selectedOptions[0]?.textContent ?? '';
    box.classList.toggle('disabled', select.disabled);
    box.style.display = select.style.display === 'none' ? 'none' : '';
  };
  select.w3Refresh = refresh;
  Object.defineProperty(select, 'value', { configurable: true, get() { return VALUE.get.call(this); }, set(v) { VALUE.set.call(this, v); refresh(); } });
  Object.defineProperty(select, 'selectedIndex', { configurable: true, get() { return INDEX.get.call(this); }, set(v) { INDEX.set.call(this, v); refresh(); } });
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
  select.addEventListener('change', refresh);
  box.addEventListener('mousedown', e => {
    if (e.button !== 0 || select.disabled) return;
    e.preventDefault();
    box.focus();
    if (open?.select === select) close(); else openList(select);
  });
  box.addEventListener('keydown', e => {
    if (select.disabled) return;
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (open?.select === select) {
      if (step) setHot(Math.max(0, Math.min(select.options.length - 1, open.hot + step)));
      else if (e.key === 'Enter' || e.key === ' ') pick(select, open.hot);
      else if (e.key === 'Escape' || e.key === 'Tab') close();
      else return;
    } else if (e.altKey && step) openList(select);
    else if (step) pick(select, Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + step)));
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'F4') openList(select);
    else return;
    e.preventDefault();
  });
  box.addEventListener('blur', () => { if (open?.select === select) close(); });
  refresh();
}

function openList(select) {
  close();
  select.w3Refresh();
  const box = select.w3Box, at = box.getBoundingClientRect();
  const list = document.createElement('div');
  list.className = 'w3-select-list';
  [...select.options].forEach((option, i) => {
    const item = document.createElement('div');
    item.className = 'w3-select-item';
    item.textContent = option.textContent;
    item.addEventListener('mousemove', () => setHot(i));
    item.addEventListener('mousedown', e => e.preventDefault()); // (the field keeps focus)
    item.addEventListener('click', () => pick(select, i));
    list.appendChild(item);
  });
  document.body.appendChild(list);
  const rowH = list.firstChild?.offsetHeight || 16;
  list.style.width = at.width + 'px';
  list.style.maxHeight = rowH*LIST_ROWS + 2 + 'px';
  const below = window.innerHeight - at.bottom, tall = list.offsetHeight;
  list.style.left = at.left + 'px';
  list.style.top = (below < tall && at.top > below ? at.top - tall + 1 : at.bottom - 1) + 'px';
  box.classList.add('down');
  open = { select, list, hot: -1 };
  setHot(Math.max(0, select.selectedIndex));
}
function setHot(i) {
  if (!open) return;
  open.list.children[open.hot]?.classList.remove('hot');
  open.hot = i;
  const item = open.list.children[i];
  if (!item) return;
  item.classList.add('hot');
  if (item.offsetTop < open.list.scrollTop) open.list.scrollTop = item.offsetTop;
  else if (item.offsetTop + item.offsetHeight > open.list.scrollTop + open.list.clientHeight) open.list.scrollTop = item.offsetTop + item.offsetHeight - open.list.clientHeight;
}
function pick(select, i) {
  close();
  if (i < 0 || i === select.selectedIndex) return;
  select.selectedIndex = i;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
function close() {
  if (!open) return;
  open.select.w3Box.classList.remove('down');
  open.list.remove();
  open = null;
}
document.addEventListener('mousedown', e => { if (open && !open.list.contains(e.target) && !open.select.w3Box.contains(e.target)) close(); }, true);
window.addEventListener('resize', close);
document.addEventListener('scroll', e => { if (open && !open.list.contains(e.target)) close(); }, true);

// every select there now, and any added later (panels build theirs as they're shown)
const enhanceIn = root => {
  if (root.matches?.('select.select-input')) enhance(root);
  root.querySelectorAll?.('select.select-input').forEach(enhance);
};
enhanceIn(document.body);
new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(enhanceIn))).observe(document.body, { childList: true, subtree: true });
