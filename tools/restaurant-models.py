# Builds assets/models/Restaurant.glb: an old New York Italian restaurant's pieces, in the same low-poly, flat-coloured,
# softened style as Pub.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/restaurant-models.py
#
# Tables under red-and-white checked cloths (Table2, Table4, BoothTable) or a white one (TableRound), laid with plates,
# glasses and a candle in a Chianti bottle; bentwood Chairs and red leather Booths. A marble-topped Bar with an espresso
# machine, a BackBar of wine, a HostStand, swinging KitchenDoors (and a KitchenDoor leaf), a DessertCart, a WineRack, a CoatStand and a Plant.
# For the walls: a Mural of the Bay of Naples, Photos (signed headshots), a WallLamp; to hang: a Tiffany Pendant and
# Chiantis (straw-wrapped bottles off a beam). To carry: Spaghetti, PizzaSlice, Wine and Chianti.
# One top-level mesh per piece, at five times life size, each facing -y. Wall pieces stand on their own bottom edge;
# hung ones hang from z 0.6.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Restaurant.glb')
random.seed(11)

# (the ones to recolour per restaurant: Wood, Upholstery, Check)
material('Wood', 0x3e2014, 0.5)
material('WoodLight', 0x6a3e22, 0.5)
material('Upholstery', 0x7e1616, 0.45)
material('Check', 0xb81e1e, 0.9)
material('Cloth', 0xf4f0e6, 0.9)
material('Marble', 0xe6e2da, 0.25)
material('Brass', 0xc8a050, 0.3, 0.7)
material('Chrome', 0xc8ccd0, 0.25, 0.8)
material('Mirror', 0x9aa4a8, 0.08, 0.9)
material('Glass', 0xcfe0dc, 0.08)
material('Black', 0x141416, 0.6)
material('Cream', 0xece4cc, 0.8)
material('Plate', 0xf8f8f2, 0.3)
material('Straw', 0xc8a050, 1.0)
material('Fiasco', 0x2a5a2a, 0.15)
material('RedWine', 0x5a0a16, 0.2)
material('Wax', 0xf0e6cc, 0.7)
material('Pasta', 0xe8c870, 0.7)
material('Sauce', 0xa81e10, 0.4)
material('Crust', 0xd8963a, 0.9)
material('Cheese', 0xf0c850, 0.8)
material('Pepperoni', 0xa82a1e, 0.8)
material('Meat', 0x5a2a18, 0.8)
material('Basil', 0x2a6a2a, 0.7)
material('Cake', 0xd8b890, 0.8)
material('Pastry', 0xc89050, 0.8)
material('Cocoa', 0x4a2a18, 0.9)
material('Leaf', 0x2e5a26, 0.8)
material('Pot', 0xa8502a, 0.9)
material('Felt', 0x3a3430, 0.9)
material('Gilt', 0xb8923a, 0.35, 0.6)
material('Photo', 0x8a8a86, 0.5)
material('Face', 0xc4c2bc, 0.5)
material('Suit', 0x2a2a2c, 0.5)
material('Sky', 0x8ab8d8, 0.9)
material('SkyLow', 0xe8c8a0, 0.9)
material('Sea', 0x2a6a9a, 0.9)
material('Hill', 0x6a6258, 0.9)
material('Smoke', 0xb8b4b0, 0.9)
material('Land', 0x6a8a3a, 0.9)
material('House', 0xe8d0a0, 0.9)
material('Roof', 0xb85a30, 0.9)
material('Pine', 0x2a4a2a, 0.9)
material('Light', 0x000000, 1.0, glow=0xffd8a0)
material('Flame', 0x000000, 1.0, glow=0xffb040)
material('GlowKitchen', 0xd0d8d0, 0.2, glow=0xe8f0e0)
material('GlowAmber', 0x6a4010, 0.4, glow=0xe89a30)
material('GlowGreen', 0x1a3a1a, 0.4, glow=0x6a9a3a)
material('GlowRed', 0x3a0a0a, 0.4, glow=0xc03020)
for i, colour in enumerate((0x2a4a2a, 0x3a0a14, 0x1a2a1a, 0xd8c880, 0x4a1a1a, 0x2a3a2a)):
    material('Bottle%d' % i, colour, 0.15)
BOTTLES = ['Bottle%d' % i for i in range(6)]

# ------------------------------------------------------------------ building blocks
# a wine glass on z0 at (x, y), with red in it
def wine_glass(p, x, y, z0, full=True):
    p.lathe([(0.03, 0), (0.03, 0.004), (0.005, 0.012), (0.005, 0.09), (0.03, 0.105), (0.037, 0.15), (0.033, 0.19)], 'Glass', x, y, z0, segments=8)
    if full: p.cyl(0.032, 0.03, 'RedWine', x, y, z0 + 0.11, r2=0.036, segments=8)

# a straw-wrapped Chianti bottle on z0 at (x, y), a candle burning in its neck
def chianti(p, x, y, z0, candle=True):
    p.ball(0.065, 'Straw', (x, y, z0 + 0.06), scale=(1, 1, 0.95), detail=1)
    p.lathe([(0.04, 0.09), (0.02, 0.15), (0.013, 0.2), (0.016, 0.24)], 'Fiasco', x, y, z0, segments=8)
    if not candle: return
    p.cyl(0.012, 0.09, 'Wax', x, y, z0 + 0.24, segments=8)
    for a in (0.5, 2.4, 4.1):                                                       # drips down the neck
        p.box(0.01, 0.01, 0.07, 'Wax', x + 0.017*math.cos(a), y + 0.017*math.sin(a), z0 + 0.19, bevel=0.003)
    p.ball(0.012, 'Flame', (x, y, z0 + 0.35), scale=(0.7, 0.7, 1.6), detail=1)

# a place laid at (x, y) on top z, for someone sat out along angle a from the table's middle
def setting(p, x, y, z, a):
    ox, oy = math.cos(a), math.sin(a)                                               # out towards them
    sx, sy = -oy, ox                                                                # sideways
    # no plate: whoever sits is served one there (see serveMeal in peopleActivities.js)
    p.box(0.07, 0.12, 0.02, 'Check', x + 0.25*sx, y + 0.25*sy, z, bevel=0.006, rot=(0, 0, a))   # a folded napkin
    for s in (1, -1):                                                               # fork and knife either side
        cx, cy = x + s*0.17*sx, y + s*0.17*sy
        p.bar((cx - 0.09*ox, cy - 0.09*oy, z + 0.004), (cx + 0.09*ox, cy + 0.09*oy, z + 0.004), 0.012, 'Chrome', bevel=0)
    wine_glass(p, x - 0.14*sx - 0.16*ox, y - 0.14*sy - 0.16*oy, z, full=random.random() < 0.5)

# a red-and-white checked cloth over a table w by d, its top at h, hanging down `drape`
def checked_cloth(p, w, d, h, drape=0.22, sq=0.11):
    W, D = w + 0.04, d + 0.04
    p.box(W, D, 0.01, 'Cloth', 0, 0, h - 0.01, bevel=0.003)
    for sx in (1, -1):
        p.box(0.006, D, drape, 'Cloth', sx*W/2, 0, h - drape, bevel=0)
    for sy in (1, -1):
        p.box(W, 0.006, drape, 'Cloth', 0, sy*D/2, h - drape, bevel=0)
    nx, ny, nz = max(2, round(W/sq)), max(2, round(D/sq)), max(1, round(drape/sq))
    gx, gy, gz = W/nx, D/ny, drape/nz
    for i in range(nx):
        for j in range(ny):
            if (i + j) % 2: p.box(gx, gy, 0.002, 'Check', -W/2 + (i + 0.5)*gx, -D/2 + (j + 0.5)*gy, h, bevel=0)
        for k in range(nz):                                                         # down the long sides
            for sy, j in ((-1, 0), (1, ny - 1)):
                if (i + j + k + 1) % 2: p.box(gx, 0.003, gz, 'Check', -W/2 + (i + 0.5)*gx, sy*(D/2 + 0.004), h - (k + 1)*gz, bevel=0)
    for j in range(ny):
        for k in range(nz):                                                         # and the ends
            for sx, i in ((-1, 0), (1, nx - 1)):
                if (i + j + k + 1) % 2: p.box(0.003, gy, gz, 'Check', sx*(W/2 + 0.004), -D/2 + (j + 0.5)*gy, h - (k + 1)*gz, bevel=0)

# a table w by d, top at h, on four legs under a checked cloth, laid for places [(x, y, a)...]
TH = 0.75
def table(p, w, d, places):
    for sx in (1, -1):
        for sy in (1, -1):
            p.box(0.05, 0.05, TH - 0.03, 'Wood', sx*(w/2 - 0.06), sy*(d/2 - 0.06), 0, bevel=0.008)
    checked_cloth(p, w, d, TH)
    for x, y, a in places: setting(p, x, y, TH + 0.002, a)
    chianti(p, 0, 0, TH + 0.002)

# ------------------------------------------------------------------ tables
p = piece('Table2')                                                                 # for two, sat either side along y
table(p, 0.76, 0.76, [(0, -0.22, -math.pi/2), (0, 0.22, math.pi/2)])

p = piece('Table4')                                                                 # for four, two a side along y
table(p, 1.2, 0.8, [(x, s*0.24, s*math.pi/2) for x in (-0.3, 0.3) for s in (1, -1)])

p = piece('BoothTable')                                                             # between a pair of Booths, facing along y
table(p, 1.1, 0.7, [(x, s*0.2, s*math.pi/2) for x in (-0.28, 0.28) for s in (1, -1)])

p = piece('TableRound')                                                             # a family's: white cloth, on a pedestal, for six
R = 0.65
for a in range(4):
    t = a*math.pi/2 + math.pi/4
    p.bar((0, 0, 0.03), (0.34*math.cos(t), 0.34*math.sin(t), 0.02), 0.05, 'Wood')
p.cyl(0.06, TH - 0.2, 'Wood', z0=0.02, r2=0.045, segments=10)
p.cyl(R + 0.04, 0.01, 'Cloth', z0=TH - 0.01, segments=24)
p.cyl(R + 0.08, 0.26, 'Cloth', z0=TH - 0.27, r2=R + 0.04, segments=24)            # its skirt
for k in range(6):
    t = k*math.pi/3 + math.pi/6
    setting(p, 0.44*math.cos(t), 0.44*math.sin(t), TH + 0.002, t)
chianti(p, 0.08, 0, TH + 0.002)
chianti(p, -0.1, 0.06, TH + 0.002, candle=False)
p.cyl(0.1, 0.06, 'Straw', -0.06, -0.12, TH + 0.002, r2=0.12, segments=10)           # a bread basket
for k in range(3): p.ball(0.035, 'Pastry', (-0.06 + 0.04*math.cos(k*2.1), -0.12 + 0.04*math.sin(k*2.1), TH + 0.07), scale=(1.4, 0.8, 0.7))

# ------------------------------------------------------------------ seats
# a bentwood café chair: a round seat on splayed legs with a ring under it, its back a bent hoop
p = piece('Chair')
CS = 0.46
for sx, sy in ((1, -1), (-1, -1), (1, 1), (-1, 1)):
    p.bar((sx*0.2, sy*0.19, 0), (sx*0.14, sy*0.13, CS - 0.04), 0.03, 'Wood')
ring = [(0.17*math.cos(k*math.pi/6), 0.17*math.sin(k*math.pi/6)) for k in range(13)]
for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
    p.bar((x0, y0, 0.2), (x1, y1, 0.2), 0.018, 'Wood')
p.cyl(0.2, 0.03, 'Wood', z0=CS - 0.04, segments=16)
p.cyl(0.2, 0.025, 'Upholstery', z0=CS - 0.01, r2=0.19, segments=16)
hoop = []                                                                           # the back: two uprights bent into a hoop
for k in range(13):
    t = math.pi*k/12
    hoop.append((0.17*math.cos(t), 0.2 + 0.03*math.sin(t), CS + 0.18 + 0.28*math.sin(t)**0.5))
hoop = [(0.17, 0.16, CS - 0.02)] + hoop + [(-0.17, 0.16, CS - 0.02)]
for a, b in zip(hoop, hoop[1:]): p.bar(a, b, 0.028, 'Wood')
inner = [(0.1*math.cos(math.pi*k/8), 0.2, CS + 0.12 + 0.2*math.sin(math.pi*k/8)**0.5) for k in range(9)]
for a, b in zip(inner, inner[1:]): p.bar(a, b, 0.018, 'Wood')

# a booth's bench: channel-tufted red leather on a dark wood base, a rail along its top; sat facing -y, 1.5 long
p = piece('Booth')
BL, BD, BS, BH = 1.5, 0.62, 0.45, 1.2
p.box(BL, BD - 0.06, 0.08, 'Black', 0, 0.02, 0, bevel=0.005)
p.box(BL, BD - 0.06, BS - 0.18, 'Wood', 0, 0.02, 0.06, bevel=0.01)
p.box(BL - 0.02, BD - 0.16, 0.12, 'Upholstery', 0, -0.03, BS - 0.12, bevel=0.035, segments=2)
p.box(BL, 0.12, BH - 0.06, 'Wood', 0, BD/2 - 0.06, 0, bevel=0.01)                  # its back
n = 9
for k in range(n):                                                                  # the channels
    x = -BL/2 + (k + 0.5)*BL/n
    p.box(BL/n - 0.01, 0.12, BH - BS - 0.12, 'Upholstery', x, BD/2 - 0.16, BS + 0.02, bevel=0.04, segments=2, rot=(-0.12, 0, 0))
p.box(BL + 0.04, 0.18, 0.06, 'Wood', 0, BD/2 - 0.08, BH - 0.06, bevel=0.015)        # the rail
for x in (-BL/2 + 0.2, BL/2 - 0.2):                                                 # coat hooks
    p.bar((x, BD/2 - 0.16, BH - 0.1), (x, BD/2 - 0.26, BH + 0.02), 0.015, 'Brass')

# ------------------------------------------------------------------ the bar
BAR_L, BAR_D, BAR_H = 3.0, 0.62, 1.07
p = piece('Bar')
p.box(BAR_L, BAR_D - 0.12, 0.1, 'Black', 0, 0.03, 0, bevel=0.006)
p.box(BAR_L, BAR_D - 0.14, BAR_H - 0.14, 'Wood', 0, 0.04, 0.08, bevel=0.01)
front = -(BAR_D - 0.14)/2 + 0.04
n = 5
for i in range(n):                                                                  # raised panels
    x = -BAR_L/2 + (i + 0.5)*BAR_L/n
    p.box(BAR_L/n - 0.1, 0.02, 0.6, 'WoodLight', x, front - 0.01, 0.2, bevel=0.012)
p.box(BAR_L + 0.06, BAR_D, 0.05, 'Marble', 0, 0, BAR_H - 0.05, bevel=0.015)
p.box(BAR_L + 0.02, 0.04, 0.04, 'Wood', 0, -BAR_D/2 + 0.02, BAR_H - 0.09, bevel=0.012)
for x in (-1.1, 0, 1.1):                                                            # the foot rail
    p.bar((x, front - 0.01, 0.1), (x, front - 0.2, 0.2), 0.025, 'Brass')
p.cyl(0.024, BAR_L - 0.3, 'Brass', -BAR_L/2 + 0.15, front - 0.2, 0.2, segments=10, rot=(0, math.pi/2, 0))
# an espresso machine along the back of the top: chrome body, three group heads, cups warming on top
ex, ey = 0.8, 0.12
p.box(0.66, 0.36, 0.34, 'Chrome', ex, ey, BAR_H, bevel=0.03)
p.box(0.6, 0.02, 0.1, 'Upholstery', ex, ey - 0.18, BAR_H + 0.2, bevel=0.005)
for k in (-1, 0, 1):
    p.cyl(0.035, 0.05, 'Chrome', ex + k*0.19, ey - 0.2, BAR_H + 0.1, segments=8)
    p.bar((ex + k*0.19, ey - 0.22, BAR_H + 0.08), (ex + k*0.19, ey - 0.36, BAR_H + 0.06), 0.02, 'Black')
    p.cyl(0.028, 0.04, 'Plate', ex + k*0.19, ey - 0.2, BAR_H + 0.002, r2=0.024, segments=8)
p.box(0.6, 0.12, 0.012, 'Chrome', ex, ey - 0.2, BAR_H, bevel=0)
for k in range(5):
    p.cyl(0.028, 0.045, 'Plate', ex - 0.2 + k*0.1, ey, BAR_H + 0.34, r2=0.034, segments=8)
wine_glass(p, -0.9, -0.12, BAR_H)
wine_glass(p, -0.5, -0.15, BAR_H)
chianti(p, -1.2, 0.05, BAR_H, candle=False)

# the back bar: cupboards under a marble counter, then a mirror and shelves of wine and spirits, glasses hung upside down
BB_L, BB_D, BB_H = 3.0, 0.42, 2.3
p = piece('BackBar')
p.box(BB_L, BB_D - 0.04, 0.9, 'Wood', 0, 0.02, 0, bevel=0.01)
for i in range(5):
    x = -BB_L/2 + (i + 0.5)*BB_L/5
    p.box(BB_L/5 - 0.1, 0.02, 0.62, 'WoodLight', x, -(BB_D - 0.04)/2 + 0.01, 0.14, bevel=0.012)
p.box(BB_L + 0.04, BB_D, 0.04, 'Marble', 0, 0, 0.9, bevel=0.01)
p.box(BB_L, 0.03, BB_H - 0.94, 'Mirror', 0, BB_D/2 - 0.03, 0.94, bevel=0.002)
for x in (-BB_L/2 + 0.04, -BB_L/6, BB_L/6, BB_L/2 - 0.04):
    p.box(0.07, 0.24, BB_H - 0.94, 'Wood', x, BB_D/2 - 0.14, 0.94, bevel=0.01)
for z in (1.3, 1.72):
    p.box(BB_L, 0.2, 0.03, 'Wood', 0, BB_D/2 - 0.13, z, bevel=0.006)
    x = -BB_L/2 + 0.12
    while x < BB_L/2 - 0.12:
        if all(abs(x - u) > 0.07 for u in (-BB_L/6, BB_L/6)):
            h = random.uniform(0.26, 0.34)
            p.lathe([(0.036, 0), (0.037, h*0.62), (0.014, h*0.78), (0.012, h)], random.choice(BOTTLES), x, BB_D/2 - 0.13, z + 0.03, segments=8)
        x += random.uniform(0.08, 0.1)
p.box(1.0, 0.24, 0.03, 'Wood', -BB_L/3, BB_D/2 - 0.14, 1.26 - 0.3, bevel=0)        # a rack of glasses, hung over the counter
for k in range(7):
    x = -BB_L/3 - 0.42 + k*0.14
    p.lathe([(0.033, 0), (0.037, 0.04), (0.03, 0.085), (0.005, 0.1), (0.005, 0.17), (0.03, 0.18)], 'Glass', x, BB_D/2 - 0.14, 0.78, segments=8)
for k in range(3): chianti(p, 0.7 + k*0.22, 0, 0.94, candle=False)
p.box(BB_L + 0.1, BB_D - 0.04, 0.1, 'Wood', 0, 0.02, BB_H - 0.1, bevel=0.01)
p.box(BB_L + 0.16, BB_D, 0.04, 'WoodLight', 0, 0, BB_H - 0.04, bevel=0.01)

# the host's stand by the door: a podium with the book open on its sloped top and a green banker's lamp
p = piece('HostStand')
p.box(0.62, 0.44, 0.06, 'Black', 0, 0, 0, bevel=0.006)
p.box(0.56, 0.38, 1.0, 'Wood', 0, 0, 0.06, bevel=0.012)
p.box(0.46, 0.02, 0.7, 'WoodLight', 0, -0.19, 0.2, bevel=0.012)
p.box(0.66, 0.5, 0.04, 'Wood', 0, 0.02, 1.06, bevel=0.01, rot=(-0.2, 0, 0))
p.box(0.4, 0.28, 0.025, 'Cream', 0, 0.0, 1.1, bevel=0.004, rot=(-0.2, 0, 0))         # the book
p.box(0.01, 0.28, 0.03, 'Upholstery', 0, 0.0, 1.1, bevel=0, rot=(-0.2, 0, 0))
p.cyl(0.05, 0.02, 'Brass', 0.22, 0.14, 1.12, segments=8)
p.cyl(0.008, 0.16, 'Brass', 0.22, 0.14, 1.14, segments=6)
p.cyl(0.05, 0.3, 'GlowGreen', 0.07, 0.14, 1.3, r2=0.05, segments=10, rot=(0, math.pi/2, 0))
p.cyl(0.03, 0.29, 'Light', 0.075, 0.14, 1.285, segments=8, rot=(0, math.pi/2, 0))

# the kitchen's swinging doors' frame (the way through beyond: kitchenWay in interior.js), porthole windows lit from behind, kick plates on; against a wall, 1.6 wide
p = piece('KitchenDoors')
p.box(0.08, 0.12, 2.2, 'Wood', -0.8, 0, 0, bevel=0.01)
p.box(0.08, 0.12, 2.2, 'Wood', 0.8, 0, 0, bevel=0.01)
p.box(1.68, 0.12, 0.1, 'Wood', 0, 0, 2.2, bevel=0.01)
# one of its two leaves (the right-hand one; the left's the same mirrored), hung by its right-hand edge: swung by the
# waiter going through (see waiterbot.js), placed on KitchenDoors by furnishRestaurant in interior.js
p = piece('KitchenDoor')
p.box(0.74, 0.05, 2.0, 'WoodLight', 0, -0.02, 0, bevel=0.01)
p.box(0.7, 0.01, 0.3, 'Chrome', 0, -0.05, 0.04, bevel=0.002)
p.cyl(0.16, 0.012, 'Chrome', 0, -0.042, 1.46, segments=16, rot=(math.pi/2, 0, 0))
p.cyl(0.13, 0.014, 'GlowKitchen', 0, -0.043, 1.46, segments=16, rot=(math.pi/2, 0, 0))
p.box(0.04, 0.02, 0.24, 'Chrome', -0.3, -0.055, 0.96, bevel=0.005)                  # push plate

# a dessert trolley: two wooden trays in a brass frame, a cake under a glass dome, cannoli and a tray of tiramisu
p = piece('DessertCart')
DW, DD = 0.8, 0.5
for sx in (1, -1):
    for sy in (1, -1):
        p.cyl(0.012, 0.86, 'Brass', sx*(DW/2 - 0.03), sy*(DD/2 - 0.03), 0.06, segments=6)
        p.cyl(0.035, 0.03, 'Black', sx*(DW/2 - 0.03), sy*(DD/2 - 0.03), 0.02, segments=8, rot=(0, math.pi/2, 0))
for z in (0.25, 0.82):
    p.box(DW, DD, 0.03, 'Wood', 0, 0, z, bevel=0.006)
    for sy in (1, -1): p.cyl(0.008, DW - 0.06, 'Brass', -DW/2 + 0.03, sy*(DD/2 - 0.03), z + 0.08, segments=6, rot=(0, math.pi/2, 0))
p.bar((DW/2 - 0.03, -0.2, 0.92), (DW/2 + 0.08, -0.2, 0.98), 0.02, 'Brass')          # its handle
p.bar((DW/2 + 0.08, -0.2, 0.98), (DW/2 + 0.08, 0.2, 0.98), 0.025, 'Brass')
p.bar((DW/2 - 0.03, 0.2, 0.92), (DW/2 + 0.08, 0.2, 0.98), 0.02, 'Brass')
p.cyl(0.03, 0.08, 'Glass', -0.18, 0, 0.85, segments=8)                              # the cake stand and dome
p.cyl(0.16, 0.012, 'Plate', -0.18, 0, 0.93, segments=14)
p.cyl(0.13, 0.1, 'Cake', -0.18, 0, 0.942, segments=14)
p.cyl(0.13, 0.02, 'Cream', -0.18, 0, 1.042, segments=14)
p.lathe([(0.155, 0), (0.155, 0.12), (0.13, 0.18), (0.07, 0.22), (0.02, 0.23)], 'Glass', -0.18, 0, 0.942, segments=14)
p.ball(0.018, 'Glass', (-0.18, 0, 1.18))
p.cyl(0.12, 0.012, 'Plate', 0.2, 0, 0.85, r2=0.13, segments=12)                    # cannoli
for k in range(5):
    a = k*math.pi/5
    c, s = math.cos(a), math.sin(a)
    p.cyl(0.018, 0.14, 'Pastry', 0.2 - 0.07*c, -0.07*s, 0.875, segments=6, rot=(0, math.pi/2, a))
p.box(0.5, 0.3, 0.06, 'Glass', 0, 0, 0.28, bevel=0.005)                              # tiramisu, down below
p.box(0.48, 0.28, 0.012, 'Cocoa', 0, 0, 0.34, bevel=0)

# a floor-standing rack of wine, the bottles' ends showing
p = piece('WineRack')
RW, RD, RH = 1.1, 0.34, 2.0
p.box(RW, RD, 0.06, 'Wood', 0, 0, 0, bevel=0.008)
p.box(RW, RD, 0.05, 'Wood', 0, 0, RH - 0.05, bevel=0.008)
for x in (-RW/2 + 0.025, RW/2 - 0.025): p.box(0.05, RD, RH, 'Wood', x, 0, 0, bevel=0.008)
p.box(RW, 0.02, RH, 'Wood', 0, RD/2 - 0.01, 0, bevel=0)
cols, rows = 7, 12
cw, rh = (RW - 0.05)/cols, (RH - 0.11)/rows
for i in range(1, cols): p.box(0.015, RD - 0.02, RH - 0.11, 'WoodLight', -RW/2 + 0.025 + i*cw, -0.01, 0.06, bevel=0)
for j in range(1, rows): p.box(RW - 0.05, RD - 0.02, 0.012, 'WoodLight', 0, -0.01, 0.06 + j*rh, bevel=0)
for i in range(cols):
    for j in range(rows):
        if random.random() < 0.15: continue
        x, z = -RW/2 + 0.025 + (i + 0.5)*cw, 0.06 + (j + 0.5)*rh - 0.035
        p.cyl(0.035, 0.28, random.choice(BOTTLES), x, RD/2 - 0.02, z, segments=8, rot=(math.pi/2, 0, 0))
        p.cyl(0.014, 0.06, random.choice(('Wax', 'Upholstery', 'Gilt')), x, -RD/2 + 0.12, z + 0.021, segments=6, rot=(math.pi/2, 0, 0))

# a bentwood coat stand, a fedora on one hook
p = piece('CoatStand')
p.cyl(0.025, 1.8, 'Wood', segments=8)
for k in range(3):
    t = k*2*math.pi/3
    p.bar((0, 0, 0.35), (0.3*math.cos(t), 0.3*math.sin(t), 0.01), 0.03, 'Wood')
for k in range(4):
    t = k*math.pi/2 + math.pi/4
    p.bar((0, 0, 1.6), (0.18*math.cos(t), 0.18*math.sin(t), 1.72), 0.025, 'Wood')
    p.ball(0.02, 'Wood', (0.18*math.cos(t), 0.18*math.sin(t), 1.72))
p.ball(0.035, 'Wood', (0, 0, 1.82))
hx, hy = 0.18*math.cos(math.pi/4), 0.18*math.sin(math.pi/4)
p.cyl(0.14, 0.012, 'Felt', hx, hy, 1.72, segments=12)
p.cyl(0.085, 0.1, 'Felt', hx, hy, 1.73, r2=0.075, segments=12)
p.cyl(0.087, 0.022, 'Black', hx, hy, 1.735, segments=12)

# a potted palm
p = piece('Plant')
p.cyl(0.18, 0.4, 'Pot', r2=0.22, segments=12)
p.cyl(0.23, 0.05, 'Pot', z0=0.38, segments=12)
p.cyl(0.2, 0.01, 'Cocoa', z0=0.42, segments=12)
for k in range(3):
    p.bar((0.02*k - 0.02, 0, 0.42), (0.04*k - 0.04, 0.02, 1.1 + 0.1*k), 0.04, 'Pastry')
for k in range(11):                                                                 # fronds arching out
    t = k*2.39
    base = (0.03*math.cos(t), 0.03*math.sin(t), 1.1 + (k % 3)*0.1)
    mid = (0.35*math.cos(t), 0.35*math.sin(t), base[2] + 0.18)
    tip = (0.62*math.cos(t), 0.62*math.sin(t), base[2] - 0.12)
    sx, sy = -math.sin(t)*0.12, math.cos(t)*0.12
    p.hull([base, (mid[0] + sx, mid[1] + sy, mid[2]), (mid[0] - sx, mid[1] - sy, mid[2]), (mid[0], mid[1], mid[2] + 0.01)], 'Leaf')
    p.hull([(mid[0] + sx, mid[1] + sy, mid[2]), (mid[0] - sx, mid[1] - sy, mid[2]), tip, (mid[0], mid[1], mid[2] + 0.01)], 'Leaf')

# ------------------------------------------------------------------ on the walls
# the Bay of Naples, Vesuvius smoking over it, in a gilt frame; 2.4 wide
p = piece('Mural')
MW, MH = 2.4, 1.2
p.box(MW, 0.05, MH, 'Gilt', bevel=0.012)
p.box(MW - 0.12, 0.02, MH - 0.12, 'Sky', 0, -0.02, 0.06, bevel=0)
p.box(MW - 0.12, 0.021, 0.2, 'SkyLow', 0, -0.021, 0.5, bevel=0)
p.box(MW - 0.12, 0.022, 0.44, 'Sea', 0, -0.022, 0.06, bevel=0)
p.hull([(-0.1, -0.03, 0.5), (0.9, -0.03, 0.5), (0.45, -0.03, 0.92), (0.3, -0.03, 0.9), (0.4, -0.025, 0.5)], 'Hill')
for k, (x, z, r) in enumerate(((0.38, 0.98, 0.05), (0.33, 1.04, 0.06), (0.24, 1.08, 0.05))):
    p.ball(r, 'Smoke', (x, -0.035, z), scale=(1.4, 0.3, 0.8))
p.hull([(-1.14, -0.035, 0.06), (-0.3, -0.035, 0.06), (-0.6, -0.035, 0.3), (-1.14, -0.035, 0.46)], 'Land')
for x, z, w in ((-1.05, 0.3, 0.1), (-0.92, 0.26, 0.12), (-0.78, 0.2, 0.1), (-0.64, 0.14, 0.09), (-0.98, 0.38, 0.08)):
    p.box(w, 0.01, 0.08, 'House', x, -0.042, z, bevel=0)
    p.box(w + 0.02, 0.01, 0.025, 'Roof', x, -0.043, z + 0.08, bevel=0)
p.box(0.025, 0.01, 0.5, 'Pastry', 0.85, -0.045, 0.06, bevel=0)                       # an umbrella pine
p.ball(0.2, 'Pine', (0.85, -0.05, 0.6), scale=(1.3, 0.1, 0.4))
p.box(0.08, 0.01, 0.04, 'Cloth', -0.05, -0.04, 0.2, bevel=0)                         # a sail
p.hull([(-0.05, -0.045, 0.24), (-0.05, -0.045, 0.4), (0.03, -0.045, 0.24)], 'Cloth')

# a wall of signed headshots in black frames; 1.2 wide
p = piece('Photos')
for x, z, w, h in ((-0.42, 0.5, 0.3, 0.38), (-0.05, 0.56, 0.3, 0.38), (0.34, 0.48, 0.34, 0.42),
                   (-0.44, 0.0, 0.26, 0.34), (-0.1, 0.04, 0.3, 0.38), (0.3, 0.0, 0.28, 0.36)):
    p.box(w, 0.03, h, 'Black', x, 0, z, bevel=0.005)
    p.box(w - 0.05, 0.02, h - 0.05, 'Cream', x, -0.008, z + 0.025, bevel=0)
    p.box(w - 0.1, 0.02, h - 0.12, 'Photo', x, -0.01, z + 0.07, bevel=0)
    p.box(w*0.5, 0.01, h*0.14, 'Suit', x, -0.018, z + 0.07, bevel=0.01)
    p.ball(w*0.14, 'Face', (x, -0.02, z + 0.07 + h*0.3), scale=(0.85, 0.15, 1.05))
    p.bar((x - w*0.25, -0.022, z + 0.05 + h*0.1), (x + w*0.22, -0.022, z + 0.06 + h*0.2), 0.006, 'Black', bevel=0)   # the signature

# a brass sconce with a tulip shade
p = piece('WallLamp')
p.cyl(0.05, 0.02, 'Brass', 0, 0.0, 0.1, segments=10, rot=(math.pi/2, 0, 0))
p.bar((0, -0.02, 0.1), (0, -0.12, 0.04), 0.015, 'Brass')
p.bar((0, -0.12, 0.04), (0, -0.16, 0.14), 0.015, 'Brass')
p.cyl(0.02, 0.03, 'Light', 0, -0.16, 0.15, segments=8)
p.lathe([(0.02, 0), (0.05, 0.05), (0.075, 0.12), (0.085, 0.15)], 'GlowAmber', 0, -0.16, 0.13, segments=10)

# ------------------------------------------------------------------ to hang (from z 0.6)
# a Tiffany shade: bands of coloured glass, a red rim, on a brass chain
p = piece('Pendant')
p.cyl(0.006, 0.34, 'Brass', z0=0.26, segments=6)
p.cyl(0.04, 0.02, 'Brass', z0=0.58, segments=8)
p.cyl(0.03, 0.03, 'Brass', z0=0.23, segments=8)
for (r0, z0), (r1, z1), mat in (((0.26, 0.0), (0.24, 0.05), 'GlowRed'), ((0.24, 0.05), (0.19, 0.12), 'GlowAmber'),
                                 ((0.19, 0.12), (0.11, 0.19), 'GlowGreen'), ((0.11, 0.19), (0.03, 0.23), 'GlowAmber')):
    p.cyl(r0, z1 - z0, mat, z0=z0, r2=r1, segments=16)
p.cyl(0.05, 0.03, 'Light', z0=0.02, segments=8)

# a beam of Chianti bottles hung on strings, 1.6 long
p = piece('Chiantis')
p.box(1.6, 0.08, 0.08, 'Wood', 0, 0, 0.52, bevel=0.01)
for x in (-0.7, 0.7): p.cyl(0.006, 0.08, 'Black', x, 0, 0.6, segments=4)
for k in range(7):
    x = -0.66 + k*0.22
    drop = random.uniform(0.0, 0.14)
    p.cyl(0.004, 0.2 + drop, 'Straw', x, 0, 0.32 - drop, segments=4)
    chianti(p, x, 0, 0.0 - drop + 0.06, candle=False)

# ------------------------------------------------------------------ to carry
p = piece('Spaghetti')                                                              # and meatballs
p.cyl(0.12, 0.014, 'Plate', r2=0.14, segments=14)
p.ball(0.09, 'Pasta', (0, 0, 0.03), scale=(1, 1, 0.35), detail=2)
for k in range(5):                                                                  # loose strands round the nest
    a = k*1.26
    p.bar((0.07*math.cos(a), 0.07*math.sin(a), 0.03), (0.09*math.cos(a + 0.9), 0.09*math.sin(a + 0.9), 0.022), 0.008, 'Pasta', bevel=0)
p.ball(0.06, 'Sauce', (0, 0, 0.05), scale=(1, 1, 0.3), detail=1)
for k in range(3):
    p.ball(0.024, 'Meat', (0.03*math.cos(k*2.1), 0.03*math.sin(k*2.1), 0.07), detail=1)
p.box(0.03, 0.02, 0.004, 'Basil', 0.0, 0.0, 0.095, bevel=0, rot=(0, 0, 0.5))

# a slice of pizza, as the students' (Student.glb), an eighth of a whole one: tip at the middle, crust along +y
p = piece('PizzaSlice')
R, H, A = 0.16, 0.012, math.pi/8
rim = [(R*math.sin(d), R*math.cos(d)) for d in (-A, -A/2, 0, A/2, A)]
p.hull([(0, 0, 0), (0, 0, H)] + [(u, v, h) for u, v in rim for h in (0, H)], 'Cheese')
L = 2*R*math.sin(A)
p.cyl(0.014, L, 'Crust', -L/2, R*math.cos(A), 0.008, segments=8, rot=(math.pi/2, 0, math.pi/2))
p.cyl(0.02, 0.004, 'Pepperoni', 0, 0.095, H, segments=10)

p = piece('Wine')
wine_glass(p, 0, 0, 0)

p = piece('Chianti')
chianti(p, 0, 0, 0, candle=False)

# ------------------------------------------------------------------ out
export(OUT)
