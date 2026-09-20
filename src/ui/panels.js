import { S, App, setSandTint } from '../core/shared.js';
import { scene } from '../core/scene.js';
import { BUILDING_GROUND_COLORS, ROAD_COLOR, ROAD_COLOR_PALETTE, PARK_TINT_COLORS, TREE_TINT_COLORS, SAND_TINT_COLORS, DEFAULT_GRASS_NOISE_STRENGTH } from '../core/splines.js';
import { roadNodes, MAX_TARGET_LOTS } from '../core/state.js';
import { SIDEWALK_COLOR, SIDEWALK_COLOR_PALETTE, disposeObject } from '../roads/roads.js';
import { WALKWAY_COLOR, WALKWAY_COLOR_PALETTE, WALKWAY_TEXTURE, isWalkwayLine, isRiverLine, rebuildRoadMeshes, refreshRoadAppearance, walkwayTextureChangeNeedsRebuild, defaultWalkwayTextureScale, walkwayTextureScaleOf } from '../roads/paths.js';
import { networkKindOf, rebuildRoadMarkers, rebuildRoadHandles, cleanupOrphanRoadNodes } from '../trains/trains.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { PLAZA_COLORS } from '../zones/plazas.js';
import { subdivideZone, subdivideZonesFrom, subdivideZonesFromIndex, moveZone } from '../zones/cutouts.js';
import { refreshHighlights } from '../water/bridges.js';
import { IS_TOUCH } from '../core/device.js';

// ============================================================ selection / hierarchy
export function selectItem(type,id,force) {
  if (!force && S.selection.type===type && S.selection.id===id) { deselect(); return; }
  S.selection = { type, id };
  S.currentTool = type;
  S.colorPickerState = null;
  if (type==='road') {
    S.lastSelectedRoadNetworkId = id;
    // new paths take the type of the one last selected
    const line = S.roadLines.find(l=>l.networkId===id);
    if (line) S.newRoadType = line.roadType || 'sidewalk';
  }
  else if (type==='zone') S.lastSelectedZoneId = id;
  else if (type==='train') S.lastSelectedTrainNetworkId = id;
  refreshHighlights();
  S.zones.forEach(rebuildZoneVisual);
  rebuildRoadMarkers(); rebuildRoadHandles(); // the tab may have changed, and each tab only shows its own kind of node
  App.applyModeVisibility();
  renderHierarchy();
}
function deselect() {
  S.selection = { type:null, id:null };
  S.colorPickerState = null;
  refreshHighlights();
  S.zones.forEach(rebuildZoneVisual);
  renderHierarchy();
}
function removeRoadNetwork(networkId) {
  const removedIds = S.roadLines.filter(l=>l.networkId===networkId).map(l=>l.id);
  S.roadLines = S.roadLines.filter(l => l.networkId!==networkId);
  if (S.activeRoadLine && removedIds.includes(S.activeRoadLine.id)) S.activeRoadLine=null;
  if ((S.selection.type==='road' || S.selection.type==='train') && S.selection.id===networkId) S.selection={type:null,id:null};
  cleanupOrphanRoadNodes();
  rebuildRoadMeshes();
  S.zones.forEach(subdivideZone);
  renderHierarchy();
}
function removeZone(id) {
  const zone = S.zones.find(z=>z.id===id);
  if (!zone) return;
  const index = S.zones.indexOf(zone);
  S.zones = S.zones.filter(z=>z.id!==id);
  if (zone.outlineGroup) { scene.remove(zone.outlineGroup); disposeObject(zone.outlineGroup); }
  if (zone.buildingsGroup) { scene.remove(zone.buildingsGroup); disposeObject(zone.buildingsGroup); }
  if (S.activeZone && S.activeZone.id===id) S.activeZone=null;
  if (S.selection.id===id) S.selection={type:null,id:null};
  if (!zone.drawing) subdivideZonesFromIndex(index); // the zones below get back what it was cutting out of them
  renderHierarchy();
  updateStats();
}
export function deleteRoadNode(id) {
  delete roadNodes[id];
  for (let i=S.roadLines.length-1;i>=0;i--) {
    const line = S.roadLines[i];
    const idx = line.nodeIds.indexOf(id);
    if (idx!==-1) line.nodeIds.splice(idx,1);
    if (line.nodeIds.length<2) S.roadLines.splice(i,1);
  }
  if ((S.selection.type==='road' || S.selection.type==='train') && !S.roadLines.some(l=>l.networkId===S.selection.id)) S.selection={type:null,id:null};
  rebuildRoadMeshes();
  S.zones.forEach(subdivideZone);
  renderHierarchy();
}
export function deleteZoneVertex(zone, idx) {
  zone.points.splice(idx,1);
  if (zone.points.length<3) { removeZone(zone.id); return; }
  subdivideZonesFrom(zone);
  rebuildZoneVisual(zone);
  renderHierarchy();
}

export function renderHierarchy() {
  // road and train networks both live in roadLines, and are listed together in the Paths tab
  const pathsList = document.getElementById('paths-list');
  pathsList.innerHTML='';
  const networks = [];
  const seenNetworks = new Set();
  S.roadLines.forEach(line => {
    if (seenNetworks.has(line.networkId)) return;
    seenNetworks.add(line.networkId);
    networks.push({ netId: line.networkId, kind: networkKindOf(line) });
  });
  networks.forEach(({ netId, kind }) => {
    const lines = S.roadLines.filter(l=>l.networkId===netId);
    const row = document.createElement('div');
    row.className = 'hier-row' + (S.selection.type===kind&&S.selection.id===netId?' active':'');
    const span = document.createElement('span');
    span.textContent = lines.length>1
      ? `${netId} · ${lines.length} branches`
      : lines[0].id;
    row.appendChild(span);
    const del = document.createElement('button');
    del.className='hier-del'; del.textContent='×';
    del.onclick = (e)=>{ e.stopPropagation(); removeRoadNetwork(netId); };
    row.appendChild(del);
    row.onclick = ()=> selectItem(kind, netId);
    pathsList.appendChild(row);
  });
  document.getElementById('paths-count').textContent = networks.length;

  const zonesList = document.getElementById('zones-list');
  zonesList.innerHTML='';
  S.zones.forEach(zone => {
    const row = document.createElement('div');
    row.className = 'hier-row' + (S.selection.type==='zone'&&S.selection.id===zone.id?' active':'');
    const span = document.createElement('span');
    span.textContent = zone.name + (zone.drawing?' (drawing…)':'');
    row.appendChild(span);
    const del = document.createElement('button');
    del.className='hier-del'; del.textContent='×';
    del.onclick = (e)=>{ e.stopPropagation(); removeZone(zone.id); };
    row.appendChild(del);
    row.onclick = ()=> selectItem('zone', zone.id);
    // drag to reorder: higher in the list = higher priority, cutting into every zone below
    row.draggable = !zone.drawing;
    row.addEventListener('dragstart', (e) => {
      S.draggedZoneId = zone.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', zone.id);
    });
    row.addEventListener('dragend', () => { if (S.draggedZoneId) { S.draggedZoneId = null; renderHierarchy(); } });
    row.addEventListener('dragover', (e) => {
      if (!S.draggedZoneId || S.draggedZoneId===zone.id) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect(), before = e.clientY < rect.top + rect.height/2;
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      if (!S.draggedZoneId) return;
      e.preventDefault();
      moveZone(S.draggedZoneId, zone.id, row.classList.contains('drop-before'));
    });
    // dragging and dropping never happens under a finger, so touch moves a zone up and down the list a step at a time
    if (IS_TOUCH) {
      const step = (dir) => (e) => {
        e.stopPropagation();
        const i = S.zones.indexOf(zone), j = i + dir;
        if (j < 0 || j >= S.zones.length) return;
        moveZone(zone.id, S.zones[j].id, dir < 0);
      };
      const up = document.createElement('button');
      up.className = 'hier-move'; up.textContent = '\u25b2'; up.title = 'Move up (cuts into more)'; up.onclick = step(-1);
      const down = document.createElement('button');
      down.className = 'hier-move'; down.textContent = '\u25bc'; down.title = 'Move down'; down.onclick = step(1);
      row.insertBefore(up, del); row.insertBefore(down, del);
    }
    zonesList.appendChild(row);
  });
  document.getElementById('zones-count').textContent = S.zones.length;

  syncRoadWidthUI();
  syncSidewalkWidthUI();
  syncTrainRadiusUI();
  App.renderObjectsPanel?.(); // the Objects tab's palette and list, which also fills in the details panel (see objects.js)
  renderDetails();
  updateStats();
}

function syncRoadWidthUI() {
  const widthInput = document.getElementById('s-roadwidth');
  const widthVal = document.getElementById('v-roadwidth');
  const ctx = document.getElementById('rw-context');
  if (S.selection.type==='road') {
    const line = S.roadLines.find(l=>l.networkId===S.selection.id);
    if (line) {
      widthInput.value = line.width;
      widthVal.textContent = line.width;
      ctx.textContent = '· '+S.selection.id;
      return;
    }
  }
  widthInput.value = S.DEFAULT_ROAD_WIDTH;
  widthVal.textContent = S.DEFAULT_ROAD_WIDTH;
  ctx.textContent = '· new paths';
}
function syncSidewalkWidthUI() {
  const widthInput = document.getElementById('s-sidewalkwidth');
  const widthVal = document.getElementById('v-sidewalkwidth');
  const ctx = document.getElementById('sw-context');
  if (S.selection.type==='road') {
    const line = S.roadLines.find(l=>l.networkId===S.selection.id);
    if (line) {
      const v = line.sidewalkWidth!=null ? line.sidewalkWidth : S.DEFAULT_SIDEWALK_WIDTH;
      widthInput.value = v;
      widthVal.textContent = v;
      ctx.textContent = '· '+S.selection.id;
      return;
    }
  }
  widthInput.value = S.DEFAULT_SIDEWALK_WIDTH;
  widthVal.textContent = S.DEFAULT_SIDEWALK_WIDTH;
  ctx.textContent = '· new paths';
}

function syncTrainRadiusUI() {
  const line = S.selection.type==='train' ? S.roadLines.find(l=>l.networkId===S.selection.id) : null;
  const v = line ? (line.radius || S.TRAIN_DEFAULT_RADIUS) : S.TRAIN_DEFAULT_RADIUS;
  document.getElementById('s-tuberadius').value = v;
  document.getElementById('v-tuberadius').textContent = v;
  document.getElementById('tr-context').textContent = line ? '· '+S.selection.id : '· new lines';
}

// Generic dual-handle range slider — two overlapping native <input type=range> (see the
// .range-slider CSS for how clicks reach whichever handle is under the cursor) plus a green
// fill bar between them. `id` must be unique within whatever panel renders it.
function rangeSliderHtml(id, label, min, max, step, valLo, valHi, decimals) {
  const fmt = v => decimals!=null ? Number(v).toFixed(decimals) : v;
  return `
    <div class="slider-row">
      <div class="row"><label>${label}</label><span class="val" id="dv-${id}">${fmt(valLo)}–${fmt(valHi)}</span></div>
      <div class="range-slider">
        <div class="range-track"></div>
        <div class="range-fill" id="rf-${id}"></div>
        <input type="range" id="rs-${id}-lo" min="${min}" max="${max}" step="${step}" value="${valLo}">
        <input type="range" id="rs-${id}-hi" min="${min}" max="${max}" step="${step}" value="${valHi}">
      </div>
    </div>
  `;
}
function updateRangeFillVisual(id, min, max) {
  const lo = parseFloat(document.getElementById(`rs-${id}-lo`).value);
  const hi = parseFloat(document.getElementById(`rs-${id}-hi`).value);
  const fill = document.getElementById(`rf-${id}`);
  const loPct = (lo-min)/(max-min)*100, hiPct = (hi-min)/(max-min)*100;
  fill.style.left = loPct+'%';
  fill.style.width = Math.max(0, hiPct-loPct)+'%';
}
function wireRangeSlider(id, min, max, decimals, onChange) {
  // onChange(lo, hi) fires on every move, after clamping lo<=hi by pushing whichever handle
  // got crossed along with it — the same "push the other one" behavior this app's existing
  // single-slider min/max pairs already use (see heightMin/heightMax historically).
  const loInput = document.getElementById(`rs-${id}-lo`);
  const hiInput = document.getElementById(`rs-${id}-hi`);
  const dv = document.getElementById(`dv-${id}`);
  const fmt = v => decimals!=null ? Number(v).toFixed(decimals) : v;
  function apply(movedLo) {
    let lo = parseFloat(loInput.value), hi = parseFloat(hiInput.value);
    if (lo > hi) {
      if (movedLo) { hi = lo; hiInput.value = hi; } else { lo = hi; loInput.value = lo; }
    }
    dv.textContent = `${fmt(lo)}–${fmt(hi)}`;
    updateRangeFillVisual(id, min, max);
    onChange(lo, hi);
  }
  loInput.addEventListener('input', () => apply(true));
  hiInput.addEventListener('input', () => apply(false));
  updateRangeFillVisual(id, min, max);
}

// shared by any zone type that exposes a ground color (buildings, plain)
// generic extendable-palette swatch row, shared by anything with a "pick a color" control
// (zone ground color, road color, park grass tint, tree tint, ...). A single detail panel can
// now show more than one of these rows at once (a park zone has both Grass tint and Tree
// tint), so each row is tagged with its own `key` — colorPickerState carries that key too, so
// opening the add/edit picker on one row never touches the other row's elements or state, and
// element ids are suffixed with the key so two rows' "+"/confirm/cancel controls never collide.
function colorSwatchRowHtml(palette, currentHex, key) {
  key = key || 'default';
  const isOpen = S.colorPickerState && S.colorPickerState.key === key;
  return `
    <div class="swatch-row" data-palette-key="${key}">
      ${palette.map((c,i) => `
        <div class="swatch-wrap">
          <button class="swatch${c===currentHex?' active':''}" data-swatchcolor="${c}" title="Double-click to edit" style="background:#${c.toString(16).padStart(6,'0')}"></button>
          ${palette.length>1 ? `<button class="swatch-delete" data-deleteindex="${i}" title="Remove this color">&times;</button>` : ''}
        </div>
      `).join('')}
      ${isOpen ? `
        <div class="add-color-row">
          <input type="color" class="color-input" id="d-addcolor-input-${key}" value="#${(S.colorPickerState.mode==='edit'?palette[S.colorPickerState.index]:0x888888).toString(16).padStart(6,'0')}">
          <button class="add-color-confirm" id="d-addcolor-confirm-${key}">${S.colorPickerState.mode==='edit'?'OK':'Add'}</button>
          <button class="add-color-cancel" id="d-addcolor-cancel-${key}" title="Cancel">&times;</button>
        </div>
      ` : `<button class="swatch swatch-add" id="d-addcolor-${key}" title="Add custom color">+</button>`}
    </div>
  `;
}
function wireColorSwatchEvents(panel, palette, opts, key, rerender, currentHex) {
  // opts: { onPick(hex), onCommit(hex, mode, oldHexIfEdit), onRemove(oldHex, fallbackHex),
  //         onPreview(hex) — optional, called live on every drag tick of the open native
  //         picker (both add and edit) so a caller that wants to see the change land in the
  //         3D view as they drag can apply it immediately without waiting for Add/OK. }
  // Clicking "+" or double-clicking a swatch immediately opens the native picker (a .click()
  // on the now-visible color input, still inside the same user-gesture call stack) instead of
  // making the user click twice — once to reveal it, again to actually open it. The click is
  // deferred one frame: firing it in the same tick as the innerHTML swap that just created the
  // input can catch the browser before it's laid the element out, which is what made the
  // picker occasionally anchor to the top-left of the screen instead of the actual swatch.
  key = key || 'default';
  // rerender: which render function redraws this row's own panel — defaults to the zone/road
  // details panel, since that's every existing caller; the World section's tint rows pass
  // renderWorldTintPanel instead so opening/closing their picker redraws the right panel.
  rerender = rerender || renderDetails;
  function openPickerNextFrame() {
    requestAnimationFrame(() => {
      const input = document.getElementById('d-addcolor-input-'+key);
      if (input) input.click();
    });
  }
  // scoped to this row only — a panel with multiple swatch rows (e.g. a park's Grass tint +
  // Tree tint) must not have one row's wiring pick up another row's buttons.
  const row = panel.querySelector(`[data-palette-key="${key}"]`);
  if (!row) return;
  row.querySelectorAll('[data-swatchcolor]').forEach(btn => {
    btn.addEventListener('click', () => opts.onPick(parseInt(btn.dataset.swatchcolor, 10)));
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const hex = parseInt(btn.dataset.swatchcolor, 10);
      S.colorPickerState = { key, mode:'edit', index: palette.indexOf(hex) };
      rerender();
      openPickerNextFrame();
    });
  });
  row.querySelectorAll('[data-deleteindex]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.deleteindex, 10);
      const oldHex = palette[idx];
      palette.splice(idx, 1);
      opts.onRemove(oldHex, palette[0]);
      S.colorPickerState = null;
      rerender();
    });
  });
  if (S.colorPickerState && S.colorPickerState.key === key) {
    if (opts.onPreview) {
      document.getElementById('d-addcolor-input-'+key).addEventListener('input', (e) => {
        opts.onPreview(parseInt(e.target.value.slice(1), 16));
      });
    }
    document.getElementById('d-addcolor-confirm-'+key).addEventListener('click', () => {
      const hex = parseInt(document.getElementById('d-addcolor-input-'+key).value.slice(1), 16);
      if (S.colorPickerState.mode==='edit') {
        const oldHex = palette[S.colorPickerState.index];
        palette[S.colorPickerState.index] = hex;
        opts.onCommit(hex, 'edit', oldHex);
      } else {
        if (!palette.includes(hex)) palette.push(hex);
        opts.onCommit(hex, 'add', null);
      }
      S.colorPickerState = null;
      rerender();
    });
    document.getElementById('d-addcolor-cancel-'+key).addEventListener('click', () => {
      // undo whatever was live-previewed while dragging — the picker never actually committed
      if (opts.onPreview && currentHex!=null) opts.onPreview(currentHex);
      S.colorPickerState = null;
      rerender();
    });
  } else {
    const addBtn = document.getElementById('d-addcolor-'+key);
    if (addBtn) addBtn.addEventListener('click', () => {
      S.colorPickerState = { key, mode:'add' };
      rerender();
      openPickerNextFrame();
    });
  }
}
// World-section grass/tree tint — the default every park's grass and every tree falls back to
// unless a park zone turns on its own "Custom color" override (see the park zoneType branch in
// renderDetails). Lives in its own panel/render function since it's outside the zone/road
// details panel entirely.
// The one sand swatch, shown both in the World panel and in a beach's own settings. There is no
// per-zone version: a beach, the park fading into it and the shallows beyond it are one continuous
// stretch of sand, so a beach with its own color would seam against everything it touches. Both rows
// set the same color, which every sand material picks up through the shared SAND_TINT uniform with
// nothing rebuilt.
function wireSandTintSwatches(panel, swatchKey, rerender) {
  wireColorSwatchEvents(panel, SAND_TINT_COLORS, {
    onPick: (hex) => { setSandTint(hex); rerender(); },
    onCommit: (hex, mode, oldHex) => {
      if (mode==='edit') { if (S.globalSandTint===oldHex) setSandTint(hex); }
      else setSandTint(hex);
    },
    onRemove: (oldHex, fallback) => { if (S.globalSandTint===oldHex) setSandTint(fallback); },
    onPreview: (hex) => setSandTint(hex)
  }, swatchKey, rerender, S.globalSandTint);
}
export function renderWorldTintPanel() {
  const panel = document.getElementById('world-tint-panel');
  panel.innerHTML = `
    <div class="section-label">Grass tint</div>
    ${colorSwatchRowHtml(PARK_TINT_COLORS, S.globalParkTint, 'worldparktint')}
    <div class="section-label">Tree tint</div>
    ${colorSwatchRowHtml(TREE_TINT_COLORS, S.globalTreeTint, 'worldtreetint')}
    <div class="section-label">Sand tint</div>
    ${colorSwatchRowHtml(SAND_TINT_COLORS, S.globalSandTint, 'worldsandtint')}
  `;
  wireColorSwatchEvents(panel, PARK_TINT_COLORS, {
    onPick: (hex) => { S.globalParkTint = hex; S.zones.forEach(subdivideZone); renderWorldTintPanel(); },
    onCommit: (hex, mode, oldHex) => {
      if (mode==='edit') {
        if (S.globalParkTint===oldHex) S.globalParkTint = hex;
        S.zones.forEach(z => { if (z.settings && z.settings.parkTint===oldHex) z.settings.parkTint = hex; });
      } else {
        S.globalParkTint = hex;
      }
      S.zones.forEach(subdivideZone);
    },
    onRemove: (oldHex, fallback) => {
      if (S.globalParkTint===oldHex) S.globalParkTint = fallback;
      S.zones.forEach(z => { if (z.settings && z.settings.parkTint===oldHex) z.settings.parkTint = fallback; });
      S.zones.forEach(subdivideZone);
    },
    onPreview: (hex) => { S.globalParkTint = hex; S.zones.forEach(subdivideZone); }
  }, 'worldparktint', renderWorldTintPanel, S.globalParkTint);
  wireColorSwatchEvents(panel, TREE_TINT_COLORS, {
    onPick: (hex) => { S.globalTreeTint = hex; S.zones.forEach(subdivideZone); renderWorldTintPanel(); },
    onCommit: (hex, mode, oldHex) => {
      if (mode==='edit') {
        if (S.globalTreeTint===oldHex) S.globalTreeTint = hex;
        S.zones.forEach(z => { if (z.settings && z.settings.treeTint===oldHex) z.settings.treeTint = hex; });
      } else {
        S.globalTreeTint = hex;
      }
      S.zones.forEach(subdivideZone);
    },
    onRemove: (oldHex, fallback) => {
      if (S.globalTreeTint===oldHex) S.globalTreeTint = fallback;
      S.zones.forEach(z => { if (z.settings && z.settings.treeTint===oldHex) z.settings.treeTint = fallback; });
      S.zones.forEach(subdivideZone);
    },
    onPreview: (hex) => { S.globalTreeTint = hex; S.zones.forEach(subdivideZone); }
  }, 'worldtreetint', renderWorldTintPanel, S.globalTreeTint);
  wireSandTintSwatches(panel, 'worldsandtint', renderWorldTintPanel);
}
function renderDetails() {
  const panel = document.getElementById('details-panel');
  // the Objects tab keeps its own details — the selected object's, which isn't part of S.selection (see objects.js)
  if (S.interactionMode==='node' && S.currentTool==='objects') { App.renderObjectDetails?.(); return; }
  if (S.selection.type==='zone') {
    const zone = S.zones.find(z=>z.id===S.selection.id);
    if (!zone) { panel.innerHTML = '<div class="empty">Select a path or zone from the list to see its settings.</div>'; return; }
    const s = zone.settings;
    const zoneType = zone.zoneType || 'buildings';
    const toggleHtml = (id, label, on) => `<div class="row" style="margin-top:11px;"><label>${label}</label><button class="toggle-switch${on?' on':''}" id="${id}"><span class="knob"></span></button></div>`;
    const seedHtml = `<div class="seed-row"><input type="number" id="ds-seed" value="${s.seed}"><button class="icon-btn" id="d-dice">&#127922;</button></div>`;
    const settingsHtml = zoneType==='water' ? `
      <div class="empty" style="margin:6px 0 10px;">Animated water, sunk below the ground. It joins any river running into it, roads cross it on bridges, and where it meets a park or beach there's a sandy slope down into it.</div>
    ` : zoneType==='beach' ? `
      <div class="empty" style="margin:6px 0 10px;">Sand, darker and wetter toward the water. It slopes gently down into any water beside it, and parks next to it fade from grass into sand.</div>
      <div class="section-label">Sand tint</div>
      ${colorSwatchRowHtml(SAND_TINT_COLORS, S.globalSandTint, 'beachsandtint')}
      <div class="empty" style="margin:6px 0 10px;">Shared by every beach, and by the sand a park fades into and the sand under the shallows &mdash; the same swatch as the World panel's.</div>
    ` : zoneType==='plaza' ? `
      <div class="slider-row"><div class="row"><label>Paving</label></div>
        <select id="ds-paving" class="select-input">
          <option value="tiles" ${s.pavingPattern!=='herringbone'?'selected':''}>Tiles</option>
          <option value="herringbone" ${s.pavingPattern==='herringbone'?'selected':''}>Herringbone</option>
        </select></div>
      <div class="slider-row" style="margin-top:11px;"><div class="row"><label>Paving scale</label><span class="val" id="dv-pavingscale">${(s.pavingScale!=null?s.pavingScale:1).toFixed(2)}</span></div>
        <input type="range" id="ds-pavingscale" min="0.3" max="3" step="0.05" value="${s.pavingScale!=null?s.pavingScale:1}"></div>
      <div class="slider-row" style="margin-top:11px;"><div class="row"><label>Mortar</label><span class="val" id="dv-mortarwidth">${(s.mortarWidth!=null?s.mortarWidth:0.08).toFixed(2)}</span></div>
        <input type="range" id="ds-mortarwidth" min="0.01" max="0.3" step="0.01" value="${s.mortarWidth!=null?s.mortarWidth:0.08}"></div>
      <div class="section-label">Paving color</div>
      ${colorSwatchRowHtml(PLAZA_COLORS, s.pavingColor!=null?s.pavingColor:PLAZA_COLORS[0], 'pavingcolor')}
      ${toggleHtml('ds-fountain', 'Fountain', s.fountain!==false)}
      <div class="slider-row" style="margin-top:11px;"><div class="row"><label>Trees</label><span class="val" id="dv-plazatrees">${(s.plazaTrees!=null?s.plazaTrees:0.35).toFixed(2)}</span></div>
        <input type="range" id="ds-plazatrees" min="0" max="1" step="0.05" value="${s.plazaTrees!=null?s.plazaTrees:0.35}"></div>
      ${seedHtml}
    ` : zoneType==='farmland' ? `
      <div class="slider-row"><div class="row"><label>Fields</label><span class="val" id="dv-fieldcount">${s.fieldCount!=null?s.fieldCount:14}</span></div>
        <input type="range" id="ds-fieldcount" min="1" max="60" step="1" value="${s.fieldCount!=null?s.fieldCount:14}"></div>
      ${toggleHtml('ds-hedgerows', 'Hedgerows', s.hedgerows!==false)}
      ${toggleHtml('ds-farmsteads', 'Farmsteads', s.farmsteads!==false)}
      <div style="margin-top:11px;">${seedHtml}</div>
    ` : zoneType==='suburbs' ? `
      <div class="slider-row"><div class="row"><label>Plots</label><span class="val" id="dv-suburbplots">${s.suburbPlots!=null?s.suburbPlots:40}</span></div>
        <input type="range" id="ds-suburbplots" min="1" max="150" step="1" value="${s.suburbPlots!=null?s.suburbPlots:40}"></div>
      <div class="slider-row"><div class="row"><label>Density</label><span class="val" id="dv-suburbdensity">${(s.suburbDensity!=null?s.suburbDensity:0.9).toFixed(2)}</span></div>
        <input type="range" id="ds-suburbdensity" min="0" max="1" step="0.05" value="${s.suburbDensity!=null?s.suburbDensity:0.9}"></div>
      ${toggleHtml('ds-suburbhedges', 'Hedges', s.suburbHedges!==false)}
      <div class="section-label">Ground color</div>
      ${colorSwatchRowHtml(BUILDING_GROUND_COLORS, s.groundColor!=null?s.groundColor:BUILDING_GROUND_COLORS[0], 'groundcolor')}
      <div class="empty" style="margin:6px 0 10px;">Every house faces the nearest road &mdash; or, with none within reach, the nearest walkway, and failing those the zone's own edge.</div>
      ${seedHtml}
    ` : zoneType==='airport' ? `
      ${zone.airportInfo ? `<div class="row" style="margin-bottom:9px;"><label>Airfield</label><span class="val">${zone.airportInfo.label}</span></div>
      <div class="row" style="margin-bottom:9px;"><label>Runway</label><span class="val">${zone.airportInfo.numbers ? zone.airportInfo.numbers + ' &middot; ' + zone.airportInfo.length + 'm' : '&mdash;'}</span></div>` : ''}
      ${toggleHtml('ds-airportterminal', 'Terminal &amp; hangars', s.airportTerminal!==false)}
      ${toggleHtml('ds-airporttower', 'Control tower', s.airportTower!==false)}
      ${toggleHtml('ds-airportaircraft', 'Aircraft', s.airportAircraft!==false)}
      ${toggleHtml('ds-airportfence', 'Perimeter fence', s.airportFence!==false)}
      <div class="empty" style="margin:6px 0 10px;">The longest runway that fits decides what you get &mdash; a helipad, a grass strip, a regional field or an international one. Roads can't cross a runway, so one drawn through the zone pushes the runway aside or drops it a size. Its number is its real compass heading, and the terminal turns to face the nearest road.</div>
      ${seedHtml}
    ` : zoneType==='industrial' ? `
      <div class="slider-row"><div class="row"><label>Lot count</label><span class="val" id="dv-industriallots">${s.industrialLots!=null?s.industrialLots:10}</span></div>
        <input type="range" id="ds-industriallots" min="1" max="40" step="1" value="${s.industrialLots!=null?s.industrialLots:10}"></div>
      <div class="slider-row"><div class="row"><label>Density</label><span class="val" id="dv-industrialdensity">${(s.industrialDensity!=null?s.industrialDensity:0.85).toFixed(2)}</span></div>
        <input type="range" id="ds-industrialdensity" min="0.1" max="1" step="0.05" value="${s.industrialDensity!=null?s.industrialDensity:0.85}"></div>
      ${rangeSliderHtml('indheight', 'Building height', 3, 40, 1, s.industrialHeightMin!=null?s.industrialHeightMin:5, s.industrialHeightMax!=null?s.industrialHeightMax:14)}
      ${toggleHtml('ds-lotfences', 'Lot fences', s.lotFences!==false)}
      <div class="section-label">Ground color</div>
      ${colorSwatchRowHtml(BUILDING_GROUND_COLORS, s.groundColor!=null?s.groundColor:BUILDING_GROUND_COLORS[0], 'groundcolor')}
      ${seedHtml}
    ` : zoneType==='park' ? `
      <div class="slider-row"><div class="row"><label>Foliage</label><span class="val" id="dv-treedensity">${s.treeDensity.toFixed(2)}</span></div>
        <input type="range" id="ds-treedensity" min="0" max="1" step="0.02" value="${s.treeDensity}"></div>
      ${toggleHtml('ds-fence', 'Fence', s.fence!==false)}
      <div class="row" style="margin-top:11px;"><label>Custom color</label><button class="toggle-switch${s.customTint?' on':''}" id="ds-customtint"><span class="knob"></span></button></div>
      ${s.customTint ? `
        <div class="section-label">Grass tint</div>
        ${colorSwatchRowHtml(PARK_TINT_COLORS, s.parkTint!=null?s.parkTint:PARK_TINT_COLORS[0], 'parktint')}
        <div class="section-label">Tree tint</div>
        ${colorSwatchRowHtml(TREE_TINT_COLORS, s.treeTint!=null?s.treeTint:TREE_TINT_COLORS[0], 'treetint')}
        <div class="slider-row"><div class="row"><label>Grass noise strength</label><span class="val" id="dv-grassnoisezone">${(s.grassNoiseStrength!=null?s.grassNoiseStrength:DEFAULT_GRASS_NOISE_STRENGTH).toFixed(2)}</span></div>
          <input type="range" id="ds-grassnoisezone" min="0" max="2.5" step="0.05" value="${s.grassNoiseStrength!=null?s.grassNoiseStrength:DEFAULT_GRASS_NOISE_STRENGTH}"></div>
      ` : ''}
      ${rangeSliderHtml('treesize', 'Tree size', 0.4, 5, 0.1, s.treeSizeMin, s.treeSizeMax, 1)}
      <div class="slider-row"><div class="row"><label>Border setback</label><span class="val" id="dv-treesetback">${s.treeSetback}</span></div>
        <input type="range" id="ds-treesetback" min="0" max="15" step="0.5" value="${s.treeSetback}"></div>
      <div class="seed-row"><input type="number" id="ds-seed" value="${s.seed}"><button class="icon-btn" id="d-dice">&#127922;</button></div>
    ` : zoneType==='plain' ? `
      <div class="section-label">Ground color</div>
      ${colorSwatchRowHtml(BUILDING_GROUND_COLORS, s.groundColor!=null?s.groundColor:BUILDING_GROUND_COLORS[0], 'groundcolor')}
    ` : `
      <div class="slider-row"><div class="row"><label>Density</label><span class="val" id="dv-density">${s.density.toFixed(2)}</span></div>
        <input type="range" id="ds-density" min="0.1" max="1" step="0.02" value="${s.density}"></div>
      ${rangeSliderHtml('height', 'Height range', 1, 180, 1, s.heightMin, s.heightMax)}
      <div class="slider-row"><div class="row"><label>Landmark chance</label><span class="val" id="dv-landmark">${s.landmarkChance.toFixed(2)}</span></div>
        <input type="range" id="ds-landmark" min="0" max="0.3" step="0.01" value="${s.landmarkChance}"></div>
      <div class="slider-row"><div class="row"><label>Lot count</label><span class="val" id="dv-minlot">${s.lotCount<=1?'Whole zone':s.lotCount}</span></div>
        <input type="range" id="ds-minlot" min="1" max="${MAX_TARGET_LOTS}" step="1" value="${s.lotCount}"></div>
      <div class="slider-row"><div class="row"><label>Lot setback</label><span class="val" id="dv-setback">${s.setback}</span></div>
        <input type="range" id="ds-setback" min="0" max="6" step="0.25" value="${s.setback}"></div>
      <div class="slider-row"><div class="row"><label>Border setback</label><span class="val" id="dv-bordersetback">${s.borderSetback}</span></div>
        <input type="range" id="ds-bordersetback" min="0" max="30" step="0.5" value="${s.borderSetback}"></div>
      <div class="section-label">Ground color</div>
      ${colorSwatchRowHtml(BUILDING_GROUND_COLORS, s.groundColor!=null?s.groundColor:BUILDING_GROUND_COLORS[0], 'groundcolor')}
      <div class="row"><label>Windows</label><button class="toggle-switch${s.windowsEnabled?' on':''}" id="ds-windows"><span class="knob"></span></button></div>
      ${s.windowsEnabled ? `
      <div class="slider-row" style="margin-top:11px;"><div class="row"><label>Window scale</label><span class="val" id="dv-windowscale">${(s.windowScale!=null?s.windowScale:1).toFixed(1)}</span></div>
        <input type="range" id="ds-windowscale" min="0.3" max="3" step="0.1" value="${s.windowScale!=null?s.windowScale:1}"></div>
      <div class="slider-row"><div class="row"><label>Lit windows</label><span class="val" id="dv-litwindowchance">${(s.litWindowChance!=null?s.litWindowChance:0.8).toFixed(2)}</span></div>
        <input type="range" id="ds-litwindowchance" min="0" max="1" step="0.02" value="${s.litWindowChance!=null?s.litWindowChance:0.8}"></div>
      <div class="row" style="margin-top:11px;"><label>Specular windows</label><button class="toggle-switch${s.specularWindows?' on':''}" id="ds-specularwindows"><span class="knob"></span></button></div>
      ` : ''}
      <div style="margin-top:11px;">${rangeSliderHtml('colorvar', 'Color variation', 0, 1, 0.02, s.colorVariationMin!=null?s.colorVariationMin:0.25, s.colorVariationMax!=null?s.colorVariationMax:0.25, 2)}</div>
      <div class="seed-row"><input type="number" id="ds-seed" value="${s.seed}"><button class="icon-btn" id="d-dice">&#127922;</button></div>
    `;
    panel.innerHTML = `
      <div class="title-row"><span class="name">${zone.name}</span><button class="close-x" id="d-close">deselect</button></div>
      ${App.zoneTypeCarouselHtml(zoneType)}
      ${settingsHtml}
      <button class="btn danger" id="d-delete">Delete zone</button>
    `;
    App.wireZoneTypeCarousel(panel, (type) => {
      if (type === zoneType) return;
      zone.zoneType = type;
      subdivideZonesFrom(zone); // a new type can change the shorelines and beaches of the zones around it
      renderDetails();
    });
    // an on/off setting (unset counts as on)
    const wireToggle = (id, key) => document.getElementById(id).addEventListener('click', () => { s[key] = s[key]===false; subdivideZone(zone); renderDetails(); });
    const wireNumber = (sliderId, valId, key, decimals) => document.getElementById(sliderId).addEventListener('input', (e) => {
      s[key] = parseFloat(e.target.value);
      document.getElementById(valId).textContent = decimals!=null ? s[key].toFixed(decimals) : s[key];
      subdivideZone(zone);
    });
    const wireSwatches = (palette, key, swatchKey, fallback) => wireColorSwatchEvents(panel, palette, {
      onPick: (hex) => { s[key] = hex; subdivideZone(zone); renderDetails(); },
      onCommit: (hex, mode, oldHex) => {
        if (mode==='edit') S.zones.forEach(z => { if (z.settings && z.settings[key]===oldHex) { z.settings[key]=hex; subdivideZone(z); } });
        else { s[key] = hex; subdivideZone(zone); }
      },
      onRemove: (oldHex, replacement) => { S.zones.forEach(z => { if (z.settings && z.settings[key]===oldHex) { z.settings[key]=replacement; subdivideZone(z); } }); },
      onPreview: (hex) => { s[key] = hex; subdivideZone(zone); }
    }, swatchKey, renderDetails, s[key]!=null ? s[key] : fallback);
    if (zoneType==='water') {
      // water has no settings of its own
    } else if (zoneType==='beach') {
      // the beach's only control is the shared sand tint, which also lives in the World panel; keep
      // that one in step in case both are on screen
      wireSandTintSwatches(panel, 'beachsandtint', () => { renderDetails(); renderWorldTintPanel(); });
    } else if (zoneType==='plaza') {
      document.getElementById('ds-paving').addEventListener('change', (e) => { s.pavingPattern = e.target.value; subdivideZone(zone); });
      wireNumber('ds-pavingscale', 'dv-pavingscale', 'pavingScale', 2);
      wireNumber('ds-mortarwidth', 'dv-mortarwidth', 'mortarWidth', 2);
      wireSwatches(PLAZA_COLORS, 'pavingColor', 'pavingcolor', PLAZA_COLORS[0]);
      wireToggle('ds-fountain', 'fountain');
      wireNumber('ds-plazatrees', 'dv-plazatrees', 'plazaTrees', 2);
    } else if (zoneType==='farmland') {
      wireNumber('ds-fieldcount', 'dv-fieldcount', 'fieldCount');
      wireToggle('ds-hedgerows', 'hedgerows');
      wireToggle('ds-farmsteads', 'farmsteads');
    } else if (zoneType==='suburbs') {
      wireNumber('ds-suburbplots', 'dv-suburbplots', 'suburbPlots');
      wireNumber('ds-suburbdensity', 'dv-suburbdensity', 'suburbDensity', 2);
      wireToggle('ds-suburbhedges', 'suburbHedges');
      wireSwatches(BUILDING_GROUND_COLORS, 'groundColor', 'groundcolor', BUILDING_GROUND_COLORS[0]);
    } else if (zoneType==='airport') {
      wireToggle('ds-airportterminal', 'airportTerminal');
      wireToggle('ds-airporttower', 'airportTower');
      wireToggle('ds-airportaircraft', 'airportAircraft');
      wireToggle('ds-airportfence', 'airportFence');
    } else if (zoneType==='industrial') {
      wireNumber('ds-industriallots', 'dv-industriallots', 'industrialLots');
      wireNumber('ds-industrialdensity', 'dv-industrialdensity', 'industrialDensity', 2);
      wireRangeSlider('indheight', 3, 40, null, (lo, hi) => { s.industrialHeightMin = lo; s.industrialHeightMax = hi; subdivideZone(zone); });
      wireToggle('ds-lotfences', 'lotFences');
      wireSwatches(BUILDING_GROUND_COLORS, 'groundColor', 'groundcolor', BUILDING_GROUND_COLORS[0]);
    } else if (zoneType==='park') {
      wireToggle('ds-fence', 'fence');
      const bindP = (sliderId,valId,key,decimals) => {
        document.getElementById(sliderId).addEventListener('input', (e)=>{
          const v = parseFloat(e.target.value);
          s[key]=v;
          document.getElementById(valId).textContent = decimals!=null ? v.toFixed(decimals) : v;
          subdivideZone(zone);
        });
      };
      bindP('ds-treedensity','dv-treedensity','treeDensity',2);
      wireRangeSlider('treesize', 0.4, 5, 1, (lo,hi) => { s.treeSizeMin=lo; s.treeSizeMax=hi; subdivideZone(zone); });
      bindP('ds-treesetback','dv-treesetback','treeSetback');
      if (s.customTint) bindP('ds-grassnoisezone','dv-grassnoisezone','grassNoiseStrength',2);
      document.getElementById('ds-customtint').addEventListener('click', ()=>{
        s.customTint = !s.customTint;
        subdivideZone(zone);
        renderDetails();
      });
      wireColorSwatchEvents(panel, PARK_TINT_COLORS, {
        onPick: (hex) => { s.parkTint = hex; subdivideZone(zone); renderDetails(); },
        onCommit: (hex, mode, oldHex) => {
          if (mode==='edit') {
            S.zones.forEach(z => { if (z.settings && z.settings.parkTint===oldHex) { z.settings.parkTint=hex; subdivideZone(z); } });
          } else {
            s.parkTint = hex;
            subdivideZone(zone);
          }
        },
        onRemove: (oldHex, fallback) => {
          S.zones.forEach(z => { if (z.settings && z.settings.parkTint===oldHex) { z.settings.parkTint=fallback; subdivideZone(z); } });
        },
        onPreview: (hex) => { s.parkTint = hex; subdivideZone(zone); }
      }, 'parktint', renderDetails, s.parkTint!=null?s.parkTint:PARK_TINT_COLORS[0]);
      wireColorSwatchEvents(panel, TREE_TINT_COLORS, {
        onPick: (hex) => { s.treeTint = hex; subdivideZone(zone); renderDetails(); },
        onCommit: (hex, mode, oldHex) => {
          if (mode==='edit') {
            S.zones.forEach(z => { if (z.settings && z.settings.treeTint===oldHex) { z.settings.treeTint=hex; subdivideZone(z); } });
          } else {
            s.treeTint = hex;
            subdivideZone(zone);
          }
        },
        onRemove: (oldHex, fallback) => {
          S.zones.forEach(z => { if (z.settings && z.settings.treeTint===oldHex) { z.settings.treeTint=fallback; subdivideZone(z); } });
        },
        onPreview: (hex) => { s.treeTint = hex; subdivideZone(zone); }
      }, 'treetint', renderDetails, s.treeTint!=null?s.treeTint:TREE_TINT_COLORS[0]);
    } else if (zoneType==='plain') {
      wireColorSwatchEvents(panel, BUILDING_GROUND_COLORS, {
        onPick: (hex) => { s.groundColor = hex; subdivideZone(zone); renderDetails(); },
        onCommit: (hex, mode, oldHex) => {
          if (mode==='edit') {
            S.zones.forEach(z => { if (z.settings && z.settings.groundColor===oldHex) { z.settings.groundColor=hex; subdivideZone(z); } });
          } else {
            s.groundColor = hex;
            subdivideZone(zone);
          }
        },
        onRemove: (oldHex, fallback) => {
          S.zones.forEach(z => { if (z.settings && z.settings.groundColor===oldHex) { z.settings.groundColor=fallback; subdivideZone(z); } });
        },
        onPreview: (hex) => { s.groundColor = hex; subdivideZone(zone); }
      }, 'groundcolor', renderDetails, s.groundColor!=null?s.groundColor:BUILDING_GROUND_COLORS[0]);
    } else {
      const bind = (sliderId,valId,key,decimals) => {
        document.getElementById(sliderId).addEventListener('input', (e)=>{
          const v = parseFloat(e.target.value);
          s[key]=v;
          document.getElementById(valId).textContent = decimals!=null ? v.toFixed(decimals) : v;
          subdivideZone(zone);
        });
      };
      bind('ds-density','dv-density','density',2);
      wireRangeSlider('height', 1, 180, null, (lo,hi) => { s.heightMin=lo; s.heightMax=hi; subdivideZone(zone); });
      bind('ds-landmark','dv-landmark','landmarkChance',2);
      document.getElementById('ds-minlot').addEventListener('input', (e) => {
        s.lotCount = parseFloat(e.target.value);
        document.getElementById('dv-minlot').textContent = s.lotCount<=1 ? 'Whole zone' : s.lotCount;
        subdivideZone(zone);
      });
      bind('ds-setback','dv-setback','setback');
      bind('ds-bordersetback','dv-bordersetback','borderSetback');
      wireRangeSlider('colorvar', 0, 1, 2, (lo,hi) => { s.colorVariationMin=lo; s.colorVariationMax=hi; subdivideZone(zone); });
      if (s.windowsEnabled) {
        bind('ds-windowscale','dv-windowscale','windowScale',1);
        bind('ds-litwindowchance','dv-litwindowchance','litWindowChance',2);
        document.getElementById('ds-specularwindows').addEventListener('click', ()=>{
          s.specularWindows = !s.specularWindows;
          subdivideZone(zone);
          renderDetails();
        });
      }
      wireColorSwatchEvents(panel, BUILDING_GROUND_COLORS, {
        onPick: (hex) => { s.groundColor = hex; subdivideZone(zone); renderDetails(); },
        onCommit: (hex, mode, oldHex) => {
          if (mode==='edit') {
            S.zones.forEach(z => { if (z.settings && z.settings.groundColor===oldHex) { z.settings.groundColor=hex; subdivideZone(z); } });
          } else {
            s.groundColor = hex;
            subdivideZone(zone);
          }
        },
        onRemove: (oldHex, fallback) => {
          S.zones.forEach(z => { if (z.settings && z.settings.groundColor===oldHex) { z.settings.groundColor=fallback; subdivideZone(z); } });
        },
        onPreview: (hex) => { s.groundColor = hex; subdivideZone(zone); }
      }, 'groundcolor', renderDetails, s.groundColor!=null?s.groundColor:BUILDING_GROUND_COLORS[0]);
      document.getElementById('ds-windows').addEventListener('click', ()=>{
        s.windowsEnabled = !s.windowsEnabled;
        subdivideZone(zone);
        renderDetails();
      });
    }
    const seedInput = document.getElementById('ds-seed');
    if (seedInput) {
      seedInput.addEventListener('change', (e)=>{ s.seed=parseInt(e.target.value,10)||0; subdivideZone(zone); });
      document.getElementById('d-dice').addEventListener('click', ()=>{ s.seed=Math.floor(Math.random()*1000000); document.getElementById('ds-seed').value=s.seed; subdivideZone(zone); });
    }
    document.getElementById('d-delete').addEventListener('click', ()=> removeZone(zone.id));
    document.getElementById('d-close').addEventListener('click', deselect);
  } else if (S.selection.type==='road') {
    const netId = S.selection.id;
    const lines = S.roadLines.filter(l=>l.networkId===netId);
    if (!lines.length) { panel.innerHTML = '<div class="empty">Select a path or zone from the list to see its settings.</div>'; return; }
    const totalNodes = lines.reduce((sum,l)=>sum+l.nodeIds.length, 0);
    const curColor = lines[0].color!=null ? lines[0].color : ROAD_COLOR;
    const curSidewalkColor = lines[0].sidewalkColor!=null ? lines[0].sidewalkColor : SIDEWALK_COLOR;
    const title = lines.length>1 ? netId : lines[0].id;
    const subtitle = lines.length>1 ? `${lines.length} branches · ${totalNodes} nodes` : `${totalNodes} nodes`;
    const isWalkway = isWalkwayLine(lines[0]), isRiver = isRiverLine(lines[0]);
    const curWalkwayColor = lines[0].walkwayColor!=null ? lines[0].walkwayColor : WALKWAY_COLOR;
    const curWalkwayTexture = lines[0].walkwayTexture || WALKWAY_TEXTURE;
    const curTextureScale = walkwayTextureScaleOf(lines[0]), curTextureRotation = lines[0].walkwayTextureRotation ?? 0;
    panel.innerHTML = `
      <div class="title-row"><span class="name">${title}</span><button class="close-x" id="d-close">deselect</button></div>
      <div class="empty" style="margin-bottom:10px;">${subtitle}</div>
      <div class="slider-row"><div class="row"><label>Path type</label></div>
        <select id="ds-roadtype" class="select-input">
          <option value="sidewalk" ${!isWalkway&&!isRiver?'selected':''}>Sidewalk</option>
          <option value="walkway" ${isWalkway?'selected':''}>Walkway</option>
          <option value="river" ${isRiver?'selected':''}>River</option>
        </select>
      </div>
      ${isRiver ? `
      <div class="empty" style="margin:6px 0 10px;">Water, as wide as the path's width. It joins any water zone it runs into, and roads and paths cross it on bridges.</div>
      ` : isWalkway ? `
      ${App.walkwayTextureCarouselHtml(curWalkwayTexture, curWalkwayColor)}
      ${curWalkwayTexture!=='plain' ? `
      <div class="slider-row"><div class="row"><label>Texture scale</label><span class="val" id="dv-walkwayscale">${curTextureScale.toFixed(2)}</span></div>
        <input type="range" id="ds-walkwayscale" min="0.25" max="4" step="0.05" value="${curTextureScale}"></div>
      ` : ''}
      ${curWalkwayTexture!=='plain' && curWalkwayTexture!=='dirt' ? `
      <div class="slider-row"><div class="row"><label>Texture rotation</label><span class="val" id="dv-walkwayrotation">${curTextureRotation}°</span></div>
        <input type="range" id="ds-walkwayrotation" min="0" max="180" step="1" value="${curTextureRotation}"></div>
      ` : ''}
      <div class="section-label">Walkway color</div>
      ${colorSwatchRowHtml(WALKWAY_COLOR_PALETTE, curWalkwayColor, 'walkwaycolor')}
      ` : `
      <div class="section-label">Color</div>
      ${colorSwatchRowHtml(ROAD_COLOR_PALETTE, curColor, 'roadcolor')}
      <div class="section-label">Sidewalk color</div>
      ${colorSwatchRowHtml(SIDEWALK_COLOR_PALETTE, curSidewalkColor, 'sidewalkcolor')}
      `}
      <button class="btn danger" id="d-delete">Delete path${lines.length>1?' network':''}</button>
    `;
    document.getElementById('ds-roadtype').addEventListener('change', (e) => {
      lines.forEach(l => { l.roadType = e.target.value; });
      S.newRoadType = e.target.value;
      App.applyModeVisibility();
      rebuildRoadMeshes(); S.zones.forEach(subdivideZone); renderDetails();
    });
    // walkways get their texture and color; sidewalk roads get road and sidewalk colors
    if (isWalkway) {
      App.wireWalkwayTextureCarousel(panel, curWalkwayColor, (texture) => {
        if (texture === curWalkwayTexture) return;
        // a scale still sitting on the old texture's default follows along to the new one's, so
        // picking Dirt gives you dirt at the size it's meant to be; a scale someone actually set is theirs
        lines.forEach(l => {
          if (l.walkwayTextureScale === defaultWalkwayTextureScale(l.walkwayTexture || WALKWAY_TEXTURE)) l.walkwayTextureScale = undefined;
          l.walkwayTexture = texture;
        });
        if (walkwayTextureChangeNeedsRebuild(curWalkwayTexture, texture)) rebuildRoadMeshes(); else refreshRoadAppearance(netId);
        renderDetails();
      });
      const wireTextureSlider = (id, key, format) => document.getElementById('ds-'+id).addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        lines.forEach(l => { l[key] = v; });
        document.getElementById('dv-'+id).textContent = format(v);
        refreshRoadAppearance(netId);
      });
      if (curWalkwayTexture!=='plain') wireTextureSlider('walkwayscale', 'walkwayTextureScale', v => v.toFixed(2));
      if (curWalkwayTexture!=='plain' && curWalkwayTexture!=='dirt') wireTextureSlider('walkwayrotation', 'walkwayTextureRotation', v => v+'°');
      wireColorSwatchEvents(panel, WALKWAY_COLOR_PALETTE, {
        onPick: (hex) => { lines.forEach(l => { l.walkwayColor = hex; }); refreshRoadAppearance(netId); renderDetails(); },
        onCommit: (hex, mode, oldHex) => {
          if (mode==='edit') {
            S.roadLines.forEach(l => { if (isWalkwayLine(l) && (l.walkwayColor!=null?l.walkwayColor:WALKWAY_COLOR)===oldHex) l.walkwayColor = hex; });
          } else {
            lines.forEach(l => { l.walkwayColor = hex; });
          }
          refreshRoadAppearance();
        },
        onRemove: (oldHex, fallback) => {
          S.roadLines.forEach(l => { if (isWalkwayLine(l) && (l.walkwayColor!=null?l.walkwayColor:WALKWAY_COLOR)===oldHex) l.walkwayColor = fallback; });
          refreshRoadAppearance();
        },
        onPreview: (hex) => { lines.forEach(l => { l.walkwayColor = hex; }); refreshRoadAppearance(netId); }
      }, 'walkwaycolor', renderDetails, curWalkwayColor);
    }
    if (!isWalkway && !isRiver) {
    wireColorSwatchEvents(panel, ROAD_COLOR_PALETTE, {
      onPick: (hex) => { lines.forEach(l => { l.color = hex; }); refreshRoadAppearance(netId); renderDetails(); },
      onCommit: (hex, mode, oldHex) => {
        if (mode==='edit') {
          S.roadLines.forEach(l => { if ((l.color!=null?l.color:ROAD_COLOR)===oldHex) l.color = hex; });
        } else {
          lines.forEach(l => { l.color = hex; });
        }
        refreshRoadAppearance();
      },
      onRemove: (oldHex, fallback) => {
        S.roadLines.forEach(l => { if ((l.color!=null?l.color:ROAD_COLOR)===oldHex) l.color = fallback; });
        refreshRoadAppearance();
      },
      onPreview: (hex) => { lines.forEach(l => { l.color = hex; }); refreshRoadAppearance(netId); }
    }, 'roadcolor', renderDetails, curColor);
    wireColorSwatchEvents(panel, SIDEWALK_COLOR_PALETTE, {
      onPick: (hex) => { lines.forEach(l => { l.sidewalkColor = hex; }); refreshRoadAppearance(netId); renderDetails(); },
      onCommit: (hex, mode, oldHex) => {
        if (mode==='edit') {
          S.roadLines.forEach(l => { if ((l.sidewalkColor!=null?l.sidewalkColor:SIDEWALK_COLOR)===oldHex) l.sidewalkColor = hex; });
        } else {
          lines.forEach(l => { l.sidewalkColor = hex; });
        }
        refreshRoadAppearance();
      },
      onRemove: (oldHex, fallback) => {
        S.roadLines.forEach(l => { if ((l.sidewalkColor!=null?l.sidewalkColor:SIDEWALK_COLOR)===oldHex) l.sidewalkColor = fallback; });
        refreshRoadAppearance();
      },
      onPreview: (hex) => { lines.forEach(l => { l.sidewalkColor = hex; }); refreshRoadAppearance(netId); }
    }, 'sidewalkcolor', renderDetails, curSidewalkColor);
    }
    document.getElementById('d-delete').addEventListener('click', ()=> removeRoadNetwork(netId));
    document.getElementById('d-close').addEventListener('click', deselect);
  } else if (S.selection.type==='train') {
    const netId = S.selection.id;
    const lines = S.roadLines.filter(l=>l.networkId===netId);
    if (!lines.length) { panel.innerHTML = '<div class="empty">Select a path or zone from the list to see its settings.</div>'; return; }
    const nodeIds = new Set(lines.flatMap(l => l.nodeIds));
    const stations = [...nodeIds].filter(id => roadNodes[id] && roadNodes[id].type==='station').length;
    const title = lines.length>1 ? netId : lines[0].id;
    panel.innerHTML = `
      <div class="title-row"><span class="name">${title}</span><button class="close-x" id="d-close">deselect</button></div>
      <div class="empty" style="margin-bottom:10px;">${nodeIds.size} nodes · ${stations} station${stations===1?'':'s'}</div>
      <button class="btn danger" id="d-delete">Delete train line${lines.length>1?'s':''}</button>
    `;
    document.getElementById('d-delete').addEventListener('click', ()=> removeRoadNetwork(netId));
    document.getElementById('d-close').addEventListener('click', deselect);
  } else {
    panel.innerHTML = '<div class="empty">Select a path or zone from the list to see its settings.</div>';
  }
}

export function updateStats() {
  App.refreshMorality?.(); // (the meter at the top right, see morality.js)
}

Object.assign(App, { renderHierarchy, updateStats });
