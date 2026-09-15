import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_ZONE_FILL, Y_ZONE_LINE } from '../core/scene.js';
import { centroid } from '../core/math.js';
import { tessellateOpenPath, tessellateClosedPath } from '../core/splines.js';
import { mergeGeometries, extractCapGeometry, buildWallGeometry } from '../buildings/windows.js';
import { disposeObject } from '../roads/roads.js';
import { nodeUiMaterial, asNodeUi } from '../trains/trains.js';

// ---------------------------------------------------------- zone rendering + generation
export function rebuildZoneVisual(zone) {
  if (zone.outlineGroup) { scene.remove(zone.outlineGroup); disposeObject(zone.outlineGroup); }
  const g = new THREE.Group();
  const markerGroup = new THREE.Group();
  const tessPts = zone.points.length>=2 ? (zone.closed ? tessellateClosedPath(zone.points) : tessellateOpenPath(zone.points)) : zone.points;
  if (zone.points.length>=3) {
    const shape = new THREE.Shape();
    tessPts.forEach((p,i) => { const sx=p.x, sy=-p.z; if (i===0) shape.moveTo(sx,sy); else shape.lineTo(sx,sy); });
    shape.closePath();
    const fillGeo = new THREE.ShapeGeometry(shape);
    const isSel = S.selection.type==='zone' && S.selection.id===zone.id;
    const fillMat = new THREE.MeshBasicMaterial({ color: isSel?0xffffff:0x3ddc97, transparent:true, opacity: isSel?0.13:0.07, side:THREE.DoubleSide, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-8, polygonOffsetUnits:-8 });
    const fill = new THREE.Mesh(fillGeo,fillMat);
    fill.rotation.x=-Math.PI/2; fill.position.y=Y_ZONE_FILL;
    fill.userData = { zoneId: zone.id, isZoneFill:true };
    g.add(fill);
  }
  if (zone.points.length>=2) {
    const pts = tessPts.map(p => new THREE.Vector3(p.x,Y_ZONE_LINE,p.z));
    if (zone.closed) pts.push(pts[0].clone());
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const isSel = S.selection.type==='zone' && S.selection.id===zone.id;
    const lineMat = new THREE.LineBasicMaterial({ color: isSel?0xffffff:0x3ddc97 });
    const lineObj = new THREE.Line(lineGeo,lineMat);
    lineObj.userData = { zoneId: zone.id, isZoneLine:true };
    g.add(lineObj);
  }
  zone.points.forEach((p,i) => {
    const isStart = i===0 && zone.drawing;
    const baseColor = isStart?0xffd23d:0x3ddc97;
    const geo = new THREE.SphereGeometry(isStart?2.0:1.5,12,12);
    const mat = nodeUiMaterial(THREE.MeshBasicMaterial, { color: baseColor });
    const m = new THREE.Mesh(geo,mat);
    m.position.set(p.x,1.4,p.z);
    m.userData = { zoneId: zone.id, vertexIndex: i, baseColor };
    markerGroup.add(asNodeUi(m));
    if (p.type==='spline') {
      ['handleIn','handleOut'].forEach(key => {
        const h = p[key];
        if (!h) return;
        const hgeo = new THREE.OctahedronGeometry(0.9, 0);
        const hmat = nodeUiMaterial(THREE.MeshBasicMaterial, { color:0xffd23d });
        const hm = new THREE.Mesh(hgeo,hmat);
        hm.position.set(h.x,1.4,h.z);
        hm.userData = { zoneId: zone.id, ownerIndex: i, handleKind:key, baseColor:0xffd23d };
        markerGroup.add(asNodeUi(hm));
        const clGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x,1.35,p.z), new THREE.Vector3(h.x,1.35,h.z)]);
        markerGroup.add(asNodeUi(new THREE.Line(clGeo, nodeUiMaterial(THREE.LineBasicMaterial, { color:0xffd23d, opacity:0.5 }))));
      });
    }
  });
  markerGroup.visible = (S.interactionMode==='node');
  g.add(markerGroup);
  zone.markerGroup = markerGroup;
  g.visible = (S.interactionMode==='node');
  zone.outlineGroup = g;
  scene.add(g);
}

export function scalePolygonAroundCentroid(poly, scale) {
  const c = centroid(poly);
  return poly.map(p => ({ x:c.x+(p.x-c.x)*scale, z:c.z+(p.z-c.z)*scale }));
}
export function makeExtrudeRaw(poly, height) {
  const shape = new THREE.Shape();
  poly.forEach((p,i) => { const sx=p.x, sy=-p.z; if (i===0) shape.moveTo(sx,sy); else shape.lineTo(sx,sy); });
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth:height, bevelEnabled:false });
}
export function extrudeFootprintGeo(poly, height, gradient, tileSize) {
  const raw = makeExtrudeRaw(poly, height);
  const caps = extractCapGeometry(raw);
  const walls = buildWallGeometry(poly, height, gradient, tileSize);
  return mergeGeometries(caps, walls);
}

Object.assign(App, { rebuildZoneVisual });
