import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { camera, Y_PARK, Y_ROAD } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { buildingNumber as numberFor } from '../buildings/footprints.js';
import { makeThumbnailDrawer } from './thumbnail.js';
import { makeCard, TEXT_ROWS } from '../ui/entity-card.js';
import { loadTypeText } from '../core/type-text.js';
import { mulberry32 } from '../core/math.js';
import { TOON_RAMP } from '../core/toon.js';
import { startFlying, endFlying, controlInput } from './possession.js';
import { blastFx, explodeBee } from './giblets.js';
import { blasts, blastDamageAt, PERSON_BLAST_SCALE } from './traffic/state.js';
import { updateBuzzes } from '../audio/buzz.js';
import { chaseBehind } from './flight.js';
import { registerHealthKind, healthOf, damage } from '../core/health.js';

// ============================================================ flowers, hives and bees
// Three things a park grows, all cut from one model (assets/models/Bee.glb, made in Blender): patches of flowers, a hive
// now and then hanging under a tree, and the bees that work between them.
//
// Flowers come up in clumps rather than one at a time, as many clumps as the park's Foliage slider asks for — the same
// slider the trees are on, since it's the one question "how planted is this park" (see generateParkContent). A tree has a
// small chance of a hive under it, and a hive keeps a few bees.
//
// A bee sits in its hive for a while, then goes out on a round: it makes for a flower, circles down onto it, sits there a
// moment working, moves on to the next one or two, and flies home. The model carries four shape keys and the flight
// drives all four: 'flap' beats the wings (0 all the way up, 1 all the way down), fast while it's in the air and held
// all the way down while it's sat; 'legs' reaches them out and folds them back about once every three-quarters of a
// second in the air; 'land' puts them down under it to stand on a flower, and takes over from 'legs' the moment it's
// down; and 'look' turns its head onto the flower it's coming onto or sitting on. They ride along as four morph
// influences a bee (InstancedMesh.setMorphAt), so every bee in a park is at its own point of the beat.
//
// Bees are fair-weather workers: they stay in from dusk until the sun's up again, and through anything rainier than a
// shower, and one caught out by either turns for home.
//
// Both a bee and a hive can be followed by the camera in World mode, with a card saying which it is (the cards are built
// below, in this file) — and the two change over the way a person and a train do (see riderFollowed in people.js): follow
// a bee home and the hive's card takes over with that bee picked out of whoever else is in, until it comes out and the
// camera leaves with it. A hive's card lists whichever of its bees are home whether or not the camera arrived with one of
// them.
//
// Everything static (the flowers, the hives) is an instanced mesh in the park's own group, so it's thrown away and
// rebuilt with the rest of the zone. The bees are instanced too, one mesh per park, and their flight is stepped by
// updateBees below; a park whose group has left the scene drops off the list on the next frame.
const BEE_MODEL_URL = 'assets/models/Bee.glb';

// ---------------------------------------------------------- the bee and hive cards
// Which bee or hive the camera's following, in the shared card at the bottom right (ui/entity-card.js): a bee's name and
// mood and what it loves and hates, or a hive's, from assets/bees.txt by [bee] or [hive] — read like the vehicles' and the
// trains' files (see core/type-text.js). It changes over the way a person's and a train's do: follow a bee home and the
// hive's card takes over, listing its bees under "Bees" where a building says "Inhabitants", with the one the camera came
// in with picked out, and handing back when that bee comes out again. No Smite button on either: nothing here wants to be
// the thing that kills the bees.
const text = loadTypeText('assets/bees.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'], // can have several per bee, like people: see [distribution] in bees.txt
  // this stands in until bees.txt has loaded, or if it can't be
  placeholder: { bee: { name: ['Bee'], mood: ['🐝'], loves: ['Flowers'], hates: ['Rain'] }, default: { name: ['Hive'], mood: ['🍯'], loves: ['Flowers'], hates: ['Bears'] } },
});

const beeCard = makeCard({ id: 'bee-card', title: 'Bee', health: true, onClose: () => App.stopFollowingBee(),
  thumb: { title: 'Fly it', onClick: () => App.flyBee() } }); // the picture takes the controls (see flyBee)
const hiveCard = makeCard({ id: 'hive-card', title: 'Hive', onClose: () => App.stopFollowingHive(), labels: { occupants: 'Bees' } });
const drawBeeThumbnail = makeThumbnailDrawer(beeCard.canvas);
const drawHiveThumbnail = makeThumbnailDrawer(hiveCard.canvas);

// what a bee or a hive is called, on its own card and on the other's: its kind and its own number (see numberFor)
export let beeName = number => text.of('bee', number).name + ' #' + number;
export const hiveName = number => text.of('hive', number).name + ' #' + number;

function speakInBee(number) {
  const beeLangRNG = mulberry32(number);
  let beeLanguage = '';
  for ( let bztBzts = 0; bztBzts < 1+Math.round(beeLangRNG()*2); bztBzts++) {
    for (let bzBzs = 0; bzBzs < 1+Math.round(beeLangRNG()*2); bzBzs++) {
      beeLanguage+= bzBzs === 0 ? 'B' : 'b';
      if (beeLangRNG()>0.5) beeLanguage += 'u';
      for (let zs = 0; zs< 1+Math.round(beeLangRNG()*3); zs++) {
        beeLanguage+= (beeLangRNG()>0.3) ? 'z':'m';
      }
    }
    return beeLanguage += 'zt ';
  }
}

function showBeeCard(number) {
  
  const beeRNG = mulberry32(number);

  const id = beeName(number)
  const beeLanguage = speakInBee(number)
  
  const beeText = text.of('bee', number);
  // a bee can have several loves and hates now (see the [distribution] in bees.txt); talking bee replaces them all with
  // the one thing it says about each
  let beeLove = beeText.loves.map(love => beeRNG()>0.7 ? speakInBee(number+37)+"\n("+love+")" : love);
  let beeHate = beeText.hates.map(hate => beeRNG()>0.7 ? speakInBee(number+227).toUpperCase()+"\n("+hate+")" : hate);

  
  beeCard.show({ ...beeText, name: `${beeLanguage} (${id})`, loves: beeLove, hates: beeHate} );
  drawBeeThumbnail(beeThumbnailScene());
}
// what it's up to: where it is in its round (see the flight states in bees.js)
function setBeeCardDoing(doing) {
  beeCard.set('status', doing);
}
function hideBeeCard() { beeCard.hide(); }

function showHiveCard(number) {
  hiveCard.show({ ...text.of('hive', number), name: hiveName(number) });
  setHiveCardBees([]);
  drawHiveThumbnail(hiveThumbnailScene());
}
// which of its bees are home, by name — the one the camera came in with, if any, picked out as a train's passengers are,
// and `onPick` told when one of the names is clicked, to leave with that bee instead
function setHiveCardBees(names, tracked = -1, onPick = null) {
  hiveCard.setList('occupants', names, tracked, onPick && { title: 'Follow it out of the hive', onClick: onPick });
}
function hideHiveCard() { hiveCard.hide(); }

const FLOWER_HEIGHT = 0.42;   // how tall the tallest of the three flowers stands, in world units; the others keep their proportion to it
const HIVE_HEIGHT = 0.6;
const BEE_LENGTH = 0.26;      // nose to tail
const BEE_BLAST_FX = 2;       // an explosive bee's fireball size (a car's is its height)
// The bee's body in the people's own yellow rather than the model's, which is a shade off it: the Person model's
// Skin material, as it's drawn (people.js reads that material and converts it the same way — see its palette).
const BEE_BODY_MATERIAL = /^bee\s*1$/i, BEE_BODY_COLOR = 0xffeb2b;

const FLOWER_CLUSTERS_MAX = 22;                        // clumps of flowers in a park at Foliage 1 (one clump at Foliage 0)
const FLOWER_CLUSTER_MIN = 1, FLOWER_CLUSTER_MAX = 10; // flowers in a clump
const FLOWER_CLUSTER_SPREAD = 1.15;                    // how far from the middle of a clump its flowers land
const HIVE_CHANCE = 0.05;                              // a tree's chance of one hanging under it
const HIVE_BEES_MIN = 1, HIVE_BEES_MAX = 3;

const BEE_SPEED = 2.1;        // world units a second in the air
const BEE_TURN = 3.2;         // how fast it comes round onto a new heading
const BEE_FLAP_HZ = 13;       // wingbeats a second (a real bee's two hundred would only strobe)
const BEE_LEGS_SECONDS = 0.75;  // how long the legs take to reach out and fold back once, in the air
const BEE_LOOK_EASE = 7;        // how fast the head comes round onto a flower and back up again
const BEE_REST_MIN = 5, BEE_REST_MAX = 26;      // seconds in the hive between rounds
const BEE_FLOWERS_MIN = 2, BEE_FLOWERS_MAX = 4; // flowers visited in one round
const BEE_CIRCLE_MIN = 1.6, BEE_CIRCLE_MAX = 3.4;  // seconds spent circling one down
const BEE_SIT_MIN = 1.5, BEE_SIT_MAX = 4.5;        // seconds sat on it
const BEE_RANGE = 22;         // how far from its hive a bee will go looking for a flower
const BEE_ARRIVED = 0.45;     // how near a target counts as reaching it
const BEE_HIT_REACH = 0.4;    // how near (at people size 1) a bee flown by hand has to be to someone to knock them over
const BEE_RAGE_TIME = 10;    // seconds a colony chases whoever punched one of its bees
const BEE_RAGE_SPEED = 2.2;   // how much faster than usual they fly after them
const BEE_RESPAWN_MIN = 6, BEE_RESPAWN_MAX = 14; // seconds before a bee that's died is replaced, by a new one in its hive
const BEE_CEILING = 40;       // how far above the park a bee flown by hand can climb
const BEE_DUSK = 3;           // the sun this far above the horizon or lower and they're in for the night, in degrees
const BEE_RAIN = 0.2;         // rain past this and they stay in as well
// whether it's weather to be out in at all — read once a frame, since it's the same answer for every bee in the world
const beesSheltering = () => S.sunElevation <= BEE_DUSK || S.weatherRain > BEE_RAIN;

// ---- the model: one geometry per part, baked out of the file's own nodes
let model = null; // { flowers: [{ geometry, perch }], hive, bee } once loaded, null until then

const V = new THREE.Vector3(), N = new THREE.Vector3(), M3 = new THREE.Matrix3();
const L3 = new THREE.Matrix3(), R3 = new THREE.Matrix3(), TURN = new THREE.Matrix4();
// Flattens one node of the model — a flower, the hive, the bee — into a single geometry in the node's own space, with
// each part's material color and how see-through it is written into a four-component vertex color. Triangles are sorted
// solid-first, see-through-after, and put in two groups, so one mesh draws the lot with a material for each: the bee's
// wings are glassy and the rest of it isn't. The node's shape keys come across as morph targets on the baked geometry,
// and so does a note of which vertices took their color from the material named "Foliage Tint" — the green in a flower
// that a park recolors to match its own trees (see tintedFlowers).
const TINT_MATERIAL = /foliage\s*tint/i;
function bakeNode(node) {
  node.updateMatrixWorld(true);
  const positions = [], normals = [], colors = [], solid = [], clear = [], tinted = [];
  // every shape key in the node, in the order the parts that have them list them; a part without one (the wings have no
  // say in where the legs are) contributes nothing but zeroes to it
  const names = [];
  node.traverse(o => o.isMesh && o.morphTargetDictionary && Object.keys(o.morphTargetDictionary)
    .sort((a, b) => o.morphTargetDictionary[a] - o.morphTargetDictionary[b])
    .forEach(name => { if (!names.includes(name)) names.push(name); }));
  const shapePositions = names.map(() => []), shapeNormals = names.map(() => []);
  node.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry, pos = geo.attributes.position, nor = geo.attributes.normal;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const alpha = mat.transparent && mat.opacity != null ? mat.opacity : 1;
    M3.getNormalMatrix(o.matrixWorld);
    const first = positions.length/3;
    for (let i=0;i<pos.count;i++) {
      V.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      positions.push(V.x, V.y, V.z);
      if (nor) { N.fromBufferAttribute(nor, i).applyMatrix3(M3).normalize(); normals.push(N.x, N.y, N.z); }
      else normals.push(0, 1, 0);
      colors.push(mat.color.r, mat.color.g, mat.color.b, alpha);
    }
    if (TINT_MATERIAL.test(mat.name || '')) tinted.push([first, pos.count]);
    // the same vertices' shape-key offsets, which are differences between two shapes rather than places, so they follow
    // the part through its turn and its scaling but not through its move
    L3.setFromMatrix4(o.matrixWorld);
    R3.setFromMatrix4(TURN.extractRotation(o.matrixWorld));
    names.forEach((name, m) => {
      const at = o.morphTargetDictionary ? o.morphTargetDictionary[name] : undefined;
      const dp = at == null ? null : (geo.morphAttributes.position || [])[at];
      const dn = at == null ? null : (geo.morphAttributes.normal || [])[at];
      for (let i=0;i<pos.count;i++) {
        if (dp) { V.fromBufferAttribute(dp, i).applyMatrix3(L3); shapePositions[m].push(V.x, V.y, V.z); }
        else shapePositions[m].push(0, 0, 0);
        if (dn) { N.fromBufferAttribute(dn, i).applyMatrix3(R3); shapeNormals[m].push(N.x, N.y, N.z); }
        else shapeNormals[m].push(0, 0, 0);
      }
    });
    const index = geo.index, corners = index ? index.count : pos.count;
    const into = alpha < 1 ? clear : solid;
    for (let t=0;t<corners;t++) into.push(first + (index ? index.getX(t) : t));
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4)); // four, so the wings keep their own transparency
  if (names.length) {
    geometry.morphAttributes.position = shapePositions.map(a => new THREE.Float32BufferAttribute(a, 3));
    geometry.morphAttributes.normal = shapeNormals.map(a => new THREE.Float32BufferAttribute(a, 3));
    geometry.morphTargetsRelative = true; // glTF keeps a shape key as offsets from the base shape, not as a shape of its own
  }
  geometry.userData.shapes = names;
  geometry.userData.tinted = tinted;
  geometry.setIndex(solid.concat(clear));
  geometry.addGroup(0, solid.length, 0);
  if (clear.length) geometry.addGroup(solid.length, clear.length, 1);
  geometry.computeBoundingBox();
  return geometry;
}
const sizeOf = geometry => geometry.boundingBox.getSize(new THREE.Vector3());
// The biggest part of a node, in the same space bakeNode leaves it in: for the hive that's the hive itself rather than
// the cord it hangs from, which runs on as far up as the model likes so that it always reaches into the leaves.
function biggestPart(node) {
  node.updateMatrixWorld(true);
  let biggest = null, most = -1;
  node.traverse(o => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const size = box.getSize(V), room = size.x*size.y*size.z;
    if (room > most) { most = room; biggest = box; }
  });
  return biggest;
}
// Where a bee settles on a flower: the middle of whatever is in its top fifth, which is the blossom rather than the stem.
function perchOf(geometry) {
  const pos = geometry.attributes.position, box = geometry.boundingBox;
  const cut = box.max.y - (box.max.y - box.min.y)*0.2;
  const at = new THREE.Vector3();
  let n = 0;
  for (let i=0;i<pos.count;i++) { V.fromBufferAttribute(pos, i); if (V.y >= cut) { at.add(V); n++; } }
  return n ? at.divideScalar(n) : box.getCenter(new THREE.Vector3());
}
// Moves a baked geometry's shape keys along with it: applyMatrix4 (and so translate, scale and rotateY) only knows about
// position and normal, and the offsets a shape key is made of want the turn and the scaling of a move but not the move
// itself — and the normal offsets, which are added to normals that are already unit length, want only the turn.
function moveShapes(geometry, matrix) {
  L3.setFromMatrix4(matrix);
  R3.setFromMatrix4(TURN.extractRotation(matrix));
  (geometry.morphAttributes.position || []).forEach(a => a.applyMatrix3(L3));
  (geometry.morphAttributes.normal || []).forEach(a => a.applyMatrix3(R3));
}

// Smooth shading for the bee. The model comes over flat-shaded — a normal a face, with a face's corners split off into
// vertices of their own — which on something this small reads as a handful of facets catching the light one at a time.
// Averaging the normals of everything that meets at a point rounds it off instead, the way Blender's own shade-smooth
// does. Two vertices only count as the same point if every shape key leaves them in the same place as well, so the
// wings, which move where the body doesn't, don't drag the body's shading around with them through a beat. A shape
// key's normal offsets are averaged the same way, on the shape that key describes, and written back as the difference
// from the smoothed base normal, which is what they were and what the shader adds them to.
function smoothShade(geometry) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal;
  const shapePositions = geometry.morphAttributes.position || [], shapeNormals = geometry.morphAttributes.normal || [];
  const round = v => Math.round(v*1e4); // a place to a ten-thousandth, so vertices meant to be together find each other
  const groups = new Map();
  for (let i=0;i<pos.count;i++) {
    let key = `${round(pos.getX(i))},${round(pos.getY(i))},${round(pos.getZ(i))}`;
    shapePositions.forEach(d => { key += ` ${round(d.getX(i))},${round(d.getY(i))},${round(d.getZ(i))}`; });
    const group = groups.get(key);
    if (group) group.push(i); else groups.set(key, [i]);
  }
  const sum = new THREE.Vector3(), one = new THREE.Vector3(), base = new THREE.Vector3();
  // where a group of vertices points between them, either as they stand or as one shape key leaves them
  const average = (group, offsets) => {
    sum.set(0, 0, 0);
    group.forEach(i => {
      one.fromBufferAttribute(nor, i);
      if (offsets) one.set(one.x + offsets.getX(i), one.y + offsets.getY(i), one.z + offsets.getZ(i));
      sum.add(one.normalize());
    });
    if (sum.lengthSq() < 1e-10) sum.fromBufferAttribute(nor, group[0]); // a part with a face each way: leave it be
    return sum.normalize();
  };
  groups.forEach(group => {
    base.copy(average(group, null)); // read before anything is written back: the shapes' averages are built on it
    shapeNormals.forEach(offsets => {
      const smoothed = average(group, offsets);
      group.forEach(i => offsets.setXYZ(i, smoothed.x - base.x, smoothed.y - base.y, smoothed.z - base.z));
    });
    group.forEach(i => nor.setXYZ(i, base.x, base.y, base.z));
  });
  nor.needsUpdate = true;
  shapeNormals.forEach(a => { a.needsUpdate = true; });
}

// Solid and see-through halves of anything out of this model. Both take their color from the vertices, so one pair does
// for the flowers, the hives, the bees and the cards' thumbnails, and neither is ever disposed — every mesh that uses
// them is marked shared, so a park rebuilding doesn't take the shader program down with it (see disposeObject). The bees
// need nothing of their own: three.js reads the morph targets off the geometry and compiles its own program for them.
const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide });
const clearMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2, side: THREE.DoubleSide, transparent: true, depthWrite: false });
// the bees themselves are toon-shaded, like people (see core/toon.js); the flowers and hives aren't
const beeSolidMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: TOON_RAMP, side: THREE.DoubleSide });
const beeClearMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: TOON_RAMP, side: THREE.DoubleSide, transparent: true, depthWrite: false });

export async function loadBeeModel() {
  let gltf;
  try {
    const buffer = await fetch(BEE_MODEL_URL).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.arrayBuffer(); });
    gltf = await new GLTFLoader().parseAsync(buffer, '');
  } catch (err) {
    console.warn('Kallipolis: the bee model failed to load; parks go without flowers, hives and bees', err);
    return;
  }
  try {
    // the body's color, before any of it is baked into vertex colors
    gltf.scene.traverse(o => (Array.isArray(o.material) ? o.material : [o.material])
      .forEach(mat => { if (mat && BEE_BODY_MATERIAL.test(mat.name || '')) mat.color.setHex(BEE_BODY_COLOR); }));
    // (three.js puts underscores in place of the spaces in a glTF node's name, so "Flower 1" arrives as "Flower_1")
    const node = name => {
      const o = gltf.scene.getObjectByName(name) || gltf.scene.getObjectByName(name.replace(/\s+/g, '_'));
      if (!o) throw new Error(`the model has no "${name}"`);
      return o;
    };
    // the three flowers to one scale, so the tallest stands FLOWER_HEIGHT and the others keep their proportion to it
    const flowers = ['Flower 1', 'Flower 2', 'Flower 3'].map(name => bakeNode(node(name)));
    const tallest = Math.max(...flowers.map(g => sizeOf(g).y));
    flowers.forEach(geometry => {
      const box = geometry.boundingBox, mid = box.getCenter(new THREE.Vector3());
      geometry.translate(-mid.x, -box.min.y, -mid.z); // stood on its own spot on the ground
      geometry.scale(FLOWER_HEIGHT/tallest, FLOWER_HEIGHT/tallest, FLOWER_HEIGHT/tallest);
      geometry.computeBoundingBox();
    });
    // The hive hangs, so its origin goes at the top of it — that's the point that meets the branch, and the cord carries
    // on above it into the canopy. Both the size and that point are taken from the hive's body alone: the cord is drawn
    // long on purpose, and measuring it as well would shrink the hive itself to whatever was left over.
    const hiveNode = node('Hive');
    const hive = bakeNode(hiveNode);
    const hiveBody = biggestPart(hiveNode);
    const hiveScale = HIVE_HEIGHT/hiveBody.getSize(new THREE.Vector3()).y;
    const hiveMid = hiveBody.getCenter(new THREE.Vector3());
    hive.translate(-hiveMid.x, -hiveBody.max.y, -hiveMid.z);
    hive.scale(hiveScale, hiveScale, hiveScale);
    hive.computeBoundingBox();
    // and the card frames the body rather than all that cord
    hive.userData.frame = hiveBody.clone().translate(new THREE.Vector3(-hiveMid.x, -hiveBody.max.y, -hiveMid.z))
      .applyMatrix4(new THREE.Matrix4().makeScale(hiveScale, hiveScale, hiveScale));
    // the bee, centered on itself and turned to face +Z like everything else here that moves under its own steam; it's
    // modelled head-along-+X, so that's a quarter turn the other way, and it leaves the wings reaching out along ±X
    const bee = bakeNode(node('Bee'));
    smoothShade(bee);
    const beeScale = BEE_LENGTH/sizeOf(bee).x;
    const beeMid = bee.boundingBox.getCenter(new THREE.Vector3());
    bee.translate(-beeMid.x, -beeMid.y, -beeMid.z);
    bee.scale(beeScale, beeScale, beeScale);
    bee.rotateY(-Math.PI/2);
    moveShapes(bee, new THREE.Matrix4().makeRotationY(-Math.PI/2).multiply(new THREE.Matrix4().makeScale(beeScale, beeScale, beeScale)));
    bee.computeBoundingBox(); // only once the shape keys have been scaled along with it: three.js grows the box to hold
    // however far they reach, and at the size they arrive in that's a box three times around the bee — which is what the
    // card's thumbnail frames, and why it sat so far back
    // which shape key is which, by name and whatever order they came out of the file in; a missing one is simply never
    // driven, so an export without the legs in it still flies and still flaps
    const shapes = bee.userData.shapes.map(name => name.toLowerCase());
    const shape = { flap: shapes.indexOf('flap'), legs: shapes.indexOf('legs'), look: shapes.indexOf('look'), land: shapes.indexOf('land') };
    model = { flowers: flowers.map(geometry => ({ geometry, perch: perchOf(geometry) })), hive, bee, shape, shapeCount: shapes.length };
  } catch (err) {
    console.warn('Kallipolis: the bee model failed to build; parks go without flowers, hives and bees', err);
    return;
  }
  // parks built before it arrived have no flowers in them yet
  S.zones.forEach(zone => { if (zone.zoneType === 'park') App.subdivideZone(zone); });
}

// the cards' thumbnails: the model's own bee and hive, framed from an isometric angle like a car's or a building's. A
// still bee is posed mid-beat with its legs out rather than left at the shape keys' zero, which would have its wings
// straight up and nothing to stand on.
const THUMBNAIL_POSE = { flap: 0.45, legs: 1, look: 0, land: 0 };
// what a geometry fills once its shape keys are turned up as far as this pose turns them
function posedBox(geometry, influences) {
  const pos = geometry.attributes.position, shapes = geometry.morphAttributes.position || [];
  const box = new THREE.Box3();
  for (let i=0;i<pos.count;i++) {
    V.fromBufferAttribute(pos, i);
    shapes.forEach((d, m) => { const by = influences ? influences[m] : 0; if (by) V.addScaledVector(N.fromBufferAttribute(d, i), by); });
    box.expandByPoint(V);
  }
  return box;
}
function thumbnailOf(geometry) {
  if (!geometry) return null; // (no thumbnail before the model has loaded)
  const mesh = new THREE.Mesh(geometry, [solidMaterial, clearMaterial]);
  if (mesh.morphTargetInfluences && model) Object.entries(THUMBNAIL_POSE)
    .forEach(([key, value]) => { if (model.shape[key] >= 0) mesh.morphTargetInfluences[model.shape[key]] = value; });
  // framed on the pose it's drawn in rather than on the geometry's own box, which three.js grows to hold every shape
  // key at once — all of them at full stretch and at the same time, which is a good deal more room than a bee takes up
  const box = geometry.userData.frame || posedBox(geometry, mesh.morphTargetInfluences);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  mesh.position.sub(center);
  const elevation = Math.atan(1/Math.SQRT2), azimuth = Math.PI/4, distance = radius*4;
  const view = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, distance*2);
  view.position.set(distance*Math.cos(elevation)*Math.sin(azimuth), distance*Math.sin(elevation), distance*Math.cos(elevation)*Math.cos(azimuth));
  view.lookAt(0, 0, 0);
  return { mesh, camera: view };
}
export const beeThumbnailScene = () => thumbnailOf(model && model.bee);
export const hiveThumbnailScene = () => thumbnailOf(model && model.hive);

// ---- what a park gets
// one per park that has any bees at all: { group, hiveMesh, hives, mesh, bees }, pruned once the park's group has
// left the scene (its zone rebuilt or deleted), which is also what lets go of anything the camera was following in it
const colonies = [];

function instanced(geometry, count, materials, name) {
  const mesh = new THREE.InstancedMesh(geometry, materials, count);
  mesh.count = 0;
  mesh.name = name;
  mesh.userData.sharedMaterial = true; // module-wide and never disposed (see the materials above)
  return mesh;
}
// Flowers in a park's own green: the model's "Foliage Tint" material is the leafy part of a blossom, and it's meant to
// match the trees it's growing under rather than whatever green the model was drawn with. A tree's canopy is a neutral
// gray with the Tree tint multiplied over it (see makeTreeMesh), rolled a little lighter or darker a tree; a flower
// takes the middle of that roll, so a bed of them sits in the same green as the stand of trees around it.
//
// One set of geometries a tint, kept for as long as the page is up: every park on the same tint shares the one set, so
// the flower meshes stay shared geometry and a park rebuilding still disposes nothing (see disposeObject).
const FLOWER_TINT_LIGHTNESS = 0.55;
const tintedFlowers = new Map();
const tintColor = new THREE.Color();
function flowersInTint(tint) {
  const key = tint != null ? new THREE.Color(tint).getHexString() : 'none';
  let set = tintedFlowers.get(key);
  if (set) return set;
  tintColor.setHSL(0, 0, FLOWER_TINT_LIGHTNESS).multiply(new THREE.Color(tint != null ? tint : 0xffffff));
  set = model.flowers.map(flower => {
    const ranges = flower.geometry.userData.tinted;
    if (!ranges.length) return flower;
    const geometry = flower.geometry.clone();
    const color = geometry.attributes.color;
    ranges.forEach(([first, count]) => {
      for (let i=first;i<first+count;i++) color.setXYZ(i, tintColor.r, tintColor.g, tintColor.b);
    });
    return { geometry, perch: flower.perch };
  });
  tintedFlowers.set(key, set);
  return set;
}
const between = (rng, lo, hi) => lo + rng()*(hi - lo);
const countBetween = (rng, lo, hi) => lo + Math.floor(rng()*(hi - lo + 1));

// Plants a park: clumps of flowers wherever `spot` finds room for them, a hive under the odd tree, and bees to work it.
// `spot()` gives back a free point in the park (or null when it can't find one) and `clear(x, z)` says whether a
// particular point is free, both of them the park's own business — flowers keep off roads, paths and the sand for the
// same reasons trees do. `trees` are the trees that went in, each with the underside of its canopy, which is what a hive
// hangs from. `foliage` is the Foliage slider, 0 to 1, and `tint` the park's Tree tint, which its flowers take too.
export function plantParkLife(zone, { rng, foliage, ground, spot, clear, trees, tint }) {
  if (!model) return;
  const flowers = flowersInTint(tint);
  const placed = [];
  const clusters = Math.round(1 + foliage*(FLOWER_CLUSTERS_MAX - 1));
  for (let c=0;c<clusters;c++) {
    const middle = spot();
    if (!middle) break;
    const n = countBetween(rng, FLOWER_CLUSTER_MIN, FLOWER_CLUSTER_MAX);
    for (let k=0;k<n;k++) {
      // the first one stands in the middle of the clump; the rest fall around it, wherever there's room
      const angle = rng()*Math.PI*2, out = k === 0 ? 0 : Math.sqrt(rng())*FLOWER_CLUSTER_SPREAD;
      const x = middle.x + Math.cos(angle)*out, z = middle.z + Math.sin(angle)*out;
      if (k > 0 && !clear(x, z)) continue;
      placed.push({ x, z, variant: Math.floor(rng()*flowers.length), scale: between(rng, 0.78, 1.3), turn: rng()*Math.PI*2 });
    }
  }
  const held = new THREE.Object3D();
  const flowerSpots = []; // where a bee can settle, in world space
  flowers.forEach((flower, variant) => {
    const mine = placed.filter(f => f.variant === variant);
    if (!mine.length) return;
    const mesh = instanced(flower.geometry, mine.length, [solidMaterial, clearMaterial], 'Flowers');
    mesh.userData.sharedGeometry = true; // the model's, shared by every park
    mesh.receiveShadow = true;
    mine.forEach((f, i) => {
      held.position.set(f.x, ground, f.z);
      held.rotation.set(0, f.turn, 0);
      held.scale.setScalar(f.scale);
      held.updateMatrix();
      mesh.setMatrixAt(i, held.matrix);
      flowerSpots.push(new THREE.Vector3(flower.perch.x, flower.perch.y, flower.perch.z)
        .multiplyScalar(f.scale).applyAxisAngle(THREE.Object3D.DEFAULT_UP, f.turn).add(held.position));
    });
    mesh.count = mine.length;
    mesh.instanceMatrix.needsUpdate = true;
    zone.buildingsGroup.add(mesh);
  });

  // a hive under the odd tree, hung off the underside of the canopy and a little way out from the trunk
  const hives = [];
  (trees || []).forEach((tree, index) => {
    if (rng() >= HIVE_CHANCE) return;
    const angle = rng()*Math.PI*2, out = tree.canopyR*between(rng, 0.3, 0.6);
    // shrunk if it would otherwise hang down into the grass, which a small enough tree's canopy would
    const scale = Math.min(1, (tree.canopyY - 0.25)/HIVE_HEIGHT);
    if (scale < 0.35) return;
    const x = tree.x + Math.cos(angle)*out, z = tree.z + Math.sin(angle)*out;
    const y = ground + tree.canopyY + HIVE_HEIGHT*scale*0.12; // its top tucked up into the leaves
    hives.push({ number: numberFor(zone.id + ':hive:' + index), x, y, z, scale, turn: rng()*Math.PI*2,
      bees: countBetween(rng, HIVE_BEES_MIN, HIVE_BEES_MAX),
      // about where the hole in the front of it is, which is where its bees come and go from
      mouth: new THREE.Vector3(x, y - HIVE_HEIGHT*scale*0.45, z) });
  });
  if (!hives.length) return;
  const hiveMesh = instanced(model.hive, hives.length, [solidMaterial, clearMaterial], 'Hives');
  hiveMesh.userData.sharedGeometry = true;
  hiveMesh.castShadow = true; hiveMesh.receiveShadow = true;
  hives.forEach((h, i) => {
    held.position.set(h.x, h.y, h.z);
    held.rotation.set(0, h.turn, 0);
    held.scale.setScalar(h.scale);
    held.updateMatrix();
    hiveMesh.setMatrixAt(i, held.matrix);
  });
  hiveMesh.count = hives.length;
  hiveMesh.instanceMatrix.needsUpdate = true;
  zone.buildingsGroup.add(hiveMesh);

  // and the bees, each belonging to the hive it came out of, and each with the flowers within reach of it
  const bees = [];
  hives.forEach((hive, index) => {
    const near = flowerSpots.filter(f => f.distanceTo(hive.mouth) < BEE_RANGE);
    for (let k=0;k<hive.bees;k++) {
      const key = zone.id + ':bee:' + index + ':' + k;
      bees.push({ hive, key, number: numberFor(key),
        flowers: near.length ? near : flowerSpots,
        at: hive.mouth.clone(), v: new THREE.Vector3(), aim: hive.mouth.clone(),
        state: 'hive', until: between(Math.random, 0.5, BEE_REST_MAX), yaw: Math.random()*Math.PI*2, pitch: 0, bank: 0, hand: null,
        phase: Math.random()*Math.PI*2, plan: [], perch: null, angle: 0, circling: 1, flap: 0, legs: 0, look: 0, land: 1 });
    }
  });
  const beeMesh = instanced(model.bee, bees.length, [beeSolidMaterial, beeClearMaterial], 'Bees');
  beeMesh.userData.sharedGeometry = true;
  beeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  beeMesh.count = bees.length; // before the shape keys below, which size their own texture by it
  beeMesh.frustumCulled = false; // they wander away from wherever they were when the matrices were last bounded
  // a set of shape-key influences a bee, so every wing in one park isn't on the same downstroke; it's a texture on the
  // mesh rather than an attribute on the geometry, which is what lets every park share the one bee geometry
  bees.forEach((bee, k) => setShape(beeMesh, k, bee));
  zone.buildingsGroup.add(beeMesh);
  colonies.push({ group: zone.buildingsGroup, hiveMesh, hives, mesh: beeMesh, bees });
}

// ---- flight
const held = new THREE.Object3D(), toward = new THREE.Vector3(), wander = new THREE.Vector3();
held.rotation.order = 'YXZ'; // rolled about its own length first, then pitched and turned (as an aircraft is: see poseAircraft)
const pick = list => list[Math.floor(Math.random()*list.length)];
const isHome = bee => bee.state === 'hive';
/**
 * Set bee.traits from its entries in assets/bees.txt, once per bee. `speed` scales its flight speed and `size` its
 * body; other traits can be read off bee.traits wherever they're wanted.
 * @param {object} bee
 * @returns {void}
 */
function refreshBeeTraits(bee) {
  if (bee.traits) return;
  bee.traits = text.of('bee', bee.number).traits;
}
// the head, which comes round onto a flower over a moment rather than snapping onto it
const lookAt = (bee, to, dt) => { bee.look += (to - bee.look)*(1 - Math.exp(-BEE_LOOK_EASE*dt)); };
// one bee's four shape keys onto its instance of the mesh (see the model's own 'shape' for which is which)
const posed = { morphTargetInfluences: [] };
function setShape(mesh, k, bee) {
  const shape = model.shape;
  if (!model.shapeCount) return; // a bee exported without its shape keys: leave the mesh alone, or it asks for morphing it can't do
  posed.morphTargetInfluences.length = model.shapeCount;
  posed.morphTargetInfluences.fill(0);
  if (shape.flap >= 0) posed.morphTargetInfluences[shape.flap] = bee.flap;
  if (shape.legs >= 0) posed.morphTargetInfluences[shape.legs] = bee.legs;
  if (shape.look >= 0) posed.morphTargetInfluences[shape.look] = bee.look;
  if (shape.land >= 0) posed.morphTargetInfluences[shape.land] = bee.land;
  mesh.setMorphAt(k, posed);
}

// Where a bee is heading while it circles a flower: a spiral in as it drops — wide and high when it starts, right over
// the flower by the time it lands.
function circleDown(bee, t) {
  const through = 1 - Math.max(0, (bee.until - t)/bee.circling);
  const r = 0.95 - through*0.68, lift = 0.62 - through*0.5;
  bee.angle += 0.055;
  bee.aim.set(bee.perch.x + Math.cos(bee.angle)*r, bee.perch.y + lift, bee.perch.z + Math.sin(bee.angle)*r);
}
// on to the next flower of the round, or home once they're done
function nextLeg(bee) {
  bee.perch = bee.plan.length ? bee.plan.shift() : null;
  bee.state = 'travel';
  if (bee.perch) bee.aim.set(bee.perch.x, bee.perch.y + 0.75, bee.perch.z);
  else bee.aim.copy(bee.hive.mouth);
}
// wings and legs of a bee in the air
function beatWings(bee, t) {
  bee.flap = 0.5 - 0.5*Math.cos(t*BEE_FLAP_HZ*Math.PI*2 + bee.phase);
  bee.legs = 0.5 - 0.5*Math.cos(t*Math.PI*2/BEE_LEGS_SECONDS + bee.phase);
  bee.land = 0; // back off the flower, so the legs are the flight's again
}
function stepBee(bee, t, dt, sheltering) {
  if (bee.hand) { flyByHand(bee, t, dt); return; }
  // caught out by the dark or the rain: it gives up the round it was on and makes straight for home
  if (sheltering && !isHome(bee) && (bee.perch || bee.plan.length)) {
    bee.plan.length = 0;
    bee.perch = null;
    bee.state = 'travel';
    bee.aim.copy(bee.hive.mouth);
  }
  switch (bee.state) {
    case 'hive':
      bee.at.copy(bee.hive.mouth);
      bee.flap = 0; bee.legs = 0; bee.look = 0; bee.land = 1;
      // in for the night, or for the weather — and, once it lifts, out again a few seconds later rather than every bee
      // in the park at the same instant
      if (sheltering) { bee.until = t + between(Math.random, 0.5, BEE_REST_MIN); return; }
      if (t >= bee.until) {
        // out on a round: a few flowers, in whatever order they come
        const n = Math.min(bee.flowers.length, countBetween(Math.random, BEE_FLOWERS_MIN, BEE_FLOWERS_MAX));
        bee.plan = [];
        for (let i=0;i<n;i++) bee.plan.push(pick(bee.flowers));
        nextLeg(bee);
      }
      return;
    case 'land':
      // sat on the blossom with its wings folded all the way down and its legs down under it, working it over
      bee.at.lerp(bee.perch, 1 - Math.exp(-14*dt));
      bee.flap = 1; bee.legs = 0; bee.land = 1;
      lookAt(bee, 1, dt);
      if (t >= bee.until) nextLeg(bee);
      return;
    case 'circle':
      circleDown(bee, t);
      if (t >= bee.until) { bee.state = 'land'; bee.until = t + between(Math.random, BEE_SIT_MIN, BEE_SIT_MAX); }
      break;
    default: // 'travel'
      if (bee.at.distanceTo(bee.aim) < BEE_ARRIVED) {
        if (!bee.perch) { bee.state = 'hive'; bee.until = t + between(Math.random, BEE_REST_MIN, BEE_REST_MAX); return; }
        bee.state = 'circle';
        bee.circling = between(Math.random, BEE_CIRCLE_MIN, BEE_CIRCLE_MAX);
        bee.until = t + bee.circling;
        bee.angle = Math.atan2(bee.at.z - bee.perch.z, bee.at.x - bee.perch.x);
      }
      break;
  }
  flyToward(bee, t, dt);
}
// steered rather than pointed: it leans onto a new heading over a moment, and drifts about on the way there, so a leg
// of the round is a wavering line and not a ruled one — `speedScale` times as fast as it usually flies
function flyToward(bee, t, dt, speedScale = 1) {
  toward.copy(bee.aim).sub(bee.at);
  const far = toward.length();
  if (far > 1e-4) toward.multiplyScalar(BEE_SPEED*bee.traits.speed*speedScale*Math.min(1, far/0.6)/far);
  wander.set(Math.sin(t*1.7 + bee.phase), Math.sin(t*2.3 + bee.phase*1.7)*0.6, Math.cos(t*1.3 + bee.phase*0.6));
  toward.addScaledVector(wander, bee.state === 'travel' ? 0.5 : 0.18);
  bee.v.lerp(toward, 1 - Math.exp(-BEE_TURN*dt));
  bee.at.addScaledVector(bee.v, dt);
  beatWings(bee, t);
  lookAt(bee, bee.state === 'circle' ? 1 : 0, dt); // head down onto the flower it's coming onto, and up again after
  if (bee.v.lengthSq() > 0.04) bee.yaw = Math.atan2(bee.v.x, bee.v.z);
}

// ---- flying a bee by hand
// A bee hovers rather than flies like an aeroplane: W and S push it forward and back along the way it faces, A and D
// turn it on the spot, space lifts it and shift lets it sink. It takes a moment to get going and to stop (the lag),
// and leans into whatever it is doing — nose down going forward, over into a turn — so it still looks like it flies.
let flownBee = null; // the bee under the player's hands, if any; its state is bee.hand
const HAND_FORWARD = 1.6, HAND_BACK = 0.6, HAND_CLIMB = 0.8; // of its cruising speed: flat out forward, backing off, and up or down
const HAND_TURN = 2.4, HAND_LAG = 0.3;                        // radians a second it turns, and seconds it takes to answer the keys
const HAND_LEAN = 0.3, HAND_BANK = 0.45;                      // radians it tips its nose at full speed, and leans over at the full turn
const handSpeed = bee => BEE_SPEED*bee.traits.speed;
function flyByHand(bee, t, dt) {
  const hand = bee.hand, { forward, right, run, brake } = controlInput();
  const ease = (v, goal) => v + (goal - v)*(1 - Math.exp(-dt/HAND_LAG));
  const speed = handSpeed(bee);
  hand.turn = ease(hand.turn, -right*HAND_TURN);
  hand.heading += hand.turn*dt;
  hand.along = ease(hand.along, forward*(forward > 0 ? HAND_FORWARD : HAND_BACK)*speed);
  hand.vy = ease(hand.vy, ((brake ? 1 : 0) - (run ? 1 : 0))*HAND_CLIMB*speed);
  hand.vx = Math.sin(hand.heading)*hand.along;
  hand.vz = Math.cos(hand.heading)*hand.along;
  hand.x += hand.vx*dt;
  hand.z += hand.vz*dt;
  const floor = Y_PARK + 0.05, ceiling = Y_PARK + BEE_CEILING;
  hand.y = Math.max(floor, Math.min(ceiling, hand.y + hand.vy*dt));
  if ((hand.y === floor && hand.vy < 0) || (hand.y === ceiling && hand.vy > 0)) hand.vy = 0;
  bee.at.set(hand.x, hand.y, hand.z);
  bee.v.set(hand.vx, hand.vy, hand.vz);
  bee.yaw = hand.heading;
  bee.pitch = -HAND_LEAN*hand.along/(HAND_FORWARD*speed);
  bee.bank = HAND_BANK*hand.turn/HAND_TURN;
  knockOverWhoIsHit(bee);
  beatWings(bee, t);
  lookAt(bee, 0, dt);
}
// whether a bee is close enough to someone (in reach of them, and between their feet and their head) to hit them
function isTouching(bee, person) {
  const reach = BEE_HIT_REACH*S.peopleSize;
  return Math.abs(person.x - bee.at.x) <= reach && Math.abs(person.z - bee.at.z) <= reach
    && bee.at.y >= person.y && bee.at.y <= person.y + App.personHeight(person);
}
// whoever a bee flown by hand has flown into goes down, as if punched
function knockOverWhoIsHit(bee) {
  App.people?.forEach(p => { if (p.mode !== 'possessed' && isTouching(bee, p)) App.knockOverPerson?.(p, bee.at); });
}
// a bee out after someone, at their chest: whenever it reaches them they go down (again, once they're up)
function chase(bee, t, dt, person) {
  bee.state = 'travel'; bee.perch = null; bee.plan.length = 0;
  bee.aim.set(person.x, person.y + App.personHeight(person)*0.6, person.z);
  flyToward(bee, t, dt, BEE_RAGE_SPEED);
  if (isTouching(bee, person)) App.knockOverPerson?.(person, bee.at);
}
// the rage over, whatever bees are out make for home
function calmColony(colony) {
  colony.rage = null;
  colony.bees.forEach(bee => {
    if (isHome(bee) || bee.hand) return;
    bee.state = 'travel'; bee.perch = null; bee.plan.length = 0;
    bee.aim.copy(bee.hive.mouth);
  });
}
/**
 * The nearest bee in front of a punch, if there is one: within `reach` and `arcCos` of dead ahead, at the height of the
 * puncher's body.
 * @param {{x: number, y: number, z: number, heading: number, reach: number, arcCos: number, height: number}} punch
 * @returns {?object} the bee
 */
function beeInPunch({ x, y, z, heading, reach, arcCos, height }) {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  let nearest = null, nearestDistance = reach;
  colonies.forEach(colony => colony.bees.forEach(bee => {
    if (isHome(bee) || bee.at.y < y || bee.at.y > y + height) return;
    const dx = bee.at.x - x, dz = bee.at.z - z, d = Math.hypot(dx, dz);
    if (d > nearestDistance || d < 1e-3 || (dx*fx + dz*fz)/d < arcCos) return;
    nearest = bee; nearestDistance = d;
  }));
  return nearest;
}
/**
 * A punch that has landed on a bee: it dies, and the rest of its colony's bees that are out chase whoever threw it for
 * BEE_RAGE_TIME seconds, knocking them down whenever they catch them.
 * @param {object} bee - the bee (from beeInPunch)
 * @param {object} puncher - the person
 * @returns {void}
 */
function punchBee(bee, puncher) {
  const colony = colonies.find(c => c.bees.includes(bee));
  killBee(bee);
  if (colony) colony.rage = { person: puncher, until: (lastBeeTime || 0) + BEE_RAGE_TIME };
}
/**
 * Kill a bee that's out flying — wherever it was, in a burst of its colours — and put a new one in its hive to come out
 * after a few seconds. The camera on it stays where it died, following nothing. An explosive one goes up in a blast.
 * @param {object} bee
 * @returns {void}
 */
// (killBee turns the same object into a new bee, so it's always back at full)
registerHealthKind('bee', { max: 3, die: bee => killBee(bee), alive: () => true });
function killBee(bee) {
  if (isHome(bee)) return;
  if (flownBee === bee || (followedBee && followedBee.colony.bees[followedBee.index] === bee)) stopFollowingBee();
  const at = { x: bee.at.x, y: bee.at.y, z: bee.at.z };
  explodeBee(at, BEE_LENGTH*bee.traits.size, Y_PARK);
  if (bee.traits.explosive) { // (its pop becomes a person-sized blast: see blasts in traffic/state.js)
    blastFx(at, BEE_BLAST_FX, 1);
    blasts.push({ ...at, scale: PERSON_BLAST_SCALE });
  }
  bee.generation = (bee.generation || 0) + 1;
  bee.number = numberFor(bee.key + ':' + bee.generation);
  bee.traits = null; // (a new bee: its own traits, from its own number)
  bee.state = 'hive';
  bee.at.copy(bee.hive.mouth);
  bee.v.set(0, 0, 0);
  bee.plan.length = 0;
  bee.perch = null;
  bee.until = (lastBeeTime || 0) + between(Math.random, BEE_RESPAWN_MIN, BEE_RESPAWN_MAX);
}
/**
 * Hurt every bee out flying within `reach` of `at` (a blast: see updateTraffic), by blastDamageAt.
 * @param {{x: number, y: number, z: number, scale?: number}} at
 * @param {number} reach
 * @returns {void}
 */
function blastBees(at, reach) {
  colonies.forEach(colony => colony.bees.forEach(bee => {
    const d = Math.hypot(bee.at.x - at.x, bee.at.y - at.y, bee.at.z - at.z);
    if (!isHome(bee) && d <= reach) { healthOf(bee, 'bee'); damage(bee, blastDamageAt(at.scale ?? 1, d, reach)); }
  }));
}
/**
 * Kill any bee inside a box on the ground — a car's — that is low enough to be hit.
 * @param {{x: number, z: number, heading: number, halfLength: number, halfWidth: number, height: number}} box
 * @returns {void}
 */
function strikeBees({ x, z, heading, halfLength, halfWidth, height }) {
  const cos = Math.cos(heading), sin = Math.sin(heading), reach = Math.hypot(halfLength, halfWidth);
  colonies.forEach(colony => colony.bees.forEach(bee => {
    if (isHome(bee) || bee.at.y > Y_ROAD + height) return;
    const dx = bee.at.x - x, dz = bee.at.z - z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) return;
    if (Math.abs(dx*cos - dz*sin) < halfWidth && Math.abs(dx*sin + dz*cos) < halfLength) killBee(bee);
  }));
}
/**
 * The bee card's picture: take the followed bee off its round and fly it by hand, from exactly where and how fast it
 * already was. Does nothing for a bee that is indoors.
 * @returns {void}
 */
function flyBee() {
  if (!followedBee) return;
  const bee = followedBee.colony.bees[followedBee.index];
  if (isHome(bee) || bee === flownBee || !startFlying(stopFlyingBee, {
    keys: 'W/S forward and back · A/D to turn · Space to rise · Shift to sink',
    touch: 'Stick to fly it · Brake to rise · Run to sink' })) return;
  flownBee = bee;
  // (already going the way it was, so the handover is invisible)
  const along = Math.hypot(bee.v.x, bee.v.z);
  bee.hand = { x: bee.at.x, y: bee.at.y, z: bee.at.z, heading: bee.yaw, along, turn: 0, vx: bee.v.x, vy: bee.v.y, vz: bee.v.z };
  controls.goalRadius = Math.max(controls.minRadius, BEE_FOLLOW_RADIUS*0.5);
}
/**
 * Let go of the flown bee: it carries on in the direction it was going and heads home, as one caught out by the dark does.
 * @returns {void}
 */
function stopFlyingBee() {
  if (!flownBee) return;
  const bee = flownBee, hand = bee.hand;
  flownBee = null;
  endFlying();
  bee.v.set(hand.vx, hand.vy, hand.vz);
  bee.hand = null; bee.pitch = 0; bee.bank = 0;
  bee.plan.length = 0;
  bee.perch = null;
  bee.state = 'travel';
  bee.aim.copy(bee.hive.mouth);
}

// ---- following a bee, or a hive: as for a person and a building (see input.js for what a click in World mode picks)
let followedBee = null;  // { colony, index } of the bee the camera's on, or null
let followedHive = null; // likewise a hive
let homedBee = null;     // the bee the camera followed into the hive it's on now, so it can pick it out and leave with it
let beeDoingShown = null, hiveBeesShown = null; // what the cards were last told, so they're only written to on a change
const FOLLOW_MIN_RADIUS = 1.2; // the closest the camera zooms on a bee or hive it's following (people and cars use the same floor)
const BEE_FOLLOW_RADIUS = 8;   // how near the camera comes in on a bee it's following
const BEE_PICK_PIXELS = 16;    // how near a click has to land on one

// the bee under a point on the screen (the nearest, if several are), or null — like pickPerson in people.js, but a bee is
// small enough on screen to be worth a flat few pixels around wherever it is rather than a line up its middle
const screen = new THREE.Vector3();
// (out, if given, gets the picked bee's distance from the camera, for comparing across kinds)
function pickBee(clientX, clientY, out) {
  const width = window.innerWidth, height = window.innerHeight;
  let best = null, bestDepth = Infinity;
  colonies.forEach(colony => colony.bees.forEach((bee, index) => {
    if (isHome(bee)) return; // indoors, and not drawn
    screen.copy(bee.at).project(camera);
    if (Math.abs(screen.z) > 1) return; // behind the camera, or beyond what it draws
    const off = Math.hypot((screen.x + 1)/2*width - clientX, (1 - screen.y)/2*height - clientY);
    if (off <= BEE_PICK_PIXELS && screen.z < bestDepth) { best = { colony, index }; bestDepth = screen.z; }
  }));
  if (out && best) out.distance = camera.position.distanceTo(best.colony.bees[best.index].at);
  return best;
}
// the hive under a point on the screen, or null — straight off the mesh, since a hive stays where it was hung
const raycaster = new THREE.Raycaster();
function pickHive(clientX, clientY, out) {
  if (!colonies.length) return null;
  raycaster.setFromCamera(new THREE.Vector2(clientX/window.innerWidth*2 - 1, -clientY/window.innerHeight*2 + 1), camera);
  const hit = raycaster.intersectObjects(colonies.map(c => c.hiveMesh), false)[0];
  if (!hit || hit.instanceId == null) return null;
  if (out) out.distance = hit.distance;
  return { colony: colonies.find(c => c.hiveMesh === hit.object), index: hit.instanceId };
}
function followBee(colony, index) {
  stopFlyingBee();
  followedBee = { colony, index };
  beeDoingShown = null;
  controls.minRadius = FOLLOW_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, BEE_FOLLOW_RADIUS)); // swooping in, if the camera's far off
  const number = colony.bees[index].number;
  showBeeCard(number);
  beeCard.bindHealth(colony.bees[index], 'bee');
  beeCard.setFavorite({ key: 'bee:' + number, kind: 'Bee', follow: () => {
    for (const c of colonies) { const i = c.bees.findIndex(b => b.number === number); if (i >= 0) { followBee(c, i); return true; } }
    return false;
  } });
}
function followBeeAt(clientX, clientY) {
  const picked = pickBee(clientX, clientY);
  if (!picked) { stopFollowingBee(); return; }
  followBee(picked.colony, picked.index);
}
function stopFollowingBee() {
  if (!followedBee) return;
  stopFlyingBee();
  followedBee = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  hideBeeCard();
}
function followHive(colony, index) {
  followedHive = { colony, index };
  hiveBeesShown = null;
  controls.minRadius = FOLLOW_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, BEE_FOLLOW_RADIUS));
  const number = colony.hives[index].number;
  showHiveCard(number);
  hiveCard.setFavorite({ key: 'hive:' + number, kind: 'Hive', follow: () => {
    for (const c of colonies) { const i = c.hives.findIndex(h => h.number === number); if (i >= 0) { homedBee = null; followHive(c, i); return true; } }
    return false;
  } });
}
function followHiveAt(clientX, clientY) {
  const picked = pickHive(clientX, clientY);
  if (!picked) { stopFollowingHive(); return; }
  followHive(picked.colony, picked.index);
  homedBee = null; // a hive picked out by hand has nobody in particular in it
}
function stopFollowingHive() {
  if (!followedHive) return;
  followedHive = null;
  homedBee = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  hideHiveCard();
}
// what the followed bee's card says it's up to: where it's got to in its round. There's nothing for being home, since a
// bee that goes in hands the camera over to its hive and the hive's card takes over from here (see followBees).
function beeDoing(bee) {
  if (bee.hand) return 'Flying by hand';
  if (bee.state === 'land') return 'On a flower';
  if (bee.state === 'circle') return 'Circling a flower';
  return bee.perch ? 'Off to a flower' : 'Flying home';
}
// the camera each frame, once the bees have moved: on the bee it's following — which, when that bee goes into its hive,
// means changing over to the hive itself and back again when it comes out, the way following someone onto a train
// changes over to the train (see people.js) — and on a hive it's following, whose card says which of its bees are home
function followBees() {
  // out again: the camera leaves with the bee it came in with, as long as it's still on that bee's hive
  if (homedBee && !isHome(homedBee.colony.bees[homedBee.index])) {
    const { colony, index } = homedBee;
    const hive = colony.bees[index].hive;
    const onIt = followedHive && followedHive.colony === colony && colony.hives[followedHive.index] === hive;
    homedBee = null;
    if (onIt) { stopFollowingHive(); followBee(colony, index); }
  }
  if (followedBee) {
    const bee = followedBee.colony.bees[followedBee.index];
    if (isHome(bee)) {
      // and in: the hive takes over, with this bee picked out among whoever else is in
      const { colony, index } = followedBee, hive = colony.hives.indexOf(bee.hive);
      stopFollowingBee();
      if (hive >= 0) { followHive(colony, hive); homedBee = { colony, index }; }
    } else {
      const doing = beeDoing(bee);
      if (doing !== beeDoingShown) { beeDoingShown = doing; setBeeCardDoing(doing); }
      controls.goalTarget.copy(bee.at);
      if (bee.hand) chaseBehind(bee.hand.heading);
    }
  }
  if (!followedHive) return;
  const { colony } = followedHive, hive = colony.hives[followedHive.index];
  controls.goalTarget.copy(hive.mouth);
  // who's in, by name, with the bee the camera came in with picked out (as a train's passengers are) — and a click on
  // one of the others making that one the bee it came in with, to leave with when that one next flies out
  const home = [];
  colony.bees.forEach((bee, index) => { if (bee.hive === hive && isHome(bee)) home.push(index); });
  const came = homedBee && homedBee.colony === colony ? homedBee.index : -1;
  const names = home.map(index => beeName(colony.bees[index].number)), tracked = home.indexOf(came);
  const key = names.join(',') + '|' + tracked;
  if (key === hiveBeesShown) return;
  hiveBeesShown = key;
  setHiveCardBees(names, tracked, at => { homedBee = { colony, index: home[at] }; });
}

let lastBeeTime = null;
export function updateBees(t) {
  const dt = lastBeeTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastBeeTime));
  lastBeeTime = t;
  for (let i=colonies.length-1;i>=0;i--) {
    const colony = colonies[i];
    if (colony.group.parent) continue;
    // its park was rebuilt or deleted, so it goes — and so does whatever the camera was following in it
    colonies.splice(i, 1);
    colony.mesh.dispose(); // its instance buffers and its shape-key texture, neither of which disposeObject knows about
    if (homedBee && homedBee.colony === colony) homedBee = null;
    if (followedBee && followedBee.colony === colony) stopFollowingBee();
    if (followedHive && followedHive.colony === colony) stopFollowingHive();
  }
  if (S.interactionMode !== 'move') { stopFollowingBee(); stopFollowingHive(); }
  const sheltering = beesSheltering();
  const flying = []; // (the bees in the air, for their buzzing: see buzz.js)
  colonies.forEach(colony => {
    if (colony.rage && (t >= colony.rage.until || colony.rage.person.mode === 'dead')) calmColony(colony);
    colony.bees.forEach((bee, k) => {
      refreshBeeTraits(bee);
      if (colony.rage && !isHome(bee) && !bee.hand) chase(bee, t, dt, colony.rage.person);
      else stepBee(bee, t, dt, sheltering);
      // (how fast it went this frame, however it was flown, against its usual speed)
      const moved = bee.heardAt ? bee.at.distanceTo(bee.heardAt) : 0;
      (bee.heardAt ??= new THREE.Vector3()).copy(bee.at);
      if (!isHome(bee) && bee.state !== 'land' && dt > 0) {
        flying.push({ bee, x: bee.at.x, y: bee.at.y, z: bee.at.z, speed: moved/dt/(BEE_SPEED*bee.traits.speed), size: bee.traits.size, angry: !!colony.rage });
      }
      held.position.copy(bee.at);
      held.rotation.set(-bee.pitch, bee.yaw, -bee.bank);
      held.scale.setScalar(isHome(bee) ? 0 : bee.traits.size); // indoors, and not to be drawn
      held.updateMatrix();
      colony.mesh.setMatrixAt(k, held.matrix);
      setShape(colony.mesh, k, bee);
    });
    colony.mesh.instanceMatrix.needsUpdate = true;
    if (colony.mesh.morphTexture) colony.mesh.morphTexture.needsUpdate = true;
  });
  updateBuzzes(flying);
  followBees();
}

// (the bee and hive cards are handed over too, for whoever else wants to put something on them or open one)
Object.assign(App, { blastBees, strikeBees, beeInPunch, punchBee, pickBee, followBeeAt, stopFollowingBee, pickHive, followHiveAt, stopFollowingHive, flyBee, showBeeCard, setBeeCardDoing, hideBeeCard, showHiveCard, setHiveCardBees, hideHiveCard });
