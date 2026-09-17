import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { clipPolygons, createMeshBuilder } from '../roads/roads.js';

// ---------------------------------------------------------- fences & railings
// Fences (around parks, industrial lots) and railings (along bridges) are all built the same way: rails running along a
// line, and posts spaced evenly along it — carried over from one segment to the next, so a curve made of many short
// segments still gets evenly spaced posts rather than one at every bend.
const PARK_FENCE_STYLE = { height:1.1, rails:[1.05, 0.6], railWidth:0.08, railHeight:0.08, postSize:0.14, postSpacing:2.5, color:0x3a3d38 };
// one segment a→b ({x,z}) of a railing standing at baseY; `state` carries the distance since the last post between calls
export function addRailingSegment(builder, a, b, baseY, style, state) {
  const len = Math.hypot(b.x-a.x, b.z-a.z);
  if (len < 1e-3) return;
  const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len;
  style.rails.forEach(h => builder.addBox((a.x+b.x)/2, (a.z+b.z)/2, dx, dz, len/2 + style.railWidth/2, style.railWidth/2, baseY+h-style.railHeight, baseY+h));
  let s = style.postSpacing - (state.carry!=null ? state.carry : style.postSpacing);
  for (; s <= len; s += style.postSpacing) builder.addBox(a.x+dx*s, a.z+dz*s, dx, dz, style.postSize/2, style.postSize/2, baseY, baseY+style.height);
  state.carry = len - (s - style.postSpacing);
}
// a mesh of railings along polylines ({x,z}[]), each ending in a post
export function buildRailingMesh(lines, baseY, style, name) {
  const builder = createMeshBuilder();
  lines.forEach(line => {
    const state = {};
    for (let i=0;i<line.length-1;i++) addRailingSegment(builder, line[i], line[i+1], baseY, style, state);
    const end = line[line.length-1], prev = line[line.length-2];
    const len = Math.hypot(end.x-prev.x, end.z-prev.z) || 1;
    if (state.carry > style.postSpacing*0.25) builder.addBox(end.x, end.z, (end.x-prev.x)/len, (end.z-prev.z)/len, style.postSize/2, style.postSize/2, baseY, baseY+style.height);
  });
  const geo = builder.build();
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: style.color, roughness: style.roughness!=null ? style.roughness : 0.8, metalness: style.metalness || 0 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}
// The lines a fence around `poly` (a zone's outline) should follow: the edge of its area — the outline minus the zones
// above it — pulled in by `inset`, with a gap wherever a road, river or path crosses it, and left off wherever it runs along
// water or a beach zone (that edge is a beach or an embankment instead).
function zoneFenceLines(zone, poly, inset) {
  const { ctDifference, ctUnion, ctIntersection } = ClipperLib.ClipType;
  const edge = App.offsetPaths(clipPolygons(ctDifference, [App.toClipperPath(poly)], App.zoneOutlinesAbove(zone)), -inset, ClipperLib.JoinType.jtMiter);
  if (!edge.length) return [];
  const loops = edge.map(path => path.concat([path[0]]));
  const reach = App.offsetPaths([App.toClipperPath(poly)], App.ZONE_CUTOUT_REACH + inset, ClipperLib.JoinType.jtRound);
  const crossings = clipPolygons(ctIntersection, clipPolygons(ctUnion, S.landCutFootprint, S.pathFootprint), reach);
  const water = clipPolygons(ctIntersection, clipPolygons(ctUnion, App.getWaterRegion(), App.getBeachZoneArea()), reach);
  const gaps = clipPolygons(ctUnion, crossings.length ? App.offsetPaths(crossings, 0.6, ClipperLib.JoinType.jtRound) : [],
    water.length ? App.offsetPaths(water, inset + 0.6, ClipperLib.JoinType.jtRound) : []);
  if (!gaps.length) return loops.map(App.fromClipperPath);
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(loops, ClipperLib.PolyType.ptSubject, false);
  clipper.AddPaths(gaps, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.Clipper.OpenPathsFromPolyTree(tree).map(App.fromClipperPath).filter(line => line.length >= 2);
}

Object.assign(App, { PARK_FENCE_STYLE, buildRailingMesh, zoneFenceLines });
