import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { groundCandidates, refreshSceneIndex } from './scene.js';

// Finds the solid ground straight below a point, for anything that falls and lands (gibs, body parts, a bee's flecks).
//
// Only plain meshes are ray-tested (groundCandidates, kept by the scene index in core/scene.js and rebuilt whenever
// anything is added or removed, so land and water edits are picked up with no registration): instanced and skinned
// meshes are never ground, and raycasting them is by far the most expensive case.
//
// Each candidate a ray could reach is given a bounding volume hierarchy (three-mesh-bvh) the first time, so a ray tests
// the few triangles near it rather than every one — the ground is one mesh spanning the map, so without it every ray
// tested all of its triangles. A hierarchy is rebuilt when its geometry is swapped (a new geometry has none) or its
// positions change in place (the attribute's version moves on). Built 'indirect', so the geometry itself is untouched.
// Meshes without one (small ones, or anything else in the app raycasting) fall back to three.js's own raycast.
//
// Visibility and material transparency can change without anything being added or removed, so they're checked per hit.
//
// Excluded by name: 'Water', the water surface (gibs fall through it: see WATER_LEVEL in updateGiblets); 'WaterMask',
// a stencil helper over the same area; and 'Beach', the sloped sand running from the shore down under the water, which
// would otherwise catch gibs partway down a slope that's still water. The main ground mesh has a hole cut under open
// water, so a ray there finds nothing and falls through to `fallback`.
const NON_GROUND_NAMES = new Set(['Water', 'WaterMask', 'Beach']);
const MIN_UPWARD_NORMAL = 0.5; // a hit face must point at least this far upward to be stood on

const isShown = o => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0), normal = new THREE.Vector3();
const hits = [], sphere = new THREE.Sphere();
const BVH_MIN_TRIANGLES = 128; // below this, testing every triangle is as quick as walking a hierarchy

THREE.Mesh.prototype.raycast = acceleratedRaycast;

function ensureBVH(geometry) {
  const position = geometry.attributes.position;
  if (!position || (geometry.index ? geometry.index.count : position.count)/3 < BVH_MIN_TRIANGLES) return;
  if (geometry.boundsTree && geometry.userData.bvhVersion === position.version) return;
  geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
  geometry.userData.bvhVersion = position.version;
}
// give a hierarchy to every candidate whose bounds the ray passes through, and no others
function prepareCandidates() {
  for (const mesh of groundCandidates) {
    const geometry = mesh.geometry;
    if (!geometry) continue;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (ray.ray.intersectsSphere(sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld))) ensureBVH(geometry);
  }
}

/**
 * The height of the first solid, upward-facing, shown surface straight below (x, fromY, z).
 * @param {number} x
 * @param {number} fromY - where the ray starts
 * @param {number} z
 * @param {number} fallback - what to return when nothing is found
 * @returns {number}
 */
export function groundBelow(x, fromY, z, fallback) {
  refreshSceneIndex();
  ray.set(origin.set(x, fromY, z), DOWN);
  hits.length = 0;
  prepareCandidates();
  ray.intersectObjects(groundCandidates, false, hits);
  for (const hit of hits) {
    const o = hit.object;
    if (!hit.face || NON_GROUND_NAMES.has(o.name) || !isShown(o)) continue;
    const material = Array.isArray(o.material) ? o.material[hit.face.materialIndex] : o.material;
    // (see-through only counts as not there when it's mostly see-through: a dirt path is 'transparent' only for its faded edges)
    if (!material || (material.transparent && material.opacity < 0.5) || material.visible === false) continue;
    if (normal.copy(hit.face.normal).transformDirection(o.matrixWorld).y < MIN_UPWARD_NORMAL) continue;
    return hit.point.y;
  }
  return fallback;
}
