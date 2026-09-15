import * as THREE from 'three';
import { App } from '../core/shared.js';
import { Y_ZONE_GROUND } from '../core/scene.js';
import { mulberry32, lerp, polygonArea, pointInPolygon, centroid, recursiveSubdivide } from '../core/math.js';
import { BUILDING_GROUND_COLORS } from '../core/splines.js';
import { clipPolygons, createMeshBuilder, forEachPolyTreeEdge } from '../roads/roads.js';
import { makeFlatZoneMesh } from './surface-detail.js';
import { longAxisOf, builderMesh, addGableRoof } from './farmland.js';
import { buildRailingMesh } from './fences.js';
import { toClipperPath, cutLotByCutouts, insetPolygonExact } from './cutouts.js';

// ---------------------------------------------------------- industrial
// An industrial zone is split into big lots, each paved as a yard behind a chain-link fence with a gate, and each holding
// one of: a warehouse (sawtooth or gable roof, loading doors down its sides), a factory with tall banded chimneys, a
// cluster of storage tanks, or a yard of stacked shipping containers. Anything a lot's shape is too irregular for falls
// back to a flat-roofed shed that follows its outline.
const Y_YARD = Y_ZONE_GROUND + 0.02;
const INDUSTRIAL_WALL_COLORS = [0xb9bcc0, 0xc8bea8, 0x8e9aa6, 0xa3a7ab, 0x9a8f80];
const INDUSTRIAL_ACCENT_COLORS = [0x2f6fae, 0xd2a23a, 0xb8412f, 0x3f8f5a];
const CONTAINER_COLORS = [0xb33a2e, 0x2e6fb3, 0xd9a13b, 0x3f8f5a, 0x8a8f96, 0xe07b2a, 0x6b4f8a];
const LOT_FENCE_STYLE = { height:2.0, rails:[2.0, 0.15], railWidth:0.06, railHeight:0.06, postSize:0.1, postSpacing:3, color:0x80868d, roughness:0.5, metalness:0.5 };
// an upright prism over any polygon ({x,z}[]), from y0 to y1
function addPrism(builder, poly, y0, y1) {
  const tree = clipPolygons(ClipperLib.ClipType.ctUnion, [toClipperPath(poly)], [], true);
  builder.addTops(tree, y1);
  forEachPolyTreeEdge(tree, (p, q, outward) => builder.addWall(p, q, y0, y1, outward));
}
function generateIndustrialContent(zone, poly, cutouts, blockers) {
  const s = zone.settings, rng = mulberry32(s.seed>>>0);
  const groundColor = s.groundColor!=null ? s.groundColor : BUILDING_GROUND_COLORS[0];
  const ground = makeFlatZoneMesh(poly, groundColor, Y_ZONE_GROUND, 'ZoneGround', null, cutouts);
  if (ground) zone.buildingsGroup.add(ground);
  const hMin = s.industrialHeightMin!=null ? s.industrialHeightMin : 5, hMax = s.industrialHeightMax!=null ? s.industrialHeightMax : 14;
  const lots = [];
  const target = Math.max(1, Math.round(s.industrialLots!=null ? s.industrialLots : 10));
  recursiveSubdivide(poly, 0, { minArea: Math.abs(polygonArea(poly))/target, maxDepth: 9, jitter: 0.3, minSplitDim: 8 }, rng, lots);
  const yards = createMeshBuilder(), fenceLines = [];
  lots.forEach(lot => cutLotByCutouts(lot, blockers).pieces.forEach(piece => {
    if (Math.abs(polygonArea(piece)) < 80) return;
    const site = insetPolygonExact(piece, 1.2)[0];
    if (!site || Math.abs(polygonArea(site)) < 50) return;
    addPrism(yards, site, Y_ZONE_GROUND, Y_YARD);
    if (s.lotFences !== false) {
      // the fence goes all the way around, leaving a gate in the middle of the lot's longest side
      let longest = 0;
      site.forEach((p, i) => { const q = site[(i+1)%site.length]; if (Math.hypot(q.x-p.x, q.z-p.z) > Math.hypot(site[(longest+1)%site.length].x-site[longest].x, site[(longest+1)%site.length].z-site[longest].z)) longest = i; });
      const a = site[longest], b = site[(longest+1)%site.length], len = Math.hypot(b.x-a.x, b.z-a.z);
      const around = site.slice(longest+1).concat(site.slice(0, longest+1));
      if (len > 10) {
        const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len, mx = (a.x+b.x)/2, mz = (a.z+b.z)/2;
        fenceLines.push([{ x: mx + dx*3.5, z: mz + dz*3.5 }, ...around, { x: mx - dx*3.5, z: mz - dz*3.5 }]);
      } else {
        fenceLines.push(around.concat([around[0]]));
      }
    }
    if (rng() > (s.industrialDensity!=null ? s.industrialDensity : 0.85)) return; // an empty yard
    const inner = insetPolygonExact(site, 2.2)[0];
    if (!inner || Math.abs(polygonArea(inner)) < 30) return;
    const group = new THREE.Group();
    group.name = 'Building';
    const roll = rng();
    if (roll < 0.4) buildWarehouse(group, inner, rng, lerp(hMin, (hMin+hMax)/2, rng()));
    else if (roll < 0.6) buildFactory(group, inner, rng, lerp(hMin, hMax, rng()));
    else if (roll < 0.8) buildTankFarm(group, inner, rng, lerp(hMin*0.8, hMax*0.8, rng()));
    else buildContainerYard(group, inner, rng);
    if (group.children.length) zone.buildingsGroup.add(group);
  }));
  const yardMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(groundColor).lerp(new THREE.Color(0x8c8c88), 0.55), roughness: 0.95 });
  const yardGeo = yards.build();
  if (yardGeo) { const mesh = new THREE.Mesh(yardGeo, yardMat); mesh.receiveShadow = true; mesh.name = 'Yard'; zone.buildingsGroup.add(mesh); }
  const fence = buildRailingMesh(fenceLines, Y_YARD, LOT_FENCE_STYLE, 'LotFence');
  if (fence) zone.buildingsGroup.add(fence);
}
// Whether a polygon is close enough to its bounding rectangle — and big enough — to build a rectangular building on.
function rectangularSite(poly, minShort) {
  const axis = longAxisOf(poly);
  return Math.abs(polygonArea(poly))/axis.rect.area > 0.85 && axis.halfShort*2 > minShort ? axis : null;
}
// Shared by warehouse and factory: a box on a rectangular site, or a prism following an irregular one. Returns the
// rectangle used ({ cx, cz, dx, dz, L, W }), or null for an irregular site.
function addMainBlock(walls, accent, site, h, withBand) {
  const axis = rectangularSite(site, 7);
  if (!axis) {
    addPrism(walls, site, Y_YARD, Y_YARD + h);
    return null;
  }
  const { rect, dx, dz } = axis, L = axis.halfLong - 0.3, W = axis.halfShort - 0.3;
  walls.addBox(rect.center.x, rect.center.z, dx, dz, L, W, Y_YARD, Y_YARD + h);
  if (withBand) accent.addBox(rect.center.x, rect.center.z, dx, dz, L + 0.06, W + 0.06, Y_YARD + h - 1.0, Y_YARD + h - 0.5);
  return { cx: rect.center.x, cz: rect.center.z, dx, dz, L, W };
}
function buildWarehouse(group, site, rng, h) {
  const walls = createMeshBuilder(), roof = createMeshBuilder(), accent = createMeshBuilder(), glass = createMeshBuilder(), doors = createMeshBuilder();
  const wallColor = INDUSTRIAL_WALL_COLORS[Math.floor(rng()*INDUSTRIAL_WALL_COLORS.length)];
  const box = addMainBlock(walls, accent, site, h, true);
  if (box) {
    const { cx, cz, dx, dz, L, W } = box, nx = -dz, nz = dx, top = Y_YARD + h;
    const at = (s, w, y) => ({ x: cx + dx*s + nx*w, y, z: cz + dz*s + nz*w });
    if (rng() < 0.5) {
      // sawtooth: a row of sloped roof panels, each ending in a steep glazed face
      const teeth = Math.max(2, Math.round(2*L/6)), t = 2*L/teeth, rise = Math.min(2.2, t*0.4), len = Math.hypot(rise, t);
      for (let k=0;k<teeth;k++) {
        const s0 = -L + k*t, s1 = s0 + t;
        roof.addQuad(at(s0, -W, top), at(s0, W, top), at(s1, W, top+rise), at(s1, -W, top+rise), { x: -dx*rise/len, y: t/len, z: -dz*rise/len });
        glass.addQuad(at(s1, -W, top), at(s1, W, top), at(s1, W, top+rise), at(s1, -W, top+rise), { x: dx, y: 0, z: dz });
        [1, -1].forEach(side => walls.addQuad(at(s0, W*side, top), at(s1, W*side, top), at(s1, W*side, top+rise), at(s1, W*side, top+rise), { x: nx*side, y: 0, z: nz*side }));
      }
    } else {
      addGableRoof(roof, walls, cx, cz, dx, dz, L + 0.3, W + 0.3, top, Math.min(2.5, W*0.3));
    }
    // loading doors down both long sides
    const count = Math.floor(2*L/6.5);
    for (let k=0;k<count;k++) {
      const s = -L + (k + 0.5)*(2*L/count);
      [1, -1].forEach(side => { const p = at(s, (W + 0.04)*side, 0); doors.addBox(p.x, p.z, dx, dz, 1.4, 0.06, Y_YARD, Y_YARD + Math.min(3.4, h*0.6)); });
    }
  } else {
    // an irregular site: a flat roof with a few vents on top
    const c = centroid(site);
    for (let k=0;k<4;k++) {
      const p = { x: c.x + (rng()-0.5)*6, z: c.z + (rng()-0.5)*6 };
      if (pointInPolygon(p, site)) roof.addBox(p.x, p.z, 1, 0, 0.6, 0.6, Y_YARD + h, Y_YARD + h + 0.9);
    }
  }
  [[walls, wallColor, 'Warehouse'], [roof, 0x6b7076, 'WarehouseRoof', { metalness: 0.3 }], [accent, INDUSTRIAL_ACCENT_COLORS[Math.floor(rng()*INDUSTRIAL_ACCENT_COLORS.length)], 'Stripe'],
   [glass, 0x2c4a63, 'Skylights', { roughness: 0.2, metalness: 0.4 }], [doors, 0x3a3e44, 'LoadingDoors', { metalness: 0.4 }]].forEach(([builder, color, name, opts]) => {
    const mesh = builderMesh(builder, color, name, opts);
    if (mesh) group.add(mesh);
  });
}
function buildFactory(group, site, rng, h) {
  const walls = createMeshBuilder(), accent = createMeshBuilder(), roofGear = createMeshBuilder();
  const brick = rng() < 0.5;
  const box = addMainBlock(walls, accent, site, h, !brick);
  const c = box ? { x: box.cx, z: box.cz } : centroid(site);
  const dx = box ? box.dx : 1, dz = box ? box.dz : 0, L = box ? box.L : 4, W = box ? box.W : 4;
  // a few boxes of plant on the roof
  for (let k=0;k<3;k++) roofGear.addBox(c.x + dx*(rng()-0.5)*L + -dz*(rng()-0.5)*W, c.z + dz*(rng()-0.5)*L + dx*(rng()-0.5)*W, dx, dz, 0.8 + rng(), 0.6 + rng()*0.6, Y_YARD + h, Y_YARD + h + 1 + rng());
  [[walls, brick ? 0x8a5a45 : INDUSTRIAL_WALL_COLORS[Math.floor(rng()*INDUSTRIAL_WALL_COLORS.length)], 'Factory'], [accent, INDUSTRIAL_ACCENT_COLORS[Math.floor(rng()*INDUSTRIAL_ACCENT_COLORS.length)], 'Stripe'],
   [roofGear, 0x8b9095, 'RoofPlant', { metalness: 0.3 }]].forEach(([builder, color, name, opts]) => {
    const mesh = builderMesh(builder, color, name, opts);
    if (mesh) group.add(mesh);
  });
  // chimneys rise from the roof, each banded red near the top
  const chimneyMat = new THREE.MeshStandardMaterial({ color: brick ? 0x7a4a38 : 0xd8d8d4, roughness: 0.8 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6 });
  const count = 1 + Math.floor(rng()*3);
  for (let k=0;k<count;k++) {
    const p = { x: c.x + dx*(k - (count-1)/2)*Math.min(4, L*0.5), z: c.z + dz*(k - (count-1)/2)*Math.min(4, L*0.5) };
    if (!pointInPolygon(p, site)) continue;
    const r = 0.8 + rng()*0.5, H = h + 14 + rng()*16;
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(r*0.7, r, H, 16), chimneyMat);
    stack.position.set(p.x, Y_YARD + H/2, p.z);
    stack.castShadow = true; stack.name = 'Chimney';
    group.add(stack);
    [H - 1.2, H - 3.8].forEach(y => {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r*0.76, r*0.78, 1.1, 16), bandMat);
      band.position.set(p.x, Y_YARD + y, p.z);
      band.name = 'Chimney';
      group.add(band);
    });
  }
}
function buildTankFarm(group, site, rng, h) {
  const { rect, dx, dz, halfLong, halfShort } = longAxisOf(site), nx = -dz, nz = dx;
  const r = Math.min(2.2 + rng()*2.5, halfShort*0.9), gap = 1.4, step = 2*r + gap;
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xdfe2e4, roughness: 0.45, metalness: 0.35 });
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x70757b, roughness: 0.7 });
  let placed = 0;
  for (let i=-Math.floor(halfLong/step); i<=Math.floor(halfLong/step) && placed < 8; i++) {
    for (let j=-Math.floor(halfShort/step); j<=Math.floor(halfShort/step) && placed < 8; j++) {
      const x = rect.center.x + dx*i*step + nx*j*step, z = rect.center.z + dz*i*step + nz*j*step;
      let inside = true;
      for (let k=0;k<8 && inside;k++) inside = pointInPolygon({ x: x + Math.cos(k/8*Math.PI*2)*r, z: z + Math.sin(k/8*Math.PI*2)*r }, site);
      if (!inside) continue;
      placed++;
      const tankH = h*(0.85 + rng()*0.3);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tankH, 28), tankMat);
      body.position.set(x, Y_YARD + tankH/2, z);
      const lid = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 6, 0, Math.PI*2, 0, Math.PI*0.3), tankMat);
      lid.position.set(x, Y_YARD + tankH - r*Math.cos(Math.PI*0.3), z);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.15, r + 0.15, 0.6, 28), baseMat);
      base.position.set(x, Y_YARD + 0.3, z);
      [body, lid, base].forEach(m => { m.castShadow = true; m.receiveShadow = true; m.name = 'Tank'; group.add(m); });
    }
  }
}
function buildContainerYard(group, site, rng) {
  const { rect, dx, dz, halfLong, halfShort } = longAxisOf(site), nx = -dz, nz = dx;
  const CL = 6.1, CW = 2.45, CH = 2.6;
  const builders = new Map();
  const builderFor = color => { if (!builders.has(color)) builders.set(color, createMeshBuilder()); return builders.get(color); };
  const rowPitch = CW + 0.3;
  for (let row=0, w=-halfShort + CW/2 + 0.5; w <= halfShort - CW/2 - 0.5; row++, w += rowPitch + (row % 2 === 0 ? 2.5 : 0)) {
    for (let s = -halfLong + CL/2 + 0.5; s <= halfLong - CL/2 - 0.5; s += CL + 0.4) {
      const x = rect.center.x + dx*s + nx*w, z = rect.center.z + dz*s + nz*w;
      const corners = [[1,1], [1,-1], [-1,1], [-1,-1]].map(([a, b]) => ({ x: x + dx*a*CL/2 + nx*b*CW/2, z: z + dz*a*CL/2 + nz*b*CW/2 }));
      if (!corners.every(p => pointInPolygon(p, site)) || rng() < 0.15) continue;
      const stack = 1 + Math.floor(rng()*3);
      for (let k=0;k<stack;k++) {
        builderFor(CONTAINER_COLORS[Math.floor(rng()*CONTAINER_COLORS.length)]).addBox(x, z, dx, dz, CL/2 - 0.02, CW/2 - 0.02, Y_YARD + k*CH, Y_YARD + (k+1)*CH - 0.04);
      }
    }
  }
  builders.forEach((builder, color) => { const mesh = builderMesh(builder, color, 'Containers', { roughness: 0.7, metalness: 0.2 }); if (mesh) group.add(mesh); });
}

Object.assign(App, { generateIndustrialContent });
