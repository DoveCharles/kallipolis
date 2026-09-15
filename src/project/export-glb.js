import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { S, App } from '../core/shared.js';
import { scene, ground } from '../core/scene.js';
import { downloadFile } from './save-load.js';

// ============================================================ GLB export
// The city as a GLB with real materials, for Blender, Unity, Unreal and the like: the ground, roads, train lines, water,
// bridges and each zone's contents, as named nodes. Every mesh is baked into world space and merged with the others in its
// node that share its material, so the file stays lean. Materials keep their color, roughness, metalness, glow and vertex
// colors; a surface drawn by one of the app's shaders (water, grass, crops, paving, paths, building windows) comes out in
// its representative flat color, since a GLB can't carry the shader. Things that move (people, cars, train shuttles, signal
// lamps) and the editing overlays (node markers, zone outlines, the grid) are left out.
function exportLookOf(material) {
  const shader = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile') ? String(material.onBeforeCompile) : '';
  return shader.includes('uWaterTime') ? 'water' : shader.includes('uZoneEdgePoints') ? 'grass' : shader.includes('uRowDir') ? 'crop'
    : shader.includes('uPavePattern') ? 'paving' : shader.includes('uPathSegments') ? 'path' : shader.includes('WINDOW_FRAGMENT_LAYOUT') ? 'windows' : 'plain';
}
function exportMaterialFor(material) {
  const look = exportLookOf(material);
  const color = material.color ? material.color.clone() : new THREE.Color(0xffffff);
  if (look === 'water') color.setHex(0x1d6f7d);
  else if (look === 'grass') color.multiplyScalar(0.6); // the grass shader shades its tint by a mid grey
  const out = new THREE.MeshStandardMaterial({
    color,
    roughness: look === 'water' ? 0.1 : (material.roughness != null ? material.roughness : 1),
    metalness: material.metalness != null ? material.metalness : 0,
    vertexColors: !!material.vertexColors,
    side: material.side,
    transparent: !!material.transparent && look !== 'path',
    opacity: look === 'path' ? 1 : material.opacity,
  });
  // glow only where it lights the whole surface — the window shader limits its glow to the windows, which a flat material can't
  if (material.emissive && material.emissiveIntensity > 0 && look !== 'windows') { out.emissive.copy(material.emissive); out.emissiveIntensity = material.emissiveIntensity; }
  out.name = (look === 'plain' ? '' : look + ' ') + '#' + color.getHexString();
  const key = [out.name, out.roughness.toFixed(2), out.metalness.toFixed(2), out.vertexColors, out.side, out.transparent, out.opacity.toFixed(2), out.emissive.getHexString(), out.emissiveIntensity.toFixed(2)].join('|');
  return { material: out, key };
}
// a mesh's geometry in world space, with just positions, normals and (if its material uses them) vertex colors
function exportGeometryOf(mesh, withColors) {
  const src = mesh.geometry, position = src.attributes.position;
  if (!position || !position.count) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', position.clone());
  if (src.attributes.normal) geo.setAttribute('normal', src.attributes.normal.clone());
  if (withColors) geo.setAttribute('color', src.attributes.color ? src.attributes.color.clone() : new THREE.Float32BufferAttribute(new Float32Array(position.count*3).fill(1), 3));
  if (src.index) geo.setIndex(src.index.clone());
  geo.applyMatrix4(mesh.matrixWorld);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}
function mergeExportGeometries(geos) {
  if (geos.length === 1) return geos[0];
  let vertices = 0, corners = 0;
  geos.forEach(g => { vertices += g.attributes.position.count; corners += g.index ? g.index.count : g.attributes.position.count; });
  const withColors = !!geos[0].attributes.color;
  const position = new Float32Array(vertices*3), normal = new Float32Array(vertices*3), color = withColors ? new Float32Array(vertices*3) : null;
  const index = new Uint32Array(corners);
  let v = 0, c = 0;
  geos.forEach(g => {
    const count = g.attributes.position.count, p = g.attributes.position, n = g.attributes.normal, col = g.attributes.color;
    for (let i=0;i<count;i++) {
      position[(v+i)*3] = p.getX(i); position[(v+i)*3+1] = p.getY(i); position[(v+i)*3+2] = p.getZ(i);
      normal[(v+i)*3] = n.getX(i); normal[(v+i)*3+1] = n.getY(i); normal[(v+i)*3+2] = n.getZ(i);
      if (color) { color[(v+i)*3] = col.getX(i); color[(v+i)*3+1] = col.getY(i); color[(v+i)*3+2] = col.getZ(i); }
    }
    if (g.index) for (let i=0;i<g.index.count;i++) index[c++] = g.index.getX(i) + v;
    else for (let i=0;i<count;i++) index[c++] = v + i;
    v += count;
    g.dispose();
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (color) merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}
function exportGLB() {
  if (!GLTFExporter) { alert('The GLB exporter didn\'t load — check your connection and reload the page.'); return; }
  scene.updateMatrixWorld(true);
  const sources = [['Ground', ground], ['Roads', S.roadMeshGroup], ['Trains', S.trainMeshGroup], ['Water', S.waterGroup], ['Bridges', S.bridgeGroup],
    ...S.zones.filter(z => z.buildingsGroup).map(z => [z.name + ' (' + (z.zoneType || 'buildings') + ')', z.buildingsGroup])];
  const exportScene = new THREE.Scene();
  exportScene.name = 'Splinetopia';
  const materials = new Map(); // shared across the whole file: one material per distinct look, however many nodes use it
  let cityMeshes = 0;
  sources.forEach(([name, root]) => {
    const byMaterial = new Map();
    root.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || !o.visible || o.userData.noExport || o.userData.isShuttle || Array.isArray(o.material)) return;
      const made = exportMaterialFor(o.material);
      if (materials.has(made.key)) made.material.dispose(); else materials.set(made.key, made.material);
      const material = materials.get(made.key), key = made.key;
      const geo = exportGeometryOf(o, material.vertexColors);
      if (!geo) return;
      if (!byMaterial.has(key)) byMaterial.set(key, { material, geos: [] });
      byMaterial.get(key).geos.push(geo);
    });
    if (!byMaterial.size) return;
    const node = new THREE.Group();
    node.name = name;
    byMaterial.forEach(({ material, geos }) => {
      const mesh = new THREE.Mesh(mergeExportGeometries(geos), material);
      mesh.name = name + ' · ' + material.name;
      node.add(mesh);
      if (name !== 'Ground') cityMeshes++;
    });
    exportScene.add(node);
  });
  const cleanUp = () => exportScene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  if (!cityMeshes) { cleanUp(); alert('Nothing to export yet — draw some roads or zones first.'); return; }
  new GLTFExporter().parse(exportScene, (result) => {
    downloadFile('splinetopia_city.glb', new Blob([result], { type: 'model/gltf-binary' }));
    cleanUp();
  }, (err) => {
    cleanUp();
    alert('The GLB export failed: ' + (err && err.message ? err.message : err));
  }, { binary: true });
}

Object.assign(App, { exportGLB });
