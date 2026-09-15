import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, sun, sunOffset, updateSun } from '../core/scene.js';
import { controls } from '../core/camera-controls.js';
import { mulberry32 } from '../core/math.js';
import { syncSkyUI } from './day-night.js';

// ============================================================ weather
// Rain and snow fall through a box of air around wherever the camera's looking — sized to how far out it's zoomed, and
// anchored to the world, so the drops don't slide along as the view moves (they wrap round the box instead). Each drop's
// place comes straight from its random seed and the clock, so there's nothing to simulate. Rain is streaks slanting a little
// in the wind; snow is soft flakes swaying as they drift down. Cloud shadows come from an invisible layer of cloud high over
// the city: it takes part only in the sun's shadow map, where a tiling noise texture cuts it into cloud shapes (more of
// them the higher the setting), drifting with the wind. Rain and snow also dim the light and grey the sky (see updateSun).
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
  texture.repeat.set(5, 5);
  return texture;
})();
const CLOUD_LAYER_SIZE = 4800, CLOUD_TILES = 10; // the pattern repeats every CLOUD_LAYER_SIZE/CLOUD_TILES units
const cloudShadowMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: cloudTexture, alphaTest: 0.6 });
// never seen, only its shadow — its own material carries the pattern too, since the shadow pass may take it from there
cloudTexture.repeat.set(CLOUD_TILES, CLOUD_TILES);
const cloudLayer = new THREE.Mesh(new THREE.PlaneGeometry(CLOUD_LAYER_SIZE, CLOUD_LAYER_SIZE).rotateX(-Math.PI/2),
  new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, alphaMap: cloudTexture, alphaTest: 0.6 }));
cloudLayer.customDepthMaterial = cloudShadowMaterial;
cloudLayer.position.y = 140;
cloudLayer.castShadow = true;
cloudLayer.frustumCulled = false;
cloudLayer.visible = false;
cloudLayer.name = 'CloudShadows';
scene.add(cloudLayer);
// Shadows come from a shadow map rendered from the sun, which only covers the box its shadow camera sees. Rather than a
// fixed box around the middle of the map, the light and its shadow camera follow the view every frame — centered on what
// the camera's looking at, and sized to how far out it's zoomed (so zoomed out, the same map covers more ground, a little
// softer). The box moves in whole shadow-map texels, so shadows don't shimmer as the view pans. The cloud layer follows
// along too, in whole tiles of its pattern, so the clouds themselves stay where they are.
export function placeSunLight() {
  const half = Math.round(THREE.MathUtils.clamp(controls.radius*1.6, 150, 1500)/10)*10, shadowCamera = sun.shadow.camera;
  if (shadowCamera.right !== half) {
    shadowCamera.left = -half; shadowCamera.right = half; shadowCamera.top = half; shadowCamera.bottom = -half;
    shadowCamera.updateProjectionMatrix();
  }
  const texel = 2*half/sun.shadow.mapSize.x;
  const x = Math.round(controls.target.x/texel)*texel, z = Math.round(controls.target.z/texel)*texel;
  sun.target.position.set(x, 0, z);
  sun.target.updateMatrixWorld();
  sun.position.set(x + sunOffset.x, sunOffset.y, z + sunOffset.z);
  if (cloudLayer.visible) {
    const tile = CLOUD_LAYER_SIZE/CLOUD_TILES;
    cloudLayer.position.x = Math.round(controls.target.x/tile)*tile;
    cloudLayer.position.z = Math.round(controls.target.z/tile)*tile;
  }
}
function setWeather(kind, value) {
  if (kind === 'rain') S.weatherRain = value; else if (kind === 'snow') S.weatherSnow = value; else S.weatherClouds = value;
  cloudLayer.visible = S.weatherClouds > 0;
  // more cover lets more of the pattern through as cloud
  const threshold = +THREE.MathUtils.lerp(0.72, 0.36, S.weatherClouds).toFixed(2);
  [cloudShadowMaterial, cloudLayer.material].forEach(material => {
    if (material.alphaTest !== threshold) { material.alphaTest = threshold; material.needsUpdate = true; }
  });
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
  if (cloudLayer.visible) cloudTexture.offset.set(t*0.0035, t*0.0018);
}

Object.assign(App, { setWeather });
