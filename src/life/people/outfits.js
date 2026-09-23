import * as THREE from 'three';

// =========================================== OUTFITS ===========================================
// Now and then someone wears an outfit instead of clothes in colors of their own: every part of the body their clothes
// cover takes the outfit's colors, mostly all the way down (no bare arms, no midriff), and their torso takes a texture —
// a shirt and tie under a jacket, say, or the bib and straps of a pair of dungarees.
//
// The model has no UVs, so the texture is projected straight through the torso of the figure in its rest pose (facing
// +z), over OUTFIT_CHEST (a window of the model's x and y) — the faces turned forwards taking the front of it, the rest
// the back — and so rides the torso however they are posed and shaped. The arms, held out straight either side in the
// rest pose, take a strip of their own looking down on them (OUTFIT_ARM), on the faces turned upwards only: the outside of
// the arm once it hangs down (a tracksuit's stripes); and the legs one looking at them side on (OUTFIT_LEG), on the faces
// turned outwards only. Each outfit's texture is one column of an atlas, in the order of OUTFITS, its front, back, arm
// and leg one above the other; the channels are masks, not colors, so one texture takes
// anyone's colors: red and green are where the outfit's two colors of its own show (OutfitRed and OutfitGreen: a
// suit's shirt and tie), blue how much darker it is (seams, lapels, buttons). Anywhere else is the top's own color.

/** Where on the rest-pose figure the chest texture goes: the model's x and y (a window a little wider than the torso). */
export const OUTFIT_CHEST = { minX: -0.75, maxX: 0.75, minY: 5.2, maxY: 7.0 };
/** Where on the rest-pose figure the arm texture goes: along the arm (the model's x, either side) and across it (z). */
export const OUTFIT_ARM = { minX: 0.35, maxX: 3.25, minZ: -0.3, maxZ: 0.2 };
/** Where on the rest-pose figure the leg texture goes: across the leg (the model's z) and up it (y). */
export const OUTFIT_LEG = { minZ: -0.7, maxZ: 0.6, minY: 0.3, maxY: 5.3 };
export const OUTFIT_TILES = ['front', 'back', 'arm', 'leg'];
const TILE_WIDTH = 256, TILE_HEIGHT = Math.round(TILE_WIDTH*(OUTFIT_CHEST.maxY - OUTFIT_CHEST.minY)/(OUTFIT_CHEST.maxX - OUTFIT_CHEST.minX));

/**
 * The outfits (id 1 onwards, 0 being none). Each is worn either by `chance` of people or, with `hat`, by everyone
 * wearing that hat (a hairstyle's name in Hair.glb) and no one else; with `trousers`, never by anyone in a skirt.
 *
 * `colors` gives the color each part of them takes, in order (see PERSON_TRAIT_COLORS): a list to pick one from, or the
 * name of a part picked before it, to match. `bare` names the bands of clothes (see PERSON_CLOTHING) that stop where
 * the wearer's own would; the rest cover the part altogether. `paint` draws its front and back of the texture, and `paintArm` and `paintLeg`, if it
 * has them, the tops of its sleeves and the outsides of its legs.
 */
export const OUTFITS = [
  {
    name: 'Suit', chance: 0.08, bare: [],
    colors: {
      Top: [0x141518, 0x17192a, 0x1b2440, 0x222d4d, 0x26282d],                  // black, navy, charcoal
      Pants: 'Top', Skirt: 'Top',                                               // (a skirt over a woman's bare legs)
      Shoes: [0x111113, 0x111113, 0x3b2a1e],
      OutfitRed: [0xf2f2ee, 0xf2f2ee, 0xf2f2ee, 0xdce6f2, 0xeeeae0],            // the shirt: mostly white, some pale blue or cream
      OutfitGreen: [0x8c1c24, 0x5e1a2a, 0x1f2d55, 0x2d4f8a, 0x2e5a3c, 0xa8842c, 0x151515, 0x6b6e75], // the tie
    },
    paint: paintSuit,
  },
  {
    // work dungarees, over a t-shirt with its sleeves wherever, and boots
    name: 'Dungarees', hat: 'Hair46_GB', bare: ['Sleeve'],
    colors: {
      Top: [0xeeeeea, 0x9a9ca0, 0x2b2b2f, 0xd8e03a, 0xe07a26, 0x7a2a26, 0x4f6b3a],  // white, grey, black, hi-vis, orange, rust, green
      Pants: [0x3e5a82, 0x2f4466, 0xc8641e, 0x6b4a2e, 0x5f6166],                    // denim, dark denim, orange, brown, grey
      Skirt: 'Pants', OutfitGreen: 'Pants',                                          // (the bib and straps)
      OutfitRed: [0xb8b8b2, 0x9a8a5a],                                               // the buckles: steel or brass
      Shoes: [0x6b4a2f, 0x8a6a3e, 0x2b2118, 0x151517],                               // work boots
      Hat: [0xf0c419, 0xf0c419, 0xe8741c, 0xeeeee8, 0xc8322a, 0x2f5fa8],             // the hard hat: mostly yellow
    },
    paint: paintDungarees,
  },
  {
    // a tracksuit, all of a piece
    name: 'Tracksuit', chance: 0.05, bare: [], trousers: true,
    colors: {
      Top: [0x1b2a5c, 0x151517, 0xb3202a, 0x2856b8, 0x1f6b3a, 0x6a1c2c, 0x4b2a7a, 0x1d7a80, 0xd6508a, 0x6e7075, 0xe0a51c],
      Pants: 'Top', Skirt: 'Top',
      OutfitRed: [0x8a8c90],                                                    // the zip
      OutfitGreen: [0xf4f4f0],                                                  // the stripes down the arms
    },
    paint: paintTracksuit, paintArm: paintTracksuitArm, paintLeg: paintTracksuitLeg,
  },
];

/**
 * Pick which outfit someone wears.
 * @param {function(): number} rng - their outfit rng
 * @param {?string} hat - the name of the hairstyle (or hat) they wear, or null
 * @param {boolean} skirt - whether they wear a skirt
 * @returns {number} the outfit's id (its place in OUTFITS, from 1), or 0 for none
 */
export function pickOutfit(rng, hat, skirt) {
  const worn = OUTFITS.findIndex(outfit => outfit.hat && outfit.hat === hat);
  if (worn >= 0) return worn + 1;
  let roll = rng();
  for (let k=0;k<OUTFITS.length;k++) {
    if (OUTFITS[k].hat) continue;
    if (roll < OUTFITS[k].chance) return OUTFITS[k].trousers && skirt ? 0 : k + 1;
    roll -= OUTFITS[k].chance;
  }
  return 0;
}

/**
 * The texture every outfit is drawn from: a column per outfit, left to right, its tiles (OUTFIT_TILES) top to bottom.
 * @returns {THREE.CanvasTexture}
 */
export function buildOutfitTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_WIDTH*OUTFITS.length; canvas.height = TILE_HEIGHT*OUTFIT_TILES.length;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  OUTFITS.forEach((outfit, k) => OUTFIT_TILES.forEach((tile, row) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(k*TILE_WIDTH + 1, row*TILE_HEIGHT + 1, TILE_WIDTH - 2, TILE_HEIGHT - 2); ctx.clip(); // (a black edge, so a tile never bleeds into the next)
    ctx.translate(k*TILE_WIDTH, row*TILE_HEIGHT);
    if (tile === 'front' || tile === 'back') outfit.paint(ctx, TILE_WIDTH, TILE_HEIGHT, tile === 'front');
    else if (tile === 'arm' && outfit.paintArm) outfit.paintArm(ctx, TILE_WIDTH, TILE_HEIGHT);
    else if (tile === 'leg' && outfit.paintLeg) outfit.paintLeg(ctx, TILE_WIDTH, TILE_HEIGHT);
    ctx.restore();
  }));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace; // (masks, not colors)
  texture.anisotropy = 4;
  return texture;
}

/**
 * Draw on the tile in the model's own units: x across (0 the middle), y up.
 * @returns {{x: function(number): number, y: function(number): number, s: function(number): number}} model to canvas
 */
function modelToTile(width, height) {
  const scale = width/(OUTFIT_CHEST.maxX - OUTFIT_CHEST.minX);
  return { x: x => (x - OUTFIT_CHEST.minX)*scale, y: y => (OUTFIT_CHEST.maxY - y)*scale, s: d => d*scale };
}

const RED = '#f00', GREEN = '#0f0', SHADE = b => `rgb(0,0,${Math.round(b*255)})`;

/**
 * Pens for drawing on a tile in the model's units.
 * @returns {{polygon: function, line: function, dot: function}}
 */
function pens(ctx, width, height) {
  const { x, y, s } = modelToTile(width, height);
  const path = points => { ctx.beginPath(); points.forEach(([px, py], i) => i ? ctx.lineTo(x(px), y(py)) : ctx.moveTo(x(px), y(py))); };
  return {
    polygon: (points, fill) => { ctx.fillStyle = fill; path(points); ctx.closePath(); ctx.fill(); },
    line: (points, stroke, w) => { ctx.strokeStyle = stroke; ctx.lineWidth = s(w); ctx.lineCap = ctx.lineJoin = 'round'; path(points); ctx.stroke(); },
    dot: (px, py, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x(px), y(py), s(r), 0, Math.PI*2); ctx.fill(); },
  };
}

/**
 * Pens for drawing on an arm tile, in the model's units: x along the arm (from OUTFIT_ARM.minX), z across it.
 * @returns {{polygon: function}}
 */
function armPens(ctx, width, height) {
  const x = px => (px - OUTFIT_ARM.minX)/(OUTFIT_ARM.maxX - OUTFIT_ARM.minX)*width, z = pz => (OUTFIT_ARM.maxZ - pz)/(OUTFIT_ARM.maxZ - OUTFIT_ARM.minZ)*height;
  return {
    polygon: (points, fill) => { ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([px, pz], i) => i ? ctx.lineTo(x(px), z(pz)) : ctx.moveTo(x(px), z(pz))); ctx.closePath(); ctx.fill(); },
  };
}

/**
 * Pens for drawing on a leg tile, in the model's units: z across the leg (its front to the right), y up it.
 * @returns {{polygon: function}}
 */
function legPens(ctx, width, height) {
  const z = pz => (pz - OUTFIT_LEG.minZ)/(OUTFIT_LEG.maxZ - OUTFIT_LEG.minZ)*width, y = py => (OUTFIT_LEG.maxY - py)/(OUTFIT_LEG.maxY - OUTFIT_LEG.minY)*height;
  return {
    polygon: (points, fill) => { ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([pz, py], i) => i ? ctx.lineTo(z(pz), y(py)) : ctx.moveTo(z(pz), y(py))); ctx.closePath(); ctx.fill(); },
  };
}

/**
 * The business suit: a jacket open in a V down to its buttons, a buttoned-up shirt with a collar, and a tie; behind, a
 * plain back with a seam and a vent.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {boolean} front - the front, or the back
 */
function paintSuit(ctx, width, height, front) {
  const { polygon, line, dot } = pens(ctx, width, height);
  if (!front) {
    line([[0, 6.9], [0, 5.25]], SHADE(0.2), 0.01);
    line([[0, 5.55], [0, 5.25]], SHADE(0.5), 0.014);
    return;
  }
  const SHIRT = RED, TIE = GREEN;
  const top = 7.0, vBottom = 5.95, neck = 0.19;   // the V's top (over the neck), its point, and how wide it opens there

  // the shirt, filling the V (and over the neck's base, which the collar hides)
  polygon([[-neck - 0.03, top], [neck + 0.03, top], [0, vBottom]], SHIRT);
  // its placket and buttons, peeping out beside the tie's tip
  line([[0, 6.3], [0, vBottom + 0.03]], 'rgb(255,0,60)', 0.012);
  [6.22, 6.08].forEach(py => dot(0, py, 0.014, 'rgb(255,0,110)'));
  // the tie: a knot tight under the collar, then the blade, widening to a point
  polygon([[-0.045, 6.9], [0.045, 6.9], [0.032, 6.81], [-0.032, 6.81]], TIE);
  polygon([[-0.028, 6.81], [0.028, 6.81], [0.062, 6.24], [0, 6.14], [-0.062, 6.24]], TIE);
  line([[-0.032, 6.81], [0.032, 6.81]], 'rgb(0,255,120)', 0.012); // under the knot
  line([[0.01, 6.78], [0.04, 6.3]], 'rgb(0,255,50)', 0.008);        // a fold down the blade
  // the collar: two points turned down over the tie's knot either side
  polygon([[-0.05, 6.93], [-neck - 0.01, 6.98], [-0.13, 6.78]], SHIRT);
  polygon([[0.05, 6.93], [neck + 0.01, 6.98], [0.13, 6.78]], SHIRT);
  line([[-0.05, 6.93], [-0.13, 6.78], [-neck - 0.01, 6.98]], 'rgb(255,0,90)', 0.01);
  line([[0.05, 6.93], [0.13, 6.78], [neck + 0.01, 6.98]], 'rgb(255,0,90)', 0.01);
  // the jacket's lapels: the V's edges, and a notch and fold line out towards the shoulders
  [-1, 1].forEach(side => {
    line([[side*(neck + 0.03), top], [0, vBottom]], SHADE(0.55), 0.016);
    line([[side*(neck + 0.03), 6.86], [side*0.3, 6.7], [side*0.11, 6.12]], SHADE(0.3), 0.012);
    line([[side*0.3, 6.7], [side*0.25, 6.62]], SHADE(0.4), 0.012);
    // a breast pocket on the left, a seam on either side
    if (side > 0) line([[0.22, 6.42], [0.38, 6.45]], SHADE(0.45), 0.014);
    line([[side*0.34, 6.2], [side*0.38, 5.35]], SHADE(0.18), 0.01);
  });
  // where the jacket closes, below the V, and its buttons
  line([[0, vBottom], [0.015, 5.25]], SHADE(0.4), 0.012);
  [5.86, 5.62].forEach(py => { dot(0.015, py, 0.024, SHADE(0.7)); dot(0.015, py, 0.012, SHADE(0.35)); });
  // hip pockets
  [-1, 1].forEach(side => line([[side*0.14, 5.45], [side*0.32, 5.43]], SHADE(0.45), 0.014));
}

/**
 * Work dungarees: a bib over the chest with straps up over the shoulders, a square buckle joining each to it, and the
 * trousers coming up to the waist all round; behind, the straps crossing down to the waistband.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {boolean} front - the front, or the back
 */
function paintDungarees(ctx, width, height, front) {
  const { polygon } = pens(ctx, width, height);
  const BIB = GREEN, METAL = RED, waist = 5.92;
  // below the waist, all the way round, the trousers
  polygon([[-1, waist], [1, waist], [1, 5.0], [-1, 5.0]], BIB);
  if (front) {
    const bibTop = 6.55, bibHalf = 0.23;
    polygon([[-bibHalf, bibTop], [bibHalf, bibTop], [bibHalf + 0.02, waist], [-bibHalf - 0.02, waist]], BIB);
    [-1, 1].forEach(side => {
      // the strap, from the bib's corner up over the shoulder, and the buckle joining them
      polygon([[side*(bibHalf - 0.1), bibTop], [side*bibHalf, bibTop], [side*0.36, 7.1], [side*0.24, 7.1]], BIB);
      polygon([[side*(bibHalf - 0.1), bibTop + 0.07], [side*bibHalf, bibTop + 0.07], [side*bibHalf, bibTop - 0.03], [side*(bibHalf - 0.1), bibTop - 0.03]], METAL);
    });
  } else {
    // the straps crossing, from over the shoulders to the waistband either side
    [-1, 1].forEach(side => polygon([[side*0.36, 7.1], [side*0.24, 7.1], [-side*0.2, waist], [-side*0.08, waist]], BIB));
  }
}

/**
 * The tracksuit's top: a zip down the middle of the front, its pull a triangle at the neck; a plain back.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {boolean} front - the front, or the back
 */
function paintTracksuit(ctx, width, height, front) {
  if (!front) return;
  const { polygon, line } = pens(ctx, width, height);
  const ZIP = RED;
  line([[0, 6.95], [0, 5.5]], ZIP, 0.025);
  polygon([[-0.05, 6.9], [0.05, 6.9], [0, 6.76]], ZIP);
}

/**
 * The tracksuit's sleeves: two stripes all the way down the outside.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 */
function paintTracksuitArm(ctx, width, height) {
  const { polygon } = armPens(ctx, width, height);
  const STRIPE = GREEN, middle = -0.045;
  [-1, 1].forEach(side => {
    const z0 = middle + side*0.025, z1 = middle + side*0.06;
    polygon([[0, z0], [4, z0], [4, z1], [0, z1]], STRIPE);
  });
}

/**
 * The tracksuit's legs: two stripes all the way down the outside, following the middle of each face of the leg (the
 * model's legs being boxes: hip, thigh and shin), from the waist to the ankle.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 */
function paintTracksuitLeg(ctx, width, height) {
  const { polygon } = legPens(ctx, width, height);
  const STRIPE = GREEN, middle = [[-0.01, 0.2], [-0.01, 0.34], [0.055, 2.62], [-0.06, 4.54], [-0.02, 5.24], [-0.02, 5.4]];
  [-1, 1].forEach(side => {
    const [a, b] = [0.025, 0.06].map(off => middle.map(([z, y]) => [z + side*off, y]));
    polygon([...a, ...b.reverse()], STRIPE);
  });
}
