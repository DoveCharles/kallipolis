// ============================================================ math helpers
/**
 * Seeded PRNG and the 2D geometry helpers the whole app builds cities out of: hashing, polygon
 * tests, convex hulls, oriented bounding boxes and lot subdivision.
 *
 * Conventions used throughout: polygons are arrays of `Vec2` in **XZ** (three.js ground) space,
 * and a polygon's winding is significant only where a function says so.
 *
 * @module core/math
 */

/**
 * A point on the ground plane — `z` is the depth axis, not a height.
 * @typedef {{ x: number, z: number }} Vec2
 */

/**
 * An oriented bounding box fitted to a hull.
 * @typedef {object} OrientedRect
 * @property {number} area
 * @property {number} angle Radians; the rotation of the box's width axis.
 * @property {number} width Extent along `angle`.
 * @property {number} height Extent across `angle`.
 * @property {Vec2} center In world space (un-rotated back from the box's own frame).
 */

/**
 * Limits for {@link recursiveSubdivide}.
 * @typedef {object} SubdivideOptions
 * @property {number} minArea Stop splitting once a piece falls to this area or below.
 * @property {number} maxDepth Hard recursion cap.
 * @property {number} jitter 0..1; how far the split line may wander from the box centre.
 * @property {number} minSplitDim Stop splitting once a piece's long side falls below this.
 */

/**
 * Mulberry32 — a small, fast, seedable PRNG.
 *
 * Seeded rather than random so a saved project rebuilds the same city every load.
 *
 * @param {number} seed
 * @returns {() => number} A generator returning floats in `[0, 1)`.
 */
export function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Linear interpolation.
 * @param {number} a Value at `t` = 0.
 * @param {number} b Value at `t` = 1.
 * @param {number} t
 * @returns {number}
 */
export const lerp = (a,b,t) => a + (b-a)*t;

/**
 * djb2 hash of a string, kept to 32 bits.
 * @param {string} text
 * @returns {number} Unsigned 32-bit hash.
 */
function djb2(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Derive a fixed-length string from a name, by seeding a PRNG with its hash.
 * @param {string} name
 * @param {string} charset Characters to draw from.
 * @param {number} length How many characters to emit.
 * @returns {string}
 */
function hashedString(name, charset, length) {
  const rng = mulberry32(djb2(name));
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(rng() * charset.length)];
  }
  return result;
}

/** Lowercase alphanumerics, for generated handles. */
const HANDLE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derive a stable lowercase string from a name — the same name always yields the same result.
 * @param {string} name
 * @param {number} [length] Characters to emit.
 * @returns {string}
 */
export function hashNameToString(name, length = 8) {
  return hashedString(name, HANDLE_CHARS, length);
}

/**
 * Derive a stable digit string from a name — used for the fleet numbers on vehicles.
 * @param {string} name
 * @param {number} [length] Digits to emit.
 * @returns {number}
 */
export function hashNameToNumber(name, length = 8) {
  return Number(hashedString(name, '0123456789', length));
}

/**
 * Build a licence plate for a vehicle, in a format chosen from its name's hash.
 *
 * @param {string} name
 * @param {number} [forceType] Pin the format instead of rolling for it: `0` UK, `1` EU, `2` US.
 * @returns {string}
 */
export function hashLicensePlate(name, forceType) {
  const rng = mulberry32(djb2(name));

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';

  const pickChar = (chars) => chars[(rng() * chars.length) | 0];
  const pick = (chars, count) => {
    let text = '';
    for (let i = 0; i < count; i++) text += pickChar(chars);
    return text;
  };

  const roll = rng();
  const format = forceType !== undefined ?
    forceType :
    roll < 0.85 ? 0 : roll < 0.95 ? 1 : 2; // 0=uk 1=eu 2=us

  switch (format) {
    case 0: // UK format: AB12 CDE
      return `${pick(letters, 2)}${pick(digits, 2)} ${pick(letters, 3)}`;
    case 1: // EU format: AB-123-CD
      return `${pick(letters, 2)}-${pick(digits, 3)}-${pick(letters, 2)}`;
    default: // US format: ABC 1234
      return `${pick(letters, 3)} ${pick(digits, 4)}`;
  }
}

/**
 * Signed area of a polygon, by the shoelace formula.
 *
 * The sign follows the winding, so callers wanting a magnitude take `Math.abs`.
 *
 * @param {Vec2[]} poly
 * @returns {number}
 */
export function polygonArea(poly) {
  let area2 = 0;
  for (let i=0;i<poly.length;i++) { const a=poly[i], b=poly[(i+1)%poly.length]; area2 += a.x*b.z - b.x*a.z; }
  return area2/2;
}

/**
 * Whether a point lies inside a polygon, by ray casting.
 * @param {Vec2} point
 * @param {Vec2[]} poly
 * @returns {boolean}
 */
export function pointInPolygon(point, poly) {
  let inside = false;
  const count = poly.length;
  for (let i=0, j=count-1; i<count; j=i++) {
    const xi=poly[i].x, zi=poly[i].z, xj=poly[j].x, zj=poly[j].z;
    if (((zi>point.z) !== (zj>point.z)) && (point.x < (xj-xi)*(point.z-zi)/(zj-zi)+xi)) inside = !inside;
  }
  return inside;
}

/**
 * Average of a polygon's vertices — a cheap centre, not an area-weighted one.
 * @param {Vec2[]} poly
 * @returns {Vec2}
 */
export function centroid(poly) {
  let sumX=0, sumZ=0;
  poly.forEach(point => { sumX+=point.x; sumZ+=point.z; });
  return { x: sumX/poly.length, z: sumZ/poly.length };
}

/**
 * 2D cross product of `a - origin` and `b - origin`. Positive when the turn `origin → a → b` is
 * counter-clockwise.
 * @param {Vec2} origin
 * @param {Vec2} a
 * @param {Vec2} b
 * @returns {number}
 */
function crossXZ(origin, a, b) { return (a.x-origin.x)*(b.z-origin.z) - (a.z-origin.z)*(b.x-origin.x); }

/**
 * Convex hull of a point set, by Andrew's monotone chain.
 * @param {Vec2[]} points Not modified.
 * @returns {Vec2[]} Hull vertices in counter-clockwise order; 0-2 points are returned as given.
 */
export function convexHull(points) {
  const pts = points.slice().sort((a,b)=> a.x-b.x || a.z-b.z);
  if (pts.length <= 2) return pts;
  const lower=[];
  for (const p of pts) {
    while (lower.length>=2 && crossXZ(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for (let i=pts.length-1;i>=0;i--) {
    const p=pts[i];
    while (upper.length>=2 && crossXZ(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * Smallest-area rectangle enclosing a hull, by rotating calipers over the hull's own edge angles.
 * @param {Vec2[]} hull A convex hull, from {@link convexHull}.
 * @returns {OrientedRect|null} `null` for an empty hull.
 */
export function minAreaRect(hull) {
  let best = null;
  for (let i=0;i<hull.length;i++) {
    const edgeStart=hull[i], edgeEnd=hull[(i+1)%hull.length];
    const angle = Math.atan2(edgeEnd.z-edgeStart.z, edgeEnd.x-edgeStart.x);
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    // Project every hull point into the edge's own frame; the extent there is the box.
    for (const point of hull) {
      const rx=point.x*cos - point.z*sin, rz=point.x*sin + point.z*cos;
      if (rx<minX) minX=rx;
      if (rx>maxX) maxX=rx;
      if (rz<minZ) minZ=rz;
      if (rz>maxZ) maxZ=rz;
    }
    const width=maxX-minX, height=maxZ-minZ, area=width*height;
    if (!best || area<best.area) {
      const centerX=(minX+maxX)/2, centerZ=(minZ+maxZ)/2;
      const cosBack=Math.cos(angle), sinBack=Math.sin(angle);
      best = { area, angle, width, height, center:{ x:centerX*cosBack - centerZ*sinBack, z:centerX*sinBack + centerZ*cosBack } };
    }
  }
  return best;
}

/**
 * Signed distance of a point from a line through `origin` along `normal`.
 * @param {Vec2} point
 * @param {Vec2} origin
 * @param {Vec2} normal
 * @returns {number}
 */
function sideOf(point, origin, normal) { return (point.x-origin.x)*normal.x + (point.z-origin.z)*normal.z; }

/**
 * Where segment `a → b` crosses the line through `origin` along `normal`.
 * @param {Vec2} a
 * @param {Vec2} b
 * @param {Vec2} origin
 * @param {Vec2} normal
 * @returns {Vec2}
 */
function segIntersect(a,b,origin,normal) {
  const sideA=sideOf(a,origin,normal), sideB=sideOf(b,origin,normal);
  const t = sideA/(sideA-sideB);
  return { x:a.x+(b.x-a.x)*t, z:a.z+(b.z-a.z)*t };
}

/**
 * Sutherland-Hodgman clip: keep the part of a polygon on the positive side of a line.
 * @param {Vec2[]} poly
 * @param {Vec2} origin
 * @param {Vec2} normal
 * @returns {Vec2[]}
 */
function clipHalfPlane(poly, origin, normal) {
  if (poly.length===0) return [];
  const clipped=[];
  for (let i=0;i<poly.length;i++) {
    const curr=poly[i], prev=poly[(i-1+poly.length)%poly.length];
    const sideCurr=sideOf(curr,origin,normal), sidePrev=sideOf(prev,origin,normal);
    if (sideCurr>=0) { if (sidePrev<0) clipped.push(segIntersect(prev,curr,origin,normal)); clipped.push(curr); }
    else if (sidePrev>=0) { clipped.push(segIntersect(prev,curr,origin,normal)); }
  }
  return clipped;
}

/**
 * Carve a polygon into small lots by repeatedly splitting its two halves along the short axis of a
 * fitted bounding box, until the pieces reach `opts.minArea` / `opts.minSplitDim` / `opts.maxDepth`.
 *
 * Recursive: both halves are subdivided, so the number of pieces can be large. `jitter` moves the split line off the box
 * centre, so lots don't come out in obvious rows.
 *
 * @param {Vec2[]} poly
 * @param {number} depth Current recursion depth; callers start at 0.
 * @param {SubdivideOptions} opts
 * @param {() => number} rng Seeded stream, so a zone's lots are reproducible.
 * @param {Vec2[][]} out Appended to — pieces that can't be split further land here.
 * @returns {void}
 */
export function recursiveSubdivide(poly, depth, opts, rng, out) {
  const area = Math.abs(polygonArea(poly));
  if (depth>=opts.maxDepth || area<=opts.minArea || poly.length<3) { out.push(poly); return; }
  const hull = convexHull(poly);
  if (hull.length<3) { out.push(poly); return; }
  const rect = minAreaRect(hull);
  const axisX = { x:Math.cos(rect.angle), z:Math.sin(rect.angle) };
  const axisZ = { x:-Math.sin(rect.angle), z:Math.cos(rect.angle) };
  let longDir, longDim;
  if (rect.width >= rect.height) { longDir=axisX; longDim=rect.width; } else { longDir=axisZ; longDim=rect.height; }
  if (longDim < opts.minSplitDim) { out.push(poly); return; }
  const jitter = (rng()-0.5) * opts.jitter * longDim * 0.6;
  const origin = { x: rect.center.x + longDir.x*jitter, z: rect.center.z + longDir.z*jitter };
  const partA = clipHalfPlane(poly, origin, longDir);
  const partB = clipHalfPlane(poly, origin, { x:-longDir.x, z:-longDir.z });
  if (partA.length<3 || partB.length<3 || Math.abs(polygonArea(partA))<1 || Math.abs(polygonArea(partB))<1) {
    out.push(poly); return;
  }
  recursiveSubdivide(partA, depth+1, opts, rng, out);
  recursiveSubdivide(partB, depth+1, opts, rng, out);
}

/**
 * Shrink or grow a polygon towards its centroid, keeping its shape.
 *
 * Fails safe for degenerate input: a polygon whose vertices sit on the centroid is returned unchanged, and the scale
 * never inverts, so a huge `amount` flattens to the 0.15 minimum instead of turning the polygon inside out. A
 * **negative `amount` grows** the polygon.
 *
 * @param {Vec2[]} poly
 * @param {number} amount Distance to inset by; negative to outset.
 * @returns {Vec2[]} A new polygon; the input is not modified.
 */
export function insetPolygon(poly, amount) {
  const center = centroid(poly);
  let avgDist = 0;
  poly.forEach(point => { avgDist += Math.hypot(point.x-center.x, point.z-center.z); });
  avgDist /= poly.length;
  const scale = avgDist>0 ? Math.max(0.15, (avgDist-amount)/avgDist) : 1;
  return poly.map(point => ({ x:center.x+(point.x-center.x)*scale, z:center.z+(point.z-center.z)*scale }));
}
