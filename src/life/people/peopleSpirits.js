import * as THREE from 'three';
import { scene } from '../../core/scene.js';

// One-colour copies of a person (face picked out), posed as they are and bobbing: the spirits trait's small one on each
// shoulder, posed as they are but idling where they walk (gold on their right, purple on their left, riding the chest bone), and the ghost trait's full-size blue one
// in place of their body (hidden in the person shader). The body's geometry again, one instanced mesh each, over a compact
// copy of the body's instances holding only those flagged by its SPIRITS_ROW bit (personSpectral; see compactOf in peopleModel.js).

// the SPIRITS_ROW bits (peopleModel.js)
export const SPECTRAL = { spirits: 1, ghost: 2, bodiless: 4, twins: 8 }; // (twins: see personTwin in peopleModel.js)
export const VANISHED_BIT = 32; // (a shy ghost gone for a while: nothing of them drawn — see shyGhost in people.js)
export const BALD_BIT = 16; // (bald = 1 under a hat: the hat's hair parts folded away — see stripBald in peopleModel.js)

const DEPTH_ORDER = 1000; // the see-through ones' depth twins draw at this, then they do (among the transparent, last)
const WORN_DARK = 0.7;   // hair and accessories' colour, × the spirit's
const SPIRIT_OUT = 3;         // how far out from the middle, × the shoulder bone's
const SPIRITS = [
  // face: the mood they wear, whatever the person's (FACES); scale × the person; bob × the model's height, rate radians a second; shoulder 1 left, -1 right (the model faces +Z: its left is +X)
  { bit: SPECTRAL.spirits, shoulder: -1, face: 'happy', scale: 0.18, bob: 0.03, rate: 2.4, phase: 0, color: 0xffc83d, opacity: 0.7, name: 'SpiritRight' },
  { bit: SPECTRAL.spirits, shoulder: 1, face: 'angry', scale: 0.18, bob: 0.03, rate: 2.4, phase: Math.PI, color: 0xa15cff, opacity: 0.7, name: 'SpiritLeft' },
  { bit: SPECTRAL.ghost, shoulder: 0, scale: 1, bob: 0.05, rate: 1.8, phase: 0, color: 0x8fd4ff, opacity: 0.45, name: 'Ghost' },
];
// instanceEyes (shock, happy, angry, sad) and the mouth's Emotion key (instanceLook.w)
const FACES = { happy: [[0, 1, 0, 0], 1, 'x'], angry: [[0, 0, 1, 0], -1, 'y'] }; // (and its mouth's talk: instanceSpirit's component)

/**
 * @param {object} o
 * @param {string} o.vertexPars - PERSON_VERTEX_PARS
 * @param {Object<string, {value: *}>} o.uniforms - the person uniforms
 * @param {THREE.BufferGeometry} o.geometry - the body's geometry (with its instance attributes)
 * @param {THREE.InstancedMesh} o.body - the body mesh
 * @param {function(THREE.InstancedMesh, number, ...THREE.InstancedMesh): {geometry: THREE.BufferGeometry, matrix: THREE.InstancedBufferAttribute}} o.compact -
 *   a mesh's instances with a SPECTRAL bit, drawn by the meshes given
 * @param {THREE.Vector3} o.shoulder - the left shoulder at rest
 * @param {number} o.animRow - traits row of a spirit's own pose (SPIRIT_ANIM_ROW: the person's, the Idle loop where they walk)
 * @param {{white: number, dark: number[], lashes: number[], femaleOnly: number[], lashRow: number}} o.slots - the eye whites' slot, the face's drawn dark,
 *   and (as the body hides them: injectPersonShader) the lashes they've not got (lashRow's .w bits) and the parts a man hasn't
 * @param {number} o.headshotLayer - the headshot camera's layer
 * @returns {THREE.InstancedMesh[]} right spirit, left spirit, ghost
 */
export function makeSpiritMeshes(o) {
  return SPIRITS.map(spec => spiritMesh(spec, o, o.body, false));
}

/**
 * The spirits' and ghost's hair and accessories (the worn layers but clothes), a little darker; call once the styles' meshes are made.
 * @param {object} o - as makeSpiritMeshes
 * @param {object[]} styles - the worn styles with meshes (instancePerson on their geometry)
 * @returns {THREE.InstancedMesh[]}
 */
export function makeSpiritWorn(o, styles) {
  return SPIRITS.flatMap(spec => styles.map(style => {
    return spiritMesh(spec, o, style.mesh, true);
  }));
}

// One spirit's (or the ghost's) mesh over `source`'s compact copy (o.compact); `dressed` for a worn layer.
function spiritMesh({ bit, shoulder: side, face, scale, bob, rate, phase, color, opacity, name }, { vertexPars, uniforms, geometry: bodyGeometry, shoulder, slots, headshotLayer, fadeRow, animRow, compact }, source, dressed) {
  const box = bodyGeometry.boundingBox, tall = box.max.y - box.min.y;
  // (a spirit sits on the shoulder, feet first; the ghost stands where they do)
  const place = side
    ? `vec3 at = (chest*vec4(${(side*shoulder.x*SPIRIT_OUT).toFixed(4)}, ${shoulder.y.toFixed(4)}, ${shoulder.z.toFixed(4)}, 1.0)).xyz
            + mat3(chest)*((posed - vec3(0.0, ${box.min.y.toFixed(4)}, 0.0))*${scale.toFixed(3)} + vec3(0.0, lift, 0.0));`
    : 'vec3 at = posed + vec3(0.0, lift, 0.0);';
  let pars = face ? worn(vertexPars, ...FACES[face], dressed) : vertexPars;
  if (side) pars = posedOwn(pars);
  const params = {
    uniforms: { ...uniforms, spiritColor: { value: new THREE.Color(color).multiplyScalar(dressed ? WORN_DARK : 1) }, spiritClock: uniforms.personTime },
    side: THREE.DoubleSide, transparent: opacity < 1, depthWrite: opacity >= 1,
    defines: { PERSON_INDEX_ATTRIBUTE: '' },
    vertexShader: `${pars}
        varying float vSpiritShade;
        varying float vSpiritFade; // (a shy ghost fading out or in: see shyGhost in people.js)
        void main() {
          vSpiritFade = texelFetch(personTraits, ivec2(personIndex(), ${fadeRow}), 0).w;
          if ((personSpectral() & ${bit}) == 0 || (personSpectral() & ${VANISHED_BIT}) != 0 || personIndex() == personHidden || (personOnly >= 0 && personIndex() != personOnly)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          ${side ? `// (riding their chest as it's posed; posed itself as they are, but idling where they walk: animRow)
          spiritAnimNow = spiritRawAnim();
          mat4 chest = personBone(personChestBone);
          spiritAnimNow = vec4(texelFetch(personTraits, ivec2(personIndex(), ${animRow}), 0).xyz, spiritRawAnim().w);` : ''}
          vec3 posed = personBodiless(personLook((personSkinMatrix()*vec4(position + personShape(), 1.0)).xyz));
          int slot = int(personVertex.y + 0.5);
          ${dressed ? '' : `if (${[...slots.lashes.map((k, b) => `(slot == ${k} && (int(personTrait(${slots.lashRow}).w + 0.5) & ${1 << b}) == 0)`),
            ...slots.femaleOnly.map(k => `(slot == ${k} && personTrait(1).y > 0.5)`)].join(' || ') || 'false'}) posed = vec3(0.0);`}
          if (posed == vec3(0.0)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          float lift = ${(bob*tall).toFixed(4)}*personBob(${rate.toFixed(2)}, ${phase.toFixed(4)});
          ${place}
          // (the face picked out: eye whites lighter, pupils, lashes and lips dark)
          vSpiritShade = ${dressed ? '0.0' : `slot == ${slots.white} ? 1.0 : (${slots.dark.map(k => `slot == ${k}`).join(' || ')}) ? -1.0 : 0.0`};
          gl_Position = projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(at, 1.0);
        }`,
    fragmentShader: `
        uniform vec3 spiritColor;
        varying float vSpiritShade;
        varying float vSpiritFade;
        void main() {
          vec3 color = vSpiritShade > 0.5 ? mix(spiritColor, vec3(1.0), 0.7) : vSpiritShade < -0.5 ? spiritColor*0.15 : spiritColor;
          gl_FragColor = vec4(color, ${opacity.toFixed(2)}*(1.0 - vSpiritFade));
        }`,
  };
  const material = new THREE.ShaderMaterial(params);
  const { geometry: compacted, matrix } = compact(source, bit);
  const mesh = new THREE.InstancedMesh(compacted, material, matrix.count);
  mesh.instanceMatrix = matrix;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.layers.enable(headshotLayer);
  mesh.name = name + (dressed ? 'Worn' : '');
  // (see-through as a whole: a depth-only twin drawn first, so only the nearest surface is blended — overlapping parts
  // don't build up. Both after everything else, the opaque included, or it would hide what's behind it: DEPTH_ORDER)
  if (opacity < 1) {
    const depth = new THREE.InstancedMesh(compacted, new THREE.ShaderMaterial({ ...params, colorWrite: false, depthWrite: true }), matrix.count);
    depth.instanceMatrix = matrix;
    depth.frustumCulled = false;
    depth.renderOrder = DEPTH_ORDER; mesh.renderOrder = DEPTH_ORDER + 1;
    depth.layers.enable(headshotLayer);
    depth.name = mesh.name + 'Depth';
    mesh.add(depth); // (shown and hidden with it)
    compact(source, bit, depth);
  }
  compact(source, bit, mesh);
  scene.add(mesh);
  return mesh;
}

// the pars with their face fixed: eyes as given, the mouth's keys overridden — its own talking (peopleSpiritChat.js) and mood (the head's turn kept)
const worn = (pars, eyes, mouth, talk, dressed) => pars
  .replace('attribute vec4 instanceEyes;', `const vec4 instanceEyes = vec4(${eyes.map(n => n.toFixed(1)).join(', ')});`)
  .replace('attribute vec4 instanceLook;', `attribute vec4 instanceLook;
${dressed ? '' : 'attribute vec2 instanceSpirit;'}
#define instanceLook vec4(instanceLook.xy, ${dressed ? '0.0' : 'instanceSpirit.' + talk}, ${mouth.toFixed(1)})`);
// the pars with the pose its own to set (spiritAnimNow: see spiritMesh) — the person's for the chest it rides, its own
// row (people.js) for itself; spiritRawAnim the person's
const posedOwn = pars => pars
  .replace(/int personIndex\(\) \{ return gl_InstanceID; \}\s*#endif/, `int personIndex() { return gl_InstanceID; }
  #endif
vec4 spiritRawAnim() { return instanceAnim; }
vec4 spiritAnimNow;
#define instanceAnim spiritAnimNow`);
