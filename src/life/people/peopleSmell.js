import * as THREE from 'three';
import { S } from '../../core/shared.js';
import { camera, scene } from '../../core/scene.js';
import { isDrawn, isGone, notice, people, peopleNav, randomSpotIn } from './people.js';

// The smells trait, on people: everyone else keeps clear. Walking along a walkway towards someone who smells, within
// SMELL_REACH, they turn round; wandering a plaza or park, heading for somewhere near them, they pick somewhere else, as
// far from them as they can find. (Circles on the grass empty when someone who smells sits in one, and nobody joins
// theirs: see updateGroups and goSit in peopleActivities.js; nor does anyone stop to chat with them: goChat, meetOnWalkways.)
const SMELL_REACH = 5, SMELL_CHECK = 0.5; // (at people size 1; seconds between each person's looks round)
const busy = p => p.act || p.fright || p.attack || p.punched || p.crossStage || p.jc || p.water;

/**
 * Keep everyone clear of anyone who smells, each frame.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function avoidSmells(dt) {
  const smelly = people.filter(q => q.traits.smells && !isGone(q) && q.mode !== 'indoors');
  if (!smelly.length) return;
  const reach = SMELL_REACH*S.peopleSize;
  people.forEach(p => {
    if (p.traits.smells || (p.mode !== 'line' && p.mode !== 'wander') || busy(p)) return;
    if ((p.smellCheck = (p.smellCheck ?? Math.random()*SMELL_CHECK) - dt) > 0) return;
    p.smellCheck = SMELL_CHECK;
    const q = smelly.find(q => Math.hypot(q.x - p.x, q.z - p.z) < reach && Math.abs(q.y - p.y) < reach);
    if (!q) return;
    notice(p, q, 'smelly'); // (for what they say: see life/speech-text.js)
    if (p.mode === 'line') {
      const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1];
      if (((b.x - a.x)*(q.x - p.x) + (b.z - a.z)*(q.z - p.z))*p.dir > 0) p.dir = -p.dir; // (they're ahead: back the way they came)
    } else if (Math.hypot(p.tx - q.x, p.tz - q.z) < reach*1.5 || (p.tx - p.x)*(q.x - p.x) + (p.tz - p.z)*(q.z - p.z) > 0) {
      const area = peopleNav.areas[p.area];
      let best = null;
      for (let k = 0; k < 6; k++) {
        const spot = randomSpotIn(area, null, p), d = Math.hypot(spot.x - q.x, spot.z - q.z);
        if (!best || d > best.d) best = { ...spot, d };
      }
      p.tx = best.x; p.tz = best.z; p.wait = 0;
    }
  });
}

// Flies: FLIES_EACH little black dots round everyone who smells, near enough the camera (S.particleRange) and while
// particles are on (S.maxParticles > 0). Each hovers with a buzz of jitter, then every FLY_HOP seconds zips to a new spot
// round them (eased in at FLY_ZIP a second), placed relative to them so the swarm follows. Their own instanced mesh,
// FLIES_MAX in all, outside the particle pool — so the particle limit never takes them.
const FLIES_EACH = 6, FLIES_MAX = 240, FLY_SIZE = 0.035, FLY_HOP = [0.2, 1], FLY_ZIP = 14, FLY_BUZZ = 0.012;
const FLY_REACH = 0.45, FLY_LOW = 0.35, FLY_HIGH = 1.15; // (how far out they go, and how low and high, as shares of the person's height)
const flyMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x111111 }), FLIES_MAX);
flyMesh.name = 'Flies';
flyMesh.frustumCulled = false;
flyMesh.count = 0;
scene.add(flyMesh);
const swarms = new WeakMap(), matrix = new THREE.Matrix4(), place = new THREE.Vector3(), turn = new THREE.Quaternion(), size = new THREE.Vector3();

/** A new spot for a fly round someone `height` tall, relative to their feet. */
function flySpot(height) {
  const a = Math.random()*Math.PI*2, r = FLY_REACH*height*Math.sqrt(Math.random());
  return { x: Math.sin(a)*r, y: height*(FLY_LOW + Math.random()*(FLY_HIGH - FLY_LOW)), z: Math.cos(a)*r };
}

/**
 * Move and draw the flies round everyone who smells, each frame.
 * @param {number} dt - seconds since the last frame
 * @returns {void}
 */
export function updateFlies(dt) {
  let n = 0;
  flyMesh.visible = S.peopleEnabled && S.maxParticles > 0;
  if (flyMesh.visible) for (const p of people) {
    if (!p.traits.smells || !isDrawn(p) || n + FLIES_EACH > FLIES_MAX) continue;
    if ((p.x - camera.position.x)**2 + (p.y - camera.position.y)**2 + (p.z - camera.position.z)**2 > S.particleRange**2) continue;
    const height = 1.7*p.height*S.peopleSize;
    let swarm = swarms.get(p);
    if (!swarm) swarms.set(p, swarm = Array.from({ length: FLIES_EACH }, () => ({ ...flySpot(height), to: flySpot(height), hop: Math.random()*FLY_HOP[1] })));
    const ease = 1 - Math.exp(-FLY_ZIP*dt), buzz = FLY_BUZZ*height;
    for (const fly of swarm) {
      if ((fly.hop -= dt) <= 0) { fly.to = flySpot(height); fly.hop = FLY_HOP[0] + Math.random()*(FLY_HOP[1] - FLY_HOP[0]); }
      fly.x += (fly.to.x - fly.x)*ease + (Math.random() - 0.5)*buzz;
      fly.y += (fly.to.y - fly.y)*ease + (Math.random() - 0.5)*buzz;
      fly.z += (fly.to.z - fly.z)*ease + (Math.random() - 0.5)*buzz;
      matrix.compose(place.set(p.x + fly.x, p.y + fly.y, p.z + fly.z), turn, size.setScalar(FLY_SIZE*S.peopleSize));
      flyMesh.setMatrixAt(n++, matrix);
    }
  }
  flyMesh.count = n;
  flyMesh.instanceMatrix.needsUpdate = true;
}
