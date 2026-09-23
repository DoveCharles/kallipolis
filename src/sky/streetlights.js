import * as THREE from 'three';
import { S } from '../core/shared.js';
import { computeWindowGlowFactor, lampPostMeshes, litLobbies, refreshSceneIndex } from '../core/scene.js';
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
// A building with its ground floor lit spills a strip of light out onto the pavement all round it, painted into the
// same map — so shop fronts cost nothing more at draw time than the lamps already do.
const LOBBY_SPILL = 7;     // how far out from the wall it reaches, in metres
const LOBBY_BRIGHTNESS = 0.7; // at the foot of the wall, for a lobby lit at intensity 1 (a lamp's pool peaks at 0.6)
// Headlights throw a cone out ahead of each car, painted into a map of their own that follows the camera about.
const HEADLIGHT_REACH = 22;     // how far down the road a car's beam reaches, in metres
const HEADLIGHT_SPREAD = 0.35;  // how much wider the beam gets for every metre it goes (it's HEADLIGHT_WIDTH wide at the bumper)
const HEADLIGHT_WIDTH = 1.8;
const HEADLIGHT_HEIGHT = 3;     // nothing higher than this is in the beam
const HEADLIGHT_TILT = 3;       // (see nightLightAt)
const HEADLIGHT_COLOR = new THREE.Color(0xfff2dc);
const HEADLIGHT_STRENGTH = 5;
// and behind each car a short, dim red glow off its taillights, in the same map's second channel
const TAILLIGHT_REACH = 5;
const TAILLIGHT_SPREAD = 0.2;
const TAILLIGHT_COLOR = new THREE.Color(0xff2a1a);
const TAILLIGHT_STRENGTH = 3;
const HEADLIGHT_TEXELS = 256;   // along either side of their map…
const HEADLIGHT_SPAN = [160, 640]; // …which covers this far across (metres), nearer or further out as the camera is

// Every material gets its own copy of its uniforms when its program is made (see UniformsUtils.clone). These hand back
// themselves instead, so all of them share one map and one set of numbers, and changing them here changes them
// everywhere.
class SharedTexture extends THREE.DataTexture { clone() { return this; } }
class SharedVector4 extends THREE.Vector4 { clone() { return this; } }
class SharedVector3 extends THREE.Vector3 { clone() { return this; } }

// in colour, so each thing lit into it can shine its own — a lamp's orange, a lobby's warm or cool
const lampMap = new SharedTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
lampMap.magFilter = lampMap.minFilter = THREE.LinearFilter;
lampMap.generateMipmaps = false;
lampMap.needsUpdate = true;
const lampMapBounds = new SharedVector4(0, 0, 1, 1); // the map's -x,-z corner, and 1/its size along each
const lampLight = new SharedVector3(0, 0, 0);        // strength (the color's in the map), zero by day or with no lamps down

// and the same again for cars' headlights, which move, so are painted afresh every frame (see "headlights", below):
// white headlights in red, red taillights in green, their colors being in taillightLight and headlightLight
const headlightMap = new SharedTexture(new Uint8Array(2), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
headlightMap.magFilter = headlightMap.minFilter = THREE.LinearFilter;
headlightMap.generateMipmaps = false;
headlightMap.unpackAlignment = 1;
headlightMap.needsUpdate = true;
const headlightMapBounds = new SharedVector4(0, 0, 1, 1);
const headlightLight = new SharedVector3(0, 0, 0);
const taillightLight = new SharedVector3(0, 0, 0);

const uniforms = {
  lampMap: { value: lampMap }, lampMapBounds: { value: lampMapBounds }, lampLight: { value: lampLight },
  headlightMap: { value: headlightMap }, headlightMapBounds: { value: headlightMapBounds }, headlightLight: { value: headlightLight }, taillightLight: { value: taillightLight },
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
uniform vec3 taillightLight;
// How much of a map's light lands on a surface here. The map only says how much light there is, not which way it comes
// from — but it's brightest at its source, so the way it rises points back there. Two more reads either side give that,
// and with it which walls face the light; \`tilt\` is how far that leans the light over from straight down. (How
// bright is taken as the brightest channel.)
float nightLevel( vec4 texel ) { return max( texel.r, max( texel.g, texel.b ) ); }
vec3 nightLightAt( sampler2D map, vec4 bounds, float tilt, vec3 world, vec3 worldNormal ) {
  vec2 uv = ( world.xz - bounds.xy ) * bounds.zw;
  vec3 here = texture2D( map, uv ).rgb;
  if ( nightLevel( vec4( here, 0.0 ) ) <= 0.0 ) return vec3( 0.0 );
  vec2 metre = vec2( 1.0, 0.0 ) * bounds.zw;
  vec2 rise = vec2( nightLevel( texture2D( map, uv + metre.xy ) ) - nightLevel( texture2D( map, uv - metre.xy ) ),
                    nightLevel( texture2D( map, uv + metre.yx ) ) - nightLevel( texture2D( map, uv - metre.yx ) ) );
  vec3 dir = normalize( vec3( rise.x * tilt, 1.0, rise.y * tilt ) );
  return here * clamp( ( dot( worldNormal, dir ) + 0.25 ) / 1.25, 0.0, 1.0 );
}
// the same for a map of two separate lights, one to a channel, each leaning its own way
vec2 nightLightsAt( sampler2D map, vec4 bounds, float tilt, vec3 world, vec3 worldNormal ) {
  vec2 uv = ( world.xz - bounds.xy ) * bounds.zw;
  vec2 here = texture2D( map, uv ).rg;
  if ( max( here.x, here.y ) <= 0.0 ) return vec2( 0.0 );
  vec2 metre = vec2( 1.0, 0.0 ) * bounds.zw;
  vec2 riseX = texture2D( map, uv + metre.xy ).rg - texture2D( map, uv - metre.xy ).rg;
  vec2 riseZ = texture2D( map, uv + metre.yx ).rg - texture2D( map, uv - metre.yx ).rg;
  vec3 dir0 = normalize( vec3( riseX.x * tilt, 1.0, riseZ.x * tilt ) ), dir1 = normalize( vec3( riseX.y * tilt, 1.0, riseZ.y * tilt ) );
  return here * clamp( ( vec2( dot( worldNormal, dir0 ), dot( worldNormal, dir1 ) ) + 0.25 ) / 1.25, 0.0, 1.0 );
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
  if ( headlightLight.r > 0.0 ) {
    vec2 beams = nightLightsAt( headlightMap, headlightMapBounds, ${HEADLIGHT_TILT.toFixed(1)}, nightWorld, nightNormal );
    irradiance += ( headlightLight * beams.x + taillightLight * beams.y ) * smoothstep( ${HEADLIGHT_HEIGHT.toFixed(1)}, 0.8, nightWorld.y );
  }
}
#endif
`;

// ---------------------------------------------------------------- painting the map
// The lamps are the ones put down by hand and the ones standing round the plazas, and the light's the lit lobbies'
// too. The map's redone only when one of them is put down, moved, resized or taken away: each frame just compares
// where they all are. (A plaza's lamps and a building's lobby don't move without it being built again, so which of
// them there are is enough to go on.)
let paintedAs = '', anyLamps = false;
function paintLampMap() {
  refreshSceneIndex();
  const placed = S.objects.filter(o => o.type === LAMP_TYPE);
  const key = placed.map(o => `${o.x.toFixed(2)},${o.z.toFixed(2)},${o.scale.toFixed(2)}`).join(';')
    + '|' + lampPostMeshes.map(m => m.id).join(',') + '|' + litLobbies.map(m => m.id).join(',');
  if (key === paintedAs) return anyLamps;
  paintedAs = key;
  const lamps = [...placed, ...lampPostMeshes.flatMap(m => m.userData.lampPosts.map(p => ({ x: p.x, z: p.z, scale: 1 })))];
  anyLamps = lamps.length > 0 || litLobbies.length > 0;
  if (!anyLamps) return false;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  lamps.forEach(o => {
    const r = REACH*o.scale;
    minX = Math.min(minX, o.x - r); maxX = Math.max(maxX, o.x + r);
    minZ = Math.min(minZ, o.z - r); maxZ = Math.max(maxZ, o.z + r);
  });
  litLobbies.forEach(m => m.userData.footprint.forEach(p => {
    minX = Math.min(minX, p.x - LOBBY_SPILL); maxX = Math.max(maxX, p.x + LOBBY_SPILL);
    minZ = Math.min(minZ, p.z - LOBBY_SPILL); maxZ = Math.max(maxZ, p.z + LOBBY_SPILL);
  }));
  // a clear texel all the way round, so what's past the edge (clamped to it) stays dark
  const texel = Math.max(TEXEL, (maxX - minX)/(MAX_TEXELS - 2), (maxZ - minZ)/(MAX_TEXELS - 2));
  minX -= texel; minZ -= texel;
  const w = Math.ceil((maxX - minX)/texel) + 2, h = Math.ceil((maxZ - minZ)/texel) + 2;
  const light = new Float32Array(w*h*3);
  lamps.forEach(o => {
    const r = REACH*o.scale;
    const x0 = Math.max(0, Math.floor((o.x - r - minX)/texel)), x1 = Math.min(w - 1, Math.ceil((o.x + r - minX)/texel));
    const z0 = Math.max(0, Math.floor((o.z - r - minZ)/texel)), z1 = Math.min(h - 1, Math.ceil((o.z + r - minZ)/texel));
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const dx = minX + (i + 0.5)*texel - o.x, dz = minZ + (j + 0.5)*texel - o.z;
      const d = Math.sqrt(dx*dx + dz*dz)/r;
      if (d < 1) { const f = 1 - d; addLight(light, j*w + i, LAMP_COLOR, 0.6*f*f*(3 - 2*f)); } // a broad pool, softening to nothing at the edge
    }
  });
  litLobbies.forEach(m => paintSpill(light, w, h, minX, minZ, texel, m.userData.footprint, m.userData.lobbyColor || LAMP_COLOR, LOBBY_BRIGHTNESS*m.userData.lobbyLight));
  const data = new Uint8Array(w*h*4);
  for (let k = 0; k < w*h; k++) {
    for (let c = 0; c < 3; c++) data[k*4 + c] = Math.min(255, Math.round(light[k*3 + c]*255));
    data[k*4 + 3] = 255;
  }
  if (lampMap.image.width !== w || lampMap.image.height !== h) lampMap.dispose(); // a new size needs a new texture
  lampMap.image = { data, width: w, height: h };
  lampMap.needsUpdate = true;
  lampMapBounds.set(minX, minZ, 1/(w*texel), 1/(h*texel));
  return true;
}

function addLight(light, k, color, amount) {
  light[k*3] += color.r*amount; light[k*3 + 1] += color.g*amount; light[k*3 + 2] += color.b*amount;
}
// Light falling out of a footprint's walls: brightest right at the glass, gone LOBBY_SPILL out, and none inside.
function paintSpill(light, w, h, minX, minZ, texel, poly, color, peak) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  poly.forEach(p => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); });
  const i0 = Math.max(0, Math.floor((x0 - LOBBY_SPILL - minX)/texel)), i1 = Math.min(w - 1, Math.ceil((x1 + LOBBY_SPILL - minX)/texel));
  const j0 = Math.max(0, Math.floor((z0 - LOBBY_SPILL - minZ)/texel)), j1 = Math.min(h - 1, Math.ceil((z1 + LOBBY_SPILL - minZ)/texel));
  const n = poly.length;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = minX + (i + 0.5)*texel, z = minZ + (j + 0.5)*texel;
    let d2 = Infinity, inside = false;
    for (let k = 0, l = n - 1; k < n; l = k++) {
      const a = poly[l], b = poly[k];
      if ((b.z > z) !== (a.z > z) && x < (a.x - b.x)*(z - b.z)/(a.z - b.z) + b.x) inside = !inside;
      const ex = b.x - a.x, ez = b.z - a.z, t = Math.max(0, Math.min(1, ((x - a.x)*ex + (z - a.z)*ez)/(ex*ex + ez*ez || 1)));
      const dx = x - a.x - t*ex, dz = z - a.z - t*ez;
      d2 = Math.min(d2, dx*dx + dz*dz);
    }
    if (inside) continue;
    const f = 1 - Math.sqrt(d2)/LOBBY_SPILL;
    if (f > 0) addLight(light, j*w + i, color, peak*f*f);
  }
}

// ---------------------------------------------------------------- headlights
// Cars move, so their map's painted again every frame — which is why it's small (HEADLIGHT_TEXELS square) and only
// covers the ground round where the camera's looking, finer close in and coarser from further out. It's squared up to
// its own texels as it follows the camera, so the beams don't shimmer as it goes.
const headlightData = new Uint8Array(HEADLIGHT_TEXELS*HEADLIGHT_TEXELS*2);
headlightMap.image = { data: headlightData, width: HEADLIGHT_TEXELS, height: HEADLIGHT_TEXELS };
const headlightLight01 = new Float32Array(HEADLIGHT_TEXELS*HEADLIGHT_TEXELS*2);
let headlightsLit = false;
function paintHeadlightMap() {
  const n = HEADLIGHT_TEXELS;
  const span = THREE.MathUtils.clamp(controls.radius*2, HEADLIGHT_SPAN[0], HEADLIGHT_SPAN[1]), texel = span/n;
  const minX = Math.floor((controls.target.x - span/2)/texel)*texel, minZ = Math.floor((controls.target.z - span/2)/texel)*texel;
  const light = headlightLight01;
  light.fill(0);
  let any = false;
  // A cone of light from (bx, bz) out along (fx, fz), `width` wide there and spreading as it goes, into one channel.
  const cone = (bx, bz, fx, fz, reach, width, spread, fadeIn, channel) => {
    const far = width/2 + reach*spread;
    const ex = bx + fx*reach, ez = bz + fz*reach;
    const x0 = Math.max(1, Math.floor((Math.min(bx, ex) - far - minX)/texel)), x1 = Math.min(n - 2, Math.ceil((Math.max(bx, ex) + far - minX)/texel));
    const z0 = Math.max(1, Math.floor((Math.min(bz, ez) - far - minZ)/texel)), z1 = Math.min(n - 2, Math.ceil((Math.max(bz, ez) + far - minZ)/texel));
    if (x0 > x1 || z0 > z1) return; // (off the map)
    any = true;
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const dx = minX + (i + 0.5)*texel - bx, dz = minZ + (j + 0.5)*texel - bz;
      const along = dx*fx + dz*fz;
      if (along <= 0 || along >= reach) continue;
      const half = width/2 + along*spread, across = Math.abs(dx*fz - dz*fx)/half;
      if (across >= 1) continue;
      const down = 1 - along/reach, edge = 1 - across*across;
      light[(j*n + i)*2 + channel] += down*Math.sqrt(down)*edge*Math.min(1, along/fadeIn); // (fading in off the bumper, so it doesn't light its own car)
    }
  };
  forEachHeadlight((x, z, heading, length) => {
    const fx = Math.sin(heading), fz = Math.cos(heading); // ahead, and (fz, -fx) across
    cone(x + fx*length/2, z + fz*length/2, fx, fz, HEADLIGHT_REACH, HEADLIGHT_WIDTH, HEADLIGHT_SPREAD, 2, 0); // from the front bumper
    cone(x - fx*length/2, z - fz*length/2, -fx, -fz, TAILLIGHT_REACH, HEADLIGHT_WIDTH, TAILLIGHT_SPREAD, 0.6, 1); // and the back one
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
  lampLight.setScalar(LAMP_STRENGTH*lamps);
  const beams = dark > 0 && paintHeadlightMap() ? dark*dark : 0;
  headlightLight.set(HEADLIGHT_COLOR.r, HEADLIGHT_COLOR.g, HEADLIGHT_COLOR.b).multiplyScalar(HEADLIGHT_STRENGTH*beams);
  taillightLight.set(TAILLIGHT_COLOR.r, TAILLIGHT_COLOR.g, TAILLIGHT_COLOR.b).multiplyScalar(TAILLIGHT_STRENGTH*beams);
}
