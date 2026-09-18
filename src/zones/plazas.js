import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { computeWindowGlowFactor } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { distPointSegment } from '../buildings/footprints.js';
import { resolveTreeTint } from '../core/splines.js';
import { clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { makeFlatZoneMesh, makeTreeMesh } from './surface-detail.js';

// ---------------------------------------------------------- plazas
// A plaza is a paved square: tiles or herringbone brick drawn by a shader in world space (so the pattern runs on unbroken
// across the whole plaza), edged with a darker band of paving. Lamp posts — lit after dark, like windows — stand around its
// edge with benches between them, trees grow in square planters, and a fountain sits at the most open spot, if there's
// room for one.
export const PLAZA_COLORS = [0xb7b0a4, 0xc4a88a, 0x9c9fa4, 0xd6cfc0];
export const Y_PLAZA = 0.07;
const PLAZA_LAMP_SPACING = 13;
const PAVING_FRAGMENT_PARS = `
  varying vec3 vPaveWorldPos;
  uniform int uPavePattern;
  uniform float uPaveScale;
  float paveHash(vec2 p) { p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
`;
const PAVING_COLOR_FRAGMENT = `
  {
    vec2 wp = vPaveWorldPos.xz;
    float edgeDist = -1.0;
    vec2 id = vec2(0.0);
    if (uPavePattern == 1) {
      // herringbone: 2:1 bricks laid at 45 degrees. In brick units, horizontal bricks cover [k, k+2] x [k+4m, k+4m+1] and
      // vertical ones [k, k+1] x [k+4m+1, k+4m+3] — together they tile the plane, so a point is in exactly one of them.
      float unit = 0.6*uPaveScale;
      vec2 p = vec2(wp.x + wp.y, wp.y - wp.x)*0.70710678/unit;
      float k1 = floor(p.x);
      for (int j=0; j<2; j++) {
        float k = k1 - float(j), t = p.y - k, m = floor(t/4.0), v = t - 4.0*m, u = p.x - k;
        if (edgeDist < 0.0 && v < 1.0) { edgeDist = min(min(u, 2.0-u), min(v, 1.0-v)); id = vec2(k, m*2.0); }
      }
      if (edgeDist < 0.0) {
        float t = p.y - k1 - 1.0, m = floor(t/4.0), v = t - 4.0*m, u = p.x - k1;
        edgeDist = min(min(u, 1.0-u), min(v, 2.0-v)); id = vec2(k1, m*2.0 + 1.0);
      }
      edgeDist *= unit;
    } else {
      float size = 2.4*uPaveScale;
      vec2 p = wp/size, f = fract(p);
      id = floor(p);
      edgeDist = min(min(f.x, 1.0-f.x), min(f.y, 1.0-f.y))*size;
    }
    float grout = smoothstep(0.03, 0.08, edgeDist);
    float tint = 0.9 + 0.2*paveHash(id + 17.0);
    diffuseColor.rgb *= mix(0.62, tint, grout);
  }
`;
export function applyPavingShader(mat, pattern, scale) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPavePattern = { value: pattern };
    shader.uniforms.uPaveScale = { value: scale || 1 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaveWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaveWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PAVING_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PAVING_COLOR_FRAGMENT);
  };
}
// A round stone fountain of radius r centered at c ({x,z}), standing on the plaza.
function buildFountain(c, r) {
  const group = new THREE.Group();
  group.name = 'Fountain';
  const stone = new THREE.MeshStandardMaterial({ color: 0xa9a49b, roughness: 0.8, side: THREE.DoubleSide });
  const rimH = 0.65, rimW = 0.35, inner = r - rimW;
  const place = (mesh, y) => { mesh.position.set(c.x, Y_PLAZA + y, c.z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh; };
  place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, rimH, 48, 1, true), stone), rimH/2);
  place(new THREE.Mesh(new THREE.CylinderGeometry(inner, inner, rimH, 48, 1, true), stone), rimH/2);
  place(new THREE.Mesh(new THREE.RingGeometry(inner, r, 48).rotateX(-Math.PI/2), stone), rimH);
  // the pool: the water shader, with the basin's inner wall as its shore
  const shore = [];
  for (let i=0;i<32;i++) {
    const a0 = i/32*Math.PI*2, a1 = (i+1)/32*Math.PI*2;
    shore.push([c.x + Math.cos(a0)*inner, c.z + Math.sin(a0)*inner, c.x + Math.cos(a1)*inner, c.z + Math.sin(a1)*inner]);
  }
  const waterMat = new THREE.MeshStandardMaterial({ color: App.WATER_COLOR, roughness: 1 });
  App.applyWaterShader(waterMat, shore, [], 0);
  const pool = place(new THREE.Mesh(new THREE.CircleGeometry(inner, 48).rotateX(-Math.PI/2), waterMat), rimH - 0.15);
  pool.castShadow = false;
  // a pedestal in the middle holding up a smaller bowl, and a spout of water rising from it
  place(new THREE.Mesh(new THREE.CylinderGeometry(r*0.1, r*0.15, 1.5, 16), stone), 0.75);
  place(new THREE.Mesh(new THREE.CylinderGeometry(r*0.34, r*0.2, 0.28, 24), stone), 1.64);
  place(new THREE.Mesh(new THREE.CylinderGeometry(r*0.05, r*0.08, 0.7, 12), stone), 2.1);
  const spray = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.16, 1.4, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xe8f6ff, transparent: true, opacity: 0.55, roughness: 0.2, depthWrite: false }));
  spray.position.set(c.x, Y_PLAZA + 3.1, c.z);
  group.add(spray);
  return group;
}
// `cutouts` are cut out of the paving; `blockers` (cut-outs plus paths) are where nothing's placed
export function generatePlazaContent(zone, poly, cutouts, blockers) {
  const s = zone.settings, rng = mulberry32(s.seed>>>0);
  const { ctDifference } = ClipperLib.ClipType;
  const { jtMiter, jtRound } = ClipperLib.JoinType;
  const color = s.pavingColor!=null ? s.pavingColor : PLAZA_COLORS[0];
  const pattern = s.pavingPattern==='herringbone' ? 1 : 0;
  const paveScale = s.pavingScale!=null ? s.pavingScale : 1;
  const floor = makeFlatZoneMesh(poly, color, Y_PLAZA, 'Plaza', mat => applyPavingShader(mat, pattern, paveScale), cutouts);
  if (!floor) return;
  zone.buildingsGroup.add(floor);
  const area = clipPolygons(ctDifference, [App.toClipperPath(poly)], cutouts);
  // the border: a band of darker, smaller paving just inside the edge
  const bandBuilder = createMeshBuilder();
  bandBuilder.addTops(clipPolygons(ctDifference, area, App.offsetPaths(area, -1.2, jtMiter), true), Y_PLAZA + 0.01);
  const bandGeo = bandBuilder.build();
  if (bandGeo) {
    const bandMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72), roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    applyPavingShader(bandMat, 0, 0.3*paveScale);
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.receiveShadow = true;
    band.name = 'PlazaBorder';
    zone.buildingsGroup.add(band);
  }
  const inArea = App.createRegionTester(area);
  const blocked = App.createRegionTester(blockers.length ? App.offsetPaths(blockers, 1.2, jtRound) : []);
  // the fountain goes at the most open spot: the sample point furthest from the plaza's edge and anything crossing it
  const obstacles = App.edgeSegmentsOf(area.concat(blockers), 800);
  const distToObstacle = p => obstacles.reduce((m, [ax, az, bx, bz]) => Math.min(m, distPointSegment(p, { x:ax, z:az }, { x:bx, z:bz })), Infinity);
  let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
  poly.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); });
  let fountain = null;
  if (s.fountain !== false) {
    let best = null;
    for (let i=0;i<24;i++) for (let j=0;j<24;j++) {
      const p = { x: minX + (maxX-minX)*(i+0.5)/24, z: minZ + (maxZ-minZ)*(j+0.5)/24 };
      if (!inArea(p.x, p.z) || blocked(p.x, p.z)) continue;
      const d = distToObstacle(p);
      if (!best || d > best.d) best = { p, d };
    }
    const r = best ? Math.min(7, best.d*0.45) : 0;
    if (r >= 2.2) {
      fountain = { x: best.p.x, z: best.p.z, r };
      zone.buildingsGroup.add(buildFountain(best.p, r));
    }
  }
  zone.fountainSpot = fountain; // so people hanging out here keep out of the pool (see "people")
  const clearOfFountain = (x, z, gap) => !fountain || Math.hypot(x-fountain.x, z-fountain.z) > fountain.r + gap;
  // lamp posts every PLAZA_LAMP_SPACING around the edge, with a bench facing inward halfway between each pair — room for two
  // on each, who people can sit down in (see "people")
  const furniture = createMeshBuilder(), lampHeads = createMeshBuilder();
  const lampGlobe = new THREE.IcosahedronGeometry(0.3, 1);
  const seatTop = Y_PLAZA + 0.42;
  zone.benchSeats = [];
  App.offsetPaths(area, -2.2, jtMiter).forEach(path => {
    const pts = App.fromClipperPath(path);
    // Which way the plaza's inside lies: to the left of the way round an outline runs, and to the right around a hole. Its
    // signed area tells the two apart wherever the contour is — a point sample can't, where the paving is narrower than the
    // bench, and a bench that guesses wrong sits outside the plaza with its back to it.
    let twiceArea = 0;
    pts.forEach((a, i) => { const b = pts[(i+1)%pts.length]; twiceArea += a.x*b.z - b.x*a.z; });
    const side = twiceArea > 0 ? 1 : -1;
    let untilNext = PLAZA_LAMP_SPACING/2, lamp = true;
    pts.forEach((a, i) => {
      const b = pts[(i+1)%pts.length], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len < 1e-6) return;
      const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len;
      let d = untilNext;
      for (; d <= len; d += PLAZA_LAMP_SPACING/2, lamp = !lamp) {
        const x = a.x + dx*d, z = a.z + dz*d;
        if (blocked(x, z) || !clearOfFountain(x, z, 2)) continue;
        if (lamp) {
          furniture.addBox(x, z, dx, dz, 0.08, 0.08, Y_PLAZA, Y_PLAZA + 4.2);
          furniture.addBox(x, z, dx, dz, 0.2, 0.2, Y_PLAZA, Y_PLAZA + 0.35);
          lampHeads.addGeometry(lampGlobe, x, Y_PLAZA + 4.45, z);
        } else {
          const bx = x - dz*1.1*side, bz = z + dx*1.1*side, nx = -dz*side, nz = dx*side;
          if (blocked(bx, bz)) continue;
          furniture.addBox(bx, bz, dx, dz, 0.95, 0.26, seatTop - 0.1, seatTop);                   // seat
          furniture.addBox(bx - nx*0.22, bz - nz*0.22, dx, dz, 0.95, 0.05, seatTop, seatTop + 0.45); // backrest, away from the plaza
          [-0.8, 0.8].forEach(o => furniture.addBox(bx + dx*o, bz + dz*o, dx, dz, 0.05, 0.22, Y_PLAZA, seatTop - 0.1));
          [-0.45, 0.45].forEach(o => zone.benchSeats.push({ x: bx + dx*o, z: bz + dz*o, y: seatTop, nx, nz }));
        }
      }
      untilNext = d - len;
    });
  });
  // Trees in square planters, laid out in rows rather than scattered: a grid squared up with the plaza's longest edge and
  // centred on it, so the trees line up with the paving and each other. The spacing is whatever makes as many of the grid's
  // spots land on open ground as the tree setting asks for — spread wider for a few trees, tighter for many.
  const deepInside = App.createRegionTester(App.offsetPaths(area, -4, jtMiter));
  const targetTrees = Math.round((s.plazaTrees!=null ? s.plazaTrees : 0.35)*16);
  let ux = 1, uz = 0, longest = 0;
  poly.forEach((a, i) => {
    const b = poly[(i+1)%poly.length], len = Math.hypot(b.x-a.x, b.z-a.z);
    if (len > longest) { longest = len; ux = (b.x-a.x)/len; uz = (b.z-a.z)/len; }
  });
  const cx = (minX+maxX)/2, cz = (minZ+maxZ)/2, reach = Math.hypot(maxX-minX, maxZ-minZ)/2;
  // every spot on a grid of this spacing that a tree can stand on, nearest the middle of the plaza first
  const gridSpots = (spacing) => {
    const spots = [], n = Math.ceil(reach/spacing);
    for (let i=-n; i<=n; i++) for (let j=-n; j<=n; j++) {
      const x = cx + ux*i*spacing - uz*j*spacing, z = cz + uz*i*spacing + ux*j*spacing;
      if (!deepInside(x, z) || blocked(x, z) || !clearOfFountain(x, z, 3)) continue;
      spots.push({ x, z, d: Math.hypot(x-cx, z-cz) });
    }
    return spots.sort((a, b) => a.d - b.d);
  };
  let planted = targetTrees > 0 ? gridSpots(7) : [];
  if (planted.length > targetTrees) { // too many at the tightest spacing: open the grid up until only as many fit as we want
    let lo = 7, hi = Math.max(14, reach*2);
    for (let i=0; i<12; i++) {
      const mid = (lo+hi)/2, spots = gridSpots(mid);
      if (spots.length > targetTrees) lo = mid; else { hi = mid; planted = spots; }
    }
  }
  planted.slice(0, targetTrees).forEach(({ x, z }) => {
    furniture.addBox(x, z, ux, uz, 0.95, 0.95, Y_PLAZA, Y_PLAZA + 0.55);
    const tree = makeTreeMesh(1, 1.4 + rng()*0.7, rng, resolveTreeTint(zone));
    tree.position.set(x, Y_PLAZA + 0.55, z);
    tree.rotation.y = rng()*Math.PI*2;
    zone.buildingsGroup.add(tree);
  });
  const furnitureGeo = furniture.build();
  if (furnitureGeo) {
    const mesh = new THREE.Mesh(furnitureGeo, new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.7, metalness: 0.2 }));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'PlazaFurniture';
    zone.buildingsGroup.add(mesh);
  }
  const headGeo = lampHeads.build();
  if (headGeo) {
    const glow = new THREE.MeshStandardMaterial({ color: 0xfff1d6, roughness: 0.4, emissive: 0xffd08a, emissiveIntensity: 1.6*computeWindowGlowFactor(S.sunElevation) });
    glow.userData.baseEmissiveIntensity = 1.6; // lit after dark (see updateWindowGlowForSun)
    const mesh = new THREE.Mesh(headGeo, glow);
    mesh.name = 'PlazaLamps';
    zone.buildingsGroup.add(mesh);
  }
}
