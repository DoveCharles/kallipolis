import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { downloadFile } from './save-load.js';

// ============================================================ OBJ export
function exportOBJ() {
  const meshes = [];
  S.roadMeshGroup.traverse(o => { if (o.isMesh) meshes.push(o); });
  S.trainMeshGroup.traverse(o => { if (o.isMesh && !o.userData.isShuttle) meshes.push(o); }); // moving shuttles aren't part of the city
  S.zones.forEach(z => { if (z.buildingsGroup) z.buildingsGroup.traverse(o => { if (o.isMesh) meshes.push(o); }); });
  [S.waterGroup, S.bridgeGroup].forEach(group => group.traverse(o => { if (o.isMesh && !o.userData.noExport) meshes.push(o); }));
  if (!meshes.length) { alert('Nothing to export yet — draw some roads or zones first.'); return; }
  let out = '# Blockout export\n';
  let offset = 1, n = 0;
  meshes.forEach(obj => {
    obj.updateMatrixWorld(true);
    const geo = obj.geometry, pos = geo.attributes.position, matrix = obj.matrixWorld;
    out += `o ${obj.name||'Object'}_${n++}\n`;
    const v = new THREE.Vector3();
    for (let i=0;i<pos.count;i++) { v.fromBufferAttribute(pos,i).applyMatrix4(matrix); out += `v ${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}\n`; }
    if (geo.index) {
      const idx = geo.index;
      for (let i=0;i<idx.count;i+=3) { out += `f ${idx.getX(i)+offset} ${idx.getX(i+1)+offset} ${idx.getX(i+2)+offset}\n`; }
    } else {
      for (let i=0;i<pos.count;i+=3) { out += `f ${i+offset} ${i+1+offset} ${i+2+offset}\n`; }
    }
    offset += pos.count;
  });
  const blob = new Blob([out], { type:'text/plain' });
  downloadFile('blockout_city.obj', blob);
}

Object.assign(App, { exportOBJ });
