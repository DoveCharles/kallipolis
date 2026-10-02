// Multiplayer: each player's Name over whoever they're possessing (see net/net.js), as .net-tag labels over the view.
import * as THREE from 'three';
import { camera, renderer, Y_ROAD } from '../core/scene.js';
import { people } from '../life/people/people.js';
import { personHeight } from '../life/people/peopleTracking.js';
import { cars } from '../life/traffic/state.js';
import { carHeight } from '../life/traffic/placing.js';
import { beeById } from '../life/bees.js';

// where to hang a tag: [kind, which] — a person's slot, a car's id or a bee's netId (see net.js)
function top([kind, which]) {
  if (kind === 'car') { const car = cars.find(c => c.id === which); return car && car.li >= 0 ? at.set(car.x, Y_ROAD + (car.deckY ?? 0) + carHeight(car) + 0.3, car.z) : null; }
  if (kind === 'bee') { const bee = beeById(which); return bee && bee.state !== 'hive' ? at.set(bee.at.x, bee.at.y + 0.3, bee.at.z) : null; }
  const p = people[which];
  return p && p.mode !== 'none' ? at.set(p.x, p.y + personHeight(p) + 0.3, p.z) : null;
}

const FAR = 150; // (no label further off than this)
const at = new THREE.Vector3(), labels = [];

/** @param {() => Array<[string, number, string]>} list - [kind, which, name] to label, read each frame */
export function showTags(list) {
  const frame = () => {
    requestAnimationFrame(frame);
    const tags = list(), box = renderer.domElement.getBoundingClientRect();
    tags.forEach(([kind, which, name], k) => {
      const el = labels[k] ??= Object.assign(document.createElement('div'), { className: 'net-tag' });
      if (!el.isConnected) document.body.append(el);
      el.hidden = !top([kind, which]) || camera.position.distanceTo(at) > FAR;
      if (el.hidden) return;
      at.project(camera);
      el.hidden = at.z > 1;
      if (el.textContent !== name) el.textContent = name;
      el.style.transform = `translate(${box.left + (at.x + 1)/2*box.width}px, ${box.top + (1 - at.y)/2*box.height}px) translate(-50%, -100%)`;
    });
    for (let k = tags.length; k < labels.length; k++) labels[k].hidden = true;
  };
  requestAnimationFrame(frame);
}
