import * as THREE from 'three';
import { scene } from '../../core/scene.js';
import { possession } from '../possession.js';

// The nude trait's censor: a Sims-style mosaic rectangle over each nude person, from upper thigh to stomach (a man) or
// to below the shoulders (a woman). It faces the camera, upright along the body's own up (pelvis to chest, as posed), so
// it falls over with them; seen along the body it hangs from just under the head (from above) or comes nearer the camera (below). One instanced quad per
// slot, sharing the body mesh's matrices and pose attribute. Whoever's possessed sees theirs upright just in front of them.

const CENSOR_WIDTH = 0.26;   // × the model's height
const CENSOR_NEAR = 0.3;     // how far towards the camera it's pushed, × the model's height (clear of the body)
const CENSOR_BLOCKS = 3;     // mosaic blocks across
const CENSOR_MIN_TALL = 0.8;  // the least it's ever as tall as it's wide, seen from above
const CENSOR_BELOW_NEAR = 2;  // seen from straight below, this many times CENSOR_NEAR more towards the camera
const CENSOR_SHIMMER = 6;    // times a second the blocks' shades re-roll
const CENSOR_OWN_NEAR = 0.1;  // CENSOR_NEAR for whoever's possessed: just in front of them

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
    censorTime: { value: 0 }, censorPossessed: { value: -1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...own },
    side: THREE.DoubleSide,
    vertexShader: `${vertexPars}
      uniform vec2 censorBones;
      uniform vec3 censorLow, censorHighMan, censorHighWoman;
      uniform float censorWidth, censorNear;
      uniform int censorPossessed;
      varying vec2 vCensorBlock;
      varying vec3 vCensorSkin;
      flat varying int vCensorPerson; // (flat: interpolated, its tiny errors turn the hash to noise)
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
        float block = censorWidth*scale/${CENSOR_BLOCKS.toFixed(1)};
        vCensorSkin = personTrait(${skinRow}).rgb;
        vCensorPerson = personIndex();
        if (personIndex() == censorPossessed) {
          // (seen from their own eyes: upright in front of them, pelvis to its usual top, no higher than the shoulders)
          vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          vec3 fwd = -(back - up*dot(back, up));
          vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          if (dot(fwd, fwd) < 1e-6) fwd = camUp - up*dot(camUp, up);
          fwd = normalize(fwd);
          vec3 side = normalize(cross(up, fwd));
          vec3 world = 0.5*(low + top) + side*position.x*censorWidth*scale + up*position.y*tall + fwd*${CENSOR_OWN_NEAR.toFixed(2)}*censorNear/${CENSOR_NEAR.toFixed(2)}*scale;
          gl_Position = projectionMatrix*viewMatrix*vec4(world, 1.0);
          vCensorBlock = (position.xy + 0.5)*vec2(${CENSOR_BLOCKS.toFixed(1)}, max(1.0, floor(tall/block + 0.5)));
          return;
        }
        // (towards the camera: its position in perspective, back along its view when orthographic)
        vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        vec3 facing = normalize(projectionMatrix[2][3] == 0.0 ? back : cameraPosition - 0.5*(low + top));
        vec3 side = cross(up, facing);
        if (dot(side, side) < 1e-8) side = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        side = normalize(side);
        vec3 onScreen = cross(facing, side); // (the body's up, as the camera sees it)
        // from above (along the body) it shortens, no less than MIN_TALL × its width, its top moving to just under the head;
        // from below it keeps its place and size, only coming nearer the camera (by up to BELOW_NEAR more)
        float along = dot(up, facing), above = max(along, 0.0), below = max(-along, 0.0);
        vec3 middle = 0.5*(low + top);
        if (above > 0.0) {
          tall = max(tall*sqrt(1.0 - above*above), ${CENSOR_MIN_TALL.toFixed(2)}*censorWidth*scale);
          middle = mix(top, (placed*(personBone(censorBones.y)*vec4(censorHighWoman, 1.0))).xyz, above) - onScreen*0.5*tall;
        }
        vec3 world = middle + side*position.x*censorWidth*scale + onScreen*position.y*tall + facing*censorNear*scale*(1.0 + ${CENSOR_BELOW_NEAR.toFixed(2)}*below);
        gl_Position = projectionMatrix*viewMatrix*vec4(world, 1.0);
        // (whole blocks each way: a part-block sliver at an edge reads as a rim)
        vCensorBlock = (position.xy + 0.5)*vec2(${CENSOR_BLOCKS.toFixed(1)}, max(1.0, floor(tall/block + 0.5)));
      }`,
    fragmentShader: `
      uniform float censorTime;
      varying vec2 vCensorBlock;
      varying vec3 vCensorSkin;
      flat varying int vCensorPerson; // (flat: interpolated, its tiny errors turn the hash to noise)
      void main() {
        // (an integer hash of the block, the tick and the person: the same for every pixel of a block on any GPU)
        uvec2 block = uvec2(ivec2(floor(max(vCensorBlock, 0.0))));
        uint k = block.x*73856093u ^ block.y*19349663u ^ uint(censorTime*${CENSOR_SHIMMER.toFixed(1)})*83492791u ^ uint(vCensorPerson)*2654435761u;
        k ^= k >> 13; k *= 0x5bd1e995u; k ^= k >> 15;
        float h = float(k & 0xffffu)/65535.0;
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
  mesh.onBeforeRender = () => { own.censorTime.value = performance.now()/1000; own.censorPossessed.value = possession.index; };
  scene.add(mesh);
  return mesh;
}
