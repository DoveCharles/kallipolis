import * as THREE from 'three';
import { camera, frustumHalfHeightAt } from './scene.js';

// ============================================================ camera controls (math only)
// the closest the camera zooms in, except while it's following someone (see people.js)
export const CAMERA_MIN_RADIUS = 8;
const EASE_PER_FRAME = 0.15;
export const controls = {
  target: new THREE.Vector3(0, 8, 0),
  radius: 220, theta: Math.PI*0.28, phi: Math.PI*0.32,
  minRadius: CAMERA_MIN_RADIUS,
  goalRadius: 220, goalTheta: Math.PI*0.28, goalPhi: Math.PI*0.32,
  goalTarget: new THREE.Vector3(0, 8, 0),
  // set while the view's held in one place (inside a building: see buildings/interior.js) — no orbiting, panning or zooming
  locked: false,
  // set while the camera rides round something (a room's walls: see buildings/interior.js), locked or not: { place,
  // rise, zoom } — place from which way round it is (theta) to how far out and how high ({ radius, phi }), rise(dy) to
  // take it up or down for a drag of dy, and zoom(factor) to zoom by the factor zoomBy's given — orbiting going round and
  // up and down, zooming zooming, and nothing else
  hug: null,
  orbit(dx, dy) {
    if (this.hug) { this.goalTheta -= dx * 0.006; this.hug.rise(dy); return; }
    if (this.locked) return;
    this.goalTheta -= dx * 0.006;
    this.goalPhi -= dy * 0.006;
    this.goalPhi = Math.max(0.03, Math.min(Math.PI - 0.03, this.goalPhi));
  },
  pan(dx, dy) {
    if (this.locked) return;
    const panSpeed = this.radius * 0.0016;
    const forward = new THREE.Vector3(
      Math.sin(this.theta) * Math.sin(this.phi), Math.cos(this.phi), Math.cos(this.theta) * Math.sin(this.phi));
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0,1,0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    this.goalTarget.addScaledVector(right, dx * panSpeed);
    this.goalTarget.addScaledVector(up, dy * panSpeed);
  },
  zoom(deltaY) { this.zoomBy(1 + deltaY * 0.001); },
  // straight multiplier, for a pinch: the radius scales with how far the two fingers have closed or spread
  zoomBy(factor) {
    if (this.hug) { this.hug.zoom(factor); return; }
    if (this.locked) return;
    this.goalRadius = Math.max(this.minRadius, Math.min(1800, this.goalRadius * factor));
  },
  snapTop() { if (!this.locked) this.goalPhi = 0.05; },
  snapFront() { if (this.locked) return; this.goalPhi = Math.PI/2; this.goalTheta = 0; },
  snapRight() { if (this.locked) return; this.goalPhi = Math.PI/2; this.goalTheta = Math.PI/2; },
  // Eases toward the goals by EASE_PER_FRAME of the way per 1/60 s, whatever the actual frame time, so the camera trails a
  // moving target by a steady distance and a slow frame doesn't make it lurch.
  update(instant) {
    const now = performance.now(), frames = Math.min(6, Math.max(0, (now - (this.lastUpdate ?? now))*0.06));
    this.lastUpdate = now;
    const a = instant ? 1 : 1 - Math.pow(1 - EASE_PER_FRAME, frames);
    this.radius += (this.goalRadius - this.radius) * a;
    this.theta += (this.goalTheta - this.theta) * a;
    this.phi += (this.goalPhi - this.phi) * a;
    // (from the eased theta, not eased themselves, so the camera keeps to its path even as it goes round a corner)
    if (this.hug) {
      ({ radius: this.radius, phi: this.phi } = this.hug.place(this.theta));
      ({ radius: this.goalRadius, phi: this.goalPhi } = this.hug.place(this.goalTheta));
    }
    this.target.lerp(this.goalTarget, a);
    const x = this.target.x + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.target.y + this.radius * Math.cos(this.phi);
    const z = this.target.z + this.radius * Math.sin(this.phi) * Math.cos(this.theta);
    camera.position.set(x, y, z);
    camera.lookAt(this.target);
    // The orthographic camera has no distance falloff to frame the city for it, so its frustum is sized here instead, to
    // hold exactly what the perspective camera would hold at this radius — that way the switch between them is a change
    // of projection and nothing else.
    if (camera.isOrthographicCamera) {
      const h = Math.max(0.5, frustumHalfHeightAt(this.radius)), w = h * (window.innerWidth/window.innerHeight);
      if (camera.top !== h || camera.right !== w) {
        camera.top = h; camera.bottom = -h; camera.right = w; camera.left = -w;
        camera.updateProjectionMatrix();
      }
    }
  }
};
controls.update(true);
