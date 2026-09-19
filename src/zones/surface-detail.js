import * as THREE from 'three';
import { S, App, SAND_TINT } from '../core/shared.js';
import { Y_PARK } from '../core/scene.js';
import { mulberry32, lerp, pointInPolygon, centroid, insetPolygon } from '../core/math.js';
import { distPointSegment, distToPolygonBoundary } from '../buildings/footprints.js';
import { PARK_TINT_COLORS, resolveParkTint, resolveTreeTint, resolveGrassNoiseStrength, pickBuildingColor, accentColorFrom } from '../core/splines.js';
import { WINDOW_TILE_WORLD_SIZE, createWindowMaterial, mergeGeometries, mergeGeometryList, extractCapGeometry, buildWallGeometry, buildWedgeCapGeometry } from '../buildings/windows.js';
import { MIN_ZONE_TREES, MAX_ZONE_TREES } from '../core/state.js';
import { clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { scalePolygonAroundCentroid, makeExtrudeRaw, extrudeFootprintGeo } from './zone-visuals.js';
import { plantParkLife } from '../life/bees.js';

// ---------------------------------------------------------- surface detail (Y2K greebles/bands/rings)
// A slim torus ring around the building at zHeight, proud of the wall between its inner radius and tube.
function addRingAccent(group, c, ringRadius, tube, zHeight, colorHex) {
  const ringGeo = new THREE.TorusGeometry(Math.max(0.6,ringRadius), Math.max(0.06,tube), 8, 28);
  const ringMat = new THREE.MeshStandardMaterial({ color:colorHex, roughness:0.3, metalness:0.6, emissive:colorHex, emissiveIntensity:0.3 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(c.x, -c.z, zHeight);
  ring.castShadow = true;
  ring.name = 'Building';
  group.add(ring);
}
// A capped slab 0.35-0.85 tall around the footprint, its outline pushed out 0.12-0.22 past `poly` so the ledge stands
// proud of the wall rather than lying coplanar with it. Positioned with its bottom at bandBottom
function addAccentBand(group, poly, bandBottom, bandColor, rng) {
  const bandH = 0.35 + rng()*0.5;
  const bandPoly = insetPolygon(poly, -(0.12 + rng()*0.1));
  const bandGeo = extrudeFootprintGeo(bandPoly, bandH);
  const bandMat = new THREE.MeshStandardMaterial({ color:bandColor, roughness:0.3, metalness:0.6, emissive:bandColor, emissiveIntensity:0.25 });
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.z = bandBottom;
  band.castShadow = true; band.name = 'Building';
  group.add(band);
}
// 2-6 rooftop props scattered over the footprint: a point at random in its bounding box, kept if it's inside the poly
// and 0.8 clear of its edge, up to count*12 tries. `kind` picks one of: under 0.18 an AC unit, under 0.33 a vent pipe,
// under 0.46 a dish antenna on a mast, under 0.62 a squat water tank with a conical lid, under 0.77 clustered vent
// pipes, under 0.87 a helipad marking, else a row of tilted solar panels. All sit on top of height
function addRooftopGreebles(group, poly, height, rng) {
  const count = 2 + Math.floor(rng()*5);
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  poly.forEach(p => { if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x; if(p.z<minZ)minZ=p.z; if(p.z>maxZ)maxZ=p.z; });
  let placed=0, attempts=0;
  while (placed<count && attempts<count*12) {
    attempts++;
    const pt = { x:minX+rng()*(maxX-minX), z:minZ+rng()*(maxZ-minZ) };
    if (!pointInPolygon(pt, poly)) continue;
    if (distToPolygonBoundary(pt, poly) < 0.8) continue;
    const kind = rng();
    let obj;
    if (kind < 0.18) {
      // AC/HVAC unit
      const w=0.5+rng()*0.7, d=0.5+rng()*0.7, gh=0.3+rng()*0.6;
      obj = new THREE.Mesh(new THREE.BoxGeometry(w,d,gh), new THREE.MeshStandardMaterial({ color:0x6b6e73, roughness:0.8, metalness:0.2, flatShading:true }));
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height+gh/2);
    } else if (kind < 0.33) {
      // single vent pipe
      const r=0.15+rng()*0.2, gh=0.6+rng()*1.4;
      obj = new THREE.Mesh(new THREE.CylinderGeometry(r,r,gh,6), new THREE.MeshStandardMaterial({ color:0x888c92, roughness:0.5, metalness:0.4, flatShading:true }));
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height+gh/2);
    } else if (kind < 0.46) {
      // dish antenna on a mast
      const dishR=0.35+rng()*0.35, mastH=0.25+rng()*0.3;
      obj = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,mastH,5), new THREE.MeshStandardMaterial({ color:0x555a60 }));
      mast.position.y = mastH/2;
      const dish = new THREE.Mesh(new THREE.ConeGeometry(dishR, dishR*0.55, 12, 1, true), new THREE.MeshStandardMaterial({ color:0xd8dade, roughness:0.4, metalness:0.3, side:THREE.DoubleSide }));
      dish.rotation.x = Math.PI*0.62;
      dish.position.y = mastH + dishR*0.2;
      obj.add(mast, dish);
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height);
    } else if (kind < 0.62) {
      // squat water tank with a conical lid
      const tankR = 0.45+rng()*0.3, tankH = 0.8+rng()*0.6, lidH = tankR*0.7;
      obj = new THREE.Group();
      const tankMat = new THREE.MeshStandardMaterial({ color:0x8a8f96, roughness:0.6, metalness:0.35, flatShading:true });
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(tankR,tankR,tankH,10), tankMat);
      tank.position.y = tankH/2;
      const lid = new THREE.Mesh(new THREE.ConeGeometry(tankR*1.05, lidH, 10), new THREE.MeshStandardMaterial({ color:0x6f747a, roughness:0.6, metalness:0.3, flatShading:true }));
      lid.position.y = tankH + lidH/2;
      obj.add(tank, lid);
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height);
    } else if (kind < 0.77) {
      // clustered vent pipes
      obj = new THREE.Group();
      const clusterMat = new THREE.MeshStandardMaterial({ color:0x75797f, roughness:0.55, metalness:0.4, flatShading:true });
      const n = 3 + Math.floor(rng()*2);
      for (let i=0;i<n;i++) {
        const r=0.08+rng()*0.08, gh=0.35+rng()*0.5;
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r,r,gh,6), clusterMat);
        const off = 0.22+rng()*0.14, ang = rng()*Math.PI*2;
        pipe.position.set(Math.cos(ang)*off, gh/2, Math.sin(ang)*off);
        obj.add(pipe);
      }
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height);
    } else if (kind < 0.87) {
      // helipad marking
      const padR = 1.1+rng()*0.6, padH = 0.06;
      obj = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(padR,padR,padH,20), new THREE.MeshStandardMaterial({ color:0x2b2e33, roughness:0.7, metalness:0.1 }));
      base.position.y = padH/2;
      const marking = new THREE.Mesh(new THREE.CylinderGeometry(padR*0.62,padR*0.62,padH*1.6,20), new THREE.MeshStandardMaterial({ color:0xc7cad0, roughness:0.6, metalness:0.1, emissive:0xc7cad0, emissiveIntensity:0.25 }));
      marking.position.y = padH*1.6/2 + 0.001;
      obj.add(base, marking);
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height);
    } else {
      // row of angled solar panels
      obj = new THREE.Group();
      const panelMat = new THREE.MeshStandardMaterial({ color:0x1c2b3d, roughness:0.35, metalness:0.5, side:THREE.DoubleSide });
      const railMat = new THREE.MeshStandardMaterial({ color:0x555a60, roughness:0.6, metalness:0.4 });
      const n = 3 + Math.floor(rng()*3);
      const panelW = 0.55, panelLen = 0.9+rng()*0.4, tilt = 0.45+rng()*0.25, gap = 0.18;
      const rowAngle = rng()*Math.PI*2;
      const rowGroup = new THREE.Group();
      for (let i=0;i<n;i++) {
        const along = i*(panelW+gap);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(panelW, 0.05, panelLen), panelMat);
        rail.position.set(along, panelLen*0.5*Math.sin(tilt), 0);
        rail.rotation.x = tilt;
        const support = new THREE.Mesh(new THREE.BoxGeometry(0.06,0.3,0.06), railMat);
        support.position.set(along, 0.15, 0);
        rowGroup.add(support, rail);
      }
      rowGroup.position.set(-(n-1)*(panelW+gap)/2, 0, 0);
      rowGroup.rotation.y = rowAngle;
      obj.add(rowGroup);
      obj.rotation.x = Math.PI/2;
      obj.position.set(pt.x, -pt.z, height);
    }
    obj.traverse(o => { if (o.isMesh) { o.name='Building'; o.castShadow=true; } });
    group.add(obj);
    placed++;
  }
}

/**  Facade and structure detail added around the massing makeBuildingMesh has already built, so each is called
  independently on its own roll. Repeated small pieces (ribs, balcony ledges) are merged into one mesh per building
  through mergeGeometryList.
  Vertical fins or curtain-wall seams down each edge of the footprint, `spacing` apart, up to 40 of them and skipped
  entirely on edges shorter than 1.3*spacing. Each is ribWidth*ribDepth in section, ribSpanH = 0.86-0.96 of zHeight tall
  and centered in it, standing off the wall by half its depth less 0.03 */
function addVerticalRibs(group, poly, zBottom, zHeight, rng, ribColor) {
  const chunky = rng() < 0.5; // chunky structural fins vs frequent thin curtain-wall seams
  const ribWidth = chunky ? 0.28+rng()*0.14 : 0.09+rng()*0.06;
  const ribDepth = chunky ? 0.16+rng()*0.1  : 0.05+rng()*0.03;
  const spacing  = chunky ? 2.4+rng()*1.0   : 1.0+rng()*0.5;
  const ribSpanH = zHeight * (0.86+rng()*0.1);
  const zCenter = zBottom + zHeight/2;
  const c = centroid(poly), clx=c.x, cly=-c.z;
  const n = poly.length;
  const geos = [];
  for (let i=0;i<n && geos.length<40;i++) {
    const pa=poly[i], pb=poly[(i+1)%n];
    const ax=pa.x, ay=-pa.z, bx=pb.x, by=-pb.z;
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy)||1;
    const ux=dx/len, uy=dy/len;
    let nx=dy/len, ny=-dx/len;
    const midx=(ax+bx)/2, midy=(ay+by)/2;
    if (((midx-clx)*nx+(midy-cly)*ny) < 0) { nx=-nx; ny=-ny; }
    if (len < spacing*1.3) continue;
    const count = Math.max(1, Math.floor(len/spacing));
    const used = count*spacing;
    const start = (len-used)/2 + spacing/2;
    const edgeAngle = Math.atan2(uy,ux);
    for (let k=0;k<count && geos.length<40;k++) {
      const t = start + k*spacing;
      const px = ax+ux*t + nx*(ribDepth/2-0.03);
      const py = ay+uy*t + ny*(ribDepth/2-0.03);
      // box authored as (along the edge, out from it, height), turned to the edge's angle — a rotateZ is enough since
      // the height axis never moves
      const g = new THREE.BoxGeometry(ribWidth, ribDepth, ribSpanH);
      g.rotateZ(edgeAngle);
      g.translate(px, py, zCenter);
      geos.push(g);
    }
  }
  if (!geos.length) return;
  const mesh = new THREE.Mesh(mergeGeometryList(geos), new THREE.MeshStandardMaterial({ color:ribColor, roughness:0.6, metalness:0.3, flatShading:true }));
  mesh.castShadow = true; mesh.name = 'Building';
  group.add(mesh);
}
/** Balconies on 1-2 edges of the footprint (each at least 3 long), one per floor from floorH = 3-4.5 up to 1 below the
*   top: a ledge slab spanning the middle 70% of the edge and projecting 0.7-1.2 out, with a rail 0.85-1.0 tall and 0.06
 thick along its outer edge, in a see-through dark material*/
function addBalconies(group, poly, zBottom, zHeight, rng, balColor) {
  const n = poly.length;
  if (n < 3 || zHeight < 6) return;
  const c = centroid(poly), clx=c.x, cly=-c.z;
  const floorH = 3 + rng()*1.5;
  const floors = Math.floor(zHeight/floorH) - 1;
  if (floors < 1) return;
  const edgeCount = Math.min(n, 1+Math.floor(rng()*2));
  const chosen = new Set();
  while (chosen.size < edgeCount) chosen.add(Math.floor(rng()*n));
  const ledgeDepth = 0.7+rng()*0.5, ledgeH = 0.12, railH = 0.85+rng()*0.15, railThick = 0.06;
  const ledgeGeos = [], railGeos = [];
  chosen.forEach(i => {
    const pa=poly[i], pb=poly[(i+1)%n];
    const ax=pa.x, ay=-pa.z, bx=pb.x, by=-pb.z;
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy)||1;
    if (len < 3) return;
    const ux=dx/len, uy=dy/len;
    let nx=dy/len, ny=-dx/len;
    const midx=(ax+bx)/2, midy=(ay+by)/2;
    if (((midx-clx)*nx+(midy-cly)*ny) < 0) { nx=-nx; ny=-ny; }
    const span = len*0.7;
    const edgeAngle = Math.atan2(uy,ux);
    for (let f=1; f<=floors; f++) {
      const floorZ = zBottom + f*floorH;
      if (floorZ > zBottom+zHeight-1) break;
      const lg = new THREE.BoxGeometry(span, ledgeDepth, ledgeH);
      lg.rotateZ(edgeAngle);
      lg.translate(midx+nx*(ledgeDepth/2-0.05), midy+ny*(ledgeDepth/2-0.05), floorZ);
      ledgeGeos.push(lg);
      const rg = new THREE.BoxGeometry(span, railThick, railH);
      rg.rotateZ(edgeAngle);
      rg.translate(midx+nx*(ledgeDepth-0.03), midy+ny*(ledgeDepth-0.03), floorZ+ledgeH/2+railH/2);
      railGeos.push(rg);
    }
  });
  if (!ledgeGeos.length) return;
  const ledgeMesh = new THREE.Mesh(mergeGeometryList(ledgeGeos), new THREE.MeshStandardMaterial({ color:balColor, roughness:0.7, metalness:0.15, flatShading:true }));
  ledgeMesh.castShadow = true; ledgeMesh.name = 'Building';
  group.add(ledgeMesh);
  const railMesh = new THREE.Mesh(mergeGeometryList(railGeos), new THREE.MeshStandardMaterial({ color:0x2a2d32, roughness:0.4, metalness:0.5, transparent:true, opacity:0.55 }));
  railMesh.castShadow = true; railMesh.name = 'Building';
  group.add(railMesh);
}
function addEntranceCanopy(group, poly, rng, canopyColor) {
  const n = poly.length;
  if (n < 3) return;
  const c = centroid(poly), clx=c.x, cly=-c.z;
  const i = Math.floor(rng()*n);
  const pa=poly[i], pb=poly[(i+1)%n];
  const ax=pa.x, ay=-pa.z, bx=pb.x, by=-pb.z;
  const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy)||1;
  if (len < 2.5) return;
  const ux=dx/len, uy=dy/len;
  let nx=dy/len, ny=-dx/len;
  const midx=(ax+bx)/2, midy=(ay+by)/2;
  if (((midx-clx)*nx+(midy-cly)*ny) < 0) { nx=-nx; ny=-ny; }
  const canopyW = Math.min(len*0.5, 2.5+rng()*1.5);
  const canopyDepth = 1.4+rng()*1.0;
  const canopyH = 0.18;
  const zCenter = 2.6+rng()*0.6;
  const edgeAngle = Math.atan2(uy,ux);
  const geo = new THREE.BoxGeometry(canopyW, canopyDepth, canopyH);
  geo.rotateZ(edgeAngle);
  geo.translate(midx+nx*canopyDepth/2, midy+ny*canopyDepth/2, zCenter);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color:canopyColor, roughness:0.4, metalness:0.5, flatShading:true }));
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'Building';
  group.add(mesh);
  const strutMat = new THREE.MeshStandardMaterial({ color:0x555a60, roughness:0.5, metalness:0.5 });
  const strutH = zCenter - canopyH/2;
  [-0.32, 0.32].forEach(sOff => {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,strutH,6), strutMat);
    strut.rotation.x = Math.PI/2;
    strut.position.set(midx+ux*canopyW*sOff+nx*canopyDepth*0.85, midy+uy*canopyW*sOff+ny*canopyDepth*0.85, strutH/2);
    strut.castShadow = true; strut.name = 'Building';
    group.add(strut);
  });
}
function addExoskeletonAccent(group, corners, zBottom, zHeight, rng, accentColor) {
  // corner pilasters proud of each vertex, bisecting the two adjacent edges' outward
  // normals — reads as an exposed structural frame at the building's corners.
  const n = corners.length;
  if (n < 3) return;
  const c = centroid(corners), clx=c.x, cly=-c.z;
  function edgeNormal(pA, pB) {
    const ax=pA.x, ay=-pA.z, bx=pB.x, by=-pB.z;
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy)||1;
    let nx=dy/len, ny=-dx/len;
    const midx=(ax+bx)/2, midy=(ay+by)/2;
    if (((midx-clx)*nx+(midy-cly)*ny) < 0) { nx=-nx; ny=-ny; }
    return { nx, ny };
  }
  const pilasterW = 0.3+rng()*0.15;
  const spanH = zHeight*(0.9+rng()*0.08);
  const zCenter = zBottom + zHeight/2;
  const geos = [];
  for (let i=0;i<n;i++) {
    const prev=corners[(i-1+n)%n], cur=corners[i], next=corners[(i+1)%n];
    const n1 = edgeNormal(prev, cur), n2 = edgeNormal(cur, next);
    let bx = n1.nx+n2.nx, by = n1.ny+n2.ny;
    const blen = Math.hypot(bx,by)||1; bx/=blen; by/=blen;
    const ax=cur.x, ay=-cur.z;
    const g = new THREE.BoxGeometry(pilasterW, pilasterW, spanH);
    g.translate(ax+bx*(pilasterW/2-0.02), ay+by*(pilasterW/2-0.02), zCenter);
    geos.push(g);
  }
  const mesh = new THREE.Mesh(mergeGeometryList(geos), new THREE.MeshStandardMaterial({ color:accentColor, roughness:0.45, metalness:0.55, flatShading:true }));
  mesh.castShadow = true; mesh.name = 'Building';
  group.add(mesh);
}
function buildLedgeCapGeometry(outerPoly, innerPoly) {
  // a flat "picture frame" annulus between two polygons sharing a center — the same Shape+hole
  // technique used for the map-image selection/hover outline rings, generalized to any polygon.
  const shape = new THREE.Shape();
  outerPoly.forEach((p,i) => { const sx=p.x, sy=-p.z; if (i===0) shape.moveTo(sx,sy); else shape.lineTo(sx,sy); });
  shape.closePath();
  const hole = new THREE.Path();
  innerPoly.forEach((p,i) => { const sx=p.x, sy=-p.z; if (i===0) hole.moveTo(sx,sy); else hole.lineTo(sx,sy); });
  hole.closePath();
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape);
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n*3).fill(0.82), 3));
  return geo;
}
function addRoofParapet(group, roofFootprint, roofZ, rng, roofMat, presetInnerPoly) {
  // A flat roof reads as unfinished without a lip. Raise a short wall around the real roof
  // edge, bring its top in slightly, and drop a matching inner wall back down — the existing
  // roof cap shows through the middle like a shallow recessed tray, so no new floor is needed.
  // `presetInnerPoly` (optional): a landmark's pyramid topper needs to agree on the exact same
  // recess opening as this parapet, computed once up front — see buildPyramidGeometry's caller.
  const rc = centroid(roofFootprint);
  let roofAvgR = 0; roofFootprint.forEach(p => roofAvgR += Math.hypot(p.x-rc.x, p.z-rc.z)); roofAvgR /= roofFootprint.length;
  if (roofAvgR < 1.5) return; // too small a roof for a meaningful ledge
  const parapetH = 0.35 + rng()*0.35;
  const innerPoly = presetInnerPoly || insetPolygon(roofFootprint, Math.min(0.35 + rng()*0.35, roofAvgR*0.4));
  if (innerPoly.length < 3) return;
  const outerWall = buildWallGeometry(roofFootprint, parapetH, null, WINDOW_TILE_WORLD_SIZE);
  const innerWall = buildWallGeometry(innerPoly, parapetH, null, WINDOW_TILE_WORLD_SIZE);
  const ledgeCap = buildLedgeCapGeometry(roofFootprint, innerPoly);
  ledgeCap.translate(0, 0, parapetH);
  const merged = mergeGeometries(mergeGeometries(outerWall, innerWall), ledgeCap);
  const mesh = new THREE.Mesh(merged, roofMat);
  mesh.position.z = roofZ;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'Building';
  group.add(mesh);
}
function buildPyramidGeometry(poly, apexHeight) {
  // A fan of triangles from each base edge to a single apex above centroid — the topper then
  // follows the actual footprint outline (chamfered, rounded, circular, whatever archetype was
  // picked) instead of a generic fixed-sided cone. flatShading derives real per-face normals
  // from screen-space derivatives, so the per-vertex normal here only needs to be reasonable,
  // not exact.
  const c = centroid(poly);
  const apx = c.x, apy = -c.z, apz = apexHeight;
  const n = poly.length;
  const positions = [], normals = [], uvs = [];
  for (let i=0;i<n;i++) {
    const pa = poly[i], pb = poly[(i+1)%n];
    const ax=pa.x, ay=-pa.z, bx=pb.x, by=-pb.z;
    positions.push(ax,ay,0, bx,by,0, apx,apy,apz);
    const e1x=bx-ax, e1y=by-ay, e2x=apx-ax, e2y=apy-ay, e2z=apz;
    let nx = e1y*e2z - 0*e2y, ny = 0*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.hypot(nx,ny,nz) || 1;
    nx/=len; ny/=len; nz/=len;
    const midx=(ax+bx)/2, midy=(ay+by)/2;
    if ((midx-c.x)*nx + (midy-(-c.z))*ny < 0) { nx=-nx; ny=-ny; nz=-nz; }
    normals.push(nx,ny,nz, nx,ny,nz, nx,ny,nz);
    uvs.push(0,0, 1,0, 0.5,1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals,3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  return geo;
}

export function makeBuildingMesh(poly,h,isLandmark,rng,windowsEnabled,colorVariation,windowScale,isRound,archetype,corners,litWindowChance,specularWindows) {
  const cv = colorVariation!=null ? colorVariation : 0.25;
  const tileSize = WINDOW_TILE_WORLD_SIZE * (windowScale!=null ? windowScale : 1);
  const { color, hue: buildingHue } = pickBuildingColor(rng, cv);
  // Every window decision (lit or not, style, glass tint, lit color and pattern) draws from an
  // isolated sub-generator, seeded by exactly one always-drawn value, rather than the shared
  // `rng` — so changing a window setting only ever changes window appearance, never the rolls
  // of later buildings in the stream.
  const texRng = mulberry32(Math.floor(rng()*0xffffffff)>>>0);
  const wantsLitWindows = windowsEnabled && texRng() < (litWindowChance!=null ? litWindowChance : 0.8);
  const litIntensity = wantsLitWindows ? (0.9+texRng()*0.6) : 0;
  const mat = new THREE.MeshStandardMaterial({ color, vertexColors:true, roughness:0.85, metalness:0.05, flatShading:true, side:THREE.DoubleSide });
  // one window material shared by every wall that gets windows (see addSegment, and the wedge top's walls)
  const windowMat = windowsEnabled ? createWindowMaterial(color, texRng, wantsLitWindows, litIntensity, windowScale, specularWindows) : null;
  // subtle bottom->top wall tint: mostly a soft (colorless) anodized-metal shading gradient,
  // occasionally a more saturated iridescent one for a Y2K "chromatic panel" look — only once
  // colorVariation has moved past the flat-gray range, so low variation stays truly monochrome.
  const iridescent = rng() < 0.18*THREE.MathUtils.clamp((cv-0.25)/0.75, 0, 1);
  const gradient = iridescent
    ? { c0:[0.7,0.82,1.0], c1:[1.2,0.98,1.06] }
    : { c0:[0.85,0.85,0.85], c1:[1.08,1.08,1.08] };
  const group = new THREE.Group();
  group.name = 'Building';
  const c = centroid(poly);
  let avgR = 0; poly.forEach(p => avgR += Math.hypot(p.x-c.x, p.z-c.z)); avgR /= poly.length;
  // How tall the BASE footprint's own wall actually stands before the building narrows,
  // angles away, or tops out with a cap/topper — ribs/balconies/exoskeleton accents are built
  // against this same base footprint, so anything taller than this would poke out past the
  // real roofline into a narrower or absent upper section. Defaults to the full height (matches
  // the flat-roof and tiered-first-tier cases); each other massing branch below overrides it.
  let baseWallHeight = h;
  // The actual top face — narrower than the base footprint whenever a branch steps the top in
  // — whether that top is flat at all, and the world Z it sits at. Dome-cap and wedge tops
  // aren't flat; landmarks ARE flat right at bodyH (a roof deck the topper rises from, exactly
  // like a real tower's mechanical deck + spire) even though the full building keeps climbing.
  let roofFootprint = poly;
  let flatRoof = false;
  let roofZ = h;
  // Precomputed for landmarks, so the pyramid topper's base and the parapet's inner recess
  // (added later, in the post-hoc section) agree on exactly the same opening instead of each
  // independently guessing an inset and risking the pyramid clipping through the parapet wall.
  let roofInnerPoly = null;

  // `noWindow`: a segment deliberately kept solid (the podium) — a solid-clad base reads as a
  // distinct plinth instead of the same glazed mass continuing straight down to the ground.
  function addSegment(footprint, segHeight, zOffset, noWindow) {
    if (windowMat && !noWindow && segHeight > 0.5) {
      // Walls take the window shader, fed this wall's real size and its height above the ground
      // (zOffset), so floors line up across every tier. The roof/floor caps are a separate mesh
      // with the plain material.
      const wallMesh = new THREE.Mesh(buildWallGeometry(footprint, segHeight, gradient, tileSize, zOffset), windowMat);
      wallMesh.position.z = zOffset;
      wallMesh.castShadow = true; wallMesh.receiveShadow = true;
      wallMesh.name = 'Building';
      group.add(wallMesh);
      const capMesh = new THREE.Mesh(extractCapGeometry(makeExtrudeRaw(footprint, segHeight)), mat);
      capMesh.position.z = zOffset;
      capMesh.castShadow = true; capMesh.receiveShadow = true;
      capMesh.name = 'Building';
      group.add(capMesh);
      return;
    }
    const geo = extrudeFootprintGeo(footprint, segHeight, gradient, tileSize);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = zOffset;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'Building';
    group.add(mesh);
  }

  if (isLandmark) {
    const bodyH = h * 0.76, toppH = h - bodyH;
    baseWallHeight = bodyH;
    flatRoof = true;
    roofFootprint = poly;
    roofZ = bodyH;
    addSegment(poly, bodyH, 0);
    // Computed once so the pyramid topper (if that's the roll below) and the parapet added
    // later in the post-hoc section agree on the exact same recess opening. roofFootprint is
    // just `poly` for landmarks, so the already-computed avgR applies directly here too.
    roofInnerPoly = insetPolygon(poly, Math.min(0.35 + rng()*0.35, avgR*0.4));
    const topperRoll = rng();
    // Domes are the signature look for a cylindrical tower, so give them most of the roll
    // once a building is round; non-round buildings never had that option, so their
    // cone/mast split is unchanged.
    const coneCut = isRound ? 0.15 : 0.4;
    const domeCut = isRound ? 0.85 : coneCut;
    if (topperRoll < coneCut) {
      // A pyramid built from the roof's own recessed opening (the same one the parapet uses),
      // not a generic fixed-sided cone — so its cross-section actually follows the building's
      // footprint (chamfered, rounded, circular, whatever archetype this tower got).
      const coneGeo = buildPyramidGeometry(roofInnerPoly, toppH);
      const coneMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.8), roughness:0.5, metalness:0.15, flatShading:true, side:THREE.DoubleSide });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.z = bodyH;
      cone.castShadow = true;
      cone.name = 'Building';
      group.add(cone);
    } else if (isRound && topperRoll < domeCut) {
      // glass observation dome — a hemisphere only reads right on a cylindrical tower
      const domeR = Math.max(1.6, avgR*0.62);
      const domeGeo = new THREE.SphereGeometry(domeR, 18, 12, 0, Math.PI*2, 0, Math.PI/2);
      const domeMat = new THREE.MeshStandardMaterial({ color:0xbfe6ff, transparent:true, opacity:0.55, roughness:0.1, metalness:0.1, side:THREE.DoubleSide });
      const dome = new THREE.Mesh(domeGeo, domeMat);
      dome.rotation.x = Math.PI/2;
      dome.position.set(c.x, -c.z, bodyH);
      dome.castShadow = true;
      dome.name = 'Building';
      group.add(dome);
    } else {
      // antenna mast with a blinking beacon
      const mastH = toppH*0.9;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.25,mastH,6), new THREE.MeshStandardMaterial({ color:0x888c92, roughness:0.4, metalness:0.6 }));
      mast.rotation.x = Math.PI/2;
      mast.position.set(c.x, -c.z, bodyH+mastH/2);
      mast.castShadow = true; mast.name = 'Building';
      group.add(mast);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.35,8,8), new THREE.MeshStandardMaterial({ color:0xff3b3b, emissive:0xff2222, emissiveIntensity:1 }));
      light.position.set(c.x, -c.z, bodyH+mastH);
      light.name = 'Building';
      light.userData = { isBlinkLight:true, blinkPhase: rng()*Math.PI*2 };
      group.add(light);
    }
    const wantsRing = rng() < 0.85;
    if (isRound && wantsRing) addRingAccent(group, c, avgR*(1.1+rng()*0.15), avgR*0.05, bodyH*(0.62+rng()*0.2), accentColorFrom(color, buildingHue, rng));
    if (rng() < 0.6) {
      addAccentBand(group, poly, bodyH*(0.18+rng()*0.12), accentColorFrom(color, buildingHue, rng), rng);
      if (rng() < 0.5) addAccentBand(group, poly, bodyH*(0.5+rng()*0.15), accentColorFrom(color, buildingHue, rng), rng);
    }
  } else {
    const roll = rng();
    // A round footprint weights massing heavily toward the dome cap — it's the signature
    // look for a cylindrical tower. Non-round keeps the original distribution (dome is simply
    // unreachable there; those rolls fall through to the wedge top).
    const flatCut = isRound ? 0.10 : 0.35;
    const setbackCut = isRound ? 0.20 : 0.55;
    const tieredCut = isRound ? 0.30 : 0.68;
    const domeCut = isRound ? 0.85 : tieredCut;
    flatRoof = roll < tieredCut;
    if (roll < flatCut) {
      addSegment(poly, h, 0);
    } else if (roll < setbackCut) {
      const mainH = h * (0.62 + rng()*0.12);
      const topH = h - mainH;
      const topFootprint = scalePolygonAroundCentroid(poly, 0.55 + rng()*0.15);
      addSegment(poly, mainH, 0);
      addSegment(topFootprint, topH, mainH);
      roofFootprint = topFootprint;
      baseWallHeight = mainH;
    } else if (roll < tieredCut) {
      const seg = h/3;
      const topTierFootprint = scalePolygonAroundCentroid(poly, 0.6);
      addSegment(poly, seg, 0);
      addSegment(scalePolygonAroundCentroid(poly, 0.8), seg, seg);
      addSegment(topTierFootprint, seg, seg*2);
      roofFootprint = topTierFootprint;
      baseWallHeight = seg; // only the first (widest) tier actually matches the base footprint
    } else if (isRound && roll < domeCut) {
      // glass dome cap — only on the circular/oval footprint archetype, otherwise it reads as
      // a mismatched hemisphere balanced on a boxy top; non-round rolls here fall through to the wedge top below
      const bodyH = h * (0.8 + rng()*0.1);
      baseWallHeight = bodyH;
      addSegment(poly, bodyH, 0);
      const domeR = Math.max(1.4, avgR*(0.68+rng()*0.22));
      const domeGeo = new THREE.SphereGeometry(domeR, 16, 10, 0, Math.PI*2, 0, Math.PI/2);
      const domeMat = new THREE.MeshStandardMaterial({ color:0xbfe6ff, transparent:true, opacity:0.5, roughness:0.1, metalness:0.1, side:THREE.DoubleSide });
      const dome = new THREE.Mesh(domeGeo, domeMat);
      dome.rotation.x = Math.PI/2;
      dome.position.set(c.x, -c.z, bodyH);
      dome.castShadow = true; dome.name = 'Building';
      group.add(dome);
    } else {
      // angled / cantilevered wedge top
      const baseH = h * (0.68 + rng()*0.14);
      const wedgeH = h - baseH;
      baseWallHeight = baseH;
      addSegment(poly, baseH, 0);
      const dirAngle = rng()*Math.PI*2;
      const minTop = wedgeH*(0.1+rng()*0.2), maxTop = wedgeH*(0.85+rng()*0.15);
      const wedgeGeo = buildWedgeCapGeometry(poly, baseH, minTop, maxTop, dirAngle, tileSize);
      const wedgeMesh = new THREE.Mesh(wedgeGeo, windowMat || mat);
      wedgeMesh.castShadow = true; wedgeMesh.receiveShadow = true; wedgeMesh.name = 'Building';
      group.add(wedgeMesh);
    }
    if (flatRoof && avgR>2.2 && rng()<0.4) addRooftopGreebles(group, roofFootprint, h, rng);
    const wantsRing2 = rng() < 0.65;
    if (isRound && wantsRing2) addRingAccent(group, c, avgR*(1.08+rng()*0.12), avgR*0.045, baseWallHeight*(0.5+rng()*0.3), accentColorFrom(color, buildingHue, rng));
    if (rng() < 0.6) {
      // scaled against baseWallHeight (not h) so both bands stay below wherever THIS massing
      // branch's own base-footprint wall actually ends — same reasoning as detailZHeight above
      addAccentBand(group, poly, baseWallHeight*(0.18+rng()*0.12), accentColorFrom(color, buildingHue, rng), rng);
      if (rng() < 0.5) addAccentBand(group, poly, baseWallHeight*(0.42+rng()*0.1), accentColorFrom(color, buildingHue, rng), rng);
    }
  }

  // -------- post-hoc facade/structure detail — adds to, never modifies, the massing above --------
  // Capped at baseWallHeight (how tall the base footprint's OWN wall actually stands for
  // whichever massing branch ran above) rather than a flat 0.82h guess — ribs/balconies/
  // exoskeleton are all built against the base footprint, so anything taller than that pokes
  // out past a narrower, angled, or absent upper section (most visible on landmarks, whose
  // body is a fixed 0.76h regardless of topper).
  const detailZHeight = Math.min(h * 0.82, baseWallHeight);
  if (rng() < 0.35 && h > 6) {
    // a wider, shorter podium collar around the base — additive, so it doesn't touch the
    // tower's own height budget or the segments already built above
    const podiumH = Math.min(h*0.22, 2+rng()*2);
    const podiumFootprint = insetPolygon(poly, -(0.6+rng()*0.9));
    addSegment(podiumFootprint, podiumH, 0, true);
  }
  if (rng() < 0.32) addVerticalRibs(group, poly, 0, detailZHeight, rng, accentColorFrom(color, buildingHue, rng));
  if (!isLandmark && avgR > 2.5 && rng() < 0.22) addBalconies(group, poly, 0, detailZHeight, rng, color.clone().multiplyScalar(0.92).getHex());
  if (rng() < 0.3) addEntranceCanopy(group, poly, rng, accentColorFrom(color, buildingHue, rng));
  if ((archetype==='rect' || archetype==='chamfer') && corners && rng() < (isLandmark ? 0.5 : 0.22)) {
    addExoskeletonAccent(group, corners, 0, detailZHeight, rng, accentColorFrom(color, buildingHue, rng));
  }
  // A flat roof always gets a parapet ledge — real flat roofs don't just end in a bare edge.
  if (flatRoof) addRoofParapet(group, roofFootprint, roofZ, rng, mat, roofInnerPoly);

  group.rotation.x = -Math.PI/2;
  return group;
}
export function makeParkMesh(poly, tintColor, noiseStrength, cutouts, beachSegments, wetCount) {
  // falls back to PARK_TINT_COLORS[0] (a natural yellow-green by default, white = fully
  // untinted) when no tint is passed; multiplies over the shader's own grayscale grass pattern
  return makeFlatZoneMesh(poly, tintColor!=null ? tintColor : PARK_TINT_COLORS[0], Y_PARK, 'Park', (mat) => applyGrassNoiseShader(mat, poly, noiseStrength, beachSegments, wetCount), cutouts);
}
// The sand shared by park beaches and beach zones, so the two meet without a seam: `p` is the world position, `wetDistance`
// how far it is from the water's edge (darker, still wet, within 1.5 units of it). Needs grassNoise.
const SAND_GLSL = `
  uniform vec3 uSandTint;
  // Four octaves, like the grass — one octave of value noise on its own is a single lattice of
  // smooth blobs about a third of a unit across, which is what made the sand look like a
  // low-resolution texture stretched over the beach however close you got to it.
  float sandFbm(vec2 p) {
    float v = 0.0, amp = 0.5;
    for (int i=0;i<4;i++) { v += amp*grassNoise(p); p = p*2.07 + 17.3; amp *= 0.5; }
    return v;
  }
  vec3 sandColor(vec2 p, float wetDistance) {
    // The World "Sand tint" swatch is the mid tone: broad patches drift between crests bleached
    // toward white and dips a shade deeper, rather than sitting on one flat khaki.
    vec3 sand = mix(mix(uSandTint, vec3(1.0), 0.16), uSandTint*0.86, smoothstep(0.25, 0.8, sandFbm(p*0.6)));
    sand *= 0.95 + 0.10*sandFbm(p*2.2);
    // A fine grain on top, at a scale far below the mottling. It has no mipmaps to fall back on,
    // so it's faded out once a pixel covers enough ground to alias against it (fwidth = how much
    // world one pixel spans here) — the beach keeps its grain up close and stays smooth from high up.
    float grain = grassNoise(p*13.0 + 31.7) - 0.5;
    sand *= 1.0 + 0.13*grain*(1.0 - smoothstep(0.03, 0.12, fwidth(p.x) + fwidth(p.y)));
    // wet sand darkens and loses some of its warmth rather than just dimming
    return sand*mix(vec3(0.63, 0.61, 0.60), vec3(1.0), smoothstep(0.0, 1.5, wetDistance));
  }
`;
const GRASS_NOISE_GLSL = `
  float grassHash(vec2 p) {
    p = fract(p*vec2(123.34, 456.21));
    p += dot(p, p+45.32);
    return fract(p.x*p.y);
  }
  float grassNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = grassHash(i), b = grassHash(i+vec2(1.0,0.0));
    float c = grassHash(i+vec2(0.0,1.0)), d = grassHash(i+vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
  // shortest distance from p to the segment a-b
  float grassDistToSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p-a, ba = b-a;
    float h = clamp(dot(pa,ba)/max(dot(ba,ba), 1e-6), 0.0, 1.0);
    return length(pa - ba*h);
  }
  // 1 while detail of this frequency is comfortably wider than a pixel, 0 once it isn't. None of
  // these noise layers has mipmaps to fall back on, so anything finer than the pixel grid can only
  // sparkle: fading it out instead is what lets the ground carry real detail up close and still go
  // smooth from high up. \`px\` is how much world one pixel spans (fwidth), in the same units as the
  // frequency.
  float grassDetailFade(float px, float freq) {
    return 1.0 - smoothstep(0.35, 1.1, px*freq);
  }
`;
// A beach zone's surface: all sand, wet along `wetSegments` (its edges that meet water), with faint wind-blown ripples.
// `allWet` makes it wet all over — for the beach slopes running down into the water.
export function applySandShader(mat, wetSegments, allWet) {
  const wet = App.segmentUniformArray(wetSegments, GRASS_MAX_BEACH_SEGMENTS);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSandTint = SAND_TINT;
    shader.uniforms.uWetSegments = { value: wet };
    shader.uniforms.uWetCount = { value: allWet ? 0 : Math.min(wetSegments.length, GRASS_MAX_BEACH_SEGMENTS) };
    shader.uniforms.uAllWet = { value: allWet ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSandWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSandWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        #define SAND_MAX_WET ${GRASS_MAX_BEACH_SEGMENTS}
        varying vec3 vSandWorldPos;
        uniform vec4 uWetSegments[SAND_MAX_WET];
        uniform int uWetCount;
        uniform int uAllWet;
        ${GRASS_NOISE_GLSL}
        ${SAND_GLSL}
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        {
          vec2 p = vSandWorldPos.xz;
          float wetDistance = uAllWet == 1 ? 0.0 : 1e9;
          for (int i=0; i<SAND_MAX_WET; i++) {
            if (i >= uWetCount) break;
            wetDistance = min(wetDistance, grassDistToSegment(p, uWetSegments[i].xy, uWetSegments[i].zw));
          }
          vec3 sand = sandColor(p, wetDistance);
          // soft ripples, bent by broad noise so they don't read as stripes — fading out toward the (flat, wet) waterline
          float ripple = sin(p.x*0.9 + p.y*0.35 + grassNoise(p*0.15)*6.0);
          sand *= 1.0 + 0.035*ripple*smoothstep(1.0, 4.0, wetDistance);
          diffuseColor.rgb = sand;
        }
      `);
  };
}
export function generateBeachContent(zone, poly, cutouts) {
  const ownArea = clipPolygons(ClipperLib.ClipType.ctDifference, [App.toClipperPath(poly)], cutouts);
  const wet = App.sharedEdgeSegmentsWith(ownArea, App.getWaterRegion(), GRASS_MAX_BEACH_SEGMENTS);
  const floor = makeFlatZoneMesh(poly, 0xffffff, Y_PARK, 'BeachFloor', mat => applySandShader(mat, wet), cutouts);
  if (floor) zone.buildingsGroup.add(floor);
}
// Fractal (fBM) value-noise grass shading, evaluated per-fragment from each vertex's real
// WORLD position (not local UV) — see the comment above the old texture code for why. Octaves at
// doubling frequency, from wandering patches a few units across down to tufts a few centimetres
// wide, give the "coarse patches + finer mottling + fine grain" look the old canvas texture had,
// but as one continuous function with no tile period at all and no resolution to run out of: each
// octave is faded out as it approaches the size of a pixel, so the ground carries its detail right
// up to the camera and still goes smooth from high above.
const GRASS_MAX_EDGE_POINTS = 48; // fixed GLSL array size; zone outlines beyond this are truncated
const GRASS_MAX_BEACH_SEGMENTS = 64; // fixed GLSL array size for the stretches of a park's edge that meet water
// `beachSegments` (optional): stretches of the park's edge where its grass turns to sand — the first `wetCount` meet water
// (the sand there is wet), the rest meet beach zones
export function applyGrassNoiseShader(mat, poly, noiseStrength, beachSegments, wetCount) {
  const beach = App.segmentUniformArray(beachSegments || [], GRASS_MAX_BEACH_SEGMENTS);
  const beachCount = Math.min((beachSegments || []).length, GRASS_MAX_BEACH_SEGMENTS);
  // Pad/truncate the zone's own world-space outline to a fixed-length array so it can be
  // uploaded as a uniform (GLSL array sizes must be compile-time constants) — padding entries
  // are never read since the shader loop stops at the real uEdgeCount regardless of array size.
  const n = Math.min(poly.length, GRASS_MAX_EDGE_POINTS);
  const edgePoints = [];
  for (let i=0;i<GRASS_MAX_EDGE_POINTS;i++) {
    const p = poly[Math.min(i, n-1)];
    edgePoints.push(new THREE.Vector2(p.x, p.z));
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSandTint = SAND_TINT; // the park's own sand fade, matching the beach beside it
    shader.uniforms.uZoneEdgePoints = { value: edgePoints };
    shader.uniforms.uZoneEdgeCount = { value: n };
    shader.uniforms.uZoneEdgeFalloff = { value: 3.0 }; // world units over which the darkening fades in
    shader.uniforms.uZoneEdgeDarken = { value: 0.7 };  // brightness multiplier right at the boundary
    // 0 = perfectly flat/uniform grey, 1 = the original fixed contrast, >1 exaggerates it further
    shader.uniforms.uGrassNoiseStrength = { value: noiseStrength!=null ? noiseStrength : 1.0 };
    shader.uniforms.uBeachSegments = { value: beach };
    shader.uniforms.uBeachCount = { value: beachCount };
    shader.uniforms.uBeachWetCount = { value: wetCount!=null ? wetCount : beachCount };
    shader.uniforms.uBeachWidth = { value: App.PARK_BEACH_WIDTH };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vGrassWorldPos;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vGrassWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        #define GRASS_MAX_EDGE_POINTS ${GRASS_MAX_EDGE_POINTS}
        #define GRASS_MAX_BEACH ${GRASS_MAX_BEACH_SEGMENTS}
        varying vec3 vGrassWorldPos;
        uniform vec2 uZoneEdgePoints[GRASS_MAX_EDGE_POINTS];
        uniform int uZoneEdgeCount;
        uniform float uZoneEdgeFalloff;
        uniform float uZoneEdgeDarken;
        uniform float uGrassNoiseStrength;
        uniform vec4 uBeachSegments[GRASS_MAX_BEACH];
        uniform int uBeachCount;
        uniform int uBeachWetCount;
        uniform float uBeachWidth;
        ${GRASS_NOISE_GLSL}
        ${SAND_GLSL}
        // Six octaves, not four, and each one turned 37° against the last: value noise sits on a
        // square lattice, so octaves stacked at the same angle line their cells up into a grid you
        // can see, and four of them bottom out at features about a third of a unit across — which
        // is what made the ground look like a low-resolution texture stretched over it up close.
        // Octaves too fine to draw at this distance are dropped (and the loop stops there, since
        // every later one is finer still), and what's left is renormalised so the contrast of the
        // pattern doesn't change as they go.
        float grassFbm(vec2 p, float px) {
          mat2 turn = mat2(0.799, 0.602, -0.602, 0.799);
          float v = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
          for (int i=0;i<6;i++) {
            float fade = grassDetailFade(px, freq);
            if (fade <= 0.0) break;
            v += amp*fade*grassNoise(p);
            norm += amp*fade;
            p = turn*p*2.03 + 19.1;
            freq *= 2.03;
            amp *= 0.5;
          }
          return norm > 0.0001 ? v/norm : 0.5;
        }
        // The finest layer, at blade scale (a road is 8 units wide, so these are a few centimetres
        // across): two noises, each stretched about 3:1 and lying at a different angle, so close up
        // the grass breaks into tufts rather than into either round dots or one direction of combing.
        float grassTufts(vec2 p, float px) {
          float v = 0.0;
          float fineFade = grassDetailFade(px, 11.0);
          if (fineFade <= 0.0) return v;
          v += (grassNoise(vec2(p.x*4.4 + p.y*11.0, p.y*4.4 - p.x*11.0)) - 0.5)*0.55*fineFade;
          float finerFade = grassDetailFade(px, 24.0);
          if (finerFade <= 0.0) return v;
          v += (grassNoise(vec2(p.x*24.0 - p.y*8.0, p.y*9.0 + p.x*3.0) + 61.3) - 0.5)*0.33*finerFade;
          // A third layer, finer again, for a camera down at ground level — from any normal height
          // it is already smaller than a pixel, so it costs nothing to look at the grass up close.
          float finestFade = grassDetailFade(px, 52.0);
          if (finestFade <= 0.0) return v;
          v += (grassNoise(vec2(p.x*52.0 + p.y*15.0, p.y*19.0 - p.x*6.0) + 8.9) - 0.5)*0.22*finestFade;
          return v;
        }
        // shortest distance from world position p to the zone's own boundary polygon —
        // walks every edge since a zone can be concave, where "nearest edge" isn't obvious
        float grassDistToZoneEdge(vec2 p) {
          float minDist = 1e9;
          for (int i=0; i<GRASS_MAX_EDGE_POINTS; i++) {
            if (i >= uZoneEdgeCount) break;
            int j = i+1;
            if (j >= uZoneEdgeCount) j = 0;
            minDist = min(minDist, grassDistToSegment(p, uZoneEdgePoints[i], uZoneEdgePoints[j]));
          }
          return minDist;
        }
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        {
          vec2 wp = vGrassWorldPos.xz;
          float px = fwidth(wp.x) + fwidth(wp.y); // how much world one pixel spans here
          vec2 gp = wp * 0.35;
          // The coarse patches are warped by a slower noise before they're read, so they clump and
          // wander instead of sitting in the evenly spaced round blobs a plain fBM makes.
          vec2 warp = vec2(grassNoise(gp*0.47 + 3.1), grassNoise(gp*0.47 + 17.9)) - 0.5;
          float n = grassFbm(gp + warp*0.9, px*0.35);
          float fine = grassNoise(gp*6.3);
          // Grayscale, not green — the grass tint is what actually colors this (diffuseColor
          // already carries it going into this block), so keeping the base neutral means the
          // tint you pick is close to the final rendered color instead of being muddied by
          // multiplying against an inherent green baked in here.
          // uGrassNoiseStrength scales the contrast around a fixed mid-grey: 0 collapses both
          // the coarse patches and the fine grain to perfectly flat, 1 matches the original
          // fixed contrast, and above 1 exaggerates it into a rougher, more mottled look.
          float grassMid = 0.59;
          float coarseHalf = 0.19 * uGrassNoiseStrength;
          float fineHalf = 0.08 * uGrassNoiseStrength;
          vec3 grassColor = vec3(grassMid + (n - 0.5) * 2.0 * coarseHalf) * (1.0 + (fine - 0.5) * 2.0 * fineHalf);
          // The blade-scale tufts follow the same slider — 0 is still perfectly flat — but along a
          // curve that rises fast and then levels off, so the turf keeps a tooth to it at the low
          // settings the broad mottling is meant to be barely visible at, and doesn't turn to
          // static at the high ones.
          float detail = uGrassNoiseStrength / (uGrassNoiseStrength + 0.45) * 1.45;
          grassColor *= 1.0 + grassTufts(wp, px) * 0.26 * detail;
          // A little hue along with the tone: bleached, yellower crests and cooler, deeper hollows.
          // Turf is never one hue, and a purely tonal noise still reads as one flat color with the
          // brightness turned up and down.
          grassColor *= mix(vec3(1.0), mix(vec3(1.045, 1.0, 0.93), vec3(0.955, 1.0, 1.06), smoothstep(0.3, 0.7, n)),
                            clamp(uGrassNoiseStrength, 0.0, 1.0));
          // subtle darkening as grass nears the zone boundary, fading in smoothly over
          // uZoneEdgeFalloff world units so it reads as a soft vignette, not a hard band
          float edgeDist = grassDistToZoneEdge(vGrassWorldPos.xz);
          float edgeT = smoothstep(0.0, uZoneEdgeFalloff, edgeDist);
          grassColor *= mix(uZoneEdgeDarken, 1.0, edgeT);
          diffuseColor.rgb *= grassColor;
          // sand where the park meets water or a beach zone: strongest at that edge (and darker, still wet, at the
          // water's), fading back into grass over about uBeachWidth units, with a ragged inland edge rather than a
          // ruler-straight one
          if (uBeachCount > 0) {
            float beachDistance = 1e9, wetDistance = 1e9;
            for (int i=0; i<GRASS_MAX_BEACH; i++) {
              if (i >= uBeachCount) break;
              float d = grassDistToSegment(vGrassWorldPos.xz, uBeachSegments[i].xy, uBeachSegments[i].zw);
              beachDistance = min(beachDistance, d);
              if (i < uBeachWetCount) wetDistance = min(wetDistance, d);
            }
            float reach = uBeachWidth*(0.75 + 0.5*grassNoise(vGrassWorldPos.xz*0.12));
            float sandT = 1.0 - smoothstep(reach*0.45, reach, beachDistance);
            diffuseColor.rgb = mix(diffuseColor.rgb, sandColor(vGrassWorldPos.xz, wetDistance), sandT);
          }
        }
      `);
  };
}
// `cutouts` (optional Clipper paths): areas to leave out of the surface — roads, and zones higher up the zone list (see
// "zone cut-outs"). Returns null if nothing is left.
// `depthBias` (default -2) is the polygon offset that decides which of two surfaces at nearly the same height wins: the
// world Y layers are only hundredths apart, which the depth buffer can't tell apart once the camera pulls back, so a
// surface meant to lie on top of another flat one needs a bias below the one underneath it (see the Fields in farmland.js).
export function makeFlatZoneMesh(poly, color, y, name, customShader, cutouts, depthBias) {
  const bias = depthBias != null ? depthBias : -2;
  const mat = new THREE.MeshStandardMaterial({ color, roughness:1, polygonOffset:true, polygonOffsetFactor:bias, polygonOffsetUnits:bias });
  if (customShader) customShader(mat);
  let mesh;
  if (cutouts && cutouts.length) {
    // the surface is the outline minus the cut-outs — possibly in several pieces, or with holes where a road loop or a
    // smaller zone above sits inside it
    const builder = createMeshBuilder();
    builder.addTops(clipPolygons(ClipperLib.ClipType.ctDifference, [App.toClipperPath(poly)], cutouts, true), y);
    const geo = builder.build();
    if (!geo) return null;
    mesh = new THREE.Mesh(geo, mat);
  } else {
    const shape = new THREE.Shape();
    poly.forEach((p,i) => { const sx=p.x, sy=-p.z; if (i===0) shape.moveTo(sx,sy); else shape.lineTo(sx,sy); });
    shape.closePath();
    mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    mesh.rotation.x=-Math.PI/2; mesh.position.y=y;
  }
  mesh.receiveShadow=true;
  mesh.name=name;
  return mesh;
}
// The underside of each variant's canopy and how wide it is down there, as a share of the tree's scale — read off the
// shapes below, and what a park's beehives hang from (see life/bees.js).
export const TREE_CANOPY = [
  { y: 1.0 + 1.7*0.42 - 1.7/2,   r: 0.55 }, // the single cone
  { y: 1.0 + 0.52*0.75 - 0.52,   r: 0.52 }, // the lower of the two clumps
  { y: 1.0 + 0.68*0.42 - 0.68/2, r: 0.62 }, // the fir's bottom tier
];
export function makeTreeMesh(variant, scale, rng, tintColor) {
  const group = new THREE.Group();
  const trunkH = 1.0*scale, trunkR = 0.12*scale;
  const trunkGeo = new THREE.CylinderGeometry(trunkR*0.7, trunkR, trunkH, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color:0x5b4632, roughness:0.9 });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = trunkH/2;
  trunk.castShadow = true; trunk.receiveShadow = true;
  group.add(trunk);

  // Grayscale (no inherent hue), with only a lightness jitter so a stand of trees still shows
  // real variety from sunlit to shaded — the tree tint is what actually colors this (see the
  // multiply below), so keeping the base neutral means the tint you pick closely matches the
  // final rendered color instead of being muddied by multiplying against a baked-in green.
  const foliageColor = new THREE.Color().setHSL(0, 0, THREE.MathUtils.clamp(0.55 + (rng()-0.5)*0.3, 0.25, 0.85));
  // tintColor multiplies over each tree's own randomly-rolled (grayscale) foliage color, same
  // pattern as the park's grass tint — white leaves the rolled grayscale color untouched, so
  // this only falls back to plain white if no tint is passed at all (see resolveTreeTint).
  foliageColor.multiply(new THREE.Color(tintColor!=null ? tintColor : 0xffffff));
  const foliageMat = new THREE.MeshStandardMaterial({ color:foliageColor, roughness:0.9 });

  if (variant===0) {
    // single-cone pine
    const h=1.7*scale, r=0.55*scale;
    const m = new THREE.Mesh(new THREE.ConeGeometry(r,h,10), foliageMat);
    m.position.y = trunkH + h*0.42;
    m.castShadow = true;
    group.add(m);
  } else if (variant===1) {
    // two stacked rounded clumps (bushy deciduous)
    const r1=0.52*scale, r2=0.36*scale;
    const m1 = new THREE.Mesh(new THREE.IcosahedronGeometry(r1,1), foliageMat);
    m1.position.y = trunkH + r1*0.75;
    const m2 = new THREE.Mesh(new THREE.IcosahedronGeometry(r2,1), foliageMat);
    m2.position.y = trunkH + r1*1.15 + r2*0.6;
    m1.castShadow = true; m2.castShadow = true;
    group.add(m1, m2);
  } else {
    // three-tier fir
    let y = trunkH;
    for (let t=0;t<3;t++) {
      const tr = (0.62-t*0.15)*scale, th=0.68*scale;
      const m = new THREE.Mesh(new THREE.ConeGeometry(tr,th,10), foliageMat);
      m.position.y = y + th*0.42;
      m.castShadow = true;
      group.add(m);
      y += th*0.58;
    }
  }
  group.name = 'Tree';
  return group;
}
// `cutouts` are cut out of the park's grass; `blockers` (cut-outs plus paths) are where trees can't go
export function generateParkContent(zone, poly, cutouts, blockers) {
  const rng = mulberry32(zone.settings.seed>>>0);
  // where the park meets water or a beach zone, its grass turns to sand along that edge (see applyGrassNoiseShader)
  const ownArea = clipPolygons(ClipperLib.ClipType.ctDifference, [App.toClipperPath(poly)], cutouts);
  const wet = App.sharedEdgeSegmentsWith(ownArea, App.getWaterRegion(), GRASS_MAX_BEACH_SEGMENTS);
  const beach = wet.concat(App.sharedEdgeSegmentsWith(ownArea, App.getBeachZoneArea(), GRASS_MAX_BEACH_SEGMENTS - wet.length));
  const floor = makeParkMesh(poly, resolveParkTint(zone), resolveGrassNoiseStrength(zone), cutouts, beach, wet.length);
  if (floor) { floor.name = 'ParkFloor'; zone.buildingsGroup.add(floor); }

  const s = zone.settings;
  // trees stand clear of roads, paths and zones above by the canopy radius of the biggest tree this park can grow
  // (the fir's bottom tier is the widest canopy, at 0.62 × tree scale)
  const treeBlockers = blockers || cutouts;
  const inCutout = App.createRegionTester(treeBlockers.length ? App.offsetPaths(treeBlockers, 0.62*s.treeSizeMax, ClipperLib.JoinType.jtRound) : []);
  // …and off the sand along any water's edge
  const onBeach = (x, z) => beach.some(([ax, az, bx, bz]) => distPointSegment({ x, z }, { x:ax, z:az }, { x:bx, z:bz }) < App.PARK_BEACH_WIDTH*1.25 + 0.62*s.treeSizeMax);
  // Flat target count, independent of zone size: density 0 -> 1 tree, density 1 -> MAX_ZONE_TREES.
  const targetCount = Math.round(MIN_ZONE_TREES + s.treeDensity * (MAX_ZONE_TREES - MIN_ZONE_TREES));
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  poly.forEach(p => { if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x; if(p.z<minZ)minZ=p.z; if(p.z>maxZ)maxZ=p.z; });
  const avgSize = (s.treeSizeMin+s.treeSizeMax)/2;
  const minSpacing = Math.max(0.7, avgSize*1.3);
  const placed = [];
  const maxAttempts = Math.max(250, targetCount*40);
  let attempts = 0;
  while (placed.length<targetCount && attempts<maxAttempts) {
    attempts++;
    const pt = { x: minX+rng()*(maxX-minX), z: minZ+rng()*(maxZ-minZ) };
    if (!pointInPolygon(pt, poly)) continue;
    if (distToPolygonBoundary(pt, poly) < s.treeSetback) continue;
    if (inCutout(pt.x, pt.z) || onBeach(pt.x, pt.z)) continue;
    let tooClose = false;
    for (const p of placed) { if (Math.hypot(p.x-pt.x, p.z-pt.z) < minSpacing) { tooClose=true; break; } }
    if (tooClose) continue;
    placed.push(pt);
  }
  zone.treeSpots = []; // so people sitting or lying on the grass keep clear of the trunks (see "people")
  const trees = [];    // and so a beehive knows what it's hanging under (see plantParkLife)
  placed.forEach(pt => {
    const variant = Math.floor(rng()*3);
    const scale = lerp(s.treeSizeMin, s.treeSizeMax, rng());
    const tree = makeTreeMesh(variant, scale, rng, resolveTreeTint(zone));
    tree.position.set(pt.x, Y_PARK, pt.z);
    tree.rotation.y = rng()*Math.PI*2;
    zone.buildingsGroup.add(tree);
    zone.treeSpots.push({ x: pt.x, z: pt.z, r: 0.35*scale });
    trees.push({ x: pt.x, z: pt.z, canopyY: TREE_CANOPY[variant].y*scale, canopyR: TREE_CANOPY[variant].r*scale });
  });
  // Flowers, hives and bees (see life/bees.js), off the same roads, paths and sand the trees keep off — but a flower is
  // small enough to stand where a tree couldn't, so it asks for the room it actually takes rather than a canopy's worth.
  const FLOWER_CLEARANCE = 0.3;
  const offFlowers = App.createRegionTester(treeBlockers.length ? App.offsetPaths(treeBlockers, FLOWER_CLEARANCE, ClipperLib.JoinType.jtRound) : []);
  const flowerOnBeach = (x, z) => beach.some(([ax, az, bx, bz]) => distPointSegment({ x, z }, { x:ax, z:az }, { x:bx, z:bz }) < App.PARK_BEACH_WIDTH*1.25 + FLOWER_CLEARANCE);
  const clearForFlower = (x, z) => pointInPolygon({ x, z }, poly) && distToPolygonBoundary({ x, z }, poly) >= FLOWER_CLEARANCE
    && !offFlowers(x, z) && !flowerOnBeach(x, z);
  const flowerSpot = () => {
    for (let i=0;i<60;i++) {
      const x = minX+rng()*(maxX-minX), z = minZ+rng()*(maxZ-minZ);
      if (clearForFlower(x, z)) return { x, z };
    }
    return null; // nowhere left in this park that a flower would fit
  };
  plantParkLife(zone, { rng, foliage: s.treeDensity, ground: Y_PARK, spot: flowerSpot, clear: clearForFlower, trees, tint: resolveTreeTint(zone) });
  // a fence around the park's edge, open wherever a road, river or path runs into it, and not along the water
  if (s.fence !== false) {
    const fence = App.buildRailingMesh(App.zoneFenceLines(zone, poly, 0.5), Y_PARK, App.PARK_FENCE_STYLE, 'Fence');
    if (fence) zone.buildingsGroup.add(fence);
  }
}

Object.assign(App, { applySandShader });
