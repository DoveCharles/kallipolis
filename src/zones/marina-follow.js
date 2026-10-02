import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { camera } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { startFlying, endFlying } from '../life/possession.js';
import { chaseBehind } from '../life/flight.js';
import { makeThumbnailDrawer } from '../life/thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';
import { WATER_LEVEL } from '../water/water.js';
import { BOATS, takeHelm, giveHelmBack, unmoor } from './marina.js';

// ---------------------------------------------------------- following a boat
// A marina's roamers (the boats that go out: zones/marina.js) clicked in World mode: the camera follows, with a card from
// assets/text/boats.txt (a [section] per kind). Its picture takes the helm (startFlying's chase camera and keys, charged
// as a vehicle); letting go sends it home to its berth (giveHelmBack).
const boatText = loadTypeText('assets/text/boats.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'],
  placeholder: { default: { name: ['Boat'], mood: ['⛵'], loves: ['Calm water'], hates: ['Rocks'] } },
});
const card = makeCard({
  id: 'boat-card',
  title: 'Boat',
  onClose: () => stopFollowingBoat(),
  thumb: { title: 'Steer it', onClick: () => steerBoat() },
  labels: { occupants: 'Aboard' },
});
const drawThumb = makeThumbnailDrawer(card.canvas);

let followed = null; // { zoneId, index }
let steered = null;  // the roamer at the helm
const everyBoat = () => S.zones.flatMap(z => z.marinaRoamers || []);
const followedBoat = () => followed ? S.zones.find(z => z.id === followed.zoneId)?.marinaRoamers?.[followed.index] || null : null;
// a roamer, or a moored boat (in its marina's shared mesh) lifted out into one (unmoor) — the latter only on a click
function pickBoat(clientX, clientY, out, lift = false) {
  const zones = S.zones.filter(z => z.marinaRoamers?.length || z.marinaBoatMesh);
  if (!zones.length) return null;
  App.raycaster.setFromCamera(App.ndcOf(clientX, clientY), camera);
  const meshes = zones.flatMap(z => [...(z.marinaRoamers || []).map(r => r.mesh), ...(z.marinaBoatMesh ? [z.marinaBoatMesh] : [])]);
  const hit = App.raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  if (out) out.distance = hit.distance;
  const roamer = everyBoat().find(r => r.mesh === hit.object);
  if (roamer) return roamer;
  const zone = zones.find(z => z.marinaBoatMesh === hit.object), v = hit.face?.a ?? -1;
  const i = (zone?.marinaMoored || []).findIndex(m => v >= m.range.start && v < m.range.start + m.range.count);
  if (i < 0) return null;
  return lift ? unmoor(zone, i) : true;
}
function followBoatAt(clientX, clientY) {
  const r = pickBoat(clientX, clientY, null, true);
  if (r) followBoat(r); else stopFollowingBoat();
}
function thumbnailOf(r) {
  const mesh = r.mesh.clone();
  mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0);
  const rad = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius;
  const elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = rad*4;
  const view = new THREE.OrthographicCamera(-rad, rad, rad, -rad, 0.1, distance*2);
  view.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  view.lookAt(0, 0, 0);
  return { mesh, camera: view };
}
function followBoat(r) {
  if (followedBoat() !== r) stopSteering();
  followed = { zoneId: r.zone.id, index: r.index };
  const size = BOATS[r.kind].L;
  controls.minRadius = Math.max(1.2, size*0.5);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, size*3));
  const number = everyBoat().indexOf(r) + 1, type = boatText.of(r.kind, number);
  card.show({ ...type, name: type.name + ' #' + number });
  drawThumb(thumbnailOf(r));
  const { zoneId, index } = followed, moored = r.mooredIndex;
  card.setFavorite({ key: 'boat:' + zoneId + ':' + (moored != null ? 'm' + moored : index), kind: 'Boat', follow: () => {
    const zone = S.zones.find(z => z.id === zoneId);
    const again = moored != null ? zone && unmoor(zone, moored) : zone?.marinaRoamers?.[index];
    if (!again) return false;
    followBoat(again);
    return true;
  } });
}
function stopFollowingBoat() {
  if (!followed) return;
  stopSteering();
  followed = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  card.hide();
}
function steerBoat() {
  const r = followedBoat();
  if (!r || steered === r || !startFlying(stopSteering, { kind: 'flying', verb: 'steering',
    keys: 'W/S for ahead and astern · A/D to steer · Shift for power · Space to stop', touch: 'Stick to steer · Run for power · Brake to stop',
    at: () => steered?.mesh.position })) return;
  steered = r;
  takeHelm(r);
  controls.goalRadius = Math.max(controls.minRadius, BOATS[r.kind].L*2.5);
}
function stopSteering() {
  if (!steered) return;
  const r = steered;
  steered = null;
  endFlying();
  giveHelmBack(r);
}
// each frame, after updateMarinas
export function updateBoatFollow() {
  if (followed && S.interactionMode !== 'move') { stopFollowingBoat(); return; }
  const r = followedBoat();
  if (steered && steered !== r) { steered = null; endFlying(); } // (a rebuild made fresh boats)
  if (!r) { if (followed) stopFollowingBoat(); return; }
  controls.goalTarget.set(r.x, WATER_LEVEL + 1, r.z);
  if (r === steered) chaseBehind(Math.PI/2 - r.yaw);
}

Object.assign(App, { pickBoat, followBoatAt, stopFollowingBoat });
