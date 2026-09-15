import * as THREE from 'three';
import { App } from '../core/shared.js';
import { Y_ZONE_GROUND, Y_PARK } from '../core/scene.js';
import { mulberry32, polygonArea, pointInPolygon, centroid, convexHull, minAreaRect, recursiveSubdivide } from '../core/math.js';
import { createMeshBuilder } from '../roads/roads.js';
import { makeFlatZoneMesh } from './surface-detail.js';

// ---------------------------------------------------------- farmland
// Farmland is split into fields, like lots, with dirt tracks between them. Each field grows a crop — drawn by a shader as
// rows running along the field's longer side, with slow patches of lighter and darker growth across it — and some are
// lined with hedgerows, as is the farmland's edge (with gaps where roads and paths come through). A farmstead — a barn with
// a silo and a shed — stands in some of the bigger fields.
const FARM_TRACK_COLOR = 0x8f7b5e;
const CROPS = [
  { color:0xd9bc5c, spacing:0.9, contrast:0.16 },  // wheat
  { color:0xcfc47e, spacing:0.8, contrast:0.14 },  // barley
  { color:0x86ad48, spacing:1.4, contrast:0.3 },   // leafy crop
  { color:0x9cbf5c, spacing:1.7, contrast:0.5 },   // young shoots, with soil showing between the rows
  { color:0x7d5d3f, spacing:1.1, contrast:0.35 },  // ploughed soil
  { color:0xd6c554, spacing:0.9, contrast:0.1 },   // rapeseed
  { color:0x9588ad, spacing:1.8, contrast:0.4 },   // lavender
  { color:0x93b862, spacing:3.0, contrast:0.06 },  // pasture
];
const CROP_FRAGMENT_PARS = `
  varying vec3 vCropWorldPos;
  uniform vec2 uRowDir;
  uniform float uRowSpacing;
  uniform float uRowContrast;
  float cropHash(vec2 p) { p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float cropNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = cropHash(i), b = cropHash(i+vec2(1.0,0.0)), c = cropHash(i+vec2(0.0,1.0)), d = cropHash(i+vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
`;
const CROP_COLOR_FRAGMENT = `
  {
    vec2 wp = vCropWorldPos.xz;
    float ridge = smoothstep(0.15, 0.85, abs(fract(dot(wp, uRowDir)/uRowSpacing) - 0.5)*2.0);
    float patches = cropNoise(wp*0.06)*0.6 + cropNoise(wp*0.23)*0.4;
    vec3 c = diffuseColor.rgb*mix(1.0 - uRowContrast, 1.0 + uRowContrast*0.35, ridge);
    c *= (0.86 + 0.28*patches)*(0.95 + 0.1*cropNoise(wp*2.7));
    diffuseColor.rgb = c;
  }
`;
// rows run across (dx, dz): the stripes are perpendicular to it
export function applyCropShader(mat, dx, dz, spacing, contrast) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRowDir = { value: new THREE.Vector2(dx, dz) };
    shader.uniforms.uRowSpacing = { value: spacing };
    shader.uniforms.uRowContrast = { value: contrast };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCropWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCropWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CROP_FRAGMENT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + CROP_COLOR_FRAGMENT);
  };
}
// the long axis (unit vector) of a polygon's minimum-area bounding rectangle, with that rectangle
export function longAxisOf(poly) {
  const rect = minAreaRect(convexHull(poly));
  const angle = rect.width >= rect.height ? rect.angle : rect.angle + Math.PI/2;
  return { rect, dx: Math.cos(angle), dz: Math.sin(angle), halfLong: Math.max(rect.width, rect.height)/2, halfShort: Math.min(rect.width, rect.height)/2 };
}
// A mesh from a mesh builder, in a flat color — null if the builder's empty.
export function builderMesh(builder, color, name, opts) {
  const geo = builder.build();
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...(opts || {}) }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}
// a gable roof over the rectangle centered on (cx, cz) with half-length L along (dx, dz) and half-width W across it,
// its eaves at y0 and ridge `rise` above them; the sloped faces go in `roof`, the triangular gable ends in `walls`
export function addGableRoof(roof, walls, cx, cz, dx, dz, L, W, y0, rise) {
  const nx = -dz, nz = dx;
  const at = (s, w, y) => ({ x: cx + dx*s + nx*w, y, z: cz + dz*s + nz*w });
  [1, -1].forEach(side => {
    const len = Math.hypot(rise, W);
    roof.addQuad(at(-L, W*side, y0), at(L, W*side, y0), at(L, 0, y0+rise), at(-L, 0, y0+rise), { x: nx*side*rise/len, y: W/len, z: nz*side*rise/len });
    walls.addQuad(at(L*side, -W, y0), at(L*side, W, y0), at(L*side, 0, y0+rise), at(L*side, 0, y0+rise), { x: dx*side, y: 0, z: dz*side });
  });
}
export function generateFarmlandContent(zone, poly, cutouts, blockers) {
  const s = zone.settings, rng = mulberry32(s.seed>>>0);
  const tracks = makeFlatZoneMesh(poly, FARM_TRACK_COLOR, Y_ZONE_GROUND, 'FarmTracks', null, cutouts);
  if (tracks) zone.buildingsGroup.add(tracks);
  const lots = [];
  const targetFields = Math.max(1, Math.round(s.fieldCount!=null ? s.fieldCount : 14));
  recursiveSubdivide(poly, 0, { minArea: Math.abs(polygonArea(poly))/targetFields, maxDepth: 9, jitter: 0.5, minSplitDim: 6 }, rng, lots);
  const fields = [];
  lots.forEach(lot => App.cutLotByCutouts(lot, blockers).pieces.forEach(piece => {
    App.insetPolygonExact(piece, 0.9).forEach(field => { if (field.length >= 3 && Math.abs(polygonArea(field)) > 20) fields.push(field); });
  }));
  const inBlocker = App.createRegionTester(blockers.length ? App.offsetPaths(blockers, 0.8, ClipperLib.JoinType.jtRound) : []);
  const hedges = createMeshBuilder();
  // a hedgerow along a line: a chain of leafy blocks of slightly varying size, skipping any that would stand in a blocker
  const hedgeAlong = line => {
    for (let i=0;i<line.length-1;i++) {
      const a = line[i], b = line[i+1], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len < 0.2) continue;
      const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len, pieces = Math.max(1, Math.round(len/1.6));
      for (let k=0;k<pieces;k++) {
        const t = (k+0.5)/pieces, x = a.x + (b.x-a.x)*t, z = a.z + (b.z-a.z)*t;
        if (inBlocker(x, z)) continue;
        hedges.addBox(x, z, dx, dz, len/pieces/2 + 0.1, 0.4 + rng()*0.12, Y_PARK, Y_PARK + 0.9 + rng()*0.5);
      }
    }
  };
  fields.forEach(field => {
    const crop = CROPS[Math.floor(rng()*CROPS.length)];
    const axis = longAxisOf(field);
    const across = rng() < 0.25; // most fields are ploughed along their length
    const mesh = makeFlatZoneMesh(field, crop.color, Y_PARK, 'Field', mat => applyCropShader(mat, across ? axis.dx : -axis.dz, across ? axis.dz : axis.dx, crop.spacing, crop.contrast));
    if (mesh) zone.buildingsGroup.add(mesh);
    if (s.hedgerows !== false && rng() < 0.5) {
      App.offsetPaths([App.toClipperPath(field)], 0.45, ClipperLib.JoinType.jtMiter).forEach(path => {
        const loop = App.fromClipperPath(path);
        // with a gateway left open somewhere along it
        const gate = Math.floor(rng()*loop.length);
        hedgeAlong(loop.slice(gate+1).concat(loop.slice(0, gate+1)));
      });
    }
  });
  if (s.hedgerows !== false) App.zoneFenceLines(zone, poly, 0.6).forEach(hedgeAlong);
  const hedgeMesh = builderMesh(hedges, 0x4d6a33, 'Hedgerow', { roughness: 1 });
  if (hedgeMesh) zone.buildingsGroup.add(hedgeMesh);
  // farmsteads, in some of the larger fields
  if (s.farmsteads !== false && fields.length) {
    const bySize = fields.slice().sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
    const count = Math.max(1, Math.round(fields.length/9));
    for (let i=0;i<count;i++) {
      const field = bySize[Math.min(bySize.length-1, Math.floor(rng()*Math.min(bySize.length, count*3)))];
      const spot = App.insetPolygonExact(field, 8)[0];
      if (!spot) continue;
      const c = centroid(spot);
      if (!pointInPolygon(c, spot)) continue;
      const { dx, dz } = longAxisOf(field), nx = -dz, nz = dx;
      const group = new THREE.Group();
      group.name = 'Building';
      const yard = createMeshBuilder(), barn = createMeshBuilder(), roof = createMeshBuilder(), silo = createMeshBuilder();
      yard.addBox(c.x, c.z, dx, dz, 10, 7.5, Y_PARK, Y_PARK + 0.04);
      barn.addBox(c.x, c.z, dx, dz, 6, 3.6, Y_PARK, Y_PARK + 4.2);
      addGableRoof(roof, barn, c.x, c.z, dx, dz, 6.3, 3.9, Y_PARK + 4.2, 2.6);
      const shed = { x: c.x - nx*6.5 + dx*2, z: c.z - nz*6.5 + dz*2 };
      barn.addBox(shed.x, shed.z, dx, dz, 2.4, 1.8, Y_PARK, Y_PARK + 2.4);
      addGableRoof(roof, barn, shed.x, shed.z, dx, dz, 2.6, 2.0, Y_PARK + 2.4, 1.1);
      [[yard, FARM_TRACK_COLOR, 'Farmyard'], [barn, 0x9d3d2f, 'Barn'], [roof, 0x4a4643, 'BarnRoof']].forEach(([builder, color, name]) => {
        const mesh = builderMesh(builder, color, name);
        if (mesh) group.add(mesh);
      });
      const siloMat = new THREE.MeshStandardMaterial({ color: 0xd3d6d8, roughness: 0.55, metalness: 0.1 });
      const siloAt = { x: c.x + dx*8.4 + nx*1.2, z: c.z + dz*8.4 + nz*1.2 };
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 9, 20), siloMat);
      body.position.set(siloAt.x, Y_PARK + 4.5, siloAt.z);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.6, 20, 8, 0, Math.PI*2, 0, Math.PI/2), siloMat);
      dome.position.set(siloAt.x, Y_PARK + 9, siloAt.z);
      [body, dome].forEach(m => { m.castShadow = true; m.receiveShadow = true; m.name = 'Silo'; group.add(m); });
      zone.buildingsGroup.add(group);
    }
  }
}
