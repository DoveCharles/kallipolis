# Builds assets/models/Pub.glb: the pieces a pub is fitted out from (see "a pub" in src/buildings/interior.js), in the
# same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/pub-models.py
#
# The bar: a panelled Bar counter with handpulls, a keg font and a brass foot rail, the BackBar behind it (a mirrored
# gantry of bottles and optics over glass-fronted fridges), and BarStools. Seating: a BoothBench (high-backed, one of a
# pair either side of a BoothTable), a button-backed Settle to go along a wall, captain's Chairs, low Stools, a round
# cast-iron Table and a square one (Table2), and a Barrel to stand at. And: a Fireplace, a Dartboard in its cabinet, a
# FruitMachine, a Chalkboard, hunting prints (Picture) and a brewery mirror (Mirror) for the walls, a brass WallLamp,
# a Pendant to hang, and a Pint to stand on the tables.
# Like Interior.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported). Built in metres, life size, and scaled up at the end. Wall-hung pieces (Dartboard, Chalkboard, Picture,
# Mirror, WallLamp) stand on their own bottom edge; interior.js lifts them up the wall.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Pub.glb')
random.seed(47)

# (the ones interior.js recolours for each pub are Oak, Upholstery, Leather and Tile; Light, Fire and the Glow ones glow
# as they are)
material('Oak', 0x5a3a22, 0.6)
material('OakDark', 0x6a4a30, 0.6)
material('Top', 0x5e3e28, 0.35)
material('Upholstery', 0x7a1e22, 0.9)
material('Leather', 0x6a2a1a, 0.5)
material('Tile', 0x2a5a4a, 0.3)
material('Brass', 0xc8a050, 0.3, 0.7)
material('Iron', 0x1e1e20, 0.6, 0.3)
material('Chrome', 0xc8ccd0, 0.25, 0.8)
material('Mirror', 0x9aa4a8, 0.08, 0.9)
material('Stone', 0x8a8478, 0.9)
material('Slate', 0x2a2e30, 0.8)
material('Chalk', 0xeeeee6, 0.9)
material('Cream', 0xe8e0c8, 0.8)
material('Red', 0xa82a24, 0.6)
material('Green', 0x2a6a3a, 0.6)
material('Black', 0x141416, 0.6)
material('Cork', 0xc8a878, 0.9)
material('Beer', 0xb8741e, 0.2)
material('Stout', 0x1a100a, 0.2)
material('Head', 0xf2ead8, 0.8)
material('Towel', 0xe8e0cc, 1.0)
material('Canvas', 0x5a7a4a, 0.9)
material('Canvas2', 0x8a9a6a, 0.9)
material('Horse', 0x6a3a1e, 0.8)
material('Coat', 0xa8241e, 0.8)
material('Gilt', 0xb8923a, 0.35, 0.6)
material('Light', 0x000000, 1.0, glow=0xffd8a0)
material('Fire', 0x000000, 1.0, glow=0xff7a20)
material('GlowFridge', 0x2a3a40, 0.2, glow=0x8ab0c0)
material('GlowMachine', 0x2a1a3a, 0.3, glow=0xe8a040)
material('GlowReels', 0xe8e0d0, 0.3, glow=0xa09880)
for i, colour in enumerate((0x2a5a2a, 0x6a3a14, 0xd8d0b0, 0xa8601a, 0x3a1a2a, 0x2a3a6a, 0xc8a040, 0x8a1a1a)):
    material('Bottle%d' % i, colour, 0.15)
BOTTLES = ['Bottle%d' % i for i in range(8)]

# ------------------------------------------------------------------ building blocks
# a panel of oak w wide and h high on the face of something, at y (its face) and centred on x, standing on z0: a flat
# field with a raised moulding round it
def panel(p, w, h, x, y, z0, mat='Oak', out=-1):
    p.box(w, 0.012, h, 'OakDark', x, y + out*0.006, z0, bevel=0.002)
    p.box(w - 0.08, 0.02, h - 0.08, mat, x, y + out*0.012, z0 + 0.04, bevel=0.006)

# a turned leg from z0 up to z1 at (x, y)
def turned_leg(p, x, y, z0, z1, r=0.022, mat='Oak'):
    h = z1 - z0
    p.lathe([(r*0.8, 0), (r, h*0.1), (r*0.75, h*0.3), (r*1.2, h*0.45), (r*0.8, h*0.6), (r*1.05, h*0.9), (r*1.1, h)], mat, x, y, z0, segments=8)

# a pint of beer (or stout) standing on z0 at (x, y)
def pint(p, x, y, z0, stout=False):
    p.cyl(0.036, 0.13, 'Stout' if stout else 'Beer', x, y, z0, r2=0.043, segments=12)
    p.cyl(0.043, 0.018, 'Head', x, y, z0 + 0.13, r2=0.044, segments=12)

# a bottle standing on z0 at (x, y), of height h
def bottle(p, x, y, z0, h=0.28, mat=None):
    mat = mat or random.choice(BOTTLES)
    p.lathe([(0.035, 0), (0.037, h*0.62), (0.014, h*0.8), (0.012, h*0.96), (0.015, h)], mat, x, y, z0, segments=8)

# ------------------------------------------------------------------ the bar
BAR_L, BAR_D, BAR_H = 3.6, 0.62, 1.07
p = piece('Bar')
p.box(BAR_L, BAR_D - 0.1, 0.1, 'OakDark', 0, 0.02, 0, bevel=0.01)                  # plinth
p.box(BAR_L, BAR_D - 0.12, BAR_H - 0.16, 'Oak', 0, 0.03, 0.1, bevel=0.01)          # carcass
front = -(BAR_D - 0.12)/2 + 0.03
n = 6
for i in range(n):                                                                  # panelled front
    x = -BAR_L/2 + (i + 0.5)*BAR_L/n
    panel(p, BAR_L/n - 0.06, 0.62, x, front, 0.2)
p.box(BAR_L, 0.04, 0.05, 'OakDark', 0, front - 0.02, BAR_H - 0.16, bevel=0.008)   # moulding under the top
p.box(BAR_L + 0.08, BAR_D, 0.06, 'Top', 0, 0, BAR_H - 0.06, bevel=0.015)            # the top, overhanging the front
p.box(BAR_L - 0.2, 0.18, 0.006, 'Towel', 0, -0.12, BAR_H, bevel=0.002)              # a bar towel along it
for x in (-BAR_L/2 + 0.2, -0.6, 0.6, BAR_L/2 - 0.2):                                # the foot rail, on brackets
    p.bar((x, front - 0.02, 0.1), (x, front - 0.2, 0.2), 0.025, 'Brass')
p.cyl(0.024, BAR_L - 0.3, 'Brass', -BAR_L/2 + 0.15, front - 0.2, 0.2, segments=10, rot=(0, math.pi/2, 0))
# handpulls: a row of pumps along the back of the top, each with a clip on its handle
for k, x in enumerate((-1.2, -1.0, -0.8, -0.6)):
    y = 0.14
    p.cyl(0.03, 0.05, 'Chrome', x, y, BAR_H, segments=10)
    p.cyl(0.018, 0.05, 'Brass', x, y, BAR_H + 0.05, segments=8)
    p.bar((x, y, BAR_H + 0.09), (x, y - 0.03, BAR_H + 0.38), 0.028, 'OakDark')    # the handle, leant back
    p.box(0.06, 0.012, 0.075, random.choice(['Red', 'Green', 'Cream', 'Black']), x, y - 0.045, BAR_H + 0.25, bevel=0.004, rot=(-0.1, 0, 0))
    p.cyl(0.012, 0.08, 'Chrome', x, y - 0.05, BAR_H + 0.03, segments=6, rot=(math.pi/2, 0, 0))  # the swan neck
# a keg font: a T-bar with three taps
fx = 0.6
p.cyl(0.025, 0.3, 'Chrome', fx, 0.12, BAR_H, segments=10)
p.cyl(0.03, 0.5, 'Chrome', fx - 0.25, 0.12, BAR_H + 0.3, segments=10, rot=(0, math.pi/2, 0))
for x in (fx - 0.18, fx, fx + 0.18):
    p.box(0.07, 0.02, 0.06, random.choice(['Red', 'Green', 'Black']), x, 0.1, BAR_H + 0.35, bevel=0.005)
    p.cyl(0.01, 0.07, 'Chrome', x, 0.12, BAR_H + 0.22, segments=6)
p.box(0.34, 0.14, 0.02, 'Chrome', fx, 0.12, BAR_H, bevel=0.004)                     # its drip tray
pint(p, 1.3, -0.1, BAR_H)
pint(p, -0.2, -0.16, BAR_H, stout=True)

# the back bar: fridges and cupboards under a counter, then a mirrored gantry of bottle shelves and optics
BB_L, BB_D, BB_H = 3.6, 0.45, 2.3
p = piece('BackBar')
p.box(BB_L, BB_D - 0.04, 0.08, 'OakDark', 0, 0.02, 0, bevel=0.008)
p.box(BB_L, BB_D - 0.06, 0.82, 'Oak', 0, 0.02, 0.08, bevel=0.01)
dy = -(BB_D - 0.06)/2 + 0.02
for i in range(4):
    x = -BB_L/2 + (i + 0.5)*BB_L/4
    if i in (1, 2):                                                                 # glass-fronted fridges
        p.box(BB_L/4 - 0.08, 0.02, 0.66, 'Chrome', x, dy - 0.01, 0.14, bevel=0.004)
        p.box(BB_L/4 - 0.14, 0.02, 0.6, 'GlowFridge', x, dy - 0.02, 0.17, bevel=0.002)
        for s in (0.24, 0.5):
            for b in range(6):
                bottle(p, x - 0.3 + b*0.12, dy + 0.1, s, 0.2)
    else:
        panel(p, BB_L/4 - 0.08, 0.66, x, dy, 0.14)
p.box(BB_L + 0.04, BB_D, 0.05, 'Top', 0, 0, 0.9, bevel=0.012)                       # the counter
p.box(0.34, 0.26, 0.2, 'Black', -1.2, 0, 0.95, bevel=0.02)                          # a till
p.box(0.3, 0.02, 0.12, 'GlowFridge', -1.2, -0.13, 1.05, bevel=0.004, rot=(0.4, 0, 0))
for b in range(5):                                                                  # glasses upside down on a mat
    p.cyl(0.036, 0.13, 'Mirror', 0.7 + b*0.1, 0.02, 0.95, r2=0.043, segments=10)
# the gantry: uprights, a mirror behind, two shelves of bottles, and optics along the bottom
p.box(BB_L, 0.03, BB_H - 0.95, 'Mirror', 0, BB_D/2 - 0.03, 0.95, bevel=0.002)
for x in (-BB_L/2 + 0.04, -BB_L/6, BB_L/6, BB_L/2 - 0.04):
    p.box(0.07, 0.24, BB_H - 0.95, 'Oak', x, BB_D/2 - 0.14, 0.95, bevel=0.01)
for z in (1.45, 1.85):
    p.box(BB_L, 0.2, 0.03, 'Oak', 0, BB_D/2 - 0.13, z, bevel=0.006)
    x = -BB_L/2 + 0.12
    while x < BB_L/2 - 0.12:
        if all(abs(x - u) > 0.06 for u in (-BB_L/6, BB_L/6)):
            bottle(p, x, BB_D/2 - 0.13, z + 0.03, random.uniform(0.24, 0.34))
        x += random.uniform(0.08, 0.11)
for k in range(8):                                                                  # optics: bottles hung upside down
    x = -1.3 + k*0.23
    if any(abs(x - u) < 0.08 for u in (-BB_L/6, BB_L/6)): continue
    p.box(0.012, 0.03, 0.4, 'Chrome', x, BB_D/2 - 0.08, 1.02, bevel=0)
    bm_z = 1.12
    p.lathe([(0.012, 0), (0.015, 0.04), (0.035, 0.1), (0.037, 0.3)], random.choice(BOTTLES), x, BB_D/2 - 0.13, bm_z, segments=8)
    p.cyl(0.018, 0.06, 'Chrome', x, BB_D/2 - 0.13, bm_z - 0.06, segments=8)
p.box(BB_L + 0.1, BB_D - 0.05, 0.1, 'OakDark', 0, 0.02, BB_H - 0.1, bevel=0.01)    # the cornice
p.box(BB_L + 0.16, BB_D, 0.04, 'Oak', 0, 0.0, BB_H - 0.04, bevel=0.01)

# ------------------------------------------------------------------ seats
p = piece('BarStool')                                                               # 0.76 to the top of its seat
SH = 0.76
for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
    p.bar((sx*0.17, sy*0.17, 0), (sx*0.12, sy*0.12, SH - 0.06), 0.03, 'Oak')
for sx, sy, ex, ey in ((1, 1, 1, -1), (1, -1, -1, -1), (-1, -1, -1, 1), (-1, 1, 1, 1)):
    p.bar((sx*0.155, sy*0.155, 0.26), (ex*0.155, ey*0.155, 0.26), 0.022, 'Brass')   # a foot ring
p.cyl(0.17, 0.035, 'Oak', z0=SH - 0.075, segments=14)
p.cyl(0.18, 0.05, 'Leather', z0=SH - 0.045, r2=0.16, segments=14)

p = piece('Stool')
LS = 0.47
for a in range(3):
    t = a*2*math.pi/3
    p.bar((0.17*math.cos(t), 0.17*math.sin(t), 0), (0.12*math.cos(t), 0.12*math.sin(t), LS - 0.06), 0.03, 'Oak')
p.cyl(0.18, 0.035, 'Oak', z0=LS - 0.08, segments=14)
p.cyl(0.18, 0.06, 'Upholstery', z0=LS - 0.05, r2=0.16, segments=14)

# a captain's chair: a round-fronted seat, legs splayed, a curved rail round the back on spindles
p = piece('Chair')
CS = 0.46
for sx, sy in ((1, -1), (-1, -1), (1, 1), (-1, 1)):
    p.bar((sx*0.23, sy*0.21, 0), (sx*0.19, sy*0.17, CS - 0.05), 0.035, 'Oak')
p.box(0.46, 0.44, 0.05, 'Oak', 0, 0.01, CS - 0.07, bevel=0.015)
p.box(0.42, 0.38, 0.05, 'Upholstery', 0, -0.01, CS - 0.03, bevel=0.018)
rail = []
for k in range(9):                                                                  # the curved rail, round the back
    t = math.pi*(k/8)
    rail.append((0.26*math.cos(t), 0.08 + 0.17*math.sin(t)))
for (x0, y0), (x1, y1) in zip(rail, rail[1:]):
    p.bar((x0, y0, 0.74), (x1, y1, 0.74), 0.04, 'Oak')
for k in range(1, 8):
    x, y = rail[k]
    p.bar((x*0.9, y*0.95, CS - 0.02), (x, y, 0.73), 0.018, 'Oak')
p.box(0.08, 0.3, 0.035, 'Oak', 0.25, -0.07, 0.72, bevel=0.01)                        # arms
p.box(0.08, 0.3, 0.035, 'Oak', -0.25, -0.07, 0.72, bevel=0.01)
p.bar((0.25, -0.2, CS - 0.02), (0.25, -0.2, 0.72), 0.025, 'Oak')
p.bar((-0.25, -0.2, CS - 0.02), (-0.25, -0.2, 0.72), 0.025, 'Oak')

# a settle to go along a wall: an upholstered, button-backed bench in an oak frame, low enough to go under a window
p = piece('Settle')
SL, SD, SS = 1.7, 0.55, 0.46
p.box(SL, SD - 0.05, SS - 0.1, 'Oak', 0, 0.02, 0, bevel=0.01)
for i in range(4):
    panel(p, SL/4 - 0.05, SS - 0.18, -SL/2 + (i + 0.5)*SL/4, -(SD - 0.05)/2 + 0.02, 0.05)
p.box(SL - 0.04, SD - 0.08, 0.1, 'Upholstery', 0, 0.0, SS - 0.1, bevel=0.03, segments=2)
p.box(SL, 0.08, 0.86, 'Oak', 0, SD/2 - 0.04, 0, bevel=0.01)
p.box(SL - 0.1, 0.1, 0.36, 'Upholstery', 0, SD/2 - 0.12, SS, bevel=0.04, segments=2)
for i in range(7):                                                                  # its buttons
    for j in range(2):
        p.ball(0.012, 'Leather', (-SL/2 + 0.14 + i*(SL - 0.28)/6 + j*0.1, SD/2 - 0.175, SS + 0.1 + j*0.15))
for x in (-SL/2 + 0.03, SL/2 - 0.03):                                               # ends
    p.box(0.06, SD, 0.66, 'Oak', x, 0, 0, bevel=0.01)

# a booth's bench: high-backed, panelled behind, to go either side of a BoothTable facing the other
p = piece('BoothBench')
BL, BD = 1.3, 0.6
p.box(BL, BD - 0.1, SS - 0.1, 'Oak', 0, 0.0, 0, bevel=0.01)
p.box(BL - 0.04, BD - 0.14, 0.1, 'Upholstery', 0, -0.02, SS - 0.1, bevel=0.03, segments=2)
p.box(BL, 0.08, 1.35, 'Oak', 0, BD/2 - 0.08, 0, bevel=0.01)
p.box(BL - 0.1, 0.1, 0.5, 'Upholstery', 0, BD/2 - 0.16, SS, bevel=0.04, segments=2)
for i in range(3):                                                                  # panels above, and on its back
    panel(p, BL/3 - 0.05, 0.36, -BL/2 + (i + 0.5)*BL/3, BD/2 - 0.12, 0.96)
    panel(p, BL/3 - 0.05, 1.1, -BL/2 + (i + 0.5)*BL/3, BD/2 - 0.04, 0.12, out=1)
p.box(BL + 0.06, 0.14, 0.05, 'OakDark', 0, BD/2 - 0.08, 1.35, bevel=0.01)          # a capping rail
for x in (-BL/2 + 0.03, BL/2 - 0.03):
    p.box(0.06, BD, 0.7, 'Oak', x, 0, 0, bevel=0.01)

p = piece('BoothTable')
TW, TD, TH = 1.2, 0.7, 0.74
p.box(TW, TD, 0.045, 'Top', 0, 0, TH - 0.045, bevel=0.012)
p.box(TW - 0.12, TD - 0.12, 0.08, 'Oak', 0, 0, TH - 0.125, bevel=0.008)
for sx in (1, -1):
    for sy in (1, -1):
        turned_leg(p, sx*(TW/2 - 0.1), sy*(TD/2 - 0.1), 0, TH - 0.045, 0.028)

# ------------------------------------------------------------------ tables
p = piece('Table')                                                                  # round, on a cast-iron tripod
RT = 0.72
for a in range(3):
    t = a*2*math.pi/3 + math.pi/6
    p.hull([(0, 0, 0.18), (0, 0, 0.26), (0.3*math.cos(t), 0.3*math.sin(t), 0), (0.3*math.cos(t), 0.3*math.sin(t), 0.04),
            (0.02*math.cos(t + 1.5), 0.02*math.sin(t + 1.5), 0.2), (0.02*math.cos(t - 1.5), 0.02*math.sin(t - 1.5), 0.2)], 'Iron')
p.lathe([(0.045, 0.2), (0.03, 0.3), (0.035, 0.5), (0.025, 0.6), (0.06, RT - 0.08), (0.06, RT - 0.04)], 'Iron', segments=10)
p.cyl(0.35, 0.04, 'Top', z0=RT - 0.04, segments=20)
p.cyl(0.352, 0.012, 'Brass', z0=RT - 0.03, segments=20)

p = piece('Table2')                                                                 # square, on turned legs
QW = 0.76
p.box(QW, QW, 0.045, 'Top', 0, 0, RT - 0.045, bevel=0.012)
p.box(QW - 0.1, QW - 0.1, 0.08, 'Oak', 0, 0, RT - 0.125, bevel=0.008)
for sx in (1, -1):
    for sy in (1, -1):
        turned_leg(p, sx*(QW/2 - 0.08), sy*(QW/2 - 0.08), 0, RT - 0.045)

p = piece('Barrel')                                                                 # an old barrel, to stand at
BR, BH = 0.3, 0.95
prof = [(BR*0.85, 0), (BR, BH*0.3), (BR*1.05, BH*0.5), (BR, BH*0.7), (BR*0.85, BH - 0.02)]
p.lathe(prof, 'Oak', segments=16)
for z, r in ((0.08, BR*0.9), (0.3, BR*1.01), (BH - 0.3, BR*1.01), (BH - 0.1, BR*0.9)):
    p.cyl(r + 0.006, 0.04, 'Iron', z0=z - 0.02, segments=16)
p.cyl(0.4, 0.045, 'Top', z0=BH - 0.02, segments=18)
for k in range(6):                                                                  # staves
    t = k*math.pi/3
    p.bar((BR*0.86*math.cos(t), BR*0.86*math.sin(t), 0.01), (BR*1.05*math.cos(t), BR*1.05*math.sin(t), BH*0.5), 0.012, 'OakDark')

# ------------------------------------------------------------------ fireplace, darts, the fruit machine
p = piece('Fireplace')
FW, FD, FH = 1.4, 0.34, 1.2
p.box(FW + 0.3, 0.5, 0.05, 'Stone', 0, -0.1, 0, bevel=0.008)                        # the hearth
p.box(FW, FD, FH, 'Oak', 0, 0.05, 0.05, bevel=0.01)
for x in (-FW/2 + 0.12, FW/2 - 0.12):                                               # pilasters
    p.box(0.16, 0.06, FH - 0.1, 'OakDark', x, -FD/2 + 0.02, 0.05, bevel=0.008)
p.box(FW + 0.14, FD + 0.1, 0.06, 'Oak', 0, 0.02, FH + 0.05, bevel=0.012)            # the mantel shelf
p.box(0.72, 0.03, 0.8, 'Tile', 0, -FD/2 + 0.035, 0.05, bevel=0.002)                 # tiles round the grate
p.box(0.46, 0.04, 0.58, 'Iron', 0, -FD/2 + 0.03, 0.05, bevel=0.01)                 # the cast-iron insert
p.cyl(0.23, 0.04, 'Iron', 0, -FD/2 + 0.03, 0.62, segments=16, rot=(math.pi/2, 0, 0))
p.box(0.34, 0.04, 0.4, 'Black', 0, -FD/2 + 0.01, 0.1, bevel=0.005)
p.box(0.3, 0.14, 0.1, 'Iron', 0, -FD/2 - 0.03, 0.12, bevel=0.005)                   # the grate
for k in range(7):                                                                  # coals, glowing
    p.ball(0.045, 'Fire', (random.uniform(-0.12, 0.12), -FD/2 - 0.03, 0.22 + random.uniform(0, 0.05)), detail=0)
for x in (-0.35, 0.35):                                                             # a brass fender
    p.box(0.04, 0.28, 0.08, 'Brass', x, -FD/2 - 0.16, 0.05, bevel=0.008)
p.box(0.74, 0.04, 0.08, 'Brass', 0, -FD/2 - 0.3, 0.05, bevel=0.008)
for x in (-0.55, 0.55):                                                             # candlesticks on the mantel
    p.lathe([(0.05, 0), (0.015, 0.03), (0.02, 0.15), (0.03, 0.17)], 'Brass', x, 0.02, FH + 0.11, segments=8)
    p.cyl(0.015, 0.12, 'Cream', x, 0.02, FH + 0.28, segments=8)
p.box(0.22, 0.1, 0.24, 'OakDark', 0, 0.04, FH + 0.11, bevel=0.02)                    # a clock
p.cyl(0.075, 0.02, 'Cream', 0, -0.02, FH + 0.23, segments=14, rot=(math.pi/2, 0, 0))

p = piece('Dartboard')                                                              # its cabinet open, and a scoreboard
DB = 0.48
p.box(0.6, 0.08, 0.64, 'Oak', 0, 0.04, 0, bevel=0.01)
for x in (-0.46, 0.46):                                                             # its doors, open
    p.box(0.32, 0.03, 0.64, 'Oak', x, -0.02, 0, bevel=0.006)
    p.box(0.26, 0.02, 0.56, 'Slate', x, -0.035, 0.04, bevel=0.002)
p.box(0.07, 0.006, 0.4, 'Chalk', -0.5, -0.046, 0.12, bevel=0)
p.box(0.05, 0.006, 0.3, 'Chalk', 0.42, -0.046, 0.2, bevel=0)
cy, cz = -0.01, 0.32
for r, mat, d in ((0.225, 'Black', 0.02), (0.2, 'Cork', 0.03), (0.17, 'Black', 0.035), (0.16, 'Cream', 0.037),
                  (0.1, 'Red', 0.04), (0.09, 'Black', 0.041), (0.02, 'Green', 0.043), (0.008, 'Red', 0.045)):
    p.cyl(r, d, mat, 0, cy + 0.01, cz, segments=20, rot=(math.pi/2, 0, 0))
for k in range(10):                                                                 # the cream segments, every other one black
    t = k*math.pi/10*2
    p.hull([(0.1*math.cos(t), cy - 0.04, cz + 0.1*math.sin(t)), (0.16*math.cos(t), cy - 0.04, cz + 0.16*math.sin(t)),
            (0.16*math.cos(t + 0.31), cy - 0.04, cz + 0.16*math.sin(t + 0.31)), (0.1*math.cos(t + 0.31), cy - 0.04, cz + 0.1*math.sin(t + 0.31)),
            (0.1*math.cos(t), cy - 0.036, cz + 0.1*math.sin(t)), (0.16*math.cos(t + 0.31), cy - 0.036, cz + 0.16*math.sin(t + 0.31))], 'Black')
for x, z in ((0.03, 0.04), (-0.06, 0.02), (0.02, -0.08)):                             # darts stuck in it
    p.cyl(0.005, 0.1, 'Chrome', x, cy - 0.04, cz + z, segments=5, rot=(math.pi/2, 0, 0))
    p.box(0.03, 0.003, 0.03, 'Red', x, cy - 0.13, cz + z, bevel=0)

p = piece('FruitMachine')
MW, MD, MH = 0.62, 0.55, 1.85
p.box(MW, MD, 0.9, 'Black', 0, 0, 0, bevel=0.02)
p.box(MW - 0.04, 0.02, 0.6, 'GlowMachine', 0, -MD/2 - 0.005, 0.18, bevel=0.004)    # its lit front
p.box(MW, MD - 0.1, 0.12, 'Chrome', 0, -0.02, 0.9, bevel=0.01)                      # the button deck
for k in range(4):
    p.cyl(0.025, 0.02, random.choice(['Red', 'Green', 'Cream']), -0.18 + k*0.12, -MD/2 + 0.1, 1.02, segments=8)
p.box(MW, MD - 0.18, MH - 1.02, 'Black', 0, 0.06, 1.02, bevel=0.02)
p.box(MW - 0.08, 0.02, 0.32, 'GlowReels', 0, -MD/2 + 0.09, 1.1, bevel=0.004)        # the reels
for x in (-0.16, 0, 0.16):
    p.box(0.02, 0.025, 0.32, 'Chrome', x + 0.08, -MD/2 + 0.085, 1.1, bevel=0)
p.box(MW - 0.04, 0.02, 0.36, 'GlowMachine', 0, -MD/2 + 0.09, 1.46, bevel=0.004)     # the lit top
p.box(MW + 0.02, MD - 0.16, 0.04, 'Chrome', 0, 0.06, MH - 0.02, bevel=0.008)

# ------------------------------------------------------------------ on the walls
p = piece('Chalkboard')                                                             # the specials
p.box(0.7, 0.04, 0.9, 'Oak', bevel=0.01)
p.box(0.62, 0.02, 0.82, 'Slate', 0, -0.02, 0.04, bevel=0.002)
for k in range(7):
    w = random.uniform(0.2, 0.48)
    p.box(w, 0.006, 0.02, 'Chalk', -0.26 + w/2, -0.032, 0.72 - k*0.09, bevel=0)
    if k % 2: p.box(0.08, 0.006, 0.02, 'Chalk', 0.22, -0.032, 0.72 - k*0.09, bevel=0)

p = piece('Picture')                                                                # a hunting print in a gilt frame
p.box(0.62, 0.035, 0.48, 'Gilt', bevel=0.008)
p.box(0.52, 0.02, 0.38, 'Canvas2', 0, -0.012, 0.05, bevel=0.001)
p.box(0.52, 0.021, 0.16, 'Canvas', 0, -0.013, 0.05, bevel=0.001)
for x in (-0.12, 0.08):                                                             # horses and riders
    p.box(0.12, 0.01, 0.06, 'Horse', x, -0.025, 0.16, bevel=0.004)
    for lx in (-0.045, 0.045): p.box(0.012, 0.01, 0.06, 'Horse', x + lx, -0.025, 0.1, bevel=0)
    p.box(0.03, 0.01, 0.07, 'Coat', x + 0.01, -0.026, 0.21, bevel=0.003)
    p.box(0.02, 0.01, 0.03, 'Black', x + 0.01, -0.026, 0.28, bevel=0.002)

p = piece('Mirror')                                                                 # a brewery's mirror
p.box(0.7, 0.035, 0.95, 'OakDark', bevel=0.01)
p.box(0.58, 0.02, 0.83, 'Mirror', 0, -0.012, 0.06, bevel=0.002)
p.box(0.46, 0.022, 0.12, 'Gilt', 0, -0.015, 0.62, bevel=0.002)                      # its lettering
p.box(0.3, 0.022, 0.05, 'Gilt', 0, -0.015, 0.54, bevel=0.002)
p.cyl(0.08, 0.022, 'Red', 0, -0.004, 0.3, segments=16, rot=(math.pi/2, 0, 0))

p = piece('WallLamp')                                                               # a brass sconce with a fringed shade
p.box(0.1, 0.03, 0.14, 'Brass', 0, 0.0, 0, bevel=0.01)
p.bar((0, -0.01, 0.07), (0, -0.14, 0.14), 0.015, 'Brass')
p.cyl(0.03, 0.05, 'Light', 0, -0.14, 0.14, segments=8)
p.cyl(0.1, 0.13, 'Upholstery', 0, -0.14, 0.13, r2=0.06, segments=12)
p.cyl(0.103, 0.02, 'Gilt', 0, -0.14, 0.12, segments=12)

p = piece('Pendant')                                                                # to hang, its chain up to z 0.6
p.cyl(0.006, 0.4, 'Brass', z0=0.2, segments=6)
p.cyl(0.05, 0.03, 'Brass', z0=0.6, segments=10)
p.cyl(0.05, 0.05, 'Brass', z0=0.16, segments=10)
p.cyl(0.07, 0.14, 'Gilt', z0=0.02, r2=0.04, segments=12)
p.cyl(0.18, 0.02, 'Brass', z0=0.0, r2=0.07, segments=12)
p.cyl(0.05, 0.03, 'Light', z0=-0.02, segments=10)

p = piece('Pint')
pint(p, 0, 0, 0)
p = piece('Stout')
pint(p, 0, 0, 0, stout=True)

# ------------------------------------------------------------------ out
export(OUT)
