import * as THREE from 'three';
import { buildingHolders } from '../core/shared.js';
import { mulberry32, pointInPolygon } from '../core/math.js';
import { disposeObject } from '../roads/roads.js';
import { footprintBounds } from './footprints.js';
import { subdivideZone } from '../zones/cutouts.js';

// A building a car's smashed into (see life/room-crash.js) is gone for good: a spot in it is kept on its zone's settings
// (settings.destroyed, saved with them), and whichever building's footprint holds that spot, whenever the zone's built,
// is swapped where it stands among the zone's children (so every other building keeps its key: buildingKey) for a heap of
// rubble. (Moving the zone's outline can put the spot in another building.)
// TODO: better rubble — broken wall chunks and beams in the building's own colours, dust, a scorch.
const RUBBLE_COLORS = [0x8a8580, 0x6f6a64, 0xa39b90, 0x5b5650, 0x9a7b62];
const rubbleMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
const chunk = new THREE.BoxGeometry(1, 1, 1);

function makeRubble(fp, base, seed) {
  const rng = mulberry32(seed >>> 0), xs = fp.map(p => p.x), zs = fp.map(p => p.z);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const count = Math.max(8, Math.min(60, Math.round((x1 - x0)*(z1 - z0)/3)));
  const mesh = new THREE.InstancedMesh(chunk, rubbleMaterial, count), m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const e = new THREE.Euler(), color = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < count && tries < count*8; tries++) {
    const x = x0 + rng()*(x1 - x0), z = z0 + rng()*(z1 - z0);
    if (!pointInPolygon({ x, z }, fp)) continue;
    const w = 0.4 + rng()*1.2, h = 0.2 + rng()*0.6, d = 0.4 + rng()*1.2;
    q.setFromEuler(e.set((rng() - 0.5)*0.6, rng()*Math.PI, (rng() - 0.5)*0.6));
    mesh.setMatrixAt(n, m.compose(new THREE.Vector3(x, base + h*0.3, z), q, new THREE.Vector3(w, h, d)));
    mesh.setColorAt(n++, color.setHex(RUBBLE_COLORS[Math.floor(rng()*RUBBLE_COLORS.length)]));
  }
  mesh.count = n;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'Rubble';
  mesh.userData.rubble = true;
  return mesh;
}

/** While a zone's built (see subdivideZone): its destroyed buildings swapped for rubble. */
export function wreckDestroyed(zone) {
  const spots = zone.settings?.destroyed;
  if (!spots?.length) return;
  const list = zone.buildingsGroup.children;
  spots.forEach((spot, k) => {
    const i = list.findIndex(g => g.userData.footprint?.length >= 3 && !g.userData.rubble && pointInPolygon(spot, g.userData.footprint));
    if (i < 0) return;
    const old = list[i];
    old.updateMatrixWorld(true);
    const rubble = makeRubble(old.userData.footprint, new THREE.Box3().setFromObject(old).min.y, Math.imul(k + 1, 0x9E3779B1) ^ Math.round(spot.x*97 + spot.z*13));
    rubble.parent = zone.buildingsGroup;
    list[i] = rubble;
    old.parent = null;
    disposeObject(old);
  });
}

/** Knock a building down for good (see wreckDestroyed); its zone's built again. */
export function destroyBuilding(group) {
  const zone = buildingHolders().find(z => z.buildingsGroup === group.parent);
  const fp = group.userData.footprint;
  if (!zone || zone.zoneType === 'mall' || !zone.settings || !fp || fp.length < 3) return false;
  let spot = footprintBounds(group).c;
  if (!pointInPolygon(spot, fp)) spot = { x: (fp[0].x + fp[1].x + fp[2].x)/3, z: (fp[0].z + fp[1].z + fp[2].z)/3 };
  zone.settings.destroyed = [...(zone.settings.destroyed ?? []), { x: spot.x, z: spot.z }];
  subdivideZone(zone);
  return true;
}
