import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, SKIP_OVER_WATER_AND_ROADS, Y_MAP } from '../core/scene.js';
import { mapImages, mapGroup } from '../core/state.js';

// ---------------------------------------------------------- map images (reference tracing)
function buildFrameGeometry(w, h, thickness) {
  // a flat rectangular "picture frame" ring (outer rect minus an inset rect hole) — real
  // geometry, so its thickness is a true world-unit width instead of a 1px-capped GL line.
  const shape = new THREE.Shape();
  shape.moveTo(-w/2,-h/2); shape.lineTo(w/2,-h/2); shape.lineTo(w/2,h/2); shape.lineTo(-w/2,h/2); shape.lineTo(-w/2,-h/2);
  const iw = Math.max(0.01, w/2-thickness), ih = Math.max(0.01, h/2-thickness);
  const hole = new THREE.Path();
  hole.moveTo(-iw,-ih); hole.lineTo(iw,-ih); hole.lineTo(iw,ih); hole.lineTo(-iw,ih); hole.lineTo(-iw,-ih);
  shape.holes.push(hole);
  return new THREE.ShapeGeometry(shape);
}
function createMapPlaneMesh(texture, aspect) {
  // Three.js Euler 'XYZ' order is intrinsic (each axis is the object's own, already-rotated
  // axis), so a single mesh with both "lay flat" (rotation.x) and "yaw spin" (rotation.y) set
  // would spin around a tilted axis, not world-up. Splitting them across a pivot (position +
  // yaw only) and a child plane (the fixed flat-lay tilt only) keeps yaw a pure vertical spin.
  const targetSize = 200; // world units for the image's longer side, roughly matching city scale
  const w = aspect>=1 ? targetSize : targetSize*aspect;
  const h = aspect>=1 ? targetSize/aspect : targetSize;
  const geo = new THREE.PlaneGeometry(w, h);
  const mat = new THREE.MeshBasicMaterial({ map:texture, transparent:true, side:THREE.DoubleSide,
    polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2, ...SKIP_OVER_WATER_AND_ROADS });
  const plane = new THREE.Mesh(geo, mat);
  plane.rotation.x = -Math.PI/2; // lay flat within the pivot's frame — fixed, never touched again
  plane.name = 'MapImage';
  const frameThickness = Math.max(0.6, Math.min(w,h)*0.006);
  const frameOffset = { polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-4 };
  const selectFrame = new THREE.Mesh(buildFrameGeometry(w,h,frameThickness*1.7), new THREE.MeshBasicMaterial({ color:0x3ddc97, side:THREE.DoubleSide, ...frameOffset }));
  const hoverFrame = new THREE.Mesh(buildFrameGeometry(w,h,frameThickness), new THREE.MeshBasicMaterial({ color:0xffd23d, side:THREE.DoubleSide, ...frameOffset }));
  selectFrame.position.z = 0.002; hoverFrame.position.z = 0.0015; // local Z -> world Y after rotation, clearing z-fighting
  selectFrame.visible = false; hoverFrame.visible = false;
  plane.add(selectFrame, hoverFrame);
  const pivot = new THREE.Group();
  pivot.position.set(0, Y_MAP, 0);
  pivot.add(plane);
  pivot.userData.plane = plane;
  pivot.userData.selectFrame = selectFrame;
  pivot.userData.hoverFrame = hoverFrame;
  return pivot;
}
export function importMapImageFile(file, opts) {
  // opts (used when restoring a saved project, otherwise omitted for a normal user import):
  // {id, name, position:{x,z}, rotationY, scale, visible, skipSelect, onDone}
  opts = opts || {};
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    new THREE.TextureLoader().load(dataUrl, (texture) => {
      const img = texture.image;
      const aspect = (img && img.width && img.height) ? img.width/img.height : 1;
      const mesh = createMapPlaneMesh(texture, aspect);
      if (opts.position) mesh.position.set(opts.position.x, Y_MAP, opts.position.z);
      if (opts.rotationY!=null) mesh.rotation.y = opts.rotationY;
      if (opts.scale!=null) mesh.scale.setScalar(opts.scale);
      if (opts.visible===false) mesh.visible = false;
      mapGroup.add(mesh);
      const id = opts.id || 'map'+(S.mapImageSeq++);
      const name = opts.name || (file.name||'Image').replace(/\.[^.]+$/, '');
      mapImages.push({ id, name, mesh, dataUrl });
      if (opts.skipSelect) renderMapsList(); else setSelectedMap(id);
      if (opts.onDone) opts.onDone();
    });
  };
  reader.readAsDataURL(file);
}
function eyeIconSvg(visible) {
  const slash = visible ? '' : '<path d="M2 14 L14 2"/>';
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
    <path d="M1 8 C3 3.5 6 2 8 2 C10 2 13 3.5 15 8 C13 12.5 10 14 8 14 C6 14 3 12.5 1 8 Z"/>
    <circle cx="8" cy="8" r="2.2"/>${slash}
  </svg>`;
}
function toggleMapVisibility(id) {
  const m = mapImages.find(x => x.id===id);
  if (!m) return;
  m.mesh.visible = !m.mesh.visible;
  if (!m.mesh.visible && (S.selectedMapId===id || S.hoveredMapId===id)) {
    if (S.selectedMapId===id) setSelectedMap(null);
    if (S.hoveredMapId===id) setMapHover(null);
  }
  renderMapsList();
}
export function renderMapsList() {
  const list = document.getElementById('maps-list');
  if (!list) return;
  list.innerHTML = '';
  mapImages.forEach(m => {
    const row = document.createElement('div');
    row.className = 'hier-row' + (S.selectedMapId===m.id ? ' active' : '');
    const span = document.createElement('span');
    span.textContent = m.name;
    row.appendChild(span);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:2px;flex-shrink:0;';
    const eye = document.createElement('button');
    eye.className = 'hier-eye' + (m.mesh.visible ? '' : ' off');
    eye.title = m.mesh.visible ? 'Hide image' : 'Show image';
    eye.innerHTML = eyeIconSvg(m.mesh.visible);
    eye.onclick = (e) => { e.stopPropagation(); toggleMapVisibility(m.id); };
    actions.appendChild(eye);
    const del = document.createElement('button');
    del.className = 'hier-del'; del.textContent = '×';
    del.onclick = (e) => { e.stopPropagation(); removeMapImage(m.id); };
    actions.appendChild(del);
    row.appendChild(actions);
    row.onclick = () => setSelectedMap(m.id);
    list.appendChild(row);
  });
  const countEl = document.getElementById('maps-count');
  if (countEl) countEl.textContent = mapImages.length;
}
function getSelectedMap() { return mapImages.find(m => m.id===S.selectedMapId) || null; }
function refreshMapOutlines() {
  mapImages.forEach(m => {
    m.mesh.userData.selectFrame.visible = (m.id===S.selectedMapId);
    m.mesh.userData.hoverFrame.visible = (m.id===S.hoveredMapId && m.id!==S.selectedMapId);
  });
}
export function setSelectedMap(id) {
  cancelMapTransform();
  S.selectedMapId = id;
  refreshMapOutlines();
  renderMapsList();
  App.updateHint();
}
export function setMapHover(id) {
  if (S.hoveredMapId===id) return;
  S.hoveredMapId = id;
  refreshMapOutlines();
}
export function removeMapImage(id) {
  const idx = mapImages.findIndex(m => m.id===id);
  if (idx===-1) return;
  const m = mapImages[idx];
  if (S.selectedMapId===id) { cancelMapTransform(); S.selectedMapId = null; }
  if (S.hoveredMapId===id) S.hoveredMapId = null;
  mapGroup.remove(m.mesh);
  m.mesh.userData.plane.geometry.dispose();
  if (m.mesh.userData.plane.material.map) m.mesh.userData.plane.material.map.dispose();
  m.mesh.userData.plane.material.dispose();
  m.mesh.userData.selectFrame.geometry.dispose();
  m.mesh.userData.selectFrame.material.dispose();
  m.mesh.userData.hoverFrame.geometry.dispose();
  m.mesh.userData.hoverFrame.material.dispose();
  mapImages.splice(idx, 1);
  renderMapsList();
  App.updateHint();
}
export function startMapTransform(mode, x, y) {
  const m = getSelectedMap();
  if (!m) return;
  const gp = App.raycastGround(x, y);
  if (!gp) return;
  S.mapTransform = {
    mode, id: m.id, startGround: gp,
    startPos: { x:m.mesh.position.x, z:m.mesh.position.z },
    startRotY: m.mesh.rotation.y,
    startScale: m.mesh.scale.x
  };
  App.updateHint();
}
export function applyMapTransform(x, y, snap) {
  if (!S.mapTransform) return;
  const m = getSelectedMap();
  if (!m) { S.mapTransform = null; return; }
  const gp = App.raycastGround(x, y);
  if (!gp) return;
  const cx = S.mapTransform.startPos.x, cz = S.mapTransform.startPos.z;
  if (S.mapTransform.mode==='translate') {
    m.mesh.position.x = S.mapTransform.startPos.x + (gp.x - S.mapTransform.startGround.x);
    m.mesh.position.z = S.mapTransform.startPos.z + (gp.z - S.mapTransform.startGround.z);
    // y (height above ground) is never touched, so the image stays pinned at Y_MAP
  } else if (S.mapTransform.mode==='rotate') {
    const a0 = Math.atan2(S.mapTransform.startGround.z-cz, S.mapTransform.startGround.x-cx);
    const a1 = Math.atan2(gp.z-cz, gp.x-cx);
    let rotY = S.mapTransform.startRotY - (a1 - a0);
    if (snap) { const step = Math.PI/2; rotY = Math.round(rotY/step)*step; }
    m.mesh.rotation.y = rotY;
  } else if (S.mapTransform.mode==='scale') {
    const d0 = Math.max(0.001, Math.hypot(S.mapTransform.startGround.x-cx, S.mapTransform.startGround.z-cz));
    const d1 = Math.hypot(gp.x-cx, gp.z-cz);
    const s = Math.max(0.02, S.mapTransform.startScale * (d1/d0));
    m.mesh.scale.setScalar(s);
  }
}
export function confirmMapTransform() {
  if (!S.mapTransform) return;
  S.mapTransform = null;
  App.updateHint();
}
export function cancelMapTransform() {
  if (!S.mapTransform) return;
  const m = getSelectedMap();
  if (m) {
    m.mesh.position.x = S.mapTransform.startPos.x;
    m.mesh.position.z = S.mapTransform.startPos.z;
    m.mesh.rotation.y = S.mapTransform.startRotY;
    m.mesh.scale.setScalar(S.mapTransform.startScale);
  }
  S.mapTransform = null;
  App.updateHint();
}

const previewGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
export const previewLine = new THREE.Line(previewGeo, new THREE.LineBasicMaterial({ color:0xffffff, transparent:true, opacity:0.5 }));
previewLine.visible = false;
scene.add(previewLine);
