import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { camera } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';
import { makeCard } from '../ui/entity-card.js';
import { buildingKey, buildingNumber } from './footprints.js';
import { buildingKindOf, buildingTypeOf } from './building-types.js';

// ============================================================ following a building
// As for a car or a carriage: a click on a building in World mode keeps the view on it, with a card at the bottom right
// naming it (what its kind is called, and its own number — see buildingNumber), saying what it's like (from
// assets/buildings.txt, by its kind — see building-types.js) and who's inside
// (see "going indoors" in people.js), until a click elsewhere, a pan, leaving World mode, or its zone being rebuilt lets it go.
// The card itself is the shared one in ui/entity-card.js. No Kill button, and nothing to be behind the wheel of.
// followed: { zone, group, key, center } of the building the camera's on, or null
let followed = null;
const raycaster = new THREE.Raycaster();
const card = makeCard({ id: 'building-card', title: 'Building', onClose: () => stopFollowingBuilding() });
const drawThumbnail = makeThumbnailDrawer(card.canvas);

// every zone's buildings (a zone's own children named 'Building': city blocks', industrial yards' and farmsteads')
function buildingsInZones() {
  const found = [];
  S.zones.forEach(zone => (zone.buildingsGroup?.children || []).forEach((group, index) => {
    if (group.name === 'Building' && group.visible) found.push({ zone, group, index });
  }));
  return found;
}
// the building under a point on the screen (the nearest, if several are), or null
function pickBuilding(clientX, clientY) {
  if (!S.zones.length) return null;
  const buildings = buildingsInZones();
  if (!buildings.length) return null;
  raycaster.setFromCamera(new THREE.Vector2(clientX/window.innerWidth*2 - 1, -clientY/window.innerHeight*2 + 1), camera);
  const hit = raycaster.intersectObjects(buildings.map(b => b.group), true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && !buildings.some(b => b.group === o)) o = o.parent;
  return buildings.find(b => b.group === o) || null;
}
// follows whichever building's under a point on the screen, or stops following if none is
function followBuildingAt(clientX, clientY) {
  const picked = pickBuilding(clientX, clientY);
  if (!picked) { stopFollowingBuilding(); return; }
  followBuilding(picked);
}
// `picked` as pickBuilding finds it
function followBuilding(picked) {
  const box = new THREE.Box3().setFromObject(picked.group), center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const key = buildingKey(picked.zone, picked.index);
  followed = { zone: picked.zone, group: picked.group, key, center };
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(CAMERA_MIN_RADIUS, Math.min(600, radius*2.8));
  const number = buildingNumber(key), info = buildingTypeOf(buildingKindOf(picked.group, picked.zone), number);
  card.show({ ...info, name: info.name + ' #' + number });
  setBuildingCardInhabitants([]);
  drawThumbnail(thumbnailOf(picked.group, box, center, radius));
  card.setFavorite({ key: 'building:' + key, kind: 'Building', follow: () => {
    const again = buildingsInZones().find(b => buildingKey(b.zone, b.index) === key);
    if (!again) return false;
    followBuilding(again);
    return true;
  } });
}
function stopFollowingBuilding() {
  if (!followed) return;
  followed = null;
  card.hide();
}
const followedBuildingKey = () => followed ? followed.key : null;

// The card's thumbnail: a copy of the building (sharing its geometry and materials), moved to the origin, and an
// isometric camera framing it — as for a car or a carriage.
function thumbnailOf(group, box, center, radius) {
  const mesh = group.clone();
  mesh.position.sub(center);
  const elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = radius*4;
  const view = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, distance*2);
  view.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  view.lookAt(0, 0, 0);
  return { mesh, camera: view };
}

// Who's inside the followed building (see people.js): their names, one a line. `tracked` is whichever of them the camera
// means to leave with (see "waiting on someone indoors" in people.js), picked out as a train's passengers are, and
// `onPick` is told when one of the names is clicked, to make that one the one it leaves with.
function setBuildingCardInhabitants(names, tracked = -1, onPick = null) {
  card.setList('occupants', names, tracked, onPick && { title: 'Follow them out', onClick: onPick });
}

// each frame: the camera on the building, or letting go of it once it's gone (its zone rebuilt or removed) or World mode's left
export function updateBuildingFollow() {
  if (!followed) return;
  const { zone, group, center } = followed;
  if (S.interactionMode !== 'move' || !S.zones.includes(zone) || group.parent !== zone.buildingsGroup) { stopFollowingBuilding(); return; }
  controls.goalTarget.copy(center);
}

Object.assign(App, { pickBuilding, followBuildingAt, stopFollowingBuilding, followedBuildingKey, setBuildingCardInhabitants });
