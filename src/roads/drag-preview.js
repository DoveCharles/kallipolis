// ---------------------------------------------------------------- road drag preview
// (and the drawing preview: a path being drawn is the same strip, the whole of it, until it's finished — see
// showDrawingPreview)
// While a road, walkway or river node's dragged, the paths aren't rebuilt — on a big city that's 40ms or more a mouse
// move, between recutting every network, the water's bridges and uploading it all afresh. A flat green strip the path's
// full width is laid over the stretches either side of the node instead, and follows it; the network being dragged
// darkens underneath, where it'll stay until the node's let go of and everything's rebuilt once (see commitNodeDrag).
import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_PREVIEW } from '../core/scene.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { roadLineWidths } from './roads.js';
import { isWalkwayLine, isRiverLine, rebuildRoadMeshes } from './paths.js';

const PREVIEW_COLOR = 0x3ddc97; // (the node markers' green)
const DIM = 0.45;               // how much of its colour the dragged network keeps while the strip's over it
const material = new THREE.MeshBasicMaterial({ color: PREVIEW_COLOR, transparent: true, opacity: 0.6, depthFunc: THREE.LessDepth, side: THREE.DoubleSide });

// The strip stays in the scene between drags, so its shader's compiled with everything else under the loading screen
// rather than on a drag's first mouse move — as one triangle with no area, which draws nothing. (With no triangles at
// all it'd be skipped, and never compiled.)
const idleGeometry = () => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
const mesh = new THREE.Mesh(idleGeometry(), material);
mesh.name = 'RoadDragPreview';
mesh.renderOrder = 2;
mesh.frustumCulled = false;
scene.add(mesh);
let preview = null;     // { drag, dimmed: [[material, colour it had]] }
let drawingLine = null; // the path being drawn, while showDrawingPreview has it

// how far the path reaches either side of its centreline: a road's sidewalk edge, a walkway or river's own
function halfWidthOf(line) {
  if (isWalkwayLine(line) || isRiverLine(line)) return (line.width || S.DEFAULT_ROAD_WIDTH)/2;
  const { hw, cw, sw } = roadLineWidths(line);
  return hw + cw + sw;
}
// The stretches of each line through `nodeId` that move with it — from the node before it to the node after — as
// centreline points and a half width.
function stretchesThrough(nodeId) {
  const out = [];
  S.roadLines.forEach(line => {
    const ids = line.nodeIds;
    ids.forEach((id, k) => {
      if (id !== nodeId) return;
      const pts = ids.slice(Math.max(0, k - 1), k + 2).map(i => roadNodes[i]).filter(Boolean);
      if (pts.length >= 2) out.push({ points: tessellateOpenPath(pts), hw: halfWidthOf(line) });
    });
  });
  return out;
}
// Each piece of centreline as its own quad, with a disc at every joint to round it off. (One strip bent round the points
// folds over itself at a sharp corner.) The pieces overlap at the joints, but the material writes depth and only draws
// what's strictly nearer, so the overlap isn't tinted twice.
const JOINT_SIDES = 12;
function ribbonGeometry(stretches) {
  const pos = [], index = [];
  const vertex = (x, z) => { pos.push(x, Y_PREVIEW, z); return pos.length/3 - 1; };
  stretches.forEach(({ points, hw }) => {
    points.forEach((b, i) => {
      if (i > 0) {
        const a = points[i - 1], len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len > 1e-6) {
          const nx = -(b.z - a.z)/len*hw, nz = (b.x - a.x)/len*hw;
          const v0 = vertex(a.x + nx, a.z + nz), v1 = vertex(a.x - nx, a.z - nz), v2 = vertex(b.x + nx, b.z + nz), v3 = vertex(b.x - nx, b.z - nz);
          index.push(v0, v1, v2, v1, v3, v2);
        }
      }
      if (i > 0 && i < points.length - 1) {
        const c = vertex(b.x, b.z), first = pos.length/3;
        for (let k = 0; k < JOINT_SIDES; k++) { const t = k/JOINT_SIDES*Math.PI*2; vertex(b.x + Math.cos(t)*hw, b.z + Math.sin(t)*hw); }
        for (let k = 0; k < JOINT_SIDES; k++) index.push(c, first + k, first + (k + 1) % JOINT_SIDES);
      }
    });
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  return geo;
}

// Called after each move of the dragged road node or handle `drag` ({ nodeId, ... }): lays the strip where the node
// now is, and moves its marker and handles along with it.
export function moveRoadDragPreview(drag) {
  if (!preview) {
    const networks = new Set(S.roadLines.filter(l => l.nodeIds.includes(drag.nodeId)).map(l => l.networkId));
    const dimmed = [];
    S.roadMeshGroup.traverse(o => {
      if (!o.isMesh || !networks.has(o.userData.networkId) || o.userData.sharedMaterial) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        if (!m.color || dimmed.some(([d]) => d === m)) return;
        dimmed.push([m, m.color.clone()]);
        m.color.multiplyScalar(DIM);
      });
    });
    preview = { drag, dimmed };
  }
  redraw();
}
// the strip over whatever's being dragged and drawn now, or none
function redraw() {
  const stretches = preview ? stretchesThrough(preview.drag.nodeId) : [];
  if (drawingLine) {
    const pts = drawingLine.nodeIds.map(i => roadNodes[i]).filter(Boolean);
    if (pts.length >= 2) stretches.push({ points: tessellateOpenPath(pts), hw: halfWidthOf(drawingLine) });
  }
  mesh.geometry.dispose();
  mesh.geometry = stretches.length ? ribbonGeometry(stretches) : idleGeometry();
  App.rebuildRoadMarkers();
  App.rebuildRoadHandles();
}
// Takes the strip away (and gives the network its colour back); true if there was one. The caller rebuilds the roads.
export function endRoadDragPreview() {
  if (!preview) return false;
  preview.dimmed.forEach(([m, c]) => m.color.copy(c));
  preview = null;
  redraw();
  return true;
}
// Called after each node's added to road, walkway or river line `line` while it's being drawn, in place of rebuilding
// the paths and the zones they cut — on a big city a hang of a good fraction of a second a click. The line's only built
// when it's finished (finishActiveDrawing, or clicked onto another node) or cancelled; whichever does that ends this too.
export function showDrawingPreview(line) {
  drawingLine = line;
  redraw();
}
export function endDrawingPreview() {
  if (!drawingLine) return;
  drawingLine = null;
  redraw();
}
// Once a frame: a drag that ended without being let go of the usual way (a cancelled pointer, a long press turning into
// a context menu) still gets its roads rebuilt, and the zones they cut.
export function updateRoadDragPreview() {
  // (and a line that stopped being drawn some other way — its network deleted from the panel — loses its strip)
  if (drawingLine && S.activeRoadLine !== drawingLine) endDrawingPreview();
  if (!preview || S.draggedNode === preview.drag) return;
  endRoadDragPreview();
  rebuildRoadMeshes();
  S.zones.forEach(App.subdivideZone);
}
