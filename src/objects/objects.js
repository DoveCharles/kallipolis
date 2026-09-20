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
export const MIN_OBJECT_SCALE = 0.4, MAX_OBJECT_SCALE = 3; // how far a prop can be taken from the size it was built at

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
// The ring is the whole of the manipulator. An object on this ground has four degrees of freedom and no more — where it
// stands, which way it looks, and how big it is — so rather than a set of arrows and modes there's one flat ring on the
// ground: it marks what's selected, its nose shows which way the thing is facing, and dragging it round turns it. The
// other two are the object itself (drag it to move it) and a slider (size), so there's never a mode to be in.
const RING_COLOR = 0x3ddc97;         // the app's accent
const RING_GRAB = 0.4;               // how wide a band either side of the ring counts as catching hold of it, in metres
const TURN_SNAP = 15*Math.PI/180;    // what shift rounds a turn to
const SQUARE_SNAP = 6*Math.PI/180;   // how near square-with-the-street a turn has to come to be pulled onto it
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
let ringGroup = null, ring = null, ringNose = null, ringSquares = null;
let ringSquareBase = null; // the street direction the tick marks are drawn from, while a turn is being dragged out
// A flat triangle pointing along +z — the way the object it's under is facing.
function noseGeometry() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.13,0,-0.13, 0.13,0,-0.13, 0,0,0.22], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0,1,0, 0,1,0, 0,1,0], 3));
  return geo;
}
// Four ticks at the quarter turns, shown while turning something so that the angles it'll snap onto can be seen rather
// than just felt. Built at radius 1 and scaled with the ring.
function squaresGeometry() {
  const pos = [], w = 0.05;
  for (let k = 0; k < 4; k++) {
    const a = k*Math.PI/2, c = Math.cos(a), s = Math.sin(a);
    const at = (r, t) => [c*r - s*t, 0, s*r + c*t];
    const [p0, p1, p2, p3] = [at(1.04,-w), at(1.3,-w), at(1.3,w), at(1.04,w)];
    pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => i%3===1 ? 1 : 0), 3));
  return geo;
}
function ensureRing() {
  if (ringGroup) return ringGroup;
  const flat = (opacity) => new THREE.MeshBasicMaterial({ color:RING_COLOR, transparent:true, opacity, side:THREE.DoubleSide, depthWrite:false });
  ringGroup = new THREE.Group();
  const geo = new THREE.RingGeometry(0.86, 1, 48);
  geo.rotateX(-Math.PI/2);
  ring = new THREE.Mesh(geo, flat(0.75));
  ringNose = new THREE.Mesh(noseGeometry(), flat(0.9));
  ringSquares = new THREE.Mesh(squaresGeometry(), flat(0.3));
  ringSquares.visible = false; // only while a turn is being dragged out
  [ring, ringNose, ringSquares].forEach(m => { m.renderOrder = 3; ringGroup.add(m); });
  objectUiGroup.add(ringGroup);
  return ringGroup;
}
// How big the ring under something is: what it takes up on the ground, with a little room around it — but never so small
// that a bollard's ring is a dot too fine to see or to catch.
const MIN_RING = 0.9;
export const ringRadiusOf = obj => Math.max(MIN_RING, objectTypeOf(obj.type).radius * obj.scale * 1.2);
function refreshObjectRing() {
  const obj = objectById(S.selectedObjectId);
  if (!obj) { if (ringGroup) ringGroup.visible = false; return; }
  const r = ringRadiusOf(obj);
  ensureRing().visible = true;
  ringGroup.position.set(obj.x, Y_OBJECT_RING, obj.z);
  ringGroup.rotation.y = obj.rotY; // so the nose points where the thing itself is pointing
  ring.scale.set(r, 1, r);
  ringNose.position.set(0, 0, r);
  ringSquares.scale.set(r, 1, r);
  ringSquares.rotation.y = ringSquareBase != null ? ringSquareBase - obj.rotY : 0; // the ticks stay put as the object turns
}
// The ring brightens as a turn snaps onto one of the square angles, so a snap is something you see take hold.
function markRingSnapped(snapped) {
  if (ring) ring.material.opacity = snapped ? 1 : 0.75;
}
export function selectObject(id) {
  S.selectedObjectId = id;
  refreshObjectRing();
  renderObjectsPanel();
  renderObjectDetails();
  App.updateHint(); // what you can do with one changes the moment there is one selected
}
// Edit mode's other tabs shouldn't show a ghost or a ring, but leaving the tab needn't lose the selection either — so
// the lot is just hidden and comes back as it was (see applyModeVisibility).
export function showObjectUi(visible) { objectUiGroup.visible = visible; }

// ---------------------------------------------------------- turning one by its ring
const angleFromObject = (obj, gp) => Math.atan2(gp.x - obj.x, gp.z - obj.z); // in the same sense as rotY: +z is 0
// Whether that point on the ground has hold of the selected object's ring. The test is made on the ground rather than
// against the ring's own triangles so that a bollard's small ring is as easy to catch as a water tower's wide one, and
// so it still works with the camera low enough that the ring is nearly edge-on.
export function pickObjectRing(gp) {
  const obj = objectById(S.selectedObjectId);
  if (!obj || !gp || !objectUiGroup.visible) return null;
  const r = ringRadiusOf(obj);
  return Math.abs(Math.hypot(gp.x - obj.x, gp.z - obj.z) - r) <= Math.max(RING_GRAB, r*0.3) ? obj.id : null;
}
export function startObjectTurn(id, gp) {
  const obj = objectById(id);
  if (!obj) return null;
  ringSquareBase = streetFacingAt(obj.x, obj.z);
  if (ringSquares) ringSquares.visible = ringSquareBase != null;
  refreshObjectRing();
  return { kind:'objectTurn', id, startAngle: angleFromObject(obj, gp), startRot: obj.rotY };
}
// What a turn is pulled onto. With shift it's plain 15° steps, the way a map image snaps. Otherwise it's the four ways
// of standing square to the street the thing is beside — facing it, backing it, or along it either way — which is what
// most things want and what's hardest to hit by eye. Out in open country, with no street in reach, nothing pulls.
function snapTurn(obj, rotY, shift) {
  if (shift) return { rotY: Math.round(rotY/TURN_SNAP)*TURN_SNAP, snapped: true };
  const base = ringSquareBase;
  if (base == null) return { rotY, snapped: false };
  const quarter = Math.PI/2;
  const target = base + Math.round(wrapAngle(rotY - base)/quarter)*quarter;
  return Math.abs(wrapAngle(rotY - target)) <= SQUARE_SNAP ? { rotY: target, snapped: true } : { rotY, snapped: false };
}
// Dragging the ring keeps the point you took hold of under the cursor, so the object follows the hand rather than some
// angle worked out from the middle of it.
export function turnObjectTo(dn, gp, shift) {
  const obj = objectById(dn.id);
  if (!obj || !gp) return;
  const turned = snapTurn(obj, dn.startRot + angleFromObject(obj, gp) - dn.startAngle, shift);
  obj.rotY = wrapAngle(turned.rotY);
  syncObject(obj);
  refreshObjectRing();
  markRingSnapped(turned.snapped);
  syncObjectDetails(obj);
}
export function endObjectTurn() {
  ringSquareBase = null;
  if (ringSquares) ringSquares.visible = false;
  markRingSnapped(false);
  refreshObjectRing();
}

// ---------------------------------------------------------- G, R and S
// The same three keys that move, turn and resize a map image, doing the same job here: the thing follows the cursor
// until a click or Enter leaves it there, and Esc or a right-click puts it back where it was. It's the way to turn
// something whose ring is off the edge of the view, and the only way to resize one without going to the slider.
S.objectTransform = null; // {mode, id, startGround, startPos, startRotY, startScale}
export function startObjectTransform(mode, gp) {
  const obj = objectById(S.selectedObjectId);
  if (!obj || !gp) return;
  ringSquareBase = mode === 'rotate' ? streetFacingAt(obj.x, obj.z) : null;
  if (ringSquares) ringSquares.visible = ringSquareBase != null;
  S.objectTransform = { mode, id: obj.id, startGround: gp, startPos: { x:obj.x, z:obj.z }, startRotY: obj.rotY, startScale: obj.scale,
    startAngle: angleFromObject(obj, gp), startDist: Math.max(0.001, Math.hypot(gp.x - obj.x, gp.z - obj.z)) };
  refreshObjectRing();
  App.updateHint();
}
export function applyObjectTransform(gp, shift) {
  const t = S.objectTransform;
  if (!t || !gp) return;
  const obj = objectById(t.id);
  if (!obj) { S.objectTransform = null; return; }
  if (t.mode === 'translate') {
    const at = snapPointToGrid({ x: t.startPos.x + (gp.x - t.startGround.x), z: t.startPos.z + (gp.z - t.startGround.z) }, 'object');
    obj.x = at.x; obj.z = at.z;
  } else if (t.mode === 'rotate') {
    const turned = snapTurn(obj, t.startRotY + angleFromObject(obj, gp) - t.startAngle, shift);
    obj.rotY = wrapAngle(turned.rotY);
    markRingSnapped(turned.snapped);
  } else {
    const grown = t.startScale * (Math.hypot(gp.x - obj.x, gp.z - obj.z) / t.startDist);
    obj.scale = Math.min(MAX_OBJECT_SCALE, Math.max(MIN_OBJECT_SCALE, shift ? Math.round(grown*10)/10 : grown));
  }
  syncObject(obj);
  refreshObjectRing();
  syncObjectDetails(obj);
}
export function confirmObjectTransform() {
  if (!S.objectTransform) return;
  S.objectTransform = null;
  endObjectTurn();
  renderObjectDetails();
  App.updateHint();
}
export function cancelObjectTransform() {
  const t = S.objectTransform;
  if (!t) return;
  const obj = objectById(t.id);
  if (obj) { obj.x = t.startPos.x; obj.z = t.startPos.z; obj.rotY = t.startRotY; obj.scale = t.startScale; syncObject(obj); }
  S.objectTransform = null;
  endObjectTurn();
  renderObjectDetails();
  App.updateHint();
}
export function objectTransformHint(touch) {
  const t = S.objectTransform;
  if (!t) return null;
  const label = t.mode === 'translate' ? 'Move' : t.mode === 'rotate' ? 'Turn' : 'Size';
  if (touch) return label + ' — drag it, and let go when it looks right';
  const snapHint = t.mode === 'rotate' ? ' · hold shift for 15° steps' : t.mode === 'scale' ? ' · hold shift for tenths' : '';
  return label + ' — click or Enter to leave it there · Esc or right-click to put it back' + snapHint;
}

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
  const mid = objectTransformHint(touch);
  if (mid) return mid; // something's following the cursor: say how to leave it or put it back, and nothing else
  if (S.placingType) {
    const what = objectTypeOf(S.placingType).label.toLowerCase();
    return touch
      ? `Tap the ground to put down a ${what} · keep tapping for as many as you want · press and hold to stop`
      : `Click the ground to put down a ${what} · keep clicking for as many as you want · Esc or right-click to stop`;
  }
  if (S.selectedObjectId) return touch
    ? 'Drag it to move it · drag its ring round to turn it · double-tap it to delete it · tap empty ground to let go of it'
    : 'Drag it to move it · drag its ring round to turn it (hold shift for 15° steps) · alt+drag to copy it · G, R and S move, turn and size it from the keyboard · double-click to delete it';
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
// Keeping the sliders in step with a drag, without rebuilding the panel on every pointermove — rebuilding it there
// would throw away the slider you might be holding and re-run the whole thing sixty times a second.
function syncObjectDetails(obj) {
  if (!obj || obj.id !== S.selectedObjectId) return;
  const turn = document.getElementById('s-objturn'), size = document.getElementById('s-objsize');
  const turnVal = document.getElementById('dv-objturn'), sizeVal = document.getElementById('dv-objsize');
  const deg = Math.round(((obj.rotY*180/Math.PI) % 360 + 360) % 360) % 360;
  if (turn) turn.value = deg;
  if (turnVal) turnVal.textContent = deg + '\u00b0';
  if (size) size.value = obj.scale;
  if (sizeVal) sizeVal.textContent = obj.scale.toFixed(2);
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
      <input type="range" id="s-objsize" min="${MIN_OBJECT_SCALE}" max="${MAX_OBJECT_SCALE}" step="0.01" value="${obj.scale}"></div>
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

Object.assign(App, { renderObjectsPanel, renderObjectDetails, disarmObject, invalidateObjectFacing, objectsHint, showObjectUi, restoreObjects, clearObjects,
  cancelObjectTransform, confirmObjectTransform, objectTransformHint });
