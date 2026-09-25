import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { camera, renderer, snapPointToGrid, Y_PREVIEW } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { IS_TOUCH } from '../core/device.js';
import { ROAD_COLOR } from '../core/splines.js';
import { roadNodes, mapImages, DEFAULT_ZONE_SETTINGS } from '../core/state.js';
import { setSelectedMap, setMapHover, startMapTransform, applyMapTransform, confirmMapTransform, cancelMapTransform, previewLine } from '../maps/map-images.js';
import { SIDEWALK_COLOR, setLinePoints, roadLineWidths } from '../roads/roads.js';
import { WALKWAY_COLOR, rebuildRoadMeshes } from '../roads/paths.js';
import { moveRoadDragPreview, endRoadDragPreview, showDrawingPreview, endDrawingPreview } from '../roads/drag-preview.js';
import { isTrainLine, isTrainNode, networkKindOf, pathTypeOf, currentPathType, trainNodeY, trainPlanePoint, dragTrainPoint, findNearestTrainEdge } from '../trains/trains.js';
import { setHover, insertPreviewMarker, updateInsertPreviewGeometry, findNearestEdge, insertNodeOnEdge } from './hover.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { subdivideZone, subdivideZonesFrom } from '../zones/cutouts.js';
import { selectItem, deleteRoadNode, deleteZoneVertex, renderHierarchy } from '../ui/panels.js';
import { cancelActiveDrawing, closeActiveZone, finishActiveDrawing } from './tools.js';
import { addObject, applyObjectTransform, cancelObjectTransform, clickObject, confirmObjectTransform, dragObjectTo, endObjectTurn, moveObjectGhost, pickObjectAt, pickObjectRing, removeObject, selectObject, startObjectDrag, startObjectTransform, startObjectTurn, turnObjectTo } from '../objects/objects.js';

// ============================================================ input controller
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
function ndcOf(x,y) { return new THREE.Vector2((x/window.innerWidth)*2-1, -(y/window.innerHeight)*2+1); }
function raycastGround(x,y) {
  raycaster.setFromCamera(ndcOf(x,y), camera);
  const pt = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, pt) ? { x:pt.x, z:pt.z } : null;
}
function raycastObjects(x,y,objects) {
  raycaster.setFromCamera(ndcOf(x,y), camera);
  return raycaster.intersectObjects(objects, false);
}

let pointerDown = null;
let isCameraDragging = false;
let dragMode = 'orbit';
S.draggedNode = null; // {kind:'road'|'roadHandle'|'zone'|'zoneHandle'|'object'|'objectTurn', ...}
let objectCursor = ''; // what the cursor was last set to over the Objects tab: a prop to pick up, a ring to take hold of, or nothing
S.pendingInsert = null; // edge insertion candidate while cmd is held
S.lastGroundClick = null; // {x,y,time} for double-click-to-finish detection
S.lastNodeClick = null; // {kind,nodeId|zoneId+index,time} for double-click-to-delete detection
let rightClickTarget = null; // node/vertex hit under a right-click, for the context menu
let hoveringClickable = false; // the cursor's over someone or something a click would follow (World mode), and shows it

const dom = renderer.domElement;

// ============================================================ touch gestures
// Touch has no buttons and no modifier keys, so the same jobs are done by how many fingers are down and for how long:
// one finger is the left button (drag empty ground to orbit, drag a node to move it, tap to place or pick), two fingers
// pan and pinch to zoom, and a finger held still is the right button (a node's menu, or cancelling what's being drawn).
// Cmd — inserting a node into a path, or branching off one — is the ✛ button along the top (src/ui/mobile.js), which
// sets S.touchAdd.
// Drag distances are measured from where the pointer was last rather than read off movementX/movementY, which Safari
// leaves at zero for touch.
const activePointers = new Map(); // pointerId -> {x,y}, every finger currently on the view
let dragPointerId = null;         // the one a one-finger drag is following (a second finger's moves are the gesture's)
let lastPointer = { x:0, y:0 };
let gesture = null;               // two fingers: { dist, cx, cy } as they were last frame
let ignoreUntilRelease = false;   // a gesture has had its fingers; whatever's left does nothing until they're all up
let longPress = null;             // { x, y, timer, fired }
const CLICK_SLOP = IS_TOUCH ? 12 : 6;    // how far a press may wander and still count as a click
const DOUBLE_SLOP = IS_TOUCH ? 26 : 10;  // ...and how far apart two of them may be and still count as a double
const LONG_PRESS_MS = 450;
// the ✛ button stands in for holding shift, and for cmd (branch off a node, or insert one into an edge; ctrl off a Mac,
// where ctrl+click is the right button)
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const shiftHeld = (e) => e.shiftKey || S.touchAdd === true;
const cmdKey = (e) => IS_MAC ? e.metaKey : e.ctrlKey;
const addHeld = (e) => cmdKey(e) || S.touchAdd === true;
const inControl = () => App.isPossessing?.() || App.isDriving?.();

function pointerDelta(e) {
  const dx = e.clientX - lastPointer.x, dy = e.clientY - lastPointer.y;
  lastPointer = { x:e.clientX, y:e.clientY };
  return { dx, dy };
}
function twoFingers() { const [a,b] = [...activePointers.values()]; return { dist: Math.hypot(a.x-b.x, a.y-b.y), cx: (a.x+b.x)/2, cy: (a.y+b.y)/2 }; }
function beginGesture() {
  cancelLongPress();
  if (S.draggedNode) commitNodeDrag(S.draggedNode); // a second finger down mid-drag leaves the node where it got to
  pointerDown = null; S.draggedNode = null; isCameraDragging = false; rightClickTarget = null;
  showGrabCursor();
  S.lastGroundClick = null; S.lastNodeClick = null;
  gesture = { ...twoFingers(), travelled: 0 };
  ignoreUntilRelease = true;
}
function updateGesture() {
  const now = twoFingers();
  const dx = now.cx - gesture.cx, dy = now.cy - gesture.cy;
  // Panning takes the camera off whoever it's following, as a mouse pan does — but a pinch to get a closer look at them
  // shouldn't, and two fingers closing always drag the middle about a little. So it's the distance the middle has
  // travelled over the whole gesture that decides, rather than any one frame's.
  gesture.travelled += Math.hypot(dx, dy);
  if (gesture.travelled > 24 && !controls.locked) { App.stopFollowingPerson(); App.stopFollowingBuilding(); App.stopFollowingBee(); App.stopFollowingHive(); App.stopFollowingPigeon(); }
  controls.pan(dx, dy);
  if (gesture.dist > 8 && now.dist > 8) controls.zoomBy(gesture.dist / now.dist);
  gesture = { ...now, travelled: gesture.travelled };
}
// a finger held still where a right-click would have gone
function startLongPress(e) {
  if (e.pointerType === 'mouse' || S.interactionMode !== 'node') return;
  const x = e.clientX, y = e.clientY;
  longPress = { x, y, fired: false, timer: setTimeout(() => {
    if (S.currentTool === 'objects' && pickObjectAt(x, y)) return; // a prop held under the finger is being dragged, not held
    longPress.fired = true;
    pointerDown = null; S.draggedNode = null; isCameraDragging = false;
    showGrabCursor();
    const picked = pickNodeOrHandle(x, y);
    if (picked && (picked.kind === 'road' || picked.kind === 'zone')) App.showNodeContextMenu(x, y, picked);
    else cancelActiveDrawing();
    navigator.vibrate?.(12);
  }, LONG_PRESS_MS) };
}
function cancelLongPress() { if (longPress) { clearTimeout(longPress.timer); longPress = null; } }
// a closed hand while a node or handle's held (an open one over it: see setHover). A prop dragged about in the Objects tab
// keeps the cursor that tab gives it.
const NODE_KINDS = new Set(['road', 'roadHandle', 'zone', 'zoneHandle']);
function showGrabCursor() { dom.classList.toggle('dragging-node', !!S.draggedNode && NODE_KINDS.has(S.draggedNode.kind)); }
// The box round the stretches of road either side of road node `nodeId`, on every line through it — the only ones that
// move with it — taking in their nodes, handles (a spline stays inside them) and the road's full width; null if it's on none.
function roadNodeLinesBounds(nodeId) {
  let b = null;
  S.roadLines.forEach(line => {
    const ids = line.nodeIds;
    if (ids.includes(nodeId)) b = pathBounds(ids.filter((id, i) => id === nodeId || ids[i-1] === nodeId || ids[i+1] === nodeId), line, b);
  });
  return b;
}
// the box round nodes `ids` of `line`, as above, grown out of box `b` if there's one
function pathBounds(ids, line, b = null) {
  const { hw, cw, sw } = roadLineWidths(line), pad = hw + cw + sw;
  ids.forEach(id => {
    const n = roadNodes[id];
    if (n) [n, n.handleIn, n.handleOut].forEach(p => {
      if (!p) return;
      if (!b) b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      b.minX = Math.min(b.minX, p.x - pad); b.maxX = Math.max(b.maxX, p.x + pad);
      b.minZ = Math.min(b.minZ, p.z - pad); b.maxZ = Math.max(b.maxZ, p.z + pad);
    });
  });
  return b;
}
// The zones a path drawn along nodes `ids` of `line` can cut (none, for a train line): the ones to redo once it's been
// built or taken away.
export function zonesNearPath(ids, line) {
  const b = isTrainLine(line) ? null : pathBounds(ids, line);
  return b ? S.zones.filter(z => zoneNearBoxes(z, [b])) : [];
}
// Whether moving a road from box `a` to box `b` can change what's in `zone`: whether its outline comes within reach of
// either. Suburbs lay their streets along roads up to STREET_REACH outside them; everything else only minds roads
// crossing it or running just along its edge (ZONE_CUTOUT_REACH, plus a fence's inset).
const SUBURB_STREET_REACH = 90, NEAR_ZONE_REACH = App.ZONE_CUTOUT_REACH + 6;
function zoneNearBoxes(zone, boxes) {
  if (zone.points.length < 3) return false;
  const reach = zone.zoneType === 'suburbs' ? SUBURB_STREET_REACH : NEAR_ZONE_REACH;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  zone.points.forEach(p => [p, p.handleIn, p.handleOut].forEach(q => {
    if (!q) return;
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
  }));
  return boxes.some(b => b && b.minX <= maxX + reach && b.maxX >= minX - reach && b.minZ <= maxZ + reach && b.maxZ >= minZ - reach);
}
// a node let go of after being moved: rebuild what it's part of, and reselect it
function commitNodeDrag(dn) {
  if (dn.kind === 'road' || dn.kind === 'roadHandle') {
    const line = S.roadLines.find(l => l.nodeIds.includes(dn.nodeId));
    endRoadDragPreview();
    rebuildRoadMeshes();
    // (trains don't affect zones; and only the zones near where the road was or is now need redoing, which on a big city
    // is a fraction of them — each one's lots, buildings and trees take a while)
    if (!line || !isTrainLine(line)) {
      const boxes = [dn.startBounds, roadNodeLinesBounds(dn.nodeId)];
      S.zones.forEach(z => { if (!dn.startBounds || zoneNearBoxes(z, boxes)) subdivideZone(z); });
    }
    if (line) selectItem(networkKindOf(line), line.networkId, true); else renderHierarchy();
  } else if (dn.kind === 'zone' || dn.kind === 'zoneHandle') {
    const zone = S.zones.find(z => z.id === dn.zoneId);
    if (zone) { subdivideZonesFrom(zone); selectItem('zone', zone.id, true); } else renderHierarchy();
  }
}
// (only the nodes on show can be picked: a path's in the Paths tab, a zone's in the Zones tab)
const shownZoneMarkers = () => S.zones.filter(z => z.markerGroup && z.markerGroup.visible).flatMap(z => z.markerGroup.children);
function pickNodeOrHandle(x,y) {
  const roadHandleHits = S.roadHandleGroup.visible ? raycastObjects(x,y, S.roadHandleGroup.children.filter(c=>c.userData && c.userData.handleKind)) : [];
  if (roadHandleHits.length) return { kind:'roadHandle', nodeId: roadHandleHits[0].object.userData.nodeId, which: roadHandleHits[0].object.userData.handleKind };
  const zoneHandleMarkers = shownZoneMarkers().filter(c=>c.userData && c.userData.handleKind);
  const zoneHandleHits = raycastObjects(x,y, zoneHandleMarkers);
  if (zoneHandleHits.length) { const ud=zoneHandleHits[0].object.userData; return { kind:'zoneHandle', zoneId: ud.zoneId, index: ud.ownerIndex, which: ud.handleKind }; }
  const roadNodeHits = S.roadMarkerGroup.visible ? raycastObjects(x,y, S.roadMarkerGroup.children) : [];
  if (roadNodeHits.length) return { kind:'road', nodeId: roadNodeHits[0].object.userData.nodeId };
  const zoneVertexMarkers = shownZoneMarkers().filter(c=>c.userData.vertexIndex!==undefined);
  const zoneVertexHits = raycastObjects(x,y, zoneVertexMarkers);
  if (zoneVertexHits.length) { const ud=zoneVertexHits[0].object.userData; return { kind:'zone', zoneId: ud.zoneId, index: ud.vertexIndex }; }
  return null;
}
dom.addEventListener('pointerdown', (e) => {
  if (inControl()) return; // walking someone about or driving: the view's own gestures are possession.js's while that lasts
  activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if (activePointers.size === 2) { beginGesture(); dom.setPointerCapture(e.pointerId); return; }
  if (activePointers.size > 2 || ignoreUntilRelease) return;
  dragPointerId = e.pointerId;
  lastPointer = { x:e.clientX, y:e.clientY };
  if (S.interactionMode==='maps') {
    if (S.mapTransform) {
      if (e.button===2) cancelMapTransform();
      else if (e.button===0) confirmMapTransform();
      dom.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button===0 && S.touchMapMode && S.selectedMapId) {
      startMapTransform(S.touchMapMode, e.clientX, e.clientY);
      dom.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button===0) {
      const hit = raycastObjects(e.clientX, e.clientY, mapImages.filter(m=>m.mesh.visible).map(m=>m.mesh.userData.plane));
      if (hit.length) {
        const found = mapImages.find(m=>m.mesh.userData.plane===hit[0].object);
        setSelectedMap(found ? found.id : null);
        pointerDown = { x:e.clientX, y:e.clientY, button:e.button, time:performance.now() };
        isCameraDragging = false;
        dom.setPointerCapture(e.pointerId);
        return;
      }
      setSelectedMap(null);
    }
    pointerDown = { x:e.clientX, y:e.clientY, button:e.button, time:performance.now() };
    S.draggedNode = null; rightClickTarget = null;
    isCameraDragging = true;
    dragMode = e.shiftKey ? 'pan' : 'orbit';
    dom.setPointerCapture(e.pointerId);
    return;
  }
  // cmd+click a path's node (when not already drawing): a new branch, drawn out from it
  if (S.interactionMode==='node' && e.button===0 && addHeld(e) && (S.currentTool==='road' || S.currentTool==='train') && !S.activeRoadLine) {
    const picked = pickNodeOrHandle(e.clientX, e.clientY);
    if (picked && picked.kind==='road') { startBranchFrom(picked.nodeId); dom.setPointerCapture(e.pointerId); return; }
  }
  // cmd+click a path's or zone's edge: a new node there
  if (S.interactionMode==='node' && e.button===0 && addHeld(e) && (S.currentTool==='road' || S.currentTool==='zone' || S.currentTool==='train')) {
    let found = null;
    if (S.currentTool==='train') found = findNearestTrainEdge(e.clientX, e.clientY);
    else { const gp = raycastGround(e.clientX, e.clientY); if (gp) found = findNearestEdge(gp, 6); }
    if (found) { insertNodeOnEdge(found); dom.setPointerCapture(e.pointerId); return; }
  }
  if (S.interactionMode==='node' && e.button===0 && !addHeld(e) && S.lastGroundClick
      && (performance.now()-S.lastGroundClick.time)<350
      && Math.hypot(e.clientX-S.lastGroundClick.x, e.clientY-S.lastGroundClick.y)<DOUBLE_SLOP
      && (S.currentTool==='road' || S.currentTool==='zone' || S.currentTool==='train')) {
    S.lastGroundClick = null;
    finishActiveDrawing();
    dom.setPointerCapture(e.pointerId);
    return;
  }
  // with a prop following the cursor under g/r/s, a press is the answer to that and nothing else: left leaves it where it
  // is, right puts it back (the same bargain as a map image's transform, above)
  if (S.objectTransform) {
    if (e.button===2) cancelObjectTransform();
    else if (e.button===0) confirmObjectTransform();
    dom.setPointerCapture(e.pointerId);
    return;
  }
  pointerDown = { x:e.clientX, y:e.clientY, button:e.button, time:performance.now() };
  S.draggedNode = null;
  rightClickTarget = null;
  isCameraDragging = false;
  if (e.button===0) startLongPress(e);
  if (e.button===1) {
    isCameraDragging = true;
    dragMode = e.shiftKey ? 'pan' : 'orbit';
  } else if (e.button===0) {
    if (S.interactionMode==='move') {
      isCameraDragging = true;
      dragMode = e.shiftKey ? 'pan' : 'orbit';
    } else if (S.currentTool==='objects') {
      // with the palette armed every press is about putting one down (on the way back up), so nothing gets picked up;
      // otherwise a press on a prop drags it, and alt drags a copy of it instead
      const gp = S.placingType ? null : raycastGround(e.clientX, e.clientY);
      const hit = gp && pickObjectAt(e.clientX, e.clientY);
      // the prop itself moves it, the ring round it turns it — so the ring only gets the press when there's no prop under
      // the cursor to take instead, and a prop standing on someone else's ring is still just a prop you can pick up
      const ringId = !hit && gp ? pickObjectRing(gp) : null;
      if (hit) S.draggedNode = startObjectDrag(hit, gp, e.altKey);
      else if (ringId) S.draggedNode = startObjectTurn(ringId, gp);
      else { isCameraDragging = true; dragMode = e.shiftKey ? 'pan' : 'orbit'; }
    } else {
      const picked = pickNodeOrHandle(e.clientX, e.clientY);
      if (picked && (picked.kind === 'road' || picked.kind === 'roadHandle')) picked.startBounds = roadNodeLinesBounds(picked.nodeId); // (see commitNodeDrag)
      if (picked) S.draggedNode = picked;
      else { isCameraDragging = true; dragMode = e.shiftKey ? 'pan' : 'orbit'; }
    }
  } else if (e.button===2 && S.interactionMode==='node' && S.currentTool!=='objects') {
    const picked = pickNodeOrHandle(e.clientX, e.clientY);
    if (picked && (picked.kind==='road' || picked.kind==='zone')) rightClickTarget = picked;
  }
  showGrabCursor();
  dom.setPointerCapture(e.pointerId);
});

dom.addEventListener('pointermove', (e) => {
  if (inControl()) return;
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if (gesture) { updateGesture(); return; }
  if (ignoreUntilRelease) return;
  if (e.pointerType!=='mouse' && dragPointerId!==null && e.pointerId!==dragPointerId) return;
  if (longPress && Math.hypot(e.clientX-longPress.x, e.clientY-longPress.y) > CLICK_SLOP) cancelLongPress();
  S.lastMouseX = e.clientX; S.lastMouseY = e.clientY;
  showAddCursor(e);
  if (hoveringClickable && S.interactionMode!=='move' && S.currentTool!=='objects') { hoveringClickable = false; objectCursor = ''; dom.style.cursor = ''; }
  if (S.objectTransform) { applyObjectTransform(raycastGround(e.clientX, e.clientY), shiftHeld(e)); return; }
  if (S.interactionMode==='maps') {
    if (S.mapTransform) { applyMapTransform(e.clientX, e.clientY, shiftHeld(e)); return; }
    if (isCameraDragging) {
      const { dx, dy } = pointerDelta(e);
      if (dragMode==='pan') controls.pan(dx, dy); else controls.orbit(dx, dy);
      return;
    }
    const hit = raycastObjects(e.clientX, e.clientY, mapImages.filter(m=>m.mesh.visible).map(m=>m.mesh.userData.plane));
    const found = hit.length ? mapImages.find(m=>m.mesh.userData.plane===hit[0].object) : null;
    setMapHover(found ? found.id : null);
    return;
  }
  if (isCameraDragging) {
    const { dx, dy } = pointerDelta(e);
    // panning takes the camera off whoever it's following; orbiting keeps it on them
    if (dragMode==='pan') { if (!controls.locked) { App.stopFollowingPerson(); App.stopFollowingBuilding(); App.stopFollowingBee(); App.stopFollowingHive(); App.stopFollowingPigeon(); } controls.pan(dx, dy); } else controls.orbit(dx, dy);
    return;
  }
  if (S.draggedNode) {
    if (S.draggedNode.kind==='object') { dragObjectTo(S.draggedNode, raycastGround(e.clientX, e.clientY)); return; }
    if (S.draggedNode.kind==='objectTurn') { turnObjectTo(S.draggedNode, raycastGround(e.clientX, e.clientY), shiftHeld(e)); return; }
    if ((S.draggedNode.kind==='road' || S.draggedNode.kind==='roadHandle') && isTrainNode(S.draggedNode.nodeId)) { dragTrainPoint(e); return; }
    const gp = raycastGround(e.clientX, e.clientY);
    if (gp) {
      if (S.draggedNode.kind==='road') {
        const n = roadNodes[S.draggedNode.nodeId];
        const sp = snapPointToGrid(gp, 'road');
        const dx=sp.x-n.x, dz=sp.z-n.z;
        if (!dx && !dz) return; // (still on the same grid point: nothing to rebuild)
        n.x=sp.x; n.z=sp.z;
        if (n.type==='spline') {
          if (n.handleIn) { n.handleIn.x+=dx; n.handleIn.z+=dz; }
          if (n.handleOut) { n.handleOut.x+=dx; n.handleOut.z+=dz; }
        }
        moveRoadDragPreview(S.draggedNode); // (the roads themselves are only rebuilt once it's let go of)
      } else if (S.draggedNode.kind==='roadHandle') {
        const n = roadNodes[S.draggedNode.nodeId];
        n[S.draggedNode.which] = gp;
        moveRoadDragPreview(S.draggedNode);
      } else if (S.draggedNode.kind==='zone') {
        const zone=S.zones.find(z=>z.id===S.draggedNode.zoneId);
        if (zone) {
          const p = zone.points[S.draggedNode.index];
          const sp = snapPointToGrid(gp, 'zone');
          const dx=sp.x-p.x, dz=sp.z-p.z;
          p.x=sp.x; p.z=sp.z;
          if (p.type==='spline') {
            if (p.handleIn) { p.handleIn.x+=dx; p.handleIn.z+=dz; }
            if (p.handleOut) { p.handleOut.x+=dx; p.handleOut.z+=dz; }
          }
          rebuildZoneVisual(zone);
        }
      } else if (S.draggedNode.kind==='zoneHandle') {
        const zone=S.zones.find(z=>z.id===S.draggedNode.zoneId);
        if (zone) {
          const p = zone.points[S.draggedNode.index];
          p[S.draggedNode.which] = gp;
          rebuildZoneVisual(zone);
        }
      }
    }
    return;
  }

  if (S.interactionMode==='move') {
    previewLine.visible = false;
    insertPreviewMarker.visible = false;
    setHover(null);
    const overClickable = !App.isInsideBuilding() && (App.pickPerson(e.clientX, e.clientY) >= 0 || App.pickCar(e.clientX, e.clientY) >= 0 || App.pickTrain(e.clientX, e.clientY) >= 0
      || !!App.pickPlane(e.clientX, e.clientY) || !!App.pickBee(e.clientX, e.clientY) || !!App.pickHive(e.clientX, e.clientY) || !!App.pickPigeon(e.clientX, e.clientY)
      || !!App.pickBuilding(e.clientX, e.clientY));
    if (overClickable !== hoveringClickable) { hoveringClickable = overClickable; dom.style.cursor = overClickable ? 'pointer' : ''; }
    return;
  }
  if (S.currentTool==='objects') {
    previewLine.visible = false;
    insertPreviewMarker.visible = false;
    setHover(null);
    // with something armed the ghost shows where it would land and which way it would look; otherwise the cursor says
    // whether there's a prop under it to pick up, or a ring to take hold of and turn
    if (S.placingType) {
      moveObjectGhost(raycastGround(e.clientX, e.clientY));
      if (objectCursor) { objectCursor = ''; hoveringClickable = false; dom.style.cursor = ''; }
    } else {
      const overProp = !!pickObjectAt(e.clientX, e.clientY);
      const overRing = !overProp && !!pickObjectRing(raycastGround(e.clientX, e.clientY));
      const want = overProp ? 'pointer' : overRing ? 'grab' : '';
      if (want !== objectCursor) { objectCursor = want; hoveringClickable = !!want; dom.style.cursor = want; }
    }
    return;
  }

  if (addHeld(e) && (S.currentTool==='road' || S.currentTool==='zone' || S.currentTool==='train')) {
    previewLine.visible = false;
    // over a path's node (when not drawing), a click would branch from it, so it's the node that lights up
    if (S.currentTool!=='zone' && !S.activeRoadLine) {
      const nodeHits = raycastObjects(e.clientX, e.clientY, S.roadMarkerGroup.children);
      if (nodeHits.length) { setHover(nodeHits[0].object); insertPreviewMarker.visible = false; S.pendingInsert = null; return; }
    }
    setHover(null);
    let found = null;
    if (S.currentTool==='train') found = findNearestTrainEdge(e.clientX, e.clientY);
    else { const gp = raycastGround(e.clientX, e.clientY); if (gp) found = findNearestEdge(gp, 6); }
    if (found) { updateInsertPreviewGeometry(found.point, found.angle); insertPreviewMarker.visible = true; S.pendingInsert = found; }
    else { insertPreviewMarker.visible = false; S.pendingInsert = null; }
    return;
  }
  insertPreviewMarker.visible = false;
  S.pendingInsert = null;

  const hoverList = (S.roadMarkerGroup.visible ? S.roadMarkerGroup.children : [])
    .concat(S.roadHandleGroup.visible ? S.roadHandleGroup.children.filter(c=>c.userData && c.userData.handleKind) : [])
    .concat(shownZoneMarkers().filter(c=>c.userData.vertexIndex!==undefined || c.userData.handleKind));
  const hoverHits = raycastObjects(e.clientX, e.clientY, hoverList);
  setHover(hoverHits.length ? hoverHits[0].object : null);

  if (S.currentTool==='train' && S.activeRoadLine) {
    // preview the next tube segment level with the last node, where the cursor meets that height
    const from = roadNodes[S.activeRoadLine.nodeIds[S.activeRoadLine.nodeIds.length-1]];
    const to = from ? snapPointToGrid(trainPlanePoint(e.clientX, e.clientY, trainNodeY(from)), 'road') : null;
    if (to) {
      setLinePoints(previewLine.geometry, [new THREE.Vector3(from.x,trainNodeY(from),from.z), new THREE.Vector3(to.x,trainNodeY(from),to.z)]);
      previewLine.visible = true;
    }
  } else if ((S.currentTool==='road' && S.activeRoadLine) || (S.currentTool==='zone' && S.activeZone)) {
    const gp = snapPointToGrid(raycastGround(e.clientX, e.clientY), S.currentTool);
    if (gp) {
      let from;
      if (S.currentTool==='road') { const lastId = S.activeRoadLine.nodeIds[S.activeRoadLine.nodeIds.length-1]; from = roadNodes[lastId]; }
      else { from = S.activeZone.points[S.activeZone.points.length-1]; }
      if (from) {
        setLinePoints(previewLine.geometry, [new THREE.Vector3(from.x,Y_PREVIEW,from.z), new THREE.Vector3(gp.x,Y_PREVIEW,gp.z)]);
        previewLine.visible = true;
      }
    }
  } else {
    previewLine.visible = false;
  }
});

// the last of the fingers lifting ends whatever gesture they were making
function releasePointer(e) {
  activePointers.delete(e.pointerId);
  if (gesture && activePointers.size < 2) gesture = null;
  if (activePointers.size === 0) { ignoreUntilRelease = false; dragPointerId = null; }
}
// Everything the camera can follow in World mode (see ui/entity-card.js), so a click on one of them lets go of all the
// rest — a new kind of thing need only be named here, and export stopFollowing<its name> on App.
const FOLLOWABLE = ['Person', 'Car', 'Train', 'Plane', 'Bee', 'Hive', 'Pigeon', 'Building'];
const letGoOfAllBut = kept => FOLLOWABLE.forEach(kind => { if (kind !== kept) App['stopFollowing' + kind](); });
App.letGoOfAllBut = letGoOfAllBut; // (for the favorites too: see ui/favorites.js)
// Each followable kind's picker, and whether what it returned is a hit. Every picker takes an `out` it gives the hit's
// distance from the camera, so the nearest hit of any kind wins (a far-off person on the same line of sight as a car
// clicked up close mustn't take the click from it).
const FOLLOW_PICKERS = [
  { kind: 'Bee',    isHit: hit => !!hit,   pick: (x, y, out) => App.pickBee(x, y, out) },
  { kind: 'Pigeon', isHit: hit => !!hit,   pick: (x, y, out) => App.pickPigeon(x, y, out) },
  { kind: 'Person', isHit: hit => hit >= 0, pick: (x, y, out) => App.pickPerson(x, y, out) },
  { kind: 'Car',    isHit: hit => hit >= 0, pick: (x, y, out) => App.pickCar(x, y, out) },
  { kind: 'Train',  isHit: hit => hit >= 0, pick: (x, y, out) => App.pickTrain(x, y, out) },
  { kind: 'Plane',  isHit: hit => !!hit,   pick: (x, y, out) => App.pickPlane(x, y, out) },
  { kind: 'Hive',   isHit: hit => !!hit,   pick: (x, y, out) => App.pickHive(x, y, out) },
];
/**
 * The kind of whatever followable thing is nearest the camera under a point on the screen.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {?string} its kind, as FOLLOWABLE names it, or null if nothing's there
 */
function pickNearestFollowable(clientX, clientY) {
  let nearestKind = null, nearestDistance = Infinity;
  for (const { kind, isHit, pick } of FOLLOW_PICKERS) {
    const out = { distance: Infinity };
    if (isHit(pick(clientX, clientY, out)) && out.distance < nearestDistance) { nearestKind = kind; nearestDistance = out.distance; }
  }
  return nearestKind;
}

dom.addEventListener('pointercancel', (e) => {
  releasePointer(e); cancelLongPress();
  pointerDown = null; isCameraDragging = false; S.draggedNode = null;
  showGrabCursor();
});
dom.addEventListener('pointerup', (e) => {
  const spent = !!gesture || ignoreUntilRelease || (longPress && longPress.fired); // a gesture or a held press: no click in it
  releasePointer(e);
  cancelLongPress();
  const was = pointerDown; pointerDown=null;
  const camDrag = isCameraDragging; isCameraDragging=false;
  const dn = S.draggedNode; S.draggedNode=null;
  showGrabCursor();
  if (spent || !was || inControl()) return;
  if (S.interactionMode==='maps') {
    // on touch a map transform is dragged out rather than confirmed with a second click (see pointerdown)
    if (S.mapTransform && S.touchMapMode) confirmMapTransform();
    return; // otherwise selection/transform is already handled on pointerdown/pointermove
  }
  const dist = Math.hypot(e.clientX-was.x, e.clientY-was.y);
  const dt = performance.now()-was.time;

  if (camDrag) {
    if (was.button===0 && dist<CLICK_SLOP && dt<600 && S.interactionMode==='node') {
      handleLeftClick(e.clientX, e.clientY);
      S.lastGroundClick = { x:e.clientX, y:e.clientY, time:performance.now() };
    } else if (was.button===0 && dist<CLICK_SLOP && dt<600 && S.interactionMode==='move' && !App.isInsideBuilding()) {
      // a click on someone or something has the camera follow them; anywhere else lets go of both
      // (not from inside a building, where the view's held in the room until Leave: see buildings/interior.js)
      const kind = pickNearestFollowable(e.clientX, e.clientY) ?? 'Building';
      letGoOfAllBut(kind);
      App['follow' + kind + 'At'](e.clientX, e.clientY);
    }
    return;
  }

  if (dn) {
    if (dn.kind==='object') {
      if (dist<CLICK_SLOP && dt<600 && !dn.copied) clickObject(dn.id); // a second click on the same prop deletes it
      return;
    }
    if (dn.kind==='objectTurn') { endObjectTurn(); return; }
    if (dist<CLICK_SLOP && dt<600) {
      if (dn.kind==='road') {
        if (S.activeRoadLine) {
          const ids = S.activeRoadLine.nodeIds, line = S.activeRoadLine;
          if (dn.nodeId !== ids[ids.length-1]) {
            ids.push(dn.nodeId);
            S.activeRoadLine.drawing = false;
            const kind = networkKindOf(line), drawn = ids.slice();
            const merged = mergeActiveRoadLineInto(dn.nodeId);
            S.activeRoadLine = null;
            endDrawingPreview(); rebuildRoadMeshes(); zonesNearPath(drawn, line).forEach(subdivideZone);
            selectItem(kind, (merged || line).networkId, true);
          } else if (isTrainLine(line)) rebuildRoadMeshes();
          else showDrawingPreview(line);
          renderHierarchy();
        } else if (S.lastNodeClick && S.lastNodeClick.kind==='road' && S.lastNodeClick.nodeId===dn.nodeId && (performance.now()-S.lastNodeClick.time)<350) {
          S.lastNodeClick = null;
          deleteRoadNode(dn.nodeId);
        } else {
          S.lastNodeClick = { kind:'road', nodeId: dn.nodeId, time: performance.now() };
          const lines = S.roadLines.filter(l => l.nodeIds.includes(dn.nodeId));
          const line = lines.find(l => pathTypeOf(l)===currentPathType()) || lines[0];
          if (line) selectItem(networkKindOf(line), line.networkId);
        }
      } else if (dn.kind==='zone') {
        const zone = S.zones.find(z=>z.id===dn.zoneId);
        if (zone) {
          if (S.activeZone && zone.id===S.activeZone.id && dn.index===0 && S.activeZone.points.length>=3) {
            closeActiveZone();
          } else if (!S.activeZone) {
            if (S.lastNodeClick && S.lastNodeClick.kind==='zone' && S.lastNodeClick.zoneId===dn.zoneId && S.lastNodeClick.index===dn.index && (performance.now()-S.lastNodeClick.time)<350) {
              S.lastNodeClick = null;
              deleteZoneVertex(zone, dn.index);
            } else {
              S.lastNodeClick = { kind:'zone', zoneId: dn.zoneId, index: dn.index, time: performance.now() };
              selectItem('zone', zone.id);
            }
          }
        }
      }
      // roadHandle / zoneHandle: a bare click on a handle does nothing
    } else {
      commitNodeDrag(dn);
    }
    return;
  }

  if (dist<CLICK_SLOP && dt<600) {
    if (was.button===0) {
      handleLeftClick(e.clientX, e.clientY);
      S.lastGroundClick = { x:e.clientX, y:e.clientY, time:performance.now() };
    }
    else if (was.button===2) {
      const rct = rightClickTarget; rightClickTarget = null;
      if (rct) App.showNodeContextMenu(e.clientX, e.clientY, rct);
      else cancelActiveDrawing();
    }
  }
});
// No browser right-click menu anywhere but text fields: on Windows it opens when the button comes up — after a right-click on
// a node has already opened the node menu under the cursor, so it lands on that rather than the view (on a Mac it opens as
// the button goes down, while the view's still under the cursor)
document.addEventListener('contextmenu', (e) => {
  const field = e.target.closest && e.target.closest('input, textarea');
  if (!field || ['range', 'checkbox', 'color', 'button', 'file'].includes(field.type)) e.preventDefault();
});
dom.addEventListener('wheel', (e)=>{ e.preventDefault(); controls.zoom(e.deltaY); }, { passive:false });
window.addEventListener('keydown', (e) => {
  // undo / redo — everywhere except while typing into a text field (a slider or color input still being focused is fine)
  const focused = document.activeElement;
  const typing = focused && (focused.tagName === 'TEXTAREA' || (focused.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button', 'file'].includes(focused.type)));
  const key = e.key.toLowerCase();
  if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
    e.preventDefault();
    if (key === 'y' || e.shiftKey) App.redo(); else App.undo();
    return;
  }
  if (document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (S.interactionMode==='maps') {
    const key = e.key.toLowerCase();
    if (key==='escape') cancelMapTransform();
    else if (key==='enter') confirmMapTransform();
    else if ((key==='g' || key==='r' || key==='s') && S.selectedMapId) {
      const mode = key==='g' ? 'translate' : key==='r' ? 'rotate' : 'scale';
      if (S.mapTransform && S.mapTransform.mode===mode) confirmMapTransform();
      else { cancelMapTransform(); startMapTransform(mode, S.lastMouseX, S.lastMouseY); }
    }
    else if (key==='7') controls.snapTop();
    else if (key==='1') controls.snapFront();
    else if (key==='3') controls.snapRight();
    return;
  }
  if ((e.key==='Delete' || e.key==='Backspace') && S.currentTool==='objects' && S.selectedObjectId) { removeObject(S.selectedObjectId); return; }
  if (S.currentTool==='objects' && S.selectedObjectId && (key==='g' || key==='r' || key==='s')) {
    const mode = key==='g' ? 'translate' : key==='r' ? 'rotate' : 'scale';
    if (S.objectTransform && S.objectTransform.mode===mode) confirmObjectTransform(); // the same key again leaves it there
    else { cancelObjectTransform(); startObjectTransform(mode, raycastGround(S.lastMouseX, S.lastMouseY)); }
    return;
  }
  if (e.key==='Escape' && App.isInsideBuilding()) App.leaveBuildingInside();
  else if (e.key==='Escape') { App.hideContextMenu(); cancelActiveDrawing(); }
  else if (e.key==='Enter') finishActiveDrawing();
  else if (e.key==='7') controls.snapTop();
  else if (e.key==='1') controls.snapFront();
  else if (e.key==='3') controls.snapRight();
});

// Holding cmd in Paths or Zones — where a click adds a node to an edge, or branches off a path's node — shows a cursor
// with a plus.
function showAddCursor(e) {
  dom.classList.toggle('adding', !!e && cmdKey(e) && S.interactionMode==='node'
    && (S.currentTool==='road' || S.currentTool==='train' || S.currentTool==='zone'));
}
const ADD_KEYS = ['Meta', 'Control'];
window.addEventListener('keydown', (e) => { if (ADD_KEYS.includes(e.key)) showAddCursor(e); });
window.addEventListener('keyup', (e) => { if (ADD_KEYS.includes(e.key)) showAddCursor(e); });
window.addEventListener('blur', () => showAddCursor(null));

// Starts drawing a new line out from an existing node, as a branch of that node's network, just like it: the same type,
// width and colors (or, for a train line, tube radius). It's finished, joined onto another node, or cancelled as any line
// being drawn is.
function startBranchFrom(nodeId) {
  // (a node a walkway shares with a road branches as whichever the Paths tab is on)
  const lines = S.roadLines.filter(l => !l.drawing && l.nodeIds.includes(nodeId));
  const source = lines.find(l => pathTypeOf(l)===currentPathType()) || lines[0];
  if (!source) return;
  const { networkId } = source;
  const line = isTrainLine(source)
    ? { id:'train-'+(S.roadLineSeq++), kind:'train', nodeIds:[nodeId], drawing:true, radius: source.radius, networkId }
    : { id:'road-'+(S.roadLineSeq++), nodeIds:[nodeId], drawing:true, width: source.width, color: source.color,
        sidewalkWidth: source.sidewalkWidth, sidewalkColor: source.sidewalkColor, roadType: source.roadType, walkwayColor: source.walkwayColor,
        walkwayTexture: source.walkwayTexture, walkwayTextureScale: source.walkwayTextureScale, walkwayTextureRotation: source.walkwayTextureRotation,
        raisedHeight: source.raisedHeight, raisedTrees: source.raisedTrees, raisedBenches: source.raisedBenches, raisedLights: source.raisedLights, networkId };
  S.roadLines.push(line);
  S.activeRoadLine = line;
  S.lastGroundClick = null;
  insertPreviewMarker.visible = false;
  S.pendingInsert = null;
  selectItem(networkKindOf(source), networkId, true);
  if (isTrainLine(line)) rebuildRoadMeshes(); else showDrawingPreview(line);
}

// Ends the line being drawn on an existing node: merged into the line it ends if that's the node's end, else a branch.
// Back onto one of its own nodes (other than closing a loop on its first) it ends where it is, and drawing carries on
// from that node as a branch — so the node becomes a junction instead of the line doubling back through it.
function finishOnNode(nodeId) {
  const ids = S.activeRoadLine.nodeIds, at = ids.indexOf(nodeId);
  if (nodeId !== ids[ids.length-1] && (at > 0 || at === 0 && ids.length < 3)) {
    const line = S.activeRoadLine;
    line.drawing = false;
    S.activeRoadLine = null;
    startBranchFrom(nodeId);
    S.zones.forEach(subdivideZone); renderHierarchy();
    return;
  }
  if (nodeId !== ids[ids.length-1]) {
    ids.push(nodeId);
    S.activeRoadLine.drawing = false;
    const line = S.activeRoadLine, kind = networkKindOf(line);
    const merged = mergeActiveRoadLineInto(nodeId);
    S.activeRoadLine = null;
    selectItem(kind, (merged || line).networkId, true);
  }
  rebuildRoadMeshes(); S.zones.forEach(subdivideZone); renderHierarchy();
}

// Join toggle (#join-toggle, beside the grid magnet): whether pathNodeUnder joins roads onto paths; remembered.
const SNAP_TO_PATHS_KEY = 'splinetopia.snapToPaths';
let snapToPaths = true;
try { snapToPaths = localStorage.getItem(SNAP_TO_PATHS_KEY) !== '0'; } catch {}
const joinToggle = document.getElementById('join-toggle');
joinToggle.classList.toggle('active', snapToPaths);
joinToggle.addEventListener('click', () => {
  snapToPaths = !snapToPaths;
  joinToggle.classList.toggle('active', snapToPaths);
  try { localStorage.setItem(SNAP_TO_PATHS_KEY, snapToPaths ? '1' : '0'); } catch {}
});

// A click on another path of the same type's surface: the node it should join there — that path's node if one's within
// its half-width of the click, else a new node on its edge — so the two meet at a junction instead of just overlapping
// (lanes and junctions only link at shared nodes). Null if the click isn't on one.
function pathNodeUnder(gp) {
  if (!snapToPaths) return null;
  const found = findNearestEdge(gp, 0, S.activeRoadLine);
  if (!found || found.kind!=='road') return null;
  const reach = roadLineWidths(found.line).hw, ids = found.line.nodeIds;
  if (found.dist > reach) return null;
  const nearest = [ids[found.index], ids[found.index+1]]
    .map(id => ({ id, d: Math.hypot(roadNodes[id].x-gp.x, roadNodes[id].z-gp.z) }))
    .sort((a, b) => a.d-b.d)[0];
  if (nearest.d <= reach) return nearest.id;
  const pt = snapPointToGrid(found.point, 'road'), id = 'n'+(S.roadNodeSeq++);
  roadNodes[id] = { x:pt.x, z:pt.z, type:'poly', handleIn:null, handleOut:null };
  ids.splice(found.index+1, 0, id);
  return id;
}

// Ends the line being drawn on an existing node: merged into the line it ends if that's the node's end, else a branch.
// Back onto one of its own nodes (other than closing a loop on its first) it ends where it is, and drawing carries on
// from that node as a branch — so the node becomes a junction instead of the line doubling back through it.
function finishOnNode(nodeId) {
  const ids = S.activeRoadLine.nodeIds, at = ids.indexOf(nodeId);
  if (nodeId !== ids[ids.length-1] && (at > 0 || at === 0 && ids.length < 3)) {
    const line = S.activeRoadLine;
    line.drawing = false;
    S.activeRoadLine = null;
    startBranchFrom(nodeId);
    S.zones.forEach(subdivideZone); renderHierarchy();
    return;
  }
  if (nodeId !== ids[ids.length-1]) {
    ids.push(nodeId);
    S.activeRoadLine.drawing = false;
    const line = S.activeRoadLine, kind = networkKindOf(line);
    const merged = mergeActiveRoadLineInto(nodeId);
    S.activeRoadLine = null;
    selectItem(kind, (merged || line).networkId, true);
  }
  rebuildRoadMeshes(); S.zones.forEach(subdivideZone); renderHierarchy();
}

// Join toggle (#join-toggle, beside the grid magnet): whether pathNodeUnder joins roads onto paths; remembered.
const SNAP_TO_PATHS_KEY = 'splinetopia.snapToPaths';
let snapToPaths = true;
try { snapToPaths = localStorage.getItem(SNAP_TO_PATHS_KEY) !== '0'; } catch {}
const joinToggle = document.getElementById('join-toggle');
joinToggle.classList.toggle('active', snapToPaths);
joinToggle.addEventListener('click', () => {
  snapToPaths = !snapToPaths;
  joinToggle.classList.toggle('active', snapToPaths);
  try { localStorage.setItem(SNAP_TO_PATHS_KEY, snapToPaths ? '1' : '0'); } catch {}
});

// A click on another path of the same type's surface: the node it should join there — that path's node if one's within
// its half-width of the click, else a new node on its edge — so the two meet at a junction instead of just overlapping
// (lanes and junctions only link at shared nodes). Null if the click isn't on one.
function pathNodeUnder(gp) {
  if (!snapToPaths) return null;
  const found = findNearestEdge(gp, 0, S.activeRoadLine);
  if (!found || found.kind!=='road') return null;
  const reach = roadLineWidths(found.line).hw, ids = found.line.nodeIds;
  if (found.dist > reach) return null;
  const nearest = [ids[found.index], ids[found.index+1]]
    .map(id => ({ id, d: Math.hypot(roadNodes[id].x-gp.x, roadNodes[id].z-gp.z) }))
    .sort((a, b) => a.d-b.d)[0];
  if (nearest.d <= reach) return nearest.id;
  const pt = snapPointToGrid(found.point, 'road'), id = 'n'+(S.roadNodeSeq++);
  roadNodes[id] = { x:pt.x, z:pt.z, type:'poly', handleIn:null, handleOut:null };
  ids.splice(found.index+1, 0, id);
  return id;
}

// Only a line of the same type is joined: a walkway finished on a road's node shares that node but stays a network of
// its own, or it could no longer be picked as a walkway.
function mergeActiveRoadLineInto(sharedNodeId) {
  const type = pathTypeOf(S.activeRoadLine);
  const targetLine = S.roadLines.find(l => l.id !== S.activeRoadLine.id && l.nodeIds.includes(sharedNodeId) && pathTypeOf(l)===type);
  if (!targetLine) return null;
  const tIdx = targetLine.nodeIds.indexOf(sharedNodeId);
  const isEndpoint = (tIdx === 0 || tIdx === targetLine.nodeIds.length-1);
  if (!isEndpoint) {
    // mid-road branch: keep as a separate line (can't collapse a branch into one ordered path),
    // but join the same network so it's grouped and highlighted together.
    S.activeRoadLine.networkId = targetLine.networkId;
    return { branched: true, networkId: targetLine.networkId };
  }
  const activeIds = S.activeRoadLine.nodeIds; // already ends with sharedNodeId
  if (tIdx === targetLine.nodeIds.length-1) {
    targetLine.nodeIds = targetLine.nodeIds.concat(activeIds.slice(0,-1).reverse());
  } else {
    targetLine.nodeIds = activeIds.concat(targetLine.nodeIds.slice(1));
  }
  S.roadLines = S.roadLines.filter(l => l.id !== S.activeRoadLine.id);
  return targetLine;
}
function handleLeftClick(x,y) {
  let gp = raycastGround(x,y);
  if (!gp) return;
  if (S.currentTool==='road') {
    const joinId = pathNodeUnder(gp); // (clicked on another path: joined there, as a junction)
    if (joinId) {
      if (S.activeRoadLine) finishOnNode(joinId);
      else startBranchFrom(joinId);
      return;
    }
    gp = snapPointToGrid(gp, 'road');
    const id = 'n'+(S.roadNodeSeq++);
    roadNodes[id] = { x:gp.x, z:gp.z, type:'poly', handleIn:null, handleOut:null };
    if (S.activeRoadLine) { S.activeRoadLine.nodeIds.push(id); }
    else {
      const templateLine = S.lastSelectedRoadNetworkId ? S.roadLines.find(l=>l.networkId===S.lastSelectedRoadNetworkId) : null;
      const width = templateLine ? templateLine.width : S.DEFAULT_ROAD_WIDTH;
      const color = templateLine ? templateLine.color : ROAD_COLOR;
      const sidewalkWidth = templateLine && templateLine.sidewalkWidth!=null ? templateLine.sidewalkWidth : S.DEFAULT_SIDEWALK_WIDTH;
      const sidewalkColor = templateLine && templateLine.sidewalkColor!=null ? templateLine.sidewalkColor : SIDEWALK_COLOR;
      const roadType = S.newRoadType; // (from the Paths tab's Type menu)
      const walkwayColor = templateLine && templateLine.walkwayColor!=null ? templateLine.walkwayColor : WALKWAY_COLOR;
      const { walkwayTexture, walkwayTextureScale, walkwayTextureRotation } = templateLine || {};
      // (a raised walkway takes the height and furniture of the last one selected, if that was one)
      const { raisedHeight, raisedTrees, raisedBenches, raisedLights } = templateLine && templateLine.roadType === 'raised' ? templateLine : {};
      const line={ id:'road-'+(S.roadLineSeq++), nodeIds:[id], drawing:true, width, color, sidewalkWidth, sidewalkColor, roadType, walkwayColor,
        walkwayTexture, walkwayTextureScale, walkwayTextureRotation, raisedHeight, raisedTrees, raisedBenches, raisedLights, networkId:'net-'+(S.roadNetworkSeq++) };
      S.roadLines.push(line); S.activeRoadLine=line;
    }
    showDrawingPreview(S.activeRoadLine); renderHierarchy(); // (the line's built when it's finished)
  } else if (S.currentTool==='train') {
    // a new node goes where the cursor meets the height of the line so far (or the default height, for a new line)
    const last = S.activeRoadLine ? roadNodes[S.activeRoadLine.nodeIds[S.activeRoadLine.nodeIds.length-1]] : null;
    const height = last ? trainNodeY(last) : S.TRAIN_DEFAULT_HEIGHT;
    const pt = snapPointToGrid(trainPlanePoint(x, y, height), 'road');
    if (!pt) return;
    const id = 'n'+(S.roadNodeSeq++);
    roadNodes[id] = { x:pt.x, y:height, z:pt.z, type:'poly', handleIn:null, handleOut:null };
    if (S.activeRoadLine) { S.activeRoadLine.nodeIds.push(id); }
    else {
      const templateLine = S.lastSelectedTrainNetworkId ? S.roadLines.find(l=>l.networkId===S.lastSelectedTrainNetworkId) : null;
      const radius = templateLine && templateLine.radius ? templateLine.radius : S.TRAIN_DEFAULT_RADIUS;
      const line = { id:'train-'+(S.roadLineSeq++), kind:'train', nodeIds:[id], drawing:true, radius, networkId:'rail-'+(S.roadNetworkSeq++) };
      S.roadLines.push(line); S.activeRoadLine=line;
    }
    rebuildRoadMeshes(); renderHierarchy();
  } else if (S.currentTool==='objects') {
    // with nothing armed a click on empty ground just lets go of whatever was selected
    if (!S.placingType) { selectObject(null); return; }
    addObject(S.placingType, snapPointToGrid(gp, 'object'));
    return; // and the palette stays armed: one click, one more of them, until Esc
  } else if (S.currentTool==='zone') {
    gp = snapPointToGrid(gp, 'zone');
    const point = { x:gp.x, z:gp.z, type:'poly', handleIn:null, handleOut:null };
    if (S.activeZone) { S.activeZone.points.push(point); rebuildZoneVisual(S.activeZone); }
    else {
      const templateZone = S.lastSelectedZoneId ? S.zones.find(z=>z.id===S.lastSelectedZoneId) : null;
      const zoneType = templateZone ? templateZone.zoneType : 'buildings';
      const baseSettings = templateZone ? templateZone.settings : DEFAULT_ZONE_SETTINGS;
      const zone = { id:'zone-'+(S.zoneSeq++), name:'Zone '+S.zoneSeq, points:[point], closed:false, drawing:true, zoneType,
        settings:{ ...baseSettings, seed:Math.floor(Math.random()*100000) } };
      S.zones.unshift(zone); S.activeZone=zone; rebuildZoneVisual(zone); // new zones start at the top, cutting into whatever they're drawn over
    }
    renderHierarchy();
  }
  if (IS_TOUCH) previewLine.visible = false; // nothing hovers on touch, so there's no cursor for it to stretch to
}

Object.assign(App, { raycaster, ndcOf, raycastGround });
