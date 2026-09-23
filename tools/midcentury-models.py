# Builds assets/models/MidCentury.glb: the pieces a mid-century home is furnished from (see "a mid-century home" in
# src/buildings/interior.js), in the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/midcentury-models.py
#
# Most pieces stand in for Interior.glb's own, under the same names (Sofa, Chair, Table, TV, Lamp, Plant, Coffee Table,
# Rug, Bookcase, Pendant, Drawers), so a mid-century home is laid out as any other; the rest (LoungeChair and its
# Ottoman, Radiogram, a Sunburst clock and an abstract Print) only a mid-century home has. Like Interior.glb, it's one
# top-level mesh per piece, at five times life size, each facing -y (the room's +z, once exported) but for the TV, which
# faces +y as Interior.glb's does. Built in metres, life size, and scaled up at the end.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'MidCentury.glb')
random.seed(19)

# (the ones interior.js recolours for each mid-century home are Teak, Tweed, Accent, Shell, Leather, Brass, Ceramic,
# Tulip, LampShade, RugField, RugA, RugB and the print's Print*; Light glows as it is)
material('Teak', 0x9a5a2e, 0.5)
material('Tweed', 0x6a7a5a, 1.0)
material('Accent', 0xd8a030, 0.9)
material('Shell', 0xe8a040, 0.4)
material('Leather', 0x2a1a14, 0.4)
material('Ply', 0x6a3a1e, 0.4)
material('Brass', 0xc8a050, 0.3, 0.6)
material('Chrome', 0xc8ccd0, 0.2, 0.8)
material('Black', 0x18181a, 0.5)
material('Ceramic', 0x2a7a7a, 0.3)
material('Ceramic2', 0xece6d8, 0.3)
material('Tulip', 0xf2f0ea, 0.35)
material('Screen', 0xcccccc, 0.5)
material('TV', 0x141416, 0.4)
material('LampShade', 0xf0e6d0, 1.0)
material('Light', 0x000000, 1.0, glow=0xfff0d0)
material('Grille', 0xc8b89a, 1.0)
material('Vinyl', 0x101012, 0.3)
material('Label', 0xd83a2a, 0.8)
material('Dirt', 0x2a1a0e, 1.0)
material('Leaf', 0x2a6a2a, 0.6)
material('Stem', 0x4a5a2a, 0.8)
material('Paper', 0xf4f0e2, 0.9)
material('RugField', 0xe8dcc0, 1.0)
material('RugA', 0xd8702a, 1.0)
material('RugB', 0x2a6a6a, 1.0)
material('Print0', 0xf0e8d6, 0.9)
material('Print1', 0xd8702a, 0.9)
material('Print2', 0x2a5a7a, 0.9)
material('Print3', 0xe0b030, 0.9)
material('Print4', 0x1a1a1a, 0.9)
for i, colour in enumerate((0xd8702a, 0x2a4a5a, 0xe8d8b0, 0x5a6a3a, 0x8a2a2a, 0x1a1a1a)):
    material('Book%d' % i, colour, 0.7)
BOOKS = ['Book%d' % i for i in range(6)]

# a tapered leg from the underside of something at (x, y, h) down to the floor, splayed out by (sx, sy) at its foot,
# r thick at the top and r2 at the foot
def leg(p, x, y, h, sx=0.0, sy=0.0, r=0.022, r2=0.012, mat='Teak', z0=0.0):
    p.hull([(x + dx*r, y + dy*r, h) for dx in (-1, 1) for dy in (-1, 1)]
           + [(x + sx + dx*r2, y + sy + dy*r2, z0) for dx in (-1, 1) for dy in (-1, 1)], mat)

# four splayed legs under a w by d top at height h, inset by `inset`
def legs(p, w, d, h, inset=0.08, splay=0.05, r=0.022, r2=0.012, mat='Teak'):
    for sx in (-1, 1):
        for sy in (-1, 1):
            leg(p, sx*(w/2 - inset), sy*(d/2 - inset), h, sx*splay, sy*splay, r, r2, mat)

# a vase, standing on z0 at (x, y): a bottle shape, `h` high
def vase(p, x, y, z0, h=0.25, mat='Ceramic'):
    p.lathe([(0.03, 0), (0.06, h*0.15), (0.065, h*0.4), (0.035, h*0.7), (0.018, h*0.85), (0.025, h)], mat, x, y, z0)

# a row of books stood up, their spines to -y, from x to x_end on z0 at y (their backs to +y); returns where they end
def books(p, x, x_end, y, z0):
    while x < x_end - 0.05:
        w, h, d = random.uniform(0.025, 0.045), random.uniform(0.18, 0.26), random.uniform(0.14, 0.18)
        p.box(w, d, h, random.choice(BOOKS), x + w/2, y - d/2, z0, bevel=0.003)
        x += w + 0.003
    return x

# ------------------------------------------------------------------ the sofa: long, low, on tapered legs
p = piece('Sofa')
W, D = 2.1, 0.85
p.box(W, D, 0.08, 'Teak', 0, 0, 0.2, bevel=0.012)                              # the plinth frame
legs(p, W, D, 0.2, inset=0.1, splay=0.04)
for x in (-0.66, 0, 0.66):                                                      # three seat cushions
    p.box(0.66, 0.66, 0.15, 'Tweed', x, -0.08, 0.28, bevel=0.03, segments=2)
for x in (-0.66, 0, 0.66):                                                      # and three back cushions
    p.box(0.64, 0.16, 0.4, 'Tweed', x, D/2 - 0.12, 0.33, bevel=0.035, segments=2, rot=(-0.12, 0, 0))
p.box(W, 0.06, 0.34, 'Teak', 0, D/2 - 0.03, 0.28, bevel=0.01)                   # its back, and slim arms
for s in (-1, 1):
    p.box(0.05, D, 0.3, 'Teak', s*(W/2 - 0.025), 0, 0.28, bevel=0.01)
p.box(0.4, 0.14, 0.34, 'Accent', -0.72, 0.13, 0.43, bevel=0.05, segments=2, rot=(-0.3, 0, 0.15))  # a cushion

# ------------------------------------------------------------------ the lounge chair (a moulded-ply shell, in leather) and its ottoman
p = piece('LoungeChair')
TILT = -0.2
p.box(0.1, 0.1, 0.06, 'Black', 0, 0.02, 0.2, bevel=0.01)                        # the swivel
for k in range(5):                                                             # a five-star base
    a = k*2*math.pi/5 + math.pi/2
    p.bar((0, 0.02, 0.2), (math.cos(a)*0.36, 0.02 + math.sin(a)*0.36, 0.05), 0.03, 'Black')
    p.cyl(0.018, 0.03, 'Chrome', math.cos(a)*0.36, 0.02 + math.sin(a)*0.36, 0.02, segments=8)
p.box(0.72, 0.62, 0.05, 'Ply', 0, -0.02, 0.26, bevel=0.015, rot=(0.08, 0, 0))    # the seat shell and its cushion
p.box(0.62, 0.6, 0.13, 'Leather', 0, -0.04, 0.3, bevel=0.04, segments=2, rot=(0.08, 0, 0))   # (top at 0.43)
p.box(0.72, 0.06, 0.62, 'Ply', 0, 0.34, 0.36, bevel=0.015, rot=(TILT, 0, 0))    # the back shell, in two parts
p.box(0.62, 0.14, 0.56, 'Leather', 0, 0.26, 0.4, bevel=0.04, segments=2, rot=(TILT, 0, 0))
p.box(0.62, 0.06, 0.3, 'Ply', 0, 0.44, 0.95, bevel=0.015, rot=(TILT*1.5, 0, 0))
p.box(0.54, 0.12, 0.28, 'Leather', 0, 0.37, 0.96, bevel=0.04, segments=2, rot=(TILT*1.5, 0, 0))
for s in (-1, 1):                                                               # the arms
    p.box(0.08, 0.5, 0.05, 'Ply', s*0.38, 0.0, 0.52, bevel=0.012)
    p.box(0.08, 0.44, 0.06, 'Leather', s*0.38, 0.0, 0.57, bevel=0.025)
    p.box(0.03, 0.04, 0.24, 'Chrome', s*0.38, 0.18, 0.3, bevel=0.005)

p = piece('Ottoman')
for k in range(4):
    a = k*math.pi/2 + math.pi/4
    p.bar((0, 0, 0.17), (math.cos(a)*0.26, math.sin(a)*0.26, 0.04), 0.03, 'Black')
    p.cyl(0.016, 0.03, 'Chrome', math.cos(a)*0.26, math.sin(a)*0.26, 0.01, segments=8)
p.box(0.08, 0.08, 0.1, 'Black', 0, 0, 0.14, bevel=0.01)
p.box(0.6, 0.48, 0.04, 'Ply', 0, 0, 0.24, bevel=0.012)
p.box(0.54, 0.44, 0.13, 'Leather', 0, 0, 0.27, bevel=0.04, segments=2)

# ------------------------------------------------------------------ the dining chair: a moulded shell on a wire base
p = piece('Chair')
for sx in (-1, 1):
    for sy in (-1, 1):
        p.bar((sx*0.08, sy*0.08, 0.36), (sx*0.21, sy*0.2, 0), 0.012, 'Chrome', bevel=0)
    p.bar((sx*0.21, -0.2, 0.0), (sx*0.21, 0.2, 0.0), 0.01, 'Chrome', bevel=0)
    p.bar((sx*0.08, -0.08, 0.36), (sx*-0.08, 0.08, 0.36), 0.008, 'Chrome', bevel=0)   # the Eiffel cross
    p.bar((sx*0.2, -0.19, 0.03), (-sx*0.08, 0.08, 0.36), 0.006, 'Chrome', bevel=0)
p.box(0.46, 0.44, 0.06, 'Shell', 0, -0.01, 0.38, bevel=0.025, segments=2)         # the shell's seat, top at 0.44
p.hull([(-0.23, 0.14, 0.42), (0.23, 0.14, 0.42), (-0.25, 0.26, 0.82), (0.25, 0.26, 0.82),
        (-0.23, 0.18, 0.42), (0.23, 0.18, 0.42), (-0.25, 0.3, 0.8), (0.25, 0.3, 0.8)], 'Shell')   # its back
for s in (-1, 1):                                                                # and a lip up each side
    p.hull([(s*0.23, -0.2, 0.42), (s*0.23, 0.2, 0.42), (s*0.24, 0.2, 0.5), (s*0.23, -0.16, 0.47),
            (s*0.2, -0.2, 0.42), (s*0.2, 0.2, 0.42), (s*0.21, 0.2, 0.5), (s*0.2, -0.16, 0.47)], 'Shell')

# ------------------------------------------------------------------ the dining table: a round top on a tulip foot
p = piece('Table')
TR, TH = 0.55, 0.73
p.lathe([(0.27, 0), (0.25, 0.03), (0.12, 0.08), (0.06, 0.2), (0.05, 0.45), (0.08, 0.62), (0.2, 0.69), (0.24, 0.7)],
        'Tulip', segments=24)
p.cyl(TR, 0.03, 'Tulip', z0=TH - 0.03, segments=32)
p.cyl(0.2, 0.004, 'Ceramic', 0, 0, TH, r2=0.21, segments=20)                    # a fruit bowl, and fruit
p.lathe([(0.06, 0), (0.14, 0.04), (0.16, 0.07)], 'Ceramic', 0, 0, TH, segments=16)
for k, (x, y) in enumerate(((-0.04, -0.03), (0.05, -0.02), (0.0, 0.05), (0.02, 0.0))):
    p.ball(0.038, 'Accent' if k % 2 else 'Label', (x, y, TH + 0.08 + (0.04 if k == 3 else 0)), detail=1)

# ------------------------------------------------------------------ the TV, on a teak credenza (facing +y)
p = piece('TV')
CW, CD, CH = 1.7, 0.45, 0.62
legs(p, CW, CD, 0.2, inset=0.1, splay=0.03)
p.box(CW, CD, CH - 0.2, 'Teak', 0, 0, 0.2, bevel=0.012)
for k in range(4):                                                             # sliding doors, a slot in each
    x = -CW/2 + CW/8 + k*CW/4
    p.box(CW/4 - 0.02, 0.012, CH - 0.26, 'Teak' if k % 3 else 'Accent', x, CD/2 + 0.004, 0.23, bevel=0.004)
    p.box(0.012, 0.014, 0.12, 'Black', x + (0.13 if k % 2 == 0 else -0.13), CD/2 + 0.008, 0.36, bevel=0)
p.box(0.3, 0.2, 0.015, 'TV', 0.1, 0, CH, bevel=0.005)                           # the TV's foot and neck
p.box(0.07, 0.04, 0.12, 'TV', 0.1, -0.03, CH + 0.015, bevel=0.005)
p.box(1.12, 0.05, 0.66, 'TV', 0.1, 0, CH + 0.08, bevel=0.01)
p.box(1.06, 0.006, 0.6, 'Screen', 0.1, 0.027, CH + 0.11, bevel=0.001)
vase(p, -0.66, 0.02, CH, 0.3)
vase(p, -0.56, -0.06, CH, 0.18, 'Ceramic2')
p.box(0.1, 0.1, 0.1, 'Brass', 0.74, -0.05, CH, bevel=0.01, rot=(0, 0, 0.4))    # (an ornament)

# ------------------------------------------------------------------ the floor lamp: a tripod, with a cone of a shade
p = piece('Lamp')
for k in range(3):
    a = k*2*math.pi/3
    leg(p, 0, 0, 1.2, math.cos(a)*0.24, math.sin(a)*0.24, 0.012, 0.01)
p.cyl(0.02, 0.1, 'Brass', z0=1.18, segments=10)
p.cyl(0.08, 0.3, 'LampShade', z0=1.26, r2=0.22, segments=18, rot=(0.25, 0, 0))
p.cyl(0.07, 0.006, 'Light', z0=1.27, segments=14, rot=(0.25, 0, 0))

# ------------------------------------------------------------------ a rubber plant, in a pot on a wire stand
p = piece('Plant')
for k in range(3):
    a = k*2*math.pi/3
    p.bar((math.cos(a)*0.12, math.sin(a)*0.12, 0.3), (math.cos(a)*0.17, math.sin(a)*0.17, 0), 0.012, 'Black', bevel=0)
p.cyl(0.13, 0.012, 'Black', z0=0.24, segments=14)
p.lathe([(0.09, 0.25), (0.12, 0.3), (0.15, 0.5), (0.155, 0.51)], 'Ceramic', segments=16)
p.cyl(0.14, 0.01, 'Dirt', z0=0.48, segments=12)
for s, (dx, dy, top) in enumerate(((0, 0, 1.4), (0.08, 0.05, 1.1), (-0.07, -0.04, 1.2))):
    p.cyl(0.012, top - 0.5, 'Stem', dx*0.3, dy*0.3, 0.49, r2=0.008, segments=6, rot=(dy*1.2, -dx*1.2, 0))
    for k in range(6):
        z = 0.75 + k*(top - 0.75)/6
        a = k*2.4 + s
        cx, cy = dx*(z - 0.5)*1.3, dy*(z - 0.5)*1.3
        tipx, tipy = cx + math.cos(a)*0.24, cy + math.sin(a)*0.24
        side = (-math.sin(a)*0.06, math.cos(a)*0.06)
        p.hull([(cx, cy, z), (cx + math.cos(a)*0.1 + side[0], cy + math.sin(a)*0.1 + side[1], z + 0.02),
                (cx + math.cos(a)*0.1 - side[0], cy + math.sin(a)*0.1 - side[1], z + 0.03), (tipx, tipy, z - 0.02),
                (cx + math.cos(a)*0.1, cy + math.sin(a)*0.1, z + 0.035)], 'Leaf')

# ------------------------------------------------------------------ the coffee table: a teak surfboard on tapered legs
p = piece('Coffee Table')
CW, CD, CH = 1.3, 0.6, 0.4
pts = []
for k in range(24):
    a = k*2*math.pi/24
    c, s = math.cos(a), math.sin(a)
    pts += [(CW/2*c*abs(c)**-0.3 if c else 0, CD/2*s*abs(s)**-0.3 if s else 0)]
pts = [(x if abs(x) <= CW/2 else math.copysign(CW/2, x), y if abs(y) <= CD/2 else math.copysign(CD/2, y)) for x, y in pts]
p.prism(pts, 0.035, 'Teak', z0=CH - 0.035)
legs(p, CW*0.8, CD*0.8, CH - 0.035, inset=0.08, splay=0.04, r=0.02, r2=0.011)
p.cyl(0.14, 0.03, 'Ceramic2', -0.3, 0.02, CH, r2=0.17, segments=16)            # a bowl
p.box(0.22, 0.3, 0.012, 'Print1', 0.1, -0.05, CH, bevel=0.002, rot=(0, 0, 0.2))  # magazines
p.box(0.22, 0.3, 0.012, 'Print2', 0.13, -0.02, CH + 0.012, bevel=0.002, rot=(0, 0, -0.15))
p.lathe([(0.05, 0), (0.06, 0.02), (0.045, 0.03)], 'Brass', 0.42, 0.08, CH, segments=12)    # an ashtray
vase(p, 0.42, -0.12, CH, 0.16, 'Accent')

# ------------------------------------------------------------------ the rug: a field of circles and diamonds
p = piece('Rug')
RW, RD = 1.8, 1.2
p.box(RW, RD, 0.012, 'RugField', 0, 0, 0, bevel=0.004)
for i in range(5):
    for j in range(3):
        x, y = -RW/2 + 0.2 + i*(RW - 0.4)/4, -RD/2 + 0.2 + j*(RD - 0.4)/2
        if (i + j) % 2 == 0:
            p.cyl(0.13, 0.004, 'RugA', x, y, 0.012, segments=20)
            p.cyl(0.06, 0.004, 'RugField', x, y, 0.016, segments=16)
        else:
            p.hull([(x - 0.15, y, 0.012), (x + 0.15, y, 0.012), (x, y - 0.13, 0.012), (x, y + 0.13, 0.012),
                    (x - 0.15, y, 0.016), (x + 0.15, y, 0.016), (x, y - 0.13, 0.016), (x, y + 0.13, 0.016)], 'RugB')

# ------------------------------------------------------------------ the bookcase: open teak shelves on tapered legs, a cupboard at the bottom
p = piece('Bookcase')
BW, BD, BH = 1.0, 0.36, 1.8
legs(p, BW, BD, 0.18, inset=0.06, splay=0.03)
for x in (-BW/2 + 0.015, BW/2 - 0.015):
    p.box(0.03, BD, BH - 0.18, 'Teak', x, 0, 0.18, bevel=0.005)
p.box(BW, 0.015, BH - 0.18, 'Teak', 0, BD/2 - 0.008, 0.18, bevel=0)
p.box(BW - 0.03, BD, 0.5, 'Teak', 0, 0, 0.18, bevel=0.006)                    # the cupboard, its doors
for s in (-1, 1):
    p.box(BW/2 - 0.04, 0.012, 0.44, 'Teak' if s < 0 else 'Accent', s*(BW/4 - 0.005), -BD/2 - 0.004, 0.21, bevel=0.004)
    p.box(0.014, 0.014, 0.1, 'Brass', s*0.04, -BD/2 - 0.012, 0.38, bevel=0)
SHELVES = [0.68, 1.06, 1.44, BH - 0.025]
for z in SHELVES:
    p.box(BW - 0.03, BD - 0.02, 0.025, 'Teak', 0, 0.005, z, bevel=0.004)
for i, z in enumerate(SHELVES[:3]):
    z += 0.025
    if i == 0:
        x = books(p, -BW/2 + 0.04, 0.1, BD/2 - 0.03, z)
        vase(p, 0.3, 0, z, 0.26)
    elif i == 1:
        vase(p, -0.3, 0, z, 0.2, 'Ceramic2')
        p.ball(0.07, 'Brass', (-0.12, 0, z + 0.07))
        books(p, 0.05, BW/2 - 0.04, BD/2 - 0.03, z)
    else:
        books(p, -BW/2 + 0.04, -0.15, BD/2 - 0.03, z)
        for k in range(3):                                                    # records, leaning
            p.box(0.31, 0.006, 0.31, ('Print1', 'Print2', 'Print3')[k], 0.12 + k*0.012, 0.1 - k*0.03, z, bevel=0, rot=(0.25, 0, 0))
p.lathe([(0.05, 0), (0.08, 0.1), (0.06, 0.18)], 'Ceramic', 0.25, 0, BH, segments=12)     # a jug on top

# ------------------------------------------------------------------ a sputnik light (its top at the ceiling)
p = piece('Pendant')
PH = 0.9
p.cyl(0.06, 0.02, 'Brass', z0=PH - 0.02, segments=14)
p.cyl(0.01, PH - 0.3, 'Brass', z0=0.3, segments=8)
p.ball(0.07, 'Brass', (0, 0, 0.25), detail=2)
dirs = []
for k in range(14):                                                           # arms out every way (a Fibonacci sphere)
    zz = 1 - 2*(k + 0.5)/14
    r = math.sqrt(1 - zz*zz)
    a = k*2.39996
    dirs.append((math.cos(a)*r, math.sin(a)*r, zz*0.75))
for dx, dy, dz in dirs:
    end = (dx*0.4, dy*0.4, 0.25 + dz*0.4)
    p.bar((0, 0, 0.25), end, 0.01, 'Brass', bevel=0)
    p.ball(0.028, 'Light', end, scale=(1, 1, 1))

# ------------------------------------------------------------------ the drawers: a teak highboy on tapered legs
p = piece('Drawers')
DW, DD, DH = 0.9, 0.44, 0.95
legs(p, DW, DD, 0.2, inset=0.07, splay=0.03)
p.box(DW, DD, DH - 0.2, 'Teak', 0, 0, 0.2, bevel=0.01)
for k in range(4):
    z = 0.23 + k*0.175
    p.box(DW - 0.04, 0.012, 0.16, 'Teak', 0, -DD/2 - 0.004, z, bevel=0.004)
    p.box(0.3, 0.02, 0.018, 'Ply', 0, -DD/2 - 0.012, z + 0.14, bevel=0.004)     # a finger pull along the top of each
vase(p, -0.25, 0.02, DH, 0.34)
vase(p, -0.12, -0.04, DH, 0.2, 'Ceramic2')
p.ball(0.06, 'Accent', (0.25, 0.02, DH + 0.06), scale=(1, 1, 0.9))             # a ceramic bird, as it were
p.hull([(0.25, 0.0, DH + 0.08), (0.36, 0.02, DH + 0.12), (0.25, 0.04, DH + 0.08), (0.27, 0.02, DH + 0.1)], 'Accent')

# ------------------------------------------------------------------ the radiogram: a long, low teak cabinet with a record player in the lid
p = piece('Radiogram')
RW, RD, RH = 1.4, 0.44, 0.72
legs(p, RW, RD, 0.2, inset=0.1, splay=0.04)
p.box(RW, RD, RH - 0.2, 'Teak', 0, 0, 0.2, bevel=0.01)
p.box(0.66, 0.012, RH - 0.28, 'Grille', -RW/4, -RD/2 - 0.002, 0.24, bevel=0.004)    # the speaker's cloth
for k in range(5):
    p.box(0.01, 0.016, RH - 0.28, 'Teak', -RW/4 - 0.26 + k*0.13, -RD/2 - 0.006, 0.24, bevel=0)
for k in range(3):                                                             # knobs, and a tuning dial
    p.cyl(0.025, 0.02, 'Brass', RW/4 - 0.12 + k*0.12, -RD/2, 0.4, segments=12, rot=(math.pi/2, 0, 0))
p.box(0.4, 0.012, 0.07, 'Paper', RW/4, -RD/2 - 0.004, 0.5, bevel=0.003)
p.box(0.004, 0.016, 0.06, 'Label', RW/4 + 0.06, -RD/2 - 0.008, 0.505, bevel=0)
p.box(0.46, 0.34, 0.06, 'Black', RW/4, 0.0, RH, bevel=0.01)                    # the deck, a record on it
p.cyl(0.15, 0.008, 'Vinyl', RW/4 - 0.04, 0.0, RH + 0.06, segments=24)
p.cyl(0.05, 0.01, 'Label', RW/4 - 0.04, 0.0, RH + 0.06, segments=14)
p.bar((RW/4 + 0.18, 0.12, RH + 0.08), (RW/4 + 0.06, -0.08, RH + 0.075), 0.008, 'Chrome', bevel=0)
p.box(0.3, 0.3, 0.012, 'Print3', -RW/4, 0.0, RH, bevel=0.002, rot=(0, 0, 0.1))  # and a sleeve or two
p.box(0.3, 0.3, 0.012, 'Print2', -RW/4 + 0.03, 0.02, RH + 0.012, bevel=0.002, rot=(0, 0, -0.08))

# ------------------------------------------------------------------ a sunburst clock, to hang (facing -y)
p = piece('Sunburst')
p.cyl(0.1, 0.04, 'Brass', 0, 0, 0, segments=20, rot=(math.pi/2, 0, 0))
p.cyl(0.085, 0.006, 'Ceramic2', 0, -0.04, 0, segments=20, rot=(math.pi/2, 0, 0))
for k in range(24):
    a = k*2*math.pi/24
    r = 0.36 if k % 2 == 0 else 0.26
    p.bar((math.cos(a)*0.1, -0.02, math.sin(a)*0.1), (math.cos(a)*r, -0.02, math.sin(a)*r), 0.014, 'Brass', bevel=0)
    p.ball(0.018, 'Brass', (math.cos(a)*r, -0.02, math.sin(a)*r))
for k in range(12):                                                           # the hours, and hands
    a = k*math.pi/6
    p.box(0.006, 0.004, 0.012, 'Black', math.cos(a)*0.07, -0.045, math.sin(a)*0.07 - 0.006, bevel=0)
p.bar((0, -0.047, 0), (0.035, -0.047, 0.03), 0.006, 'Black', bevel=0)
p.bar((0, -0.049, 0), (-0.02, -0.049, -0.06), 0.004, 'Black', bevel=0)

# ------------------------------------------------------------------ an abstract print, in a thin frame (facing -y)
p = piece('Print')
w, h = 0.7, 0.9
p.box(w, 0.03, h, 'Teak', 0, 0.01, 0, bevel=0.006)
p.box(w - 0.04, 0.01, h - 0.04, 'Print0', 0, -0.005, 0.02, bevel=0)
p.box(0.28, 0.01, 0.4, 'Print2', -0.1, -0.009, 0.36, bevel=0)
p.cyl(0.14, 0.01, 'Print1', 0.1, -0.006, 0.6, segments=24, rot=(math.pi/2, 0, 0))
p.box(0.42, 0.01, 0.06, 'Print4', 0.02, -0.013, 0.28, bevel=0)
p.hull([(0.02, -0.012, 0.08), (0.28, -0.012, 0.08), (0.2, -0.012, 0.3), (0.02, -0.01, 0.08), (0.28, -0.01, 0.08)], 'Print3')

# ------------------------------------------------------------------ out
export(OUT)
