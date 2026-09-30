import * as THREE from 'three';
import { mergeGeometryList as merge } from './windows.js';

// A shop's hanging sign: an iron bracket out from the wall, a painted board in a gilt frame, and the shop's symbol
// (SYMBOLS) cut flat on both faces. Parts as [geometry, material], x along the wall, y out from it, z up, the origin on
// the wall at the bracket's top.

// each symbol drawn in a unit box (centred, 1 tall), as shapes for ExtrudeGeometry
const poly = pts => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
const ring = (x, y, r, hole) => {
  const s = new THREE.Shape().absarc(x, y, r, 0, Math.PI*2, false);
  s.holes.push(new THREE.Path().absarc(x, y, hole, 0, Math.PI*2, true));
  return s;
};
const SYMBOLS = {
  // a nonic pint, its head split off by a line
  pub: () => [
    poly([[-0.2, -0.5], [0.2, -0.5], [0.27, 0.2], [0.3, 0.26], [0.27, 0.32], [-0.27, 0.32], [-0.3, 0.26], [-0.27, 0.2]]),
    poly([[-0.28, 0.36], [0.28, 0.36], [0.29, 0.5], [-0.29, 0.5]]),
  ],
  // scissors, open: two blades crossing, a ring handle on each
  salon: () => {
    const blade = sign => {
      const s = poly([[-0.035, -0.12], [0.035, -0.12], [0.012, 0.52], [-0.01, 0.52]]), m = new THREE.Matrix3().makeRotation(sign*0.3);
      return poly(s.getPoints().map(p => p.applyMatrix3(m)).map(p => [p.x, p.y]));
    };
    return [blade(1), blade(-1), ring(0.1, -0.33, 0.14, 0.08), ring(-0.1, -0.33, 0.14, 0.08)];
  },
  // a T-shirt
  clothes: () => {
    const s = poly([[-0.12, 0.45], [-0.3, 0.41], [-0.5, 0.22], [-0.39, 0.08], [-0.27, 0.17], [-0.27, -0.5], [0.27, -0.5],
      [0.27, 0.17], [0.39, 0.08], [0.5, 0.22], [0.3, 0.41], [0.12, 0.45]]);
    s.quadraticCurveTo(0, 0.3, -0.12, 0.45);
    return [s];
  },
  // a fork and a knife
  restaurant: () => {
    const fork = [poly([[-0.27, -0.5], [-0.19, -0.5], [-0.19, 0.08], [-0.27, 0.08]]), poly([[-0.33, 0.08], [-0.13, 0.08], [-0.15, 0.2], [-0.31, 0.2]])];
    for (let k = 0; k < 3; k++) { const x = -0.33 + k*0.08; fork.push(poly([[x, 0.19], [x + 0.04, 0.19], [x + 0.04, 0.5], [x, 0.5]])); }
    const blade = poly([[0.17, 0.02], [0.29, 0.02], [0.29, 0.3]]);
    blade.quadraticCurveTo(0.29, 0.5, 0.17, 0.5);
    return [...fork, poly([[0.18, -0.5], [0.26, -0.5], [0.26, 0.02], [0.18, 0.02]]), blade];
  },
};
const symbolGeos = new Map();
function symbolGeometry(kind) {
  if (!SYMBOLS[kind]) return null;
  if (!symbolGeos.has(kind)) symbolGeos.set(kind, new THREE.ExtrudeGeometry(SYMBOLS[kind](), { depth: 0.02, bevelEnabled: false, curveSegments: 10 }));
  return symbolGeos.get(kind).clone();
}

const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.02, side: THREE.DoubleSide, ...extra });
const box = (w, d, h, x, y, z) => new THREE.BoxGeometry(w, d, h).translate(x, y, z);
export function hangingSign(kind, board) {
  const out = 0.75, mid = -0.75;
  const parts = [
    [merge([
      box(0.06, 1.35, 0.06, 0, 0.68, 0),               // the bracket, out from the wall
      box(0.05, 0.05, 0.55, 0, 0.05, -0.25),           // its plate on the wall
      box(0.04, 0.04, 0.2, 0, out - 0.3, -0.12),       // and what it hangs from
      box(0.04, 0.04, 0.2, 0, out + 0.3, -0.12),
    ]), mat(0x1a1a1a)],
    [box(0.08, 0.86, 1.06, 0, out, mid), mat(0xc8a040, { roughness: 0.35, metalness: 0.5 })],
    [box(0.1, 0.72, 0.92, 0, out, mid), mat(board)],
  ];
  const sym = symbolGeometry(kind);
  if (sym) {
    // (on both faces, light on a dark board and dark on a light one)
    const c = new THREE.Color(board), light = c.r*0.3 + c.g*0.59 + c.b*0.11 > 0.55;
    const face = s => sym.clone().scale(0.52, 0.52, 1).rotateX(Math.PI/2).rotateZ(s*Math.PI/2).translate(s*0.05, out, mid);
    parts.push([merge([face(1), face(-1)]), mat(light ? 0x1d2340 : 0xf4ead0, { roughness: 0.5 })]);
  }
  return parts;
}
