// Multiplayer: each player's Name over whoever they're possessing (see net/net.js), as .net-tag labels over the view.
import * as THREE from 'three';
import { camera, renderer } from '../core/scene.js';
import { people } from '../life/people/people.js';
import { personHeight } from '../life/people/peopleTracking.js';

const FAR = 150; // (no label further off than this)
const at = new THREE.Vector3(), labels = [];

/** @param {() => Array<[number, string]>} list - [person slot, name] to label, read each frame */
export function showTags(list) {
  const frame = () => {
    requestAnimationFrame(frame);
    const tags = list(), box = renderer.domElement.getBoundingClientRect();
    tags.forEach(([i, name], k) => {
      const el = labels[k] ??= Object.assign(document.createElement('div'), { className: 'net-tag' });
      if (!el.isConnected) document.body.append(el);
      const p = people[i];
      el.hidden = !p || p.mode === 'none' || camera.position.distanceTo(at.set(p.x, p.y, p.z)) > FAR;
      if (el.hidden) return;
      at.y += personHeight(p) + 0.3;
      at.project(camera);
      el.hidden = at.z > 1;
      if (el.textContent !== name) el.textContent = name;
      el.style.transform = `translate(${box.left + (at.x + 1)/2*box.width}px, ${box.top + (1 - at.y)/2*box.height}px) translate(-50%, -100%)`;
    });
    for (let k = tags.length; k < labels.length; k++) labels[k].hidden = true;
  };
  requestAnimationFrame(frame);
}
