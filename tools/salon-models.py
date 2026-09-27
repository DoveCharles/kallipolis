# Builds assets/models/Salon.glb: the pieces a hair salon is fitted out from (see "a hair salon" in
# src/buildings/interior.js), a 1990s high-street one — chrome and vinyl, mirrors, hood dryers, a fish tank, posters of
# big hair — in the same low-poly, flat-coloured style as Pub.glb's.
#
#   blender -b --python tools/salon-models.py      (or, with the bpy module installed: python3 tools/salon-models.py)
#
# Where the hair's done: a StylingStation (a shelf with a mirror over it, against a wall) with a StylingChair (chrome,
# on a pump-up column) in front of it, facing it. Where it's washed: a Basin, a backwash sink with its reclined chair.
# Where it's dried: a DryerChair, an armchair under a hood dryer on a stand. Waiting: a WaitingBench in black vinyl and
# a MagazineTable. And: the Reception desk, a Trolley of rollers and brushes, ProductShelves, a FishTank on its stand, a
# Plant, Posters (Poster, Poster2) and a Clock for the walls, and a Tube light for the ceiling.
# Like Pub.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported). Built in metres, life size, and scaled up at the end. Wall-hung pieces (Poster, Poster2, Clock) stand on
# their own bottom edge; interior.js lifts them up the wall.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Salon.glb')
random.seed(1990)

# (the ones interior.js recolours for each salon are Vinyl, Laminate and Accent; Light and the Glow ones glow as they are)
material('Vinyl', 0x1a1a1c, 0.35)
material('Laminate', 0xf0eee8, 0.3)
material('Accent', 0x8ec8d8, 0.4)
material('Chrome', 0xd0d4d8, 0.2, 0.85)
material('Black', 0x141416, 0.5)
material('White', 0xf2f0ea, 0.6)
material('Mirror', 0xd4e2ea, 0.15, 0.3)
material('Hood', 0xece6d8, 0.3)
material('HoodGlass', 0x6a7a80, 0.1, 0.5)
material('Sink', 0x1e1e20, 0.2)
material('Wood', 0x8a6040, 0.6)
material('Pot', 0xe8e2d4, 0.5)
material('Leaf', 0x2e6a32, 0.7)
material('Leaf2', 0x3e8a3a, 0.7)
material('Soil', 0x3a2a1c, 1.0)
material('Paper', 0xf4f0e4, 0.9)
material('Skin', 0xe0b494, 0.7)
material('Hair1', 0x2a1a14, 0.8)
material('Hair2', 0xa8441e, 0.8)
material('Lips', 0xa82a3a, 0.5)
material('Back1', 0x8a8aa8, 0.8)
material('Back2', 0x5a5a6a, 0.8)
material('Towel', 0xf4f2ec, 1.0)
material('Towel2', 0x8ec8d8, 1.0)
material('Gravel', 0xc8b48a, 1.0)
material('Fish', 0xf07a20, 0.4)
material('Light', 0x000000, 1.0, glow=0xf4f8ff)
material('GlowTank', 0x2a5a6a, 0.1, glow=0x6ab0c0)
material('GlowTill', 0x1a2a1a, 0.3, glow=0x7ac87a)
for i, colour in enumerate((0xe8407a, 0x40a8e0, 0xf0d040, 0x60c060, 0xe8e8e8, 0x9a40c0, 0xf08030, 0x202020)):
    material('Bottle%d' % i, colour, 0.25)
BOTTLES = ['Bottle%d' % i for i in range(8)]

# ------------------------------------------------------------------ building blocks
# a salon product: a squat tub, a tall bottle or a spray can, standing on z0 at (x, y)
def product(p, x, y, z0, kind=None):
    kind = kind or random.choice(('bottle', 'bottle', 'can', 'tub'))
    mat = random.choice(BOTTLES)
    if kind == 'bottle':
        h = random.uniform(0.14, 0.22)
        p.lathe([(0.03, 0), (0.032, h*0.75), (0.014, h*0.85), (0.012, h)], mat, x, y, z0, segments=8)
        p.cyl(0.014, 0.02, 'Black', x, y, z0 + h, segments=6)
    elif kind == 'can':
        p.cyl(0.028, 0.2, mat, x, y, z0, segments=10)
        p.cyl(0.02, 0.03, 'White', x, y, z0 + 0.2, segments=8)
    else:
        p.cyl(0.045, 0.07, mat, x, y, z0, segments=10)
        p.cyl(0.047, 0.015, 'White', x, y, z0 + 0.07, segments=10)

# a hand-held hairdryer lying on z0 at (x, y), its nozzle along x
def hairdryer(p, x, y, z0):
    p.cyl(0.04, 0.2, 'Black', x - 0.1, y, z0 + 0.04, segments=10, rot=(0, math.pi/2, 0))
    p.cyl(0.03, 0.05, 'Black', x + 0.1, y, z0 + 0.04, segments=10, rot=(0, math.pi/2, 0))
    p.box(0.04, 0.035, 0.03, 'Black', x - 0.02, y + 0.08, z0, bevel=0.01)
    p.box(0.035, 0.12, 0.03, 'Black', x - 0.02, y + 0.05, z0 + 0.01, bevel=0.01, rot=(0.3, 0, 0))

# a round brush lying on z0 at (x, y)
def brush(p, x, y, z0, turn=0.0):
    c, s = math.cos(turn), math.sin(turn)
    p.cyl(0.012, 0.14, 'Black', x - c*0.07, y - s*0.07, z0 + 0.02, segments=6, rot=(0, math.pi/2, turn))
    p.cyl(0.025, 0.1, 'White', x + c*0.05, y + s*0.05, z0 + 0.025, segments=8, rot=(0, math.pi/2, turn))

# a chrome arm pad: a slatted chrome rest from (x, y0) to (x, y1) at height z
def chrome_arm(p, x, y0, y1, z):
    p.box(0.06, y1 - y0, 0.03, 'Vinyl', x, (y0 + y1)/2, z, bevel=0.012)
    for k in range(4):
        y = y0 + (k + 0.5)*(y1 - y0)/4
        p.bar((x, y, z - 0.01), (x, y, z - 0.16), 0.012, 'Chrome')
    p.bar((x, y0 + 0.03, z - 0.16), (x, y1 - 0.03, z - 0.16), 0.02, 'Chrome')

# a potted plant's leaves: a spray of flat leaves round a point
def leaves(p, x, y, z, n=10, reach=0.35, size=0.16):
    for k in range(n):
        a = k*2.4 + random.uniform(-0.3, 0.3)
        lean = random.uniform(0.4, 1.1)
        ex, ey = x + math.cos(a)*reach*lean, y + math.sin(a)*reach*lean
        ez = z + random.uniform(0.15, 0.55)
        p.bar((x, y, z), (ex, ey, ez), 0.012, 'Leaf')
        p.hull([(-size, -size*0.6, 0), (size, -size*0.6, 0), (size*0.3, size*0.8, 0), (-size*0.3, size*0.8, 0),
                (0, 0, 0.015)], random.choice(('Leaf', 'Leaf2')), at=(ex, ey, ez), rot=(random.uniform(-0.5, 0.5), random.uniform(-0.5, 0.5), a))

# ------------------------------------------------------------------ where the hair's done
# a styling station: a white laminate shelf on a black cabinet, a tall mirror over it in a chrome frame, the tools of the
# trade laid out on it
SW, SD = 1.0, 0.42
p = piece('StylingStation')
p.box(SW - 0.1, SD - 0.08, 0.72, 'Black', 0, 0.04, 0, bevel=0.01)                  # cabinet
p.box(SW, SD, 0.05, 'Laminate', 0, 0, 0.72, bevel=0.012)                           # shelf
p.box(SW, 0.03, 0.08, 'Accent', 0, -SD/2 + 0.015, 0.7, bevel=0.006)                # its coloured edge
p.box(SW - 0.04, 0.04, 1.3, 'Chrome', 0, SD/2 - 0.02, 0.77, bevel=0.008)            # mirror frame
p.box(SW - 0.12, 0.02, 1.22, 'Mirror', 0, SD/2 - 0.045, 0.81, bevel=0.002)
p.box(SW, 0.05, 0.05, 'Chrome', 0, SD/2 - 0.025, 2.07, bevel=0.01)                 # a light bar over it
for k in range(4):
    p.ball(0.03, 'Light', (-0.36 + k*0.24, SD/2 - 0.06, 2.06))
for k in range(4):
    product(p, 0.2 + k*0.08, 0.1, 0.77)
hairdryer(p, -0.2, -0.05, 0.77)
brush(p, 0.05, -0.08, 0.77, 0.4)
p.box(0.16, 0.05, 0.01, 'Black', -0.36, 0.08, 0.77, bevel=0.002)                   # a comb

# a styling chair: a round chrome base, a pump-up column, a vinyl seat and back and slatted chrome arms
CH = 0.55
p = piece('StylingChair')
p.cyl(0.3, 0.03, 'Chrome', z0=0, r2=0.28, segments=18)
p.cyl(0.05, 0.1, 'Black', z0=0.03, segments=10)
p.cyl(0.04, CH - 0.2, 'Chrome', z0=0.12, segments=10)
p.bar((0.05, -0.05, 0.14), (0.25, -0.2, 0.12), 0.02, 'Chrome')                      # the pump pedal
p.box(0.08, 0.05, 0.01, 'Black', 0.26, -0.21, 0.12, bevel=0.005)
p.box(0.48, 0.46, 0.08, 'Chrome', 0, 0, CH - 0.14, bevel=0.01)
p.box(0.48, 0.48, 0.1, 'Vinyl', 0, -0.01, CH - 0.1, bevel=0.035, segments=2)
p.box(0.46, 0.1, 0.52, 'Vinyl', 0, 0.22, CH - 0.04, bevel=0.04, segments=2, rot=(-0.12, 0, 0))
for k in range(5):                                                                  # chrome slats on the back of the back
    p.box(0.44, 0.02, 0.02, 'Chrome', 0, 0.28, CH + 0.02 + k*0.09, bevel=0.004)
for x in (-0.27, 0.27):
    chrome_arm(p, x, -0.2, 0.18, CH + 0.18)
p.box(0.22, 0.08, 0.1, 'Vinyl', 0, 0.28, CH + 0.5, bevel=0.03)                      # a headrest
p.cyl(0.015, 0.1, 'Chrome', 0, 0.27, CH + 0.42, segments=6)
p.box(0.4, 0.12, 0.04, 'Chrome', 0, -0.3, 0.2, bevel=0.01)                         # a foot rest

# ------------------------------------------------------------------ where it's washed
# a backwash basin: a cabinet with a black sink tipped towards the chair in front of it, the chair reclined
p = piece('Basin')
p.box(0.7, 0.5, 0.82, 'Laminate', 0, 0.22, 0, bevel=0.01)
p.box(0.72, 0.52, 0.04, 'Accent', 0, 0.22, 0.82, bevel=0.01)
p.hull([(-0.26, -0.22, 0), (0.26, -0.22, 0), (0.26, 0.2, 0.04), (-0.26, 0.2, 0.04),
        (-0.2, -0.16, -0.14), (0.2, -0.16, -0.14), (0.2, 0.14, -0.12), (-0.2, 0.14, -0.12)], 'Sink', at=(0, 0.1, 0.9))
p.box(0.1, 0.08, 0.04, 'Sink', 0, -0.13, 0.84, bevel=0.01)                          # the neck rest
p.cyl(0.015, 0.2, 'Chrome', 0.1, 0.34, 0.9, segments=6)                             # taps and hose
p.bar((0.1, 0.34, 1.1), (0.1, 0.24, 1.12), 0.02, 'Chrome')
p.cyl(0.018, 0.08, 'Chrome', -0.12, 0.36, 0.9, segments=6)
p.cyl(0.018, 0.08, 'Chrome', -0.2, 0.36, 0.9, segments=6)
product(p, 0.26, 0.36, 0.86, 'bottle'); product(p, -0.28, 0.38, 0.86, 'bottle')
# the chair, reclined, facing away from the basin
p.box(0.5, 0.5, 0.4, 'Black', 0, -0.4, 0, bevel=0.01)
p.box(0.54, 0.6, 0.1, 'Vinyl', 0, -0.45, 0.4, bevel=0.035, segments=2)
p.box(0.54, 0.12, 0.6, 'Vinyl', 0, -0.13, 0.42, bevel=0.04, segments=2, rot=(-0.45, 0, 0))
for x in (-0.3, 0.3):
    p.box(0.08, 0.5, 0.2, 'Vinyl', x, -0.42, 0.45, bevel=0.03)
p.box(0.5, 0.35, 0.08, 'Vinyl', 0, -0.85, 0.22, bevel=0.03, rot=(0.25, 0, 0))       # its leg rest
p.box(0.4, 0.3, 0.05, 'Towel', 0, 0.2, 0.86, bevel=0.02)                            # a folded towel
p.box(0.4, 0.3, 0.05, 'Towel2', 0, 0.2, 0.91, bevel=0.02)

# ------------------------------------------------------------------ where it's dried
# a dryer chair: a vinyl armchair, and behind it a hood dryer on a chrome stand, the hood over the sitter's head
DS = 0.45
p = piece('DryerChair')
p.box(0.6, 0.55, DS - 0.12, 'Black', 0, 0, 0, bevel=0.01)
p.box(0.6, 0.58, 0.12, 'Vinyl', 0, -0.02, DS - 0.12, bevel=0.04, segments=2)
p.box(0.6, 0.14, 0.5, 'Vinyl', 0, 0.24, DS - 0.05, bevel=0.05, segments=2, rot=(-0.1, 0, 0))
for x in (-0.3, 0.3):
    p.box(0.1, 0.55, 0.26, 'Vinyl', x, 0, DS - 0.02, bevel=0.04, segments=2)
# the stand, rising behind the chair and arching over
p.cyl(0.22, 0.03, 'Chrome', 0, 0.48, 0, r2=0.2, segments=14)
p.cyl(0.028, 1.2, 'Chrome', 0, 0.48, 0.03, segments=10)
p.bar((0, 0.48, 1.22), (0, 0.3, 1.4), 0.04, 'Chrome')
# the hood: a dome tipped forward over the seat, with a smoked visor and a dial
hood = (0, 0.08, 1.25)
p.ball(0.3, 'Hood', hood, scale=(1, 1.05, 0.95), rot=(-0.5, 0, 0), detail=2)
p.ball(0.26, 'HoodGlass', (0, 0.0, 1.18), scale=(1.02, 0.6, 0.7), rot=(-0.5, 0, 0), detail=2)
p.cyl(0.05, 0.04, 'Chrome', 0, 0.34, 1.45, segments=10, rot=(-1.0, 0, 0))
p.cyl(0.035, 0.02, 'Black', 0, 0.36, 1.48, segments=8, rot=(-1.0, 0, 0))

# ------------------------------------------------------------------ waiting
# a waiting bench: three seats in black vinyl, buttoned, on a chrome frame
WL, WS = 1.7, 0.44
p = piece('WaitingBench')
for x in (-WL/2 + 0.1, WL/2 - 0.1):
    p.box(0.04, 0.5, 0.04, 'Chrome', x, 0, 0, bevel=0.01)
    p.bar((x, -0.22, 0.02), (x, -0.2, WS - 0.1), 0.03, 'Chrome')
    p.bar((x, 0.22, 0.02), (x, 0.24, 0.8), 0.03, 'Chrome')
p.box(WL, 0.5, 0.06, 'Chrome', 0, 0, WS - 0.14, bevel=0.01)
for i in range(3):
    x = -WL/2 + (i + 0.5)*WL/3
    p.box(WL/3 - 0.03, 0.52, 0.1, 'Vinyl', x, -0.01, WS - 0.1, bevel=0.035, segments=2)
    p.box(WL/3 - 0.03, 0.1, 0.44, 'Vinyl', x, 0.24, WS - 0.02, bevel=0.04, segments=2, rot=(-0.1, 0, 0))
    for j in range(2):
        p.ball(0.012, 'Black', (x - 0.1 + j*0.2, 0.18, WS + 0.22))

# a low table with magazines
p = piece('MagazineTable')
p.box(0.8, 0.5, 0.03, 'Laminate', 0, 0, 0.4, bevel=0.008)
p.box(0.82, 0.52, 0.02, 'Accent', 0, 0, 0.39, bevel=0.004)
for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
    p.cyl(0.018, 0.39, 'Chrome', sx*0.36, sy*0.21, 0, segments=8)
for k in range(4):
    p.box(0.21, 0.28, 0.012, random.choice(BOTTLES), -0.2 + k*0.13 + random.uniform(-0.03, 0.03), random.uniform(-0.08, 0.08), 0.43 + k*0.012,
          bevel=0.002, rot=(0, 0, random.uniform(-0.5, 0.5)))

# ------------------------------------------------------------------ the rest
# the reception desk: a curved front in the accent colour, a white top, a till, the appointment book and a phone
p = piece('Reception')
RW = 1.5
front = [(-RW/2 + RW*k/10, -0.3 - 0.12*math.sin(math.pi*k/10)) for k in range(11)]
p.prism(front + [(RW/2, 0.3), (-RW/2, 0.3)], 1.0, 'Accent')
p.prism([(x, y - 0.03) for x, y in front] + [(RW/2 + 0.03, 0.33), (-RW/2 - 0.03, 0.33)], 0.04, 'Laminate', z0=1.0)
p.box(RW - 0.1, 0.3, 0.04, 'Laminate', 0, 0.2, 0.74, bevel=0.01)                  # the lower desk behind
p.box(0.3, 0.25, 0.14, 'Black', 0.4, 0.12, 1.04, bevel=0.02)                       # till
p.box(0.26, 0.02, 0.1, 'GlowTill', 0.4, -0.01, 1.1, bevel=0.004, rot=(0.4, 0, 0))
p.box(0.3, 0.22, 0.03, 'Paper', -0.15, 0.0, 1.04, bevel=0.004)                     # appointment book
p.box(0.01, 0.2, 0.035, 'Back2', -0.15, 0.0, 1.04, bevel=0.002)
p.box(0.18, 0.2, 0.06, 'White', -0.5, 0.1, 1.04, bevel=0.02)                       # phone
p.box(0.2, 0.06, 0.04, 'White', -0.5, 0.1, 1.1, bevel=0.02)
for k in range(3):
    product(p, 0.1 + k*0.08, 0.2, 1.04)

# a trolley: three chrome-rimmed trays on castors, of rollers, clips and brushes
p = piece('Trolley')
for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
    p.cyl(0.012, 0.85, 'Chrome', sx*0.18, sy*0.14, 0.05, segments=6)
    p.ball(0.03, 'Black', (sx*0.18, sy*0.14, 0.03))
for z in (0.25, 0.55, 0.85):
    p.box(0.42, 0.34, 0.03, 'Accent', 0, 0, z, bevel=0.008)
for k in range(12):                                                                 # rollers
    p.cyl(0.02, 0.06, random.choice(('Bottle0', 'Bottle1', 'Bottle2', 'Bottle3')), -0.15 + (k % 6)*0.06, -0.06 + (k//6)*0.1, 0.88,
          segments=8, rot=(math.pi/2, 0, 0))
brush(p, 0, 0.08, 0.58, 0.2)
product(p, 0.12, -0.05, 0.58, 'can')
p.box(0.3, 0.25, 0.05, 'Towel', 0, 0, 0.28, bevel=0.02)

# shelves of products for sale, against a wall
p = piece('ProductShelves')
PW, PH = 1.2, 1.8
p.box(PW, 0.3, 0.1, 'Black', 0, 0, 0, bevel=0.008)
p.box(PW, 0.02, PH, 'Laminate', 0, 0.14, 0, bevel=0.004)
for x in (-PW/2 + 0.02, PW/2 - 0.02):
    p.box(0.03, 0.3, PH, 'Chrome', x, 0, 0, bevel=0.006)
for z in (0.1, 0.55, 1.0, 1.45):
    p.box(PW - 0.04, 0.3, 0.02, 'Mirror' if z > 0.2 else 'Laminate', 0, 0, z, bevel=0.004)
    for k in range(9):
        product(p, -PW/2 + 0.1 + k*(PW - 0.2)/8, random.uniform(-0.05, 0.05), z + 0.02)

# a fish tank on its black stand, lit from above
p = piece('FishTank')
TW, TD = 1.1, 0.4
p.box(TW, TD, 0.7, 'Black', 0, 0, 0, bevel=0.01)
p.box(TW, TD, 0.03, 'Black', 0, 0, 0.7, bevel=0.005)
p.box(TW - 0.04, 0.03, 0.46, 'GlowTank', 0, TD/2 - 0.035, 0.73, bevel=0.002)               # the lit water, seen against its back
for x in (-TW/2 + 0.03, TW/2 - 0.03):
    p.box(0.02, TD - 0.04, 0.46, 'GlowTank', x, 0, 0.73, bevel=0.002)
p.box(TW - 0.06, TD - 0.06, 0.06, 'Gravel', 0, 0, 0.73, bevel=0.01)
p.box(TW, TD, 0.06, 'Black', 0, 0, 1.19, bevel=0.005)
for k in range(6):
    x, y, z = random.uniform(-0.4, 0.4), random.uniform(-0.1, 0.1), random.uniform(0.85, 1.1)
    p.ball(0.03, 'Fish', (x, y, z), scale=(1.6, 0.5, 0.9))
    p.hull([(0, 0, 0), (0.05, -0.01, 0.03), (0.05, 0.01, -0.03)], 'Fish', at=(x + (0.04 if k % 2 else -0.04), y, z), rot=(0, 0, 0 if k % 2 else math.pi))
for k in range(3):
    p.bar((-0.4 + k*0.35, 0.05, 0.78), (-0.42 + k*0.35, 0.06, 1.05), 0.015, 'Leaf2')
leaves(p, 0.3, -0.05, 1.25, n=6, reach=0.25, size=0.08)                              # a trailing plant on the lid

# a big potted plant: a cheese plant in a white pot
p = piece('Plant')
p.lathe([(0.16, 0), (0.2, 0.36), (0.21, 0.4)], 'Pot', segments=12)
p.cyl(0.19, 0.02, 'Soil', z0=0.36, segments=12)
p.bar((0, 0, 0.36), (0.02, 0.01, 1.0), 0.02, 'Leaf')
leaves(p, 0, 0, 0.6, n=12, reach=0.4, size=0.17)
leaves(p, 0.02, 0.01, 1.0, n=6, reach=0.3, size=0.14)

# posters of big hair, in thin chrome frames: a face in three-quarter view under a cloud of hair
def poster(name, hair, back):
    p = piece(name)
    W, H = 0.55, 0.75
    p.box(W, 0.02, H, 'Chrome', 0, 0, 0, bevel=0.003)
    p.box(W - 0.03, 0.022, H - 0.03, back, 0, -0.001, 0.015, bevel=0.001)
    p.ball(0.2, hair, (0, -0.012, 0.44), scale=(1.1, 0.05, 1.0), detail=2)          # the hair
    p.ball(0.11, 'Skin', (0.02, -0.018, 0.36), scale=(0.85, 0.05, 1.15), detail=2)   # the face
    p.box(0.16, 0.01, 0.2, 'Skin', 0.02, -0.014, 0.1, bevel=0.002)                   # the neck
    p.box(0.44, 0.012, 0.12, 'Black', 0, -0.014, 0.02, bevel=0.002)                  # shoulders
    p.box(0.05, 0.01, 0.015, 'Lips', 0.03, -0.024, 0.29, bevel=0.002)
    for x in (-0.015, 0.06):
        p.box(0.03, 0.01, 0.012, 'Black', x, -0.024, 0.38, bevel=0.002)
    p.ball(0.12, hair, (-0.08, -0.02, 0.42), scale=(0.6, 0.05, 1.2), detail=1)        # a fringe falling over one side
poster('Poster', 'Hair1', 'Back1')
poster('Poster2', 'Hair2', 'Back2')

# a round wall clock
p = piece('Clock')
p.cyl(0.16, 0.05, 'Black', 0, 0, 0.16, segments=20, rot=(math.pi/2, 0, 0))
p.cyl(0.14, 0.052, 'White', 0, -0.001, 0.16, segments=20, rot=(math.pi/2, 0, 0))
p.box(0.012, 0.01, 0.1, 'Black', 0, -0.058, 0.2, bevel=0.002)
p.box(0.08, 0.01, 0.012, 'Black', 0.035, -0.058, 0.16, bevel=0.002)
for k in range(12):
    a = k*math.pi/6
    p.box(0.01, 0.01, 0.02, 'Black', math.sin(a)*0.12, -0.058, 0.16 + math.cos(a)*0.12, bevel=0.001, rot=(0, a, 0))

# a fluorescent tube in its fitting, to hang flat against the ceiling (its top at z 0.08)
p = piece('Tube')
p.box(1.3, 0.14, 0.05, 'White', 0, 0, 0.03, bevel=0.01)
p.cyl(0.025, 1.2, 'Light', -0.6, 0, 0.02, segments=8, rot=(0, math.pi/2, 0))

export(OUT)
