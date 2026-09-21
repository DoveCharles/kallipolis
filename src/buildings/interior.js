import * as THREE from 'three';
import { camera, scene } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { footprintBounds } from './footprints.js';

// ============================================================ going inside a building
// Every building has the same inside: one room (furnished one of a few ways), built once and moved to whichever building's
// being looked into. It goes where the building actually stands, on its top floor, turned square to its longest wall, and
// the building itself isn't drawn while you're in there — so the windows look out on the real city around it, traffic,
// weather, time of day and all, with nothing to fake. The view is held in one top corner of the room, looking across at
// the two far walls and their windows (the two walls behind the camera are there too, for the sun's shadows, but never seen).
// The room's a fixed size whatever the building's shape: nobody inside can tell how far its walls are from the facade.
const ROOM_W = 8, ROOM_D = 6, ROOM_H = 3.2;  // along the room's own x and z, and floor to ceiling
// The sun's shadow is coarse (its bias lets light through anything within ~0.4 of what's casting it: see scene.js), so the
// walls and ceiling cast from their outer faces rather than three.js's usual inner ones (shadowSide, below), and they're
// far thicker than a real building's, with the slabs reaching out past the walls behind the camera — anything less lets
// daylight bleed in along the seams where they meet. Nobody inside sees their outsides, so the ceiling and the two walls behind the camera
// are thicker still; the far walls stay thin enough for the windows.
const WALL = 0.5, SLAB = 0.6, THICK = 1.6, OVERHANG = 1.5;
const FLOOR_HEIGHT = 3.5;                    // a storey, as the facades' windows are drawn (see windows.js)
const SILL = 0.9, HEAD = 2.5;                // a window's bottom and top, above the floor
const CAMERA_INSET = 0.7, CAMERA_DROP = 0.7;  // the camera, in from the corner walls and down from the ceiling

const room = new THREE.Group();
room.name = 'Interior';
room.visible = false;
scene.add(room);

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.95 });
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x9a7452, roughness: 0.8 });
const ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 1 });
const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.6 });
wallMaterial.shadowSide = ceilingMaterial.shadowSide = THREE.FrontSide;
const glassMaterial = new THREE.MeshStandardMaterial({ color: 0xbcd6e6, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.12, depthWrite: false });

// Under its own ceiling the room's all in the sun's shadow, and the scene's ambient light alone leaves it murky. Rather
// than a lamp (one more light in every material in the scene, whether anyone's indoors or not), the room's own materials
// glow a little in their own colour — the same by day or night, which after dark reads as the lights being on.
const ROOM_GLOW = 0.3;
function roomLit(material) {
  material.emissive.copy(material.color);
  material.emissiveIntensity = ROOM_GLOW;
  return material;
}
function box(w, h, d, material, x, y, z, parent = room) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = material !== glassMaterial;
  parent.add(mesh);
  return mesh;
}
// A wall `length` long along x, centred on the origin, with `windows` evenly spaced along it — built out of the pieces
// between the holes (under the sills, over the heads, and the piers either side) — then turned by `angle` about y and
// moved to (x, z).
function wall(length, windows, x, z, angle, thickness = WALL) {
  const piece = (w, h, d, material, px, py, pz) => {
    const mesh = box(w, h, d, material, 0, py, 0);
    const c = Math.cos(angle), s = Math.sin(angle);
    mesh.position.x = x + px*c + pz*s;
    mesh.position.z = z - px*s + pz*c;
    mesh.rotation.y = angle;
  };
  if (!windows) { piece(length, ROOM_H, thickness, wallMaterial, 0, ROOM_H/2, 0); return; }
  const pier = length/(windows*2 + 1)*0.9, gap = (length - pier*(windows + 1))/windows;
  piece(length, SILL, WALL, wallMaterial, 0, SILL/2, 0);
  piece(length, ROOM_H - HEAD, WALL, wallMaterial, 0, (HEAD + ROOM_H)/2, 0);
  for (let i = 0; i <= windows; i++) {
    const px = -length/2 + pier/2 + i*(pier + gap);
    piece(pier, HEAD - SILL, WALL, wallMaterial, px, (SILL + HEAD)/2, 0);
    if (i === windows) break;
    const mid = px + pier/2 + gap/2;
    piece(gap, HEAD - SILL, 0.02, glassMaterial, mid, (SILL + HEAD)/2, 0);
    piece(0.06, HEAD - SILL, WALL + 0.04, frameMaterial, mid, (SILL + HEAD)/2, 0);    // a mullion down the middle
    piece(gap, 0.06, WALL + 0.1, frameMaterial, mid, SILL, 0);                        // and a sill to lean on
  }
}
[wallMaterial, floorMaterial, ceilingMaterial, frameMaterial].forEach(roomLit);
box(ROOM_W + (WALL + OVERHANG)*2, SLAB, ROOM_D + (WALL + OVERHANG)*2, floorMaterial, 0, -SLAB/2, 0);
// (the ceiling stops flush with the far walls — any further and it'd shade their windows — but reaches on past the thick
// ones behind the camera)
const ceilW = ROOM_W/2 + WALL + ROOM_W/2 + THICK + OVERHANG, ceilD = ROOM_D/2 + WALL + ROOM_D/2 + THICK + OVERHANG;
box(ceilW, THICK, ceilD, ceilingMaterial, ROOM_W/2 + WALL - ceilW/2, ROOM_H + THICK/2, ROOM_D/2 + WALL - ceilD/2);
// the camera sits in the (-x, -z) corner, so the windows are in the +x and +z walls, facing it
wall(ROOM_W + WALL*2, 3, 0, ROOM_D/2 + WALL/2, 0);            // far, along x
wall(ROOM_D, 2, ROOM_W/2 + WALL/2, 0, Math.PI/2);             // far, along z
wall(ROOM_W + THICK*2, 0, 0, -ROOM_D/2 - THICK/2, 0, THICK);  // behind the camera
wall(ROOM_D, 0, -ROOM_W/2 - THICK/2, 0, Math.PI/2, THICK);   // behind the camera
// ---------------------------------------------------------- what's in it
// The shell's the same everywhere; what's in it is one of a few layouts, each a group of furniture shown or hidden as a
// whole, a floor colour, and the rectangles (in the room's own x and z, with room to pass round them) nobody stands in or
// walks through — see "who's in the room" below.
const LAYOUTS = {};
const lit = (color, roughness = 0.8) => roomLit(new THREE.MeshStandardMaterial({ color, roughness }));
function layout(name, floor, build) {
  const group = new THREE.Group();
  group.visible = false;
  room.add(group);
  const add = (w, h, d, material, x, y, z) => box(w, h, d, material, x, y, z, group);
  LAYOUTS[name] = { group, floor: new THREE.Color(floor), blocked: build(add) };
}
const around = (x0, x1, z0, z1, pad = 0.45) => ({ x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad });

// a home: a table, a rug and a low cabinet under the far windows
layout('home', 0x9a7452, add => {
  const wood = lit(0x6b4a33, 0.7);
  add(1.8, 0.06, 0.9, wood, 0.6, 0.74, 0.4);
  [[-0.2, 0.05], [1.4, 0.05], [-0.2, 0.75], [1.4, 0.75]].forEach(([x, z]) => add(0.07, 0.71, 0.07, wood, x, 0.355, z));
  add(3.2, 0.01, 2.2, lit(0x8c3b3b, 1), 0.6, 0.005, 0.4);
  add(2.4, 0.8, 0.5, wood, 0.4, 0.4, ROOM_D/2 - 0.3);
  return [around(-0.3, 1.5, -0.05, 0.85), around(-0.8, 1.6, ROOM_D/2 - 0.55, ROOM_D/2, 0.35)];
});

// an office floor: a bank of desks back to back with a screen between, each with its monitor and chair, strip lights in
// the ceiling, a water cooler, a printer and a pot plant
const DESKS = 3, DESK_W = 1.2, DESK_D = 0.75, DESK_H = 0.74;
const BANK_X = 0.6, BANK_Z = 0.9;                              // the bank's middle
layout('office', 0x6f7478, add => {
  const top = lit(0xd8d4cc, 0.6), metal = lit(0x55595e, 0.5), screen = lit(0x9aa7a0, 0.9);
  const black = lit(0x222428, 0.4), seat = lit(0x2f3f5a, 0.9);
  const x0 = BANK_X - DESKS*DESK_W/2;
  for (let i = 0; i < DESKS; i++) {
    const x = x0 + DESK_W*(i + 0.5);
    for (const side of [-1, 1]) {
      const z = BANK_Z + side*DESK_D/2;
      add(DESK_W - 0.04, 0.04, DESK_D - 0.02, top, x, DESK_H, z);
      add(0.04, DESK_H - 0.02, DESK_D - 0.1, metal, x - DESK_W/2 + 0.06, (DESK_H - 0.02)/2, z);
      // the monitor, back by the screen and facing whoever sits there
      add(0.55, 0.34, 0.03, black, x, DESK_H + 0.3, BANK_Z + side*0.18);
      add(0.06, 0.13, 0.06, black, x, DESK_H + 0.07, BANK_Z + side*0.15);
      add(0.4, 0.02, 0.14, black, x, DESK_H + 0.03, BANK_Z + side*0.45);            // keyboard
      // the chair, pulled out a little
      const cz = BANK_Z + side*(DESK_D + 0.3);
      add(0.48, 0.08, 0.46, seat, x + 0.05, 0.47, cz);
      add(0.46, 0.5, 0.07, seat, x + 0.05, 0.78, cz + side*0.23);
      add(0.05, 0.4, 0.05, metal, x + 0.05, 0.24, cz);
      add(0.5, 0.04, 0.5, metal, x + 0.05, 0.04, cz);
    }
  }
  add(DESKS*DESK_W - 0.04, 0.4, 0.04, screen, BANK_X, DESK_H + 0.2, BANK_Z);
  add(0.04, DESK_H - 0.02, DESK_D*2 - 0.1, metal, x0 + DESKS*DESK_W - 0.06, (DESK_H - 0.02)/2, BANK_Z);
  // strip lights, bright in any light
  const light = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfffbf0, emissiveIntensity: 0.9 });
  for (const lx of [-2, 0.6, 3.2]) for (const lz of [-1.2, 1.6]) add(1.2, 0.03, 0.3, light, lx, ROOM_H - 0.015, lz);
  // water cooler by the far corner, a printer against the back wall, and a plant in the other corner
  add(0.32, 0.9, 0.32, lit(0xe6e6e2), ROOM_W/2 - 0.4, 0.45, -ROOM_D/2 + 0.9);
  add(0.28, 0.4, 0.28, lit(0x7fb2d8, 0.2), ROOM_W/2 - 0.4, 1.1, -ROOM_D/2 + 0.9);
  add(0.7, 0.55, 0.55, metal, -ROOM_W/2 + 0.45, 0.275, ROOM_D/2 - 0.5);
  add(0.62, 0.35, 0.5, lit(0xcfcfc8), -ROOM_W/2 + 0.45, 0.72, ROOM_D/2 - 0.5);
  add(0.4, 0.4, 0.4, lit(0x7a5a42), ROOM_W/2 - 0.45, 0.2, ROOM_D/2 - 0.45);
  add(0.7, 0.9, 0.7, lit(0x3f6b3a, 1), ROOM_W/2 - 0.45, 0.85, ROOM_D/2 - 0.45);
  const chairsOut = DESK_D + 0.3 + 0.3;
  return [
    around(x0, x0 + DESKS*DESK_W, BANK_Z - chairsOut, BANK_Z + chairsOut, 0.35),
    around(ROOM_W/2 - 0.6, ROOM_W/2, -ROOM_D/2 + 0.7, -ROOM_D/2 + 1.1, 0.35),
    around(-ROOM_W/2, -ROOM_W/2 + 0.8, ROOM_D/2 - 0.8, ROOM_D/2, 0.35),
    around(ROOM_W/2 - 0.8, ROOM_W/2, ROOM_D/2 - 0.8, ROOM_D/2, 0.35),
  ];
});
let current = LAYOUTS.home;
function useLayout(name) {
  current.group.visible = false;
  current = LAYOUTS[name] ?? LAYOUTS.home;
  current.group.visible = true;
  floorMaterial.color.copy(current.floor);
  floorMaterial.emissive.copy(current.floor);
}

// where the camera sits in the room, and what it looks at, in the room's own terms
const CAMERA_AT = new THREE.Vector3(-ROOM_W/2 + CAMERA_INSET, ROOM_H - CAMERA_DROP, -ROOM_D/2 + CAMERA_INSET);
// what the view widens to take in: the far corners, floor and ceiling, of the three walls the camera looks across
const FIT = [[ROOM_W/2, -ROOM_D/2], [ROOM_W/2, ROOM_D/2], [-ROOM_W/2, ROOM_D/2]]
  .flatMap(([x, z]) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, ROOM_H, z)]);
const FIT_MARGIN = 1.04, MAX_FOV = 110, FOV_EASE = 0.12;
const ROOM_NEAR = 0.1; // the ceiling's closer than the usual near plane, and the wide view takes it in
// Where the camera looks: the middle of FIT's spread, side to side and up and down, so the view widens no more than
// the room needs.
const LOOK_AT = (() => {
  const yaws = [], pitches = [];
  for (const corner of FIT) {
    const d = corner.clone().sub(CAMERA_AT);
    yaws.push(Math.atan2(d.x, d.z));
    pitches.push(Math.atan2(d.y, Math.hypot(d.x, d.z)));
  }
  const yaw = (Math.min(...yaws) + Math.max(...yaws))/2, pitch = (Math.min(...pitches) + Math.max(...pitches))/2;
  const reach = 5;
  return CAMERA_AT.clone().add(new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), Math.cos(yaw)*Math.cos(pitch)).multiplyScalar(reach));
})();
const BASE_FOV = camera.fov;

// inside: { group, key, before } — the building being looked into, its key (buildingKey), and the camera's goals as they
// were, to go back to
let inside = null;
// counts every time the room's set up somewhere, so anyone placed in it can tell when it's a new visit (see roomVisit)
let visits = 0;

// The room's angle: square to the footprint's longest edge, so its walls run the way the building's do.
function longestEdgeAngle(fp) {
  let best = 0, angle = 0;
  fp.forEach((p, i) => {
    const q = fp[(i + 1) % fp.length], length = Math.hypot(q.x - p.x, q.z - p.z);
    if (length > best) { best = length; angle = Math.atan2(-(q.z - p.z), q.x - p.x); }
  });
  return angle;
}

// Goes into `group` (a building, as building-card.js follows it, with its key): the room onto its top floor, laid out as
// `kind` of room (one of LAYOUTS: 'home' or 'office'), the building hidden, and the camera cut straight to the corner and
// held there.
export function enterBuilding(group, key, kind = 'home') {
  if (inside) leaveBuilding();
  useLayout(kind);
  const fp = group.userData.footprint;
  const bounds = new THREE.Box3().setFromObject(group);
  const base = bounds.min.y, height = group.userData.height ?? (bounds.max.y - base);
  const centre = fp && fp.length >= 3 ? footprintBounds(group).c : bounds.getCenter(new THREE.Vector3());
  const storey = Math.max(0, Math.floor((height - ROOM_H - 0.3)/FLOOR_HEIGHT));
  room.position.set(centre.x, base + storey*FLOOR_HEIGHT, centre.z);
  room.rotation.y = fp && fp.length >= 3 ? longestEdgeAngle(fp) : 0;
  room.visible = true;
  room.updateMatrixWorld(true);
  group.visible = false;

  visits++;
  inside = { group, key, before: {
    target: controls.goalTarget.clone(), radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi,
    minRadius: controls.minRadius, near: camera.near,
  } };
  camera.near = ROOM_NEAR;
  camera.updateProjectionMatrix();
  const eye = room.localToWorld(CAMERA_AT.clone()), look = room.localToWorld(LOOK_AT.clone());
  const offset = eye.clone().sub(look), radius = offset.length();
  controls.goalTarget.copy(look);
  controls.minRadius = 0;
  controls.goalRadius = radius;
  controls.goalPhi = Math.acos(offset.y/radius);
  // the nearer way round to the corner, so easing back out on leaving doesn't swing all the way about
  const theta = Math.atan2(offset.x, offset.z);
  controls.goalTheta = controls.theta + Math.atan2(Math.sin(theta - controls.theta), Math.cos(theta - controls.theta));
  controls.locked = true;
  // a hard cut in, no glide
  controls.update(true);
  camera.fov = fittedFov();
  camera.updateProjectionMatrix();
}

// Back out: the building drawn again, the room put away, and the camera eased back to where it was looking from.
export function leaveBuilding() {
  if (!inside) return;
  const { group, before } = inside;
  inside = null;
  group.visible = true;
  room.visible = false;
  controls.locked = false;
  controls.goalTarget.copy(before.target);
  controls.goalRadius = before.radius;
  controls.goalTheta = before.theta;
  controls.goalPhi = before.phi;
  controls.minRadius = before.minRadius;
  camera.near = before.near;
  camera.updateProjectionMatrix();
}

// The vertical field of view that takes in all of FIT from the corner at the window's current shape: the room's width
// fits a narrow window as well as a wide one.
function fittedFov() {
  const forward = LOOK_AT.clone().sub(CAMERA_AT).normalize();
  const right = forward.clone().cross(new THREE.Vector3(0, 1, 0)).normalize(), up = right.clone().cross(forward);
  let tanUp = 0, tanSide = 0;
  for (const corner of FIT) {
    const d = corner.clone().sub(CAMERA_AT), depth = d.dot(forward);
    tanUp = Math.max(tanUp, Math.abs(d.dot(up))/depth);
    tanSide = Math.max(tanSide, Math.abs(d.dot(right))/depth);
  }
  const tan = Math.max(tanUp, tanSide/camera.aspect)*FIT_MARGIN;
  return Math.min(MAX_FOV, THREE.MathUtils.radToDeg(2*Math.atan(tan)));
}

// Each frame: the view eased wider inside a room, and back to its usual angle outside.
export function updateInteriorCamera() {
  const goal = inside ? fittedFov() : BASE_FOV;
  if (camera.fov === goal) return;
  camera.fov = Math.abs(goal - camera.fov) < 0.05 ? goal : camera.fov + (goal - camera.fov)*FOV_EASE;
  camera.updateProjectionMatrix();
}

export const isInsideBuilding = () => !!inside;
export const buildingInside = () => inside?.group ?? null;

// ---------------------------------------------------------- who's in the room
// Whoever's inside the building (see "going indoors" in people.js) is only drawn while the room's there to be drawn in,
// standing about it and now and then wandering over to somewhere else in it — never through the furniture (the layout's
// `blocked`), or into the corner the camera's in (where they'd stand with their head in its face).
const ROOM_MARGIN = 0.5;                                                                   // from the walls
const CAMERA_CLEAR = 1.8;                                                                  // kept clear, from the corner
const clearOfFurniture = (x, z) => current.blocked.every(b => x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1);
const clearOfCamera = (x, z) => x > -ROOM_W/2 + CAMERA_CLEAR || z > -ROOM_D/2 + CAMERA_CLEAR;

/** Whether the room's set up in the building with this key (buildingKey) right now. */
export const roomHolds = key => !!inside && inside.key === key;
/** Which time the room's been set up this is: someone placed in it on an earlier visit needs placing again. */
export const roomVisit = () => visits;
// A spot to stand in the room, in the world, from `rng` — one the straight walk from `from` (if given) to it stays clear of
// the furniture on. The camera's corner is just as clear, but there's no avoiding walking past it from where they are.
export function roomSpot(rng, from = null) {
  const local = from && room.worldToLocal(new THREE.Vector3(from.x, from.y, from.z));
  let x = 0, z = 0;
  for (let tries = 0; tries < 40; tries++) {
    x = -ROOM_W/2 + ROOM_MARGIN + rng()*(ROOM_W - ROOM_MARGIN*2);
    z = -ROOM_D/2 + ROOM_MARGIN + rng()*(ROOM_D - ROOM_MARGIN*2);
    if (!clearOfFurniture(x, z) || !clearOfCamera(x, z)) continue;
    let clear = true;
    for (let k = 1; local && clear && k < 12; k++) clear = clearOfFurniture(local.x + (x - local.x)*k/12, local.z + (z - local.z)*k/12);
    if (clear) break;
  }
  return room.localToWorld(new THREE.Vector3(x, 0, z));
}
