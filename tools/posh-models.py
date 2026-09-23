# Builds assets/models/Posh.glb: the pieces a posh home is furnished from (see "a posh home" in
# src/buildings/interior.js), in the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/posh-models.py
#
# Most pieces stand in for Interior.glb's own, under the same names (Sofa, Chair, Table, TV, Lamp, Plant, Coffee Table,
# Rug, Bookcase, Pendant, Drawers), so a posh home is laid out as any other; the rest (Armchair, Fireplace, Piano,
# PianoBench, Painting, Portrait) only a posh home has. Like Interior.glb, it's one top-level mesh per piece, at five
# times life size, each facing -y (the room's +z, once exported) but for the TV, which faces +y as Interior.glb's does.
# Everything's built here in metres, life size, and scaled up at the end.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export
import bmesh
from mathutils import Vector, Euler

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Posh.glb')
random.seed(11)

# (the ones interior.js recolours for each posh home are Leather, Velvet, Walnut, Gilt, Marble, Lacquer, LampShade, Urn,
# RugField, RugBorder, RugMotif and the paintings' Paint*; Light and Fire glow as they are)
material('Leather', 0x5a1a1a, 0.55)
material('Velvet', 0x1f6a4a, 1.0)
material('Walnut', 0x4a2c1a, 0.5)
material('Gilt', 0xd4a84a, 0.35, 0.3)
material('Marble', 0xece8e2, 0.25)
material('Lacquer', 0x141416, 0.2)
material('Ivory', 0xf4efe2, 0.4)
material('Ebony', 0x121214, 0.4)
material('Steel', 0xb0b0b0, 0.3, 0.4)
material('Soundboard', 0xc89a5a, 0.6)
material('Screen', 0xcccccc, 0.5)
material('TV', 0x101012, 0.4)
material('LampShade', 0xece2cc, 1.0)
material('Light', 0x000000, 1.0, glow=0xfff0d0)
material('Fire', 0x000000, 1.0, glow=0xff8a2a)
material('Soot', 0x141212, 1.0)
material('Log', 0x5a3a24, 1.0)
material('Mirror', 0xb8c6cc, 0.1)
material('Crystal', 0xe8f0f4, 0.1)
material('Candle', 0xf2ecdc, 0.8)
material('Urn', 0x7aa89a, 0.3)
material('Dirt', 0x2a1a0e, 1.0)
material('Frond', 0x3a7a3a, 0.6)
material('Stem', 0x5a6a2a, 0.8)
material('Bloom', 0xf0e0e8, 0.8)
material('Bloom2', 0xd85a7a, 0.8)
material('Paper', 0xf6f2e6, 0.9)
material('Face', 0xf6f2e6, 0.5)
material('Hands', 0x1a1a1a, 0.5)
material('RugField', 0x8a2a2a, 1.0)
material('RugBorder', 0x243a5a, 1.0)
material('RugMotif', 0xd8c090, 1.0)
material('Fringe', 0xece4d0, 1.0)
material('PaintSky', 0x9ab8c8, 0.9)
material('PaintLand', 0x6a8a4a, 0.9)
material('PaintHill', 0x4a6a5a, 0.9)
material('PaintDark', 0x2a2420, 0.9)
material('PaintFigure', 0x3a2a3a, 0.9)
material('PaintSkin', 0xd8b090, 0.9)
material('Globe', 0x3a6a8a, 0.6)
for i, colour in enumerate((0x5a1a1a, 0x1e3a2a, 0x1e2a4a, 0x8a5a2a, 0x1a1a1a, 0x6a3a2a)):
    material('Book%d' % i, colour, 0.7)
BOOKS = ['Book%d' % i for i in range(6)]

# a candlestick, standing at (x, y, z0), with its candle lit or not
def candlestick(p, x, y, z0, lit=False, h=0.2):
    p.lathe([(0.045, 0), (0.045, 0.012), (0.02, 0.02), (0.012, 0.05), (0.022, 0.06), (0.01, 0.07), (0.01, h - 0.02),
             (0.025, h - 0.01), (0.025, h)], 'Gilt', x, y, z0, segments=10)
    p.cyl(0.011, 0.09, 'Candle', x, y, z0 + h, segments=8)
    if lit: p.ball(0.01, 'Light', (x, y, z0 + h + 0.105), scale=(1, 1, 1.8))

# a mantel clock, standing on z0 at (x, y)
def clock(p, x, y, z0):
    p.box(0.26, 0.1, 0.03, 'Walnut', x, y, z0, bevel=0.008)
    p.box(0.22, 0.08, 0.16, 'Walnut', x, y, z0 + 0.03, bevel=0.01)
    p.ball(0.11, 'Walnut', (x, y, z0 + 0.19), scale=(1, 0.36, 0.9))
    p.cyl(0.075, 0.01, 'Gilt', x, y - 0.04, z0 + 0.16, segments=16, rot=(math.pi/2, 0, 0))
    p.cyl(0.062, 0.01, 'Face', x, y - 0.045, z0 + 0.16, segments=16, rot=(math.pi/2, 0, 0))
    p.box(0.008, 0.004, 0.05, 'Hands', x, y - 0.056, z0 + 0.16, bevel=0)
    p.box(0.035, 0.004, 0.008, 'Hands', x + 0.016, y - 0.056, z0 + 0.155, bevel=0)
    p.ball(0.018, 'Gilt', (x, y, z0 + 0.31))

# a vase of flowers, standing on z0 at (x, y)
def flowers(p, x, y, z0, mat='Urn', h=0.2):
    p.lathe([(0.04, 0), (0.07, 0.06), (0.06, h*0.7), (0.035, h*0.85), (0.045, h)], mat, x, y, z0)
    for k in range(9):
        a, r = k*2.4, 0.03 + 0.07*((k*7) % 5)/4
        top = (x + math.cos(a)*r, y + math.sin(a)*r, z0 + h + 0.12 + 0.04*((k*3) % 4)/3)
        p.bar((x, y, z0 + h - 0.02), top, 0.006, 'Stem', bevel=0)
        p.ball(0.028, 'Bloom' if k % 3 else 'Bloom2', top, detail=1)
    for k in range(5):
        a = k*1.3
        p.hull([(0, 0, 0), (math.cos(a)*0.14, math.sin(a)*0.14, 0.04), (math.cos(a + 0.3)*0.08, math.sin(a + 0.3)*0.08, 0.03),
                (math.cos(a)*0.07, math.sin(a)*0.07, 0.005)], 'Frond', (x, y, z0 + h + 0.01))

# a pile of books lying flat, from z0 up at (x, y)
def pile(p, x, y, z0, n, turn=0.0):
    z = z0
    for k in range(n):
        w, d, t = random.uniform(0.2, 0.28), random.uniform(0.15, 0.2), random.uniform(0.025, 0.04)
        p.box(w, d, t, BOOKS[(k*2 + int(x*10)) % len(BOOKS)], x, y, z, bevel=0.003, rot=(0, 0, turn + random.uniform(-0.12, 0.12)))
        p.box(w - 0.015, d + 0.004, t - 0.01, 'Paper', x, y, z + 0.005, bevel=0, rot=(0, 0, turn))
        z += t
    return z

# ------------------------------------------------------------------ the chesterfield
p = piece('Sofa')
W, D = 2.0, 0.9
for x in (-W/2 + 0.1, W/2 - 0.1):
    for y in (-D/2 + 0.1, D/2 - 0.1):
        p.lathe([(0.03, 0), (0.045, 0.03), (0.035, 0.07), (0.04, 0.08)], 'Walnut', x, y, 0, segments=10)
p.box(W, D, 0.3, 'Leather', 0, 0, 0.08, bevel=0.03, segments=2)
for x in (-0.53, 0, 0.53):                                                 # the seat cushions, three, one in the middle
    p.box(0.52, 0.62, 0.12, 'Leather', x, -0.08, 0.37, bevel=0.035, segments=2)
BACK_Y = D/2 - 0.11
p.box(W - 0.04, 0.22, 0.42, 'Leather', 0, BACK_Y, 0.37, bevel=0.03, segments=2)
p.cyl(0.075, W - 0.04, 'Leather', -(W - 0.04)/2, BACK_Y - 0.02, 0.79, segments=12, rot=(0, math.pi/2, 0))
for i in range(3):                                                         # the buttoned back, in diamonds
    z = 0.54 + i*0.1
    for k in range(13):
        x = -0.84 + k*0.14 + (0.07 if i % 2 else 0)
        if abs(x) < 0.9: p.ball(0.02, 'Leather', (x, BACK_Y - 0.115, z), scale=(1, 0.6, 1), detail=1)
for side in (-1, 1):                                                       # the rolled arms, as high as the back
    x = side*(W/2 - 0.1)
    p.box(0.2, D, 0.36, 'Leather', x, 0, 0.37, bevel=0.03, segments=2)
    p.cyl(0.11, D + 0.02, 'Leather', x + side*0.02, D/2 + 0.01, 0.73, segments=12, rot=(math.pi/2, 0, 0))
    p.cyl(0.07, 0.01, 'Leather', x + side*0.02, -D/2 - 0.012, 0.77, segments=12, rot=(math.pi/2, 0, 0))
    for i in range(3):
        p.ball(0.018, 'Leather', (x + side*0.02, -D/2 - 0.02, 0.5 + i*0.1), scale=(1, 0.6, 1))

# ------------------------------------------------------------------ the wingback armchair
p = piece('Armchair')
for x in (-0.33, 0.33):
    for y in (-0.33, 0.33):
        p.box(0.05, 0.05, 0.17, 'Walnut', x, y, 0, bevel=0.01, rot=(0.12*math.copysign(1, -y), 0.12*math.copysign(1, x), 0))
p.box(0.8, 0.78, 0.22, 'Velvet', 0, 0.01, 0.16, bevel=0.03, segments=2)
p.box(0.56, 0.62, 0.1, 'Velvet', 0, -0.06, 0.38, bevel=0.035, segments=2)          # the seat, top at 0.48
p.box(0.66, 0.18, 0.78, 'Velvet', 0, 0.3, 0.36, bevel=0.035, segments=2, rot=(-0.1, 0, 0))
p.ball(0.33, 'Velvet', (0, 0.33, 1.12), scale=(1, 0.27, 0.35))                     # its rounded top
for side in (-1, 1):
    x = side*0.35
    p.box(0.12, 0.7, 0.26, 'Velvet', x, -0.02, 0.38, bevel=0.03, segments=2)        # the arm
    p.cyl(0.075, 0.72, 'Velvet', x + side*0.02, 0.34, 0.6, segments=10, rot=(math.pi/2, 0, 0))
    p.hull([(x - 0.05, 0.4, 0.62), (x + 0.05, 0.4, 0.62), (x - 0.05, 0.4, 1.14), (x + 0.05, 0.38, 1.14),
            (x + side*0.03 - 0.04, -0.02, 0.72), (x + side*0.03 + 0.04, -0.02, 0.72),
            (x + side*0.03 - 0.04, 0.02, 0.98), (x + side*0.03 + 0.04, 0.02, 0.98)], 'Velvet')   # and the wing over it

# ------------------------------------------------------------------ the dining chair
p = piece('Chair')
for x in (-0.2, 0.2):
    p.lathe([(0.018, 0), (0.024, 0.08), (0.03, 0.12), (0.02, 0.16), (0.026, 0.3), (0.026, 0.42)], 'Walnut', x, -0.19, 0)
    p.box(0.04, 0.04, 1.02, 'Walnut', x, 0.2, 0, bevel=0.008, rot=(-0.06, 0, 0))
p.box(0.46, 0.44, 0.07, 'Walnut', 0, 0, 0.38, bevel=0.01)
p.box(0.5, 0.48, 0.07, 'Velvet', 0, -0.01, 0.43, bevel=0.025, segments=2)         # seat, top at 0.5
p.box(0.34, 0.05, 0.38, 'Velvet', 0, 0.23, 0.58, bevel=0.02, rot=(-0.06, 0, 0))
p.box(0.46, 0.06, 0.07, 'Walnut', 0, 0.25, 0.97, bevel=0.015, rot=(-0.06, 0, 0))
p.ball(0.03, 'Walnut', (0, 0.25, 1.05), scale=(1.4, 0.6, 1))
p.box(0.4, 0.035, 0.04, 'Walnut', 0, 0.21, 0.56, bevel=0.008)

# ------------------------------------------------------------------ the dining table, laid with a candelabra
p = piece('Table')
TW, TD, TH = 1.5, 0.95, 0.76
p.box(TW, TD, 0.05, 'Walnut', 0, 0, TH - 0.05, bevel=0.015)
p.box(TW - 0.12, TD - 0.12, 0.09, 'Walnut', 0, 0, TH - 0.14, bevel=0.01)
for x in (-TW/2 + 0.1, TW/2 - 0.1):
    for y in (-TD/2 + 0.1, TD/2 - 0.1):
        p.lathe([(0.025, 0), (0.035, 0.03), (0.03, 0.1), (0.06, 0.25), (0.05, 0.33), (0.03, 0.42), (0.035, 0.5),
                 (0.04, 0.62)], 'Walnut', x, y, 0)
p.box(1.1, 0.32, 0.004, 'Velvet', 0, 0, TH, bevel=0)                             # a runner down it
z = TH + 0.004
p.lathe([(0.07, 0), (0.07, 0.015), (0.03, 0.03), (0.015, 0.08), (0.03, 0.1), (0.012, 0.13), (0.012, 0.26)], 'Gilt', 0, 0, z)
for k in range(5):
    if k == 2: continue
    x = (k - 2)*0.1
    p.bar((0, 0, z + 0.22), (x, 0, z + 0.26 + abs(x)*0.2), 0.012, 'Gilt')
for k in range(5):
    x = (k - 2)*0.1
    top = z + (0.28 if k == 2 else 0.26 + abs(x)*0.2)
    p.cyl(0.025, 0.012, 'Gilt', x, 0, top, segments=10)
    p.cyl(0.011, 0.1, 'Candle', x, 0, top + 0.012, segments=8)
    p.ball(0.01, 'Light', (x, 0, top + 0.13), scale=(1, 1, 1.8))
for x in (-0.5, 0.5):                                                         # a plate either end
    p.cyl(0.13, 0.012, 'Face', x, 0, z, r2=0.14, segments=18)

# ------------------------------------------------------------------ the TV, on a sideboard (facing +y, as Interior.glb's)
p = piece('TV')
SW, SD, SH = 1.6, 0.45, 0.6
for x in (-SW/2 + 0.08, SW/2 - 0.08):
    for y in (-SD/2 + 0.07, SD/2 - 0.07):
        p.box(0.04, 0.04, 0.12, 'Gilt', x, y, 0, bevel=0.008)
p.box(SW, SD, SH - 0.12, 'Walnut', 0, 0, 0.12, bevel=0.012)
p.box(SW + 0.04, SD + 0.03, 0.03, 'Walnut', 0, 0, SH - 0.03, bevel=0.01)
for k in range(4):                                                            # doors, each with its knob
    x = -SW/2 + SW/8 + k*SW/4
    p.box(SW/4 - 0.03, 0.015, SH - 0.2, 'Walnut', x, SD/2 + 0.005, 0.15, bevel=0.006)
    p.box(SW/4 - 0.09, 0.02, SH - 0.26, 'Walnut', x, SD/2 + 0.008, 0.18, bevel=0.01)
    p.ball(0.015, 'Gilt', (x + (0.1 if k % 2 == 0 else -0.1), SD/2 + 0.02, 0.4))
p.box(0.36, 0.2, 0.02, 'TV', 0, 0, SH, bevel=0.006)                            # the TV's foot and neck
p.box(0.08, 0.04, 0.14, 'TV', 0, -0.03, SH + 0.02, bevel=0.006)
p.box(1.34, 0.05, 0.78, 'TV', 0, 0, SH + 0.1, bevel=0.01)
p.box(1.28, 0.006, 0.72, 'Screen', 0, 0.027, SH + 0.13, bevel=0.001)
flowers(p, -0.7, -0.05, SH, h=0.18)
pile(p, 0.66, -0.02, SH, 3, 0.1)

# ------------------------------------------------------------------ the floor lamp
p = piece('Lamp')
p.cyl(0.17, 0.035, 'Marble', segments=16)
p.lathe([(0.12, 0.035), (0.06, 0.06), (0.03, 0.1), (0.018, 0.14)], 'Gilt')
p.cyl(0.014, 1.12, 'Gilt', z0=0.14, segments=8)
for z in (0.5, 0.9):
    p.lathe([(0.016, 0), (0.028, 0.02), (0.016, 0.04)], 'Gilt', z0=z, segments=10)
p.cyl(0.24, 0.32, 'LampShade', z0=1.2, r2=0.17, segments=16)
p.cyl(0.215, 0.006, 'Light', z0=1.195, segments=16)
p.ball(0.022, 'Gilt', (0, 0, 1.55))

# ------------------------------------------------------------------ a palm in an urn
p = piece('Plant')
p.lathe([(0.12, 0), (0.12, 0.04), (0.09, 0.07), (0.17, 0.15), (0.23, 0.3), (0.21, 0.42), (0.17, 0.46), (0.21, 0.5)], 'Urn',
        segments=16)
p.cyl(0.19, 0.01, 'Dirt', z0=0.47, segments=14)
for k in range(9):
    a = k*2*math.pi/9 + random.uniform(-0.2, 0.2)
    rise, reach = random.uniform(1.0, 1.3), random.uniform(0.5, 0.7)
    pts = []
    for i in range(9):
        t = i/8
        out = reach*t
        pts.append(Vector((math.cos(a)*out, math.sin(a)*out, 0.48 + rise*(1.7*t - 1.1*t*t))))
    for i in range(8):
        p.bar(pts[i], pts[i + 1], 0.012, 'Stem', bevel=0)
    along = Vector((math.cos(a), math.sin(a), 0))
    side = Vector((-math.sin(a), math.cos(a), 0))
    for i in range(3, 9):
        base = pts[i]
        length = 0.2*(1 - (i - 3)/7)
        for s in (-1, 1):
            tip = base + side*s*length + along*0.05 - Vector((0, 0, length*0.5))
            p.hull([base, base + along*0.035, tip, tip + Vector((0, 0, 0.012))], 'Frond')

# ------------------------------------------------------------------ the coffee table: marble on a gilt frame
p = piece('Coffee Table')
CW, CD, CH = 1.2, 0.64, 0.44
p.box(CW, CD, 0.04, 'Marble', 0, 0, CH - 0.04, bevel=0.012)
p.box(CW - 0.06, CD - 0.06, 0.045, 'Gilt', 0, 0, CH - 0.085, bevel=0.006)
for x in (-CW/2 + 0.05, CW/2 - 0.05):
    for y in (-CD/2 + 0.05, CD/2 - 0.05):
        p.box(0.035, 0.035, CH - 0.06, 'Gilt', x, y, 0.02, bevel=0.006)
        p.ball(0.028, 'Gilt', (x, y, 0.02))
p.box(CW - 0.08, CD - 0.08, 0.02, 'Walnut', 0, 0, 0.1, bevel=0.005)
z = pile(p, -0.3, 0.02, CH, 3, 0.2)
p.ball(0.045, 'Gilt', (-0.3, 0.02, z + 0.03), scale=(1, 1, 0.7))
flowers(p, 0.33, -0.04, CH, 'Gilt', 0.14)
p.cyl(0.12, 0.02, 'Gilt', 0.05, 0.12, CH, r2=0.13, segments=16)                 # a tray, with a decanter on it
p.lathe([(0.04, 0), (0.05, 0.05), (0.03, 0.11), (0.012, 0.14), (0.02, 0.17)], 'Crystal', 0.05, 0.12, CH + 0.02, segments=10)

# ------------------------------------------------------------------ the Persian rug
p = piece('Rug')
RW, RD = 1.8, 1.15
p.box(RW, RD, 0.01, 'RugBorder', bevel=0)
p.box(RW - 0.08, RD - 0.08, 0.012, 'RugMotif', bevel=0)
p.box(RW - 0.1, RD - 0.1, 0.014, 'RugBorder', bevel=0)
p.box(RW - 0.3, RD - 0.3, 0.016, 'RugMotif', bevel=0)
p.box(RW - 0.32, RD - 0.32, 0.018, 'RugField', bevel=0)
# the border's own pattern, diamonds all round
for k in range(15):
    x = -RW/2 + 0.12 + k*(RW - 0.24)/14
    for y in (-RD/2 + 0.1, RD/2 - 0.1):
        p.hull([(x - 0.04, y, 0), (x + 0.04, y, 0), (x, y - 0.035, 0), (x, y + 0.035, 0),
                (x - 0.04, y, 0.016), (x + 0.04, y, 0.016), (x, y - 0.035, 0.016), (x, y + 0.035, 0.016)], 'RugMotif')
for k in range(9):
    y = -RD/2 + 0.12 + k*(RD - 0.24)/8
    for x in (-RW/2 + 0.1, RW/2 - 0.1):
        p.hull([(x - 0.035, y, 0), (x + 0.035, y, 0), (x, y - 0.04, 0), (x, y + 0.04, 0),
                (x - 0.035, y, 0.016), (x + 0.035, y, 0.016), (x, y - 0.04, 0.016), (x, y + 0.04, 0.016)], 'RugMotif')
# the medallion in the middle, a lozenge in a lozenge, and a pendant either end
def lozenge(rx, ry, z, mat, cx=0, sides=12):
    pts = []
    for k in range(sides):
        a = k*2*math.pi/sides
        c, s = math.cos(a), math.sin(a)
        pts += [(cx + rx*c*abs(c)**0.3, ry*s*abs(s)**0.3, 0), (cx + rx*c*abs(c)**0.3, ry*s*abs(s)**0.3, z)]
    p.hull(pts, mat)
lozenge(0.42, 0.3, 0.02, 'RugBorder')
lozenge(0.36, 0.25, 0.022, 'RugMotif')
lozenge(0.2, 0.14, 0.024, 'RugField')
lozenge(0.08, 0.06, 0.026, 'RugMotif')
for s in (-1, 1):
    lozenge(0.07, 0.06, 0.02, 'RugBorder', s*0.5, 8)
    for y in (-1, 1):                                                        # and the corners
        cx, cy = s*(RW/2 - 0.16), y*(RD/2 - 0.16)
        p.hull([(cx, cy, 0), (cx - s*0.28, cy, 0), (cx, cy - y*0.2, 0), (cx, cy, 0.02), (cx - s*0.28, cy, 0.02),
                (cx, cy - y*0.2, 0.02)], 'RugBorder')
for s in (-1, 1):                                                            # the fringe at either end
    for k in range(40):
        y = -RD/2 + 0.03 + k*(RD - 0.06)/39
        p.box(0.07, 0.008, 0.004, 'Fringe', s*(RW/2 + 0.03), y, 0, bevel=0)

# ------------------------------------------------------------------ the library bookcase
p = piece('Bookcase')
BW, BD, BH = 0.94, 0.38, 2.2
p.box(BW, BD, 0.1, 'Walnut', 0, 0, 0, bevel=0.01)                           # plinth
for x in (-BW/2 + 0.025, BW/2 - 0.025):
    p.box(0.05, BD, BH - 0.1, 'Walnut', x, 0, 0.1, bevel=0.008)
p.box(BW - 0.05, 0.02, BH - 0.1, 'Walnut', 0, BD/2 - 0.01, 0.1, bevel=0)
p.box(BW + 0.04, BD + 0.04, 0.05, 'Walnut', 0, -0.02, BH - 0.02, bevel=0.012)  # the cornice, stepped
p.box(BW + 0.02, BD + 0.02, 0.05, 'Walnut', 0, -0.01, BH - 0.07, bevel=0.01)
# a cupboard at the bottom, two doors with their knobs
p.box(BW - 0.08, BD - 0.02, 0.02, 'Walnut', 0, 0, 0.62, bevel=0.005)
for s in (-1, 1):
    p.box(BW/2 - 0.07, 0.015, 0.48, 'Walnut', s*(BW/4 - 0.015), -BD/2 + 0.005, 0.12, bevel=0.005)
    p.box(BW/2 - 0.15, 0.02, 0.38, 'Walnut', s*(BW/4 - 0.015), -BD/2 + 0.002, 0.17, bevel=0.012)
    p.ball(0.014, 'Gilt', (s*0.04, -BD/2 - 0.01, 0.38))
# and shelves above, full of leather-bound books, bar a globe, a bust and a pile or two
SHELVES = [0.64, 1.02, 1.4, 1.78]
for z in SHELVES[1:]:
    p.box(BW - 0.08, BD - 0.03, 0.025, 'Walnut', 0, 0.01, z - 0.025, bevel=0.004)
for i, z in enumerate(SHELVES):
    x, end = -BW/2 + 0.06, BW/2 - 0.06
    gap = [(-0.2, 0.05), (0.12, 0.38), (-0.4, -0.12), (0.05, 0.3)][i]
    while x < end - 0.03:
        if gap[0] <= x < gap[1]:
            x = gap[1]
            continue
        w, h = random.uniform(0.028, 0.05), random.uniform(0.24, 0.32)
        if x + w > end: break
        mat = random.choice(BOOKS)
        p.box(w, 0.22, h, mat, x + w/2, 0.02, z, bevel=0)
        if random.random() < 0.7:                                          # gilt bands across the spine
            for band in (0.035, h - 0.05):
                p.box(w + 0.002, 0.004, 0.01, 'Gilt', x + w/2, -0.092, z + band, bevel=0)
        x += w + 0.002
mid = lambda gap: (gap[0] + gap[1])/2
p.ball(0.1, 'Globe', (mid((0.12, 0.38)), 0, 1.02 + 0.18))
p.lathe([(0.06, 0), (0.06, 0.02), (0.015, 0.03), (0.015, 0.08)], 'Gilt', mid((0.12, 0.38)), 0, 1.02)
p.box(0.12, 0.12, 0.08, 'Marble', mid((-0.4, -0.12)), 0, 1.4, bevel=0.01)       # a bust on its plinth
p.hull([(-0.1, -0.05, 0.08), (0.1, -0.05, 0.08), (-0.1, 0.05, 0.08), (0.1, 0.05, 0.08), (-0.05, -0.03, 0.17),
        (0.05, -0.03, 0.17), (-0.05, 0.03, 0.17), (0.05, 0.03, 0.17)], 'Marble', (mid((-0.4, -0.12)), 0, 1.4))
p.ball(0.055, 'Marble', (mid((-0.4, -0.12)), 0, 1.64), scale=(0.85, 0.95, 1.1))
p.cyl(0.02, 0.04, 'Marble', mid((-0.4, -0.12)), 0, 1.57, segments=8)
pile(p, mid((-0.2, 0.05)), 0.02, 0.64, 4, 0.05)
pile(p, mid((0.05, 0.3)), 0.02, 1.78, 3, -0.1)

# ------------------------------------------------------------------ the chandelier (its top at the ceiling)
p = piece('Pendant')
PH = 0.95
p.cyl(0.09, 0.03, 'Gilt', z0=PH - 0.03, r2=0.07, segments=16)                 # ceiling rose
for k in range(8):                                                           # the chain, link by link
    z = PH - 0.05 - k*0.045
    p.box(0.022, 0.006 if k % 2 else 0.022, 0.04, 'Gilt', 0, 0, z - 0.04, bevel=0.003)
p.lathe([(0.02, 0.0), (0.05, 0.03), (0.07, 0.08), (0.04, 0.13), (0.02, 0.17), (0.05, 0.22), (0.02, 0.26),
         (0.03, 0.32), (0.015, 0.36), (0.015, 0.58)], 'Gilt', z0=0.02, segments=12)
def arms(n, reach, z, lift, offset=0.0):
    for k in range(n):
        a = k*2*math.pi/n + offset
        c, s = math.cos(a), math.sin(a)
        mid = (c*reach*0.6, s*reach*0.6, z - 0.06)
        end = (c*reach, s*reach, z + lift)
        p.bar((c*0.03, s*0.03, z), mid, 0.012, 'Gilt')
        p.bar(mid, end, 0.012, 'Gilt')
        p.cyl(0.032, 0.015, 'Gilt', end[0], end[1], end[2], r2=0.04, segments=10)
        p.cyl(0.011, 0.08, 'Candle', end[0], end[1], end[2] + 0.015, segments=8)
        p.ball(0.011, 'Light', (end[0], end[1], end[2] + 0.11), scale=(1, 1, 1.8))
        for d in (0.05, 0.1):                                                # crystals hanging from the arm
            p.ball(0.012, 'Crystal', (end[0], end[1], end[2] - d), scale=(1, 1, 1.6), detail=0)
arms(6, 0.36, 0.2, 0.1)
arms(4, 0.2, 0.44, 0.06, math.pi/4)
for k in range(12):                                                          # a ring of drops, and one at the bottom
    a = k*2*math.pi/12
    p.ball(0.014, 'Crystal', (math.cos(a)*0.2, math.sin(a)*0.2, 0.12), scale=(1, 1, 1.7), detail=0)
    p.bar((math.cos(a)*0.2, math.sin(a)*0.2, 0.14), (math.cos(a)*0.06, math.sin(a)*0.06, 0.1), 0.005, 'Crystal', bevel=0)
p.ball(0.03, 'Crystal', (0, 0, 0.0), scale=(1, 1, 1.8), detail=0)

# ------------------------------------------------------------------ the commode
p = piece('Drawers')
DW, DD = 1.0, 0.5
for x in (-DW/2 + 0.06, DW/2 - 0.06):
    for y in (-DD/2 + 0.06, DD/2 - 0.06):
        p.box(0.05, 0.05, 0.14, 'Walnut', x, y, 0, bevel=0.01, rot=(0.15*math.copysign(1, -y), 0.15*math.copysign(1, x), 0))
        p.box(0.055, 0.055, 0.025, 'Gilt', x + math.copysign(0.02, x), y - math.copysign(0.02, y), 0, bevel=0.006)
p.box(DW, DD, 0.64, 'Walnut', 0, 0, 0.13, bevel=0.02)
p.box(DW - 0.04, 0.05, 0.1, 'Walnut', 0, -DD/2 + 0.02, 0.1, bevel=0.02)          # its shaped apron
for i in range(3):
    z = 0.17 + i*0.195
    p.box(DW - 0.1, 0.03, 0.17, 'Walnut', 0, -DD/2 - 0.004, z, bevel=0.012)
    for x in (-0.24, 0.24):                                                    # a bail handle either side
        p.box(0.12, 0.012, 0.02, 'Gilt', x, -DD/2 - 0.03, z + 0.07, bevel=0.004)
        for e in (-0.055, 0.055): p.box(0.02, 0.02, 0.04, 'Gilt', x + e, -DD/2 - 0.022, z + 0.07, bevel=0.005)
    p.box(0.02, 0.008, 0.035, 'Gilt', 0, -DD/2 - 0.022, z + 0.07, bevel=0.003)   # and its keyhole
p.box(DW + 0.06, DD + 0.05, 0.03, 'Marble', 0, -0.01, 0.77, bevel=0.01)
clock(p, 0, 0.02, 0.8)
candlestick(p, -0.4, 0.05, 0.8)
flowers(p, 0.36, 0.02, 0.8)

# ------------------------------------------------------------------ the fireplace, with a mirror over it
p = piece('Fireplace')
FW = 0.98
p.box(FW, 0.44, 0.04, 'Marble', 0, -0.06, 0, bevel=0.008)                     # the hearth
for s in (-1, 1):                                                              # the pilasters
    p.box(0.15, 0.2, 0.96, 'Marble', s*(FW/2 - 0.1), 0.04, 0.04, bevel=0.012)
    p.box(0.18, 0.23, 0.05, 'Marble', s*(FW/2 - 0.1), 0.04, 0.04, bevel=0.01)
    p.box(0.1, 0.012, 0.6, 'Marble', s*(FW/2 - 0.1), -0.065, 0.2, bevel=0.004)
p.box(FW - 0.02, 0.2, 0.2, 'Marble', 0, 0.04, 0.82, bevel=0.012)              # the frieze
p.box(FW, 0.28, 0.05, 'Marble', 0, 0.01, 1.02, bevel=0.012)                    # and the mantel shelf
p.box(FW - 0.36, 0.1, 0.78, 'Soot', 0, 0.1, 0.04, bevel=0)                     # the firebox
p.box(FW - 0.36, 0.2, 0.02, 'Soot', 0, 0.04, 0.04, bevel=0)
for k in range(5):                                                             # the grate
    p.box(0.012, 0.012, 0.18, 'Hands', -0.2 + k*0.1, -0.02, 0.06, bevel=0)
p.box(0.46, 0.14, 0.02, 'Hands', 0, 0.04, 0.12, bevel=0)
for a, dx in ((0.3, -0.05), (-0.25, 0.06), (0.05, 0.0)):                        # logs
    p.cyl(0.04, 0.34, 'Log', -0.17 + dx, 0.03 + a*0.1, 0.16 + (0.06 if dx == 0 else 0), segments=8, rot=(0, math.pi/2, a))
for k in range(7):                                                             # and the fire
    x = -0.15 + k*0.05
    h = 0.1 + 0.12*math.sin(k*1.9)**2
    p.hull([(x - 0.035, 0.0, 0.2), (x + 0.035, 0.0, 0.2), (x - 0.02, 0.07, 0.2), (x + 0.02, 0.07, 0.2),
            (x + 0.01*(k % 3 - 1), 0.03, 0.2 + h)], 'Fire')
p.box(0.8, 0.04, 1.06, 'Gilt', 0, 0.12, 1.12, bevel=0.012)                    # the mirror, in its frame
p.box(0.68, 0.01, 0.9, 'Mirror', 0, 0.098, 1.2, bevel=0)
p.ball(0.07, 'Gilt', (0, 0.11, 2.18), scale=(1.4, 0.4, 0.9))
clock(p, 0, 0.0, 1.07)
candlestick(p, -0.36, 0.02, 1.07)
candlestick(p, 0.36, 0.02, 1.07)

# ------------------------------------------------------------------ the grand piano (its keyboard to the front), and its bench
p = piece('Piano')
# the case's outline, anticlockwise from the keyboard's left end: the straight side down the left, round the tail, and
# back up the bentside to the right
OUTLINE = [(-0.74, -0.8), (0.74, -0.8), (0.74, -0.3)]
for k in range(1, 9):
    t = k/8
    OUTLINE.append((0.74 - 0.5*t*t, -0.3 + 0.75*t))                                 # the bentside, curving in
for k in range(1, 7):
    a = k/6*math.pi/2
    OUTLINE.append((-0.25 + 0.49*math.cos(a), 0.45 + 0.5*math.sin(a)))              # round the tail
OUTLINE.append((-0.74, 0.95))
CASE_Z, CASE_H = 0.62, 0.3
p.prism(OUTLINE, CASE_H, 'Lacquer', CASE_Z)
# the rim above the soundboard, and the gilt plate and strings in it
TOP = CASE_Z + CASE_H
for (x0, y0), (x1, y1) in zip(OUTLINE, OUTLINE[1:] + OUTLINE[:1]):
    if y0 == y1 == -0.8: continue
    p.bar((x0, y0, TOP + 0.04), (x1, y1, TOP + 0.04), 0.045, 'Lacquer', bevel=0)
p.prism([((x*0.93 - 0.01), y*0.92 + 0.02) for x, y in OUTLINE], 0.005, 'Soundboard', TOP)
p.prism([((x*0.8 - 0.02), y*0.8 + 0.0) for x, y in OUTLINE], 0.02, 'Gilt', TOP)
for k in range(24):
    x = -0.66 + k*0.058
    far = max([y for ox, y in OUTLINE if ox >= x - 0.05] + [-0.3]) - 0.1
    p.bar((x, -0.72, TOP + 0.03), (x + 0.02, min(far, 0.9), TOP + 0.03), 0.004, 'Steel', bevel=0)
# the lid, hinged along the straight side and propped up over the bentside
LID = 0.5
def lift(bm):
    bmesh.ops.translate(bm, vec=Vector((0.76, 0, -(TOP + 0.065))), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Euler((0, -LID, 0)).to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((-0.76, 0, TOP + 0.065)), verts=bm.verts)
p.prism([(x, max(y, -0.62)) for x, y in OUTLINE], 0.018, 'Lacquer', TOP + 0.065, lift)
d = 1.2
p.bar((-0.76 + d*math.cos(LID), 0.2, TOP + 0.06), (-0.76 + d*math.cos(LID), 0.2, TOP + 0.065 + d*math.sin(LID)), 0.018, 'Lacquer')
# the keyboard
p.box(1.56, 0.34, 0.1, 'Lacquer', 0, -0.93, CASE_Z, bevel=0.01)
for s in (-1, 1):
    p.box(0.08, 0.34, 0.16, 'Lacquer', s*0.74, -0.93, CASE_Z, bevel=0.015)
p.box(1.4, 0.06, 0.16, 'Lacquer', 0, -0.8, CASE_Z + 0.1, bevel=0.01)
KEYS = 52
for k in range(KEYS):
    x = -0.69 + (k + 0.5)*1.38/KEYS
    p.box(1.38/KEYS - 0.002, 0.15, 0.022, 'Ivory', x, -0.99, CASE_Z + 0.1, bevel=0)
    if k % 7 in (0, 1, 3, 4, 5) and k < KEYS - 1:
        p.box(0.014, 0.09, 0.02, 'Ebony', x + 1.38/KEYS/2, -0.955, CASE_Z + 0.12, bevel=0)
p.box(0.7, 0.02, 0.26, 'Lacquer', 0, -0.72, TOP + 0.04, bevel=0.006, rot=(-0.25, 0, 0))   # the music desk
p.box(0.42, 0.01, 0.28, 'Paper', 0, -0.735, TOP + 0.06, bevel=0, rot=(-0.25, 0, 0))
# three legs, on casters, and the pedals in their lyre
for x, y in ((-0.64, -0.72), (0.64, -0.72), (-0.46, 0.78)):
    p.box(0.11, 0.11, CASE_Z - 0.06, 'Lacquer', x, y, 0.05, bevel=0.015)
    p.box(0.14, 0.14, 0.06, 'Lacquer', x, y, CASE_Z - 0.06, bevel=0.015)
    p.ball(0.03, 'Gilt', (x, y, 0.03))
p.box(0.05, 0.04, CASE_Z - 0.08, 'Lacquer', -0.08, -0.62, 0.08, bevel=0.008)
p.box(0.05, 0.04, CASE_Z - 0.08, 'Lacquer', 0.08, -0.62, 0.08, bevel=0.008)
p.box(0.26, 0.12, 0.06, 'Lacquer', 0, -0.64, 0.04, bevel=0.01)
for x in (-0.06, 0, 0.06):
    p.box(0.03, 0.1, 0.012, 'Gilt', x, -0.72, 0.07, bevel=0.003)

p = piece('PianoBench')
for x in (-0.33, 0.33):
    for y in (-0.13, 0.13):
        p.box(0.04, 0.04, 0.44, 'Lacquer', x, y, 0, bevel=0.008)
p.box(0.78, 0.34, 0.06, 'Lacquer', 0, 0, 0.42, bevel=0.01)
p.box(0.74, 0.3, 0.05, 'Velvet', 0, 0, 0.47, bevel=0.02)

# ------------------------------------------------------------------ paintings, to hang
def frame(p, w, h):
    p.box(w, 0.04, h, 'Gilt', 0, 0.02, 0, bevel=0.01)
    for z0, bh in ((0, 0.06), (h - 0.06, 0.06)):
        p.box(w, 0.02, bh, 'Gilt', 0, -0.01, z0, bevel=0.008)
    for s in (-1, 1):
        p.box(0.06, 0.02, h, 'Gilt', s*(w/2 - 0.03), -0.01, 0, bevel=0.008)
    return w - 0.12, h - 0.12
p = piece('Painting')                                                          # a landscape
cw, ch = frame(p, 1.0, 0.76)
p.box(cw, 0.01, ch, 'PaintSky', 0, -0.005, 0.06, bevel=0)
p.hull([(-cw/2, -0.012, 0.06), (cw/2, -0.012, 0.06), (-cw/2, -0.012, 0.06 + ch*0.45), (-cw*0.1, -0.012, 0.06 + ch*0.62),
        (cw*0.2, -0.012, 0.06 + ch*0.5), (cw/2, -0.012, 0.06 + ch*0.56), (-cw/2, -0.01, 0.06), (cw/2, -0.01, 0.06)], 'PaintHill')
p.hull([(-cw/2, -0.016, 0.06), (cw/2, -0.016, 0.06), (-cw/2, -0.016, 0.06 + ch*0.28), (cw/2, -0.016, 0.06 + ch*0.36),
        (-cw/2, -0.012, 0.06), (cw/2, -0.012, 0.06)], 'PaintLand')
for x, s in ((-0.22, 1.0), (-0.14, 0.7), (0.26, 0.85)):                        # trees
    base = 0.06 + ch*0.3
    p.box(0.012, 0.004, 0.1*s, 'PaintDark', x, -0.02, base, bevel=0)
    p.ball(0.06*s, 'PaintHill', (x, -0.02, base + 0.12*s), scale=(0.9, 0.1, 1.2))
p = piece('Portrait')                                                          # and a portrait
cw, ch = frame(p, 0.7, 0.9)
p.box(cw, 0.01, ch, 'PaintDark', 0, -0.005, 0.06, bevel=0)
p.hull([(-cw*0.4, -0.012, 0.06), (cw*0.4, -0.012, 0.06), (-cw*0.3, -0.012, 0.06 + ch*0.3), (cw*0.3, -0.012, 0.06 + ch*0.3),
        (-cw*0.1, -0.012, 0.06 + ch*0.42), (cw*0.1, -0.012, 0.06 + ch*0.42), (0, -0.01, 0.06)], 'PaintFigure')
p.ball(0.1, 'PaintSkin', (0, -0.014, 0.06 + ch*0.6), scale=(0.8, 0.1, 1.05))
p.ball(0.11, 'PaintFigure', (0, -0.012, 0.06 + ch*0.68), scale=(0.9, 0.1, 0.8))

# ------------------------------------------------------------------ out
export(OUT)
