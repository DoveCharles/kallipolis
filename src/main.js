import './core/scene.js';
import './core/camera-controls.js';
import './core/math.js';
import './buildings/footprints.js';
import './core/splines.js';
import './buildings/windows.js';
import './core/state.js';
import './maps/map-images.js';
import './roads/roads.js';
import './roads/paths.js';
import './roads/markings.js';
import './trains/trains.js';
import './editor/hover.js';
import './zones/zone-visuals.js';
import './zones/surface-detail.js';
import './zones/plazas.js';
import './zones/farmland.js';
import './zones/fences.js';
import './water/water.js';
import './zones/cutouts.js';
import './zones/industrial.js';
import './water/bridges.js';
import './ui/panels.js';
import './editor/tools.js';
import './editor/input.js';
import './editor/context-menu.js';
import './project/save-load.js';
import './ui/zone-carousel.js';
import './sky/day-night.js';
import './sky/weather.js';
import './project/history.js';
import './project/export-glb.js';
import './life/people.js';
import './life/traffic.js';
import './life/person-card.js';
import './ui/win3.js';
import './ui/pixelation.js';
import './project/export-obj.js';
import * as THREE from 'three';
import { S } from './core/shared.js';
import { scene, camera, renderer, skyDome, SKIP_OVER_WATER } from './core/scene.js';
import { controls } from './core/camera-controls.js';
import { mulberry32 } from './core/math.js';
import { createWindowMaterial } from './buildings/windows.js';
import { renderMapsList } from './maps/map-images.js';
import { applyPathShader } from './roads/paths.js';
import { updateTrafficLights } from './roads/markings.js';
import { loadCarriageModel, updateTrainShuttles, scaleNodeUi } from './trains/trains.js';
import { applyGrassNoiseShader } from './zones/surface-detail.js';
import { applyPavingShader } from './zones/plazas.js';
import { applyCropShader } from './zones/farmland.js';
import { WATER_TIME, applyWaterShader, rebuildWater } from './water/water.js';
import { renderHierarchy, renderWorldTintPanel } from './ui/panels.js';
import { applyModeVisibility } from './editor/tools.js';
import { updateDayNight, syncSkyUI } from './sky/day-night.js';
import { placeSunLight, updateWeather } from './sky/weather.js';
import { commitHistory } from './project/history.js';
import { loadPersonModel, syncPeopleUI, updatePeople } from './life/people.js';
import { updateTraffic } from './life/traffic.js';
import { renderView } from './ui/pixelation.js';

// ============================================================ init
applyModeVisibility();
renderHierarchy();
renderMapsList();
renderWorldTintPanel();
loadCarriageModel();
loadPersonModel();
// Roads, zones and water are thrown away and rebuilt wholesale on every edit, and three.js deletes a shader program as soon
// as the last material using it is disposed — so a rebuild that replaces every material of one kind (every water tile,
// every road surface…) would compile that shader again from scratch: a hitch of up to a third of a second. One
// never-disposed mesh per kind of material (a single zero-size triangle, so it draws nothing) keeps each program alive.
const shaderKeepAlive = new THREE.Group();
shaderKeepAlive.name = 'ShaderKeepAlive';
const standardWith = (applyShader, params) => () => {
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, ...(params || {}) });
  if (applyShader) applyShader(mat);
  return mat;
};
[
  standardWith(mat => applyWaterShader(mat, [], [], 0)),
  standardWith(mat => applyGrassNoiseShader(mat, [{ x:0, z:0 }, { x:1, z:0 }, { x:0, z:1 }], 1, [])),
  standardWith(mat => applyCropShader(mat, 1, 0, 1, 0.2)),
  standardWith(mat => applyPavingShader(mat, 0)),
  standardWith(mat => applyPathShader(mat, [], 1, 1), { transparent: true, depthWrite: false, ...SKIP_OVER_WATER }),
  standardWith(null, { side: THREE.DoubleSide }),                                         // road surfaces, fountain stone
  standardWith(null, { vertexColors: true, flatShading: true, side: THREE.DoubleSide }),  // building bodies
  standardWith(null, { flatShading: true }),                                              // building details (greebles, ribs, canopies…)
  standardWith(null, { flatShading: true, side: THREE.DoubleSide }),                      // landmark cone toppers
  standardWith(null, { transparent: true, opacity: 0.5, depthWrite: false }),             // glass domes, fountain spray
  () => createWindowMaterial(0x888888, mulberry32(1), true, 1, 1, true),                  // building windows, with and
  () => createWindowMaterial(0x888888, mulberry32(1), true, 1, 1, false),                 // without reflections
  () => new THREE.MeshBasicMaterial({ color: 0xffffff }),
].forEach(makeMaterial => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0,-10,0, 0,-10,0, 0,-10,0], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0,1,0, 0,1,0, 0,1,0], 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([1,1,1, 1,1,1, 1,1,1], 3));
  const mesh = new THREE.Mesh(geo, makeMaterial());
  mesh.frustumCulled = false;
  shaderKeepAlive.add(mesh);
});
scene.add(shaderKeepAlive);
syncPeopleUI();
syncSkyUI();
commitHistory(); // the starting point undo goes back to
function animate() {
  requestAnimationFrame(animate);
  controls.update(false);
  skyDome.position.copy(camera.position);
  const t = performance.now()*0.001;
  updateTrainShuttles(t);
  if (S.waterDirty) rebuildWater();
  updatePeople(t);
  updateTraffic(t);
  updateTrafficLights(t);
  updateDayNight(t);
  updateWeather(t);
  placeSunLight();
  WATER_TIME.value = t;
  scene.traverse(o => {
    if (o.userData && o.userData.isBlinkLight) {
      o.material.emissiveIntensity = 0.5 + Math.sin(t*3 + o.userData.blinkPhase)*0.5;
    }
  });
  if (S.interactionMode === 'node') scaleNodeUi(camera);
  renderView(scene, camera);
}
animate();

// A handle on the app's insides, for poking at it from the browser console.
import * as SceneModule from './core/scene.js';
import * as Shared from './core/shared.js';
window.splinetopia = { scene: SceneModule.scene, renderer: SceneModule.renderer, camera: SceneModule.camera, S: Shared.S, App: Shared.App };
