import * as THREE from 'three';
import { S, App } from '../core/shared.js';

// ---------------------------------------------------------- road rendering
// Roads are built as three non-overlapping layers — road surface, curb, sidewalk — traced from the
// outline of the road network as a whole rather than laid down per line. Every line's centerline is
// stroked outward (round ends, mitered bends) at three radii: the road edge, the curb's outer edge, and
// the sidewalk's outer edge. The strokes at each radius are unioned, so a branch, a crossing, or a loop
// merges into one continuous outline; the curb is the ring between the curb outline and the road outline,
// and the sidewalk the ring between the sidewalk outline and the curb outline. Polygon offsetting and
// boolean ops are done by Clipper (clipper-lib); the resulting polygons — holes included, e.g. the block
// enclosed by a ring road — are triangulated with THREE.ShapeUtils. The road surface stays flat at Y_ROAD, sunk below
// the ground; curb and sidewalk together are one solid raised to Y_SIDEWALK, with a vertical face stepping down to the
// road along the road outline and one dropping to the ground along the outer outline.
const CURB_WIDTH = 0.5;
export const CURB_COLOR = 0x9c988d; // light concrete, deliberately not tied to the road's own color palette —
// kept a shade darker than typical real concrete since a near-white color specular-blows-out
// to solid white under steep sun angles on this material's roughness
const CURB_MIN_ROAD_WIDTH = 3; // narrower paths skip curbs entirely — not enough room to read as one
S.DEFAULT_SIDEWALK_WIDTH = 3;
export const SIDEWALK_COLOR = 0xb0ac9f;
export const SIDEWALK_COLOR_PALETTE = [0xb0ac9f]; // user-extendable palette; grows via the '+' swatch
export const CLIPPER_SCALE = 1000; // Clipper works in integer coordinates — 1000 per world unit
const ROAD_MITER_LIMIT = 4; // bends sharper than this square off instead of spiking outward
export const ROAD_ARC_TOLERANCE = 0.05; // max distance (world units) a rounded road end strays from a true arc
// The whole road network's footprint (road + curb + sidewalk) as Clipper paths, cached by rebuildRoadMeshes for
// zones to cut themselves with — see "zone cut-outs".
S.roadFootprint = [];
S.roadSurfaceOutline = [];
// Paths' footprint (the track itself, not its fade), cached alongside by rebuildRoadMeshes — zones keep lots, buildings
// and trees off it without cutting their ground (see "paths").
S.pathFootprint = [];
// Rivers' footprint (see "water"), and roads and rivers together — what cuts into every zone except water.
S.riverFootprint = [], S.riverFootprintKey = '', S.riverSeq = 0;
S.landCutFootprint = [];
// What rebuildWater needs to turn the parts of roads and paths over water into bridges, cached by rebuildRoadMeshes:
// each road network's share of the road outline ({ networkId, territory, strokes }) and each path network's centerlines.
S.roadBridgeSources = [], S.pathBridgeSources = [];
S.roadBuildSeq = 0;  // bumped on every road rebuild, so rebuildWater knows its bridges are out of date
S.waterDirty = true; // set by anything that can change the water or what crosses it; animate() rebuilds it once per frame
S.peopleNavDirty = true; // set whenever roads or zones change — see "people"
S.trafficNavDirty = true; // set whenever roads change — see "traffic"

// Half road width, curb width and sidewalk width for one line.
export function roadLineWidths(line) {
  const w = line.width || S.DEFAULT_ROAD_WIDTH;
  const cw = w >= CURB_MIN_ROAD_WIDTH ? Math.min(CURB_WIDTH, w*0.15) : 0; // proportionally thinner on narrower roads
  const sw = Math.max(line.sidewalkWidth!=null ? line.sidewalkWidth : S.DEFAULT_SIDEWALK_WIDTH, 0);
  return { hw: w/2, cw, sw };
}
// Union of every stroke in `strokes` ({ path: Clipper IntPoint[], radius }) — each one its centerline
// offset outward by `radius` to both sides, with round ends and mitered bends.
export function unionRoadStrokes(strokes) {
  const clipper = new ClipperLib.Clipper();
  strokes.forEach(({ path, radius }) => {
    if (!(radius > 0)) return;
    const offset = new ClipperLib.ClipperOffset(ROAD_MITER_LIMIT, ROAD_ARC_TOLERANCE*CLIPPER_SCALE);
    offset.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etOpenRound);
    const stroked = [];
    offset.Execute(stroked, radius*CLIPPER_SCALE);
    clipper.AddPaths(stroked, ClipperLib.PolyType.ptSubject, true);
  });
  const united = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, united, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return united;
}
// A boolean op between two sets of closed Clipper paths — as a PolyTree when `asTree`, which keeps each
// hole attached to the outline it belongs to (needed for triangulation), otherwise as flat paths.
export function clipPolygons(clipType, subject, clip, asTree) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = asTree ? new ClipperLib.PolyTree() : [];
  clipper.Execute(clipType, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}
// Collects triangles with explicit per-vertex normals — so flat tops and vertical walls both shade crisply —
// into one BufferGeometry.
export function createMeshBuilder() {
  const positions = [], normals = [], indices = [];
  const vertex = (x, y, z, n) => { positions.push(x, y, z); normals.push(n.x, n.y, n.z); return positions.length/3 - 1; };
  // winds a triangle so its front face points along its vertices' normal
  const triangle = (a, b, c) => {
    const ux=positions[b*3]-positions[a*3], uy=positions[b*3+1]-positions[a*3+1], uz=positions[b*3+2]-positions[a*3+2];
    const vx=positions[c*3]-positions[a*3], vy=positions[c*3+1]-positions[a*3+1], vz=positions[c*3+2]-positions[a*3+2];
    const facing = (uy*vz-uz*vy)*normals[a*3] + (uz*vx-ux*vz)*normals[a*3+1] + (ux*vy-uy*vx)*normals[a*3+2];
    if (facing < 0) indices.push(a, c, b); else indices.push(a, b, c);
  };
  return {
    // every polygon (with its holes) in a Clipper PolyTree, as flat faces at height y — facing up, or down if `facingDown`
    addTops(tree, y, facingDown) {
      const up = { x:0, y:facingDown ? -1 : 1, z:0 };
      const toVecs = path => path.map(p => new THREE.Vector2(p.X/CLIPPER_SCALE, p.Y/CLIPPER_SCALE));
      const addOutline = node => {
        const contour = toVecs(node.Contour());
        const holes = node.Childs().map(hole => toVecs(hole.Contour()));
        const tris = THREE.ShapeUtils.triangulateShape(contour, holes); // indexes the contour's points, then each hole's
        const base = positions.length/3;
        contour.concat(...holes).forEach(v => vertex(v.x, y, v.y, up));
        tris.forEach(([a, b, c]) => triangle(base+a, base+b, base+c));
        node.Childs().forEach(hole => hole.Childs().forEach(addOutline)); // islands sitting inside a hole
      };
      tree.Childs().forEach(addOutline);
    },
    // a vertical quad standing on the segment p→q (Clipper points), from y0 up to y1, facing `outward`
    addWall(p, q, y0, y1, outward) {
      const px=p.X/CLIPPER_SCALE, pz=p.Y/CLIPPER_SCALE, qx=q.X/CLIPPER_SCALE, qz=q.Y/CLIPPER_SCALE;
      const a=vertex(px,y0,pz,outward), b=vertex(qx,y0,qz,outward), c=vertex(qx,y1,qz,outward), d=vertex(px,y1,pz,outward);
      triangle(a, b, c); triangle(a, c, d);
    },
    // a flat-shaded quad through four world-space corners ({x,y,z}, in order around it), facing `normal`
    addQuad(p0, p1, p2, p3, normal) {
      const a=vertex(p0.x,p0.y,p0.z,normal), b=vertex(p1.x,p1.y,p1.z,normal), c=vertex(p2.x,p2.y,p2.z,normal), d=vertex(p3.x,p3.y,p3.z,normal);
      triangle(a, b, c); triangle(a, c, d);
    },
    // an upright box from y0 to y1 centered on (cx, cz), `halfLen` along the horizontal unit direction (dx, dz) and
    // `halfWid` across it — its four sides and top (the bottom is never seen)
    addBox(cx, cz, dx, dz, halfLen, halfWid, y0, y1) {
      const ax = dx*halfLen, az = dz*halfLen, bx = -dz*halfWid, bz = dx*halfWid;
      const corner = (s, t, y) => ({ x: cx + ax*s + bx*t, y, z: cz + az*s + bz*t });
      const sides = [[1,-1, 1,1, { x:dx, y:0, z:dz }], [1,1, -1,1, { x:-dz, y:0, z:dx }], [-1,1, -1,-1, { x:-dx, y:0, z:-dz }], [-1,-1, 1,-1, { x:dz, y:0, z:-dx }]];
      sides.forEach(([s0, t0, s1, t1, n]) => this.addQuad(corner(s0,t0,y0), corner(s1,t1,y0), corner(s1,t1,y1), corner(s0,t0,y1), n));
      this.addQuad(corner(-1,-1,y1), corner(1,-1,y1), corner(1,1,y1), corner(-1,1,y1), { x:0, y:1, z:0 });
    },
    build() {
      if (!indices.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setIndex(indices);
      return geo;
    }
  };
}
// Calls fn(p, q, outward) for every edge of every contour (outlines and holes) in a Clipper PolyTree, with
// `outward` the horizontal unit normal pointing away from the filled side of that edge.
export function forEachPolyTreeEdge(tree, fn) {
  const visit = node => {
    const path = node.Contour(), n = path.length;
    let area2 = 0;
    for (let i=0;i<n;i++) { const a=path[i], b=path[(i+1)%n]; area2 += a.X*b.Y - b.X*a.Y; }
    const filledOnLeft = (area2 > 0) === !node.IsHole();
    for (let i=0;i<n;i++) {
      const p=path[i], q=path[(i+1)%n];
      const dx=q.X-p.X, dz=q.Y-p.Y, len=Math.hypot(dx, dz);
      if (!len) continue;
      fn(p, q, filledOnLeft ? { x:dz/len, y:0, z:-dx/len } : { x:-dz/len, y:0, z:dx/len });
    }
    node.Childs().forEach(visit);
  };
  tree.Childs().forEach(visit);
}
// Spatial hash over the edges of a set of closed Clipper paths, answering which stretches of a given segment
// run along them — used to tell where the raised sidewalk's edge borders the road, where it borders open
// ground, and where it merely meets another network's share of the platform. One platform edge can do all
// three along its length, so this works in ranges along the segment rather than testing a single point.
export function createEdgeIndex(paths) {
  const CELL = 2*CLIPPER_SCALE, TOL = 2, cells = new Map();
  // every cell a segment passes through (or comes within TOL of): sample it at quarter-cell steps and take
  // each sample's 3x3 cell neighborhood, rather than walking its whole bounding box
  const cellKeys = (a, b) => {
    const keys = new Set(), steps = Math.max(1, Math.ceil(Math.hypot(b.X-a.X, b.Y-a.Y)/(CELL/4)));
    for (let s=0;s<=steps;s++) {
      const cx = Math.floor((a.X+(b.X-a.X)*s/steps)/CELL), cy = Math.floor((a.Y+(b.Y-a.Y)*s/steps)/CELL);
      for (let ox=-1;ox<=1;ox++) for (let oy=-1;oy<=1;oy++) keys.add((cx+ox)+','+(cy+oy));
    }
    return keys;
  };
  paths.forEach(path => path.forEach((a, i) => {
    const edge = { a, b: path[(i+1)%path.length] };
    cellKeys(edge.a, edge.b).forEach(key => { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(edge); });
  }));
  return {
    // the stretches of segment p→q lying along indexed edges, as merged [t0, t1] ranges (t=0 at p, t=1 at q)
    coverage(p, q) {
      const dx=q.X-p.X, dy=q.Y-p.Y, len=Math.hypot(dx, dy);
      if (!len) return [];
      const along = pt => ((pt.X-p.X)*dx + (pt.Y-p.Y)*dy)/(len*len);
      const at = t => ({ X: p.X+dx*t, Y: p.Y+dy*t });
      const distToEdge = (pt, edge) => {
        const ex=edge.b.X-edge.a.X, ey=edge.b.Y-edge.a.Y, l2=ex*ex+ey*ey;
        const s = l2 ? Math.max(0, Math.min(1, ((pt.X-edge.a.X)*ex + (pt.Y-edge.a.Y)*ey)/l2)) : 0;
        return Math.hypot(pt.X-(edge.a.X+ex*s), pt.Y-(edge.a.Y+ey*s));
      };
      const seen = new Set(), ranges = [];
      cellKeys(p, q).forEach(key => (cells.get(key) || []).forEach(edge => {
        if (seen.has(edge)) return;
        seen.add(edge);
        const ta = along(edge.a), tb = along(edge.b);
        const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(1, Math.max(ta, tb));
        if ((t1-t0)*len <= TOL) return;
        // collinear over the overlap: judged only within the stretch both segments share, since Clipper's
        // integer rounding can tilt a short edge slightly — harmless there, but it would add up if the
        // line were extended out to the far end of a much longer edge
        if (distToEdge(at(t0), edge) > TOL || distToEdge(at((t0+t1)/2), edge) > TOL || distToEdge(at(t1), edge) > TOL) return;
        ranges.push([t0, t1]);
      }));
      ranges.sort((r, s) => r[0]-s[0]);
      const merged = [];
      ranges.forEach(r => {
        const last = merged[merged.length-1];
        if (last && r[0] <= last[1] + TOL/len) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
      });
      return merged;
    }
  };
}
export function addRoadLayerMesh(geo, color, roughness, name, networkId) {
  if (!geo) return;
  const mat = new THREE.MeshStandardMaterial({ color, roughness, side:THREE.DoubleSide, polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-4 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = name;
  mesh.userData = { networkId, baseColor: color };
  S.roadMeshGroup.add(mesh);
}
// Frees the graphics-card memory held by everything under `root` (geometries and materials) once it's been taken out of
// the scene for good. three.js keeps a removed object's buffers and shader programs alive on the GPU until they're
// disposed explicitly, and the road, train, zone and marker rebuilds all replace whole groups — dragging a node
// rebuilds on every mouse move — so without this, memory climbs until the browser gives up. Textures are left alone:
// the only ones inside these groups are shared (the sky reflection map); map images dispose their own.
export function disposeObject(root) {
  if (!root) return;
  root.traverse(o => {
    if (o.geometry && !o.userData.sharedGeometry) o.geometry.dispose(); // shared: the train carriage model, reused by every carriage
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
}
// Moves a line's points in place. setFromPoints swaps in a brand-new position attribute instead, which leaves the old
// one's buffer behind on the GPU — and the preview lines update on every mouse move.
export function setLinePoints(geometry, points) {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count !== points.length) {
    if (pos) geometry.dispose(); // frees the old buffer; the geometry re-uploads with its new attribute
    geometry.setFromPoints(points);
    return;
  }
  points.forEach((p, i) => pos.setXYZ(i, p.x, p.y, p.z));
  pos.needsUpdate = true;
  geometry.computeBoundingSphere();
}

Object.assign(App, { disposeObject });
