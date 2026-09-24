import * as THREE from 'three';
import { scene, camera, renderer } from '../core/scene.js';
import { S } from '../core/shared.js';
import { groundBelow } from '../core/ground-probe.js';
import { NO_GROUND_FALLBACK, fallStep, gibGone, gibSink, isNear, landingGround } from './giblets.js';

// What's left of a vehicle that blows up: its body cut into a grid of blocks (a car into 2×2×2, an aircraft into
// CRAFT_GRID), and a car's wheels flying off whole, each falling, bouncing and sinking away like any other gib (fallStep
// in giblets.js).
//
// Everything is cut from the model's own geometry once, at load (buildCarWreck, buildCraftWreck): every opaque triangle
// not on a wheel (the glass is blown out) is clipped exactly at the grid's planes, so each block is the part of the body
// inside its cell, with no triangle reaching past it, and its cut faces filled in (capCell); and one of the wheels, centred on its hub, drawn once per hub (one
// on the other side is the same wheel turned round). All of a model's pieces are one geometry, each centred on itself
// and tagged with its part (wreckPart); an instance says which part it draws (instancePart) and the vertex shader folds
// away the rest, so a model's whole wreck is one draw call.
//
// Every model shares one material (one shader compile, done at load), colored per vertex: the model's own colors,
// scorched, with the paint (wreckPaint 1) and trim (2) taken per wreck from the instance's. Each model has a ring of
// WRECKS_MAX wrecks; a wreck keeps its instances for life, so lying still it's written once and left alone.

const WRECKS_MAX = 12; // per model
export const CAR_GRID = { across: 2, up: 2, along: 2 }, CRAFT_GRID = { across: 3, up: 1, along: 4 }; // blocks the body is cut into, on its own x, y and z
const JOIN_SHARE = 0.03; // how far apart the ends of a cut's outline can be, against the model's size, and still be joined (see capCell)
const CUT = [0.3, 0.28, 0.26]; // the color of a block's cut faces: sooty metal, not scorched further, so it reads as solid rather than as a hole
const SCORCH = new THREE.Color(0x120d0a), SCORCH_BODY = 0.55, SCORCH_PAINT = 0.6; // how far the colors are burnt towards black
const BLOCK_LAUNCH = [3, 7], BLOCK_THROW = [1.5, 5], BLOCK_SPIN = [1, 5]; // upward and outward speed (m/s), spin (rad/s)
const WHEEL_LAUNCH = [4, 9], WHEEL_THROW = [3, 8], WHEEL_SPIN = [8, 18];
const BLOCK_REST_SHARE = 0.5, WHEEL_REST_SHARE = 0.6; // how far above the ground each rests: of its thinnest side, of its radius
const RAY_LIFT = 0.5; // how far above where it stood its landing rays start, so the ground itself is never level with the ray
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

// (the vertex shader: fold away every part but the instance's own; a painted vertex takes the wreck's paint or trim)
const PART_PARS = 'attribute float wreckPart;\nattribute float instancePart;\nattribute float wreckPaint;\nattribute vec3 instanceTrim;';
const FOLD = '#include <begin_vertex>\nif (abs(wreckPart - instancePart) > 0.5) transformed = vec3(0.0);';
// (drawn with a stronger polygon offset than the flat ground it lands on, so a flat block lying there doesn't flicker into it)
const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1, flatShading: true, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
material.onBeforeCompile = shader => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + PART_PARS)
    .replace('#include <begin_vertex>', FOLD)
    .replace('#include <color_vertex>', `#include <color_vertex>
      #ifdef USE_INSTANCING_COLOR
        vColor.xyz = wreckPaint > 1.5 ? instanceTrim : mix(color.xyz, instanceColor.xyz, wreckPaint);
      #endif`);
};
material.customProgramCacheKey = () => 'wreck';
const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
depthMaterial.onBeforeCompile = shader => {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + PART_PARS).replace('#include <begin_vertex>', FOLD);
};
depthMaterial.customProgramCacheKey = () => 'wreck-depth';

const random = ([lo, hi]) => lo + Math.random()*(hi - lo);
const wrecks = []; // every model's pools
const placed = new THREE.Matrix4(), turn = new THREE.Quaternion(), scale = new THREE.Vector3(), position = new THREE.Vector3();
const flip = new THREE.Matrix4().makeRotationY(Math.PI), paintColor = new THREE.Color(), trimColor = new THREE.Color();
const wreckPosition = new THREE.Vector3(), wreckTurn = new THREE.Quaternion(), wreckScale = new THREE.Vector3();
let lastTime = null;

// ---- cutting
// A vertex while cutting: [x, y, z, r, g, b, paint], and a 1 on the end for one whose color is kept as it is (not scorched).
const lerpVertex = (a, b, t) => a.map((value, k) => value + (b[k] - value)*t);
// the part of a convex polygon on each side of the plane (axis) = value
function splitPolygon(polygon, axis, value) {
  const below = [], above = [];
  polygon.forEach((a, k) => {
    const b = polygon[(k + 1) % polygon.length], da = a[axis] - value, db = b[axis] - value;
    if (da <= 0) below.push(a);
    if (da >= 0) above.push(a); // (a corner on the plane is on both sides)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const cut = lerpVertex(a, b, da/(da - db)); below.push(cut); above.push(cut); }
  });
  return [below, above].filter(p => p.length >= 3);
}
/**
 * Clip triangles into the cells of a grid over their bounds.
 * @param {number[][]} triangles - each a list of three vertices ([x, y, z, r, g, b, paint])
 * @param {{across: number, up: number, along: number}} grid - cells on x, y and z
 * @returns {number[][][]} each non-empty cell's triangles, as vertex lists, its cut faces filled in
 */
function cutIntoCells(triangles, grid) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  triangles.forEach(t => t.forEach(v => { for (let a=0;a<3;a++) { low[a] = Math.min(low[a], v[a]); high[a] = Math.max(high[a], v[a]); } }));
  const counts = [grid.across, grid.up, grid.along];
  const cuts = counts.map((n, a) => Array.from({ length: n - 1 }, (_, k) => low[a] + (high[a] - low[a])*(k + 1)/n));
  const cells = new Map();
  triangles.forEach(triangle => {
    let pieces = [triangle];
    cuts.forEach((planes, axis) => planes.forEach(value => { pieces = pieces.flatMap(p => splitPolygon(p, axis, value)); }));
    pieces.forEach(p => {
      const middle = [0, 1, 2].map(a => p.reduce((sum, v) => sum + v[a], 0)/p.length);
      const cell = middle.map((m, a) => Math.min(counts[a] - 1, Math.max(0, Math.floor((m - low[a])/Math.max(1e-9, high[a] - low[a])*counts[a]))));
      const key = (cell[2]*counts[1] + cell[1])*counts[0] + cell[0];
      if (!cells.has(key)) cells.set(key, { cell, triangles: [] });
      for (let k=1;k+1<p.length;k++) cells.get(key).triangles.push([p[0], p[k], p[k+1]]); // (a fan: every piece is convex)
    });
  });
  const eps = 1e-5*Math.max(...high.map((h, a) => h - low[a]));
  return [...cells.values()].map(({ cell, triangles }) => capCell(triangles, cell, cuts, eps, JOIN_SHARE*Math.max(...high.map((h, a) => h - low[a]))));
}

/**
 * Fill in a block's cut faces. The model is (nearly all) a closed skin, so where a cut plane runs through it the block
 * is left open along a set of loops lying in that plane: each loop is walked round, and filled in flat on the plane —
 * an outline with any loops inside it as holes, the way a cut through a hollow shape would look. The model is built of
 * separate parts that only touch, so a cut's outline comes in runs with small gaps where one part meets the next: each
 * run's end is joined to the nearest other end within JOIN_SHARE of the model's size, until the runs close up. A run
 * that still doesn't close (where the model is properly open) gets a strip of `join` wide instead, running in from it
 * on the plane towards the block's middle, so the cut still looks solid there.
 * @param {number[][][]} triangles - the block's triangles, as vertex lists
 * @param {number[]} cell - which cell it is, on x, y and z
 * @param {number[][]} cuts - the cut planes on each axis
 * @param {number} eps - how near a plane counts as on it
 * @param {number} join - how far apart two ends of a cut's outline can be and still be joined
 * @returns {number[][][]} its triangles with the cut faces added
 */
function capCell(triangles, cell, cuts, eps, join) {
  const key = v => `${Math.round(v[0]/eps)},${Math.round(v[1]/eps)},${Math.round(v[2]/eps)}`;
  const edges = new Map();
  triangles.forEach(t => [[0, 1], [1, 2], [2, 0]].forEach(([i, k]) => {
    const a = key(t[i]), b = key(t[k]), id = a < b ? a + '|' + b : b + '|' + a;
    const seen = edges.get(id);
    if (seen) seen.count++; else edges.set(id, { count: 1, p: t[i], q: t[k], a, b });
  }));
  const out = [...triangles];
  const middle = [0, 1, 2].map(a => triangles.reduce((sum, t) => sum + t[0][a] + t[1][a] + t[2][a], 0)/(triangles.length*3));
  [0, 1, 2].forEach(axis => {
    const planes = [];
    if (cell[axis] > 0) planes.push(cuts[axis][cell[axis] - 1]);
    if (cell[axis] < cuts[axis].length) planes.push(cuts[axis][cell[axis]]);
    planes.forEach(value => {
      // the open edges lying in this plane, and each loop they make
      const around = new Map(), at = new Map();
      edges.forEach(({ count, p, q, a, b }) => {
        if (count !== 1 || Math.abs(p[axis] - value) > eps || Math.abs(q[axis] - value) > eps) return;
        [[a, b], [b, a]].forEach(([from, to]) => { if (!around.has(from)) around.set(from, []); around.get(from).push(to); });
        at.set(a, p); at.set(b, q);
      });
      const used = new Set(), loops = [], runs = [], strips = [];
      const edgeId = (a, b) => a < b ? a + '|' + b : b + '|' + a;
      for (const start of around.keys()) {
        for (;;) {
          const loop = [start];
          let u = start, closed = false;
          for (;;) {
            const next = around.get(u).find(w => !used.has(edgeId(u, w)));
            if (next == null) break;
            used.add(edgeId(u, next));
            if (next === start) { closed = true; break; }
            loop.push(next);
            u = next;
          }
          if (loop.length === 1 && !closed) break;
          if (closed) { if (loop.length >= 3) loops.push(loop.map(k => at.get(k))); }
          else runs.push(loop.map(k => at.get(k)));
        }
      }
      // (the runs, joined end to end across the gaps between the model's parts)
      const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      while (runs.length) {
        const run = runs.pop();
        for (;;) {
          const end = run[run.length - 1];
          let best = null, bestDistance = join;
          if (run.length >= 3 && distance(end, run[0]) < bestDistance) { best = 'self'; bestDistance = distance(end, run[0]); }
          runs.forEach((other, k) => {
            const toStart = distance(end, other[0]), toEnd = distance(end, other[other.length - 1]);
            if (toStart < bestDistance) { best = { k, reverse: false }; bestDistance = toStart; }
            if (toEnd < bestDistance) { best = { k, reverse: true }; bestDistance = toEnd; }
          });
          if (best === 'self') { loops.push(run); break; }
          if (!best) { strips.push(run); break; }
          const [other] = runs.splice(best.k, 1);
          run.push(...(best.reverse ? other.reverse() : other));
        }
      }
      const corner = v => [v[0], v[1], v[2], ...CUT, 0, 1];
      strips.forEach(run => {
        const inward = v => {
          const d = [0, 1, 2].map(a => a === axis ? 0 : middle[a] - v[a]), length = Math.hypot(...d) || 1;
          return corner([v[0] + d[0]/length*join, v[1] + d[1]/length*join, v[2] + d[2]/length*join]);
        };
        for (let k=0;k+1<run.length;k++) {
          const p = run[k], q = run[k + 1];
          out.push([corner(p), corner(q), inward(q)], [corner(p), inward(q), inward(p)]);
        }
      });
      if (!loops.length) return;
      // flat on the plane: the other two axes; each loop inside an odd number of others is a hole in the one just round it
      const [u, w] = [0, 1, 2].filter(a => a !== axis);
      const flat = loops.map(loop => loop.map(v => new THREE.Vector2(v[u], v[w])));
      const area = poly => poly.reduce((sum, p, k) => { const q = poly[(k + 1) % poly.length]; return sum + p.x*q.y - q.x*p.y; }, 0)/2;
      const inside = (point, poly) => {
        let hit = false;
        for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
          const a = poly[k], b = poly[j];
          if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x)*(point.y - a.y)/(b.y - a.y) + a.x) hit = !hit;
        }
        return hit;
      };
      const order = flat.map((_, k) => k).sort((a, b) => Math.abs(area(flat[b])) - Math.abs(area(flat[a])));
      const parent = new Array(flat.length).fill(-1), depth = new Array(flat.length).fill(0);
      order.forEach((k, n) => {
        for (let m = n - 1; m >= 0; m--) {
          const j = order[m];
          if (inside(flat[k][0], flat[j])) { parent[k] = j; depth[k] = depth[j] + 1; break; }
        }
      });
      order.filter(k => depth[k] % 2 === 0).forEach(k => {
        const holes = order.filter(h => parent[h] === k);
        const points = [loops[k], ...holes.map(h => loops[h])].flat();
        THREE.ShapeUtils.triangulateShape(flat[k], holes.map(h => flat[h]))
          .forEach(([a, b, c]) => out.push([corner(points[a]), corner(points[b]), corner(points[c])]));
      });
    });
  });
  return out;
}

/**
 * The parts, as one geometry: each part's triangles, centred on the part's own middle.
 * @param {number[][][][]} parts - each part's triangles, as vertex lists
 * @returns {{geometry: THREE.BufferGeometry, parts: {centre: THREE.Vector3, size: THREE.Vector3}[]}}
 */
function partsGeometry(parts) {
  const positions = [], colors = [], paint = [], part = [], info = [], c = new THREE.Color(), box = new THREE.Box3(), v = new THREE.Vector3();
  parts.forEach((triangles, p) => {
    box.makeEmpty();
    triangles.forEach(t => t.forEach(w => box.expandByPoint(v.set(w[0], w[1], w[2]))));
    const centre = box.getCenter(new THREE.Vector3());
    info.push({ centre, size: box.getSize(new THREE.Vector3()) });
    triangles.forEach(t => t.forEach(w => {
      positions.push(w[0] - centre.x, w[1] - centre.y, w[2] - centre.z);
      c.setRGB(w[3], w[4], w[5]);
      if (!w[7]) c.lerp(SCORCH, SCORCH_BODY);
      colors.push(c.r, c.g, c.b);
      paint.push(Math.round(w[6]));
      part.push(p);
    }));
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('wreckPaint', new THREE.Float32BufferAttribute(paint, 1));
  geometry.setAttribute('wreckPart', new THREE.Float32BufferAttribute(part, 1));
  geometry.computeVertexNormals();
  return { geometry, parts: info };
}

/**
 * Make a model's wreck pool: its body cut into `grid`, and its wheel drawn at each of `hubs`.
 * @param {string} name
 * @param {number[][]} body - the body's triangles, as vertex lists
 * @param {{across: number, up: number, along: number}} grid
 * @param {?number[][]} wheel - one wheel's triangles, as vertex lists, around hubs[0]
 * @param {THREE.Vector3[]} hubs - each wheel's middle
 * @returns {object} the pool, for throwWreck
 */
function buildWreck(name, body, grid, wheel = null, hubs = []) {
  const blocks = body.length ? cutIntoCells(body, grid) : [];
  const { geometry, parts } = partsGeometry(wheel ? [...blocks, wheel] : blocks);
  if (!wheel) hubs = [];
  const perWreck = blocks.length + hubs.length, capacity = WRECKS_MAX*perWreck;
  const instancePart = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  for (let slot=0;slot<WRECKS_MAX;slot++) for (let k=0;k<perWreck;k++) instancePart.array[slot*perWreck + k] = Math.min(k, blocks.length);
  const instanceTrim = new THREE.InstancedBufferAttribute(new Float32Array(capacity*3), 3);
  geometry.setAttribute('instancePart', instancePart);
  geometry.setAttribute('instanceTrim', instanceTrim);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i=0;i<capacity;i++) mesh.setMatrixAt(i, HIDDEN);
  mesh.setColorAt(0, new THREE.Color());
  mesh.customDepthMaterial = depthMaterial;
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'Wreck';
  mesh.count = 0;
  scene.add(mesh);
  const bodyBox = new THREE.Box3();
  body.forEach(t => t.forEach(w => bodyBox.expandByPoint(position.set(w[0], w[1], w[2]))));
  const pool = { name, mesh, instanceTrim, hubs, blocks: parts.slice(0, blocks.length), perWreck, centre: bodyBox.getCenter(new THREE.Vector3()),
    slots: new Array(WRECKS_MAX).fill(null), cursor: 0, used: 0, dirty: false,
    wheelRadius: wheel ? parts[blocks.length].size.y/2 : 0, wheelSide: hubs.length ? Math.sign(hubs[0].x) || 1 : 1 };
  wrecks.push(pool);
  if (wrecks.length === 1) { // (compile the one shader now, rather than on the first explosion)
    mesh.count = 1;
    renderer.compileAsync?.(mesh, camera, scene).catch(() => {}).finally(() => { mesh.count = pool.used*pool.perWreck; });
  }
  return pool;
}

/**
 * Cut a car design's wreck out of its geometry.
 * @param {THREE.BufferGeometry} source - the design's geometry (see buildCarDesigns in traffic/models.js): carSlot, carColor
 *   and carWheel per vertex, its opaque triangles as draw group 0
 * @param {number} paintSlot - the carSlot value of the paint
 * @param {string} name - the design's name
 * @returns {object} the design's wreck pool, for throwWreck
 */
export function buildCarWreck(source, paintSlot, name) {
  const index = source.index.array, opaque = source.groups[0] ?? { start: 0, count: index.length };
  const position = source.attributes.position, color = source.attributes.carColor, slot = source.attributes.carSlot, hubOf = source.attributes.carWheel;
  const vertex = v => [position.getX(v), position.getY(v), position.getZ(v), color.getX(v), color.getY(v), color.getZ(v), slot.getX(v) === paintSlot ? 1 : 0];
  const hubKey = v => hubOf.getW(v) > 0 ? `${hubOf.getX(v)},${hubOf.getY(v)},${hubOf.getZ(v)}` : null;
  const body = [], wheels = new Map();
  for (let t = opaque.start; t + 2 < opaque.start + opaque.count; t += 3) {
    const corners = [index[t], index[t+1], index[t+2]], key = hubKey(corners[0]);
    if (key != null) { if (!wheels.has(key)) wheels.set(key, []); wheels.get(key).push(corners.map(vertex)); }
    else if (corners.every(v => hubKey(v) == null)) body.push(corners.map(vertex));
  }
  const hubKeys = [...wheels.keys()];
  return buildWreck(name, body, CAR_GRID, hubKeys.length ? wheels.get(hubKeys[0]) : null, hubKeys.map(key => new THREE.Vector3(...key.split(',').map(Number))));
}

/**
 * Cut an aircraft model's wreck out of it: every opaque mesh under `root`, in root's own space, with its shape keys
 * wound off. Vertices of a material named in `paintNames` take the wreck's paint (the first) or trim (the second).
 * @param {THREE.Object3D} root - the loaded model
 * @param {string[]} paintNames - its paint and trim materials
 * @param {string} name
 * @returns {object} the model's wreck pool, for throwWreck
 */
export function buildCraftWreck(root, paintNames, name) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert(), toModel = new THREE.Matrix4(), v = new THREE.Vector3(), body = [];
  root.traverse(o => {
    if (!o.isMesh || !o.material || o.material.transparent) return;
    const geometry = o.geometry, position = geometry.attributes.position, index = geometry.index;
    const paint = paintNames.indexOf(o.material.name) + 1, color = o.material.color ?? new THREE.Color(0xffffff);
    toModel.multiplyMatrices(toRoot, o.matrixWorld);
    const vertex = i => { v.fromBufferAttribute(position, i).applyMatrix4(toModel); return [v.x, v.y, v.z, color.r, color.g, color.b, paint]; };
    const corners = index ? index.count : position.count;
    for (let t=0;t+2<corners;t+=3) body.push([0, 1, 2].map(k => vertex(index ? index.getX(t + k) : t + k)));
  });
  return buildWreck(name, body, CRAFT_GRID);
}

function hideWreck(pool, slot) {
  for (let k=0;k<pool.perWreck;k++) pool.mesh.setMatrixAt(slot*pool.perWreck + k, HIDDEN);
  pool.slots[slot] = null;
  pool.dirty = true;
}

/**
 * Blow a vehicle apart into its blocks and wheels.
 * @param {?object} pool - its model's wreck pool (see buildCarWreck, buildCraftWreck)
 * @param {THREE.Matrix4} matrix - where its model was: place, turn and scale, from the model's own space
 * @param {number[]} paint - its paint (r, g, b)
 * @param {object} [options]
 * @param {number[]} [options.trim] - its trim (r, g, b), for a model with one
 * @param {number} [options.power] - how hard it's thrown (1 for a car)
 * @param {number} [options.groundFrom] - the height it stood at, which its landing rays start just above (default: the model's own origin)
 * @returns {boolean} whether it was (not when gibs are off or it's too far away)
 */
export function throwWreck(pool, matrix, paint, { trim = paint, power = 1, groundFrom = null } = {}) {
  matrix.decompose(wreckPosition, wreckTurn, wreckScale);
  const middle = pool ? pool.centre.clone().applyMatrix4(matrix) : null;
  if (!pool || !S.showGibs || S.gibAmount <= 0 || !isNear(middle)) return false;
  const slot = pool.cursor, t = performance.now()/1000, size = wreckScale.x;
  const rayFrom = (groundFrom ?? wreckPosition.y) + RAY_LIFT*power;
  pool.cursor = (slot + 1) % WRECKS_MAX;
  pool.used = Math.max(pool.used, slot + 1);
  if (pool.slots[slot]) hideWreck(pool, slot);
  const groundAt = (x, z) => groundBelow(x, rayFrom, z, NO_GROUND_FALLBACK), fromGround = groundAt(middle.x, middle.z);
  const piece = (instance, local, lift, launch, throwSpeed, spin, spinAxis, shape) => {
    const at = local.clone().applyMatrix4(matrix), away = at.clone().sub(middle).setY(0);
    if (away.lengthSq() < 1e-6) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    const outward = random(throwSpeed)*power;
    const p = { instance, x: at.x, y: at.y, z: at.z, vx: away.x*outward, vy: random(launch)*power, vz: away.z*outward,
      quaternion: new THREE.Quaternion(), spinAxis: spinAxis.normalize(), spin: random(spin), lift, resting: false, shown: false,
      base: new THREE.Matrix4().makeTranslation(-at.x, -at.y, -at.z).multiply(matrix).multiply(shape) };
    p.ground = landingGround(p, fromGround, groundAt);
    return p;
  };
  const pieces = pool.blocks.map((block, k) => piece(slot*pool.perWreck + k, block.centre, Math.min(block.size.x, block.size.y, block.size.z)*size*BLOCK_REST_SHARE,
    BLOCK_LAUNCH, BLOCK_THROW, BLOCK_SPIN, new THREE.Vector3().randomDirection(), new THREE.Matrix4().makeTranslation(block.centre.x, block.centre.y, block.centre.z)));
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(wreckTurn);
  pool.hubs.forEach((h, k) => {
    const shape = new THREE.Matrix4().makeTranslation(h.x, h.y, h.z);
    if (Math.sign(h.x) !== pool.wheelSide) shape.multiply(flip); // (the wheel's own shape is the first hub's: turned round to face out)
    pieces.push(piece(slot*pool.perWreck + pool.blocks.length + k, h, pool.wheelRadius*size*WHEEL_REST_SHARE, WHEEL_LAUNCH, WHEEL_THROW, WHEEL_SPIN, side.clone(), shape));
  });
  pool.slots[slot] = { born: t, pieces };
  paintColor.setRGB(...paint).lerp(SCORCH, SCORCH_PAINT);
  trimColor.setRGB(...trim).lerp(SCORCH, SCORCH_PAINT);
  for (let k=0;k<pool.perWreck;k++) {
    pool.mesh.setColorAt(slot*pool.perWreck + k, paintColor);
    pool.instanceTrim.setXYZ(slot*pool.perWreck + k, trimColor.r, trimColor.g, trimColor.b);
  }
  pool.mesh.instanceColor.needsUpdate = true;
  pool.instanceTrim.needsUpdate = true;
  return true;
}
/** A car's wreck: see throwWreck. */
export const throwCarWreck = (pool, matrix, paint) => throwWreck(pool, matrix, paint);

/**
 * Move and draw every wreck. Call once a frame.
 * @param {number} t - the time, in seconds
 * @returns {void}
 */
export function updateCarWrecks(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  const off = !S.showGibs || S.gibAmount <= 0;
  wrecks.forEach(pool => {
    for (let slot=0;slot<pool.used;slot++) {
      const wreck = pool.slots[slot];
      if (!wreck) continue;
      if (off || gibGone(t, wreck.born)) { hideWreck(pool, slot); continue; }
      const sink = gibSink(t, wreck.born);
      for (const p of wreck.pieces) {
        if (p.gone) continue;
        if (!isNear(p)) { if (p.shown) { pool.mesh.setMatrixAt(p.instance, HIDDEN); p.shown = false; pool.dirty = true; } continue; }
        if (!fallStep(p, dt, t, p.lift, p.lift)) { pool.mesh.setMatrixAt(p.instance, HIDDEN); p.gone = true; pool.dirty = true; continue; }
        if (p.resting && !sink && p.shown) continue; // (lying still: already where it's drawn)
        placed.compose(position.set(p.x, p.y - sink*p.lift*2, p.z), turn.copy(p.quaternion), scale.setScalar(1 - sink)).multiply(p.base);
        pool.mesh.setMatrixAt(p.instance, placed);
        p.shown = pool.dirty = true;
      }
    }
    pool.mesh.count = pool.used*pool.perWreck;
    pool.mesh.visible = pool.used > 0;
    if (pool.dirty) { pool.mesh.instanceMatrix.needsUpdate = true; pool.dirty = false; }
  });
}
