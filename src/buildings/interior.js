import * as THREE from 'three';
import { camera, scene, renderer } from '../core/scene.js';
import { S, App } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { footprintBounds } from './footprints.js';
import { hashNameToNumber, mulberry32 } from '../core/math.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { setCutout } from '../ui/pixelation.js';
import { isMuted, playSound, setIndoors } from '../audio/sfx.js';
import { officeAmbience, resetOfficeAmbience } from '../audio/office.js';

// ============================================================ going inside a building
// Every building has the same inside: one room (furnished one of a few ways), built once and moved to whichever building's
// being looked into. It goes where the building actually stands, on its top floor, turned square to its longest wall, and
// the building itself isn't drawn while you're in there — so the windows look out on the real city around it, traffic,
// weather, time of day and all, with nothing to fake. The view's from up by the ceiling, looking at the middle of the
// room, and dragging takes it round the walls, keeping to them, and up and down them — starting from the corner that looks across at the two
// far walls and their windows (the other two are blank, and thick, for the sun's shadows: see below).
// The room's a fixed size whatever the building's shape: nobody inside can tell how far its walls are from the facade.
const ROOM_W = 8, ROOM_D = 6, ROOM_H = 3.2;  // along the room's own x and z, and floor to ceiling
// The sun's shadow is coarse (its bias lets light through anything within ~0.4 of what's casting it: see scene.js), so the
// walls and ceiling cast from their outer faces rather than three.js's usual inner ones (shadowSide, below), and they're
// far thicker than a real building's, with the slabs reaching out past the walls behind the camera — anything less lets
// daylight bleed in along the seams where they meet. Nobody inside sees their outsides, so the ceiling and the two walls behind the camera
// are thicker still; the far walls stay thin enough for the windows.
const WALL = 0.5, SLAB = 0.6, THICK = 1.6, OVERHANG = 1.5;
const FLOOR_HEIGHT = 3.5;                    // a storey, as the facades' windows are drawn (see windows.js)
// the ground floor's a step up off the ground: a house stands at the lawn's own height, and the lawn's depth bias (see
// LAWN_BIAS in suburbs.js) would paint grass over a floor laid level with it
const PLINTH = 0.3;
const SILL = 0.9, HEAD = 2.5;                // a window's bottom and top, above the floor
const CAMERA_INSET = 0.7;                    // the camera, in from the walls
const CAMERA_CLEAR = 1.8;                    // the corner it starts in, kept clear of furniture
// and its view: its height above the floor to start with, the height of the middle of the room it looks at, and its
// vertical field of view (tuned with tools/interior.html)
const CAMERA_HEIGHT = 2.6, CAMERA_LOOK = 1.1, CAMERA_FOV = 85.3;
// how low and high dragging takes it (the ceiling's at ROOM_H), how far for each pixel dragged, and how quickly it gets there
const CAMERA_LOWEST = 0.5, CAMERA_HIGHEST = 3.0, CAMERA_RISE = 0.008, RISE_EASE = 0.15;
// and how narrow and wide zooming takes its field of view (vertical degrees)
const FOV_NARROWEST = 30, FOV_WIDEST = 100;

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
// glow a little in their own colour — the same by day or night, which after dark reads as the lights being on. Nor do
// the street's lamps reach in through its walls (see streetlights.js).
const ROOM_GLOW = 0.3;
function roomLit(material) {
  material.emissive.copy(material.color);
  material.emissiveIntensity = ROOM_GLOW;
  material.defines = { ...material.defines, NO_LAMPLIGHT: '' };
  return material;
}
// Whoever's in the room is lit by the same glow — people, their hair and clothes (and any bee that's got in): every
// toon-shaded material, chunk-patched as streetlights.js does it, gets ambient light enough to match ROOM_GLOW (an
// emissive k reads as irradiance kπ on a Lambert surface) wherever it's inside the room's box. Out of it, or with no
// room up, nothing — or at night they're left in the dimmed sky's light alone, far darker than the room around them.
class SharedMatrix4 extends THREE.Matrix4 { clone() { return this; } }
class SharedVector3 extends THREE.Vector3 { clone() { return this; } }
const roomGlowUniforms = { roomGlow: { value: new SharedVector3() }, roomFromWorld: { value: new SharedMatrix4() } };
Object.assign(THREE.ShaderLib.toon.uniforms, roomGlowUniforms);
THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#ifdef TOON
uniform vec3 roomGlow;
uniform mat4 roomFromWorld;
#endif
`;
THREE.ShaderChunk.lights_fragment_maps += /* glsl */`
#if defined( RE_IndirectDiffuse ) && defined( TOON )
if ( roomGlow.r > 0.0 ) {
  vec3 inRoom = ( roomFromWorld * vec4( ( -vViewPosition ) * mat3( viewMatrix ) + cameraPosition, 1.0 ) ).xyz;
  if ( all( lessThan( abs( inRoom.xz ), vec2( ${(ROOM_W/2 + 0.5).toFixed(2)}, ${(ROOM_D/2 + 0.5).toFixed(2)} ) ) )
       && inRoom.y > -0.5 && inRoom.y < ${(ROOM_H + 0.5).toFixed(2)} ) irradiance += roomGlow;
}
#endif
`;
// (set as the room goes up and comes down: see enterBuilding and leaveBuilding)
function setRoomGlow(on) {
  roomGlowUniforms.roomGlow.value.setScalar(on ? ROOM_GLOW*Math.PI : 0);
  if (on) roomGlowUniforms.roomFromWorld.value.copy(room.matrixWorld).invert();
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
// a number from 0 up to 1 for a building's key, the same every time (and unlike its number, which picks home or office),
// and different for each `salt`
function keyFraction(key, salt = ':walls') {
  let h = 2166136261;
  for (const ch of String(key) + salt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0)/2**32;
}
wall(ROOM_W + THICK*2, 0, 0, -ROOM_D/2 - THICK/2, 0, THICK);  // behind the camera
// The other, along z, has the room's door in it, by the corner the camera starts in: a doorway some way into the wall,
// black at the back — where anyone coming in comes from, and anyone going goes — with a door hung in it that swings in
// to let them through (see openRoomDoor).
const DOOR_W = 0.9, DOOR_H = 2.1, DOOR_Z = -ROOM_D/2 + 1, RECESS = 0.5;   // the doorway: where along the wall, how deep
const doorFrom = DOOR_Z - DOOR_W/2, doorTo = DOOR_Z + DOOR_W/2;
box(THICK - RECESS, ROOM_H, ROOM_D, wallMaterial, -ROOM_W/2 - RECESS - (THICK - RECESS)/2, ROOM_H/2, 0);
box(RECESS, ROOM_H, doorFrom + ROOM_D/2, wallMaterial, -ROOM_W/2 - RECESS/2, ROOM_H/2, (doorFrom - ROOM_D/2)/2);
box(RECESS, ROOM_H, ROOM_D/2 - doorTo, wallMaterial, -ROOM_W/2 - RECESS/2, ROOM_H/2, (doorTo + ROOM_D/2)/2);
box(RECESS, ROOM_H - DOOR_H, DOOR_W, wallMaterial, -ROOM_W/2 - RECESS/2, (DOOR_H + ROOM_H)/2, DOOR_Z);
box(0.02, DOOR_H, DOOR_W, new THREE.MeshBasicMaterial({ color: 0x000000 }), -ROOM_W/2 - RECESS + 0.02, DOOR_H/2, DOOR_Z);
// the door, on its hinge at the corner end of the doorway, and a knob on it
const DOOR_OPEN = THREE.MathUtils.degToRad(95), DOOR_HOLD = 1500, DOOR_EASE = 0.12; // how far, for how long (ms), how quickly
const doorMaterial = roomLit(new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
const door = new THREE.Group();
door.position.set(-ROOM_W/2 - 0.03, 0, doorFrom);
room.add(door);
box(0.05, DOOR_H - 0.01, DOOR_W - 0.01, doorMaterial, 0, DOOR_H/2, DOOR_W/2, door);
box(0.12, 0.05, 0.05, frameMaterial, 0, 1, DOOR_W - 0.1, door);
let doorOpenUntil = -Infinity;
/** Swing the room's door open (or keep it open) for someone coming or going through it: it shuts on its own after. */
export const openRoomDoor = () => { doorOpenUntil = performance.now() + DOOR_HOLD; };
// each frame: the door eased open or shut, heard as it shuts
function updateDoor() {
  const goal = performance.now() < doorOpenUntil ? DOOR_OPEN : 0, was = door.rotation.y;
  if (was === goal) return;
  door.rotation.y = Math.abs(goal - was) < 0.01 ? goal : was + (goal - was)*DOOR_EASE;
  if (door.rotation.y === 0) playSound('door', room.localToWorld(new THREE.Vector3(-ROOM_W/2, 1, DOOR_Z)));
}
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
LAYOUTS.office.furnished = officeGroup;
// a warehouse and a factory: steel beams across the ceiling (high enough for the camera to pass under), a concrete floor,
// and fitted out afresh for each building from the industrial model (see "a warehouse or a factory", below)
const beamMaterial = lit(0x5a5e62, 0.5);
for (const name of ['warehouse', 'factory']) {
  layout(name, 0x9a9a96, add => {
    for (const x of [-2, 0, 2]) {
      add(0.03, 0.15, ROOM_D, beamMaterial, x, ROOM_H - 0.075, 0);
      add(0.2, 0.02, ROOM_D, beamMaterial, x, ROOM_H - 0.14, 0);
    }
    return [];
  });
  const furnished = new THREE.Group();
  LAYOUTS[name].group.add(furnished);
  Object.assign(LAYOUTS[name], { furnished, industrial: true, kind: name });
}
let current = LAYOUTS.home;
// where there's room to walk in it, as laid out (see walkGrid)
let grid = null;
function useLayout(name) {
  current.group.visible = false;
  grid = null;
  current = LAYOUTS[name] ?? LAYOUTS.home;
  current.group.visible = true;
  trim.visible = false; // (till a posh home's furnished)
  dado.visible = !!current.industrial;
  paintRoom();
}
function paintRoom() {
  floorMaterial.color.copy(current.floor);
  wallMaterial.color.copy(current.wall);
  roomLit(floorMaterial); roomLit(wallMaterial);
  // (and a posh home's parquet or marble)
  const map = current.floorMap ?? null;
  if (floorMaterial.map !== map) {
    floorMaterial.map = floorMaterial.emissiveMap = map;
    floorMaterial.needsUpdate = true;
  }
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
const DINER_PLATE_IN = 0.22; // how far in from a dining table's edge a diner's plate sits, in metres
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
    console.warn('Splinetopia: the interior model failed to load; homes are left bare', err);
    return;
  }
  measureParts(pieces);
  if (!['TV', 'Sofa', 'Coffee_Table'].every(name => pieces[name])) {
    console.warn('Splinetopia: the interior model is missing its TV, sofa or coffee table; homes are left bare');
    return;
  }
  furniture = pieces;
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
// Where anyone can sit on a furniture model's seats, and where its TV's screen (where the video goes: see "the TV",
// below) and its lamps' bulbs are, in their pieces' own terms.
function measureParts(pieces) {
  for (const name of ['Sofa', 'Chair', 'Chair2', 'Chair3', 'Armchair', 'PianoBench', 'Beanbag', 'LoungeChair', 'PeacockChair', 'Pouf']) if (pieces[name]) pieces[name].seats = measureSeats(pieces[name]);
  const part = (piece, material) => {
    const box = new THREE.Box3();
    piece?.object.traverse(o => { if (o.isMesh && o.material.name === material) box.expandByObject(o); });
    return box.isEmpty() ? null : box;
  };
  const screen = part(pieces.TV, 'Screen'), bulb = part(pieces.Lamp, 'Light');
  if (screen) pieces.TV.screen = { centre: screen.getCenter(new THREE.Vector3()).setZ(screen.max.z + 0.004),
    w: screen.max.x - screen.min.x, h: screen.max.y - screen.min.y };
  if (bulb) pieces.Lamp.bulb = bulb.getCenter(new THREE.Vector3());
  const hanging = part(pieces.Pendant, 'Light');
  if (hanging) pieces.Pendant.bulb = hanging.getCenter(new THREE.Vector3());
}
// lit like the rest of the room (see roomLit), but for the lamp's bulb, which glows anyway, the glass, and the TV's screen
function furnitureLit(material) {
  if (material.name === 'Screen') {
    material.color.setHex(SCREEN_COLOR);
    material.emissive.setHex(SCREEN_GLOW);
    material.emissiveIntensity = 1;
  } else if (material.name !== 'Light' && material.name !== 'Fire' && !material.transparent) {
    roomLit(material);
  }
}
// Where on a sofa or chair (facing +z) anyone can sit: feeling down onto it from above, front to back along its middle,
// the seat's the first thing there and its back where it rises well above that; they sit a little in front of the back,
// as far apart along it as there's room for (up to three on a sofa).
/**
 * How high a piece's surface is at a place on it, from above: a table's top, say.
 * @param {object} piece - the piece (see `furniture`)
 * @param {number} turn - how far it's turned, as `put` turns it
 * @param {number} x - the place, across the room from the piece's middle
 * @param {number} z - and along it
 * @returns {number} the height there, or the piece's whole height if nothing's under that place
 */
function surfaceAt(piece, turn, x, z) {
  const c = Math.cos(turn), s = Math.sin(turn);
  surfaceRay.set(new THREE.Vector3(x*c - z*s, piece.h + 1, x*s + z*c), new THREE.Vector3(0, -1, 0));
  return surfaceRay.intersectObject(piece.object, true)[0]?.point.y ?? piece.h;
}
const surfaceRay = new THREE.Raycaster();
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

// ---------------------------------------------------------- a posh home
// Now and then a home's posh (from its building's key): furnished from a set of its own (assets/models/Posh.glb, built by
// tools/posh-models.py) with the same pieces as the interior model — a chesterfield for the sofa, a sideboard under the
// TV, a Persian rug, a library bookcase, a chandelier, a commode — laid out the same way, and then an armchair or two by
// the coffee table, a fireplace, a grand piano with its bench, and paintings on the walls behind the camera. Its room's
// dressed up to match: panelled below a dado rail, skirting and a crown moulding, curtains at the windows, and a parquet
// or marble floor. Until its model's loaded, posh homes are furnished as any other.
const POSH_MODEL_URL = 'assets/models/Posh.glb';
const POSH_SHARE = 0.25;
let posh = null;
const POSH_WALLS = [0x2e4a3a, 0x283a58, 0x6a2a2a, 0x9aa88e, 0xe0c0b4, 0xece2c8, 0x5a646a, 0xc8a050];
const POSH_TRIM = [0xf2eee4, 0xe8e0cc, 0xf4f2ee, 0x4a3020, 0xd8d2c4];
const DRAPES = [0x7a1e24, 0x2a4a34, 0xc8a050, 0x283458, 0xe6dcc6, 0x5a2a4a, 0x8a9a8a];
// the parquet's tinted by the floor's colour (its planks are shades of grey); the marble's black and white
const POSH_FLOORS = [0xc89a6a, 0xa87a50, 0xd8b488, 0x8a6040, 0xb88c5c];
const POSH_PAINTED = {
  Leather: [0x5a1a1a, 0x1e3a2a, 0x8a4a22, 0x1e2a44, 0x1a1a1a, 0xa87a4a],
  Velvet: [0x1f6a4a, 0x22386a, 0xc89a2a, 0xc88a8a, 0x5a2a5a, 0x1e5a5e],
  Walnut: [0x4a2c1a, 0x3a2012, 0x5e3a22, 0x2a1a12, 0x161416],
  Gilt: [0xd4a84a, 0xc09040, 0xc8c8cc, 0xa8743a],
  Marble: [0xece8e2, 0x2a2a2c, 0x3e6a52, 0xe8dcc4, 0xd8b4ac],
  Lacquer: [0x141416, 0x141416, 0x141416, 0xf0eee8, 0x3a2416],
  LampShade: [0xece2cc, 0x1a1a1a, 0x7a1e24, 0x2a4a34, 0xd8c090],
  Urn: [0x7aa89a, 0xece8e2, 0x283a58, 0xc8a050, 0x8a3a2a],
  RugField: [0x8a2a2a, 0x243a5a, 0x6a3a2a, 0x2e4a3a, 0xc8a878],
  RugBorder: [0x243a5a, 0x8a2a2a, 0x1a1a22, 0xc8a050],
  RugMotif: [0xd8c090, 0xece2cc, 0xc88a5a, 0x8aa0b8],
  PaintSky: [0x9ab8c8, 0xe0b8a0, 0xd8c890, 0xa8b0b4],
  PaintLand: [0x6a8a4a, 0xa89a4a, 0x5a7a5a, 0x8a7a4a],
  PaintHill: [0x4a6a5a, 0x3a5a3a, 0x5a5a6a, 0x6a5a3a],
  PaintDark: [0x2a2420, 0x1a2a22, 0x1e1e2a],
  PaintFigure: [0x3a2a3a, 0x1a1a1a, 0x5a1a1a, 0x1e2a44],
};
const poshPainted = [];
// the set a home's to be furnished from whatever its key says, for tools/interior.html: 'posh', 'student', 'retro', 'boho',
// 'plain', or null
let forcedSet = null;
// which set a home's furnished from: a quarter posh, a fifth student flats (see "a student flat", below), some
// mid-century ("a mid-century home") and some bohemian ("a bohemian home"), the rest plain
function homeSet(key) {
  if (forcedSet) return forcedSet;
  const f = keyFraction(key, ':set');
  return f < POSH_SHARE ? 'posh' : f < POSH_SHARE + STUDENT_SHARE ? 'student'
    : f < POSH_SHARE + STUDENT_SHARE + RETRO_SHARE ? 'retro'
    : f < POSH_SHARE + STUDENT_SHARE + RETRO_SHARE + BOHO_SHARE ? 'boho' : 'plain';
}
/** Furnish every home from one set ('posh', 'student', 'retro', 'boho' or 'plain') whatever its key says, or (null) as its key says: for tools/interior.html. */
export function forceHomeSet(set) {
  forcedSet = set;
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
async function loadPosh() {
  try {
    posh = await loadPieces(POSH_MODEL_URL, POSH_PAINTED, poshPainted);
  } catch (err) {
    console.warn('Splinetopia: the posh interior model failed to load; posh homes are furnished as any other', err);
    return;
  }
  measureParts(posh);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
loadPosh();

// The posh room's woodwork, built once and shown for posh homes: skirting, raised panels up to a dado rail, and a stepped
// crown moulding, round all four walls (but for the doorway, which gets a casing), each a strip `depth` out from the wall.
const trim = new THREE.Group();
trim.visible = false;
room.add(trim);
const trimMaterial = lit(POSH_TRIM[0], 0.6), drapeMaterial = lit(DRAPES[0], 1);
// the walls' inner faces: along x or z, where, and which way the room is from them
const WALL_FACES = [{ alongX: true, at: ROOM_D/2, n: -1 }, { alongX: false, at: ROOM_W/2, n: -1 },
  { alongX: true, at: -ROOM_D/2, n: 1 }, { alongX: false, at: -ROOM_W/2, n: 1 }];
function strip(face, a, b, y, h, depth, material = trimMaterial) {
  const out = face.at + face.n*depth/2, mid = (a + b)/2;
  const mesh = face.alongX ? box(b - a, h, depth, material, mid, y, out, trim) : box(depth, h, b - a, material, out, y, mid, trim);
  mesh.castShadow = false;
  return mesh;
}
for (const face of WALL_FACES) {
  const half = face.alongX ? ROOM_W/2 : ROOM_D/2;
  const runs = face.alongX || face.n < 0 ? [[-half, half]] : [[-half, doorFrom - 0.08], [doorTo + 0.08, half]];
  for (const [a, b] of runs) {
    strip(face, a, b, 0.08, 0.16, 0.025);                     // skirting
    strip(face, a, b, 0.165, 0.02, 0.035);
    strip(face, a, b, 0.85, 0.05, 0.035);                     // the dado rail
    const panels = Math.max(1, Math.round((b - a)/0.75)), each = (b - a)/panels;
    for (let i = 0; i < panels; i++) strip(face, a + i*each + 0.1, a + (i + 1)*each - 0.1, 0.5, 0.5, 0.015);
  }
  strip(face, -half, half, ROOM_H - 0.06, 0.12, 0.03);       // the crown moulding, stepping out to the ceiling
  strip(face, -half, half, ROOM_H - 0.025, 0.05, 0.07);
  strip(face, -half, half, ROOM_H - 0.13, 0.02, 0.045);
}
{ // the doorway's casing
  const face = WALL_FACES[3];
  strip(face, doorFrom - 0.08, doorFrom, (DOOR_H + 0.08)/2, DOOR_H + 0.08, 0.03);
  strip(face, doorTo, doorTo + 0.08, (DOOR_H + 0.08)/2, DOOR_H + 0.08, 0.03);
  strip(face, doorFrom - 0.08, doorTo + 0.08, DOOR_H + 0.04, 0.08, 0.035);
}
// Curtains either side of each of the far walls' windows, hung from a pole over it and tied back to the wall either side,
// so each is gathered in at the tie and spreads out above and below it (which reads as curtains from its outline alone,
// with the room lit as flatly as it is): each a group, with the rectangle it stands on (shown in each posh home unless
// the TV's in front of it: see furnish).
const drapes = [];
{
  const poleMaterial = lit(0xc09040, 0.4);
  const pleat = new THREE.CylinderGeometry(0.035, 0.035, 1, 8), pole = new THREE.CylinderGeometry(0.018, 0.018, 1, 8);
  const finial = new THREE.SphereGeometry(0.04, 10, 8);
  const UP = new THREE.Vector3(0, 1, 0), POLE = HEAD + 0.2, TIE = 1.0, PLEATS = 6;
  // (the room's x, y and z for u along the wall, y up and v out from it)
  const place = (face, u, y, v) => face.alongX ? new THREE.Vector3(u, y, face.at + face.n*v) : new THREE.Vector3(face.at + face.n*v, y, u);
  const rod = (geometry, material, a, b, parent) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.y = a.distanceTo(b);
    mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
  };
  for (const [length, windows, face] of [[...FAR_X, WALL_FACES[0]], [...FAR_Z, WALL_FACES[1]]]) {
    const { width, gap, centres } = piers(length, windows);
    for (let i = 0; i < windows; i++) {
      // (along the wall as the room has it: the wall along z is turned, so its own x runs down the room's z)
      const mid = (centres[i] + width/2 + gap/2)*(face.alongX ? 1 : -1);
      for (const side of [-1, 1]) {
        // (u from the window's edge, e, in towards its middle: its span at the top, at the tie and at the floor)
        const group = new THREE.Group(), edge = mid + side*gap/2, e = t => edge - side*t;
        for (let k = 0; k < PLEATS; k++) {
          const f = k/(PLEATS - 1), wave = 0.06 + (k % 2)*0.035;
          const top = place(face, e(-0.02 + f*0.42), POLE - 0.02, wave), tie = place(face, e(0.02 + f*0.1), TIE, 0.09);
          const foot = place(face, e(-0.01 + f*0.3), 0, wave);
          rod(pleat, drapeMaterial, top, tie, group);
          rod(pleat, drapeMaterial, tie, foot, group);
        }
        rod(pleat, poleMaterial, place(face, e(-0.02), TIE, 0.1), place(face, e(0.14), TIE, 0.1), group);   // the tie
        // (what's kept clear for it stops a little short of the pier, so a bookcase or fireplace still fits between)
        const [a, b] = [Math.min(e(0.06), e(0.32)), Math.max(e(0.06), e(0.32))], d = [face.at, face.at + face.n*0.15];
        group.userData.area = face.alongX ? { x0: a, x1: b, z0: Math.min(...d), z1: Math.max(...d) }
          : { x0: Math.min(...d), x1: Math.max(...d), z0: a, z1: b };
        trim.add(group);
        drapes.push(group);
      }
      // the pole, with a finial at either end
      const ends = [-1, 1].map(s => place(face, mid + s*(gap/2 + 0.12), POLE, 0.1));
      rod(pole, poleMaterial, ...ends, trim);
      for (const end of ends) { const ball = new THREE.Mesh(finial, poleMaterial); ball.position.copy(end); trim.add(ball); }
    }
  }
}

// The posh floors, as textures (plank-grey parquet for the floor's colour to tint, or a marble chequer), laid across the
// floor's slab (see the box at the top) at their real size: the slab is 12 by 10 metres.
const SLAB_W = ROOM_W + (WALL + OVERHANG)*2, SLAB_D = ROOM_D + (WALL + OVERHANG)*2;
function floorTexture(size, metres, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), mulberry32(7));
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(SLAB_W/metres, SLAB_D/metres);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
// Herringbone: planks L widths long, alternately along and across, in a staircase — which repeats every (1, 1) plank
// widths and (L, -L), so every 2L both ways.
const PLANK = 4;
const parquet = floorTexture(512, 0.09*PLANK*2, (g, rng) => {
  const w = 512/(PLANK*2), plank = (x, y, pw, ph) => {
    const shade = 205 + rng()*50;
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.fillRect(x*w, y*w, pw*w, ph*w);
    g.strokeStyle = 'rgba(60,40,25,0.35)';
    g.lineWidth = 2;
    g.strokeRect(x*w + 1, y*w + 1, pw*w - 2, ph*w - 2);
  };
  for (let a = -PLANK*3; a <= PLANK*3; a++) for (let b = -3; b <= 3; b++) {
    const x = a + PLANK*b, y = a - PLANK*b;
    plank(x, y, PLANK, 1);
    plank(x, y + 1, 1, PLANK);
  }
});
const chequer = floorTexture(512, 0.8, (g, rng) => {
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const white = (i + j) % 2 === 0;
    g.fillStyle = white ? '#eeece6' : '#1c1c1e';
    g.fillRect(i*256, j*256, 256, 256);
    // (a few veins through each)
    g.strokeStyle = white ? 'rgba(120,120,125,0.18)' : 'rgba(200,200,205,0.1)';
    for (let k = 0; k < 4; k++) {
      g.lineWidth = 0.5 + rng()*1.5;
      g.beginPath();
      let x = i*256 + rng()*256, y = j*256;
      g.moveTo(x, y);
      while (y < (j + 1)*256) { x += (rng() - 0.5)*24; y += 14 + rng()*24; g.lineTo(x, y); }
      g.stroke();
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.5)';
  for (let k = 0; k <= 2; k++) { g.fillRect(k*256 - 1, 0, 2, 512); g.fillRect(0, k*256 - 1, 512, 2); }
});

// ---------------------------------------------------------- a student flat
// Now and then a home's a student flat (from its building's key, as a posh home is): furnished from a set of its own
// (assets/models/Student.glb, built by tools/student-models.py) with the same pieces as the interior model — a futon for
// the sofa, a TV on milk crates with a games console, a pallet for the coffee table with a pizza box and cans on it, a
// folding table, crates for a bookcase, a paper lantern, a bare bulb — laid out the same way, and then chairs that don't
// match round the table, a beanbag by the coffee table, a clothes horse full of washing, posters stuck up on the walls,
// and fairy lights strung along the top of one of the far walls. Its floor's bare boards. Until its model's loaded,
// student flats are furnished as any other home.
const STUDENT_MODEL_URL = 'assets/models/Student.glb';
const STUDENT_SHARE = 0.2;
let student = null;
const STUDENT_WALLS = [0xece2c4, 0xf0ead8, 0xe6e2d8, 0xd8d4c8, 0xe8dcc0, 0xdcd8cc];
// the boards are tinted by the floor's colour (they're shades of grey)
const STUDENT_FLOORS = [0xe0b078, 0xd09a60, 0xecc890, 0xc08858, 0xb07a48];
const STUDENT_PAINTED = {
  Futon: [0x2a3a5a, 0x3a3a3c, 0xc8962e, 0x6a2a2e, 0x5a6a3a, 0x2f6a6a, 0x8a8c8e],
  Pine: [0xd8b47a, 0xe8cc98, 0xc8a068, 0x3a3430],
  Crate: [0xc83a2a, 0x2a5ab0, 0xe0b020, 0x3a8a4a, 0x2a2a2c, 0x8a9098],
  Crate2: [0x2a5ab0, 0xc83a2a, 0x3a8a4a, 0xe0b020, 0x8a9098],
  Beanbag: [0xd86a2a, 0x6a3a8a, 0x2a2a2c, 0xc82a3a, 0x2a8a8a, 0x8ab02a, 0x3a4a8a],
  Formica: [0xe8e4da, 0xd8d0c0, 0xf2f0ea, 0xa8b0b0],
  Painted: [0x5a8a7a, 0xd8c040, 0xc85a4a, 0x4a6a9a, 0xece8e0, 0x2a2a2c],
  Plastic: [0xf2f0ea, 0x2a6a4a, 0x3a3a3c, 0xd8d4c8],
  Bucket: [0xe8e4d8, 0x3a8ac8, 0xd84a3a, 0xe0b020],
  RugA: [0x2a6a7a, 0xc83a2a, 0x3a3a4a, 0xd8a030, 0x6a3a6a],
  RugB: [0xe8d8b0, 0xf0ece0, 0x8a8a8a, 0x2a2a2c],
  Poster0: [0x1a1a22, 0xf0ece0, 0x2a2a4a],
  Poster1: [0xe84a3a, 0xe87aa8, 0x3ab08a, 0xf08a2a],
  Poster2: [0xf0d040, 0xf0f0e8, 0x8ad0e8],
  Poster3: [0x3a8ac8, 0x2a4a6a, 0x5a3a8a],
};
const studentPainted = [];
async function loadStudent() {
  try {
    student = await loadPieces(STUDENT_MODEL_URL, STUDENT_PAINTED, studentPainted);
  } catch (err) {
    console.warn('Splinetopia: the student interior model failed to load; student flats are furnished as any other home', err);
    return;
  }
  measureParts(student);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
loadStudent();
// Bare floorboards: planks 2.4 m long and 15 cm wide, in rows, their ends staggered and nailed down — which repeats
// every 2.4 m both ways.
const boards = floorTexture(1024, 2.4, (g, rng) => {
  const ROWS = 16, row = 1024/ROWS;
  for (let r = 0; r < ROWS; r++) {
    const end = Math.floor(rng()*16)*64;
    for (const x of [end - 1024, end]) {
      const shade = 212 + rng()*38;
      g.fillStyle = `rgb(${shade},${shade},${shade})`;
      g.fillRect(x, r*row, 1024, row);
      g.strokeStyle = 'rgba(70,50,30,0.06)';                                 // (a little grain along it)
      g.lineWidth = 2;
      for (let j = 0; j < 3; j++) {
        const y = r*row + 10 + rng()*(row - 20), w = (rng() - 0.5)*10;
        g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + 340, y + w, x + 680, y - w, x + 1024, y); g.stroke();
      }
      g.fillStyle = 'rgba(40,30,20,0.3)';                                     // nails, at its ends
      for (const nx of [x + 8, x + 1016]) for (const ny of [r*row + row*0.3, r*row + row*0.7]) g.fillRect(nx - 2, ny - 2, 4, 4);
      g.fillStyle = 'rgba(40,25,15,0.4)';
      g.fillRect(x - 1, r*row, 3, row);
    }
    g.fillStyle = 'rgba(40,25,15,0.35)';
    g.fillRect(0, r*row - 1, 1024, 2);
  }
});

// ---------------------------------------------------------- a mid-century home
// Now and then a home's mid-century (from its building's key, as a posh home is): furnished from a set of its own
// (assets/models/MidCentury.glb, built by tools/midcentury-models.py) with the same pieces as the interior model — a long
// low sofa on tapered legs, the TV on a teak credenza, a tulip table with shell chairs, a tripod lamp, a surfboard coffee
// table, a geometric rug, teak shelving, a sputnik light, a highboy — laid out the same way, and then a lounge chair and
// its ottoman by the coffee table, a radiogram along a far wall, and a sunburst clock or an abstract print on the walls
// behind the camera. Its floor's teak parquet or terrazzo. Until its model's loaded, mid-century homes are furnished as
// any other.
const RETRO_MODEL_URL = 'assets/models/MidCentury.glb';
const RETRO_SHARE = 0.15;
let retro = null;
const RETRO_WALLS = [0xf0e8d6, 0xece4cc, 0xb8c4a0, 0x9aa878, 0x8ab0a8, 0xe8d49a, 0xd8cfc0, 0xf2efe8];
// the parquet's tinted by the floor's colour; the terrazzo's its own colours
const RETRO_FLOORS = [0xb87a48, 0xa06a3a, 0xc8905a, 0x8a5a30];
const RETRO_PAINTED = {
  Teak: [0x9a5a2e, 0x8a4e26, 0xa8683a, 0x6a3a1e, 0xb07848],
  Tweed: [0x6a7a5a, 0xc89030, 0x2a6a6a, 0xc8602a, 0x5a5a5c, 0xd8ccb0, 0x3a4a6a],
  Accent: [0xd8a030, 0xc8602a, 0x2a7a7a, 0x3a5a8a, 0xa82a2a, 0x6a8a3a],
  Shell: [0xe8a040, 0xf0ece0, 0xd86a3a, 0x3a8a8a, 0x2a2a2c, 0xc8c090],
  Leather: [0x2a1a14, 0x4a2a1a, 0x1a1a1c, 0x7a4a2a],
  Brass: [0xc8a050, 0xb89040],
  Ceramic: [0x2a7a7a, 0xd8702a, 0xe0b030, 0x3a5a8a, 0x6a8a3a, 0xa82a2a],
  Tulip: [0xf2f0ea, 0xf2f0ea, 0x1a1a1c],
  LampShade: [0xf0e6d0, 0xe0b030, 0xd8702a, 0xf2f0ea, 0x2a6a6a],
  RugField: [0xe8dcc0, 0xd8c8a0, 0x2a3a3a, 0xc89040],
  RugA: [0xd8702a, 0xe0b030, 0xa82a2a, 0x2a6a6a],
  RugB: [0x2a6a6a, 0x3a4a6a, 0x5a6a3a, 0x1a1a1c],
  Print0: [0xf0e8d6, 0xe8dcc0, 0x1a1a1c],
  Print1: [0xd8702a, 0xe0b030, 0xa82a2a],
  Print2: [0x2a5a7a, 0x2a7a7a, 0x3a4a3a],
  Print3: [0xe0b030, 0xd8702a, 0xece4cc],
};
const retroPainted = [];
async function loadRetro() {
  try {
    retro = await loadPieces(RETRO_MODEL_URL, RETRO_PAINTED, retroPainted);
  } catch (err) {
    console.warn('Splinetopia: the mid-century interior model failed to load; mid-century homes are furnished as any other', err);
    return;
  }
  measureParts(retro);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
loadRetro();
// Terrazzo: chips of marble in a pale ground, which repeats every 1.2 m both ways (as a pour between brass strips would).
const terrazzo = floorTexture(1024, 1.2, (g, rng) => {
  g.fillStyle = '#ece6da';
  g.fillRect(0, 0, 1024, 1024);
  const chips = ['#d8ccb4', '#c8baa0', '#e0d0b0', '#b0a894', '#d0a080', '#f6f2ea', '#a89078', '#8a8680'];
  for (let k = 0; k < 1600; k++) {
    const x = rng()*1024, y = rng()*1024, r = 2 + rng()*rng()*14, a = rng()*Math.PI;
    const corners = [0, 1, 2, 3, 4].map(j => [a + j*Math.PI*2/5, r*(0.6 + rng()*0.5)]);
    g.fillStyle = chips[Math.floor(rng()*chips.length)];
    // (and again a tile over, where it runs off an edge, so it repeats without a seam)
    for (const dx of [-1024, 0, 1024]) for (const dy of [-1024, 0, 1024]) {
      if (Math.abs(x + dx - 512) > 512 + r*1.1 || Math.abs(y + dy - 512) > 512 + r*1.1) continue;
      g.beginPath();
      for (const [t, rr] of corners) g.lineTo(x + dx + Math.cos(t)*rr, y + dy + Math.sin(t)*rr);
      g.fill();
    }
  }
  g.fillStyle = 'rgba(160,120,50,0.6)';                                        // (the brass strips)
  g.fillRect(0, 0, 1024, 3); g.fillRect(0, 0, 3, 1024);
});

// ---------------------------------------------------------- a bohemian home
// Now and then a home's bohemian (from its building's key, as a posh home is), and whoever lives there loves plants:
// furnished from a set of its own (assets/models/Boho.glb, built by tools/boho-models.py) with the same pieces as the
// interior model — a low linen sofa heaped with cushions, the TV on a plank bench, a trestle table with bentwood chairs,
// a rattan lamp, a kilim, a ladder of shelves, a woven dome of a light, a painted chest — laid out the same way, and then
// a peacock chair by the coffee table and a pouf, plants everywhere (on the floor, along the windowsills, and hung in
// front of the windows), and macramé and tapestries on the walls behind the camera. Until its model's loaded, bohemian
// homes are furnished as any other.
const BOHO_MODEL_URL = 'assets/models/Boho.glb';
const BOHO_SHARE = 0.12;
let boho = null;
const BOHO_WALLS = [0xe8c8a0, 0xd8a878, 0xc8b088, 0xa8b088, 0xe0b890, 0xf0dcc0, 0xc89878, 0xb8c8a8];
// the boards are tinted by the floor's colour (they're shades of grey)
const BOHO_FLOORS = [0xc88a50, 0xb87a48, 0xd8a060, 0xa06a3a];
const BOHO_PAINTED = {
  Linen: [0xd8ccb4, 0xe8e0d0, 0xb8a888, 0x8a8070, 0xc8a080, 0x6a7a5a],
  Cushion0: [0xc8602a, 0xb84a3a, 0xd89040, 0x8a3a4a],
  Cushion1: [0xd8a030, 0xe8c070, 0xc88a2a, 0xe8dcc0],
  Cushion2: [0x2a6a6a, 0x3a5a4a, 0x2a4a6a, 0x6a8a5a],
  Cushion3: [0x8a3a4a, 0xc86a6a, 0x6a3a5a, 0xd8a890],
  Throw: [0xe8dcc0, 0xc8602a, 0x8a3a4a, 0x3a5a4a, 0xd8a030],
  Wood: [0x8a6242, 0x6a4a30, 0xa87a50, 0x5a3a24],
  Painted: [0x3a7a7a, 0xc8602a, 0x6a8a5a, 0xe8dcc0, 0x3a4a6a, 0xd8a030],
  Pot: [0xc0643a, 0xe8e0d0, 0x3a3a3c, 0xd89a6a, 0x5a8a8a],
  Pouf: [0xd8b890, 0xe8e0d0, 0xc8602a, 0x6a7a5a, 0x8a5a4a],
  RugField: [0xb8482a, 0x8a3a3a, 0x2a3a5a, 0xc87a3a, 0xd8c8a8],
  RugA: [0x2a3a5a, 0xe8d8b0, 0x1a1a22, 0x6a2a2a],
  RugB: [0xe8d8b0, 0xf0e8d8, 0xd8a030],
  RugC: [0xd8a030, 0x2a6a6a, 0xc8602a, 0xe8d8b0],
  Tapestry0: [0xe8dcc0, 0xf0e8d6, 0xd8c8a8, 0x2a3a3a],
  Tapestry1: [0xc8602a, 0xd8a030, 0xb8482a, 0xe8b890],
  Tapestry2: [0x2a5a5a, 0x3a4a3a, 0x6a3a4a, 0x8a6a4a],
};
const bohoPainted = [];
async function loadBoho() {
  try {
    boho = await loadPieces(BOHO_MODEL_URL, BOHO_PAINTED, bohoPainted);
  } catch (err) {
    console.warn('Splinetopia: the bohemian interior model failed to load; bohemian homes are furnished as any other', err);
    return;
  }
  measureParts(boho);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
loadBoho();

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
  home.floorMap = null;
  // (colours from a generator of their own, so the furniture's where it always was)
  const set = homeSet(key), fancy = !!(furniture && posh && set === 'posh'), scruffy = !!(furniture && student && set === 'student');
  const sixties = !!(furniture && retro && set === 'retro'), leafy = !!(furniture && boho && set === 'boho');
  const tint = mulberry32(hashNameToNumber(key + (fancy ? ' posh colours' : scruffy ? ' student colours' : sixties ? ' retro colours'
    : leafy ? ' boho colours' : ' colours')));
  const pick = list => list[Math.floor(tint()*list.length)];
  home.wall.setHex(pick(fancy ? POSH_WALLS : scruffy ? STUDENT_WALLS : sixties ? RETRO_WALLS : leafy ? BOHO_WALLS : WALLS));
  trim.visible = fancy;
  if (fancy) {
    const marble = tint() < 0.3;
    home.floorMap = marble ? chequer : parquet;
    home.floor.setHex(marble ? 0xffffff : pick(POSH_FLOORS));
    trimMaterial.color.setHex(pick(POSH_TRIM)); roomLit(trimMaterial);
    drapeMaterial.color.setHex(pick(DRAPES)); roomLit(drapeMaterial);
  }
  if (scruffy) {
    home.floorMap = boards;
    home.floor.setHex(pick(STUDENT_FLOORS));
  }
  if (sixties) {
    const stone = tint() < 0.3;
    home.floorMap = stone ? terrazzo : parquet;
    home.floor.setHex(stone ? 0xffffff : pick(RETRO_FLOORS));
  }
  if (leafy) {
    home.floorMap = boards;
    home.floor.setHex(pick(BOHO_FLOORS));
  }
  paintRoom();
  for (const [materials, palettes] of fancy ? [[poshPainted, POSH_PAINTED]] : scruffy ? [[studentPainted, STUDENT_PAINTED]]
    : sixties ? [[retroPainted, RETRO_PAINTED]] : leafy ? [[bohoPainted, BOHO_PAINTED]] : [[painted, PAINTED]]) for (const material of materials) {
    material.color.setHex(pick(palettes[material.name]));
    roomLit(material);
  }
  if (!furniture) return;
  // (the posh, student, mid-century or bohemian set's in place of the interior model's pieces it has, and has some of its own)
  const F = fancy ? { ...furniture, ...posh } : scruffy ? { ...furniture, ...student } : sixties ? { ...furniture, ...retro }
    : leafy ? { ...furniture, ...boho } : furniture;

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
  const put = (name, x, z, angle, { scale = 1, tall = false, underfoot = false, diner = false } = {}) => {
    const piece = F[name], object = piece.object.clone();
    object.position.set(x, 0, z);
    object.rotation.y = angle;
    object.scale.setScalar(scale);
    object.userData.isTV = name === 'TV'; // (never faded: see fadeWhatsInTheWay)
    home.group.add(object);
    const r = footprint(piece, x, z, angle, scale);
    if (underfoot) return r;
    taken.push({ ...r, tall });
    home.solid.push(r);
    home.blocked.push(around(r.x0, r.x1, r.z0, r.z1, 0.35));
    const c = Math.cos(angle), s = Math.sin(angle);
    for (const seat of piece.seats) home.seats.push({ x: x + seat.x*c + seat.z*s, z: z - seat.x*s + seat.z*c, y: seat.y, nx: s, nz: c, sofa: name === 'Sofa', diner });
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
  const { TV: tv, Sofa: sofa, 'Coffee_Table': coffee } = F;
  // (towards the wall's far end, rather than the camera's, where it'd be seen side on and the sofa'd be under the camera)
  const tvRange = wallLength/2 - tv.w/2 - 0.8, tvU = tvRange*(rng()*1.3 - 0.3), tvV = tv.d/2 + 0.03;
  let spot = at(tvU, tvV);
  put('TV', spot.x, spot.z, fromWall);
  const screen = { ...spot }, tvObject = home.group.children.at(-1);
  // (a posh home's curtains, but for any the TV's in front of)
  const tvArea = taken[0];
  for (const drape of drapes) {
    const area = drape.userData.area;
    drape.visible = !overlaps(area, tvArea, 0.05);
    if (fancy && drape.visible) { taken.push(area); home.solid.push(area); home.blocked.push(around(area.x0, area.x1, area.z0, area.z1, 0.2)); }
  }
  // the sofa, facing it a comfortable way off, with its back to the room behind
  const sofaV = Math.min(tv.d + 2.3 + rng()*0.7 + sofa.d/2, depth - sofa.d/2 - 0.05);
  const sofaU = THREE.MathUtils.clamp(tvU + (rng() - 0.5)*0.6, -wallLength/2 + sofa.w/2 + 0.1, wallLength/2 - sofa.w/2 - 0.1);
  spot = at(sofaU, sofaV);
  const sofaArea = put('Sofa', spot.x, spot.z, toWall);
  // the coffee table between them, far enough from the sofa to get to it, on a rug
  const coffeeV = sofaV - sofa.d/2 - 0.55 - coffee.d/2;
  spot = at(sofaU, coffeeV);
  put('Coffee_Table', spot.x, spot.z, toWall);
  if (F.Rug) { spot = at(sofaU, coffeeV + 0.15); put('Rug', spot.x, spot.z, toWall, { scale: 1.35, underfoot: true }); }
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

  // in a posh home, an armchair or two at the coffee table's ends, turned to it
  const armchair = F.Armchair;
  if (fancy && armchair) {
    const along = at(1, 0), zero = at(0, 0), ux = along.x - zero.x, uz = along.z - zero.z;
    const first = rng() < 0.5 ? -1 : 1;
    for (const side of rng() < 0.6 ? [first, -first] : [first]) {
      spot = at(sofaU + side*(Math.max(coffee.w/2 + 0.45, sofa.w/2 + 0.05) + armchair.d/2), coffeeV);
      const angle = Math.atan2(-side*ux, -side*uz), r = footprint(armchair, spot.x, spot.z, angle);
      if (!fits(r, 0.05) || hidesScreen(r)) continue;
      put('Armchair', spot.x, spot.z, angle, { tall: true });
    }
  }
  // in a student flat, a beanbag at one end of the coffee table or the other, turned to the TV
  const beanbag = F.Beanbag;
  if (scruffy && beanbag) {
    const first = rng() < 0.5 ? -1 : 1;
    for (const side of [first, -first]) {
      spot = at(sofaU + side*(Math.max(coffee.w/2 + 0.35, sofa.w/2 - 0.1) + beanbag.w/2), coffeeV - 0.2);
      const angle = Math.atan2(screen.x - spot.x, screen.z - spot.z), r = footprint(beanbag, spot.x, spot.z, angle);
      if (!fits(r, 0.05)) continue;
      put('Beanbag', spot.x, spot.z, angle);
      break;
    }
  }
  // in a mid-century home, the lounge chair at one end of the coffee table or the other, turned to it, its ottoman in
  // front of it
  const lounge = F.LoungeChair, ottoman = F.Ottoman;
  if (sixties && lounge && rng() < 0.85) {
    const along = at(1, 0), zero = at(0, 0), ux = along.x - zero.x, uz = along.z - zero.z;
    const first = rng() < 0.5 ? -1 : 1;
    for (const side of [first, -first]) {
      const out = Math.max(coffee.w/2 + 0.5, sofa.w/2 + 0.1) + lounge.d/2 + (ottoman ? ottoman.d + 0.05 : 0);
      spot = at(sofaU + side*out, coffeeV);
      const angle = Math.atan2(-side*ux, -side*uz), r = footprint(lounge, spot.x, spot.z, angle);
      if (!fits(r, 0.05) || hidesScreen(r)) continue;
      put('LoungeChair', spot.x, spot.z, angle, { tall: true });
      if (ottoman) {
        const foot = at(sofaU + side*(out - lounge.d/2 - ottoman.d/2 - 0.05), coffeeV), o = footprint(ottoman, foot.x, foot.z, angle);
        if (fits(o, 0.02) && !hidesScreen(o)) put('Ottoman', foot.x, foot.z, angle);
      }
      break;
    }
  }
  // in a bohemian home, a peacock chair at one end of the coffee table or the other, turned to it, and a pouf at the other
  const peacock = F.PeacockChair, pouf = F.Pouf;
  if (leafy && peacock) {
    const along = at(1, 0), zero = at(0, 0), ux = along.x - zero.x, uz = along.z - zero.z;
    const first = rng() < 0.5 ? -1 : 1;
    let poufSide = first;
    for (const side of [first, -first]) {
      spot = at(sofaU + side*(Math.max(coffee.w/2 + 0.45, sofa.w/2 + 0.05) + peacock.d/2), coffeeV);
      const angle = Math.atan2(-side*ux, -side*uz), r = footprint(peacock, spot.x, spot.z, angle);
      if (!fits(r, 0.05) || hidesScreen(r)) continue;
      put('PeacockChair', spot.x, spot.z, angle, { tall: true });
      poufSide = -side;
      break;
    }
    if (pouf && rng() < 0.8) {
      spot = at(sofaU + poufSide*(coffee.w/2 + 0.3 + pouf.w/2), coffeeV - 0.1);
      const angle = Math.atan2(screen.x - spot.x, screen.z - spot.z), r = footprint(pouf, spot.x, spot.z, angle);
      if (fits(r, 0.05)) put('Pouf', spot.x, spot.z, angle);
    }
  }
  // a lamp at one end of the sofa or the other
  const lamp = F.Lamp;
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
  // Something tall against one of the far walls, between two of its windows, facing into the room: a bookcase, or in a
  // posh home a fireplace first. (Only piers wide enough for it, so it's not over the window either side: the ones at
  // the walls' ends are mostly behind the side walls, and fits turns those down.)
  const inPier = name => {
    const piece = F[name];
    const spots = [[FAR_X, u => ({ x: u, z: ROOM_D/2 - piece.d/2 - 0.03, angle: Math.PI })],
      [FAR_Z, u => ({ x: ROOM_W/2 - piece.d/2 - 0.03, z: -u, angle: -Math.PI/2 })]]
      .flatMap(([w, spot]) => { const p = piers(...w); return p.width > piece.w + 0.04 ? p.centres.map(spot) : []; });
    while (spots.length) {
      const [p] = spots.splice(Math.floor(rng()*spots.length), 1);
      const r = footprint(piece, p.x, p.z, p.angle);
      if (!fits(r, 0.1) || hidesScreen(r)) continue;
      put(name, p.x, p.z, p.angle, { tall: true });
      return;
    }
  };
  if (fancy && F.Fireplace) inPier('Fireplace');
  if (F.Bookcase && rng() < 0.7) inPier('Bookcase');
  // a chest of drawers somewhere along one of the far walls, facing into the room
  const alongFar = name => {
    const piece = F[name];
    for (let tries = 0; tries < 30; tries++) {
      const onX = rng() < 0.5, u = (rng()*2 - 1)*((onX ? ROOM_D : ROOM_W)/2 - piece.w/2 - 0.1);
      const p = onX ? { x: ROOM_W/2 - piece.d/2 - 0.03, z: u, angle: -Math.PI/2 } : { x: u, z: ROOM_D/2 - piece.d/2 - 0.03, angle: Math.PI };
      const r = footprint(piece, p.x, p.z, p.angle);
      if (!fits(r, 0.15) || hidesScreen(r)) continue;
      put(name, p.x, p.z, p.angle);
      break;
    }
  };
  if (F.Drawers && rng() < 0.6) alongFar('Drawers');
  // (and in a mid-century home, a radiogram likewise)
  if (sixties && F.Radiogram && rng() < 0.75) alongFar('Radiogram');
  // a dining table somewhere with room to walk round it, with a chair either side or all round — and not so near the
  // camera that it's cut off by the bottom of the view
  const underCamera = { x0: -ROOM_W/2, x1: -ROOM_W/2 + 2.8, z0: -ROOM_D/2, z1: -ROOM_D/2 + 2.8 };
  // (but in a posh home, first a grand piano somewhere with room round it, and its bench pulled up to the keyboard, at its +z)
  const piano = F.Piano, bench = F.PianoBench;
  if (fancy && piano && bench && rng() < 0.8) {
    for (let tries = 0; tries < 60; tries++) {
      const x = (rng()*2 - 1)*(ROOM_W/2 - 1), z = (rng()*2 - 1)*(ROOM_D/2 - 1), angle = Math.floor(rng()*4)*Math.PI/2;
      const b = turned(0, piano.d/2 + 0.2 + bench.d/2, angle, x, z);
      const all = [footprint(piano, x, z, angle), footprint(bench, b.x, b.z, angle)];
      const whole = { x0: Math.min(...all.map(r => r.x0)), x1: Math.max(...all.map(r => r.x1)),
        z0: Math.min(...all.map(r => r.z0)), z1: Math.max(...all.map(r => r.z1)) };
      if (!fits(whole, 0.35, 0.05) || overlaps(whole, underCamera) || hidesScreen(whole)) continue;
      put('Piano', x, z, angle, { tall: true });
      put('PianoBench', b.x, b.z, angle + Math.PI);
      break;
    }
  }
  const table = F.Table, chair = F.Chair;
  let dining = null;
  if (table && chair && rng() < 0.8) {
    for (let tries = 0; tries < 60; tries++) {
      const x = (rng()*2 - 1)*(ROOM_W/2 - 1), z = (rng()*2 - 1)*(ROOM_D/2 - 1), turn = rng() < 0.5 ? 0 : Math.PI/2;
      const sides = rng() < 0.45 ? [0, 1, 2, 3] : rng() < 0.5 ? [0, 2] : [1, 3];
      const top = footprint(table, x, z, turn);
      const chairs = sides.map(k => {
        const dx = [0, 1, 0, -1][k], dz = [1, 0, -1, 0][k];
        const half = (dx ? (top.x1 - top.x0) : (top.z1 - top.z0))/2, reach = half + chair.d/2 - 0.08;
        // and how high the table top is where the plate goes, in from its edge in front of the chair (not the table's
        // whole height, which a posh one's centrepiece stands well above)
        return { x: x + dx*reach, z: z + dz*reach, angle: Math.atan2(-dx, -dz), plate: surfaceAt(table, turn, dx*(half - DINER_PLATE_IN), dz*(half - DINER_PLATE_IN)) };
      });
      const all = [top, ...chairs.map(c => footprint(chair, c.x, c.z, c.angle))];
      const whole = { x0: Math.min(...all.map(r => r.x0)), x1: Math.max(...all.map(r => r.x1)),
        z0: Math.min(...all.map(r => r.z0)), z1: Math.max(...all.map(r => r.z1)) };
      if (!fits(whole, 0.7, 0.35) || overlaps(whole, underCamera)) continue;
      put('Table', x, z, turn);
      dining = { x, z };
      // (in a student flat, whatever chairs came to hand)
      const odd = ['Chair', 'Chair2', 'Chair3'].filter(name => F[name]), first = scruffy ? Math.floor(tint()*odd.length) : 0;
      // (each chair knows how high the table top is, for the plate of whoever sits at it: see serveMeal in peopleHolding.js)
      chairs.forEach((c, k) => put(scruffy ? odd[(first + k) % odd.length] : 'Chair', c.x, c.z, c.angle, { diner: c.plate }));
      break;
    }
  }
  // a light hanging from the ceiling over the dining table, or else the coffee table — the room's light after dark when
  // there is one, rather than the lamp's
  const pendant = F.Pendant;
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
  // (and in a bohemian home, plants of every sort in every one of those spots it can, and in front of the far walls'
  // piers, and at the sofa's ends)
  const plant = F.Plant;
  if (plant) {
    let plants = leafy ? 5 + Math.floor(rng()*4) : 1 + Math.floor(rng()*2.5);
    const inset = Math.max(plant.w, plant.d)/2 + 0.1;
    const spots = [
      { x: ROOM_W/2 - inset, z: ROOM_D/2 - inset }, { x: ROOM_W/2 - inset, z: -ROOM_D/2 + inset },
      { x: -ROOM_W/2 + inset, z: ROOM_D/2 - inset },
      at(tvU - tv.w/2 - inset, inset), at(tvU + tv.w/2 + inset, inset),
    ];
    if (leafy) {
      spots.push(at(sofaU - sofa.w/2 - inset, sofaV + sofa.d/2 - inset), at(sofaU + sofa.w/2 + inset, sofaV + sofa.d/2 - inset));
      for (const u of piers(...FAR_X).centres) spots.push({ x: u, z: ROOM_D/2 - inset });
      for (const u of piers(...FAR_Z).centres) spots.push({ x: ROOM_W/2 - inset, z: -u });
    }
    const kinds = ['Plant', 'Plant2', 'Plant3'].filter(name => F[name]);
    while (plants > 0 && spots.length) {
      const [p] = spots.splice(Math.floor(rng()*spots.length), 1), scale = 0.85 + rng()*0.3;
      const name = leafy ? kinds[Math.floor(rng()*kinds.length)] : 'Plant', r = footprint(F[name], p.x, p.z, 0, scale);
      if (!fits(r, 0.1) || hidesScreen(r)) continue;
      put(name, p.x, p.z, rng()*Math.PI*2, { scale, tall: true });
      plants--;
    }
  }
  // and along its windowsills, and hung from the ceiling in front of its windows (but not in front of the TV)
  if (leafy && F.SillPlants) {
    const hanging = F.HangingPlant;
    for (const [[length, windows], wallAt] of [[FAR_X, (u, v) => ({ x: u, z: ROOM_D/2 + v, angle: Math.PI })],
      [FAR_Z, (u, v) => ({ x: ROOM_W/2 + v, z: -u, angle: -Math.PI/2 })]]) {
      const p = piers(length, windows);
      for (let i = 0; i < windows; i++) {
        const u = p.centres[i] + p.width/2 + p.gap/2, inside = (length === FAR_X[0] ? ROOM_W : ROOM_D)/2;
        if (Math.abs(u) > inside - 0.4) continue;
        if (rng() < 0.75) {
          const s = wallAt(u + (rng() - 0.5)*0.3, 0.12);
          put('SillPlants', s.x, s.z, s.angle + (rng() < 0.5 ? Math.PI : 0), { underfoot: true });
          home.group.children.at(-1).position.y = SILL + 0.03;
        }
        if (hanging && rng() < 0.45) {
          const s = wallAt(u + (rng() < 0.5 ? -1 : 1)*p.gap*0.25, -0.35), r = footprint(hanging, s.x, s.z, 0);
          if (hidesScreen(r)) continue;
          put('HangingPlant', s.x, s.z, rng()*Math.PI*2, { underfoot: true });
          home.group.children.at(-1).position.y = ROOM_H - hanging.h;
        }
      }
    }
  }
  // in a student flat, the washing out on a clothes horse somewhere with room round it, but not in the way of the TV
  const horse = F.ClothesHorse;
  if (scruffy && horse && rng() < 0.85) {
    for (let tries = 0; tries < 40; tries++) {
      const x = (rng()*2 - 1)*(ROOM_W/2 - 0.8), z = (rng()*2 - 1)*(ROOM_D/2 - 0.6), angle = rng()*Math.PI;
      const r = footprint(horse, x, z, angle);
      if (!fits(r, 0.3, 0.1) || overlaps(r, cameraCorner) || hidesScreen(r)) continue;
      put('ClothesHorse', x, z, angle, { tall: true });
      break;
    }
  }
  // and posters stuck up round the walls, a little askew: between the far walls' windows, and on the walls behind the
  // camera as a posh home has paintings (below)
  const posters = ['PosterBand', 'PosterFilm', 'PosterMap'].filter(name => F[name]);
  if (scruffy && posters.length) {
    const hang = (name, x, z, angle, y) => {
      put(name, x, z, angle, { underfoot: true });
      const object = home.group.children.at(-1);
      object.position.y = y - F[name].h/2;
      object.rotateZ((rng() - 0.5)*0.08);
    };
    for (const [[length, windows], wallAt] of [[FAR_X, u => ({ x: u, z: ROOM_D/2 - 0.012, angle: Math.PI })],
      [FAR_Z, u => ({ x: ROOM_W/2 - 0.012, z: -u, angle: -Math.PI/2 })]]) {
      const inside = (length === FAR_X[0] ? ROOM_W : ROOM_D)/2, p = piers(length, windows);
      for (const u of p.centres) {
        const name = posters[Math.floor(rng()*posters.length)], w = F[name].w;
        if (rng() < 0.35 || w > p.width - 0.15 || Math.abs(u) + w/2 > inside - 0.15) continue;
        // (not over anything tall, such as the crates)
        const spot = wallAt(u), front = footprint({ w, d: 1 }, spot.x, spot.z, spot.angle);
        if (taken.some(o => o.tall && overlaps(o, front))) continue;
        hang(name, spot.x, spot.z, spot.angle, 1.65 + rng()*0.15);
      }
    }
    const hung = [];
    for (let tries = 0, count = 1 + Math.floor(rng()*3); tries < 20 && count > 0; tries++) {
      const name = posters[Math.floor(rng()*posters.length)], w = F[name].w, back = rng() < 0.5;
      const [lo, hi] = back ? [-ROOM_W/2 + 1.6 + w/2, ROOM_W/2 - 0.5 - w/2] : [doorTo + 0.4 + w/2, ROOM_D/2 - 1 - w/2];
      const u = lo + rng()*(hi - lo);
      if (hi < lo || hung.some(h => h.back === back && Math.abs(h.u - u) < (h.w + w)/2 + 0.3)) continue;
      if (back) hang(name, u, -ROOM_D/2 + 0.012, 0, 1.55 + rng()*0.2);
      else hang(name, -ROOM_W/2 + 0.012, u, Math.PI/2, 1.55 + rng()*0.2);
      hung.push({ back, u, w });
      count--;
    }
  }
  // and fairy lights strung in swags along the top of one far wall or the other, above its windows, or both
  const lights = F.FairyLights;
  if (scruffy && lights && rng() < 0.8) {
    const both = rng() < 0.3, first = rng() < 0.5;
    for (const alongX of both ? [true, false] : [first]) {
      const length = (alongX ? ROOM_W : ROOM_D) - 0.3, swags = Math.round(length/lights.w), span = length/swags;
      for (let k = 0; k < swags; k++) {
        const u = -length/2 + span*(k + 0.5);
        if (alongX) put('FairyLights', u, ROOM_D/2 - 0.05, Math.PI, { underfoot: true });
        else put('FairyLights', ROOM_W/2 - 0.05, -u, -Math.PI/2, { underfoot: true });
        const object = home.group.children.at(-1);
        object.scale.x = span/lights.w;
        object.position.y = 3.02 - lights.h;
      }
    }
  }

  // and in a posh home, a painting or three on the walls behind the camera, about eye height and clear of each other: along
  // x from a little way past the camera, and along z (the door's wall) from past the door to short of the far corner (and
  // in a mid-century home, prints and a sunburst clock)
  const gallery = fancy ? ['Painting', 'Portrait'] : sixties ? ['Print', 'Sunburst'] : leafy ? ['Tapestry', 'Macrame'] : null;
  if (gallery && F[gallery[0]]) {
    const hung = [];
    let count = 1 + Math.floor(rng()*3);
    for (let tries = 0; tries < 20 && count > 0; tries++) {
      const name = F[gallery[1]] && rng() < 0.4 && !hung.some(h => h.name === gallery[1] && sixties) ? gallery[1] : gallery[0], art = F[name], back = rng() < 0.5;
      const [lo, hi] = back ? [-ROOM_W/2 + 1.6 + art.w/2, ROOM_W/2 - 0.5 - art.w/2] : [doorTo + 0.4 + art.w/2, ROOM_D/2 - 1 - art.w/2];
      const u = lo + rng()*(hi - lo);
      if (hi < lo || hung.some(h => h.back === back && Math.abs(h.u - u) < (h.w + art.w)/2 + 0.4)) continue;
      const out = art.d/2 + 0.03;
      if (back) put(name, u, -ROOM_D/2 + out, 0, { underfoot: true });
      else put(name, -ROOM_W/2 + out, u, Math.PI/2, { underfoot: true });
      home.group.children.at(-1).position.y = 1.6 - art.h/2;
      hung.push({ back, u, w: art.w, name });
      count--;
    }
  }

  // the seats, in the world: where to sit, how high, and which way they face
  const c = Math.cos(room.rotation.y), s = Math.sin(room.rotation.y);
  home.seats = home.seats.map(seat => {
    const w = room.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z));
    const diner = seat.diner ? { top: room.localToWorld(new THREE.Vector3(seat.x, seat.diner, seat.z)).y } : false; // (the table top's height)
    return { x: w.x, y: w.y, z: w.z, nx: seat.nx*c + seat.nz*s, nz: -seat.nx*s + seat.nz*c, sofa: seat.sofa, diner, by: null };
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
    console.warn('Splinetopia: the office model failed to load; offices are left bare', err);
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

// The helpers a layout's furnished with, from `F` (a model's pieces) into `group`, for `layout` (whose solid, blocked and
// seats they fill): what's taken so far and whether something fits, putting a piece in place, and finding somewhere
// along a wall for one — glass-walled or not (see enterBuilding), its random choices from `rng`, and sitting on any of the
// pieces named in `deskSeats` as at a desk.
function planRoom(layout, F, group, rng, glass, deskSeats) {
  const any = list => list[Math.floor(rng()*list.length)];
  // what's taken so far (and room kept clear), as rectangles in the room's x and z
  const taken = [];
  const overlaps = (a, b, gap = 0) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.z0 < b.z1 + gap && b.z0 < a.z1 + gap;
  const inRoom = (r, margin) => r.x0 >= -ROOM_W/2 + margin && r.x1 <= ROOM_W/2 - margin
    && r.z0 >= -ROOM_D/2 + margin && r.z1 <= ROOM_D/2 - margin;
  const fits = (r, gap = 0, margin = 0.02) => inRoom(r, margin) && taken.every(o => !overlaps(r, o, gap));
  // `name` stood at (x, z) turned by `angle`, in `parent` (the room's furniture, or on a desk, in the desk's terms),
  // and unless it's something small nobody could walk into, solid (or `solid` of it, in its own terms)
  const put = (name, x, z, angle, { parent = group, y = 0, small = false, solid = null } = {}) => {
    const piece = F[name], object = piece.object.clone();
    object.position.set(x, y, z);
    object.rotation.y = angle;
    parent.add(object);
    if (small) return object;
    const r = turnedRect(solid ?? piece.bounds, angle, x, z);
    layout.solid.push(r);
    layout.blocked.push(around(...(solid ? [x - 0.4, x + 0.4, z - 0.4, z + 0.4] : [r.x0, r.x1, r.z0, r.z1]), 0.35));
    for (const seat of piece.seats) {
      const at = turned(seat.x, seat.z, angle, x, z);
      layout.seats.push({ x: at.x, z: at.z, y: seat.y, nx: Math.sin(angle), nz: Math.cos(angle), sofa: false, desk: deskSeats.includes(name) });
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

  return { taken, overlaps, inRoom, fits, put, cameraCorner, underCamera, WALL_SIDES, overWindow, againstWall, any };
}
// `layout`'s seats, from the room's terms to the world's: where to sit, how high, and which way they face
function seatsInWorld(layout) {
  const c = Math.cos(room.rotation.y), s = Math.sin(room.rotation.y);
  layout.seats = layout.seats.map(seat => {
    const w = room.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z));
    return { x: w.x, y: w.y, z: w.z, nx: seat.nx*c + seat.nz*s, nz: -seat.nx*s + seat.nz*c, sofa: false, desk: seat.desk, by: null };
  });
}

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

  const { taken, overlaps, fits, put, underCamera, againstWall, any } = planRoom(office, F, officeGroup, rng, glass, ['OfficeChair']);

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

  seatsInWorld(office);
  // and the desks, for the phones and computers on them to be heard from (see audio/office.js): in front of each desk chair
  office.desks = office.seats.filter(seat => seat.desk)
    .map(seat => ({ x: seat.x + seat.nx*0.55, y: room.position.y + 0.85, z: seat.z + seat.nz*0.55 }));
}

// ---------------------------------------------------------- a warehouse or a factory
// A warehouse or a factory (see roomLayoutOf) has its room on the ground floor: bare concrete under steel beams, the
// walls painted a darker colour up to the sills with a yellow line along the top, a walkway marked out on the floor from
// the door, and lamps hung from the beams — and it's fitted out from a model of its own (assets/models/Industrial.glb,
// built by tools/industrial-models.py, which lists its pieces), each building its own way (from its key). A warehouse:
// runs of pallet racking, single with their backs to a wall or back to back out in the room, lined up to look down the
// aisles between them if they'll go that way; a forklift, pallets of boxes, drums and crates about the floor, a pallet
// jack, a rolling ladder, and a packing bench with a stool at it. A factory: machines (a CNC mill, a lathe, a pillar
// drill, a hydraulic press), each in a yellow box painted on the floor, maybe a conveyor, workbenches with stools at them,
// a tool chest, lockers, the electrical cabinet, and a drum or two. Until the model's loaded, they're bare.
const INDUSTRIAL_MODEL_URL = 'assets/models/Industrial.glb';
let industrial = null;
// the concrete's tinted by the floor's colour (a factory's is sometimes painted)
const WAREHOUSE_FLOORS = [0x9a9a96, 0x8a8c8a, 0xa8a49c, 0x7a7e80, 0xb0aca4];
const FACTORY_FLOORS = [0x9a9a96, 0x8a8c8a, 0x6a8a7a, 0x8a9098, 0x7a8a6a, 0x9a8a78];
const INDUSTRIAL_WALLS = [0xe8e6e0, 0xd8d8d4, 0xdcdfe2, 0xe6e0d4, 0xc8ccc8, 0xf0ece0, 0xd4dcd8];
const DADOS = [0x3a5a7a, 0x5a6a5a, 0x7a7e80, 0x2a4a3a, 0x8a3a2a, 0x4a4e56, 0x6a5a4a];
const INDUSTRIAL_PAINTED = {
  Machine: [0x5a7a6a, 0x6a7a8a, 0xd8d4c8, 0x3a5a8a, 0x8a8e92, 0x4a6a5a],
  Upright: [0x2a5aa8, 0x3a6a9a, 0x6a6e72, 0x2a7a5a],
  Beam: [0xe07a2a, 0xe8a030, 0xd84a2a],
  Forklift: [0xe8b020, 0xe07a2a, 0xc8352c, 0x3a6ab0],
  Toolbox: [0xc8352c, 0x2a4a8a, 0x2a2c30, 0x3a3e44],
  Locker: [0x6a7a8a, 0x9aa4ac, 0x3a5a7a, 0x6a8a6a, 0xc8c4b8],
  Bench: [0x3a5a8a, 0x6a6e72, 0x4a6a4a, 0xd8a030],
  Drum: [0x2a5aa8, 0xc8352c, 0x3a7a4a, 0x2a2c30, 0xd8a030],
};
const industrialPainted = [];
async function loadIndustrial() {
  try {
    industrial = await loadPieces(INDUSTRIAL_MODEL_URL, INDUSTRIAL_PAINTED, industrialPainted);
  } catch (err) {
    console.warn('Splinetopia: the industrial model failed to load; warehouses and factories are left bare', err);
    return;
  }
  // (a stool's seat is its top, in the middle: sat on facing whichever way it's turned)
  if (industrial.Stool) industrial.Stool.seats = [{ x: 0, z: 0, y: industrial.Stool.h }];
  if (inside && current.industrial) furnishIndustrial(inside.key, current.kind);
}
loadIndustrial();
// Plain concrete: mottled, with a saw-cut joint every 4 m — which is how often it repeats.
const concrete = floorTexture(1024, 4, (g, rng) => {
  g.fillStyle = 'rgb(232,232,230)';
  g.fillRect(0, 0, 1024, 1024);
  const blot = (x, y, r, style) => {
    for (const dx of [-1024, 0, 1024]) for (const dy of [-1024, 0, 1024]) {
      g.fillStyle = style;
      g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI*2); g.fill();
    }
  };
  for (let i = 0; i < 5000; i++) {
    const shade = rng() < 0.5 ? 'rgba(90,90,85,' : 'rgba(255,255,250,';
    blot(rng()*1024, rng()*1024, 2 + rng()*rng()*16, shade + (0.01 + rng()*0.025) + ')');
  }
  for (let i = 0; i < 5; i++) blot(rng()*1024, rng()*1024, 30 + rng()*60, 'rgba(60,55,50,0.025)');  // (old stains)
  g.fillStyle = 'rgba(40,40,40,0.55)';
  g.fillRect(0, 0, 1024, 3); g.fillRect(0, 0, 3, 1024);
});
LAYOUTS.warehouse.floorMap = LAYOUTS.factory.floorMap = concrete;
// The walls painted to the sills (round the door), and a yellow line along the top of it: shown in warehouses and
// factories (see useLayout), and coloured for each.
const dado = new THREE.Group();
dado.visible = false;
room.add(dado);
const dadoMaterial = lit(DADOS[0], 0.9), lineMaterial = lit(0xe8b820, 0.6);
const DADO_H = SILL - 0.1;
for (const [w, d, x, z] of [[ROOM_W, 0.02, 0, ROOM_D/2 - 0.01], [ROOM_W, 0.02, 0, -ROOM_D/2 + 0.01], [0.02, ROOM_D, ROOM_W/2 - 0.01, 0],
  [0.02, doorFrom + ROOM_D/2, -ROOM_W/2 + 0.01, (doorFrom - ROOM_D/2)/2], [0.02, ROOM_D/2 - doorTo, -ROOM_W/2 + 0.01, (doorTo + ROOM_D/2)/2]]) {
  box(w, DADO_H, d, dadoMaterial, x, DADO_H/2, z, dado);
  box(w + (w > d ? 0 : 0.004), 0.05, d + (w > d ? 0.004 : 0), lineMaterial, x, DADO_H + 0.025, z, dado);
}
// a line painted on the floor from (x0, z0) to (x1, z1), along x or z
const floorLine = (group, x0, z0, x1, z1, w = 0.07) =>
  box(Math.abs(x1 - x0) + w, 0.006, Math.abs(z1 - z0) + w, lineMaterial, (x0 + x1)/2, 0.003, (z0 + z1)/2, group);
const outline = (group, r) => {
  floorLine(group, r.x0, r.z0, r.x1, r.z0); floorLine(group, r.x0, r.z1, r.x1, r.z1);
  floorLine(group, r.x0, r.z0, r.x0, r.z1); floorLine(group, r.x1, r.z0, r.x1, r.z1);
};
const grown = (r, by) => ({ x0: r.x0 - by, x1: r.x1 + by, z0: r.z0 - by, z1: r.z1 + by });

// Fits out the warehouse or factory (`kind`) for the building with this key (see buildingKey): its layout's furniture,
// where nobody stands or walks, and its seats, in the room as it's now placed.
function furnishIndustrial(key, kind) {
  const layout = LAYOUTS[kind], group = layout.furnished;
  group.clear();
  layout.blocked = []; layout.solid = []; layout.seats = [];
  grid = null;
  const rng = mulberry32(hashNameToNumber(key + ' ' + kind));
  const tint = mulberry32(hashNameToNumber(key + ' ' + kind + ' colours'));
  const pick = list => list[Math.floor(tint()*list.length)];
  layout.floor.setHex(pick(kind === 'factory' ? FACTORY_FLOORS : WAREHOUSE_FLOORS));
  layout.wall.setHex(pick(INDUSTRIAL_WALLS));
  dadoMaterial.color.setHex(pick(DADOS));
  roomLit(dadoMaterial);
  paintRoom();
  for (const material of industrialPainted) {
    material.color.setHex(pick(INDUSTRIAL_PAINTED[material.name]));
    roomLit(material);
  }
  // the walkway in from the door, between two lines, kept clear
  const walkway = { x0: -ROOM_W/2, x1: -0.8, z0: DOOR_Z - 0.6, z1: DOOR_Z + 0.6 };
  floorLine(group, walkway.x0 + 0.1, walkway.z0, walkway.x1, walkway.z0);
  floorLine(group, walkway.x0 + 0.1, walkway.z1, walkway.x1, walkway.z1);
  const F = industrial;
  if (!F) return;
  const { taken, overlaps, fits, put, underCamera, againstWall, any } = planRoom(layout, F, group, rng, false, ['Stool']);
  taken.push(walkway);
  const high = [];  // (what's too tall to hang a lamp over)
  // `name` put at `spot` ({ x, z, angle, area }, as againstWall finds it) and its area kept
  const place = (name, spot) => {
    put(name, spot.x, spot.z, spot.angle);
    taken.push(spot.area);
    if (F[name].h > 2.3) high.push(spot.area);
    return spot;
  };
  // somewhere along a wall for `name` (tall or not, and allowed in front of a window or not: see againstWall)
  const onWall = (name, tall, under = false) => {
    const spot = F[name] && againstWall(F[name].bounds, tall, { under });
    return spot ? place(name, spot) : null;
  };
  // somewhere out in the room for `r` (a footprint, in its own terms), square to the walls or (`loose`) not quite,
  // `gap` clear of everything else, and not right under the camera if it's `tall`
  const inTheOpen = (r, { gap = 0.6, tall = true, loose = false, tries = 40 } = {}) => {
    for (let k = 0; k < tries; k++) {
      const angle = Math.floor(rng()*4)*Math.PI/2 + (loose ? (rng() - 0.5)*0.6 : 0);
      const x = (rng()*2 - 1)*(ROOM_W/2 - 0.8), z = (rng()*2 - 1)*(ROOM_D/2 - 0.8);
      const area = turnedRect(r, angle, x, z);
      if (!fits(area, gap, 0.1) || (tall && overlaps(area, underCamera))) continue;
      return { x, z, angle, area };
    }
    return null;
  };
  const openPut = (name, options = {}) => {
    const spot = F[name] && inTheOpen(F[name].bounds, { tall: F[name].h > 1.2, ...options });
    return spot ? place(name, spot) : null;
  };
  // a bench against a wall with a stool pulled up to its front, sat at as a desk is (see measureSeats' desk)
  const benchWithStool = name => {
    const bench = F[name];
    if (!bench || !F.Stool) return null;
    const r = { ...bench.bounds, z1: bench.bounds.z1 + 0.6 };
    const spot = againstWall(r, false, { under: true });
    if (!spot) return null;
    place(name, spot);
    const at = turned((rng() - 0.5)*0.5, bench.bounds.z1 + 0.28, spot.angle, spot.x, spot.z);
    put('Stool', at.x, at.z, spot.angle + Math.PI + (rng() - 0.5)*0.3, { solid: { x0: -0.18, x1: 0.18, z0: -0.18, z1: 0.18 } });
    return spot;
  };
  const LOADS = ['PalletBoxes', 'PalletBoxes', 'PalletWrapped', 'Drums', 'PalletStack', 'Crate'].filter(name => F[name]);
  // a pallet or a crate, along a wall or out on the floor
  const load = () => {
    const name = any(LOADS);
    return rng() < 0.5 ? onWall(name, false, true) ?? openPut(name, { gap: 0.5, loose: true }) : openPut(name, { gap: 0.5, loose: true });
  };

  if (kind === 'warehouse' && F.Racking) {
    // The racking: runs of a bay or two, as many as will go (up to four) with aisles between them wide enough for the
    // forklift. A run out in the room is two rows back to back (or one) and mostly turned end on to the camera, to look
    // down the aisles; a single row may go with its back to a wall instead.
    const RACKS = ['Racking', 'Racking2'].filter(name => F[name]);
    const bay = F.Racking, SPACING = 2.8, D = bay.bounds.z1 - bay.bounds.z0;
    for (let runs = 0, tries = 0; runs < 4 && tries < 200; tries++) {
      const bays = rng() < 0.6 ? 2 : 1, double = rng() < 0.55;
      const r = { x0: -bays*SPACING/2, x1: bays*SPACING/2, z0: double ? -D - 0.05 : bay.bounds.z0, z1: double ? D + 0.05 : bay.bounds.z1 };
      let spot;
      if (!double && rng() < 0.5) {
        spot = againstWall(r, true, { tries: 1 });
        if (!spot) continue;
      } else {
        const x = (rng()*2 - 1)*(ROOM_W/2 - 1), z = (rng()*2 - 1)*(ROOM_D/2 - 1);
        const toX = -ROOM_W/2 - x, toZ = -ROOM_D/2 - z;
        const endOn = a => Math.abs(Math.cos(a)*toX - Math.sin(a)*toZ);
        const angles = [0, 1, 2, 3].map(i => i*Math.PI/2);
        const angle = rng() < 0.25 ? any(angles) : angles.reduce((best, a) => endOn(a) > endOn(best) ? a : best);
        const area = turnedRect(r, angle, x, z);
        if (!fits(area, 1.3, 0.05) || overlaps(area, underCamera)) continue;
        spot = { x, z, angle, area };
      }
      for (const row of double ? [0, 1] : [0]) for (let i = 0; i < bays; i++) {
        const at = turned((i - (bays - 1)/2)*SPACING, double ? (row ? -1 : 1)*(D/2 + 0.05) : 0, spot.angle, spot.x, spot.z);
        put(any(RACKS), at.x, at.z, spot.angle + (row ? Math.PI : 0));
      }
      taken.push(spot.area);
      high.push(spot.area);
      runs++;
    }
    if (F.Forklift) openPut('Forklift', { gap: 0.3, loose: true });
    for (let n = 2 + Math.floor(rng()*5); n > 0; n--) load();
    if (F.PalletJack && rng() < 0.7) openPut('PalletJack', { gap: 0.3, loose: true });
    if (F.Ladder && rng() < 0.6) openPut('Ladder', { gap: 0.4 });
    if (rng() < 0.75) benchWithStool('PackingBench');
  } else if (kind === 'factory') {
    // The machines, each in a yellow box on the floor a little way out round it: two to four of them, against a wall (not
    // in front of a window, unless it's low) or out in the room.
    const MACHINES = ['Mill', 'Lathe', 'DrillPress', 'Press'].filter(name => F[name]);
    for (let n = 2 + Math.floor(rng()*3); n > 0 && MACHINES.length; n--) {
      const name = any(MACHINES), piece = F[name];
      const r = grown(piece.bounds, 0.35);
      const spot = (rng() < 0.4 ? againstWall({ ...r, z0: piece.bounds.z0 }, true, { under: piece.h < 1.6 }) : null)
        ?? inTheOpen(r, { gap: 0.8 });
      if (!spot) continue;
      put(name, spot.x, spot.z, spot.angle);
      taken.push(spot.area);
      if (piece.h > 2.3) high.push(spot.area);
      outline(group, spot.area);
    }
    if (F.Conveyor && rng() < 0.5) openPut('Conveyor', { gap: 0.8 });
    for (let n = 1 + Math.floor(rng()*2); n > 0; n--) benchWithStool('Workbench');
    if (rng() < 0.8) onWall('ToolChest', false, true) ?? openPut('ToolChest', { gap: 0.4 });
    if (rng() < 0.7) onWall('Lockers', true);
    if (rng() < 0.8) onWall('ControlPanel', true);
    for (let n = Math.floor(rng()*3); n > 0; n--) load();
  }
  // either: a fire extinguisher by a wall, a cone or two, and the lamps hung from the beams, over wherever's clear
  onWall('Extinguisher', false, true);
  for (let n = Math.floor(rng()*rng()*3); n > 0; n--) openPut('Cone', { gap: 0.3, loose: true });
  if (F.HighBay) for (const x of [-2, 0, 2]) for (const z of [-1.6, 0.6, 2.2]) {
    const r = { x0: x - 0.35, x1: x + 0.35, z0: z - 0.35, z1: z + 0.35 };
    if (overlaps(r, underCamera) || high.some(h => overlaps(r, h))) continue;
    put('HighBay', x, z, 0, { y: ROOM_H - 0.15 - F.HighBay.h, small: true });
  }
  seatsInWorld(layout);
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

// where the camera starts in the room, in the room's own terms: the corner looking across at the far walls
const CAMERA_AT = new THREE.Vector3(-ROOM_W/2 + CAMERA_INSET, CAMERA_HEIGHT, -ROOM_D/2 + CAMERA_INSET);
const FOV_EASE = 0.12;
const ROOM_NEAR = 0.1; // the ceiling's closer than the usual near plane, and the wide view takes it in
const BASE_FOV = camera.fov;
// What tools/interior.html is trying out in place of the view above, each null for the usual: the camera's height above
// the floor, the height it looks at in the middle of the room, and its vertical field of view (degrees).
const tuning = { height: null, look: null, fov: null };
// the field of view zooming's taken it to (eased there in updateInteriorCamera)
let zoomedFov = CAMERA_FOV;
const viewFov = () => zoomedFov;
// the camera's height above the floor, and where dragging's taking it (eased there in updateInteriorCamera)
let eyeHeight = CAMERA_HEIGHT, eyeGoal = CAMERA_HEIGHT;
// The camera's way round the room (for controls.hug): theta, as the controls have it, is which way from the middle of
// the room the camera is, and it's out along there as far as CAMERA_INSET short of the wall that way, at its height —
// which a drag up or down (dy, in pixels) takes up or down the wall.
const hugWalls = {
  place(theta) {
    const turn = theta - room.rotation.y, s = Math.abs(Math.sin(turn)), c = Math.abs(Math.cos(turn));
    const out = Math.min(s > 1e-6 ? (ROOM_W/2 - CAMERA_INSET)/s : Infinity, c > 1e-6 ? (ROOM_D/2 - CAMERA_INSET)/c : Infinity);
    const up = eyeHeight - (tuning.look ?? CAMERA_LOOK);
    return { radius: Math.hypot(out, up), phi: Math.atan2(out, up) };
  },
  rise(dy) { eyeGoal = THREE.MathUtils.clamp(eyeGoal + dy*CAMERA_RISE, CAMERA_LOWEST, CAMERA_HIGHEST); },
  zoom(factor) { zoomedFov = THREE.MathUtils.clamp(zoomedFov*factor, FOV_NARROWEST, FOV_WIDEST); },
};
/**
 * Try out a different view (for tools/interior.html): anything left out or null goes back to the usual.
 * @param {{height?: ?number, look?: ?number, fov?: ?number}} t - height above the floor, height looked at, vertical FOV
 * @returns {{height: number, look: number, fov: number}} the view as it now is
 */
export function tuneInteriorView(t = {}) {
  Object.assign(tuning, { height: null, look: null, fov: null }, t);
  eyeHeight = eyeGoal = tuning.height ?? CAMERA_HEIGHT;
  zoomedFov = tuning.fov ?? CAMERA_FOV;
  if (inside) { controls.goalTarget.copy(lookAt()); controls.update(true); camera.fov = viewFov(); camera.updateProjectionMatrix(); }
  return { height: eyeHeight, look: tuning.look ?? CAMERA_LOOK, fov: viewFov() };
}
// what the camera looks at, in the world: the middle of the room
const lookAt = () => room.localToWorld(new THREE.Vector3(0, tuning.look ?? CAMERA_LOOK, 0));
// the nearer way round to `theta` from where the camera is, so it doesn't swing all the way about
const nearerWay = theta => controls.theta + Math.atan2(Math.sin(theta - controls.theta), Math.cos(theta - controls.theta));

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

// Goes into `group` (a building, as building-card.js follows it, with its key): the room onto its top floor (a warehouse
// or factory's ground floor), laid out as `kind` of room (one of LAYOUTS: 'home', 'office', 'warehouse' or 'factory'),
// the building hidden, and the camera cut straight to the corner, to go round the walls from there.
export function enterBuilding(group, key, kind = 'home') {
  if (inside) leaveBuilding();
  useLayout(kind);
  const glass = current === LAYOUTS.office && keyFraction(key) >= OFFICE_PUNCHED;
  // (a warehouse or a factory's room is on its ground floor: its roof's high over one big space, not storeys)
  const workshop = !!current.industrial;
  curtain.visible = glass; punched.visible = !glass;
  const fp = group.userData.footprint;
  const bounds = new THREE.Box3().setFromObject(group);
  const base = bounds.min.y, height = group.userData.height ?? (bounds.max.y - base);
  const centre = fp && fp.length >= 3 ? footprintBounds(group).c : bounds.getCenter(new THREE.Vector3());
  const storey = workshop ? 0 : Math.max(0, Math.floor((height - PLINTH - ROOM_H - 0.3)/FLOOR_HEIGHT));
  room.position.set(centre.x, base + PLINTH + storey*FLOOR_HEIGHT, centre.z);
  room.rotation.y = fp && fp.length >= 3 ? longestEdgeAngle(fp) : 0;
  room.visible = true;
  room.updateMatrixWorld(true);
  setRoomGlow(true);
  group.visible = false;
  if (current === LAYOUTS.home) furnish(key);
  else if (current === LAYOUTS.office) furnishOffice(key, glass);
  else if (workshop) furnishIndustrial(key, current.kind);

  visits++;
  resetOfficeAmbience();
  inside = { group, key, before: {
    target: controls.goalTarget.clone(), radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi,
    minRadius: controls.minRadius, near: camera.near,
  } };
  camera.near = ROOM_NEAR;
  camera.updateProjectionMatrix();
  controls.goalTarget.copy(lookAt());
  controls.minRadius = 0;
  controls.goalTheta = nearerWay(room.rotation.y + Math.atan2(CAMERA_AT.x, CAMERA_AT.z));
  controls.locked = true;
  controls.hug = hugWalls;
  eyeHeight = eyeGoal = tuning.height ?? CAMERA_HEIGHT;
  zoomedFov = tuning.fov ?? CAMERA_FOV;
  setIndoors(inRoom);
  // a hard cut in, no glide
  controls.update(true);
  camera.fov = viewFov();
  camera.updateProjectionMatrix();
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
  setRoomGlow(false);
  controls.locked = false;
  controls.hug = null;
  controls.goalTarget.copy(before.target);
  controls.goalRadius = before.radius;
  controls.goalTheta = nearerWay(before.theta);
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

// Whatever's between the camera and the middle of the room — the light hanging over a table as the camera comes round
// behind it, a bookcase it's riding past — fades nearly out of the way, on materials of its own for as long as it's
// faded (the model's are shared by every clone of it). Not the TV: its picture's a hole cut through to the player
// behind the canvas (see "the TV"), and it's too low to be in the way. Only what the sightline's through and out of
// again CLEAR short of the middle is in the way: a desk out in the middle of the room, the middle inside it or just
// beyond it, is what's being looked at.
const FADED = 0.15, FADE_EASE = 0.15, CLEAR = 0.75;
const sightline = new THREE.Ray(), sightHit = new THREE.Vector3(), sightEnd = new THREE.Vector3();
function fadeWhatsInTheWay() {
  if (!inside) return;
  sightline.origin.copy(camera.position);
  const reach = sightline.direction.copy(controls.target).sub(camera.position).length() - CLEAR;
  sightline.direction.normalize();
  sightline.at(reach, sightEnd);
  const pieces = (current.furnished ?? current.group).children;
  for (const piece of pieces) {
    if (!piece.isGroup || piece.userData.isTV) continue;
    const u = piece.userData;
    if (u.fadeVisit !== visits) { u.fadeBox = new THREE.Box3().setFromObject(piece); u.fadeVisit = visits; u.fade ??= 1; }
    const hit = sightline.intersectBox(u.fadeBox, sightHit);
    const goal = hit && hit.distanceTo(sightline.origin) < reach && !u.fadeBox.containsPoint(sightEnd) ? FADED : 1;
    if (u.fade === goal) continue;
    u.fade = Math.abs(goal - u.fade) < 0.01 ? goal : u.fade + (goal - u.fade)*FADE_EASE;
    piece.traverse(o => {
      if (!o.isMesh) return;
      if (u.fade === 1) { if (o.userData.ownMaterial) { o.material = o.userData.ownMaterial; delete o.userData.ownMaterial; } return; }
      if (!o.userData.ownMaterial) {
        o.userData.ownMaterial = o.material;
        o.material = o.material.clone();
        o.material.transparent = true;
      }
      o.material.opacity = o.userData.ownMaterial.opacity*u.fade;
    });
  }
}

// Each frame: the view eased wider inside a room, and back to its usual angle outside.
export function updateInteriorCamera() {
  updateTV();
  updateLamp();
  updateDoor();
  if (inside && eyeHeight !== eyeGoal) eyeHeight = Math.abs(eyeGoal - eyeHeight) < 0.002 ? eyeGoal : eyeHeight + (eyeGoal - eyeHeight)*RISE_EASE;
  fadeWhatsInTheWay();
  occupants = counting; counting = 0;
  if (inside && current === LAYOUTS.office && performance.now() - occupiedAt < 1000) {
    officeAmbience({ printer: current.printer, desks: current.desks, centre: room.localToWorld(new THREE.Vector3(0, 1, 0)), people: occupants });
  }
  const goal = inside ? viewFov() : (App.ridingFov?.() ?? BASE_FOV*(App.boostFovScale?.() ?? 1)); // (riding a train carriage sets its own: see trains.js; boosting widens it: see life/traffic/driving.js)
  if (camera.fov === goal) return;
  camera.fov = Math.abs(goal - camera.fov) < 0.05 ? goal : camera.fov + (goal - camera.fov)*FOV_EASE;
  camera.updateProjectionMatrix();
}

export const isInsideBuilding = () => !!inside;
export const buildingInside = () => inside?.group ?? null;

// ---------------------------------------------------------- who's in the room
// Whoever's inside the building (see "going indoors" in people.js) is only drawn while the room's there to be drawn in,
// standing about it and now and then wandering over to somewhere else in it — never through the furniture (the layout's
// `blocked`).
const ROOM_MARGIN = 0.5;                                                                   // from the walls
const clearOfFurniture = (x, z) => current.blocked.every(b => x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1);
const clearOfDoor = (x, z) => x > -ROOM_W/2 + DOOR_W + 0.4 || z < doorFrom - 0.4 || z > doorTo + 0.4;

/** Whether the room's set up in the building with this key (buildingKey) right now. */
export const roomHolds = key => !!inside && inside.key === key;
/** Which time the room's been set up this is: someone placed in it on an earlier visit needs placing again. */
export const roomVisit = () => visits;
// A spot to stand in the room, in the world, from `rng`: clear of the furniture, and out of the door's way.
export function roomSpot(rng) {
  let x = 0, z = 0;
  for (let tries = 0; tries < 40; tries++) {
    x = -ROOM_W/2 + ROOM_MARGIN + rng()*(ROOM_W - ROOM_MARGIN*2);
    z = -ROOM_D/2 + ROOM_MARGIN + rng()*(ROOM_D - ROOM_MARGIN*2);
    if (clearOfFurniture(x, z) && clearOfDoor(x, z)) break;
  }
  return room.localToWorld(new THREE.Vector3(x, 0, z));
}

// The way in and out of the room: just inside its door (see "the door", above), and the dark beyond it — where anyone
// coming in steps out of and anyone going steps off into, the door swinging open for them (see aboutTheRoom and
// leaveRoom in peopleActivities.js).
const DOORWAY = new THREE.Vector3(-ROOM_W/2 + 0.3, 0, DOOR_Z), BEYOND = new THREE.Vector3(-ROOM_W/2 - RECESS + 0.2, 0, DOOR_Z);
/** The room's doorway, just inside it, in the world. */
export const roomDoorway = () => room.localToWorld(DOORWAY.clone());
/** Through the room's door, in the dark beyond it, in the world. */
export const roomBeyondDoor = () => room.localToWorld(BEYOND.clone());

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
