import { S, App, setSandTint } from '../core/shared.js';
import { scene, updateSun, groundMat, setGridColor } from '../core/scene.js';
import { BUILDING_GROUND_COLORS, ROAD_COLOR, ROAD_COLOR_PALETTE, PARK_TINT_COLORS, TREE_TINT_COLORS, SAND_TINT_COLORS, DEFAULT_GRASS_NOISE_STRENGTH } from '../core/splines.js';
import { roadNodes, mapImages, DEFAULT_ZONE_SETTINGS } from '../core/state.js';
import { importMapImageFile, renderMapsList, removeMapImage } from '../maps/map-images.js';
import { SIDEWALK_COLOR, SIDEWALK_COLOR_PALETTE, disposeObject } from '../roads/roads.js';
import { DIRT_COLOR, WALKWAY_COLOR, WALKWAY_COLOR_PALETTE, WALKWAY_TEXTURE, isWalkwayLine, isRiverLine, rebuildRoadMeshes, walkwayTextureScaleOf } from '../roads/paths.js';
import { isTrainLine } from '../trains/trains.js';
import { rebuildZoneVisual } from '../zones/zone-visuals.js';
import { subdivideZone } from '../zones/cutouts.js';
import { renderHierarchy, renderWorldTintPanel } from '../ui/panels.js';
import { restoreObjects } from '../objects/objects.js';
import { cancelActiveDrawing, applyModeVisibility } from '../editor/tools.js';
import { savedFavorites, restoreFavorites } from '../ui/favorites.js';

// ============================================================ project save / load
const PROJECT_FORMAT_VERSION = 1;
function colorToHex(n, fallback) {
  const v = (n!=null ? n : fallback) >>> 0;
  return '#'+v.toString(16).padStart(6,'0');
}
function hexToColor(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const n = parseInt(s.replace('#',''),16);
  return Number.isFinite(n) ? n : fallback;
}
function serializePoint(p) {
  const withY = (out, src) => src.y!=null ? { ...out, y:src.y } : out; // only train nodes and handles have a height
  return withY({ x:p.x, z:p.z, type:p.type||'poly',
    handleIn: p.handleIn ? withY({x:p.handleIn.x, z:p.handleIn.z}, p.handleIn) : null,
    handleOut: p.handleOut ? withY({x:p.handleOut.x, z:p.handleOut.z}, p.handleOut) : null }, p);
}
export function serializeProject() {
  const finishedLines = S.roadLines.filter(l => !l.drawing);
  const usedNodeIds = new Set();
  finishedLines.forEach(l => l.nodeIds.forEach(id => usedNodeIds.add(id)));
  const nodes = {};
  usedNodeIds.forEach(id => { if (roadNodes[id]) nodes[id] = serializePoint(roadNodes[id]); });
  return {
    version: PROJECT_FORMAT_VERSION,
    app: 'blockout',
    exportedAt: new Date().toISOString(),
    scene: {
      groundColor: colorToHex(groundMat.color.getHex()),
      gridColor: document.getElementById('s-gridcolor').value,
      sunElevation: S.sunElevation, sunAzimuth: S.sunAzimuth,
      defaultRoadWidth: S.DEFAULT_ROAD_WIDTH,
      defaultSidewalkWidth: S.DEFAULT_SIDEWALK_WIDTH,
      defaultTrainHeight: S.TRAIN_DEFAULT_HEIGHT,
      defaultTrainRadius: S.TRAIN_DEFAULT_RADIUS,
      trainCoilTurnsPer10: S.TRAIN_COIL_TURNS_PER_10,
      groundColorPalette: BUILDING_GROUND_COLORS.map(c => colorToHex(c)),
      roadColorPalette: ROAD_COLOR_PALETTE.map(c => colorToHex(c)),
      sidewalkColorPalette: SIDEWALK_COLOR_PALETTE.map(c => colorToHex(c)),
      walkwayColorPalette: WALKWAY_COLOR_PALETTE.map(c => colorToHex(c)),
      parkTintPalette: PARK_TINT_COLORS.map(c => colorToHex(c)),
      treeTintPalette: TREE_TINT_COLORS.map(c => colorToHex(c)),
      sandTintPalette: SAND_TINT_COLORS.map(c => colorToHex(c)),
      globalParkTint: colorToHex(S.globalParkTint, PARK_TINT_COLORS[0]),
      globalTreeTint: colorToHex(S.globalTreeTint, TREE_TINT_COLORS[0]),
      globalSandTint: colorToHex(S.globalSandTint, SAND_TINT_COLORS[0]),
      globalGrassNoiseStrength: S.globalGrassNoiseStrength,
      people: { enabled: S.peopleEnabled, amount: S.peopleAmount, speed: S.peopleSpeed, size: S.peopleSize, traffic: S.trafficAmount, idSeq: S.peopleIdSeq },
      dayNight: { enabled: S.dayNightEnabled, dayLength: S.dayLengthMinutes, time: S.timeOfDay },
      weather: { rain: S.weatherRain, snow: S.weatherSnow, clouds: S.weatherClouds }
    },
    favorites: savedFavorites(), // (only those that can be found again in a reloaded city: see ui/favorites.js)
    roads: {
      nodeSeq: S.roadNodeSeq, lineSeq: S.roadLineSeq, networkSeq: S.roadNetworkSeq,
      walkwayOrder: (S.walkwayOrder || []).slice(), // (defensively: same fallback loadProjectFromData below already uses on the way back in)
      nodes,
      lines: finishedLines.map(l => ({ id:l.id, nodeIds:l.nodeIds.slice(), width:l.width,
        color: colorToHex(l.color, ROAD_COLOR), sidewalkWidth:l.sidewalkWidth,
        sidewalkColor: colorToHex(l.sidewalkColor, SIDEWALK_COLOR), networkId:l.networkId,
        ...(isTrainLine(l) ? { kind:'train', radius:l.radius } : {}), ...(isWalkwayLine(l) ? { roadType:'walkway', walkwayColor: colorToHex(l.walkwayColor, WALKWAY_COLOR), walkwayTexture: l.walkwayTexture || WALKWAY_TEXTURE, walkwayTextureScale: walkwayTextureScaleOf(l), walkwayTextureRotation: l.walkwayTextureRotation ?? 0 } : {}), ...(isRiverLine(l) ? { roadType:'river' } : {}) }))
    },
    zoneSeq: S.zoneSeq,
    zones: S.zones.filter(z => !z.drawing && z.points.length>=3).map(z => ({
      id:z.id, name:z.name, closed:!!z.closed, zoneType: z.zoneType||'buildings',
      points: z.points.map(serializePoint),
      settings: { ...z.settings, groundColor: colorToHex(z.settings.groundColor, BUILDING_GROUND_COLORS[0]) }
    })),
    objectSeq: S.objectSeq,
    // what was put down by hand in the Objects tab: the record only, since its seed builds the thing itself back (objects.js)
    objects: S.objects.map(o => ({ id:o.id, type:o.type, x:o.x, z:o.z, rotY:o.rotY, scale:o.scale, seed:o.seed })),
    mapImageSeq: S.mapImageSeq,
    mapImages: mapImages.map(m => ({
      id:m.id, name:m.name, dataUrl:m.dataUrl,
      position:{ x:m.mesh.position.x, z:m.mesh.position.z },
      rotationY:m.mesh.rotation.y, scale:m.mesh.scale.x, visible:m.mesh.visible
    }))
  };
}
// Saves a file to the viewer. Uses the Artifact "downloads" capability when
// running as a published Claude artifact (window.claude.use exists); falls
// back to a plain <a download> for local/self-hosted use.
export async function downloadFile(filename, blob) {
  if (window.claude && typeof window.claude.use === 'function') {
    try {
      const downloads = await window.claude.use('downloads');
      if (downloads) {
        await downloads.save({ filename, data: blob });
        return;
      }
    } catch (err) {
      if (err && err.code === 'declined') return;
      console.warn('downloads capability failed, falling back to <a download>', err);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function saveProject() {
  const data = serializeProject();
  const blob = new Blob([JSON.stringify(data)], { type:'application/json' });
  await downloadFile('blockout_project.json', blob);
}
async function restoreMapImages(list) {
  for (const im of (list||[])) {
    try {
      const blob = await fetch(im.dataUrl).then(r=>r.blob());
      const file = new File([blob], im.name||'image', { type: blob.type||'image/png' });
      await new Promise(resolve => {
        importMapImageFile(file, {
          id: im.id, name: im.name, position: im.position, rotationY: im.rotationY,
          scale: im.scale, visible: im.visible, skipSelect: true, onDone: resolve
        });
      });
    } catch (err) { console.error('Blockout: failed to restore map image', im && im.name, err); }
  }
}
// `options.keepMaps`: leave the map images as they are (used by undo and redo, whose snapshots don't include them)
export async function loadProjectFromData(data, options) {
  const keepMaps = !!(options && options.keepMaps);
  if (!keepMaps) App.hushMorality?.(); // (a project coming in isn't something to announce on the morality meter; undo is)
  // wipe current scene (roads, zones, map images, selection) before restoring
  cancelActiveDrawing();
  S.roadLines = []; Object.keys(roadNodes).forEach(k => delete roadNodes[k]);
  S.zones.forEach(z => { if (z.outlineGroup) { scene.remove(z.outlineGroup); disposeObject(z.outlineGroup); } if (z.buildingsGroup) { scene.remove(z.buildingsGroup); disposeObject(z.buildingsGroup); } });
  S.zones = [];
  if (!keepMaps) mapImages.slice().forEach(m => removeMapImage(m.id));
  S.selection = { type:null, id:null };
  S.colorPickerState = null;

  const sc = data.scene || {};
  if (sc.groundColor) { groundMat.color.set(sc.groundColor); document.getElementById('s-groundcolor').value = sc.groundColor; }
  if (sc.gridColor) { setGridColor(sc.gridColor); document.getElementById('s-gridcolor').value = sc.gridColor; }
  if (sc.sunElevation!=null) { S.sunElevation = sc.sunElevation; document.getElementById('s-sunelev').value = S.sunElevation; document.getElementById('dv-sunelev').textContent = S.sunElevation; }
  if (sc.sunAzimuth!=null) { S.sunAzimuth = sc.sunAzimuth; document.getElementById('s-sunazim').value = S.sunAzimuth; document.getElementById('dv-sunazim').textContent = S.sunAzimuth; }
  updateSun();
  if (sc.defaultRoadWidth!=null) S.DEFAULT_ROAD_WIDTH = sc.defaultRoadWidth;
  if (sc.defaultSidewalkWidth!=null) S.DEFAULT_SIDEWALK_WIDTH = sc.defaultSidewalkWidth;
  if (sc.defaultTrainRadius!=null) S.TRAIN_DEFAULT_RADIUS = sc.defaultTrainRadius;
  if (sc.trainCoilTurnsPer10!=null) {
    S.TRAIN_COIL_TURNS_PER_10 = sc.trainCoilTurnsPer10;
    document.getElementById('s-coilfreq').value = S.TRAIN_COIL_TURNS_PER_10;
    document.getElementById('v-coilfreq').textContent = S.TRAIN_COIL_TURNS_PER_10.toFixed(2);
  }
  if (sc.defaultTrainHeight!=null) {
    S.TRAIN_DEFAULT_HEIGHT = sc.defaultTrainHeight;
    document.getElementById('s-trainheight').value = S.TRAIN_DEFAULT_HEIGHT;
    document.getElementById('v-trainheight').textContent = S.TRAIN_DEFAULT_HEIGHT;
  }
  if (Array.isArray(sc.groundColorPalette) && sc.groundColorPalette.length) {
    BUILDING_GROUND_COLORS.length = 0;
    sc.groundColorPalette.forEach(hex => BUILDING_GROUND_COLORS.push(hexToColor(hex, 0x6b6e73)));
  }
  if (Array.isArray(sc.roadColorPalette) && sc.roadColorPalette.length) {
    ROAD_COLOR_PALETTE.length = 0;
    sc.roadColorPalette.forEach(hex => ROAD_COLOR_PALETTE.push(hexToColor(hex, ROAD_COLOR)));
  }
  if (Array.isArray(sc.sidewalkColorPalette) && sc.sidewalkColorPalette.length) {
    SIDEWALK_COLOR_PALETTE.length = 0;
    sc.sidewalkColorPalette.forEach(hex => SIDEWALK_COLOR_PALETTE.push(hexToColor(hex, SIDEWALK_COLOR)));
  }
  if (Array.isArray(sc.walkwayColorPalette) && sc.walkwayColorPalette.length) {
    WALKWAY_COLOR_PALETTE.length = 0;
    sc.walkwayColorPalette.forEach(hex => WALKWAY_COLOR_PALETTE.push(hexToColor(hex, WALKWAY_COLOR)));
  }
  // older saves had dirt paths as a path type of their own, with their own palette: it joins the walkway one
  if (Array.isArray(sc.pathColorPalette)) sc.pathColorPalette.forEach(hex => {
    const color = hexToColor(hex, DIRT_COLOR);
    if (!WALKWAY_COLOR_PALETTE.includes(color)) WALKWAY_COLOR_PALETTE.push(color);
  });
  if (Array.isArray(sc.parkTintPalette) && sc.parkTintPalette.length) {
    PARK_TINT_COLORS.length = 0;
    sc.parkTintPalette.forEach(hex => PARK_TINT_COLORS.push(hexToColor(hex, 0xffffff)));
  }
  if (Array.isArray(sc.treeTintPalette) && sc.treeTintPalette.length) {
    TREE_TINT_COLORS.length = 0;
    sc.treeTintPalette.forEach(hex => TREE_TINT_COLORS.push(hexToColor(hex, 0xffffff)));
  }
  if (Array.isArray(sc.sandTintPalette) && sc.sandTintPalette.length) {
    SAND_TINT_COLORS.length = 0;
    sc.sandTintPalette.forEach(hex => SAND_TINT_COLORS.push(hexToColor(hex, 0xffffff)));
  }
  S.globalParkTint = hexToColor(sc.globalParkTint, PARK_TINT_COLORS[0]);
  S.globalTreeTint = hexToColor(sc.globalTreeTint, TREE_TINT_COLORS[0]);
  setSandTint(hexToColor(sc.globalSandTint, SAND_TINT_COLORS[0])); // projects saved before the sand tint existed fall back to the default gold

  S.globalGrassNoiseStrength = sc.globalGrassNoiseStrength!=null ? sc.globalGrassNoiseStrength : DEFAULT_GRASS_NOISE_STRENGTH;
  document.getElementById('s-grassnoise').value = S.globalGrassNoiseStrength;
  document.getElementById('dv-grassnoise').textContent = S.globalGrassNoiseStrength.toFixed(2);
  renderWorldTintPanel();
  if (!keepMaps) restoreFavorites(data.favorites); // (undo and redo leave the favorites alone: they aren't steps to undo)
  if (sc.people) {
    S.peopleEnabled = !!sc.people.enabled;
    if (sc.people.amount != null) S.peopleAmount = sc.people.amount;
    if (sc.people.speed != null) S.peopleSpeed = sc.people.speed;
    if (sc.people.size != null) S.peopleSize = sc.people.size;
    if (sc.people.traffic != null) S.trafficAmount = sc.people.traffic;
    // never lower: undo/redo also comes through here, and the live crowd (not itself a saved/undoable thing) may
    // already have handed out ids past whatever this particular save remembers
    S.peopleIdSeq = Math.max(S.peopleIdSeq, sc.people.idSeq || 1);
    App.syncPeopleUI();
  }
  if (sc.weather) {
    S.weatherRain = sc.weather.rain || 0; S.weatherSnow = sc.weather.snow || 0;
    App.setWeather('clouds', sc.weather.clouds || 0); // also applies the rain and snow to the light and sky
  }
  if (sc.dayNight) {
    S.dayNightEnabled = !!sc.dayNight.enabled;
    if (sc.dayNight.dayLength != null) S.dayLengthMinutes = sc.dayNight.dayLength;
    if (sc.dayNight.time != null) S.timeOfDay = sc.dayNight.time;
    if (S.dayNightEnabled) App.applyTimeOfDay(false);
  }
  App.syncSkyUI();

  const rd = data.roads || {};
  const withY = (out, src) => src.y!=null ? { ...out, y:src.y } : out; // only train nodes and handles have a height
  Object.keys(rd.nodes||{}).forEach(id => {
    const n = rd.nodes[id];
    roadNodes[id] = withY({ x:n.x, z:n.z, type:n.type||'poly',
      handleIn: n.handleIn ? withY({x:n.handleIn.x, z:n.handleIn.z}, n.handleIn) : null,
      handleOut: n.handleOut ? withY({x:n.handleOut.x, z:n.handleOut.z}, n.handleOut) : null }, n);
  });
  S.roadLines = (rd.lines||[]).map(l => ({ id:l.id, nodeIds:l.nodeIds.slice(), width:l.width,
    color: hexToColor(l.color, ROAD_COLOR), sidewalkWidth: l.sidewalkWidth!=null ? l.sidewalkWidth : S.DEFAULT_SIDEWALK_WIDTH,
    sidewalkColor: hexToColor(l.sidewalkColor, SIDEWALK_COLOR), networkId:l.networkId, drawing:false,
    ...(l.kind==='train' ? { kind:'train', radius: l.radius!=null ? l.radius : S.TRAIN_DEFAULT_RADIUS } : {}),
    ...(l.roadType==='path' ? { roadType:'walkway', walkwayColor: hexToColor(l.pathColor, DIRT_COLOR), walkwayTexture:'dirt', walkwayTextureScale:1, walkwayTextureRotation:0 } : {}), // (older saves' dirt paths)
    ...(l.roadType==='walkway' ? { roadType:'walkway', walkwayColor: hexToColor(l.walkwayColor, WALKWAY_COLOR),
      walkwayTexture: l.walkwayTexture || WALKWAY_TEXTURE, walkwayTextureScale: l.walkwayTextureScale ?? 1, walkwayTextureRotation: l.walkwayTextureRotation ?? 0 } : {}),
    ...(l.roadType==='river' ? { roadType:'river' } : {}) }));
  S.roadNodeSeq = rd.nodeSeq || 1; S.roadLineSeq = rd.lineSeq || 1; S.roadNetworkSeq = rd.networkSeq || 1;
  S.walkwayOrder = Array.isArray(rd.walkwayOrder) ? rd.walkwayOrder.slice() : [];
  rebuildRoadMeshes();

  (data.zones||[]).forEach(zd => {
    const zone = {
      id: zd.id, name: zd.name, closed: !!zd.closed, drawing:false, zoneType: zd.zoneType||'buildings',
      points: (zd.points||[]).map(p => ({ x:p.x, z:p.z, type:p.type||'poly',
        handleIn: p.handleIn ? {x:p.handleIn.x, z:p.handleIn.z} : null,
        handleOut: p.handleOut ? {x:p.handleOut.x, z:p.handleOut.z} : null })),
      settings: { ...DEFAULT_ZONE_SETTINGS, ...(zd.settings||{}) }
    };
    zone.settings.groundColor = hexToColor(zd.settings && zd.settings.groundColor, BUILDING_GROUND_COLORS[0]);
    S.zones.push(zone);
    rebuildZoneVisual(zone);
  });
  // only once every zone is in: a zone's beaches and fences depend on the zones below it too, not just the ones above
  S.zones.forEach(subdivideZone);
  S.zoneSeq = data.zoneSeq || 1;
  restoreObjects(data.objects);
  S.objectSeq = data.objectSeq || 1;
  if (!keepMaps) {
    S.mapImageSeq = data.mapImageSeq || 1;
    await restoreMapImages(data.mapImages);
    App.scheduleHistory(0); // loading a project is a step you can undo
  }

  applyModeVisibility();
  renderHierarchy();
  renderMapsList();
  if (!keepMaps) App.hushMorality?.();
}
function loadProject(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    let data;
    try { data = JSON.parse(ev.target.result); }
    catch (err) { alert('That file isn\'t valid Blockout project JSON.'); return; }
    if (!data || typeof data !== 'object' || !data.roads || !data.zones) {
      alert('That file doesn\'t look like a Blockout project.'); return;
    }
    loadProjectFromData(data);
  };
  reader.readAsText(file);
}
document.getElementById('btn-save-project').addEventListener('click', saveProject);
document.getElementById('btn-load-project').addEventListener('click', () => {
  document.getElementById('project-file-input').click();
});
document.getElementById('project-file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) loadProject(file);
  e.target.value = '';
});
