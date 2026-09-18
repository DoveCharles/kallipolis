import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, Y_PARK, Y_PATH, Y_ROAD, Y_SIDEWALK, Y_ZONE_GROUND } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { mulberry32, centroid } from '../core/math.js';
import { closestPointOnSegment, buildingKey, buildingNumber } from '../buildings/footprints.js';
import { buildingKindOf, buildingTypeOf, buildingEnterable } from '../buildings/building-types.js';
import { tessellateOpenPath, tessellateClosedPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CLIPPER_SCALE, roadLineWidths, clipPolygons, unionRoadStrokes, navRebuildOnHold } from '../roads/roads.js';
import { isWalkwayLine, isRiverLine } from '../roads/paths.js';
import { isTrainLine, getTrainStations, trainStationsVersion, getTrainShuttles } from '../trains/trains.js';
import { Y_PLAZA } from '../zones/plazas.js';
import { getWaterRegion } from '../water/water.js';
import { signalRedLeft } from '../roads/markings.js';
import { toClipperPath, pathsArea, offsetPaths, createRegionTester, zoneCutoutsNear } from '../zones/cutouts.js';
import { FOOTBRIDGE_TOP } from '../water/bridges.js';
import { DEFAULT_TRAITS, profileOf, profilesVersion } from './profiles.js';
import { explode } from './giblets.js';
import { possession, controlInput, startPossession, endPossession } from './possession.js';

// ============================================================ people
// Lil people: tiny cuboids in random colors, all drawn as one instanced mesh. Most walk the walkways — the sidewalks either
// side of sidewalk roads, and paths — carrying on through junctions or turning off, and turning back at dead ends. They
// gather in plazas, parks and on beaches: someone walking past one sometimes wanders in, drifts from spot to spot (often
// over to someone already there), stands around for a while, and eventually heads back out to the nearest walkway. The
// walkways are worked out again whenever the roads or zones change, and anyone whose walkway moved is set back on the
// nearest one.
const PEOPLE_MAX = 2000;
const PERSON_WALK_SPEED = 1.4;   // world units per second at speed 1
export const PEOPLE_NAV_SPACING = 4;    // walkways are resampled to a point at least this often, for entrances and re-seating
S.peopleEnabled = false, S.peopleAmount = 300, S.peopleSpeed = 1, S.peopleSize = 1, S.showRoadsafetyDebug = false, S.showPeopleNavDebug = false;
let peopleNav = null, peopleNavBuiltAt = -Infinity, peopleNavDebugBuiltAt = -Infinity, lastPeopleTime = null;
const people = [];
const peopleRng = mulberry32(90210);
const peopleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8 }), PEOPLE_MAX);
peopleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
{
  const color = new THREE.Color();
  for (let i=0;i<PEOPLE_MAX;i++) peopleMesh.setColorAt(i, color.setHSL(peopleRng(), 0.45 + peopleRng()*0.4, 0.42 + peopleRng()*0.25));
}
peopleMesh.count = 0;
peopleMesh.frustumCulled = false;
peopleMesh.castShadow = true; peopleMesh.receiveShadow = true;
peopleMesh.visible = false;
peopleMesh.name = 'People';
scene.add(peopleMesh);

// Debug wireframes (World → Peds → Roadsafety radius (debug)): a sphere around each person showing how far they check for
// traffic before crossing (see ROADSAFETY_RADIUS below), and a box around them showing the hitbox a car's run-over check
// uses (see runOverPeople in traffic.js) — off by default, and only kept up to date while the toggle's on.
const roadsafetyDebugMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x3ddc97, wireframe: true, transparent: true, opacity: 0.35 }), PEOPLE_MAX);
roadsafetyDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
roadsafetyDebugMesh.count = 0;
roadsafetyDebugMesh.frustumCulled = false;
roadsafetyDebugMesh.visible = false;
roadsafetyDebugMesh.name = 'RoadsafetyDebug';
scene.add(roadsafetyDebugMesh);
// (and, for someone waiting in the middle of the road, just the half of it they check then — in front of them, +Z for
// a person facing +Z: see crossingClear)
const roadsafetyHalfDebugMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 12, 0, Math.PI), roadsafetyDebugMesh.material, PEOPLE_MAX);
roadsafetyHalfDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
roadsafetyHalfDebugMesh.count = 0;
roadsafetyHalfDebugMesh.frustumCulled = false;
roadsafetyHalfDebugMesh.visible = false;
roadsafetyHalfDebugMesh.name = 'RoadsafetyHalfDebug';
scene.add(roadsafetyHalfDebugMesh);
const pedHitboxDebugMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffd23d, wireframe: true }), PEOPLE_MAX);
pedHitboxDebugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pedHitboxDebugMesh.count = 0;
pedHitboxDebugMesh.frustumCulled = false;
pedHitboxDebugMesh.visible = false;
pedHitboxDebugMesh.name = 'PedHitboxDebug';
scene.add(pedHitboxDebugMesh);
// the walkway lines themselves (see buildPeopleNav below): cyan along each sidewalk ring and path, red where a path runs
// over a road (and nobody walks), yellow across each zebra crossing, and white joining a path to the sidewalk it meets —
// rebuilt whenever the nav does, shown only while the toggle's on
const peopleNavDebugMesh = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
peopleNavDebugMesh.frustumCulled = false;
peopleNavDebugMesh.visible = false;
peopleNavDebugMesh.renderOrder = 999;
peopleNavDebugMesh.name = 'PeopleNavDebug';
scene.add(peopleNavDebugMesh);
// which way (and how far, per unit of lateral offset) a walkway's point vi is set off square to it: the average of the
// nearest non-zero-length segments either side (skipping the zero-length ones a duplicate node leaves), stretched so a
// bend keeps the full width from both — wrapping round, for a ring
const NAV_MITER_LIMIT = 2;
function navVertexMitre(pts, vi, loop) {
  const last = pts.length - 1;
  const dirFrom = (j, step) => {
    for (let n = 0; n < last; n++, j += step) {
      if (loop) j = (j + last) % last;
      else if (j < 0 || j >= last) return null;
      const a = pts[j], b = pts[j+1], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len > 1e-6) return { x: (b.x-a.x)/len, z: (b.z-a.z)/len };
    }
    return null;
  };
  const d1 = dirFrom(vi-1, -1) || dirFrom(vi, 1), d2 = dirFrom(vi, 1) || d1;
  if (!d1) return { x: 0, z: 0 };
  let tx = d1.x + d2.x, tz = d1.z + d2.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-6) { tx = d1.x; tz = d1.z; } else { tx /= len; tz /= len; } // (a full U-turn)
  const stretch = 1/Math.max(tx*d1.x + tz*d1.z, 1/NAV_MITER_LIMIT);
  return { x: -tz*stretch, z: tx*stretch };
}
function rebuildPeopleNavDebug() {
  const positions = [], colors = [], walk = [0.22, 0.77, 1], blocked = [1, 0.18, 0.33], zebra = [1, 0.82, 0.2], join = [1, 1, 1];
  const seg = (a, b, c, y) => { positions.push(a.x, y, a.z, b.x, y, b.z); colors.push(...c, ...c); };
  if (peopleNav) peopleNav.lines.forEach((nav, li) => {
    const y = nav.y + 0.15;
    for (let vi = 0; vi < nav.pts.length - 1; vi++) seg(nav.pts[vi], nav.pts[vi+1], nav.blocked && (nav.blocked[vi] || nav.blocked[vi+1]) ? blocked : walk, y);
    nav.vertices.forEach((vertex, vi) => vertex.links.forEach(link => {
      if (link.li < li || (link.li === li && link.vi < vi)) return; // (each pair once)
      seg(nav.pts[vi], peopleNav.lines[link.li].pts[link.vi], link.cross ? zebra : join, y);
    }));
  });
  const geom = peopleNavDebugMesh.geometry;
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
}

// The people model (assets/models/Person.glb, made in Blender) replaces the cuboids once it's loaded: a rigged figure with
// animations — walking, standing idle (now and then scratching or having a think), waving, sitting on a bench, sitting or
// lying on the grass, and punching someone or being knocked flat — drawn, everyone at once, as one instanced mesh, flat-shaded. three.js's own rigged meshes can't be
// instanced, so the animations are baked: when the model loads, each one is played through a frame at a time and every
// bone's pose at each frame is written into a texture (a row per frame, three texels per bone), and the vertex shader poses
// each person by looking up the rows for the moment they're at — the texture blending between frames, and the shader
// between the animation they're going into and the one they're leaving. What makes each person themselves is kept in
// textures too, a texel per person, as there aren't enough vertex attributes to go round: their body shape keys, their sex
// (a man's eyelashes and lips aren't drawn), the colors of their top, pants, shoes and hair, and how much skin their clothes
// show. Their skin is always the model's yellow. Only what they're doing changes from frame to frame: their animation — the
// rows they're at in the two animations, how far they've blended from one to the other, how far their eyes are closed — in
// the instanceAnim attribute, and which way they've turned their head and what their mouth is doing, in instanceLook.
// Hairstyles (assets/models/Hair.glb, each its own mesh, placed on the model's head) ride on the head bone. A style's name
// says who can wear it: ending in _G, girls; _B, boys; _GB, either (as does no suffix). Facial hair
// (assets/models/FacialHair.glb) works the same way, but only boys wear it. Each style is an instanced mesh of its own,
// holding just the people with that style, who carry a copy of their pose and their index into the traits texture.
const PERSON_MODEL_URL = 'assets/models/Person.glb';
const HAIR_MODEL_URL = 'assets/models/Hair.glb';
const FACIAL_HAIR_MODEL_URL = 'assets/models/FacialHair.glb';
const PERSON_BAKE_FPS = 24;
// how far a person walks for each cycle of the walk animation, in the distances the model's foot travels in one — the higher,
// the slower the walk plays for the same speed
const WALK_CYCLE_LENGTH = 4;
// the model's animations: `loop` for those playing round and round (walking, standing idle, sitting on a bench), the rest
// playing through once (Idle2, Idle3, Wave, Punch, Fall) or being a single pose, held; `pose` for sitting and lying down;
// `from` for a pose that's the last frame of another animation (Fallen: lying where Fall leaves them)
const PERSON_CLIPS = [
  { name: 'Walk', loop: true }, { name: 'Idle', loop: true }, { name: 'Idle2' }, { name: 'Idle3' }, { name: 'Wave' },
  { name: 'Sit1', loop: true, pose: true }, { name: 'SitDown1', pose: true }, { name: 'SitDown2', pose: true }, { name: 'SitDown3', pose: true },
  { name: 'LieDown1', pose: true }, { name: 'LieDown2', pose: true }, { name: 'LieDown3', pose: true },
  { name: 'Punch' }, { name: 'Fall' }, { name: 'Fallen', from: 'Fall', pose: true },
];
const FIDGETS = ['Idle2', 'Idle3'], GRASS_SITS = ['SitDown1', 'SitDown2', 'SitDown3'], LIE_DOWNS = ['LieDown1', 'LieDown2', 'LieDown3'];
// seconds to blend from one animation into the next: between walking, standing and waving, and into or out of sitting or lying
const FADE_QUICK = 0.2, FADE_POSE = 0.6;
const CHAT_GAP = 1.1;        // how far apart two people stand to talk, at people size 1
const CIRCLE_RADIUS = 1.35;  // how far from the middle of a circle sat on the grass each of them sits, at people size 1
const CIRCLE_MAX = 4;
// every shape key the shader applies, in the order of the shape key texture, and the bit of personVertex.z saying a vertex
// moves with it: the body's (1) and the head's and eyes' shapes (8, 16), set once per person; Blink (2), as they blink;
// the mouth's Talk and Emotion (4), as they talk and listen; and the eyes' Shock, Happy, Angry and Sad (32), as they feel
const PERSON_SHAPE_KEYS = ['Breast', 'Waist', 'Hips', 'Weight', 'Butt', 'Blink', 'Talk', 'Emotion', 'Key 1', 'Key 2', 'Shape1', 'Shape2', 'Shape3',
  'Shock', 'Happy', 'Angry', 'Sad'];
const PERSON_SHAPE_KEY_BITS = [1, 1, 1, 1, 1, 2, 4, 4, 8, 8, 16, 16, 16, 32, 32, 32, 32];
const PERSON_BODY_KEY_COUNT = 5;
// each person's shape keys by sex, as [lowest, highest]
const PERSON_BODY_SHAPES = {
  male:   { Breast: [0.6, 1],  Waist: [0.5, 1],    Hips: [-1, -0.5],   Weight: [0, 1],   Butt: [1, 1] },
  female: { Breast: [-1, 0.1], Waist: [-0.5, 0.1], Hips: [-0.4, 0.2], Weight: [0, 0.3], Butt: [0, 0.6] },
};
// each person's head and eye shape keys, as [lowest, highest] — or, where men's and women's differ, one of those for each
const PERSON_FACE_SHAPES = { 'Key 1': { male: [0, 1], female: [-0.3, 0] }, 'Key 2': [-0.5, 0.3], Shape1: [-0.2, 1], Shape2: [0, 1], Shape3: [0, 1] };
// How much skin clothes show: a sleeve, the tummy and a leg are each split into numbered bands (materials named Sleeve1,
// Sleeve2…, lowest nearest the body), and each person's clothes stop at one of them — it and every higher-numbered band of
// that part showing skin, the rest the clothes' color. A man's tummy is always covered.
const PERSON_CLOTHING = [
  { band: 'Sleeve', part: 'Top', count: 3 },
  { band: 'Tummy', part: 'Top', count: 2, coveredOnMen: true },
  { band: 'Leg', part: 'Pants', count: 2 },
];
// the model's materials, by name: which part of the model each vertex belongs to (its slot, in personVertex.y) — the clothes take each
// person's own colors, the rest keep the model's; and the parts only drawn for women
const PERSON_SLOTS = ['Skin', 'Top', 'Pants', 'Shoes', 'White', 'Black', 'Eyelashes', 'Lips',
  ...PERSON_CLOTHING.flatMap(c => Array.from({ length: c.count }, (_, k) => c.band + (k + 1)))];
const PERSON_FEMALE_ONLY = ['Eyelashes', 'Lips'];
// the colors each person has their own of, from row 2 of the traits texture on; then a row of where their clothes stop,
// and one of their head's and eyes' shape keys (Key 1, Key 2, Shape1, Shape2 — Shape3 being in row 1)
const PERSON_TRAIT_COLORS = ['Top', 'Pants', 'Shoes', 'Hair', 'Hat'];
const PERSON_CLOTHING_ROW = 2 + PERSON_TRAIT_COLORS.length, PERSON_FACE_ROW = PERSON_CLOTHING_ROW + 1;
// who can wear a hairstyle, from the end of its name: 'Hair3_GB' girls and boys, 'Hair6_G' only girls
const hairstyleWearers = name => {
  const suffix = /_([GB]+)$/i.exec(name)?.[1].toUpperCase();
  return suffix ? { girls: suffix.includes('G'), boys: suffix.includes('B') } : { girls: true, boys: true };
};
// a hairstyle's parts with this material take a color of their own, rather than the hair's
const isHatMaterial = name => /^Hat(\.\d+)?$/i.test(name || '');
const PANTS_COLORS = [0x26344f, 0x3e5a82, 0x5a7aa6, 0x232326, 0x4d5057, 0x8f8f93, 0xb09a72, 0x6b5038, 0x46503a];
const SHOE_COLORS = [0x151517, 0x2b2b2f, 0xeeeeea, 0x8f9298, 0x6b4a2f, 0x3b2a1e, 0x22304a, 0xb5a383];
const HAIR_TONES = [0x0f0d0c, 0x2a1d15, 0x4a3223, 0x6f4e33, 0x8a4f2a, 0xa0692f, 0xc49a5a, 0xdcc08a]; // black to platinum
//Removed light tones: 0xb9b5a 0xe3ddd2
const BLINK_DURATION = 0.5; // seconds for the eyes to close and open again
// how far a person turns their head when they glance around: side to side, and up and down
const LOOK_MAX_TURN = 50*Math.PI/180, LOOK_MAX_TILT = 15*Math.PI/180;
// the camera layer the people (and the lights) are also on, for the person card's headshot to draw them alone
export const HEADSHOT_LAYER = 3;
// the middle of a person's face, from where their head meets their neck, in the model's units
const HEAD_CENTER = new THREE.Vector3(0, 0.3, 0.2);
let personModel = null; // { mesh, anim, look, hair, headLayers, isMan, height, minY, clips, stride } once loaded

const PERSON_VERTEX_PARS = `
  uniform sampler2D personBones;
  uniform vec2 personBonesSize;
  uniform sampler2D personMorphs;
  uniform float personMorphsWidth;
  uniform float personMorphsRows;
  uniform sampler2D personTraits;
  uniform float personHeadBone;
  uniform vec3 personHeadPivot;
  attribute vec4 personJoints;
  attribute vec4 personWeights;
  // What the shader needs to know about the vertex itself, all in one attribute: a machine is only guaranteed 16 of them,
  // and instanceMatrix takes four of those while gl_InstanceID takes another. x how much the vertex moves with the head,
  // y which slot (which part of the figure) it belongs to, z which shape keys move it (see PERSON_SHAPE_KEY_BITS), and w
  // where it is in the shape key texture — which is gl_VertexID, but reading it costs an attribute of its own.
  attribute vec4 personVertex;
  attribute vec4 instanceAnim;
  attribute vec4 instanceLook;
  attribute vec4 instanceEyes;
  // which person this instance is: the instance itself for the body, and for a hairstyle (holding only some people) the
  // person it was given
  #ifdef PERSON_INDEX_ATTRIBUTE
    attribute float instancePerson;
    int personIndex() { return int(instancePerson + 0.5); }
  #else
    int personIndex() { return gl_InstanceID; }
  #endif
  // a bone's pose (as a matrix from the rest pose) at a row of the bone texture — part-way between rows is part-way between
  // frames, as the texture blends them
  mat4 personBoneAt(float bone, float row) {
    vec2 texel = 1.0/personBonesSize;
    float x = (bone*3.0 + 0.5)*texel.x, y = (row + 0.5)*texel.y;
    vec4 r0 = textureLod(personBones, vec2(x, y), 0.0);
    vec4 r1 = textureLod(personBones, vec2(x + texel.x, y), 0.0);
    vec4 r2 = textureLod(personBones, vec2(x + 2.0*texel.x, y), 0.0);
    return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
  }
  // instanceAnim: x the row they're at in the animation they're going into, y the row of the one they're leaving, z how far
  // they've gone into the first (1 all the way), w how far their eyes are closed
  mat4 personBone(float bone) {
    mat4 pose;
    if (instanceAnim.z > 0.999) pose = personBoneAt(bone, instanceAnim.x);
    else if (instanceAnim.z < 0.001) pose = personBoneAt(bone, instanceAnim.y);
    else pose = personBoneAt(bone, instanceAnim.x)*instanceAnim.z + personBoneAt(bone, instanceAnim.y)*(1.0 - instanceAnim.z);
    return pose;
  }
  mat4 personSkinMatrix() {
    mat4 m = personBone(personJoints.x)*personWeights.x;
    if (personWeights.y > 0.0) m += personBone(personJoints.y)*personWeights.y;
    if (personWeights.z > 0.0) m += personBone(personJoints.z)*personWeights.z;
    if (personWeights.w > 0.0) m += personBone(personJoints.w)*personWeights.w;
    return m;
  }
  // a posed position with the head turned — everything moving with the head bone or the bones under it (personVertex.x),
  // about where the head meets the neck — by instanceLook: x side to side, y up and down, as the head sees it (so someone
  // lying down rolls their head to the side rather than twisting it round)
  vec3 personLook(vec3 posed) {
    vec3 looked = posed;
    if (personVertex.x > 0.0 && (instanceLook.x != 0.0 || instanceLook.y != 0.0)) {
      mat4 head = personBone(personHeadBone);
      mat3 headTurn = mat3(head);
      vec3 pivot = (head*vec4(personHeadPivot, 1.0)).xyz, p = inverse(headTurn)*(posed - pivot);
      float ct = cos(instanceLook.x), st = sin(instanceLook.x), cn = cos(instanceLook.y), sn = sin(instanceLook.y);
      p = vec3(p.x, p.y*cn - p.z*sn, p.y*sn + p.z*cn);
      p = vec3(p.x*ct + p.z*st, p.y, p.z*ct - p.x*st);
      looked = mix(posed, pivot + headTurn*p, personVertex.x);
    }
    return looked;
  }
  // this person's row of the traits texture: 0 their first four body shape keys, 1 x their fifth, y whether they're a man
  // and z their Shape3, then the colors they have their own of, where their clothes stop, and their face's shape keys
  vec4 personTrait(int row) { return texelFetch(personTraits, ivec2(personIndex(), row), 0); }
  // a shape key's offset at this vertex
  vec3 personMorph(int key) {
    int width = int(personMorphsWidth), vertex = int(personVertex.w + 0.5);
    return texelFetch(personMorphs, ivec2(vertex % width, vertex/width + key*int(personMorphsRows)), 0).xyz;
  }
  // every shape key's offset at this vertex, each as far on as this person has it
  vec3 personShape() {
    int mask = int(personVertex.z + 0.5);
    vec3 offset = vec3(0.0);
    if ((mask & 1) != 0) {
      vec4 body = personTrait(0);
      offset += personMorph(0)*body.x + personMorph(1)*body.y + personMorph(2)*body.z + personMorph(3)*body.w + personMorph(4)*personTrait(1).x;
    }
    if ((mask & 2) != 0) offset += personMorph(5)*instanceAnim.w;
    if ((mask & 4) != 0) offset += personMorph(6)*instanceLook.z + personMorph(7)*instanceLook.w;
    if ((mask & 24) != 0) {
      vec4 face = personTrait(${PERSON_FACE_ROW});
      if ((mask & 8) != 0) offset += personMorph(8)*face.x + personMorph(9)*face.y;
      if ((mask & 16) != 0) offset += personMorph(10)*face.z + personMorph(11)*face.w + personMorph(12)*personTrait(1).z;
    }
    // instanceEyes: how shocked, happy, angry and sad their eyes look
    if ((mask & 32) != 0) offset += personMorph(13)*instanceEyes.x + personMorph(14)*instanceEyes.y + personMorph(15)*instanceEyes.z + personMorph(16)*instanceEyes.w;
    return offset;
  }
`;
// Adds the posing and shape keys to a material's shaders, and how it colors the figure. `look`: `femaleOnly`, the slots only
// drawn for women; and, unless it's the shadow's depth material, `palette` (each slot's own color), `traitColors` (the
// slots taking a color of the person's own instead, as { slot: traits row }) and `bands` (bands of clothes, which show skin —
// slot 0's color — if the person's clothes stop at or before them: { slot, number, cut (which of the clothing row's values
// says where their clothes stop), colorRow (the traits row of the clothes' color) }).
function injectPersonShader(shader, uniforms, look) {
  Object.assign(shader.uniforms, uniforms);
  const colored = !!look.palette;
  if (colored) shader.uniforms.personPalette = { value: look.palette };
  const hide = look.femaleOnly.length
    ? `if ((${look.femaleOnly.map(slot => `personSlotIndex == ${slot}`).join(' || ')}) && personTrait(1).y > 0.5) transformed = vec3(0.0);` : '';
  const bands = (look.bands || []).map(b => `personSlotIndex == ${b.slot} ? (${b.number}.0 >= personTrait(${PERSON_CLOTHING_ROW})[${b.cut}] ? personPalette[0] : personTrait(${b.colorRow}).rgb) : `).join('');
  const color = colored
    ? 'vPersonColor = ' + bands + Object.entries(look.traitColors).map(([slot, row]) => `personSlotIndex == ${slot} ? personTrait(${row}).rgb : `).join('') + 'personPalette[personSlotIndex];' : '';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + PERSON_VERTEX_PARS
      + (colored ? `uniform vec3 personPalette[${look.palette.length}];\nvarying vec3 vPersonColor;` : ''))
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed = personLook((personSkinMatrix()*vec4(transformed + personShape(), 1.0)).xyz);
      int personSlotIndex = int(personVertex.y + 0.5);
      // for a man, the parts only drawn for women are folded away to a point
      ${hide}
      ${color}`);
  if (!colored) return;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPersonColor;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vPersonColor;');
}
// An instanced mesh of `geometry` drawn with `look` (see injectPersonShader), with shadows that take the pose too;
// `byAttribute` for one whose instances say which person they are (instancePerson) rather than being them in order.
function makePersonMesh(geometry, uniforms, look, capacity, byAttribute) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide, flatShading: true });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (byAttribute) { material.defines = { PERSON_INDEX_ATTRIBUTE: '' }; depth.defines = { PERSON_INDEX_ATTRIBUTE: '' }; }
  // three.js reuses a compiled shader for materials whose onBeforeCompile reads the same, so a look of its own needs a key of its own
  const key = ['person', byAttribute, look.palette.length, JSON.stringify(look.traitColors), JSON.stringify(look.bands || []), look.femaleOnly.join(',')].join('|');
  material.onBeforeCompile = shader => injectPersonShader(shader, uniforms, look);
  material.customProgramCacheKey = () => key;
  depth.onBeforeCompile = shader => injectPersonShader(shader, uniforms, { femaleOnly: look.femaleOnly });
  depth.customProgramCacheKey = () => key + '|depth';
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.customDepthMaterial = depth;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(HEADSHOT_LAYER);
  mesh.visible = false;
  mesh.name = 'People';
  scene.add(mesh);
  return mesh;
}
// a per-instance attribute that changes every frame
function dynamicInstanceAttribute(count, size) {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count*size), size);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

async function loadGLB(url) {
  const buffer = await fetch(url).then(response => { if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.arrayBuffer(); });
  return new GLTFLoader().parseAsync(buffer, '');
}
export async function loadPersonModel() {
  const [body, hair, facialHair] = await Promise.allSettled([loadGLB(PERSON_MODEL_URL), loadGLB(HAIR_MODEL_URL), loadGLB(FACIAL_HAIR_MODEL_URL)]);
  if (body.status === 'rejected') { console.warn('Blockout: the people model failed to load; people stay cuboids', body.reason); return; }
  if (hair.status === 'rejected') console.warn('Blockout: the hair model failed to load; people go without', hair.reason);
  if (facialHair.status === 'rejected') console.warn('Blockout: the facial hair model failed to load; people go without', facialHair.reason);
  try {
    personModel = buildPersonModel(body.value, hair.status === 'fulfilled' ? hair.value : null, facialHair.status === 'fulfilled' ? facialHair.value : null);
    peopleMesh.visible = false;
  } catch (err) {
    console.warn('Blockout: the people model failed to load; people stay cuboids', err);
  }
}

// The instanced meshes, and their textures, from the loaded models.
function buildPersonModel(gltf, hairGltf, facialHairGltf) {
  const root = gltf.scene;
  const rigged = [], attached = [];
  root.traverse(o => { if (o.isSkinnedMesh) rigged.push(o); else if (o.isMesh) attached.push(o); });
  if (!rigged.length) throw new Error('the model has no rigged mesh');
  const skeleton = rigged[0].skeleton, bones = skeleton.bones;
  const boneIndex = new Map(bones.map((bone, i) => [bone, i])), boneByName = new Map(bones.map((bone, i) => [bone.name, i]));
  // the same bone on the other side of the body (three.js drops the dot from Blender's names, so Shoulder.L is ShoulderL)
  const mirrorBone = bones.map((bone, i) => {
    const side = bone.name.slice(-1), other = bone.name.slice(0, -1) + (side === 'L' ? 'R' : 'L');
    return (side === 'L' || side === 'R') && boneByName.has(other) ? boneByName.get(other) : i;
  });
  skeleton.pose();
  root.updateMatrixWorld(true);
  // the head bone and every bone under it (the eyes', the lips') — what turns when a person looks around — and where it
  // meets the neck
  const headBone = boneByName.get('Head');
  const inHead = bones.map(bone => { for (let b = bone; b; b = b.parent) if (headBone != null && b === bones[headBone]) return true; return false; });
  const headPivot = headBone != null ? bones[headBone].getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();

  // ---- the body, in the rest pose, as one mesh: every part's vertices with the bones moving them, which part they are,
  // and each shape key's offsets. A mesh riding on a bone rather than rigged (the head) moves with that bone alone. A mesh
  // that's only one side of the body — Blender's Mirror modifier isn't applied when the model's exported, as a mesh with
  // shape keys can't have its modifiers applied — gets its other side here, flipped across X onto the other side's bones.
  const positions = [], joints = [], weights = [], headWeights = [], slots = [], indices = [];
  const offsets = PERSON_SHAPE_KEYS.map(() => []);
  const toModel = new THREE.Matrix4(), toModelLinear = new THREE.Matrix3(), v = new THREE.Vector3();
  const palette = PERSON_SLOTS.map(() => new THREE.Color(0xffffff));
  [...rigged, ...attached].forEach(mesh => {
    let bone = mesh.parent;
    while (bone && !boneIndex.has(bone)) bone = bone.parent;
    if (!mesh.isSkinnedMesh && !bone) return; // not part of the figure
    const geo = mesh.geometry, pos = geo.attributes.position, count = pos.count;
    const slot = Math.max(0, PERSON_SLOTS.indexOf(mesh.material.name));
    // the model's colors, as Blender shows them (the app treats colors as they're shown, not as the linear values glTF stores)
    if (mesh.material.color) palette[slot].copy(mesh.material.color).convertLinearToSRGB();
    toModel.copy(mesh.isSkinnedMesh ? mesh.bindMatrix : mesh.matrixWorld);
    toModelLinear.setFromMatrix4(toModel);
    const ownBones = mesh.isSkinnedMesh ? mesh.skeleton.bones.map(b => boneIndex.get(b)) : null;
    const skinIndex = geo.attributes.skinIndex, skinWeight = geo.attributes.skinWeight;
    const dictionary = mesh.morphTargetDictionary || {}, targets = geo.morphAttributes.position || [];
    const keyTargets = PERSON_SHAPE_KEYS.map(key => {
      const name = Object.keys(dictionary).find(n => n.toLowerCase() === key.toLowerCase());
      return name != null ? targets[dictionary[name]] : null;
    });
    let minX = Infinity, maxX = -Infinity;
    for (let i=0;i<count;i++) { minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i)); }
    const sides = minX > -1e-4 && maxX > 1e-3 ? [1, -1] : [1];
    sides.forEach(side => {
      const first = positions.length/3;
      for (let i=0;i<count;i++) {
        v.set(pos.getX(i)*side, pos.getY(i), pos.getZ(i)).applyMatrix4(toModel);
        positions.push(v.x, v.y, v.z);
        let headWeight = 0;
        for (let k=0;k<4;k++) {
          const own = mesh.isSkinnedMesh ? ownBones[skinIndex.getComponent(i, k)] : k === 0 ? boneIndex.get(bone) : 0;
          const joint = side < 0 ? mirrorBone[own] : own, weight = mesh.isSkinnedMesh ? skinWeight.getComponent(i, k) : k === 0 ? 1 : 0;
          joints.push(joint);
          weights.push(weight);
          if (inHead[joint]) headWeight += weight;
        }
        headWeights.push(Math.min(1, headWeight));
        slots.push(slot);
        keyTargets.forEach((target, key) => {
          if (target) v.set(target.getX(i)*side, target.getY(i), target.getZ(i)).applyMatrix3(toModelLinear); else v.set(0, 0, 0);
          offsets[key].push(v.x, v.y, v.z);
        });
      }
      const index = geo.index, corners = index ? index.count : count;
      for (let t=0;t+2<corners;t+=3) {
        const a = first + (index ? index.getX(t) : t), b = first + (index ? index.getX(t+1) : t+1), c = first + (index ? index.getX(t+2) : t+2);
        // the flipped side is inside out, so its triangles wind the other way
        if (side > 0) indices.push(a, b, c); else indices.push(a, c, b);
      }
    });
  });
  const vertexCount = positions.length/3;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setAttribute('personJoints', new THREE.Float32BufferAttribute(joints, 4));
  geometry.setAttribute('personWeights', new THREE.Float32BufferAttribute(weights, 4));
  geometry.computeVertexNormals(); // (flat shading works its normals out per pixel; these are only for the shadows)
  geometry.computeBoundingBox();

  // ---- the shape key texture: a block of rows per shape key, a texel per vertex, holding its offsets
  const morphWidth = Math.min(vertexCount, 1024), morphRows = Math.ceil(vertexCount/morphWidth);
  const morphData = new Float32Array(morphWidth*morphRows*PERSON_SHAPE_KEYS.length*4);
  const morphMask = new Float32Array(vertexCount);
  PERSON_SHAPE_KEYS.forEach((key, k) => {
    const keyOffsets = offsets[k], bit = PERSON_SHAPE_KEY_BITS[k];
    for (let i=0;i<vertexCount;i++) {
      const texel = (k*morphRows*morphWidth + i)*4;
      for (let c=0;c<3;c++) morphData[texel + c] = keyOffsets[i*3 + c];
      if (Math.abs(keyOffsets[i*3]) + Math.abs(keyOffsets[i*3+1]) + Math.abs(keyOffsets[i*3+2]) > 1e-6) morphMask[i] = morphMask[i] | bit;
    }
  });
  const vertexData = new Float32Array(vertexCount*4);
  for (let i=0;i<vertexCount;i++) vertexData.set([headWeights[i], slots[i], morphMask[i], i], i*4);
  geometry.setAttribute('personVertex', new THREE.BufferAttribute(vertexData, 4));
  const morphTexture = new THREE.DataTexture(morphData, morphWidth, morphRows*PERSON_SHAPE_KEYS.length, THREE.RGBAFormat, THREE.FloatType);
  morphTexture.needsUpdate = true;

  // ---- the bone texture: each animation's frames, then its first frame again, so that blending past its last frame loops
  // back smoothly. A missing animation is the rest pose, as a single frame (and nobody does what it's for). For each one,
  // too, from its first frame: where it puts the pelvis — someone sitting or lying down keeps their pelvis where it was, not
  // their feet — how tall it leaves them, and (for sitting on a bench) how high their bottom is.
  const mixer = new THREE.AnimationMixer(root);
  const pelvisBone = bones[boneByName.get('Pelvis') ?? 0], restPelvis = pelvisBone.getWorldPosition(new THREE.Vector3());
  const clips = PERSON_CLIPS.map(def => {
    const source = def.from || def.name;
    const clip = gltf.animations.find(c => c.name.toLowerCase() === source.toLowerCase());
    if (!clip && !def.from) console.warn(`Blockout: the people model has no ${def.name} animation`);
    const sourceFrames = clip ? Math.max(1, Math.round(clip.duration*PERSON_BAKE_FPS)) : 1, frames = def.from ? 1 : sourceFrames;
    return { name: def.name, clip, missing: !clip, loop: !!def.loop && frames > 1, pose: !!def.pose, frames, duration: frames/PERSON_BAKE_FPS,
      holdAt: def.from ? (sourceFrames - 1)/PERSON_BAKE_FPS : null,
      start: 0, pelvis: new THREE.Vector3(), pelvisX: 0, pelvisZ: 0, top: 0, heightScale: 1, seatY: 0 };
  });
  let boneRows = 0;
  clips.forEach(c => { c.start = boneRows; boneRows += c.frames + 1; });
  const boneWidth = bones.length*3, boneData = new Float32Array(boneWidth*boneRows*4), pose = new THREE.Matrix4();
  // how far a foot travels over the walk, for how far a cycle of it carries a person
  const footBone = bones[boneByName.get('FootL') ?? boneByName.get('FootR') ?? 0], footPosition = new THREE.Vector3();
  let footMinZ = Infinity, footMaxZ = -Infinity;
  clips.forEach(c => {
    mixer.stopAllAction();
    const action = c.clip ? mixer.clipAction(c.clip).play() : null;
    for (let f=0;f<=c.frames;f++) {
      if (action) mixer.setTime(c.holdAt ?? (f % c.frames)/PERSON_BAKE_FPS); else skeleton.pose();
      root.updateMatrixWorld(true);
      bones.forEach((bone, b) => {
        const e = pose.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[b]).elements;
        for (let r=0;r<3;r++) {
          const o = ((c.start + f)*boneWidth + b*3 + r)*4;
          boneData[o] = e[r]; boneData[o+1] = e[4+r]; boneData[o+2] = e[8+r]; boneData[o+3] = e[12+r];
        }
      });
      if (c.name === 'Walk' && action) { footBone.getWorldPosition(footPosition); footMinZ = Math.min(footMinZ, footPosition.z); footMaxZ = Math.max(footMaxZ, footPosition.z); }
      if (f === 0) pelvisBone.getWorldPosition(c.pelvis);
    }
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  // the body at each animation's first frame, posed as the shader poses it (less the shape keys)
  clips.forEach(c => {
    let top = -Infinity, seat = Infinity;
    for (let i=0;i<vertexCount;i++) {
      const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
      let x = 0, y = 0, z = 0;
      for (let k=0;k<4;k++) {
        const w = weights[i*4 + k];
        if (!w) continue;
        const o = (c.start*boneWidth + joints[i*4 + k]*3)*4;
        x += w*(boneData[o]*px + boneData[o+1]*py + boneData[o+2]*pz + boneData[o+3]);
        y += w*(boneData[o+4]*px + boneData[o+5]*py + boneData[o+6]*pz + boneData[o+7]);
        z += w*(boneData[o+8]*px + boneData[o+9]*py + boneData[o+10]*pz + boneData[o+11]);
      }
      top = Math.max(top, y);
      // their bottom: the lowest of them right around the pelvis
      if (Math.abs(x - c.pelvis.x) < 1.2 && Math.abs(z - c.pelvis.z) < 0.6) seat = Math.min(seat, y);
    }
    c.top = top;
    c.seatY = seat < Infinity ? seat : 0;
    // only sitting or lying down moves the pelvis far enough to follow; standing about, it only sways
    if (c.pose) { c.pelvisX = c.pelvis.x - restPelvis.x; c.pelvisZ = c.pelvis.z - restPelvis.z; }
  });
  const standingTop = clips.find(c => c.name === 'Idle').top;
  clips.forEach(c => { c.heightScale = standingTop > 0 ? c.top/standingTop : 1; });
  // half floats, which (unlike full floats, everywhere) the texture can blend between rows
  const boneTexture = new THREE.DataTexture(Uint16Array.from(boneData, x => THREE.DataUtils.toHalfFloat(x)), boneWidth, boneRows, THREE.RGBAFormat, THREE.HalfFloatType);
  boneTexture.magFilter = boneTexture.minFilter = THREE.LinearFilter;
  boneTexture.needsUpdate = true;

  // ---- the hairstyles and facial hair, in the model's space, each riding on the head bone. The biggest part of each (a
  // hat aside) is the hair itself, taking the person's hair color; a hat takes their hat color; anything else (a hair
  // band) keeps its own.
  const hairSlots = ['Hair', 'Hat'], hairPalette = [new THREE.Color(0xffffff), new THREE.Color(0xffffff)];
  const headStylesFrom = (styleGltf, wearers) => {
    const styles = [];
    if (!styleGltf || headBone == null) return styles;
    styleGltf.scene.updateMatrixWorld(true);
    styleGltf.scene.children.forEach(style => {
      const parts = [];
      style.traverse(o => { if (o.isMesh) parts.push(o); });
      if (!parts.length) return;
      const hairParts = parts.filter(part => !isHatMaterial(part.material.name));
      const hair = hairParts.length ? hairParts.reduce((a, b) => b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a) : null;
      const stylePositions = [], styleSlots = [], styleIndices = [];
      parts.forEach(part => {
        let slot = 0;
        if (isHatMaterial(part.material.name)) slot = 1;
        else if (part !== hair) {
          const name = part.material.name || 'Accessory';
          slot = hairSlots.indexOf(name);
          if (slot < 0) { hairSlots.push(name); hairPalette.push(new THREE.Color(part.material.color || 0xffffff).convertLinearToSRGB()); slot = hairSlots.length - 1; }
        }
        const pos = part.geometry.attributes.position, index = part.geometry.index, first = stylePositions.length/3;
        for (let i=0;i<pos.count;i++) { v.fromBufferAttribute(pos, i).applyMatrix4(part.matrixWorld); stylePositions.push(v.x, v.y, v.z); styleSlots.push(slot); }
        const corners = index ? index.count : pos.count;
        for (let t=0;t<corners;t++) styleIndices.push(first + (index ? index.getX(t) : t));
      });
      const count = stylePositions.length/3;
      const styleGeometry = new THREE.BufferGeometry();
      styleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stylePositions, 3));
      styleGeometry.setIndex(styleIndices);
      styleGeometry.setAttribute('personJoints', new THREE.Float32BufferAttribute(new Float32Array(count*4).map((_, k) => k % 4 === 0 ? headBone : 0), 4));
      styleGeometry.setAttribute('personWeights', new THREE.Float32BufferAttribute(new Float32Array(count*4).map((_, k) => k % 4 === 0 ? 1 : 0), 4));
      const styleVertices = new Float32Array(count*4);
      for (let i=0;i<count;i++) styleVertices.set([1, styleSlots[i], 0, i], i*4);
      styleGeometry.setAttribute('personVertex', new THREE.BufferAttribute(styleVertices, 4));
      styleGeometry.computeVertexNormals();
      styles.push({ name: style.name, ...wearers(style.name), geometry: styleGeometry, mesh: null, anim: null, look: null, members: [] });
    });
    styleGltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return styles;
  };
  // each layer of what's worn on the head: its styles, and for each person which style they wear (-1 for none) and where
  // they are among its wearers. Women always wear a hairstyle if one suits them; men might go without either.
  const headLayer = (styles, rng) => ({ styles, rng, of: new Int16Array(PEOPLE_MAX).fill(-1), slot: new Int32Array(PEOPLE_MAX),
    girls: styles.map((style, k) => style.girls ? k : -1).filter(k => k >= 0), boys: styles.map((style, k) => style.boys ? k : -1).filter(k => k >= 0) });
  const hairLayer = headLayer(headStylesFrom(hairGltf, hairstyleWearers), mulberry32(31337));
  const facialHairLayer = headLayer(headStylesFrom(facialHairGltf, () => ({ girls: false, boys: true })), mulberry32(4711));
  const headLayers = [hairLayer, facialHairLayer];

  // ---- each person's traits: their sex, their body's shape keys (as far on as the ranges for their sex allow), their
  // hairstyle and facial hair (what their sex can wear), their colors, and where their clothes stop
  const traitRows = PERSON_FACE_ROW + 1, traits = new Float32Array(PEOPLE_MAX*traitRows*4);
  const isMan = new Uint8Array(PEOPLE_MAX);
  const traitRng = mulberry32(777), colorRng = mulberry32(4242), hatRng = mulberry32(8086), clothingRng = mulberry32(1990), faceRng = mulberry32(2718), color = new THREE.Color();
  const NATURAL_COLOUR_CHANCE = 0.85;
  const colorFor = {
    Top: () => colorRng() < 0.22 ? color.setHSL(0, 0, [0.1, 0.3, 0.55, 0.88][Math.floor(colorRng()*4)]) : color.setHSL(colorRng(), 0.35 + colorRng()*0.45, 0.35 + colorRng()*0.3),
    Pants: () => colorRng() < 0.8 ? color.set(PANTS_COLORS[Math.floor(colorRng()*PANTS_COLORS.length)]) : color.setHSL(colorRng(), 0.25 + colorRng()*0.3, 0.25 + colorRng()*0.25),
    Shoes: () => colorRng() < 0.7 ? color.set(SHOE_COLORS[Math.floor(colorRng()*SHOE_COLORS.length)]) : color.setHSL(colorRng(), 0.4 + colorRng()*0.45, 0.35 + colorRng()*0.25),
    // three in four have a natural hair color; the rest have dyed it something bright
    Hair: () => colorRng() < NATURAL_COLOUR_CHANCE ? color.set(HAIR_TONES[Math.floor(colorRng()*HAIR_TONES.length)]).multiplyScalar(0.9 + colorRng()*0.2) : color.setHSL(colorRng(), 0.65 + colorRng()*0.3, 0.45 + colorRng()*0.15),
    // Hair: () => color.set(HAIR_TONES[Math.floor(colorRng()*HAIR_TONES.length)]).multiplyScalar(0.9 + colorRng()*0.2),
    // its own generator, so adding it didn't change anyone's other colors
    Hat: () => hatRng() < 0.25 ? color.setHSL(0, 0, [0.08, 0.3, 0.6, 0.9][Math.floor(hatRng()*4)]) : color.setHSL(hatRng(), 0.4 + hatRng()*0.5, 0.3 + hatRng()*0.35),
  };
  for (let i=0;i<PEOPLE_MAX;i++) {
    const texel = row => (row*PEOPLE_MAX + i)*4;
    const man = traitRng() < 0.5, ranges = man ? PERSON_BODY_SHAPES.male : PERSON_BODY_SHAPES.female;
    isMan[i] = man ? 1 : 0;
    const shape = PERSON_SHAPE_KEYS.slice(0, PERSON_BODY_KEY_COUNT).map(key => { const [lo, hi] = ranges[key]; return lo + traitRng()*(hi - lo); });
    traits.set(shape.slice(0, 4), texel(0));
    // their head's and eyes' shapes
    const face = Object.values(PERSON_FACE_SHAPES).map(range => {
      const [lo, hi] = Array.isArray(range) ? range : range[man ? 'male' : 'female'];
      return lo + faceRng()*(hi - lo);
    });
    traits.set([shape[4], man ? 1 : 0, face[4]], texel(1));
    traits.set(face.slice(0, 4), texel(PERSON_FACE_ROW));
    PERSON_TRAIT_COLORS.forEach((part, k) => { colorFor[part](); traits.set([color.r, color.g, color.b], texel(2 + k)); });
    // the band each part of their clothes stops at (one past the last band for none)
    traits.set(PERSON_CLOTHING.map(c => c.coveredOnMen && man ? c.count + 1 : 1 + Math.floor(clothingRng()*(c.count + 1))), texel(PERSON_CLOTHING_ROW));
    headLayers.forEach(layer => {
      const styles = man ? layer.boys : layer.girls;
      if (!styles.length) return;
      const pick = Math.floor(layer.rng()*(man ? styles.length + 1 : styles.length));
      if (pick >= styles.length) return;
      const members = layer.styles[styles[pick]].members;
      layer.of[i] = styles[pick];
      layer.slot[i] = members.length;
      members.push(i);
    });
  }
  const traitTexture = new THREE.DataTexture(traits, PEOPLE_MAX, traitRows, THREE.RGBAFormat, THREE.FloatType);
  traitTexture.needsUpdate = true;

  // ---- the meshes
  const uniforms = {
    personBones: { value: boneTexture }, personBonesSize: { value: new THREE.Vector2(boneWidth, boneRows) },
    personMorphs: { value: morphTexture }, personMorphsWidth: { value: morphWidth }, personMorphsRows: { value: morphRows },
    personTraits: { value: traitTexture },
    personHeadBone: { value: headBone ?? 0 }, personHeadPivot: { value: headPivot },
  };
  const traitRow = part => 2 + PERSON_TRAIT_COLORS.indexOf(part);
  const bodyLook = {
    palette,
    traitColors: Object.fromEntries(['Top', 'Pants', 'Shoes'].map(part => [PERSON_SLOTS.indexOf(part), traitRow(part)])),
    femaleOnly: PERSON_FEMALE_ONLY.map(part => PERSON_SLOTS.indexOf(part)),
    bands: PERSON_CLOTHING.flatMap((c, cut) => Array.from({ length: c.count }, (_, k) =>
      ({ slot: PERSON_SLOTS.indexOf(c.band + (k + 1)), number: k + 1, cut, colorRow: traitRow(c.part) }))),
  };
  const anim = dynamicInstanceAttribute(PEOPLE_MAX, 4), look = dynamicInstanceAttribute(PEOPLE_MAX, 4), eyes = dynamicInstanceAttribute(PEOPLE_MAX, 4);
  geometry.setAttribute('instanceAnim', anim);
  geometry.setAttribute('instanceLook', look);
  geometry.setAttribute('instanceEyes', eyes);
  const mesh = makePersonMesh(geometry, uniforms, bodyLook, PEOPLE_MAX, false);
  const hairLook = { palette: hairPalette, traitColors: { 0: traitRow('Hair'), 1: traitRow('Hat') }, femaleOnly: [] };
  headLayers.flatMap(layer => layer.styles).forEach(style => {
    if (!style.members.length) { style.geometry.dispose(); return; }
    style.geometry.setAttribute('instancePerson', new THREE.InstancedBufferAttribute(Float32Array.from(style.members), 1));
    style.anim = dynamicInstanceAttribute(style.members.length, 4);
    style.look = dynamicInstanceAttribute(style.members.length, 4);
    style.eyes = dynamicInstanceAttribute(style.members.length, 4);
    style.geometry.setAttribute('instanceAnim', style.anim);
    style.geometry.setAttribute('instanceLook', style.look);
    style.geometry.setAttribute('instanceEyes', style.eyes);
    style.mesh = makePersonMesh(style.geometry, uniforms, hairLook, style.members.length, true);
  });
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });

  const box = geometry.boundingBox;
  const footTravel = footMaxZ > footMinZ ? footMaxZ - footMinZ : (box.max.y - box.min.y)*0.3;
  // the model faces along +Z, as people do
  return { mesh, anim, look, eyes, hair: headLayers.flatMap(layer => layer.styles).filter(style => style.mesh), headLayers, isMan, boneData, boneWidth, traitData: traits, palette,
    headBone: headBone ?? 0, headPivot,
    height: box.max.y - box.min.y, minY: box.min.y, clips: Object.fromEntries(clips.map(c => [c.name, c])), stride: footTravel*WALK_CYCLE_LENGTH };
}

export function syncPeopleUI() {
  document.getElementById('s-people').classList.toggle('on', S.peopleEnabled);
  document.getElementById('people-settings').style.display = S.peopleEnabled ? 'block' : 'none';
  document.getElementById('s-roadsafety-debug').classList.toggle('on', S.showRoadsafetyDebug);
  document.getElementById('s-peoplenav-debug').classList.toggle('on', S.showPeopleNavDebug);
  document.getElementById('s-peopleamount').value = S.peopleAmount;
  document.getElementById('dv-peopleamount').textContent = String(Math.round(S.peopleAmount));
  document.getElementById('s-peoplespeed').value = S.peopleSpeed;
  document.getElementById('dv-peoplespeed').textContent = S.peopleSpeed.toFixed(1);
  document.getElementById('s-peoplesize').value = S.peopleSize;
  document.getElementById('dv-peoplesize').textContent = S.peopleSize.toFixed(1);
  document.getElementById('s-traffic').value = S.trafficAmount;
  document.getElementById('dv-traffic').textContent = String(Math.round(S.trafficAmount));
}

// segments ({ a, b, ... }) bucketed for finding the nearest one to a point: near(x, z, maxD) gives { seg, q (the nearest
// point on it), t (how far along it that is), d }, or null if none is within maxD
function segmentGrid(segs, cell = 8) {
  const grid = new Map();
  segs.forEach(seg => {
    const { a, b } = seg, steps = Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/(cell*0.5)), cells = new Set();
    for (let k=0; k<=steps; k++) {
      const t = steps ? k/steps : 0;
      cells.add(Math.floor((a.x + (b.x-a.x)*t)/cell) + ',' + Math.floor((a.z + (b.z-a.z)*t)/cell));
    }
    cells.forEach(key => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(seg); });
  });
  return (x, z, maxD) => {
    const r = Math.ceil(maxD/cell), cx = Math.floor(x/cell), cz = Math.floor(z/cell), seen = new Set();
    let best = null;
    for (let dx=-r; dx<=r; dx++) for (let dz=-r; dz<=r; dz++) (grid.get((cx+dx) + ',' + (cz+dz)) || []).forEach(seg => {
      if (seen.has(seg)) return;
      seen.add(seg);
      const q = closestPointOnSegment({ x, z }, seg.a, seg.b), d = Math.hypot(q.x-x, q.z-z);
      if (d <= maxD && (!best || d < best.d)) {
        const len2 = (seg.b.x-seg.a.x)**2 + (seg.b.z-seg.a.z)**2;
        best = { seg, q, d, t: len2 ? ((q.x-seg.a.x)*(seg.b.x-seg.a.x) + (q.z-seg.a.z)*(seg.b.z-seg.a.z))/len2 : 0 };
      }
    });
    return best;
  };
}
// a line's points, resampled to at least every PEOPLE_NAV_SPACING — and (at) where each of the originals ended up
function resampleLine(pts) {
  const out = [pts[0]], at = [0];
  for (let i=1;i<pts.length;i++) {
    const a = pts[i-1], b = pts[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/PEOPLE_NAV_SPACING));
    for (let k=1;k<=steps;k++) out.push(k === steps ? b : { x: a.x + (b.x-a.x)*k/steps, z: a.z + (b.z-a.z)*k/steps });
    at.push(out.length - 1);
  }
  return { pts: out, at };
}
function cumulative(pts) {
  const cum = [0];
  for (let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
  return cum;
}
// The walkways, and the hangouts. A walkway is { pts, cum, total, loop (its last point is its first: walked round and
// round), ring, path, y, lateral (how far either side of its
// line people walk), mitres (see navVertexMitre), blocked, overWater, vertices: [{ links, entrances }] }, and one of:
// - a sidewalk ring, running down the middle of the sidewalks: every sidewalk road stroked out to mid-sidewalk width
//   and unioned — joined and capped just as the sidewalk mesh is — leaves an outline that is exactly that, one closed
//   ring round each block (and one round the outside of the network). It turns each junction's corners and runs round
//   each dead end by itself, and never crosses a road. Rings are joined across the roads by each junction's zebra
//   crossings (links with `cross`); anywhere else, people cross mid-block as they please (see maybeCrossRoad).
// - a path (a footpath or walkway line), walked anywhere across its width. Where one runs over a road it's `blocked`,
//   and the points either side are linked to the nearest sidewalk ring; paths meeting at a node are linked to each other.
// A hangout is { kind, inside, bounds, y, exits, seats, trees } per plaza, park and beach — a plaza's bench seats, a park's
// trees. Beaches are open ground, like parks: people sit in circles and lie down on them (see isOpenGround).
function buildPeopleNav() {
  const areas = [], lines = [];
  S.zones.forEach(zone => {
    if (zone.drawing || zone.points.length < 3 || (zone.zoneType !== 'plaza' && zone.zoneType !== 'park' && zone.zoneType !== 'beach')) return;
    const poly = tessellateClosedPath(zone.points);
    const paths = offsetPaths(clipPolygons(ClipperLib.ClipType.ctDifference, [toClipperPath(poly)], zoneCutoutsNear(zone, poly)), -1.2, ClipperLib.JoinType.jtMiter);
    const size = pathsArea(paths);
    if (size < 20) return;
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    paths.forEach(path => path.forEach(p => { minX=Math.min(minX,p.X); maxX=Math.max(maxX,p.X); minZ=Math.min(minZ,p.Y); maxZ=Math.max(maxZ,p.Y); }));
    const inArea = createRegionTester(paths), fountain = zone.zoneType==='plaza' ? zone.fountainSpot : null;
    const inside = fountain ? (x, z) => inArea(x, z) && Math.hypot(x - fountain.x, z - fountain.z) > fountain.r + 0.8 : inArea;
    areas.push({ kind: zone.zoneType, inside, fountain, minX: minX/CLIPPER_SCALE, maxX: maxX/CLIPPER_SCALE, minZ: minZ/CLIPPER_SCALE, maxZ: maxZ/CLIPPER_SCALE,
      size, y: zone.zoneType==='plaza' ? Y_PLAZA : Y_PARK, exits: [],
      seats: zone.zoneType==='plaza' ? (zone.benchSeats || []).map(seat => ({ ...seat, by: null })) : [],
      trees: zone.zoneType==='park' ? zone.treeSpots || [] : [] });
  });
  const inWater = createRegionTester(getWaterRegion());
  // the road network, stroked three times: out to mid-sidewalk (the rings, and what paths are blocked by), to the curb, and
  // just past the sidewalk's outer edge (what a path's end has to reach to join it)
  const midStrokes = [], curbStrokes = [], edgeStrokes = [];
  let anySidewalk = false, widestSidewalk = 0; // (the widest, for how far a building can be off a walkway: see buildingDoors)
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isWalkwayLine(line) || isRiverLine(line)) return;
    const nodePts = line.nodeIds.map(id => roadNodes[id]).filter(Boolean);
    if (nodePts.length < 2) return;
    const { hw, cw, sw } = roadLineWidths(line);
    if (sw > 0) anySidewalk = true;
    widestSidewalk = Math.max(widestSidewalk, sw);
    const path = tessellateOpenPath(nodePts).map(p => ({ X: Math.round(p.x*CLIPPER_SCALE), Y: Math.round(p.z*CLIPPER_SCALE) }));
    midStrokes.push({ radius: hw + cw + sw*0.5, path });
    curbStrokes.push({ radius: hw + cw, path });
    edgeStrokes.push({ radius: hw + cw + sw + 0.5, path });
  });
  const midOutline = midStrokes.length ? unionRoadStrokes(midStrokes) : [];
  const inMid = createRegionTester(midOutline), bySidewalk = createRegionTester(edgeStrokes.length ? unionRoadStrokes(edgeStrokes) : []);
  const onPavement = createRegionTester(curbStrokes.length ? unionRoadStrokes(curbStrokes) : []);
  const rings = [];
  midOutline.forEach(path => {
    const pts = [];
    path.forEach(P => {
      const q = { x: P.X/CLIPPER_SCALE, z: P.Y/CLIPPER_SCALE }, prev = pts[pts.length-1];
      if (!prev || Math.hypot(q.x-prev.x, q.z-prev.z) > 1e-3) pts.push(q);
    });
    while (pts.length > 2 && Math.hypot(pts[0].x-pts[pts.length-1].x, pts[0].z-pts[pts.length-1].z) <= 1e-3) pts.pop();
    let perimeter = 0;
    pts.forEach((p, k) => { const q = pts[(k+1) % pts.length]; perimeter += Math.hypot(q.x-p.x, q.z-p.z); });
    if (pts.length >= 3 && perimeter >= 6) rings.push({ pts, inserts: [] });
  });
  const nearRawRing = segmentGrid(rings.flatMap((ring, ri) => ring.pts.map((a, k) => ({ a, b: ring.pts[(k+1) % ring.pts.length], ri, k }))));
  // points that have to be ring vertices (to link to): added to the ring at the nearest point to `at`, if there's one
  // within maxD, and given back as a handle whose vi is filled in once the rings are built
  const ringPoint = (at, maxD) => {
    const hit = nearRawRing(at.x, at.z, maxD);
    if (!hit) return null;
    const handle = { k: hit.seg.k, t: hit.t, q: hit.q, li: -1, vi: -1 };
    rings[hit.seg.ri].inserts.push(handle);
    return handle;
  };
  // paths
  const pending = [];
  S.roadLines.forEach(line => {
    if (!isWalkwayLine(line)) return;
    const nodes = tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (nodes.length < 2) return;
    const { pts } = resampleLine(nodes), cum = cumulative(pts);
    if (cum[cum.length-1] < 1) return;
    const blocked = pts.map(p => inMid(p.x, p.z));
    if (blocked.every(Boolean)) return;
    const loop = line.nodeIds.length > 3 && line.nodeIds[0] === line.nodeIds[line.nodeIds.length-1]; // (drawn back onto its first node)
    const { hw } = roadLineWidths(line), li = lines.length;
    // (a path's drawn end reaches its half-width past its last point)
    const endReaches = (vi, from) => {
      const d = Math.hypot(pts[vi].x - pts[from].x, pts[vi].z - pts[from].z) || 1;
      return bySidewalk(pts[vi].x + (pts[vi].x - pts[from].x)/d*hw, pts[vi].z + (pts[vi].z - pts[from].z)/d*hw);
    };
    const nav = { pts, cum, total: cum[cum.length-1], loop, ring: false, path: true, y: Y_PATH, lateral: hw*0.55,
      blocked, overWater: pts.map(p => inWater(p.x, p.z)), vertices: pts.map(() => ({ links: [], entrances: [] })) };
    if (loop) nav.vertices[pts.length-1] = nav.vertices[0];
    lines.push(nav);
    // where it comes off a road, or ends at a sidewalk (just touching it, short of where people walk along it): onto the
    // sidewalk there
    pts.forEach((p, vi) => {
      if (loop && vi === pts.length-1) return; // (the same point as its first)
      const endsBySidewalk = !loop && ((vi === 0 && endReaches(0, 1)) || (vi === pts.length-1 && endReaches(vi, vi-1)));
      if (blocked[vi] || !(blocked[nextVertex(nav, vi, -1)] || blocked[nextVertex(nav, vi, 1)] || endsBySidewalk)) return;
      const handle = ringPoint(p, PEOPLE_NAV_SPACING + 12);
      if (handle) pending.push({ li, vi, handle });
    });
  });
  // the zebra crossings: the two ends of each, where it meets the middle of the sidewalk either side
  const zebras = [];
  (S.roadJunctions || []).forEach(j => j.arms.forEach(arm => {
    const w = arm.hw + arm.cw + arm.sw*0.5, d = j.r + 1.25, end = s => ({ x: j.x + arm.x*d + arm.z*s*w, z: j.z + arm.z*d - arm.x*s*w });
    const a = ringPoint(end(1), 2.5), b = a && ringPoint(end(-1), 2.5);
    if (a && b) zebras.push({ a, b, cross: { junction: j, arm } });
  }));
  // the rings, with those points added and every edge resampled
  rings.forEach(ring => {
    const anchors = [];
    ring.pts.forEach((p, k) => {
      anchors.push(p);
      ring.inserts.filter(h => h.k === k).sort((h1, h2) => h1.t - h2.t).forEach(h => { anchors.push(h.q); h.anchor = anchors.length - 1; });
    });
    anchors.push(ring.pts[0]);
    const { pts, at } = resampleLine(anchors), cum = cumulative(pts), li = lines.length;
    const vertices = pts.map(() => ({ links: [], entrances: [] }));
    vertices[pts.length-1] = vertices[0]; // (the ring's last point is its first)
    ring.inserts.forEach(h => { h.li = li; h.vi = at[h.anchor] === pts.length-1 ? 0 : at[h.anchor]; });
    lines.push({ pts, cum, total: cum[cum.length-1], loop: true, ring: true, path: false, y: anySidewalk ? Y_SIDEWALK : Y_ROAD, lateral: 0.7,
      blocked: null, overWater: null, vertices });
  });
  const link = (a, b, cross) => {
    lines[a.li].vertices[a.vi].links.push({ li: b.li, vi: b.vi, cross });
    lines[b.li].vertices[b.vi].links.push({ li: a.li, vi: a.vi, cross });
  };
  pending.forEach(({ li, vi, handle }) => link({ li, vi }, handle));
  zebras.forEach(({ a, b, cross }) => link(a, b, cross));
  // paths meeting at a node
  const byPlace = new Map();
  lines.forEach((nav, li) => nav.path && nav.pts.forEach((p, vi) => {
    if (nav.blocked[vi] || (nav.loop && vi === nav.pts.length-1)) return;
    const key = Math.round(p.x*2) + ',' + Math.round(p.z*2);
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push({ li, vi });
  }));
  byPlace.forEach(list => list.forEach(a => list.forEach(b => {
    if (b.li !== a.li) lines[a.li].vertices[a.vi].links.push({ li: b.li, vi: b.vi });
  })));
  lines.forEach(nav => {
    nav.mitres = nav.pts.map((p, vi) => navVertexMitre(nav.pts, vi, nav.loop));
    if (!nav.ring) return;
    // which side of the ring the road's on (relative to the mitres)
    let votes = 0;
    nav.pts.forEach((p, vi) => {
      const m = nav.mitres[vi], len = Math.hypot(m.x, m.z) || 1;
      votes += inMid(p.x + m.x/len*0.3, p.z + m.z/len*0.3) ? 1 : -1;
    });
    nav.roadSide = votes >= 0 ? 1 : -1;
  });
  // entrances: points beside (or, for a path, in) a plaza or park — never looking across a road; and a grid of every
  // point people can be at, for finding the nearest
  const grid = new Map(), CELL = 16;
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    if ((nav.loop && vi === nav.pts.length-1) || (nav.blocked && nav.blocked[vi])) return;
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ li, vi });
    if (!areas.length) return;
    const m = nav.mitres[vi], len = Math.hypot(m.x, m.z) || 1, nx = m.x/len, nz = m.z/len, edge = nav.lateral + (nav.ring ? 1.5 : 0);
    // look straight out from the walkway, a few steps further each time — a zone's edge can sit well back from the
    // sidewalk — and, for a path, at the path itself (running through a park)
    const areaAt = (x, z) => areas.findIndex(ar => x >= ar.minX && x <= ar.maxX && z >= ar.minZ && z <= ar.maxZ && ar.inside(x, z));
    const entrances = nav.vertices[vi].entrances;
    (nav.ring ? [-nav.roadSide] : [1, -1]).forEach(side => {
      const offsets = (nav.path ? [0] : []).concat([2, 5, 9, 14].map(extra => side*(edge + extra)));
      for (const off of offsets) {
        const x = p.x + nx*off, z = p.z + nz*off;
        if (onPavement(x, z)) break;
        const area = areaAt(x, z);
        if (area >= 0) { entrances.push({ area, side, x, z }); if (!areas[area].exits.some(e => e.li === li && e.vi === vi)) areas[area].exits.push({ li, vi }); break; }
      }
    });
  }));
  // for crossing mid-block: the nearest point on any ring
  const nearRing = segmentGrid(lines.flatMap((nav, li) => nav.ring ? nav.pts.slice(0, -1).map((a, seg) => ({ a, b: nav.pts[seg+1], li, seg })) : []));
  const buildings = buildingDoors(lines, grid, CELL, onPavement, widestSidewalk);
  return { areas, lines, grid, CELL, onPavement, nearRing, buildings };
}
// The buildings people can go into (see "going indoors"): each building of a kind people go into (`enterable` in
// assets/buildings.txt) that keeps its footprint on it, close enough to a walkway point, with no road in between, gets a
// door on the wall nearest the nearest such point — which is where people on that walkway go in.
// How close is "close enough" follows the street itself rather than being a flat number, since how far a building stands
// off the pavement is the player's to set: walkways run down the middle of the sidewalk, so it takes half of that to
// reach the kerb, then the zone's setbacks to reach the lot's edge, and then DOOR_SLACK for a footprint that doesn't
// fill its lot (a rounded or stepped-back one). Capped, so nobody hikes across a field to a door.
// A building is { key, number, kind, x, z, y, height, size, door: { x, z } }, and the walkway point's vertex gets `building`.
const DOOR_SLACK = 4, DOOR_REACH_MAX = 20;
const doorReach = (zone, sidewalkWidth) =>
  Math.min(DOOR_REACH_MAX, sidewalkWidth*0.5 + (zone.settings.setback || 0) + (zone.settings.borderSetback || 0) + DOOR_SLACK);
function buildingDoors(lines, grid, CELL, onPavement, sidewalkWidth) {
  const buildings = [];
  S.zones.forEach(zone => {
    const reach = doorReach(zone, sidewalkWidth);
    (zone.buildingsGroup?.children || []).forEach((group, k) => {
      const fp = group.userData.footprint;
      if (!fp || fp.length < 3) return;
      const kind = buildingKindOf(group, zone);
      if (!buildingEnterable(kind)) return; // (nobody wanders into a tank farm: see enterable in buildings.txt)
      const c = centroid(fp), size = Math.max(...fp.map(q => Math.hypot(q.x - c.x, q.z - c.z)));
      const span = Math.ceil((size + reach)/CELL), cx = Math.floor(c.x/CELL), cz = Math.floor(c.z/CELL);
      let best = null;
      for (let ox=-span;ox<=span;ox++) for (let oz=-span;oz<=span;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
        const p = lines[li].pts[vi];
        let wall = null;
        fp.forEach((a, n) => {
          const q = closestPointOnSegment(p, a, fp[(n+1) % fp.length]), d = Math.hypot(q.x - p.x, q.z - p.z);
          if (!wall || d < wall.d) wall = { q, d };
        });
        if (wall.d > reach || wall.d < 0.5 || (best && wall.d >= best.d)) return;
        for (let t=0.2;t<1;t+=0.2) if (onPavement(p.x + (wall.q.x - p.x)*t, p.z + (wall.q.z - p.z)*t)) return; // (across a road)
        best = { li, vi, ...wall, from: p };
      });
      if (!best) return;
      const vertex = lines[best.li].vertices[best.vi];
      if (vertex.building) return; // (a door onto that point already)
      // just short of the wall, so they don't walk into it
      const back = Math.min(0.4, best.d)/best.d;
      const key = buildingKey(zone, k);
      const building = { key, number: buildingNumber(key), kind,
        x: c.x, z: c.z, y: Y_ZONE_GROUND, height: group.userData.height || 10, size,
        door: { x: best.q.x + (best.from.x - best.q.x)*back, z: best.q.z + (best.from.z - best.q.z)*back } };
      vertex.building = building;
      buildings.push(building);
    });
  });
  return buildings;
}

function newPerson() {
  const baseHeight = 0.85 + peopleRng()*0.27; // (their height, before their size trait)
  return { x:0, y:0, z:0, heading: peopleRng()*Math.PI*2, stride: 0.8 + peopleRng()*0.4, baseHeight, height: baseHeight, phase: peopleRng()*10,
    mode: 'none', li: 0, u: 0, dir: 1, seg: 0, lat: 0, area: -1, tx: 0, tz: 0, wait: 0, exit: null, moving: false, stepped: 0,
    // the model's animation: how far through the walk (in whole cycles) and the looping ones (in seconds) they are; the
    // animation they're in (clipA) and the one they're blending out of (clipB, held at row rowB), how far they've blended and
    // how long it takes; the pose they're in when they're not walking, and one playing through once (and for how long it has);
    // how tall their pose leaves them; the time to their next blink and since their last; which way they're looking (their
    // head turned and tilted, the way it's turning to, and the time until they glance somewhere else); and how long they've
    // stood about, and how long until they fidget
    walkCycle: peopleRng(), idleTime: peopleRng()*10, clipA: null, clipB: null, rowB: 0, fade: 1, fadeTime: FADE_QUICK,
    pose: 'Idle', oneShot: null, shotTime: 0, heightScale: 1, blinkIn: peopleRng()*6, blinkAge: BLINK_DURATION,
    lookTurn: 0, lookTilt: 0, lookTurnTo: 0, lookTiltTo: 0, lookIn: peopleRng()*4, stillFor: 0, fidgetAfter: 2 + peopleRng()*5,
    // what they're doing besides walking about (see "what people get up to"): act 'chat', 'bench', 'circle' or 'lie', how
    // far along it they are (stage) and for how long (timer); where they're sitting or lying (spot, seat, the pose — sitClip
    // or lieClip — and circleAngle round a circle); the group they're talking in; the way they should face and who they're
    // looking at; how far up onto a bench seat they sit; and their mouth — how open it's going to (talkTo, until talkIn) and
    // their expression (emotionTo, until emotionIn)
    act: null, stage: '', timer: 0, spot: null, seat: null, sitClip: null, lieClip: null, circleAngle: 0, group: null,
    faceTo: null, lookAt: null, seatLift: 0, chatCheckIn: peopleRng(), chatCooldown: peopleRng()*20,
    talk: 0, talkTo: 0, talkIn: 0, emotion: 0, emotionTo: 0, emotionIn: 0,
    // and their eyes: how shocked, happy, angry and sad they look
    eyes: [0, 0, 0, 0],
    // their traits, from what they were picked in people.txt (see refreshTraits)
    traits: DEFAULT_TRAITS, traitsKey: '',
    // how they're taking someone blowing up nearby, if they are (see frightenBystanders)
    fright: null,
    stun: null,
    please: null,
    // crossing a road (see updateCrossing): where they are on it (null if they aren't), the way over, and how long until
    // they next think about crossing mid-block; and linkCooldown, separately, keeps them from turning off at another
    // junction right after just having at one
    crossStage: null, jc: null, crossCheckIn: peopleRng()*5, linkCooldown: 0,
    // riding the trains (see "riding the trains"): where they are in it (null if they aren't), and how long until they'd
    // think about riding again
    train: null, trainCooldown: 20 + peopleRng()*40,
    // going into a building (see "going indoors"): where they are in it (null if they aren't), and how long until they'd
    // think about going into one again
    indoors: null, indoorsCooldown: 10 + peopleRng()*30,
    // punching (see "punching"): who they're going for and how far along it they are, how long until they'd think about it
    // again, and being punched themselves
    attack: null, punchCooldown: 10 + peopleRng()*30, punched: null };
}
// A person's traits — from the entries picked for them in people.txt (see profiles.js), by their place in the crowd, `i` —
// worked out again whenever people.txt loads, and once the model's loaded and says whether they're a man (which decides
// their name, and so the rest of their picks).
function refreshTraits(p, i) {
  const isMan = personModel ? personModel.isMan[i] === 1 : null, key = profilesVersion() + ':' + isMan;
  if (p.traitsKey === key) return;
  p.traitsKey = key;
  const profile = profileOf(i, isMan);
  p.traits = profile.traits;
  p.height = p.baseHeight*p.traits.size;
  p.age = profile.age;
}
export function pickWeighted(items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let r = peopleRng()*total;
  for (let i=0;i<items.length;i++) { r -= weightOf(items[i]); if (r <= 0) return i; }
  return items.length - 1;
}
// a random spot inside a hangout — near `near` if one can be found there
function randomSpotIn(area, near) {
  for (let k=0;k<24;k++) {
    const x = near && k < 12 ? near.x + (peopleRng()-0.5)*24 : area.minX + peopleRng()*(area.maxX-area.minX);
    const z = near && k < 12 ? near.z + (peopleRng()-0.5)*24 : area.minZ + peopleRng()*(area.maxZ-area.minZ);
    if (area.inside(x, z)) return { x, z };
  }
  return near ? { x: near.x, z: near.z } : { x: (area.minX+area.maxX)/2, z: (area.minZ+area.maxZ)/2 };
}
// puts a person on walkway `li` at distance u along it, heading `dir`, somewhere across it
function joinWalkway(p, li, u, dir) {
  const nav = peopleNav.lines[li];
  p.mode = 'line'; p.li = li; p.dir = dir; p.u = Math.max(0, Math.min(nav.total, u));
  p.seg = 0;
  while (p.seg < nav.pts.length-2 && nav.cum[p.seg+1] <= p.u) p.seg++;
  p.lat = (peopleRng()-0.5)*2*nav.lateral;
}
function wanderInto(p, areaIndex, near) {
  const spot = randomSpotIn(peopleNav.areas[areaIndex], near);
  p.mode = 'wander'; p.area = areaIndex; p.tx = spot.x; p.tz = spot.z; p.wait = 0;
}
function spawnPerson(p) {
  const { areas, lines } = peopleNav;
  if (areas.length && (!lines.length || peopleRng() < 0.45)) {
    const ai = pickWeighted(areas, a => a.size), spot = randomSpotIn(areas[ai]);
    p.x = spot.x; p.z = spot.z; p.y = areas[ai].y;
    wanderInto(p, ai, spot);
    p.wait = peopleRng()*6;
  } else if (lines.length) {
    const li = pickWeighted(lines, l => l.total), nav = lines[li];
    let u = peopleRng()*nav.total;
    // (not out on a road, for a path that crosses one)
    for (let k=0; k<8 && nav.blocked && nav.blocked.some((b, vi) => b && Math.abs(nav.cum[vi] - u) < PEOPLE_NAV_SPACING); k++) u = peopleRng()*nav.total;
    joinWalkway(p, li, u, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else {
    p.mode = 'none';
  }
}
// after the walkways are rebuilt: back into the hangout they're standing in, else onto the nearest walkway, else anywhere
function reseatPerson(p) {
  if (p.mode === 'dead') return; // (who stays that way)
  if (p.mode === 'train') return; // (up in a station or on a train, and dropped back onto whatever's there when they're done)
  if (p.mode === 'possessed') return; // (walked wherever they're walked, and set back on a walkway when let go)
  if (p.mode === 'indoors') {
    if (p.indoors.stage === 'inside') return; // (back out where they went in, when they're done)
    p.indoors = null; p.mode = 'line'; // (on their way in or out: back onto the walkway)
  }
  const { areas, lines, grid, CELL } = peopleNav;
  if (p.mode === 'wander' || p.mode === 'leaving') {
    const ai = areas.findIndex(a => p.x >= a.minX && p.x <= a.maxX && p.z >= a.minZ && p.z <= a.maxZ && a.inside(p.x, p.z));
    if (ai >= 0) { wanderInto(p, ai, p); return; }
  }
  if (p.mode !== 'none') {
    let best = null;
    const cx = Math.floor(p.x/CELL), cz = Math.floor(p.z/CELL);
    for (let ox=-2;ox<=2;ox++) for (let oz=-2;oz<=2;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      const q = lines[li].pts[vi], d = Math.hypot(q.x-p.x, q.z-p.z);
      if (!best || d < best.d) best = { li, vi, d };
    });
    if (best) { placeAtVertex(p, best.li, best.vi, p.dir || 1); return; }
  }
  spawnPerson(p);
}
// where a person on a walkway should be: the walkway's point at their distance along it, set off to one side by p.lat
function walkwayPoint(p) {
  const nav = peopleNav.lines[p.li];
  const i = Math.max(0, Math.min(nav.pts.length-2, p.seg));
  const a = nav.pts[i], b = nav.pts[i+1], segLen = (nav.cum[i+1] - nav.cum[i]) || 1;
  const t = Math.max(0, Math.min(1, (p.u - nav.cum[i])/segLen));
  // blending between the two points' own offsets, so the walkway bends round corners smoothly
  const ma = nav.mitres[i], mb = nav.mitres[i+1], k = p.lat;
  const y = nav.overWater && nav.overWater[i] && nav.overWater[i+1] ? FOOTBRIDGE_TOP : nav.y;
  return { x: a.x + (b.x-a.x)*t + (ma.x + (mb.x-ma.x)*t)*k, y, z: a.z + (b.z-a.z)*t + (ma.z + (mb.z-ma.z)*t)*k };
}
// the segment someone standing at point vi, heading dir, is on (see walkAlong: the point ahead is seg+1 going forward,
// seg going back) — round the end, for a loop's first point going back
// the point after vi, heading dir — round the end, on a loop (or past it: vi -1 or pts.length)
const nextVertex = (nav, vi, dir) => !nav.loop ? vi + dir : dir > 0 && vi === nav.pts.length-1 ? 1 : dir < 0 && vi === 0 ? nav.pts.length-2 : vi + dir;
const segFrom = (nav, vi, dir) => dir > 0 ? Math.min(vi, nav.pts.length-2) : nav.loop && vi === 0 ? nav.pts.length-2 : Math.max(vi-1, 0);
// puts p on walkway li at its point vi, heading dir (or away from the end, or the road a path runs onto, there)
function placeAtVertex(p, li, vi, dir) {
  const nav = peopleNav.lines[li];
  if (!nav.loop) { if (vi === 0) dir = 1; else if (vi === nav.pts.length-1) dir = -1; }
  if (nav.blocked?.[nextVertex(nav, vi, dir)]) dir = -dir;
  joinWalkway(p, li, nav.cum[vi], dir);
  if (nav.loop && vi === 0 && dir < 0) p.u = nav.total;
  p.seg = segFrom(nav, vi, dir);
}
// onto the walkway a (non-crossing) link leads to, either way along it
function takeLink(p, link) {
  placeAtVertex(p, link.li, link.vi, peopleRng() < 0.5 ? -1 : 1);
  p.linkCooldown = 6 + peopleRng()*4;
  return peopleNav.lines[link.li];
}
// moves a person `dist` along their walkway, dealing with each point they pass: maybe wandering into a hangout, maybe
// turning off onto another walkway or heading over a zebra crossing, and turning back at a dead end (or where a path
// runs onto a road); a loop just goes round and round
function walkAlong(p, dist) {
  let nav = peopleNav.lines[p.li];
  let u = p.u + p.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const last = nav.pts.length-1, ahead = p.dir > 0 ? p.seg + 1 : p.seg, at = nav.cum[ahead];
    if (p.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead];
    const station = p.trainCooldown <= 0 ? stationLinks().byVertex.get(p.li + ':' + ahead) : null;
    if (station != null && peopleRng() < RIDE_CHANCE) { p.u = at; goRideTrain(p, station, walkwayPoint(p)); return; }
    if (vertex.building && mayGoIndoors(p) && peopleRng() < ENTER_CHANCE) { p.u = at; goIndoors(p, vertex.building, walkwayPoint(p)); return; }
    const isEnd = (!nav.loop && (ahead === 0 || ahead === last)) || !!nav.blocked?.[nextVertex(nav, ahead, p.dir)];
    const entrance = vertex.entrances.length ? vertex.entrances[Math.floor(peopleRng()*vertex.entrances.length)] : null;
    const drawn = entrance ? (isOpenGround(peopleNav.areas[entrance.area]) ? p.traits.parks : p.traits.plazas) : 0;
    if (entrance && peopleRng() < 0.12*drawn) { p.u = at; wanderInto(p, entrance.area, entrance); return; }
    // (linkCooldown keeps them from turning off again right away — otherwise a junction with several close-together
    // links could have them zigzagging, first one way then straight back)
    if (vertex.links.length && p.linkCooldown <= 0) {
      const crossings = vertex.links.filter(l => l.cross), turns = vertex.links.filter(l => !l.cross);
      if (crossings.length && peopleRng() < 0.35) {
        p.u = at;
        startZebraCrossing(p, nav, ahead, crossings[Math.floor(peopleRng()*crossings.length)]);
        return;
      }
      if (turns.length && peopleRng() < (isEnd ? 0.85 : 0.3)) {
        const remaining = Math.abs(u - at);
        nav = takeLink(p, turns[Math.floor(peopleRng()*turns.length)]);
        u = p.u + p.dir*remaining;
        continue;
      }
    }
    if (isEnd) { p.dir = -p.dir; u = 2*at - u; continue; }
    if (nav.loop && ahead === (p.dir > 0 ? last : 0)) {
      if (p.dir > 0) { u -= nav.total; p.seg = 0; } else { u += nav.total; p.seg = last - 1; }
      continue;
    }
    p.seg += p.dir;
  }
  p.u = Math.max(0, Math.min(nav.total, u));
}
// Crossing a road. p.jc holds the way over — route (the points walked through, route[i] the one being walked to), legs
// (the crossStage while walking to each) and holds (the one, if any, while waiting on arriving at each), where it comes
// out (to) and where they were (back, for giving up) — and p.crossStage where they are on it:
// - at a junction's zebra crossing: 'jwalk' (to the curb), 'jwait' (there, until that road's lights have gone red with
//   time enough left to get over, and nothing's still moving across it) and 'jcross' (over)
// - anywhere else: 'jwalk' (to the curb), 'curb' (checking for traffic, giving up after a while), 'half1' (to the
//   middle), 'mid' (checking again) and 'half2' (the rest of the way) — straight away, once a car's stopped to let them
//   over, and with no car able to hit them till they're off the road (jc.waved: see checkYield in traffic.js), so neither
//   of them waits on the other for ever
const ROADSAFETY_RADIUS = 14, CROSS_CURB_TIMEOUT = 10, CROSS_DECIDE_CHANCE = 0.15, CROSS_SPEED_MULT = 1.6;
function startZebraCrossing(p, nav, vi, link) {
  p.jc = { route: [nav.pts[vi], peopleNav.lines[link.li].pts[link.vi]], legs: ['jwalk', 'jcross'], holds: ['jwait', null], i: 0,
    holding: false, to: { li: link.li, vi: link.vi }, back: null, junction: link.cross.junction, arm: link.cross.arm, checkIn: 0, wait: Infinity };
  p.crossStage = 'jwalk';
}
// now and then, someone on a sidewalk heads straight over the road beside them — if it is just the one road, out of the
// way of any junction, with sidewalk on the far side
function maybeCrossRoad(p, nav, dt) {
  if (!nav.ring || (p.crossCheckIn -= dt) > 0) return;
  p.crossCheckIn = 4 + peopleRng()*6;
  if (peopleRng() >= CROSS_DECIDE_CHANCE) return;
  const { onPavement, nearRing } = peopleNav, here = walkwayPoint(p);
  const vi = Math.abs(p.u - nav.cum[p.seg]) < Math.abs(p.u - nav.cum[p.seg+1]) ? p.seg : p.seg+1, m = nav.mitres[vi], len = Math.hypot(m.x, m.z);
  if (len < 1e-6) return;
  const nx = m.x/len*nav.roadSide, nz = m.z/len*nav.roadSide;
  // along the way over: onto the road, then off it again
  let enter = -1, leave = -1;
  for (let d = 0.25; d < 60; d += 0.25) {
    const on = onPavement(here.x + nx*d, here.z + nz*d);
    if (enter < 0) { if (on) enter = d; else if (d > 6) return; }
    else if (!on) { leave = d; break; }
  }
  if (leave < 0) return;
  const far = nearRing(here.x + nx*(leave + enter), here.z + nz*(leave + enter), 2);
  if (!far) return;
  const curb = { x: here.x + nx*Math.max(0, enter - 0.4), z: here.z + nz*Math.max(0, enter - 0.4) };
  const mid = { x: here.x + nx*(enter + leave)/2, z: here.z + nz*(enter + leave)/2 };
  if ((S.roadJunctions || []).some(j => [here, mid, far.q].some(q => Math.hypot(j.x - q.x, j.z - q.z) < j.r + 8))) return;
  const other = peopleNav.lines[far.seg.li], s = far.seg.seg;
  p.jc = { route: [curb, mid, far.q], legs: ['jwalk', 'half1', 'half2'], holds: ['curb', 'mid', null], i: 0, holding: false,
    to: { li: far.seg.li, u: other.cum[s] + far.t*(other.cum[s+1] - other.cum[s]) }, back: { li: p.li, u: p.u, dir: p.dir },
    junction: null, arm: null, checkIn: 0, wait: CROSS_CURB_TIMEOUT };
  p.crossStage = 'jwalk';
}
// whether it's safe to set off on the crossing's next leg
function crossingClear(p, jc, speed) {
  const from = jc.route[jc.i-1], to = jc.route[jc.i], radius = ROADSAFETY_RADIUS*p.traits.roadsafety;
  if (!jc.junction && p.crossStage === 'mid') {
    // halfway, only the far lane's still to cross, so they only check the half in front of them
    const len = Math.hypot(to.x - from.x, to.z - from.z) || 1, cx = (to.x - from.x)/len, cz = (to.z - from.z)/len;
    return !App.carsWhere((x, z, car) => {
      const dx = x - from.x, dz = z - from.z;
      return Math.hypot(dx, dz) < radius && dx*cx + dz*cz >= 0 && App.people[car.yieldFor] !== p;
    });
  }
  if (!jc.junction) return !App.carsNearby((from.x + to.x)/2, (from.z + to.z)/2, radius);
  const j = jc.junction, arm = jc.arm, sx = arm.z, sz = -arm.x;
  const need = Math.hypot(to.x - from.x, to.z - from.z)/Math.max(0.1, speed*CROSS_SPEED_MULT) + 1;
  // and nothing that could come over it: no car on the crossing (stopped or not — though one stopped at the stop line,
  // just past it, is fine), none still moving in over the stop line, and none in the middle of the junction heading
  // out this way (turning in off the road with the green)
  return signalRedLeft(j, arm.phase, lastPeopleTime) >= Math.min(need, 9) && !App.carsWhere((x, z, car) => {
    const a = (x - j.x)*arm.x + (z - j.z)*arm.z, s = (x - j.x)*sx + (z - j.z)*sz;
    if (Math.hypot(x - j.x, z - j.z) < j.r + 1) return Math.sin(car.heading)*arm.x + Math.cos(car.heading)*arm.z > 0.3;
    if (a <= j.r*0.5 || Math.abs(s) >= arm.hw + 1.5) return false;
    return a < j.r + 2.9 || (car.speed > 0.5 && a < j.r + 6);
  });
}
// off the crossing, onto the walkway at dest ({ li, and vi or u, and maybe dir })
function endCrossing(p, dest) {
  p.crossStage = null;
  p.jc = null;
  p.faceTo = null;
  const dir = dest.dir || (peopleRng() < 0.5 ? -1 : 1);
  if (dest.vi != null) placeAtVertex(p, dest.li, dest.vi, dir); else joinWalkway(p, dest.li, dest.u, dir);
  p.linkCooldown = 6 + peopleRng()*4;
  p.crossCheckIn = 4 + peopleRng()*6;
}
// the next step of a crossing: where to head for this frame (null to stand still)
function updateCrossing(p, dt, speed) {
  const jc = p.jc;
  if (jc.holding) {
    p.faceTo = headingTo(p, jc.route[jc.i]);
    if (p.crossStage === 'curb' && (jc.wait -= dt) <= 0) { endCrossing(p, jc.back); return walkwayPoint(p); } // no gap in time
    if ((jc.checkIn -= dt) > 0) return null;
    jc.checkIn = 0.3 + peopleRng()*0.3;
    if (p.crossStage === 'mid' && App.carsWhere((x, z, car) => App.people[car.yieldFor] === p)) jc.waved = true;
    if (!jc.waved && !crossingClear(p, jc, speed)) return null;
    jc.holding = false;
    p.faceTo = null;
    p.crossStage = jc.legs[jc.i];
  }
  const target = jc.route[jc.i];
  if (Math.hypot(target.x - p.x, target.z - p.z) < 0.2) {
    if (jc.i === jc.route.length - 1) { endCrossing(p, jc.to); return walkwayPoint(p); }
    const hold = jc.holds[jc.i];
    jc.i++;
    if (hold) { jc.holding = true; jc.checkIn = 0; p.crossStage = hold; return null; }
    p.crossStage = jc.legs[jc.i];
  }
  const next = jc.route[jc.i];
  return { x: next.x, y: peopleNav.lines[p.li].y, z: next.z };
}
// how many of `sorted` (ascending) are below `limit`
function countBelow(sorted, limit) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < limit) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---- what people get up to besides walking about: someone standing around for a while scratches or has a think now and
// then; two people meeting — head on along a walkway, or one going over to another in a plaza or park — wave, talk a while
// and wave goodbye; someone in a plaza sits down on a bench; and someone in a park sits down on the grass, where others might
// join them in a circle to talk, or, with nobody else about, lies down for a while. People talking are a group, taking
// turns to talk, and looking at whoever's talking.
const groups = []; // { kind: 'chat' (two, standing) or 'circle' (sat on the grass), members, speaker, turnIn, … }
const clipNamed = name => personModel ? personModel.clips[name] : null;
const hasClip = name => { const clip = clipNamed(name); return !!clip && !clip.missing; };
const pickFrom = list => list[Math.floor(peopleRng()*list.length)];
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const headingTo = (p, q) => Math.atan2(q.x - p.x, q.z - p.z);
const modelScale = p => 1.7*p.height*S.peopleSize/personModel.height; // how much the model's scaled to be a person's height
// how much of a person's pose is `clip`, part-way through blending from one animation into the next
const weightOf = (p, clip) => (p.clipA === clip ? p.fade : 0) + (p.clipB === clip ? 1 - p.fade : 0);

// the row of the bone texture a person's at in an animation: along the walk by how far they've walked, round a looping one
// by the time, and through one playing once by how long it's played
function clipRow(p, clip) {
  if (clip.name === 'Walk') return clip.start + p.walkCycle*clip.frames;
  if (clip.loop) return clip.start + (p.idleTime*PERSON_BAKE_FPS) % clip.frames;
  return clip.start + Math.min(clip.frames - 1, p.shotTime*PERSON_BAKE_FPS);
}
// starts a person blending into an animation from the one they're in — or back, if they're still blending out of it
function setClip(p, clip) {
  if (p.clipA === clip) return;
  p.rowB = clipRow(p, p.clipA);
  p.fade = p.clipB === clip ? 1 - p.fade : 0;
  p.fadeTime = clip.pose || p.clipA.pose ? FADE_POSE : FADE_QUICK;
  p.clipB = p.clipA;
  p.clipA = clip;
}
function playOnce(p, name) {
  if (!hasClip(name)) return;
  p.oneShot = clipNamed(name);
  p.shotTime = 0;
}

function removeGroup(g) {
  const k = groups.indexOf(g);
  if (k >= 0) groups.splice(k, 1);
}
// a conversation between two is over, and they both carry on
function endChat(g) {
  removeGroup(g);
  const chatGroup = g.members.splice(0);
  chatGroup.forEach((m, index) => { 
    m.group = null; finishActivity(m); 
    if (chatGroup.length <= 1) return;
    let victim;
    if (index === 0) victim = chatGroup[1]
    else victim = chatGroup[0]
    throwPunch(undefined, m, true, victim)
  });
}
function leaveGroup(p) {
  const g = p.group;
  if (!g) return;
  p.group = null;
  g.members.splice(g.members.indexOf(p), 1);
  if (g.speaker === p) g.speaker = null;
  g.members.forEach(m => { if (m.lookAt === p) m.lookAt = null; });
  // a conversation between two ends when either goes; a circle carries on while anyone's left in it
  if (g.kind === 'chat') endChat(g); else if (!g.members.length) removeGroup(g);
}
// stops whatever a person's doing, back to standing
function endActivity(p) {
  leaveGroup(p);
  endAttack(p);
  releasePunched(p);
  if (p.seat) { p.seat.by = null; p.seat = null; }
  p.act = null; p.stage = ''; p.spot = null; p.faceTo = null; p.lookAt = null; p.pose = 'Idle'; p.seatLift = 0;
}
// …and carries on: off somewhere nearby, or on along their walkway — and not stopping to talk again for a while
function finishActivity(p) {
  endActivity(p);
  if (p.mode === 'wander') { const s = randomSpotIn(peopleNav.areas[p.area], p); p.tx = s.x; p.tz = s.z; p.wait = 0.3 + peopleRng()*1.5; }
  p.chatCooldown = 30 + peopleRng()*60;
}

// two people start talking — `approach` if the second is to walk over to the first first, who waits for them
function startChat(a, b, approach) {
  const g = { kind: 'chat', members: [a, b], stage: 'gather', timer: 25, speaker: null, turnIn: 0 };
  groups.push(g);
  [a, b].forEach(m => { endActivity(m); m.act = 'chat'; m.group = g; m.wait = 0; });
  a.lookAt = b; b.lookAt = a;
  if (!approach) wave(g, 'greet');
  return g;
}
// both wave, hello or goodbye, standing still for it
function wave(g, stage) {
  g.stage = stage;
  g.timer = hasClip('Wave') ? clipNamed('Wave').duration : 1;
  g.members.forEach(m => playOnce(m, 'Wave'));
}
// someone hanging out in a plaza or park goes over to someone else standing about there, to talk
function goChat(p, area) {
  if (!personModel) return false;
  let friend = null, best = 25;
  for (let k=0;k<10;k++) {
    const q = people[Math.floor(peopleRng()*people.length)], d = Math.hypot(q.x - p.x, q.z - p.z);
    if (q !== p && q.mode === 'wander' && q.area === p.area && !q.act && !q.fright && !q.oneShot && !q.moving && !q.attack && !q.punched && q.traits.chatty > 0 && d < best) { friend = q; best = d; }
  }
  if (!friend) return false;
  startChat(friend, p, true);
  const gap = CHAT_GAP*S.peopleSize, d = Math.max(best, 1e-3);
  p.tx = friend.x + (p.x - friend.x)/d*gap; p.tz = friend.z + (p.z - friend.z)/d*gap;
  if (!area.inside(p.tx, p.tz)) { p.tx = p.x; p.tz = p.z; }
  return true;
}
// two people meeting head on along a walkway (on the same side of it) now and then stop to talk — though never too many
// at once
function meetOnWalkways(dt) {
  const cells = new Map(), CELL = 2;
  let talking = 0;
  people.forEach(p => {
    p.chatCooldown -= dt;
    if (p.mode !== 'line') return;
    if (p.act) { talking++; return; }
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  });
  if (!hasClip('Wave') || talking > people.length*0.15) return;
  const reach = 1.6*S.peopleSize;
  people.forEach(p => {
    if (p.mode !== 'line' || p.act || p.fright || p.crossStage || p.attack || p.punched || p.chatCooldown > 0 || (p.chatCheckIn -= dt) > 0) return;
    p.chatCheckIn = 0.4 + peopleRng()*0.8;
    const cx = Math.floor(p.x/CELL), cz = Math.floor(p.z/CELL);
    for (let ox=-1;ox<=1;ox++) for (let oz=-1;oz<=1;oz++) for (const q of cells.get((cx+ox) + ',' + (cz+oz)) || []) {
      if (q === p || q.act || q.fright || q.crossStage || q.attack || q.punched || q.chatCooldown > 0 || q.li !== p.li || q.dir === p.dir) continue;
      // still coming towards each other, and close
      if ((q.u - p.u)*p.dir < 0 || Math.hypot(q.x - p.x, q.z - p.z) > reach) continue;
      if (peopleRng() < 0.35*p.traits.chatty*q.traits.chatty) startChat(p, q, false); else p.chatCooldown = q.chatCooldown = 10;
      return;
    }
  });
}
function takeTurns(g, talkers, dt) {
  g.turnIn -= dt;
  if (!talkers.includes(g.speaker) || g.turnIn <= 0) {
    // the more talkative someone is, the more of the turns they take, and the longer they go on
    const others = talkers.filter(m => m !== g.speaker);
    g.speaker = others[pickWeighted(others, m => m.traits.talkative)];
    g.turnIn = (1.5 + peopleRng()*4)*Math.sqrt(g.speaker.traits.talkative);
    g.speaker.lookAt = pickFrom(talkers.filter(m => m !== g.speaker));
  }
  talkers.forEach(m => { if (m !== g.speaker) m.lookAt = g.speaker; });
}
// conversations: two standing come together, wave hello, take turns talking a while, wave goodbye and go; a circle on the
// grass talks among whoever's sat down in it
function updateGroups(dt) {
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (g.kind === 'circle') {
      const seated = g.members.filter(m => m.stage === 'sit');
      if (seated.length >= 2) takeTurns(g, seated, dt); else g.speaker = null;
      continue;
    }
    const [a, b] = g.members;
    g.timer -= dt;
    if (g.stage === 'gather') {
      a.faceTo = headingTo(a, b);
      if (Math.hypot(b.tx - b.x, b.tz - b.z) < 0.3) wave(g, 'greet');
      else if (g.timer <= 0) { endChat(g); continue; }
    } else if (g.stage === 'greet') {
      if (g.timer <= 0) { g.stage = 'talk'; g.timer = (8 + peopleRng()*22)*(a.traits.patience + b.traits.patience)/2; }
    } else if (g.stage === 'talk') {
      takeTurns(g, g.members, dt);
      if (g.timer <= 0) { g.speaker = null; wave(g, 'bye'); }
    } else if (g.timer <= 0) {
      endChat(g);
      continue;
    }
    if (g.stage !== 'gather') { a.faceTo = headingTo(a, b); b.faceTo = headingTo(b, a); }
  }
}

// whether there's room on the grass: in the park all round a spot, and clear of the tree trunks
function clearGround(area, x, z, r) {
  if (!area.inside(x, z) || !area.inside(x + r, z) || !area.inside(x - r, z) || !area.inside(x, z + r) || !area.inside(x, z - r)) return false;
  return area.trees.every(tree => Math.hypot(tree.x - x, tree.z - z) > tree.r + r);
}
// the hangouts people sit and lie down on the ground in, rather than on benches
const isOpenGround = area => area.kind === 'park' || area.kind === 'beach';
// someone in a plaza heads for a free bench seat nearby; someone in a park or on a beach for the ground, to join a circle
// there with room in it or to start one
function goSit(p, area) {
  if (!personModel) return false;
  if (area.kind === 'plaza') {
    // (only people about the size the benches are made for)
    if (!hasClip('Sit1') || !area.seats.length || Math.abs(S.peopleSize*p.traits.size - 1) > 0.3) return false;
    let seat = null, best = 40;
    for (let k=0;k<10;k++) {
      const s = area.seats[Math.floor(peopleRng()*area.seats.length)], d = Math.hypot(s.x - p.x, s.z - p.z);
      if (!s.by && d < best) { seat = s; best = d; }
    }
    if (!seat) return false;
    seat.by = p;
    Object.assign(p, { seat, act: 'bench', stage: 'go', timer: 30, wait: 0 });
    return true;
  }
  const sits = GRASS_SITS.filter(hasClip);
  if (!isOpenGround(area) || !sits.length) return false;
  const radius = CIRCLE_RADIUS*S.peopleSize;
  const circle = groups.find(g => g.kind === 'circle' && g.area === area && g.members.length < CIRCLE_MAX && Math.hypot(g.cx - p.x, g.cz - p.z) < 30);
  let spot = null;
  if (circle && peopleRng() < 0.85) {
    // the place round the circle furthest from anyone already there
    for (let k=0;k<12;k++) {
      const angle = (k + peopleRng()*0.5)/12*Math.PI*2, x = circle.cx + Math.sin(angle)*radius, z = circle.cz + Math.cos(angle)*radius;
      const gap = Math.min(...circle.members.map(m => Math.abs(wrapAngle(angle - m.circleAngle))));
      if (gap > 0.9 && (!spot || gap > spot.gap) && clearGround(area, x, z, 0.35*S.peopleSize)) spot = { x, z, angle, gap };
    }
    if (!spot) return false;
    circle.members.push(p);
    p.group = circle;
  } else {
    // an open patch of grass, away from other circles and anyone lying down
    for (let k=0;k<10 && !spot;k++) {
      const s = randomSpotIn(area, p), angle = peopleRng()*Math.PI*2;
      const cx = s.x - Math.sin(angle)*radius, cz = s.z - Math.cos(angle)*radius;
      if (clearGround(area, cx, cz, radius + 0.5*S.peopleSize) && !groups.some(g => g.kind === 'circle' && Math.hypot(g.cx - cx, g.cz - cz) < 5)
        && !people.some(q => q.act === 'lie' && Math.hypot(q.x - cx, q.z - cz) < 4)) spot = { x: s.x, z: s.z, angle, cx, cz };
    }
    if (!spot) return false;
    p.group = { kind: 'circle', area, members: [p], speaker: null, turnIn: 0, cx: spot.cx, cz: spot.cz };
    groups.push(p.group);
  }
  Object.assign(p, { act: 'circle', stage: 'go', spot: { x: spot.x, z: spot.z }, circleAngle: spot.angle, sitClip: pickFrom(sits), timer: 40, wait: 0 });
  return true;
}
// someone in a park or on a beach with nobody else about finds a patch of ground to lie down on
function goLieDown(p, area) {
  const poses = LIE_DOWNS.filter(hasClip);
  if (!personModel || !isOpenGround(area) || !poses.length) return false;
  const size = S.peopleSize, near = 8*size;
  if (people.some(q => q !== p && q.mode === 'wander' && q.area === p.area && Math.abs(q.x - p.x) < near && Math.abs(q.z - p.z) < near)) return false;
  for (let k=0;k<10;k++) {
    const s = randomSpotIn(area, p), heading = peopleRng()*Math.PI*2, fx = Math.sin(heading), fz = Math.cos(heading);
    // room from their head (behind where their pelvis goes) to their feet
    if (![-0.5, 0, 0.5, 0.9].every(d => clearGround(area, s.x + fx*d*size, s.z + fz*d*size, 0.45*size))) continue;
    Object.assign(p, { act: 'lie', stage: 'go', spot: { x: s.x, z: s.z, heading }, lieClip: pickFrom(poses), timer: 30, wait: 0 });
    return true;
  }
  return false;
}
// Someone sitting or lying down, or talking in a plaza or park: where they should walk to, if anywhere. Sitting or lying
// down goes: walking there ('go'), turning the right way ('turn'), waving hello to a circle ('greet'), sitting or lying
// ('sit') for a while, getting up ('rise'), and waving goodbye to a circle ('bye').
function updateActivity(p, area, dt) {
  if (p.act === 'chat') return p.group.stage === 'gather' && p === p.group.members[1] ? { x: p.tx, y: area.y, z: p.tz } : null;
  // where they sit or lie, and facing which way: in front of a bench seat, facing out into the plaza (sitting shifts them
  // back onto it); a place in a circle, facing its middle; or a patch of grass
  let spot = p.spot, facing, poseName;
  if (p.act === 'bench') {
    const seat = p.seat, reach = -clipNamed('Sit1').pelvisZ*modelScale(p);
    spot = { x: seat.x + seat.nx*reach, z: seat.z + seat.nz*reach };
    facing = Math.atan2(seat.nx, seat.nz);
    poseName = 'Sit1';
  } else if (p.act === 'circle') {
    facing = headingTo(spot, { x: p.group.cx, z: p.group.cz });
    poseName = p.sitClip;
  } else {
    facing = spot.heading;
    poseName = p.lieClip;
  }
  switch (p.stage) {
    case 'go':
      p.timer -= dt;
      if (p.timer <= 0) { finishActivity(p); return null; } // can't get there
      if (Math.hypot(spot.x - p.x, spot.z - p.z) > 0.25) return { x: spot.x, y: area.y, z: spot.z };
      p.stage = 'turn';
      // falls through
    case 'turn':
      p.faceTo = facing;
      if (Math.abs(wrapAngle(facing - p.heading)) > 0.15) break;
      if (p.act === 'circle' && hasClip('Wave') && p.group.members.some(m => m.stage === 'sit')) { playOnce(p, 'Wave'); p.stage = 'greet'; break; }
      // falls through
    case 'greet':
      if (p.oneShot) break;
      p.stage = 'sit';
      p.pose = poseName;
      p.timer = ((p.act === 'circle' ? 25 : 15) + peopleRng()*45)*p.traits.patience;
      if (p.act === 'bench') p.seatLift = p.seat.y - area.y - clipNamed('Sit1').seatY*modelScale(p);
      // falls through
    case 'sit':
      p.timer -= dt;
      if (p.timer <= 0) { p.stage = 'rise'; p.pose = 'Idle'; p.lookAt = null; }
      break;
    case 'rise':
      if (weightOf(p, clipNamed('Idle')) < 1) break;
      if (p.act === 'circle' && hasClip('Wave') && p.group.members.some(m => m !== p && m.stage === 'sit')) { playOnce(p, 'Wave'); p.stage = 'bye'; break; }
      finishActivity(p);
      return null;
    case 'bye':
      if (!p.oneShot) { finishActivity(p); return null; }
      break;
  }
  // on a bench, sitting down shifts them back onto the seat, and getting up forward off it — as far as sitting puts their
  // pelvis behind their feet, so that their feet stay put
  if (p.act === 'bench') {
    const w = weightOf(p, clipNamed('Sit1'));
    p.x = spot.x + (p.seat.x - spot.x)*w; p.z = spot.z + (p.seat.z - spot.z)*w;
  }
  return null;
}

// ---- punching: now and then someone (the more aggression, the more often) picks on someone near them — along the same
// walkway, or in the same plaza or park — goes up to them, as close as they'd stand to talk, punches them, and walks off.
// Whoever they pick on only notices them at the last moment, turning to face them, and is knocked flat on their back; they
// lie there a while, then get up where they fell and carry on.
const PUNCH_RATE = 1/8;        // the chance a second of picking on someone, per unit of aggression
const PUNCH_REACH = 8;          // how far off (at people size 1) the one they pick on can be
const PUNCH_NOTICE = 2.5;       // how near they come before they're noticed
const PUNCH_CHASE_SPEED = 1.5;  // how much faster than they walk they go after them
const PUNCH_CHASE_MAX = 12;     // seconds before they give up on catching them
const PUNCH_HIT_TIME = 0.5;    // how far into the Punch animation the fist lands, in seconds
let reach = PUNCH_REACH*S.peopleSize;
// someone going about their business, who might punch or be punched
const isFairGame = q => (q.mode === 'line' || q.mode === 'wander') && !q.act && !q.fright && !q.stun && !q.please && !q.jc && !q.crossStage
  && !q.attack && !q.punched && !q.oneShot;
function pickFights(dt) {
  if (!hasClip('Punch') || !hasClip('Fall')) return;
  reach = PUNCH_REACH*S.peopleSize;
  people.forEach(p => {
    throwPunch(dt, p)
  });
}

function throwPunch(dt, p, isForced, forcedVictim) {
  const { aggression } = p.traits;
  dt = isForced? p.punchCooldown : dt; //force punch roll if forced
  if ( !isForced && (aggression-1 <= 0 || (p.punchCooldown -= dt*aggression/3) > 0 || !isFairGame(p))) return;
  if (isForced) dt = 1;
  if (peopleRng() > dt*PUNCH_RATE*aggression/4){
    p.punchCooldown = 20 + peopleRng()*20;
    return;
  } 
  
  let victim;
  if (forcedVictim) {
    victim = forcedVictim;
  } else {
    // anyone near enough: along the same walkway (not across the block it runs round), or in the same hangout
    const nav = p.mode === 'line' ? peopleNav.lines[p.li] : null;
    const along = q => { const d = Math.abs(q.u - p.u); return nav.loop ? Math.min(d, nav.total - d) : d; };
    const near = people.filter(q => q !== p && q.mode === p.mode && Math.abs(q.x - p.x) < reach && Math.abs(q.z - p.z) < reach
      && Math.hypot(q.x - p.x, q.z - p.z) < reach && (nav ? q.li === p.li && along(q) < reach : q.area === p.area) && isFairGame(q));
    if (!near.length) { p.punchCooldown = 2 + peopleRng()*3; return; }
    victim = pickFrom(near);
  }
  p.attack = { target: victim, stage: 'chase', timer: PUNCH_CHASE_MAX };
  p.lookAt = victim;
  victim.punched = { by: p, stage: 'marked', timer: 0 };
  p.punchCooldown = 20 + peopleRng()*20;
}

const PUNCH_STARE_TIME = 1.5;

// someone punching, each frame: where they should walk to (or null to stand still)
function updateAttack(p, dt) {
  const a = p.attack, t = a.target;
  a.timer -= dt;
  if (a.stage === 'chase') {
    if (t.punched?.by !== p || a.timer <= 0 || !(t.mode === 'line' || t.mode === 'wander' || t.mode === 'leaving') || t.jc) { endAttack(p); return null; }
    const d = Math.hypot(t.x - p.x, t.z - p.z), gap = CHAT_GAP*S.peopleSize;
    if (t.punched.stage === 'marked' && d < PUNCH_NOTICE*S.peopleSize) {
      t.punched = null;
      endActivity(t);
      t.oneShot = null; t.wait = 0;
      t.punched = { by: p, stage: 'brace', timer: 0 };
      t.faceTo = headingTo(t, p); t.lookAt = p;
    }
    if (d > gap + 0.1) return { x: t.x + (p.x - t.x)/d*gap, y: t.y, z: t.z + (p.z - t.z)/d*gap };
    a.stage = 'punch';
    a.timer = PUNCH_HIT_TIME;
    playOnce(p, 'Punch');
  }
  if (a.stage === 'punch') {
    p.faceTo = headingTo(p, t);
    if (a.timer > 0) return null;
    if (t.punched?.by === p) knockDown(t, p);
    a.stage = 'stare';
    a.timer = PUNCH_STARE_TIME;
  }
  if (a.stage === 'stare') {
    p.faceTo = headingTo(p, t); // keep looking down at them while it plays out
    if (a.timer > 0) return null;
    a.stage = 'follow';
  }
  // the stare's over, they walk off
  if (!p.oneShot) {
    endAttack(p);
    if (p.mode === 'line') {
      const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), from = nav.pts[k], to = nav.pts[k + 1];
      if (((to.x - from.x)*(t.x - p.x) + (to.z - from.z)*(t.z - p.z))*p.dir > 0) p.dir = -p.dir;
    } else if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      let best = null;
      for (let k=0;k<8;k++) {
        const spot = randomSpotIn(area, p), d = Math.hypot(spot.x - t.x, spot.z - t.z);
        if (!best || d > best.d) best = { ...spot, d };
      }
      p.tx = best.x; p.tz = best.z; p.wait = 0;
    }
  }
  return null;
}
// stops someone going after whoever they were going to punch — who, if they hadn't been hit yet, carries on as they were
function endAttack(p) {
  const a = p.attack;
  if (!a) return;
  p.attack = null;
  p.lookAt = null; p.faceTo = null;
  const t = a.target;
  if (t.punched?.by === p && (t.punched.stage === 'marked' || t.punched.stage === 'brace')) { t.punched = null; t.faceTo = null; t.lookAt = null; }
}
// someone being punched is let off it (to do something else): whoever was coming for them gives up, and if they were
// falling they stand straight back up
function releasePunched(p) {
  const k = p.punched;
  if (!k) return;
  p.punched = null;
  if (k.by.attack?.target === p) endAttack(k.by);
  if (k.stage === 'fall') p.oneShot = null;
}
// the punch lands: they're knocked flat on their back, facing whoever hit them
function knockDown(t, p) {
  t.punched.stage = 'fall';
  t.heading = headingTo(t, p);
  t.faceTo = null; t.lookAt = null;
  playOnce(t, 'Fall');
  t.pose = 'Fallen';
}
// the fall played out: they lie where it's left them — moved to where their pelvis landed, as for anyone lying down, the
// pose drawn set back from there by as much (so nothing moves)
function landFall(p) {
  const fallen = clipNamed('Fallen'), s = modelScale(p), sin = Math.sin(p.heading), cos = Math.cos(p.heading);
  const offX = fallen.pelvisX*s, offZ = fallen.pelvisZ*s;
  p.x += offX*cos + offZ*sin; p.z += offZ*cos - offX*sin;
  p.clipA = p.clipB = fallen; p.fade = 1;
  p.punched.stage = 'down';
  p.punched.timer = (3 + peopleRng()*4)*p.traits.patience;
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; }
}
// someone who's been punched, each frame: lying there a while, then getting up
function updatePunched(p, dt) {
  const k = p.punched;
  if (k.stage === 'down' && (k.timer -= dt) <= 0) { k.stage = 'rise'; p.pose = 'Idle'; }
  else if (k.stage === 'rise' && weightOf(p, clipNamed('Idle')) >= 1) { p.punched = null; p.wait = 0.5 + peopleRng(); }
}

// ---- following someone with the camera: in World mode, clicking a person keeps the view centered on them as they go —
// orbiting and zooming as usual, and able to come in closer than the camera usually can — with a card saying who they are
// (person-card.js), until a click anywhere else, a pan, leaving World mode, or them leaving the crowd lets them go
let followed = -1; // their index in people
const personHeight = p => 1.7*p.height*S.peopleSize*p.heightScale;
// the person under a point on the screen (the one nearest the camera, if several are), or -1: a point within about their
// width of the line up the middle of them, as they look on screen — or within a few pixels, for someone far off
function pickPerson(clientX, clientY) {
  if (!S.peopleEnabled) return -1;
  const width = window.innerWidth, height = window.innerHeight, foot = new THREE.Vector3(), head = new THREE.Vector3();
  let best = -1, bestDepth = Infinity;
  people.forEach((p, i) => {
    if (isGone(p)) return;
    foot.set(p.x, p.y, p.z).project(camera);
    head.set(p.x, p.y + personHeight(p), p.z).project(camera);
    if (Math.abs(foot.z) > 1 || Math.abs(head.z) > 1) return; // behind the camera, or beyond what it draws
    const ax = (foot.x + 1)/2*width, ay = (1 - foot.y)/2*height, bx = (head.x + 1)/2*width, by = (1 - head.y)/2*height;
    const lengthSq = (bx - ax)**2 + (by - ay)**2;
    const k = lengthSq > 0 ? Math.max(0, Math.min(1, ((clientX - ax)*(bx - ax) + (clientY - ay)*(by - ay))/lengthSq)) : 0;
    const off = Math.hypot(clientX - (ax + (bx - ax)*k), clientY - (ay + (by - ay)*k));
    if (off <= Math.max(8, Math.sqrt(lengthSq)*0.22) && foot.z < bestDepth) { best = i; bestDepth = foot.z; }
  });
  return best;
}
// follows whoever's under a point on the screen, or stops following if nobody is
function followPersonAt(clientX, clientY) {
  const i = pickPerson(clientX, clientY);
  if (i < 0) { stopFollowingPerson(); return; }
  followPerson(i);
}
function followPerson(i) {
  followed = i;
  riderFollowed = -1;
  const h = personHeight(people[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9)); // swooping in, if the camera's far off
  App.showPersonCard(i, personModel ? personModel.isMan[i] === 1 : null);
  App.setPersonCardIndoors(isGone(people[i]) && people[i].indoors ? buildingLabel(people[i].indoors.building) : null);
}
// Where someone's head is and which way their face points, in the world, for the person card's headshot: from their pose
// this frame, worked out as the shader works it out — the head bone's pose (part-way between frames, and between the two
// animations they're blending), their head turned and tilted, and where they are.
const headshot = { head: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3(), distance: 0 };
const headPoseA = new Float32Array(12), headPoseB = new Float32Array(12);
const headMatrix = new THREE.Matrix4(), headTurn = new THREE.Matrix3(), lookTurn = new THREE.Matrix4(), lookTilt = new THREE.Matrix4();
const headshotInstance = new THREE.Matrix4(), headOffset = new THREE.Vector3();
// the head bone's pose (its matrix's top three rows) at a row of the bone texture
function headPoseAt(out, row) {
  const { boneData, boneWidth, headBone } = personModel, r = Math.floor(row), t = row - r;
  const a = (r*boneWidth + headBone*3)*4, b = ((r + 1)*boneWidth + headBone*3)*4;
  for (let k=0;k<12;k++) out[k] = boneData[a + k] + (boneData[b + k] - boneData[a + k])*t;
}
function headshotOf(i) {
  const anim = personModel.anim.array, look = personModel.look.array, o = i*4, fade = anim[o+2];
  headPoseAt(headPoseA, anim[o]);
  headPoseAt(headPoseB, anim[o+1]);
  const e = headPoseA.map((value, k) => value*fade + headPoseB[k]*(1 - fade));
  headMatrix.set(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], 0, 0, 0, 1);
  headTurn.setFromMatrix4(headMatrix);
  lookTurn.makeRotationY(look[o]).multiply(lookTilt.makeRotationX(look[o+1]));
  personModel.mesh.getMatrixAt(i, headshotInstance);
  headOffset.copy(HEAD_CENTER).applyMatrix4(lookTurn).applyMatrix3(headTurn);
  headshot.head.copy(personModel.headPivot).applyMatrix4(headMatrix).add(headOffset).applyMatrix4(headshotInstance);
  headshot.forward.set(0, 0, 1).applyMatrix4(lookTurn).applyMatrix3(headTurn).transformDirection(headshotInstance);
  headshot.up.set(0, 1, 0).applyMatrix4(lookTurn).applyMatrix3(headTurn).transformDirection(headshotInstance);
  headshot.distance = 4.6*modelScale(people[i]);
  return headshot;
}
// Someone blowing up nearby: everyone around notices (the nearer, the sooner), drops whatever they were doing, stares in
// shock — mouth open, face aghast — then runs off away from it for a while, more than twice as fast.
const FRIGHT_RADIUS = 14, FLEE_SPEED = 2.3;
function frightenBystanders(victim) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d <= reach) p.fright = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}
function stunBystanders(victim) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d <= reach) p.stun = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}
function pleaseBystanders(victim) {
  const reach = FRIGHT_RADIUS*S.peopleSize, from = { x: victim.x, z: victim.z };
  people.forEach(p => {
    if (p === victim || isGone(p)) return;
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d <= reach) p.please = { stage: 'notice', timer: 0.15 + d/reach*0.6 + peopleRng()*0.3, from };
  });
}
function updateEffect(p, dt, key, onResolve) {
  const state = p[key];
  state.timer -= dt;
  if (state.timer > 0) return;
  if (state.stage === 'notice') {
    endActivity(p);
    p.oneShot = null; p.wait = 0;
    p.faceTo = headingTo(p, state.from);
    p.lookAt = state.from;
    state.stage = 'look';
    state.timer = 0.5 + peopleRng()*0.7;
  } else if (state.stage === 'look') {
    onResolve(p, state);
  } else {
    p[key] = null;
  }
}

function updateFright(p, dt) {
  updateEffect(p, dt, 'fright', (p, fright) => {
    fright.stage = 'flee';
    fright.timer = 5 + peopleRng()*4;
    p.faceTo = null; p.lookAt = null;
    if (p.mode === 'line') {
      const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1];
      if (((b.x - a.x)*(fright.from.x - p.x) + (b.z - a.z)*(fright.from.z - p.z))*p.dir > 0) p.dir = -p.dir;
    } else if (p.mode === 'wander') {
      fleeWithin(p, peopleNav.areas[p.area]);
    }
  });
}

function updateStun(p, dt) {
  updateEffect(p, dt, 'stun', (p, stun) => {
    stun.stage = 'dazed';       // they hold still, don't flee
    stun.timer = 3 + peopleRng()*2;
  });
}

function updatePlease(p, dt) {
  updateEffect(p, dt, 'please', (p, please) => {
    please.stage = 'delighted'; // they hold still and beam, don't flee either
    please.timer = 2 + peopleRng()*2;
    p.faceTo = null; p.lookAt = null;
  });
}
// somewhere in a plaza or park as far as can be found from whatever frightened them
function fleeWithin(p, area) {
  let best = null;
  for (let k=0;k<12;k++) {
    const spot = randomSpotIn(area), d = Math.hypot(spot.x - p.fright.from.x, spot.z - p.fright.from.z);
    if (!best || d > best.d) best = { x: spot.x, z: spot.z, d };
  }
  p.tx = best.x; p.tz = best.z; p.wait = 0;
}
// Hair greys with age. Their trait colors go to the GPU once and are never sampled back, so this is worked out
// wherever the color is actually wanted rather than written back over the trait: written back, it re-greyed an
// already-greyed color every frame — everyone went white within seconds — and the giblets inherited the drift.
const HAIR_GREY = new THREE.Color(0xffffff);
const GREYS_FROM = 30, GREYS_OVER = 100; // white-haired by GREYS_FROM + GREYS_OVER, unless they're ageless
const greyWithAge = (color, p) =>
  color.lerp(HAIR_GREY, p.traits.ageless ? 0 : Math.max(0, Math.min(1, (p.age - GREYS_FROM)/GREYS_OVER)));
// The person card's Kill button: whoever it is explodes into giblets in their own colors, and stays dead (gone from the
// crowd, though their place in it is kept) — whoever they were talking to carrying on without them.
// `by` is who did it, for the morality meter: 'player' (the Kill button) or 'car'.
function killPerson(i, by = 'player') {
  const p = people[i];
  if (!p || isGone(p)) return;
  App.recordMoralityEvent?.(by === 'car' ? 'peds killed by cars' : 'peds killed by player');
  if (followed === i) stopFollowingPerson();
  endActivity(p);
  p.crossStage = null; // don't leave a car yielding forever for someone who can no longer finish crossing
  p.jc = null;
  const colors = { skin: new THREE.Color(0xf2d33c), top: new THREE.Color(), pants: new THREE.Color(), shoes: new THREE.Color(0x222226), hair: null };
  if (personModel) {
    const colorFrom = (part, color) => {
      const o = ((2 + PERSON_TRAIT_COLORS.indexOf(part))*PEOPLE_MAX + i)*4, data = personModel.traitData;
      return color.setRGB(data[o], data[o+1], data[o+2]);
    };
    colors.skin.copy(personModel.palette[0]);
    colorFrom('Top', colors.top); colorFrom('Pants', colors.pants); colorFrom('Shoes', colors.shoes);
    if (personModel.headLayers.some(layer => layer.of[i] >= 0)) colors.hair = colorFrom('Hair', new THREE.Color());
  } else {
    peopleMesh.getColorAt(i, colors.top);
    colors.pants.copy(colors.top);
  }
  Object.values(colors).forEach(color => color?.lerp(new THREE.Color(0x550000), 0.4)); //make gibs darker, less saturated
  explode({ x: p.x, y: p.y, z: p.z }, 1.7*p.height*S.peopleSize, colors);
  const evil = profileOf(i, true).traits.evil;
  if (people[i])
  evil <= 0.05 ? frightenBystanders(p) :
  evil <= 0.35 ? stunBystanders(p) :
  pleaseBystanders(p);
  p.mode = 'dead';
  p.train = null;
  p.indoors = null;
  p.moving = false;
}
function stopFollowingPerson() {
  if (followed < 0) return;
  if (possession.index === followed) unpossessPerson();
  followed = -1;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hidePersonCard();
}

// ---- possessing someone (see possession.js): whoever the camera's following, walked about from their own eyes. They drop
// whatever they were doing and walk wherever they're walked — out onto the roads too, where the cars can hit them — and
// when let go, carry on from the nearest walkway, with the camera back behind them.
const EYE_NEAR = 0.2; // how close the view draws, from their eyes (it's usually further off than that)
let cameraNear = camera.near;
function possessPerson(i) {
  const p = people[i];
  if (i !== followed || !p || isGone(p) || possession.index === i) return;
  endActivity(p);
  if (p.train) { p.train = null; p.trainCooldown = 40 + peopleRng()*50; }
  if (p.indoors) { p.indoors = null; p.indoorsCooldown = INDOORS_COOLDOWN; }
  p.crossStage = null; p.jc = null; p.fright = p.stun = p.please = null; p.oneShot = null;
  p.mode = 'possessed';
  p.onRoad = false;
  if (!startPossession(i, p.heading + (p.traits.backwards ? Math.PI : 0))) { p.mode = 'wander'; reseatPerson(p); return; }
  cameraNear = camera.near;
  camera.near = EYE_NEAR;
  camera.updateProjectionMatrix();
}
function unpossessPerson() {
  if (possession.index < 0) return;
  const i = possession.index, p = people[i];
  endPossession();
  camera.near = cameraNear;
  camera.updateProjectionMatrix();
  if (!p || p.mode !== 'possessed') return;
  // back into a hangout they're standing in, else onto the nearest walkway
  p.mode = 'wander';
  p.onRoad = false;
  reseatPerson(p);
  if (p.mode === 'wander') { p.tx = p.x; p.tz = p.z; p.wait = 1; }
  // the camera behind them, looking the way they were
  const behind = possession.yaw + Math.PI;
  controls.goalTheta = controls.theta + wrapAngle(behind - controls.theta);
  controls.goalPhi = Math.max(controls.goalPhi, Math.PI*0.3);
}
// walks them where they're asked to go, this frame, over whatever's there — returning where they end up
function walkPossessed(p, dt) {
  const { forward, right, run } = controlInput(), yaw = possession.yaw;
  const len = Math.hypot(forward, right);
  let x = p.x, z = p.z;
  if (len > 0) {
    const speed = PERSON_WALK_SPEED*p.stride*Math.max(0.5, p.traits.walkspeed)*(run ? FLEE_SPEED : 1);
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    x += (fx*forward + rx*right)/len*speed*dt;
    z += (fz*forward + rz*right)/len*speed*dt;
  }
  // how high the ground is there: a hangout's, the road's, or the pavement's
  const area = peopleNav.areas.find(a => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ && a.inside(x, z));
  p.onRoad = !area && peopleNav.onPavement(x, z);
  p.area = area ? peopleNav.areas.indexOf(area) : -1;
  return { x, y: area ? area.y : p.onRoad ? Y_ROAD : Y_SIDEWALK, z };
}
// the view from their eyes (or where they'd be, as a cuboid)
function placePossessedCamera(i) {
  const p = people[i];
  if (personModel) camera.position.copy(headshotOf(i).head);
  else camera.position.set(p.x, p.y + personHeight(p)*0.92, p.z);
  camera.rotation.set(possession.pitch, possession.yaw + Math.PI, 0, 'YXZ');
}

// ---- riding the trains: someone walking past a train station — one standing in the plaza or park they're in, or near
// enough a walkway they're on — now and then decides to ride it. Stations can be at any height, so there's no walking up
// to one: they go to the foot of it, pop up onto the landing outside one of its doors, walk in to wait on the platform,
// and vanish into the first carriage to stop there. At each station it then stops at, they get off — always, on a network
// of just two stations, else with a chance of one in however many stations the network has — reappearing on the
// platform, walking out, and popping back down onto the walkway or hangout at the station's foot. Stations with neither
// nearby can't be got on or off at. Someone being followed by the camera takes it with them: onto their train, and back
// off it with them (see "following a carriage" in trains.js), whose card lists who's aboard.
// p.train: { node (the station they're at or last got on at), stage ('approach' → 'enter' → 'wait' → 'ride' → 'exit'),
// target (where they're walking to), side (of the station they came in by), along (where along its platform they wait),
// lineId (while riding), timer }
const RIDE_CHANCE = 0.05;      // at each walkway point near a station
const STATION_REACH = 4;       // how far beyond a station's sides a walkway can pass and still lead up to it
const TRAIN_WAIT_MAX = 120, TRAIN_RIDE_MAX = 240;
let riderFollowed = -1;        // someone the camera was following when they got on, to follow again when they get off
const isGone = p => p.mode === 'none' || p.mode === 'dead' || (p.mode === 'train' && p.train.stage === 'ride')
  || (p.mode === 'indoors' && p.indoors.stage === 'inside');
// What each station's foot leads to, worked out again when the walkways or the trains change: for each station node,
// { area (the hangout it stands in, or -1), vertex ({ li, vi }, the nearest walkway point, or null) } — and the other way,
// the station near each walkway point ('li:vi') and those in each hangout (by index).
let stationLinksCache = null, stationLinksKey = '';
function stationLinks() {
  const key = peopleNavBuiltAt + ':' + trainStationsVersion();
  if (stationLinksCache && key === stationLinksKey) return stationLinksCache;
  stationLinksKey = key;
  const { areas, lines, grid, CELL } = peopleNav, links = { ground: new Map(), byVertex: new Map(), byArea: new Map() };
  const nearest = new Map(); // 'li:vi' -> its distance to the station it's been given
  getTrainStations().forEach(st => {
    const area = areas.findIndex(a => st.x >= a.minX && st.x <= a.maxX && st.z >= a.minZ && st.z <= a.maxZ && a.inside(st.x, st.z));
    const reach = st.halfW + STATION_REACH, span = Math.ceil(reach/CELL);
    const cx = Math.floor(st.x/CELL), cz = Math.floor(st.z/CELL);
    let vertex = null;
    for (let ox=-span;ox<=span;ox++) for (let oz=-span;oz<=span;oz++) (grid.get((cx+ox) + ',' + (cz+oz)) || []).forEach(({ li, vi }) => {
      if (lines[li].blocked && lines[li].blocked[vi]) return; // (not out on a road)
      const q = lines[li].pts[vi], d = Math.hypot(q.x - st.x, q.z - st.z), k = li + ':' + vi;
      if (d > reach) return;
      if (!vertex || d < vertex.d) vertex = { li, vi, d };
      if (!nearest.has(k) || d < nearest.get(k)) { nearest.set(k, d); links.byVertex.set(k, st.nodeId); }
    });
    if (area < 0 && !vertex) return;
    links.ground.set(st.nodeId, { area, vertex });
    if (area >= 0) { if (!links.byArea.has(area)) links.byArea.set(area, []); links.byArea.get(area).push(st.nodeId); }
  });
  return (stationLinksCache = links);
}
// off to the foot of a station, `from` (where they are), to ride its trains
function goRideTrain(p, node, from) {
  endActivity(p);
  p.crossStage = null; p.jc = null; p.wait = 0;
  p.mode = 'train';
  p.train = { node, stage: 'approach', target: { x: from.x, y: from.y, z: from.z }, side: 1, along: 0, lineId: null, timer: 0 };
}
// someone riding the trains, each frame: where they should walk to (or null to stand still)
function updateTrainRider(p, i, dt) {
  const ride = p.train, st = getTrainStations().get(ride.node), reached = () => Math.hypot(ride.target.x - p.x, ride.target.z - p.z) < 0.35;
  ride.timer += dt;
  if (ride.stage === 'ride') {
    const shuttle = getTrainShuttles().find(s => s.lineId === ride.lineId);
    if (!shuttle) { gotOff(p, i); dropToGround(p); return null; } // (their line's gone)
    p.x = shuttle.object.position.x; p.y = shuttle.object.position.y; p.z = shuttle.object.position.z;
    const at = shuttle.arrived && getTrainStations().get(shuttle.stopNode);
    if (at && stationLinks().ground.has(at.nodeId) && (at.networkStations <= 2 || peopleRng() < 1/at.networkStations || ride.timer > TRAIN_RIDE_MAX)) {
      // off here: back onto the platform, beside the track, to walk out the way they'd have come in
      ride.node = at.nodeId; ride.stage = 'exit'; ride.side = peopleRng() < 0.5 ? -1 : 1; ride.timer = 0;
      const out = at.spot(ride.side*(at.radius + 0.8), (peopleRng()*2 - 1)*Math.min(2, at.alongMax));
      p.x = out.x; p.y = out.y; p.z = out.z;
      p.heading = headingTo(p, at.spot(ride.side*at.landing, 0));
      ride.target = at.spot(ride.side*at.landing, 0);
      gotOff(p, i);
    }
    return null;
  }
  if (!st) { dropToGround(p); return null; } // (the station's gone from under them)
  if (ride.stage === 'approach') {
    if (!reached()) return ride.target;
    // up onto the landing outside whichever of its doors is nearer
    const plus = st.spot(st.landing, 0), minus = st.spot(-st.landing, 0);
    ride.side = Math.hypot(plus.x - p.x, plus.z - p.z) <= Math.hypot(minus.x - p.x, minus.z - p.z) ? 1 : -1;
    const landing = ride.side > 0 ? plus : minus;
    p.x = landing.x; p.y = landing.y; p.z = landing.z;
    ride.stage = 'enter';
    ride.along = (peopleRng()*2 - 1)*st.alongMax;
    ride.target = st.spot(ride.side*(st.radius + 0.8 + peopleRng()*1.2), ride.along);
    return ride.target;
  }
  if (ride.stage === 'enter') {
    if (!reached()) return ride.target;
    ride.stage = 'wait'; ride.timer = 0;
    p.faceTo = headingTo(p, st.spot(0, ride.along)); // (towards the track)
    return null;
  }
  if (ride.stage === 'wait') {
    const shuttle = getTrainShuttles().find(s => s.stopNode === ride.node && st.lineIds.includes(s.lineId));
    if (shuttle) {
      // aboard
      p.faceTo = null; p.oneShot = null;
      ride.stage = 'ride'; ride.lineId = shuttle.lineId; ride.timer = 0;
      if (followed === i) { stopFollowingPerson(); App.followTrainLine?.(shuttle.lineId); riderFollowed = i; }
    } else if (ride.timer > TRAIN_WAIT_MAX) {
      // fed up of waiting: back out
      p.faceTo = null;
      ride.stage = 'exit'; ride.target = st.spot(ride.side*st.landing, 0);
    }
    return null;
  }
  // 'exit': out to the landing, then down to the station's foot
  if (!reached()) return ride.target;
  landAtStation(p, ride.node);
  return null;
}
// just got off (or been thrown off) a train: the camera back onto them, if it came along for the ride and is still on it
function gotOff(p, i) {
  if (riderFollowed !== i) return;
  riderFollowed = -1;
  if (App.followedTrainLine?.() !== p.train.lineId) return;
  App.stopFollowingTrain();
  followPerson(i);
}
// from a station's landing down to its foot: onto the walkway there (heading either way), or into the hangout it's in
function landAtStation(p, node) {
  const foot = stationLinks().ground.get(node), st = getTrainStations().get(node);
  p.train = null;
  p.faceTo = null;
  p.trainCooldown = 40 + peopleRng()*50;
  if (foot && foot.vertex) {
    placeAtVertex(p, foot.vertex.li, foot.vertex.vi, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else if (foot) {
    const area = peopleNav.areas[foot.area];
    wanderInto(p, foot.area, st);
    p.x = p.tx; p.z = p.tz; p.y = area.y;
  } else {
    p.mode = 'line';
    dropToGround(p);
  }
}
// the station or line they were on has gone: straight onto the nearest walkway or hangout below
function dropToGround(p) {
  p.train = null;
  p.faceTo = null;
  p.trainCooldown = 40 + peopleRng()*50;
  p.mode = 'line';
  reseatPerson(p);
  if (p.mode === 'line') { const at = walkwayPoint(p); p.x = at.x; p.y = at.y; p.z = at.z; }
  else if (p.mode === 'wander') { p.x = p.tx; p.z = p.tz; p.y = peopleNav.areas[p.area].y; }
}
// the followed carriage's card: who's aboard, by name — whoever the camera came aboard with picked out
let passengersKey = null;
function showPassengers() {
  const line = App.followedTrainLine?.();
  const riders = [];
  if (line && S.peopleEnabled) people.forEach((p, i) => { if (p.mode === 'train' && p.train.stage === 'ride' && p.train.lineId === line) riders.push(i); });
  const key = line + '|' + riders.join(',') + '|' + riderFollowed + '|' + profilesVersion() + '|' + !!personModel;
  if (key === passengersKey || !App.setTrainCardPassengers) return;
  passengersKey = key;
  App.setTrainCardPassengers(riders.map(i => profileOf(i, personModel ? personModel.isMan[i] === 1 : null).name), riders.indexOf(riderFollowed));
}

// ---- going indoors: someone walking past a building's door (see buildingDoors) now and then goes in — walking up to it
// and vanishing inside for anything up to INDOORS_MAX_HOURS of the day's clock (at the World panel's day length, whether
// or not the clock's running), then coming back out the same door and on along the walkway they came off. Someone the
// camera's following takes it with them: it looks at the building while they're in, and their card says which one.
// Only so many of the crowd are ever indoors at once, so the streets don't empty out on long days.
// p.indoors: { building, stage ('approach' → 'inside' → 'exit'), back (the walkway point they came from), hoursLeft }
const ENTER_CHANCE = 0.1;          // at each walkway point with a door onto it
const INDOORS_MIN_HOURS = 0.25, INDOORS_MAX_HOURS = 7;
const INDOORS_MAX_SHARE = 0.3;     // of the crowd, indoors (or on their way in) at once
const INDOORS_COOLDOWN = 30;       // seconds after coming out before they'd go in anywhere again
let indoorsCount = 0;
const mayGoIndoors = p => p.indoorsCooldown <= 0 && !p.act && !p.attack && !p.punched && !p.fright && indoorsCount < people.length*INDOORS_MAX_SHARE;
// what a building's called on the card of whoever's in it: its kind's name and its own number (see building-types.js)
const buildingLabel = b => buildingTypeOf(b.kind, b.number).name + ' #' + b.number;
function goIndoors(p, building, from) {
  endActivity(p);
  p.crossStage = null; p.jc = null; p.wait = 0;
  p.mode = 'indoors';
  // mostly a quick visit, now and then most of the day
  const hours = INDOORS_MIN_HOURS + (INDOORS_MAX_HOURS - INDOORS_MIN_HOURS)*peopleRng()**2;
  p.indoors = { building, stage: 'approach', back: { x: from.x, y: from.y, z: from.z }, hoursLeft: hours };
  indoorsCount++;
}
// someone going into (or in, or coming out of) a building, each frame: where they should walk to (or null to stand still)
function updateIndoors(p, i, dt) {
  const visit = p.indoors, { door } = visit.building;
  if (visit.stage === 'approach') {
    if (Math.hypot(door.x - p.x, door.z - p.z) >= 0.35) return { x: door.x, y: visit.building.y, z: door.z };
    visit.stage = 'inside';
    p.faceTo = null; p.lookAt = null; p.oneShot = null;
    if (followed === i) { App.setPersonCardIndoors(buildingLabel(visit.building)); lookAtBuilding(visit.building); }
    return null;
  }
  if (visit.stage === 'inside') {
    visit.hoursLeft -= dt*24/(Math.max(0.1, S.dayLengthMinutes)*60);
    if (visit.hoursLeft > 0) return null;
    // back out, at the door, facing the walkway
    visit.stage = 'exit';
    p.x = door.x; p.z = door.z; p.y = visit.building.y;
    p.heading = headingTo(p, visit.back) + (p.traits.backwards ? Math.PI : 0);
    if (followed === i) { App.setPersonCardIndoors(null); lookAtPerson(p); }
    return visit.back;
  }
  // 'exit': back to the walkway, then on along it, whichever way
  if (Math.hypot(visit.back.x - p.x, visit.back.z - p.z) >= 0.35) return visit.back;
  p.indoors = null;
  p.indoorsCooldown = INDOORS_COOLDOWN*(0.5 + peopleRng());
  p.mode = 'line';
  p.dir = peopleRng() < 0.5 ? -1 : 1;
  reseatPerson(p);
  return null;
}
// the followed building's card (see building-card.js): who's inside, by name
let inhabitantsKey = null;
function showInhabitants() {
  const key = App.followedBuildingKey?.();
  const inside = [];
  if (key && S.peopleEnabled) people.forEach((p, i) => { if (p.mode === 'indoors' && p.indoors.stage === 'inside' && p.indoors.building.key === key) inside.push(i); });
  const shownKey = key + '|' + inside.join(',') + '|' + profilesVersion() + '|' + !!personModel;
  if (shownKey === inhabitantsKey || !App.setBuildingCardInhabitants) return;
  inhabitantsKey = shownKey;
  if (key) App.setBuildingCardInhabitants(inside.map(i => profileOf(i, personModel ? personModel.isMan[i] === 1 : null).name));
}
// the camera, following someone who's gone indoors: back far enough to take in the building they're in
function lookAtBuilding(b) {
  controls.goalRadius = Math.max(controls.goalRadius, Math.min(400, (b.size + b.height)*1.6));
}
// and once they're out: swooping back in on them
function lookAtPerson(p) {
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, personHeight(p)*9));
}

// whether p is walking over a road (see updateCrossing) — treated like someone standing in the middle of it ('mid') by
// checkYield in traffic.js: out on the live lanes, not on a sidewalk
export function isPedInDanger(p) {
  return p.crossStage === 'jcross' || p.crossStage === 'half1' || p.crossStage === 'half2' || (p.mode === 'possessed' && p.onRoad);
}
export function updatePeople(t) {
  const dt = lastPeopleTime == null ? 0 : Math.min(0.1, Math.max(0, t - lastPeopleTime));
  lastPeopleTime = t;
  if (followed >= 0 && (!S.peopleEnabled || S.interactionMode !== 'move')) stopFollowingPerson();
  peopleMesh.visible = S.peopleEnabled && !personModel;
  if (personModel) [personModel, ...personModel.hair].forEach(part => { part.mesh.visible = S.peopleEnabled; });
  peopleNavDebugMesh.visible = S.peopleEnabled && S.showPeopleNavDebug;
  if (!S.peopleEnabled) { showPassengers(); showInhabitants(); return; }
  if (!peopleNav || (S.peopleNavDirty && t - peopleNavBuiltAt > 0.25 && !navRebuildOnHold())) {
    S.peopleNavDirty = false;
    peopleNavBuiltAt = t;
    // whatever anyone was doing stops, as the benches and grass they were using may have gone
    groups.length = 0;
    people.forEach(p => { p.group = null; p.crossStage = null; p.jc = null; p.faceTo = null; endActivity(p); });
    peopleNav = buildPeopleNav();
    people.forEach(reseatPerson);
  }
  if (S.showPeopleNavDebug && peopleNavDebugBuiltAt !== peopleNavBuiltAt) { peopleNavDebugBuiltAt = peopleNavBuiltAt; rebuildPeopleNavDebug(); }
  const wanted = Math.min(PEOPLE_MAX, Math.round(S.peopleAmount));
  while (people.length < wanted) { const p = newPerson(); spawnPerson(p); people.push(p); }
  while (people.length > wanted) endActivity(people.pop());
  if (followed >= people.length) stopFollowingPerson();
  if (riderFollowed >= people.length) riderFollowed = -1;
  peopleMesh.count = people.length;
  roadsafetyDebugMesh.visible = roadsafetyHalfDebugMesh.visible = pedHitboxDebugMesh.visible = S.showRoadsafetyDebug;
  if (S.showRoadsafetyDebug) roadsafetyDebugMesh.count = roadsafetyHalfDebugMesh.count = pedHitboxDebugMesh.count = people.length;
  indoorsCount = people.reduce((n, p) => n + (p.mode === 'indoors' ? 1 : 0), 0);
  if (personModel) {
    personModel.mesh.count = people.length;
    personModel.hair.forEach(style => { style.mesh.count = countBelow(style.members, people.length); });
    updateGroups(dt);
    meetOnWalkways(dt);
    pickFights(dt);
  }
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  people.forEach((p, i) => {
    if (p.mode === 'none' && (peopleNav.lines.length || peopleNav.areas.length)) spawnPerson(p);
    refreshTraits(p, i);
    p.trainCooldown -= dt;
    p.indoorsCooldown -= dt;
    const possessed = p.mode === 'possessed';
    if (possessed) p.fright = p.stun = p.please = null;
    if (p.fright) updateFright(p, dt);
    //attempting to give additional reactions to npc death depending on how evil they are
    if (p.stun) updateStun(p, dt); //Should freeze bystanders and turn them to face, currently interrupts their actions without freezing or turning
    if (p.please) updatePlease(p, dt); //Should do same as stun but make them emote happily - Doesn't make happy :(
    if (p.punched) updatePunched(p, dt);
    // frozen in place: fright's 'look' stage, or stun/please's 'held' stage. only fright ever flees.
    const frozen = (!!p.fright && p.fright.stage === 'look')
                || (!!p.stun && p.stun.stage === 'held')
                || (!!p.please && p.please.stage === 'held')
                || (!!p.punched && p.punched.stage !== 'marked'); // (braced for a punch, knocked down, or getting up)
    const fleeing = !!p.fright && p.fright.stage === 'flee';
    let speed = PERSON_WALK_SPEED*S.peopleSpeed*p.stride*p.traits.walkspeed*(fleeing ? FLEE_SPEED : 1);
    let goal = null;
    //Updating hair colour depending on age
    //set default hair colour once
    if ((p.defaultHair === undefined) && personModel) {
      const o = ((2 + PERSON_TRAIT_COLORS.indexOf('Hair'))*PEOPLE_MAX + i)*4, data = personModel.traitData;
      const hairColor = new THREE.Color().setRGB(data[o], data[o+1], data[o+2]);
      p.defaultHair = hairColor;
      //TO DO: If birthdays added, break this block into two; below repeated after check for newBirthday boolean
      //Saving default hair future proofs against hair collapsing to white, but as is this should only run once anyways.
      const greyAmount = p.traits.ageless ? 0 : Math.max(0, Math.min(1, (p.age - 30) / (100))); // tweak range to taste
      const newHair =  p.defaultHair.clone().lerp(new THREE.Color(0xffffff), greyAmount);
      data[o] = newHair.r; data[o+1] = newHair.g; data[o+2] = newHair.b;
    }
    // (stopped to talk, or frozen in shock, someone on a walkway stays put)
    if (p.mode === 'line' && p.act !== 'chat' && !frozen && !p.attack) {
      if (!p.jc) maybeCrossRoad(p, peopleNav.lines[p.li], dt);
      if (p.jc) {
        goal = updateCrossing(p, dt, speed); // (null while waiting for a gap in traffic)
        if (isPedInDanger(p)) speed *= CROSS_SPEED_MULT; // an increased pace, crossing
      } else {
        walkAlong(p, speed*dt);
        if (p.mode === 'line') goal = walkwayPoint(p);
      }
    }
    if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      if (p.act) {
        goal = updateActivity(p, area, dt);
      } else if (p.fright || p.stun || p.please || p.attack || frozen) {
        // frightened, stunned or pleased: fright runs off further each time they reach where they were running to;
        // stun/please just hold position via the `frozen` guard below, with no movement of their own
        if (fleeing && Math.hypot(p.tx - p.x, p.tz - p.z) < 0.5) fleeWithin(p, area);
      } else if (p.wait > 0 || p.oneShot) {
        p.wait -= dt;
      } else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.wait = (1 + peopleRng()*9)*p.traits.patience;
        // what next, by how likely each is for them: leaving, sitting down, lying down, going over to talk to someone, going
        // over to someone else, or just somewhere else here — which is what they do if what they'd do next can't be done
        const { lounging, chatty } = p.traits;
        const stations = p.trainCooldown <= 0 ? stationLinks().byArea.get(p.area) : null;
        const next = ['leave', 'sit', 'lie', 'chat', 'friend', 'roam', 'train'][pickWeighted([area.exits.length ? 0.2 : 0, 0.16*lounging, 0.08*lounging, 0.18*chatty, 0.13, 0.25, stations ? 0.12 : 0], w => w)];
        if (next === 'train' && stations) {
          // over to a train station standing in here
          const node = stations[Math.floor(peopleRng()*stations.length)], st = getTrainStations().get(node);
          goRideTrain(p, node, { x: st.x, y: area.y, z: st.z });
        } else if (next === 'leave' && area.exits.length) {
          // head for the nearest of a few of the hangout's entrances
          let exit = null;
          for (let k=0;k<6;k++) {
            const e = area.exits[Math.floor(peopleRng()*area.exits.length)], q = peopleNav.lines[e.li].pts[e.vi], d = Math.hypot(q.x-p.x, q.z-p.z);
            if (!exit || d < exit.d) exit = { ...e, d };
          }
          // they'll join that walkway where it passes the entrance, so that's where they walk to
          joinWalkway(p, exit.li, peopleNav.lines[exit.li].cum[exit.vi], peopleRng() < 0.5 ? -1 : 1);
          p.exit = walkwayPoint(p);
          p.mode = 'leaving'; p.wait = 0;
        } else if (next === 'sit' && goSit(p, area)) {
          // off to a bench, or to sit on the grass
        } else if (next === 'lie' && goLieDown(p, area)) {
          // off to lie down on the grass
        } else if (next === 'chat' && goChat(p, area)) {
          // over to talk to someone
        } else if (next === 'friend') {
          // over to someone else hanging out here
          let friend = null;
          for (let k=0;k<8 && !friend;k++) { const q = people[Math.floor(peopleRng()*people.length)]; if (q !== p && q.mode === 'wander' && q.area === p.area) friend = q; }
          const spot = friend ? { x: friend.tx + (peopleRng()-0.5)*3, z: friend.tz + (peopleRng()-0.5)*3 } : null;
          if (spot && area.inside(spot.x, spot.z)) { p.tx = spot.x; p.tz = spot.z; } else { const s = randomSpotIn(area, p); p.tx = s.x; p.tz = s.z; }
        } else {
          const s = randomSpotIn(area); p.tx = s.x; p.tz = s.z;
        }
      }
      if (p.mode === 'wander' && !p.act && !frozen && !p.attack) goal = { x: p.tx, y: area.y, z: p.tz };
    }
    if (p.mode === 'train') {
      goal = updateTrainRider(p, i, dt);
      if (frozen) goal = null;
    }
    if (p.mode === 'indoors') {
      goal = updateIndoors(p, i, dt);
      if (frozen) goal = null;
    }
    if (p.attack) {
      goal = updateAttack(p, dt);
      if (p.attack?.stage === 'chase') speed *= PUNCH_CHASE_SPEED;
    }
    if (possessed) goal = walkPossessed(p, dt);
    if (p.mode === 'leaving') {
      // already placed on their walkway by joinWalkway; once they've reached it they carry on along it
      goal = frozen ? null : p.exit;
      if (Math.hypot(p.exit.x - p.x, p.exit.z - p.z) < 0.5) p.mode = 'line';
    }
    // in a plaza, walk around its fountain rather than through the pool: while the straight line to where they're going
    // passes over it, head instead for the point on its rim nearest that line — which moves round as they do
    const hangout = (p.mode === 'wander' || p.mode === 'leaving') && p.area >= 0 ? peopleNav.areas[p.area] : null;
    if (goal && hangout && hangout.fountain) {
      const f = hangout.fountain, clearance = f.r + 1.2;
      const c = closestPointOnSegment(f, p, goal);
      let dx = c.x - f.x, dz = c.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < clearance) {
        if (d < 1e-3) { dx = -(goal.z - p.z); dz = goal.x - p.x; }
        const len = Math.hypot(dx, dz) || 1;
        goal = { x: f.x + dx/len*(clearance + 0.3), y: goal.y, z: f.z + dz/len*(clearance + 0.3) };
      }
    }
    // walk towards where they should be — faster if they've fallen behind (cutting across at a junction, say)
    p.moving = false;
    p.stepped = 0;
    if (goal) {
      const dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz);
      const step = possessed ? d : speed*dt*(p.mode === 'line' && !p.crossStage && !p.attack ? 1 + Math.min(2, d*0.5) : 1);
      if (d > 1e-4) {
        const k = Math.min(1, step/d), mx = dx*k, mz = dz*k;
        p.x += mx; p.z += mz;
        // which way they face, and whether they're walking, go by how far they actually moved this frame — someone
        // keeping pace with their walkway is always right on top of the point they're heading for
        if (Math.hypot(mx, mz) > (possessed ? 1e-3 : speed*dt*0.25)) {
          const facing = Math.atan2(mx, mz) + (p.traits.backwards ? Math.PI : 0); // (or away from it, walking backwards)
          p.heading += Math.atan2(Math.sin(facing - p.heading), Math.cos(facing - p.heading))*Math.min(1, dt*8);
          p.moving = true;
          p.stepped = Math.hypot(mx, mz);
        }
      }
      p.y += (goal.y - p.y)*Math.min(1, dt*6);
    }
    // possessed, they face the way they're looking — the walk played backwards, stepping backwards
    if (possessed) {
      p.heading = possession.yaw;
      if (p.moving && controlInput().forward < 0 !== !!p.traits.backwards) p.stepped = -p.stepped;
    }
    // standing still for something (talking, sitting down), they turn to face the way it wants
    if (!p.moving && p.faceTo != null) p.heading += wrapAngle(p.faceTo - p.heading)*Math.min(1, dt*5);
    if (personModel) {
      const clips = personModel.clips, s = isGone(p) ? 0 : modelScale(p);
      // a cycle of the walk for every stride's worth of ground covered, as big as they are (played in reverse, backwards)
      if (s > 0) p.walkCycle = (p.walkCycle + (p.traits.backwards ? -1 : 1)*p.stepped/(personModel.stride*s) + 1) % 1;
      p.idleTime += dt;
      // standing about with nothing to do for a while, now and then a scratch or a think
      if (p.moving) {
        p.stillFor = 0;
      } else if (!p.act && !p.oneShot && !p.fright && p.pose === 'Idle') {
        p.stillFor += dt;
        if (p.traits.fidgety > 0 && p.stillFor > p.fidgetAfter/p.traits.fidgety) { playOnce(p, pickFrom(FIDGETS)); p.stillFor = 0; p.fidgetAfter = 3 + peopleRng()*8; }
      }
      // the animation: one playing through once, else walking, else the pose they're in — blending into it from the last
      if (p.oneShot) {
        p.shotTime += dt;
        if (p.shotTime >= (p.oneShot.frames - 1)/PERSON_BAKE_FPS) {
          if (p.oneShot.name === 'Fall' && p.punched?.stage === 'fall') landFall(p);
          p.oneShot = null;
        }
      }
      if (!p.clipA) { p.clipA = p.clipB = clips.Idle; p.fade = 1; }
      setClip(p, p.oneShot || (p.moving ? clips.Walk : clips[p.pose] || clips.Idle));
      p.fade = Math.min(1, p.fade + dt/p.fadeTime);
      // the model, scaled to the same height as a cuboid person — set back by however far their pose puts their pelvis from
      // their feet, and sat on a bench, up on its seat
      const blend = key => p.clipA[key]*p.fade + p.clipB[key]*(1 - p.fade);
      const offX = blend('pelvisX')*s, offZ = blend('pelvisZ')*s, sin = Math.sin(p.heading), cos = Math.cos(p.heading);
      p.heightScale = blend('heightScale');
      rotation.setFromAxisAngle(up, p.heading);
      position.set(p.x - offX*cos - offZ*sin, p.y + p.seatLift*weightOf(p, clips.Sit1) - personModel.minY*s, p.z + offX*sin - offZ*cos);
      matrix.compose(position, rotation, scale.set(s, s, s));
      personModel.mesh.setMatrixAt(i, matrix);
      // a blink every few seconds, the eyes closing and opening again over BLINK_DURATION
      p.blinkIn -= dt;
      p.blinkAge += dt;
      if (p.blinkIn <= 0 && p.traits.blinks > 0) { p.blinkAge = 0; p.blinkIn = BLINK_DURATION + (1.5 + peopleRng()*5)/p.traits.blinks; }
      p.lookIn -= dt;
      if (p.lookAt) {
        // talking: at whoever they're talking to, or whoever's talking
        p.lookTurnTo = Math.max(-LOOK_MAX_TURN, Math.min(LOOK_MAX_TURN, wrapAngle(headingTo(p, p.lookAt) - p.heading)));
        p.lookTiltTo = 0;
      } else if (p.lookIn <= 0) {
        // every so often a glance somewhere else — not so far while walking — or back ahead, the head easing round to it
        // (the nosier they are, the more often, the less often back ahead, and the further round)
        const { nosy } = p.traits;
        p.lookIn = (1.5 + peopleRng()*4)/nosy;
        const ahead = peopleRng() < 0.35/nosy, reach = (p.moving ? 0.6 : 1)*Math.min(1.5, Math.sqrt(nosy));
        p.lookTurnTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TURN*reach;
        p.lookTiltTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TILT;
      }
      if (possessed) { p.lookTurnTo = 0; p.lookTiltTo = 0; }
      p.lookTurn += (p.lookTurnTo - p.lookTurn)*Math.min(1, dt*4);
      p.lookTilt += (p.lookTiltTo - p.lookTilt)*Math.min(1, dt*4);
      // talking, their mouth moves; listening, their expression changes every now and then
      const group = p.group, talking = !!group && group.speaker === p, listening = !!group && !!group.speaker && !talking && p.lookAt === group.speaker;
      if (!talking) {
        p.talkTo = 0;
      } else if ((p.talkIn -= dt) <= 0) {
        p.talkTo = peopleRng() < 0.25 ? 0 : 0.3 + peopleRng()*0.7;
        p.talkIn = 0.08 + peopleRng()*0.14;
      }
      // (shocked, a gasp — agape while they stare)
      if (frozen || fleeing) p.talkTo = frozen ? 1 : 0.55;
      p.talk += (p.talkTo - p.talk)*Math.min(1, dt*20);
      if (listening) {
        if ((p.emotionIn -= dt) <= 0) { p.emotionTo = Math.max(-1, Math.min(1, peopleRng()*2 - 1 + p.traits.mood)); p.emotionIn = 1.5 + peopleRng()*3; }
      } else if (!group) {
        p.emotionTo = p.traits.mood; // (their resting face)
      }
      if (frozen || fleeing) p.emotionTo = -1;
      p.emotion += (p.emotionTo - p.emotion)*Math.min(1, dt*5);
      // their eyes: the look their traits give them (from their mood, say), brighter or sadder as their expression swings
      // above or below where it rests, and wide with shock when frightened
      const { happy, sad, angry, shock } = p.traits, swing = p.emotion - p.traits.mood, shocked = frozen || fleeing;
      const eyesTo = [shocked ? 1 : shock, shocked ? 0 : happy + Math.max(0, swing)*0.8, p.attack ? 1 : angry, sad + Math.max(0, -swing)*0.8];
      for (let k=0;k<4;k++) p.eyes[k] += (Math.min(1, eyesTo[k]) - p.eyes[k])*Math.min(1, dt*6);
      const o = i*4, a = personModel.anim.array, lookArray = personModel.look.array;
      a[o] = clipRow(p, p.clipA);
      a[o+1] = p.clipB === p.clipA ? a[o] : p.rowB;
      a[o+2] = p.fade;
      a[o+3] = p.blinkAge < BLINK_DURATION ? Math.sin(Math.PI*p.blinkAge/BLINK_DURATION) : 0;
      lookArray[o] = p.lookTurn; lookArray[o+1] = p.lookTilt; lookArray[o+2] = p.talk; lookArray[o+3] = p.emotion;
      const eyesArray = personModel.eyes.array;
      for (let k=0;k<4;k++) eyesArray[o + k] = p.eyes[k];
      // their hairstyle's and facial hair's copies of where they are, how they're posed and which way they're looking
      personModel.headLayers.forEach(layer => {
        const style = layer.of[i] >= 0 ? layer.styles[layer.of[i]] : null;
        if (!style || !style.mesh) return;
        const slot = layer.slot[i];
        matrix.toArray(style.mesh.instanceMatrix.array, slot*16);
        for (let k=0;k<4;k++) { style.anim.array[slot*4 + k] = a[o + k]; style.look.array[slot*4 + k] = lookArray[o + k]; style.eyes.array[slot*4 + k] = eyesArray[o + k]; }
      });
    } else {
      if (p.moving) p.phase += dt*speed*Math.PI/S.peopleSize;
      const bob = p.moving ? Math.abs(Math.sin(p.phase))*0.08*S.peopleSize : 0;
      rotation.setFromAxisAngle(up, p.heading);
      if (isGone(p)) scale.set(0, 0, 0); else scale.set(0.5*S.peopleSize, 1.7*p.height*S.peopleSize, 0.34*S.peopleSize);
      matrix.compose(position.set(p.x, p.y + bob, p.z), rotation, scale);
      peopleMesh.setMatrixAt(i, matrix);
    }
    if (S.showRoadsafetyDebug) {
      const dead = isGone(p), radius = dead ? 0 : ROADSAFETY_RADIUS*p.traits.roadsafety;
      const half = p.crossStage === 'mid' && p.jc && !p.jc.junction;
      rotation.identity();
      scale.setScalar(half ? 0 : radius);
      matrix.compose(position.set(p.x, p.y + 0.9, p.z), rotation, scale);
      roadsafetyDebugMesh.setMatrixAt(i, matrix);
      const across = half && p.jc.route[p.jc.i];
      rotation.setFromAxisAngle(up, across ? Math.atan2(across.x - p.x, across.z - p.z) : 0);
      scale.setScalar(half ? radius : 0);
      matrix.compose(position, rotation, scale);
      roadsafetyHalfDebugMesh.setMatrixAt(i, matrix);
      rotation.setFromAxisAngle(up, p.heading);
      scale.set(dead ? 0 : 0.5*S.peopleSize, dead ? 0 : 1.7*p.height*S.peopleSize, dead ? 0 : 0.34*S.peopleSize);
      matrix.compose(position.set(p.x, p.y, p.z), rotation, scale);
      pedHitboxDebugMesh.setMatrixAt(i, matrix);
    }
  });

  if (personModel) {
    [personModel, ...personModel.hair].forEach(part => { part.mesh.instanceMatrix.needsUpdate = true; part.anim.needsUpdate = true; part.look.needsUpdate = true; part.eyes.needsUpdate = true; });
  } else {
    peopleMesh.instanceMatrix.needsUpdate = true;
  }
  if (S.showRoadsafetyDebug) {
    roadsafetyDebugMesh.instanceMatrix.needsUpdate = true;
    roadsafetyHalfDebugMesh.instanceMatrix.needsUpdate = true;
    pedHitboxDebugMesh.instanceMatrix.needsUpdate = true;
  }
  showPassengers();
  showInhabitants();
  // the camera onto whoever it's following, at about their shoulders — or, while they're indoors, onto the building
  const inside = followed >= 0 && isGone(people[followed]) && people[followed].indoors?.building;
  if (inside) controls.goalTarget.set(inside.x, inside.y + inside.height*0.5, inside.z);
  else if (followed >= 0) { const p = people[followed]; controls.goalTarget.set(p.x, p.y + personHeight(p)*0.8, p.z); }
  // and the card's headshot of them (kept as it was while they can't be seen)
  if (followed >= 0 && personModel && !isGone(people[followed])) App.drawPersonHeadshot(headshotOf(followed));
  // or, possessing them, the view from their eyes
  if (possession.index >= 0 && possession.index === followed && people[followed].mode === 'possessed') placePossessedCamera(followed);
}

// (people and groups too, for poking at from the browser console)
Object.assign(App, { syncPeopleUI, pickPerson, followPersonAt, stopFollowingPerson, possessPerson, unpossessPerson, killPerson, people, peopleGroups: groups });
