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
import './zones/suburbs.js';
import './zones/airport.js';
import './objects/objects.js';
import './water/bridges.js';
import './ui/panels.js';
import './ui/morality.js';
import './editor/tools.js';
import './editor/input.js';
import './editor/context-menu.js';
import './project/save-load.js';
import './ui/zone-carousel.js';
import './sky/day-night.js';
import './sky/weather.js';
import './sky/streetlights.js';
import './project/history.js';
import './project/autosave.js';
import './project/export-glb.js';
import './life/possession.js';
import './life/people/people.js';
import './life/traffic.js';
import './life/person-card.js';
import './life/car-card.js';
import './buildings/building-card.js';
import './buildings/see-through.js';
import './ui/win3.js';
import './ui/sound.js';
import './ui/mobile.js';
import './ui/pixelation.js';
import './ui/ped-view.js';
import './project/export-obj.js';
import * as THREE from 'three';
import { S } from './core/shared.js';
import { scene, camera, renderer, skyDome, SKIP_OVER_WATER_AND_ROADS, blinkLights, refreshSceneIndex } from './core/scene.js';
import { controls } from './core/camera-controls.js';
import { mulberry32 } from './core/math.js';
import { createWindowMaterial } from './buildings/windows.js';
import { renderMapsList } from './maps/map-images.js';
import { updatePedView } from './ui/ped-view.js';
import { applyPathShader, applyWalkwayShader } from './roads/paths.js';
import { updateTrafficLights } from './roads/markings.js';
import { loadCarriageModel, updateTrainShuttles, scaleNodeUi, nodeUiMaterial } from './trains/trains.js';
import { applyGrassNoiseShader } from './zones/surface-detail.js';
import { applyPavingShader, loadFountainModel } from './zones/plazas.js';
import { applyCropShader } from './zones/farmland.js';
import { WATER_TIME, applyWaterShader, rebuildWater } from './water/water.js';
import { renderHierarchy, renderWorldTintPanel } from './ui/panels.js';
import { applyModeVisibility } from './editor/tools.js';
import { updateDayNight, syncSkyUI } from './sky/day-night.js';
import { placeSunLight, updateWeather } from './sky/weather.js';
import { updateStreetlights } from './sky/streetlights.js';
import { commitHistory } from './project/history.js';
import { loadPersonModel, syncPeopleUI, updatePeople } from './life/people/people.js';
import { updateTraffic, loadCarModels } from './life/traffic.js';
import { updateGiblets } from './life/giblets.js';
import { updateBodyParts } from './life/people/peopleGibs.js';
import { updateCarWrecks } from './life/car-wrecks.js';
import { updateLightning } from './life/lightning.js';
import { updateAmbience } from './audio/ambience.js';
import { loadBeeModel, updateBees } from './life/bees.js';
import { updateAirports, loadPlaneModel } from './zones/airport.js';
import { loadHouseModels } from './zones/suburbs.js';
import { updateBuildingFollow } from './buildings/building-card.js';
import { updateInteriorCamera } from './buildings/interior.js';
import { hideBuildingsAroundCamera } from './buildings/see-through.js';
import { renderView } from './ui/pixelation.js';
import { loadStatueModel } from './objects/object-types.js';

// ============================================================ init
applyModeVisibility();
renderHierarchy();
renderMapsList();
renderWorldTintPanel();
loadCarriageModel();
loadPersonModel();
loadCarModels();
loadBeeModel();
loadHouseModels();
loadPlaneModel();
loadFountainModel();
loadStatueModel();
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
  standardWith(mat => applyPathShader(mat, [], 1, 1), { transparent: true, depthWrite: false, ...SKIP_OVER_WATER_AND_ROADS }),
  standardWith(mat => applyWalkwayShader(mat, 'plain', 1, 0), SKIP_OVER_WATER_AND_ROADS), // walkway paving
  standardWith(null, { side: THREE.DoubleSide }),                                         // road surfaces, fountain stone
  standardWith(null, { vertexColors: true, flatShading: true, side: THREE.DoubleSide }),  // building bodies
  standardWith(null, { flatShading: true }),                                              // building details (greebles, ribs, canopies…)
  standardWith(null, { flatShading: true, side: THREE.DoubleSide }),                      // landmark cone toppers
  standardWith(null, { transparent: true, opacity: 0.5, depthWrite: false }),             // glass domes, fountain spray
  () => createWindowMaterial(0x888888, mulberry32(1), true, 1, 1, true),                  // building windows, with and
  () => createWindowMaterial(0x888888, mulberry32(1), true, 1, 1, false),                 // without reflections
  () => new THREE.MeshBasicMaterial({ color: 0xffffff }),
  () => nodeUiMaterial(THREE.MeshBasicMaterial, { color: 0xffffff }),                     // node markers and handles
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
  updateGiblets(t);
  updateBodyParts(t);
  updateCarWrecks(t);
  updateLightning(t);
  updateBees(t);
  updateAirports(t);
  updateTraffic(t);
  updateAmbience(t);
  updateBuildingFollow();
  updateInteriorCamera();
  updateTrafficLights(t);
  updateDayNight(t);
  updateWeather(t);
  updateStreetlights();
  placeSunLight();
  WATER_TIME.value = t;
  refreshSceneIndex();
  updatePedView(t);
  hideBuildingsAroundCamera(); // (a building the camera's ended up inside isn't drawn: see see-through.js)
  blinkLights.forEach(o => { o.material.emissiveIntensity = 0.5 + Math.sin(t*3 + o.userData.blinkPhase)*0.5; });
  if (S.interactionMode === 'node') scaleNodeUi(camera);
  renderView(scene, camera);
}
animate();

// A handle on the app's insides, for poking at it from the browser console.
import * as SceneModule from './core/scene.js';
import * as Shared from './core/shared.js';
window.splinetopia = { scene: SceneModule.scene, renderer: SceneModule.renderer, camera: SceneModule.camera, S: Shared.S, App: Shared.App };

