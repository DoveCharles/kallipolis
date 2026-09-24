import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, camera, renderer, snapPointToGrid } from '../core/scene.js';
import { nearestPointOnEdgeTessellated } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { setLinePoints } from '../roads/roads.js';
import { rebuildRoadMeshes } from '../roads/paths.js';
import { nodeUiMaterial, asNodeUi, nodeUiScaleAt, pathTypeOf, currentPathType } from '../trains/trains.js';
import { setNodeHighlight } from './node-highlight.js';

// ---------------------------------------------------------- hover + insert-on-edge
let hoveredMesh = null;
// a green rim round the hovered node: a sphere a little bigger than it, drawn just behind it, inside out
const hoverOutline = asNodeUi(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), nodeUiMaterial(THREE.MeshBasicMaterial, { color:0x3ddc97, side:THREE.BackSide })));
hoverOutline.renderOrder = 999;
hoverOutline.userData = { noExport: true, sharedGeometry: true, sharedMaterial: true }; // (screenSized off: it grows with its node)
hoverOutline.raycast = () => {};
export function setHover(mesh) {
  if (hoveredMesh === mesh) return;
  hoverOutline.removeFromParent();
  if (mesh) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    hoverOutline.scale.setScalar(mesh.geometry.boundingSphere.radius * 1.4);
    mesh.add(hoverOutline);
  }
  if (hoveredMesh && hoveredMesh.material) {
    hoveredMesh.material.color.set(hoveredMesh.userData.baseColor !== undefined ? hoveredMesh.userData.baseColor : 0x3ddc97);
  }
  hoveredMesh = mesh;
  if (hoveredMesh && hoveredMesh.material) hoveredMesh.material.color.set(0xffffff);
  renderer.domElement.classList.toggle('over-node', !!hoveredMesh); // an open hand: it can be taken hold of (see win3.css)
  setNodeHighlight(hoveredMesh); // (a zone's or path's node lights up all it's built)
}

const insertPreviewGeo = new THREE.BufferGeometry();
export const insertPreviewMarker = asNodeUi(new THREE.LineSegments(insertPreviewGeo, nodeUiMaterial(THREE.LineBasicMaterial, { color:0xffffff })));
insertPreviewMarker.visible = false;
scene.add(insertPreviewMarker);
const insertPreviewAt = new THREE.Vector3();
export function updateInsertPreviewGeometry(point, angle) {
  const y = point.y!=null ? point.y : 1.4; // train insert points sit up on the tube
  const r = 1.8*nodeUiScaleAt(camera, insertPreviewAt.set(point.x, y, point.z)); // (the same size on screen at any zoom, as the nodes are)
  const rotAngle = angle;
  const cos = Math.cos(rotAngle), sin = Math.sin(rotAngle);
  const rot = (lx,lz) => ({ x: lx*cos - lz*sin, z: lx*sin + lz*cos });
  const c1=rot(-r,-r), c2=rot(r,r), c3=rot(-r,r), c4=rot(r,-r);
  setLinePoints(insertPreviewGeo, [
    new THREE.Vector3(point.x+c1.x, y, point.z+c1.z), new THREE.Vector3(point.x+c2.x, y, point.z+c2.z),
    new THREE.Vector3(point.x+c3.x, y, point.z+c3.z), new THREE.Vector3(point.x+c4.x, y, point.z+c4.z)
  ]);
}
export function findNearestEdge(gp, zoneThreshold) {
  let best = null;
  if (S.currentTool==='road') {
    const type = currentPathType();
    S.roadLines.forEach(line => {
      if (pathTypeOf(line)!==type) return; // (only the Paths tab's own type can be added to)
      const th = Math.max((line.width||S.DEFAULT_ROAD_WIDTH)/2+3, 6);
      const pts = line.nodeIds.map(id=>roadNodes[id]).filter(Boolean);
      for (let i=0;i<pts.length-1;i++) {
        const a=pts[i], b=pts[i+1];
        const r = nearestPointOnEdgeTessellated(gp,a,b);
        if (r.dist<=th && (!best || r.dist<best.dist)) best = { kind:'road', line, index:i, point:r.point, dist:r.dist, angle:Math.atan2(b.z-a.z,b.x-a.x) };
      }
    });
  } else if (S.currentTool==='zone') {
    S.zones.forEach(zone => {
      const n = zone.points.length;
      if (n<2) return;
      const edgeCount = zone.closed ? n : n-1;
      for (let i=0;i<edgeCount;i++) {
        const a=zone.points[i], b=zone.points[(i+1)%n];
        const r = nearestPointOnEdgeTessellated(gp,a,b);
        if (r.dist<=zoneThreshold && (!best || r.dist<best.dist)) best = { kind:'zone', zone, index:i, point:r.point, dist:r.dist, angle:Math.atan2(b.z-a.z,b.x-a.x) };
      }
    });
  }
  return best;
}
export function insertNodeOnEdge(found) {
  if (found.kind==='train') {
    const id = 'n'+(S.roadNodeSeq++);
    roadNodes[id] = { x:found.point.x, y:found.point.y, z:found.point.z, type:'poly', handleIn:null, handleOut:null };
    found.line.nodeIds.splice(found.index+1, 0, id);
    rebuildRoadMeshes(); App.renderHierarchy();
  } else if (found.kind==='road') {
    const pt = snapPointToGrid(found.point, 'road');
    const id = 'n'+(S.roadNodeSeq++);
    roadNodes[id] = { x:pt.x, z:pt.z, type:'poly', handleIn:null, handleOut:null };
    found.line.nodeIds.splice(found.index+1, 0, id);
    rebuildRoadMeshes(); S.zones.forEach(App.subdivideZone); App.renderHierarchy();
  } else {
    const pt = snapPointToGrid(found.point, 'zone');
    found.zone.points.splice(found.index+1, 0, { x:pt.x, z:pt.z, type:'poly', handleIn:null, handleOut:null });
    App.subdivideZonesFrom(found.zone);
    App.rebuildZoneVisual(found.zone);
    App.renderHierarchy();
  }
  insertPreviewMarker.visible = false;
  S.pendingInsert = null;
}
