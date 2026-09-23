import * as THREE from 'three';
import { S } from '../core/shared.js';
import { computeWindowGlowFactor, lampPostMeshes, refreshSceneIndex } from '../core/scene.js';

// ============================================================ lamp posts lighting the street
// A real light per lamp post is one more light in every lit material in the scene, and a street's worth of them would
// cost more than the rest of the frame. Instead the lamps are painted, seen from above, into one small map: a soft
// pool around each post. Every lit material looks itself up in that map by where it stands and takes what it finds as
// light, falling on it from the post's side and fading out above the lamps' height. That's a texture read or three
// per pixel however many lamps there are; what it can't do is cast shadows or stop at a wall, which after dark is hard
// to spot.
//
// It goes in through three.js's own shader chunks, so it reaches every lit material there is, custom shaders on top of
// them included, with nothing to hook up per material. A material that shouldn't have it (a room seen from inside)
// opts out with a NO_LAMPLIGHT define.
const LAMP_TYPE = 'lamp';
const REACH = 10;          // how far a post's pool of light spreads, in metres at full size
const TEXEL = 0.5;         // metres per texel in the map
const MAX_TEXELS = 2048;   // along either side; a very spread-out town gets a coarser map rather than a bigger one
const LAMP_HEIGHT = 5;     // about where the globe hangs — the light falls off above it
const LAMP_COLOR = new THREE.Color(0xffc98a);
const LAMP_STRENGTH = 5;   // irradiance at the foot of a post, at full dark (π lights a surface to its own color)

// Every material gets its own copy of its uniforms when its program is made (see UniformsUtils.clone). These hand back
// themselves instead, so all of them share one map and one set of numbers, and changing them here changes them
// everywhere.
class SharedTexture extends THREE.DataTexture { clone() { return this; } }
class SharedVector4 extends THREE.Vector4 { clone() { return this; } }
class SharedVector3 extends THREE.Vector3 { clone() { return this; } }

const lampMap = new SharedTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
lampMap.magFilter = lampMap.minFilter = THREE.LinearFilter;
lampMap.generateMipmaps = false;
lampMap.unpackAlignment = 1; // one byte a texel, and rows any length
lampMap.needsUpdate = true;
const lampMapBounds = new SharedVector4(0, 0, 1, 1); // the map's -x,-z corner, and 1/its size along each
const lampLight = new SharedVector3(0, 0, 0);        // color × strength, zero by day or with no lamps down

const uniforms = { lampMap: { value: lampMap }, lampMapBounds: { value: lampMapBounds }, lampLight: { value: lampLight } };
['standard', 'physical', 'lambert', 'phong', 'toon'].forEach(id => Object.assign(THREE.ShaderLib[id].uniforms, uniforms));

THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#ifndef NO_LAMPLIGHT
uniform sampler2D lampMap;
uniform vec4 lampMapBounds;
uniform vec3 lampLight;
#endif
`;
// The map only says how much light there is here, not which way it comes from — but it's brightest at the post, so
// the way it rises points back to it. Two more reads either side give that, and with it which walls face the lamp.
THREE.ShaderChunk.lights_fragment_maps += /* glsl */`
#if defined( RE_IndirectDiffuse ) && !defined( NO_LAMPLIGHT )
if ( lampLight.r > 0.0 ) {
  vec3 lampWorld = ( -vViewPosition ) * mat3( viewMatrix ) + cameraPosition;
  vec2 lampUv = ( lampWorld.xz - lampMapBounds.xy ) * lampMapBounds.zw;
  float lampHere = texture2D( lampMap, lampUv ).r;
  if ( lampHere > 0.0 ) {
    vec2 lampStep = vec2( ${TEXEL * 2}, 0.0 ) * lampMapBounds.zw;
    vec2 lampRise = vec2( texture2D( lampMap, lampUv + lampStep.xy ).r - texture2D( lampMap, lampUv - lampStep.xy ).r,
                          texture2D( lampMap, lampUv + lampStep.yx ).r - texture2D( lampMap, lampUv - lampStep.yx ).r );
    vec3 lampDir = normalize( vec3( lampRise.x * ${(REACH * 0.6).toFixed(2)}, 1.0, lampRise.y * ${(REACH * 0.6).toFixed(2)} ) );
    vec3 lampNormal = normalize( normal * mat3( viewMatrix ) ); // back into the world's terms
    float lampFacing = clamp( ( dot( lampNormal, lampDir ) + 0.25 ) / 1.25, 0.0, 1.0 );
    float lampBelow = smoothstep( ${(LAMP_HEIGHT + 3).toFixed(1)}, ${(LAMP_HEIGHT - 0.5).toFixed(1)}, lampWorld.y );
    irradiance += lampLight * lampHere * lampFacing * lampBelow;
  }
}
#endif
`;

// ---------------------------------------------------------------- painting the map
// The lamps are the ones put down by hand and the ones standing round the plazas. The map's redone only when one of
// them is put down, moved, resized or taken away: each frame just compares where they all are. (A plaza's lamps don't
// move without the plaza being built again, so which plazas there are is enough to go on.)
let paintedAs = '', anyLamps = false;
function paintLampMap() {
  refreshSceneIndex();
  const placed = S.objects.filter(o => o.type === LAMP_TYPE);
  const key = placed.map(o => `${o.x.toFixed(2)},${o.z.toFixed(2)},${o.scale.toFixed(2)}`).join(';')
    + '|' + lampPostMeshes.map(m => m.id).join(',');
  if (key === paintedAs) return anyLamps;
  paintedAs = key;
  const lamps = [...placed, ...lampPostMeshes.flatMap(m => m.userData.lampPosts.map(p => ({ x: p.x, z: p.z, scale: 1 })))];
  anyLamps = lamps.length > 0;
  if (!anyLamps) return false;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  lamps.forEach(o => {
    const r = REACH*o.scale;
    minX = Math.min(minX, o.x - r); maxX = Math.max(maxX, o.x + r);
    minZ = Math.min(minZ, o.z - r); maxZ = Math.max(maxZ, o.z + r);
  });
  // a clear texel all the way round, so what's past the edge (clamped to it) stays dark
  const texel = Math.max(TEXEL, (maxX - minX)/(MAX_TEXELS - 2), (maxZ - minZ)/(MAX_TEXELS - 2));
  minX -= texel; minZ -= texel;
  const w = Math.ceil((maxX - minX)/texel) + 2, h = Math.ceil((maxZ - minZ)/texel) + 2;
  const light = new Float32Array(w*h);
  lamps.forEach(o => {
    const r = REACH*o.scale;
    const x0 = Math.max(0, Math.floor((o.x - r - minX)/texel)), x1 = Math.min(w - 1, Math.ceil((o.x + r - minX)/texel));
    const z0 = Math.max(0, Math.floor((o.z - r - minZ)/texel)), z1 = Math.min(h - 1, Math.ceil((o.z + r - minZ)/texel));
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const dx = minX + (i + 0.5)*texel - o.x, dz = minZ + (j + 0.5)*texel - o.z;
      const d = Math.sqrt(dx*dx + dz*dz)/r;
      if (d < 1) { const f = 1 - d; light[j*w + i] += 0.6*f*f*(3 - 2*f); } // a broad pool, softening to nothing at the edge
    }
  });
  const data = new Uint8Array(w*h);
  for (let k = 0; k < data.length; k++) data[k] = Math.min(255, Math.round(light[k]*255));
  if (lampMap.image.width !== w || lampMap.image.height !== h) lampMap.dispose(); // a new size needs a new texture
  lampMap.image = { data, width: w, height: h };
  lampMap.needsUpdate = true;
  lampMapBounds.set(minX, minZ, 1/(w*texel), 1/(h*texel));
  return true;
}

// (each frame, from main.js)
export function updateStreetlights() {
  const any = paintLampMap();
  const dark = any ? computeWindowGlowFactor(S.sunElevation) : 0;
  lampLight.set(LAMP_COLOR.r, LAMP_COLOR.g, LAMP_COLOR.b).multiplyScalar(LAMP_STRENGTH*dark*dark);
}
