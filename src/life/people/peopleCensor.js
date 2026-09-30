import * as THREE from 'three';
import { scene } from '../../core/scene.js';

// The nude trait's censor: a Sims-style mosaic rectangle over each nude person, from upper thigh to stomach (a man) or
// to below the shoulders (a woman). It turns about the body's own up (pelvis to chest, as posed) to face the camera, so it
// falls over with them. One instanced quad per slot, sharing the body mesh's matrices and pose attribute.

const CENSOR_WIDTH = 0.26;   // × the model's height
const CENSOR_NEAR = 0.12;    // how far towards the camera it's pushed, × the model's height (clear of the body)
const CENSOR_BLOCKS = 4;     // mosaic blocks across
const CENSOR_SHIMMER = 6;    // times a second the blocks' shades re-roll

/**
 * @param {object} o
 * @param {string} o.vertexPars - PERSON_VERTEX_PARS
 * @param {Object<string, {value: *}>} o.uniforms - the person uniforms
 * @param {THREE.InstancedBufferAttribute} o.anim - the body's instanceAnim
 * @param {THREE.InstancedMesh} o.body - the body mesh (its instanceMatrix is shared)
 * @param {number} o.nudeRow - traits row whose .w is 1 when nude
 * @param {number} o.skinRow - traits row of the skin colour
 * @param {{pelvis: number, chest: number, low: THREE.Vector3, highMan: THREE.Vector3, highWoman: THREE.Vector3, tall: number}} o.rest - bones and rest points
 * @param {number} o.headshotLayer - the headshot camera's layer
 * @returns {THREE.InstancedMesh}
 */
export function makeCensorMesh({ vertexPars, uniforms, anim, body, nudeRow, skinRow, rest, headshotLayer }) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('instanceAnim', anim);
  const own = {
    censorBones: { value: new THREE.Vector2(rest.pelvis, rest.chest) },
    censorLow: { value: rest.low }, censorHighMan: { value: rest.highMan }, censorHighWoman: { value: rest.highWoman },
    censorWidth: { value: CENSOR_WIDTH*rest.tall }, censorNear: { value: CENSOR_NEAR*rest.tall },
    censorTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...own },
    side: THREE.DoubleSide,
    vertexShader: `${vertexPars}
      uniform vec2 censorBones;
      uniform vec3 censorLow, censorHighMan, censorHighWoman;
      uniform float censorWidth, censorNear;
      varying vec2 vCensorBlock;
      varying vec3 vCensorSkin;
      varying float vCensorPerson;
      void main() {
        if (personTrait(${nudeRow}).w < 0.5 || (personOnly >= 0 && personIndex() != personOnly)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
        mat4 placed = modelMatrix*instanceMatrix;
        float scale = length(placed[0].xyz);
        if (scale < 1e-6) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
        vec3 high = personTrait(1).y > 0.5 ? censorHighMan : censorHighWoman;
        vec3 low = (placed*(personBone(censorBones.x)*vec4(censorLow, 1.0))).xyz;
        vec3 top = (placed*(personBone(censorBones.y)*vec4(high, 1.0))).xyz;
        vec3 up = top - low;
        float tall = length(up);
        up /= max(tall, 1e-6);
        vec3 middle = 0.5*(low + top);
        // (towards the camera: its position in perspective, back along its view when orthographic)
        vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        vec3 toCamera = projectionMatrix[2][3] == 0.0 ? back : cameraPosition - middle;
        vec3 side = cross(up, toCamera);
        if (dot(side, side) < 1e-8) side = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        side = normalize(side);
        vec3 facing = cross(side, up);
        vec3 world = middle + side*position.x*censorWidth*scale + up*position.y*tall + facing*censorNear*scale;
        gl_Position = projectionMatrix*viewMatrix*vec4(world, 1.0);
        float block = censorWidth*scale/${CENSOR_BLOCKS.toFixed(1)};
        vCensorBlock = vec2((position.x + 0.5)*censorWidth*scale, (position.y + 0.5)*tall)/block;
        vCensorSkin = personTrait(${skinRow}).rgb;
        vCensorPerson = float(personIndex());
      }`,
    fragmentShader: `
      uniform float censorTime;
      varying vec2 vCensorBlock;
      varying vec3 vCensorSkin;
      varying float vCensorPerson;
      void main() {
        vec3 cell = vec3(floor(vCensorBlock), floor(censorTime*${CENSOR_SHIMMER.toFixed(1)}) + vCensorPerson*17.0);
        float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719)))*43758.5453);
        // (mostly near their skin, a third of blocks much darker)
        float shade = h < 0.33 ? 0.35 + 0.6*h : 0.8 + 0.35*(h - 0.33);
        gl_FragColor = vec4(vCensorSkin*shade, 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, body.instanceMatrix.count);
  mesh.instanceMatrix = body.instanceMatrix;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.layers.enable(headshotLayer);
  mesh.visible = false;
  mesh.name = 'Censor';
  mesh.onBeforeRender = () => { own.censorTime.value = performance.now()/1000; };
  scene.add(mesh);
  return mesh;
}
