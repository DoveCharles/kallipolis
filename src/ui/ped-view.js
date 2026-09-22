import { scene } from '../core/scene.js';
import { S } from '../core/shared.js';
import { people } from '../life/people/people.js';

// ============================================================ ped view
// The smiling head button over the view, beside the heart, drains the color out of the whole city: everything renders in
// its own brightness but grey, apart from the people, who go entirely yellow, and every building with somebody inside
// it, which goes yellow with them — so a glance says where the crowd is, indoors and out.
//
// Nothing is rebuilt or re-lit for this: each mesh keeps its own material's shader (people are posed in theirs, the
// water and the sky are drawn in theirs), and the tint is tacked onto the end of the fragment shader — its main() is
// renamed and called from a new one that recolors what it wrote. So a material needs a copy per tint, since the same
// material draws both a yellow building and a grey one; a ShaderMaterial's copy shares the original's uniforms object,
// so the water still moves and the sun still crosses the sky while the mode is on.
const YELLOW = 'vec3(1.0, 0.82, 0.16)';
// The grey is the brightness brought down a little rather than used as it is: sunlit ground comes out near the top of
// the range, and the 16-color palette (see ui/pixelation.js) has nothing between light grey and white to put it in, so
// grass drawn at its own brightness dithers to something that reads as snow. Everything keeps its order, darker.
const GREY_SCALE = '0.78';
const TINTS = {
  grey: `gl_FragColor.rgb = vec3(pedLuma*${GREY_SCALE});`,
  yellow: `gl_FragColor.rgb = ${YELLOW} * clamp(0.5 + pedLuma, 0.35, 1.0);`,
};
// How bright a thing is, to draw it again in a tint. The brightness is taken from the color *as it's shown* — clamped
// first: a lit surface can come out of the shader past 1 in a channel (sunlit grass is well past it in green), and the
// screen never shows that, but a brightness taken from the raw number would be over 1 and go white where the grass it
// came from is green.
const LUMA = 'float pedLuma = dot(clamp(gl_FragColor.rgb, 0.0, 1.0), vec3(0.299, 0.587, 0.114));';
// how often the world is looked over again while the mode is on: often enough to catch someone going in or coming out,
// rarely enough that walking the whole scene graph doesn't show
const RESCAN = 0.3;

let on = false, scannedAt = -Infinity;
const variants = new Map(); // original material -> { grey, yellow }: its copy per tint
const swapped = new Set();  // every mesh whose material we've swapped, to put back when the mode goes off

/**
 * Tack the tint onto the end of a compiled material's fragment shader (see above).
 * @param {object} shader - the shader three.js is about to compile
 * @param {string} tint - which of TINTS to end it with
 * @returns {void}
 */
function tintShader(shader, tint) {
  const renamed = shader.fragmentShader.replace(/void\s+main\s*\([^)]*\)/, 'void pedViewMain()');
  if (renamed === shader.fragmentShader) return; // (no main to wrap: leave it alone rather than break it)
  shader.fragmentShader = renamed + `
    void main() {
      pedViewMain();
      ${LUMA}
      ${TINTS[tint]}
    }`;
}

/**
 * The copy of a material that draws in one tint, made once and kept.
 * @param {THREE.Material} material - the material as the mesh was built with it
 * @param {string} tint - which of TINTS it draws in
 * @returns {THREE.Material} the tinted copy
 */
function variantOf(material, tint) {
  let byTint = variants.get(material);
  if (!byTint) variants.set(material, byTint = {});
  if (!byTint[tint]) {
    const copy = material.clone();
    // a ShaderMaterial's uniforms are deep-copied by clone(), which would freeze whatever's driving them (the water's
    // time, the sky's sun): hand the copy the very same uniforms instead
    if (material.isShaderMaterial) copy.uniforms = material.uniforms;
    const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
    copy.onBeforeCompile = (shader, renderer) => { compile.call(copy, shader, renderer); tintShader(shader, tint); };
    copy.customProgramCacheKey = () => key.call(copy) + '|pedview:' + tint;
    byTint[tint] = copy;
  }
  return byTint[tint];
}

/**
 * Draw this mesh in a tint (or, with none, back in its own materials).
 * @param {THREE.Mesh} mesh - the mesh
 * @param {?string} tint - which of TINTS, or null to put its own materials back
 * @returns {void}
 */
function paint(mesh, tint) {
  const own = mesh.userData.pedViewMaterial ?? mesh.material;
  if (!tint) {
    if (mesh.userData.pedViewMaterial) { mesh.material = own; delete mesh.userData.pedViewMaterial; }
    swapped.delete(mesh);
    return;
  }
  mesh.userData.pedViewMaterial = own;
  mesh.material = Array.isArray(own) ? own.map(m => variantOf(m, tint)) : variantOf(own, tint);
  swapped.add(mesh);
}

/** The keys (see buildingKey) of every building somebody's inside right now. */
function occupiedBuildings() {
  const keys = new Set();
  if (S.peopleEnabled) people.forEach(p => {
    if (p.mode === 'indoors' && p.indoors.stage === 'inside') keys.add(p.indoors.building.key);
  });
  return keys;
}

/**
 * Look the world over and paint it: yellow for people and for the buildings holding them, grey for all the rest.
 * @returns {void}
 */
function repaint() {
  const occupied = occupiedBuildings(), yellowGroups = new Set();
  S.zones.forEach(zone => (zone.buildingsGroup?.children || []).forEach((group, index) => {
    if (occupied.has(zone.id + ':' + index)) yellowGroups.add(group);
  }));
  const seen = new Set();
  (function walk(object, yellow) {
    const mine = yellow || yellowGroups.has(object);
    if (object.isMesh || object.isLine || object.isPoints || object.isSprite) {
      paint(object, mine || object.name === 'People' ? 'yellow' : 'grey');
      seen.add(object);
    }
    object.children.forEach(child => walk(child, mine));
  })(scene, false);
  // anything that's left the scene since the last look (a zone rebuilt, a car blown up) is no longer ours to put back
  [...swapped].forEach(mesh => { if (!seen.has(mesh)) swapped.delete(mesh); });
}

/**
 * Keep the tints up to date with who's gone indoors and what's been built, while the mode is on.
 * @param {number} t - the time, in seconds
 * @returns {void}
 */
export function updatePedView(t) {
  if (!on || t - scannedAt < RESCAN) return;
  scannedAt = t;
  repaint();
}

function setPedView(v) {
  on = v;
  scannedAt = -Infinity;
  button.classList.toggle('on', on);
  button.title = on ? 'Back to the usual colors' : 'Grey out everything but the people';
  if (on) repaint();
  else [...swapped].forEach(mesh => paint(mesh, null));
}

const button = document.getElementById('btn-ped-view');
button.addEventListener('click', () => setPedView(!on));
