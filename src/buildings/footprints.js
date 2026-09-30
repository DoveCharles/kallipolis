import { centroid, pointInPolygon } from '../core/math.js';
import { buildingHolders } from '../core/shared.js';

// ---------------------------------------------------------- footprint archetypes (Y2K variety)
function roundPolygonCorners(poly, radius, segs) {
  const n = poly.length;
  if (n<3) return poly;
  const out = [];
  for (let i=0;i<n;i++) {
    const prev=poly[(i-1+n)%n], cur=poly[i], next=poly[(i+1)%n];
    const d1x=cur.x-prev.x, d1z=cur.z-prev.z, len1=Math.hypot(d1x,d1z)||1;
    const d2x=next.x-cur.x, d2z=next.z-cur.z, len2=Math.hypot(d2x,d2z)||1;
    const r = Math.min(radius, len1*0.4, len2*0.4);
    if (r<0.3) { out.push(cur); continue; }
    const p1 = { x:cur.x-d1x/len1*r, z:cur.z-d1z/len1*r };
    const p2 = { x:cur.x+d2x/len2*r, z:cur.z+d2z/len2*r };
    for (let s=0;s<=segs;s++) {
      const t=s/segs, mt=1-t; // quadratic bezier through cur approximates a rounded corner
      out.push({ x: mt*mt*p1.x + 2*mt*t*cur.x + t*t*p2.x, z: mt*mt*p1.z + 2*mt*t*cur.z + t*t*p2.z });
    }
  }
  return out;
}
function chamferPolygonCorners(poly, cut) {
  const n = poly.length;
  if (n<3) return poly;
  const out = [];
  for (let i=0;i<n;i++) {
    const prev=poly[(i-1+n)%n], cur=poly[i], next=poly[(i+1)%n];
    const d1x=cur.x-prev.x, d1z=cur.z-prev.z, len1=Math.hypot(d1x,d1z)||1;
    const d2x=next.x-cur.x, d2z=next.z-cur.z, len2=Math.hypot(d2x,d2z)||1;
    const c = Math.min(cut, len1*0.4, len2*0.4);
    if (c<0.3) { out.push(cur); continue; }
    out.push({ x:cur.x-d1x/len1*c, z:cur.z-d1z/len1*c });
    out.push({ x:cur.x+d2x/len2*c, z:cur.z+d2z/len2*c });
  }
  return out;
}
function circleFootprint(poly, segs, rng) {
  const c = centroid(poly);
  const r = Math.max(1.5, distToPolygonBoundary(c, poly) * (0.86 + rng()*0.1));
  const squash = 0.78 + rng()*0.44; // occasionally an oval instead of a perfect circle
  const rot = rng()*Math.PI;
  const out = [];
  for (let i=0;i<segs;i++) {
    const a = (i/segs)*Math.PI*2;
    const lx = Math.cos(a)*r, lz = Math.sin(a)*r*squash;
    out.push({ x: c.x + lx*Math.cos(rot) - lz*Math.sin(rot), z: c.z + lx*Math.sin(rot) + lz*Math.cos(rot) });
  }
  return out;
}
export function applyFootprintArchetype(poly, rng) {
  // isRound flags the circular/oval archetype specifically, so callers can gate details
  // (ring accents, dome caps) that only read as intentional on a cylindrical footprint —
  // a chamfered/rounded-corner rectangle is still fundamentally boxy, not a cylinder.
  // `archetype` gives finer-grained detail: 'rect'/'chamfer' still have well-defined corners
  // (from the original un-archetyped `poly`, returned as `corners`) that corner/exoskeleton
  // detail can anchor to; 'round'/'circle' don't.
  if (poly.length<3) return { poly, isRound:false, archetype:'rect', corners:poly };
  const roll = rng();
  if (roll < 0.45) return { poly, isRound:false, archetype:'rect', corners:poly };
  if (roll < 0.65) return { poly: circleFootprint(poly, 18, rng), isRound:true, archetype:'circle', corners:null };
  if (roll < 0.82) return { poly: chamferPolygonCorners(poly, 1.2+rng()*1.6), isRound:false, archetype:'chamfer', corners:poly };
  return { poly: roundPolygonCorners(poly, 1.2+rng()*1.8, 4), isRound:false, archetype:'round', corners:null };
}

export function distPointSegment(p,a,b) {
  const abx=b.x-a.x, abz=b.z-a.z;
  const t = ((p.x-a.x)*abx + (p.z-a.z)*abz) / ((abx*abx+abz*abz) || 1);
  const tc = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x-(a.x+abx*tc), p.z-(a.z+abz*tc));
}
export function closestPointOnSegment(p,a,b) {
  const abx=b.x-a.x, abz=b.z-a.z;
  const t = ((p.x-a.x)*abx + (p.z-a.z)*abz) / ((abx*abx+abz*abz) || 1);
  const tc = Math.max(0, Math.min(1, t));
  return { x:a.x+abx*tc, z:a.z+abz*tc };
}
export function distToPolygonBoundary(p, poly) {
  let minD = Infinity;
  const n = poly.length;
  for (let i=0;i<n;i++) {
    const d = distPointSegment(p, poly[i], poly[(i+1)%n]);
    if (d<minD) minD = d;
  }
  return minD;
}
// A building's footprint's centre and the radius covering it, worked out once and kept on it: a circle to reject against
// before walking the footprint edge by edge. A building's footprint never changes — a rebuilt zone makes new meshes.
export function footprintBounds(group) {
  let bounds = group.userData.clipBounds;
  if (!bounds) {
    const fp = group.userData.solidFootprint ?? group.userData.footprint; // (the wider of the two)
    const pts = wallsOf(group).flatMap(w => w.poly); // (and any solid props: see wallsOf)
    let c = fp ? centroid(fp) : null;
    if (!c) { const xs = pts.map(p => p.x), zs = pts.map(p => p.z); c = { x: (Math.min(...xs) + Math.max(...xs))/2, z: (Math.min(...zs) + Math.max(...zs))/2 }; }
    bounds = group.userData.clipBounds = { c, r: Math.max(...pts.map(p => Math.hypot(p.x - c.x, p.z - c.z))) };
  }
  return bounds;
}
/**
 * Everything of a building that's a wall: its footprint (a podium's, wider, if it has one) up to its height, and any solid
 * props it holds (userData.solids: { poly, top } — an industrial yard's tanks and containers, see zones/industrial.js).
 * @returns {Array<{poly: Array<{x: number, z: number}>, top: number, prop?: boolean}>}
 */
export function wallsOf(group) {
  let walls = group.userData.walls;
  if (!walls) {
    const fp = group.userData.solidFootprint ?? group.userData.footprint;
    walls = group.userData.walls = (fp?.length >= 3 ? [{ poly: fp, top: group.userData.height || 0 }] : [])
      .concat((group.userData.solids || []).map(s => ({ ...s, prop: true })));
  }
  return walls;
}
// ---- what flies: every building's walls, bucketed by SOLID_CELL, for anything in the air to test a point against. Built
// again whenever the buildings held change (checked at most every SOLID_CHECK ms: a new zone group, or a different count).
const SOLID_CELL = 16, SOLID_CHECK = 500;
let solidGrid = null, solidKey = null, solidCheckedAt = -Infinity;
function solidGridNow() {
  const now = performance.now();
  if (solidGrid && now - solidCheckedAt < SOLID_CHECK) return solidGrid;
  solidCheckedAt = now;
  const holders = buildingHolders(), key = holders.map(z => z.buildingsGroup ? z.buildingsGroup.children.length : 0).join(',');
  if (solidGrid && key === solidKey && holders.every((z, i) => z.buildingsGroup === solidGrid.groups[i])) return solidGrid;
  solidKey = key;
  solidGrid = { cells: new Map(), groups: holders.map(z => z.buildingsGroup) };
  holders.forEach(zone => (zone.buildingsGroup?.children || []).forEach(group => {
    const walls = wallsOf(group);
    if (!walls.length) return;
    const { c, r } = footprintBounds(group), base = group.userData.base || 0;
    for (let cx = Math.floor((c.x - r)/SOLID_CELL); cx <= Math.floor((c.x + r)/SOLID_CELL); cx++)
      for (let cz = Math.floor((c.z - r)/SOLID_CELL); cz <= Math.floor((c.z + r)/SOLID_CELL); cz++) {
        const k = cx + ',' + cz;
        if (!solidGrid.cells.has(k)) solidGrid.cells.set(k, []);
        walls.forEach(w => solidGrid.cells.get(k).push({ group, poly: w.poly, base, top: w.top }));
      }
  }));
  return solidGrid;
}
/**
 * The wall (of a building or a solid prop) standing at (x, y, z), if any — for birds, bees and aircraft to fly into.
 * @returns {?{group: object, poly: Array<{x: number, z: number}>, base: number, top: number}}
 */
export function solidAt(x, y, z) {
  const list = solidGridNow().cells.get(Math.floor(x/SOLID_CELL) + ',' + Math.floor(z/SOLID_CELL));
  if (!list) return null;
  for (const w of list) if (y < w.top && y >= w.base - 0.5 && pointInPolygon({ x, z }, w.poly)) return w;
  return null;
}

// ---------------------------------------------------------- building identity
// Which building a zone's child `index` is, as a key (see people.js and building-card.js), and its number on its card —
// the same every time, for the same building in the same zone.
export const buildingKey = (zone, index) => zone.id + ':' + index;
export function buildingNumber(key) {
  let h = 2166136261;
  for (let i=0;i<key.length;i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return 1 + ((h >>> 0) % 9999);
}
// What's inside (a layout in interior.js): about half the buildings zones' blocks are offices, by their number so each
// is the same every time; a warehouse or a factory is fitted out as one, and a pub, a hair salon, a clothes shop or a
// restaurant as one of those; everything else is a home. A city block's
// landmark is one of those blocks too — taller and fancier, but still somewhere people live or work, and named for it
// (see buildingName) — so it splits the same way.
const CITY_BLOCK_KINDS = new Set(['buildings', 'landmark']), OWN_LAYOUT_KINDS = new Set(['warehouse', 'factory', 'pub', 'salon', 'clothes', 'restaurant', 'convenience']);
export const roomLayoutOf = (kind, number) => OWN_LAYOUT_KINDS.has(kind) ? kind
  : CITY_BLOCK_KINDS.has(kind) && number % 2 === 0 ? 'office' : 'home';
// A pub's kind of pub, by its key (see buildingKey), the same every time: a craft beer bar — bright paint, neon, festoon
// lights, long tables (see furnishPub in interior.js) — about a third of the time, else an old British boozer.
export const CRAFT_PUB = 0.35;
export function pubStyleOf(key) {
  let h = 2166136261;
  for (const ch of String(key) + ':craft') h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0)/2**32 < CRAFT_PUB ? 'craft' : 'pub';
}
// A restaurant's kind, by its key, the same every time: a Greek taverna (RestaurantGreek.glb: see furnishRestaurant in
// interior.js) GREEK_RESTAURANT of the time, a kaiten sushi bar (RestaurantSushi.glb: see furnishSushi) SUSHI_RESTAURANT,
// else an old New York Italian.
export const GREEK_RESTAURANT = 0.35, SUSHI_RESTAURANT = 0.3;
export function restaurantStyleOf(key) {
  let h = 2166136261;
  for (const ch of String(key) + ':greek') h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const u = (h >>> 0)/2**32;
  return u < GREEK_RESTAURANT ? 'greek' : u < GREEK_RESTAURANT + SUSHI_RESTAURANT ? 'sushi' : 'italian';
}
// An office's kind, by its key, the same every time: a startup's open plan (OfficeStartup.glb: see furnishOffice in
// interior.js) STARTUP_OFFICE of the time, else a corporate one of cubicles.
export const STARTUP_OFFICE = 0.35;
export function officeStyleOf(key) {
  let h = 2166136261;
  for (const ch of String(key) + ':startup') h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0)/2**32 < STARTUP_OFFICE ? 'startup' : 'corporate';
}
// A home's bedroom with its ensuite (see "the bedroom" in interior.js), by its key, the same every time: every home has
// one, through an open doorway in one of the living room's walls but the door's — '+x' or '+z' (a far wall) or '-z' (the
// other wall behind the camera).
export function homeSuiteOf(key) {
  let h = 2166136261;
  for (const ch of String(key) + ':suite') h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ['+x', '+z', '-z'][Math.floor((h >>> 0)/2**32*3)];
}
