# Builds assets/models/Clothes.glb: the pieces a clothes shop is fitted out from (see "a clothes shop" in
# src/buildings/interior.js), a high-street one — rails of clothes, shelves of folded ones, a till, a changing room — in
# the same low-poly, flat-coloured style as Pub.glb's.
#
#   blender -b --python tools/clothes-models.py      (or, with the bpy module installed: python3 tools/clothes-models.py)
#
# The clothes: a Rack (a straight chrome rail on T feet, hung with shirts, dresses and trousers), a RoundRack (a ring of
# them), WallShelves of folded ones in cubbies, a DisplayTable of folded piles, a Mannequin dressed up and a ShoeStand.
# The rest: the Counter with the till and carrier bags, a ChangingRoom (a cubicle open at the front, a mirror at the back
# and a stool) and its Curtain (drawn across the cubicle's front, 1.1 wide and pleated, which interior.js squashes to one
# side to open it), a FloorMirror, a Plant, a Sale sign for the wall and a spotlight Track for the ceiling.
# Like Pub.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported). Built in metres, life size, and scaled up at the end. The Sale sign stands on its own bottom edge;
# interior.js lifts it up the wall.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Clothes.glb')
random.seed(2001)

# (the ones interior.js recolours for each shop are Fixture, Panel and the three Cloth ones; Light glows as it is)
material('Fixture', 0xf2f0ea, 0.5)
material('Panel', 0xd8c8a8, 0.7)
material('Chrome', 0xd0d4d8, 0.2, 0.85)
material('Black', 0x18181a, 0.5)
material('White', 0xf4f2ee, 0.6)
material('Wood', 0xc8a070, 0.6)
material('Mirror', 0xd4e2ea, 0.15, 0.3)
material('Mannequin', 0xe8e4dc, 0.4)
material('Curtain', 0x7a2a3a, 0.95)
material('Bag', 0xf4f0e6, 0.8)
material('BagRed', 0xc82a2a, 0.8)
material('Red', 0xd02a2a, 0.5)
material('Pot', 0x2a2a2c, 0.5)
material('Leaf', 0x2e6a32, 0.7)
material('Leaf2', 0x3e8a3a, 0.7)
material('Soil', 0x3a2a1c, 1.0)
material('Light', 0x000000, 1.0, glow=0xfff4e0)
material('GlowTill', 0x1a2a1a, 0.3, glow=0x7ac87a)
material('ClothA', 0x2a4a8a, 0.9)
material('ClothB', 0xc84a5a, 0.9)
material('ClothC', 0xe8d8b0, 0.9)
for i, colour in enumerate((0x1e1e22, 0xf2f0ea, 0x6a7a8a, 0x3a5a3a, 0xd8a040, 0x8a3a6a, 0x5a8ac8, 0xb85a2a, 0x2a3a5a, 0xa8a8a0)):
    material('Cloth%d' % i, colour, 0.9)
CLOTHS = ['ClothA', 'ClothB', 'ClothC'] + ['Cloth%d' % i for i in range(10)]
def cloth(): return random.choice(CLOTHS)

# ------------------------------------------------------------------ building blocks
# a garment on a hanger, hung from a rail at height z at (x, y), flat across the rail's way (`turn` about z: 0 for a rail
# along x): a shirt, a dress, trousers or a coat
def garment(p, x, y, z, turn=0.0, kind=None, mat=None):
    kind = kind or random.choice(('shirt', 'shirt', 'dress', 'trousers', 'coat'))
    mat = mat or cloth()
    c, s = math.cos(turn), math.sin(turn)
    at = lambda u, v, w: (x + u*c - v*s, y + u*s + v*c, w)   # u along the rail, v across it
    rot = (0, 0, turn + math.pi/2)                            # a box's x (its width) across the rail
    p.bar(at(0, 0, z + 0.01), at(0, 0, z - 0.05), 0.008, 'Chrome')           # the hook
    p.hull([(-0.2, -0.004, 0), (0.2, -0.004, 0), (0, -0.004, 0.06), (-0.2, 0.004, 0), (0.2, 0.004, 0), (0, 0.004, 0.06)],
           'Black', at=at(0, 0, z - 0.1), rot=rot)                          # the hanger
    top = z - 0.08
    if kind == 'shirt':
        p.box(0.4, 0.035, 0.6, mat, *at(0, 0, 0)[:2], top - 0.6, bevel=0.01, rot=rot)
        for side in (-1, 1):                                                  # sleeves hanging down its sides
            p.box(0.08, 0.03, 0.5, mat, *at(0, side*0.22, 0)[:2], top - 0.52, bevel=0.01, rot=(0, 0, turn + math.pi/2 + side*0.08))
    elif kind == 'coat':
        p.box(0.46, 0.05, 0.95, mat, *at(0, 0, 0)[:2], top - 0.95, bevel=0.012, rot=rot)
        for side in (-1, 1):
            p.box(0.1, 0.045, 0.7, mat, *at(0, side*0.26, 0)[:2], top - 0.72, bevel=0.012, rot=rot)
    elif kind == 'dress':
        p.hull([(-0.18, -0.02, 0), (0.18, -0.02, 0), (-0.14, -0.02, -0.4), (0.14, -0.02, -0.4), (-0.3, -0.02, -1.0), (0.3, -0.02, -1.0),
                (-0.18, 0.02, 0), (0.18, 0.02, 0), (-0.14, 0.02, -0.4), (0.14, 0.02, -0.4), (-0.3, 0.02, -1.0), (0.3, 0.02, -1.0)],
               mat, at=at(0, 0, top), rot=rot)
    else:
        p.box(0.34, 0.03, 0.08, 'Chrome', *at(0, 0, 0)[:2], top - 0.08, bevel=0.005, rot=rot)  # a clip bar
        for side in (-1, 1):
            p.box(0.16, 0.035, 0.85, mat, *at(0, side*0.085, 0)[:2], top - 0.93, bevel=0.01, rot=rot)

# a folded pile of `n` on z0 at (x, y), w wide and d deep
def pile(p, x, y, z0, n=None, w=0.3, d=0.26):
    n = n or random.randint(2, 6)
    mat = cloth()
    for k in range(n):
        p.box(w + random.uniform(-0.01, 0.01), d, 0.045, mat if random.random() < 0.8 else cloth(), x + random.uniform(-0.012, 0.012),
              y + random.uniform(-0.01, 0.01), z0 + k*0.047, bevel=0.012)

# a pair of shoes on z0 at (x, y)
def shoes(p, x, y, z0):
    mat = random.choice(('Black', 'Cloth7', 'White', 'ClothB', 'Wood'))
    for side in (-0.05, 0.05):
        p.box(0.08, 0.24, 0.05, mat, x + side, y, z0, bevel=0.02)
        p.box(0.08, 0.1, 0.06, mat, x + side, y + 0.06, z0 + 0.03, bevel=0.025)

def leaves(p, x, y, z, n=10, reach=0.35, size=0.16):
    for k in range(n):
        a = k*2.4 + random.uniform(-0.3, 0.3)
        lean = random.uniform(0.4, 1.1)
        ex, ey = x + math.cos(a)*reach*lean, y + math.sin(a)*reach*lean
        ez = z + random.uniform(0.15, 0.55)
        p.bar((x, y, z), (ex, ey, ez), 0.012, 'Leaf')
        p.hull([(-size, -size*0.6, 0), (size, -size*0.6, 0), (size*0.3, size*0.8, 0), (-size*0.3, size*0.8, 0),
                (0, 0, 0.015)], random.choice(('Leaf', 'Leaf2')), at=(ex, ey, ez), rot=(random.uniform(-0.5, 0.5), random.uniform(-0.5, 0.5), a))

# ------------------------------------------------------------------ clothes on rails
RL, RH = 1.4, 1.5
p = piece('Rack')
for x in (-RL/2, RL/2):
    p.box(0.04, 0.5, 0.03, 'Chrome', x, 0, 0, bevel=0.008)
    for y in (-0.22, 0.22): p.ball(0.02, 'Black', (x, y, 0.01))
    p.cyl(0.016, RH, 'Chrome', x, 0, 0.03, segments=8)
p.cyl(0.014, RL, 'Chrome', -RL/2, 0, RH, segments=8, rot=(0, math.pi/2, 0))
n = 11
for k in range(n):
    garment(p, -RL/2 + 0.1 + k*(RL - 0.2)/(n - 1), 0, RH, 0.0)

p = piece('RoundRack')
p.cyl(0.25, 0.03, 'Chrome', segments=14)
p.cyl(0.02, 1.25, 'Chrome', 0, 0, 0.03, segments=8)
R = 0.45
for k in range(4):
    a = k*math.pi/2
    p.bar((0, 0, 1.25), (R*math.cos(a), R*math.sin(a), 1.25), 0.015, 'Chrome')
ring = [(R*math.cos(k*math.pi/8), R*math.sin(k*math.pi/8)) for k in range(17)]
for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
    p.bar((x0, y0, 1.28), (x1, y1, 1.28), 0.02, 'Chrome')
for k in range(12):
    a = k*math.pi/6 + 0.1
    garment(p, R*math.cos(a), R*math.sin(a), 1.28, a + math.pi/2, random.choice(('shirt', 'shirt', 'dress')))

# ------------------------------------------------------------------ folded clothes
p = piece('WallShelves')
WW, WH, WD = 1.4, 2.0, 0.4
p.box(WW, 0.03, WH, 'Panel', 0, WD/2 - 0.015, 0, bevel=0.004)
for x in (-WW/2, 0, WW/2):
    p.box(0.03, WD, WH, 'Fixture', x, 0, 0, bevel=0.004)
p.box(WW, WD, 0.1, 'Fixture', 0, 0, 0, bevel=0.006)
for z in (0.5, 0.95, 1.4, 1.85):
    p.box(WW, WD, 0.025, 'Fixture', 0, 0, z, bevel=0.004)
for z in (0.1, 0.525, 0.975, 1.425):
    for x in (-WW/4 - 0.1, -WW/4 + 0.12, WW/4 - 0.12, WW/4 + 0.1):
        if random.random() < 0.85: pile(p, x, -0.02, z, n=random.randint(3, 7), w=0.2, d=0.3)
p.box(WW, 0.08, 0.1, 'Fixture', 0, 0, WH, bevel=0.006)

p = piece('DisplayTable')
TW, TD, TH = 1.2, 0.7, 0.75
p.box(TW, TD, 0.04, 'Wood', 0, 0, TH - 0.04, bevel=0.01)
for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
    p.box(0.05, 0.05, TH - 0.04, 'Wood', sx*(TW/2 - 0.06), sy*(TD/2 - 0.06), 0, bevel=0.008)
p.box(TW - 0.2, TD - 0.2, 0.03, 'Wood', 0, 0, 0.15, bevel=0.006)
for x in (-0.38, 0, 0.38):
    for y in (-0.15, 0.15):
        pile(p, x, y, TH, w=0.28, d=0.24)
for x in (-0.4, 0, 0.4): pile(p, x, 0, 0.18, n=2, w=0.28, d=0.24)

p = piece('ShoeStand')
for k, z in enumerate((0.02, 0.35, 0.68)):
    p.box(0.9 - k*0.1, 0.3, 0.03, 'Fixture', 0, 0.05*k, z, bevel=0.006)
    for x in (-0.28 + k*0.04, 0.02, 0.3 - k*0.04):
        shoes(p, x, 0.05*k, z + 0.03)
for x in (-0.44, 0.44):
    p.box(0.03, 0.4, 0.75, 'Chrome', x, 0.05, 0, bevel=0.006)

# a mannequin in a top and a skirt, on a stand
p = piece('Mannequin')
p.cyl(0.18, 0.03, 'Chrome', segments=14)
p.cyl(0.015, 0.9, 'Chrome', 0, 0, 0.03, segments=6)
torso = cloth()
p.hull([(-0.17, -0.1, 0), (0.17, -0.1, 0), (0.17, 0.1, 0), (-0.17, 0.1, 0), (-0.13, -0.08, 0.3), (0.13, -0.08, 0.3), (0.13, 0.08, 0.3), (-0.13, 0.08, 0.3),
        (-0.2, -0.1, 0.55), (0.2, -0.1, 0.55), (0.2, 0.1, 0.55), (-0.2, 0.1, 0.55), (-0.08, -0.06, 0.62), (0.08, -0.06, 0.62), (0.08, 0.06, 0.62), (-0.08, 0.06, 0.62)],
       torso, at=(0, 0, 0.95))
p.hull([(-0.18, -0.11, 0), (0.18, -0.11, 0), (0.18, 0.11, 0), (-0.18, 0.11, 0), (-0.27, -0.16, -0.45), (0.27, -0.16, -0.45), (0.27, 0.16, -0.45), (-0.27, 0.16, -0.45)],
       'ClothC' if torso != 'ClothC' else 'Cloth0', at=(0, 0, 1.0))
for side in (-1, 1):
    p.bar((side*0.2, 0, 1.46), (side*0.26, 0, 1.08), 0.06, torso)
    p.bar((side*0.26, 0, 1.08), (side*0.27, -0.04, 0.85), 0.045, 'Mannequin')
p.cyl(0.04, 0.1, 'Mannequin', 0, 0, 1.56, segments=8)
p.ball(0.1, 'Mannequin', (0, 0, 1.73), scale=(0.85, 0.95, 1.15), detail=2)

# ------------------------------------------------------------------ paying and trying on
p = piece('Counter')
CL, CD, CH = 1.6, 0.6, 1.0
p.box(CL, CD - 0.05, CH - 0.04, 'Panel', 0, 0.02, 0, bevel=0.01)
p.box(CL + 0.04, CD, 0.04, 'Fixture', 0, 0, CH - 0.04, bevel=0.01)
p.box(CL - 0.1, 0.02, 0.08, 'Fixture', 0, -CD/2 + 0.02, 0.05, bevel=0.004)
p.box(0.36, 0.3, 0.14, 'Black', 0.4, 0.1, CH, bevel=0.02)                          # the till
p.box(0.3, 0.02, 0.12, 'GlowTill', 0.4, -0.04, CH + 0.08, bevel=0.004, rot=(0.4, 0, 0))
p.box(0.14, 0.1, 0.05, 'Black', 0.05, 0.0, CH, bevel=0.015)                        # the card machine
for k, (x, mat) in enumerate(((-0.35, 'Bag'), (-0.55, 'BagRed'))):                 # carrier bags, folded flat
    p.box(0.34, 0.26, 0.012 + k*0.004, mat, x, 0.05, CH + k*0.012, bevel=0.003)
pile(p, -0.3, 0.1, CH + 0.03, n=2, w=0.26, d=0.22)
p.cyl(0.14, 0.02, 'Chrome', 0.7, 0.2, CH, segments=10)                             # a pot of hangers
p.bar((0.7, 0.2, CH), (0.68, 0.18, CH + 0.3), 0.012, 'Black')
p.bar((0.72, 0.2, CH), (0.74, 0.22, CH + 0.28), 0.012, 'Black')

# a changing room: a cubicle open at its front (-y), panelled walls, a mirror on the back wall, a stool and a hook, a
# rail across the front for its curtain (see Curtain)
CW, CD2, CHt = 1.2, 1.2, 2.2
p = piece('ChangingRoom')
p.box(CW, 0.05, CHt, 'Panel', 0, CD2/2 - 0.025, 0, bevel=0.005)                   # back
for x in (-CW/2 + 0.025, CW/2 - 0.025):
    p.box(0.05, CD2, CHt, 'Panel', x, 0, 0, bevel=0.005)                           # sides
p.box(CW, 0.1, 0.12, 'Fixture', 0, -CD2/2 + 0.05, CHt - 0.12, bevel=0.01)       # header over the front
p.cyl(0.012, CW - 0.1, 'Chrome', -CW/2 + 0.05, -CD2/2 + 0.12, CHt - 0.18, segments=6, rot=(0, math.pi/2, 0))  # curtain rail
p.box(0.5, 0.02, 1.4, 'Fixture', 0, CD2/2 - 0.055, 0.35, bevel=0.004)             # the mirror in its frame
p.box(0.44, 0.02, 1.34, 'Mirror', 0, CD2/2 - 0.065, 0.38, bevel=0.002)
p.cyl(0.16, 0.42, 'Wood', CW/2 - 0.25, CD2/2 - 0.3, 0, segments=12)               # a stool in the corner
p.bar((-CW/2 + 0.05, 0.3, 1.7), (-CW/2 + 0.12, 0.3, 1.72), 0.02, 'Chrome')        # hooks, a bag on one
p.bar((-CW/2 + 0.05, -0.1, 1.7), (-CW/2 + 0.12, -0.1, 1.72), 0.02, 'Chrome')
p.box(0.04, 0.25, 0.3, 'BagRed', -CW/2 + 0.12, 0.3, 1.4, bevel=0.01)
p.box(CW, CD2, 0.02, 'Panel', 0, 0, CHt - 0.02, bevel=0.004)                      # its ceiling
p.ball(0.05, 'Light', (0, 0.1, CHt - 0.05))

# its curtain, drawn: pleats hung from rings on the rail, reaching almost to the floor
p = piece('Curtain')
CUW, CUH = 1.1, 1.95
k = 12
for i in range(k):
    x = -CUW/2 + (i + 0.5)*CUW/k
    p.box(CUW/k + 0.02, 0.03, CUH, 'Curtain', x, 0.025 if i % 2 else -0.025, 0.04, bevel=0.01, rot=(0, 0, 0.5 if i % 2 else -0.5))
    p.cyl(0.018, 0.012, 'Chrome', x, 0, CUH + 0.04, segments=6, rot=(math.pi/2, 0, 0))

p = piece('FloorMirror')
p.box(0.6, 0.35, 0.04, 'Fixture', 0, 0.05, 0, bevel=0.01)
p.box(0.56, 0.05, 1.8, 'Fixture', 0, 0.05, 0.04, bevel=0.008, rot=(-0.06, 0, 0))
p.box(0.5, 0.02, 1.7, 'Mirror', 0, 0.02, 0.09, bevel=0.002, rot=(-0.06, 0, 0))

p = piece('Plant')
p.lathe([(0.14, 0), (0.18, 0.4), (0.19, 0.44)], 'Pot', segments=12)
p.cyl(0.17, 0.02, 'Soil', z0=0.4, segments=12)
p.bar((0, 0, 0.4), (0.02, 0.01, 1.1), 0.02, 'Leaf')
leaves(p, 0, 0, 0.7, n=12, reach=0.35, size=0.15)
leaves(p, 0.02, 0.01, 1.1, n=6, reach=0.25, size=0.12)

# a sale sign for the wall: SALE in white block letters on a red board
p = piece('Sign')
SW2, SH2 = 1.1, 0.45
p.box(SW2, 0.03, SH2, 'Red', 0, 0, 0, bevel=0.006)
LW, LH, B, T = 0.18, 0.28, 0.085, 0.045   # a letter's width, height and bottom, and its strokes' thickness
def stroke(x0, z0, x1, z1):
    dx, dz = (T/2 if x1 != x0 else 0), (T/2 if z1 != z0 else 0)   # (out past each end, so the corners meet)
    p.bar((x0 - dx, -0.025, z0 - dz), (x1 + dx, -0.025, z1 + dz), T, 'White', bevel=0.002)
def letter(ch, x):
    l, r, b, m, t = x, x + LW, B, B + LH/2, B + LH
    for x0, z0, x1, z1 in {
        'S': [(l, t, r, t), (l, m, l, t), (l, m, r, m), (r, b, r, m), (l, b, r, b)],
        'A': [(l, b, l, t), (r, b, r, t), (l, t, r, t), (l, m, r, m)],
        'L': [(l, b, l, t), (l, b, r, b)],
        'E': [(l, b, l, t), (l, t, r, t), (l, m, r - 0.04, m), (l, b, r, b)],
    }[ch]:
        stroke(x0, z0, x1, z1)
for k, ch in enumerate('SALE'):
    letter(ch, -0.43 + k*0.235)

# a track of spotlights, to go flat against the ceiling (its top at z 0.2)
p = piece('Track')
p.box(1.6, 0.05, 0.04, 'Black', 0, 0, 0.16, bevel=0.008)
for x in (-0.6, 0, 0.6):
    p.bar((x, 0, 0.16), (x, 0, 0.1), 0.02, 'Black')
    p.cyl(0.05, 0.12, 'Black', x, 0.03, 0.02, segments=10, rot=(0.5, 0, 0))
    p.cyl(0.04, 0.01, 'Light', x, 0.03, 0.015, segments=10, rot=(0.5, 0, 0))

export(OUT)
