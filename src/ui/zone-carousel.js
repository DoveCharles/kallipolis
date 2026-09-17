import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, renderer, updateSun, Y_ZONE_GROUND } from '../core/scene.js';
import { BUILDING_GROUND_COLORS } from '../core/splines.js';
import { DEFAULT_ZONE_SETTINGS } from '../core/state.js';
import { createMeshBuilder, disposeObject } from '../roads/roads.js';
import { makeFlatZoneMesh } from '../zones/surface-detail.js';
import { WATER_COLOR, WATER_LEVEL, WATER_BANK_TOP, WATER_BANK_BOTTOM, WATER_BANK_COLOR, applyWaterShader } from '../water/water.js';
import { toClipperPath, subdivideZone } from '../zones/cutouts.js';
import { updateStats } from './panels.js';

// ============================================================ zone type carousel
// A zone's type is picked from a carousel of cards rather than a dropdown, each card showing what that type looks like. The
// thumbnails are rendered by the app itself, the first time they're needed: for each type, a square zone is generated
// far off the map with the real generator (water, which is built with all the other water, gets a pond cut into a patch
// of ground instead), lit by a fixed daytime sun with no weather, and rendered from above at an angle into an image. It
// all happens between two frames, so the view never flickers, and the images are kept for the rest of the session.
const ZONE_TYPES = [
  { id: 'buildings', label: 'Buildings', color: '#6d717c' }, { id: 'plain', label: 'Plain', color: '#5d6068' },
  { id: 'park', label: 'Park', color: '#8fb85a' }, { id: 'beach', label: 'Beach', color: '#d9c48f' },
  { id: 'water', label: 'Water', color: '#1d6f7d' },
  { id: 'plaza', label: 'Plaza', color: '#b7b0a4' }, { id: 'farmland', label: 'Farmland', color: '#c9b75c' },
  { id: 'industrial', label: 'Industrial', color: '#7d8187' },
];
const THUMBNAIL_SIZE = 128;
let zoneThumbnails = null, zoneThumbnailsScheduled = false;
function zoneTypeCarouselHtml(zoneType) {
  const label = (ZONE_TYPES.find(t => t.id === zoneType) || ZONE_TYPES[0]).label;
  return `
    <div class="slider-row"><div class="row"><label>Zone type</label><span class="val">${label}</span></div>
      <div class="type-carousel">
        <button class="carousel-arrow" data-scroll="-1" title="Previous">&#8249;</button>
        <div class="carousel-track" id="ds-zonetype">
          ${ZONE_TYPES.map(t => `<button class="type-card${t.id === zoneType ? ' active' : ''}" data-type="${t.id}" title="${t.label}">
            <div class="thumb" style="background-color:${t.color};${zoneThumbnails ? `background-image:url(${zoneThumbnails[t.id]});` : ''}"></div>${t.label}</button>`).join('')}
        </div>
        <button class="carousel-arrow" data-scroll="1" title="Next">&#8250;</button>
      </div>
    </div>`;
}
// wires the carousel in `panel`: a card click calls onPick(type), the arrows scroll by a card, and the current type starts in view
function wireZoneTypeCarousel(panel, onPick) {
  const track = panel.querySelector('#ds-zonetype');
  if (!track) return;
  track.querySelectorAll('.type-card').forEach(card => card.addEventListener('click', () => onPick(card.dataset.type)));
  panel.querySelectorAll('.carousel-arrow').forEach(arrow => arrow.addEventListener('click', () => {
    track.scrollBy({ left: Number(arrow.dataset.scroll)*76, behavior: 'smooth' });
  }));
  const active = track.querySelector('.type-card.active');
  if (active) track.scrollLeft = active.offsetLeft - track.offsetLeft - (track.clientWidth - active.offsetWidth)/2;
  if (!zoneThumbnails && !zoneThumbnailsScheduled) {
    zoneThumbnailsScheduled = true;
    setTimeout(() => {
      zoneThumbnails = renderZoneThumbnails();
      document.querySelectorAll('#ds-zonetype .type-card').forEach(card => { card.querySelector('.thumb').style.backgroundImage = `url(${zoneThumbnails[card.dataset.type]})`; });
    }, 30);
  }
}
function renderZoneThumbnails() {
  const saved = { sunElevation: S.sunElevation, sunAzimuth: S.sunAzimuth, weatherRain: S.weatherRain, weatherSnow: S.weatherSnow, weatherClouds: S.weatherClouds, clear: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha() };
  S.sunElevation = 42; S.sunAzimuth = 35; S.weatherRain = S.weatherSnow = S.weatherClouds = 0;
  updateSun();
  const RENDER = THUMBNAIL_SIZE*2; // rendered at twice the size, then scaled down smoothly
  const target = new THREE.WebGLRenderTarget(RENDER, RENDER);
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  const pixels = new Uint8Array(RENDER*RENDER*4);
  const full = document.createElement('canvas'), small = document.createElement('canvas');
  full.width = full.height = RENDER; small.width = small.height = THUMBNAIL_SIZE;
  const fullCtx = full.getContext('2d'), smallCtx = small.getContext('2d');
  smallCtx.imageSmoothingQuality = 'high';
  const thumbnails = {};
  ZONE_TYPES.forEach((type, i) => {
    const cx = 40000 + i*500, cz = 40000, half = 75; // big enough that the camera below never sees past its edges
    const square = h => [{ x: cx-h, z: cz-h, type: 'poly' }, { x: cx+h, z: cz-h, type: 'poly' }, { x: cx+h, z: cz+h, type: 'poly' }, { x: cx-h, z: cz+h, type: 'poly' }];
    let group;
    if (type.id === 'water') {
      group = new THREE.Group();
      const pond = 32, ground = makeFlatZoneMesh(square(half), BUILDING_GROUND_COLORS[0], Y_ZONE_GROUND, 'ThumbGround', null, [toClipperPath(square(pond))]);
      if (ground) group.add(ground);
      const shore = [[cx-pond, cz-pond, cx+pond, cz-pond], [cx+pond, cz-pond, cx+pond, cz+pond], [cx+pond, cz+pond, cx-pond, cz+pond], [cx-pond, cz+pond, cx-pond, cz-pond]];
      const waterMat = new THREE.MeshStandardMaterial({ color: WATER_COLOR, roughness: 1 });
      applyWaterShader(waterMat, shore, [], 0);
      const surface = new THREE.Mesh(new THREE.PlaneGeometry(pond*2, pond*2).rotateX(-Math.PI/2), waterMat);
      surface.position.set(cx, WATER_LEVEL, cz);
      const banks = createMeshBuilder();
      shore.forEach(([ax, az, bx, bz]) => {
        const nx = -(bz - az)/(pond*2), nz = (bx - ax)/(pond*2); // pointing into the pond
        banks.addQuad({ x: ax, y: WATER_BANK_TOP, z: az }, { x: bx, y: WATER_BANK_TOP, z: bz }, { x: bx, y: WATER_BANK_BOTTOM, z: bz }, { x: ax, y: WATER_BANK_BOTTOM, z: az }, { x: nx, y: 0, z: nz });
      });
      group.add(surface, new THREE.Mesh(banks.build(), new THREE.MeshStandardMaterial({ color: WATER_BANK_COLOR, roughness: 0.95 })));
      scene.add(group);
    } else {
      const zone = { id: '__thumbnail-' + type.id, name: type.label, zoneType: type.id, closed: true, drawing: false, points: square(half),
        settings: { ...DEFAULT_ZONE_SETTINGS, seed: 4242 + i, lotCount: 14, fieldCount: 9, industrialLots: 7, treeDensity: 0.5, plazaTrees: 0.6 } };
      subdivideZone(zone);
      group = zone.buildingsGroup;
    }
    camera.position.set(cx + 40, 135, cz + 40); // looking down steeply enough that the view stays inside the patch
    camera.lookAt(cx, 2, cz);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x1b1e24, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, RENDER, RENDER, pixels);
    renderer.setRenderTarget(null);
    scene.remove(group);
    disposeObject(group);
    // the render target's rows run bottom to top
    const image = fullCtx.createImageData(RENDER, RENDER);
    for (let y=0;y<RENDER;y++) image.data.set(pixels.subarray((RENDER - 1 - y)*RENDER*4, (RENDER - y)*RENDER*4), y*RENDER*4);
    fullCtx.putImageData(image, 0, 0);
    smallCtx.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    smallCtx.drawImage(full, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    thumbnails[type.id] = small.toDataURL('image/jpeg', 0.88);
  });
  target.dispose();
  renderer.setClearColor(saved.clear, saved.clearAlpha);
  S.sunElevation = saved.sunElevation; S.sunAzimuth = saved.sunAzimuth;
  S.weatherRain = saved.weatherRain; S.weatherSnow = saved.weatherSnow; S.weatherClouds = saved.weatherClouds;
  updateSun();
  updateStats();
  return thumbnails;
}

Object.assign(App, { zoneTypeCarouselHtml, wireZoneTypeCarousel });
