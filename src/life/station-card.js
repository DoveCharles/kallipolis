import * as THREE from 'three';
import { S } from '../core/shared.js';
import { camera } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { makeCard } from '../ui/entity-card.js';
import { makeThumbnailDrawer } from './thumbnail.js';

// ============================================================ a bot's home station's card
// A Med booth's or Seraphorb Station's card (see medbot.js, seraphorb.js): clicked in World mode, the camera rests on
// it and its card shows what its bot is doing and its charge, with a button under the picture to go and follow the bot.
const FOLLOW_RADIUS = 10;
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();

/**
 * @param {{ id: string, title: string, kind: string (as editor/input.js FOLLOWABLE names it), find: string, bots: Map<string, object>, doing: (bot: object) => string,
 *   onFind: (bot: object) => void, onClose: () => void }} o
 */
export function makeStationCard({ id, title, kind, find, bots, doing, onFind, onClose }) {
  let followed = null, doingShown = null, chargeShown = null; // followed: the station's object id
  const card = makeCard({ id, title, onClose, action: { text: find, onClick: () => { const bot = bots.get(followed); if (bot) onFind(bot); } } });
  const draw = makeThumbnailDrawer(card.canvas);

  function thumbnail(group) {
    const mesh = group.clone(true);
    mesh.position.set(0, 0, 0); mesh.rotation.set(0, -Math.PI/6, 0); mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh), mid = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)*0.6;
    const view = new THREE.OrthographicCamera(-r, r, r, -r, 0.1, r*20);
    view.position.set(mid.x, mid.y + r*1.2, mid.z + r*4);
    view.lookAt(mid);
    return { mesh, camera: view };
  }
  function pick(clientX, clientY, out) {
    const groups = S.objects.filter(o => bots.has(o.id) && o.group).map(o => o.group);
    if (!groups.length) return null;
    raycaster.setFromCamera(pointer.set(clientX/window.innerWidth*2 - 1, -clientY/window.innerHeight*2 + 1), camera);
    const hit = raycaster.intersectObjects(groups, true)[0];
    if (!hit) return null;
    let g = hit.object;
    while (g && g.userData.objectId == null) g = g.parent;
    if (!g) return null;
    if (out) out.distance = hit.distance;
    return g.userData.objectId;
  }
  function followNow(objectId) {
    const obj = S.objects.find(o => o.id === objectId), bot = bots.get(objectId);
    if (!obj?.group || !bot) return false;
    followed = objectId;
    doingShown = chargeShown = null;
    controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, FOLLOW_RADIUS));
    card.show({ name: title + ' #' + bot.number });
    draw(thumbnail(obj.group));
    card.setFavorite({ key: kind.toLowerCase() + ':' + objectId, kind, kindLabel: title, follow: () => followNow(objectId) });
    const box = new THREE.Box3().setFromObject(obj.group);
    controls.goalTarget.copy(box.getCenter(new THREE.Vector3()));
    return true;
  }
  function followAt(clientX, clientY) {
    const objectId = pick(clientX, clientY);
    if (objectId == null || !followNow(objectId)) stop();
  }
  function stop() {
    if (followed == null) return;
    followed = null;
    controls.minRadius = CAMERA_MIN_RADIUS;
    card.hide();
  }
  // each frame
  function update() {
    if (followed == null) return;
    const bot = bots.get(followed);
    if (!bot || S.interactionMode !== 'move') { stop(); return; }
    const now = doing(bot);
    if (now !== doingShown) { doingShown = now; card.set('status', now); }
    const charge = Math.round(bot.charge*100) + '%';
    if (charge !== chargeShown) { chargeShown = charge; card.set('charge', charge); }
  }
  return { pick, followAt, stop, update };
}
