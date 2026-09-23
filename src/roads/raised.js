import * as THREE from 'three';
import { S } from '../core/shared.js';
import { Y_PATH, computeWindowGlowFactor } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { tessellateOpenPath } from '../core/splines.js';
import { roadNodes } from '../core/state.js';
import { CLIPPER_SCALE, unionRoadStrokes, clipPolygons, createMeshBuilder, forEachPolyTreeEdge } from './roads.js';
import { applyWalkwayShader, walkwayTextureScaleOf, WALKWAY_COLOR, WALKWAY_TEXTURE } from './paths.js';
import { createRegionTester, offsetPaths, toClipperPath } from '../zones/cutouts.js';
import { makeTreeMesh } from '../zones/surface-detail.js';

// ---------------------------------------------------------- raised walkways
// A walkway up on pillars: a concrete deck at the line's own height, a ledge along both sides, and a spiral ramp down to
// the ground at each end of the network — and beside any node set to 'ramp' (from its right-click menu). Optionally,
// trees in planters, benches and lamp posts along it. Nothing under it is cut or covered: it's a thing standing in the city, so
// only its pillars and ramps (and the deck's shadow on the map) keep lots and trees off (see pathFootprint).
export const RAISED_HEIGHT = 6, MIN_RAISED_HEIGHT = 3, MAX_RAISED_HEIGHT = 60;
export const RAISED_STRUCTURE_COLOR = 0xb9b5ab;
const DECK_THICKNESS = 0.45;
const LEDGE_WIDTH = 0.6, LEDGE_HEIGHT = 1.0;
const PILLAR_SPACING = 16, PILLAR_HALF = 0.4;
const FURNITURE_SPACING = 10;
const LAMP_SPACING = 18, LAMP_POST_HEIGHT = 3.4; // (standing on the ledge, so its globe ends up about as high over the deck as a street's)
const RAMP_STEP = 0.7; // how far apart, along its middle, the ramp's slices are

export function isRaisedWalkwayLine(line) { return line.roadType === 'raised'; }
export function raisedHeightOf(line) { return line.raisedHeight ?? RAISED_HEIGHT; }
// A ramp's width, radius and the height it drops per full turn: no wider than a generous footpath, turning round a core
// wide enough to read as a column, and wide and steep enough (about one in seven) to get down in few turns — with
// plenty of headroom under each one.
export function rampShape(halfWidth) {
  const rw = Math.min(halfWidth*2, 4.5), R = Math.max(rw/2 + 2.4, 5.5);
  return { rw, R, drop: Math.max(5, 2*Math.PI*R*0.15) };
}

const toClipper = (x, z) => ({ X: Math.round(x*CLIPPER_SCALE), Y: Math.round(z*CLIPPER_SCALE) });
// a rectangle, as a Clipper path: from `o`, u0..u1 along unit u and v0..v1 along unit v
function rect(o, u, v, u0, u1, v0, v1) {
  const at = (a, b) => toClipper(o.x + u.x*a + v.x*b, o.z + u.z*a + v.z*b);
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}
function circle(c, r, n = 32) {
  const out = [];
  for (let i=0;i<n;i++) { const a = i/n*Math.PI*2; out.push(toClipper(c.x + Math.cos(a)*r, c.z + Math.sin(a)*r)); }
  return out;
}
const norm = v => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x/l, z: v.z/l }; };
const perp = v => ({ x: -v.z, z: v.x });

// One spiral ramp, from its top at S (level with the deck at H, heading h) round towards n and down to the ground:
// flat for the first phiL of its turn (the landing, for a ramp off the side of the deck), then descending steadily.
// Its middle at angle φ is C − n·R·cosφ + h·R·sinφ, with C = S + n·R the column it winds round.
function makeRamp({ S: start, h, n, phiL, H, rw, R, drop, side }) {
  const C = { x: start.x + n.x*R, z: start.z + n.z*R };
  const total = phiL + 2*Math.PI*(H - Y_PATH)/drop;
  const at = (phi, r) => ({ x: C.x + (-n.x*Math.cos(phi) + h.x*Math.sin(phi))*r, z: C.z + (-n.z*Math.cos(phi) + h.z*Math.sin(phi))*r });
  const yAt = phi => phi <= phiL ? H : Math.max(Y_PATH, H - (phi - phiL)/(2*Math.PI)*drop);
  const angles = [];
  const landingSteps = phiL > 0 ? Math.max(1, Math.ceil(phiL*R/RAMP_STEP)) : 0;
  for (let i=0;i<landingSteps;i++) angles.push(phiL*i/landingSteps);
  const steps = Math.max(2, Math.ceil((total - phiL)*R/RAMP_STEP));
  for (let i=0;i<=steps;i++) angles.push(phiL + (total - phiL)*i/steps);
  return { C, R, rw, H, phiL, total, side, h, n, start, at, yAt, angles };
}

// The deck, ledges, pillars, ramps and furniture of one raised walkway network, plus what people need to walk it
export function buildRaisedWalkway(lines, networkId) {
  const line = lines[0]; // height, look and furniture are set per network in the details panel
  const hw = (line.width || S.DEFAULT_ROAD_WIDTH)/2, H = raisedHeightOf(line);
  const { rw, R, drop } = rampShape(hw);
  const polylines = lines.map(l => ({ line: l, nodeIds: l.nodeIds.filter(id => roadNodes[id]) }))
    .filter(l => l.nodeIds.length >= 2)
    .map(l => {
      const tess = tessellateOpenPath(l.nodeIds.map(id => roadNodes[id]));
      // where each of the line's nodes falls in its tessellation
      const at = [];
      let k = 0;
      l.nodeIds.forEach(id => {
        const n = roadNodes[id];
        while (k < tess.length-1 && Math.hypot(tess[k].x - n.x, tess[k].z - n.z) > 1e-6) k++;
        at.push(k);
      });
      return { ...l, tess, at };
    });
  if (!polylines.length) return null;
  // how many line ends and middles meet at each node: an end of the network is a node only one line reaches, once
  const degree = new Map();
  polylines.forEach(({ nodeIds }) => nodeIds.forEach((id, i) => degree.set(id, (degree.get(id) || 0) + (i === 0 || i === nodeIds.length-1 ? 1 : 2))));
  const tangentAt = (tess, k) => norm({ x: tess[Math.min(tess.length-1, k+1)].x - tess[Math.max(0, k-1)].x, z: tess[Math.min(tess.length-1, k+1)].z - tess[Math.max(0, k-1)].z });

  const ramps = [], ends = [], rampNodes = [];
  const seenNode = new Set();
  polylines.forEach(({ nodeIds, tess, at }) => nodeIds.forEach((id, i) => {
    if (seenNode.has(id)) return;
    const node = roadNodes[id], deg = degree.get(id), side = node.rampSide === -1 ? -1 : 1;
    if (deg === 1) {
      seenNode.add(id);
      const k = at[i], from = tess[i === 0 ? Math.min(tess.length-1, k+1) : Math.max(0, k-1)];
      const h = norm({ x: node.x - from.x, z: node.z - from.z }), nrm = perp(h);
      const n = { x: nrm.x*side, z: nrm.z*side };
      ends.push({ E: node, h, n });
      ramps.push({ ...makeRamp({ S: node, h, n, phiL: 0, H, rw, R, drop, side }), kind: 'end', node });
    } else if (node.ramp) {
      seenNode.add(id);
      const t = tangentAt(tess, at[i]), nrm0 = perp(t), nrm = { x: nrm0.x*side, z: nrm0.z*side };
      const S0 = { x: node.x + nrm.x*(hw + rw/2), z: node.z + nrm.z*(hw + rw/2) };
      const phiL = rw/(R + rw/2);
      rampNodes.push({ node, t, nrm });
      ramps.push({ ...makeRamp({ S: S0, h: t, n: nrm, phiL, H, rw, R, drop, side }), kind: 'side', node, t, nrm });
    }
  }));

  // ---- the deck: the lines stroked out to their width, cut square at the network's ends
  const strokes = polylines.map(({ tess }) => ({ path: toClipperPath(tess), radius: hw }));
  let deck = unionRoadStrokes(strokes);
  const { ctDifference, ctUnion } = ClipperLib.ClipType;
  const butts = ends.map(({ E, h }) => rect(E, h, perp(h), 0, hw + 2, -hw - 2, hw + 2));
  if (butts.length) deck = clipPolygons(ctDifference, deck, butts);
  // where the ledge is left open onto a ramp
  const openings = [];
  ramps.forEach(r => {
    if (r.kind === 'end') openings.push(rect(r.start, r.h, r.n, -LEDGE_WIDTH - 0.2, 0.2, -(rw/2 - LEDGE_WIDTH), rw/2 - LEDGE_WIDTH));
    else {
      const len = (R + rw/2)*Math.sin(r.phiL);
      openings.push(rect(r.node, r.t, r.nrm, 0, Math.max(0.1, len - LEDGE_WIDTH), hw - LEDGE_WIDTH - 0.2, hw + 0.2));
    }
  });
  const ledgeBand = clipPolygons(ctDifference, clipPolygons(ctDifference, deck, offsetPaths(deck, -LEDGE_WIDTH, ClipperLib.JoinType.jtMiter)), openings, true);

  const surface = createMeshBuilder(), structure = createMeshBuilder(), furniture = createMeshBuilder();
  const deckTree = clipPolygons(ctUnion, deck, [], true);
  surface.addTops(deckTree, H);
  structure.addTops(deckTree, H - DECK_THICKNESS, true);
  forEachPolyTreeEdge(deckTree, (p, q, outward) => structure.addWall(p, q, H - DECK_THICKNESS, H, outward));
  structure.addTops(ledgeBand, H + LEDGE_HEIGHT);
  forEachPolyTreeEdge(ledgeBand, (p, q, outward) => structure.addWall(p, q, H, H + LEDGE_HEIGHT, outward));

  // ---- the ramps
  const up = { x: 0, y: 1, z: 0 }, down = { x: 0, y: -1, z: 0 };
  const p3 = (p, y) => ({ x: p.x, y, z: p.z });
  ramps.forEach(r => {
    const { at, yAt, angles, C } = r, rin = R - rw/2, rout = R + rw/2;
    const radial = phi => { const p = at(phi, 1); return { x: p.x - C.x, y: 0, z: p.z - C.z }; };
    for (let i=0;i<angles.length-1;i++) {
      const a0 = angles[i], a1 = angles[i+1], y0 = yAt(a0), y1 = yAt(a1), mid = radial((a0 + a1)/2);
      const inward = { x: -mid.x, y: 0, z: -mid.z };
      const onLanding = r.kind === 'side' && a1 <= r.phiL + 1e-9;
      surface.addQuad(p3(at(a0, rin), y0), p3(at(a0, rout), y0), p3(at(a1, rout), y1), p3(at(a1, rin), y1), up);
      structure.addQuad(p3(at(a0, rin), y0 - DECK_THICKNESS), p3(at(a0, rout), y0 - DECK_THICKNESS), p3(at(a1, rout), y1 - DECK_THICKNESS), p3(at(a1, rin), y1 - DECK_THICKNESS), down);
      // the inner ledge, against the column
      const ledge = (r0, r1, faceOut) => {
        structure.addQuad(p3(at(a0, r0), y0 + LEDGE_HEIGHT), p3(at(a0, r1), y0 + LEDGE_HEIGHT), p3(at(a1, r1), y1 + LEDGE_HEIGHT), p3(at(a1, r0), y1 + LEDGE_HEIGHT), up);
        const outer = faceOut ? r1 : r0, innerFace = faceOut ? r0 : r1;
        const outN = faceOut ? mid : inward, inN = faceOut ? inward : mid;
        structure.addQuad(p3(at(a0, outer), y0 - DECK_THICKNESS), p3(at(a1, outer), y1 - DECK_THICKNESS), p3(at(a1, outer), y1 + LEDGE_HEIGHT), p3(at(a0, outer), y0 + LEDGE_HEIGHT), outN);
        structure.addQuad(p3(at(a0, innerFace), y0), p3(at(a1, innerFace), y1), p3(at(a1, innerFace), y1 + LEDGE_HEIGHT), p3(at(a0, innerFace), y0 + LEDGE_HEIGHT), inN);
      };
      ledge(rin, rin + LEDGE_WIDTH, false);
      if (!onLanding) ledge(rout - LEDGE_WIDTH, rout, true);
    }
    // the column it winds round
    // (up past the ledges like a newel post — unless it stands under the deck, as an end ramp's can off a wide walkway)
    const coreTop = r.kind === 'end' && hw > R - rin*0.85 - 0.2 ? H - DECK_THICKNESS : H + LEDGE_HEIGHT;
    const core = new THREE.CylinderGeometry(rin*0.85, rin*0.85, coreTop, 20);
    structure.addGeometry(core, C.x, coreTop/2, C.z);
    core.dispose();
    if (r.kind === 'side') {
      // a ledge across the ramp's back end, and the apron filling the wedge between the deck's edge and the landing's
      // outer arc, closed off by a ledge across its far end
      const back = at(0, R);
      structure.addBox(back.x + r.h.x*LEDGE_WIDTH/2, back.z + r.h.z*LEDGE_WIDTH/2, r.n.x, r.n.z, rw/2, LEDGE_WIDTH/2, H - DECK_THICKNESS, H + LEDGE_HEIGHT);
      const landing = angles.filter(a => a <= r.phiL + 1e-9);
      const arc = landing.map(a => at(a, rout)), B = arc[arc.length-1];
      const len = rout*Math.sin(r.phiL);
      const A = { x: r.node.x + r.nrm.x*hw + r.t.x*len, z: r.node.z + r.nrm.z*hw + r.t.z*len };
      for (let i=0;i<arc.length-1;i++) {
        surface.addQuad(p3(A, H), p3(arc[i], H), p3(arc[i+1], H), p3(A, H), up);
        structure.addQuad(p3(A, H - DECK_THICKNESS), p3(arc[i], H - DECK_THICKNESS), p3(arc[i+1], H - DECK_THICKNESS), p3(A, H - DECK_THICKNESS), down);
      }
      const across = norm({ x: A.x - B.x, z: A.z - B.z }), span = Math.hypot(A.x - B.x, A.z - B.z);
      structure.addBox((A.x + B.x)/2 - r.t.x*LEDGE_WIDTH/2, (A.z + B.z)/2 - r.t.z*LEDGE_WIDTH/2, across.x, across.z, span/2 + LEDGE_WIDTH/2, LEDGE_WIDTH/2, H - DECK_THICKNESS, H + LEDGE_HEIGHT);
    }
  });

  // ---- pillars, along each line, clear of roads, rivers and the ramps' turns
  const overRoad = createRegionTester(S.roadFootprint || []), overRiver = createRegionTester(S.riverFootprint || []);
  const clearOfRamps = (x, z) => ramps.every(r => {
    const d = Math.hypot(x - r.C.x, z - r.C.z);
    return d < R - rw/2 - PILLAR_HALF - 0.3 || d > R + rw/2 + PILLAR_HALF + 0.3;
  });
  const walk = (tess, spacing, offset, fn) => {
    let total = 0;
    const cum = [0];
    for (let i=1;i<tess.length;i++) cum.push(total += Math.hypot(tess[i].x - tess[i-1].x, tess[i].z - tess[i-1].z));
    if (total < 1) return;
    const count = Math.max(1, Math.round(total/spacing));
    for (let k=0;k<count;k++) {
      const d = (k + offset)*total/count;
      let i = 0;
      while (i < tess.length-2 && cum[i+1] < d) i++;
      const a = tess[i], b = tess[i+1], t = (d - cum[i])/((cum[i+1] - cum[i]) || 1);
      fn({ x: a.x + (b.x - a.x)*t, z: a.z + (b.z - a.z)*t }, norm({ x: b.x - a.x, z: b.z - a.z }), k, d, total);
    }
  };
  const pillarOffsets = hw > 3.5 ? [-(hw - 1.2), hw - 1.2] : [0];
  const pillar = (x, z, t) => {
    if (overRoad(x, z) || overRiver(x, z) || !clearOfRamps(x, z)) return;
    structure.addBox(x, z, t.x, t.z, PILLAR_HALF, PILLAR_HALF, 0, H - DECK_THICKNESS);
  };
  polylines.forEach(({ tess }) => walk(tess, PILLAR_SPACING, 0.5, (p, t) => pillarOffsets.forEach(s => { const nr = perp(t); pillar(p.x + nr.x*s, p.z + nr.z*s, t); })));
  // and under each end of the deck, just short of where its ramp takes over
  ends.forEach(({ E, h }) => pillarOffsets.forEach(s => { const nr = perp(h); pillar(E.x - h.x*1.2 + nr.x*s, E.z - h.z*1.2 + nr.z*s, h); }));

  // ---- trees, benches and lamp posts, along each line on alternate sides, clear of the ends, junctions and ramps
  const trees = new THREE.Group();
  trees.name = 'RaisedTrees';
  const withTrees = !!line.raisedTrees, withBenches = !!line.raisedBenches, room = hw - LEDGE_WIDTH;
  const nodesBy = [...degree.entries()].map(([id, deg]) => ({ node: roadNodes[id], deg }));
  const clear = p => nodesBy.every(({ node, deg }) => {
    const d = Math.hypot(p.x - node.x, p.z - node.z);
    if (deg === 1) return d > 4;
    if (node.ramp) return d > rw + 3;
    if (deg >= 3) return d > hw + 3;
    return true;
  });
  let furnitureSpots = 0;
  if ((withTrees || withBenches) && room >= 1.2) {
    const rng = mulberry32(((parseInt(String(networkId).replace(/\D/g, ''), 10) || 0)*7919 + 17) >>> 0);
    const planterHalf = Math.min(0.9, room*0.35), seatTop = H + 0.45;
    polylines.forEach(({ tess }) => walk(tess, FURNITURE_SPACING, 0.5, (p, t, k) => {
      if (!clear(p)) return;
      furnitureSpots++;
      const nr = perp(t), side = k % 2 ? 1 : -1;
      if (withTrees) {
        const o = side*(room - planterHalf - 0.15), x = p.x + nr.x*o, z = p.z + nr.z*o;
        furniture.addBox(x, z, t.x, t.z, planterHalf, planterHalf, H, H + 0.5);
        const tree = makeTreeMesh(1, 1.1 + rng()*0.5, rng, S.globalTreeTint);
        tree.position.set(x, H + 0.5, z);
        tree.rotation.y = rng()*Math.PI*2;
        trees.add(tree);
      }
      if (withBenches) {
        const bs = withTrees ? -side : side, o = bs*(room - 0.45), x = p.x + nr.x*o, z = p.z + nr.z*o;
        furniture.addBox(x, z, t.x, t.z, 0.95, 0.26, seatTop - 0.1, seatTop); // seat
        const bo = bs*0.22;
        furniture.addBox(x + nr.x*bo, z + nr.z*bo, t.x, t.z, 0.95, 0.05, seatTop, seatTop + 0.45); // backrest, on the ledge's side
        [-0.8, 0.8].forEach(l => furniture.addBox(x + t.x*l, z + t.z*l, t.x, t.z, 0.05, 0.22, H, seatTop - 0.1)); // legs
      }
    }));
  }

  // lamp posts on the ledges, a side at a time, lighting the deck after dark as a street's do (see streetlights.js)
  const lampHeads = createMeshBuilder(), lampPosts = [];
  if (line.raisedLights) {
    const globe = new THREE.IcosahedronGeometry(0.3, 1), o = hw - LEDGE_WIDTH/2, foot = H + LEDGE_HEIGHT;
    polylines.forEach(({ tess }) => walk(tess, LAMP_SPACING, 0.25, (p, t, k) => {
      if (!clear(p)) return;
      const nr = perp(t), side = k % 2 ? -1 : 1, x = p.x + nr.x*o*side, z = p.z + nr.z*o*side;
      furniture.addBox(x, z, t.x, t.z, 0.08, 0.08, foot, foot + LAMP_POST_HEIGHT);
      lampHeads.addGeometry(globe, x, foot + LAMP_POST_HEIGHT + 0.25, z);
      lampPosts.push({ x, z, y: H });
    }));
    globe.dispose();
  }

  // ---- meshes
  const objects = [];
  const color = line.walkwayColor != null ? line.walkwayColor : WALKWAY_COLOR;
  const surfaceGeo = surface.build();
  if (surfaceGeo) {
    // the paving shader without the stencil a ground walkway has (which hides it over roads and water — this one's above them),
    // and no dirt: a track of sand six metres up makes no sense, so it's laid plain
    const texture = line.walkwayTexture || WALKWAY_TEXTURE;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide });
    applyWalkwayShader(mat, texture === 'dirt' ? 'plain' : texture, walkwayTextureScaleOf(line), line.walkwayTextureRotation);
    const mesh = new THREE.Mesh(surfaceGeo, mat);
    mesh.receiveShadow = true; mesh.castShadow = true;
    mesh.name = 'Walkway';
    mesh.userData = { networkId, baseColor: color, raised: true };
    objects.push(mesh);
  }
  const structureGeo = structure.build();
  if (structureGeo) {
    const mesh = new THREE.Mesh(structureGeo, new THREE.MeshStandardMaterial({ color: RAISED_STRUCTURE_COLOR, roughness: 0.85 }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'RaisedStructure';
    mesh.userData = { networkId, baseColor: RAISED_STRUCTURE_COLOR };
    objects.push(mesh);
  }
  const furnitureGeo = furniture.build();
  if (furnitureGeo) {
    const mesh = new THREE.Mesh(furnitureGeo, new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.7, metalness: 0.2 }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'RaisedFurniture';
    mesh.userData = { networkId, baseColor: 0x4a4d52 };
    objects.push(mesh);
  }
  const headGeo = lampHeads.build();
  if (headGeo) {
    const glow = new THREE.MeshStandardMaterial({ color: 0xfff1d6, roughness: 0.4, emissive: 0xffd08a, emissiveIntensity: 1.6*computeWindowGlowFactor(S.sunElevation) });
    glow.userData.baseEmissiveIntensity = 1.6; // lit after dark (see updateWindowGlowForSun)
    const mesh = new THREE.Mesh(headGeo, glow);
    mesh.name = 'RaisedLamps';
    mesh.userData = { networkId, baseColor: 0xfff1d6, lampPosts }; // where they stand, and how high, for the light they throw
    objects.push(mesh);
  }
  if (trees.children.length) objects.push(trees);

  // ---- what keeps the ground clear under it: the deck and each ramp's whole turn
  const footprint = clipPolygons(ctUnion, deck, ramps.map(r => circle(r.C, R + rw/2)));

  // ---- for people: each line along the deck, and each ramp from the deck down to its foot
  const navRamps = ramps.map(r => {
    const pts = [], ys = [];
    if (r.kind === 'side') { pts.push({ x: r.node.x, z: r.node.z }); ys.push(H); }
    const step = Math.min(0.5, 3.5/R), n = Math.max(2, Math.ceil(r.total/step));
    for (let i=0;i<=n;i++) { const phi = r.total*i/n; pts.push(r.at(phi, R)); ys.push(r.yAt(phi)); }
    return { pts, ys, top: pts[0], foot: pts[pts.length-1], lateral: Math.max(0.2, rw/2 - LEDGE_WIDTH - 0.4), walk: Math.max(0.2, rw/2 - LEDGE_WIDTH - 0.25) };
  });
  const nav = {
    networkId, H,
    lateral: Math.max(0.3, room - (furnitureSpots ? 1.4 : 0.3)),
    walk: Math.max(0.3, room - 0.25), // (how far either side of its line someone walked about on it can go, short of the ledge)
    decks: polylines.map(({ tess }) => tess),
    ramps: navRamps,
  };
  return { objects, footprint, nav };
}
