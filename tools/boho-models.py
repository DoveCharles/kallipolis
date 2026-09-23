# Builds assets/models/Boho.glb: the pieces a bohemian home is furnished from (see "a bohemian home" in
# src/buildings/interior.js), in the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/boho-models.py
#
# Most pieces stand in for Interior.glb's own, under the same names (Sofa, Chair, Table, TV, Lamp, Plant, Coffee Table,
# Rug, Bookcase, Pendant, Drawers), so a bohemian home is laid out as any other; the rest (more plants — Plant2, Plant3,
# HangingPlant and SillPlants — a PeacockChair, a Pouf, a Macrame wall hanging and a Tapestry) only a bohemian home has.
# Like Interior.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported) but for the TV, which faces +y as Interior.glb's does. Built in metres, life size, and scaled up at the end.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Boho.glb')
random.seed(23)

# (the ones interior.js recolours for each bohemian home are Linen, Cushion0-3, Throw, Wood, Painted, Pot, Pouf,
# RugField, RugA-C and Tapestry0-2; Light glows as it is)
material('Linen', 0xd8ccb4, 1.0)
material('Cushion0', 0xc8602a, 1.0)
material('Cushion1', 0xd8a030, 1.0)
material('Cushion2', 0x2a6a6a, 1.0)
material('Cushion3', 0x8a3a4a, 1.0)
material('Throw', 0xe8dcc0, 1.0)
material('Wood', 0x8a6242, 0.8)
material('Rattan', 0xc8a068, 0.9)
material('Cane', 0xd8bc88, 0.9)
material('Basket', 0xb89060, 1.0)
material('Painted', 0x3a7a7a, 0.7)
material('Pot', 0xc0643a, 0.9)
material('Terracotta', 0xb85a34, 0.95)
material('Ceramic', 0xece6d8, 0.4)
material('Pouf', 0xd8b890, 1.0)
material('Macrame', 0xf0e8d6, 1.0)
material('Brass', 0xc8a050, 0.3, 0.6)
material('Black', 0x1a1a1c, 0.5)
material('Candle', 0xf4efe2, 0.7)
material('Screen', 0xcccccc, 0.5)
material('TV', 0x141416, 0.4)
material('Light', 0x000000, 1.0, glow=0xffe8c0)
material('Dirt', 0x2a1a0e, 1.0)
material('Leaf', 0x2a6a30, 0.6)
material('Leaf2', 0x4a8a3a, 0.6)
material('Leaf3', 0x3a7a5a, 0.6)
material('Stem', 0x5a6a2a, 0.8)
material('Cactus', 0x4a7a4a, 0.8)
material('RugField', 0xb8482a, 1.0)
material('RugA', 0x2a3a5a, 1.0)
material('RugB', 0xe8d8b0, 1.0)
material('RugC', 0xd8a030, 1.0)
material('Tapestry0', 0xe8dcc0, 1.0)
material('Tapestry1', 0xc8602a, 1.0)
material('Tapestry2', 0x2a5a5a, 1.0)
for i, colour in enumerate((0x8a2a2a, 0x2a4a5a, 0xe8d8b0, 0x5a6a3a, 0xc8902a, 0x4a2a4a)):
    material('Book%d' % i, colour, 0.7)
BOOKS = ['Book%d' % i for i in range(6)]
LEAVES = ['Leaf', 'Leaf2', 'Leaf3']

# a leaf from `at` out along heading `a` (about z), rising or drooping by `lift`, `length` long and `width` wide
def leaf(p, at, a, length, width, lift=0.0, mat='Leaf'):
    x, y, z = at
    c, s = math.cos(a), math.sin(a)
    px, py = -s*width/2, c*width/2
    mid = (x + c*length*0.45, y + s*length*0.45, z + lift*0.6)
    tip = (x + c*length, y + s*length, z + lift)
    p.hull([(x, y, z), (mid[0] + px, mid[1] + py, mid[2]), (mid[0] - px, mid[1] - py, mid[2]), tip,
            (mid[0], mid[1], mid[2] + 0.012)], mat)

# a trailing strand, from `at` down (and out along `a`) `drop` metres, a leaf every few centimetres
def trail(p, at, a, drop, out=0.08):
    x, y, z = at
    n = max(3, int(drop/0.06))
    for k in range(n + 1):
        t = k/n
        px = x + math.cos(a)*out*math.sin(t*math.pi/2)
        py = y + math.sin(a)*out*math.sin(t*math.pi/2)
        pz = z - drop*t
        if k:
            p.bar(prev, (px, py, pz), 0.006, 'Stem', bevel=0)
        side = 1 if k % 2 else -1
        leaf(p, (px, py, pz), a + side*1.3 + random.uniform(-0.3, 0.3), 0.055, 0.04, -0.01, random.choice(('Leaf', 'Leaf2')))
        prev = (px, py, pz)

# a pot (`mat`), `r` across the top and `h` high, standing on z0 at (x, y), soil in it; returns the soil's height
def pot(p, x, y, z0, r, h, mat='Pot'):
    p.lathe([(r*0.72, 0), (r*0.8, h*0.08), (r, h*0.92), (r*1.06, h)], mat, x, y, z0, segments=14)
    p.cyl(r*0.95, 0.01, 'Dirt', x, y, z0 + h - 0.03, segments=12)
    return z0 + h - 0.02

# a woven basket, `r` across and `h` high, a band round it
def basket(p, x, y, z0, r, h):
    p.lathe([(r*0.85, 0), (r, h*0.3), (r*1.02, h)], 'Basket', x, y, z0, segments=16)
    p.cyl(r*1.02, 0.03, 'Wood', x, y, z0 + h*0.55, r2=r*1.025, segments=16)
    p.cyl(r*0.97, 0.01, 'Dirt', x, y, z0 + h - 0.03, segments=12)
    return z0 + h - 0.02

# a trailing plant in a pot on z0 at (x, y), its strands falling on the side `a` (or all round)
def pothos(p, x, y, z0, r=0.08, strands=5, drop=0.35, a=None, mat='Pot'):
    top = pot(p, x, y, z0, r, r*1.3, mat)
    for k in range(6):
        leaf(p, (x, y, top), k*1.05 + 0.3, 0.09, 0.07, 0.04, random.choice(LEAVES))
    for k in range(strands):
        ang = (a if a is not None else k*2*math.pi/strands) + random.uniform(-0.5, 0.5)
        trail(p, (x + math.cos(ang)*r, y + math.sin(ang)*r, top), ang, drop*random.uniform(0.6, 1.2))

# a succulent rosette on z0 at (x, y), in a little pot
def succulent(p, x, y, z0, r=0.06, mat='Terracotta'):
    top = pot(p, x, y, z0, r, r*1.1, mat)
    for k in range(9):
        a = k*2.4
        leaf(p, (x, y, top), a, r*1.1 - (k % 3)*0.01, r*0.6, 0.02 + (k % 3)*0.015, 'Leaf3')

# a cactus on z0 at (x, y), in a little pot
def cactus(p, x, y, z0, h=0.18):
    top = pot(p, x, y, z0, 0.055, 0.07, 'Terracotta')
    p.cyl(0.03, h, 'Cactus', x, y, top, r2=0.022, segments=8)
    p.cyl(0.015, 0.06, 'Cactus', x + 0.03, y, top + h*0.4, r2=0.012, segments=6, rot=(0, 0.5, 0))

def candle(p, x, y, z0, h=0.1, r=0.025):
    p.cyl(r, h, 'Candle', x, y, z0, segments=10)
    p.cyl(0.002, 0.012, 'Black', x, y, z0 + h, segments=4)

# a row of books stood up, their spines to -y, from x to x_end on z0 at y (their backs to +y); returns where they end
def books(p, x, x_end, y, z0):
    while x < x_end - 0.05:
        w, h, d = random.uniform(0.025, 0.045), random.uniform(0.18, 0.25), random.uniform(0.14, 0.18)
        p.box(w, d, h, random.choice(BOOKS), x + w/2, y - d/2, z0, bevel=0.003)
        x += w + 0.003
    return x

# a stack of books lying flat, on z0 at (x, y)
def stack(p, x, y, z0, n=3):
    for k in range(n):
        p.box(random.uniform(0.18, 0.24), random.uniform(0.14, 0.18), 0.03, random.choice(BOOKS), x, y, z0 + k*0.03,
              bevel=0.004, rot=(0, 0, random.uniform(-0.2, 0.2)))

# ------------------------------------------------------------------ the sofa: low and deep, in linen, heaped with cushions, a throw over one arm
p = piece('Sofa')
W, D = 2.2, 0.95
for x in (-W/2 + 0.08, W/2 - 0.08):
    for y in (-D/2 + 0.08, D/2 - 0.08):
        p.box(0.08, 0.08, 0.1, 'Wood', x, y, 0, bevel=0.01)
p.box(W, D, 0.14, 'Linen', 0, 0, 0.1, bevel=0.03, segments=2)
p.box(W - 0.3, D - 0.25, 0.16, 'Linen', 0, -0.1, 0.24, bevel=0.05, segments=2)    # one long seat cushion, top at 0.4
p.box(W - 0.06, 0.22, 0.46, 'Linen', 0, D/2 - 0.11, 0.24, bevel=0.07, segments=2)
for s in (-1, 1):
    p.box(0.18, D, 0.34, 'Linen', s*(W/2 - 0.09), 0, 0.2, bevel=0.07, segments=2)
for k, (x, rot, mat) in enumerate(((-0.78, 0.2, 'Cushion0'), (-0.52, -0.15, 'Cushion2'), (-0.1, 0.1, 'Cushion1'),
                                   (0.45, -0.2, 'Cushion3'), (0.72, 0.15, 'Cushion0'))):
    size = 0.42 if k % 2 == 0 else 0.36
    p.box(size, 0.13, size, mat, x, D/2 - 0.3 + (k % 2)*0.06, 0.38, bevel=0.05, segments=2, rot=(-0.3, rot, 0))
p.box(0.5, 0.16, 0.26, 'Cushion2', 0.2, D/2 - 0.3, 0.4, bevel=0.07, segments=2, rot=(-0.25, 0, 0))   # a bolster
p.box(0.34, 1.0, 0.02, 'Throw', W/2 - 0.12, -0.02, 0.56, bevel=0.008, rot=(0, 0.35, 0))              # a throw over the arm
p.box(0.3, 0.02, 0.36, 'Throw', W/2 + 0.02, -0.02, 0.24, bevel=0.008, rot=(0, 0, math.pi/2 - 0.1))
for k in range(8):                                                                                    # (its tassels)
    p.bar((W/2 + 0.04, -0.45 + k*0.13, 0.22), (W/2 + 0.05, -0.45 + k*0.13, 0.15), 0.01, 'Throw', bevel=0)

# ------------------------------------------------------------------ the peacock chair: a rattan fan of a back on an hourglass foot, a cushion in it
p = piece('PeacockChair')
p.lathe([(0.3, 0), (0.24, 0.08), (0.12, 0.22), (0.14, 0.3), (0.34, 0.4)], 'Rattan', segments=18)
p.cyl(0.36, 0.05, 'Rattan', z0=0.38, segments=20)
p.cyl(0.33, 0.08, 'Cushion0', z0=0.4, segments=18)                                              # (top at 0.48)
FAN = 12
for k in range(FAN + 1):                                                                         # the fan's ribs
    a = math.pi*(0.08 + 0.84*k/FAN)
    p.bar((math.cos(a)*0.3, 0.28, 0.42), (math.cos(a)*0.66, 0.36, 0.5 + math.sin(a)*1.0), 0.025, 'Rattan')
fan = []
for k in range(FAN + 1):
    a = math.pi*(0.08 + 0.84*k/FAN)
    fan += [(math.cos(a)*0.64, 0.37, 0.5 + math.sin(a)*0.98), (math.cos(a)*0.64, 0.4, 0.5 + math.sin(a)*0.98)]
fan += [(-0.3, 0.3, 0.42), (0.3, 0.3, 0.42), (-0.3, 0.33, 0.42), (0.3, 0.33, 0.42)]
p.hull(fan, 'Cane')
for r in (0.45, 0.75, 0.95):                                                                     # rings woven through it
    for k in range(FAN):
        a0, a1 = math.pi*(0.08 + 0.84*k/FAN), math.pi*(0.08 + 0.84*(k + 1)/FAN)
        p.bar((math.cos(a0)*r*0.66, 0.35, 0.5 + math.sin(a0)*r), (math.cos(a1)*r*0.66, 0.35, 0.5 + math.sin(a1)*r), 0.02, 'Rattan', bevel=0)
p.box(0.4, 0.14, 0.36, 'Cushion1', 0, 0.2, 0.46, bevel=0.06, segments=2, rot=(-0.25, 0, 0))

# ------------------------------------------------------------------ a pouf, knitted
p = piece('Pouf')
p.lathe([(0.24, 0), (0.29, 0.04), (0.3, 0.14), (0.29, 0.28), (0.24, 0.32), (0.0, 0.33)], 'Pouf', segments=20)
for k in range(10):
    a = k*math.pi/5
    p.bar((math.cos(a)*0.3, math.sin(a)*0.3, 0.06), (math.cos(a)*0.3, math.sin(a)*0.3, 0.26), 0.02, 'Pouf', bevel=0)

# ------------------------------------------------------------------ the dining chair: bentwood and cane
p = piece('Chair')
p.cyl(0.21, 0.04, 'Cane', 0, -0.02, 0.41, segments=18)                                          # (top at 0.45)
p.cyl(0.22, 0.03, 'Wood', 0, -0.02, 0.4, segments=18)
for k in range(4):
    a = k*math.pi/2 + math.pi/4
    p.bar((math.cos(a)*0.17, -0.02 + math.sin(a)*0.17, 0.41), (math.cos(a)*0.21, -0.02 + math.sin(a)*0.21, 0), 0.025, 'Wood')
p.cyl(0.19, 0.015, 'Wood', 0, -0.02, 0.17, segments=16)                                         # the ring between the legs
for k in range(12):                                                                              # the hoop of a back
    a0, a1 = math.pi*(0.1 + 0.8*k/12), math.pi*(0.1 + 0.8*(k + 1)/12)
    p.bar((math.cos(a0)*0.2, 0.08 + math.sin(a0)*0.12, 0.86), (math.cos(a1)*0.2, 0.08 + math.sin(a1)*0.12, 0.86), 0.022, 'Wood', bevel=0)
for s in (-1, 1):
    p.bar((s*0.19, 0.12, 0.45), (s*0.19, 0.1, 0.86), 0.022, 'Wood', bevel=0)
p.box(0.3, 0.015, 0.25, 'Cane', 0, 0.19, 0.55, bevel=0.004, rot=(-0.1, 0, 0))

# ------------------------------------------------------------------ the dining table: planks on trestles, a runner, candles and a plant
p = piece('Table')
TW, TD, TH = 1.5, 0.85, 0.75
for k in range(3):
    p.box(TW, TD/3 - 0.006, 0.045, 'Wood', 0, -TD/3 + k*TD/3, TH - 0.045, bevel=0.008)
for s in (-1, 1):
    for t in (-1, 1):
        p.bar((s*(TW/2 - 0.2), t*(TD/2 - 0.08), TH - 0.05), (s*(TW/2 - 0.2), -t*(TD/2 - 0.08), 0), 0.05, 'Wood')
p.bar((-TW/2 + 0.2, 0, 0.35), (TW/2 - 0.2, 0, 0.35), 0.05, 'Wood')
p.box(0.35, TD + 0.1, 0.004, 'Tapestry1', 0, 0, TH, bevel=0)
pothos(p, -0.35, 0.05, TH, 0.07, 3, 0.1)
for k, x in enumerate((0.15, 0.3, 0.42)):
    p.cyl(0.035, 0.05, 'Brass', x, 0.05*(k - 1), TH, r2=0.02, segments=10)
    candle(p, x, 0.05*(k - 1), TH + 0.05, 0.2 - k*0.04, 0.012)

# ------------------------------------------------------------------ the TV, on a low plank bench, baskets under it and a trailing plant (facing +y)
p = piece('TV')
BW, BD, BH = 1.6, 0.42, 0.45
p.box(BW, BD, 0.05, 'Wood', 0, 0, BH - 0.05, bevel=0.01)
for s in (-1, 1):
    p.box(0.06, BD, BH - 0.05, 'Wood', s*(BW/2 - 0.1), 0, 0, bevel=0.008)
p.box(BW - 0.2, BD - 0.04, 0.03, 'Wood', 0, 0, 0.12, bevel=0.006)
for x in (-0.35, 0.35):
    p.lathe([(0.15, 0), (0.17, 0.2), (0.175, 0.24)], 'Basket', x, 0, 0.15, segments=14)
p.box(0.34, 0.2, 0.015, 'TV', -0.05, 0, BH, bevel=0.005)
p.box(0.07, 0.04, 0.12, 'TV', -0.05, -0.03, BH + 0.015, bevel=0.005)
p.box(1.1, 0.05, 0.64, 'TV', -0.05, 0, BH + 0.08, bevel=0.01)
p.box(1.04, 0.006, 0.58, 'Screen', -0.05, 0.027, BH + 0.11, bevel=0.001)
pothos(p, 0.66, 0.02, BH, 0.09, 6, 0.45, math.pi/2)
candle(p, -0.66, 0.05, BH, 0.14, 0.035)
candle(p, -0.58, -0.05, BH, 0.09, 0.03)

# ------------------------------------------------------------------ the floor lamp: a rattan drum on a wooden pole
p = piece('Lamp')
p.cyl(0.16, 0.03, 'Wood', segments=16)
p.cyl(0.018, 1.35, 'Wood', z0=0.03, segments=8)
p.lathe([(0.2, 1.22), (0.23, 1.38), (0.2, 1.54)], 'Rattan', segments=18)
p.cyl(0.17, 0.006, 'Light', z0=1.24, segments=14)

# ------------------------------------------------------------------ the plants: a monstera in a basket, a snake plant in terracotta, a palm
p = piece('Plant')
top = basket(p, 0, 0, 0, 0.2, 0.34)
for k in range(9):
    a = k*2.39996
    h = top + 0.35 + (k % 4)*0.18
    tip = (math.cos(a)*(0.2 + (k % 3)*0.1), math.sin(a)*(0.2 + (k % 3)*0.1), h)
    p.bar((math.cos(a)*0.03, math.sin(a)*0.03, top), tip, 0.014, 'Stem', bevel=0)
    # (a big split leaf: two halves either side of its midrib)
    for side in (-1, 1):
        leaf(p, tip, a + side*0.5, 0.3, 0.2, -0.12, 'Leaf')
    leaf(p, tip, a, 0.34, 0.1, -0.16, 'Leaf')

p = piece('Plant2')
top = pot(p, 0, 0, 0, 0.16, 0.3, 'Terracotta')
for k in range(11):
    a = k*2.39996
    r = 0.03 + (k % 3)*0.035
    x, y, h = math.cos(a)*r, math.sin(a)*r, 0.45 + random.uniform(0, 0.4)
    c, s = -math.sin(a), math.cos(a)
    p.hull([(x - c*0.03, y - s*0.03, top), (x + c*0.03, y + s*0.03, top), (x - c*0.035, y - s*0.035, top + h*0.5),
            (x + c*0.035, y + s*0.035, top + h*0.5), (x + math.cos(a)*0.02, y + math.sin(a)*0.02, top + h),
            (x + math.cos(a)*0.012, y + math.sin(a)*0.012, top + h*0.5)], 'Leaf3' if k % 2 else 'Leaf')

p = piece('Plant3')
top = basket(p, 0, 0, 0, 0.18, 0.32)
for k in range(5):
    a = k*2*math.pi/5 + 0.3
    lean = 0.15 + (k % 2)*0.1
    base = (0, 0, top)
    crown = (math.cos(a)*lean, math.sin(a)*lean, top + 0.9 + (k % 3)*0.2)
    p.bar(base, crown, 0.018, 'Stem', bevel=0)
    # a frond arching out and over from the crown, its leaflets either side
    prev = crown
    for j in range(1, 8):
        t = j/7
        pt = (crown[0] + math.cos(a)*0.55*t, crown[1] + math.sin(a)*0.55*t, crown[2] + 0.15*t - 0.45*t*t)
        p.bar(prev, pt, 0.01, 'Stem', bevel=0)
        for side in (-1, 1):
            leaf(p, pt, a + side*1.1, 0.26*(1 - t*0.5), 0.035, -0.12, 'Leaf2')
        prev = pt

# ------------------------------------------------------------------ a plant hung from the ceiling in a macramé hanger, trailing (its top at the ceiling)
p = piece('HangingPlant')
HB = 0.75                                                                                        # (the pot's foot)
p.lathe([(0.1, HB), (0.14, HB + 0.15), (0.145, HB + 0.18)], 'Ceramic', segments=16)
p.cyl(0.14, 0.01, 'Dirt', z0=HB + 0.16, segments=12)
for k in range(4):                                                                               # the hanger's cords, knotted
    a = k*math.pi/2 + 0.4
    p.bar((math.cos(a)*0.14, math.sin(a)*0.14, HB + 0.1), (math.cos(a)*0.05, math.sin(a)*0.05, HB - 0.05), 0.008, 'Macrame', bevel=0)
    p.bar((math.cos(a)*0.14, math.sin(a)*0.14, HB + 0.1), (0, 0, HB + 1.0), 0.008, 'Macrame', bevel=0)
    p.ball(0.015, 'Macrame', (math.cos(a)*0.12, math.sin(a)*0.12, HB + 0.25))
p.ball(0.03, 'Macrame', (0, 0, HB - 0.06))
p.bar((0, 0, HB - 0.06), (0, 0, HB - 0.3), 0.01, 'Macrame', bevel=0)                               # the tassel
p.bar((0, 0, HB + 1.0), (0, 0, HB + 1.3), 0.008, 'Macrame', bevel=0)                               # up to the hook
for k in range(7):
    leaf(p, (0, 0, HB + 0.17), k*0.9, 0.12, 0.09, 0.06, random.choice(LEAVES))
for k in range(7):
    a = k*2*math.pi/7 + random.uniform(-0.2, 0.2)
    trail(p, (math.cos(a)*0.14, math.sin(a)*0.14, HB + 0.17), a, random.uniform(0.45, HB + 0.1), 0.1)

# ------------------------------------------------------------------ plants along a windowsill: a cactus, succulents, a trailing one
p = piece('SillPlants')
cactus(p, -0.36, 0, 0, 0.2)
succulent(p, -0.2, 0.02, 0)
pothos(p, 0.02, 0, 0, 0.07, 3, 0.12)
cactus(p, 0.2, -0.02, 0, 0.12)
succulent(p, 0.34, 0.0, 0, 0.07, 'Ceramic')

# ------------------------------------------------------------------ the coffee table: round and low, a tray of candles, books, a succulent
p = piece('Coffee Table')
CR, CH = 0.48, 0.38
p.cyl(CR, 0.045, 'Wood', z0=CH - 0.045, segments=28)
p.cyl(CR - 0.06, 0.03, 'Wood', z0=0.1, segments=24)
for k in range(4):
    a = k*math.pi/2 + math.pi/4
    p.box(0.05, 0.05, CH - 0.045, 'Wood', math.cos(a)*(CR - 0.1), math.sin(a)*(CR - 0.1), 0, bevel=0.008)
p.cyl(0.18, 0.015, 'Brass', 0.12, 0.05, CH, segments=18)
for k, (x, y, h) in enumerate(((0.06, 0.02, 0.12), (0.16, 0.1, 0.08), (0.18, -0.02, 0.05))):
    candle(p, x, y, CH + 0.015, h, 0.03)
stack(p, -0.2, -0.08, CH, 3)
succulent(p, -0.16, 0.2, CH, 0.07)
basket(p, 0, 0, 0.13, 0.14, 0.14)                                                              # (on the shelf under it)

# ------------------------------------------------------------------ the rug: a kilim, in bands of diamonds, fringed
p = piece('Rug')
RW, RD = 1.9, 1.25
p.box(RW, RD, 0.012, 'RugField', 0, 0, 0, bevel=0.004)
for y in (-RD/2 + 0.12, RD/2 - 0.12):
    p.box(RW - 0.1, 0.07, 0.004, 'RugA', 0, y, 0.012, bevel=0)
for j, y in enumerate((-0.3, 0, 0.3)):
    mat = 'RugA' if j != 1 else 'RugC'
    for i in range(7):
        x = -RW/2 + 0.2 + i*(RW - 0.4)/6
        p.hull([(x - 0.12, y, 0.012), (x + 0.12, y, 0.012), (x, y - 0.1, 0.012), (x, y + 0.1, 0.012),
                (x - 0.12, y, 0.016), (x + 0.12, y, 0.016), (x, y - 0.1, 0.016), (x, y + 0.1, 0.016)], mat)
        p.box(0.06, 0.06, 0.004, 'RugB', x, y, 0.016, bevel=0, rot=(0, 0, math.pi/4))
for s in (-1, 1):
    for k in range(24):
        x = s*(RW/2 + 0.04)
        y = -RD/2 + 0.05 + k*(RD - 0.1)/23
        p.box(0.08, 0.012, 0.005, 'RugB', x, y, 0, bevel=0)

# ------------------------------------------------------------------ the bookcase: a leaning ladder of shelves, more plants on it than books
p = piece('Bookcase')
LW, LD, LH = 0.9, 0.46, 1.85
for s in (-1, 1):
    p.bar((s*LW/2, -LD/2, 0), (s*LW/2, LD/2 - 0.04, LH), 0.04, 'Wood')
    p.bar((s*LW/2, LD/2 - 0.02, 0), (s*LW/2, LD/2 - 0.02, LH), 0.035, 'Wood')
SH = [0.3, 0.72, 1.12, 1.5]
for z in SH:
    front = -LD/2 + (LD - 0.04)*z/LH
    d = LD/2 - 0.02 - front
    p.box(LW - 0.02, d, 0.025, 'Wood', 0, front + d/2, z, bevel=0.004)
z = SH[0] + 0.025
basket(p, -0.2, 0.06, z, 0.13, 0.2)
pothos(p, 0.2, 0.06, z, 0.1, 5, 0.3, -math.pi/2)
z = SH[1] + 0.025
books(p, -0.4, 0.0, LD/2 - 0.03, z)
succulent(p, 0.18, 0.1, z, 0.07)
cactus(p, 0.33, 0.12, z, 0.16)
z = SH[2] + 0.025
pothos(p, -0.2, 0.12, z, 0.08, 5, 0.35, -math.pi/2)
candle(p, 0.1, 0.14, z, 0.12, 0.03)
stack(p, 0.28, 0.14, z, 2)
z = SH[3] + 0.025
pothos(p, 0.12, 0.16, z, 0.07, 4, 0.3, -math.pi/2)
succulent(p, -0.22, 0.16, z, 0.06)

# ------------------------------------------------------------------ a woven rattan dome of a light (its top at the ceiling)
p = piece('Pendant')
PH = 0.85
p.cyl(0.05, 0.02, 'Wood', z0=PH - 0.02, segments=12)
p.cyl(0.006, PH - 0.3, 'Black', z0=0.28, segments=6)
p.lathe([(0.34, 0), (0.33, 0.06), (0.26, 0.18), (0.12, 0.27), (0.04, 0.3)], 'Rattan', segments=22)
p.cyl(0.24, 0.006, 'Light', z0=0.06, segments=18)

# ------------------------------------------------------------------ the drawers: a painted chest, plants and candles on it
p = piece('Drawers')
DW, DD, DH = 0.95, 0.45, 0.82
for x in (-DW/2 + 0.05, DW/2 - 0.05):
    for y in (-DD/2 + 0.05, DD/2 - 0.05):
        p.cyl(0.03, 0.08, 'Wood', x, y, 0, r2=0.025, segments=8)
p.box(DW, DD, DH - 0.08, 'Painted', 0, 0, 0.08, bevel=0.012)
p.box(DW + 0.03, DD + 0.02, 0.03, 'Wood', 0, 0, DH - 0.03, bevel=0.008)
for k in range(3):
    z = 0.12 + k*0.22
    p.box(DW - 0.08, 0.012, 0.19, 'Painted', 0, -DD/2 - 0.004, z, bevel=0.004)
    for s in (-1, 1):
        p.cyl(0.018, 0.02, 'Brass', s*0.22, -DD/2 - 0.01, z + 0.095, segments=8, rot=(math.pi/2, 0, 0))
pothos(p, 0.28, -0.02, DH, 0.1, 6, 0.5, -math.pi/2)
candle(p, -0.3, 0.05, DH, 0.2, 0.04)
candle(p, -0.2, -0.05, DH, 0.12, 0.035)
p.box(0.3, 0.02, 0.38, 'Wood', -0.05, 0.16, DH, bevel=0.006, rot=(-0.2, 0, 0))                    # a picture, leant
p.box(0.24, 0.01, 0.3, 'Tapestry2', -0.05, 0.14, DH + 0.04, bevel=0, rot=(-0.2, 0, 0))

# ------------------------------------------------------------------ a macramé wall hanging on a driftwood dowel (facing -y)
p = piece('Macrame')
MW = 0.6
p.bar((-MW/2 - 0.08, 0, 0.9), (MW/2 + 0.08, 0.005, 0.9), 0.03, 'Wood')
CORDS = 12
for k in range(CORDS):
    x = -MW/2 + 0.02 + k*(MW - 0.04)/(CORDS - 1)
    # (down, drawn in to a V of knots, and out into a fringe)
    v = 0.55 - 0.35*abs(x)/(MW/2)
    p.bar((x, -0.01, 0.9), (x*0.9, -0.01, v), 0.01, 'Macrame', bevel=0)
    p.ball(0.02, 'Macrame', (x*0.9, -0.012, v))
    p.bar((x*0.9, -0.01, v), (x*0.8, -0.01, 0.0 + 0.2*abs(x)/(MW/2)), 0.01, 'Macrame', bevel=0)
for row in range(3):
    for k in range(CORDS//2 - row):
        x = -MW/2 + 0.08 + row*0.05 + k*(MW - 0.16 - row*0.1)/max(1, CORDS//2 - row - 1)
        p.ball(0.022, 'Macrame', (x*0.9, -0.015, 0.8 - row*0.07), scale=(1.3, 1, 1))

# ------------------------------------------------------------------ a woven tapestry, hung from a dowel (facing -y)
p = piece('Tapestry')
TW, THH = 0.85, 1.1
p.bar((-TW/2 - 0.06, 0.005, THH), (TW/2 + 0.06, 0.005, THH), 0.025, 'Wood')
p.box(TW, 0.01, THH - 0.12, 'Tapestry0', 0, -0.005, 0.1, bevel=0)
for k, (z, mat) in enumerate(((0.9, 'Tapestry1'), (0.75, 'Tapestry2'), (0.62, 'Tapestry1'))):
    p.box(TW, 0.012, 0.05 + (k == 1)*0.04, mat, 0, -0.008, z, bevel=0)
p.hull([(-0.25, -0.01, 0.18), (0.25, -0.01, 0.18), (0, -0.01, 0.52), (-0.25, -0.014, 0.18), (0.25, -0.014, 0.18),
        (0, -0.014, 0.52)], 'Tapestry2')                                                          # a mountain
p.cyl(0.08, 0.006, 'Tapestry1', 0.22, -0.012, 0.44, segments=16, rot=(math.pi/2, 0, 0))           # and a sun
for k in range(16):
    x = -TW/2 + 0.03 + k*(TW - 0.06)/15
    p.bar((x, -0.005, 0.11), (x, -0.005, 0.0), 0.012, 'Tapestry0', bevel=0)

# ------------------------------------------------------------------ out
export(OUT)
