# Builds assets/models/Student.glb: the pieces a student flat is furnished from (see "a student flat" in
# src/buildings/interior.js), in the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/student-models.py
#
# Most pieces stand in for Interior.glb's own, under the same names (Sofa, Chair, Table, TV, Lamp, Plant, Coffee Table,
# Rug, Bookcase, Pendant, Drawers), so a student flat is laid out as any other home; the rest (Chair2 and Chair3, for
# chairs that don't match, Beanbag, ClothesHorse, three posters (PosterBand, PosterFilm, PosterMap) and a length of
# FairyLights) only a student flat has.
# Like Interior.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported) but for the TV, which faces +y as Interior.glb's does. Built in metres, life size, and scaled up at the end.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Student.glb')
random.seed(5)

# (the ones interior.js recolours for each student flat are Futon, Pine, Crate, Crate2, Beanbag, Formica, Painted,
# Plastic, LampShade, Bucket, RugA, RugB and the posters' Poster*; Light glows as it is)
material('Futon', 0x2a3a5a, 1.0)
material('Pine', 0xd8b47a, 0.7)
material('Crate', 0xc83a2a, 0.6)
material('Crate2', 0x2a5ab0, 0.6)
material('Beanbag', 0xd86a2a, 0.9)
material('Formica', 0xe8e4da, 0.5)
material('Painted', 0x5a8a7a, 0.6)
material('Plastic', 0xf2f0ea, 0.5)
material('Steel', 0x9a9ea4, 0.35, 0.5)
material('Black', 0x18181a, 0.5)
material('Screen', 0xcccccc, 0.5)
material('TV', 0x1a1a1c, 0.4)
material('LampShade', 0xf0e8d8, 1.0)
material('Light', 0x000000, 1.0, glow=0xffe0a8)
material('Flex', 0x202020, 0.8)
material('Bucket', 0xe8e4d8, 0.5)
material('Dirt', 0x2a1a0e, 1.0)
material('Leaf', 0x4a8a3a, 0.7)
material('LeafPale', 0xb8d890, 0.7)
material('Card', 0xc8a070, 0.9)
material('CardPrint', 0xb83a2a, 0.9)
material('Crust', 0xd8963a, 0.9)
material('Cheese', 0xf0c850, 0.8)
material('Pepperoni', 0xa82a1e, 0.8)
material('Can', 0xc8c8cc, 0.3, 0.6)
material('Can2', 0xc81e2a, 0.3, 0.4)
material('Can3', 0x2a6ab0, 0.3, 0.4)
material('Bottle', 0x2a5a2a, 0.2)
material('Mug', 0xe8e4dc, 0.4)
material('Paper', 0xf4f2ea, 0.9)
material('RugA', 0x2a6a7a, 1.0)
material('RugB', 0xe8d8b0, 1.0)
material('Poster0', 0x1a1a22, 0.9)
material('Poster1', 0xe84a3a, 0.9)
material('Poster2', 0xf0d040, 0.9)
material('Poster3', 0x3a8ac8, 0.9)
material('Tack', 0x5ab0d8, 0.7)
for i, colour in enumerate((0xd84a3a, 0x3a5aa8, 0xf2f0ea, 0x2a2a2c, 0x7a9a5a, 0xe8a8b8, 0xe0b040)):
    material('Cloth%d' % i, colour, 1.0)
CLOTHS = ['Cloth%d' % i for i in range(7)]
for i, colour in enumerate((0x2a2a3a, 0xc83a2a, 0xe8e0c8, 0x3a6a4a, 0xe0a030, 0x6a3a6a)):
    material('Book%d' % i, colour, 0.7)
BOOKS = ['Book%d' % i for i in range(6)]

# a milk crate, w by d by h, open at the top (or at the front, stood on its side, if `side`), standing on z0 at (x, y)
def crate(p, x, y, z0, mat, w=0.44, d=0.34, h=0.3, side=False):
    t = 0.02
    if side:                                                                  # its open top turned to face -y
        p.box(w, t, h, mat, x, y + d/2 - t/2, z0, bevel=0.004)                 # (its bottom, at the back)
        for s in (-1, 1):
            p.box(t, d, h, mat, x + s*(w/2 - t/2), y, z0, bevel=0.004)
        for z in (z0, z0 + h - t):
            p.box(w, d, t, mat, x, y, z, bevel=0.004)
        for s in (-1, 1):                                                     # the hand holds, as slots
            p.box(0.012, d*0.5, 0.05, 'Black', x + s*(w/2 - 0.005), y, z0 + h*0.6, bevel=0)
    else:
        p.box(w, d, t, mat, x, y, z0, bevel=0.004)
        for s in (-1, 1):
            p.box(t, d, h, mat, x + s*(w/2 - t/2), y, z0, bevel=0.004)
            p.box(w - 2*t, t, h, mat, x, y + s*(d/2 - t/2), z0, bevel=0.004)
    # (the grid of slats across each side, as dark lines)
    for k in (1, 2, 3):
        z = z0 + h*k/4
        p.box(w + 0.004, d + 0.004 if not side else d - 0.02, 0.006, 'Black', x, y + (0.01 if side else 0), z, bevel=0)

# a book stood up, its spine to -y, from its bottom left corner at (x, y, z0); returns where the next one goes
def book(p, x, y, z0, tilt=0.0):
    w, h, d = random.uniform(0.025, 0.05), random.uniform(0.17, 0.25), random.uniform(0.13, 0.17)
    p.box(w, d, h, random.choice(BOOKS), x + w/2, y + d/2, z0, bevel=0.003, rot=(0, tilt, 0))
    return x + w + 0.003

# a drinks can, standing on z0 at (x, y), or lying on its side
def can(p, x, y, z0, mat='Can2', lying=False, turn=0.0):
    if lying:
        p.cyl(0.033, 0.12, mat, x, y, z0 + 0.033, segments=10, rot=(math.pi/2, 0, turn))
    else:
        p.cyl(0.033, 0.11, mat, x, y, z0, segments=10)
        p.cyl(0.028, 0.012, 'Can', x, y, z0 + 0.11, segments=10)

# a pizza box, lid up, with a couple of slices left, its hinge along the back at y + 0.19, on z0 at (x, y)
def pizza(p, x, y, z0, turn=0.0):
    c, s = math.cos(turn), math.sin(turn)
    at = lambda u, v: (x + u*c - v*s, y + u*s + v*c)
    p.box(0.38, 0.38, 0.04, 'Card', *at(0, 0), z0, bevel=0.004, rot=(0, 0, turn))
    p.box(0.36, 0.36, 0.004, 'Paper', *at(0, 0), z0 + 0.036, bevel=0, rot=(0, 0, turn))
    hx, hy = at(0, 0.19)
    p.box(0.38, 0.004, 0.38, 'Card', hx, hy, z0 + 0.04, bevel=0.002, rot=(-0.25, 0, turn))  # the lid, standing open
    p.box(0.2, 0.006, 0.2, 'CardPrint', hx - 0.0, hy - 0.004, z0 + 0.12, bevel=0, rot=(-0.25, 0, turn))
    for a in (0.3, 1.6):                                                      # two slices left
        sx, sy = at(-0.02 + math.cos(a)*0.03, -0.02 + math.sin(a)*0.03)
        rim = [(math.cos(a + d)*0.15, math.sin(a + d)*0.15) for d in (-0.35, 0.35)]
        p.hull([(0, 0, 0), (0, 0, 0.012)] + [(u, v, h) for u, v in rim for h in (0, 0.012)], 'Cheese', (sx, sy, z0 + 0.04))
        cx, cy = sx + math.cos(a)*0.145, sy + math.sin(a)*0.145
        p.cyl(0.013, 0.105, 'Crust', cx - math.sin(a)*0.0525, cy + math.cos(a)*0.0525, z0 + 0.046, segments=8,
              rot=(math.pi/2, 0, a))
        for f in (0.05, 0.1):
            p.cyl(0.017, 0.004, 'Pepperoni', sx + math.cos(a + 0.1)*f, sy + math.sin(a + 0.1)*f, z0 + 0.052, segments=8)

# ------------------------------------------------------------------ the futon, folded up as a sofa
p = piece('Sofa')
W, D = 1.9, 0.95
for x in (-W/2 + 0.04, W/2 - 0.04):                                           # the pine frame's ends, slatted arms
    for y in (-D/2 + 0.05, D/2 - 0.08):
        p.box(0.05, 0.05, 0.6, 'Pine', x, y, 0, bevel=0.006)
    for z in (0.2, 0.4, 0.58):
        p.box(0.05, D - 0.08, 0.04, 'Pine', x, -0.015, z, bevel=0.006)
p.box(W - 0.1, 0.04, 0.08, 'Pine', 0, -D/2 + 0.06, 0.16, bevel=0.006)          # the seat's rails
p.box(W - 0.1, 0.04, 0.08, 'Pine', 0, D/2 - 0.1, 0.16, bevel=0.006)
p.box(W - 0.12, 0.8, 0.18, 'Futon', 0, -0.05, 0.24, bevel=0.07, segments=3)    # the mattress, folded: seat
p.box(W - 0.12, 0.18, 0.62, 'Futon', 0, D/2 - 0.16, 0.3, bevel=0.07, segments=3, rot=(-0.18, 0, 0))  # and back
for x in (-0.6, -0.2, 0.2, 0.6):                                                # tufts
    p.ball(0.015, 'Black', (x, -0.1, 0.42), scale=(1, 1, 0.5))
p.box(0.5, 0.36, 0.1, 'Cloth1', -0.55, 0.12, 0.42, bevel=0.04, rot=(0.5, 0.2, 0.3))  # a cushion, flung down
p.box(0.7, 0.5, 0.04, 'Cloth5', 0.5, -0.05, 0.42, bevel=0.02, rot=(0, 0, 0.3))   # and a throw, rucked up
p.box(0.5, 0.3, 0.07, 'Cloth5', 0.62, 0.1, 0.44, bevel=0.03, rot=(0.2, 0, 0.1))

# ------------------------------------------------------------------ a beanbag, slumped
p = piece('Beanbag')
p.ball(0.46, 'Beanbag', (0, 0, 0.18), scale=(1, 1, 0.42), detail=2)
p.ball(0.4, 'Beanbag', (0, 0.18, 0.3), scale=(1, 0.55, 0.9), detail=2, rot=(-0.3, 0, 0))

# ------------------------------------------------------------------ the chairs: a folding one, a painted kitchen one, a plastic one
p = piece('Chair')
for x in (-0.19, 0.19):
    p.bar((x, -0.2, 0), (x, 0.16, 0.9), 0.022, 'Steel')                          # the back legs, up into the back
    p.bar((x, 0.18, 0), (x, -0.18, 0.46), 0.022, 'Steel')                         # and the front ones, crossing
p.box(0.42, 0.4, 0.03, 'Steel', 0, -0.02, 0.44, bevel=0.01)                     # seat, top at 0.47
p.box(0.38, 0.05, 0.2, 'Steel', 0, 0.14, 0.66, bevel=0.012, rot=(-0.4, 0, 0))
p.bar((-0.19, 0.0, 0.2), (0.19, 0.0, 0.2), 0.016, 'Steel')

p = piece('Chair2')
for x in (-0.19, 0.19):
    for y in (-0.18, 0.18):
        p.box(0.035, 0.035, 0.44, 'Painted', x, y, 0, bevel=0.006)
    p.box(0.035, 0.035, 0.5, 'Painted', x, 0.18, 0.44, bevel=0.006, rot=(-0.08, 0, 0))
p.box(0.44, 0.42, 0.035, 'Painted', 0, 0, 0.44, bevel=0.008)                    # seat, top at 0.475
for z in (0.62, 0.8):
    p.box(0.38, 0.025, 0.05, 'Painted', 0, 0.19 + (z - 0.44)*0.08, z, bevel=0.006)
p.box(0.36, 0.025, 0.025, 'Painted', 0, 0, 0.14, bevel=0.004, rot=(0, 0, math.pi/2))
p.box(0.36, 0.34, 0.04, 'Cloth0', 0, -0.01, 0.475, bevel=0.015)                # a cushion tied on

p = piece('Chair3')
for x in (-0.2, 0.2):
    for y in (-0.19, 0.17):
        p.cyl(0.02, 0.44, 'Plastic', x + (0.02 if x < 0 else -0.02)*0, y, 0, r2=0.024, segments=8)
p.box(0.46, 0.44, 0.04, 'Plastic', 0, -0.01, 0.43, bevel=0.015)                 # seat, top at 0.47
p.box(0.46, 0.04, 0.36, 'Plastic', 0, 0.2, 0.47, bevel=0.015, rot=(-0.15, 0, 0))
for x in (-0.12, 0, 0.12):
    p.box(0.05, 0.05, 0.16, 'Black', x, 0.215, 0.62, bevel=0)                    # slots through the back

# ------------------------------------------------------------------ the folding table, with a laptop, a mug and some post
p = piece('Table')
TW, TD, TH = 1.2, 0.75, 0.74
p.box(TW, TD, 0.03, 'Formica', 0, 0, TH - 0.03, bevel=0.01)
p.box(TW - 0.04, TD - 0.04, 0.04, 'Steel', 0, 0, TH - 0.07, bevel=0.004)
for x in (-TW/2 + 0.08, TW/2 - 0.08):
    for y in (-TD/2 + 0.07, TD/2 - 0.07):
        p.cyl(0.014, TH - 0.07, 'Steel', x, y, 0, segments=8)
    p.bar((x, -TD/2 + 0.07, 0.2), (x, TD/2 - 0.07, 0.2), 0.012, 'Steel')
p.box(0.34, 0.24, 0.012, 'Black', -0.25, -0.05, TH, bevel=0.004, rot=(0, 0, 0.1))  # the laptop, open
p.box(0.34, 0.012, 0.23, 'Black', -0.26, 0.065, TH + 0.012, bevel=0.004, rot=(-0.3, 0, 0.1))
p.box(0.3, 0.004, 0.19, 'Screen', -0.26, 0.058, TH + 0.03, bevel=0, rot=(-0.3, 0, 0.1))
p.cyl(0.04, 0.09, 'Mug', 0.12, -0.15, TH, segments=10)
p.cyl(0.034, 0.004, 'Dirt', 0.12, -0.15, TH + 0.08, segments=10)
for k in range(3):                                                             # post, unopened
    p.box(0.22, 0.11, 0.006, 'Paper', 0.35, 0.12, TH + k*0.006, bevel=0, rot=(0, 0, 0.3*k - 0.2))
p.cyl(0.035, 0.22, 'Bottle', 0.42, -0.2, TH, segments=10)
p.cyl(0.013, 0.07, 'Bottle', 0.42, -0.2, TH + 0.22, segments=8)

# ------------------------------------------------------------------ the TV, on crates, with a games console (facing +y)
p = piece('TV')
for x in (-0.23, 0.23):
    crate(p, x, 0, 0, 'Crate', w=0.44, d=0.34, h=0.3, side=True)
p.box(0.6, 0.28, 0.02, 'Pine', 0, 0, 0.3, bevel=0.004)                           # a board across them
p.box(0.22, 0.16, 0.012, 'TV', 0, 0.01, 0.32, bevel=0.004)                       # the TV's foot and neck
p.box(0.06, 0.03, 0.08, 'TV', 0, -0.01, 0.33, bevel=0.004)
p.box(0.84, 0.05, 0.5, 'TV', 0, 0, 0.38, bevel=0.01)
p.box(0.8, 0.006, 0.46, 'Screen', 0, 0.027, 0.4, bevel=0.001)
p.box(0.3, 0.2, 0.06, 'Black', 0.22, -0.01, 0.03, bevel=0.012)                   # the console, in the crate below
p.box(0.12, 0.004, 0.006, 'Light', 0.22, 0.092, 0.06, bevel=0)
for k in range(4):
    book(p, -0.42 + k*0.035, -0.08, 0.03, 0)                                     # games, in the other
for x, turn in ((-0.1, 0.4), (0.12, -0.2)):                                   # two controllers on the floor
    p.hull([(-0.07, -0.02, 0), (0.07, -0.02, 0), (-0.08, 0.04, 0), (0.08, 0.04, 0), (-0.07, -0.02, 0.03), (0.07, -0.02, 0.03),
            (-0.08, 0.04, 0.03), (0.08, 0.04, 0.03), (0, 0.05, 0.02)], 'Black', (x, 0.36, 0), rot=(0, 0, turn))

# ------------------------------------------------------------------ the floor lamp: a paper globe on a tripod
p = piece('Lamp')
for k in range(3):
    a = k*2*math.pi/3
    p.bar((math.cos(a)*0.22, math.sin(a)*0.22, 0), (0, 0, 1.1), 0.02, 'Pine')
p.cyl(0.01, 0.35, 'Flex', z0=1.05, segments=6)
p.ball(0.22, 'Light', (0, 0, 1.5), scale=(1, 1, 0.9), detail=2)                # (lit)

# ------------------------------------------------------------------ a spider plant in a bucket
p = piece('Plant')
p.lathe([(0.13, 0), (0.15, 0.02), (0.17, 0.3), (0.175, 0.31)], 'Bucket', segments=14)
p.cyl(0.16, 0.01, 'Dirt', z0=0.27, segments=12)
for k in range(22):
    a = k*2.4 + random.uniform(-0.2, 0.2)
    reach, rise = random.uniform(0.2, 0.45), random.uniform(0.1, 0.35)
    base = (math.cos(a)*0.04, math.sin(a)*0.04, 0.28)
    mid = (math.cos(a)*reach*0.5, math.sin(a)*reach*0.5, 0.28 + rise)
    tip = (math.cos(a)*reach, math.sin(a)*reach, 0.28 + rise*0.4 - (0.12 if reach > 0.35 else 0))
    for (u, v) in ((base, mid), (mid, tip)):
        p.hull([u, (u[0], u[1], u[2] + 0.01), v, (v[0] + math.sin(a)*0.015, v[1] - math.cos(a)*0.015, v[2])], 'Leaf' if k % 2 else 'LeafPale')
for k in range(3):                                                             # babies, trailing over the side
    a = k*2.1 + 0.5
    end = (math.cos(a)*0.4, math.sin(a)*0.4, 0.05)
    p.bar((math.cos(a)*0.17, math.sin(a)*0.17, 0.3), end, 0.006, 'LeafPale', bevel=0)
    for j in range(5):
        b = j*1.26
        p.hull([end, (end[0] + math.cos(b)*0.08, end[1] + math.sin(b)*0.08, end[2] + 0.04), (end[0], end[1], end[2] + 0.02)], 'Leaf')

# ------------------------------------------------------------------ the coffee table: a pallet on bricks, with the night before on it
p = piece('Coffee Table')
CW, CD, CH = 1.2, 0.8, 0.36
for x in (-0.5, 0.5):
    for y in (-0.3, 0.3):
        p.box(0.1, 0.1, 0.22, 'CardPrint', x, y, 0, bevel=0.006)               # (bricks, as it were)
for x in (-0.55, 0, 0.55):
    p.box(0.1, CD, 0.08, 'Pine', x, 0, 0.22, bevel=0.006)
for k in range(7):
    p.box(CW, 0.09, 0.022, 'Pine', 0, -CD/2 + 0.045 + k*(CD - 0.09)/6, 0.3, bevel=0.005)
CT = 0.322
pizza(p, -0.2, -0.04, CT, 0.15)
can(p, 0.18, -0.2, CT, 'Can2')
can(p, 0.28, -0.08, CT, 'Can3')
can(p, 0.35, 0.18, CT, 'Can2', lying=True, turn=0.7)
can(p, 0.62, -0.5, 0, 'Can3', lying=True, turn=2.1)                             # and one rolled off
p.cyl(0.04, 0.09, 'Mug', 0.45, -0.25, CT, segments=10)
p.hull([(-0.07, -0.02, 0), (0.07, -0.02, 0), (-0.08, 0.04, 0), (0.08, 0.04, 0), (-0.07, -0.02, 0.03), (0.07, -0.02, 0.03),
        (-0.08, 0.04, 0.03), (0.08, 0.04, 0.03)], 'Black', (0.12, 0.25, CT), rot=(0, 0, 0.5))

# ------------------------------------------------------------------ a striped rug, a bit rucked
p = piece('Rug')
RW, RD = 1.6, 1.0
p.box(RW, RD, 0.012, 'RugB', 0, 0, 0, bevel=0.004)
for k in range(9):
    if k % 2: continue
    p.box(RW/9, RD - 0.004, 0.004, 'RugA', -RW/2 + RW/18 + k*RW/9, 0, 0.012, bevel=0)
p.box(RW*0.8, 0.12, 0.03, 'RugB', 0.05, -RD/2 + 0.08, 0, bevel=0.012, rot=(0, 0, 0.05))   # the ruck

# ------------------------------------------------------------------ the bookcase: milk crates stacked, full of books and stuff
p = piece('Bookcase')
CRATE_W, CRATE_D, CRATE_H = 0.44, 0.34, 0.3
for row in range(4):
    for col, x in enumerate((-CRATE_W/2 - 0.005, CRATE_W/2 + 0.005)):
        mat = 'Crate' if (row + col) % 3 else 'Crate2'
        z0 = row*CRATE_H
        crate(p, x + random.uniform(-0.015, 0.015), 0, z0, mat, CRATE_W, CRATE_D, CRATE_H, side=True)
        inside = z0 + 0.02
        what = (row*2 + col) % 5
        if what in (0, 2, 3):                                                   # books
            bx = x - CRATE_W/2 + 0.03
            while bx < x + CRATE_W/2 - (0.1 if what == 2 else 0.06):
                bx = book(p, bx, -CRATE_D/2 + 0.03, inside, 0)
            if what == 2: p.box(0.18, 0.13, 0.03, BOOKS[row], x + 0.1, -0.02, inside, bevel=0.003, rot=(0, 0.5, 0))
        elif what == 1:                                                         # a speaker
            p.box(0.2, 0.2, 0.25, 'Black', x, 0, inside, bevel=0.01)
            p.cyl(0.06, 0.01, 'TV', x, -0.1, inside + 0.1, segments=14, rot=(math.pi/2, 0, 0))
        else:                                                                   # records
            for k in range(8):
                p.box(0.004, 0.26, 0.26, CLOTHS[k % 7] if k % 2 else 'Black', x - 0.15 + k*0.03, 0, inside, bevel=0, rot=(0, 0.1, 0))
top = CRATE_H*4
p.cyl(0.035, 0.22, 'Bottle', -0.3, -0.05, top, segments=10)                   # a bottle with a candle in it
p.cyl(0.012, 0.1, 'Paper', -0.3, -0.05, top + 0.22, segments=8)
p.cyl(0.07, 0.03, 'Leaf', 0.25, 0.0, top, segments=10)                          # and a cactus
p.lathe([(0.05, 0), (0.05, 0.08), (0.04, 0.11)], 'Crate2', 0.25, 0, top + 0.001, segments=10)
p.cyl(0.03, 0.12, 'Leaf', 0.25, 0, top + 0.1, r2=0.02, segments=8)

# ------------------------------------------------------------------ a bare bulb on its flex (its top at the ceiling)
p = piece('Pendant')
PH = 0.8
p.cyl(0.05, 0.03, 'Plastic', z0=PH - 0.03, r2=0.045, segments=12)             # ceiling rose
p.cyl(0.004, PH - 0.13, 'Flex', z0=0.1, segments=6)
p.cyl(0.018, 0.05, 'Black', z0=0.07, segments=10)                              # the lampholder
p.lathe([(0.012, 0.0), (0.03, 0.015), (0.03, 0.045), (0.012, 0.07)], 'Light', segments=12)

# ------------------------------------------------------------------ flatpack drawers, a drawer out of line, stuff on top
p = piece('Drawers')
DW, DD, DH = 0.8, 0.42, 0.78
p.box(DW, DD, DH, 'Formica', 0, 0, 0, bevel=0.006)
for k in range(4):
    z = 0.04 + k*0.185
    out = 0.05 if k == 1 else 0.0
    p.box(DW - 0.04, 0.02, 0.17, 'Formica', 0, -DD/2 - 0.01 - out, z, bevel=0.004)
    p.box(0.12, 0.02, 0.02, 'Steel', 0, -DD/2 - 0.03 - out, z + 0.1, bevel=0.004)
p.box(0.18, 0.02, 0.1, 'Cloth3', -0.1, -DD/2 - 0.05, 0.25, bevel=0.01)         # a sleeve hanging out of it
p.box(0.35, 0.3, 0.08, 'Cloth1', -0.18, 0.02, DH, bevel=0.03, rot=(0, 0, 0.2))   # clothes on top
p.box(0.3, 0.25, 0.06, 'Cloth4', -0.14, -0.02, DH + 0.07, bevel=0.025, rot=(0, 0, -0.3))
p.box(0.15, 0.12, 0.2, 'Black', 0.25, 0.05, DH, bevel=0.01)                      # a little speaker
p.cyl(0.035, 0.008, 'TV', 0.25, -0.011, DH + 0.1, segments=12, rot=(math.pi/2, 0, 0))
p.cyl(0.03, 0.1, 'Can3', 0.08, -0.1, DH, segments=10)                            # deodorant

# ------------------------------------------------------------------ the clothes horse, with the washing on it
p = piece('ClothesHorse')
HW, HD, HH = 1.3, 0.6, 1.0
for s in (-1, 1):
    for x in (-HW/2, HW/2):
        p.bar((x, s*HD/2, 0), (x, s*0.05, HH), 0.02, 'Plastic')
    for k in range(3):
        z = 0.35 + k*0.3
        y = s*(HD/2 - (z/HH)*(HD/2 - 0.05))
        p.bar((-HW/2, y, z), (HW/2, y, z), 0.012, 'Plastic')
p.bar((-HW/2, 0.05, HH), (HW/2, 0.05, HH), 0.014, 'Plastic')
# the washing, draped over the rails: t-shirts, a towel, socks, a pair of jeans
def draped(x, w, rail_z, rail_y, drop, mat, s=1):
    p.box(w, 0.02, drop, mat, x, rail_y + s*0.012, rail_z - drop, bevel=0.006)
    p.box(w, 0.035, 0.03, mat, x, rail_y, rail_z - 0.015, bevel=0.012)
top_y = 0.05
draped(-0.38, 0.5, HH, top_y, 0.55, 'Cloth3', 1)                              # the towel, over the top
draped(-0.38, 0.5, HH, top_y, 0.5, 'Cloth3', -1)
rail_y = lambda z, s: s*(HD/2 - (z/HH)*(HD/2 - 0.05))
for x, w, drop, mat in ((-0.4, 0.35, 0.3, 'Cloth0'), (0.05, 0.3, 0.26, 'Cloth2'), (0.42, 0.28, 0.4, 'Cloth6')):   # t-shirts
    draped(x, w, 0.65, rail_y(0.65, -1), drop, mat, -1)
for k, x in enumerate((0.05, 0.14, 0.24, 0.35, 0.45)):                        # socks, in a row on the top
    p.box(0.07, 0.02, 0.16, CLOTHS[(k*3) % 7], x, top_y + 0.015, HH - 0.16, bevel=0.01)
draped(0.2, 0.36, 0.65, rail_y(0.65, 1), 0.4, 'Cloth1', 1)   # jeans, the far side
draped(-0.3, 0.3, 0.35, rail_y(0.35, 1), 0.2, 'Cloth5', 1)

# ------------------------------------------------------------------ posters, stuck up with Blu-tack
def poster(p, w, h):
    p.box(w, 0.004, h, 'Poster0', 0, 0, 0, bevel=0)
    for x in (-w/2 + 0.03, w/2 - 0.03):
        for z in (0.03, h - 0.03):
            p.ball(0.012, 'Tack', (x, -0.004, z), scale=(1, 0.4, 1))
p = piece('PosterBand')                                                         # a band's: a big red disc, and a name
w, h = 0.6, 0.85
poster(p, w, h)
p.cyl(0.2, 0.004, 'Poster1', 0, -0.002, h*0.58, segments=24, rot=(math.pi/2, 0, 0))
p.cyl(0.08, 0.005, 'Poster0', 0, -0.003, h*0.58, segments=16, rot=(math.pi/2, 0, 0))
for k in range(5):
    p.box(0.06 + (k % 2)*0.03, 0.006, 0.07, 'Poster2', -0.2 + k*0.1, -0.003, 0.12, bevel=0)
p = piece('PosterFilm')                                                        # a film's: a figure against a sunset
w, h = 0.5, 0.72
poster(p, w, h)
for k, mat in enumerate(('Poster1', 'Poster2', 'Poster1')):
    p.box(w - 0.04, 0.005, 0.12, mat, 0, -0.002, 0.3 + k*0.12, bevel=0)
p.box(w - 0.04, 0.005, 0.26, 'Poster3', 0, -0.002, 0.03, bevel=0)
p.hull([(-0.04, -0.004, 0.2), (0.04, -0.004, 0.2), (-0.03, -0.004, 0.42), (0.03, -0.004, 0.42), (0, -0.003, 0.2)], 'Poster0')
p.ball(0.035, 'Poster0', (0, -0.004, 0.46), scale=(1, 0.1, 1.1))
for k in range(3):
    p.box(0.3 - k*0.08, 0.006, 0.025, 'Paper', 0, -0.004, 0.62 - k*0.04, bevel=0)
p = piece('PosterMap')                                                        # and a map of the world, landscape
w, h = 0.9, 0.6
poster(p, w, h)
p.box(w - 0.04, 0.005, h - 0.04, 'Poster3', 0, -0.002, 0.02, bevel=0)
for (x, z, sw, sh) in ((-0.25, 0.35, 0.18, 0.14), (-0.2, 0.16, 0.08, 0.16), (0.02, 0.36, 0.1, 0.1), (0.05, 0.2, 0.09, 0.14),
                       (0.22, 0.36, 0.26, 0.12), (0.3, 0.14, 0.1, 0.07)):
    p.ball(0.5, 'Poster2', (x, -0.004, z), scale=(sw, 0.004, sh))

# ------------------------------------------------------------------ fairy lights: one swag of them, a metre long, pinned at its ends
p = piece('FairyLights')
SPAN, SAG, N = 1.0, 0.16, 11
curve = lambda t: (-SPAN/2 + SPAN*t, 0, -SAG*4*t*(1 - t))
for k in range(16):
    p.bar(curve(k/16), curve((k + 1)/16), 0.004, 'Flex', bevel=0)
for k in range(N):
    x, y, z = curve((k + 0.5)/N)
    p.cyl(0.005, 0.012, 'Flex', x, y, z - 0.012, segments=6)
    p.ball(0.012, 'Light', (x, y, z - 0.025), scale=(1, 1, 1.4))

# ------------------------------------------------------------------ out
export(OUT)
