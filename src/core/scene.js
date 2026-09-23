import * as THREE from 'three';
import { S, App } from './shared.js';
import { IS_TOUCH } from './device.js';

// ============================================================ renderer / scene
const wrap = document.getElementById('canvas-wrap');
// Every color in the app was tuned by eye as a raw value, the way three.js used to treat them, so color management stays
// off (and the renderer's output linear, below) — otherwise hex colors would be converted from sRGB and everything would
// render lighter. This has to happen before any color is made.
THREE.ColorManagement.enabled = false;
// Likewise the light intensities were tuned for three.js's old "legacy" lighting, which newer versions dropped: the same
// look now takes intensities π times higher.
const LIGHT_INTENSITY_SCALE = Math.PI;
// And the sky reflection map (SKY_ENV_MAP, below) used to add only reflections, not light: three.js now also lights
// every surface that has an envMap with the whole sky, which on top of the hemisphere light washed buildings and water
// out to white. Take that diffuse part back out of the shader so envMaps are reflections again.
THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');

export const scene = new THREE.Scene();
const bgColor = 0x12141a;
scene.background = null;
scene.fog = new THREE.Fog(bgColor, 600, 2800);

// The view is drawn through one of two cameras, swapped by the projection button in the canvas tools: the perspective
// one, and an orthographic one that flattens the city out the way a plan or an elevation does. Everything else reads
// `camera` at the moment it draws or picks, so the live export below is enough to swap it under them — nothing keeps a
// camera of its own.
const perspectiveCamera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.5, 3000);
const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 3000);
export let camera = perspectiveCamera;
export function isOrthographic() { return camera === orthographicCamera; }
export function setProjection(mode) {
  const next = mode==='ortho' ? orthographicCamera : perspectiveCamera;
  if (next === camera) return;
  next.position.copy(camera.position);
  next.quaternion.copy(camera.quaternion);
  next.near = camera.near; next.far = camera.far;
  camera = next;
}
// How tall a slice of the world the perspective camera frames at a given distance — which is what the orthographic
// camera's frustum is sized to (see camera-controls.js), so switching projection keeps the city the same size on screen.
export function frustumHalfHeightAt(distance) { return distance * Math.tan(perspectiveCamera.fov*Math.PI/360); }
// The distance a thing has to be drawn as, to come out the size it does on screen: its own distance under perspective,
// and — since nothing shrinks with distance in an orthographic view — the same for everything under orthographic (see
// nodeUiScaleAt, which keeps the node handles a steady size).
export function apparentDistance(cam, position) {
  return cam.isOrthographicCamera ? cam.top / Math.tan(perspectiveCamera.fov*Math.PI/360) : cam.position.distanceTo(position);
}
// the stencil buffer is off by default now, and the water and road masks need it (see SKIP_OVER_WATER_AND_ROADS)
// (and an alpha channel, for the holes cut through to the page behind: see setCutout in pixelation.js)
export const renderer = new THREE.WebGLRenderer({ antialias:true, stencil:true, alpha:true });
// phones and tablets draw the same scene on a much smaller GPU, so they render at a lower ratio (and with a smaller
// shadow map below) — at that size the difference is hard to see, and it's the difference between smooth and not
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // (soft-edged now — PCFSoftShadowMap was folded into it)
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
wrap.appendChild(renderer.domElement);
window.addEventListener('resize', () => {
  perspectiveCamera.aspect = window.innerWidth/window.innerHeight;
  perspectiveCamera.updateProjectionMatrix();   // (the orthographic frustum is sized every frame, in camera-controls.js)
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hemi = new THREE.HemisphereLight(0x8fa3b3, 0x23262c, 0.9);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff2df, 1.1);
sun.position.set(150, 220, 100);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
sun.shadow.camera.left = -300; sun.shadow.camera.right = 300;
sun.shadow.camera.top = 300; sun.shadow.camera.bottom = -300;
sun.shadow.camera.far = 800;
sun.shadow.bias = -0.0005;
scene.add(sun);

// ---- procedural sky dome, driven by sun elevation/azimuth ----
const skyDomeMat = new THREE.ShaderMaterial({
  uniforms: {
    sunDirection: { value: new THREE.Vector3(0,1,0) },
    topColor: { value: new THREE.Color(0x2f7fd0) },
    horizonColor: { value: new THREE.Color(0xdfefff) },
    sunColor: { value: new THREE.Color(0xffffff) },
    starAmount: { value: 0 },
  },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vDir;
    uniform vec3 sunDirection;
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 sunColor;
    uniform float starAmount;
    void main() {
      vec3 dir = normalize(vDir);
      float h = clamp(dir.y, -1.0, 1.0);
      vec3 col;
      if (h > 0.0) {
        col = mix(horizonColor, topColor, pow(h, 0.55));
      } else {
        col = mix(horizonColor, horizonColor*0.35, pow(-h, 0.4));
      }
      float sunAmount = max(dot(dir, normalize(sunDirection)), 0.0);
      col += sunColor * pow(sunAmount, 380.0) * 2.0;
      col += sunColor * pow(sunAmount, 24.0) * 0.25;
      // stars, once it's dark enough: a sparse scatter of directions, fading out towards the horizon
      if (starAmount > 0.0 && h > 0.0) {
        vec3 cell = floor(dir * 240.0);
        float r = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        col += vec3(step(0.9972, r) * starAmount * smoothstep(0.0, 0.3, h) * (0.6 + 0.4*fract(r*97.0)));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
});
export const skyDome = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), skyDomeMat);
skyDome.renderOrder = -1000;
scene.add(skyDome);

const SKY_KEYFRAMES = [
  { e:-90, top:0x03040a, horizon:0x05070f, sun:0x1c2438 },
  { e:-8,  top:0x0c1633, horizon:0x24304f, sun:0x8898bb },
  { e:0,   top:0x1c2c58, horizon:0xff8f5c, sun:0xffb37a },
  { e:10,  top:0x3768a8, horizon:0xffe0b0, sun:0xfff0d0 },
  { e:35,  top:0x4f97dd, horizon:0xd8ecff, sun:0xffffff },
  { e:90,  top:0x3a86d6, horizon:0xe8f4ff, sun:0xffffff },
];
function computeSkyColors(elevDeg) {
  let i = 0;
  while (i<SKY_KEYFRAMES.length-1 && elevDeg>SKY_KEYFRAMES[i+1].e) i++;
  const a = SKY_KEYFRAMES[i], b = SKY_KEYFRAMES[Math.min(SKY_KEYFRAMES.length-1, i+1)];
  const span = (b.e-a.e) || 1;
  const t = Math.max(0, Math.min(1, (elevDeg-a.e)/span));
  return {
    top: new THREE.Color(a.top).lerp(new THREE.Color(b.top), t),
    horizon: new THREE.Color(a.horizon).lerp(new THREE.Color(b.horizon), t),
    sun: new THREE.Color(a.sun).lerp(new THREE.Color(b.sun), t),
  };
}
S.sunElevation = 45, S.sunAzimuth = 45;
// Lit-window glow fades in as the sun goes down: full glow at/below this elevation, fully off
// at/above it. "Off" means no glow, not a black window — the window shader draws the glass
// independently of the glow, so zeroing emissiveIntensity alone reveals the daytime facade.
const WINDOW_GLOW_FULL_ELEV = -20, WINDOW_GLOW_OFF_ELEV = 36;
export function computeWindowGlowFactor(elevation) {
  return THREE.MathUtils.clamp((WINDOW_GLOW_OFF_ELEV-elevation)/(WINDOW_GLOW_OFF_ELEV-WINDOW_GLOW_FULL_ELEV), 0, 1);
}
// Two things have to be picked out of the scene by hand: the beacons blinking on landmark masts, and every material
// that lights up after dark. Walking the whole graph to find them costs more on a built-up city than the rest of a
// frame put together, and neither set changes except on an edit — so the walk happens only once something has been
// added or taken out, and both lists are read straight from then on.
export const blinkLights = [];   // meshes with userData.isBlinkLight — landmark antenna beacons (see surface-detail)
export const glowMaterials = []; // materials with userData.baseEmissiveIntensity — lit windows, lamps, train interiors
export const lampPostMeshes = []; // meshes with userData.lampPosts — a plaza's lamps, which light the ground around them
export const litLobbies = [];     // buildings with userData.lobbyLight — a lit ground floor, which lights the pavement outside
S.sceneIndexDirty = true;
// What marks the index stale is the graph changing shape, not the materials being made: a building's windows exist
// well before its group is hung off the scene, and anything indexed in between would be missed. Every add and remove
// goes through these two, detached ones included — marking stale more often than strictly needed, which costs one
// walk on the next frame and never a wrong answer. Nothing is added or taken out while the city just sits there, so
// an idle frame does no walking at all.
['add', 'remove'].forEach(method => {
  const inner = THREE.Object3D.prototype[method];
  THREE.Object3D.prototype[method] = function (...objects) { S.sceneIndexDirty = true; return inner.apply(this, objects); };
});
export function refreshSceneIndex() {
  if (!S.sceneIndexDirty) return;
  S.sceneIndexDirty = false;
  blinkLights.length = 0; glowMaterials.length = 0; lampPostMeshes.length = 0; litLobbies.length = 0;
  const seen = new Set(); // one material is shared by many meshes, and rescaling its glow once is enough
  scene.traverse(o => {
    if (o.userData && o.userData.isBlinkLight && o.material) blinkLights.push(o);
    if (o.userData && o.userData.lampPosts) lampPostMeshes.push(o);
    if (o.userData && o.userData.lobbyLight && o.userData.footprint) litLobbies.push(o);
    const mat = o.isMesh ? o.material : null;
    if (mat && mat.userData && mat.userData.baseEmissiveIntensity != null && !seen.has(mat)) { seen.add(mat); glowMaterials.push(mat); }
  });
}
function updateWindowGlowForSun() {
  refreshSceneIndex();
  const factor = computeWindowGlowFactor(S.sunElevation);
  // a material that does more with nightfall than turn its glow up says so with a hook — house windows come on room by
  // room over dusk and need the same number the glow is scaled by (see glassMaterial in suburbs.js)
  glowMaterials.forEach(mat => {
    mat.emissiveIntensity = mat.userData.baseEmissiveIntensity * factor;
    if (mat.userData.onGlow) mat.userData.onGlow(factor);
  });
}
// Cheapest plausible "glass reflects the sky" trick: a tiny (16px/face) CubeTexture painted
// from the same top/horizon colors already driving the sky dome, reused as every specular
// window material's envMap. No CubeCamera, no scene capture, no per-frame cost — just six small
// canvases repainted (and the one shared texture flagged needsUpdate) whenever the sun moves.
// Since every specular-window material references this SAME texture object, they all update for
// free with no per-material traversal. And because it's built from the SAME colors that already
// go dark at night, the reflection naturally fades out right alongside the sky — no separate
// logic needed to make the glass "fade into emission" after dark.
// three.js blurs an envMap into a PMREM for rough reflections, and that needs faces of at least 16px — smaller ones come out black
const SKY_ENV_FACE_SIZE = 16;
function makeSkyEnvFace() { const c = document.createElement('canvas'); c.width=SKY_ENV_FACE_SIZE; c.height=SKY_ENV_FACE_SIZE; return c; }
const skyEnvFaces = { px:makeSkyEnvFace(), nx:makeSkyEnvFace(), py:makeSkyEnvFace(), ny:makeSkyEnvFace(), pz:makeSkyEnvFace(), nz:makeSkyEnvFace() };
export const SKY_ENV_MAP = new THREE.CubeTexture([skyEnvFaces.px, skyEnvFaces.nx, skyEnvFaces.py, skyEnvFaces.ny, skyEnvFaces.pz, skyEnvFaces.nz]);
SKY_ENV_MAP.mapping = THREE.CubeReflectionMapping;
function updateSkyEnvMap(sky) {
  const topHex = '#'+sky.top.getHexString(), horizonHex = '#'+sky.horizon.getHexString();
  [skyEnvFaces.px, skyEnvFaces.nx, skyEnvFaces.pz, skyEnvFaces.nz].forEach(canvas => {
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,0,SKY_ENV_FACE_SIZE);
    grad.addColorStop(0, topHex);
    grad.addColorStop(1, horizonHex);
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,SKY_ENV_FACE_SIZE,SKY_ENV_FACE_SIZE);
  });
  const pyCtx = skyEnvFaces.py.getContext('2d'); pyCtx.fillStyle = topHex; pyCtx.fillRect(0,0,SKY_ENV_FACE_SIZE,SKY_ENV_FACE_SIZE);
  const nyCtx = skyEnvFaces.ny.getContext('2d'); nyCtx.fillStyle = horizonHex; nyCtx.fillRect(0,0,SKY_ENV_FACE_SIZE,SKY_ENV_FACE_SIZE);
  // the PMREM made from the texture is cached until the texture is disposed, so dispose it to have the repaint picked up
  // (it's uploaded and blurred again the next time it's drawn)
  SKY_ENV_MAP.dispose();
  SKY_ENV_MAP.needsUpdate = true;
}
// Weather, 0..1 each (see "weather") — here because it dims the light and greys the sky.
S.weatherRain = 0, S.weatherSnow = 0, S.weatherClouds = 0;
const MOON_COLOR = new THREE.Color(0x9fb4d8);
// where the light sits relative to what it shines on — placeSunLight moves it (and its shadow camera) to follow the view
export const sunOffset = new THREE.Vector3(150, 220, 100);
// Points the light, sky and fog at the current sun position and weather. While the sun is up (or just below the horizon)
// the light is the sun; once it's well down, the moon — opposite it, dim and cool — takes over, with the two fading
// through a moment of near-darkness around -4° so the shadows don't jump. `quick` skips the costlier refreshes (the sky
// reflection map and every lit window's glow), for the day/night cycle to call every frame.
export function updateSun(quick) {
  const elevRad = S.sunElevation*Math.PI/180, azimRad = S.sunAzimuth*Math.PI/180;
  const dir = new THREE.Vector3(
    Math.cos(elevRad)*Math.sin(azimRad),
    Math.sin(elevRad),
    Math.cos(elevRad)*Math.cos(azimRad)
  );
  const dist = 400;
  const ease = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a)/(b - a), 0, 1); return t*t*(3 - 2*t); };
  const overcast = Math.min(1, S.weatherRain*0.9 + S.weatherSnow*0.6 + S.weatherClouds*0.25);
  if (S.sunElevation > -4) {
    sunOffset.set(dir.x*dist, Math.max(dir.y, 0.06)*dist, dir.z*dist);
    const elevClamped = Math.max(dir.y, 0), warmth = 1 - elevClamped;
    sun.intensity = LIGHT_INTENSITY_SCALE*ease(-4, 4, S.sunElevation)*(0.35 + elevClamped*0.95);
    sun.color.setRGB(1, 1-warmth*0.22, 1-warmth*0.5);
  } else {
    sunOffset.set(-dir.x*dist, Math.max(-dir.y, 0.2)*dist, -dir.z*dist);
    sun.intensity = LIGHT_INTENSITY_SCALE*(1 - ease(-12, -4, S.sunElevation))*0.18;
    sun.color.copy(MOON_COLOR);
  }
  sun.intensity *= 1 - overcast*0.6;

  const sky = computeSkyColors(S.sunElevation);
  if (overcast > 0) {
    const grey = new THREE.Color().setScalar(sky.horizon.r*0.3 + sky.horizon.g*0.59 + sky.horizon.b*0.11);
    sky.top.lerp(grey.clone().multiplyScalar(0.85), overcast*0.8);
    sky.horizon.lerp(grey, overcast*0.7);
    sky.sun.multiplyScalar(1 - overcast*0.9);
  }
  skyDomeMat.uniforms.sunDirection.value.copy(dir);
  skyDomeMat.uniforms.topColor.value.copy(sky.top);
  skyDomeMat.uniforms.horizonColor.value.copy(sky.horizon);
  skyDomeMat.uniforms.sunColor.value.copy(sky.sun);
  skyDomeMat.uniforms.starAmount.value = (1 - ease(-12, -2, S.sunElevation))*(1 - overcast);
  scene.fog.color.copy(sky.horizon);
  scene.fog.near = THREE.MathUtils.lerp(600, 90, overcast);
  scene.fog.far = THREE.MathUtils.lerp(2800, 900, overcast);
  hemi.color.copy(sky.top).lerp(new THREE.Color(0xffffff), 0.35);
  hemi.intensity = LIGHT_INTENSITY_SCALE*0.9*THREE.MathUtils.lerp(0.3, 1, ease(-14, 6, S.sunElevation))*(1 - overcast*0.25);
  if (!quick) {
    updateSkyEnvMap(sky);
    updateWindowGlowForSun();
  }
}
updateSun();

// Water and road surfaces sit below the ground (see "water" and rebuildRoadMeshes). The ground mesh itself is rebuilt
// with holes where they are, but a few things are drawn flat just above ground level across the whole map — the grid,
// map images, walkways — and those skip them with the stencil buffer instead: rebuildWater and rebuildRoadMeshes each
// draw their outline into its own stencil bit first (an invisible mask, see makeStencilMask), and materials carrying
// these settings don't draw wherever those bits are marked. Zone fills only skip the roads, and still tint water zones.
export const STENCIL_WATER = 1, STENCIL_ROAD = 2;
export const SKIP_OVER_WATER_AND_ROADS = { stencilWrite:true, stencilFunc:THREE.EqualStencilFunc, stencilRef:0, stencilFuncMask:STENCIL_WATER|STENCIL_ROAD };
export const SKIP_OVER_ROADS = { stencilWrite:true, stencilFunc:THREE.EqualStencilFunc, stencilRef:0, stencilFuncMask:STENCIL_ROAD };
export function makeStencilMask(geometry, bit, name) {
  const mask = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite:false, depthWrite:false,
    stencilWrite:true, stencilFunc:THREE.AlwaysStencilFunc, stencilRef:bit, stencilWriteMask:bit, stencilZPass:THREE.ReplaceStencilOp }));
  mask.renderOrder = -10; // before anything that tests it
  mask.name = name;
  mask.userData.noExport = true;
  return mask;
}
export const GROUND_HALF_SIZE = 1500;
export const groundMat = new THREE.MeshStandardMaterial({ color:0x1b1e24, roughness:1 });
export const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_HALF_SIZE*2, GROUND_HALF_SIZE*2).rotateX(-Math.PI/2), groundMat);
ground.receiveShadow = true;
scene.add(ground);

let gridHelper = new THREE.GridHelper(2000, 200, 0x33373f, 0x20232a);
gridHelper.position.y = 0.02;
Object.assign(gridHelper.material, SKIP_OVER_WATER_AND_ROADS);
scene.add(gridHelper);
export function setGridColor(hexStr) {
  // GridHelper bakes colors into its geometry (not a live material uniform), so recreate it.
  // The secondary grid lines stay a dimmer version of the chosen color, preserving the
  // original center-line-brighter-than-grid depth effect from a single color input.
  const mainColor = new THREE.Color(hexStr);
  const dimColor = mainColor.clone().multiplyScalar(0.63);
  scene.remove(gridHelper); App.disposeObject(gridHelper);
  gridHelper = new THREE.GridHelper(2000, 200, mainColor.getHex(), dimColor.getHex());
  gridHelper.position.y = 0.02;
  Object.assign(gridHelper.material, SKIP_OVER_WATER_AND_ROADS);
  scene.add(gridHelper);
}

// world units per grid square (matches gridHelper's size/divisions above)
const GRID_CELL = 2000/200;
let gridSnapEnabled = false;
export function snapPointToGrid(p, kind) {
  if (!gridSnapEnabled || !p) return p;
  const c = GRID_CELL;
  return kind==='zone'
    ? { x: Math.round(p.x/c)*c, z: Math.round(p.z/c)*c }               // zone nodes -> grid corners
    : { x: Math.floor(p.x/c)*c + c/2, z: Math.floor(p.z/c)*c + c/2 };  // road nodes -> grid centers
}
document.getElementById('grid-toggle').addEventListener('click', (e)=>{
  gridSnapEnabled = !gridSnapEnabled;
  e.currentTarget.classList.toggle('active', gridSnapEnabled);
});

// perspective or orthographic, off the button in the canvas tools (its two grid icons are in index.html)
const projectionButton = document.getElementById('btn-projection');
projectionButton.addEventListener('click', ()=>{
  const ortho = !isOrthographic();
  setProjection(ortho ? 'ortho' : 'perspective');
  projectionButton.classList.toggle('on', ortho);
  projectionButton.title = ortho ? 'Perspective view' : 'Orthographic view';
});

// Y-height layering (avoids coplanar z-fighting). The road is sunk below the ground so its sidewalk sits level with
// the zone floors beside it, a curb's height above the road:
export const Y_ROAD=-0.07, Y_GRID=0.02, Y_MAP=0.03, Y_ZONE_GROUND=0.04, Y_PARK=0.06, Y_SIDEWALK=0.08, Y_PATH=0.1, Y_ZONE_FILL=0.2, Y_ZONE_LINE=0.55, Y_PREVIEW=0.65;
