import { S, App } from '../core/shared.js';
import { computeAutoHandlesRoad, computeAutoHandlesZone } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { rebuildRoadMeshes } from '../roads/paths.js';
import { isTrainNode, snapStationHeight, trainNodeY } from '../trains/trains.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { subdivideZone, subdivideZonesFrom } from '../zones/cutouts.js';
import { renderHierarchy } from '../ui/panels.js';
import { isRaisedWalkwayLine } from '../roads/raised.js';

// ============================================================ node type context menu
// How a raised walkway's node sits in its network — 'end' (a ramp down there anyway), 'middle', or null if it isn't
// on a raised walkway at all
function raisedNodeRole(nodeId) {
  const lines = S.roadLines.filter(l => isRaisedWalkwayLine(l) && l.nodeIds.includes(nodeId));
  if (!lines.length) return null;
  let degree = 0;
  S.roadLines.filter(l => l.networkId === lines[0].networkId).forEach(l => l.nodeIds.forEach((id, i) => {
    if (id === nodeId) degree += i === 0 || i === l.nodeIds.length-1 ? 1 : 2;
  }));
  return degree === 1 ? 'end' : 'middle';
}
function showNodeContextMenu(x,y,target) {
  const menu = document.getElementById('node-context-menu');
  const currentType = target.kind==='road'
    ? ((roadNodes[target.nodeId]||{}).type || 'poly')
    : (((S.zones.find(z=>z.id===target.zoneId)||{}).points||[])[target.index] || {}).type || 'poly';
  const isTrain = target.kind==='road' && isTrainNode(target.nodeId);
  // train lines are always smooth, so a train node is just plain track or a station
  menu.innerHTML = isTrain ? `
    <button data-type="poly" class="${currentType!=='station'?'active':''}">Track</button>
    <button data-type="station" class="${currentType==='station'?'active':''}">Station</button>
  ` : `
    <button data-type="poly" class="${currentType==='poly'?'active':''}">Poly</button>
    <button data-type="spline" class="${currentType==='spline'?'active':''}">Spline</button>
  `;
  // a raised walkway's node can have a ramp down off its side; ends have one anyway. Either way, it can go off the other side.
  const role = target.kind==='road' && !isTrain ? raisedNodeRole(target.nodeId) : null;
  if (role) {
    const n = roadNodes[target.nodeId];
    if (role === 'middle') menu.innerHTML += `<button data-ramp="toggle" class="${n.ramp?'active':''}">Ramp</button>`;
    if (role === 'end' || n.ramp) menu.innerHTML += `<button data-ramp="flip">Flip ramp</button>`;
  }
  menu.style.left = x+'px';
  menu.style.top = y+'px';
  menu.style.display = 'block';
  // there's little room to spare on a phone, and a long press near an edge would put half the menu past it
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6))+'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6))+'px';
  menu.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (b.dataset.ramp) setNodeRamp(target.nodeId, b.dataset.ramp);
      else setNodeType(target, b.dataset.type);
      hideContextMenu();
    });
  });
}
function setNodeRamp(nodeId, action) {
  const n = roadNodes[nodeId];
  if (!n) return;
  if (action === 'toggle') { if (n.ramp) { delete n.ramp; delete n.rampSide; } else n.ramp = true; }
  else if (n.rampSide === -1) delete n.rampSide; else n.rampSide = -1;
  rebuildRoadMeshes();
  S.zones.forEach(subdivideZone);
}
function hideContextMenu() {
  document.getElementById('node-context-menu').style.display = 'none';
}
function setNodeType(target, type) {
  if (target.kind==='road') {
    const n = roadNodes[target.nodeId];
    if (!n) return;
    const isTrain = isTrainNode(target.nodeId);
    n.type = type;
    if (isTrain && type==='station') {
      // (a station too low for a lift settles onto the ground, handles and all: see snapStationHeight)
      const y = trainNodeY(n), dy = snapStationHeight(target.nodeId, y) - y;
      if (dy) { n.y = y + dy; ['handleIn','handleOut'].forEach(k => { if (n[k]) n[k].y = (n[k].y ?? y) + dy; }); }
    }
    if (!isTrain && type==='spline' && !n.handleIn && !n.handleOut) {
      const h = computeAutoHandlesRoad(target.nodeId);
      n.handleIn = h.handleIn; n.handleOut = h.handleOut;
    }
    rebuildRoadMeshes();
    if (isTrain) renderHierarchy(); // refreshes the station count; trains don't affect zones
    else S.zones.forEach(subdivideZone);
  } else {
    const zone = S.zones.find(z=>z.id===target.zoneId);
    if (!zone) return;
    const p = zone.points[target.index];
    if (!p) return;
    p.type = type;
    if (type==='spline' && !p.handleIn && !p.handleOut) {
      const h = computeAutoHandlesZone(zone, target.index);
      p.handleIn = h.handleIn; p.handleOut = h.handleOut;
    }
    subdivideZonesFrom(zone);
    rebuildZoneVisual(zone);
    renderHierarchy();
  }
}
window.addEventListener('pointerdown', (e) => {
  const menu = document.getElementById('node-context-menu');
  if (menu.style.display==='block' && !menu.contains(e.target)) hideContextMenu();
}, true);

Object.assign(App, { showNodeContextMenu, hideContextMenu });
