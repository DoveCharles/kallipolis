import { camera } from '../core/scene.js';
import { S, App } from '../core/shared.js';
import { pointInPolygon } from '../core/math.js';
import { distToPolygonBoundary, footprintBounds } from './footprints.js';

// ============================================================ seeing out of a building
// Zoom in far enough — or follow someone through a door (see "going indoors" in people.js) — and the camera ends up
// inside a building, where all you see is the inside face of its walls, or a wall sliced open by the near plane. So any
// building the camera is standing in is simply not drawn while it's in there, and comes back the moment the camera
// leaves. It's the building the camera is *inside* only: nothing between the camera and what it's looking at is touched,
// so the view doesn't flicker as buildings pass in front of it.
// Every building keeps the footprint it was built on and its height (see cutouts.js, industrial.js, farmland.js), so
// "inside" is that footprint containing the camera, with the camera below the roof — no raycasting, no geometry.
// The camera counts as inside from a little way outside the wall too, since the near plane reaches ahead of it: a wall
// this close is already being cut open rather than merely close by. (camera.near is 0.5; the rest is room to spare, so a
// wall goes before it starts being sliced.)
const CLIP_MARGIN = 2;
// the buildings hidden right now, to be shown again as soon as the camera's out of them
const hidden = [];

// Each frame, once the camera's been moved: hides whichever buildings it's inside, and shows the ones it's left.
export function hideBuildingsAroundCamera() {
  showHiddenBuildings();
  const p = camera.position;
  S.zones.forEach(zone => (zone.buildingsGroup?.children || []).forEach(group => {
    const fp = group.userData.footprint;
    if (!fp || fp.length < 3 || !group.visible) return;     // (only what was built as a building keeps a footprint)
    if (p.y > (group.userData.height || 0) + CLIP_MARGIN) return; // over its roof: nothing of it to be inside of
    const { c, r } = footprintBounds(group);
    if (Math.hypot(p.x - c.x, p.z - c.z) > r + CLIP_MARGIN) return; // nowhere near it
    if (!pointInPolygon(p, fp) && distToPolygonBoundary(p, fp) > CLIP_MARGIN) return;
    group.visible = false;
    hidden.push(group);
  }));
}
// Puts back everything hidden — for the export, which leaves out anything that isn't being drawn.
export function showHiddenBuildings() {
  hidden.forEach(group => { group.visible = true; });
  hidden.length = 0;
}

Object.assign(App, { hideBuildingsAroundCamera, showHiddenBuildings });
