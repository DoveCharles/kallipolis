import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, camera, snapPointToGrid, Y_PATH } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { tessellateOpenPath, tessellateClosedPath } from '../core/splines.js';
import { distPointSegment, closestPointOnSegment } from '../buildings/footprints.js';
import { roadNodes } from '../core/state.js';
import { disposeObject } from '../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { isTrainLine } from '../trains/trains.js';
import { OBJECT_TYPES, objectTypeOf } from './object-types.js';

// ============================================================ objects
// The Objects tab: street furniture put down by hand (see object-types.js for what there is). Picking a kind off the
// palette arms it — a ghost of it follows the cursor, turned the way it would land, and every click leaves one behind
// until Esc, a right-click, or picking that kind again puts the palette down. What's down can be dragged about,
// copied by dragging with alt held, and deleted.
//
// The point of all that is that a thing lands right first time: it turns to face the street it's beside and comes out a
// little off true in turn and size, so a row of benches looks placed rather than stamped. Correcting one by hand is
// meant to be the exception.
//
// An object is a plain record — {id, type, x, z, rotY, scale, seed} — with the group it built alongside it. The record
// is all that's saved, so undo, autosave and the project file get objects for nothing (see save-load.js), and the seed
// builds one back exactly as it was.
export const objectGroup = new THREE.Group(); objectGroup.name = 'Objects'; scene.add(objectGroup);
// The ghost and the ring under what's selected are editing furniture rather than part of the city, so they're kept out
// of objectGroup — nothing that picks, saves or exports objects ever sees them.
const objectUiGroup = new THREE.Group(); objectUiGroup.name = 'Object UI'; scene.add(objectUiGroup);

S.objects = [];        // {id, type, x, z, rotY, scale, seed, group}
S.objectSeq = 1;
S.placingType = null;  // the kind armed off the palette, if any: every click puts one of these down
S.selectedObjectId = null;
S.lastObjectClick = null; // {id, time}, for double-click-to-delete

// Props stand on the ground, on top of whatever's drawn flat on it — the height a walkway's surface is, so a bench on a
// path sits on the path rather than in it. (There's one flat plane under the whole city; there's no ground to follow.)
export const Y_OBJECT = Y_PATH;
const Y_OBJECT_RING = Y_OBJECT + 0.04; // the ring under a selected one, clear of every flat surface but under the prop

// ---------------------------------------------------------- which way a thing you put down looks
const FACING_REACH = 60;  // a street further off than this doesn't get a say in it
const ON_TOP_OF_IT = 0.2; // and neither does one you've put the thing right on top of: there's no direction in that
let facingCache = null;
// Roads and zones can't be edited from the Objects tab, so what's near is worked out once and read from until the tab is
// left again or a project comes in (see applyModeVisibility and loadProjectFromData, which both throw this away).
export function invalidateObjectFacing() { facingCache = null; }
function facingSegments() {
  if (facingCache) return facingCache;
  const roads = [], paths = [], edges = [];
  const addSegments = (into, points, closed) => {
    const tess = closed ? tessellateClosedPath(points) : tessellateOpenPath(points);
    for (let i=0; i<tess.length-1; i++) into.push([tess[i], tess[i+1]]);
    if (closed && tess.length > 2) into.push([tess[tess.length-1], tess[0]]); // tessellateClosedPath leaves the loop open
  };
  S.roadLines.forEach(line => {
    if (line.drawing || isTrainLine(line) || isRiverLine(line)) return; // nothing turns to look at a railway or a river
    const points = line.nodeIds.map(id => roadNodes[id]).filter(Boolean);
    if (points.length >= 2) addSegments(isWalkwayLine(line) ? paths : roads, points, false);
  });
  S.zones.forEach(zone => {
    if (zone.drawing || !zone.closed || zone.points.length < 3) return;
    addSegments(edges, zone.points, true);
  });
  return facingCache = { roads, paths, edges };
}
function nearestSegment(segments, p) {
  let best = null, bestD = Infinity;
  for (const [a, b] of segments) {
    const d = distPointSegment(p, a, b);
    if (d < bestD) { bestD = d; best = [a, b]; }
  }
  return best && bestD <= FACING_REACH ? { at: closestPointOnSegment(p, best[0], best[1]), d: bestD } : null;
}
// The way something put down at (x, z) should look, or null if there's nothing near enough to take a direction from.
// A real road first, then a walkway, then a zone's own edge: the chain a house's front door follows (streetFor in
// suburbs.js), and for the same reason — a road right across the map shouldn't get a vote, and plenty of a city is laid
// out with no road near it at all.
export function streetFacingAt(x, z) {
  const { roads, paths, edges } = facingSegments();
  const p = { x, z };
  const near = nearestSegment(roads, p) || nearestSegment(paths, p) || nearestSegment(edges, p);
  if (!near || near.d < ON_TOP_OF_IT) return null; // sitting on the thing itself: nothing to face
  return Math.atan2(near.at.x - x, near.at.z - z); // props are built facing +z
}

// ---------------------------------------------------------- putting them down and taking them away
export const objectById = id => S.objects.find(o => o.id === id) || null;
function buildObject(obj) {
  const type = objectTypeOf(obj.type);
  const group = type.build(mulberry32(obj.seed));
  group.name = type.label;
  group.userData.objectId = obj.id;
  objectGroup.add(group);
  obj.group = group;
  syncObject(obj);
}
// Puts the group where the record says. Everything that moves, turns or resizes an object edits the record and calls this.
function syncObject(obj) {
  if (!obj.group) return;
  obj.group.position.set(obj.x, Y_OBJECT, obj.z);
  obj.group.rotation.y = obj.rotY;
  obj.group.scale.setScalar(obj.scale);
}
// How a kind of thing lands at (x, z): facing the street if it has a front, and a little off true either way so that no
// two are quite alike.
function landing(type, at, rng) {
  const facing = type.facing === 'street' ? streetFacingAt(at.x, at.z) : null;
  return {
    rotY: (facing != null ? facing : rng()*Math.PI*2) + (rng()*2-1)*type.turnJitter*Math.PI/180,
    scale: 1 + (rng()*2-1)*type.sizeJitter,
  };
}
export function addObject(typeId, at, overrides) {
  const type = objectTypeOf(typeId);
  const seed = Math.floor(Math.random()*100000);
  const obj = { id:'obj-'+(S.objectSeq++), type:type.id, x:at.x, z:at.z, seed, ...landing(type, at, mulberry32(seed)), ...overrides };
  S.objects.push(obj);
  buildObject(obj);
  renderObjectsPanel();
  return obj;
}
export function removeObject(id) {
  const i = S.objects.findIndex(o => o.id === id);
  if (i < 0) return;
  const [obj] = S.objects.splice(i, 1);
  if (obj.group) { objectGroup.remove(obj.group); disposeObject(obj.group); }
  if (S.selectedObjectId === id) selectObject(null);
  renderObjectsPanel();
}
// A second one of the same thing, built its own way (its own seed) but standing exactly as this one does.
export function duplicateObject(id) {
  const obj = objectById(id);
  if (!obj) return null;
  return addObject(obj.type, { x:obj.x, z:obj.z }, { rotY:obj.rotY, scale:obj.scale });
}
export function clearObjects() {
  S.objects.forEach(obj => { if (obj.group) { objectGroup.remove(obj.group); disposeObject(obj.group); } });
  S.objects = [];
  selectObject(null);
  invalidateObjectFacing();
}
// Rebuilds the lot from saved records (a project, an undo step, an autosave coming back).
export function restoreObjects(list) {
  clearObjects();
  (list || []).forEach(saved => {
    const obj = { id:saved.id, type:saved.type, x:saved.x, z:saved.z, rotY:saved.rotY||0, scale:saved.scale||1, seed:saved.seed||1 };
    S.objects.push(obj);
    buildObject(obj);
  });
  renderObjectsPanel();
}
// Turns one to face the street again — for when it's been dragged somewhere its old angle no longer suits.
export function faceObjectToStreet(id) {
  const obj = objectById(id);
  if (!obj) return;
  const facing = streetFacingAt(obj.x, obj.z);
  if (facing == null) return;
  obj.rotY = facing;
  syncObject(obj);
}

// ---------------------------------------------------------- the ring under what's selected
// A flat ring on the ground, which is both how you can tell what's selected and (next) what you'll drag round to turn it.
const RING_COLOR = 0x3ddc97; // the app's accent
let ring = null;
function ensureRing() {
  if (ring) return ring;
  const geo = new THREE.RingGeometry(0.86, 1, 48);
  geo.rotateX(-Math.PI/2);
  ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color:RING_COLOR, transparent:true, opacity:0.75, side:THREE.DoubleSide, depthWrite:false }));
  ring.renderOrder = 3;
  objectUiGroup.add(ring);
  return ring;
}
function refreshObjectRing() {
  const obj = objectById(S.selectedObjectId);
  if (!obj) { if (ring) ring.visible = false; return; }
  const r = objectTypeOf(obj.type).radius * obj.scale * 1.2;
  const mesh = ensureRing();
  mesh.visible = true;
  mesh.position.set(obj.x, Y_OBJECT_RING, obj.z);
  mesh.scale.set(r, 1, r);
}
export function selectObject(id) {
  S.selectedObjectId = id;
  refreshObjectRing();
  renderObjectsPanel();
  renderObjectDetails();
}
// Edit mode's other tabs shouldn't show a ghost or a ring, but leaving the tab needn't lose the selection either — so
// the lot is just hidden and comes back as it was (see applyModeVisibility).
export function showObjectUi(visible) { objectUiGroup.visible = visible; }

// ---------------------------------------------------------- the ghost on the cursor
const GHOST_MAT = new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.4, depthWrite:false });
let ghost = null, ghostType = null;
function setGhostType(typeId) {
  if (ghostType === typeId) return;
  if (ghost) { objectUiGroup.remove(ghost); disposeObject(ghost); ghost = null; }
  ghostType = typeId;
  if (!typeId) return;
  ghost = objectTypeOf(typeId).build(mulberry32(1));
  ghost.traverse(o => { if (o.isMesh) { o.material = GHOST_MAT; o.castShadow = false; o.receiveShadow = false; } });
  ghost.visible = false;
  objectUiGroup.add(ghost);
}
// Moves the ghost to where a click would put one, turned the way it would land — so the facing is something you can see
// before you commit to it rather than a surprise afterwards.
export function moveObjectGhost(at) {
  if (!S.placingType || !at) { if (ghost) ghost.visible = false; return; }
  setGhostType(S.placingType);
  const type = objectTypeOf(S.placingType);
  const p = snapPointToGrid(at, 'object');
  const facing = type.facing === 'street' ? streetFacingAt(p.x, p.z) : null;
  ghost.visible = true;
  ghost.position.set(p.x, Y_OBJECT, p.z);
  ghost.rotation.y = facing != null ? facing : 0;
}
export function hideObjectGhost() { if (ghost) ghost.visible = false; }

// ---------------------------------------------------------- picking one up
const raycaster = new THREE.Raycaster();
export function pickObjectAt(x, y) {
  if (!S.objects.length) return null;
  raycaster.setFromCamera(App.ndcOf(x, y), camera);
  for (const hit of raycaster.intersectObjects(objectGroup.children, true)) {
    let o = hit.object;
    while (o && !o.userData.objectId) o = o.parent;
    if (o) return o.userData.objectId;
  }
  return null;
}
// A prop being dragged keeps the turn and size it was given — it's being moved, not put down again. With alt held it's a
// copy that moves and the original stays put, which is how a run of the same thing gets laid out.
export function startObjectDrag(id, gp, copy) {
  const obj = objectById(id);
  if (!obj) return null;
  selectObject(id);
  return { kind:'object', id, dx: obj.x - gp.x, dz: obj.z - gp.z, copy: !!copy, copied: false };
}
export function dragObjectTo(dn, gp) {
  if (dn.copy && !dn.copied) {
    dn.copied = true;
    const made = duplicateObject(dn.id);
    if (made) dn.id = made.id;
  }
  const obj = objectById(dn.id);
  if (!obj || !gp) return;
  const at = snapPointToGrid({ x: gp.x + dn.dx, z: gp.z + dn.dz }, 'object');
  obj.x = at.x; obj.z = at.z;
  syncObject(obj);
  refreshObjectRing();
}
// A click on one selects it; a second click on the same one deletes it, the way a road's nodes go.
export function clickObject(id) {
  if (S.lastObjectClick && S.lastObjectClick.id === id && (performance.now() - S.lastObjectClick.time) < 350) {
    S.lastObjectClick = null;
    removeObject(id);
    return;
  }
  S.lastObjectClick = { id, time: performance.now() };
  selectObject(id);
}

// ---------------------------------------------------------- arming the palette
export function armObject(typeId) {
  const next = S.placingType === typeId ? null : typeId; // picking the armed kind again puts the palette down
  S.placingType = next;
  if (next) { selectObject(null); setGhostType(next); } else setGhostType(null);
  renderObjectsPanel();
  App.updateHint();
}
// Esc, a right-click, leaving the tab: whatever was armed is put down (see cancelActiveDrawing).
export function disarmObject() {
  if (!S.placingType && !ghost) return;
  S.placingType = null;
  setGhostType(null);
  renderObjectsPanel();
  App.updateHint();
}
export function objectsHint(touch) {
  if (S.placingType) {
    const what = objectTypeOf(S.placingType).label.toLowerCase();
    return touch
      ? `Tap the ground to put down a ${what} · keep tapping for as many as you want · press and hold to stop`
      : `Click the ground to put down a ${what} · keep clicking for as many as you want · Esc or right-click to stop`;
  }
  return touch
    ? 'Pick something from the palette to start putting it down · tap one to select it · drag it to move it · double-tap it to delete it · drag empty ground to orbit'
    : 'Pick something from the palette to start putting it down · click one to select it · drag it to move it · alt+drag to copy it · double-click to delete it · empty-ground drag orbits';
}

// ---------------------------------------------------------- the panel
// The palette and the list live in the Objects section; the selected object's own settings go in the details panel below
// it, where a road's or a zone's do (renderDetails hands over to this when the Objects tab is up).
export function renderObjectsPanel() {
  const palette = document.getElementById('object-palette');
  if (!palette) return;
  palette.innerHTML = '';
  OBJECT_TYPES.forEach(type => {
    const card = document.createElement('button');
    card.className = 'type-card' + (S.placingType === type.id ? ' active' : '');
    card.title = type.label;
    card.innerHTML = `<div class="thumb" style="background-color:${type.color}"></div>${type.label}`;
    card.onclick = () => armObject(type.id);
    palette.appendChild(card);
  });
  const list = document.getElementById('objects-list');
  list.innerHTML = '';
  S.objects.forEach(obj => {
    const row = document.createElement('div');
    row.className = 'hier-row' + (S.selectedObjectId === obj.id ? ' active' : '');
    const span = document.createElement('span');
    span.textContent = objectTypeOf(obj.type).label;
    row.appendChild(span);
    const del = document.createElement('button');
    del.className = 'hier-del'; del.textContent = '×';
    del.onclick = (e) => { e.stopPropagation(); removeObject(obj.id); };
    row.appendChild(del);
    row.onclick = () => selectObject(obj.id);
    list.appendChild(row);
  });
  document.getElementById('objects-count').textContent = S.objects.length;
}
export function renderObjectDetails() {
  const panel = document.getElementById('details-panel');
  const obj = objectById(S.selectedObjectId);
  if (!obj) {
    panel.innerHTML = '<div class="empty">Pick something from the palette above and click the ground to put one down. Click one that\'s down to see its settings.</div>';
    return;
  }
  const type = objectTypeOf(obj.type);
  const turn = Math.round(((obj.rotY*180/Math.PI) % 360 + 360) % 360);
  panel.innerHTML = `
    <div class="title-row"><span class="name">${type.label}</span><button class="close-x" id="do-close">deselect</button></div>
    <div class="slider-row"><div class="row"><label>Turn</label><span class="val" id="dv-objturn">${turn}°</span></div>
      <input type="range" id="s-objturn" min="0" max="359" step="1" value="${turn}"></div>
    <div class="slider-row"><div class="row"><label>Size</label><span class="val" id="dv-objsize">${obj.scale.toFixed(2)}</span></div>
      <input type="range" id="s-objsize" min="0.4" max="3" step="0.01" value="${obj.scale}"></div>
    ${type.facing === 'street' ? '<button class="btn" id="do-face">Face the street</button>' : ''}
    <button class="btn" id="do-copy" style="margin-top:6px;">Duplicate</button>
    <button class="btn danger" id="do-delete" style="margin-top:6px;">Delete</button>
  `;
  const turnInput = panel.querySelector('#s-objturn');
  turnInput.addEventListener('input', () => {
    obj.rotY = Number(turnInput.value)*Math.PI/180;
    panel.querySelector('#dv-objturn').textContent = turnInput.value + '°';
    syncObject(obj);
  });
  const sizeInput = panel.querySelector('#s-objsize');
  sizeInput.addEventListener('input', () => {
    obj.scale = Number(sizeInput.value);
    panel.querySelector('#dv-objsize').textContent = obj.scale.toFixed(2);
    syncObject(obj);
    refreshObjectRing();
  });
  panel.querySelector('#do-face')?.addEventListener('click', () => { faceObjectToStreet(obj.id); renderObjectDetails(); });
  panel.querySelector('#do-copy').addEventListener('click', () => {
    const made = duplicateObject(obj.id);
    if (made) { made.x += 3; syncObject(made); selectObject(made.id); }
  });
  panel.querySelector('#do-delete').addEventListener('click', () => removeObject(obj.id));
  panel.querySelector('#do-close').addEventListener('click', () => selectObject(null));
}

Object.assign(App, { renderObjectsPanel, renderObjectDetails, disarmObject, invalidateObjectFacing, objectsHint, showObjectUi, restoreObjects, clearObjects });
