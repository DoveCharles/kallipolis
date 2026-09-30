import { S } from '../../core/shared.js';
import { roomClash } from '../../buildings/interior.js';
import { people, peopleNav, randomSpotIn } from './people.js';

// While the view's in a room reaching into the street (roomClash in buildings/interior.js), nobody out there walks in or
// out through its windows, where they'd be seen to vanish: on a walkway about to, they turn back; wandering a plaza or park
// toward a spot in the room, they pick another. (Through its blank walls they just aren't drawn inside: see isDrawn.)
const LOOK = 1.2; // (at people size 1)

const local = (c, x, z) => ({ x: c.e[0]*x + c.e[8]*z + c.e[12], z: c.e[2]*x + c.e[10]*z + c.e[14] });
function throughWindow(c, x0, z0, x1, z1) {
  const p = local(c, x0, z0), q = local(c, x1, z1);
  return c.windows.some(w => {
    const a = w.axis, b = a === 'x' ? 'z' : 'x', da = p[a] - w.at, db = q[a] - w.at;
    if (da*db > 0 || da === db) return false;
    const cross = p[b] + (q[b] - p[b])*da/(da - db);
    return cross > c[b + '0'] && cross < c[b + '1'];
  });
}
const inBox = (c, x, z) => { const p = local(c, x, z); return p.x > c.x0 && p.x < c.x1 && p.z > c.z0 && p.z < c.z1; };

/** Each frame: keep everyone on the street from walking through the windows of the room the view's in. */
export function keepOutOfWindows() {
  const c = roomClash();
  if (!c) return;
  const look = LOOK*S.peopleSize;
  people.forEach(p => {
    if ((p.mode !== 'line' && p.mode !== 'wander') || p.y < c.y0 || p.y > c.y1) return;
    if (p.mode === 'line') {
      const nav = peopleNav.lines[p.li], k = Math.max(0, Math.min(nav.pts.length - 2, p.seg)), a = nav.pts[k], b = nav.pts[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, dx = (b.x - a.x)/len*p.dir, dz = (b.z - a.z)/len*p.dir;
      if (throughWindow(c, p.x, p.z, p.x + dx*look, p.z + dz*look)) p.dir = -p.dir;
    } else if (p.tx != null && inBox(c, p.tx, p.tz)) {
      const spot = randomSpotIn(peopleNav.areas[p.area], null, p);
      p.tx = spot.x; p.tz = spot.z;
    }
  });
}
