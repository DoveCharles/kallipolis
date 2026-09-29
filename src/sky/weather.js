import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, camera, sun, sunOffset, updateSun, skyDome } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { mulberry32 } from '../core/math.js';
import { syncSkyUI } from './day-night.js';

// ============================================================ weather
// Rain and snow fall through a box of air around wherever the camera's looking — sized to how far out it's zoomed, and
// anchored to the world, so the drops don't slide along as the view moves (they wrap round the box instead). Each drop's
// place comes straight from its random seed and the clock, so there's nothing to simulate. Rain is streaks slanting a little
// in the wind; snow is soft flakes swaying as they drift down. Cloud shadows come from a tiling noise texture, a layer of
// cloud high over the city (more of it cloud the higher the setting), drifting with the wind (see cloudShade). Rain and
// snow also dim the light and grey the sky (see updateSun).
const RAIN_MAX = 6000, SNOW_MAX = 8000;
const RAIN_SPEED = 55, SNOW_SPEED = 4;
const rainSeeds = Float32Array.from({ length: RAIN_MAX*3 }, () => Math.random());
const snowSeeds = Float32Array.from({ length: SNOW_MAX*4 }, () => Math.random());
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_MAX*6), 3).setUsage(THREE.DynamicDrawUsage));
const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaebfd0, transparent: true, opacity: 0.45, depthWrite: false }));
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_MAX*3), 3).setUsage(THREE.DynamicDrawUsage));
const snowFlake = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.5, 'rgba(255,255,255,0.8)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
})();
const snowPoints = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, map: snowFlake, transparent: true, depthWrite: false, alphaTest: 0.02 }));
[rainLines, snowPoints].forEach((object, i) => { object.frustumCulled = false; object.visible = false; object.name = i ? 'Snow' : 'Rain'; scene.add(object); });
// a tiling cloud pattern: four octaves of value noise, wrapped so the edges meet
const cloudTexture = (() => {
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'), image = ctx.createImageData(size, size), rng = mulberry32(9001);
  const octaves = [[4, 0.5], [8, 0.25], [16, 0.15], [32, 0.1]].map(([cells, weight]) => ({ cells, weight, grid: Array.from({ length: cells*cells }, () => rng()) }));
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    let v = 0;
    octaves.forEach(({ cells, weight, grid }) => {
      const fx = x/size*cells, fy = y/size*cells, ix = Math.floor(fx), iy = Math.floor(fy);
      const sx = (fx - ix)*(fx - ix)*(3 - 2*(fx - ix)), sy = (fy - iy)*(fy - iy)*(3 - 2*(fy - iy));
      const at = (i, j) => grid[(j % cells)*cells + (i % cells)];
      v += weight*((at(ix, iy)*(1 - sx) + at(ix+1, iy)*sx)*(1 - sy) + (at(ix, iy+1)*(1 - sx) + at(ix+1, iy+1)*sx)*sy);
    });
    const k = (y*size + x)*4, c = Math.round(Math.min(1, v)*255);
    image.data[k] = image.data[k+1] = image.data[k+2] = c;
    image.data[k+3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
})();
// Cloud shadows are worked out in every lit material, not in the shadow map: each point looks up the sun's direction to
// where that ray meets a layer of cloud CLOUD_HEIGHT up, and the pattern there says how much of the sun gets through.
// So they reach as far as the eye can see (the shadow map only covers a box round the view), with soft edges, for one
// texture read a pixel. It goes in through three.js's shader chunks, like the streetlights (see streetlights.js).
const CLOUD_TILE = 480, CLOUD_HEIGHT = 140; // metres the pattern takes to repeat, and how high the clouds are
const CLOUD_SHADE = 0.8;                    // how much of the sun a thick cloud keeps off
cloudTexture.clone = function () { return this; }; // (one texture shared by every material — see SharedTexture in streetlights.js)
// the pattern's drift (x, z), 1/CLOUD_TILE, and where the pattern turns to cloud (0 for no clouds at all)
class SharedVector4 extends THREE.Vector4 { clone() { return this; } }
const cloudParams = new SharedVector4(0, 0, 1/CLOUD_TILE, 0);
const cloudUniforms = { cloudMap: { value: cloudTexture }, cloudParams: { value: cloudParams } };
['standard', 'physical', 'lambert', 'phong', 'toon'].forEach(id => Object.assign(THREE.ShaderLib[id].uniforms, cloudUniforms));
THREE.ShaderChunk.lights_pars_begin += /* glsl */`
#if NUM_DIR_LIGHTS > 0
uniform sampler2D cloudMap;
uniform vec4 cloudParams;
// how much of the light coming from \`toLight\` (a direction in view space) gets through the clouds to this point
float cloudShade( vec3 viewPosition, vec3 toLight ) {
  if ( cloudParams.w <= 0.0 ) return 1.0;
  vec3 world = viewPosition * mat3( viewMatrix ) + cameraPosition;
  vec3 dir = toLight * mat3( viewMatrix );
  vec2 above = world.xz + dir.xz * ( ${CLOUD_HEIGHT.toFixed(1)} - world.y ) / max( dir.y, 0.05 );
  float density = texture2D( cloudMap, above * cloudParams.z + cloudParams.xy ).r;
  return 1.0 - ${CLOUD_SHADE.toFixed(2)} * smoothstep( cloudParams.w - 0.07, cloudParams.w + 0.09, density );
}
#endif
`;
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cloudShade( geometryPosition, directLight.direction );');
// Shadows come from a shadow map rendered from the sun, which only covers the box its shadow camera sees. Rather than a
// fixed box, it's fitted every frame to the ground and rooftops actually on screen, as seen from the sun: the corners and
// edges of the view are cast onto the ground and onto a plane at rooftop height, pulled in to `reach` of what the camera's
// looking at (so a view toward the horizon doesn't stretch the map over the whole world), and the box is the smallest
// that holds them. It's turned to line up with the screen, so a wide screen gets a wide box and none of the map is spent
// behind the camera. Its size goes up and down in steps of about 9%, and its edges move in whole texels, so shadows don't
// shimmer as the view pans or zooms (they still crawl a little while the view turns, which moves the texel grid with it).
const SHADOW_TOP = 60;                          // high enough for the rooftops shadows fall on
const SHADOW_CASTER_REACH = 250;                // how far sunward of what's on screen a caster can be and still be drawn
const SHADOW_BIAS = 0.4;                        // in world units (the rooms' walls count on it: see buildings/interior.js)
const _raycaster = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _point = new THREE.Vector3();
const _toSun = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const stepUp = w => 2**(Math.ceil(Math.log2(Math.max(w, 8))*8)/8);
export function fitSunShadow(cam, target, reach) {
  cam.updateMatrixWorld();
  _toSun.copy(sunOffset).normalize();
  // the box's "up" is the screen's up, flattened across the sunlight (or the screen's right, if the sun's straight behind it)
  _up.setFromMatrixColumn(cam.matrixWorld, 1).addScaledVector(_toSun, -_up.dot(_toSun));
  if (_up.lengthSq() < 1e-4) _up.setFromMatrixColumn(cam.matrixWorld, 0).addScaledVector(_toSun, -_up.dot(_toSun));
  _right.crossVectors(_up, _toSun).normalize();
  _up.crossVectors(_toSun, _right);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  const STEPS = 4;
  for (let i = 0; i < 4*STEPS; i++) {
    const side = Math.floor(i/STEPS), f = (i % STEPS)/STEPS*2 - 1;
    _ndc.set([f, 1, -f, -1][side], [-1, f, 1, -f][side]);
    _raycaster.setFromCamera(_ndc, cam);
    const { origin, direction } = _raycaster.ray;
    // where the ray is between the ground and rooftop height: where it goes in and where it comes out (or gives out)
    let tIn = 0, tOut = 1e5;
    if (Math.abs(direction.y) > 1e-6) {
      const ta = -origin.y/direction.y, tb = (SHADOW_TOP - origin.y)/direction.y;
      tIn = Math.max(0, Math.min(ta, tb)); tOut = Math.min(tOut, Math.max(ta, tb));
    }
    if (tOut < tIn) continue; // (it never comes down that low)
    for (const t of [tIn, tOut]) {
      _point.copy(origin).addScaledVector(direction, t);
      _point.y = THREE.MathUtils.clamp(_point.y, 0, SHADOW_TOP);
      const dx = _point.x - target.x, dz = _point.z - target.z, far = Math.hypot(dx, dz);
      if (far > reach) { _point.x = target.x + dx*reach/far; _point.z = target.z + dz*reach/far; }
      const u = _point.dot(_right), v = _point.dot(_up), d = _point.dot(_toSun);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); d0 = Math.min(d0, d); d1 = Math.max(d1, d);
    }
  }
  if (u0 === Infinity) { // (looking up at the sky: keep to what's around the target)
    u0 = u1 = target.dot(_right); v0 = v1 = target.dot(_up); d0 = d1 = target.dot(_toSun);
  }
  const shadow = sun.shadow, shadowCamera = shadow.camera;
  const w = stepUp((u1 - u0)*1.03 + 2), h = stepUp((v1 - v0)*1.03 + 2);
  const texelU = w/shadow.mapSize.x, texelV = h/shadow.mapSize.y;
  const cu = Math.floor((u0 + u1 - w)/2/texelU)*texelU + w/2, cv = Math.floor((v0 + v1 - h)/2/texelV)*texelV + h/2;
  // the light sits sunward of everything on screen, far enough back to take in whatever might shade it
  const lightDepth = d1 + SHADOW_CASTER_REACH;
  sun.position.set(0, 0, 0).addScaledVector(_right, cu).addScaledVector(_up, cv).addScaledVector(_toSun, lightDepth);
  sun.target.position.copy(sun.position).addScaledVector(_toSun, -1);
  sun.target.updateMatrixWorld();
  shadowCamera.up.copy(_up);
  const depth = lightDepth - d0 + 10;
  if (shadowCamera.right !== w/2 || shadowCamera.top !== h/2 || shadowCamera.far !== depth) {
    shadowCamera.left = -w/2; shadowCamera.right = w/2; shadowCamera.top = h/2; shadowCamera.bottom = -h/2;
    shadowCamera.near = 0.5; shadowCamera.far = depth;
    shadowCamera.updateProjectionMatrix();
  }
  shadow.bias = -SHADOW_BIAS/(depth - 0.5);
}
export function placeSunLight() {
  fitSunShadow(camera, controls.target, THREE.MathUtils.clamp(controls.radius*2.5, 120, 2400));
}
function setWeather(kind, value) {
  if (kind === 'rain') S.weatherRain = value; else if (kind === 'snow') S.weatherSnow = value; else S.weatherClouds = value;
  // more cover lets more of the pattern through as cloud
  cloudParams.w = S.weatherClouds > 0 ? THREE.MathUtils.lerp(0.72, 0.36, S.weatherClouds) : 0;
  updateSun();
  syncSkyUI();
}
export function updateWeather(t) {
  const wrap = (v, size) => ((v % size) + size) % size;
  const W = THREE.MathUtils.clamp(controls.radius*1.4, 160, 800), H = Math.min(260, W*0.5);
  const x0 = controls.target.x - W/2, z0 = controls.target.z - W/2, scale = W/300;
  rainLines.visible = S.weatherRain > 0;
  if (rainLines.visible) {
    const count = Math.round(RAIN_MAX*S.weatherRain), pos = rainGeo.attributes.position.array;
    const length = 1.4*scale + 0.6, slant = length*0.25, fall = t*RAIN_SPEED*(0.7 + scale*0.3), drift = t*6;
    for (let i=0;i<count;i++) {
      const x = x0 + wrap(rainSeeds[i*3]*W + drift - x0, W), z = z0 + wrap(rainSeeds[i*3+2]*W - z0, W), y = H - wrap(rainSeeds[i*3+1]*H + fall, H);
      pos.set([x, y, z, x - slant, y + length, z], i*6);
    }
    rainGeo.setDrawRange(0, count*2);
    rainGeo.attributes.position.needsUpdate = true;
  }
  snowPoints.visible = S.weatherSnow > 0;
  if (snowPoints.visible) {
    const count = Math.round(SNOW_MAX*S.weatherSnow), pos = snowGeo.attributes.position.array, fall = t*SNOW_SPEED;
    for (let i=0;i<count;i++) {
      const phase = snowSeeds[i*4+3]*Math.PI*2, sway = Math.sin(t*0.7 + phase)*1.5*scale;
      pos[i*3] = x0 + wrap(snowSeeds[i*4]*W + sway + t*1.5 - x0, W);
      pos[i*3+1] = H - wrap(snowSeeds[i*4+1]*H + fall*(0.7 + snowSeeds[i*4+3]*0.6), H);
      pos[i*3+2] = z0 + wrap(snowSeeds[i*4+2]*W + Math.cos(t*0.5 + phase)*1.2*scale - z0, W);
    }
    snowPoints.material.size = 0.35 + scale*0.35;
    snowGeo.setDrawRange(0, count);
    snowGeo.attributes.position.needsUpdate = true;
  }
  cloudParams.x = t*0.0035; cloudParams.y = t*0.0018;
  skyDome.material.uniforms.time.value = t;
}

Object.assign(App, { setWeather });
