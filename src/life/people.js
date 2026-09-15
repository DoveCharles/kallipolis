import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { S, App } from '../core/shared.js';
import { scene, camera, Y_PARK, Y_PATH, Y_ROAD, Y_SIDEWALK } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { mulberry32 } from '../core/math.js';
import { closestPointOnSegment } from '../buildings/footprints.js';
import { tessellateOpenPath, tessellateClosedPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CLIPPER_SCALE, roadLineWidths, clipPolygons } from '../roads/roads.js';
import { isPathLine, isRiverLine } from '../roads/paths.js';
import { isTrainLine } from '../trains/trains.js';
import { Y_PLAZA } from '../zones/plazas.js';
import { getWaterRegion } from '../water/water.js';
import { toClipperPath, pathsArea, offsetPaths, createRegionTester, zoneCutoutsNear } from '../zones/cutouts.js';
import { FOOTBRIDGE_TOP } from '../water/bridges.js';

// ============================================================ people
// Lil people: tiny cuboids in random colors, all drawn as one instanced mesh. Most walk the walkways — the sidewalks either
// side of sidewalk roads, and paths — carrying on through junctions or turning off, and turning back at dead ends. They
// gather in plazas and parks: someone walking past one sometimes wanders in, drifts from spot to spot (often over to
// someone already there), stands around for a while, and eventually heads back out to the nearest walkway. The walkways
// are worked out again whenever the roads or zones change, and anyone whose walkway moved is set back on the nearest one.
const PEOPLE_MAX = 2000;
const PERSON_WALK_SPEED = 1.4;   // world units per second at speed 1
export const PEOPLE_NAV_SPACING = 4;    // walkways are resampled to a point at least this often, for entrances and re-seating
S.peopleEnabled = false, S.peopleAmount = 300, S.peopleSpeed = 1, S.peopleSize = 1;
let peopleNav = null, peopleNavBuiltAt = -Infinity, lastPeopleTime = null;
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

// The people model (assets/models/Person.glb, made in Blender) replaces the cuboids once it's loaded: a rigged figure with a
// Walk and an Idle animation, drawn — everyone at once — as one instanced mesh, flat-shaded. three.js's own rigged meshes
// can't be instanced, so the animations are baked: when the model loads, each one is played through a frame at a time and
// every bone's pose at each frame is written into a texture (a row per frame, three texels per bone), and the vertex shader
// poses each person by looking up the rows for the moment they're at in each animation — the texture blending between
// frames, and the shader between walking and standing idle. What makes each person themselves is kept in textures too, a
// texel per person, as there aren't enough vertex attributes to go round: their body shape keys, their sex (a man's
// eyelashes and lips aren't drawn) and the colors of their top, pants, shoes and hair. Their skin is always the model's
// yellow. Only what they're doing changes from frame to frame: their animation — how far through the walk and the idle
// they are, how much they're walking, how far their eyes are closed — in the instanceAnim attribute, and which way they've
// turned their head, in instanceLook.
// Hairstyles (assets/models/Hair.glb, each its own mesh, placed on the model's head) ride on the head bone. Each style is an
// instanced mesh of its own, holding just the people with that style, who carry a copy of their pose and their index into
// the traits texture.
const PERSON_MODEL_URL = 'assets/models/Person.glb';
const HAIR_MODEL_URL = 'assets/models/Hair.glb';
const PERSON_BAKE_FPS = 24;
// how far a person walks for each cycle of the walk animation, in the distances the model's foot travels in one — the higher,
// the slower the walk plays for the same speed
const WALK_CYCLE_LENGTH = 4;
// every shape key the shader applies, in the order of the shape key texture; the body's are set once per person, Blink as
// they blink
const PERSON_SHAPE_KEYS = ['Breast', 'Waist', 'Hips', 'Weight', 'Butt', 'Blink'];
const PERSON_BODY_KEY_COUNT = 5;
// each person's shape keys by sex, as [lowest, highest]
const PERSON_BODY_SHAPES = {
  male:   { Breast: [0.6, 1],  Waist: [0.5, 1],    Hips: [-1, -0.5],   Weight: [0, 1],   Butt: [1, 1] },
  female: { Breast: [-1, 0.1], Waist: [-0.5, 0.1], Hips: [-0.4, 0.2], Weight: [0, 0.3], Butt: [0, 0.6] },
};
// the model's materials, by name: which part of the model each vertex belongs to (its personSlot) — the clothes take each
// person's own colors, the rest keep the model's; and the parts only drawn for women
const PERSON_SLOTS = ['Skin', 'Top', 'Pants', 'Shoes', 'White', 'Black', 'Eyelashes', 'Lips'];
const PERSON_FEMALE_ONLY = ['Eyelashes', 'Lips'];
// the colors each person has their own of, from row 2 of the traits texture on
const PERSON_TRAIT_COLORS = ['Top', 'Pants', 'Shoes', 'Hair'];
// the hairstyles a man can have (or none); a woman can have any of them
const MEN_HAIRSTYLES = ['GHair20', 'GHair14', 'GHair12', 'GHair9', 'GHair8', 'GHair21'];
const PANTS_COLORS = [0x26344f, 0x3e5a82, 0x5a7aa6, 0x232326, 0x4d5057, 0x8f8f93, 0xb09a72, 0x6b5038, 0x46503a];
const SHOE_COLORS = [0x151517, 0x2b2b2f, 0xeeeeea, 0x8f9298, 0x6b4a2f, 0x3b2a1e, 0x22304a, 0xb5a383];
const HAIR_TONES = [0x0f0d0c, 0x2a1d15, 0x4a3223, 0x6f4e33, 0x8a4f2a, 0xa0692f, 0xc49a5a, 0xdcc08a, 0xb9b5ad, 0xe3ddd2]; // black to platinum
const BLINK_DURATION = 0.5; // seconds for the eyes to close and open again
// how far a person turns their head when they glance around: side to side, and up and down
const LOOK_MAX_TURN = 50*Math.PI/180, LOOK_MAX_TILT = 15*Math.PI/180;
let personModel = null; // { mesh, anim, look, hair, hairOf, hairSlot, isMan, height, minY, walk, idle, stride } once loaded

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
  attribute float personSlot;
  attribute float personMorphMask;
  attribute float personHeadWeight;
  attribute vec4 instanceAnim;
  attribute vec2 instanceLook;
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
  // instanceAnim: x the row they're at in the walk, y the row they're at in the idle, z how much they're walking (0 standing
  // idle, 1 walking), w how far their eyes are closed
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
  // a posed position with the head turned — everything moving with the head bone or the bones under it (personHeadWeight),
  // about where the head meets the neck — by instanceLook: x side to side, y up and down
  vec3 personLook(vec3 posed) {
    vec3 looked = posed;
    if (personHeadWeight > 0.0 && (instanceLook.x != 0.0 || instanceLook.y != 0.0)) {
      vec3 pivot = (personBone(personHeadBone)*vec4(personHeadPivot, 1.0)).xyz, p = posed - pivot;
      float ct = cos(instanceLook.x), st = sin(instanceLook.x), cn = cos(instanceLook.y), sn = sin(instanceLook.y);
      p = vec3(p.x, p.y*cn - p.z*sn, p.y*sn + p.z*cn);
      p = vec3(p.x*ct + p.z*st, p.y, p.z*ct - p.x*st);
      looked = mix(posed, pivot + p, personHeadWeight);
    }
    return looked;
  }
  // this person's row of the traits texture: 0 their first four body shape keys, 1 x their fifth and y whether they're a man,
  // then the colors they have their own of
  vec4 personTrait(int row) { return texelFetch(personTraits, ivec2(personIndex(), row), 0); }
  // a shape key's offset at this vertex
  vec3 personMorph(int key) {
    int width = int(personMorphsWidth);
    return texelFetch(personMorphs, ivec2(gl_VertexID % width, gl_VertexID/width + key*int(personMorphsRows)), 0).xyz;
  }
  // every shape key's offset at this vertex, each as far on as this person has it; personMorphMask says which keys move the
  // vertex at all — 1 the body's, 2 Blink
  vec3 personShape() {
    int mask = int(personMorphMask + 0.5);
    vec3 offset = vec3(0.0);
    if ((mask & 1) != 0) {
      vec4 body = personTrait(0);
      offset += personMorph(0)*body.x + personMorph(1)*body.y + personMorph(2)*body.z + personMorph(3)*body.w + personMorph(4)*personTrait(1).x;
    }
    if ((mask & 2) != 0) offset += personMorph(5)*instanceAnim.w;
    return offset;
  }
`;
// Adds the posing and shape keys to a material's shaders, and how it colors the figure. `look`: `femaleOnly`, the slots only
// drawn for women; and, unless it's the shadow's depth material, `palette` (each slot's own color) and `traitColors` (the
// slots taking a color of the person's own instead, as { slot: traits row }).
function injectPersonShader(shader, uniforms, look) {
  Object.assign(shader.uniforms, uniforms);
  const colored = !!look.palette;
  if (colored) shader.uniforms.personPalette = { value: look.palette };
  const hide = look.femaleOnly.length
    ? `if ((${look.femaleOnly.map(slot => `personSlotIndex == ${slot}`).join(' || ')}) && personTrait(1).y > 0.5) transformed = vec3(0.0);` : '';
  const color = colored
    ? 'vPersonColor = ' + Object.entries(look.traitColors).map(([slot, row]) => `personSlotIndex == ${slot} ? personTrait(${row}).rgb : `).join('') + 'personPalette[personSlotIndex];' : '';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + PERSON_VERTEX_PARS
      + (colored ? `uniform vec3 personPalette[${look.palette.length}];\nvarying vec3 vPersonColor;` : ''))
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed = personLook((personSkinMatrix()*vec4(transformed + personShape(), 1.0)).xyz);
      int personSlotIndex = int(personSlot + 0.5);
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
  const key = ['person', byAttribute, look.palette.length, JSON.stringify(look.traitColors), look.femaleOnly.join(',')].join('|');
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
  const [body, hair] = await Promise.allSettled([loadGLB(PERSON_MODEL_URL), loadGLB(HAIR_MODEL_URL)]);
  if (body.status === 'rejected') { console.warn('Blockout: the people model failed to load; people stay cuboids', body.reason); return; }
  if (hair.status === 'rejected') console.warn('Blockout: the hair model failed to load; people go without', hair.reason);
  try {
    personModel = buildPersonModel(body.value, hair.status === 'fulfilled' ? hair.value : null);
    peopleMesh.visible = false;
  } catch (err) {
    console.warn('Blockout: the people model failed to load; people stay cuboids', err);
  }
}

// The instanced meshes, and their textures, from the loaded models.
function buildPersonModel(gltf, hairGltf) {
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
  geometry.setAttribute('personHeadWeight', new THREE.Float32BufferAttribute(headWeights, 1));
  geometry.setAttribute('personSlot', new THREE.Float32BufferAttribute(slots, 1));
  geometry.computeVertexNormals(); // (flat shading works its normals out per pixel; these are only for the shadows)
  geometry.computeBoundingBox();

  // ---- the shape key texture: a block of rows per shape key, a texel per vertex, holding its offsets
  const morphWidth = Math.min(vertexCount, 1024), morphRows = Math.ceil(vertexCount/morphWidth);
  const morphData = new Float32Array(morphWidth*morphRows*PERSON_SHAPE_KEYS.length*4);
  const morphMask = new Float32Array(vertexCount);
  PERSON_SHAPE_KEYS.forEach((key, k) => {
    const keyOffsets = offsets[k], bit = k < PERSON_BODY_KEY_COUNT ? 1 : 2;
    for (let i=0;i<vertexCount;i++) {
      const texel = (k*morphRows*morphWidth + i)*4;
      for (let c=0;c<3;c++) morphData[texel + c] = keyOffsets[i*3 + c];
      if (Math.abs(keyOffsets[i*3]) + Math.abs(keyOffsets[i*3+1]) + Math.abs(keyOffsets[i*3+2]) > 1e-6) morphMask[i] = morphMask[i] | bit;
    }
  });
  geometry.setAttribute('personMorphMask', new THREE.BufferAttribute(morphMask, 1));
  const morphTexture = new THREE.DataTexture(morphData, morphWidth, morphRows*PERSON_SHAPE_KEYS.length, THREE.RGBAFormat, THREE.FloatType);
  morphTexture.needsUpdate = true;

  // ---- the bone texture: each animation's frames, then its first frame again, so that blending past its last frame loops
  // back smoothly. A missing animation is the rest pose, as a single frame.
  const mixer = new THREE.AnimationMixer(root);
  const clips = ['Walk', 'Idle'].map(name => {
    const clip = gltf.animations.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!clip) console.warn(`Blockout: the people model has no ${name} animation`);
    return { clip, frames: clip ? Math.max(1, Math.round(clip.duration*PERSON_BAKE_FPS)) : 1 };
  });
  let boneRows = 0;
  clips.forEach(c => { c.start = boneRows; boneRows += c.frames + 1; });
  const boneWidth = bones.length*3, boneData = new Float32Array(boneWidth*boneRows*4), pose = new THREE.Matrix4();
  // how far a foot travels over the walk, for how far a cycle of it carries a person
  const footBone = bones[boneByName.get('FootL') ?? boneByName.get('FootR') ?? 0], footPosition = new THREE.Vector3();
  let footMinZ = Infinity, footMaxZ = -Infinity;
  clips.forEach((c, clipIndex) => {
    mixer.stopAllAction();
    const action = c.clip ? mixer.clipAction(c.clip).play() : null;
    for (let f=0;f<=c.frames;f++) {
      if (action) mixer.setTime((f % c.frames)/PERSON_BAKE_FPS); else skeleton.pose();
      root.updateMatrixWorld(true);
      bones.forEach((bone, b) => {
        const e = pose.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[b]).elements;
        for (let r=0;r<3;r++) {
          const o = ((c.start + f)*boneWidth + b*3 + r)*4;
          boneData[o] = e[r]; boneData[o+1] = e[4+r]; boneData[o+2] = e[8+r]; boneData[o+3] = e[12+r];
        }
      });
      if (clipIndex === 0 && action) { footBone.getWorldPosition(footPosition); footMinZ = Math.min(footMinZ, footPosition.z); footMaxZ = Math.max(footMaxZ, footPosition.z); }
    }
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  // half floats, which (unlike full floats, everywhere) the texture can blend between rows
  const boneTexture = new THREE.DataTexture(Uint16Array.from(boneData, x => THREE.DataUtils.toHalfFloat(x)), boneWidth, boneRows, THREE.RGBAFormat, THREE.HalfFloatType);
  boneTexture.magFilter = boneTexture.minFilter = THREE.LinearFilter;
  boneTexture.needsUpdate = true;

  // ---- the hairstyles, in the model's space, each riding on the head bone. The biggest part of each is the hair itself,
  // taking the person's hair color; anything else on it (a hair band) keeps its own color.
  const hairStyles = [], hairSlots = ['Hair'], hairPalette = [new THREE.Color(0xffffff)];
  if (hairGltf && headBone != null) {
    hairGltf.scene.updateMatrixWorld(true);
    hairGltf.scene.children.forEach(style => {
      const parts = [];
      style.traverse(o => { if (o.isMesh) parts.push(o); });
      if (!parts.length) return;
      const hair = parts.reduce((a, b) => b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a);
      const stylePositions = [], styleSlots = [], styleIndices = [];
      parts.forEach(part => {
        let slot = 0;
        if (part !== hair) {
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
      styleGeometry.setAttribute('personHeadWeight', new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1));
      styleGeometry.setAttribute('personSlot', new THREE.Float32BufferAttribute(styleSlots, 1));
      styleGeometry.setAttribute('personMorphMask', new THREE.BufferAttribute(new Float32Array(count), 1));
      styleGeometry.computeVertexNormals();
      hairStyles.push({ name: style.name, geometry: styleGeometry, mesh: null, anim: null, look: null, members: [] });
    });
    hairGltf.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
  const menStyles = hairStyles.map((style, k) => MEN_HAIRSTYLES.includes(style.name) ? k : -1).filter(k => k >= 0);

  // ---- each person's traits: their sex, their body's shape keys (as far on as the ranges for their sex allow), their
  // hairstyle (any for a woman; for a man one of his, or none) and their colors
  const traitRows = 2 + PERSON_TRAIT_COLORS.length, traits = new Float32Array(PEOPLE_MAX*traitRows*4);
  const isMan = new Uint8Array(PEOPLE_MAX), hairOf = new Int16Array(PEOPLE_MAX).fill(-1), hairSlot = new Int32Array(PEOPLE_MAX);
  const traitRng = mulberry32(777), colorRng = mulberry32(4242), hairRng = mulberry32(31337), color = new THREE.Color();
  const colorFor = {
    Top: () => colorRng() < 0.22 ? color.setHSL(0, 0, [0.1, 0.3, 0.55, 0.88][Math.floor(colorRng()*4)]) : color.setHSL(colorRng(), 0.35 + colorRng()*0.45, 0.35 + colorRng()*0.3),
    Pants: () => colorRng() < 0.8 ? color.set(PANTS_COLORS[Math.floor(colorRng()*PANTS_COLORS.length)]) : color.setHSL(colorRng(), 0.25 + colorRng()*0.3, 0.25 + colorRng()*0.25),
    Shoes: () => colorRng() < 0.7 ? color.set(SHOE_COLORS[Math.floor(colorRng()*SHOE_COLORS.length)]) : color.setHSL(colorRng(), 0.4 + colorRng()*0.45, 0.35 + colorRng()*0.25),
    // three in four have a natural hair color; the rest have dyed it something bright
    Hair: () => colorRng() < 0.75 ? color.set(HAIR_TONES[Math.floor(colorRng()*HAIR_TONES.length)]).multiplyScalar(0.9 + colorRng()*0.2) : color.setHSL(colorRng(), 0.65 + colorRng()*0.3, 0.45 + colorRng()*0.15),
  };
  for (let i=0;i<PEOPLE_MAX;i++) {
    const texel = row => (row*PEOPLE_MAX + i)*4;
    const man = traitRng() < 0.5, ranges = man ? PERSON_BODY_SHAPES.male : PERSON_BODY_SHAPES.female;
    isMan[i] = man ? 1 : 0;
    const shape = PERSON_SHAPE_KEYS.slice(0, PERSON_BODY_KEY_COUNT).map(key => { const [lo, hi] = ranges[key]; return lo + traitRng()*(hi - lo); });
    traits.set(shape.slice(0, 4), texel(0));
    traits.set([shape[4], man ? 1 : 0], texel(1));
    PERSON_TRAIT_COLORS.forEach((part, k) => { colorFor[part](); traits.set([color.r, color.g, color.b], texel(2 + k)); });
    if (hairStyles.length) {
      const pick = Math.floor(hairRng()*(man ? menStyles.length + 1 : hairStyles.length));
      hairOf[i] = man ? (pick < menStyles.length ? menStyles[pick] : -1) : pick;
    }
    if (hairOf[i] >= 0) { const members = hairStyles[hairOf[i]].members; hairSlot[i] = members.length; members.push(i); }
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
  };
  const anim = dynamicInstanceAttribute(PEOPLE_MAX, 4), look = dynamicInstanceAttribute(PEOPLE_MAX, 2);
  geometry.setAttribute('instanceAnim', anim);
  geometry.setAttribute('instanceLook', look);
  const mesh = makePersonMesh(geometry, uniforms, bodyLook, PEOPLE_MAX, false);
  const hairLook = { palette: hairPalette, traitColors: { 0: traitRow('Hair') }, femaleOnly: [] };
  hairStyles.forEach(style => {
    if (!style.members.length) { style.geometry.dispose(); return; }
    style.geometry.setAttribute('instancePerson', new THREE.InstancedBufferAttribute(Float32Array.from(style.members), 1));
    style.anim = dynamicInstanceAttribute(style.members.length, 4);
    style.look = dynamicInstanceAttribute(style.members.length, 2);
    style.geometry.setAttribute('instanceAnim', style.anim);
    style.geometry.setAttribute('instanceLook', style.look);
    style.mesh = makePersonMesh(style.geometry, uniforms, hairLook, style.members.length, true);
  });
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });

  const box = geometry.boundingBox;
  const footTravel = footMaxZ > footMinZ ? footMaxZ - footMinZ : (box.max.y - box.min.y)*0.3;
  // the model faces along +Z, as people do
  return { mesh, anim, look, hair: hairStyles.filter(style => style.mesh), hairOf, hairSlot, hairStyles, isMan,
    height: box.max.y - box.min.y, minY: box.min.y, walk: clips[0], idle: clips[1], stride: footTravel*WALK_CYCLE_LENGTH };
}

export function syncPeopleUI() {
  document.getElementById('s-people').classList.toggle('on', S.peopleEnabled);
  document.getElementById('people-settings').style.display = S.peopleEnabled ? 'block' : 'none';
  document.getElementById('s-peopleamount').value = S.peopleAmount;
  document.getElementById('dv-peopleamount').textContent = Math.round(S.peopleAmount);
  document.getElementById('s-peoplespeed').value = S.peopleSpeed;
  document.getElementById('dv-peoplespeed').textContent = S.peopleSpeed.toFixed(1);
  document.getElementById('s-peoplesize').value = S.peopleSize;
  document.getElementById('dv-peoplesize').textContent = S.peopleSize.toFixed(1);
  document.getElementById('s-traffic').value = S.trafficAmount;
  document.getElementById('dv-traffic').textContent = Math.round(S.trafficAmount);
}

// The walkways ({ pts, cum, lateral, jitter, y… } per road or path line, with each point's junction links and park or
// plaza entrance) and the hangouts ({ inside, bounds, y, exits } per plaza and park).
function buildPeopleNav() {
  const areas = [], lines = [];
  S.zones.forEach(zone => {
    if (zone.drawing || zone.points.length < 3 || (zone.zoneType !== 'plaza' && zone.zoneType !== 'park')) return;
    const poly = tessellateClosedPath(zone.points);
    const paths = offsetPaths(clipPolygons(ClipperLib.ClipType.ctDifference, [toClipperPath(poly)], zoneCutoutsNear(zone, poly)), -1.2, ClipperLib.JoinType.jtMiter);
    const size = pathsArea(paths);
    if (size < 20) return;
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    paths.forEach(path => path.forEach(p => { minX=Math.min(minX,p.X); maxX=Math.max(maxX,p.X); minZ=Math.min(minZ,p.Y); maxZ=Math.max(maxZ,p.Y); }));
    const inArea = createRegionTester(paths), fountain = zone.zoneType==='plaza' ? zone.fountainSpot : null;
    const inside = fountain ? (x, z) => inArea(x, z) && Math.hypot(x - fountain.x, z - fountain.z) > fountain.r + 0.8 : inArea;
    areas.push({ inside, fountain, minX: minX/CLIPPER_SCALE, maxX: maxX/CLIPPER_SCALE, minZ: minZ/CLIPPER_SCALE, maxZ: maxZ/CLIPPER_SCALE,
      size, y: zone.zoneType==='plaza' ? Y_PLAZA : Y_PARK, exits: [] });
  });
  const inWater = createRegionTester(getWaterRegion());
  S.roadLines.forEach(line => {
    if (isTrainLine(line) || isRiverLine(line)) return;
    const nodes = tessellateOpenPath(line.nodeIds.map(id => roadNodes[id]).filter(Boolean));
    if (nodes.length < 2) return;
    const pts = [nodes[0]];
    for (let i=1;i<nodes.length;i++) {
      const a = nodes[i-1], b = nodes[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.z-a.z)/PEOPLE_NAV_SPACING));
      for (let k=1;k<=steps;k++) pts.push(k === steps ? b : { x: a.x + (b.x-a.x)*k/steps, z: a.z + (b.z-a.z)*k/steps });
    }
    const cum = [0];
    for (let i=1;i<pts.length;i++) cum.push(cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
    if (cum[cum.length-1] < 1) return;
    const path = isPathLine(line), { hw, cw, sw } = roadLineWidths(line);
    lines.push({ pts, cum, total: cum[cum.length-1], path,
      y: path ? Y_PATH : (cw + sw > 0 ? Y_SIDEWALK : Y_ROAD),
      lateral: path ? hw*0.55 : hw + cw + sw*0.5, jitter: path ? 0 : Math.min(sw*0.3, 0.8),
      overWater: path ? pts.map(p => inWater(p.x, p.z)) : null,
      vertices: pts.map(() => ({ links: [], entrances: [] })) });
  });
  // junctions: points of different lines in the same place
  const byPlace = new Map();
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    const key = Math.round(p.x*2) + ',' + Math.round(p.z*2);
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push({ li, vi });
  }));
  byPlace.forEach(list => { if (list.length > 1) list.forEach(a => { lines[a.li].vertices[a.vi].links = list.filter(b => b.li !== a.li); }); });
  // entrances: points beside (or, for a path, in) a plaza or park; and a grid of every point, for finding the nearest
  const grid = new Map(), CELL = 16;
  lines.forEach((nav, li) => nav.pts.forEach((p, vi) => {
    const key = Math.floor(p.x/CELL) + ',' + Math.floor(p.z/CELL);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ li, vi });
    if (!areas.length) return;
    const a = nav.pts[Math.max(0, vi-1)], b = nav.pts[Math.min(nav.pts.length-1, vi+1)], len = Math.hypot(b.x-a.x, b.z-a.z) || 1;
    // look straight out from the walkway on each side (side is the sign of a walker's lateral offset), a few steps further
    // each time — a zone's edge can sit well back from the sidewalk — and, for a path, at the path itself (running through a
    // park). A road between a park and a plaza gets an entrance to each, one per side.
    const nx = -(b.z-a.z)/len, nz = (b.x-a.x)/len, edge = nav.lateral + nav.jitter;
    const areaAt = (x, z) => areas.findIndex(ar => x >= ar.minX && x <= ar.maxX && z >= ar.minZ && z <= ar.maxZ && ar.inside(x, z));
    const entrances = nav.vertices[vi].entrances;
    [1, -1].forEach(side => {
      const offsets = (nav.path ? [0] : []).concat([2, 5, 9, 14].map(extra => side*(edge + extra)));
      for (const off of offsets) {
        const x = p.x + nx*off, z = p.z + nz*off, area = areaAt(x, z);
        if (area >= 0) { entrances.push({ area, side, x, z }); if (!areas[area].exits.some(e => e.li === li && e.vi === vi)) areas[area].exits.push({ li, vi }); break; }
      }
    });
  }));
  return { areas, lines, grid, CELL };
}

function newPerson() {
  return { x:0, y:0, z:0, heading: peopleRng()*Math.PI*2, stride: 0.8 + peopleRng()*0.4, height: 0.85 + peopleRng()*0.27, phase: peopleRng()*10,
    mode: 'none', li: 0, u: 0, dir: 1, seg: 0, lat: 0, area: -1, tx: 0, tz: 0, wait: 0, exit: null, moving: false, stepped: 0,
    // the model's animation: how far through the walk (in whole cycles) and the idle (in seconds) they are, how much they're
    // walking rather than standing, the time to their next blink and since their last, and which way they're looking (their
    // head turned and tilted, the way it's turning to, and the time until they glance somewhere else)
    walkCycle: peopleRng(), idleTime: peopleRng()*10, walkBlend: 0, blinkIn: peopleRng()*6, blinkAge: BLINK_DURATION,
    lookTurn: 0, lookTilt: 0, lookTurnTo: 0, lookTiltTo: 0, lookIn: peopleRng()*4 };
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
// puts a person on walkway `li` at distance u along it, heading `dir`, on a random side
function joinWalkway(p, li, u, dir) {
  const nav = peopleNav.lines[li];
  p.mode = 'line'; p.li = li; p.dir = dir; p.u = Math.max(0, Math.min(nav.total, u));
  p.seg = 0;
  while (p.seg < nav.pts.length-2 && nav.cum[p.seg+1] <= p.u) p.seg++;
  p.lat = nav.path ? (peopleRng()-0.5)*2*nav.lateral : (peopleRng() < 0.5 ? -1 : 1)*(nav.lateral + (peopleRng()-0.5)*2*nav.jitter);
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
    const li = pickWeighted(lines, l => l.total);
    joinWalkway(p, li, peopleRng()*lines[li].total, peopleRng() < 0.5 ? -1 : 1);
    const at = walkwayPoint(p);
    p.x = at.x; p.y = at.y; p.z = at.z;
  } else {
    p.mode = 'none';
  }
}
// after the walkways are rebuilt: back into the hangout they're standing in, else onto the nearest walkway, else anywhere
function reseatPerson(p) {
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
    if (best) { joinWalkway(p, best.li, lines[best.li].cum[best.vi], p.dir || 1); return; }
  }
  spawnPerson(p);
}
// where a person on a walkway should be: the walkway's point at their distance along it, set off to their side
function walkwayPoint(p) {
  const nav = peopleNav.lines[p.li];
  const i = Math.max(0, Math.min(nav.pts.length-2, p.seg));
  const a = nav.pts[i], b = nav.pts[i+1], segLen = (nav.cum[i+1] - nav.cum[i]) || 1;
  const t = Math.max(0, Math.min(1, (p.u - nav.cum[i])/segLen));
  const dx = (b.x-a.x)/segLen, dz = (b.z-a.z)/segLen;
  const y = nav.path && nav.overWater[i] && nav.overWater[i+1] ? FOOTBRIDGE_TOP : nav.y;
  return { x: a.x + (b.x-a.x)*t - dz*p.lat, y, z: a.z + (b.z-a.z)*t + dx*p.lat };
}
// moves a person `dist` along their walkway, dealing with each point they pass: maybe wandering into a hangout, maybe
// turning off at a junction, and turning back at a dead end
function walkAlong(p, dist) {
  let nav = peopleNav.lines[p.li];
  let u = p.u + p.dir*dist;
  for (let guard=0; guard<64; guard++) {
    const ahead = p.dir > 0 ? p.seg + 1 : p.seg;
    const at = nav.cum[ahead];
    if (p.dir > 0 ? u < at : u > at) break;
    const vertex = nav.vertices[ahead], isEnd = ahead === 0 || ahead === nav.pts.length-1;
    // someone on a sidewalk only turns in on their own side of the road; on a path, either side will do
    const entrance = vertex.entrances.length ? vertex.entrances.find(e => e.side === Math.sign(p.lat)) || (nav.path ? vertex.entrances[0] : null) : null;
    if (entrance && peopleRng() < 0.12) { p.u = at; wanderInto(p, entrance.area, entrance); return; }
    if (vertex.links.length && peopleRng() < (isEnd ? 0.85 : 0.3)) {
      const link = vertex.links[Math.floor(peopleRng()*vertex.links.length)];
      const other = peopleNav.lines[link.li], remaining = Math.abs(u - at);
      const dir = link.vi === 0 ? 1 : link.vi === other.pts.length-1 ? -1 : (peopleRng() < 0.5 ? 1 : -1);
      joinWalkway(p, link.li, other.cum[link.vi], dir);
      p.seg = dir > 0 ? Math.min(link.vi, other.pts.length-2) : Math.max(link.vi-1, 0);
      nav = other;
      u = p.u + dir*remaining;
      continue;
    }
    if (isEnd) { p.dir = -p.dir; u = 2*at - u; continue; }
    p.seg += p.dir;
  }
  p.u = Math.max(0, Math.min(nav.total, u));
}
// how many of `sorted` (ascending) are below `limit`
function countBelow(sorted, limit) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < limit) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---- following someone with the camera: in World mode, clicking a person keeps the view centered on them as they go —
// orbiting and zooming as usual, and able to come in closer than the camera usually can — with a card saying who they are
// (person-card.js), until a click anywhere else, a pan, leaving World mode, or them leaving the crowd lets them go
let followed = -1; // their index in people
const personHeight = p => 1.7*p.height*S.peopleSize;
// the person under a point on the screen (the one nearest the camera, if several are), or -1: a point within about their
// width of the line up the middle of them, as they look on screen — or within a few pixels, for someone far off
function pickPerson(clientX, clientY) {
  if (!S.peopleEnabled) return -1;
  const width = window.innerWidth, height = window.innerHeight, foot = new THREE.Vector3(), head = new THREE.Vector3();
  let best = -1, bestDepth = Infinity;
  people.forEach((p, i) => {
    if (p.mode === 'none') return;
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
  followed = i;
  const h = personHeight(people[i]);
  controls.minRadius = Math.max(1.2, h*0.8);
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, h*9)); // swooping in, if the camera's far off
  App.showPersonCard(i, personModel ? personModel.isMan[i] === 1 : null);
}
function stopFollowingPerson() {
  if (followed < 0) return;
  followed = -1;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  App.hidePersonCard();
}

export function updatePeople(t) {
  const dt = lastPeopleTime == null ? 0 : Math.min(0.1, Math.max(0, t - lastPeopleTime));
  lastPeopleTime = t;
  if (followed >= 0 && (!S.peopleEnabled || S.interactionMode !== 'move')) stopFollowingPerson();
  peopleMesh.visible = S.peopleEnabled && !personModel;
  if (personModel) [personModel, ...personModel.hair].forEach(part => { part.mesh.visible = S.peopleEnabled; });
  if (!S.peopleEnabled) return;
  if (!peopleNav || (S.peopleNavDirty && t - peopleNavBuiltAt > 0.25)) {
    S.peopleNavDirty = false;
    peopleNavBuiltAt = t;
    peopleNav = buildPeopleNav();
    people.forEach(reseatPerson);
  }
  const wanted = Math.min(PEOPLE_MAX, Math.round(S.peopleAmount));
  while (people.length < wanted) { const p = newPerson(); spawnPerson(p); people.push(p); }
  if (people.length > wanted) people.length = wanted;
  if (followed >= people.length) stopFollowingPerson();
  peopleMesh.count = people.length;
  if (personModel) {
    personModel.mesh.count = people.length;
    personModel.hair.forEach(style => { style.mesh.count = countBelow(style.members, people.length); });
  }
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  people.forEach((p, i) => {
    if (p.mode === 'none' && (peopleNav.lines.length || peopleNav.areas.length)) spawnPerson(p);
    const speed = PERSON_WALK_SPEED*S.peopleSpeed*p.stride;
    let goal = null;
    if (p.mode === 'line') {
      walkAlong(p, speed*dt);
      if (p.mode === 'line') goal = walkwayPoint(p);
    }
    if (p.mode === 'wander') {
      const area = peopleNav.areas[p.area];
      if (p.wait > 0) {
        p.wait -= dt;
      } else if (Math.hypot(p.tx - p.x, p.tz - p.z) < 0.3) {
        p.wait = 1 + peopleRng()*7;
        const roll = peopleRng();
        if (area.exits.length && roll < 0.22) {
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
        } else if (roll < 0.6) {
          // over to someone else hanging out here
          let friend = null;
          for (let k=0;k<8 && !friend;k++) { const q = people[Math.floor(peopleRng()*people.length)]; if (q !== p && q.mode === 'wander' && q.area === p.area) friend = q; }
          const spot = friend ? { x: friend.tx + (peopleRng()-0.5)*3, z: friend.tz + (peopleRng()-0.5)*3 } : null;
          if (spot && area.inside(spot.x, spot.z)) { p.tx = spot.x; p.tz = spot.z; } else { const s = randomSpotIn(area, p); p.tx = s.x; p.tz = s.z; }
        } else {
          const s = randomSpotIn(area); p.tx = s.x; p.tz = s.z;
        }
      }
      if (p.mode === 'wander') goal = { x: p.tx, y: area.y, z: p.tz };
    }
    if (p.mode === 'leaving') {
      // already placed on their walkway by joinWalkway; once they've reached it they carry on along it
      goal = p.exit;
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
      const step = speed*dt*(p.mode === 'line' ? 1 + Math.min(2, d*0.5) : 1);
      if (d > 1e-4) {
        const k = Math.min(1, step/d), mx = dx*k, mz = dz*k;
        p.x += mx; p.z += mz;
        // which way they face, and whether they're walking, go by how far they actually moved this frame — someone
        // keeping pace with their walkway is always right on top of the point they're heading for
        if (Math.hypot(mx, mz) > speed*dt*0.25) {
          const facing = Math.atan2(mx, mz);
          p.heading += Math.atan2(Math.sin(facing - p.heading), Math.cos(facing - p.heading))*Math.min(1, dt*8);
          p.moving = true;
          p.stepped = Math.hypot(mx, mz);
        }
      }
      p.y += (goal.y - p.y)*Math.min(1, dt*6);
    }
    if (personModel) {
      // the model, scaled to the same height as a cuboid person
      const s = p.mode === 'none' ? 0 : 1.7*p.height*S.peopleSize/personModel.height;
      rotation.setFromAxisAngle(up, p.heading);
      matrix.compose(position.set(p.x, p.y - personModel.minY*s, p.z), rotation, scale.set(s, s, s));
      personModel.mesh.setMatrixAt(i, matrix);
      // a cycle of the walk for every stride's worth of ground covered, as big as they are, easing into the idle when they stop
      if (s > 0) p.walkCycle = (p.walkCycle + p.stepped/(personModel.stride*s)) % 1;
      p.idleTime += dt;
      p.walkBlend += ((p.moving ? 1 : 0) - p.walkBlend)*Math.min(1, dt*6);
      // a blink every few seconds, the eyes closing and opening again over BLINK_DURATION
      p.blinkIn -= dt;
      p.blinkAge += dt;
      if (p.blinkIn <= 0) { p.blinkAge = 0; p.blinkIn = BLINK_DURATION + 1.5 + peopleRng()*5; }
      // every so often a glance somewhere else — not so far while walking — or back ahead, the head easing round to it
      p.lookIn -= dt;
      if (p.lookIn <= 0) {
        p.lookIn = 1.5 + peopleRng()*4;
        const ahead = peopleRng() < 0.35, reach = p.moving ? 0.6 : 1;
        p.lookTurnTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TURN*reach;
        p.lookTiltTo = ahead ? 0 : (peopleRng()*2 - 1)*LOOK_MAX_TILT;
      }
      p.lookTurn += (p.lookTurnTo - p.lookTurn)*Math.min(1, dt*4);
      p.lookTilt += (p.lookTiltTo - p.lookTilt)*Math.min(1, dt*4);
      const { walk, idle } = personModel, o = i*4, a = personModel.anim.array, lookArray = personModel.look.array;
      a[o] = walk.start + p.walkCycle*walk.frames;
      a[o+1] = idle.start + (p.idleTime*PERSON_BAKE_FPS) % idle.frames;
      a[o+2] = p.walkBlend;
      a[o+3] = p.blinkAge < BLINK_DURATION ? Math.sin(Math.PI*p.blinkAge/BLINK_DURATION) : 0;
      lookArray[i*2] = p.lookTurn; lookArray[i*2+1] = p.lookTilt;
      // their hairstyle's copy of where they are, how they're posed and which way they're looking
      const style = personModel.hairOf[i] >= 0 ? personModel.hairStyles[personModel.hairOf[i]] : null;
      if (style && style.mesh) {
        const slot = personModel.hairSlot[i];
        matrix.toArray(style.mesh.instanceMatrix.array, slot*16);
        for (let k=0;k<4;k++) style.anim.array[slot*4 + k] = a[o + k];
        style.look.array[slot*2] = p.lookTurn; style.look.array[slot*2+1] = p.lookTilt;
      }
    } else {
      if (p.moving) p.phase += dt*speed*Math.PI/S.peopleSize;
      const bob = p.moving ? Math.abs(Math.sin(p.phase))*0.08*S.peopleSize : 0;
      rotation.setFromAxisAngle(up, p.heading);
      if (p.mode === 'none') scale.set(0, 0, 0); else scale.set(0.5*S.peopleSize, 1.7*p.height*S.peopleSize, 0.34*S.peopleSize);
      matrix.compose(position.set(p.x, p.y + bob, p.z), rotation, scale);
      peopleMesh.setMatrixAt(i, matrix);
    }
  });
  if (personModel) {
    [personModel, ...personModel.hair].forEach(part => { part.mesh.instanceMatrix.needsUpdate = true; part.anim.needsUpdate = true; part.look.needsUpdate = true; });
  } else {
    peopleMesh.instanceMatrix.needsUpdate = true;
  }
  // the camera onto whoever it's following, at about their shoulders
  if (followed >= 0) { const p = people[followed]; controls.goalTarget.set(p.x, p.y + personHeight(p)*0.8, p.z); }
}

Object.assign(App, { syncPeopleUI, pickPerson, followPersonAt, stopFollowingPerson });
