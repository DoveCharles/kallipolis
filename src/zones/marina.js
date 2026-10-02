import * as THREE from 'three';
import { S, App } from '../core/shared.js';
import { computeWindowGlowFactor } from '../core/scene.js';
import { mulberry32 } from '../core/math.js';
import { clipPolygons, createMeshBuilder } from '../roads/roads.js';
import { makeFlatZoneMesh } from './surface-detail.js';
import { applyPavingShader, Y_PLAZA } from './plazas.js';
import { WATER_TIME, WATER_LEVEL, WATER_BANK_BOTTOM, getWaterRegion } from '../water/water.js';

// ---------------------------------------------------------- marinas
// A concrete quay. Where its edge meets water (a water zone or river), timber jetties run out into it with boats moored
// either side, bobbing (in the vertex shader, off WATER_TIME); bollards and benches facing the water line the edge. With no
// water beside it, it's a dry boatyard: boats up on stands. Jetties are walk decks (zone.pontoonDeck, see refreshWalkDeck in
// roads/paths.js); benches are seats for people hanging out (zone.benchSeats, see buildPeopleNav).
export const MARINA_COLOR = 0xa29e95;
const JETTY_SPACING = 13, JETTY_HALF_WIDTH = 1, DECK_TOP = Y_PLAZA + 0.03, LAMP_SPACING = 14, BOLLARD_SPACING = 7;
const HULLS = [0xf4f4f0, 0xf4f4f0, 0x1d2b4a, 0xb33a2e, 0x2f6d4f, 0xe8d9b5];
const BOATS = { // L length, B beam, H freeboard, D draft
  dinghy: { L: 3.2, B: 1.4, H: 0.35, D: 0.2 },
  motor: { L: 7.5, B: 2.6, H: 0.7, D: 0.5 },
  sail: { L: 8.5, B: 2.7, H: 0.6, D: 0.6 },
  fishing: { L: 9, B: 3.1, H: 1, D: 0.8 },
};

// ---- placeholder boats: one merged mesh per marina, every vertex carrying its boat's pivot and heading
const boatMaterial = (() => {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, flatShading: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = shader => {
    shader.uniforms.uBoatTime = WATER_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aBoat;\nattribute vec3 aDir;\nuniform float uBoatTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 piv = aBoat.xyz; vec2 f = aDir.xy; float amp = aDir.z, ph = aBoat.w, t = uBoatTime;
          vec3 r = transformed - piv;
          float along = dot(r.xz, f), across = dot(r.xz, vec2(-f.y, f.x)), y = r.y;
          float roll = amp*0.05*sin(t*1.3 + ph), pitch = amp*0.025*sin(t*0.9 + ph*1.7);
          float a2 = across*cos(roll) - y*sin(roll); y = across*sin(roll) + y*cos(roll);
          float l2 = along*cos(pitch) - y*sin(pitch); y = along*sin(pitch) + y*cos(pitch);
          y += amp*0.06*sin(t*1.1 + ph*2.3);
          transformed = piv + vec3(f.x*l2 - f.y*a2, y, f.y*l2 + f.x*a2);
        }`);
  };
  return mat;
})();
// a hull, bow at +x, waterline at y=0: deck outline from a squared stern tapering to a point, keel ring narrower and lower
function hullGeometry({ L, B, H, D }, open) {
  const n = 6, top = [], bot = [];
  const half = s => s < 0.15*L ? B/2*(0.92 + 0.08*(s + L/2)/(0.65*L)) : B/2*Math.sqrt(Math.max(0, 1 - ((s - 0.15*L)/(0.35*L))**2));
  const ring = (y, wScale, sScale) => {
    const pts = [];
    for (let i=0;i<n;i++) { const s = -L/2 + L*0.92*i/(n - 1); pts.push([s*sScale, y, half(s)*wScale]); }
    pts.push([L/2*sScale, y, 0]);
    for (let i=n-1;i>=0;i--) { const [x, yy, z] = pts[i]; pts.push([x, yy, -z]); }
    return pts;
  };
  top.push(...ring(H, 1, 1)); bot.push(...ring(-D, 0.5, 0.9));
  const v = [];
  const tri = (a, b, c) => v.push(...a, ...b, ...c);
  for (let k=0;k<top.length;k++) { const k2 = (k + 1) % top.length; tri(top[k], bot[k], bot[k2]); tri(top[k], bot[k2], top[k2]); }
  const deckY = open ? H*0.3 : H, deck = top.map(([x, , z]) => [x, deckY, z]);
  for (let k=0;k<top.length;k++) { const k2 = (k + 1) % top.length; tri([0, deckY, 0], deck[k], deck[k2]); tri([0, -D, 0], bot[k2], bot[k]); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return geo;
}
const box = (sx, sy, sz, x, y, z) => new THREE.BoxGeometry(sx, sy, sz).toNonIndexed().translate(x, y, z);
// a boat's parts in its own space, each [geometry, colour]
function boatParts(kind, rng) {
  const d = BOATS[kind], hull = HULLS[Math.floor(rng()*HULLS.length)], white = 0xf2f1ec, teak = 0xa9774a, glass = 0x26313a;
  const parts = [[hullGeometry(d, kind === 'dinghy'), hull]];
  if (kind === 'dinghy') {
    parts.push([box(0.25, 0.06, d.B*0.8, 0.1, d.H*0.8, 0), teak], [box(0.35, 0.6, 0.25, -d.L/2 - 0.05, d.H*0.7, 0), 0x2b2b2b]);
  } else if (kind === 'motor') {
    parts.push([box(d.L*0.35, 0.9, d.B*0.7, -d.L*0.05, d.H + 0.45, 0), white], [box(0.08, 0.45, d.B*0.62, d.L*0.13, d.H + 0.95, 0), glass],
      [box(d.L*0.25, 0.04, d.B*0.8, -d.L*0.36, d.H + 0.02, 0), teak]);
  } else if (kind === 'sail') {
    parts.push([box(d.L*0.3, 0.45, d.B*0.55, -d.L*0.02, d.H + 0.22, 0), white], [box(0.12, 11, 0.12, d.L*0.12, d.H + 5.5, 0), 0xd8d8d8],
      [box(3.6, 0.1, 0.1, d.L*0.12 - 1.8, d.H + 1.9, 0), 0xd8d8d8], [box(3.4, 0.28, 0.3, d.L*0.12 - 1.8, d.H + 2.08, 0), rng() < 0.5 ? 0x1f4f8a : 0x7a2830],
      [box(0.5, 1.6, 0.2, 0, -d.D - 0.8, 0), hull]);
  } else {
    parts.push([box(2.2, 2, d.B*0.75, d.L*0.15, d.H + 1, 0), white], [box(0.06, 0.6, d.B*0.6, d.L*0.15 + 1.12, d.H + 1.4, 0), glass],
      [box(0.15, 4, 0.15, -d.L*0.1, d.H + 2, 0), 0x3a3a3a], [box(3, 0.12, 0.12, -d.L*0.1 - 1.4, d.H + 3, 0), 0x3a3a3a],
      [box(d.L*0.4, 0.05, d.B*0.85, -d.L*0.28, d.H + 0.03, 0), 0x5e6266]);
  }
  return parts;
}
function boatBatch() {
  const pos = [], col = [], boat = [], dir = [], c = new THREE.Color();
  return {
    // y is the waterline; amp 0 holds it still (up on stands)
    add(kind, x, y, z, yaw, amp, rng) {
      const cs = Math.cos(yaw), sn = Math.sin(yaw), ph = rng()*Math.PI*2;
      boatParts(kind, rng).forEach(([geo, hex]) => {
        const p = geo.attributes.position;
        c.setHex(hex);
        for (let i=0;i<p.count;i++) {
          const lx = p.getX(i), lz = p.getZ(i);
          pos.push(x + lx*cs - lz*sn, y + p.getY(i), z + lx*sn + lz*cs);
          col.push(c.r, c.g, c.b); boat.push(x, y, z, ph); dir.push(cs, sn, amp);
        }
        geo.dispose();
      });
    },
    build() {
      if (!pos.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute('aBoat', new THREE.Float32BufferAttribute(boat, 4));
      geo.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.boundingSphere.radius += 1; // (the bobbing)
      const mesh = new THREE.Mesh(geo, boatMaterial);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'MarinaBoats';
      mesh.userData.sharedMaterial = true;
      return mesh;
    },
  };
}
const pickKind = rng => { const r = rng(); return r < 0.3 ? 'dinghy' : r < 0.6 ? 'motor' : r < 0.9 ? 'sail' : 'fishing'; };

export function generateMarinaContent(zone, poly, cutouts, blockers) {
  const s = zone.settings, rng = mulberry32(s.seed>>>0);
  const { ctDifference } = ClipperLib.ClipType, { jtMiter, jtRound } = ClipperLib.JoinType;
  const floor = makeFlatZoneMesh(poly, MARINA_COLOR, Y_PLAZA, 'MarinaQuay', mat => applyPavingShader(mat, 0, 1.6, 0.03), cutouts);
  if (!floor) return;
  zone.buildingsGroup.add(floor);
  const area = clipPolygons(ctDifference, [App.toClipperPath(poly)], cutouts);
  const inArea = App.createRegionTester(area);
  const blocked = App.createRegionTester(blockers.length ? App.offsetPaths(blockers, 1.2, jtRound) : []);
  const water = getWaterRegion();
  const inWater = App.createRegionTester(water), onRoad = App.createRegionTester(S.roadFootprint || []);
  const wet = (x, z) => inWater(x, z) && !onRoad(x, z);
  // the edge, walked a metre at a time: each sample with its outward normal, split into runs that face water (or all of it, dry)
  const samples = [];
  area.forEach(path => {
    const pts = App.fromClipperPath(path);
    let twice = 0;
    pts.forEach((a, i) => { const b = pts[(i+1)%pts.length]; twice += a.x*b.z - b.x*a.z; });
    const side = twice > 0 ? 1 : -1;
    let run = null;
    pts.forEach((a, i) => {
      const b = pts[(i+1)%pts.length], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len < 1e-6) return;
      const dx = (b.x-a.x)/len, dz = (b.z-a.z)/len, ox = dz*side, oz = -dx*side;
      for (let d = 0.5; d < len; d += 1) {
        const x = a.x + dx*d, z = a.z + dz*d, w = wet(x + ox*1.5, z + oz*1.5);
        if (!run || run.wet !== w) samples.push(run = { wet: w, pts: [] });
        run.pts.push({ x, z, dx, dz, ox, oz });
      }
    });
  });
  const wetRuns = samples.filter(r => r.wet && r.pts.length >= 6);
  zone.marinaWet = wetRuns.length > 0;
  const kit = createMeshBuilder(), timber = createMeshBuilder(), lampHeads = createMeshBuilder(), boats = boatBatch(), lampPosts = [];
  const bollard = new THREE.CylinderGeometry(0.16, 0.2, 0.55, 8), lampGlobe = new THREE.IcosahedronGeometry(0.3, 1);
  const jetties = [], deck = [], roamers = [];
  zone.benchSeats = [];
  const nearJetty = (x, z, gap) => jetties.some(j => {
    const rx = x - j.x, rz = z - j.z, al = rx*j.dx + rz*j.dz, ac = Math.abs(-rx*j.dz + rz*j.dx);
    return al > -gap && al < j.len + gap && ac < JETTY_HALF_WIDTH + gap;
  });
  const seatTop = Y_PLAZA + 0.42;
  const addBench = (x, z, dx, dz, nx, nz) => {
    kit.addBox(x, z, dx, dz, 0.95, 0.26, seatTop - 0.1, seatTop);
    kit.addBox(x - nx*0.22, z - nz*0.22, dx, dz, 0.95, 0.05, seatTop, seatTop + 0.45);
    [-0.8, 0.8].forEach(o => kit.addBox(x + dx*o, z + dz*o, dx, dz, 0.05, 0.22, Y_PLAZA, seatTop - 0.1));
    [-0.45, 0.45].forEach(o => zone.benchSeats.push({ x: x + dx*o, z: z + dz*o, y: seatTop, nx, nz }));
  };
  const addLamp = (x, z, dx, dz) => {
    kit.addBox(x, z, dx, dz, 0.08, 0.08, Y_PLAZA, Y_PLAZA + 4.2);
    kit.addBox(x, z, dx, dz, 0.2, 0.2, Y_PLAZA, Y_PLAZA + 0.35);
    lampHeads.addGeometry(lampGlobe, x, Y_PLAZA + 4.45, z);
    lampPosts.push({ x, z });
  };
  const density = s.marinaBoats != null ? s.marinaBoats : 0.75, maxLen = s.jettyLength != null ? s.jettyLength : 16;
  if (zone.marinaWet) {
    wetRuns.forEach(run => {
      // jetties every JETTY_SPACING, straight out along the edge's normal for as far as the water's clear
      for (let i = Math.floor(JETTY_SPACING/2); i < run.pts.length - 3; i += JETTY_SPACING) {
        const p = run.pts[i], jdx = p.ox, jdz = p.oz;
        if (nearJetty(p.x, p.z, 6)) continue;
        let len = 0;
        for (let d = 1; d <= maxLen; d += 1) {
          const cx = p.x + jdx*d, cz = p.z + jdz*d;
          if (!wet(cx, cz) || !wet(cx - jdz*1.6, cz + jdx*1.6) || !wet(cx + jdz*1.6, cz - jdx*1.6) || nearJetty(cx, cz, 5)) break;
          len = d;
        }
        if (len < 5) continue;
        const j = { x: p.x - jdx*0.3, z: p.z - jdz*0.3, dx: jdx, dz: jdz, len: len + 0.3 };
        jetties.push(j);
        const mx = j.x + jdx*j.len/2, mz = j.z + jdz*j.len/2;
        timber.addBox(mx, mz, jdx, jdz, j.len/2, JETTY_HALF_WIDTH, DECK_TOP - 0.22, DECK_TOP);
        for (let d = 1.5; d < j.len; d += 3) [-1, 1].forEach(sd => {
          const px = j.x + jdx*d - jdz*sd*(JETTY_HALF_WIDTH + 0.08), pz = j.z + jdz*d + jdx*sd*(JETTY_HALF_WIDTH + 0.08);
          timber.addBox(px, pz, jdx, jdz, 0.12, 0.12, WATER_BANK_BOTTOM, DECK_TOP + 0.35);
        });
        deck.push(App.toClipperPath([[-2, -1], [j.len, -1], [j.len, 1], [-2, 1]].map(([a, w]) => ({ x: j.x + jdx*a - jdz*w*JETTY_HALF_WIDTH, z: j.z + jdz*a + jdx*w*JETTY_HALF_WIDTH }))));
        // berths both sides
        [-1, 1].forEach(sd => {
          let at = 1.2;
          const moored = [];
          for (let tries = 0; tries < 12; tries++) {
            let kind = pickKind(rng);
            if (at + BOATS[kind].L > j.len + 1.5) kind = 'dinghy';
            const b = BOATS[kind];
            if (at + b.L > j.len + 1.5) break;
            const off = JETTY_HALF_WIDTH + 0.45 + b.B/2;
            const bx = j.x + jdx*(at + b.L/2) - jdz*sd*off, bz = j.z + jdz*(at + b.L/2) + jdx*sd*off;
            const corners = [[b.L/2, 0], [b.L*0.3, b.B/2], [b.L*0.3, -b.B/2], [-b.L/2, b.B/2], [-b.L/2, -b.B/2]];
            const clear = corners.every(([a, w]) => wet(bx + jdx*a - jdz*w, bz + jdz*a + jdx*w));
            if (clear && rng() < density) {
              const out = rng() < 0.7, yaw = Math.atan2(jdz, jdx) + (out ? 0 : Math.PI);
              moored.push({ kind, bx, bz, yaw, along: at + b.L/2 });
            }
            at += b.L + 1;
          }
          // the outermost boat on a side can head out: its way along the jetty's line is clear
          const last = moored.pop();
          moored.forEach(m => boats.add(m.kind, m.bx, WATER_LEVEL, m.bz, m.yaw, 1, rng));
          if (!last) return;
          const reach = j.len + 7 - last.along, ex = last.bx + jdx*reach, ez = last.bz + jdz*reach;
          let free = rng() < 0.5;
          for (let d = 0; free && d <= reach; d += 1) {
            const cx = last.bx + jdx*d, cz = last.bz + jdz*d;
            free = wet(cx, cz) && wet(cx - jdz*2, cz + jdx*2) && wet(cx + jdz*2, cz - jdx*2);
          }
          if (!free) { boats.add(last.kind, last.bx, WATER_LEVEL, last.bz, last.yaw, 1, rng); return; }
          roamers.push(makeRoamer(last.kind, last.bx, last.bz, last.yaw, jdx, jdz, ex, ez, rng));
        });
      }
      // along the edge: a coping strip, bollards, benches facing the water and lamps
      run.pts.forEach((p, i) => {
        kit.addBox(p.x - p.ox*0.2, p.z - p.oz*0.2, p.dx, p.dz, 0.5, 0.2, Y_PLAZA, Y_PLAZA + 0.12);
        if (nearJetty(p.x, p.z, 1.2)) return;
        if (i % BOLLARD_SPACING === 0) kit.addGeometry(bollard, p.x - p.ox*0.6, Y_PLAZA + 0.27, p.z - p.oz*0.6);
        const ix = p.x - p.ox*3, iz = p.z - p.oz*3;
        if (i % LAMP_SPACING === 10 && inArea(ix, iz) && !blocked(ix, iz)) addBench(ix, iz, p.dx, p.dz, p.ox, p.oz);
        const lx = p.x - p.ox*1.6, lz = p.z - p.oz*1.6;
        if (i % LAMP_SPACING === 3 && inArea(lx, lz) && !blocked(lx, lz)) addLamp(lx, lz, p.dx, p.dz);
      });
    });
  } else {
    // dry: lamps round the edge, and boats up on stands in rows squared to the longest edge
    samples.forEach(run => run.pts.forEach((p, i) => {
      const lx = p.x - p.ox*1.6, lz = p.z - p.oz*1.6;
      if (i % LAMP_SPACING === 3 && inArea(lx, lz) && !blocked(lx, lz)) addLamp(lx, lz, p.dx, p.dz);
    }));
    let ux = 1, uz = 0, longest = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    poly.forEach((a, i) => {
      const b = poly[(i+1)%poly.length], len = Math.hypot(b.x-a.x, b.z-a.z);
      if (len > longest) { longest = len; ux = (b.x-a.x)/len; uz = (b.z-a.z)/len; }
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
    });
    const deep = App.createRegionTester(App.offsetPaths(area, -3, jtMiter));
    const cx = (minX + maxX)/2, cz = (minZ + maxZ)/2, reach = Math.hypot(maxX - minX, maxZ - minZ)/2, yaw = Math.atan2(uz, ux);
    for (let i = -Math.ceil(reach/11); i <= reach/11; i++) for (let j = -Math.ceil(reach/5.5); j <= reach/5.5; j++) {
      const kind = pickKind(rng), b = BOATS[kind], x = cx + ux*i*11 - uz*j*5.5, z = cz + uz*i*11 + ux*j*5.5;
      const ends = [[b.L/2, 0], [-b.L/2, 0], [0, b.B/2], [0, -b.B/2]].every(([a, w]) => {
        const px = x + ux*a - uz*w, pz = z + uz*a + ux*w;
        return deep(px, pz) && !blocked(px, pz);
      });
      if (!ends || rng() > density) continue;
      const keel = Y_PLAZA + 0.5, waterline = keel + b.D;
      [-0.3, 0.3].forEach(a => [-1, 1].forEach(w => timber.addBox(x + ux*a*b.L - uz*w*b.B*0.3, z + uz*a*b.L + ux*w*b.B*0.3, ux, uz, 0.12, 0.12, Y_PLAZA, keel + b.D*0.4)));
      timber.addBox(x, z, ux, uz, b.L*0.4, 0.15, Y_PLAZA, keel);
      boats.add(kind, x, waterline, z, yaw + (rng() < 0.5 ? 0 : Math.PI), 0, rng);
    }
  }
  bollard.dispose(); lampGlobe.dispose();
  zone.pontoonDeck = deck;
  const kitGeo = kit.build();
  if (kitGeo) {
    const mesh = new THREE.Mesh(kitGeo, new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.7, metalness: 0.2 }));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'MarinaFurniture';
    zone.buildingsGroup.add(mesh);
  }
  const timberGeo = timber.build();
  if (timberGeo) {
    const mesh = new THREE.Mesh(timberGeo, new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 }));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'MarinaJetties';
    zone.buildingsGroup.add(mesh);
  }
  const headGeo = lampHeads.build();
  if (headGeo) {
    const glow = new THREE.MeshStandardMaterial({ color: 0xfff1d6, roughness: 0.4, emissive: 0xffd08a, emissiveIntensity: 1.6*computeWindowGlowFactor(S.sunElevation) });
    glow.userData.baseEmissiveIntensity = 1.6; // lit after dark (see updateWindowGlowForSun)
    const mesh = new THREE.Mesh(headGeo, glow);
    mesh.name = 'MarinaLamps';
    mesh.userData.lampPosts = lampPosts; // (see streetlights.js)
    zone.buildingsGroup.add(mesh);
  }
  const boatMesh = boats.build();
  if (boatMesh) zone.buildingsGroup.add(boatMesh);
  roamers.forEach(r => { zone.buildingsGroup.add(r.mesh, r.wake); placeRoamer(r); });
  zone.marinaRoamers = roamers;
  zone.marinaJetties = jetties;
}

// ---------------------------------------------------------- boats going out
// Now and then a roamer casts off: along its jetty's line to a point past the end, then a chain of waypoints through the
// connected water (each in clear sight of the last, away from land, bridges and jetties), back the same way, and in to its
// berth bow first. Not saved: a load puts them all back.
const SPEED = { dinghy: 4, motor: 7, sail: 4.5, fishing: 4 }, CRAWL = 1.2, TURN = 0.45, ACCEL = 1.5, KEEP_OUT = 5.5;
// the wake: stern positions dropped every WAKE_STEP s and left where they fell, so it lies on the water behind the boat's
// path rather than trailing rigidly off the stern. Three ribbons through them (a V's two arms spreading as they age, and a
// broad trail between), rewritten each frame (alpha in the colours).
const WAKE_STEP = 0.2, WAKE_N = 40, WAKE_LIFE = WAKE_STEP*WAKE_N, WAKE_SLOTS = WAKE_N + 1;
const wakeMaterial = () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
function wakeGeometry() {
  const geo = new THREE.BufferGeometry(), index = [];
  for (let k = 0; k < 3; k++) for (let i = 0; i < WAKE_SLOTS - 1; i++) {
    const o = (k*WAKE_SLOTS + i)*2;
    index.push(o, o + 1, o + 3, o, o + 3, o + 2);
  }
  geo.setIndex(index);
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3*WAKE_SLOTS*2*3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3*WAKE_SLOTS*2*4).fill(1), 4).setUsage(THREE.DynamicDrawUsage));
  return geo;
}
function updateWake(r, dt) {
  const { L, B } = BOATS[r.kind], cs = Math.cos(r.yaw), sn = Math.sin(r.yaw);
  const now = { x: r.x - cs*L/2, z: r.z - sn*L/2, px: -sn, pz: cs, foam: Math.min(1, Math.max(0, r.v)/3)*0.7, t: r.clock = (r.clock || 0) + dt };
  const trail = r.trail || (r.trail = []);
  if (!trail.length || now.t - trail[0].t >= WAKE_STEP) trail.unshift(now);
  while (trail.length && now.t - trail[trail.length - 1].t > WAKE_LIFE) trail.pop();
  if (trail.every(p => p.foam < 0.01) && now.foam < 0.01) { r.wake.visible = false; return; }
  r.wake.visible = true;
  const pos = r.wake.geometry.attributes.position, col = r.wake.geometry.attributes.color;
  const pts = [now, ...trail];
  for (let i = 0; i < WAKE_SLOTS; i++) {
    const p = pts[Math.min(i, pts.length - 1)], age = now.t - p.t, fade = i < pts.length ? p.foam*Math.max(0, 1 - age/WAKE_LIFE) : 0;
    // [centre offset, half width, alpha] for each ribbon
    [[-(B*0.45 + age*1.1), 0.2 + age*0.12, fade], [B*0.45 + age*1.1, 0.2 + age*0.12, fade], [0, B*0.3 + age*0.2, i < pts.length ? p.foam*0.6*Math.max(0, 1 - age/(WAKE_LIFE*0.6)) : 0]].forEach(([c, w, al], k) => {
      const o = (k*WAKE_SLOTS + i)*2;
      [c - w, c + w].forEach((off, e) => {
        pos.setXYZ(o + e, p.x + p.px*off, WATER_LEVEL + 0.04, p.z + p.pz*off);
        col.setW(o + e, al);
      });
    });
  }
  pos.needsUpdate = true; col.needsUpdate = true;
}
function makeRoamer(kind, x, z, yaw, dx, dz, ex, ez, rng) {
  const batch = boatBatch();
  batch.add(kind, 0, 0, 0, 0, 1, rng);
  const mesh = batch.build(), wake = new THREE.Mesh(wakeGeometry(), wakeMaterial());
  mesh.name = 'MarinaBoat'; mesh.rotation.order = 'YXZ';
  wake.name = 'MarinaWake'; wake.visible = false; wake.renderOrder = 1; wake.frustumCulled = false;
  return { kind, mesh, wake, x, z, yaw, v: 0, roll: 0, berth: { x, z }, exit: { x: ex, z: ez }, inward: Math.atan2(-dz, -dx),
    state: 'berth', timer: 20 + Math.random()*280, route: null, leg: 0 };
}
function placeRoamer(r) {
  r.mesh.position.set(r.x, WATER_LEVEL, r.z);
  r.mesh.rotation.set(r.roll, -r.yaw, Math.max(0, r.v)*(r.kind === 'sail' ? 0.004 : 0.012));
}
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
// a there-and-back chain of waypoints from the roamer's exit, or null when the water round it is too tight
function planTrip(r) {
  const inWater = App.createRegionTester(getWaterRegion()), onRoad = App.createRegionTester(S.roadFootprint || []);
  const onDeck = App.createRegionTester(S.walkDeck || []);
  const jetties = S.zones.flatMap(z => z.marinaJetties || []);
  const ok = (x, z) => inWater(x, z) && !onRoad(x, z) && !onDeck(x, z) && !jetties.some(j => {
    const rx = x - j.x, rz = z - j.z, al = rx*j.dx + rz*j.dz;
    return al > -KEEP_OUT && al < j.len + KEEP_OUT && Math.abs(-rx*j.dz + rz*j.dx) < JETTY_HALF_WIDTH + KEEP_OUT;
  });
  const sight = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x)/d, uz = (b.z - a.z)/d;
    for (let s = 0; s <= d; s += 2) {
      const x = a.x + ux*s, z = a.z + uz*s;
      if (!ok(x, z) || !ok(x - uz*3, z + ux*3) || !ok(x + uz*3, z - ux*3)) return false;
    }
    return true;
  };
  const roomy = c => { for (let k = 0; k < 8; k++) if (!ok(c.x + Math.cos(k*Math.PI/4)*7, c.z + Math.sin(k*Math.PI/4)*7)) return false; return true; };
  const chain = [], legs = 2 + Math.floor(Math.random()*4);
  let from = r.exit;
  for (let leg = 0; leg < legs; leg++) {
    let next = null;
    for (let tries = 0; tries < 30 && !next; tries++) {
      const a = Math.random()*Math.PI*2, d = 25 + Math.random()*70, c = { x: from.x + Math.cos(a)*d, z: from.z + Math.sin(a)*d };
      if (ok(c.x, c.z) && roomy(c) && sight(from, c)) next = c;
    }
    if (!next) break;
    chain.push(next); from = next;
  }
  if (!chain.length) return null;
  return [...chain, ...chain.slice(0, -1).reverse(), r.exit];
}
// straight along the jetty's line to a point without turning (astern if it's behind)
function slide(r, to, dt) {
  const dx = to.x - r.x, dz = to.z - r.z, d = Math.hypot(dx, dz);
  if (d < 0.05) { r.x = to.x; r.z = to.z; r.v = 0; return true; }
  const ahead = dx*Math.cos(r.yaw) + dz*Math.sin(r.yaw) >= 0, sp = Math.min(CRAWL, d*0.6 + 0.15, Math.abs(r.v) + ACCEL*dt);
  const step = Math.min(d, sp*dt);
  r.x += dx/d*step; r.z += dz/d*step; r.v = ahead ? sp : -sp;
  return false;
}
function stepRoamer(r, dt) {
  let turn = 0;
  if (r.state === 'berth') {
    if ((r.timer -= dt) > 0) return;
    r.route = planTrip(r);
    if (!r.route) { r.timer = 30 + Math.random()*90; return; }
    r.leg = 0; r.state = 'out';
  } else if (r.state === 'out' || r.state === 'in') {
    if (slide(r, r.state === 'out' ? r.exit : r.berth, dt)) {
      if (r.state === 'in') { r.state = 'berth'; r.timer = 60 + Math.random()*300; }
      else { r.state = 'pivot'; r.face = Math.atan2(r.route[0].z - r.z, r.route[0].x - r.x); r.then = 'roam'; }
    }
  } else if (r.state === 'pivot') {
    const diff = wrap(r.face - r.yaw);
    turn = Math.sign(diff)*Math.min(Math.abs(diff), 0.35*dt);
    r.yaw += turn;
    if (Math.abs(diff) < 0.01) r.state = r.then;
  } else if (r.state === 'roam') {
    const p = r.route[r.leg], dx = p.x - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz), last = r.leg === r.route.length - 1;
    const diff = wrap(Math.atan2(dz, dx) - r.yaw);
    turn = Math.sign(diff)*Math.min(Math.abs(diff), TURN*dt);
    r.yaw += turn;
    let want = SPEED[r.kind]*Math.min(1, Math.max(0.1, Math.cos(diff)));
    if (last) want = Math.min(want, d*0.4 + 0.5);
    r.v += Math.max(-ACCEL*dt, Math.min(ACCEL*dt, want - r.v));
    r.x += Math.cos(r.yaw)*r.v*dt; r.z += Math.sin(r.yaw)*r.v*dt;
    if (last ? d < 0.8 : d < Math.max(3, r.v*1.2)) {
      if (!last) r.leg++;
      else { r.x = p.x; r.z = p.z; r.v = 0; r.state = 'pivot'; r.face = r.inward; r.then = 'in'; }
    }
  }
  // leaning into turns
  const lean = Math.max(-0.12, Math.min(0.12, (dt > 0 ? turn/dt : 0)*r.v*0.05));
  r.roll += (lean - r.roll)*Math.min(1, dt*2);
  placeRoamer(r);
}
let lastFrame = null;
export function updateMarinas(t) {
  const dt = lastFrame == null ? 0 : Math.max(0, Math.min(0.1, t - lastFrame));
  lastFrame = t;
  S.zones.forEach(zone => (zone.marinaRoamers || []).forEach(r => { stepRoamer(r, dt); updateWake(r, dt); }));
}
