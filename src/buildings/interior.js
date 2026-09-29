import * as THREE from 'three';
import { camera, scene, renderer, STENCIL_ROOM_SHADOW } from '../core/scene.js';
import { S, App, buildingHolders } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { possession } from '../life/possession.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { footprintBounds, pubStyleOf, homeSuiteOf } from './footprints.js';
import { hashNameToNumber, mulberry32, pointInPolygon } from '../core/math.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { setCutout } from '../ui/pixelation.js';
import { cards } from '../ui/entity-card.js';
import { isMuted, playSound, setIndoors } from '../audio/sfx.js';
import { officeAmbience, resetOfficeAmbience } from '../audio/office.js';
import { pubMusic, stopPubMusic } from '../audio/pub-music.js';
import { loadingTask, loadingSay } from '../ui/loading.js';
import { loadBarbot, placeBarbot, updateBarbot, barbotWarmUp } from './barbot.js';
import { placeJukebox, updateJukebox } from './jukebox.js';
import { loadSalonBot, placeSalonBot, salonBotReach, clearSalonBots, updateSalonBots, salonBotWarmUp } from './salonbot.js';

// ============================================================ going inside a building
// Every building has the same inside: one room (furnished one of a few ways), built once and moved to whichever building's
// being looked into. It goes where the building actually stands, on its top floor, turned square to its longest wall, and
// the building itself isn't drawn while you're in there — so the windows look out on the real city around it, traffic,
// weather, time of day and all, with nothing to fake. The view's from up by the ceiling, looking at the middle of the
// room, and dragging takes it round the walls, keeping to them, and up and down them — starting from the corner that looks across at the two
// far walls and their windows (the other two are blank, and thick, for the sun's shadows: see below).
// The room's sized for each building as it's gone into (see shapeRoom): about as big as the building's footprint, within
// what its layout takes, and a little more or less by its key, so no two rooms are quite alike.
let ROOM_W = 8, ROOM_D = 6;                  // along the room's own x and z (x the longer, or square)
let SUITE = null;                            // a home's bedroom through one of its walls, or null (see "the bedroom")
let EXTENT;                                  // the room and any bedroom, walls and all, as a rectangle (see shapeRoom)
const ROOM_H = 3.2;                          // floor to ceiling
// The sun's shadow is coarse (its bias lets light through anything within ~0.4 of what's casting it: see scene.js), so the
// walls and ceiling cast from their outer faces rather than three.js's usual inner ones (shadowSide, below), and they're
// far thicker than a real building's, with the ceiling reaching out past the walls behind the camera — anything less lets
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

const modelsLoading = []; // (each furniture set's load, waited on by the warm-up below)
const room = new THREE.Group();
room.name = 'Interior';
room.visible = false;
scene.add(room);

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.95 });
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x9a7452, roughness: 0.8 });
const CEILING = 0xf4f1ea; // (a pub's is stained: see LAYOUTS.pub.ceiling)
const ceilingMaterial = new THREE.MeshStandardMaterial({ color: CEILING, roughness: 1 });
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
  material.defines = { ...material.defines, NO_LAMPLIGHT: '', ROOM_LAMP: '' };
  return material;
}
// Whoever's in the room is lit by the same glow — people, their hair and clothes (and any bee that's got in): every
// toon-shaded material, chunk-patched as streetlights.js does it, gets ambient light enough to match ROOM_GLOW (an
// emissive k reads as irradiance kπ on a Lambert surface) wherever it's inside the room's box. Out of it, or with no
// room up, nothing — or at night they're left in the dimmed sky's light alone, far darker than the room around them.
class SharedMatrix4 extends THREE.Matrix4 { clone() { return this; } }
class SharedVector3 extends THREE.Vector3 { clone() { return this; } } // (every material sees the one value)
const roomGlowUniforms = { roomGlow: { value: new SharedVector3() }, roomFromWorld: { value: new SharedMatrix4() },
  roomReach: { value: new SharedVector3() } }; // (half the room's width, its height and half its depth, and a little over)
Object.assign(THREE.ShaderLib.toon.uniforms, roomGlowUniforms);
THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#ifdef TOON
uniform vec3 roomGlow;
uniform mat4 roomFromWorld;
uniform vec3 roomReach;
#endif
`;
THREE.ShaderChunk.lights_fragment_maps += /* glsl */`
#if defined( RE_IndirectDiffuse ) && defined( TOON )
if ( roomGlow.r > 0.0 ) {
  vec3 inRoom = ( roomFromWorld * vec4( ( -vViewPosition ) * mat3( viewMatrix ) + cameraPosition, 1.0 ) ).xyz;
  if ( all( lessThan( abs( inRoom.xz ), roomReach.xz ) ) && inRoom.y > -0.5 && inRoom.y < roomReach.y ) irradiance += roomGlow;
}
#endif
`;
// (set as the room goes up and comes down: see enterBuilding and leaveBuilding)
function setRoomGlow(on) {
  roomGlowUniforms.roomGlow.value.setScalar(on ? ROOM_GLOW*Math.PI : 0);
  if (on) roomGlowUniforms.roomFromWorld.value.copy(room.matrixWorld).invert();
  roomGlowUniforms.roomReach.value.set(Math.max(-EXTENT.x0, EXTENT.x1), ROOM_H + 0.5, Math.max(-EXTENT.z0, EXTENT.z1));
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
// Everything below that's the room's size is built by a function of its own, run once here and again by shapeRoom for
// each building's size — into groups that stay put, emptied first (clearOut), so what shows or hides them keeps working.
function clearOut(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse(o => o.geometry?.dispose());
  }
}
// the floor, the ceiling, the walls behind the camera and the doorway: the same in every room
const bare = new THREE.Group();
room.add(bare);
// the camera sits in the (-x, -z) corner, so the windows are in the +x and +z walls, facing it: the far walls' lengths
// and windows (about one every 2.4m)
let FAR_X, FAR_Z;
// The far walls come two ways, one shown at a time (see enterBuilding): punched through with windows (every home, and
// now and then an office) or, in most offices, glass floor to ceiling.
const punched = new THREE.Group(), curtain = new THREE.Group();
room.add(punched, curtain);
// (each punched wall, and the wall behind the camera along x, in a group of its own: a bedroom's doorway wall stands in
// for whichever one it's through — see "the bedroom")
const farX = new THREE.Group(), farZ = new THREE.Group(), backWall = new THREE.Group();
punched.add(farX, farZ);
room.add(backWall);
let SLAB_W, SLAB_D; // (the floor's slab: see buildShell)
// (or, in a shop, blank: its window's its shopfront, in the wall with the door — see `shopfront`, below)
const blankWalls = new THREE.Group();
blankWalls.visible = false;
room.add(blankWalls);
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
let COLUMNS;
/** The chance an office has windows punched through its walls, as a home does, rather than glass floor to ceiling. */
const OFFICE_PUNCHED = 0.1;
/** The chance a pub's room has a shopfront in the wall with the door, as a shop's does (see `shopfront`), rather than
 * windows in its far walls. */
const PUB_SHOPFRONT = 0.5;
// a number from 0 up to 1 for a building's key, the same every time (and unlike its number, which picks home or office),
// and different for each `salt`
function keyFraction(key, salt = ':walls') {
  let h = 2166136261;
  for (const ch of String(key) + salt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0)/2**32;
}
// The other wall behind the camera, along z, has the room's door in it, by the corner the camera starts in: a doorway
// some way into the wall, black at the back — where anyone coming in comes from, and anyone going goes — with a door hung
// in it that swings in to let them through (see openRoomDoor).
const DOOR_W = 0.9, DOOR_H = 2.1, DOOR_IN = 1, RECESS = 0.5;   // the doorway: how far along the wall, how deep
let DOOR_Z, doorFrom, doorTo;
const doorBlack = new THREE.MeshBasicMaterial({ color: 0x000000 });
// The rest of that wall, past the door: solid (with the thick wall behind it all along), or in a shop (a salon or a
// clothes shop: see `shopfront` on its layout) its shopfront, on the street — past a pier beside the door, glass the rest
// of the way, from a low stallriser up to a deep fascia, split into bays by thin mullions — with its far walls blank
// (blankWalls, above).
const doorWall = new THREE.Group(), shopfront = new THREE.Group();
shopfront.visible = false;
room.add(doorWall, shopfront);
const SHOPFRONT_PIER = 0.35, SHOPFRONT_RISER = 0.35, SHOPFRONT_TOP = 2.75, SHOPFRONT_BAYS = 2;
let shopfrontFrom; // (where the glass starts, along z; it runs on to the far wall)
// the shopfront's glass: from its stallriser, or from the dado rail's height in a room with one (so the rail doesn't
// run across the glass)
let lowGlass, dadoGlass;
const shopfrontGlass = high => { lowGlass.visible = !high; dadoGlass.visible = high; };
function buildShell() {
  for (const group of [bare, farX, farZ, backWall, curtain, blankWalls, doorWall, shopfront]) clearOut(group);
  // (the floor's slab stops WALL past the room all round — flush with the far walls' outer faces and a shopfront's glass,
  // so it doesn't poke out under the windows — and under the wall into a bedroom, where the bedroom's own floor takes over:
  // see "the bedroom")
  SLAB_W = ROOM_W + WALL*2; SLAB_D = ROOM_D + WALL*2;
  box(SLAB_W, SLAB, SLAB_D, floorMaterial, 0, -SLAB/2, 0, bare);
  // (the ceiling stops flush with the far walls — any further and it'd shade their windows — but reaches on past the thick
  // ones behind the camera)
  // (or, with a bedroom through the wall behind the camera, stops at it, where the bedroom's own takes over)
  const ceilW = ROOM_W/2 + WALL + ROOM_W/2 + THICK + OVERHANG;
  const ceilD = ROOM_D/2 + WALL + ROOM_D/2 + (SUITE?.side === '-z' ? WALL : THICK + OVERHANG);
  box(ceilW, THICK, ceilD, ceilingMaterial, ROOM_W/2 + WALL - ceilW/2, ROOM_H + THICK/2, ROOM_D/2 + WALL - ceilD/2, bare);
  FAR_X = [ROOM_W + WALL*2, Math.max(1, Math.round(ROOM_W/2.4))];
  FAR_Z = [ROOM_D, Math.max(1, Math.round(ROOM_D/2.4))];
  wall(...FAR_X, 0, ROOM_D/2 + WALL/2, 0, WALL, farX);       // far, along x
  wall(...FAR_Z, ROOM_W/2 + WALL/2, 0, Math.PI/2, WALL, farZ); // far, along z
  wall(FAR_X[0], 0, 0, ROOM_D/2 + WALL/2, 0, WALL, blankWalls);
  wall(FAR_Z[0], 0, ROOM_W/2 + WALL/2, 0, Math.PI/2, WALL, blankWalls);
  COLUMNS = [[ROOM_W/2, ROOM_D/2], [-ROOM_W/2 + COLUMN/2, ROOM_D/2], [ROOM_W/2, -ROOM_D/2 + COLUMN/2]];
  for (const [cx, cz] of COLUMNS) box(COLUMN, ROOM_H, COLUMN, concreteMaterial, cx, ROOM_H/2, cz, curtain);
  // (along the same lines as the punched walls, from inside the walls behind the camera to the far corner; the one along
  // z runs the other way along itself, turned as it is)
  curtainWall(ROOM_W + WALL, 0, ROOM_D/2 + WALL/2, 0, -ROOM_W/2 + COLUMN, ROOM_W/2 - COLUMN/2);
  curtainWall(ROOM_D + WALL, ROOM_W/2 + WALL/2, 0, Math.PI/2, -ROOM_D/2 + COLUMN/2, ROOM_D/2 - COLUMN);
  wall(ROOM_W + THICK*2, 0, 0, -ROOM_D/2 - THICK/2, 0, THICK, backWall);  // behind the camera
  DOOR_Z = -ROOM_D/2 + DOOR_IN;
  doorFrom = DOOR_Z - DOOR_W/2; doorTo = DOOR_Z + DOOR_W/2;
  box(RECESS, ROOM_H, doorFrom + ROOM_D/2, wallMaterial, -ROOM_W/2 - RECESS/2, ROOM_H/2, (doorFrom - ROOM_D/2)/2, bare);
  box(RECESS, ROOM_H - DOOR_H, DOOR_W, wallMaterial, -ROOM_W/2 - RECESS/2, (DOOR_H + ROOM_H)/2, DOOR_Z, bare);
  box(0.02, DOOR_H, DOOR_W, doorBlack, -ROOM_W/2 - RECESS + 0.02, DOOR_H/2, DOOR_Z, bare);
  box(THICK - RECESS, ROOM_H, ROOM_D, wallMaterial, -ROOM_W/2 - RECESS - (THICK - RECESS)/2, ROOM_H/2, 0, doorWall);
  box(RECESS, ROOM_H, ROOM_D/2 - doorTo, wallMaterial, -ROOM_W/2 - RECESS/2, ROOM_H/2, (doorTo + ROOM_D/2)/2, doorWall);
  shopfrontFrom = doorTo + SHOPFRONT_PIER;
  const x = -ROOM_W/2 - RECESS/2, len = ROOM_D/2 - shopfrontFrom, z = (shopfrontFrom + ROOM_D/2)/2;
  box(THICK - RECESS, ROOM_H, shopfrontFrom + ROOM_D/2, wallMaterial, -ROOM_W/2 - RECESS - (THICK - RECESS)/2, ROOM_H/2, (shopfrontFrom - ROOM_D/2)/2, shopfront);
  box(RECESS, ROOM_H, SHOPFRONT_PIER, wallMaterial, x, ROOM_H/2, doorTo + SHOPFRONT_PIER/2, shopfront);
  box(RECESS, ROOM_H - SHOPFRONT_TOP, len, wallMaterial, x, (SHOPFRONT_TOP + ROOM_H)/2, z, shopfront);
  box(RECESS + 0.04, 0.1, len, frameMaterial, x, SHOPFRONT_TOP, z, shopfront);     // the transom
  // below it, the glass from a stallriser `riser` high: low, or (see shopfrontGlass) as high as a dado rail — about
  // one bay every 2.4m
  const bays = Math.max(SHOPFRONT_BAYS, Math.round(len/2.4));
  for (const riser of [SHOPFRONT_RISER, SILL - 0.05]) {
    const glazing = new THREE.Group(), glassH = SHOPFRONT_TOP - riser, mid = (riser + SHOPFRONT_TOP)/2;
    shopfront.add(glazing);
    box(RECESS, riser, len, wallMaterial, x, riser/2, z, glazing);
    box(0.02, glassH, len, glassMaterial, x, mid, z, glazing);
    box(RECESS + 0.08, 0.08, len, frameMaterial, x, riser, z, glazing);  // the sill
    for (let i = 0; i <= bays; i++) box(RECESS + 0.04, glassH, 0.07, frameMaterial, x, mid, shopfrontFrom + 0.035 + i*(len - 0.07)/bays, glazing);
  }
  [lowGlass, dadoGlass] = shopfront.children.slice(-2);
  lowGlass.visible = false;
  door.position.set(-ROOM_W/2 - 0.03, 0, doorFrom);
}
// the door, on its hinge at the corner end of the doorway (put there by buildShell), and a knob on it
const door = new THREE.Group();
room.add(door);
buildShell();
const DOOR_OPEN = THREE.MathUtils.degToRad(95), DOOR_HOLD = 1500, DOOR_EASE = 0.12; // how far, for how long (ms), how quickly
const doorMaterial = roomLit(new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
box(0.05, DOOR_H - 0.01, DOOR_W - 0.01, doorMaterial, 0, DOOR_H/2, DOOR_W/2, door);
box(0.12, 0.05, 0.05, frameMaterial, 0, 1, DOOR_W - 0.1, door);
let doorOpenUntil = -Infinity;
/** Swing the room's door open (or keep it open) for someone coming or going through it: it shuts on its own after. */
export const openRoomDoor = () => { doorOpenUntil = performance.now() + DOOR_HOLD; };
// each frame: the door eased open or shut, heard as it opens and clicking as it shuts
function updateDoor() {
  const goal = performance.now() < doorOpenUntil ? DOOR_OPEN : 0, was = door.rotation.y;
  if (was === goal) return;
  door.rotation.y = Math.abs(goal - was) < 0.01 ? goal : was + (goal - was)*DOOR_EASE;
  if (was === 0 || door.rotation.y === 0) playSound(was === 0 ? 'door' : 'latch', room.localToWorld(new THREE.Vector3(-ROOM_W/2, 1, DOOR_Z)));
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
  // (what `build` adds is the room's size, so it's built again as the room's sized: see shapeRoom)
  const fixtures = new THREE.Group();
  group.add(fixtures);
  const add = (w, h, d, material, x, y, z) => box(w, h, d, material, x, y, z, fixtures);
  const blocked = build(add);
  // (solid: what nobody walks through, as against blocked, where nobody stops; seats: where anyone can sit — see roomSeats)
  LAYOUTS[name] = { name, group, floor: new THREE.Color(floor), wall: new THREE.Color(0xe8e2d6), blocked, solid: blocked, seats: [],
    refit: () => { clearOut(fixtures); build(add); } };
}
const around = (x0, x1, z0, z1, pad = 0.45) => ({ x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad });

// a home: furnished afresh for each building from the interior model (see "a home's furniture", below)
layout('home', 0x9a7452, () => []);

// an office: strip lights in the ceiling, bright in any light, and furnished afresh for each building from the office
// model (see "an office's furniture", below)
layout('office', 0x6f7478, add => {
  const light = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfffbf0, emissiveIntensity: 0.9 });
  // (in rows about 2.6m apart along x and 2.8m along z, as the 8 by 6 room had them)
  const nx = Math.max(2, Math.round(ROOM_W/2.6)), nz = Math.max(2, Math.round(ROOM_D/2.8));
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const lx = -ROOM_W/2 + 1.4 + (ROOM_W - 2.2)*i/(nx - 1), lz = -ROOM_D/2 + 1.8 + (ROOM_D - 3.2)*k/(nz - 1);
    add(1.2, 0.03, 0.3, light, lx, ROOM_H - 0.015, lz);
  }
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
    for (let x = -2*Math.floor(ROOM_W/4); x <= ROOM_W/2 - 1; x += 2) {
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
  dado.visible = !!current.industrial || !!current.panelled;
  shopfrontGlass(dado.visible);
  paintRoom();
}
function paintRoom() {
  floorMaterial.color.copy(current.floor);
  wallMaterial.color.copy(current.wall);
  ceilingMaterial.color.setHex(current.ceiling ?? CEILING);
  roomLit(floorMaterial); roomLit(wallMaterial); roomLit(ceilingMaterial);
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
    console.warn('Kallipolis: the interior model failed to load; homes are left bare', err);
    return;
  }
  measureParts(pieces);
  if (!['TV', 'Sofa', 'Coffee_Table'].every(name => pieces[name])) {
    console.warn('Kallipolis: the interior model is missing its TV, sofa or coffee table; homes are left bare');
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
  // (a fireplace with logs but no Fire of its own, the posh one, burns with flames: see "the fire")
  const logs = part(pieces.Fireplace, 'Log');
  if (logs && !part(pieces.Fireplace, 'Fire')) pieces.Fireplace.hearth = logs;
}
// lit like the rest of the room (see roomLit), but for the lamp's bulb (and a pub's fire, and whatever else it has that's
// lit from within: its Glow materials), which glows anyway, the glass, and the TV's screen
function furnitureLit(material) {
  if (material.name === 'Screen') {
    material.color.setHex(SCREEN_COLOR);
    material.emissive.setHex(SCREEN_GLOW);
    material.emissiveIntensity = 1;
  } else if (material.name !== 'Light' && material.name !== 'Fire' && !material.name.startsWith('Glow') && !material.transparent) {
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
modelsLoading.push(loadFurniture());

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
    console.warn('Kallipolis: the posh interior model failed to load; posh homes are furnished as any other', err);
    return;
  }
  measureParts(posh);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
modelsLoading.push(loadPosh());

// The posh room's woodwork, built once and shown for posh homes: skirting, raised panels up to a dado rail, and a stepped
// crown moulding, round all four walls (but for the doorway, which gets a casing), each a strip `depth` out from the wall.
const trim = new THREE.Group();
trim.visible = false;
room.add(trim);
const trimMaterial = lit(POSH_TRIM[0], 0.6), drapeMaterial = lit(DRAPES[0], 1), poleMaterial = lit(0xc09040, 0.4);
// the walls' inner faces: along x or z, where, and which way the room is from them
let WALL_FACES;
function strip(face, a, b, y, h, depth, material = trimMaterial) {
  const out = face.at + face.n*depth/2, mid = (a + b)/2;
  const mesh = face.alongX ? box(b - a, h, depth, material, mid, y, out, trim) : box(depth, h, b - a, material, out, y, mid, trim);
  mesh.castShadow = false;
  return mesh;
}
// Curtains either side of each of the far walls' windows, hung from a pole over it and tied back to the wall either side,
// so each is gathered in at the tie and spreads out above and below it (which reads as curtains from its outline alone,
// with the room lit as flatly as it is): each a group, with the rectangle it stands on (shown in each posh home unless
// the TV's in front of it: see furnish).
const drapes = [];
// (all of it built again for each size of room: see shapeRoom)
function buildTrim() {
clearOut(trim);
drapes.length = 0;
WALL_FACES = [{ alongX: true, at: ROOM_D/2, n: -1 }, { alongX: false, at: ROOM_W/2, n: -1 },
  { alongX: true, at: -ROOM_D/2, n: 1 }, { alongX: false, at: -ROOM_W/2, n: 1 }];
// (the wall through to any bedroom, and its doorway along it: see "the bedroom")
const through = SUITE && WALL_FACES[{ '+z': 0, '+x': 1, '-z': 2 }[SUITE.side]];
const [openFrom, openTo] = !SUITE ? [] : through.alongX ? [SUITE.doorway.x0, SUITE.doorway.x1] : [SUITE.doorway.z0, SUITE.doorway.z1];
for (const face of WALL_FACES) {
  const half = face.alongX ? ROOM_W/2 : ROOM_D/2;
  const runs = face === through ? [[-half, openFrom - 0.08], [openTo + 0.08, half]]
    : face.alongX || face.n < 0 ? [[-half, half]] : [[-half, doorFrom - 0.08], [doorTo + 0.08, half]];
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
// the doorways' casings
for (const [face, from, to] of [[WALL_FACES[3], doorFrom, doorTo], ...SUITE ? [[through, openFrom, openTo]] : []]) {
  strip(face, from - 0.08, from, (DOOR_H + 0.08)/2, DOOR_H + 0.08, 0.03);
  strip(face, to, to + 0.08, (DOOR_H + 0.08)/2, DOOR_H + 0.08, 0.03);
  strip(face, from - 0.08, to + 0.08, DOOR_H + 0.04, 0.08, 0.035);
}
{
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
    if (face === through) continue; // (no windows in it)
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
}
buildTrim();

// The posh floors, as textures (plank-grey parquet for the floor's colour to tint, or a marble chequer), laid across the
// floor's slab (see buildShell) at their real size, however big the room: set again as it's sized (fitFloors).
const floorTextures = [];
function fitFloors() {
  for (const { texture, metres } of floorTextures) texture.repeat.set(SLAB_W/metres, SLAB_D/metres);
}
function floorTexture(size, metres, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), mulberry32(7));
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  floorTextures.push({ texture, metres });
  fitFloors();
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
    console.warn('Kallipolis: the student interior model failed to load; student flats are furnished as any other home', err);
    return;
  }
  measureParts(student);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
modelsLoading.push(loadStudent());
// Bare floorboards: planks 15 cm wide and about 1.2 m long, each one flat shade, two to a row with the rows' joints
// staggered — which repeats every 2.4 m both ways. A plank running off one side of the tile carries on from the other,
// so it's drawn at both, in the one shade.
const boards = floorTexture(1024, 2.4, (g, rng) => {
  const ROWS = 16, row = 1024/ROWS;
  for (let r = 0; r < ROWS; r++) {
    const start = Math.floor(rng()*16)*64, mid = start + (6 + Math.floor(rng()*5))*64;
    for (const [a, b] of [[start, mid], [mid, start + 1024]]) {
      const shade = 212 + rng()*38;
      g.fillStyle = `rgb(${shade},${shade},${shade})`;
      for (const x of [a - 1024, a]) g.fillRect(x, r*row, b - a, row);
      g.fillStyle = 'rgba(40,25,15,0.4)';
      for (const x of [a - 1024, a, a + 1024]) g.fillRect(x - 1, r*row, 3, row);
    }
    g.fillStyle = 'rgba(40,25,15,0.35)';
    g.fillRect(0, r*row - 1, 1024, 2);
  }
  g.fillRect(0, 1024 - 1, 1024, 2); // (the other half of the top row's joint, where the tile wraps)
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
    console.warn('Kallipolis: the mid-century interior model failed to load; mid-century homes are furnished as any other', err);
    return;
  }
  measureParts(retro);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
modelsLoading.push(loadRetro());
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
    console.warn('Kallipolis: the bohemian interior model failed to load; bohemian homes are furnished as any other', err);
    return;
  }
  measureParts(boho);
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
modelsLoading.push(loadBoho());

// ---------------------------------------------------------- the kitchen
// Every home with room for it has a fitted kitchen in a corner (assets/models/Kitchen.glb, built by tools/kitchen-models.py:
// one piece, an L of units with the fridge, oven, hob, microwave, sink, toaster and kettle). Its long leg, with the
// fridge and the wall cupboards, goes against a wall behind the camera; its short leg, low all along, out along the far
// wall at that one's end, under its windows: in the (+x, -z) corner as it's built, or mirrored into the (-x, +z) corner,
// its long leg along the door's wall. Recoloured for each home, as the rest of the furniture is, its cupboards in the
// room's own wood.
const KITCHEN_MODEL_URL = 'assets/models/Kitchen.glb';
const KITCHEN_LEG = 0.66;   // how deep the units are (the fridge, the deepest), from the wall
const KITCHEN_PAINTED = {
  Cabinet: [0xece8de, 0xf4f2ee, 0x3a4a5a, 0x7a8a6a, 0xb8c4c8, 0xc8a878, 0x2a2a2c, 0x9a3a2e, 0xd8ccb4],
  Worktop: [0x3a3632, 0x1c1c1e, 0xc89a5a, 0xe8e4dc, 0x8a8a88, 0x5a4a3a],
  Tiles: [0xf2f0ea, 0xd8e4e8, 0x2a4a6a, 0x5a8a7a, 0xe8d8b0, 0x3a3a3c, 0xc8a8a0],
  Appliance: [0xf2f2f0, 0xf2f2f0, 0xa8acb0, 0x2a2a2c],
  Kettle: [0xd83a2a, 0xf2f0ea, 0x2a2a2c, 0xa8acb0, 0x3a7ac8, 0xe8c040],
  Toaster: [0xe8e4dc, 0xa8acb0, 0xd83a2a, 0x2a2a2c, 0xa8d0c0],
};
let kitchen = null;
const kitchenPainted = [];
// Its floor's tiled, over the whole of the L's footprint (inside the L too): 30 cm squares, each a slightly different
// shade, tinted per home; a patch laid just over the room's floor (under the furniture's shadows, at SHADOW_Y).
const KITCHEN_TILE = 0.3;
const KITCHEN_FLOORS = [0xf2f0ea, 0xd8d4cc, 0x9a9a98, 0xc87a5a, 0x3a3a3c, 0xe8dcc0, 0xa8b8b8];
const kitchenTiles = (() => {
  const canvas = document.createElement('canvas'), size = 512, tile = size/2, rng = mulberry32(11);
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const shade = 228 + rng()*24;
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.fillRect(i*tile, j*tile, tile, tile);
  }
  g.fillStyle = 'rgba(70,65,60,0.45)';
  for (let k = 0; k <= 2; k++) { g.fillRect(k*tile - 2, 0, 4, size); g.fillRect(0, k*tile - 2, size, 4); }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
})();
const kitchenFloorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.45, map: kitchenTiles, emissiveMap: kitchenTiles,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
const kitchenFloor = new THREE.Mesh(new THREE.BufferGeometry(), kitchenFloorMaterial);
kitchenFloor.receiveShadow = true;
// the patch over the rectangle `r` of the room's floor, its tiles square to the walls from its (x0, z0) corner (or
// `mesh`, some other patch of them: an ensuite's, see "the bedroom")
function layKitchenFloor(r, mesh = kitchenFloor) {
  mesh.geometry.dispose();
  const w = r.x1 - r.x0, d = r.z1 - r.z0, geometry = new THREE.PlaneGeometry(w, d);
  geometry.rotateX(-Math.PI/2);
  const uv = geometry.attributes.uv, position = geometry.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (position.getX(i) + w/2)/(KITCHEN_TILE*2), (position.getZ(i) + d/2)/(KITCHEN_TILE*2));
  mesh.geometry = geometry;
  mesh.position.set((r.x0 + r.x1)/2, 0.004, (r.z0 + r.z1)/2);
}
async function loadKitchen() {
  try {
    kitchen = await loadPieces(KITCHEN_MODEL_URL, KITCHEN_PAINTED, kitchenPainted);
  } catch (err) {
    console.warn('Kallipolis: the kitchen model failed to load; homes have no kitchens', err);
    return;
  }
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
modelsLoading.push(loadKitchen());

// ---------------------------------------------------------- the bedroom
// About half of homes (see homeSuiteOf in footprints.js) have a bedroom beyond one of the living room's walls but the
// door's — a far wall (+x or +z) or the other wall behind the camera (-z) — through an open doorway in it, with an
// ensuite at one end behind a partition, through a doorway of its own: a double bed with a bedside table either side,
// a wardrobe or two and a dresser against its walls; a toilet, a basin and a shower in the ensuite
// (assets/models/Bedroom.glb, built by tools/bedroom-models.py). The living room's made smaller to leave room for it, and
// the two are centred on the building together (see enterBuilding). The bedroom's worked out in its own terms: u along
// the wall it's through, v out from that wall's far face into it (see planSuite) — and built into `suite`, turned and
// moved to match. It's carpeted, its ensuite tiled as the kitchen is, in colours of their own for each home, and its
// furniture's in the room's wood.
const BEDROOM_MODEL_URL = 'assets/models/Bedroom.glb';
const SUITE_DOOR = 1.0;                              // the doorway through to it, wide open
const ENSUITE = 1.8, PARTITION = 0.12;               // the ensuite's width, along the wall, and the wall between
const ENSUITE_DOOR = [0.2, 1.05];                    // its doorway in the partition: from and to, out from the wall
const BEDROOM_PAINTED = {
  Wood: WOODS,
  Duvet: [0x5a7ab0, 0xe8e4dc, 0xc8603e, 0x3e6a4e, 0xd8a8b0, 0x34466a, 0xe0c060, 0x8a8c8e, 0x7a4868],
  Sheet: [0xf2f0ea, 0xf4f2ee, 0xe8e4dc, 0xdce4ec, 0xece2d0],
  Headboard: [0x8a8c8e, 0x3c4a6e, 0x5a3c2a, 0xc8b8a0, 0x2f7474, 0x89666e, 0x3a3a3c],
  Shade: SHADES,
};
const BEDROOM_FLOORS = [0xc8bca8, 0xa89c88, 0x8a8c90, 0xd8ccb4, 0x6a7a8a, 0x9a8a78, 0xb8a898, 0x5a6a5a];
let bedroom = null;
const bedroomPainted = [];
async function loadBedroom() {
  try {
    bedroom = await loadPieces(BEDROOM_MODEL_URL, BEDROOM_PAINTED, bedroomPainted);
  } catch (err) {
    console.warn('Kallipolis: the bedroom model failed to load; bedrooms are left bare', err);
    return;
  }
  // (the shower's glass, frosted: see-through, a little)
  for (const piece of Object.values(bedroom)) piece.object.traverse(o => {
    for (const material of o.isMesh ? [o.material].flat() : []) if (material.name === 'Frosted') {
      Object.assign(material, { transparent: true, opacity: 0.45, depthWrite: false });
    }
  });
  if (inside && current === LAYOUTS.home) furnish(inside.key);
}
modelsLoading.push(loadBedroom());
// its shell (built again as the room's sized: see shapeRoom), and its floors
const suite = new THREE.Group();
suite.visible = false;
room.add(suite);
const bedroomFloorMaterial = roomLit(new THREE.MeshStandardMaterial({ color: BEDROOM_FLOORS[0], roughness: 1 }));
const ensuiteFloor = new THREE.Mesh(new THREE.BufferGeometry(), kitchenFloorMaterial.clone());
ensuiteFloor.receiveShadow = true;
// A home's bedroom, as its key has it (see enterBuilding): which wall it's through, how deep it is (v), which end of it
// (along u) the ensuite's at, and how far along the doorway is (0 to 1, of as far as it can go) — or null.
function suiteSpec(key) {
  const side = homeSuiteOf(key);
  if (!side) return null;
  // (behind the camera, the ensuite's at the camera's end, so the doorway's out along the wall from it)
  return { side, depth: Math.round((3.4 + keyFraction(key, ':bedroom')*0.8)*10)/10,
    end: side === '-z' || keyFraction(key, ':ensuite') < 0.5 ? 1 : -1, door: Math.round(keyFraction(key, ':doorway')*100)/100 };
}
// The bedroom for the room as it's now sized: its terms (u along the wall, v out from it: `at`, and `rect` for a
// rectangle in them, in the room's), how long it is along the wall (the room's length that way), where the bedroom
// proper, the partition and the ensuite are along it, and the doorway; how thick its walls are — windows in any facing
// the far walls' way (+x or +z), and thick and blank as the walls behind the camera are otherwise — and how far it all
// reaches (`bounds`, in the room's terms).
function planSuite({ side, depth, end: e, door }) {
  const angle = { '+x': Math.PI/2, '+z': 0, '-z': Math.PI }[side];
  const tx = Math.round(Math.cos(angle)), tz = -Math.round(Math.sin(angle)), nx = -tz, nz = tx;
  const ox = side === '+x' ? ROOM_W/2 + WALL : 0, oz = side === '+x' ? 0 : Math.sign(nz)*(ROOM_D/2 + WALL);
  const L = side === '+x' ? ROOM_D : ROOM_W;
  const at = (u, v) => ({ x: ox + tx*u + nx*v, z: oz + tz*u + nz*v });
  const rect = (u0, u1, v0, v1) => {
    const a = at(u0, v0), b = at(u1, v1);
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
  };
  const windowed = (x, z) => x > 0.5 || z > 0.5;
  const ends = [-1, 1].map(s => windowed(s*tx, s*tz) ? WALL : THICK), outer = windowed(nx, nz) ? WALL : THICK;
  const ensuite = e > 0 ? [L/2 - ENSUITE, L/2] : [-L/2, -L/2 + ENSUITE];
  const partition = e > 0 ? [ensuite[0] - PARTITION, ensuite[0]] : [ensuite[1], ensuite[1] + PARTITION];
  const bed = e > 0 ? [-L/2, partition[0]] : [partition[1], L/2];
  // (the doorway clear of the partition, and behind the camera, of the camera's corner)
  const lo = bed[0] + 0.8, hi = Math.min(bed[1] - 0.8, side === '-z' ? L/2 - 2.2 : Infinity);
  const doorU = hi > lo ? Math.round((lo + door*(hi - lo))*10)/10 : (bed[0] + bed[1])/2;
  const doorway = rect(doorU - SUITE_DOOR/2, doorU + SUITE_DOOR/2, -WALL, 0);
  return { side, depth, e, angle, ox, oz, L, at, rect, ends, outer, ensuite, partition, bed, doorU, doorway,
    bounds: rect(-L/2 - ends[0], L/2 + ends[1], -WALL, depth + outer) };
}
// its floor, ceiling and walls, and the wall through to it with the doorway (standing in for the living room's own:
// see buildShell)
function buildSuite() {
  clearOut(suite);
  suite.visible = !!SUITE;
  farX.visible = SUITE?.side !== '+z'; farZ.visible = SUITE?.side !== '+x'; backWall.visible = SUITE?.side !== '-z';
  if (!SUITE) return;
  const { L, depth, ends: [t0, t1], outer, doorU, bed, partition, ensuite } = SUITE;
  suite.position.set(SUITE.ox, 0, SUITE.oz);
  suite.rotation.y = SUITE.angle;
  const u0 = -L/2 - t0, u1 = L/2 + t1, v1 = depth + outer, add = (w, h, d, material, u, y, v) => box(w, h, d, material, u, y, v, suite);
  // (the floor flush with the walls' outer faces, as the living room's is; the ceiling on out past the thick ones)
  const past = t => t === THICK ? OVERHANG : 0;
  add(u1 - u0, SLAB, v1, bedroomFloorMaterial, (u0 + u1)/2, -SLAB/2, v1/2);
  const c0 = u0 - past(t0), c1 = u1 + past(t1), cv = v1 + past(outer);
  add(c1 - c0, THICK, cv, ceilingMaterial, (c0 + c1)/2, ROOM_H + THICK/2, cv/2);
  // the wall it's through, either side of the doorway and over it
  const a = doorU - SUITE_DOOR/2, b = doorU + SUITE_DOOR/2;
  add(a - u0, ROOM_H, WALL, wallMaterial, (u0 + a)/2, ROOM_H/2, -WALL/2);
  add(u1 - b, ROOM_H, WALL, wallMaterial, (b + u1)/2, ROOM_H/2, -WALL/2);
  add(SUITE_DOOR, ROOM_H - DOOR_H, WALL, wallMaterial, doorU, (DOOR_H + ROOM_H)/2, -WALL/2);
  // its ends, and the wall across from the doorway: windows in the bedroom's stretch of it, none in the ensuite's
  const windows = (length, t) => t === WALL ? Math.max(1, Math.round(length/2.4)) : 0;
  wall(depth, windows(depth, t0), -L/2 - t0/2, depth/2, Math.PI/2, t0, suite);
  wall(depth, windows(depth, t1), L/2 + t1/2, depth/2, Math.PI/2, t1, suite);
  const [w0, w1] = SUITE.e > 0 ? [u0, bed[0]] : [bed[1], u1], [e0, e1] = SUITE.e > 0 ? [bed[1], u1] : [u0, bed[0]];
  wall(bed[1] - bed[0], windows(bed[1] - bed[0], outer), (bed[0] + bed[1])/2, depth + outer/2, 0, outer, suite);
  add(w1 - w0, ROOM_H, outer, wallMaterial, (w0 + w1)/2, ROOM_H/2, depth + outer/2);
  add(e1 - e0, ROOM_H, outer, wallMaterial, (e0 + e1)/2, ROOM_H/2, depth + outer/2);
  // the partition, with its doorway by the wall it's through
  const [d0, d1] = ENSUITE_DOOR, pu = (partition[0] + partition[1])/2;
  add(PARTITION, ROOM_H, d0, wallMaterial, pu, ROOM_H/2, d0/2);
  add(PARTITION, ROOM_H, depth - d1, wallMaterial, pu, ROOM_H/2, (d1 + depth)/2);
  add(PARTITION, ROOM_H - DOOR_H, d1 - d0, wallMaterial, pu, (DOOR_H + ROOM_H)/2, (d0 + d1)/2);
  // and the ensuite's tiles
  layKitchenFloor({ x0: ensuite[0], x1: ensuite[1], z0: 0, z1: depth }, ensuiteFloor);
  suite.add(ensuiteFloor);
}
// Its colours for the home with this key, the bedroom furniture in `wood` (the living room's, as the kitchen's cupboards
// are), and its furniture into `home` (LAYOUTS.home, being furnished: see furnish) — nothing in front of either doorway.
function furnishSuite(key, home, wood) {
  const tint = mulberry32(hashNameToNumber(key + ' bedroom colours'));
  const pick = list => list[Math.floor(tint()*list.length)];
  for (const material of bedroomPainted) {
    material.color.setHex(pick(BEDROOM_PAINTED[material.name]));
    if (material.name === 'Wood' && wood) material.color.copy(wood.color);
    roomLit(material);
  }
  bedroomFloorMaterial.color.setHex(pick(BEDROOM_FLOORS)); roomLit(bedroomFloorMaterial);
  ensuiteFloor.material.color.setHex(pick(KITCHEN_FLOORS)); roomLit(ensuiteFloor.material);
  if (!SUITE || !bedroom) return;
  const { e, depth, bed: [b0, b1], ensuite, partition, doorU } = SUITE, rng = mulberry32(hashNameToNumber(key + ' bedroom'));
  // (rectangles in the bedroom's own terms here: x for u, z for v)
  const footprint = (piece, u, v, turn) => {
    const across = Math.abs(Math.sin(turn)) > 0.5, hu = (across ? piece.d : piece.w)/2, hv = (across ? piece.w : piece.d)/2;
    return { x0: u - hu, x1: u + hu, z0: v - hv, z1: v + hv };
  };
  const overlaps = (a, b, gap) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.z0 < b.z1 + gap && b.z0 < a.z1 + gap;
  const taken = [
    { x0: doorU - SUITE_DOOR/2 - 0.3, x1: doorU + SUITE_DOOR/2 + 0.3, z0: 0, z1: 1.1 },
    e > 0 ? { x0: partition[0] - 0.9, x1: partition[0], z0: 0, z1: ENSUITE_DOOR[1] + 0.15 }
      : { x0: partition[1], x1: partition[1] + 0.9, z0: 0, z1: ENSUITE_DOOR[1] + 0.15 },
  ];
  // (against a wall's 0.02 off it: a little less, so rounding doesn't turn it down)
  const fits = (r, gap) => r.x0 >= b0 + 0.015 && r.x1 <= b1 - 0.015 && r.z0 >= 0.015 && r.z1 <= depth - 0.015
    && taken.every(o => !overlaps(o, r, gap));
  const put = (name, u, v, turn, flip = false) => {
    const piece = bedroom[name], object = piece.object.clone(), p = SUITE.at(u, v), f = footprint(piece, u, v, turn);
    object.position.set(p.x, 0, p.z);
    object.rotation.y = SUITE.angle + turn;
    if (flip) object.scale.x = -1;
    home.group.add(object);
    taken.push(f);
    const r = SUITE.rect(f.x0, f.x1, f.z0, f.z1);
    home.solid.push(r);
    home.blocked.push(around(r.x0, r.x1, r.z0, r.z1, 0.35));
  };
  // The bedroom's walls, each facing into it: the one across from the doorway, its end away from the ensuite, the one
  // it's through, and the partition — the spot out from it for something `d` deep, and how far along it runs
  const walls = [
    { alongU: true, turn: Math.PI, out: d => depth - d/2 - 0.02, from: b0, to: b1 },
    { alongU: false, turn: e*Math.PI/2, out: d => e > 0 ? b0 + d/2 + 0.02 : b1 - d/2 - 0.02, from: 0, to: depth },
    { alongU: true, turn: 0, out: d => d/2 + 0.02, from: b0, to: b1 },
    { alongU: false, turn: -e*Math.PI/2, out: d => e > 0 ? b1 - d/2 - 0.02 : b0 + d/2 + 0.02, from: 0, to: depth },
  ];
  const spotOn = (wall, piece, s) => wall.alongU ? [s, wall.out(piece.d)] : [wall.out(piece.d), s];
  // somewhere along one of `choices` there's room for `name`, with `spare` more along the wall either side (or first at
  // `first`, along the first of them)
  const room = (name, choices, spare = 0, first = null) => {
    const piece = bedroom[name];
    for (let tries = 0; tries < 30; tries++) {
      const wall = tries === 0 && first !== null ? choices[0] : choices[Math.floor(rng()*choices.length)];
      const half = piece.w/2 + spare, span = wall.to - wall.from - half*2;
      if (span < 0) continue;
      const s = tries === 0 && first !== null ? first : wall.from + half + rng()*span;
      const [u, v] = spotOn(wall, piece, s), r = footprint(piece, u, v, wall.turn);
      const grown = wall.alongU ? { ...r, x0: r.x0 - spare, x1: r.x1 + spare } : { ...r, z0: r.z0 - spare, z1: r.z1 + spare };
      if (fits(grown, 0.05)) return { wall, s };
    }
    return null;
  };
  // the bed, its head against the wall across from the doorway (about the middle of it) or else the end wall, with a
  // bedside table either side
  const bedPiece = bedroom.Bed, side = bedroom.Bedside;
  if (bedPiece) {
    const spare = side ? side.w + 0.04 : 0;
    const spot = room('Bed', [walls[0]], spare, (b0 + b1)/2 + (rng() - 0.5)*0.5) ?? room('Bed', [walls[1]], spare);
    if (spot) {
      put('Bed', ...spotOn(spot.wall, bedPiece, spot.s), spot.wall.turn);
      if (side) for (const k of [-1, 1]) {
        const [u, v] = spotOn(spot.wall, side, spot.s + k*(bedPiece.w/2 + side.w/2 + 0.02));
        if (fits(footprint(side, u, v, spot.wall.turn), 0)) put('Bedside', u, v, spot.wall.turn);
      }
    }
  }
  // a wardrobe, or two side by side, and a dresser
  const wardrobe = bedroom.Wardrobe;
  if (wardrobe) {
    const two = rng() < 0.45, spot = (two && room('Wardrobe', walls, wardrobe.w/2 + 0.01)) || room('Wardrobe', walls);
    if (spot) {
      const pair = two && spot.wall.to - spot.wall.from > 0 && fits(grownAlong(spot, wardrobe), 0.05);
      for (const k of pair ? [-1, 1] : [0]) put('Wardrobe', ...spotOn(spot.wall, wardrobe, spot.s + k*(wardrobe.w/2 + 0.01)), spot.wall.turn);
    }
  }
  function grownAlong(spot, piece) {
    const [u, v] = spotOn(spot.wall, piece, spot.s), r = footprint(piece, u, v, spot.wall.turn), by = piece.w/2 + 0.01;
    return spot.wall.alongU ? { ...r, x0: r.x0 - by, x1: r.x1 + by } : { ...r, z0: r.z0 - by, z1: r.z1 + by };
  }
  if (bedroom.Dresser) {
    const spot = room('Dresser', walls);
    if (spot) put('Dresser', ...spotOn(spot.wall, bedroom.Dresser, spot.s), spot.wall.turn);
  }
  // and in the ensuite, the shower in the corner at its far end (its glass out into the ensuite), the toilet against
  // its end wall and the basin by the doorway
  const end = e > 0 ? ensuite[1] : ensuite[0], { Shower: shower, Toilet: toilet, Basin: basin } = bedroom;
  const facing = -e*Math.PI/2;
  if (shower) put('Shower', end - e*(shower.w/2 + 0.01), depth - shower.d/2 - 0.01, Math.PI, e < 0);
  if (toilet) put('Toilet', end - e*(toilet.d/2 + 0.02), depth - (shower ? shower.d : 0) - 0.25 - toilet.w/2, facing);
  if (basin) put('Basin', end - e*(basin.d/2 + 0.02), ENSUITE_DOOR[0] + 0.1 + basin.w/2, facing);
}

// Lays out the home for the building with this key (see buildingKey): `LAYOUTS.home`'s furniture, where nobody stands or
// walks, and its seats, in the room as it's now placed.
function furnish(key) {
  const home = LAYOUTS.home;
  home.group.clear(); // (clones, sharing the model's geometry and materials)
  home.blocked = []; home.solid = []; home.seats = [];
  home.screen = null; home.tvObject = null;
  tvClickedOn = false;
  grid = null;
  stopTV();
  home.group.add(lampLight);
  lampLight.userData.there = false;
  flames.removeFromParent();
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
  // (the kitchen's from a generator of its own too, so the rest keeps its colours — but for its cupboards, in the same
  // wood as the rest of the room's furniture)
  const kitchenTint = mulberry32(hashNameToNumber(key + ' kitchen colours'));
  const [woods, wood] = fancy ? [poshPainted, 'Walnut'] : scruffy ? [studentPainted, 'Pine'] : sixties ? [retroPainted, 'Teak']
    : leafy ? [bohoPainted, 'Wood'] : [painted, 'Wood'];
  const roomWood = woods.find(material => material.name === wood);
  for (const material of kitchenPainted) {
    const list = KITCHEN_PAINTED[material.name];
    material.color.setHex(list[Math.floor(kitchenTint()*list.length)]);
    if (material.name === 'Cabinet' && roomWood) material.color.copy(roomWood.color);
    roomLit(material);
  }
  kitchenFloorMaterial.color.setHex(KITCHEN_FLOORS[Math.floor(kitchenTint()*KITCHEN_FLOORS.length)]);
  roomLit(kitchenFloorMaterial);
  furnishSuite(key, home, roomWood);
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
    if (piece.hearth) lightFire(object, piece.hearth);
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
  // (not the wall through to a bedroom)
  const onSide = (r => SUITE?.side === '+x' ? false : SUITE?.side === '+z' ? true : r)(rng() < 0.4); // the +x wall, facing -x, or else the +z wall
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
  const screen = { ...spot }, tvObject = home.tvObject = home.group.children.at(-1);
  // (a posh home's curtains, but for any the TV's in front of)
  const tvArea = taken[0];
  for (const drape of drapes) {
    const area = drape.userData.area;
    drape.visible = !overlaps(area, tvArea, 0.05);
    if (fancy && drape.visible) { taken.push(area); home.solid.push(area); home.blocked.push(around(area.x0, area.x1, area.z0, area.z1, 0.2)); }
  }
  // the sofa, facing it a comfortable way off, with its back to the room behind
  // (and with a bedroom through the wall behind the camera, clear of the way through to it)
  const behind = SUITE?.side === '-z' ? 1.2 : 0;
  const sofaV = Math.min(tv.d + 2.3 + rng()*0.7 + sofa.d/2, depth - sofa.d/2 - 0.05 - (onSide ? 0 : behind));
  const sofaU = THREE.MathUtils.clamp(tvU + (rng() - 0.5)*0.6, -wallLength/2 + sofa.w/2 + 0.1 + (onSide ? behind : 0), wallLength/2 - sofa.w/2 - 0.1);
  // (the way through to any bedroom kept clear; its wall's got no windows, for anything that goes by them)
  if (SUITE) taken.push(SUITE.rect(SUITE.doorU - SUITE_DOOR/2 - 0.4, SUITE.doorU + SUITE_DOOR/2 + 0.4, -WALL - 1.2, -WALL));
  const suiteWall = { '+z': FAR_X, '+x': FAR_Z }[SUITE?.side], windowed = ([wall]) => wall !== suiteWall;
  const byDoorway = (u, w) => SUITE?.side === '-z' && Math.abs(u - (SUITE.doorway.x0 + SUITE.doorway.x1)/2) < w/2 + SUITE_DOOR/2 + 0.2;
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

  // the kitchen, in whichever of its two corners it fits (see "the kitchen"): its legs kept apart, so the floor inside
  // the L's still free (and from a generator of its own, so the rest of the room's laid out as it was)
  if (kitchen?.Kitchen) {
    const piece = kitchen.Kitchen, b = piece.bounds, gap = 0.03, pick = mulberry32(hashNameToNumber(key + ' kitchen'));
    // its legs in its own terms: the long one along its back (z0), the short one along its side (x1)
    const legs = [{ ...b, z1: b.z0 + KITCHEN_LEG }, { ...b, x0: b.x1 - KITCHEN_LEG }];
    const corners = [
      { x: ROOM_W/2 - gap - b.x1, z: -ROOM_D/2 + gap - b.z0, angle: 0, flip: false,
        room: (r, c) => ({ x0: r.x0 + c.x, x1: r.x1 + c.x, z0: r.z0 + c.z, z1: r.z1 + c.z }) },
      // (mirrored and turned a quarter: its x is the room's z, its z the room's x)
      { x: -ROOM_W/2 + gap - b.z0, z: ROOM_D/2 - gap - b.x1, angle: Math.PI/2, flip: true,
        room: (r, c) => ({ x0: r.z0 + c.x, x1: r.z1 + c.x, z0: r.x0 + c.z, z1: r.x1 + c.z }) },
    ];
    if (pick() < 0.5) corners.reverse();
    for (const c of corners) {
      const areas = legs.map(r => c.room(r, c));
      // (clear of the door's swing, too)
      if (c.flip && areas[0].z0 < doorTo + 0.6) continue;
      if (!areas.every(r => fits(r, 0.1)) || areas.some(hidesScreen)) continue;
      const object = piece.object.clone();
      object.position.set(c.x, 0, c.z);
      object.rotation.y = c.angle;
      if (c.flip) object.scale.x = -1;
      home.group.add(object);
      layKitchenFloor(c.room(b, c));
      home.group.add(kitchenFloor);
      for (const r of areas) {
        taken.push({ ...r, tall: true });
        home.solid.push(r);
        home.blocked.push(around(r.x0, r.x1, r.z0, r.z1, 0.35));
      }
      break;
    }
  }

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
      [FAR_Z, (u, v) => ({ x: ROOM_W/2 + v, z: -u, angle: -Math.PI/2 })]].filter(windowed)) {
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
      [FAR_Z, u => ({ x: ROOM_W/2 - 0.012, z: -u, angle: -Math.PI/2 })]].filter(windowed)) {
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
      if (hi < lo || hung.some(h => h.back === back && Math.abs(h.u - u) < (h.w + w)/2 + 0.3) || back && byDoorway(u, w)) continue;
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
      if (hi < lo || hung.some(h => h.back === back && Math.abs(h.u - u) < (h.w + art.w)/2 + 0.4) || back && byDoorway(u, art.w)) continue;
      const out = art.d/2 + 0.03;
      if (back) put(name, u, -ROOM_D/2 + out, 0, { underfoot: true });
      else put(name, -ROOM_W/2 + out, u, Math.PI/2, { underfoot: true });
      home.group.children.at(-1).position.y = 1.6 - art.h/2;
      hung.push({ back, u, w: art.w, name });
      count--;
    }
  }

  // the seats, in the world: where to sit, how high, and which way they face
  home.seats = home.seats.map(seat => {
    const w = room.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z)), n = roomWay(seat.nx, seat.nz);
    const diner = seat.diner ? { top: room.localToWorld(new THREE.Vector3(seat.x, seat.diner, seat.z)).y } : false; // (the table top's height)
    return { x: w.x, y: w.y, z: w.z, nx: n.x, nz: n.z, sofa: seat.sofa, diner, by: null };
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
    console.warn('Kallipolis: the office model failed to load; offices are left bare', err);
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
modelsLoading.push(loadOfficeFurniture());

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
  const put = (name, x, z, angle, { parent = group, y = 0, small = false, solid = null, seatKind = null } = {}) => {
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
      layout.seats.push({ x: at.x, z: at.z, y: seat.y, nx: Math.sin(angle), nz: Math.cos(angle), sofa: false, desk: deskSeats.includes(name),
        bar: name === 'BarStool', kind: seatKind }); // (sat at the bar, with the bar bot to talk to: see barbot.js)
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
    { nx: 0, nz: -1, at: u => ({ x: u, z: ROOM_D/2 }), length: ROOM_W, far: layout.shopfront ? null : FAR_X, flip: 1 },
    { nx: -1, nz: 0, at: u => ({ x: ROOM_W/2, z: u }), length: ROOM_D, far: layout.shopfront ? null : FAR_Z, flip: -1 },
    { nx: 0, nz: 1, at: u => ({ x: u, z: -ROOM_D/2 }), length: ROOM_W },
    { nx: 1, nz: 0, at: u => ({ x: -ROOM_W/2, z: u }), length: ROOM_D, glazed: !!layout.shopfront },
  ].map(side => ({ ...side, angle: Math.atan2(side.nx, side.nz) }));
  // whether something from u0 to u1 along a far wall, and taller than its windowsills, stands in front of a window (a
  // shop's shopfront's all window)
  const overWindow = (side, u0, u1) => {
    if (side.glazed) return true;
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

  // Something `r` in its own terms with its back to wall `side`, `u` along it, if it fits there: where it goes and which
  // way it faces, as againstWall has it — or null.
  const atWall = (side, u, r, gap = 0.05) => {
    const out = -r.z0 + 0.02, mid = (r.x0 + r.x1)/2, across = turned(1, 0, side.angle), wallAt = side.at(u);
    const x = wallAt.x + side.nx*out - across.x*mid, z = wallAt.z + side.nz*out - across.z*mid;
    const area = turnedRect(r, side.angle, x, z);
    return fits(area, gap) ? { x, z, angle: side.angle, area } : null;
  };

  return { taken, overlaps, inRoom, fits, put, cameraCorner, underCamera, WALL_SIDES, overWindow, againstWall, atWall, any };
}
// `layout`'s seats, from the room's terms to the world's: where to sit, how high, and which way they face
function seatsInWorld(layout) {
  layout.seats = layout.seats.map(seat => {
    const w = room.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z)), n = roomWay(seat.nx, seat.nz);
    return { x: w.x, y: w.y, z: w.z, nx: n.x, nz: n.z, sofa: false, desk: seat.desk, bar: seat.bar, kind: seat.kind ?? null, by: null,
      salonBot: seat.salonBot ?? null }; // (a styling chair's: see salonbot.js)
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
    console.warn('Kallipolis: the industrial model failed to load; warehouses and factories are left bare', err);
    return;
  }
  // (a stool's seat is its top, in the middle: sat on facing whichever way it's turned)
  if (industrial.Stool) industrial.Stool.seats = [{ x: 0, z: 0, y: industrial.Stool.h }];
  if (inside && current.industrial) furnishIndustrial(inside.key, current.kind);
}
modelsLoading.push(loadIndustrial());
// Plain concrete: mottled, with a saw-cut joint every 4 m — which is how often it repeats — or `cuts` of them across
// those 4 m, for smaller tiles.
const concreteFloor = (cuts = 1) => floorTexture(1024, 4, (g, rng) => {
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
  for (let i = 0; i < cuts; i++) { const at = Math.round(i*1024/cuts); g.fillRect(at, 0, 3, 1024); g.fillRect(0, at, 1024, 3); }
});
const concrete = concreteFloor();
// (a craft beer bar's: tiles two-thirds of a metre across)
const concreteTiles = concreteFloor(6);
LAYOUTS.warehouse.floorMap = LAYOUTS.factory.floorMap = concrete;
// The walls painted to the sills (round the door), and a yellow line along the top of it: shown in warehouses and
// factories (see useLayout), and coloured for each.
const dado = new THREE.Group();
dado.visible = false;
room.add(dado);
const LINE = 0xe8b820; // (a pub's dado rail's wood instead: see furnishPub)
const dadoMaterial = lit(DADOS[0], 0.9), lineMaterial = lit(LINE, 0.6);
const DADO_H = SILL - 0.1;
function buildDado() {
  clearOut(dado);
  for (const [w, d, x, z] of [[ROOM_W, 0.02, 0, ROOM_D/2 - 0.01], [ROOM_W, 0.02, 0, -ROOM_D/2 + 0.01], [0.02, ROOM_D, ROOM_W/2 - 0.01, 0],
    [0.02, doorFrom + ROOM_D/2, -ROOM_W/2 + 0.01, (doorFrom - ROOM_D/2)/2], [0.02, ROOM_D/2 - doorTo, -ROOM_W/2 + 0.01, (doorTo + ROOM_D/2)/2]]) {
    box(w, DADO_H, d, dadoMaterial, x, DADO_H/2, z, dado);
    box(w + (w > d ? 0 : 0.004), 0.05, d + (w > d ? 0.004 : 0), lineMaterial, x, DADO_H + 0.025, z, dado);
  }
}
buildDado();
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
  lineMaterial.color.setHex(LINE);
  roomLit(dadoMaterial); roomLit(lineMaterial);
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

// ---------------------------------------------------------- a pub
// A pub (see roomLayoutOf) has its room on the ground floor: dark oak beams across a stained ceiling, the walls panelled
// in oak to the dado rail and painted oxblood, bottle green or cream above, and a patterned carpet (or bare boards) —
// and it's fitted out from a model of its own (assets/models/Pub.glb, built by tools/pub-models.py, which lists its
// pieces), each pub its own way (from its key). Every one has its bar: the back bar against the near wall without
// windows, the counter in front of it with room to serve from between (nobody else goes back there), and bar stools along
// it. Then booths — a table between two high-backed benches, end on to a wall — a settle or two along the walls with a
// table and a stool in front, and tables out in the room with chairs or stools round them, until the room's full; maybe
// a jukebox, a barrel to stand at, a fireplace, a fruit machine and a dartboard; pictures, mirrors, a chalkboard and lamps on the
// walls, lights hung over the tables, and pints on them. Until the model's loaded, pubs are bare.
const PUB_MODEL_URL = 'assets/models/Pub.glb';
let pub = null;
const PUB_WALLS = [0x5a1a1a, 0x6a2220, 0x243a2c, 0x2e4632, 0xd8c8a0, 0xcab888, 0x2a3048, 0x7a5a2a];
const PUB_CEILINGS = [0xe0d0a8, 0xd8c498, 0xe8dcc0, 0xcdb88c];
// the boards' tint, for a pub with bare floorboards
const PUB_BOARDS = [0x7a5030, 0x5a3a22, 0x8a6a48, 0x4a3020];
const PUB_PAINTED = {
  Oak: [0x4a2c18, 0x3e2414, 0x55341c, 0x34200f, 0x5e3c22],
  Upholstery: [0x7a1e22, 0x6a1830, 0x1e4a2e, 0x2a3458, 0x8a5a1e, 0x5a2a4a],
  Leather: [0x6a2a1a, 0x3a1a12, 0x1e2a1e, 0x5a1a1a, 0x2a1a12],
  Tile: [0x2a5a4a, 0x7a2a2a, 0x2a3a6a, 0x6a5a2a, 0x3a3a3a],
};
// the panelling to the dado rail (see `dado`), and the rail
const PUB_PANELLING = [0x3e2414, 0x4a2c18, 0x34200f, 0x55341c], PUB_RAIL = 0x24140a;
const pubPainted = [];
// A craft beer bar (see pubStyleOf) is the same pieces done up loud: walls in a bright colour over a wainscot in another,
// black beams under a dark (or white) ceiling, polished concrete or pale boards, blond or painted furniture in mustard,
// teal and coral — then long tables to share, barrels to stand at, neon on the walls and strings of coloured bulbs
// across the ceiling. No carpet, no fire, no fruit machine.
const CRAFT_WALLS = [0x1f8a84, 0xe0a41e, 0xe0604a, 0x2f58c0, 0xd8508e, 0x5ec89e, 0xe8782a, 0x7a4ac0, 0xf0e6d0, 0xa8442e];
const CRAFT_WAINSCOT = [0x1c1c20, 0x1f5a58, 0x2a2a5a, 0xf0e6d0, 0xd8b030, 0x3a6a3a, 0xc0503c];
const CRAFT_CEILINGS = [0x26262a, 0x26262a, 0xf0ece4, 0x1e3a3a];
const CRAFT_FLOORS = [0xd8d2c8, 0xb8b4ac, 0xe0c8a0, 0x8a8a90];
const CRAFT_PAINTED = {
  Oak: [0xc89a64, 0xd8b484, 0xb88450, 0x1f7a78, 0xe0a41e, 0x2a2a2e, 0xd85a48],
  Upholstery: [0xe0a41e, 0x1f8a84, 0xe0604a, 0xd8508e, 0x5ec89e, 0x2f58c0],
  Leather: [0xa0643a, 0xb8763e, 0x8a4a2a, 0xc88a4a],
  Tile: [0xf2eee4, 0xe0a41e, 0x2fa0c0, 0xe05a7a, 0x60b060, 0x1c1c20],
};
const NEON = ['#ff3ea5', '#39f0ff', '#ffe23a', '#7cff5a', '#ff7a2a', '#b56cff'];
const NEON_WORDS = ['HOPS', 'IPA', 'BEER', 'CHEERS', 'SOURS', 'ON TAP', 'DRINK LOCAL', 'HAZY', 'PINTS', 'BREW', 'GOOD VIBES', 'OPEN'];
const FESTOON = [0xff5a5a, 0xffc83a, 0x5affa0, 0x5ab4ff, 0xff7ae0, 0xfff0c0];
async function loadPub() {
  try {
    pub = await loadPieces(PUB_MODEL_URL, PUB_PAINTED, pubPainted);
  } catch (err) {
    console.warn('Kallipolis: the pub model failed to load; pubs are left bare', err);
    return;
  }
  for (const name of ['Chair', 'Settle', 'BoothBench']) if (pub[name]) pub[name].seats = measureSeats(pub[name]);
  // (a stool's seat is its top, in the middle: sat on facing whichever way it's turned)
  for (const name of ['BarStool', 'Stool']) if (pub[name]) pub[name].seats = [{ x: 0, z: 0, y: pub[name].h }];
  if (inside && current === LAYOUTS.pub) furnishPub(inside.key);
}
modelsLoading.push(loadPub());
modelsLoading.push(loadBarbot());
// Carpet: a lattice of diamonds with a rosette in each and a smaller one where they meet, over a field flecked with
// wear — in its own colours (the floor's left white), repeating every 0.8 m.
const carpet = ([field, lattice, rose, fleck]) => floorTexture(512, 0.8, (g, rng) => {
  g.fillStyle = field;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rng()*512, rng()*512, 2, 2);
  }
  const cell = 128;
  g.strokeStyle = lattice;
  g.lineWidth = 7;
  for (let k = -4; k <= 8; k++) {
    g.beginPath(); g.moveTo(k*cell, 0); g.lineTo(k*cell + 512, 512); g.stroke();
    g.beginPath(); g.moveTo(k*cell, 0); g.lineTo(k*cell - 512, 512); g.stroke();
  }
  const rosette = (x, y, r, petal, heart) => {
    g.fillStyle = petal;
    for (let a = 0; a < 8; a++) {
      const t = a*Math.PI/4;
      g.beginPath(); g.ellipse(x + Math.cos(t)*r*0.55, y + Math.sin(t)*r*0.55, r*0.45, r*0.2, t, 0, Math.PI*2); g.fill();
    }
    g.fillStyle = heart;
    g.beginPath(); g.arc(x, y, r*0.25, 0, Math.PI*2); g.fill();
  };
  for (let x = 0; x <= 512; x += cell) for (let y = 0; y <= 512; y += cell) {
    rosette(x + cell/2, y + cell/2, 40, rose, fleck);
    rosette(x, y, 18, fleck, rose);
  }
});
// (the flowers a dull old gold, not far off the field, so the pattern's there without shouting)
const CARPETS = [
  carpet(['#6a1c20', '#3e1a16', '#7a4a28', '#3e2a22']),
  carpet(['#1e3a2c', '#18281f', '#4e4a2a', '#4a2a22']),
  carpet(['#26284a', '#1a1c34', '#4e4640', '#4a2a36']),
];

// the pub: dark beams across the ceiling, panelled to the dado rail (see useLayout), and furnished afresh for each pub
const PUB_BEAM = 0x2e1c10, CRAFT_BEAM = 0x18181a;
const pubBeam = lit(PUB_BEAM, 0.8), PUB_DAYLIT = 0.4;
layout('pub', 0xffffff, add => {
  const beams = Math.max(2, Math.round(ROOM_W/2));
  for (let i = 0; i < beams; i++) add(0.18, 0.22, ROOM_D, pubBeam, (i - (beams - 1)/2)*ROOM_W*0.9/beams, ROOM_H - 0.11, 0);
  add(ROOM_W, 0.16, 0.16, pubBeam, 0, ROOM_H - 0.08, 0);
  return [];
});
const pubGroup = new THREE.Group();
LAYOUTS.pub.group.add(pubGroup);
Object.assign(LAYOUTS.pub, { furnished: pubGroup, panelled: true, ceiling: PUB_CEILINGS[0], lamps: true, daylit: PUB_DAYLIT });

// Fits out the pub for the building with this key (see buildingKey): its furniture, where nobody stands or walks, and its
// seats, in the room as it's now placed.
function furnishPub(key) {
  const layout = LAYOUTS.pub, group = pubGroup;
  group.clear();
  placeJukebox(null);
  pubLamps = [];
  layout.blocked = []; layout.solid = []; layout.seats = [];
  grid = null;
  const rng = mulberry32(hashNameToNumber(key + ' pub'));
  const tint = mulberry32(hashNameToNumber(key + ' pub colours'));
  const pick = list => list[Math.floor(tint()*list.length)];
  const craft = pubStyleOf(key) === 'craft';
  if (craft) {
    const wall = pick(CRAFT_WALLS);
    layout.wall.setHex(wall);
    layout.ceiling = pick(CRAFT_CEILINGS);
    layout.floorMap = tint() < 0.6 ? concreteTiles : boards;
    layout.floor.setHex(pick(CRAFT_FLOORS));
    let wainscot = pick(CRAFT_WAINSCOT);
    if (wainscot === wall) wainscot = CRAFT_WAINSCOT[0];
    dadoMaterial.color.setHex(wainscot);
    lineMaterial.color.setHex(CRAFT_BEAM);
    pubBeam.color.setHex(CRAFT_BEAM);
  } else {
    layout.wall.setHex(pick(PUB_WALLS));
    layout.ceiling = pick(PUB_CEILINGS);
    if (tint() < 0.7) {
      layout.floorMap = pick(CARPETS);
      layout.floor.setHex(0xffffff);
    } else {
      layout.floorMap = boards;
      layout.floor.setHex(pick(PUB_BOARDS));
    }
    dadoMaterial.color.setHex(pick(PUB_PANELLING));
    lineMaterial.color.setHex(PUB_RAIL);
    pubBeam.color.setHex(PUB_BEAM);
  }
  roomLit(dadoMaterial); roomLit(lineMaterial); roomLit(pubBeam);
  paintRoom();
  for (const material of pubPainted) {
    material.color.setHex(pick((craft ? CRAFT_PAINTED : PUB_PAINTED)[material.name]));
    roomLit(material);
  }
  const F = pub;
  if (!F?.Bar || !F.BackBar) return;
  const { taken, overlaps, fits, put, underCamera, WALL_SIDES, overWindow, againstWall, any } = planRoom(layout, F, group, rng, false, []);
  // (where things stand on: a table's top, to put a pint on, and where it is)
  const tops = [];

  // The bar, against the near wall with no windows in it, and along it as far as the far wall or a little short of it:
  // the back bar, then room to serve from, then the counter.
  const back = F.BackBar, counter = F.Bar;
  const endGap = rng() < 0.5 ? 0 : 0.3 + rng()*0.6;
  const bx = ROOM_W/2 - endGap - back.w/2, bz = -ROOM_D/2 - back.bounds.z0 + 0.02;
  put('BackBar', bx, bz, 0);
  const serve = 0.9, cz = -ROOM_D/2 + back.d + serve - counter.bounds.z0;
  const cx = endGap ? bx : ROOM_W/2 - counter.w/2 - 0.01;
  put('Bar', cx, cz, 0);
  const behind = { x0: Math.min(bx - back.w/2, cx + counter.bounds.x0) - 0.1, x1: ROOM_W/2, z0: -ROOM_D/2, z1: cz + counter.bounds.z1 };
  taken.push(behind);
  layout.solid.push(behind);
  layout.blocked.push(behind);
  // the stools along it, facing it, and room kept to stand at it between them
  const barFront = cz + counter.bounds.z1;
  if (F.BarStool) {
    const n = 3 + Math.floor(rng()*2), from = cx + counter.bounds.x0 + 0.45, to = cx + counter.bounds.x1 - 0.45;
    for (let i = 0; i < n; i++) {
      const x = from + (i + 0.5)*(to - from)/n + (rng() - 0.5)*0.15;
      put('BarStool', x, barFront + 0.3, Math.PI + (rng() - 0.5)*0.3, { solid: { x0: -0.18, x1: 0.18, z0: -0.18, z1: 0.18 } });
    }
  }
  taken.push({ x0: behind.x0 - 0.6, x1: ROOM_W/2, z0: barFront, z1: barFront + 0.9 });
  // and the bar bot behind it (see barbot.js)
  placeBarbot(group, { x0: cx + counter.bounds.x0, x1: Math.min(cx + counter.bounds.x1, ROOM_W/2), barZ: cz + counter.bounds.z0 },
    mulberry32(hashNameToNumber(key + ' bar bot')));

  // `name` at `spot` ({ x, z, angle, area }, as againstWall finds it), its area kept
  const place = (name, spot, options) => {
    put(name, spot.x, spot.z, spot.angle, options);
    taken.push(spot.area);
    return spot;
  };
  // parts of a group laid out in its own terms ([name, x, z, angle]) put in place at `spot`
  const placeAll = (parts, spot) => {
    for (const [name, x, z, angle] of parts) {
      const at = turned(x, z, spot.angle, spot.x, spot.z);
      put(name, at.x, at.z, spot.angle + angle);
      if (F[name].tabletop) tops.push({ ...at, y: F[name].h, big: name === 'BoothTable' });
    }
    taken.push(spot.area);
  };
  for (const name of ['Table', 'Table2', 'BoothTable', 'Barrel']) if (F[name]) F[name].tabletop = true;
  const TABLES = ['Table', 'Table2'].filter(name => F[name]);
  const SITS = ['Chair', 'Chair', 'Stool'].filter(name => F[name]);
  // somewhere out in the room for `r`, `gap` clear of everything else, square to the walls
  const inTheOpen = (r, gap = 0.5) => {
    for (let k = 0; k < 40; k++) {
      const angle = Math.floor(rng()*4)*Math.PI/2;
      const x = (rng()*2 - 1)*(ROOM_W/2 - 0.8), z = (rng()*2 - 1)*(ROOM_D/2 - 0.8);
      const area = turnedRect(r, angle, x, z);
      if (fits(area, gap, 0.1)) return { x, z, angle, area };
    }
    return null;
  };

  // A booth: two benches facing each other across a table, end on to a wall (under a window is fine), or two.
  const booth = () => {
    const bench = F.BoothBench, table = F.BoothTable;
    if (!bench || !table) return null;
    const off = table.d/2 + bench.d/2 - 0.08;
    const r = { x0: -off - bench.d/2, x1: off + bench.d/2, z0: -bench.w/2, z1: bench.w/2 };
    const spot = againstWall(r, false, { under: true });
    if (!spot) return null;
    placeAll([['BoothBench', -off, 0, Math.PI/2], ['BoothBench', off, 0, -Math.PI/2], ['BoothTable', 0, 0, Math.PI/2]], spot);
    return spot;
  };
  // A settle along a wall (low enough to go under a window), with a table in front and a stool or chair across it.
  const settle = () => {
    const s = F.Settle, name = any(TABLES), table = F[name];
    if (!s || !table) return null;
    const tz = s.bounds.z1 + 0.05 - table.bounds.z0, across = tz + table.bounds.z1 + 0.3;
    const r = { ...s.bounds, z1: across + 0.3 };
    const spot = againstWall(r, false, { under: true });
    if (!spot) return null;
    const tx = (rng() - 0.5)*0.4, sit = any(SITS);
    placeAll([['Settle', 0, 0, 0], [name, tx, tz, 0], [sit, tx, across, Math.PI + (rng() - 0.5)*0.4]], spot);
    return spot;
  };
  // A table out in the room with two to four chairs or stools round it, facing it.
  const table = () => {
    const name = any(TABLES), t = F[name];
    const reach = Math.max(t.w, t.d)/2 + 0.3, r = { x0: -reach - 0.3, x1: reach + 0.3, z0: -reach - 0.3, z1: reach + 0.3 };
    const spot = inTheOpen(r, 0.35);
    if (!spot) return null;
    const parts = [[name, 0, 0, 0]], n = 2 + Math.floor(rng()*3), turn = rng()*Math.PI*2;
    for (let i = 0; i < n; i++) {
      const a = turn + i*Math.PI*2/n + (rng() - 0.5)*0.3;
      parts.push([any(SITS), Math.sin(a)*reach, Math.cos(a)*reach, a + Math.PI + (rng() - 0.5)*0.3]);
    }
    placeAll(parts, spot);
    return spot;
  };

  // A long table to share, two or three tables end to end, with stools (and a chair or two) down both sides.
  const communal = () => {
    const name = any(TABLES), t = F[name], n = 2 + Math.floor(rng()*2);
    const len = n*t.w, side = t.d/2 + 0.3;
    const spot = inTheOpen({ x0: -len/2 - 0.2, x1: len/2 + 0.2, z0: -side - 0.35, z1: side + 0.35 }, 0.35);
    if (!spot) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1)/2)*t.w;
      parts.push([name, x, 0, 0]);
      for (const s of [-1, 1]) if (rng() < 0.85) parts.push([rng() < 0.75 ? 'Stool' : any(SITS), x + (rng() - 0.5)*0.15, s*side, (s < 0 ? 0 : Math.PI) + (rng() - 0.5)*0.3]);
    }
    placeAll(parts.filter(([part]) => F[part]), spot);
    return spot;
  };

  const tall = [];  // (what's too tall to hang anything on the wall above)
  // the jukebox, in every pub (see jukebox.js), with room in front to stand and choose
  if (F.Jukebox) {
    const spot = againstWall({ ...F.Jukebox.bounds, z1: F.Jukebox.bounds.z1 + 0.5 }, true, { tries: 80 });
    if (spot) { placeJukebox(put('Jukebox', spot.x, spot.z, spot.angle), key); taken.push(spot.area); tall.push(spot.area); }
  }
  // the fireplace against a wall, with the hearth in front kept clear (not in front of a window, and not under the camera)
  if (F.Fireplace && !craft && rng() < 0.7) {
    const spot = againstWall({ ...F.Fireplace.bounds, z1: F.Fireplace.bounds.z1 + 0.5 }, true);
    if (spot) tall.push(place('Fireplace', spot).area);
  }
  if (craft) for (let tries = 0, n = 1 + Math.floor(rng()*2); tries < 6 && n > 0; tries++) if (communal()) n--;
  for (let n = (craft ? 0 : 1) + Math.floor(rng()*2); n > 0; n--) { const spot = booth(); if (spot) tall.push(spot.area); }
  for (let n = 1 + Math.floor(rng()*2); n > 0; n--) settle();
  if (F.FruitMachine && !craft && rng() < 0.6) {
    const spot = againstWall(F.FruitMachine.bounds, true);
    if (spot) tall.push(place('FruitMachine', spot).area);
  }
  // a dartboard, with the floor in front of it (to the oche) kept clear
  if (F.Dartboard && rng() < (craft ? 0.3 : 0.6)) {
    const spot = againstWall({ ...F.Dartboard.bounds, x0: -0.6, x1: 0.6, z1: F.Dartboard.bounds.z1 + 2.2 }, true);
    if (spot) place('Dartboard', spot, { y: 1.41, small: true });
  }
  for (let n = F.Barrel ? craft ? 1 + Math.floor(rng()*3) : +(rng() < 0.5) : 0; n > 0; n--) {
    const spot = inTheOpen(grown(F.Barrel.bounds, 0.5), 0.3);
    if (spot) placeAll([['Barrel', 0, 0, 0]], spot);
  }
  for (let tries = 0, tables = 0; tries < 8 && tables < (craft ? 2 : 4); tries++) if (table()) tables++;

  // Things on the walls, above whatever's in front of them: not over a window or the back bar, clear of the door, and
  // clear of each other. `y` is how high up their bottoms are.
  const hung = [behind, ...tall];
  // (`hang`, if given, hangs something that isn't one of the model's pieces there instead: see neonSign)
  const onWall = (name, y, piece = F[name], hang = null) => {
    if (!piece) return;
    for (let k = 0; k < 30; k++) {
      const side = any(WALL_SIDES), half = piece.w/2;
      const u = (rng()*2 - 1)*(side.length/2 - half - 0.2), wallAt = side.at(u);
      if (side.nx === 1 && Math.abs(u - DOOR_Z) < DOOR_W/2 + half + 0.2) continue;
      const out = -piece.bounds.z0 + 0.01;
      const x = wallAt.x + side.nx*out, z = wallAt.z + side.nz*out;
      const area = turnedRect(grown(piece.bounds, 0.15), side.angle, x, z);
      if (hung.some(h => overlaps(area, h))) continue;
      const along = side.nx ? [area.z0, area.z1] : [area.x0, area.x1];
      if (y + piece.h > SILL && y < HEAD && overWindow(side, ...along)) continue;
      if (hang) hang(x, z, side.angle);
      else put(name, x, z, side.angle, { y, small: true });
      hung.push(area);
      return;
    }
  };
  // (the dartboard's hung already)
  for (const o of group.children) if (o.position.y > 1) hung.push({ x0: o.position.x - 1, x1: o.position.x + 1, z0: o.position.z - 1, z1: o.position.z + 1 });
  onWall('Chalkboard', 1.2);
  // (a craft bar's beer list's chalked up twice over, and it's neon, not wall lamps: see neonSign)
  const neon = [];
  if (craft) {
    onWall('Chalkboard', 1.2);
    for (let n = 2 + Math.floor(rng()*2); n > 0; n--) {
      const sign = neonSign(any(NEON_WORDS), any(NEON)), y = 1.7 + rng()*0.3;
      onWall(null, y, sign.userData.piece, (x, z, angle) => {
        sign.position.set(x, y + sign.userData.piece.h/2, z);
        sign.rotation.y = angle;
        group.add(sign);
        neon.push(sign);
      });
    }
    for (let n = 1 + Math.floor(rng()*2); n > 0; n--) onWall('Picture', 1.3 + rng()*0.3);
    festoon(group, rng);
  } else {
    for (let n = 2 + Math.floor(rng()*3); n > 0; n--) onWall(rng() < 0.6 ? 'Picture' : 'Mirror', 1.3 + rng()*0.3);
    for (let n = 2 + Math.floor(rng()*3); n > 0; n--) onWall('WallLamp', 1.75);
  }

  // lights hung over the tables (but not right under the camera), and a pint or two on each
  for (const top of tops) {
    if (F.Pendant && !overlaps({ x0: top.x - 0.3, x1: top.x + 0.3, z0: top.z - 0.3, z1: top.z + 0.3 }, underCamera))
      put('Pendant', top.x, top.z, 0, { y: ROOM_H - F.Pendant.h, small: true });
    for (let n = Math.floor(rng()*(top.big ? 4 : 3)); n > 0; n--) {
      const a = rng()*Math.PI*2, d = 0.1 + rng()*(top.big ? 0.3 : 0.18);
      put(rng() < 0.75 ? 'Pint' : 'Stout', top.x + Math.cos(a)*d, top.z + Math.sin(a)*d, 0, { y: top.y, small: true });
    }
  }
  lightPub(group, cx, cz, neon);
  seatsInWorld(layout);
}
// A neon sign saying `text` in `color`: tubes on a clear backing (a canvas, cached by text and colour), to hang on a
// wall — its size as a piece's ({ w, h, bounds }, facing +z) in userData.piece. In a mirrored room it's turned back
// the right way round, so it reads.
const neonTextures = new Map(), neonGeometry = new THREE.PlaneGeometry(1, 1);
function neonSign(text, color) {
  const id = text + color;
  let texture = neonTextures.get(id);
  const H = 128, font = `bold italic 84px "Brush Script MT", "Segoe Script", cursive`;
  if (!texture) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(measure.measureText(text).width + 60); canvas.height = H;
    const g = canvas.getContext('2d');
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = color;
    for (const [blur, width, stroke] of [[30, 8, color], [14, 6, color], [0, 2.5, '#ffffff']]) {
      g.shadowBlur = blur; g.lineWidth = width; g.strokeStyle = stroke;
      g.strokeText(text, canvas.width/2, H/2);
    }
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.userData = { aspect: canvas.width/H };
    neonTextures.set(id, texture);
  }
  const h = 0.4, w = h*texture.userData.aspect;
  const sign = new THREE.Mesh(neonGeometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  sign.scale.set(w*(room.scale.x < 0 ? -1 : 1), h, 1);
  sign.userData.piece = { w, h, bounds: { x0: -w/2, x1: w/2, z0: -0.02, z1: 0.02 } };
  sign.userData.neon = new THREE.Color(color);
  return sign;
}
// Strings of coloured bulbs across the ceiling, wall to wall the short way, sagging between.
const festoonGeometry = new THREE.SphereGeometry(0.04, 8, 6);
const festoonMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
const festoonWire = new THREE.LineBasicMaterial({ color: 0x111111 });
function festoon(group, rng) {
  const along = ROOM_W >= ROOM_D, span = along ? ROOM_D : ROOM_W, across = along ? ROOM_W : ROOM_D;
  const strands = Math.max(2, Math.round(across/2.5)), per = Math.floor(span/0.4), top = ROOM_H - 0.12, sag = 0.3 + rng()*0.15;
  const bulbs = new THREE.InstancedMesh(festoonGeometry, festoonMaterial, strands*per);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  let i = 0;
  for (let s = 0; s < strands; s++) {
    const u = (s - (strands - 1)/2)*across/strands + (rng() - 0.5)*0.3, wire = [];
    for (let k = 0; k <= 24; k++) {
      const t = k/24, v = (t - 0.5)*span, y = top - sag*4*t*(1 - t);
      wire.push(along ? new THREE.Vector3(u, y, v) : new THREE.Vector3(v, y, u));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(wire), festoonWire));
    for (let k = 0; k < per; k++) {
      const t = (k + 0.5)/per, v = (t - 0.5)*span, y = top - sag*4*t*(1 - t) - 0.06;
      m.makeTranslation(along ? u : v, y, along ? v : u);
      bulbs.setMatrixAt(i, m);
      bulbs.setColorAt(i++, c.setHex(FESTOON[Math.floor(rng()*FESTOON.length)]));
    }
  }
  bulbs.frustumCulled = false;
  group.add(bulbs);
}
// The pub's lamps (see "the lamp"): one at every bulb it's hung (its Light parts), one in the fire's glow (Fire), and one
// over the bar where the gantry lights would be, in that order of who gets left out past ROOM_LAMPS. A bulb on a wall, or
// the fire in it, is lit from a little way into the room, so the wall right behind isn't burnt out.
const PUB_LAMPS = { Fire: [0xff8a3c, 3], Light: [0xffc68a, 2.2], Bar: [0xffc68a, 2.5] };
// (and a salon's or a clothes shop's: see lightShop)
let pubLamps = [], pubLit = 0;
function lightPub(group, barX, barZ, neon = []) {
  const add = (kind, at) => {
    const [hex, power] = PUB_LAMPS[kind], c = new THREE.Color(hex);
    const lamp = new THREE.Object3D();
    lamp.position.copy(at);
    lamp.userData.light = new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(power);
    group.add(lamp);
    pubLamps.push(lamp);
  };
  group.updateWorldMatrix(true, true);
  const found = { Fire: [], Light: [] };
  for (const piece of [...group.children]) for (const kind of ['Fire', 'Light']) {
    const box = new THREE.Box3();
    piece.traverse(o => { if (o.isMesh && o.material.name === kind) box.expandByObject(o); });
    if (box.isEmpty()) continue;
    const at = group.worldToLocal(box.getCenter(new THREE.Vector3()));
    const inward = new THREE.Vector3(-at.x, 0, -at.z);
    if (Math.abs(at.x) > ROOM_W/2 - 0.6 || Math.abs(at.z) > ROOM_D/2 - 0.6) at.add(inward.setLength(kind === 'Fire' ? 0.6 : 0.35));
    found[kind].push(at);
  }
  found.Fire.forEach(at => add('Fire', at));
  add('Bar', new THREE.Vector3(barX, ROOM_H - 0.3, barZ - 0.4));
  // (a neon sign tints the wall round it: see neonSign)
  for (const sign of neon) {
    const at = sign.position.clone().add(new THREE.Vector3(Math.sin(sign.rotation.y), 0, Math.cos(sign.rotation.y)).multiplyScalar(0.4));
    const lamp = new THREE.Object3D();
    lamp.position.copy(at);
    lamp.userData.light = new THREE.Vector3(sign.userData.neon.r, sign.userData.neon.g, sign.userData.neon.b).multiplyScalar(1.4);
    group.add(lamp);
    pubLamps.push(lamp);
  }
  found.Light.sort((a, b) => b.y - a.y).forEach(at => add('Light', at)); // (the pendants over the tables first)
}

// ---------------------------------------------------------- shops: what a salon and a clothes shop share
// A salon and a clothes shop (see roomLayoutOf) are on the ground floor, like a pub, and lit by lamps of their own the
// same way (see "the lamp"): one at every piece with a bulb in it (its Light parts), the ones up by the ceiling first —
// on whenever it's open, a little brighter after dark.
const SHOP_DAYLIT = 0.75;
function lightShop(group, hex, power) {
  group.updateWorldMatrix(true, true);
  const c = new THREE.Color(hex), found = [];
  for (const piece of group.children) {
    const box = new THREE.Box3();
    piece.traverse(o => { if (o.isMesh && o.material.name === 'Light') box.expandByObject(o); });
    if (box.isEmpty()) continue;
    const at = group.worldToLocal(box.getCenter(new THREE.Vector3()));
    const inward = new THREE.Vector3(-at.x, 0, -at.z);
    if (Math.abs(at.x) > ROOM_W/2 - 0.6 || Math.abs(at.z) > ROOM_D/2 - 0.6) at.add(inward.setLength(0.4));
    found.push(at);
  }
  found.sort((a, b) => b.y - a.y).forEach(at => {
    const lamp = new THREE.Object3D();
    lamp.position.copy(at);
    lamp.userData.light = new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(power);
    group.add(lamp);
    pubLamps.push(lamp);
  });
}
// A shop's room made ready to fit out: its furniture cleared away, and its colours from `tint` — walls, floor (a texture
// from `floors`, or a tint of the floorboards), its model's recoloured materials (`painted`, from `palette`).
function openShop(layout, tint, { walls, floors, painted, palette }) {
  layout.furnished.clear();
  pubLamps = [];
  layout.blocked = []; layout.solid = []; layout.seats = []; layout.cubicles = [];
  grid = null;
  const pick = list => list[Math.floor(tint()*list.length)];
  layout.wall.setHex(pick(walls));
  const floor = pick(floors);
  if (floor.isTexture) { layout.floorMap = floor; layout.floor.setHex(0xffffff); }
  else { layout.floorMap = boards; layout.floor.setHex(floor); }
  for (const material of painted) {
    material.color.setHex(pick(palette[material.name]));
    roomLit(material);
  }
  return pick;
}
// Things hung on a shop's walls (from its model `F`, with planRoom's helpers `plan`): above whatever's in front of them,
// not over a window, clear of the door and of each other and of `hung` (areas already taken up the wall). `y` is how high
// up their bottoms are.
function wallHanger(F, plan, rng, hung) {
  const { any, put, WALL_SIDES, overlaps, overWindow } = plan;
  return (name, y) => {
    const piece = F[name];
    if (!piece) return;
    for (let k = 0; k < 30; k++) {
      const side = any(WALL_SIDES), half = piece.w/2;
      const u = (rng()*2 - 1)*(side.length/2 - half - 0.2), wallAt = side.at(u);
      if (side.nx === 1 && Math.abs(u - DOOR_Z) < DOOR_W/2 + half + 0.2) continue;
      const out = -piece.bounds.z0 + 0.01;
      const x = wallAt.x + side.nx*out, z = wallAt.z + side.nz*out;
      const area = turnedRect(grown(piece.bounds, 0.15), side.angle, x, z);
      if (hung.some(h => overlaps(area, h))) continue;
      const along = side.nx ? [area.z0, area.z1] : [area.x0, area.x1];
      if (y + piece.h > SILL && y < HEAD && overWindow(side, ...along)) continue;
      put(name, x, z, side.angle, { y, small: true });
      hung.push(area);
      return;
    }
  };
}
// the way in from the door, kept clear
const doorClear = () => ({ x0: -ROOM_W/2, x1: -ROOM_W/2 + 1.5, z0: DOOR_Z - 0.8, z1: DOOR_Z + 0.8 });
// Where anyone can sit on `piece` (as measureSeats), leaving its meshes in any of the materials `over` out of it.
function measureSeatsUnder(piece, over) {
  const moved = [];
  piece.object.traverse(o => { if (o.isMesh && over.includes(o.material.name)) { moved.push(o); o.layers.set(1); } });
  const seats = measureSeats(piece);
  moved.forEach(o => o.layers.set(0));
  return seats;
}

// ---------------------------------------------------------- a hair salon
// A salon is a high-street one from the nineties: a chequered vinyl floor, black and white (now and then with grey in
// it), white tiles to the dado (see `dado`) and pastel walls above, fluorescent tubes on the ceiling — and, like any
// shop, its window a shopfront along the wall with the door, the far walls left blank for the mirrors (`shopfront`: see
// enterBuilding and planRoom). It's
// fitted out from a model of its own (assets/models/Salon.glb, built by tools/salon-models.py, which lists its pieces),
// each salon its own way (from its key): a row of styling stations down a blank wall, each a mirror with a chair in
// front of it facing it (seats of kind 'cut': whoever sits in one a while comes out with a new haircut — see "a salon"
// in peopleActivities.js), and maybe a couple more along the other; then a row of hood dryers (kind 'dryer'), a waiting bench
// (kind 'wait') with magazines, the reception desk by the door, a backwash basin, shelves of products, a fish tank,
// plants, a trolley, and posters of big hair and a clock on the walls. Until the model's loaded, salons are bare.
const SALON_MODEL_URL = 'assets/models/Salon.glb';
let salon = null;
const SALON_WALLS = [0xb8d4e8, 0xc4dcec, 0xe8c8cc, 0xf0f0ec, 0xc8e4d8, 0xe0d0e8, 0xf0e0c8, 0xa8c8e0];
const SALON_PAINTED = {
  Vinyl: [0x1a1a1c, 0x1a1a1c, 0x1a1a1c, 0x5aa8b8, 0x8ec8d8, 0x7a1e3a, 0x2a2a4a],
  Laminate: [0xf0eee8, 0xf0eee8, 0x1a1a1c, 0xe8e0d0],
  Accent: [0x8ec8d8, 0xe890b0, 0x60b0a0, 0xb0a0d8, 0xf0c060, 0x1a1a1c, 0xd8d8d8],
};
// the tiles to the dado rail, and the rail
const SALON_DADOS = [0xf2f2ee, 0xf2f2ee, 0xe8eef0, 0x1a1a1c], SALON_RAILS = [0x1a1a1c, 0xc8ccd0, 0x5aa8b8];
const salonPainted = [];
async function loadSalon() {
  try {
    salon = await loadPieces(SALON_MODEL_URL, SALON_PAINTED, salonPainted);
  } catch (err) {
    console.warn('Kallipolis: the salon model failed to load; salons are left bare', err);
    return;
  }
  if (salon.WaitingBench) salon.WaitingBench.seats = measureSeats(salon.WaitingBench);
  // (felt for without the chrome: a styling chair's foot rest, out in front, would pass for its seat; and a dryer's hood,
  // over it, would hide it)
  if (salon.StylingChair) salon.StylingChair.seats = measureSeatsUnder(salon.StylingChair, ['Chrome', 'Black']);
  if (salon.DryerChair) salon.DryerChair.seats = measureSeatsUnder(salon.DryerChair, ['Hood', 'HoodGlass', 'Chrome']);
  if (inside && current === LAYOUTS.salon) furnishSalon(inside.key);
}
modelsLoading.push(loadSalon(), loadSalonBot().then(() => { if (salon && inside && current === LAYOUTS.salon) furnishSalon(inside.key); }));
// Vinyl tiles 0.3 m square, laid chequerboard: black and white, or (`grey`) every other dark one grey, a little worn.
const vinylTiles = grey => floorTexture(512, 1.2, (g, rng) => {
  const t = 128;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const light = (i + j) % 2 === 0, shade = light ? '#ecebe6' : grey && i % 2 ? '#8a8e94' : '#1e1e20';
    g.fillStyle = shade;
    g.fillRect(i*t, j*t, t, t);
    for (let k = 0; k < 60; k++) { // (marbled flecks, as vinyl tiles have)
      g.fillStyle = light ? 'rgba(90,90,95,0.12)' : 'rgba(230,230,235,0.08)';
      g.fillRect(i*t + rng()*t, j*t + rng()*t, 1 + rng()*4, 1 + rng()*2);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let k = 0; k <= 4; k++) { g.fillRect(k*t - 1, 0, 2, 512); g.fillRect(0, k*t - 1, 512, 2); }
});
const SALON_FLOORS = [vinylTiles(false), vinylTiles(false), vinylTiles(true)];
layout('salon', 0xffffff, () => []);
const salonGroup = new THREE.Group();
LAYOUTS.salon.group.add(salonGroup);
Object.assign(LAYOUTS.salon, { furnished: salonGroup, panelled: true, shopfront: true, shop: true, ceiling: 0xf6f6f2, lamps: true, daylit: SHOP_DAYLIT });

// Fits out the salon for the building with this key (see buildingKey): its furniture, where nobody stands or walks, and
// its seats, in the room as it's now placed.
function furnishSalon(key) {
  const layout = LAYOUTS.salon, group = salonGroup;
  clearSalonBots();
  const rng = mulberry32(hashNameToNumber(key + ' salon'));
  const tint = mulberry32(hashNameToNumber(key + ' salon colours'));
  const pick = openShop(layout, tint, { walls: SALON_WALLS, floors: SALON_FLOORS, painted: salonPainted, palette: SALON_PAINTED });
  layout.ceiling = 0xf6f6f2;
  dadoMaterial.color.setHex(pick(SALON_DADOS));
  lineMaterial.color.setHex(pick(SALON_RAILS));
  roomLit(dadoMaterial); roomLit(lineMaterial);
  paintRoom();
  const F = salon;
  if (!F?.StylingStation || !F.StylingChair) return;
  const plan = planRoom(layout, F, group, rng, false, []);
  const { taken, put, WALL_SIDES, againstWall, atWall } = plan;
  taken.push(doorClear());
  const tall = [];  // (what's too tall to hang anything on the wall above)
  const place = (name, spot, options) => {
    put(name, spot.x, spot.z, spot.angle, options);
    taken.push(spot.area);
    if (F[name].h > 1.2) tall.push(spot.area);
    return spot;
  };

  // The styling stations: down the blank side wall a chair's width apart, three or four, and maybe a couple along the far
  // one — each with its chair in front, turned to face the mirror, a little way off it.
  const station = F.StylingStation, chair = F.StylingChair;
  const reach = station.bounds.z1 + 0.28 + chair.bounds.z1; // (from the station's middle to the chair's)
  const r = { x0: station.bounds.x0 - 0.05, x1: station.bounds.x1 + 0.05, z0: station.bounds.z0, z1: reach + chair.bounds.z1 + 0.45 };
  // (and room for the salon bot's hatch behind the chair: see salonbot.js)
  const chairSeat = chair.seats[0];
  if (chairSeat) r.z1 = Math.max(r.z1, reach - chairSeat.z + salonBotReach(chairSeat) + 0.1);
  const stationAt = (side, u) => {
    const spot = atWall(side, u, r);
    if (!spot) return false;
    put('StylingStation', spot.x, spot.z, spot.angle);
    const at = turned(0, reach, spot.angle, spot.x, spot.z);
    put('StylingChair', at.x, at.z, spot.angle + Math.PI, { seatKind: 'cut' });
    // (and its salon bot behind it, under the floor, its hatch not stood on: see salonbot.js)
    const hatch = placeSalonBot(group, layout.seats[layout.seats.length - 1]);
    if (hatch) layout.solid.push({ x0: hatch.x - hatch.radius, x1: hatch.x + hatch.radius, z0: hatch.z - hatch.radius, z1: hatch.z + hatch.radius });
    taken.push(spot.area);
    tall.push(spot.area);
    return true;
  };
  // (along a wall from `u` towards `to`, each as soon as there's room for it, up to `n` of them)
  const row = (side, u, to, n) => {
    const step = Math.sign(to - u)*0.1, gap = Math.sign(to - u)*(station.w + 0.25);
    for (let placed = 0; placed < n && (to - u)*step > 0; u += step) if (stationAt(side, u)) { placed++; u += gap - step; }
  };
  row(WALL_SIDES[1], -ROOM_D/2 + 0.7 + rng()*0.3, ROOM_D/2, rng() < 0.5 ? 4 : 3);
  if (rng() < 0.6) row(WALL_SIDES[0], ROOM_W/2 - 0.7, -1.2, 1 + Math.floor(rng()*2));
  // a trolley by one of them
  if (F.Trolley) {
    const spot = againstWall(grown(F.Trolley.bounds, 0.1), false);
    if (spot) place('Trolley', spot, { solid: F.Trolley.bounds });
  }

  // the reception desk along the wall behind the camera, clear of its corner, with room behind it
  if (F.Reception) {
    const d = F.Reception, rr = { ...d.bounds, z0: d.bounds.z0 - 0.7, z1: d.bounds.z1 + 0.6 };
    for (const u of [-0.6, -0.2, 0.2, 0.6, 1.0]) {
      const spot = atWall(WALL_SIDES[2], u, rr);
      if (!spot) continue;
      put('Reception', spot.x, spot.z, spot.angle); // (out from the wall by the gap behind it, which rr takes in)
      taken.push(spot.area);
      tall.push(spot.area);
      break;
    }
  }
  // a row of hood dryers along a wall (not in front of a window)
  if (F.DryerChair) {
    const d = F.DryerChair, count = 2 + Math.floor(rng()*2), w = d.w + 0.1;
    const rr = { x0: -count*w/2, x1: count*w/2, z0: d.bounds.z0, z1: d.bounds.z1 + 0.6 };
    const spot = againstWall(rr, true);
    if (spot) {
      for (let i = 0; i < count; i++) {
        const at = turned(-count*w/2 + (i + 0.5)*w, 0, spot.angle, spot.x, spot.z);
        put('DryerChair', at.x, at.z, spot.angle, { seatKind: 'dryer' });
      }
      taken.push(spot.area);
      tall.push(spot.area);
    }
  }
  // the waiting bench (low enough to go under a window), with the magazines in front
  if (F.WaitingBench) {
    const b = F.WaitingBench, t = F.MagazineTable, tz = b.bounds.z1 + 0.4 - (t ? t.bounds.z0 : 0);
    const spot = againstWall({ ...b.bounds, z1: tz + (t ? t.bounds.z1 : 0) + 0.4 }, false, { under: true });
    if (spot) {
      put('WaitingBench', spot.x, spot.z, spot.angle, { seatKind: 'wait' });
      if (t) { const at = turned((rng() - 0.5)*0.3, tz, spot.angle, spot.x, spot.z); put('MagazineTable', at.x, at.z, spot.angle); }
      taken.push(spot.area);
    }
  }
  // a basin or two to wash hair at, and then whatever else there's room for
  for (let k = rng() < 0.4 ? 2 : 1; k > 0 && F.Basin; k--) {
    const spot = againstWall({ ...F.Basin.bounds, z1: F.Basin.bounds.z1 + 0.4 }, true);
    if (spot) place('Basin', spot);
  }
  const alongWall = (name, chance, tallOne = true, front = 0.4) => {
    if (!F[name] || rng() >= chance) return;
    const spot = againstWall({ ...F[name].bounds, z1: F[name].bounds.z1 + front }, tallOne);
    if (spot) place(name, spot);
  };
  alongWall('ProductShelves', 0.8);
  alongWall('FishTank', 0.6);
  for (let k = 1 + Math.floor(rng()*3); k > 0; k--) alongWall('Plant', 1, true, 0.1);

  // posters of hair do's and a clock on the walls, and the tubes on the ceiling
  const onWall = wallHanger(F, plan, rng, [...tall, doorClear()]);
  for (let k = 2 + Math.floor(rng()*3); k > 0; k--) onWall(rng() < 0.5 ? 'Poster' : 'Poster2', 1.35 + rng()*0.1);
  onWall('Clock', 2.1);
  if (F.Tube) for (const x of [-2, 0.2, 2.4]) for (const z of [-1.3, 1.3])
    put('Tube', x, z, Math.PI/2*(rng() < 0.2 ? 1 : 0), { y: ROOM_H - F.Tube.h, small: true });
  lightShop(group, 0xf2f6ff, 1.1);
  seatsInWorld(layout);
}

// ---------------------------------------------------------- a clothes shop
// A clothes shop is a bright high-street one: pale walls, pale boards or polished concrete, spotlights on tracks. It's
// fitted out from a model of its own (assets/models/Clothes.glb, built by tools/clothes-models.py, which lists its
// pieces), each its own way (from its key), behind its shopfront (see `shopfront`): a changing room or two along the
// blank side wall — a cubicle anyone
// can walk into, its curtain drawn across while they're in there (see roomCubicles and drawCurtain), and out they come in
// something new (see "a clothes shop" in peopleActivities.js) — the counter with the till, shelves of folded clothes on
// the walls, and out in the room rails and round rails of clothes, a table of folded ones, a mannequin or two, a shoe
// stand, a mirror to see yourself in, a plant and a sale sign. Until the model's loaded, clothes shops are bare.
const CLOTHES_MODEL_URL = 'assets/models/Clothes.glb';
let clothes = null;
const CLOTHES_WALLS = [0xf4f2ec, 0xf0ece4, 0xe8ecee, 0xf2e8e0, 0xe4e8e0, 0x3a3a3c];
const CLOTHES_FLOORS = [0xd8b88a, 0xc8a070, 0xe0c8a0, concrete, concrete, parquet];
const CLOTHES_PAINTED = {
  Fixture: [0xf2f0ea, 0xf2f0ea, 0x1a1a1c, 0xc8a070, 0xd8d8d4],
  Panel: [0xd8c8a8, 0xe8e4dc, 0x3a3a3c, 0xb8c8c0, 0xc8a070],
  ClothA: [0x2a4a8a, 0x1e1e22, 0x6a1a2a, 0x3a6a4a, 0xc8b89a, 0xe86a8a],
  ClothB: [0xc84a5a, 0xe8b040, 0x5aa0d0, 0x8a5aa0, 0xf2f0ea, 0x4a4a4e],
  ClothC: [0xe8d8b0, 0xf2f0ea, 0x9ab0c8, 0xd8a0a0, 0x2a2a2e, 0xa8c890],
};
const clothesPainted = [];
async function loadClothes() {
  try {
    clothes = await loadPieces(CLOTHES_MODEL_URL, CLOTHES_PAINTED, clothesPainted);
  } catch (err) {
    console.warn('Kallipolis: the clothes shop model failed to load; clothes shops are left bare', err);
    return;
  }
  if (inside && current === LAYOUTS.clothes) furnishClothes(inside.key);
}
modelsLoading.push(loadClothes());
layout('clothes', 0xffffff, () => []);
const clothesGroup = new THREE.Group();
LAYOUTS.clothes.group.add(clothesGroup);
Object.assign(LAYOUTS.clothes, { furnished: clothesGroup, shopfront: true, shop: true, lamps: true, daylit: SHOP_DAYLIT, cubicles: [] });
// how far across a changing room's curtain is drawn when it's open (bunched up at one side), and how quickly it's drawn
const CURTAIN_OPEN = 0.16, CURTAIN_EASE = 0.18;

// Fits out the clothes shop for the building with this key (see buildingKey): its furniture, where nobody stands or
// walks, and its changing rooms, in the room as it's now placed.
function furnishClothes(key) {
  const layout = LAYOUTS.clothes, group = clothesGroup;
  const rng = mulberry32(hashNameToNumber(key + ' clothes'));
  const tint = mulberry32(hashNameToNumber(key + ' clothes colours'));
  openShop(layout, tint, { walls: CLOTHES_WALLS, floors: CLOTHES_FLOORS, painted: clothesPainted, palette: CLOTHES_PAINTED });
  layout.ceiling = CEILING;
  paintRoom();
  const F = clothes;
  if (!F?.ChangingRoom || !F.Curtain) return;
  const plan = planRoom(layout, F, group, rng, false, []);
  const { taken, fits, put, WALL_SIDES, againstWall, atWall } = plan;
  taken.push(doorClear());
  const tall = [];
  const place = (name, spot, options) => {
    put(name, spot.x, spot.z, spot.angle, options);
    taken.push(spot.area);
    if (F[name].h > 1.2) tall.push(spot.area);
    return spot;
  };

  // The changing rooms, along the blank side wall from its far end: each open to the room, with room kept in front of
  // it. Only its walls are solid, so anyone can walk in; its curtain hung at the front, open to start with.
  const cubicle = F.ChangingRoom, b = cubicle.bounds, cw = cubicle.w;
  const count = rng() < 0.5 ? 2 : 1;
  for (let i = 0, u = ROOM_D/2 - 0.1 - cw/2; i < count; i++, u -= cw + 0.05) {
    const spot = atWall(WALL_SIDES[1], u, { ...b, z1: b.z1 + 1.1 });
    if (!spot) break;
    put('ChangingRoom', spot.x, spot.z, spot.angle, { small: true });
    const wall = 0.07, walls = [{ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z0 + wall }, { x0: b.x0, x1: b.x0 + wall, z0: b.z0, z1: b.z1 },
      { x0: b.x1 - wall, x1: b.x1, z0: b.z0, z1: b.z1 }];
    for (const w of walls) layout.solid.push(turnedRect(w, spot.angle, spot.x, spot.z));
    layout.blocked.push(turnedRect(grown(b, 0.35), spot.angle, spot.x, spot.z));
    taken.push(spot.area);
    tall.push(spot.area);
    // (its curtain, on the rail just in from the front: squashed to one side to open it — see updateCurtains)
    const holder = new THREE.Group(), rail = turned(0, b.z1 - 0.12, spot.angle, spot.x, spot.z);
    holder.position.set(rail.x, 0, rail.z);
    holder.rotation.y = spot.angle;
    const drape = F.Curtain.object.clone();
    drape.position.y = 0.04;
    holder.add(drape);
    group.add(holder);
    drape.scale.x = CURTAIN_OPEN;
    drape.position.x = -(1 - CURTAIN_OPEN)*F.Curtain.w/2;
    const at = (x, z) => { const t = turned(x, z, spot.angle, spot.x, spot.z); return room.localToWorld(new THREE.Vector3(t.x, 0, t.z)); };
    layout.cubicles.push({ drape, width: F.Curtain.w, shown: CURTAIN_OPEN, closed: false, by: null,
      inside: at(0, b.z0 + 0.6), front: at(0, b.z1 + 0.55), facing: roomHeading(spot.angle) });
  }
  // the counter with the till, out from the wall behind the camera (clear of its corner), with room behind it to serve from
  if (F.Counter) {
    const c = F.Counter, rr = { ...c.bounds, z0: c.bounds.z0 - 0.8, z1: c.bounds.z1 + 0.6 };
    for (const u of [-0.4, 0, 0.4, 0.8, 1.2]) {
      const spot = atWall(WALL_SIDES[2], u, rr);
      if (!spot) continue;
      put('Counter', spot.x, spot.z, spot.angle);
      taken.push(spot.area);
      break;
    }
  }
  const alongWall = (name, chance, tallOne = true, front = 0.5, options) => {
    if (!F[name] || rng() >= chance) return null;
    const spot = againstWall({ ...F[name].bounds, z1: F[name].bounds.z1 + front }, tallOne, { under: !tallOne });
    return spot ? place(name, spot, options) : null;
  };
  for (let k = 1 + Math.floor(rng()*2); k > 0; k--) alongWall('WallShelves', 1);
  alongWall('ShoeStand', 0.7, false);
  alongWall('FloorMirror', 0.8, true, 0.8);
  alongWall('Plant', 0.7, true, 0.1);
  // out in the room: rails, round rails, a table and a mannequin or two, each with room to get round it
  const inTheOpen = (name, gap) => {
    const piece = F[name];
    if (!piece) return;
    for (let k = 0; k < 40; k++) {
      const angle = Math.floor(rng()*2)*Math.PI/2 + (name === 'Mannequin' ? rng()*Math.PI*2 : 0);
      const x = (rng()*2 - 1)*(ROOM_W/2 - 1), z = (rng()*2 - 1)*(ROOM_D/2 - 1);
      const area = turnedRect(piece.bounds, angle, x, z);
      if (!fits(area, gap, 0.3)) continue;
      put(name, x, z, angle);
      taken.push(area);
      return;
    }
  };
  // a mannequin or two in the window, looking out at the street
  if (F.Mannequin) for (let k = 1 + Math.floor(rng()*2), z = ROOM_D/2 - 0.7; k > 0 && z > shopfrontFrom + 0.5; z -= 0.3) {
    const x = -ROOM_W/2 + 0.55, area = turnedRect(F.Mannequin.bounds, -Math.PI/2, x, z);
    if (!fits(area, 0.3)) continue;
    put('Mannequin', x, z, -Math.PI/2);
    taken.push(area);
    k--; z -= 0.6;
  }
  for (const [name, n] of [['Rack', 2 + Math.floor(rng()*2)], ['RoundRack', 1 + Math.floor(rng()*2)], ['DisplayTable', 1], ['Mannequin', Math.floor(rng()*2)]])
    for (let k = 0; k < n; k++) inTheOpen(name, name === 'Mannequin' ? 0.5 : 0.75);

  const onWall = wallHanger(F, plan, rng, [...tall, doorClear()]);
  if (rng() < 0.7) onWall('Sign', 2.0);
  if (F.Track) for (const x of [-1.8, 0.6, 2.8]) for (const z of [-1.2, 1.4])
    put('Track', x, z, 0, { y: ROOM_H - F.Track.h, small: true });
  lightShop(group, 0xfff2dc, 1.2);
  seatsInWorld(layout);
}
/** The clothes shop's changing rooms, as the room's laid out now: where to stand in front of one (`front`) and inside it
 * (`inside`), in the world; `facing`, the heading out of it; `by`, whoever's using it; and `closed`, its curtain drawn. */
export const roomCubicles = () => inside ? current.cubicles ?? [] : [];
/** Draw a changing room's curtain across (`closed`) or back. */
export function drawCurtain(cubicle, closed) {
  if (cubicle.closed !== closed) playSound('curtain', cubicle.front);
  cubicle.closed = closed;
}
// each frame: the curtains eased across or back
function updateCurtains() {
  for (const c of current.cubicles ?? []) {
    const goal = c.closed ? 1 : CURTAIN_OPEN;
    if (c.shown === goal) continue;
    c.shown = Math.abs(goal - c.shown) < 0.005 ? goal : c.shown + (goal - c.shown)*CURTAIN_EASE;
    c.drape.scale.x = c.shown;
    c.drape.position.x = -(1 - c.shown)*c.width/2;
  }
}

// ---------------------------------------------------------------- the TV
// A home's TV is on while anyone's sat on the sofa (see watchingTV), playing a video picked at random from
// assets/text/tv.txt each time it comes on: a YouTube link plays in a real YouTube player (an iframe), a link to a video file
// (.mp4, .webm, ...: e.g. a Tumblr video's address) in a <video> (see filePlayer). Either is laid out by CSS3DRenderer to sit exactly
// where the screen is, on its own layer behind the canvas — and the canvas cut through to it at the screen (see
// setCutout in pixelation.js), so whoever walks in front of the TV hides it as they would anything else. It starts muted
// (browsers only let a page play sound once it's been clicked or typed into) and turns its sound up from then on, unless
// the app's muted. One at a time: it's only ever the room you're in.
// It plays each video through once, and whoever's watching sits it out to the end (see watchingTV) — the player telling
// us when it's over. A video that's over within TV_SHORT (or wouldn't play) is followed straight on by another, watched
// as part of the same sitting.
const TV_LIST_URL = 'assets/text/tv.txt';
const TV_PIXELS = 640;  // the player's width, as laid out — scaled down to the screen's
const TV_VOLUME = 60;   // out of 100
const TV_SHORT = 20000;       // ms: a video played for less than this is followed by another
const TV_MAX_FOLLOW_ONS = 5;  // in a row, so a list of broken or short videos can't keep anyone sat forever
let channels = [];      // { youtube: id } or { file: url }
fetch(TV_LIST_URL).then(r => r.ok ? r.text() : '').then(text => {
  channels = text.split('\n').map(channelOf).filter(Boolean);
}).catch(() => {});
const VIDEO_FILE = /^https?:\/\/\S+\.(?:mp4|webm|ogv|ogg|mov|m4v)(?:[?#]\S*)?$/i;
// what a line of tv.txt links to (any of YouTube's link shapes or a bare id, or a video file's address), or null;
// anything after whitespace and # is a comment
function channelOf(line) {
  line = line.replace(/\s#.*/, '').trim();
  if (!line || line.startsWith('#')) return null;
  if (VIDEO_FILE.test(line)) return { file: line };
  const id = (line.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) ?? line.match(/^([\w-]{11})$/))?.[1];
  return id ? { youtube: id } : null;
}
let tvLayer = null;       // the CSS3DRenderer and its scene, made the first time there's a TV on
// what's on: { object (its CSS3DObject), element (its iframe), player (a file's <video>), youtube, muted, video, startedAt, playingAt, heard,
// endedAt, followOns }
let tv = null;
let videos = 0;           // counts every sitting's video put on, so a watcher can tell theirs from the next
const tvHoles = new THREE.Scene();
const tvHole = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  vertexShader: 'void main() { gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }',
  fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
  blending: THREE.NoBlending, depthWrite: false,
}));
tvHoles.add(tvHole);
function youtubePlayer(id) {
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay; encrypted-media';
  iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0`
    + `&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  return iframe;
}
// A video file plays in a <video> inside its own blank iframe that sends no Referer: Tumblr (and other hosts) refuse
// video requested from another site's page. `tv.player` is the <video>, once the iframe's loaded.
const FILE_PAGE = '<meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;background:#000}'
  + 'video{width:100%;height:100%;object-fit:contain}</style><video muted autoplay playsinline preload="auto"></video>';
function filePlayer(url) {
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay';
  iframe.srcdoc = FILE_PAGE;
  iframe.addEventListener('load', () => {
    if (tv?.element !== iframe) return;
    const video = iframe.contentDocument.querySelector('video');
    const mine = () => tv?.element === iframe;
    video.addEventListener('playing', () => { if (mine()) tv.playingAt ??= performance.now(); });
    video.addEventListener('ended', () => { if (mine()) videoOver(); });
    video.addEventListener('error', () => {
      if (!mine()) return;
      console.warn(`TV: couldn't play ${url}`);
      videoOver();
    });
    video.src = url;
    tv.player = video;
    tv.toldAt = -Infinity; // (sound set on the next frame)
  }, { once: true });
  return iframe;
}
// (sameSitting: the video number and follow-on count carried over from a short video, so its watcher stays sat)
function startTV(sameSitting = null) {
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
  const channel = channels[Math.floor(Math.random()*channels.length)];
  const youtube = !!channel.youtube;
  const element = youtube ? youtubePlayer(channel.youtube) : filePlayer(channel.file);
  const width = TV_PIXELS, height = Math.round(TV_PIXELS*screen.h/screen.w);
  element.style.cssText += `;width:${width}px;height:${height}px;border:0;background:#000`;
  const object = new CSS3DObject(element);
  object.position.copy(screen.centre);
  object.quaternion.copy(screen.turn);
  object.scale.setScalar(screen.w/width);
  tvLayer.scene.add(object);
  tvHole.position.copy(screen.centre);
  tvHole.quaternion.copy(screen.turn);
  tvHole.scale.set(screen.w, screen.h, 1);
  setCutout(tvHoles);
  tv = { object, element, player: null, youtube, muted: true, toldAt: -Infinity, video: sameSitting?.video ?? ++videos,
    followOns: sameSitting?.followOns ?? 0, startedAt: performance.now(), playingAt: null, heard: !youtube, endedAt: null };
}
function stopTV() {
  if (!tv) return;
  tv.player?.pause();
  tvLayer.scene.remove(tv.object); // (which takes its player out of the page)
  tv = null;
  setCutout(null);
}
// The video's over (ended, or couldn't play): straight on to another if it was short, or else marked over.
function videoOver() {
  if (tv.endedAt !== null) return;
  const now = performance.now();
  if (now - (tv.playingAt ?? now) < TV_SHORT && tv.followOns < TV_MAX_FOLLOW_ONS) {
    const sitting = { video: tv.video, followOns: tv.followOns + 1 };
    stopTV();
    startTV(sitting);
  } else tv.endedAt = now;
}
// a command for the YouTube player (see YouTube's IFrame Player API)
const tell = (func, ...args) => tv.element.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
// What the YouTube player tells us, once it's been told we're listening: when it's playing, and when it's over.
window.addEventListener('message', e => {
  if (!tv?.youtube || e.source !== tv.element.contentWindow) return;
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  tv.heard = true;
  const state = data.event === 'onStateChange' ? data.info : data.event === 'infoDelivery' ? data.info?.playerState : undefined;
  if (state === 1) tv.playingAt ??= performance.now();
  if (state === 0 || data.event === 'onError') videoOver();
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
// Clicking the TV (a click, not the end of a drag round the room) switches it on, watched or not, till it's clicked
// again or the room's left.
let tvClickedOn = false;
const TV_CLICK_SLOP = 5; // px the pointer can move between press and release and still count as a click
const tvRay = new THREE.Raycaster(), tvPointer = new THREE.Vector2();
let pressedAt = null;
renderer.domElement.addEventListener('pointerdown', e => { pressedAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', e => {
  const tvObject = LAYOUTS.home.tvObject;
  if (!pressedAt || !inside || current !== LAYOUTS.home || !tvObject) return;
  if (Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > TV_CLICK_SLOP) return;
  const box = renderer.domElement.getBoundingClientRect();
  tvPointer.set((e.clientX - box.left)/box.width*2 - 1, -(e.clientY - box.top)/box.height*2 + 1);
  tvRay.setFromCamera(tvPointer, camera);
  if (!tvRay.intersectObject(tvObject, true).length) return;
  tvClickedOn = !(tvClickedOn || tv);
  if (!tvClickedOn) stopTV();
});
// Each frame: the TV switched on or off as anyone's sat watching it or not, and while it's on, the player laid out where
// the screen now is on the screen, and its sound on or off.
function updateTV() {
  const watched = inside && current === LAYOUTS.home && (tvClickedOn || performance.now() - watchedAt < 500);
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
  if (!tv.youtube) {
    if (tv.player) {
      tv.player.muted = muted;
      tv.player.volume = TV_VOLUME/100;
    }
    return;
  }
  if (!tv.heard) {
    tv.element.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: tv.video, channel: 'widget' }), 'https://www.youtube.com');
    tell('addEventListener', 'onStateChange');
    tell('addEventListener', 'onError');
  }
  if (muted) tell('mute');
  else { tell('unMute'); tell('setVolume', TV_VOLUME); }
}

// ---------------------------------------------------------------- the fire
// A fireplace's fire (one with a hearth: see measureParts) is particles: little pyramids like the flat fire it used to
// have, each springing up from somewhere along the logs, rising a little and flickering side to side, yellow going to
// red as it shrinks away, then starting again. Unlit, so it glows. One set of them, moved to whichever home's fireplace.
const FLAMES = 24, FLAME_LIFE = [0.45, 0.9], FLAME_WIDTH = [0.05, 0.08], FLAME_HEIGHT = [0.12, 0.26], FLAME_RISE = 0.08;
const FLAME_YOUNG = new THREE.Color(0xffdd66), FLAME_OLD = new THREE.Color(0xd8280f);
const flames = (() => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0, 1, 0], 3));
  geometry.setIndex([0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0, 0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ name: 'Fire' }), FLAMES);
  mesh.frustumCulled = false; // (its instances move about; its box would be wherever they first were)
  mesh.userData.flames = Array.from({ length: FLAMES }, () => ({ born: -Infinity, life: 1 }));
  const none = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < FLAMES; i++) { mesh.setMatrixAt(i, none); mesh.setColorAt(i, FLAME_YOUNG); }
  return mesh;
})();
let hearth = null;
function lightFire(fireplace, logs) {
  hearth = logs;
  fireplace.add(flames);
  for (const f of flames.userData.flames) f.born = -Infinity;
}
const flameAt = new THREE.Matrix4(), flameTurn = new THREE.Quaternion(), flamePlace = new THREE.Vector3(), flameSize = new THREE.Vector3();
const flameColor = new THREE.Color(), flameUp = new THREE.Vector3(0, 1, 0);
const between = ([lo, hi]) => lo + Math.random()*(hi - lo);
function updateFire() {
  if (!inside || current !== LAYOUTS.home || !flames.parent || !hearth) return;
  const now = performance.now()/1000, w = hearth.max.x - hearth.min.x, d = hearth.max.z - hearth.min.z;
  flames.userData.flames.forEach((f, i) => {
    let t = (now - f.born)/f.life;
    if (t >= 1) { // (started again, anywhere from the first frame's age on, so they don't all go at once)
      Object.assign(f, { life: between(FLAME_LIFE), w: between(FLAME_WIDTH), h: between(FLAME_HEIGHT), turn: Math.random()*Math.PI,
        x: hearth.min.x + w*(0.15 + 0.7*Math.random()), z: hearth.min.z + d*(0.3 + 0.4*Math.random()), wobble: Math.random()*10 });
      f.born = f.born === -Infinity ? now - Math.random()*f.life : now;
      t = (now - f.born)/f.life;
    }
    const fade = 1 - t;
    flamePlace.set(f.x + Math.sin(now*9 + f.wobble)*0.012*t, hearth.min.y + (hearth.max.y - hearth.min.y)*0.4 + FLAME_RISE*t, f.z);
    flameSize.set(f.w*fade, f.h*Math.sqrt(fade)*(0.85 + 0.15*Math.sin(now*14 + f.wobble)), f.w*fade);
    flames.setMatrixAt(i, flameAt.compose(flamePlace, flameTurn.setFromAxisAngle(flameUp, f.turn), flameSize));
    flames.setColorAt(i, flameColor.lerpColors(FLAME_YOUNG, FLAME_OLD, t));
  });
  flames.instanceMatrix.needsUpdate = flames.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------- the lamp
// A home's lamp (when it has one) comes on after dark, while anyone's in (see someoneHome). Not a three.js light: one
// of those joining or leaving the scene changes the light count, recompiling every lit material in the city (a stall of
// seconds). Instead the room's own materials (ROOM_LAMP, see roomLit) add a point light's diffuse share themselves, from
// shared uniforms, the way streetlights.js lights the streets. `lampLight` is just where the bulb is, and how bright.
const LAMP_COLOR = 0xffc68a, LAMP_INTENSITY = 6, LAMP_REACH = 9, LAMP_DECAY = 1.2, LAMP_EASE = 0.05;
const lampLight = Object.assign(new THREE.Object3D(), { intensity: 0 });
// A pub has several (see pubLamps): up to ROOM_LAMPS in all, the rest left off.
const ROOM_LAMPS = 10;
const lampUniforms = {
  roomLampPosition: { value: Array.from({ length: ROOM_LAMPS }, () => new SharedVector3()) }, // world
  roomLampLight: { value: Array.from({ length: ROOM_LAMPS }, () => new SharedVector3()) },    // colour × intensity, zero when off
  roomGlowLight: { value: new SharedVector3() },    // the people's share of the room's glow (ROOM_GLOW), zero outdoors
};
['standard', 'physical', 'lambert', 'phong', 'toon'].forEach(id => Object.assign(THREE.ShaderLib[id].uniforms, lampUniforms));
THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#ifdef ROOM_LAMP
uniform vec3 roomLampPosition[ ${ROOM_LAMPS} ];
uniform vec3 roomLampLight[ ${ROOM_LAMPS} ];
#endif
#ifdef ROOM_GLOW
uniform vec3 roomGlowLight;
#endif
`;
// (three.js's point light falloff, and no specular)
THREE.ShaderChunk.lights_fragment_maps += /* glsl */`
#if defined( RE_IndirectDiffuse ) && defined( ROOM_LAMP )
if ( roomLampLight[ 0 ].r > 0.0 ) {
  vec3 roomWorld = ( -vViewPosition ) * mat3( viewMatrix ) + cameraPosition;
  vec3 roomNormal = normalize( normal * mat3( viewMatrix ) );
  for ( int i = 0; i < ${ROOM_LAMPS}; i ++ ) {
    if ( roomLampLight[ i ].r <= 0.0 ) break;
    vec3 toLamp = roomLampPosition[ i ] - roomWorld;
    float lampDistance = length( toLamp );
    float lampFalloff = pow( max( lampDistance, 0.01 ), -${LAMP_DECAY.toFixed(2)} )
      * pow2( saturate( 1.0 - pow4( lampDistance / ${LAMP_REACH.toFixed(1)} ) ) );
    irradiance += roomLampLight[ i ] * lampFalloff * saturate( dot( roomNormal, toLamp / max( lampDistance, 0.01 ) ) );
  }
}
#endif
// (the people: lit to match the room's own glow while the view's in one — the same all round, a little more from above)
#if defined( RE_IndirectDiffuse ) && defined( ROOM_GLOW )
if ( roomGlowLight.r > 0.0 ) irradiance += roomGlowLight * ( 0.8 + 0.2 * normalize( normal * mat3( viewMatrix ) ).y );
#endif
`;
const lampColor = new THREE.Color(LAMP_COLOR);
let occupiedAt = -Infinity;
// (said each frame by whoever's in the room: see peopleActivities.js)
export const someoneHome = () => { occupiedAt = performance.now(); counting++; };
let occupants = 0, counting = 0; // how many said so over the last frame, and so far this one
function updateLamp() {
  const dark = THREE.MathUtils.smoothstep(-(S.sunElevation ?? 90), -6, 2);
  const on = lampLight.userData.there && current === LAYOUTS.home && performance.now() - occupiedAt < 1000;
  const goal = on ? LAMP_INTENSITY*dark : 0;
  lampLight.intensity = Math.abs(goal - lampLight.intensity) < 0.01 ? goal : lampLight.intensity + (goal - lampLight.intensity)*LAMP_EASE;
  const shining = room.visible && lampLight.parent ? lampLight.intensity : 0;
  const lights = lampUniforms.roomLampLight.value, positions = lampUniforms.roomLampPosition.value;
  let n = 0;
  if (shining) {
    lights[n].set(lampColor.r, lampColor.g, lampColor.b).multiplyScalar(shining);
    lampLight.getWorldPosition(positions[n++]);
  }
  // a pub's lamps are on whenever it's open, dimmer by day (with the daylight coming in), easing up as it gets dark
  const pubGoal = current.lamps && room.visible ? current.daylit + (1 - current.daylit)*dark : 0;
  pubLit = Math.abs(pubGoal - pubLit) < 0.005 ? pubGoal : pubLit + (pubGoal - pubLit)*LAMP_EASE;
  if (pubLit) for (const lamp of pubLamps) {
    if (n === ROOM_LAMPS) break;
    lights[n].copy(lamp.userData.light).multiplyScalar(pubLit);
    lamp.getWorldPosition(positions[n++]);
  }
  for (; n < ROOM_LAMPS; n++) lights[n].set(0, 0, 0);
  // (irradiance lighting a surface to ROOM_GLOW of its colour, as the room's materials glow)
  lampUniforms.roomGlowLight.value.setScalar(inside ? ROOM_GLOW*Math.PI : 0);
}

// ---------------------------------------------------------------- warming up
// A room's materials compile the first time it's drawn: a stall on first entering. Done under the loading screen
// instead — every furniture set, wall and floor shown at once, compiled with and without a posh floor's pattern, then
// everything put back.
async function warmUp() {
  await Promise.allSettled(modelsLoading);
  const shown = [];
  room.traverse(o => { shown.push([o, o.visible]); o.visible = true; });
  const sets = new THREE.Group();
  room.add(sets);
  const floorMap = floorMaterial.map;
  const compile = async text => {
    loadingSay(text);
    room.updateMatrixWorld(true);
    await renderer.compileAsync(scene, camera); // (what's compiled already is passed over)
  };
  try {
    await compile('Preparing rooms...');
    floorMaterial.map = floorMaterial.emissiveMap = parquet;
    floorMaterial.needsUpdate = true;
    await compile('Preparing floors...');
    // one set at a time, so the label follows along
    const named = { Interior: furniture, Posh: posh, Student: student, MidCentury: retro, Boho: boho, Office: officeFurniture,
      Industrial: industrial, Pub: pub, Salon: salon, Clothes: clothes, Bedroom: bedroom };
    for (const [name, set] of Object.entries(named)) {
      if (!set) continue;
      for (const piece of Object.values(set)) {
        sets.add(piece.object.clone());
        // (and faded, as fadeWhatsInTheWay does it)
        const faded = piece.object.clone();
        faded.traverse(o => { if (o.isMesh && !Array.isArray(o.material)) { o.material = o.material.clone(); o.material.transparent = true; } });
        sets.add(faded);
      }
      if (set === posh) sets.add(flames);
      await compile(`Preparing ${name} furniture...`);
    }
    const barbot = barbotWarmUp();
    if (barbot) { sets.add(barbot); await compile('Preparing the bar bot...'); }
    const salonBot = salonBotWarmUp();
    if (salonBot) { sets.add(salonBot); await compile('Preparing the salon bots...'); }
  } finally {
    floorMaterial.map = floorMaterial.emissiveMap = floorMap;
    floorMaterial.needsUpdate = true;
    room.remove(sets);
    for (const [o, visible] of shown) o.visible = visible;
  }
}
loadingTask('Preparing interiors...', warmUp().catch(err => console.warn('Kallipolis: interior warm-up failed', err)), 5);

// where the camera starts in the room, in the room's own terms: the corner looking across at the far walls
const CAMERA_AT = new THREE.Vector3(); // (set as the room's sized: see shapeRoom)
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
// The free way round the room (for controls.hug, with Options > Game > Free Camera Indoors: S.freeRoomCamera): orbiting,
// panning and zooming as outside, but kept in the room — the look-at point held FREE_TARGET in from the walls, floor and
// ceiling (keep), and the camera drawn in along its line to it wherever that would take it within FREE_WALL of one
// (place), so it slides along the walls rather than through them. Zooming sets how far back it'd like to be (reach, eased
// there in updateInteriorCamera), but not further back while a wall's already holding it in. With a bedroom (see "the
// bedroom"), both go through into it and its ensuite by the doorways (freeSpaces).
const FREE_WALL = 0.25, FREE_TARGET = 0.5, FREE_NEAREST = 0.4, FREE_FURTHEST = 9;
// The room's spaces as boxes in its terms ({ lo: [x, y, z], hi }), each `inset` in from its walls, floor and ceiling — and
// the doorways between them, `side` in from theirs and under their heads, reaching `inset` and a little more into the
// rooms either side, so the boxes overlap there.
function freeSpaces(inset, side) {
  return floorRects().map(r => {
    if (r.room) return { lo: [r.x0 + inset, inset, r.z0 + inset], hi: [r.x1 - inset, ROOM_H - inset, r.z1 - inset] };
    const alongX = (r.across === 'u') === (SUITE.side !== '+x'), on = inset + 0.05, top = DOOR_H - Math.min(side, inset);
    return alongX ? { lo: [r.x0 + side, inset, r.z0 - on], hi: [r.x1 - side, top, r.z1 + on] }
      : { lo: [r.x0 - on, inset, r.z0 + side], hi: [r.x1 + on, top, r.z1 - side] };
  });
}
const inSpace = (b, p) => [0, 1, 2].every(k => p.getComponent(k) >= b.lo[k] - 1e-6 && p.getComponent(k) <= b.hi[k] + 1e-6);
const freeProbe = new THREE.Vector3();
// how far a pan moves the look-at point for each pixel dragged (outside it goes with the radius, which is tiny in here)
const FREE_PAN = 0.0085;
let reach = 3, reachGoal = 3;
const freeAt = new THREE.Vector3(), freeWay = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const freeRoom = {
  free: true,
  panSpeed: FREE_PAN,
  place(theta, phi, target) {
    room.worldToLocal(freeAt.copy(target));
    freeWay.set(Math.sin(phi)*Math.sin(theta), Math.cos(phi), Math.sin(phi)*Math.cos(theta)).applyAxisAngle(UP, -room.rotation.y);
    freeWay.x *= room.scale.x; // (a flipped room's x runs the other way)
    // (as far out along it as it stays in the spaces: stepped out, then narrowed down to where it leaves them)
    const spaces = freeSpaces(FREE_WALL, 0.15), within = t => spaces.some(b => inSpace(b, freeProbe.copy(freeAt).addScaledVector(freeWay, t)));
    let out = 0, step = 0.1;
    while (out < reach && within(Math.min(out + step, reach))) out = Math.min(out + step, reach);
    if (out < reach) for (let k = 0; k < 6; k++) { step /= 2; if (within(out + step)) out += step; }
    return { radius: Math.max(0, out), phi };
  },
  keep(target) {
    room.worldToLocal(freeAt.copy(target));
    // (into the nearest of the spaces, if it's in none of them)
    let best = null, nearest = Infinity;
    for (const b of freeSpaces(FREE_TARGET, 0.3)) {
      for (let k = 0; k < 3; k++) freeProbe.setComponent(k, THREE.MathUtils.clamp(freeAt.getComponent(k), b.lo[k], b.hi[k]));
      const d = freeProbe.distanceToSquared(freeAt);
      if (d < nearest) { nearest = d; best = freeProbe.clone(); }
    }
    target.copy(room.localToWorld(freeAt.copy(best)));
  },
  zoom(factor) {
    if (factor > 1 && controls.radius < reach - 0.05) return; // (up against a wall already)
    reachGoal = THREE.MathUtils.clamp(reachGoal*factor, FREE_NEAREST, FREE_FURTHEST);
  },
};
// Onto the free way round the room (from wherever the camera is now), or back onto the walls (looking at the middle again).
function freeCamera(on) {
  if (on) { reach = reachGoal = Math.max(controls.radius, FREE_NEAREST); controls.hug = freeRoom; }
  else { controls.goalTarget.copy(lookAt()); controls.hug = hugWalls; }
}
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

// Half the rooms are flipped, mirrored across their own x (room.scale.x = -1): the door, the windows and everything laid
// out in them the other way round. Anything in the room's terms goes to the world's through room.localToWorld, which
// mirrors it along with them; a way or a heading, through these.
const ROOM_FLIPPED = 0.5;
const roomWay = (nx, nz) => new THREE.Vector3(nx, 0, nz).transformDirection(room.matrixWorld);
const roomHeading = angle => room.rotation.y + angle*room.scale.x;
// The room's angle: square to the footprint's longest edge, so its walls run the way the building's do.
function longestEdgeAngle(fp) {
  let best = 0, angle = 0;
  fp.forEach((p, i) => {
    const q = fp[(i + 1) % fp.length], length = Math.hypot(q.x - p.x, q.z - p.z);
    if (length > best) { best = length; angle = Math.atan2(-(q.z - p.z), q.x - p.x); }
  });
  return angle;
}

// The room's the same size whatever it's in, so in a narrow building — a town terrace, built wall to wall — it reaches
// past the building's own walls into the ones next door, which would show through inside. Any other building whose
// footprint crosses the room's walls, and stands tall enough to reach its floor, isn't drawn while the room's up (hidden
// the way the building gone into is, so building-batches.js draws that zone one by one meanwhile; see-through.js leaves
// alone what's hidden).
const NEIGHBOUR_SLACK = 0.05; // (a wall only touching the room's from outside isn't in it)
function hideNeighbours(group) {
  // (the room and any bedroom, as a rectangle about its own middle)
  const cx = (EXTENT.x0 + EXTENT.x1)/2, cz = (EXTENT.z0 + EXTENT.z1)/2;
  const a = (EXTENT.x1 - EXTENT.x0)/2 - NEIGHBOUR_SLACK, b = (EXTENT.z1 - EXTENT.z0)/2 - NEIGHBOUR_SLACK;
  const reach = Math.hypot(a, b) + Math.hypot(cx, cz);
  const local = p => { room.worldToLocal(probe.set(p.x, 0, p.z)); return { x: probe.x - cx, z: probe.z - cz }; };
  // whether the segment p–q passes through the room's rectangle (Liang–Barsky)
  const crosses = (p, q) => {
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dz = q.z - p.z;
    for (const [d, gap] of [[-dx, p.x + a], [dx, a - p.x], [-dz, p.z + b], [dz, b - p.z]]) {
      if (d === 0) { if (gap < 0) return false; continue; }
      const t = gap/d;
      if (d < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
    return true;
  };
  const hidden = [], floor = room.position.y, box = new THREE.Box3();
  buildingHolders().forEach(zone => (zone.buildingsGroup?.children || []).forEach(other => {
    const fp = other.userData.footprint;
    if (other === group || !fp || fp.length < 3 || !other.visible) return;
    const { c, r } = footprintBounds(other);
    if (Math.hypot(c.x - room.position.x, c.z - room.position.z) > r + reach) return; // nowhere near it
    const pts = fp.map(local);
    if (!pts.some((p, i) => crosses(p, pts[(i + 1) % pts.length])) && !pointInPolygon({ x: 0, z: 0 }, pts)) return;
    if (box.setFromObject(other).max.y < floor) return; // all below the room
    other.visible = false;
    hidden.push(other);
  }));
  return hidden;
}

// Goes into `group` (a building, as building-card.js follows it, with its key): the room onto its top floor (a warehouse
// or factory's, or a pub's or a shop's, ground floor), laid out as `kind` of room (one of LAYOUTS: 'home', 'office',
// 'warehouse', 'factory', 'pub', 'salon' or 'clothes'),
// the building hidden, and the camera cut straight to the corner, to go round the walls from there.
// How big each layout's room can be, width (x) and depth (z): [narrowest, widest, shallowest, deepest].
const ROOM_SIZES = {
  home: [6, 9.5, 5, 7.5], office: [7, 12, 5.5, 9], warehouse: [9, 14, 7, 11], factory: [9, 14, 7, 11],
  pub: [7.5, 11, 6, 8.5], salon: [7, 10, 5.5, 8], clothes: [7, 10, 5.5, 8],
};
/** The chance a room's as deep as it's wide (or as near as its layout lets it). */
const ROOM_SQUARE = 0.25;
// The room for the building `group` with this key, laid out as `kind`: its width and depth, from the footprint's extent
// along and across the room (turned as `angle` has it) less the walls, a little more or less by its key, within its
// layout's sizes — and whether it's turned a quarter round, so its width runs along the building's longer side.
function roomSizeFor(group, key, kind, angle) {
  const [w0, w1, d0, d1] = ROOM_SIZES[kind] ?? ROOM_SIZES.home;
  const fp = group.userData.footprint;
  let along = 8, across = 6;
  if (fp && fp.length >= 3) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const xs = fp.map(p => p.x*c - p.z*s), zs = fp.map(p => p.x*s + p.z*c);
    along = Math.max(...xs) - Math.min(...xs) - 1.5; across = Math.max(...zs) - Math.min(...zs) - 1.5;
  }
  const turned = across > along;
  if (turned) [along, across] = [across, along];
  const jitter = salt => 0.85 + keyFraction(key, salt)*0.3;
  let w = THREE.MathUtils.clamp(along*jitter(':width'), w0, w1), d = THREE.MathUtils.clamp(across*jitter(':depth'), d0, d1);
  if (keyFraction(key, ':square') < ROOM_SQUARE) w = d = THREE.MathUtils.clamp(Math.min(w, d1), Math.max(w0, d0), d1);
  d = Math.min(d, w);
  return { w: Math.round(w*10)/10, d: Math.round(d*10)/10, turned };
}
// The room made `w` by `d`, with a bedroom as `spec` has it (see suiteSpec) or none: its shell, trim, dado, each layout's
// fixtures and floors built again to fit, and everything kept in the room's terms (where the camera starts, the walk
// grid, how far it all reaches) moved to match.
let shapedSuite = 'null';
function shapeRoom(w, d, spec = null) {
  const suited = JSON.stringify(spec);
  if (w === ROOM_W && d === ROOM_D && suited === shapedSuite) return;
  ROOM_W = w; ROOM_D = d; shapedSuite = suited;
  SUITE = spec && planSuite(spec);
  buildShell(); buildSuite(); buildTrim(); buildDado(); fitFloors();
  for (const layout of Object.values(LAYOUTS)) layout.refit();
  placeCamera();
}
// The floors there are to walk on, in the room's terms: the room's, and any bedroom's — its bedroom proper and ensuite,
// and the doorways through to them (see walkGrid)
function floorRects() {
  const floors = [{ x0: -ROOM_W/2, x1: ROOM_W/2, z0: -ROOM_D/2, z1: ROOM_D/2, room: true }];
  if (!SUITE) return floors;
  const { rect, depth, bed, ensuite, partition, doorU } = SUITE;
  floors.push({ ...rect(bed[0], bed[1], 0, depth), room: true }, { ...rect(ensuite[0], ensuite[1], 0, depth), room: true },
    { ...rect(doorU - SUITE_DOOR/2, doorU + SUITE_DOOR/2, -WALL, 0), across: 'u' },
    { ...rect(partition[0], partition[1], ...ENSUITE_DOOR), across: 'v' });
  return floors;
}
function placeCamera() {
  CAMERA_AT.set(-ROOM_W/2 + CAMERA_INSET, CAMERA_HEIGHT, -ROOM_D/2 + CAMERA_INSET);
  const main = { x0: -ROOM_W/2 - WALL, x1: ROOM_W/2 + WALL, z0: -ROOM_D/2 - WALL, z1: ROOM_D/2 + WALL }, b = SUITE?.bounds ?? main;
  EXTENT = { x0: Math.min(main.x0, b.x0), x1: Math.max(main.x1, b.x1), z0: Math.min(main.z0, b.z0), z1: Math.max(main.z1, b.z1) };
  const floors = floorRects();
  GX0 = Math.min(...floors.map(r => r.x0)); GZ0 = Math.min(...floors.map(r => r.z0));
  GRID_X = Math.ceil((Math.max(...floors.map(r => r.x1)) - GX0)/CELL - 1e-6);
  GRID_Z = Math.ceil((Math.max(...floors.map(r => r.z1)) - GZ0)/CELL - 1e-6);
  grid = null;
}
export function enterBuilding(group, key, kind = 'home') {
  if (inside) leaveBuilding();
  // A building can say where its room goes instead (userData.room): a mall's shop has the room the shops had before rooms
  // were sized for their buildings, always with a shopfront, set just behind its own and facing the concourse — { w, d,
  // at: {x, z}, facing: the way out through the shopfront } (see makeUnit in roads/mall.js).
  const fixed = group.userData.room;
  const fp = group.userData.footprint, angle = fp && fp.length >= 3 ? longestEdgeAngle(fp) : 0;
  const size = fixed ? { w: fixed.w, d: fixed.d, turned: false } : roomSizeFor(group, key, LAYOUTS[kind] ? kind : 'home', angle);
  // (a home with a bedroom has a smaller living room, to leave room for it: see "the bedroom")
  const spec = !fixed && (!LAYOUTS[kind] || kind === 'home') ? suiteSpec(key) : null;
  if (spec?.side === '+x') size.w = Math.max(6, size.w - WALL - spec.depth);
  else if (spec) size.d = Math.max(5, size.d - WALL - spec.depth);
  size.d = Math.min(size.d, size.w);
  shapeRoom(Math.round(size.w*10)/10, Math.round(size.d*10)/10, spec);
  useLayout(kind);
  const glass = current === LAYOUTS.office && keyFraction(key) >= OFFICE_PUNCHED;
  // (a pub's room comes either way: windows in the far walls, or a shopfront beside the door — by its key)
  if (current === LAYOUTS.pub) LAYOUTS.pub.shopfront = fixed ? true : keyFraction(key, ':shopfront') < PUB_SHOPFRONT;
  // (a warehouse or a factory's room is on its ground floor: its roof's high over one big space, not storeys — and a pub's
  // on the street)
  const workshop = !!current.industrial, groundFloor = workshop || current === LAYOUTS.pub || !!current.shop;
  curtain.visible = glass; punched.visible = !glass && !current.shopfront;
  blankWalls.visible = shopfront.visible = !!current.shopfront; doorWall.visible = !current.shopfront;
  const bounds = new THREE.Box3().setFromObject(group);
  const base = bounds.min.y, height = group.userData.height ?? (bounds.max.y - base);
  const centre = fixed ? fixed.at : fp && fp.length >= 3 ? footprintBounds(group).c : bounds.getCenter(new THREE.Vector3());
  const storey = groundFloor ? 0 : Math.max(0, Math.floor((height - PLINTH - ROOM_H - 0.3)/FLOOR_HEIGHT));
  room.position.set(centre.x, base + PLINTH + storey*FLOOR_HEIGHT, centre.z);
  room.scale.x = keyFraction(key, ':flip') < ROOM_FLIPPED ? -1 : 1;
  // (the door's wall is the room's -x: turned to face `facing`, and round the other way when the room's mirrored, which
  // puts that wall on its +x — so the door's at the other end of the same shopfront)
  room.rotation.y = fixed ? Math.atan2(fixed.facing.z, -fixed.facing.x) + (room.scale.x < 0 ? Math.PI : 0) : angle + (size.turned ? Math.PI/2 : 0);
  room.visible = true;
  room.updateMatrixWorld(true);
  // (the living room and its bedroom centred on the building together)
  const mid = room.localToWorld(new THREE.Vector3((EXTENT.x0 + EXTENT.x1)/2, 0, (EXTENT.z0 + EXTENT.z1)/2)).sub(room.position);
  room.position.x -= mid.x; room.position.z -= mid.z;
  room.updateMatrixWorld(true);
  setRoomGlow(true);
  group.visible = false;
  const neighbours = hideNeighbours(group);
  if (current === LAYOUTS.home) furnish(key);
  else if (current === LAYOUTS.office) furnishOffice(key, glass);
  else if (workshop) furnishIndustrial(key, current.kind);
  else if (current === LAYOUTS.pub) furnishPub(key);
  else if (current === LAYOUTS.salon) furnishSalon(key);
  else if (current === LAYOUTS.clothes) furnishClothes(key);

  visits++;
  resetOfficeAmbience();
  inside = { group, key, neighbours, before: {
    target: controls.goalTarget.clone(), radius: controls.goalRadius, theta: controls.goalTheta, phi: controls.goalPhi,
    minRadius: controls.minRadius, near: camera.near,
  } };
  camera.near = ROOM_NEAR;
  camera.updateProjectionMatrix();
  controls.goalTarget.copy(lookAt());
  controls.minRadius = 0;
  controls.goalTheta = nearerWay(roomHeading(Math.atan2(CAMERA_AT.x, CAMERA_AT.z)));
  controls.locked = true;
  controls.hug = hugWalls;
  eyeHeight = eyeGoal = tuning.height ?? CAMERA_HEIGHT;
  zoomedFov = tuning.fov ?? CAMERA_FOV;
  setIndoors(inRoom);
  // a hard cut in, no glide (to the same corner either way: freely, from where the walls would put it)
  controls.update(true);
  if (S.freeRoomCamera) { freeCamera(true); controls.update(true); }
  camera.fov = possession.index >= 0 ? possession.fov : viewFov(); // (someone taken over keeps the width the wheel's set)
  camera.updateProjectionMatrix();
}
// Back out: the building drawn again, the room put away, and the camera eased back to where it was looking from.
export function leaveBuilding() {
  if (!inside) return;
  const { group, neighbours, before } = inside;
  inside = null;
  setIndoors(null);
  tvClickedOn = false;
  cards.forEach(card => card.resetPlace()); // (any dragged about in the room back where they belong)
  stopTV();
  group.visible = true;
  neighbours.forEach(other => { other.visible = true; });
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
  return probe.x >= EXTENT.x0 && probe.x <= EXTENT.x1 && probe.z >= EXTENT.z0 && probe.z <= EXTENT.z1
    && probe.y >= -SLAB && probe.y <= ROOM_H + SLAB;
}

// Whatever's between the camera and the middle of the room — the light hanging over a table as the camera comes round
// behind it, a bookcase it's riding past — fades nearly out of the way, on materials of its own for as long as it's
// faded (the model's are shared by every clone of it). Not the TV: its picture's a hole cut through to the player
// behind the canvas (see "the TV"), and it's too low to be in the way. Only what the sightline's through and out of
// again CLEAR short of the middle is in the way (by its meshes, not just its box): a desk out in the middle of the room,
// the middle inside it or just beyond it, is what's being looked at. Nothing fades while someone's taken over.
const FADED = 0.15, FADE_EASE = 0.15, CLEAR = 0.75;
const sightline = new THREE.Ray(), sightHit = new THREE.Vector3(), sightEnd = new THREE.Vector3();
const sightRay = new THREE.Raycaster(), sightHits = [];
sightRay.camera = camera; // (sprites need it)
sightRay.params.Line.threshold = sightRay.params.Points.threshold = 0.02;
// Its box first (cheap), then its own meshes: a box round an L of counter or a bed and its headboard takes in a lot of
// air the sightline's clear through.
function inTheWay(piece, box, reach) {
  const hit = sightline.intersectBox(box, sightHit);
  if (!hit || hit.distanceTo(sightline.origin) >= reach || box.containsPoint(sightEnd)) return false;
  sightRay.ray.copy(sightline);
  sightRay.far = reach;
  sightHits.length = 0;
  sightRay.intersectObject(piece, true, sightHits);
  return sightHits.some(({ object }) => {
    for (let o = object; o && o !== piece; o = o.parent) if (!o.visible) return false;
    return true;
  });
}

function fadeWhatsInTheWay() {
  if (!inside) return;
  // (someone taken over sees from their own eyes: nothing's in the way of the room's middle, and nothing fades)
  const possessing = possession.index >= 0;
  sightline.origin.copy(camera.position);
  const reach = sightline.direction.copy(controls.target).sub(camera.position).length() - CLEAR;
  sightline.direction.normalize();
  sightline.at(reach, sightEnd);
  const pieces = (current.furnished ?? current.group).children;
  for (const piece of pieces) {
    if (!piece.isGroup || piece.userData.isTV) continue;
    const u = piece.userData;
    if (u.fadeVisit !== visits) { u.fadeBox = new THREE.Box3().setFromObject(piece); u.fadeVisit = visits; u.fade ??= 1; }
    const goal = !possessing && inTheWay(piece, u.fadeBox, reach) ? FADED : 1;
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

// ---------------------------------------------------------------- furniture shadows
// Under its own ceiling the room's out of the sun, and the glow and lamps cast no shadows, so furniture stands on the
// floor as if pasted on. Every piece standing on the floor casts a hard shadow instead: its own meshes drawn again,
// flattened onto the floor along SHADOW_FALL (straight down, as from lights overhead: each piece's
// own outline on the floor right under it), in black at SHADOW_DARK. No shadow map, and no light added to the scene (which
// would recompile every lit material: see "the lamp"). Where two overlap they darken the floor once, not twice — the
// stencil's STENCIL_ROOM_SHADOW bit marks where one's been drawn. Pieces lower than SHADOW_FLAT (rugs, mats) or not
// reaching down to the floor (lamps hung from the ceiling, things on the walls) cast none, and they're put back
// whenever the room's furnished afresh (see updateFurnitureShadows).
const SHADOW_DARK = 0.35, SHADOW_FLAT = 0.08, SHADOW_OFF_FLOOR = 0.12, SHADOW_Y = 0.012;
const SHADOW_FALL = new THREE.Vector3(0, -1, 0);
const flatten = new THREE.Matrix4().set( // (along SHADOW_FALL onto the plane y = SHADOW_Y, in the room's own space)
  1, -SHADOW_FALL.x/SHADOW_FALL.y, 0, SHADOW_FALL.x/SHADOW_FALL.y*SHADOW_Y,
  0, 0, 0, SHADOW_Y,
  0, -SHADOW_FALL.z/SHADOW_FALL.y, 1, SHADOW_FALL.z/SHADOW_FALL.y*SHADOW_Y,
  0, 0, 0, 1);
const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: SHADOW_DARK,
  depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: STENCIL_ROOM_SHADOW, stencilFuncMask: STENCIL_ROOM_SHADOW,
  stencilWriteMask: STENCIL_ROOM_SHADOW, stencilZPass: THREE.ReplaceStencilOp });
const furnitureShadows = new THREE.Group();
furnitureShadows.name = 'Furniture shadows';
room.add(furnitureShadows);
const NOTHING = [];
let shadowedFor = null, shadowedCount = -1, shadowedFirst = null;
function updateFurnitureShadows() {
  const pieces = inside ? (current.furnished ?? current.group).children : NOTHING;
  if (pieces === shadowedFor && pieces.length === shadowedCount && pieces[0] === shadowedFirst) return;
  shadowedFor = pieces; shadowedCount = pieces.length; shadowedFirst = pieces[0];
  furnitureShadows.clear();
  room.updateMatrixWorld(true);
  const fromWorld = new THREE.Matrix4().copy(room.matrixWorld).invert();
  for (const piece of pieces) {
    if (!piece.visible) continue;
    const meshes = [], bounds = new THREE.Box3(), part = new THREE.Box3();
    piece.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || !o.visible || o.material?.transparent) return;
      const inRoom = new THREE.Matrix4().multiplyMatrices(fromWorld, o.matrixWorld);
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      bounds.union(part.copy(o.geometry.boundingBox).applyMatrix4(inRoom));
      meshes.push([o.geometry, inRoom]);
    });
    if (bounds.isEmpty() || bounds.min.y > SHADOW_OFF_FLOOR || bounds.max.y - bounds.min.y < SHADOW_FLAT) continue;
    for (const [geometry, inRoom] of meshes) {
      const shadow = new THREE.Mesh(geometry, shadowMaterial);
      shadow.matrixAutoUpdate = false;
      shadow.matrix.multiplyMatrices(flatten, inRoom);
      shadow.frustumCulled = false;
      shadow.renderOrder = 1;
      furnitureShadows.add(shadow);
    }
  }
}

const speakerAt = new THREE.Vector3();
// Each frame: the view eased wider inside a room, and back to its usual angle outside.
export function updateInteriorCamera() {
  updateTV();
  updateLamp();
  updateFire();
  updateFurnitureShadows();
  updateDoor();
  updateCurtains();
  if (inside && (controls.hug === freeRoom) !== !!S.freeRoomCamera) freeCamera(!!S.freeRoomCamera);
  if (inside && reach !== reachGoal) reach = Math.abs(reachGoal - reach) < 0.002 ? reachGoal : reach + (reachGoal - reach)*RISE_EASE;
  if (inside && eyeHeight !== eyeGoal) eyeHeight = Math.abs(eyeGoal - eyeHeight) < 0.002 ? eyeGoal : eyeHeight + (eyeGoal - eyeHeight)*RISE_EASE;
  fadeWhatsInTheWay();
  occupants = counting; counting = 0;
  if (inside && current === LAYOUTS.office && performance.now() - occupiedAt < 1000) {
    officeAmbience({ printer: current.printer, desks: current.desks, centre: room.localToWorld(new THREE.Vector3(0, 1, 0)), people: occupants });
  }
  // (a pub's music comes from up by the ceiling, over the middle of the room)
  if (inside && current === LAYOUTS.pub && performance.now() - occupiedAt < 1000) pubMusic(inside.key, room.localToWorld(speakerAt.set(0, ROOM_H - 0.3, 0)));
  else stopPubMusic();
  updateJukebox();
  updateBarbot(!!inside && current === LAYOUTS.pub, performance.now() - occupiedAt < 1000);
  updateSalonBots(!!inside && current === LAYOUTS.salon);
  // (riding a train carriage sets its own: see trains.js; boosting widens it: see life/traffic/driving.js; someone taken
  // over sees as wide as the wheel's set, in a room or out, so going through a door doesn't change the view: see possession.js)
  const goal = possession.index >= 0 ? possession.fov : inside ? viewFov() : (App.ridingFov?.() ?? BASE_FOV*(App.boostFovScale?.() ?? 1));
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
/** The room's doorway, just inside it, in the world. */
export const roomDoorway = () => room.localToWorld(new THREE.Vector3(-ROOM_W/2 + 0.3, 0, DOOR_Z));
/** Through the room's door, in the dark beyond it, in the world. */
export const roomBeyondDoor = () => room.localToWorld(new THREE.Vector3(-ROOM_W/2 - RECESS + 0.2, 0, DOOR_Z));
// Just outside the door, where the room's own thick wall and the black beyond the doorway hide whoever's standing there
// from anyone in the room, and where the door's wall — the one wall without windows in it — puts them out of sight of
// those, too: `out` from the mouth of the doorway (the far side of the room's wall) and `across` along it, +z for the end
// away from the corner the camera starts in. At the room's own floor height; anyone putting someone out there on the
// ground gives their own y (see the party in peopleActivities.js, which queues people up out here to come in).
/**
 * A spot just outside the room's door, in the world.
 * @param {number} out - how far past the doorway's mouth
 * @param {number} across - how far along the wall from the door, +z
 * @returns {THREE.Vector3} the spot, at the room's floor height
 */
export const roomOutsideDoor = (out = 0.4, across = 0) =>
  room.localToWorld(new THREE.Vector3(-ROOM_W/2 - THICK - out, 0, DOOR_Z + across));

// Walked about by hand (see "walking into buildings" in life/people/peopleTracking.js): whether a point in the world is
// somewhere to stand in the room — the walk grid's floor (BODY clear of the walls and furniture), or the doorway's recess
// out to the dark beyond it — and whether it's through the door and out.
const probeWalk = new THREE.Vector3();
export function roomWalkable(x, z) {
  if (!inside) return false;
  room.worldToLocal(probeWalk.set(x, room.position.y, z));
  if (probeWalk.x < -ROOM_W/2 + BODY) return probeWalk.x > -ROOM_W/2 - RECESS && probeWalk.z > doorFrom + BODY && probeWalk.z < doorTo - BODY;
  const i = Math.floor((probeWalk.x - GX0)/CELL), k = Math.floor((probeWalk.z - GZ0)/CELL);
  return i >= 0 && k >= 0 && i < GRID_X && k < GRID_Z && walkGrid()[k*GRID_X + i] === 1;
}
export function roomThroughDoor(x, z) {
  if (!inside) return false;
  room.worldToLocal(probeWalk.set(x, room.position.y, z));
  return probeWalk.x < -ROOM_W/2 - RECESS + 0.25;
}
/** The near plane the room's view uses (see enterBuilding). */
export const roomNear = () => ROOM_NEAR;

/** Which of the layouts the room's laid out as ('home', 'office', 'warehouse', 'factory', 'pub', 'salon' or 'clothes'), or null if nobody's inside. */
export const roomKind = () => inside ? current.name : null;
/** Where anyone can sit in the room, in the world: { x, y, z } on the seat, { nx, nz } the way it faces, and who's `by` it. */
export const roomSeats = () => current.seats;

// Walking about the room: a grid over its floor (and any bedroom's: see floorRects), CELL square, of where there's room to
// walk — BODY clear of the walls and the furniture (1) — or only floor (2), built for the room as it's laid out the
// first time anyone needs it. Near where they start and where they're going, though, any floor will do: someone getting
// up off the sofa, or going to sit on it, is well within BODY of it and the coffee table in front.
const CELL = 0.1;
let GRID_X, GRID_Z, GX0, GZ0; // (its size, and its (-x, -z) corner: set as the room's sized, see shapeRoom)
placeCamera();
const BODY = 0.2, LEEWAY = 0.45;
function walkGrid() {
  if (grid) return grid;
  grid = new Uint8Array(GRID_X*GRID_Z);
  // (rooms BODY in from their walls; doorways BODY in from their sides, and on BODY either way into the rooms they join)
  const floors = floorRects(), walks = floors.map(r => {
    if (r.room) return { x0: r.x0 + BODY, x1: r.x1 - BODY, z0: r.z0 + BODY, z1: r.z1 - BODY };
    const alongX = (r.across === 'u') === (SUITE.side !== '+x'), along = BODY + CELL;
    return alongX ? { x0: r.x0 + BODY, x1: r.x1 - BODY, z0: r.z0 - along, z1: r.z1 + along }
      : { x0: r.x0 - along, x1: r.x1 + along, z0: r.z0 + BODY, z1: r.z1 - BODY };
  });
  const within = (list, x, z) => list.some(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  for (let k = 0; k < GRID_Z; k++) for (let i = 0; i < GRID_X; i++) {
    const x = GX0 + (i + 0.5)*CELL, z = GZ0 + (k + 0.5)*CELL;
    grid[k*GRID_X + i] = within(walks, x, z)
      && current.solid.every(r => x < r.x0 - BODY || x > r.x1 + BODY || z < r.z0 - BODY || z > r.z1 + BODY) ? 1
      : within(floors, x, z) ? 2 : 0;
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
    const i = Math.floor((x - GX0)/CELL), k = Math.floor((z - GZ0)/CELL);
    return i < 0 || k < 0 || i >= GRID_X || k >= GRID_Z ? -1 : k*GRID_X + i;
  };
  const walkable = (x, z) => {
    const c = cellOf(x, z);
    return c >= 0 && (open[c] === 1 || open[c] === 2 && (Math.hypot(x - a.x, z - a.z) < LEEWAY || Math.hypot(x - b.x, z - b.z) < LEEWAY));
  };
  const start = cellOf(a.x, a.z), goal = cellOf(b.x, b.z);
  if (start < 0 || goal < 0) return null;
  // breadth first over the grid, diagonals only where neither corner's cut
  const came = new Int32Array(GRID_X*GRID_Z).fill(-1), queue = [start];
  came[start] = start;
  const centre = c => ({ x: GX0 + (c % GRID_X + 0.5)*CELL, z: GZ0 + (Math.floor(c/GRID_X) + 0.5)*CELL });
  const free = (i, k) => i >= 0 && k >= 0 && i < GRID_X && k < GRID_Z && walkable(GX0 + (i + 0.5)*CELL, GZ0 + (k + 0.5)*CELL);
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
