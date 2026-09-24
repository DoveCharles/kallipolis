import { S, App } from '../core/shared.js';
import { scene, updateSun, groundMat, setGridColor } from '../core/scene.js';
import { roadNodes, mapImages } from '../core/state.js';
import { importMapImageFile, setSelectedMap, removeMapImage, previewLine } from '../maps/map-images.js';
import { disposeObject } from '../roads/roads.js';
import { rebuildRoadMeshes } from '../roads/paths.js';
import { networkKindOf, pathTypeOf, currentPathType, rebuildTrainMeshes, rebuildRoadMarkers, rebuildRoadHandles, cleanupOrphanRoadNodes } from '../trains/trains.js';
import { setHover, insertPreviewMarker } from './hover.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { subdivideZone, subdivideZonesFrom } from '../zones/cutouts.js';
import { refreshHighlights, styleZoneVisual } from '../water/bridges.js';
import { disarmObject, invalidateObjectFacing, objectsHint, showObjectUi } from '../objects/objects.js';
import { selectItem, renderHierarchy } from '../ui/panels.js';
import { IS_TOUCH } from '../core/device.js';

// ============================================================ tool switching / drawing lifecycle
export function cancelActiveDrawing() {
  S.lastGroundClick = null;
  S.lastNodeClick = null;
  disarmObject(); // whatever the Objects palette had armed (see objects.js)
  App.cancelObjectTransform(); // and a prop left following the cursor under g/r/s goes back where it was
  if (S.activeRoadLine) {
    S.roadLines = S.roadLines.filter(l=>l.id!==S.activeRoadLine.id);
    cleanupOrphanRoadNodes();
    S.activeRoadLine=null;
    rebuildRoadMeshes();
    S.zones.forEach(subdivideZone);
  }
  if (S.activeZone) {
    S.zones = S.zones.filter(z=>z.id!==S.activeZone.id);
    if (S.activeZone.outlineGroup) { scene.remove(S.activeZone.outlineGroup); disposeObject(S.activeZone.outlineGroup); }
    S.activeZone=null;
    renderHierarchy();
  }
  previewLine.visible=false;
}
export function closeActiveZone() {
  S.activeZone.closed=true; S.activeZone.drawing=false;
  const finished=S.activeZone; S.activeZone=null;
  subdivideZonesFrom(finished);
  previewLine.visible=false;
  selectItem('zone', finished.id, true);
}
export function finishActiveDrawing() {
  S.lastGroundClick = null;
  App.confirmObjectTransform(); // Enter leaves a prop being moved, turned or resized under g/r/s where it stands
  if (S.activeRoadLine) {
    if (S.activeRoadLine.nodeIds.length<2) { cancelActiveDrawing(); return; }
    const finishedLine = S.activeRoadLine;
    finishedLine.drawing=false;
    S.activeRoadLine=null;
    rebuildRoadMeshes();
    previewLine.visible=false;
    selectItem(networkKindOf(finishedLine), finishedLine.networkId, true);
  }
  if (S.activeZone) {
    if (S.activeZone.points.length<3) return;
    closeActiveZone();
  }
}
// There's no mouse button, no modifier and no Esc under a finger, so touch is told about the gestures that do those jobs
// instead: two fingers to pan and pinch, a long press for the right button, and ✛ along the top for shift (src/ui/mobile.js).
function updateHint() {
  let msg;
  if (S.interactionMode==='move' && App.possessionHint) {
    // taking control of someone or something (life/possession.js): how to let go, and the controls — with <kbd> in it
    const hint = document.getElementById('hint');
    hint.innerHTML = App.possessionHint;
    hint.dataset.kind = 'general';
    return;
  }
  if (S.interactionMode==='move') {
    msg = IS_TOUCH
      ? 'Drag to orbit · two fingers to pan · pinch to zoom · tap a person to follow them'
      : 'Left-drag to orbit · shift+left-drag to pan · scroll to zoom · 1/3/7 for view snaps · click a person to follow them';
  } else if (S.interactionMode==='maps') {
    if (S.mapTransform) {
      const label = S.mapTransform.mode==='translate' ? 'Move' : S.mapTransform.mode==='rotate' ? 'Rotate' : 'Scale';
      const snapHint = S.mapTransform.mode==='rotate' ? ' · hold shift to snap to 90°' : '';
      msg = IS_TOUCH ? label+' — drag the image, and let go when it looks right'
                     : label+' — click or Enter to confirm · Esc or right-click to cancel'+snapHint;
    } else {
      msg = IS_TOUCH
        ? 'Tap an image to select it · Move, Rotate and Scale are under the Images list · drag empty ground to orbit'
        : 'Click an image to select it · G move · R rotate · S scale · empty-ground drag orbits';
    }
  } else if (IS_TOUCH) {
    const hints = {
      train: "Tap to place nodes at the line's height · drag a node to move it in 3D (top view moves it level) · double-tap a node to delete it · double-tap to finish · press and hold a node to make it a station · ✛ then tap a line to insert a node, or a node to branch from it · press and hold empty ground to cancel",
      road: 'Tap ground to place nodes · tap a node to select its path · double-tap a node to delete it · drag to move · drag empty ground to orbit · double-tap ground to finish · ✛ then tap a path to insert a node, or a node to branch from it · press and hold to cancel',
      zone: 'Tap ground for boundary points · tap a point to select its zone · double-tap a point to delete it · drag to move · drag empty ground to orbit · double-tap ground, or tap the first point, to close · ✛ then tap an edge to insert a point · press and hold to cancel',
      objects: objectsHint(true)
    };
    msg = hints[S.currentTool];
  } else {
    const hints = {
      train: "Click to place nodes at the line's height · drag a node to move it in 3D (top view, key 7, moves it level) · alt+drag changes only its height · right-click a node to make it a station · double-click a node to delete it · double-click or Enter finishes · cmd+click a line to insert a node · cmd+click a node to branch from it · Esc cancels",
      road:'Click ground to place nodes · click a node to select its path · double-click a node to delete it · drag to move · empty-ground drag orbits · double-click ground or Enter finishes · cmd+click a path to insert a node · cmd+click a node to branch from it · Esc cancels',
      zone: 'Click ground for boundary points · click a point to select its zone · double-click a point to delete it · drag to move · empty-ground drag orbits · double-click ground, click first point, or Enter (3+ points) to close · cmd+click an edge to insert a point · Esc cancels',
      objects: objectsHint(false)
    };
    msg = hints[S.currentTool];
  }
  const hint = document.getElementById('hint');
  hint.textContent = msg;
  hint.dataset.kind = S.interactionMode==='move' ? 'general' : 'edit'; // (which View menu toggle hides it: ui/view-prefs.js)
}
// Edit mode's tabs: Paths (roads, paths and rivers — the 'road' tool — and train lines, the 'train' tool, which its type
// carousel switches between; each type lists only its own networks and shows only its own nodes), Zones, and Objects (street furniture, see objects/objects.js)
export function applyModeVisibility() {
  App.hideContextMenu();
  const inNode = S.interactionMode==='node', inPaths = S.currentTool==='road' || S.currentTool==='train', inObjects = S.currentTool==='objects';
  if (inPaths) S.lastPathTool = S.currentTool;
  // each tab shows (and lets you pick) only its own nodes — though zones' outlines stay on show in the Paths tab
  S.roadMarkerGroup.visible = inNode && inPaths;
  S.roadHandleGroup.visible = inNode && inPaths;
  S.zones.forEach(z => {
    if (z.outlineGroup) z.outlineGroup.visible = inNode && !inObjects;
    if (z.markerGroup) z.markerGroup.visible = inNode && S.currentTool==='zone';
  });
  document.getElementById('section-paths').style.display = (inNode && inPaths) ? 'block' : 'none';
  document.getElementById('path-road-settings').style.display = S.currentTool==='road' ? 'block' : 'none';
  document.getElementById('path-train-settings').style.display = S.currentTool==='train' ? 'block' : 'none';
  if (inNode && inPaths) syncPathTypeCarousel();
  document.getElementById('section-zone').style.display = (inNode && S.currentTool==='zone') ? 'block' : 'none';
  document.getElementById('section-objects').style.display = (inNode && inObjects) ? 'block' : 'none';
  document.getElementById('entity-toolbar').style.display = inNode ? 'flex' : 'none';
  document.getElementById('details-panel').style.display = inNode ? 'block' : 'none'; // in the Objects tab it's the selected object's (see objects.js)
  showObjectUi(inNode && inObjects);
  if (inNode && inObjects) invalidateObjectFacing(); // roads and zones can't change from in here, so what's near is worked out once on the way in
  document.getElementById('section-move').style.display = S.interactionMode==='move' ? 'block' : 'none';
  document.getElementById('section-maps').style.display = S.interactionMode==='maps' ? 'block' : 'none';
  document.querySelectorAll('#mode-toolbar .tool-btn').forEach(b => b.classList.toggle('active', b.dataset.mode===S.interactionMode));
  document.querySelectorAll('#entity-toolbar .tool-btn').forEach(b => b.classList.toggle('active', b.dataset.entity===(inPaths ? 'paths' : S.currentTool)));
  updateHint();
}
function setMode(mode) {
  S.lastGroundClick = null;
  cancelActiveDrawing();
  setHover(null);
  if (S.hoveredRoadLineId!=null) { S.hoveredRoadLineId=null; refreshHighlights(); }
  if (S.hoveredZoneId!=null) { const z=S.zones.find(z=>z.id===S.hoveredZoneId); S.hoveredZoneId=null; if (z) styleZoneVisual(z); }
  insertPreviewMarker.visible = false;
  if (mode==='move' && S.selection.type) {
    S.selection = { type:null, id:null };
    refreshHighlights();
    S.zones.forEach(rebuildZoneVisual);
  }
  if (mode!=='maps') { S.hoveredMapId = null; setSelectedMap(null); }
  S.interactionMode = mode;
  applyModeVisibility();
  renderHierarchy();
}
function setEntityTab(tab) {
  S.lastGroundClick = null;
  cancelActiveDrawing();
  setHover(null);
  insertPreviewMarker.visible = false;
  S.currentTool = tab;
  // what was selected in the tab left behind goes with it, or its settings stay in the details under the new one
  if (S.selection.type && S.selection.type!==tab) {
    S.selection = { type:null, id:null };
    refreshHighlights();
    S.zones.forEach(rebuildZoneVisual);
  }
  rebuildRoadMarkers(); rebuildRoadHandles(); // each tab only shows its own kind of node
  applyModeVisibility();
  renderHierarchy();
}
document.querySelectorAll('#mode-toolbar .tool-btn').forEach(b => b.addEventListener('click', ()=> setMode(b.dataset.mode)));
document.querySelectorAll('#entity-toolbar .tool-btn').forEach(b => b.addEventListener('click', ()=> setEntityTab(b.dataset.entity==='paths' ? S.lastPathTool : b.dataset.entity)));
// The Paths tab's type: what new paths are drawn as (sidewalk, walkway, raised walkway or river with the road tool, a train
// line with the train tool), and the only networks it lists and nodes it shows. The carousel is made the first time the
// tab is shown, and after that only has its card moved.
let pathTypeCarousel = null;
function syncPathTypeCarousel() {
  const type = currentPathType();
  if (!pathTypeCarousel) {
    pathTypeCarousel = document.getElementById('path-type-carousel');
    pathTypeCarousel.innerHTML = App.pathTypeCarouselHtml(type);
    App.wirePathTypeCarousel(pathTypeCarousel, pickPathType);
  } else App.syncPathTypeCarousel(pathTypeCarousel, type);
}
function pickPathType(type) {
  if (type===currentPathType()) return;
  if (type!=='train') S.newRoadType = type;
  // a selected network of another type goes, as it's no longer in the list
  const selected = (S.selection.type==='road' || S.selection.type==='train') && S.roadLines.find(l => l.networkId===S.selection.id);
  if (selected && pathTypeOf(selected)!==type) {
    S.selection = { type:null, id:null };
    refreshHighlights();
  }
  const tool = type==='train' ? 'train' : 'road';
  if (tool!==S.currentTool) { setEntityTab(tool); return; }
  cancelActiveDrawing();
  rebuildRoadMarkers(); rebuildRoadHandles(); // only the new type's nodes
  applyModeVisibility();
  renderHierarchy();
}

document.getElementById('s-roadwidth').addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  document.getElementById('v-roadwidth').textContent = v;
  if (S.selection.type==='road') {
    const lines = S.roadLines.filter(l=>l.networkId===S.selection.id);
    if (lines.length) { lines.forEach(l=>{ l.width = v; }); rebuildRoadMeshes(); }
  } else {
    S.DEFAULT_ROAD_WIDTH = v;
  }
});
document.getElementById('s-sidewalkwidth').addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  document.getElementById('v-sidewalkwidth').textContent = v;
  if (S.selection.type==='road') {
    const lines = S.roadLines.filter(l=>l.networkId===S.selection.id);
    if (lines.length) { lines.forEach(l=>{ l.sidewalkWidth = v; }); rebuildRoadMeshes(); }
  } else {
    S.DEFAULT_SIDEWALK_WIDTH = v;
  }
});

// the zones' lots and buildings only follow once the slider's let go of — regenerating them on every tick is slow
['s-roadwidth', 's-sidewalkwidth'].forEach(id => document.getElementById(id).addEventListener('change', () => {
  if (S.selection.type==='road' && S.roadLines.some(l=>l.networkId===S.selection.id)) S.zones.forEach(subdivideZone);
}));

document.getElementById('s-tuberadius').addEventListener('input', (e)=>{
  const v = parseFloat(e.target.value);
  document.getElementById('v-tuberadius').textContent = v;
  if (S.selection.type==='train') {
    const lines = S.roadLines.filter(l=>l.networkId===S.selection.id);
    if (lines.length) { lines.forEach(l=>{ l.radius = v; }); rebuildTrainMeshes(); refreshHighlights(); }
  } else {
    S.TRAIN_DEFAULT_RADIUS = v;
  }
});
document.getElementById('s-trainheight').addEventListener('input', (e)=>{
  S.TRAIN_DEFAULT_HEIGHT = parseFloat(e.target.value);
  document.getElementById('v-trainheight').textContent = S.TRAIN_DEFAULT_HEIGHT;
});
document.getElementById('s-coilfreq').addEventListener('input', (e)=>{
  S.TRAIN_COIL_TURNS_PER_10 = parseFloat(e.target.value);
  document.getElementById('v-coilfreq').textContent = S.TRAIN_COIL_TURNS_PER_10.toFixed(2);
  rebuildTrainMeshes(); refreshHighlights();
});

document.getElementById('btn-export').addEventListener('click', () => App.exportOBJ());
document.getElementById('btn-export-glb').addEventListener('click', () => App.exportGLB());
document.getElementById('btn-undo').addEventListener('click', () => App.undo());
document.getElementById('btn-redo').addEventListener('click', () => App.redo());
document.getElementById('s-sunelev').addEventListener('input', (e) => {
  S.sunElevation = parseFloat(e.target.value);
  document.getElementById('dv-sunelev').textContent = S.sunElevation;
  updateSun();
});
document.getElementById('s-sunazim').addEventListener('input', (e) => {
  S.sunAzimuth = parseFloat(e.target.value);
  document.getElementById('dv-sunazim').textContent = S.sunAzimuth;
  updateSun();
});
document.getElementById('s-grassnoise').addEventListener('input', (e) => {
  S.globalGrassNoiseStrength = parseFloat(e.target.value);
  document.getElementById('dv-grassnoise').textContent = S.globalGrassNoiseStrength.toFixed(2);
  S.zones.forEach(subdivideZone);
});
// the extra settings, under Clear all: they slide open with the button
function syncExtraSettings() {
  document.getElementById('s-gibs').classList.toggle('on', S.showGibs);
  document.getElementById('s-bloodsoak').classList.toggle('on', S.bloodSoak);
  document.getElementById('s-hideownhead').classList.toggle('on', S.hideOwnHead);
  document.getElementById('s-gibrange').value = S.gibRange;
  document.getElementById('dv-gibrange').textContent = String(Math.round(S.gibRange));
  document.getElementById('s-carspawn').value = S.carSpawnDistance;
  document.getElementById('dv-carspawn').textContent = String(Math.round(S.carSpawnDistance));
  document.getElementById('s-gibamount').value = S.gibAmount*100;
  document.getElementById('dv-gibamount').textContent = Math.round(S.gibAmount*100) + '%';
  document.getElementById('s-giblifetime').value = S.gibLifetime*100;
  document.getElementById('dv-giblifetime').textContent = Math.round(S.gibLifetime*100) + '%';
  document.getElementById('s-particlerange').value = S.particleRange;
  document.getElementById('dv-particlerange').textContent = String(Math.round(S.particleRange));
  document.getElementById('s-maxparticles').value = S.maxParticles;
  document.getElementById('dv-maxparticles').textContent = String(Math.round(S.maxParticles));
}
document.getElementById('btn-settings-toggle').addEventListener('click', (e) => {
  const block = document.getElementById('extra-settings'), open = block.style.maxHeight === '0px';
  block.style.maxHeight = open ? block.scrollHeight + 'px' : '0px';
  e.currentTarget.textContent = open ? 'Show settings ▴' : 'Show settings ▾'; // (the arrow points up when it's down, to fold it away)
});
document.getElementById('s-bloodsoak').addEventListener('click', () => { S.bloodSoak = !S.bloodSoak; syncExtraSettings(); });
document.getElementById('s-gibs').addEventListener('click', () => { S.showGibs = !S.showGibs; syncExtraSettings(); });
document.getElementById('s-gibrange').addEventListener('input', (e) => { S.gibRange = parseFloat(e.target.value); syncExtraSettings(); });
document.getElementById('s-gibamount').addEventListener('input', (e) => { S.gibAmount = parseFloat(e.target.value)/100; syncExtraSettings(); });
document.getElementById('s-giblifetime').addEventListener('input', (e) => { S.gibLifetime = parseFloat(e.target.value)/100; syncExtraSettings(); });
document.getElementById('s-particlerange').addEventListener('input', (e) => { S.particleRange = parseFloat(e.target.value); syncExtraSettings(); });
document.getElementById('s-maxparticles').addEventListener('input', (e) => { S.maxParticles = parseFloat(e.target.value); syncExtraSettings(); });
document.getElementById('s-carspawn').addEventListener('input', (e) => { S.carSpawnDistance = parseFloat(e.target.value); syncExtraSettings(); });
document.getElementById('s-hideownhead').addEventListener('click', () => { S.hideOwnHead = !S.hideOwnHead; syncExtraSettings(); });
syncExtraSettings();
document.getElementById('s-people').addEventListener('click', () => { S.peopleEnabled = !S.peopleEnabled; App.syncPeopleUI(); });
document.getElementById('s-peopleamount').addEventListener('input', (e) => { S.peopleAmount = parseFloat(e.target.value); App.syncPeopleUI(); });
document.getElementById('s-peoplespeed').addEventListener('input', (e) => { S.peopleSpeed = parseFloat(e.target.value); App.syncPeopleUI(); });
document.getElementById('s-peoplesize').addEventListener('input', (e) => { S.peopleSize = parseFloat(e.target.value); App.syncPeopleUI(); });
document.getElementById('s-roadsafety-debug').addEventListener('click', () => { S.showRoadsafetyDebug = !S.showRoadsafetyDebug; App.syncPeopleUI(); });
document.getElementById('s-peoplenav-debug').addEventListener('click', () => { S.showPeopleNavDebug = !S.showPeopleNavDebug; App.syncPeopleUI(); });
document.getElementById('s-traffic').addEventListener('input', (e) => { S.trafficAmount = parseFloat(e.target.value); App.syncPeopleUI(); });
document.getElementById('s-daynight').addEventListener('click', () => {
  S.dayNightEnabled = !S.dayNightEnabled;
  if (S.dayNightEnabled) App.applyTimeOfDay(false); else App.syncSkyUI();
});
document.getElementById('s-timeofday').addEventListener('input', (e) => { S.timeOfDay = parseFloat(e.target.value) % 24; App.applyTimeOfDay(false); });
document.getElementById('s-daylength').addEventListener('input', (e) => { S.dayLengthMinutes = parseFloat(e.target.value); App.syncSkyUI(); });
['rain', 'snow', 'clouds'].forEach(kind => document.getElementById('s-' + kind).addEventListener('input', (e) => App.setWeather(kind, parseFloat(e.target.value))));
document.getElementById('s-groundcolor').addEventListener('input', (e) => {
  groundMat.color.set(e.target.value);
});
document.getElementById('s-gridcolor').addEventListener('input', (e) => {
  setGridColor(e.target.value);
});
document.getElementById('btn-clear').addEventListener('click', ()=>{
  cancelActiveDrawing();
  S.roadLines=[]; Object.keys(roadNodes).forEach(k=>delete roadNodes[k]);
  S.zones.forEach(z=>{ scene.remove(z.outlineGroup); disposeObject(z.outlineGroup); scene.remove(z.buildingsGroup); disposeObject(z.buildingsGroup); });
  S.zones=[];
  S.selection={type:null,id:null};
  mapImages.slice().forEach(m => removeMapImage(m.id));
  rebuildRoadMeshes();
  renderHierarchy();
});
document.getElementById('btn-import-image').addEventListener('click', () => {
  document.getElementById('map-file-input').click();
});
document.getElementById('map-file-input').addEventListener('change', (e) => {
  Array.from(e.target.files||[]).forEach(importMapImageFile);
  e.target.value = ''; // allow re-importing the same filename later
});

Object.assign(App, { updateHint, applyModeVisibility });
