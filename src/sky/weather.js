import * as THREE from 'three';
import { S, App, buildingHolders } from '../core/shared.js';
import { scene, sun, sunOffset, updateSun, skyDome } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { mulberry32, pointInPolygon } from '../core/math.js';
import { solidTopAt } from '../buildings/footprints.js';
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
#if NUM_DIR_LIGHTS > 0 || NUM_SUN_LIGHTS > 0
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
  'getSunLightInfo( sunLight, directLight );',
  'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= cloudShade( geometryPosition, directLight.direction );');
// Shadows come from a shadow map rendered from the sun, in two cascades (see "sun" in scene.js), each only covering the box
// its shadow camera sees. The boxes are fitted every frame to the ground and rooftops actually on screen, as seen from the
// sun: rays through the edges of the view are followed through the slab between the ground and rooftop height, pulled in
// to `reach` of what the camera's looking at (so a view toward the horizon doesn't stretch the map over the whole world),
// and cut where the near cascade hands over to the far one, and each box is the smallest that holds its part. They're
// turned to line up with the screen, so a wide screen gets wide boxes and none of the map is spent behind the camera.
// Their sizes go up and down in steps of about 9%, and their edges move in whole texels, so shadows don't shimmer as the
// view pans or zooms (they still crawl a little while the view turns, which moves the texel grid with it).
const SHADOW_TOP = 60;                          // high enough for the rooftops shadows fall on
const SHADOW_CASTER_REACH = 250;                // how far sunward of what's on screen a caster can be and still be drawn
const SHADOW_BIAS = 0.4;                        // in world units (the rooms' walls count on it: see buildings/interior.js)
const SHADOW_FADE = 0.1;                        // how much of each cascade's far end blends into the next (or fades out)
const RAYS_PER_SIDE = 8;
const _raycaster = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _point = new THREE.Vector3(), _forward = new THREE.Vector3();
const _toSun = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _rays = Array.from({ length: 4*RAYS_PER_SIDE }, () => ({ ray: new THREE.Ray(), tIn: 0, tOut: 0, depth0: 0, depthPerT: 0 }));
const stepUp = w => 2**(Math.ceil(Math.log2(Math.max(w, 8))*8)/8);
let shadowTarget = new THREE.Vector3(), shadowReach = 500;
// the part of the view whose depth from the camera is between depthA and depthB, as a box across the sunlight
// (and, of what's in it, the nearest and furthest from the camera, and whether any of it was pulled in to the reach)
function footprint(cam, depthA, depthB, box) {
  box.u0 = box.v0 = box.d0 = box.near = Infinity; box.u1 = box.v1 = box.d1 = box.far = -Infinity; box.cut = false;
  for (const r of _rays) {
    const t0 = Math.max(r.tIn, (depthA - r.depth0)/r.depthPerT), t1 = Math.min(r.tOut, (depthB - r.depth0)/r.depthPerT);
    if (t1 < t0) continue;
    for (const t of [t0, t1]) {
      r.ray.at(t, _point);
      _point.y = THREE.MathUtils.clamp(_point.y, 0, SHADOW_TOP);
      const dx = _point.x - shadowTarget.x, dz = _point.z - shadowTarget.z, far = Math.hypot(dx, dz);
      if (far > shadowReach) { _point.x = shadowTarget.x + dx*shadowReach/far; _point.z = shadowTarget.z + dz*shadowReach/far; box.cut = true; }
      const ahead = _point.sub(cam.position).dot(_forward);
      box.near = Math.min(box.near, ahead); box.far = Math.max(box.far, ahead);
      _point.add(cam.position);
      const u = _point.dot(_right), v = _point.dot(_up), d = _point.dot(_toSun);
      box.u0 = Math.min(box.u0, u); box.u1 = Math.max(box.u1, u); box.v0 = Math.min(box.v0, v); box.v1 = Math.max(box.v1, v);
      box.d0 = Math.min(box.d0, d); box.d1 = Math.max(box.d1, d);
    }
  }
  if (box.u0 === Infinity) { // (nothing there — looking up at the sky, say: keep to what's around the target)
    box.u0 = box.u1 = shadowTarget.dot(_right); box.v0 = box.v1 = shadowTarget.dot(_up); box.d0 = box.d1 = shadowTarget.dot(_toSun);
    box.near = box.far = 1;
  }
  return box;
}
const _boxes = [{}, {}, {}];
// Stands in for SunLightShadow's own fitting (bounding spheres round slices of the whole view frustum) when the renderer
// draws the shadow map, for whichever camera it's drawing for.
function fitSunCascades(light, cam) {
  const shadow = light.shadow;
  cam.updateMatrixWorld();
  _toSun.setFromMatrixPosition(light.matrixWorld).normalize();
  // the boxes' "up" is the screen's up, flattened across the sunlight (or the screen's right, if the sun's straight behind it)
  _up.setFromMatrixColumn(cam.matrixWorld, 1).addScaledVector(_toSun, -_up.dot(_toSun));
  if (_up.lengthSq() < 1e-4) _up.setFromMatrixColumn(cam.matrixWorld, 0).addScaledVector(_toSun, -_up.dot(_toSun));
  _right.crossVectors(_up, _toSun).normalize();
  _up.crossVectors(_toSun, _right);
  // rays round the edge of the view, each with where it's in the slab and how its distance ahead of the camera grows
  _forward.set(0, 0, -1).transformDirection(cam.matrixWorld);
  _rays.forEach((r, i) => {
    const side = Math.floor(i/RAYS_PER_SIDE), f = (i % RAYS_PER_SIDE)/RAYS_PER_SIDE*2 - 1;
    _ndc.set([f, 1, -f, -1][side], [-1, f, 1, -f][side]);
    _raycaster.setFromCamera(_ndc, cam);
    const { origin, direction } = r.ray.copy(_raycaster.ray);
    r.tIn = 0; r.tOut = 1e5;
    if (Math.abs(direction.y) > 1e-6) {
      const ta = -origin.y/direction.y, tb = (SHADOW_TOP - origin.y)/direction.y;
      r.tIn = Math.max(0, Math.min(ta, tb)); r.tOut = Math.min(r.tOut, Math.max(ta, tb));
    } else if (origin.y < 0 || origin.y > SHADOW_TOP) r.tOut = -1;
    r.depth0 = _point.copy(origin).sub(cam.position).dot(_forward);
    r.depthPerT = Math.max(direction.dot(_forward), 1e-6);
  });
  // how near and far what's on screen is, and the hand-over between the cascades: halfway between an even split and a
  // logarithmic one
  const all = footprint(cam, -Infinity, Infinity, _boxes[2]);
  const nearest = Math.max(all.near, 0.1), furthest = Math.max(all.far, nearest*1.01);
  const split = ((nearest + furthest)/2 + Math.sqrt(nearest*furthest))/2, fadeStart = split - SHADOW_FADE*(split - nearest);
  const boxes = [footprint(cam, -Infinity, split, _boxes[0]), footprint(cam, fadeStart, Infinity, _boxes[1])];
  // both cascades share a depth range, so one bias suits both; the light sits sunward of everything on screen, far enough
  // back to take in whatever might shade it
  const lightDepth = Math.max(boxes[0].d1, boxes[1].d1) + SHADOW_CASTER_REACH;
  const depth = lightDepth - Math.min(boxes[0].d0, boxes[1].d0) + 10;
  shadow.bias = -SHADOW_BIAS/(depth - 0.5);
  // each cascade's corner of the map, inset a texel so filtering can't read across into the other
  const inset = 1/shadow.mapSize.x;
  boxes.forEach((box, i) => {
    const viewport = shadow.getViewport(i).set(i + inset, inset, 1 - 2*inset, 1 - 2*inset);
    const resolution = shadow.mapSize.x*viewport.z;
    const w = stepUp((box.u1 - box.u0)*1.03 + 2), h = stepUp((box.v1 - box.v0)*1.03 + 2);
    const texelU = w/resolution, texelV = h/resolution;
    const cu = Math.floor((box.u0 + box.u1 - w)/2/texelU)*texelU + w/2, cv = Math.floor((box.v0 + box.v1 - h)/2/texelV)*texelV + h/2;
    const shadowCamera = shadow.getCamera(i);
    shadowCamera.position.set(0, 0, 0).addScaledVector(_right, cu).addScaledVector(_up, cv).addScaledVector(_toSun, lightDepth);
    shadowCamera.up.copy(_up);
    shadowCamera.lookAt(_point.copy(shadowCamera.position).sub(_toSun));
    shadowCamera.left = -w/2; shadowCamera.right = w/2; shadowCamera.top = h/2; shadowCamera.bottom = -h/2;
    shadowCamera.near = 0.5; shadowCamera.far = depth;
    shadowCamera.updateProjectionMatrix();
    shadowCamera.updateMatrixWorld();
    shadow._updateMatrix(shadowCamera, shadow.getMatrix(i), shadow.getFrustum(i), viewport);
  });
  // which cascade each point on screen reads, by its distance ahead of the camera: (from, to, fading out from); where the
  // reach cut the view short, the far one fades its shadows out toward its end rather than stopping them dead
  shadow._cascadeData[0].set(-1e10, split, fadeStart, 0);
  if (all.cut) shadow._cascadeData[1].set(fadeStart, furthest, furthest - SHADOW_FADE*(furthest - split), 0);
  else shadow._cascadeData[1].set(fadeStart, 1e10, 1e9, 0);
}
sun.shadow.updateMatrices = function (light, cam) { if (cam) fitSunCascades(light, cam); };
// Points the sun the way sunOffset says, and sets what the shadows fit to: the ground within `reach` of `target`.
export function fitSunShadow(target, reach) {
  sun.position.copy(sunOffset);
  sun.updateMatrixWorld();
  shadowTarget.copy(target); shadowReach = reach;
}
export function placeSunLight() {
  fitSunShadow(controls.target, THREE.MathUtils.clamp(controls.radius*4, 200, 2400));
}
function setWeather(kind, value) {
  if (kind === 'rain') S.weatherRain = value; else if (kind === 'snow') S.weatherSnow = value; else S.weatherClouds = value;
  // more cover lets more of the pattern through as cloud
  cloudParams.w = S.weatherClouds > 0 ? THREE.MathUtils.lerp(0.72, 0.36, S.weatherClouds) : 0;
  updateSun();
  syncSkyUI();
}
// Cycle Weather: every few minutes picks a new spell (clear, cloudy, rain, storm, snow) and eases toward it.
const SPELLS = [[0, 0, 0], [0, 0, 0.3], [0, 0, 0.7], [0.4, 0, 0.8], [1, 0, 1], [0, 0.5, 0.6]];
const SPELL_MIN = 90, SPELL_MAX = 300, EASE = 0.02; // seconds; share of the gap closed per second
let spellEnd = 0, spell = SPELLS[0], lastCycle = 0;
function cycleWeather(t) {
  if (!S.weatherCycle) { spellEnd = 0; return; }
  if (t - lastCycle < 0.5) return;
  const dt = Math.min(t - lastCycle, 1); lastCycle = t;
  if (t > spellEnd) { spell = SPELLS[Math.floor(Math.random()*SPELLS.length)]; spellEnd = t + SPELL_MIN + Math.random()*(SPELL_MAX - SPELL_MIN); }
  const step = (v, to) => Math.abs(to - v) < 0.01 ? to : v + (to - v)*Math.min(1, EASE*dt*4);
  S.weatherRain = step(S.weatherRain, spell[0]); S.weatherSnow = step(S.weatherSnow, spell[1]);
  setWeather('clouds', step(S.weatherClouds, spell[2]));
}
// Rain and snow stop at roofs (buildings' and malls'): the cover's top per COVER_CELL, cached till the buildings change.
const COVER_CELL = 1.5;
let cover = new Map(), coverKey = '', coverCheckedAt = -Infinity;
function coverTopAt(x, z) {
  const cx = Math.floor(x/COVER_CELL), cz = Math.floor(z/COVER_CELL), k = (cx + 32768)*65536 + cz + 32768;
  let top = cover.get(k);
  if (top === undefined) {
    const px = (cx + 0.5)*COVER_CELL, pz = (cz + 0.5)*COVER_CELL;
    top = solidTopAt(px, pz);
    for (const m of S.malls || []) if (m.roofTop > top && pointInPolygon({ x: px, z: pz }, m.points)) top = m.roofTop;
    if (cover.size > 300000) cover.clear();
    cover.set(k, top);
  }
  return top;
}
function checkCover() {
  const now = performance.now();
  if (now - coverCheckedAt < 500) return;
  coverCheckedAt = now;
  const key = buildingHolders().map(z => z.id + ':' + (z.buildingsGroup?.children.length ?? 0)).join(',');
  if (key !== coverKey) { coverKey = key; cover.clear(); }
}
export function updateWeather(t) {
  cycleWeather(t);
  const wrap = (v, size) => ((v % size) + size) % size;
  const W = THREE.MathUtils.clamp(controls.radius*1.4, 160, 800), H = Math.min(260, W*0.5);
  const x0 = controls.target.x - W/2, z0 = controls.target.z - W/2, scale = W/300;
  rainLines.visible = S.weatherRain > 0;
  if (rainLines.visible || S.weatherSnow > 0) checkCover();
  if (rainLines.visible) {
    const count = Math.round(RAIN_MAX*S.weatherRain), pos = rainGeo.attributes.position.array;
    const length = 1.4*scale + 0.6, slant = length*0.25, fall = t*RAIN_SPEED*(0.7 + scale*0.3), drift = t*6;
    for (let i=0;i<count;i++) {
      const x = x0 + wrap(rainSeeds[i*3]*W + drift - x0, W), z = z0 + wrap(rainSeeds[i*3+2]*W - z0, W), y = H - wrap(rainSeeds[i*3+1]*H + fall, H);
      const top = coverTopAt(x, z);
      if (y + length <= top) pos.set([x, -1e4, z, x, -1e4, z], i*6);
      else pos.set([x, Math.max(y, top), z, x - slant, y + length, z], i*6);
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
      if (pos[i*3+1] < coverTopAt(pos[i*3], pos[i*3+2])) pos[i*3+1] = -1e4;
    }
    snowPoints.material.size = 0.35 + scale*0.35;
    snowGeo.setDrawRange(0, count);
    snowGeo.attributes.position.needsUpdate = true;
  }
  cloudParams.x = t*0.0035; cloudParams.y = t*0.0018;
  skyDome.material.uniforms.time.value = t;
}

Object.assign(App, { setWeather });
