import './ui/loading.js'; // (first, so it sees every fetch)
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
import './zones/town.js';
import './roads/mall.js';
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
import './life/traffic/traffic.js';
import './life/person-card.js';
import './life/car-card.js';
import './buildings/building-card.js';
import './buildings/see-through.js';
import './ui/win3.js';
import './ui/win3-menu.js';
import './ui/w3-select.js';
import './ui/sound.js';
import './ui/pixel-icons.js';
import './ui/mobile.js';
import './ui/pixelation.js';
import './ui/flat-shading.js';
import './ui/toon-shading.js';
import './ui/view-prefs.js';
import './ui/color-schemes.js';
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
import { updateRoadDragPreview } from './roads/drag-preview.js';
import { disposeRetiredMaterials } from './roads/roads.js';
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
import { aimPersonCulling } from './life/people/peopleModel.js';
import { updateTraffic, loadCarModels } from './life/traffic/traffic.js';
import { updateGiblets } from './life/giblets.js';
import { updateBodyParts } from './life/people/peopleGibs.js';
import { updateCarWrecks } from './life/car-wrecks.js';
import { shakeCamera, updateLightning } from './life/lightning.js';
import { updateAmbience } from './audio/ambience.js';
import { loadBeeModel, updateBees } from './life/bees.js';
import { updateAirports, loadPlaneModel } from './zones/airport.js';
import { loadPigeonModel, updatePigeons } from './life/pigeons.js';
import { loadMedBot, updateMedBots } from './life/medbot.js';
import { loadHouseModels } from './zones/suburbs.js';
import { updateBuildingFollow } from './buildings/building-card.js';
import { updateInteriorCamera, isInsideBuilding } from './buildings/interior.js';
import { fadeBuildingsAroundCamera } from './buildings/see-through.js';
import { updateBuildingBatches } from './buildings/building-batches.js';
import { updateNodeHighlight } from './editor/node-highlight.js';
import { renderView } from './ui/pixelation.js';
import { loadStatueModel, loadBeerStallModel } from './objects/object-types.js';
import { updateSpeechBubbles } from './ui/speech-bubbles.js';
import { placeEar } from './audio/sfx.js';
import { stillLoading, compileWhileLoading, waitForModels } from './ui/loading.js';

// ============================================================ init
applyModeVisibility();
renderHierarchy();
renderMapsList();
renderWorldTintPanel();
waitForModels([loadCarriageModel(), loadPersonModel(), loadCarModels(), loadBeeModel(), loadPigeonModel(), loadHouseModels(), loadPlaneModel(),
  loadFountainModel(), loadStatueModel(), loadBeerStallModel(), loadMedBot()]);
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
  standardWith(mat => applyWalkwayShader(mat, 'plain', 1, 0), SKIP_OVER_WATER_AND_ROADS), // raised walkway paving
  standardWith(mat => applyWalkwayShader(mat, 'plain', 1, 0, { segments: [], halfWidth: 1, fringe: 1 }),
    { transparent: true, depthWrite: false, ...SKIP_OVER_WATER_AND_ROADS }),              // ground walkway paving
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
  updateRoadDragPreview();
  if (S.waterDirty) rebuildWater();
  updatePeople(t);
  updateGiblets(t);
  updateBodyParts(t);
  updateCarWrecks(t);
  updateLightning(t);
  updateBees(t);
  updateAirports(t);
  updateMedBots(t);
  updatePigeons(t); // (before updateTraffic, which sets off the blasts that scatter them)
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
  fadeBuildingsAroundCamera(); // (a building the camera's inside or right up against fades out: see see-through.js)
  updateBuildingBatches();
  updateNodeHighlight();
  blinkLights.forEach(o => { o.material.emissiveIntensity = 0.5 + Math.sin(t*3 + o.userData.blinkPhase)*0.5; });
  if (S.interactionMode === 'node') scaleNodeUi(camera);
  updateSpeechBubbles(); // (once the camera's settled for the frame)
  placeEar(); // (likewise: where you hear from, see audio/sfx.js)
  const unshake = isInsideBuilding() ? () => {} : shakeCamera(camera, t); // (no shaking in a building's room)
  // (under the loading screen, shaders are compiled in the background rather than drawn: see ui/loading.js)
  if (stillLoading()) compileWhileLoading(renderer, scene, camera);
  else { aimPersonCulling(camera, renderer); renderView(scene, camera); }
  unshake();
  disposeRetiredMaterials(); // (only now the new ones have taken over their shader programs: see disposeObject)
}
animate();

// A handle on the app's insides, for poking at it from the browser console. `status` is there too, so a status effect can
// be tried out without waiting for someone to happen to buy a coffee: `kallipolis.status.add('caffeinated')` puts one on
// whoever the camera is following — the card should show its icon at once — and a second number is how long it lasts, and
// a third says whose, their place in the crowd (`kallipolis.status.add('caffeinated', 30, 3)`), a fourth its level.
import * as SceneModule from './core/scene.js';
import * as Shared from './core/shared.js';
import { EFFECTS, STATUS_SOURCES, addStatus, removeStatus, hasStatus } from './life/statuseffects.js';
import { inspected } from './ui/entity-card.js';
const followedAt = () => Shared.App.followedPerson?.() ?? -1;
// (the clock a status's length runs on: the same running people time updatePeople ticks them down by)
const peopleClock = () => Shared.App.peopleClock?.() ?? 0;
const status = {
  effects: EFFECTS, sources: STATUS_SOURCES, has: hasStatus, remove: removeStatus,
  add: (key, seconds = null, who = null, level = 1) => addStatus(Shared.App.people[who ?? followedAt()], key, seconds, peopleClock(), level),
  of: who => Shared.App.people[who ?? followedAt()],
  // What the followed person's card shows in its status column, and whether the pointer's tip is up — for the console:
  // `kallipolis.status.add('caffeinated', 60)`, rest the pointer on the coffee icon, then `kallipolis.status.report()`.
  // Read live every time, and the last two fields say where the browser thinks the pointer is: `over` is the element under
  // the icon's middle, and `tipBox` is where the tip was put (null if it isn't up).
  report: () => {
    const w = followedAt();
    const card = document.getElementById('person-card'), column = card?.querySelector('.pc-effects');
    const kids = [...(column?.children ?? [])];
    const icon = kids.find(el => el.classList.contains('pc-effect') && !el.classList.contains('pc-effect-empty'));
    const box = el => { const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null; };
    const from = box(icon);
    const middle = from ? document.elementFromPoint(from.x + from.w/2, from.y + from.h/2) : null;
    const live = inspected.get(card);
    const tip = live?.tip();
    return {
      following: w,
      statuses: (Shared.App.people[w]?.status ?? []).map(s => ({ key: s.key, left: Math.round((s.until - peopleClock())*10)/10 })),
      cardShown: !!card && !card.hidden,
      columnFound: !!column,
      slots: kids.map(el => el.classList.contains('pc-effect-empty') ? 'dash' : el.querySelector?.('img') ? 'icon' : el.className),
      iconSrc: icon?.querySelector('img')?.getAttribute('src') ?? null,
      iconBox: from,
      tipFound: !!tip, tipHidden: tip?.hidden ?? null, tipBox: box(tip),
      tipLines: tip ? [...tip.children].map(c => c.textContent) : null,
      tipStyle: tip ? { left: tip.style.left, right: tip.style.right, top: tip.style.top, position: getComputedStyle(tip).position, z: getComputedStyle(tip).zIndex, width: Math.round(tip.offsetWidth), height: Math.round(tip.offsetHeight) } : null,
      over: from ? { tag: middle?.tagName ?? null, cls: middle?.className ?? null, inColumn: !!middle?.closest?.('.pc-effects') } : null,
    };
  },
};
window.kallipolis = { scene: SceneModule.scene, renderer: SceneModule.renderer, camera: SceneModule.camera, S: Shared.S, App: Shared.App, status };

