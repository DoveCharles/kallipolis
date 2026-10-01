import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, camera, SKY_ENV_MAP } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { makeCard } from '../ui/entity-card.js';
import { makeThumbnailDrawer } from './thumbnail.js';
import { makeStationCard } from './station-card.js';
import { SERAPH_RING } from '../objects/object-types.js';
import { solidTopAt } from '../buildings/footprints.js';
import { people, isGone, standingOf, witness } from './people/people.js';
import { personHeight } from './people/peopleTracking.js';
import { strikeLightning } from './lightning.js';
import { updateSeraphorbSounds } from '../audio/seraphorb.js';

// ============================================================ Seraphorbs
// Every Seraph ring put down in the Objects tab ('seraphring' in objects/object-types.js) holds a chrome orb. Charged,
// it rises out of the ring and drifts about the city round it; any villain it spots (standingOf 'villainous': vampires
// included) it speeds after, hovers over their head a moment, and smites with a bolt straight down out of itself (see
// lightning.js). Flying and smiting run its charge down; low, it goes back to its ring to charge. Its hum: audio/seraphorb.js.
const ORB_R = 0.5;                   // m
const REST = SERAPH_RING.y + Math.sqrt((ORB_R + SERAPH_RING.tube)**2 - SERAPH_RING.r**2); // its middle, sat in the ring
const CRUISE = 16;                   // m above its ring's ground it drifts about at
const SPEED = 5, RUSH = 3.5;         // m/s drifting; × chasing
const ACCEL = 2.5;                   // how quickly (per s) it comes round to the speed and way it wants
const PATROL_RADIUS = 160;           // m round the ring it drifts to
const SIGHT = 60;                    // m it spots a villain from
const LEASH = 220;                   // m from the ring it'll chase, and gives up past
const HOVER = 1.4;                   // m over their head (to its middle) it smites from
const SMITE_HOLD = 1.5;              // s it hovers there, building up, before it strikes
const SMITE_NEAR = 1.2;              // m from over their head (across, and up or down) it's close enough to start smiting
const NEAR_HEAD = 4;                 // m away (across) it starts dropping to their head
const PAUSE = [0.5, 3];              // s it hangs between patrol points
const DRAIN = 1/240, SMITE_COST = 0.2, LOW = 0.15, CHARGE_TIME = 15;
const SPARE = 20;                    // s someone it's struck at is left alone (a ghost, the hearted, a vampire reviving)
const BOB = 0.25;                    // m it bobs, drifting
const CLEAR = 2.5;                   // m it keeps over any roof it's over or heading for
const LOOK = [0, 3, 7, 12, 18];      // m ahead (toward where it's going) it checks for roofs
const SIDE = 1.2;                    // m either side of that line it checks too

const geometry = new THREE.SphereGeometry(ORB_R, 40, 20);
const SPIN = 0.25;                   // rad/s it turns while out of its ring

// ---- scare-eye balloon eyes engraved into the chrome, one on each face of a dodecahedron (the poles and two
// rings of 5): drawn per texel, open and shut (a straight line), as height (bump), roughness and glow maps
const EYE_A = 0.4, EYE_H = 0.85, EYE_LINE = 0.7, EYE_W = 0.014; // rad half-width; lid height, slit half-length (shares of it); groove half-width
function eyeMaps() {
  const W = 2048, H = 1024, px = Math.PI*2/W;
  const ring = Math.atan(0.5), eyes = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)];
  for (let i = 0; i < 10; i++) { const lat = i < 5 ? ring : -ring, lon = (i + (i < 5 ? 0 : 0.5))*Math.PI*2/5; eyes.push(new THREE.Vector3(Math.cos(lat)*Math.cos(lon), Math.sin(lat), Math.cos(lat)*Math.sin(lon))); }
  const frames = eyes.map(c => { const e = Math.abs(c.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0).cross(c).normalize(); return [c, e, c.clone().cross(e)]; });
  const h = EYE_A*EYE_H, R = (EYE_A*EYE_A + h*h)/(2*h);
  const maps = Array.from({ length: 5 }, () => new Uint8ClampedArray(W*H*4)), p = new THREE.Vector3();
  for (let j = 0; j < H; j++) {
    const th = (j + 0.5)/H*Math.PI;
    for (let i = 0; i < W; i++) {
      const ph = (i + 0.5)/W*Math.PI*2;
      p.set(-Math.cos(ph)*Math.sin(th), Math.cos(th), Math.sin(ph)*Math.sin(th));
      let best = frames[0], bd = -2;
      for (const f of frames) { const d = p.dot(f[0]); if (d > bd) { bd = d; best = f; } }
      const u = p.dot(best[1])/bd, v = p.dot(best[2])/bd;
      const lid = Math.abs(Math.max(Math.hypot(u, v + R - h), Math.hypot(u, v - R + h)) - R);
      const slit = Math.abs(v) < EYE_A*EYE_LINE ? Math.abs(u) : Math.hypot(u, Math.abs(v) - EYE_A*EYE_LINE);
      const shut = Math.hypot(Math.max(0, Math.abs(u) - EYE_A), v), k = (j*W + i)*4;
      const g = Math.min(1, Math.max(0, (EYE_W - Math.min(lid, slit))/px + 0.5)), gs = Math.min(1, Math.max(0, (EYE_W - shut)/px + 0.5));
      [255*(1 - g), 15 + 95*g, 255*g, 255*(1 - gs), 15 + 95*gs].forEach((x, m) => { const d = maps[m]; d[k] = d[k+1] = d[k+2] = x; d[k+3] = 255; });
    }
  }
  return maps.map(d => { const t = new THREE.DataTexture(d, W, H); t.flipY = true; t.wrapS = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; return t; });
}
const [EYE_BUMP, EYE_ROUGH, EYE_GLOW, SHUT_BUMP, SHUT_ROUGH] = eyeMaps();
const engraved = () => ({ roughness: 1, roughnessMap: EYE_ROUGH, bumpMap: EYE_BUMP, bumpScale: 1.5 });
const EYE_GLOW_COLOR = 0xff3020, EYE_GLOW_RISE = 4; // its eyes' glow, once it's spotted a villain; 1/s it fades in and out at

// ---- the build-up: white motes swirling round it while it hovers to smite, sucked into it just before the bolt
const MOTES = 16, MOTES_MAX = MOTES*8;
const MOTE_R = [1.1, 2.2];           // m from its middle they swirl at
const MOTE_SIZE = 0.07;              // m
const MOTE_BORN = 0.35, MOTE_GROW = 0.2, SUCK_FROM = 0.72; // (shares of SMITE_HOLD: each starts growing at a random point before the first, takes the second to reach full size, and all are sucked in from the third)
const motes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), MOTES_MAX);
motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
motes.count = 0;
motes.frustumCulled = false;
motes.name = 'SeraphorbMotes';
scene.add(motes);
// each mote's own orbit: a tilted circle (u, w its axes), speed and start
function makeMotes() {
  return Array.from({ length: MOTES }, () => {
    const n = new THREE.Vector3().randomDirection(), u = new THREE.Vector3().randomDirection().cross(n).normalize(), w = n.clone().cross(u);
    return { u, w, r: MOTE_R[0] + Math.random()*(MOTE_R[1] - MOTE_R[0]), spin: (2 + Math.random()*3)*(Math.random() < 0.5 ? -1 : 1), born: Math.random()*MOTE_BORN, at: Math.random()*Math.PI*2, wobble: Math.random()*Math.PI*2 };
  });
}
const moteMatrix = new THREE.Matrix4(), moteAt = new THREE.Vector3(), moteSize = new THREE.Vector3(), noTurn = new THREE.Quaternion();
function drawMotes(orb, n, t) {
  const f = 1 - orb.timer/SMITE_HOLD, suck = Math.max(0, (f - SUCK_FROM)/(1 - SUCK_FROM));
  const pull = 1 - suck*suck; // (slow at first, then all at once)
  for (const m of orb.motes) {
    if (n >= MOTES_MAX) break;
    const a = m.at + orb.moteSpin*m.spin, r = m.r*pull*(1 + 0.12*Math.sin(t*5 + m.wobble)) + ORB_R*0.6*(1 - pull);
    moteAt.set(orb.x, orb.y, orb.z).addScaledVector(m.u, Math.cos(a)*r).addScaledVector(m.w, Math.sin(a)*r);
    const g = Math.min(1, Math.max(0, (f - m.born)/MOTE_GROW)), grow = 1 - (1 - g)**3; // (from nothing, easing out to full size)
    if (!grow) continue;
    const s = MOTE_SIZE*grow*(1 - 0.6*suck);
    motes.setMatrixAt(n++, moteMatrix.compose(moteAt, noTurn, moteSize.set(s, s, s)));
  }
  return n;
}
const orbs = new Map(); // ring object id → orb
let orbNumbers = 0;
const spared = new WeakMap(); // person → when last struck at

function makeOrb(obj) {
  const material = new THREE.MeshStandardMaterial({ ...engraved(), color: 0xe6ebf0, metalness: 1, envMap: SKY_ENV_MAP, emissive: 0x9fc4ff, emissiveIntensity: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  const glowMaterial = new THREE.MeshBasicMaterial({ color: EYE_GLOW_COLOR, map: EYE_GLOW, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const glowMesh = new THREE.Mesh(geometry, glowMaterial);
  glowMesh.scale.setScalar(1.003); glowMesh.visible = false;
  mesh.add(glowMesh);
  mesh.castShadow = true;
  mesh.name = 'Seraphorb';
  scene.add(mesh);
  const orb = { obj, mesh, material, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, number: ++orbNumbers, motes: makeMotes(), moteSpin: 0, state: 'charging', charge: 1, goal: null, timer: 0, target: null, scan: 0, glow: 0, glowMaterial, glowMesh, eyeGlow: 0, shut: null };
  const at = restPoint(orb);
  orb.x = at.x; orb.y = at.y; orb.z = at.z;
  return orb;
}
function removeOrb(id) {
  const orb = orbs.get(id);
  if (!orb) return;
  letGo(orb);
  orb.mesh.removeFromParent();
  orb.material.dispose();
  orb.glowMaterial.dispose();
  orbs.delete(id);
  if (followed === orb) stopFollowingSeraphorb();
}

// the ring's middle, where it rests, as the ring stands now
const local = new THREE.Vector3();
function restPoint(orb) {
  const g = orb.obj.group;
  g.updateMatrixWorld();
  return local.set(0, REST, 0).applyMatrix4(g.matrixWorld);
}
const groundY = orb => orb.obj.group.position.y;
function patrolPoint(orb) {
  const angle = Math.random()*Math.PI*2, r = (0.2 + 0.8*Math.sqrt(Math.random()))*PATROL_RADIUS;
  return { x: orb.obj.x + Math.sin(angle)*r, y: groundY(orb) + CRUISE*(0.8 + Math.random()*0.4), z: orb.obj.z + Math.cos(angle)*r };
}
function letGo(orb) {
  if (orb.target?.seraphorb === orb) orb.target.seraphorb = null;
  orb.target = null;
}
// the lowest it may fly on its way toward (x, z): CLEAR over the highest roof under it or along the way ahead
function floorToward(orb, x, z) {
  const dx = x - orb.x, dz = z - orb.z, d = Math.hypot(dx, dz), ux = d ? dx/d : 0, uz = d ? dz/d : 0;
  let top = -Infinity;
  for (const a of LOOK) {
    const along = Math.min(a, d), px = orb.x + ux*along, pz = orb.z + uz*along;
    top = Math.max(top, solidTopAt(px, pz), solidTopAt(px - uz*SIDE, pz + ux*SIDE), solidTopAt(px + uz*SIDE, pz - ux*SIDE));
    if (a >= d) break;
  }
  return top + CLEAR + ORB_R;
}
// steer toward (x, y, z) at up to `speed`, slowing into it, over any buildings in the way; true once there
function flyTo(orb, x, y, z, speed, dt, within = 0.3) {
  const floor = floorToward(orb, x, z);
  y = Math.max(y, floor);
  const dx = x - orb.x, dy = y - orb.y, dz = z - orb.z, d = Math.hypot(dx, dy, dz);
  const want = Math.min(speed*(S.peopleSpeed ?? 1), d*1.5)/(d || 1), k = Math.min(1, ACCEL*dt);
  const climb = floor > orb.y + 0.3 ? 0.15 : 1; // (a roof ahead and not over it yet: up first, barely forward)
  orb.vx += (dx*want*climb - orb.vx)*k; orb.vy += (dy*want - orb.vy)*k; orb.vz += (dz*want*climb - orb.vz)*k;
  orb.x += orb.vx*dt; orb.y += orb.vy*dt; orb.z += orb.vz*dt;
  return d < within;
}
function canSmite(orb, p, t) {
  return !!p && !isGone(p) && p.mode !== 'indoors' && !p.punched?.revive && standingOf(p) === 'villainous'
    && !(t - (spared.get(p) ?? -Infinity) < SPARE) && Math.hypot(p.x - orb.obj.x, p.z - orb.obj.z) < LEASH;
}
function spot(orb, t) {
  let best = null, bestD = SIGHT;
  for (const p of people) {
    if (!p || (p.seraphorb && p.seraphorb !== orb) || !canSmite(orb, p, t)) continue;
    const d = Math.hypot(p.x - orb.x, p.z - orb.z);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}
const overHead = p => ({ x: p.x, y: p.y + personHeight(p) + HOVER, z: p.z });

function updateOrb(orb, dt, t) {
  const p = orb.target;
  if (orb.state !== 'charging') orb.charge = Math.max(0, orb.charge - DRAIN*dt);
  let glow = 0.08; // (steady unless pursuing or smiting)
  switch (orb.state) {
    case 'charging': {
      const at = restPoint(orb);
      orb.x = at.x; orb.y = at.y; orb.z = at.z; orb.vx = orb.vy = orb.vz = 0;
      orb.charge = Math.min(1, orb.charge + dt/CHARGE_TIME);
      if (orb.charge >= 1) { orb.state = 'rising'; orb.goal = { x: at.x, y: groundY(orb) + CRUISE, z: at.z }; }
      break;
    }
    case 'rising':
      if (flyTo(orb, orb.goal.x, orb.goal.y, orb.goal.z, SPEED, dt, 1)) { orb.state = 'patrol'; orb.goal = patrolPoint(orb); }
      break;
    case 'patrol':
      if (orb.charge < LOW) { orb.state = 'home'; break; }
      if ((orb.scan -= dt) <= 0) {
        orb.scan = 0.3;
        const villain = orb.charge > SMITE_COST*0.5 ? spot(orb, t) : null;
        if (villain) { orb.target = villain; villain.seraphorb = orb; orb.state = 'chase'; break; }
      }
      if (orb.timer > 0) { orb.timer -= dt; flyTo(orb, orb.goal.x, orb.goal.y + Math.sin(t*1.3)*BOB, orb.goal.z, SPEED, dt); break; }
      if (flyTo(orb, orb.goal.x, orb.goal.y, orb.goal.z, SPEED, dt, 1)) { orb.goal = patrolPoint(orb); orb.timer = PAUSE[0] + Math.random()*(PAUSE[1] - PAUSE[0]); }
      break;
    case 'chase': {
      if (!canSmite(orb, p, t) || p.seraphorb !== orb) { letGo(orb); orb.state = 'patrol'; orb.goal = patrolPoint(orb); break; }
      const to = overHead(p), across = Math.hypot(to.x - orb.x, to.z - orb.z);
      // (high till near, then down onto them)
      const y = across > NEAR_HEAD ? Math.max(to.y, Math.min(orb.y, groundY(orb) + CRUISE)) : to.y;
      glow = 0.3 + 0.2*Math.sin(t*12);
      flyTo(orb, to.x, y, to.z, SPEED*RUSH, dt);
      if (across < SMITE_NEAR && orb.y - Math.max(to.y, floorToward(orb, to.x, to.z)) < SMITE_NEAR) { // (held up over a roof beside them: from there)
        orb.state = 'smite'; orb.timer = SMITE_HOLD; orb.moteSpin = 0; witness(p, 'orbhunt');
      }
      break;
    }
    case 'smite': {
      if (!canSmite(orb, p, t)) { letGo(orb); orb.state = 'patrol'; orb.goal = patrolPoint(orb); break; }
      const to = overHead(p);
      flyTo(orb, to.x, to.y, to.z, SPEED*RUSH, dt, 0);
      orb.timer -= dt;
      glow = 0.4 + 2*(1 - orb.timer/SMITE_HOLD) + 0.3*Math.sin(t*30);
      orb.moteSpin += dt*(1 + 4*Math.max(0, (1 - orb.timer/SMITE_HOLD - SUCK_FROM)/(1 - SUCK_FROM))); // (whirling faster as they're sucked in)
      if (orb.timer <= 0) {
        strikeLightning({ x: p.x, y: p.y, z: p.z }, { x: orb.x, y: orb.y - ORB_R*0.8, z: orb.z });
        spared.set(p, t);
        App.killPerson?.(people.indexOf(p), 'orb', null, 1, null, 'orbsmited');
        orb.charge = Math.max(0, orb.charge - SMITE_COST);
        letGo(orb);
        orb.glow = 4;
        orb.state = 'patrol'; orb.goal = { x: orb.x, y: groundY(orb) + CRUISE, z: orb.z }; orb.timer = 0;
      }
      break;
    }
    case 'home': { // over the ring, then down into it
      const at = restPoint(orb).clone(), across = Math.hypot(at.x - orb.x, at.z - orb.z);
      if (across > 0.5) flyTo(orb, at.x, Math.max(at.y + 4, groundY(orb) + CRUISE), at.z, SPEED, dt);
      else if (flyTo(orb, at.x, at.y, at.z, SPEED*0.4, dt, 0.05)) orb.state = 'charging';
      break;
    }
  }
  orb.glow = Math.max(glow, orb.glow - dt*8); // (a strike's flash fades off)
  orb.material.emissiveIntensity = orb.glow;
  if (orb.state !== 'charging') { orb.mesh.rotation.y += SPIN*dt; orb.mesh.rotation.x = Math.sin(t*0.4 + orb.number)*0.25; }
  const shut = orb.state === 'charging';
  if (shut !== orb.shut) { orb.shut = shut; orb.material.bumpMap = shut ? SHUT_BUMP : EYE_BUMP; orb.material.roughnessMap = shut ? SHUT_ROUGH : EYE_ROUGH; }
  const hunting = orb.state === 'chase' || orb.state === 'smite';
  orb.eyeGlow = Math.min(1, Math.max(0, orb.eyeGlow + (hunting ? 1 : -1)*EYE_GLOW_RISE*dt));
  orb.glowMaterial.opacity = orb.eyeGlow; orb.glowMesh.visible = orb.eyeGlow > 0;
  orb.mesh.position.set(orb.x, orb.y, orb.z);
}

let lastTime = null;
/**
 * Every Seraph ring's orb, each frame: one made for each ring put down, gone with it.
 * @param {number} t - seconds
 * @returns {void}
 */
export function updateSeraphorbs(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  const seen = new Set();
  for (const obj of S.objects) {
    if (obj.type !== 'seraphring' || !obj.group) continue;
    seen.add(obj.id);
    let orb = orbs.get(obj.id);
    if (!orb) orbs.set(obj.id, orb = makeOrb(obj));
    orb.obj = obj; // (an undo brings back the same ring as a new record)
  }
  for (const id of [...orbs.keys()]) if (!seen.has(id)) removeOrb(id);
  if (!dt) { updateSeraphorbSounds([]); return; }
  const heard = [];
  let moteCount = 0;
  orbs.forEach(orb => {
    updateOrb(orb, dt, t);
    if (orb.state === 'smite') moteCount = drawMotes(orb, moteCount, t);
    heard.push({ orb, x: orb.x, y: orb.y, z: orb.z, chasing: orb.state === 'chase', smiting: orb.state === 'smite', charging: orb.state === 'charging' });
  });
  motes.count = moteCount;
  motes.instanceMatrix.needsUpdate = true;
  updateSeraphorbSounds(heard);
  followSeraphorb();
}

// ---------------------------------------------------------- its card, and following it
// As the MedBot's (see medbot.js): a click on it in World mode puts the camera on it and its card up (see input.js).
const card = makeCard({ id: 'seraphorb-card', title: 'Seraphorb', onClose: () => App.stopFollowingSeraphorb() });
const drawThumbnail = makeThumbnailDrawer(card.canvas);
let followed = null, doingShown = null, chargeShown = null, thumbView = null;
const FOLLOW_MIN_RADIUS = 1.5, FOLLOW_RADIUS = 9, PICK_PIXELS = 26;

function thumbnailScene() {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ ...engraved(), color: 0xe6ebf0, metalness: 1, envMap: SKY_ENV_MAP }));
  const view = new THREE.OrthographicCamera(-ORB_R*1.3, ORB_R*1.3, ORB_R*1.3, -ORB_R*1.3, 0.1, 20);
  view.position.set(0, 1.5, 5);
  view.lookAt(0, 0, 0);
  return { mesh, camera: view };
}
const screen = new THREE.Vector3();
function pickSeraphorb(clientX, clientY, out) {
  const width = window.innerWidth, height = window.innerHeight;
  let best = null, bestDepth = Infinity;
  orbs.forEach(orb => {
    screen.set(orb.x, orb.y, orb.z).project(camera);
    if (Math.abs(screen.z) > 1) return;
    const off = Math.hypot((screen.x + 1)/2*width - clientX, (1 - screen.y)/2*height - clientY);
    if (off <= PICK_PIXELS && screen.z < bestDepth) { best = orb; bestDepth = screen.z; }
  });
  if (out && best) out.distance = camera.position.distanceTo(screen.set(best.x, best.y, best.z));
  return best;
}
function followSeraphorbNow(orb) {
  followed = orb;
  doingShown = chargeShown = null;
  controls.minRadius = FOLLOW_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, FOLLOW_RADIUS));
  card.show({ name: 'Seraphorb #' + orb.number, mood: '⚡' });
  drawThumbnail(thumbView ??= thumbnailScene());
  const id = orb.obj.id;
  card.setFavorite({ key: 'seraphorb:' + id, kind: 'Seraphorb', follow: () => { const o = orbs.get(id); if (o) followSeraphorbNow(o); return !!o; } });
}
function followSeraphorbAt(clientX, clientY) {
  const orb = pickSeraphorb(clientX, clientY);
  if (!orb) { stopFollowingSeraphorb(); return; }
  followSeraphorbNow(orb);
}
function stopFollowingSeraphorb() {
  if (!followed) return;
  followed = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  card.hide();
}
const DOING = { charging: 'Charging', rising: 'Rising', patrol: 'On patrol', chase: 'Chasing a villain', smite: 'Smiting', home: 'Going home to charge' };
const doingOf = orb => orb.state === 'patrol' && orb.timer > 0 ? 'Watching' : DOING[orb.state];
// its ring's card (see station-card.js), its button putting the camera on the orb
const station = makeStationCard({ id: 'seraphstation-card', title: 'Seraphorb Station', kind: 'SeraphStation', find: 'Find Seraphorb', bots: orbs, doing: doingOf,
  onFind: orb => { App.letGoOfAllBut('Seraphorb'); followSeraphorbNow(orb); }, onClose: () => App.stopFollowingSeraphStation() });
function followSeraphorb() {
  station.update();
  if (!followed) return;
  if (S.interactionMode !== 'move') { stopFollowingSeraphorb(); return; }
  const orb = followed;
  const doing = doingOf(orb);
  if (doing !== doingShown) { doingShown = doing; card.set('status', doing); }
  const charge = Math.round(orb.charge*100) + '%';
  if (charge !== chargeShown) { chargeShown = charge; card.set('charge', charge); }
  controls.goalTarget.set(orb.x, orb.y, orb.z);
}

Object.assign(App, { pickSeraphorb, followSeraphorbAt, stopFollowingSeraphorb, seraphorbs: orbs,
  pickSeraphStation: station.pick, followSeraphStationAt: station.followAt, stopFollowingSeraphStation: station.stop });
