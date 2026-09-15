import * as THREE from 'three';
import { camera } from './scene.js';

// ============================================================ camera controls (math only)
export const controls = {
  target: new THREE.Vector3(0, 8, 0),
  radius: 220, theta: Math.PI*0.28, phi: Math.PI*0.32,
  goalRadius: 220, goalTheta: Math.PI*0.28, goalPhi: Math.PI*0.32,
  goalTarget: new THREE.Vector3(0, 8, 0),
  orbit(dx, dy) {
    this.goalTheta -= dx * 0.006;
    this.goalPhi -= dy * 0.006;
    this.goalPhi = Math.max(0.03, Math.min(Math.PI - 0.03, this.goalPhi));
  },
  pan(dx, dy) {
    const panSpeed = this.radius * 0.0016;
    const forward = new THREE.Vector3(
      Math.sin(this.theta) * Math.sin(this.phi), Math.cos(this.phi), Math.cos(this.theta) * Math.sin(this.phi));
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0,1,0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    this.goalTarget.addScaledVector(right, dx * panSpeed);
    this.goalTarget.addScaledVector(up, dy * panSpeed);
  },
  zoom(deltaY) {
    this.goalRadius *= (1 + deltaY * 0.001);
    this.goalRadius = Math.max(8, Math.min(1800, this.goalRadius));
  },
  snapTop() { this.goalPhi = 0.05; },
  snapFront() { this.goalPhi = Math.PI/2; this.goalTheta = 0; },
  snapRight() { this.goalPhi = Math.PI/2; this.goalTheta = Math.PI/2; },
  update(instant) {
    const a = instant ? 1 : 0.15;
    this.radius += (this.goalRadius - this.radius) * a;
    this.theta += (this.goalTheta - this.theta) * a;
    this.phi += (this.goalPhi - this.phi) * a;
    this.target.lerp(this.goalTarget, a);
    const x = this.target.x + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.target.y + this.radius * Math.cos(this.phi);
    const z = this.target.z + this.radius * Math.sin(this.phi) * Math.cos(this.theta);
    camera.position.set(x, y, z);
    camera.lookAt(this.target);
  }
};
controls.update(true);
