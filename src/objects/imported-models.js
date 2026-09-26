import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { S, App } from '../core/shared.js';
import { OBJECT_TYPES } from './object-types.js';

// ============================================================ models brought in from outside
// The Objects tab's "Import model" button: a .glb, a self-contained .gltf or an .obj becomes one more kind on the
// palette, put down, dragged, turned and sized like any other. Each is a record — {id, name, format, dataUrl} — and the
// file itself is kept in it as a data URL, the way a map image is, so the project file and the autosave carry it and a
// project opened elsewhere still has it. (Undo's snapshots leave them out, as they do map images; see history.js.)
//
// A model lands the way a Blender-made prop does (propModel in object-types.js): rested on y=0 and centred on its own
// origin. glTF is in metres already; an .obj could be in anything, so one that comes in absurdly big or small (a
// centimetre export, say) is brought to IMPORT_FALLBACK_SIZE and can be sized from there.
S.importedModels = [];  // {id, name, format, dataUrl}
S.importedModelSeq = 1;
const IMPORT_MAX_SIZE = 150, IMPORT_MIN_SIZE = 0.05, IMPORT_FALLBACK_SIZE = 2;
const OBJ_MATERIAL = new THREE.MeshStandardMaterial({ color:0xb0aba0, roughness:0.85, metalness:0.05 }); // an .obj's parts, which bring no materials of their own
export const importedTypeId = id => 'model:' + id;
export const isImportedType = typeId => typeof typeId === 'string' && typeId.startsWith('model:');

async function parseModel(format, buffer) {
  if (format === 'obj') {
    const root = new OBJLoader().parse(new TextDecoder().decode(buffer));
    root.traverse(o => { if (o.isMesh) o.material = OBJ_MATERIAL; });
    return root;
  }
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}
function modelTemplate(root) {
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error('the model is empty');
  const size = box.getSize(new THREE.Vector3()), biggest = Math.max(size.x, size.y, size.z);
  if (biggest > IMPORT_MAX_SIZE || biggest < IMPORT_MIN_SIZE) {
    root.scale.multiplyScalar(IMPORT_FALLBACK_SIZE/biggest);
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
  }
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = !o.material?.transparent; o.receiveShadow = true;
    o.userData.sharedGeometry = true; // every one put down draws the template's, so removing one mustn't free it
    o.userData.sharedMaterial = true;
  });
  const middle = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3());
  return { root, middle, floor: box.min.y, radius: Math.max(0.3, Math.hypot(extent.x, extent.z)/2) };
}
function placeTemplate(template) {
  const clone = SkeletonUtils.clone(template.root); // (a plain clone would leave a rigged model's copies bound to the template's bones)
  clone.position.set(-template.middle.x, -template.floor, -template.middle.z);
  const group = new THREE.Group();
  group.add(clone);
  return group;
}

// The model's kind on the palette. It's added to OBJECT_TYPES itself, so everything that looks a kind up finds it.
function registerModel(record, template) {
  const type = {
    id: importedTypeId(record.id), label: record.name, color:'#8a8f96', facing:'street', radius: template.radius,
    turnJitter:0, sizeJitter:0, imported: record.id, // put down exactly as it was made: it's someone's own model
    build: () => placeTemplate(template),
  };
  const at = OBJECT_TYPES.findIndex(t => t.id === type.id);
  if (at >= 0) OBJECT_TYPES[at] = type; else OBJECT_TYPES.push(type);
  return type;
}
async function loadModelRecord(record) {
  const buffer = await fetch(record.dataUrl).then(r => r.arrayBuffer());
  const template = modelTemplate(await parseModel(record.format, buffer));
  S.importedModels.push(record);
  return registerModel(record, template);
}

const formatOf = name => {
  const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  return ext === 'obj' ? 'obj' : ext === 'glb' || ext === 'gltf' ? 'gltf' : null;
};
const readAsDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
// From the file picker: loads it, puts it on the palette and arms it, ready to click down.
export async function importModelFile(file) {
  const format = formatOf(file.name);
  if (!format) { alert(`${file.name} isn't a model Kallipolis can read — use a .glb, .gltf or .obj.`); return; }
  try {
    const record = { id: 'm' + (S.importedModelSeq++), name: file.name.replace(/\.[^.]+$/, '') || 'Model', format, dataUrl: await readAsDataUrl(file) };
    const type = await loadModelRecord(record);
    App.refreshObjectThumbnails?.([type]);
    App.armObject?.(type.id);
  } catch (err) {
    console.warn('Kallipolis: the model failed to import', err);
    alert(`${file.name} couldn't be read${format === 'gltf' ? ' (a .gltf has to have its buffers and textures embedded — a .glb always does)' : ''}.`);
  }
}
// Takes a model off the palette, and everything of it that's been put down with it.
export function removeImportedModel(id) {
  const typeId = importedTypeId(id);
  S.objects.filter(o => o.type === typeId).forEach(o => App.removeObject(o.id));
  if (S.placingType === typeId) App.disarmObject();
  S.importedModels = S.importedModels.filter(m => m.id !== id);
  const at = OBJECT_TYPES.findIndex(t => t.id === typeId);
  if (at >= 0) OBJECT_TYPES.splice(at, 1);
  App.renderObjectsPanel();
  App.scheduleHistory?.(0);
}

export const serializeImportedModels = () => S.importedModels.map(({ id, name, format, dataUrl }) => ({ id, name, format, dataUrl }));
// A project coming in: its models replace whatever was imported before, and are all loaded before any object is built
// from them (see loadProjectFromData).
export async function restoreImportedModels(list, seq) {
  for (let i = OBJECT_TYPES.length - 1; i >= 0; i--) if (OBJECT_TYPES[i].imported) OBJECT_TYPES.splice(i, 1);
  S.importedModels = [];
  const types = [];
  for (const saved of list || []) {
    try { types.push(await loadModelRecord({ id: saved.id, name: saved.name, format: saved.format, dataUrl: saved.dataUrl })); }
    catch (err) { console.warn(`Kallipolis: the imported model ${saved.name} failed to load`, err); }
  }
  S.importedModelSeq = seq || 1;
  App.refreshObjectThumbnails?.(types);
}
