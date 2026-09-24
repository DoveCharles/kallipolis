import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_ZONE_FILL } from '../core/scene.js';
import { zoneBatchMeshes } from '../buildings/building-batches.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { unionRoadStrokes, clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { isRiverLine } from '../roads/paths.js';

// ---------------------------------------------------------- node highlight
// While a node is hovered, everything its zone or path network has built is washed green — a zone's buildings, trees,
// ground and lot (a water zone, the water inside its outline); a network's road, curbs, sidewalks, walkways or track
// (a river, a green ribbon over its water) — and the rest of its nodes turn a lighter green. Nothing is recolored or unbatched for it: each mesh gets
// a see-through green twin as a child, drawing the same geometry in a basic material, so it follows its host about,
// shows only when its host does (a merged building batch, or the buildings one by one when those are handed back), and
// costs a draw call or so a mesh while it lasts. One shader program or two (plain and instanced) rather than a tinted
// copy of every material, which is what makes ped view stall as it turns on.
// (A mesh displaced in its own shader — trees swaying — is drawn as it rests, so the green may sit a touch off it.)

const base = new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.55, depthWrite: false });
// a copy of it per kind of depth and stencil state its hosts draw with: a floor pulled toward the camera by a polygon
// offset (a plaza's paving, a beach's sand) needs its twin pulled a step further, or the twin loses the depth test to it,
// and ground kept off the roads by the stencil keeps its twin off them too. (Only GL state differs between the copies,
// so they all share one shader program.)
const materials = new Map();
function materialFor(host) {
  const m = Array.isArray(host.material) ? host.material[0] : host.material;
  const factor = (m?.polygonOffset ? m.polygonOffsetFactor : 0) - 1, units = (m?.polygonOffset ? m.polygonOffsetUnits : 0) - 1;
  const stencil = m?.stencilWrite ? [m.stencilFunc, m.stencilRef, m.stencilFuncMask] : null;
  const side = m?.side ?? THREE.FrontSide;
  const key = [factor, units, side, stencil].join();
  let material = materials.get(key);
  if (!material) {
    material = base.clone();
    Object.assign(material, { polygonOffset: true, polygonOffsetFactor: factor, polygonOffsetUnits: units, side });
    // (tested against, never written: the twin leaves the stencil as its host left it)
    if (stencil) Object.assign(material, { stencilWrite: true, stencilFunc: stencil[0], stencilRef: stencil[1], stencilFuncMask: stencil[2], stencilWriteMask: 0 });
    materials.set(key, material);
  }
  return material;
}
const noRaycast = () => {};

let target = null;     // the zone, or {networkIds} of the path network, highlighted
let sources = [];      // what its twins were made from (any of it rebuilt → made again)
let ribbon = null;     // a river's green, which has no mesh of its own to twin
const twins = [];

function twinOf(host) {
  let twin;
  if (host.isInstancedMesh) {
    twin = new THREE.InstancedMesh(host.geometry, materialFor(host), host.count);
    twin.instanceMatrix = host.instanceMatrix;
    twin.frustumCulled = false;
    twin.onBeforeRender = () => { twin.count = host.count; };
  } else {
    twin = new THREE.Mesh(host.geometry, materialFor(host));
  }
  // a shape-keyed host (a flower opening, say) lends its twin its weights, or three finds none to draw it with
  if (host.morphTexture) twin.morphTexture = host.morphTexture;
  if (host.morphTargetInfluences) { twin.morphTargetInfluences = host.morphTargetInfluences; twin.morphTargetDictionary = host.morphTargetDictionary; }
  twin.raycast = noRaycast;
  twin.renderOrder = host.renderOrder;
  twin.userData = { noExport: true, sharedGeometry: true, sharedMaterial: true, nodeHighlight: true };
  host.add(twin);
  twins.push(twin);
}
function clear() {
  twins.forEach(t => t.removeFromParent());
  twins.length = 0;
  if (ribbon) { ribbon.removeFromParent(); ribbon.geometry.dispose(); ribbon = null; }
  sources = [];
}
const sourcesOf = t => t.networkIds
  ? [S.roadMeshGroup, S.trainMeshGroup, S.riverSeq, S.roadMarkerGroup]
  : [t.buildingsGroup, zoneBatchMeshes(t), t.outlineGroup];
const meshesIn = (group, hosts, keep = () => true) => {
  if (group && group.parent === scene) group.traverse(o => { if (o.isMesh && !o.isSkinnedMesh && !o.userData.nodeHighlight && keep(o)) hosts.push(o); });
};
function build() {
  sources = sourcesOf(target);
  const hosts = [];
  if (target.networkIds) {
    // a network's meshes carry its id (a train's carriages, on the group they're in)
    const ours = o => { for (; o; o = o.parent) if (o.userData.networkId != null) return target.networkIds.has(o.userData.networkId); return false; };
    meshesIn(S.roadMeshGroup, hosts, ours);
    meshesIn(S.trainMeshGroup, hosts, ours);
    buildRibbon();
  } else {
    meshesIn(target.buildingsGroup, hosts);
    (zoneBatchMeshes(target) || []).forEach(m => hosts.push(m));
    // water is drawn as one body for every water zone and river together, so a water zone's own is its outline's fill
    // (which sits above the sunken surface)
    if (target.zoneType === 'water') target.outlineGroup?.children.forEach(c => { if (c.userData.isZoneFill) hosts.push(c); });
  }
  hosts.forEach(twinOf);
}
// the network's rivers stroked as rebuildRoads strokes them into the water, laid flat just above it
function buildRibbon() {
  const strokes = S.roadLines.filter(l => target.networkIds.has(l.networkId) && isRiverLine(l)).map(l => ({
    path: App.toClipperPath(tessellateOpenPath(l.nodeIds.map(id => roadNodes[id]).filter(Boolean))),
    radius: (l.width || S.DEFAULT_ROAD_WIDTH)/2,
  })).filter(s => s.path.length >= 2);
  if (!strokes.length) return;
  const builder = createMeshBuilder();
  builder.addTops(clipPolygons(ClipperLib.ClipType.ctUnion, unionRoadStrokes(strokes), [], true), Y_ZONE_FILL);
  const geo = builder.build();
  if (!geo) return;
  ribbon = new THREE.Mesh(geo, base);
  ribbon.raycast = noRaycast;
  ribbon.userData = { noExport: true, sharedMaterial: true, nodeHighlight: true };
  scene.add(ribbon);
}

/**
 * Light up what the hovered node's zone or path network has built (or, with none hovered, stop).
 * @param {?THREE.Object3D} hovered - the node (or handle) hovered, left as setHover colored it
 * @returns {void}
 */
export function setNodeHighlight(hovered) {
  const t = targetOf(hovered);
  if (!sameTarget(t, target)) {
    const was = target;
    clear();
    target = t;
    paintNodes(was, null);
    if (target) build();
  }
  paintNodes(target, hovered);
}
function targetOf(node) {
  const zoneId = node?.userData.zoneId, nodeId = node?.userData.nodeId;
  if (zoneId != null) return S.zones.find(z => z.id === zoneId) || null;
  if (nodeId == null) return null;
  const networkIds = new Set(S.roadLines.filter(l => l.nodeIds.includes(nodeId)).map(l => l.networkId));
  return networkIds.size ? { networkIds } : null;
}
const sameTarget = (a, b) => a === b || (a?.networkIds && b?.networkIds && a.networkIds.size === b.networkIds.size && [...a.networkIds].every(id => b.networkIds.has(id)));

// the zone's or network's other nodes a lighter green while one of them is hovered (that one's white: see setHover),
// back as they were after
const NODE_LIT = 0xa8f5d0;
let hoveredNode = null;
function paintNodes(t, hovered) {
  if (hovered !== undefined) hoveredNode = hovered;
  if (!t) return;
  const lit = t === target;
  if (t.networkIds) {
    const nodeIds = new Set(S.roadLines.filter(l => t.networkIds.has(l.networkId)).flatMap(l => l.nodeIds));
    S.roadMarkerGroup.children.forEach(m => {
      if (m === hoveredNode || !nodeIds.has(m.userData.nodeId)) return;
      m.material.color.set(lit ? NODE_LIT : m.userData.baseColor);
    });
  } else {
    t.markerGroup?.children.forEach(m => {
      if (m.userData.vertexIndex === undefined || m === hoveredNode) return;
      m.material.color.set(lit ? NODE_LIT : m.userData.baseColor);
    });
  }
}

// each frame: a zone or network rebuilt (or merged afresh) under the highlight gets its twins again
export function updateNodeHighlight() {
  if (!target) return;
  if (target.networkIds ? !S.roadLines.some(l => target.networkIds.has(l.networkId)) : !S.zones.includes(target)) { setNodeHighlight(null); return; }
  const now = sourcesOf(target);
  if (now.some((s, i) => s !== sources[i])) { clear(); build(); paintNodes(target); }
}
