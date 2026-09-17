import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, renderer, updateSun, Y_ZONE_GROUND, Y_PATH } from '../core/scene.js';
import { BUILDING_GROUND_COLORS } from '../core/splines.js';
import { DEFAULT_ZONE_SETTINGS } from '../core/state.js';
import { createMeshBuilder, disposeObject } from '../roads/roads.js';
import { makeFlatZoneMesh } from '../zones/surface-detail.js';
import { WATER_COLOR, WATER_LEVEL, WATER_BANK_TOP, WATER_BANK_BOTTOM, WATER_BANK_COLOR, applyWaterShader } from '../water/water.js';
import { WALKWAY_TEXTURES, makeWalkwayMaterial, pathFadeWidth } from '../roads/paths.js';
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
// a carousel of `items` ({ id, label, color }) with `value` picked, its track given the element id `trackId`
function typeCarouselHtml(trackId, title, items, value, thumbnails) {
  const label = (items.find(t => t.id === value) || items[0]).label;
  return `
    <div class="slider-row"><div class="row"><label>${title}</label><span class="val">${label}</span></div>
      <div class="type-carousel">
        <button class="carousel-arrow" data-scroll="-1" title="Previous">&#8249;</button>
        <div class="carousel-track" id="${trackId}">
          ${items.map(t => `<button class="type-card${t.id === value ? ' active' : ''}" data-type="${t.id}" title="${t.label}">
            <div class="thumb" style="background-color:${t.color};${thumbnails && thumbnails[t.id] ? `background-image:url(${thumbnails[t.id]});` : ''}"></div>${t.label}</button>`).join('')}
        </div>
        <button class="carousel-arrow" data-scroll="1" title="Next">&#8250;</button>
      </div>
    </div>`;
}
// wires the carousel `trackId` in `panel`: a card click calls onPick(type), the arrows scroll by a card, and the current type
// starts in view. Returns the track, or null if it isn't there.
function wireTypeCarousel(panel, trackId, onPick) {
  const track = panel.querySelector('#' + trackId);
  if (!track) return null;
  track.querySelectorAll('.type-card').forEach(card => card.addEventListener('click', () => onPick(card.dataset.type)));
  track.parentElement.querySelectorAll('.carousel-arrow').forEach(arrow => arrow.addEventListener('click', () => {
    track.scrollBy({ left: Number(arrow.dataset.scroll)*76, behavior: 'smooth' });
  }));
  const active = track.querySelector('.type-card.active');
  if (active) track.scrollLeft = active.offsetLeft - track.offsetLeft - (track.clientWidth - active.offsetWidth)/2;
  return track;
}
function setCarouselThumbnails(trackId, thumbnails) {
  document.querySelectorAll(`#${trackId} .type-card`).forEach(card => { card.querySelector('.thumb').style.backgroundImage = `url(${thumbnails[card.dataset.type]})`; });
}
function zoneTypeCarouselHtml(zoneType) {
  return typeCarouselHtml('ds-zonetype', 'Zone type', ZONE_TYPES, zoneType, zoneThumbnails);
}
function wireZoneTypeCarousel(panel, onPick) {
  if (!wireTypeCarousel(panel, 'ds-zonetype', onPick)) return;
  if (!zoneThumbnails && !zoneThumbnailsScheduled) {
    zoneThumbnailsScheduled = true;
    setTimeout(() => {
      zoneThumbnails = renderZoneThumbnails();
      setCarouselThumbnails('ds-zonetype', zoneThumbnails);
    }, 30);
  }
}
// Renders thumbnails between two frames: the real scene, lit by a fixed daytime sun with no weather. `render(snap)` builds
// each one somewhere far off the map and calls snap(camera) to capture it as an image.
function withThumbnailStudio(render) {
  const saved = { sunElevation: S.sunElevation, sunAzimuth: S.sunAzimuth, weatherRain: S.weatherRain, weatherSnow: S.weatherSnow, weatherClouds: S.weatherClouds, clear: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha() };
  S.sunElevation = 42; S.sunAzimuth = 35; S.weatherRain = S.weatherSnow = S.weatherClouds = 0;
  updateSun();
  const RENDER = THUMBNAIL_SIZE*2; // rendered at twice the size, then scaled down smoothly
  const target = new THREE.WebGLRenderTarget(RENDER, RENDER);
  const pixels = new Uint8Array(RENDER*RENDER*4);
  const full = document.createElement('canvas'), small = document.createElement('canvas');
  full.width = full.height = RENDER; small.width = small.height = THUMBNAIL_SIZE;
  const fullCtx = full.getContext('2d'), smallCtx = small.getContext('2d');
  smallCtx.imageSmoothingQuality = 'high';
  const snap = (camera) => {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x1b1e24, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, RENDER, RENDER, pixels);
    renderer.setRenderTarget(null);
    // the render target's rows run bottom to top
    const image = fullCtx.createImageData(RENDER, RENDER);
    for (let y=0;y<RENDER;y++) image.data.set(pixels.subarray((RENDER - 1 - y)*RENDER*4, (RENDER - y)*RENDER*4), y*RENDER*4);
    fullCtx.putImageData(image, 0, 0);
    smallCtx.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    smallCtx.drawImage(full, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    return small.toDataURL('image/jpeg', 0.88);
  };
  try { return render(snap); }
  finally {
    target.dispose();
    renderer.setClearColor(saved.clear, saved.clearAlpha);
    S.sunElevation = saved.sunElevation; S.sunAzimuth = saved.sunAzimuth;
    S.weatherRain = saved.weatherRain; S.weatherSnow = saved.weatherSnow; S.weatherClouds = saved.weatherClouds;
    updateSun();
  }
}
function renderZoneThumbnails() {
  const thumbnails = withThumbnailStudio(snap => {
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
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
      thumbnails[type.id] = snap(camera);
      scene.remove(group);
      disposeObject(group);
    });
    return thumbnails;
  });
  updateStats();
  return thumbnails;
}

// ============================================================ walkway texture carousel
// The same kind of carousel for a walkway's texture, each card a square sample of the texture seen from straight above in
// the walkway's own color (dirt as a strip across ground, so its soft edge shows). Kept per color for the session.
const walkwayThumbnails = new Map(); // color -> { texture id -> image }
function walkwayTextureCarouselHtml(texture, color) {
  const items = WALKWAY_TEXTURES.map(t => ({ ...t, color: '#' + new THREE.Color(color).getHexString() })); // (until the thumbnails are ready)
  return typeCarouselHtml('ds-walkwaytexture', 'Texture', items, texture, walkwayThumbnails.get(color));
}
function wireWalkwayTextureCarousel(panel, color, onPick) {
  if (!wireTypeCarousel(panel, 'ds-walkwaytexture', onPick) || walkwayThumbnails.has(color)) return;
  walkwayThumbnails.set(color, null); // (being rendered)
  setTimeout(() => {
    walkwayThumbnails.set(color, renderWalkwayThumbnails(color));
    if (panel.querySelector('#ds-walkwaytexture')) setCarouselThumbnails('ds-walkwaytexture', walkwayThumbnails.get(color));
  }, 30);
}
function renderWalkwayThumbnails(color) {
  return withThumbnailStudio(snap => {
    const SAMPLE = 8; // metres across
    const camera = new THREE.OrthographicCamera(-SAMPLE/2, SAMPLE/2, SAMPLE/2, -SAMPLE/2, 1, 100);
    camera.up.set(0, 0, -1);
    const thumbnails = {};
    WALKWAY_TEXTURES.forEach((texture, i) => {
      const cx = 41000 + i*50, cz = 41000;
      const group = new THREE.Group();
      const plane = (y, material) => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SAMPLE*1.25, SAMPLE*1.25).rotateX(-Math.PI/2), material);
        mesh.position.set(cx, y, cz);
        group.add(mesh);
      };
      const halfWidth = texture.id === 'dirt' ? SAMPLE*0.22 : 0;
      if (texture.id === 'dirt') plane(Y_ZONE_GROUND, new THREE.MeshStandardMaterial({ color: BUILDING_GROUND_COLORS[0], roughness: 1 }));
      plane(Y_PATH, makeWalkwayMaterial({ texture: texture.id, color, scale: 1, rotation: 0, halfWidth,
        segments: [[cx - SAMPLE, cz, cx + SAMPLE, cz]], fade: pathFadeWidth(halfWidth) }));
      scene.add(group);
      camera.position.set(cx, 50, cz);
      camera.lookAt(cx, 0, cz);
      thumbnails[texture.id] = snap(camera);
      scene.remove(group);
      disposeObject(group);
    });
    return thumbnails;
  });
}

Object.assign(App, { zoneTypeCarouselHtml, wireZoneTypeCarousel, walkwayTextureCarouselHtml, wireWalkwayTextureCarousel });
