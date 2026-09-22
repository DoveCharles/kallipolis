import * as THREE from 'three';
import { camera, scene, renderer } from '../core/scene.js';
import { S } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { footprintBounds } from './footprints.js';
import { hashNameToNumber, mulberry32 } from '../core/math.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { setCutout } from '../ui/pixelation.js';
import { isMuted, setIndoors } from '../audio/sfx.js';
import { officeAmbience, resetOfficeAmbience } from '../audio/office.js';

// ============================================================ going inside a building
// Every building has the same inside: one room (furnished one of a few ways), built once and moved to whichever building's
// being looked into. It goes where the building actually stands, on its top floor, turned square to its longest wall, and
// the building itself isn't drawn while you're in there — so the windows look out on the real city around it, traffic,
// weather, time of day and all, with nothing to fake. The view is held in one corner of the room, at about eye height,
// looking across at the two far walls and their windows (the two walls behind the camera are there too, for the sun's
// shadows, but never seen).
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
const CAMERA_INSET = 0.7;                    // the camera, in from the corner walls
// and its view: height above the floor, degrees looking down, and vertical field of view (tuned with tools/interior.html)
const CAMERA_HEIGHT = 1.62, CAMERA_PITCH = 2.6, CAMERA_FOV = 85.3;

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
function wall(length, windows, x, z, angle, thickness = WALL, parent = room) {
  const piece = (w, h, d, material, px, py, pz) => {
    const mesh = box(w, h, d, material, 0, py, 0, parent);
    const c = Math.cos(angle), s = Math.sin(angle);
    mesh.position.x = x + px*c + pz*s;
    mesh.position.z = z - px*s + pz*c;
    mesh.rotation.y = angle;
  };
  if (!windows) { piece(length, ROOM_H, thickness, wallMaterial, 0, ROOM_H/2, 0); return; }
  const { width: pier, gap, centres } = piers(length, windows);
  piece(length, SILL, WALL, wallMaterial, 0, SILL/2, 0);
  piece(length, ROOM_H - HEAD, WALL, wallMaterial, 0, (HEAD + ROOM_H)/2, 0);
  for (let i = 0; i <= windows; i++) {
    const px = centres[i];
    piece(pier, HEAD - SILL, WALL, wallMaterial, px, (SILL + HEAD)/2, 0);
    if (i === windows) break;
    const mid = px + pier/2 + gap/2;
    piece(gap, HEAD - SILL, 0.02, glassMaterial, mid, (SILL + HEAD)/2, 0);
    piece(0.06, HEAD - SILL, WALL + 0.04, frameMaterial, mid, (SILL + HEAD)/2, 0);    // a mullion down the middle
    piece(gap, 0.06, WALL + 0.1, frameMaterial, mid, SILL, 0);                        // and a sill to lean on
  }
}
// the solid bits of such a wall between and either side of its windows: how wide, and where along it
function piers(length, windows) {
  const width = length/(windows*2 + 1)*0.9, gap = (length - width*(windows + 1))/windows;
  return { width, gap, centres: Array.from({ length: windows + 1 }, (_, i) => -length/2 + width/2 + i*(width + gap)) };
}
[wallMaterial, floorMaterial, ceilingMaterial, frameMaterial].forEach(roomLit);
box(ROOM_W + (WALL + OVERHANG)*2, SLAB, ROOM_D + (WALL + OVERHANG)*2, floorMaterial, 0, -SLAB/2, 0);
// (the ceiling stops flush with the far walls — any further and it'd shade their windows — but reaches on past the thick
// ones behind the camera)
const ceilW = ROOM_W/2 + WALL + ROOM_W/2 + THICK + OVERHANG, ceilD = ROOM_D/2 + WALL + ROOM_D/2 + THICK + OVERHANG;
box(ceilW, THICK, ceilD, ceilingMaterial, ROOM_W/2 + WALL - ceilW/2, ROOM_H + THICK/2, ROOM_D/2 + WALL - ceilD/2);
// the camera sits in the (-x, -z) corner, so the windows are in the +x and +z walls, facing it
const FAR_X = [ROOM_W + WALL*2, 3], FAR_Z = [ROOM_D, 2];         // the far walls' lengths and windows
// The far walls come two ways, one shown at a time (see enterBuilding): punched through with windows (every home, and
// now and then an office) or, in most offices, glass floor to ceiling.
const punched = new THREE.Group(), curtain = new THREE.Group();
room.add(punched, curtain);
wall(...FAR_X, 0, ROOM_D/2 + WALL/2, 0, WALL, punched);       // far, along x
wall(...FAR_Z, ROOM_W/2 + WALL/2, 0, Math.PI/2, WALL, punched); // far, along z
// A curtain wall `length` long along x, centred on the origin: one sheet of glass floor to ceiling with a rail along the
// floor and the ceiling, split into panes of about PANE wide by mullions between `from` and `to` (along it) — the
// faces of the columns at either end (see COLUMNS), each with a mullion up against it — then turned by `angle` about y
// and moved to (x, z).
const PANE = 2.8, MULLION = 0.07, MULLION_DEPTH = 0.18, RAIL = 0.07;
function curtainWall(length, x, z, angle, from, to) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const piece = (w, h, d, material, px, py) => {
    const mesh = box(w, h, d, material, x + px*c, py, z - px*s, curtain);
    mesh.rotation.y = angle;
  };
  piece(length, ROOM_H, 0.02, glassMaterial, 0, ROOM_H/2);
  piece(length, RAIL, MULLION_DEPTH, frameMaterial, 0, RAIL/2);
  piece(length, RAIL, MULLION_DEPTH, frameMaterial, 0, ROOM_H - RAIL/2);
  const a = from + MULLION/2, b = to - MULLION/2, panes = Math.max(1, Math.round((b - a)/PANE));
  for (let i = 0; i <= panes; i++) piece(MULLION, ROOM_H, MULLION_DEPTH, frameMaterial, a + (b - a)*i/panes, ROOM_H/2);
}
// A square concrete column, floor to ceiling, in each of the room's corners the glass runs into: the far one, and either
// end where it meets the walls behind the camera. The glass runs along their outer faces.
const COLUMN = 0.5;
const concreteMaterial = roomLit(new THREE.MeshStandardMaterial({ color: 0xa8a59e, roughness: 0.95 }));
const COLUMNS = [[ROOM_W/2, ROOM_D/2], [-ROOM_W/2 + COLUMN/2, ROOM_D/2], [ROOM_W/2, -ROOM_D/2 + COLUMN/2]];
for (const [cx, cz] of COLUMNS) box(COLUMN, ROOM_H, COLUMN, concreteMaterial, cx, ROOM_H/2, cz, curtain);
// (along the same lines as the punched walls, from inside the walls behind the camera to the far corner; the one along
// z runs the other way along itself, turned as it is)
curtainWall(ROOM_W + WALL, 0, ROOM_D/2 + WALL/2, 0, -ROOM_W/2 + COLUMN, ROOM_W/2 - COLUMN/2);
curtainWall(ROOM_D + WALL, ROOM_W/2 + WALL/2, 0, Math.PI/2, -ROOM_D/2 + COLUMN/2, ROOM_D/2 - COLUMN);
curtain.visible = false;
/** The chance an office has windows punched through its walls, as a home does, rather than glass floor to ceiling. */
const OFFICE_PUNCHED = 0.1;
// a number from 0 up to 1 for a building's key, the same every time (and unlike its number, which picks home or office)
function keyFraction(key) {
  let h = 2166136261;
  for (const ch of String(key) + ':walls') h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0)/2**32;
}
wall(ROOM_W + THICK*2, 0, 0, -ROOM_D/2 - THICK/2, 0, THICK);  // behind the camera
wall(ROOM_D, 0, -ROOM_W/2 - THICK/2, 0, Math.PI/2, THICK);   // behind the camera
// ---------------------------------------------------------- what's in it
// The shell's the same everywhere; what's in it is one of a few layouts, each a group of furniture shown or hidden as a
// whole, a floor and wall colour, and the rectangles (in the room's own x and z, with room to pass round them) nobody stands in or
// walks through — see "who's in the room" below.
const LAYOUTS = {};
const lit = (color, roughness = 0.8) => roomLit(new THREE.MeshStandardMaterial({ color, roughness }));
function layout(name, floor, build) {
  const group = new THREE.Group();
  group.visible = false;
  room.add(group);
  const add = (w, h, d, material, x, y, z) => box(w, h, d, material, x, y, z, group);
  const blocked = build(add);
  // (solid: what nobody walks through, as against blocked, where nobody stops; seats: where anyone can sit — see roomSeats)
  LAYOUTS[name] = { group, floor: new THREE.Color(floor), wall: new THREE.Color(0xe8e2d6), blocked, solid: blocked, seats: [] };
}
const around = (x0, x1, z0, z1, pad = 0.45) => ({ x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad });

// a home: furnished afresh for each building from the interior model (see "a home's furniture", below)
layout('home', 0x9a7452, () => []);

// an office: strip lights in the ceiling, bright in any light, and furnished afresh for each building from the office
// model (see "an office's furniture", below)
layout('office', 0x6f7478, add => {
  const light = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfffbf0, emissiveIntensity: 0.9 });
  for (const lx of [-2, 0.6, 3.2]) for (const lz of [-1.2, 1.6]) add(1.2, 0.03, 0.3, light, lx, ROOM_H - 0.015, lz);
  return [];
});
const officeGroup = new THREE.Group();
LAYOUTS.office.group.add(officeGroup);
let current = LAYOUTS.home;
// where there's room to walk in it, as laid out (see walkGrid)
let grid = null;
function useLayout(name) {
  current.group.visible = false;
  grid = null;
  current = LAYOUTS[name] ?? LAYOUTS.home;
  current.group.visible = true;
  paintRoom();
}
function paintRoom() {
  floorMaterial.color.copy(current.floor);
  wallMaterial.color.copy(current.wall);
  roomLit(floorMaterial); roomLit(wallMaterial);
}

// ---------------------------------------------------------- a home's furniture
// The furniture's a custom model (assets/models/Interior.glb, made in Blender): one top-level mesh per piece — Chair,
// Table, TV, Lamp, Plant, Sofa, Coffee Table (loaded as Coffee_Table), Rug, Bookcase, Pendant, Drawers — at five times
// life size, the TV's screen facing -z and everything else facing +z. Each home arranges it its own way (from its
// building's key, so it's the same every visit): the TV against one of the two far walls, facing the camera, the sofa
// across the room facing it with the coffee table on a rug between them, maybe a lamp at the sofa's end, a bookcase
// against a far wall between its windows, a chest of drawers along one (low enough to go under a window), a dining table
// with two or four chairs wherever there's room for it, a light hanging over the dining table or the coffee table, and
// a plant or two by the walls. Until the model's loaded, homes are bare.
const FURNITURE_MODEL_URL = 'assets/models/Interior.glb';
const FURNITURE_SCALE = 0.2;
// { [name]: { object, w, d, h, bounds, seats } } — each piece turned to face +z, centred on its footprint and standing on
// y = 0, w across and d deep (bounds: { x0, x1, z0, z1 }, its footprint in its own terms), with where on it anyone can
// sit (seats: { x, z, y }, in its own terms)
let furniture = null;
const FLOORS = [0x9a7452, 0x7d5b3f, 0xb08a62, 0x8a6a55, 0x6e6861, 0xa3927c, 0xc4ae8c, 0x5c4636, 0x8c8478];
// and each home's own paint, woodwork (the TV stand, tables and chairs), sofa and rug
const WALLS = [0xe8e2d6, 0xcfd8c4, 0xc9dcdc, 0xe8d2cc, 0xeee2b8, 0xd0d6e0, 0xe0c4a8, 0xd8cfe0, 0xf2efe8];
const WOODS = [0xe7be73, 0xe8d2a8, 0x8a5a3a, 0xb0603e, 0x5a3c2a, 0xb8ae9e, 0xeae6de, 0x3a3430];
const SOFAS = [0x89666e, 0x3c4a6e, 0xc8962e, 0x3e6a4e, 0x8a8c8e, 0x2f7474, 0xa4553a, 0xd8ccb4, 0xd88a96];
const RUGS = [0xe78676, 0xe6dcc6, 0x5a7ab0, 0x9ab08a, 0x55555a, 0xd0a048, 0x7a4868, 0x4a9a9a];
const SHADES = [0x3a3a3a, 0xece8e0, 0xc9a352, 0x8fa88a, 0xc0603e, 0x34466a, 0xd8b440];
// the model's materials for those, by the names they have in it (shared by every clone, so recoloured per home)
const PAINTED = { Wood: WOODS, Material: SOFAS, 'Material.002': RUGS, Shade: SHADES };
const painted = [];
// the screen, lit as if it's on
const SCREEN_COLOR = 0x0c1218, SCREEN_GLOW = 0x33536e;

// The pieces in a furniture model (see FURNITURE_MODEL_URL), by name (see `furniture`), each lit as the room is and the
// materials in it named in `paint` added to `painted`. Centred on their footprints, or else (`centred` false) put where
// the model has its origin, as the office's are (see OFFICE_MODEL_URL).
async function loadPieces(url, paint, painted, centred = true) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const pieces = {};
  for (const node of [...gltf.scene.children]) {
    const inner = new THREE.Group();
    inner.add(node);
    inner.scale.setScalar(FURNITURE_SCALE);
    if (node.name === 'TV') inner.rotation.y = Math.PI;
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    if (centred) inner.position.set(-mid.x, -box.min.y, -mid.z);
    else inner.position.set(-node.position.x*FURNITURE_SCALE, -box.min.y, -node.position.z*FURNITURE_SCALE);
    const object = new THREE.Group();
    object.add(inner);
    object.updateMatrixWorld(true);
    node.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = !o.material.transparent;
      furnitureLit(o.material);
      if (paint[o.material.name] && !painted.includes(o.material)) painted.push(o.material);
    });
    const bounds = { x0: box.min.x + inner.position.x, x1: box.max.x + inner.position.x, z0: box.min.z + inner.position.z, z1: box.max.z + inner.position.z };
    pieces[node.name] = { object, w: size.x, d: size.z, h: size.y, bounds, seats: [] };
  }
  return pieces;
}
async function loadFurniture() {
  let pieces;
  try {
    pieces = await loadPieces(FURNITURE_MODEL_URL, PAINTED, painted);
  } catch (err) {
    console.warn('Blockout: the interior model failed to load; homes are left bare', err);
    return;
  }
  for (const name of ['Sofa', 'Chair']) if (pieces[name]) pieces[name].seats = measureSeats(pieces[name]);
  // the TV's screen (where the video goes: see "the TV", below) and the lamp's bulb, in their pieces' own terms
  const part = (piece, material) => {
    let mesh = null;
    piece?.object.traverse(o => { if (o.isMesh && o.material.name === material) mesh = o; });
    return mesh && new THREE.Box3().setFromObject(mesh);
  };
  const screen = part(pieces.TV, 'Screen'), bulb = part(pieces.Lamp, 'Light');
  if (screen) pieces.TV.screen = { centre: screen.getCenter(new THREE.Vector3()).setZ(screen.max.z + 0.004),
    w: screen.max.x - screen.min.x, h: screen.max.y - screen.min.y };
  if (bulb) pieces.Lamp.bulb = bulb.getCenter(new THREE.Vector3());
  const hanging = part(pieces.Pendant, 'Light');
  if (hanging) pieces.Pendant.bulb = hanging.getCenter(new THREE.Vector3());
  if (!['TV', 'Sofa', 'Coffee_Table'].every(name => pieces[name])) {
    console.warn('Blockout: the interior model is missing its TV, sofa or coffee table; homes are left bare');
    return;
  }
  furniture = pieces;
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
// lit like the rest of the room (see roomLit), but for the lamp's bulb, which glows anyway, the glass, and the TV's screen
function furnitureLit(material) {
  if (material.name === 'Screen') {
    material.color.setHex(SCREEN_COLOR);
    material.emissive.setHex(SCREEN_GLOW);
    material.emissiveIntensity = 1;
  } else if (material.name !== 'Light' && !material.transparent) {
    roomLit(material);
  }
}
// Where on a sofa or chair (facing +z) anyone can sit: feeling down onto it from above, front to back along its middle,
// the seat's the first thing there and its back where it rises well above that; they sit a little in front of the back,
// as far apart along it as there's room for (up to three on a sofa).
function measureSeats(piece) {
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), from = new THREE.Vector3();
  const heightAt = (x, z) => {
    ray.set(from.set(x, piece.h + 1, z), down);
    const hit = ray.intersectObject(piece.object, true)[0];
    return hit ? hit.point.y : 0;
  };
  const { z0, z1 } = piece.bounds;
  let front = null, y = 0, back = z0;
  for (let z = z1; z > z0; z -= 0.01) {
    const h = heightAt(0, z);
    if (front === null) { if (h > 0.2) front = z; continue; }
    if (z > front - 0.1) { y = Math.max(y, h); continue; }
    if (h > y + 0.15) { back = z; break; }
  }
  if (front === null) return [];
  const z = Math.min(front - 0.08, back + 0.2);
  let half = 0;
  while (half < piece.w/2 && heightAt(half, z) < y + 0.1 && heightAt(-half, z) < y + 0.1) half += 0.02;
  const count = Math.max(1, Math.min(3, Math.floor(half*2/0.55)));
  return Array.from({ length: count }, (_, i) => ({ x: -half + (i + 0.5)*half*2/count, z, y }));
}
loadFurniture();

// Lays out the home for the building with this key (see buildingKey): `LAYOUTS.home`'s furniture, where nobody stands or
// walks, and its seats, in the room as it's now placed.
function furnish(key) {
  const home = LAYOUTS.home;
  home.group.clear(); // (clones, sharing the model's geometry and materials)
  home.blocked = []; home.solid = []; home.seats = [];
  home.screen = null;
  grid = null;
  stopTV();
  home.group.add(lampLight);
  lampLight.userData.there = false;
  const rng = mulberry32(hashNameToNumber(String(key)));
  home.floor.setHex(FLOORS[Math.floor(rng()*FLOORS.length)]);
  // (colours from a generator of their own, so the furniture's where it always was)
  const tint = mulberry32(hashNameToNumber(key + ' colours'));
  const pick = list => list[Math.floor(tint()*list.length)];
  home.wall.setHex(pick(WALLS));
  paintRoom();
  for (const material of painted) {
    material.color.setHex(pick(PAINTED[material.name]));
    roomLit(material);
  }
  if (!furniture) return;

  // what's taken so far (and room kept clear), as rectangles in the room's x and z; `tall` ones could hide the TV
  const taken = [];
  const footprint = (piece, x, z, angle, s = 1) => {
    const across = Math.abs(Math.sin(angle)) > 0.5, hw = (across ? piece.d : piece.w)*s/2, hd = (across ? piece.w : piece.d)*s/2;
    return { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd };
  };
  const overlaps = (a, b, gap = 0) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.z0 < b.z1 + gap && b.z0 < a.z1 + gap;
  const inRoom = (r, margin = 0.02) => r.x0 >= -ROOM_W/2 + margin && r.x1 <= ROOM_W/2 - margin
    && r.z0 >= -ROOM_D/2 + margin && r.z1 <= ROOM_D/2 - margin;
  const fits = (r, gap = 0, margin = 0.02) => inRoom(r, margin) && taken.every(o => !overlaps(r, o, gap));
  const put = (name, x, z, angle, { scale = 1, tall = false, underfoot = false } = {}) => {
    const piece = furniture[name], object = piece.object.clone();
    object.position.set(x, 0, z);
    object.rotation.y = angle;
    object.scale.setScalar(scale);
    home.group.add(object);
    const r = footprint(piece, x, z, angle, scale);
    if (underfoot) return r;
    taken.push({ ...r, tall });
    home.solid.push(r);
    home.blocked.push(around(r.x0, r.x1, r.z0, r.z1, 0.35));
    const c = Math.cos(angle), s = Math.sin(angle);
    for (const seat of piece.seats) home.seats.push({ x: x + seat.x*c + seat.z*s, z: z - seat.x*s + seat.z*c, y: seat.y, nx: s, nz: c, sofa: name === 'Sofa' });
    return r;
  };
  // the camera's corner, kept clear of anything but the sofa
  const cameraCorner = { x0: -ROOM_W/2, x1: -ROOM_W/2 + CAMERA_CLEAR, z0: -ROOM_D/2, z1: -ROOM_D/2 + CAMERA_CLEAR };

  // The TV and sofa, in terms of the wall the TV's against: u along it, v out from it into the room. Either far wall is
  // in full view of the camera.
  const onSide = rng() < 0.4;                                          // the +x wall, facing -x, or else the +z wall
  const wallLength = onSide ? ROOM_D : ROOM_W, depth = onSide ? ROOM_W : ROOM_D;
  const at = (u, v) => onSide ? { x: ROOM_W/2 - v, z: u } : { x: u, z: ROOM_D/2 - v };
  const toWall = onSide ? Math.PI/2 : 0, fromWall = toWall + Math.PI;
  const areaUV = (u0, u1, v0, v1) => {
    const a = at(u0, v0), b = at(u1, v1);
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
  };
  const { TV: tv, Sofa: sofa, 'Coffee_Table': coffee } = furniture;
  // (towards the wall's far end, rather than the camera's, where it'd be seen side on and the sofa'd be under the camera)
  const tvRange = wallLength/2 - tv.w/2 - 0.8, tvU = tvRange*(rng()*1.3 - 0.3), tvV = tv.d/2 + 0.03;
  let spot = at(tvU, tvV);
  put('TV', spot.x, spot.z, fromWall);
  const screen = { ...spot }, tvObject = home.group.children.at(-1);
  // the sofa, facing it a comfortable way off, with its back to the room behind
  const sofaV = Math.min(tv.d + 2.3 + rng()*0.7 + sofa.d/2, depth - sofa.d/2 - 0.05);
  const sofaU = THREE.MathUtils.clamp(tvU + (rng() - 0.5)*0.6, -wallLength/2 + sofa.w/2 + 0.1, wallLength/2 - sofa.w/2 - 0.1);
  spot = at(sofaU, sofaV);
  const sofaArea = put('Sofa', spot.x, spot.z, toWall);
  // the coffee table between them, far enough from the sofa to get to it, on a rug
  const coffeeV = sofaV - sofa.d/2 - 0.55 - coffee.d/2;
  spot = at(sofaU, coffeeV);
  put('Coffee_Table', spot.x, spot.z, toWall);
  if (furniture.Rug) { spot = at(sofaU, coffeeV + 0.15); put('Rug', spot.x, spot.z, toWall, { scale: 1.35, underfoot: true }); }
  // and nothing else between them
  taken.push(areaUV(sofaU - sofa.w/2, sofaU + sofa.w/2, tv.d, sofaV - sofa.d/2));
  taken.push(cameraCorner);
  // whether something tall at `r` would stand between the camera and the screen
  const hidesScreen = r => {
    for (let k = 1; k < 40; k++) {
      const x = CAMERA_AT.x + (screen.x - CAMERA_AT.x)*k/40, z = CAMERA_AT.z + (screen.z - CAMERA_AT.z)*k/40;
      if (x > r.x0 - 0.1 && x < r.x1 + 0.1 && z > r.z0 - 0.1 && z < r.z1 + 0.1) return true;
    }
    return false;
  };

  // a lamp at one end of the sofa or the other
  const lamp = furniture.Lamp;
  if (lamp && rng() < 0.7) {
    const first = rng() < 0.5 ? -1 : 1;
    for (const side of [first, -first]) {
      spot = at(sofaU + side*(sofa.w/2 + lamp.w/2 + 0.1), sofaV + sofa.d/2 - lamp.d/2);
      const r = footprint(lamp, spot.x, spot.z, 0);
      if (!fits(r, 0.05) || hidesScreen(r)) continue;
      put('Lamp', spot.x, spot.z, 0, { tall: true });
      if (lamp.bulb) { lampLight.position.copy(lamp.bulb).add(new THREE.Vector3(spot.x, 0, spot.z)); lampLight.userData.there = true; }
      break;
    }
  }
  // a bookcase against one of the far walls, between two of its windows, facing into the room
  const bookcase = furniture.Bookcase;
  if (bookcase && rng() < 0.7) {
    // (only piers wide enough for it, so it's not over the window either side: the ones at the walls' ends are mostly
    // behind the side walls, and fits turns those down)
    const spots = [[FAR_X, u => ({ x: u, z: ROOM_D/2 - bookcase.d/2 - 0.03, angle: Math.PI })],
      [FAR_Z, u => ({ x: ROOM_W/2 - bookcase.d/2 - 0.03, z: -u, angle: -Math.PI/2 })]]
      .flatMap(([w, spot]) => { const p = piers(...w); return p.width > bookcase.w + 0.04 ? p.centres.map(spot) : []; });
    while (spots.length) {
      const [p] = spots.splice(Math.floor(rng()*spots.length), 1);
      const r = footprint(bookcase, p.x, p.z, p.angle);
      if (!fits(r, 0.1) || hidesScreen(r)) continue;
      put('Bookcase', p.x, p.z, p.angle, { tall: true });
      break;
    }
  }
  // a chest of drawers somewhere along one of the far walls, facing into the room
  const drawers = furniture.Drawers;
  if (drawers && rng() < 0.6) {
    for (let tries = 0; tries < 30; tries++) {
      const onX = rng() < 0.5, u = (rng()*2 - 1)*((onX ? ROOM_D : ROOM_W)/2 - drawers.w/2 - 0.1);
      const p = onX ? { x: ROOM_W/2 - drawers.d/2 - 0.03, z: u, angle: -Math.PI/2 } : { x: u, z: ROOM_D/2 - drawers.d/2 - 0.03, angle: Math.PI };
      const r = footprint(drawers, p.x, p.z, p.angle);
      if (!fits(r, 0.15) || hidesScreen(r)) continue;
      put('Drawers', p.x, p.z, p.angle);
      break;
    }
  }
  // a dining table somewhere with room to walk round it, with a chair either side or all round — and not so near the
  // camera that it's cut off by the bottom of the view
  const underCamera = { x0: -ROOM_W/2, x1: -ROOM_W/2 + 2.8, z0: -ROOM_D/2, z1: -ROOM_D/2 + 2.8 };
  const table = furniture.Table, chair = furniture.Chair;
  let dining = null;
  if (table && chair && rng() < 0.8) {
    for (let tries = 0; tries < 60; tries++) {
      const x = (rng()*2 - 1)*(ROOM_W/2 - 1), z = (rng()*2 - 1)*(ROOM_D/2 - 1), turn = rng() < 0.5 ? 0 : Math.PI/2;
      const sides = rng() < 0.45 ? [0, 1, 2, 3] : rng() < 0.5 ? [0, 2] : [1, 3];
      const top = footprint(table, x, z, turn);
      const chairs = sides.map(k => {
        const dx = [0, 1, 0, -1][k], dz = [1, 0, -1, 0][k];
        const reach = (dx ? (top.x1 - top.x0) : (top.z1 - top.z0))/2 + chair.d/2 - 0.08;
        return { x: x + dx*reach, z: z + dz*reach, angle: Math.atan2(-dx, -dz) };
      });
      const all = [top, ...chairs.map(c => footprint(chair, c.x, c.z, c.angle))];
      const whole = { x0: Math.min(...all.map(r => r.x0)), x1: Math.max(...all.map(r => r.x1)),
        z0: Math.min(...all.map(r => r.z0)), z1: Math.max(...all.map(r => r.z1)) };
      if (!fits(whole, 0.7, 0.35) || overlaps(whole, underCamera)) continue;
      put('Table', x, z, turn);
      dining = { x, z };
      chairs.forEach(c => put('Chair', c.x, c.z, c.angle));
      break;
    }
  }
  // a light hanging from the ceiling over the dining table, or else the coffee table — the room's light after dark when
  // there is one, rather than the lamp's
  const pendant = furniture.Pendant;
  if (pendant && rng() < 0.75) {
    spot = dining ?? at(sofaU, coffeeV);
    put('Pendant', spot.x, spot.z, 0, { underfoot: true });
    home.group.children.at(-1).position.y = ROOM_H - pendant.h;
    if (pendant.bulb) {
      lampLight.position.copy(pendant.bulb).add(new THREE.Vector3(spot.x, ROOM_H - pendant.h, spot.z));
      lampLight.userData.there = true;
    }
  }
  // a plant or two, in the corners (not the camera's) or either side of the TV
  const plant = furniture.Plant;
  if (plant) {
    let plants = 1 + Math.floor(rng()*2.5);
    const inset = Math.max(plant.w, plant.d)/2 + 0.1;
    const spots = [
      { x: ROOM_W/2 - inset, z: ROOM_D/2 - inset }, { x: ROOM_W/2 - inset, z: -ROOM_D/2 + inset },
      { x: -ROOM_W/2 + inset, z: ROOM_D/2 - inset },
      at(tvU - tv.w/2 - inset, inset), at(tvU + tv.w/2 + inset, inset),
    ];
    while (plants > 0 && spots.length) {
      const [p] = spots.splice(Math.floor(rng()*spots.length), 1), scale = 0.85 + rng()*0.3;
      const r = footprint(plant, p.x, p.z, 0, scale);
      if (!fits(r, 0.1) || hidesScreen(r)) continue;
      put('Plant', p.x, p.z, rng()*Math.PI*2, { scale, tall: true });
      plants--;
    }
  }

  // the seats, in the world: where to sit, how high, and which way they face
  const c = Math.cos(room.rotation.y), s = Math.sin(room.rotation.y);
  home.seats = home.seats.map(seat => {
    const w = room.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z));
    return { x: w.x, y: w.y, z: w.z, nx: seat.nx*c + seat.nz*s, nz: -seat.nx*s + seat.nz*c, sofa: seat.sofa, by: null };
  });
  // and the TV's screen, in the world (switched on by whoever sits down in front of it: see watchingTV)
  if (tv.screen) {
    tvObject.updateMatrixWorld(true);
    home.screen = { centre: tvObject.localToWorld(tv.screen.centre.clone()), turn: tvObject.getWorldQuaternion(new THREE.Quaternion()),
      w: tv.screen.w, h: tv.screen.h };
  }
}

// ---------------------------------------------------------- an office's furniture
// The office's furniture's a model too (assets/models/Office.glb, built by tools/office-models.py): one top-level mesh per
// piece — WaterCooler, Printer, Cabinet, LowCabinet, Desk (a cubicle: its desk, back and left-hand panels, monitor,
// keyboard and mouse), Panel (to close off a row of them), OfficeChair, three plants (SnakePlant, Ficus, Bush), and what's
// left lying about a desk (Sticky, Calendar, Mug, Frame, Pens, Cactus, Papers, Duck) — at five times life size, facing +z,
// each placed by its own origin rather than centred (so the desk's parts are where DESK says). Each office arranges it
// its own way (from its building's key): a bank or two of cubicles, side by side in a row or back to back, out in the
// room or against a wall, each with its chair and its own clutter, then filing cabinets, a printer and a water cooler
// against the walls and plants about the place. Until the model's loaded, offices are bare.
const OFFICE_MODEL_URL = 'assets/models/Office.glb';
let officeFurniture = null;
// Where things are on the Desk, in its own terms (life size, from its origin, x across, y up and z out of its front):
// the top's height, its front edge, the faces of its back and left-hand panels, how far apart the desks stand in a row,
// what's where on its top (the monitor's face and span, and the two clear patches either side), and where its right-hand
// end's closing Panel goes. (As tools/office-models.py builds it.)
const DESK = {
  top: 0.74, front: 0.375, back: -0.375, left: -0.7, panelTop: 1.25, spacing: 1.45, depth: 0.425,
  monitor: { face: -0.13, x0: -0.29, x1: 0.29, top: 1.19 },
  clear: [{ x0: -0.64, x1: -0.38, z0: -0.3, z1: 0 }, { x0: -0.64, x1: -0.38, z0: 0.02, z1: 0.3 }, { x0: 0.4, x1: 0.64, z0: -0.3, z1: -0.04 }],
  endPanel: { x: 0.725, z: 0.025 },
};
const CHAIR_ROOM = 0.8;  // behind a desk's front, for its chair and the one sitting in it
const OFFICE_FLOORS = [0x6f7478, 0x5d6670, 0x7a7670, 0x565a5e, 0x6a7a80, 0x8a8478, 0x4e5660, 0x7d8a8a];
const OFFICE_WALLS = [0xe8e6e0, 0xf2f1ec, 0xdcdfe2, 0xe6e0d4, 0xd8e0dc, 0xeae4da];
const FABRICS = [0x6d7a8c, 0x8a8c8e, 0x5a6a70, 0xa8a090, 0x4a5a78, 0x6a7a62, 0x9a8a80, 0x3e4a56];
const UPHOLSTERY = [0x2f3f5a, 0x2a2c30, 0x5a2e2e, 0x3a4a3a, 0x4a4e56, 0x2e5a6a, 0x6a5a3a];
const LAMINATES = [0xe2ddd2, 0xf0efea, 0xc8b08a, 0xa8a8a4, 0xd8c4a0, 0x8a6a4a];
const STEELS = [0x9a9ea3, 0xc8c4b8, 0x5a5e64, 0x8a96a0, 0xd8d6d0];
const POTS = [0xece8e0, 0x3a3a3c, 0xb8603e, 0x8a9a8a, 0xd8ccb4];
const OFFICE_PAINTED = { Fabric: FABRICS, Upholstery: UPHOLSTERY, Laminate: LAMINATES, Steel: STEELS, Pot: POTS };
const officePainted = [];
// sticky notes and mugs come in all colours, office to office and desk to desk: a material for each
const STICKIES = [0xf6e36a, 0xf6a6c0, 0x9ae0a0, 0x8cc8f0, 0xf8b060];
const MUGS = [0xd84a3a, 0xf2f0ea, 0x2c4ec8, 0x3a3a3c, 0xe8c040, 0x4a9a6a];
const clutterMaterials = { Sticky: [], Mug: [] };

async function loadOfficeFurniture() {
  try {
    officeFurniture = await loadPieces(OFFICE_MODEL_URL, OFFICE_PAINTED, officePainted, false);
  } catch (err) {
    console.warn('Blockout: the office model failed to load; offices are left bare', err);
    return;
  }
  for (const [name, colours] of [['Sticky', STICKIES], ['Mug', MUGS]]) {
    let base = null;
    officeFurniture[name]?.object.traverse(o => { if (o.isMesh && o.material.name === name) base = o.material; });
    if (base) clutterMaterials[name] = colours.map(c => { const m = base.clone(); m.color.setHex(c); return roomLit(m); });
  }
  if (officeFurniture.OfficeChair) officeFurniture.OfficeChair.seats = measureSeats(officeFurniture.OfficeChair);
  if (inside && current === LAYOUTS.office) furnishOffice(inside.key, curtain.visible);
}
loadOfficeFurniture();

// (x, z) turned by `angle` about y (as three.js turns an object: +z towards (sin, cos)) and moved to (ox, oz)
const turned = (x, z, angle, ox = 0, oz = 0) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: ox + x*c + z*s, z: oz - x*s + z*c };
};
// the rectangle (in the room's x and z) that `r`, in something's own terms, covers once it's turned and moved so
const turnedRect = (r, angle, ox, oz) => {
  const corners = [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]].map(([x, z]) => turned(x, z, angle, ox, oz));
  return { x0: Math.min(...corners.map(p => p.x)), x1: Math.max(...corners.map(p => p.x)),
    z0: Math.min(...corners.map(p => p.z)), z1: Math.max(...corners.map(p => p.z)) };
};

// Lays out the office for the building with this key (see buildingKey), glass-walled or not (see enterBuilding):
// `LAYOUTS.office`'s furniture, where nobody stands or walks, and its seats, in the room as it's now placed.
function furnishOffice(key, glass) {
  const office = LAYOUTS.office;
  officeGroup.clear();
  office.blocked = []; office.solid = []; office.seats = []; office.printer = null; office.desks = [];
  grid = null;
  const rng = mulberry32(hashNameToNumber(key + ' office'));
  const tint = mulberry32(hashNameToNumber(key + ' office colours'));
  const pick = list => list[Math.floor(tint()*list.length)];
  office.floor.setHex(pick(OFFICE_FLOORS));
  office.wall.setHex(pick(OFFICE_WALLS));
  paintRoom();
  for (const material of officePainted) {
    material.color.setHex(pick(OFFICE_PAINTED[material.name]));
    roomLit(material);
  }
  const F = officeFurniture;
  if (!F?.Desk || !F.OfficeChair) return;
  const any = list => list[Math.floor(rng()*list.length)];

  // what's taken so far (and room kept clear), as rectangles in the room's x and z
  const taken = [];
  const overlaps = (a, b, gap = 0) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.z0 < b.z1 + gap && b.z0 < a.z1 + gap;
  const inRoom = (r, margin) => r.x0 >= -ROOM_W/2 + margin && r.x1 <= ROOM_W/2 - margin
    && r.z0 >= -ROOM_D/2 + margin && r.z1 <= ROOM_D/2 - margin;
  const fits = (r, gap = 0, margin = 0.02) => inRoom(r, margin) && taken.every(o => !overlaps(r, o, gap));
  // `name` stood at (x, z) turned by `angle`, in `parent` (the room's furniture, or on a desk, in the desk's terms),
  // and unless it's something small nobody could walk into, solid (or `solid` of it, in its own terms)
  const put = (name, x, z, angle, { parent = officeGroup, y = 0, small = false, solid = null } = {}) => {
    const piece = F[name], object = piece.object.clone();
    object.position.set(x, y, z);
    object.rotation.y = angle;
    parent.add(object);
    if (small) return object;
    const r = turnedRect(solid ?? piece.bounds, angle, x, z);
    office.solid.push(r);
    office.blocked.push(around(...(solid ? [x - 0.4, x + 0.4, z - 0.4, z + 0.4] : [r.x0, r.x1, r.z0, r.z1]), 0.35));
    for (const seat of piece.seats) {
      const at = turned(seat.x, seat.z, angle, x, z);
      office.seats.push({ x: at.x, z: at.z, y: seat.y, nx: Math.sin(angle), nz: Math.cos(angle), sofa: false, desk: name === 'OfficeChair' });
    }
    return object;
  };
  const cameraCorner = { x0: -ROOM_W/2, x1: -ROOM_W/2 + CAMERA_CLEAR, z0: -ROOM_D/2, z1: -ROOM_D/2 + CAMERA_CLEAR };
  taken.push(cameraCorner);
  // (nothing tall right under the camera, where it'd fill the bottom of the view)
  const underCamera = { x0: -ROOM_W/2, x1: -ROOM_W/2 + 2.4, z0: -ROOM_D/2, z1: -ROOM_D/2 + 2.4 };
  if (glass) for (const [cx, cz] of COLUMNS) taken.push({ x0: cx - COLUMN/2, x1: cx + COLUMN/2, z0: cz - COLUMN/2, z1: cz + COLUMN/2 });

  // The walls, each as where along it things stand with their backs to it, facing into the room: the direction into the
  // room (nx, nz), and the angle that faces that way. The far two have windows unless the office is glass (see piers).
  const WALL_SIDES = [
    { nx: 0, nz: -1, at: u => ({ x: u, z: ROOM_D/2 }), length: ROOM_W, far: FAR_X, flip: 1 },
    { nx: -1, nz: 0, at: u => ({ x: ROOM_W/2, z: u }), length: ROOM_D, far: FAR_Z, flip: -1 },
    { nx: 0, nz: 1, at: u => ({ x: u, z: -ROOM_D/2 }), length: ROOM_W },
    { nx: 1, nz: 0, at: u => ({ x: -ROOM_W/2, z: u }), length: ROOM_D },
  ].map(side => ({ ...side, angle: Math.atan2(side.nx, side.nz) }));
  // whether something from u0 to u1 along a far wall, and taller than its windowsills, stands in front of a window
  const overWindow = (side, u0, u1) => {
    if (glass || !side.far) return false;
    const { width, centres } = piers(...side.far);
    return !centres.some(c => { const p = c*side.flip; return u0 >= p - width/2 && u1 <= p + width/2; });
  };
  // Somewhere along a wall for something `r` in its own terms (facing +z, its back towards -z), tall or not (and so kept
  // out from under the camera, and from in front of the windows unless it's `under` them): where it goes and which way
  // it faces, or null if there's nowhere.
  const againstWall = (r, tall, { tries = 40, under = false } = {}) => {
    for (let k = 0; k < tries; k++) {
      const side = any(WALL_SIDES), half = (r.x1 - r.x0)/2;
      const u = (rng()*2 - 1)*(side.length/2 - half - 0.05), wallAt = side.at(u);
      const out = -r.z0 + 0.02, mid = (r.x0 + r.x1)/2;
      // (u runs along the wall the way its local x does once it's turned to face the room)
      const across = turned(1, 0, side.angle);
      const x = wallAt.x + side.nx*out - across.x*mid, z = wallAt.z + side.nz*out - across.z*mid;
      const area = turnedRect(r, side.angle, x, z);
      if (!fits(area, 0.25)) continue;
      if (tall && overlaps(area, underCamera)) continue;
      const along = side.nx ? [area.z0, area.z1] : [area.x0, area.x1];
      if (tall && !under && overWindow(side, ...along)) continue;
      return { x, z, angle: side.angle, area };
    }
    return null;
  };

  // The cubicles: banks of them, a row side by side or two rows back to back, out in the room or with their backs to a
  // wall. A bank's laid out in its own terms — u along it, v out from the line down its middle (its back, for a row) —
  // then turned and moved into place.
  const bank = (count, double) => {
    const desks = [];
    for (const row of double ? [0, 1] : [0]) for (let i = 0; i < count; i++)
      desks.push({ u: (i - (count - 1)/2)*DESK.spacing, v: row ? -DESK.depth : DESK.depth, angle: row ? Math.PI : 0, row, i });
    const half = count*DESK.spacing/2 + 0.03, reach = DESK.depth + DESK.front + CHAIR_ROOM;
    return { desks, count, area: { x0: -half, x1: half, z0: double ? -reach : -0.02, z1: reach } };
  };
  const placeBank = (plan, x, z, angle) => {
    for (const d of plan.desks) {
      const at = turned(d.u, d.v, angle, x, z), deskAngle = angle + d.angle;
      const desk = put('Desk', at.x, at.z, deskAngle);
      clutter(desk);
      // the chair, pulled up to it near enough to type from (the Typing pose's reach: see peopleModel.js), not quite straight
      const chairAt = turned((rng() - 0.5)*0.12, DESK.front + 0.25 + rng()*0.07, deskAngle, at.x, at.z);
      put('OfficeChair', chairAt.x, chairAt.z, deskAngle + Math.PI + (rng() - 0.5)*0.24,
        { solid: { x0: -0.15, x1: 0.15, z0: -0.15, z1: 0.15 } });
      // and the panel closing off the row's far end (the last desk, the way its right hand is)
      if (F.Panel && d.i === (d.row ? 0 : plan.count - 1)) {
        const p = turned(DESK.endPanel.x, DESK.endPanel.z, deskAngle, at.x, at.z);
        put('Panel', p.x, p.z, deskAngle);
      }
    }
    taken.push(turnedRect(plan.area, angle, x, z));
  };
  // (as many as there's room for, up to three, each as big as will go: four desks along it, then fewer)
  for (let b = 0, placed = true; b < 3 && placed; b++) {
    placed = false;
    for (let tries = 0; tries < 160 && !placed; tries++) {
      const count = 4 - Math.floor(tries/40), double = rng() < (b ? 0.4 : 0.7);
      const plan = bank(count, double);
      let spot;
      if (!double && rng() < 0.6) {
        spot = againstWall(plan.area, true, { tries: 1, under: true });
        if (!spot) continue;
      } else {
        spot = { x: (rng()*2 - 1)*(ROOM_W/2 - 1), z: (rng()*2 - 1)*(ROOM_D/2 - 1) };
        // (turned so the view looks into the cubicles, not at the backs of their panels: a row with its chairs toward
        // the camera, and mostly a pod end on to it, its spine running away, both rows open to the view)
        const toX = -ROOM_W/2 - spot.x, toZ = -ROOM_D/2 - spot.z;
        const facing = a => double ? Math.abs(Math.cos(a)*toX - Math.sin(a)*toZ) : Math.sin(a)*toX + Math.cos(a)*toZ;
        const angles = [0, 1, 2, 3].map(i => i*Math.PI/2);
        spot.angle = double && rng() < 0.25 ? angles[Math.floor(rng()*4)]
          : angles.reduce((best, a) => facing(a) > facing(best) ? a : best);
        const angle = spot.angle;
        const area = turnedRect(plan.area, angle, spot.x, spot.z);
        if (!fits(area, 0.8, 0.5) || overlaps(area, underCamera)) continue;
      }
      placeBank(plan, spot.x, spot.z, spot.angle);
      placed = true;
    }
  }

  // What's lying about a desk: some of the little things on its top, in the clear patches either side of the keyboard,
  // sticky notes on its panels (and its monitor), and maybe a calendar pinned up.
  function clutter(desk) {
    const ON_TOP = ['Mug', 'Mug', 'Frame', 'Pens', 'Pens', 'Cactus', 'Papers', 'Papers', 'Duck'].filter(name => F[name]);
    const patches = [...DESK.clear];
    for (let n = Math.floor(rng()*4); n > 0 && patches.length; n--) {
      const [p] = patches.splice(Math.floor(rng()*patches.length), 1), name = any(ON_TOP);
      const x = p.x0 + (p.x1 - p.x0)*(0.3 + rng()*0.4), z = p.z0 + (p.z1 - p.z0)*(0.3 + rng()*0.4);
      // (a photo turned in towards whoever sits there; anything else any way round)
      const angle = name === 'Frame' ? Math.sign(-x)*0.5 + (rng() - 0.5)*0.3 : (rng() - 0.5)*1.2;
      const thing = put(name, x, z, angle, { parent: desk, y: DESK.top, small: true });
      paintClutter(thing);
    }
    // (the panels' faces, as where up them a thing pinned there is, from its bottom, and where along them)
    const onBack = (x, y) => ({ x, y, z: DESK.back + 0.004, angle: 0 });
    const onLeft = (z, y) => ({ x: DESK.left + 0.004, y, z, angle: Math.PI/2 });
    let calendar = null;
    if (F.Calendar && rng() < 0.35) {
      calendar = rng() < 0.5 ? 'back' : 'left';
      const at = calendar === 'back' ? onBack(-0.52 + rng()*0.04, 0.78) : onLeft(-0.15 + rng()*0.25, 0.78);
      const pinned = put('Calendar', at.x, at.z, at.angle, { parent: desk, y: at.y, small: true });
      pinned.rotation.z = (rng() - 0.5)*0.06;
    }
    if (!F.Sticky) return;
    for (let n = Math.floor(rng()*rng()*8); n > 0; n--) {
      const where = rng();
      let at;
      if (where < 0.15) {
        // on the monitor's frame, a corner
        const side = rng() < 0.5 ? -1 : 1;
        at = { x: side*(DESK.monitor.x1 - 0.03), y: DESK.monitor.top - 0.12 - rng()*0.15, z: DESK.monitor.face + 0.003, angle: 0 };
      } else if (where < 0.65 && calendar !== 'back') {
        const x = rng() < 0.5 ? -0.65 + rng()*0.3 : 0.34 + rng()*0.3;
        at = onBack(x, 0.82 + rng()*0.32);
      } else if (where < 0.65) {
        at = onBack(0.34 + rng()*0.3, 0.82 + rng()*0.32);
      } else if (calendar !== 'left') {
        at = onLeft(-0.3 + rng()*0.6, 0.82 + rng()*0.32);
      } else continue;
      const note = put('Sticky', at.x, at.z, at.angle, { parent: desk, y: at.y, small: true });
      note.rotation.z = (rng() - 0.5)*0.3;
      paintClutter(note);
    }
  }
  function paintClutter(object) {
    object.traverse(o => {
      const set = o.isMesh && clutterMaterials[o.material.name];
      if (set?.length) o.material = any(set);
    });
  }

  // against the walls: a printer, a water cooler, and a run of filing cabinets or two, tall or low
  const againstWallPut = (name, tall) => {
    if (!F[name]) return null;
    const spot = againstWall(F[name].bounds, tall);
    if (!spot) return null;
    put(name, spot.x, spot.z, spot.angle);
    taken.push(spot.area);
    return spot;
  };
  const printerSpot = rng() < 0.85 ? againstWallPut('Printer', true) : null;
  office.printer = printerSpot ? room.localToWorld(new THREE.Vector3(printerSpot.x, 0.9, printerSpot.z)) : null;
  if (rng() < 0.8) againstWallPut('WaterCooler', true);
  for (let runs = Math.floor(rng()*3); runs > 0; runs--) {
    const name = rng() < 0.6 ? 'Cabinet' : 'LowCabinet', piece = F[name];
    if (!piece) continue;
    const count = 1 + Math.floor(rng()*3), w = piece.bounds.x1 - piece.bounds.x0;
    const r = { ...piece.bounds, x0: piece.bounds.x0 - (count - 1)*w/2, x1: piece.bounds.x1 + (count - 1)*w/2 };
    const spot = againstWall(r, name === 'Cabinet');
    if (!spot) continue;
    for (let i = 0; i < count; i++) {
      const at = turned((i - (count - 1)/2)*w, 0, spot.angle, spot.x, spot.z);
      put(name, at.x, at.z, spot.angle);
    }
    taken.push(spot.area);
    // (with a plant on top now and then, if they're low)
    if (name === 'LowCabinet' && F.Cactus && rng() < 0.5) {
      const at = turned((rng() - 0.5)*(count - 0.5)*w, 0, spot.angle, spot.x, spot.z);
      put(rng() < 0.5 ? 'Cactus' : 'Pens', at.x, at.z, rng()*Math.PI*2, { y: piece.h, small: true });
    }
  }
  // and plants: in the corners (not the camera's) if there's room, or else along the walls
  const PLANTS = ['SnakePlant', 'Ficus', 'Bush'].filter(name => F[name]);
  if (PLANTS.length) {
    const corners = [[1, 1], [1, -1], [-1, 1]];
    for (let plants = 1 + Math.floor(rng()*4); plants > 0; plants--) {
      const name = any(PLANTS), piece = F[name], inset = Math.max(piece.w, piece.d)/2 + 0.08;
      let spot = null;
      while (!spot && corners.length) {
        const [[sx, sz]] = corners.splice(Math.floor(rng()*corners.length), 1);
        // (beside the column, in a glass office's corners)
        const shift = glass ? COLUMN*0.5 + inset : 0, alongX = rng() < 0.5;
        const x = sx*(ROOM_W/2 - inset - (alongX ? shift : 0)), z = sz*(ROOM_D/2 - inset - (alongX ? 0 : shift));
        const area = { x0: x - inset, x1: x + inset, z0: z - inset, z1: z + inset };
        if (fits(area, 0.1) && !overlaps(area, underCamera)) spot = { x, z, area };
      }
      spot ??= againstWall(piece.bounds, true);
      if (!spot) continue;
      put(name, spot.x, spot.z, rng()*Math.PI*2);
      taken.push(spot.area);
    }
  }

  // the seats, in the world: where to sit, how high, and which way they face
  const c = Math.cos(room.rotation.y), s = Math.sin(room.rotation.y);
  office.seats = office.seats.map(seat => {
    const w = room.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z));
    return { x: w.x, y: w.y, z: w.z, nx: seat.nx*c + seat.nz*s, nz: -seat.nx*s + seat.nz*c, sofa: false, desk: seat.desk, by: null };
  });
  // and the desks, for the phones and computers on them to be heard from (see audio/office.js): in front of each desk chair
  office.desks = office.seats.filter(seat => seat.desk)
    .map(seat => ({ x: seat.x + seat.nx*0.55, y: room.position.y + 0.85, z: seat.z + seat.nz*0.55 }));
}

// ---------------------------------------------------------------- the TV
// A home's TV is on while anyone's sat on the sofa (see watchingTV), playing a YouTube video picked at random from
// assets/tv.txt each time it comes on: a real YouTube player in an
// iframe, laid out by CSS3DRenderer to sit exactly where the screen is, on its own layer behind the canvas — and the
// canvas cut through to it at the screen (see setCutout in pixelation.js), so whoever walks in front of the TV hides it
// as they would anything else. It starts muted (browsers only let a page play sound once it's been clicked or typed
// into) and turns its sound up from then on, unless the app's muted. One at a time: it's only ever the room you're in.
// It plays each video through once, and whoever's watching sits it out to the end (see watchingTV) — the player telling
// us when it's over.
const TV_LIST_URL = 'assets/tv.txt';
const TV_PIXELS = 640;  // the player's width, as laid out — scaled down to the screen's
const TV_VOLUME = 60;   // out of 100
let channels = [];      // YouTube video ids
fetch(TV_LIST_URL).then(r => r.ok ? r.text() : '').then(text => {
  channels = text.split('\n').map(videoId).filter(Boolean);
}).catch(() => {});
// the id of the video a line of tv.txt links to (any of YouTube's link shapes, or the bare id), or null
function videoId(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  return (line.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) ?? line.match(/^([\w-]{11})$/))?.[1] ?? null;
}
let tvLayer = null;       // the CSS3DRenderer and its scene, made the first time there's a TV on
let tv = null;            // what's on: { object (its CSS3DObject), iframe, muted, video, startedAt, heard, endedAt }
let videos = 0;           // counts every video put on, so a watcher can tell theirs from the next
const tvHoles = new THREE.Scene();
const tvHole = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  vertexShader: 'void main() { gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }',
  fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
  blending: THREE.NoBlending, depthWrite: false,
}));
tvHoles.add(tvHole);
function startTV() {
  const screen = LAYOUTS.home.screen;
  if (tv || !screen || !channels.length) return;
  if (!tvLayer) {
    const css = new CSS3DRenderer();
    css.domElement.style.cssText += ';position:absolute;inset:0;pointer-events:none';
    renderer.domElement.style.position = 'relative';
    renderer.domElement.style.zIndex = '1';
    renderer.domElement.parentElement.prepend(css.domElement);
    css.setSize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', () => css.setSize(window.innerWidth, window.innerHeight));
    tvLayer = { css, scene: new THREE.Scene() };
  }
  const id = channels[Math.floor(Math.random()*channels.length)];
  const iframe = document.createElement('iframe');
  const width = TV_PIXELS, height = Math.round(TV_PIXELS*screen.h/screen.w);
  iframe.style.cssText = `width:${width}px;height:${height}px;border:0;background:#000`;
  iframe.allow = 'autoplay; encrypted-media';
  iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0`
    + `&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  const object = new CSS3DObject(iframe);
  object.position.copy(screen.centre);
  object.quaternion.copy(screen.turn);
  object.scale.setScalar(screen.w/width);
  tvLayer.scene.add(object);
  tvHole.position.copy(screen.centre);
  tvHole.quaternion.copy(screen.turn);
  tvHole.scale.set(screen.w, screen.h, 1);
  setCutout(tvHoles);
  tv = { object, iframe, muted: true, toldAt: -Infinity, video: ++videos, startedAt: performance.now(), heard: false, endedAt: null };
}
function stopTV() {
  if (!tv) return;
  tvLayer.scene.remove(tv.object); // (which takes its iframe out of the page)
  tv = null;
  setCutout(null);
}
// a command for the player (see YouTube's IFrame Player API)
const tell = (func, ...args) => tv.iframe.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
// What the player tells us, once it's been told we're listening: whether the video's over (ended, or couldn't play).
window.addEventListener('message', e => {
  if (!tv || e.source !== tv.iframe.contentWindow) return;
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  tv.heard = true;
  const state = data.event === 'onStateChange' ? data.info : data.event === 'infoDelivery' ? data.info?.playerState : undefined;
  if ((state === 0 || data.event === 'onError') && tv.endedAt === null) tv.endedAt = performance.now();
});
const TV_SILENT_AFTER = 10000; // ms without a word from the player before it's taken to be one that won't say when it's done
let watchedAt = -Infinity;
/**
 * Said each frame by whoever's sat on the sofa (see peopleActivities.js).
 * @returns {?number} the video that's on (a number to hold onto, to tell when it's over), -1 if it's on but the player
 *   won't say when it's over, or null if nothing is (the TV not on yet, or the video over)
 */
export function watchingTV() {
  watchedAt = performance.now();
  if (!tv || tv.endedAt !== null) return null;
  return !tv.heard && watchedAt - tv.startedAt > TV_SILENT_AFTER ? -1 : tv.video;
}
// Each frame: the TV switched on or off as anyone's sat watching it or not, and while it's on, the player laid out where
// the screen now is on the screen, and its sound on or off.
function updateTV() {
  const watched = inside && current === LAYOUTS.home && performance.now() - watchedAt < 500;
  if (watched && !tv) startTV();
  else if (!watched && tv) stopTV();
  // (whoever sat through it has got up; anyone still watching, sat down since, gets something new)
  else if (tv && tv.endedAt !== null && performance.now() - tv.endedAt > 1500) { stopTV(); startTV(); }
  if (!tv) return;
  tvLayer.css.render(tvLayer.scene, camera);
  // (told again every so often: the player misses anything it's told before it's ready, and there's no knowing when that is
  // without its API script)
  const muted = isMuted() || !navigator.userActivation?.hasBeenActive, now = performance.now();
  if (muted === tv.muted && now - tv.toldAt < 2000) return;
  tv.muted = muted;
  tv.toldAt = now;
  if (!tv.heard) {
    tv.iframe.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: tv.video, channel: 'widget' }), 'https://www.youtube.com');
    tell('addEventListener', 'onStateChange');
    tell('addEventListener', 'onError');
  }
  if (muted) tell('mute');
  else { tell('unMute'); tell('setVolume', TV_VOLUME); }
}

// ---------------------------------------------------------------- the lamp
// A home's lamp (when it has one) comes on after dark, while anyone's in (see someoneHome) — a real light, only in the
// scene while the room is, so it costs the rest of the city nothing.
const LAMP_COLOR = 0xffc68a, LAMP_INTENSITY = 6, LAMP_REACH = 9, LAMP_EASE = 0.05;
const lampLight = new THREE.PointLight(LAMP_COLOR, 0, LAMP_REACH, 1.2);
let occupiedAt = -Infinity;
// (said each frame by whoever's in the room: see peopleActivities.js)
export const someoneHome = () => { occupiedAt = performance.now(); counting++; };
let occupants = 0, counting = 0; // how many said so over the last frame, and so far this one
function updateLamp() {
  const dark = THREE.MathUtils.smoothstep(-(S.sunElevation ?? 90), -6, 2);
  const on = lampLight.userData.there && current === LAYOUTS.home && performance.now() - occupiedAt < 1000;
  const goal = on ? LAMP_INTENSITY*dark : 0;
  lampLight.intensity = Math.abs(goal - lampLight.intensity) < 0.01 ? goal : lampLight.intensity + (goal - lampLight.intensity)*LAMP_EASE;
}

// where the camera sits in the room, in the room's own terms
const CAMERA_AT = new THREE.Vector3(-ROOM_W/2 + CAMERA_INSET, CAMERA_HEIGHT, -ROOM_D/2 + CAMERA_INSET);
// the far corners of the three walls the camera looks across
const FAR_CORNERS = [[ROOM_W/2, -ROOM_D/2], [ROOM_W/2, ROOM_D/2], [-ROOM_W/2, ROOM_D/2]];
const FOV_EASE = 0.12;
const ROOM_NEAR = 0.1; // the ceiling's closer than the usual near plane, and the wide view takes it in
// Which way the camera faces: the middle of the far corners' spread, side to side.
const CAMERA_YAW = (() => {
  const yaws = FAR_CORNERS.map(([x, z]) => Math.atan2(x - CAMERA_AT.x, z - CAMERA_AT.z));
  return (Math.min(...yaws) + Math.max(...yaws))/2;
})();
const BASE_FOV = camera.fov;
// What tools/interior.html is trying out in place of the view above, each null for the usual: the camera's height above
// the floor, how far it looks down (degrees below level) and its vertical field of view (degrees).
const tuning = { height: null, pitch: null, fov: null };
// the camera's eye and what it looks at, in the room's own terms
function view() {
  const eye = CAMERA_AT.clone();
  eye.y = tuning.height ?? CAMERA_HEIGHT;
  const pitch = -THREE.MathUtils.degToRad(tuning.pitch ?? CAMERA_PITCH);
  const along = new THREE.Vector3(Math.sin(CAMERA_YAW)*Math.cos(pitch), Math.sin(pitch), Math.cos(CAMERA_YAW)*Math.cos(pitch));
  return { eye, look: eye.clone().add(along.multiplyScalar(5)) };
}
const viewFov = () => tuning.fov ?? CAMERA_FOV;
/**
 * Try out a different view from the room's corner (for tools/interior.html): anything left out or null goes back to the usual.
 * @param {{height?: ?number, pitch?: ?number, fov?: ?number}} t - height above the floor, degrees looking down, vertical FOV
 * @returns {{height: number, pitch: number, fov: number}} the view as it now is
 */
export function tuneInteriorView(t = {}) {
  Object.assign(tuning, { height: null, pitch: null, fov: null }, t);
  if (inside) { placeCamera(); controls.update(true); camera.fov = viewFov(); camera.updateProjectionMatrix(); }
  return { height: tuning.height ?? CAMERA_HEIGHT, pitch: tuning.pitch ?? CAMERA_PITCH, fov: viewFov() };
}

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
  const glass = current === LAYOUTS.office && keyFraction(key) >= OFFICE_PUNCHED;
  curtain.visible = glass; punched.visible = !glass;
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
  if (current === LAYOUTS.home) furnish(key);
  else if (current === LAYOUTS.office) furnishOffice(key, glass);

  visits++;
  resetOfficeAmbience();
  inside = { group, key, before: {
    target: controls.goalTarget.clone(), radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi,
    minRadius: controls.minRadius, near: camera.near,
  } };
  camera.near = ROOM_NEAR;
  camera.updateProjectionMatrix();
  placeCamera();
  controls.locked = true;
  setIndoors(inRoom);
  // a hard cut in, no glide
  controls.update(true);
  camera.fov = viewFov();
  camera.updateProjectionMatrix();
}
// The camera cut to the room's corner (see view), looking where it looks.
function placeCamera() {
  const { eye: at, look: towards } = view();
  const eye = room.localToWorld(at.clone()), look = room.localToWorld(towards.clone());
  const offset = eye.clone().sub(look), radius = offset.length();
  controls.goalTarget.copy(look);
  controls.minRadius = 0;
  controls.goalRadius = radius;
  controls.goalPhi = Math.acos(offset.y/radius);
  // the nearer way round to the corner, so easing back out on leaving doesn't swing all the way about
  const theta = Math.atan2(offset.x, offset.z);
  controls.goalTheta = controls.theta + Math.atan2(Math.sin(theta - controls.theta), Math.cos(theta - controls.theta));
}

// Back out: the building drawn again, the room put away, and the camera eased back to where it was looking from.
export function leaveBuilding() {
  if (!inside) return;
  const { group, before } = inside;
  inside = null;
  setIndoors(null);
  stopTV();
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

// Whether a point in the world is in the room, walls and all: what's heard from there isn't muffled (see setIndoors).
const probe = new THREE.Vector3();
function inRoom(x, y, z) {
  room.worldToLocal(probe.set(x, y, z));
  return Math.abs(probe.x) <= ROOM_W/2 + WALL && Math.abs(probe.z) <= ROOM_D/2 + WALL && probe.y >= -SLAB && probe.y <= ROOM_H + SLAB;
}

// Each frame: the view eased wider inside a room, and back to its usual angle outside.
export function updateInteriorCamera() {
  updateTV();
  updateLamp();
  occupants = counting; counting = 0;
  if (inside && current === LAYOUTS.office && performance.now() - occupiedAt < 1000) {
    officeAmbience({ printer: current.printer, desks: current.desks, centre: room.localToWorld(new THREE.Vector3(0, 1, 0)), people: occupants });
  }
  const goal = inside ? viewFov() : BASE_FOV;
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
// A spot to stand in the room, in the world, from `rng`: clear of the furniture and the camera's corner.
export function roomSpot(rng) {
  let x = 0, z = 0;
  for (let tries = 0; tries < 40; tries++) {
    x = -ROOM_W/2 + ROOM_MARGIN + rng()*(ROOM_W - ROOM_MARGIN*2);
    z = -ROOM_D/2 + ROOM_MARGIN + rng()*(ROOM_D - ROOM_MARGIN*2);
    if (clearOfFurniture(x, z) && clearOfCamera(x, z)) break;
  }
  return room.localToWorld(new THREE.Vector3(x, 0, z));
}

/** Where anyone can sit in the room, in the world: { x, y, z } on the seat, { nx, nz } the way it faces, and who's `by` it. */
export const roomSeats = () => current.seats;

// Walking about the room: a grid over its floor, CELL square, of where there's room to walk — BODY clear of the walls and
// the furniture — built for the room as it's laid out the first time anyone needs it. Near where they start and where
// they're going, though, anywhere in the room will do: someone getting up off the sofa, or going to sit on it, is well
// within BODY of it and the coffee table in front.
const CELL = 0.1, GRID_X = Math.round(ROOM_W/CELL), GRID_Z = Math.round(ROOM_D/CELL);
const BODY = 0.2, LEEWAY = 0.45;
function walkGrid() {
  if (grid) return grid;
  grid = new Uint8Array(GRID_X*GRID_Z);
  for (let k = 0; k < GRID_Z; k++) for (let i = 0; i < GRID_X; i++) {
    const x = -ROOM_W/2 + (i + 0.5)*CELL, z = -ROOM_D/2 + (k + 0.5)*CELL;
    grid[k*GRID_X + i] = Math.abs(x) < ROOM_W/2 - BODY && Math.abs(z) < ROOM_D/2 - BODY
      && current.solid.every(r => x < r.x0 - BODY || x > r.x1 + BODY || z < r.z0 - BODY || z > r.z1 + BODY) ? 1 : 0;
  }
  return grid;
}
/**
 * The way from `from` to `to` (both in the world) round the furniture: the points to walk to in turn, in the world, ending
 * at `to` — or null if there's no way there.
 */
export function roomRoute(from, to) {
  const open = walkGrid();
  const a = room.worldToLocal(new THREE.Vector3(from.x, from.y, from.z)), b = room.worldToLocal(new THREE.Vector3(to.x, to.y, to.z));
  const cellOf = (x, z) => {
    const i = Math.floor((x + ROOM_W/2)/CELL), k = Math.floor((z + ROOM_D/2)/CELL);
    return i < 0 || k < 0 || i >= GRID_X || k >= GRID_Z ? -1 : k*GRID_X + i;
  };
  const walkable = (x, z) => {
    const c = cellOf(x, z);
    return c >= 0 && (open[c] === 1 || Math.hypot(x - a.x, z - a.z) < LEEWAY || Math.hypot(x - b.x, z - b.z) < LEEWAY);
  };
  const start = cellOf(a.x, a.z), goal = cellOf(b.x, b.z);
  if (start < 0 || goal < 0) return null;
  // breadth first over the grid, diagonals only where neither corner's cut
  const came = new Int32Array(GRID_X*GRID_Z).fill(-1), queue = [start];
  came[start] = start;
  const centre = c => ({ x: -ROOM_W/2 + (c % GRID_X + 0.5)*CELL, z: -ROOM_D/2 + (Math.floor(c/GRID_X) + 0.5)*CELL });
  const free = (i, k) => i >= 0 && k >= 0 && i < GRID_X && k < GRID_Z && walkable(-ROOM_W/2 + (i + 0.5)*CELL, -ROOM_D/2 + (k + 0.5)*CELL);
  for (let q = 0; q < queue.length && came[goal] < 0; q++) {
    const c = queue[q], i = c % GRID_X, k = Math.floor(c/GRID_X);
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      const n = (k + dk)*GRID_X + i + di;
      if ((!di && !dk) || !free(i + di, k + dk) || came[n] >= 0) continue;
      if (di && dk && (!free(i + di, k) || !free(i, k + dk))) continue;
      came[n] = c;
      queue.push(n);
    }
  }
  if (came[goal] < 0) return null;
  const cells = [];
  for (let c = goal; c !== start; c = came[c]) cells.push(centre(c));
  const points = [{ x: a.x, z: a.z }, ...cells.reverse().slice(0, -1), { x: b.x, z: b.z }];
  // then straightened: on from each point to the furthest one it can see
  const sees = (p, q) => {
    const steps = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z)/(CELL/2));
    for (let k = 1; k < steps; k++) if (!walkable(p.x + (q.x - p.x)*k/steps, p.z + (q.z - p.z)*k/steps)) return false;
    return true;
  };
  const route = [];
  for (let i = 0; i < points.length - 1;) {
    let j = points.length - 1;
    while (j > i + 1 && !sees(points[i], points[j])) j--;
    route.push(room.localToWorld(new THREE.Vector3(points[j].x, 0, points[j].z)));
    i = j;
  }
  return route;
}
