import * as THREE from 'three';
import { scene, camera, sunOffset } from '../core/scene.js';
import { ear, playSound } from '../audio/sfx.js';
import { groundBelow } from '../core/ground-probe.js';
import { addMoney } from '../ui/money.js';
import { NO_GROUND_FALLBACK } from './giblets.js';

// Coins dropped by the dead (their wallet, see newPerson in people/people.js): thrown out, land, and when the pointer
// passes over one it curves up behind the money indicator (#morality-meter .money), spinning and glinting, and pays out
// as it leaves the top of the screen.
const KINDS = [
  { value: 100, color: 0xe8b830 }, // gold
  { value: 10, color: 0xc8ccd4 },  // silver
  { value: 1, color: 0xb8683a },   // copper
];
const RADIUS = 0.12, THICK = 0.03, GRAVITY = 9.8, MAX_COINS = 300, LIFE = 180;
const HOVER_PX = 44, FLY_TIME = 1.1, SPIN = 14, END_PX = 12, CURVE = 5;
// resting clear of park grass shells (GRASS_SHELL_HEIGHT 0.03, zones/surface-detail.js)
const LIFT = 0.04, WOBBLE_TIME = 1.6, FLIP_CHANCE = 0.4, TILT = 0.35, WHIRL = 25;
const geometry = new THREE.CylinderGeometry(RADIUS, RADIUS, THICK, 20);
const materials = KINDS.map(k => new THREE.MeshStandardMaterial({ color: k.color, metalness: 0.75, roughness: 0.28,
  polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10 })); // (over blood splats -7 and chunks -6: giblets.js)

const coins = [];
const pointer = { x: -1e4, y: -1e4 };
window.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; });
const moneyEl = document.querySelector('#morality-meter .money');
const WHITE = new THREE.Color(0xffffff), v = new THREE.Vector3(), n = new THREE.Vector3(), h = new THREE.Vector3(), axis = new THREE.Vector3();
const spinQ = new THREE.Quaternion(), yawQ = new THREE.Quaternion();
const FLAT_TO_VIEW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI/2), Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

/**
 * Throw a wallet's worth of coins out from `at`: fewest coins (gold 100, silver 10, copper 1).
 * @param {{x: number, y: number, z: number}} at @param {number} amount
 */
export function dropCoins(at, amount) {
  amount = Math.floor(amount);
  const ground = groundBelow(at.x, at.y + 1, at.z, NO_GROUND_FALLBACK);
  for (let k = 0; k < KINDS.length; k++) {
    for (let n = Math.floor(amount / KINDS[k].value); n > 0; n--) {
      if (coins.length >= MAX_COINS) removeCoin(0);
      const mesh = new THREE.Mesh(geometry, materials[k].clone());
      mesh.material.emissive.setHex(KINDS[k].color).lerp(WHITE, 0.5); mesh.material.emissiveIntensity = 0;
      mesh.name = 'Coin'; // (not ground: core/ground-probe.js)
      mesh.position.set(at.x, at.y + 1, at.z);
      scene.add(mesh);
      const a = Math.random()*Math.PI*2, s = 0.3 + Math.random()*0.7;
      coins.push({ mesh, kind: k, state: 'fall', ground, vx: Math.sin(a)*s, vy: 3 + Math.random()*2, vz: Math.cos(a)*s,
        tumble: new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(12), born: performance.now()/1000, bounced: false });
    }
    amount %= KINDS[k].value;
  }
}

// a spinning coin's quiet rattle
const tinkle = (at, volume) => playSound('coinspin', at, volume);

// the money indicator shaking as a coin's paid in
function shakeMoney() {
  moneyEl?.animate([{ transform: 'translate(0, 0)' }, { transform: 'translate(-3px, 1px) rotate(-2deg)' }, { transform: 'translate(3px, -1px) rotate(2deg)' },
    { transform: 'translate(-2px, -1px) rotate(-1deg)' }, { transform: 'translate(2px, 1px) rotate(1deg)' }, { transform: 'translate(0, 0)' }], { duration: 300 });
}

function removeCoin(i) {
  const c = coins[i];
  scene.remove(c.mesh);
  c.mesh.material.dispose();
  coins.splice(i, 1);
}

// a screen point (px) `dist` along the camera's ray through it, into `out`
function worldAt(sx, sy, dist, out) {
  out.set(sx/innerWidth*2 - 1, 1 - sy/innerHeight*2, 0.5).unproject(camera).sub(camera.position).normalize();
  return out.multiplyScalar(dist).add(camera.position);
}
const expo = (f, k) => (Math.exp(k*f) - 1)/(Math.exp(k) - 1);

let last = 0;
/** Each frame (main.js). @param {number} t - seconds */
export function updateCoins(t) {
  const dt = Math.min(0.05, last ? t - last : 0); last = t;
  if (!coins.length) return;
  const locked = !!document.pointerLockElement;
  const px = locked ? innerWidth/2 : pointer.x, py = locked ? innerHeight/2 : pointer.y;
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i], m = c.mesh;
    if (c.state === 'fall') {
      c.vy -= GRAVITY*dt;
      m.position.x += c.vx*dt; m.position.y += c.vy*dt; m.position.z += c.vz*dt;
      m.rotation.x += c.tumble.x*dt; m.rotation.y += c.tumble.y*dt; m.rotation.z += c.tumble.z*dt;
      const floor = c.ground + LIFT + THICK/2;
      if (m.position.y <= floor && c.vy < 0) {
        m.position.y = floor;
        if (!c.bounced && c.vy < -2) { c.bounced = true; c.vy *= -0.3; c.vx *= 0.4; c.vz *= 0.4; c.tumble.multiplyScalar(0.3); }
        else Object.assign(c, { state: 'rest', floor, stage: 'flat', hy: 0, hv: 0, bounces: 0, hopIn: 0.25 + Math.random(), wt: 0, air: 0, airTime: 1, flip: 0, flipRate: 0, prec: Math.random()*6, yaw: Math.random()*6 });
      }
    }
    if (c.state === 'rest') {
      if (t - c.born > LIFE) { removeCoin(i); continue; }
      // a cycle, one fluid movement: flat and still; hops up (now and then extra high, with a flip), tipping over as it
      // rises and circling ever faster till it lands, fastest then; then wobbles down flush, slowing to a stop
      let tilt = 0;
      if (c.stage === 'flat' && (c.hopIn -= dt) <= 0) {
        c.stage = 'air'; c.air = 0;
        const high = Math.random() < FLIP_CHANCE;
        c.hv = high ? 3 + Math.random() : 1.2 + Math.random()*0.6;
        c.airTime = 2*c.hv/GRAVITY;
        c.flip = 0; c.flipRate = high ? Math.PI*2/c.airTime : 0;
      } else if (c.stage === 'air') {
        c.hv -= GRAVITY*dt; c.hy += c.hv*dt; c.flip += c.flipRate*dt;
        const a = Math.min(1, (c.air += dt)/c.airTime);
        tilt = TILT*Math.min(1, a*2)**2*(3 - 2*Math.min(1, a*2)); // (tipped over by the top of the hop)
        c.prec += dt*WHIRL*a**1.5;
        if (c.hy <= 0) { c.hy = 0; c.flip = c.flipRate = 0; c.stage = 'wobble'; c.wt = 0; tinkle(m.position, 0.35); }
      } else if (c.stage === 'wobble') {
        const u = Math.min(1, c.wt += dt/WOBBLE_TIME);
        tilt = TILT*(1 - u)**1.5;
        c.prec += dt*WHIRL*(1 - u);
        if (Math.random() < dt*8*(1 - u)) tinkle(m.position, 0.2*(1 - u) + 0.05); // (rattling as it whirls)
        if (u >= 1) { c.stage = 'flat'; c.hopIn = 0.5 + Math.random()*1.25; }
      }
      yawQ.setFromAxisAngle(Y, c.yaw);
      m.quaternion.setFromAxisAngle(axis.set(Math.cos(c.prec), 0, Math.sin(c.prec)), tilt).multiply(yawQ).multiply(spinQ.setFromAxisAngle(X, c.flip));
      m.position.y = c.floor + c.hy + RADIUS*Math.sin(tilt);
      // glints as its face turns toward the view (and the sun)
      n.set(0, 1, 0).applyQuaternion(m.quaternion);
      h.copy(camera.position).sub(m.position).normalize().multiplyScalar(2).add(v.copy(sunOffset).normalize()).normalize();
      m.material.emissiveIntensity = Math.max(0, n.dot(h))**40*1.2;
      v.copy(m.position).project(camera);
      if (v.z > 1) continue;
      const sx = (v.x + 1)/2*innerWidth, sy = (1 - v.y)/2*innerHeight;
      if ((sx - px)**2 + (sy - py)**2 < HOVER_PX*HOVER_PX) {
        c.state = 'fly';
        // each its own way up, so a pile goes as a stream: a short wait, its own time, curve, lean and spin
        c.flyT = -Math.random()*0.25; c.flyTime = FLY_TIME*(0.8 + Math.random()*0.5); c.curve = CURVE*(0.7 + Math.random()*0.6);
        c.xPow = 2 + Math.random()*2; c.dx = (Math.random() - 0.5)*30; c.sway = (Math.random() - 0.5)*120; c.spinRate = SPIN*(0.7 + Math.random()*0.6); c.sx = sx; c.sy = sy; c.dist = m.position.distanceTo(camera.position); c.spin = 0;
        const startPx = RADIUS*2/(2*c.dist*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2))*innerHeight;
        c.endScale = 0.5 + 0.5*END_PX/Math.max(1, startPx); // (halfway between its size there and END_PX)
        playSound('coin', ear);
        // (drawn last, over everything: in the see-through pass, after faded paths and the like, which would otherwise paint over it)
        Object.assign(m.material, { transparent: true, depthTest: false, depthWrite: false, needsUpdate: true }); m.renderOrder = 999;
      }
      continue;
    }
    if (c.state === 'fly') {
      if ((c.flyT += dt/c.flyTime) < 0) continue;
      const f = Math.min(1, c.flyT);
      const box = moneyEl?.getBoundingClientRect();
      const tx = (box ? box.left + box.width/2 : innerWidth/2) + c.dx;
      const endY = -60; // (off the top)
      // across first, then shooting up: an exponential curve (x eases out, y grows exponentially)
      const sx = c.sx + (tx - c.sx)*(1 - (1 - f)**c.xPow) + c.sway*Math.sin(Math.PI*f), sy = c.sy + (endY - c.sy)*expo(f, c.curve);
      worldAt(sx, sy, c.dist, m.position);
      m.scale.setScalar(1 + (c.endScale - 1)*f);
      c.spin += c.spinRate*dt*(1 + f);
      spinQ.setFromAxisAngle(Y, c.spin);
      m.quaternion.copy(camera.quaternion).multiply(spinQ).multiply(FLAT_TO_VIEW);
      const glint = Math.abs(Math.cos(c.spin))**24; // (a flash each time the face turns to the view)
      m.material.emissiveIntensity = glint*1.2;
      if (f >= 1 || sy < -30) { addMoney(KINDS[c.kind].value); shakeMoney(); removeCoin(i); }
    }
  }
}
