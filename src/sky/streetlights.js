import * as THREE from 'three';
import { S } from '../core/shared.js';
import { computeWindowGlowFactor, lampPostMeshes, refreshSceneIndex } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { forEachHeadlight } from '../life/traffic.js';

// ============================================================ lamp posts and headlights lighting the street
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
// Headlights throw a cone out ahead of each car, painted into a map of their own that follows the camera about.
const HEADLIGHT_REACH = 22;     // how far down the road a car's beam reaches, in metres
const HEADLIGHT_SPREAD = 0.35;  // how much wider the beam gets for every metre it goes (it's HEADLIGHT_WIDTH wide at the bumper)
const HEADLIGHT_WIDTH = 1.8;
const HEADLIGHT_HEIGHT = 3;     // nothing higher than this is in the beam
const HEADLIGHT_TILT = 3;       // (see nightLightAt)
const HEADLIGHT_COLOR = new THREE.Color(0xfff2dc);
const HEADLIGHT_STRENGTH = 9;
const HEADLIGHT_TEXELS = 256;   // along either side of their map…
const HEADLIGHT_SPAN = [160, 640]; // …which covers this far across (metres), nearer or further out as the camera is

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

// and the same again for cars' headlights, which move, so are painted afresh every frame (see "headlights", below)
const headlightMap = new SharedTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
headlightMap.magFilter = headlightMap.minFilter = THREE.LinearFilter;
headlightMap.generateMipmaps = false;
headlightMap.unpackAlignment = 1;
headlightMap.needsUpdate = true;
const headlightMapBounds = new SharedVector4(0, 0, 1, 1);
const headlightLight = new SharedVector3(0, 0, 0);

const uniforms = {
  lampMap: { value: lampMap }, lampMapBounds: { value: lampMapBounds }, lampLight: { value: lampLight },
  headlightMap: { value: headlightMap }, headlightMapBounds: { value: headlightMapBounds }, headlightLight: { value: headlightLight },
};
['standard', 'physical', 'lambert', 'phong', 'toon'].forEach(id => Object.assign(THREE.ShaderLib[id].uniforms, uniforms));

THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#ifndef NO_LAMPLIGHT
uniform sampler2D lampMap;
uniform vec4 lampMapBounds;
uniform vec3 lampLight;
uniform sampler2D headlightMap;
uniform vec4 headlightMapBounds;
uniform vec3 headlightLight;
// How much of a map's light lands on a surface here. The map only says how much light there is, not which way it comes
// from — but it's brightest at its source, so the way it rises points back there. Two more reads either side give that,
// and with it which walls face the light; \`tilt\` is how far that leans the light over from straight down.
float nightLightAt( sampler2D map, vec4 bounds, float tilt, vec3 world, vec3 worldNormal ) {
  vec2 uv = ( world.xz - bounds.xy ) * bounds.zw;
  float here = texture2D( map, uv ).r;
  if ( here <= 0.0 ) return 0.0;
  vec2 metre = vec2( 1.0, 0.0 ) * bounds.zw;
  vec2 rise = vec2( texture2D( map, uv + metre.xy ).r - texture2D( map, uv - metre.xy ).r,
                    texture2D( map, uv + metre.yx ).r - texture2D( map, uv - metre.yx ).r );
  vec3 dir = normalize( vec3( rise.x * tilt, 1.0, rise.y * tilt ) );
  return here * clamp( ( dot( worldNormal, dir ) + 0.25 ) / 1.25, 0.0, 1.0 );
}
#endif
`;
THREE.ShaderChunk.lights_fragment_maps += /* glsl */`
#if defined( RE_IndirectDiffuse ) && !defined( NO_LAMPLIGHT )
if ( lampLight.r > 0.0 || headlightLight.r > 0.0 ) {
  vec3 nightWorld = ( -vViewPosition ) * mat3( viewMatrix ) + cameraPosition;
  vec3 nightNormal = normalize( normal * mat3( viewMatrix ) ); // (both back into the world's terms)
  if ( lampLight.r > 0.0 ) irradiance += lampLight * nightLightAt( lampMap, lampMapBounds, ${(REACH * 0.6).toFixed(2)}, nightWorld, nightNormal )
    * smoothstep( ${(LAMP_HEIGHT + 3).toFixed(1)}, ${(LAMP_HEIGHT - 0.5).toFixed(1)}, nightWorld.y );
  if ( headlightLight.r > 0.0 ) irradiance += headlightLight * nightLightAt( headlightMap, headlightMapBounds, ${HEADLIGHT_TILT.toFixed(1)}, nightWorld, nightNormal )
    * smoothstep( ${HEADLIGHT_HEIGHT.toFixed(1)}, 0.8, nightWorld.y );
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

// ---------------------------------------------------------------- headlights
// Cars move, so their map's painted again every frame — which is why it's small (HEADLIGHT_TEXELS square) and only
// covers the ground round where the camera's looking, finer close in and coarser from further out. It's squared up to
// its own texels as it follows the camera, so the beams don't shimmer as it goes.
const headlightData = new Uint8Array(HEADLIGHT_TEXELS*HEADLIGHT_TEXELS);
headlightMap.image = { data: headlightData, width: HEADLIGHT_TEXELS, height: HEADLIGHT_TEXELS };
const headlightLight01 = new Float32Array(HEADLIGHT_TEXELS*HEADLIGHT_TEXELS);
let headlightsLit = false;
function paintHeadlightMap() {
  const n = HEADLIGHT_TEXELS;
  const span = THREE.MathUtils.clamp(controls.radius*2, HEADLIGHT_SPAN[0], HEADLIGHT_SPAN[1]), texel = span/n;
  const minX = Math.floor((controls.target.x - span/2)/texel)*texel, minZ = Math.floor((controls.target.z - span/2)/texel)*texel;
  const light = headlightLight01;
  light.fill(0);
  let any = false;
  forEachHeadlight((x, z, heading, length) => {
    const fx = Math.sin(heading), fz = Math.cos(heading); // ahead, and (fz, -fx) across
    const bx = x + fx*length/2, bz = z + fz*length/2;     // the front bumper, where the beam starts
    const far = HEADLIGHT_WIDTH/2 + HEADLIGHT_REACH*HEADLIGHT_SPREAD;
    const ex = bx + fx*HEADLIGHT_REACH, ez = bz + fz*HEADLIGHT_REACH;
    const x0 = Math.max(1, Math.floor((Math.min(bx, ex) - far - minX)/texel)), x1 = Math.min(n - 2, Math.ceil((Math.max(bx, ex) + far - minX)/texel));
    const z0 = Math.max(1, Math.floor((Math.min(bz, ez) - far - minZ)/texel)), z1 = Math.min(n - 2, Math.ceil((Math.max(bz, ez) + far - minZ)/texel));
    if (x0 > x1 || z0 > z1) return; // (off the map)
    any = true;
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const dx = minX + (i + 0.5)*texel - bx, dz = minZ + (j + 0.5)*texel - bz;
      const along = dx*fx + dz*fz;
      if (along <= 0 || along >= HEADLIGHT_REACH) continue;
      const half = HEADLIGHT_WIDTH/2 + along*HEADLIGHT_SPREAD, across = Math.abs(dx*fz - dz*fx)/half;
      if (across >= 1) continue;
      const down = 1 - along/HEADLIGHT_REACH, edge = 1 - across*across;
      light[j*n + i] += down*Math.sqrt(down)*edge*Math.min(1, along/2); // (fading in off the bumper, so it doesn't light its own car)
    }
  });
  if (any || headlightsLit) {
    for (let k = 0; k < headlightData.length; k++) headlightData[k] = Math.min(255, Math.round(light[k]*255));
    headlightMap.needsUpdate = true;
  }
  headlightsLit = any;
  headlightMapBounds.set(minX, minZ, 1/span, 1/span);
  return any;
}

// (each frame, from main.js)
export function updateStreetlights() {
  const dark = computeWindowGlowFactor(S.sunElevation);
  const lamps = paintLampMap() ? dark*dark : 0;
  lampLight.set(LAMP_COLOR.r, LAMP_COLOR.g, LAMP_COLOR.b).multiplyScalar(LAMP_STRENGTH*lamps);
  const beams = dark > 0 && paintHeadlightMap() ? dark*dark : 0;
  headlightLight.set(HEADLIGHT_COLOR.r, HEADLIGHT_COLOR.g, HEADLIGHT_COLOR.b).multiplyScalar(HEADLIGHT_STRENGTH*beams);
}
