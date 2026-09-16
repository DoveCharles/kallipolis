import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { camera, renderer, snapPointToGrid, Y_PREVIEW } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { ROAD_COLOR } from '../core/splines.js';
import { roadNodes, mapImages, DEFAULT_ZONE_SETTINGS } from '../core/state.js';
import { setSelectedMap, setMapHover, startMapTransform, applyMapTransform, confirmMapTransform, cancelMapTransform, previewLine } from '../maps/map-images.js';
import { SIDEWALK_COLOR, setLinePoints } from '../roads/roads.js';
import { PATH_COLOR, rebuildRoadMeshes } from '../roads/paths.js';
import { isTrainLine, isTrainNode, networkKindOf, trainNodeY, trainPlanePoint, dragTrainPoint, findNearestTrainEdge } from '../trains/trains.js';
import { setHover, insertPreviewMarker, updateInsertPreviewGeometry, findNearestEdge, insertNodeOnEdge } from './hover.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { subdivideZone, subdivideZonesFrom } from '../zones/cutouts.js';
import { selectItem, deleteRoadNode, deleteZoneVertex, renderHierarchy } from '../ui/panels.js';
import { cancelActiveDrawing, closeActiveZone, finishActiveDrawing } from './tools.js';

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
S.draggedNode = null; // {kind:'road'|'roadHandle'|'zone'|'zoneHandle', ...}
S.pendingInsert = null; // edge insertion candidate while shift is held
S.lastGroundClick = null; // {x,y,time} for double-click-to-finish detection
S.lastNodeClick = null; // {kind,nodeId|zoneId+index,time} for double-click-to-delete detection
let rightClickTarget = null; // node/vertex hit under a right-click, for the context menu
let hoveringClickable = false; // the cursor's over someone or something a click would follow (World mode), and shows it

const dom = renderer.domElement;
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
  if (S.interactionMode==='maps') {
    if (S.mapTransform) {
      if (e.button===2) cancelMapTransform();
      else if (e.button===0) confirmMapTransform();
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
  // shift+click a path's node (when not already drawing): a new branch, drawn out from it
  if (S.interactionMode==='node' && e.button===0 && e.shiftKey && (S.currentTool==='road' || S.currentTool==='train') && !S.activeRoadLine) {
    const picked = pickNodeOrHandle(e.clientX, e.clientY);
    if (picked && picked.kind==='road') { startBranchFrom(picked.nodeId); dom.setPointerCapture(e.pointerId); return; }
  }
  if (S.interactionMode==='node' && e.button===0 && e.shiftKey && (S.currentTool==='road' || S.currentTool==='zone' || S.currentTool==='train')) {
    let found = null;
    if (S.currentTool==='train') found = findNearestTrainEdge(e.clientX, e.clientY);
    else { const gp = raycastGround(e.clientX, e.clientY); if (gp) found = findNearestEdge(gp, 6); }
    if (found) { insertNodeOnEdge(found); dom.setPointerCapture(e.pointerId); return; }
  }
  if (S.interactionMode==='node' && e.button===0 && !e.shiftKey && S.lastGroundClick
      && (performance.now()-S.lastGroundClick.time)<350
      && Math.hypot(e.clientX-S.lastGroundClick.x, e.clientY-S.lastGroundClick.y)<10
      && (S.currentTool==='road' || S.currentTool==='zone' || S.currentTool==='train')) {
    S.lastGroundClick = null;
    finishActiveDrawing();
    dom.setPointerCapture(e.pointerId);
    return;
  }
  pointerDown = { x:e.clientX, y:e.clientY, button:e.button, time:performance.now() };
  S.draggedNode = null;
  rightClickTarget = null;
  isCameraDragging = false;
  if (e.button===1) {
    isCameraDragging = true;
    dragMode = e.shiftKey ? 'pan' : 'orbit';
  } else if (e.button===0) {
    // (the Objects tab has nothing to pick yet, so it only moves the camera)
    if (S.interactionMode==='move' || S.currentTool==='objects') {
      isCameraDragging = true;
      dragMode = e.shiftKey ? 'pan' : 'orbit';
    } else {
      const picked = pickNodeOrHandle(e.clientX, e.clientY);
      if (picked) S.draggedNode = picked;
      else { isCameraDragging = true; dragMode = e.shiftKey ? 'pan' : 'orbit'; }
    }
  } else if (e.button===2 && S.interactionMode==='node' && S.currentTool!=='objects') {
    const picked = pickNodeOrHandle(e.clientX, e.clientY);
    if (picked && (picked.kind==='road' || picked.kind==='zone')) rightClickTarget = picked;
  }
  dom.setPointerCapture(e.pointerId);
});

dom.addEventListener('pointermove', (e) => {
  S.lastMouseX = e.clientX; S.lastMouseY = e.clientY;
  showAddCursor(e.shiftKey);
  if (hoveringClickable && S.interactionMode!=='move') { hoveringClickable = false; dom.style.cursor = ''; }
  if (S.interactionMode==='maps') {
    if (S.mapTransform) { applyMapTransform(e.clientX, e.clientY, e.shiftKey); return; }
    if (isCameraDragging) {
      if (dragMode==='pan') controls.pan(e.movementX, e.movementY); else controls.orbit(e.movementX, e.movementY);
      return;
    }
    const hit = raycastObjects(e.clientX, e.clientY, mapImages.filter(m=>m.mesh.visible).map(m=>m.mesh.userData.plane));
    const found = hit.length ? mapImages.find(m=>m.mesh.userData.plane===hit[0].object) : null;
    setMapHover(found ? found.id : null);
    return;
  }
  if (isCameraDragging) {
    // panning takes the camera off whoever it's following; orbiting keeps it on them
    if (dragMode==='pan') { App.stopFollowingPerson(); controls.pan(e.movementX, e.movementY); } else controls.orbit(e.movementX, e.movementY);
    return;
  }
  if (S.draggedNode) {
    if ((S.draggedNode.kind==='road' || S.draggedNode.kind==='roadHandle') && isTrainNode(S.draggedNode.nodeId)) { dragTrainPoint(e); return; }
    const gp = raycastGround(e.clientX, e.clientY);
    if (gp) {
      if (S.draggedNode.kind==='road') {
        const n = roadNodes[S.draggedNode.nodeId];
        const sp = snapPointToGrid(gp, 'road');
        const dx=sp.x-n.x, dz=sp.z-n.z;
        n.x=sp.x; n.z=sp.z;
        if (n.type==='spline') {
          if (n.handleIn) { n.handleIn.x+=dx; n.handleIn.z+=dz; }
          if (n.handleOut) { n.handleOut.x+=dx; n.handleOut.z+=dz; }
        }
        rebuildRoadMeshes();
      } else if (S.draggedNode.kind==='roadHandle') {
        const n = roadNodes[S.draggedNode.nodeId];
        n[S.draggedNode.which] = gp;
        rebuildRoadMeshes();
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
    const overClickable = App.pickPerson(e.clientX, e.clientY) >= 0 || App.pickCar(e.clientX, e.clientY) >= 0;
    if (overClickable !== hoveringClickable) { hoveringClickable = overClickable; dom.style.cursor = overClickable ? 'pointer' : ''; }
    return;
  }
  if (S.currentTool==='objects') {
    previewLine.visible = false;
    insertPreviewMarker.visible = false;
    setHover(null);
    return;
  }

  if (e.shiftKey && (S.currentTool==='road' || S.currentTool==='zone' || S.currentTool==='train')) {
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

dom.addEventListener('pointerup', (e) => {
  const was = pointerDown; pointerDown=null;
  const camDrag = isCameraDragging; isCameraDragging=false;
  const dn = S.draggedNode; S.draggedNode=null;
  if (!was) return;
  if (S.interactionMode==='maps') return; // selection/transform already handled on pointerdown/pointermove
  const dist = Math.hypot(e.clientX-was.x, e.clientY-was.y);
  const dt = performance.now()-was.time;

  if (camDrag) {
    if (was.button===0 && dist<6 && dt<600 && S.interactionMode==='node') {
      handleLeftClick(e.clientX, e.clientY);
      S.lastGroundClick = { x:e.clientX, y:e.clientY, time:performance.now() };
    } else if (was.button===0 && dist<6 && dt<600 && S.interactionMode==='move') {
      // a click on someone or something has the camera follow them; anywhere else lets go of both
      if (App.pickPerson(e.clientX, e.clientY) >= 0) { App.stopFollowingCar(); App.followPersonAt(e.clientX, e.clientY); }
      else { App.stopFollowingPerson(); App.followCarAt(e.clientX, e.clientY); }
    }
    return;
  }

  if (dn) {
    if (dist<6 && dt<600) {
      if (dn.kind==='road') {
        if (S.activeRoadLine) {
          const ids = S.activeRoadLine.nodeIds;
          if (dn.nodeId !== ids[ids.length-1]) {
            ids.push(dn.nodeId);
            S.activeRoadLine.drawing = false;
            const kind = networkKindOf(S.activeRoadLine);
            const merged = mergeActiveRoadLineInto(dn.nodeId);
            S.activeRoadLine = null;
            if (merged) selectItem(kind, merged.networkId, true);
          }
          rebuildRoadMeshes(); S.zones.forEach(subdivideZone); renderHierarchy();
        } else if (S.lastNodeClick && S.lastNodeClick.kind==='road' && S.lastNodeClick.nodeId===dn.nodeId && (performance.now()-S.lastNodeClick.time)<350) {
          S.lastNodeClick = null;
          deleteRoadNode(dn.nodeId);
        } else {
          S.lastNodeClick = { kind:'road', nodeId: dn.nodeId, time: performance.now() };
          const line = S.roadLines.find(l => l.nodeIds.includes(dn.nodeId));
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
      if (dn.kind==='road' || dn.kind==='roadHandle') {
        const line = S.roadLines.find(l => l.nodeIds.includes(dn.nodeId));
        rebuildRoadMeshes();
        if (!line || !isTrainLine(line)) S.zones.forEach(subdivideZone); // trains don't affect zones
        if (line) selectItem(networkKindOf(line), line.networkId, true); else renderHierarchy();
      } else if (dn.kind==='zone' || dn.kind==='zoneHandle') {
        const zone=S.zones.find(z=>z.id===dn.zoneId);
        if (zone) { subdivideZonesFrom(zone); selectItem('zone', zone.id, true); } else renderHierarchy();
      }
    }
    return;
  }

  if (dist<6 && dt<600) {
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
  if (e.key==='Escape') { App.hideContextMenu(); cancelActiveDrawing(); }
  else if (e.key==='Enter') finishActiveDrawing();
  else if (e.key==='7') controls.snapTop();
  else if (e.key==='1') controls.snapFront();
  else if (e.key==='3') controls.snapRight();
});

// Holding shift in the Paths tab — where a click adds a node to a path, or a branch — shows a cursor with a plus.
function showAddCursor(shift) {
  dom.classList.toggle('adding', shift && S.interactionMode==='node' && (S.currentTool==='road' || S.currentTool==='train'));
}
window.addEventListener('keydown', (e) => { if (e.key==='Shift') showAddCursor(true); });
window.addEventListener('keyup', (e) => { if (e.key==='Shift') showAddCursor(false); });
window.addEventListener('blur', () => showAddCursor(false));

// Starts drawing a new line out from an existing node, as a branch of that node's network, just like it: the same type,
// width and colors (or, for a train line, tube radius). It's finished, joined onto another node, or cancelled as any line
// being drawn is.
function startBranchFrom(nodeId) {
  const source = S.roadLines.find(l => !l.drawing && l.nodeIds.includes(nodeId));
  if (!source) return;
  const { networkId } = source;
  const line = isTrainLine(source)
    ? { id:'train-'+(S.roadLineSeq++), kind:'train', nodeIds:[nodeId], drawing:true, radius: source.radius, networkId }
    : { id:'road-'+(S.roadLineSeq++), nodeIds:[nodeId], drawing:true, width: source.width, color: source.color,
        sidewalkWidth: source.sidewalkWidth, sidewalkColor: source.sidewalkColor, roadType: source.roadType, pathColor: source.pathColor, networkId };
  S.roadLines.push(line);
  S.activeRoadLine = line;
  S.lastGroundClick = null;
  insertPreviewMarker.visible = false;
  S.pendingInsert = null;
  selectItem(networkKindOf(source), networkId, true);
  rebuildRoadMeshes();
}

function mergeActiveRoadLineInto(sharedNodeId) {
  const targetLine = S.roadLines.find(l => l.id !== S.activeRoadLine.id && l.nodeIds.includes(sharedNodeId));
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
      const pathColor = templateLine && templateLine.pathColor!=null ? templateLine.pathColor : PATH_COLOR;
      const line={ id:'road-'+(S.roadLineSeq++), nodeIds:[id], drawing:true, width, color, sidewalkWidth, sidewalkColor, roadType, pathColor, networkId:'net-'+(S.roadNetworkSeq++) };
      S.roadLines.push(line); S.activeRoadLine=line;
    }
    rebuildRoadMeshes(); S.zones.forEach(subdivideZone); renderHierarchy();
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
}

Object.assign(App, { raycaster, ndcOf, raycastGround });
