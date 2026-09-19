// ============================================================ math helpers
export function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const lerp = (a,b,t) => a + (b-a)*t;

export function hashNameToString(name, length = 8) {
  // Simple 32-bit hash (djb2-ish)
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0; // hash * 33 + char
  }

  // Use the hash to seed a PRNG (e.g. mulberry32) and generate chars
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rng = mulberry32(hash);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

export function hashNameToNumber(name, length = 8) {
  // Simple 32-bit hash (djb2-ish)
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0; // hash * 33 + char
  }

  // Use the hash to seed a PRNG (e.g. mulberry32) and generate chars
  const chars = '0123456789';
  let rng = mulberry32(hash);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

export function hashLicensePlate(name, forceType) {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  }
  const rng = mulberry32(hash);

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';

  const pickChar = (chars) => chars[(rng() * chars.length) | 0];
  const pick = (chars, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += pickChar(chars);
    return s;
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

export function polygonArea(poly) {
  let s = 0;
  for (let i=0;i<poly.length;i++) { const a=poly[i], b=poly[(i+1)%poly.length]; s += a.x*b.z - b.x*a.z; }
  return s/2;
}
export function pointInPolygon(p, poly) {
  let inside = false;
  const n = poly.length;
  for (let i=0, j=n-1; i<n; j=i++) {
    const xi=poly[i].x, zi=poly[i].z, xj=poly[j].x, zj=poly[j].z;
    if (((zi>p.z) !== (zj>p.z)) && (p.x < (xj-xi)*(p.z-zi)/(zj-zi)+xi)) inside = !inside;
  }
  return inside;
}
export function centroid(poly) {
  let cx=0, cz=0;
  poly.forEach(p => { cx+=p.x; cz+=p.z; });
  return { x: cx/poly.length, z: cz/poly.length };
}
function cross3(o,a,b) { return (a.x-o.x)*(b.z-o.z) - (a.z-o.z)*(b.x-o.x); }
export function convexHull(points) {
  const pts = points.slice().sort((a,b)=> a.x-b.x || a.z-b.z);
  if (pts.length <= 2) return pts;
  const lower=[];
  for (const p of pts) {
    while (lower.length>=2 && cross3(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for (let i=pts.length-1;i>=0;i--) {
    const p=pts[i];
    while (upper.length>=2 && cross3(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
export function minAreaRect(hull) {
  let best = null;
  for (let i=0;i<hull.length;i++) {
    const p1=hull[i], p2=hull[(i+1)%hull.length];
    const angle = Math.atan2(p2.z-p1.z, p2.x-p1.x);
    const c=Math.cos(-angle), s=Math.sin(-angle);
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const p of hull) {
      const rx=p.x*c - p.z*s, rz=p.x*s + p.z*c;
      if (rx<minX) minX=rx; if (rx>maxX) maxX=rx;
      if (rz<minZ) minZ=rz; if (rz>maxZ) maxZ=rz;
    }
    const w=maxX-minX, h=maxZ-minZ, area=w*h;
    if (!best || area<best.area) {
      const cxr=(minX+maxX)/2, czr=(minZ+maxZ)/2;
      const cb=Math.cos(angle), sb=Math.sin(angle);
      best = { area, angle, width:w, height:h, center:{ x:cxr*cb - czr*sb, z:cxr*sb + czr*cb } };
    }
  }
  return best;
}
function sideOf(p, origin, normal) { return (p.x-origin.x)*normal.x + (p.z-origin.z)*normal.z; }
function segIntersect(a,b,origin,normal) {
  const da=sideOf(a,origin,normal), db=sideOf(b,origin,normal);
  const t = da/(da-db);
  return { x:a.x+(b.x-a.x)*t, z:a.z+(b.z-a.z)*t };
}
function clipHalfPlane(poly, origin, normal) {
  if (poly.length===0) return [];
  const out=[];
  for (let i=0;i<poly.length;i++) {
    const curr=poly[i], prev=poly[(i-1+poly.length)%poly.length];
    const cs=sideOf(curr,origin,normal), ps=sideOf(prev,origin,normal);
    if (cs>=0) { if (ps<0) out.push(segIntersect(prev,curr,origin,normal)); out.push(curr); }
    else if (ps>=0) { out.push(segIntersect(prev,curr,origin,normal)); }
  }
  return out;
}
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
export function insetPolygon(poly, amount) {
  const c = centroid(poly);
  let avgDist = 0;
  poly.forEach(p => { avgDist += Math.hypot(p.x-c.x, p.z-c.z); });
  avgDist /= poly.length;
  const scale = avgDist>0 ? Math.max(0.15, (avgDist-amount)/avgDist) : 1;
  return poly.map(p => ({ x:c.x+(p.x-c.x)*scale, z:c.z+(p.z-c.z)*scale }));
}
