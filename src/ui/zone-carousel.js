import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, renderer, updateSun, sun, sunOffset, ground, Y_ZONE_GROUND, Y_PATH } from '../core/scene.js';
import { BUILDING_GROUND_COLORS, ROAD_COLOR } from '../core/splines.js';
import { DEFAULT_ZONE_SETTINGS, roadNodes } from '../core/state.js';
import { createMeshBuilder, disposeObject, clipPolygons, CLIPPER_SCALE, SIDEWALK_COLOR } from '../roads/roads.js';
import { makeFlatZoneMesh } from '../zones/surface-detail.js';
import { WATER_COLOR, WATER_LEVEL, WATER_BANK_TOP, WATER_BANK_BOTTOM, WATER_BANK_COLOR, applyWaterShader } from '../water/water.js';
import { WALKWAY_TEXTURES, WALKWAY_COLOR, makeWalkwayMaterial, pathFadeWidth, defaultWalkwayTextureScale, rebuildRoadMeshes } from '../roads/paths.js';
import { PATH_TYPES } from '../trains/trains.js';
import { RAISED_HEIGHT } from '../roads/raised.js';
import { stillLoading } from './loading.js';
import { toClipperPath, subdivideZone } from '../zones/cutouts.js';
import { updateStats } from './panels.js';

// ============================================================ zone type carousel
// A zone's type is picked from a carousel of cards rather than a dropdown, each card showing what that type looks like. The
// thumbnails are rendered by the app itself, the first time they're needed: for each type, a square zone is generated
// far off the map with the real generator (water, which is built with all the other water, gets a pond cut into a patch
// of ground instead), lit by a fixed daytime sun with no weather, and rendered from above at an angle into an image. It
// all happens between two frames, so the view never flickers, and the images are kept for the rest of the session.
const ZONE_TYPES = [ // `thumb` seeds each one's thumbnail (the order they used to come in, which picked the ones they have)
  { id: 'plain', label: 'Plain', color: '#5d6068', thumb: 1 }, { id: 'park', label: 'Park', color: '#8fb85a', thumb: 2 },
  { id: 'water', label: 'Water', color: '#1d6f7d', thumb: 4 }, { id: 'beach', label: 'Beach', color: '#d9c48f', thumb: 3 },
  { id: 'farmland', label: 'Farmland', color: '#c9b75c', thumb: 6 }, { id: 'suburbs', label: 'Suburbs', color: '#8a9a6d', thumb: 8 },
  { id: 'town', label: 'Town', color: '#8e4a36', thumb: 9 }, { id: 'plaza', label: 'Plaza', color: '#b7b0a4', thumb: 5 },
  { id: 'buildings', label: 'City', color: '#6d717c', thumb: 0 }, { id: 'industrial', label: 'Industrial', color: '#7d8187', thumb: 7 },
  { id: 'airport', label: 'Airport', color: '#6f7a80', thumb: 10 },
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
// each one somewhere far off the map and calls snap(camera) to capture it as an image. (The objects palette's too.)
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
    const VIEW = 40; // half the width it takes in, small enough that the patch below fills it from corner to corner
    const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 1, 1000);
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
        // an airport gets a long field, so its runway runs straight along it with room for a terminal beside it
        const points = type.id === 'airport' ? [{ x: cx-380, z: cz-140 }, { x: cx+380, z: cz-140 }, { x: cx+380, z: cz+140 }, { x: cx-380, z: cz+140 }].map(p => ({ ...p, type: 'poly' })) : square(half);
        const zone = { id: '__thumbnail-' + type.id, name: type.label, zoneType: type.id, closed: true, drawing: false, points,
          settings: { ...DEFAULT_ZONE_SETTINGS, seed: 4242 + type.thumb, lotCount: 14, fieldCount: 9, industrialLots: 7, suburbPlots: 9, treeDensity: 0.5, plazaTrees: 0.6, ...(type.id === 'town' && { seed: 1, townPaint: 0.7, townLots: 40, townStoreysMin: 1, townStoreysMax: 5 }) } };
        subdivideZone(zone);
        group = zone.buildingsGroup;
      }
      // what it looks at: the middle of the patch, but closer in on a plaza's fountain, and at an airport the terminal
      // and the edge of the runway in front of it
      let fx = cx, fz = cz, view = VIEW;
      if (type.id === 'town') { view = 26; fx += 15; fz += 15; } // in among the street fronts, filling the frame
      if (type.id === 'plaza') { view = 16; fx -= 1.8; fz -= 1.8; } // nudged so the fountain sits mid-frame
      if (type.id === 'airport') {
        const terminal = group.children.find(c => c.userData.buildingKind === 'terminal');
        if (terminal) { const at = new THREE.Box3().setFromObject(terminal).getCenter(new THREE.Vector3()); fx = at.x; fz = THREE.MathUtils.lerp(at.z, cz, 0.35); }
        view = 85;
      }
      camera.left = camera.bottom = -view; camera.right = camera.top = view;
      camera.updateProjectionMatrix();
      camera.position.set(fx + 200, type.id === 'town' ? 120 : 230, fz + 200); // an isometric-ish view from the south-east
      camera.lookAt(fx, 2, fz);
      // the sun's shadows only follow the main view (placeSunLight), so bring them here for the shot
      sun.target.position.set(fx, 0, fz);
      sun.target.updateMatrixWorld();
      sun.position.set(fx + sunOffset.x, sunOffset.y, fz + sunOffset.z);
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
      plane(Y_PATH, makeWalkwayMaterial({ texture: texture.id, color, scale: defaultWalkwayTextureScale(texture.id), rotation: 0, halfWidth, // each sample at the size that texture starts at
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

// ============================================================ path type carousel
// The Paths tab's type (see editor/tools.js) is picked from the same kind of carousel. Each thumbnail is a stretch of the
// real thing: a sample line of each type is added far off the map and the paths rebuilt around it, shot, and taken away
// again, the paths rebuilt as they were (a river, drawn with the rest of the water a frame later, is cut into the ground
// by hand instead, like the water zone's pond). Only once models are in, so the raised walkway has its trees.
let pathThumbnails = null, pathThumbnailsScheduled = false;
function pathTypeCarouselHtml(type) {
  return typeCarouselHtml('ds-pathtype', 'Path type', PATH_TYPES, type, pathThumbnails);
}
function wirePathTypeCarousel(panel, onPick) {
  if (!wireTypeCarousel(panel, 'ds-pathtype', onPick) || pathThumbnails || pathThumbnailsScheduled) return;
  pathThumbnailsScheduled = true;
  const render = () => {
    if (stillLoading()) { setTimeout(render, 500); return; }
    pathThumbnails = renderPathThumbnails();
    setCarouselThumbnails('ds-pathtype', pathThumbnails);
  };
  setTimeout(render, 30);
}
// moves the carousel in `panel` on to `type`, without making it again
function syncPathTypeCarousel(panel, type) {
  const track = panel.querySelector('#ds-pathtype');
  if (!track) return;
  track.querySelectorAll('.type-card').forEach(card => card.classList.toggle('active', card.dataset.type===type));
  panel.querySelector('.val').textContent = PATH_TYPES.find(t => t.id===type).label;
  const active = track.querySelector('.type-card.active');
  if (active && (active.offsetLeft < track.scrollLeft || active.offsetLeft + active.offsetWidth > track.scrollLeft + track.clientWidth))
    track.scrollTo({ left: active.offsetLeft - track.offsetLeft - (track.clientWidth - active.offsetWidth)/2, behavior: 'smooth' });
}
function renderPathThumbnails() {
  const saved = { waterDirty: S.waterDirty, peopleNavDirty: S.peopleNavDirty, trafficNavDirty: S.trafficNavDirty, walkwayOrder: S.walkwayOrder.slice() };
  const x0 = 42000, z0 = 42000, SPACING = 400, REACH = 120; // each sample runs straight along z (bottom left to top right in its
  // shot), well past the shot's edges
  const sample = i => ({ cx: x0 + i*SPACING, cz: z0 });
  const tempNodes = [], tempLines = [];
  PATH_TYPES.forEach((type, i) => {
    if (type.id === 'river') return;
    const { cx, cz } = sample(i), isTrain = type.id === 'train';
    const ids = [-REACH, REACH].map((dx, k) => {
      const id = `__thumbnail-${type.id}-${k}`;
      roadNodes[id] = { x: cx, z: cz + dx, type: 'poly', handleIn: null, handleOut: null, ...(isTrain && { y: S.TRAIN_DEFAULT_HEIGHT }) };
      tempNodes.push(id);
      return id;
    });
    const networkId = '__thumbnail-' + type.id;
    tempLines.push(isTrain ? { id: networkId, kind: 'train', nodeIds: ids, radius: S.TRAIN_DEFAULT_RADIUS, networkId }
      : { id: networkId, nodeIds: ids, width: S.DEFAULT_ROAD_WIDTH, color: ROAD_COLOR, sidewalkWidth: S.DEFAULT_SIDEWALK_WIDTH, sidewalkColor: SIDEWALK_COLOR,
        roadType: type.id, walkwayColor: WALKWAY_COLOR, networkId, ...(type.id === 'walkway' && { walkwayTexture: 'brick', walkwayColor: 0xb4623f }), // (terracotta brick)
        ...(type.id === 'raised' && { raisedTrees: true, raisedBenches: true, raisedLights: true }) });
  });
  const restore = () => {
    tempNodes.forEach(id => { delete roadNodes[id]; });
    S.roadLines = S.roadLines.filter(l => !tempLines.includes(l));
    rebuildRoadMeshes();
    Object.assign(S, saved);
  };
  S.roadLines.push(...tempLines);
  let thumbnails;
  try {
    rebuildRoadMeshes();
    S.roadMarkerGroup.visible = S.roadHandleGroup.visible = false; // (drawn over everything, even out here)
    thumbnails = withThumbnailStudio(snap => {
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
      const shots = {};
      // the ground, with the sunk road surfaces (and the river) cut out of it as the real ground has
      const C = CLIPPER_SCALE, rect = (l, t, r, b) => [{ X: l*C, Y: t*C }, { X: r*C, Y: t*C }, { X: r*C, Y: b*C }, { X: l*C, Y: b*C }];
      const riverAt = sample(PATH_TYPES.findIndex(t => t.id === 'river')), riverHalf = S.DEFAULT_ROAD_WIDTH;
      const groundTops = createMeshBuilder();
      groundTops.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, [rect(x0 - SPACING, z0 - SPACING, x0 + PATH_TYPES.length*SPACING, z0 + SPACING)],
        S.roadSurfaceOutline.concat([rect(riverAt.cx - riverHalf, riverAt.cz - REACH, riverAt.cx + riverHalf, riverAt.cz + REACH)]), true), 0);
      const studio = new THREE.Group();
      studio.add(new THREE.Mesh(groundTops.build(), ground.material));
      scene.add(studio);
      PATH_TYPES.forEach((type, i) => {
        const { cx, cz } = sample(i);
        let river = null;
        if (type.id === 'river') {
          // a straight river cut into ground, its banks either side
          river = new THREE.Group();
          const hw = riverHalf, a = cz - REACH, b = cz + REACH;
          const shore = [[cx - hw, b, cx - hw, a], [cx + hw, a, cx + hw, b]];
          const waterMat = new THREE.MeshStandardMaterial({ color: WATER_COLOR, roughness: 1 });
          applyWaterShader(waterMat, shore, [], 0);
          const surface = new THREE.Mesh(new THREE.PlaneGeometry(hw*2, REACH*2).rotateX(-Math.PI/2), waterMat);
          surface.position.set(cx, WATER_LEVEL, cz);
          const banks = createMeshBuilder();
          shore.forEach(([ax, az, bx, bz]) => {
            const nx = -(bz - az)/(REACH*2), nz = (bx - ax)/(REACH*2); // pointing into the river
            banks.addQuad({ x: ax, y: WATER_BANK_TOP, z: az }, { x: bx, y: WATER_BANK_TOP, z: bz }, { x: bx, y: WATER_BANK_BOTTOM, z: bz }, { x: ax, y: WATER_BANK_BOTTOM, z: az }, { x: nx, y: 0, z: nz });
          });
          river.add(surface, new THREE.Mesh(banks.build(), new THREE.MeshStandardMaterial({ color: WATER_BANK_COLOR, roughness: 0.95 })));
          scene.add(river);
        }
        // how much it takes in (half the shot's width), close enough that the path fills most of it, and the height it's centered
        // on: the deck of a raised walkway, a train line's tube
        const VIEWS = { sidewalk: 9, walkway: 7.5, raised: 8, river: 11, train: 9 };
        const isTrain = type.id === 'train', view = VIEWS[type.id], fy = isTrain ? S.TRAIN_DEFAULT_HEIGHT : type.id === 'raised' ? RAISED_HEIGHT : 0;
        camera.left = camera.bottom = -view; camera.right = camera.top = view;
        camera.updateProjectionMatrix();
        camera.position.set(cx + 120, fy + 140, cz + 160); // from the south-east, like the zones' — the path running across it
        camera.lookAt(cx, fy, cz);
        sun.target.position.set(cx, 0, cz);
        sun.target.updateMatrixWorld();
        sun.position.set(cx + sunOffset.x, sunOffset.y, cz + sunOffset.z);
        shots[type.id] = snap(camera);
        if (river) { scene.remove(river); disposeObject(river); }
      });
      scene.remove(studio);
      studio.children[0].geometry.dispose(); // (the material is the real ground's)
      return shots;
    });
  } finally { restore(); }
  return thumbnails;
}

Object.assign(App, { withThumbnailStudio, zoneTypeCarouselHtml, wireZoneTypeCarousel, walkwayTextureCarouselHtml, wireWalkwayTextureCarousel,
  pathTypeCarouselHtml, wirePathTypeCarousel, syncPathTypeCarousel });
