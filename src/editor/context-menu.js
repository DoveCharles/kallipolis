import { S, App } from '../core/shared.js';
import { computeAutoHandlesRoad, computeAutoHandlesZone } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { rebuildRoadMeshes } from '../roads/paths.js';
import { isTrainNode } from '../trains/trains.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { subdivideZone, subdivideZonesFrom } from '../zones/cutouts.js';
import { renderHierarchy } from '../ui/panels.js';

// ============================================================ node type context menu
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
      setNodeType(target, b.dataset.type);
      hideContextMenu();
    });
  });
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
