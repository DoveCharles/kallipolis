import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { scene, Y_SIDEWALK } from '../core/scene.js';
import { ROAD_COLOR } from '../core/splines.js';
import { CLIPPER_SCALE, unionRoadStrokes, clipPolygons, createMeshBuilder, forEachPolyTreeEdge, createEdgeIndex, disposeObject } from '../roads/roads.js';
import { addRailingSegment, addRailingLine, cutLines } from '../zones/fences.js';
import { WATER_BANK_BOTTOM } from './water.js';
import { createRegionTester, offsetPaths } from '../zones/cutouts.js';

// ---------------------------------------------------------- bridges
// Where a road crosses water it carries on as a bridge: the road, curb and sidewalk surfaces are already there (they're
// built regardless of what's underneath), so what's added is the rest of a bridge — a concrete deck slab under them, its
// sides along the sidewalk's outer edge, railings along that edge, and piers standing in the water along the road's
// centerline. A path crossing water gets a wooden footbridge the width of its track, with a railing either side; where it
// meets a road bridge, the road's railing opens up and the footbridge's railings run on to meet it.
const BRIDGE_DECK_BOTTOM = -0.3;
const BRIDGE_COLOR = 0x8f8b83;
const BRIDGE_PIER_SPACING = 18;
const ROAD_RAILING_STYLE = { height:1.0, rails:[1.0, 0.55], railWidth:0.1, railHeight:0.1, postSize:0.14, postSpacing:2.2, inset:0.25, color:0x5b6068 };
export const FOOTBRIDGE_TOP = 0.3, FOOTBRIDGE_THICKNESS = 0.25, FOOTBRIDGE_COLOR = 0x8a6a48;
const WOOD_RAILING_STYLE = { height:0.9, rails:[0.9, 0.5], railWidth:0.1, railHeight:0.1, postSize:0.16, postSpacing:2, inset:0.15, color:0x5e4630 };
S.bridgeGroup = new THREE.Group(); S.bridgeGroup.name = 'Bridges'; scene.add(S.bridgeGroup);
function buildBridges(region) {
  scene.remove(S.bridgeGroup); disposeObject(S.bridgeGroup);
  S.bridgeGroup = new THREE.Group(); S.bridgeGroup.name = 'Bridges';
  if (region.length && (S.roadBridgeSources.length || S.pathBridgeSources.length)) {
    const { ctIntersection, ctDifference, ctUnion } = ClipperLib.ClipType;
    const inWater = createRegionTester(region);
    const pointAt = (p, q, t) => ({ X: p.X+(q.X-p.X)*t, Y: p.Y+(q.Y-p.Y)*t });
    // a railing along the stretch p→q (Clipper points) of a deck edge, set in from it by the style's inset
    const railAlong = (builder, p, q, outward, baseY, style, state) => {
      const off = { x: -outward.x*style.inset, z: -outward.z*style.inset };
      addRailingSegment(builder, { x: p.X/CLIPPER_SCALE + off.x, z: p.Y/CLIPPER_SCALE + off.z }, { x: q.X/CLIPPER_SCALE + off.x, z: q.Y/CLIPPER_SCALE + off.z }, baseY, style, state);
    };
    const deck = createMeshBuilder(), rails = createMeshBuilder();
    const outerEdges = S.roadBridgeSources.length ? createEdgeIndex(S.roadFootprint) : null;
    // road railings open where a path meets them, between where its footbridge's railings stand
    const walked = S.pathBridgeSources.filter(src => src.outline).reduce((all, src) => clipPolygons(ctUnion, all, src.outline), S.pathFootprint);
    const railGaps = walked.length ? offsetPaths(walked, -WOOD_RAILING_STYLE.inset, ClipperLib.JoinType.jtMiter) : [];
    S.roadBridgeSources.forEach(({ territory, strokes }) => {
      const over = clipPolygons(ctIntersection, territory, region, true);
      if (!over.Childs().length) return;
      deck.addTops(over, BRIDGE_DECK_BOTTOM, true);
      const lines = [], inset = ROAD_RAILING_STYLE.inset*CLIPPER_SCALE;
      forEachPolyTreeEdge(over, (p, q, outward) => {
        outerEdges.coverage(p, q).forEach(([t0, t1]) => {
          const a = pointAt(p, q, t0), b = pointAt(p, q, t1);
          deck.addWall(a, b, BRIDGE_DECK_BOTTOM, 0, outward); // the sidewalk's own edge already covers 0 up to its top
          const ia = { X: a.X - outward.x*inset, Y: a.Y - outward.z*inset }, ib = { X: b.X - outward.x*inset, Y: b.Y - outward.z*inset };
          const last = lines.length && lines[lines.length-1], end = last && last[last.length-1];
          if (end && Math.abs(end.X-ia.X) + Math.abs(end.Y-ia.Y) < 1) last.push(ib); else lines.push([ia, ib]);
        });
      });
      cutLines(lines, railGaps).forEach(line => addRailingLine(rails, line.map(p => ({ x: p.X/CLIPPER_SCALE, z: p.Y/CLIPPER_SCALE })), Y_SIDEWALK, ROAD_RAILING_STYLE));
      // piers: a slab across the road every so often along its centerline, wherever that's well out over the water
      strokes.forEach(({ path, hw }) => {
        const pts = path.map(p => ({ x: p.X/CLIPPER_SCALE, z: p.Y/CLIPPER_SCALE }));
        let untilNext = BRIDGE_PIER_SPACING/2;
        for (let i=0;i<pts.length-1;i++) {
          const a = pts[i], b = pts[i+1], len = Math.hypot(b.x-a.x, b.z-a.z);
          if (len < 1e-6) continue;
          const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len;
          let s = untilNext;
          for (; s <= len; s += BRIDGE_PIER_SPACING) {
            const x = a.x + dx*s, z = a.z + dz*s, across = hw + 1;
            const clear = [[0,0], [dx*2.5, dz*2.5], [-dx*2.5, -dz*2.5], [-dz*across, dx*across], [dz*across, -dx*across]].every(([ox, oz]) => inWater(x+ox, z+oz));
            if (clear) deck.addBox(x, z, -dz, dx, hw*0.7, 0.6, WATER_BANK_BOTTOM, BRIDGE_DECK_BOTTOM);
          }
          untilNext = s - len;
        }
      });
    });
    const wood = createMeshBuilder(), woodRails = createMeshBuilder();
    const roadRailArea = S.pathBridgeSources.length && S.roadFootprint.length ? offsetPaths(S.roadFootprint, -ROAD_RAILING_STYLE.inset, ClipperLib.JoinType.jtMiter) : [];
    S.pathBridgeSources.forEach(({ strokes, outline = unionRoadStrokes(strokes), cut = [] }) => {
      const overWater = clipPolygons(ctIntersection, outline, region);
      // wherever a road already crosses this same stretch of water it carries its own bridge, so the walkway
      // is just cut off there (as it already is anywhere else it meets a road) instead of also getting one
      const off = cut.length ? clipPolygons(ctUnion, S.roadFootprint, cut) : S.roadFootprint;
      const over = clipPolygons(ctDifference, overWater, off, true);
      if (!over.Childs().length) return;
      wood.addTops(over, FOOTBRIDGE_TOP);
      wood.addTops(over, FOOTBRIDGE_TOP - FOOTBRIDGE_THICKNESS, true);
      const trackEdges = createEdgeIndex(outline), state = {};
      forEachPolyTreeEdge(over, (p, q, outward) => wood.addWall(p, q, FOOTBRIDGE_TOP - FOOTBRIDGE_THICKNESS, FOOTBRIDGE_TOP, outward));
      // railings run on over the road bridge's sidewalk as far as its railing
      const railed = clipPolygons(ctDifference, overWater, cut.length ? clipPolygons(ctUnion, roadRailArea, cut) : roadRailArea, true);
      forEachPolyTreeEdge(railed, (p, q, outward) => {
        trackEdges.coverage(p, q).forEach(([t0, t1]) => railAlong(woodRails, pointAt(p, q, t0), pointAt(p, q, t1), outward, FOOTBRIDGE_TOP, WOOD_RAILING_STYLE, state));
      });
    });
    [[deck, BRIDGE_COLOR, 0.9, 0, 'Bridge'], [rails, ROAD_RAILING_STYLE.color, 0.45, 0.6, 'BridgeRailing'],
     [wood, FOOTBRIDGE_COLOR, 0.9, 0, 'Footbridge'], [woodRails, WOOD_RAILING_STYLE.color, 0.9, 0, 'FootbridgeRailing']].forEach(([builder, color, roughness, metalness, name]) => {
      const geo = builder.build();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness, metalness }));
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = name;
      S.bridgeGroup.add(mesh);
    });
  }
  scene.add(S.bridgeGroup);
}

function roadHighlightColor(baseColorHex) {
  const c = new THREE.Color(baseColorHex);
  const hsl = {}; c.getHSL(hsl);
  const targetHue = 0.14; // yellow
  const hue = hsl.h + (targetHue - hsl.h) * 0.22;
  const sat = THREE.MathUtils.clamp(hsl.s*0.85 + 0.1, 0, 1);
  const light = THREE.MathUtils.clamp(hsl.l + 0.13, 0, 0.85);
  return new THREE.Color().setHSL(hue, sat, light);
}
export function refreshHighlights() {
  const selectedNetwork = (S.selection.type==='road' || S.selection.type==='train') ? S.selection.id : null;
  S.roadMeshGroup.children.concat(S.trainMeshGroup.children).forEach(m => {
    if (!m.userData || m.material==null) return;
    const baseColor = m.userData.baseColor!=null ? m.userData.baseColor : ROAD_COLOR;
    if (m.userData.networkId!=null && selectedNetwork!=null && m.userData.networkId===selectedNetwork) {
      m.material.color.copy(roadHighlightColor(baseColor));
    } else {
      m.material.color.set(baseColor);
    }
  });
  if (S.hoveredRoadLineId!=null) {
    S.roadMeshGroup.children.forEach(m => { if (m.userData && m.userData.lineId===S.hoveredRoadLineId && m.material) m.material.color.set(0xffffff); });
  }
}
export function styleZoneVisual(zone) {
  if (!zone.outlineGroup) return;
  const isSel = S.selection.type==='zone' && S.selection.id===zone.id;
  const isHover = S.hoveredZoneId===zone.id;
  zone.outlineGroup.children.forEach(c => {
    if (c.userData && c.userData.isZoneFill) {
      c.material.color.set(isHover?0xffd23d:(isSel?0xffffff:0x3ddc97));
      c.material.opacity = isHover?0.18:(isSel?0.13:0.07);
    } else if (c.userData && c.userData.isZoneLine) {
      c.material.color.set(isHover?0xffd23d:(isSel?0xffffff:0x3ddc97));
    }
  });
}

S.hoveredRoadLineId = null;
S.hoveredZoneId = null;
function setRoadHover(lineId) {
  if (S.hoveredRoadLineId === lineId) return;
  S.hoveredRoadLineId = lineId;
  refreshHighlights();
}
function setZoneHover(zoneId) {
  if (S.hoveredZoneId === zoneId) return;
  const prevZone = S.zones.find(z=>z.id===S.hoveredZoneId);
  S.hoveredZoneId = zoneId;
  if (prevZone) styleZoneVisual(prevZone);
  const zone = S.zones.find(z=>z.id===zoneId);
  if (zone) styleZoneVisual(zone);
}

Object.assign(App, { buildBridges, refreshHighlights });
