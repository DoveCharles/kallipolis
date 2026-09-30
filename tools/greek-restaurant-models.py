# Builds assets/models/RestaurantGreek.glb: a Greek taverna's pieces, named as Restaurant.glb's so furnishRestaurant
# (buildings/interior.js) lays either out the same way; in the same low-poly, flat-coloured style.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/greek-restaurant-models.py
#
# Tables under white cloths (Table2, Table4, BoothTable; TableRound with a copper wine jug), rush-seated taverna Chairs
# painted blue, whitewashed Booths (built-in benches, blue cushions). A whitewashed
# Bar with a meze cabinet, a BackBar of ouzo, oil tins and amphorae, a HostStand, KitchenDoors (and a KitchenDoor leaf),
# a DessertCart of baklava, a WineRack, a CoatStand with a fisherman's cap and an olive tree (Plant);
# Greenery, a big mass of leaves, roses and gilded branches to hang from the ceiling.
# For the walls: a Mural of Santorini, Photos (painted plates), a WallLamp (iron lantern); to hang: a rattan Pendant and
# Chiantis (a beam hung with grapevine). One top-level mesh per piece, at five times life size, each facing -y. Wall
# pieces stand on their own bottom edge; hung ones hang from z 0.6. To carry: Moussaka and Souvlaki (a skewer).
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'RestaurantGreek.glb')
random.seed(12)

# (the ones to recolour per restaurant: Wood (painted), Upholstery, Check)
material('Wood', 0x1e5a9a, 0.6)
material('WoodLight', 0x8a5a32, 0.6)
material('Upholstery', 0x2a5aa0, 0.9)
material('Check', 0x1e5aa8, 0.9)
material('Cloth', 0xf4f2ea, 0.9)
material('Plaster', 0xf2efe6, 0.95)
material('Stone', 0xd8cfbc, 0.7)
material('Straw', 0xc8a860, 1.0)
material('Copper', 0xb8643a, 0.35, 0.7)
material('Brass', 0xc8a050, 0.3, 0.7)
material('Chrome', 0xc8ccd0, 0.25, 0.8)
material('Iron', 0x1c1c1e, 0.6, 0.3)
material('Black', 0x141416, 0.6)
material('Glass', 0xcfe0dc, 0.08)
material('Plate', 0xf8f8f2, 0.3)
material('Terracotta', 0xb8602e, 0.9)
material('Ochre', 0xc8963a, 0.8)
material('Dome', 0x1e4aa0, 0.5)
material('Label', 0x1e4a9a, 0.6)
material('Tin', 0xd8d0b8, 0.35, 0.6)
material('Oil', 0xb8a030, 0.2)
material('RedWine', 0x5a0a16, 0.2)
material('Retsina', 0xd8c070, 0.2)
material('Wax', 0xf0e6cc, 0.7)
material('Olive', 0x3a3a1e, 0.5)
material('Feta', 0xf4f2e6, 0.8)
material('Dolma', 0x4a5a26, 0.8)
material('Lemon', 0xf0d040, 0.6)
material('Bread', 0xd8a868, 0.9)
material('Pastry', 0xc89050, 0.8)
material('Pistachio', 0x6a8a3a, 0.8)
material('Honey', 0xd89a2a, 0.3)
material('Custard', 0xf0d890, 0.8)
material('Leaf', 0x6a7a4a, 0.8)
material('VineLeaf', 0x4a7a2a, 0.8)
material('Grape', 0x4a1a3a, 0.4)
material('Bark', 0x5a4a38, 0.9)
material('Fern', 0x3e6e32, 0.8)
material('FernLight', 0x6a9a52, 0.8)
material('FernDark', 0x2a4a26, 0.8)
material('Rose', 0xd8483a, 0.7)
material('RosePink', 0xe8968a, 0.7)
material('Twig', 0xc8964a, 0.5, 0.3)
material('Soil', 0x4a2a18, 0.9)
material('Aubergine', 0x3a1a34, 0.6)
material('Mince', 0x7a3a22, 0.9)
material('Bechamel', 0xe8c878, 0.8)
material('Browned', 0xa8702a, 0.8)
material('Tomato', 0xc8281e, 0.5)
material('Grilled', 0x8a4a24, 0.8)
material('Charred', 0x3e2414, 0.9)
material('Pepper', 0x3a8a2a, 0.6)
material('Onion', 0xe8dcd8, 0.7)
material('Skewer', 0xd8b888, 0.8)
material('Felt', 0x1e2438, 0.9)
material('Sky', 0x8ac0e8, 0.9)
material('SkyLow', 0xf0d8b0, 0.9)
material('Sea', 0x1e5a9a, 0.9)
material('Rock', 0x8a5a4a, 0.9)
material('House', 0xf8f6f0, 0.9)
material('Light', 0x000000, 1.0, glow=0xffd8a0)
material('Flame', 0x000000, 1.0, glow=0xffb040)
material('GlowKitchen', 0xd0d8d0, 0.2, glow=0xe8f0e0)
material('GlowAmber', 0x6a4010, 0.4, glow=0xe89a30)
for i, colour in enumerate((0x2a4a2a, 0x3a0a14, 0x1a3a2a, 0xd8c880, 0x4a1a1a)):
    material('Bottle%d' % i, colour, 0.15)
BOTTLES = ['Bottle%d' % i for i in range(5)]

# ------------------------------------------------------------------ building blocks
# a taverna's small tumbler on z0 at (x, y), wine in it or not
def tumbler(p, x, y, z0, full=True):
    p.cyl(0.03, 0.09, 'Glass', x, y, z0, r2=0.034, segments=8)
    if full: p.cyl(0.028, 0.05, 'RedWine', x, y, z0 + 0.008, r2=0.03, segments=8)

# a candle in a glass jar
def candle(p, x, y, z0):
    p.cyl(0.04, 0.09, 'Glass', x, y, z0, segments=8)
    p.cyl(0.03, 0.05, 'Wax', x, y, z0 + 0.005, segments=8)
    p.ball(0.011, 'Flame', (x, y, z0 + 0.075), scale=(0.7, 0.7, 1.6), detail=1)

# a bottle of olive oil
def oil(p, x, y, z0):
    p.lathe([(0.028, 0), (0.028, 0.12), (0.012, 0.16), (0.01, 0.2)], 'Glass', x, y, z0, segments=8)
    p.cyl(0.025, 0.1, 'Oil', x, y, z0 + 0.005, segments=8)
    p.cyl(0.011, 0.02, 'Black', x, y, z0 + 0.2, segments=6)

# an ouzo bottle: clear, a blue label
def ouzo(p, x, y, z0, h=0.28):
    p.lathe([(0.034, 0), (0.035, h*0.6), (0.013, h*0.8), (0.012, h)], 'Glass', x, y, z0, segments=8)
    p.cyl(0.036, h*0.22, 'Label', x, y, z0 + h*0.2, segments=8)

# the copper wine jug tavernas pour by the kilo
def jug(p, x, y, z0, s=1.0):
    p.lathe([(0.045*s, 0), (0.06*s, 0.06*s), (0.05*s, 0.13*s), (0.035*s, 0.17*s), (0.045*s, 0.2*s)], 'Copper', x, y, z0, segments=10)
    p.bar((x + 0.04*s, y, z0 + 0.18*s), (x + 0.08*s, y, z0 + 0.1*s), 0.012*s, 'Copper')

# an amphora
def amphora(p, x, y, z0, s=1.0):
    p.lathe([(0.01*s, 0), (0.06*s, 0.08*s), (0.1*s, 0.22*s), (0.08*s, 0.34*s), (0.035*s, 0.4*s), (0.035*s, 0.48*s), (0.05*s, 0.5*s)],
            'Terracotta', x, y, z0, segments=10)
    for sx in (1, -1):
        p.bar((x + sx*0.035*s, y, z0 + 0.46*s), (x + sx*0.085*s, y, z0 + 0.38*s), 0.014*s, 'Terracotta')
    p.box(0.2*s, 0.004, 0.03*s, 'Black', x, y - 0.075*s, z0 + 0.25*s, bevel=0)   # a painted band

# a place laid at (x, y) on top z, for someone sat out along angle a from the table's middle
def setting(p, x, y, z, a):
    ox, oy = math.cos(a), math.sin(a)
    sx, sy = -oy, ox
    # no plate: whoever sits is served one there (see serveMeal in peopleHolding.js)
    p.box(0.07, 0.12, 0.02, 'Cloth', x + 0.25*sx, y + 0.25*sy, z, bevel=0.006, rot=(0, 0, a))    # a paper napkin
    for s in (1, -1):
        cx, cy = x + s*0.17*sx, y + s*0.17*sy
        p.bar((cx - 0.09*ox, cy - 0.09*oy, z + 0.004), (cx + 0.09*ox, cy + 0.09*oy, z + 0.004), 0.012, 'Chrome', bevel=0)
    tumbler(p, x - 0.14*sx - 0.16*ox, y - 0.14*sy - 0.16*oy, z, full=random.random() < 0.6)

# a plain white cloth over a table w by d, its top at h, hanging down `drape`
def white_cloth(p, w, d, h, drape=0.2):
    W, D = w + 0.04, d + 0.04
    p.box(W, D, 0.01, 'Cloth', 0, 0, h - 0.01, bevel=0.003)
    for sx in (1, -1):
        p.box(0.006, D, drape, 'Cloth', sx*W/2, 0, h - drape, bevel=0)
    for sy in (1, -1):
        p.box(W, 0.006, drape, 'Cloth', 0, sy*D/2, h - drape, bevel=0)

# a table w by d, top at h, on four blue legs under a white cloth, laid for places [(x, y, a)...]
TH = 0.75
def table(p, w, d, places):
    for sx in (1, -1):
        for sy in (1, -1):
            p.box(0.05, 0.05, TH - 0.03, 'Wood', sx*(w/2 - 0.06), sy*(d/2 - 0.06), 0, bevel=0.008)
    white_cloth(p, w, d, TH)
    for x, y, a in places: setting(p, x, y, TH + 0.002, a)
    candle(p, -0.05, 0, TH + 0.002)
    oil(p, 0.07, 0.02, TH + 0.002)

# ------------------------------------------------------------------ tables
p = piece('Table2')
table(p, 0.76, 0.76, [(0, -0.22, -math.pi/2), (0, 0.22, math.pi/2)])

p = piece('Table4')
table(p, 1.2, 0.8, [(x, s*0.24, s*math.pi/2) for x in (-0.3, 0.3) for s in (1, -1)])

p = piece('BoothTable')
table(p, 1.1, 0.7, [(x, s*0.2, s*math.pi/2) for x in (-0.28, 0.28) for s in (1, -1)])

p = piece('TableRound')                                                             # a family's: white cloth, on a pedestal, for six
R = 0.65
for a in range(4):
    t = a*math.pi/2 + math.pi/4
    p.bar((0, 0, 0.03), (0.34*math.cos(t), 0.34*math.sin(t), 0.02), 0.05, 'Wood')
p.cyl(0.06, TH - 0.2, 'Wood', z0=0.02, r2=0.045, segments=10)
p.cyl(R + 0.04, 0.01, 'Cloth', z0=TH - 0.01, segments=24)
p.cyl(R + 0.08, 0.26, 'Cloth', z0=TH - 0.27, r2=R + 0.04, segments=24)
for k in range(6):
    t = k*math.pi/3 + math.pi/6
    setting(p, 0.44*math.cos(t), 0.44*math.sin(t), TH + 0.002, t)
jug(p, 0.1, 0.02, TH + 0.002)
candle(p, -0.08, 0.1, TH + 0.002)
p.cyl(0.1, 0.06, 'Straw', -0.06, -0.12, TH + 0.002, r2=0.12, segments=10)           # a bread basket
for k in range(3): p.box(0.08, 0.05, 0.03, 'Bread', -0.06 + 0.035*math.cos(k*2.1), -0.12 + 0.035*math.sin(k*2.1), TH + 0.05, bevel=0.012, rot=(0.3, 0, k))
p.cyl(0.06, 0.03, 'Plate', 0.14, -0.16, TH + 0.002, r2=0.07, segments=10)          # a dish of olives
for k in range(6): p.ball(0.014, 'Olive', (0.14 + 0.03*math.cos(k), -0.16 + 0.03*math.sin(k), TH + 0.035), scale=(1, 1, 1.3))

# ------------------------------------------------------------------ seats
# a taverna chair painted blue: straight legs and stretchers, a rush seat with a cushion on it, two curved back rails
p = piece('Chair')
CS = 0.46
for sx, sy in ((1, -1), (-1, -1), (1, 1), (-1, 1)):
    p.box(0.035, 0.035, CS - 0.02, 'Wood', sx*0.19, sy*0.18, 0, bevel=0.006)
for z in (0.12, 0.22):                                                              # stretchers
    for sx in (1, -1): p.box(0.02, 0.36, 0.02, 'Wood', sx*0.19, 0, z, bevel=0.004)
    p.box(0.38, 0.02, 0.02, 'Wood', 0, -0.18 if z < 0.2 else 0.18, z, bevel=0.004)
p.box(0.42, 0.4, 0.04, 'Wood', 0, 0, CS - 0.06, bevel=0.008)
p.box(0.37, 0.35, 0.03, 'Straw', 0, 0, CS - 0.04, bevel=0.01)                      # the rush weave
p.box(0.34, 0.32, 0.025, 'Upholstery', 0, -0.01, CS - 0.015, bevel=0.012)
for sx in (1, -1):                                                                  # the back's uprights, on up from the back legs
    p.bar((sx*0.19, 0.18, CS - 0.04), (sx*0.19, 0.22, CS + 0.44), 0.035, 'Wood')
for z in (CS + 0.2, CS + 0.38):                                                     # its rails, bowed back a little
    rail = [(0.19*math.cos(math.pi*k/6), 0.19 + 0.025*math.sin(math.pi*k/6) + (z - CS)*0.09, z) for k in range(7)]
    for a, b in zip(rail, rail[1:]): p.bar(a, b, 0.05 if z > CS + 0.3 else 0.03, 'Wood')

# a booth: a whitewashed bench built out from the wall, blue cushions on it and against its back; sat facing -y, 1.5 long
p = piece('Booth')
BL, BD, BS, BH = 1.5, 0.62, 0.45, 1.2
p.box(BL, BD - 0.06, 0.06, 'Wood', 0, 0.02, 0, bevel=0.004)                        # a painted plinth
p.box(BL, BD - 0.06, BS - 0.18, 'Plaster', 0, 0.02, 0.05, bevel=0.03)
p.box(BL - 0.02, BD - 0.16, 0.12, 'Upholstery', 0, -0.03, BS - 0.13, bevel=0.035, segments=2)
p.box(BL, 0.14, BH - 0.06, 'Plaster', 0, BD/2 - 0.07, 0, bevel=0.03)              # its back
p.box(BL + 0.02, 0.18, 0.06, 'Wood', 0, BD/2 - 0.09, BH - 0.06, bevel=0.012)        # a painted ledge on top
for k in range(3):                                                                  # cushions leant on the back
    x = -BL/2 + (k + 0.5)*BL/3
    p.box(BL/3 - 0.04, 0.12, 0.42, 'Upholstery', x, BD/2 - 0.2, BS + 0.02, bevel=0.05, segments=2, rot=(-0.18, 0, 0))
for x in (-0.45, 0.4):                                                              # and a couple of white ones, blue-striped
    p.box(0.3, 0.1, 0.28, 'Cloth', x, BD/2 - 0.28, BS + 0.02, bevel=0.05, segments=2, rot=(-0.25, 0, 0.1*x))
    p.box(0.31, 0.101, 0.04, 'Check', x, BD/2 - 0.28, BS + 0.14, bevel=0.01, rot=(-0.25, 0, 0.1*x))

# ------------------------------------------------------------------ the bar
BAR_L, BAR_D, BAR_H = 3.0, 0.62, 1.07
p = piece('Bar')
p.box(BAR_L, BAR_D - 0.12, 0.1, 'Wood', 0, 0.03, 0, bevel=0.006)
p.box(BAR_L, BAR_D - 0.14, BAR_H - 0.14, 'Plaster', 0, 0.04, 0.08, bevel=0.03)
front = -(BAR_D - 0.14)/2 + 0.04
n = 20
for i in range(n):                                                                  # a Greek key band along its front
    x = -BAR_L/2 + (i + 0.5)*BAR_L/n
    w = BAR_L/n
    for (dx, dz, bw, bh) in ((0, 0, w*0.9, 0.015), (-w*0.4, 0.03, 0.015, 0.075), (0.05*w, 0.09, w*0.9, 0.015), (w*0.4, 0.03, 0.015, 0.06), (0.1*w, 0.045, w*0.5, 0.015), (-0.12*w, 0.045, 0.015, 0.03)):
        p.box(bw, 0.01, bh, 'Dome', x + dx, front - 0.012, 0.72 + dz, bevel=0)
p.box(BAR_L + 0.06, BAR_D, 0.06, 'WoodLight', 0, 0, BAR_H - 0.06, bevel=0.012)
# a glass cabinet of meze on the counter: olives, feta, dolmades
cx = 0.7
p.box(0.8, 0.34, 0.03, 'WoodLight', cx, 0.08, BAR_H, bevel=0.006)
p.box(0.78, 0.32, 0.26, 'Glass', cx, 0.08, BAR_H + 0.03, bevel=0.004)
for k, (dish, bits) in enumerate((('Olive', 0), ('Feta', 1), ('Dolma', 2))):
    x = cx - 0.24 + k*0.24
    p.box(0.2, 0.22, 0.04, 'Plate', x, 0.08, BAR_H + 0.035, bevel=0.01)
    for j in range(6):
        u, v = x - 0.05 + 0.05*(j % 3), 0.04 + 0.07*(j // 3)
        if bits == 0: p.ball(0.018, 'Olive', (u, v, BAR_H + 0.085), scale=(1, 1, 1.3))
        elif bits == 1: p.box(0.04, 0.04, 0.035, 'Feta', u, v, BAR_H + 0.075, bevel=0.005)
        else: p.cyl(0.016, 0.06, 'Dolma', u - 0.03, v, BAR_H + 0.09, segments=6, rot=(0, math.pi/2, 0))
# ouzo and little glasses, a bowl of lemons, a copper jug
for k in range(3): ouzo(p, -1.25 + k*0.1, 0.12, BAR_H, 0.26)
for k in range(4): p.cyl(0.018, 0.07, 'Glass', -0.95 + k*0.06, -0.12, BAR_H, segments=6)
p.lathe([(0.04, 0), (0.12, 0.04), (0.14, 0.07)], 'Plate', -0.4, 0.05, BAR_H, segments=12)
for k in range(5): p.ball(0.035, 'Lemon', (-0.4 + 0.06*math.cos(k*1.25), 0.05 + 0.06*math.sin(k*1.25), BAR_H + 0.07 + 0.02*(k % 2)), scale=(1.3, 1, 1))
jug(p, -0.1, 0.12, BAR_H)

# the back bar: blue-doored cupboards under a stone counter, then open shelves on whitewashed plaster: ouzo, retsina,
# wine, tins of oil; amphorae along the top, an evil eye hung in the middle
BB_L, BB_D, BB_H = 3.0, 0.42, 2.3
p = piece('BackBar')
p.box(BB_L, BB_D - 0.04, 0.9, 'Plaster', 0, 0.02, 0, bevel=0.02)
for i in range(5):
    x = -BB_L/2 + (i + 0.5)*BB_L/5
    p.box(BB_L/5 - 0.08, 0.02, 0.7, 'Wood', x, -(BB_D - 0.04)/2 + 0.01, 0.1, bevel=0.01)
    p.ball(0.015, 'Iron', (x + BB_L/10 - 0.1, -(BB_D - 0.04)/2 - 0.01, 0.62))
p.box(BB_L + 0.04, BB_D, 0.05, 'Stone', 0, 0, 0.9, bevel=0.012)
p.box(BB_L, 0.04, BB_H - 0.95, 'Plaster', 0, BB_D/2 - 0.03, 0.95, bevel=0.01)
for z in (1.3, 1.72):
    p.box(BB_L, 0.22, 0.04, 'WoodLight', 0, BB_D/2 - 0.14, z, bevel=0.008)
    for x in (-1.3, -0.45, 0.45, 1.3): p.box(0.04, 0.16, 0.08, 'Iron', x, BB_D/2 - 0.1, z - 0.08, bevel=0)   # brackets
    x = -BB_L/2 + 0.12
    while x < BB_L/2 - 0.12:
        r = random.random()
        if abs(x) < 0.12: pass
        elif r < 0.35: ouzo(p, x, BB_D/2 - 0.14, z + 0.04, random.uniform(0.26, 0.32))
        elif r < 0.55:
            p.box(0.1, 0.07, 0.16, 'Tin', x, BB_D/2 - 0.14, z + 0.04, bevel=0.006)
            p.box(0.101, 0.071, 0.06, random.choice(('Label', 'Pistachio', 'Terracotta')), x, BB_D/2 - 0.14, z + 0.09, bevel=0)
            x += 0.03
        else:
            h = random.uniform(0.26, 0.32)
            p.lathe([(0.036, 0), (0.037, h*0.62), (0.014, h*0.78), (0.012, h)], random.choice(BOTTLES), x, BB_D/2 - 0.14, z + 0.04, segments=8)
        x += random.uniform(0.08, 0.1)
for k in range(6): p.cyl(0.018, 0.07, 'Glass', -1.2 + k*0.06, -0.05, 0.95, segments=6)
jug(p, 0.8, 0, 0.95); jug(p, 0.95, 0.02, 0.95, 0.8)
p.box(BB_L + 0.1, BB_D - 0.04, 0.08, 'Wood', 0, 0.02, BB_H - 0.3, bevel=0.01)
for x in (-1.1, 0.0, 1.1): amphora(p, x, 0.02, BB_H - 0.22, 0.45)
p.cyl(0.004, 0.2, 'Black', 0, BB_D/2 - 0.06, 1.95, segments=4)                     # the evil eye
for r, mat, dy in ((0.07, 'Dome', 0), (0.045, 'Plate', -0.004), (0.028, 'Sky', -0.008), (0.013, 'Black', -0.012)):
    p.cyl(r, 0.01, mat, 0, BB_D/2 - 0.06 + dy, 1.9, segments=14, rot=(math.pi/2, 0, 0))

# the host's stand by the door: a blue podium, a wooden top, the book open on it, an oil lamp
p = piece('HostStand')
p.box(0.62, 0.44, 0.06, 'Plaster', 0, 0, 0, bevel=0.006)
p.box(0.56, 0.38, 1.0, 'Wood', 0, 0, 0.06, bevel=0.012)
for z in (0.3, 0.6): p.box(0.4, 0.02, 0.2, 'Plaster', 0, -0.19, z, bevel=0.006)
p.box(0.66, 0.5, 0.04, 'WoodLight', 0, 0.02, 1.06, bevel=0.01, rot=(-0.2, 0, 0))
p.box(0.4, 0.28, 0.025, 'Cloth', 0, 0.0, 1.1, bevel=0.004, rot=(-0.2, 0, 0))
p.box(0.01, 0.28, 0.03, 'Label', 0, 0.0, 1.1, bevel=0, rot=(-0.2, 0, 0))
p.cyl(0.05, 0.02, 'Brass', 0.24, 0.14, 1.14, segments=8)
p.lathe([(0.025, 0), (0.04, 0.03), (0.02, 0.08), (0.024, 0.2), (0.03, 0.22)], 'Glass', 0.24, 0.14, 1.16, segments=8)
p.ball(0.014, 'Flame', (0.24, 0.14, 1.22), scale=(0.7, 0.7, 1.6), detail=1)

# the kitchen's swinging doors' frame (the way through beyond: kitchenWay in interior.js); against a wall, 1.6 wide
p = piece('KitchenDoors')
p.box(0.08, 0.12, 2.2, 'Wood', -0.8, 0, 0, bevel=0.01)
p.box(0.08, 0.12, 2.2, 'Wood', 0.8, 0, 0, bevel=0.01)
p.box(1.68, 0.12, 0.1, 'Wood', 0, 0, 2.2, bevel=0.01)
# one of its two leaves (the right-hand one; the left's the same mirrored), hung by its right-hand edge: swung by the
# waiter going through (see waiterbot.js), placed on KitchenDoors by furnishRestaurant in interior.js
p = piece('KitchenDoor')
p.box(0.74, 0.05, 2.0, 'Wood', 0, -0.02, 0, bevel=0.01)
for x in (-0.18, 0.18): p.box(0.3, 0.01, 0.6, 'Plaster', x, -0.05, 0.2, bevel=0.004)   # panels
p.cyl(0.16, 0.012, 'Brass', 0, -0.042, 1.46, segments=16, rot=(math.pi/2, 0, 0))
p.cyl(0.13, 0.014, 'GlowKitchen', 0, -0.043, 1.46, segments=16, rot=(math.pi/2, 0, 0))
p.box(0.04, 0.02, 0.24, 'Brass', -0.3, -0.055, 0.96, bevel=0.005)

# a dessert trolley: baklava, a tray of galaktoboureko, loukoumades in honey, yoghurt and a jar of honey
p = piece('DessertCart')
DW, DD = 0.8, 0.5
for sx in (1, -1):
    for sy in (1, -1):
        p.cyl(0.014, 0.86, 'Iron', sx*(DW/2 - 0.03), sy*(DD/2 - 0.03), 0.06, segments=6)
        p.cyl(0.035, 0.03, 'Black', sx*(DW/2 - 0.03), sy*(DD/2 - 0.03), 0.02, segments=8, rot=(0, math.pi/2, 0))
for z in (0.25, 0.82):
    p.box(DW, DD, 0.03, 'WoodLight', 0, 0, z, bevel=0.006)
p.bar((DW/2 - 0.03, -0.2, 0.92), (DW/2 + 0.08, -0.2, 0.98), 0.02, 'Iron')
p.bar((DW/2 + 0.08, -0.2, 0.98), (DW/2 + 0.08, 0.2, 0.98), 0.025, 'Iron')
p.bar((DW/2 - 0.03, 0.2, 0.92), (DW/2 + 0.08, 0.2, 0.98), 0.02, 'Iron')
p.box(0.36, 0.3, 0.015, 'Copper', -0.18, 0, 0.85, bevel=0.004)                     # baklava, cut in diamonds
for i in range(4):
    for j in range(3):
        x, y = -0.31 + i*0.085 + (j % 2)*0.04, -0.09 + j*0.09
        if x > -0.02: continue
        p.box(0.06, 0.06, 0.04, 'Pastry', x, y, 0.865, bevel=0.006, rot=(0, 0, math.pi/4))
        p.ball(0.008, 'Pistachio', (x, y, 0.908))
p.cyl(0.13, 0.015, 'Copper', 0.2, 0, 0.85, segments=14)                           # galaktoboureko
p.cyl(0.12, 0.05, 'Custard', 0.2, 0, 0.865, segments=14)
p.cyl(0.121, 0.012, 'Pastry', 0.2, 0, 0.915, segments=14)
p.lathe([(0.04, 0), (0.12, 0.04), (0.14, 0.08)], 'Plate', -0.15, 0, 0.28, segments=12)   # loukoumades, down below
for k in range(8): p.ball(0.03, 'Honey', (-0.15 + 0.06*math.cos(k*0.8), 0.06*math.sin(k*0.8), 0.33 + 0.02*(k % 2)))
for k in range(2): p.cyl(0.05, 0.06, 'Plate', 0.12 + k*0.13, -0.08, 0.28, r2=0.06, segments=10)
for k in range(2): p.cyl(0.05, 0.012, 'Feta', 0.12 + k*0.13, -0.08, 0.33, segments=10)
p.cyl(0.05, 0.12, 'Honey', 0.2, 0.12, 0.28, segments=10)
p.cyl(0.055, 0.03, 'Check', 0.2, 0.12, 0.4, segments=10)

# a floor-standing rack of wine, the bottles' ends showing, an amphora and a demijohn on top
p = piece('WineRack')
RW, RD, RH = 1.1, 0.34, 2.0
p.box(RW, RD, 0.06, 'WoodLight', 0, 0, 0, bevel=0.008)
p.box(RW, RD, 0.05, 'WoodLight', 0, 0, RH - 0.55, bevel=0.008)
for x in (-RW/2 + 0.025, RW/2 - 0.025): p.box(0.05, RD, RH - 0.5, 'WoodLight', x, 0, 0, bevel=0.008)
p.box(RW, 0.02, RH - 0.5, 'WoodLight', 0, RD/2 - 0.01, 0, bevel=0)
cols, rows = 7, 9
cw, rh = (RW - 0.05)/cols, (RH - 0.61)/rows
for i in range(1, cols): p.box(0.015, RD - 0.02, RH - 0.61, 'Wood', -RW/2 + 0.025 + i*cw, -0.01, 0.06, bevel=0)
for j in range(1, rows): p.box(RW - 0.05, RD - 0.02, 0.012, 'Wood', 0, -0.01, 0.06 + j*rh, bevel=0)
for i in range(cols):
    for j in range(rows):
        if random.random() < 0.15: continue
        x, z = -RW/2 + 0.025 + (i + 0.5)*cw, 0.06 + (j + 0.5)*rh - 0.035
        p.cyl(0.035, 0.28, random.choice(BOTTLES), x, RD/2 - 0.02, z, segments=8, rot=(math.pi/2, 0, 0))
        p.cyl(0.014, 0.06, random.choice(('Wax', 'Label', 'Ochre')), x, -RD/2 + 0.12, z + 0.021, segments=6, rot=(math.pi/2, 0, 0))
amphora(p, -0.25, 0, RH - 0.5, 0.95)
p.ball(0.16, 'Bottle0', (0.28, 0, RH - 0.34), scale=(1, 1, 1.05))                  # a demijohn in wicker
p.cyl(0.165, 0.18, 'Straw', 0.28, 0, RH - 0.5, r2=0.17, segments=10)
p.cyl(0.03, 0.12, 'Bottle0', 0.28, 0, RH - 0.2, segments=8)

# a coat stand, a fisherman's cap on one hook
p = piece('CoatStand')
p.cyl(0.025, 1.8, 'WoodLight', segments=8)
for k in range(3):
    t = k*2*math.pi/3
    p.bar((0, 0, 0.35), (0.3*math.cos(t), 0.3*math.sin(t), 0.01), 0.03, 'WoodLight')
for k in range(4):
    t = k*math.pi/2 + math.pi/4
    p.bar((0, 0, 1.6), (0.18*math.cos(t), 0.18*math.sin(t), 1.72), 0.025, 'WoodLight')
    p.ball(0.02, 'WoodLight', (0.18*math.cos(t), 0.18*math.sin(t), 1.72))
p.ball(0.035, 'WoodLight', (0, 0, 1.82))
hx, hy = 0.18*math.cos(math.pi/4), 0.18*math.sin(math.pi/4)
p.cyl(0.1, 0.07, 'Felt', hx, hy, 1.73, r2=0.11, segments=12)
p.cyl(0.11, 0.012, 'Felt', hx, hy, 1.8, segments=12)
p.box(0.14, 0.08, 0.012, 'Black', hx - 0.06, hy - 0.06, 1.735, bevel=0.004, rot=(0.15, 0, math.pi/4))   # its peak
p.cyl(0.101, 0.012, 'Black', hx, hy, 1.745, segments=12)

# an olive tree in a terracotta pot
p = piece('Plant')
p.lathe([(0.14, 0), (0.2, 0.08), (0.22, 0.3), (0.2, 0.4), (0.24, 0.44)], 'Terracotta', segments=12)
p.cyl(0.21, 0.01, 'Soil', z0=0.41, segments=12)
trunk = [(0, 0, 0.4), (0.04, 0.02, 0.7), (-0.02, 0.01, 0.95), (0.03, -0.02, 1.2)]
for a, b in zip(trunk, trunk[1:]): p.bar(a, b, 0.06, 'Bark')
for a, b in (((0.03, -0.02, 1.15), (0.25, 0.05, 1.45)), ((0.0, 0.0, 1.1), (-0.22, -0.1, 1.4)), ((0.03, -0.02, 1.2), (0.0, 0.12, 1.55))):
    p.bar(a, b, 0.035, 'Bark')
for k in range(9):                                                                  # silvery clumps of leaves
    t = k*2.39
    r = 0.12 + 0.12*(k % 3)
    at = (r*math.cos(t), r*math.sin(t), 1.35 + 0.08*((k*7) % 4))
    p.ball(0.15, 'Leaf', at, scale=(1.2, 1.2, 0.6), detail=1)
    if k % 2: p.ball(0.018, 'Olive', (at[0] + 0.1*math.cos(t), at[1] + 0.1*math.sin(t), at[2] - 0.06), scale=(1, 1, 1.3))

# ------------------------------------------------------------------ on the walls
# Santorini: white houses and blue domes down the caldera, the sea below, in a blue frame; 2.4 wide
p = piece('Mural')
MW, MH = 2.4, 1.2
p.box(MW, 0.05, MH, 'Wood', bevel=0.012)
p.box(MW - 0.12, 0.02, MH - 0.12, 'Sky', 0, -0.02, 0.06, bevel=0)
p.box(MW - 0.12, 0.021, 0.14, 'SkyLow', 0, -0.021, 0.52, bevel=0)
p.box(MW - 0.12, 0.022, 0.46, 'Sea', 0, -0.022, 0.06, bevel=0)
p.hull([(-1.14, -0.03, 0.06), (0.1, -0.03, 0.06), (-0.2, -0.03, 0.6), (-0.7, -0.03, 0.82), (-1.14, -0.03, 0.86)], 'Rock')   # the cliff
p.hull([(0.5, -0.028, 0.52), (1.14, -0.028, 0.52), (1.14, -0.028, 0.62), (0.8, -0.028, 0.6)], 'Rock')                    # an island off
random.seed(5)
for k in range(16):                                                                 # houses stepping down the cliff
    x = -1.1 + (k % 6)*0.16 + random.uniform(-0.03, 0.03)
    z = 0.84 - (k // 6)*0.14 - (k % 6)*0.05 + random.uniform(-0.02, 0.02)
    if z < 0.12 or x > -0.1 - (0.84 - z)*0.3: continue
    w = random.uniform(0.09, 0.13)
    p.box(w, 0.01, 0.08, 'House', x, -0.04, z - 0.08, bevel=0)
    p.box(0.025, 0.012, 0.035, 'Dome' if k % 3 else 'Black', x - 0.02, -0.042, z - 0.07, bevel=0)   # a door or window
for x, z in ((-0.72, 0.8), (-0.4, 0.6)):                                           # churches, blue-domed
    p.box(0.14, 0.01, 0.1, 'House', x, -0.041, z, bevel=0)
    p.ball(0.065, 'Dome', (x, -0.045, z + 0.1), scale=(1, 0.15, 1))
    p.box(0.012, 0.01, 0.05, 'House', x, -0.05, z + 0.16, bevel=0)
p.ball(0.07, 'Lemon', (0.7, -0.03, 0.66), scale=(1, 0.15, 1))                       # the sun going down
p.box(0.07, 0.01, 0.03, 'WoodLight', 0.2, -0.04, 0.22, bevel=0)                      # a caique
p.hull([(0.2, -0.045, 0.25), (0.2, -0.045, 0.38), (0.26, -0.045, 0.25)], 'Cloth')

# painted plates hung on the wall, blue and ochre, a key round their rims; 1.2 wide
p = piece('Photos')
for x, z, r in ((-0.42, 0.52, 0.16), (-0.02, 0.6, 0.2), (0.4, 0.5, 0.15), (-0.44, 0.12, 0.13), (-0.08, 0.16, 0.15), (0.3, 0.08, 0.17)):
    zc = z + r
    p.cyl(r, 0.02, 'Plate', x, 0, zc, segments=18, rot=(math.pi/2, 0, 0))
    p.cyl(r*0.85, 0.022, 'Dome', x, 0, zc, segments=18, rot=(math.pi/2, 0, 0))
    p.cyl(r*0.72, 0.024, 'Plate', x, 0, zc, segments=18, rot=(math.pi/2, 0, 0))
    for k in range(8):                                                              # the key round the rim
        a = k*math.pi/4
        p.box(r*0.1, 0.01, r*0.1, 'Plate', x + r*0.79*math.cos(a), -0.025, zc - r*0.05 + r*0.79*math.sin(a), bevel=0)
    motif = random.choice(('fish', 'flower', 'amphora'))
    if motif == 'fish':
        p.ball(r*0.3, 'Dome', (x, -0.026, zc), scale=(1.4, 0.1, 0.6))
        p.hull([(x + r*0.35, -0.026, zc), (x + r*0.55, -0.026, zc + r*0.18), (x + r*0.55, -0.026, zc - r*0.18)], 'Dome')
    elif motif == 'flower':
        for k in range(6): p.ball(r*0.14, 'Ochre', (x + r*0.22*math.cos(k*1.05), -0.026, zc + r*0.22*math.sin(k*1.05)), scale=(1, 0.2, 1))
        p.ball(r*0.1, 'Dome', (x, -0.028, zc), scale=(1, 0.2, 1))
    else:
        p.ball(r*0.26, 'Ochre', (x, -0.026, zc - r*0.1), scale=(0.9, 0.1, 1.1))
        p.box(r*0.14, 0.008, r*0.3, 'Ochre', x, -0.026, zc + r*0.05, bevel=0)

# an iron lantern on a bracket
p = piece('WallLamp')
p.box(0.08, 0.02, 0.12, 'Iron', 0, 0, 0.02, bevel=0.004)
p.bar((0, -0.01, 0.12), (0, -0.16, 0.18), 0.015, 'Iron')
p.bar((0, -0.01, 0.05), (0, -0.14, 0.17), 0.012, 'Iron')
p.box(0.1, 0.1, 0.16, 'GlowAmber', 0, -0.16, 0.0, bevel=0)
for sx in (1, -1):
    for sy in (1, -1): p.box(0.012, 0.012, 0.16, 'Iron', sx*0.05, -0.16 + sy*0.05, 0.0, bevel=0)
p.cyl(0.075, 0.05, 'Iron', 0, -0.16, 0.16, r2=0.02, segments=4)
p.cyl(0.02, 0.03, 'Light', 0, -0.16, 0.04, segments=8)

# ------------------------------------------------------------------ to hang (from z 0.6)
# a woven rattan shade on an iron chain
p = piece('Pendant')
p.cyl(0.006, 0.34, 'Iron', z0=0.26, segments=6)
p.cyl(0.04, 0.02, 'Iron', z0=0.58, segments=8)
p.lathe([(0.27, 0.0), (0.24, 0.08), (0.12, 0.2), (0.03, 0.26)], 'Straw', segments=16)
for k in range(8):                                                                  # its weave, bands round it
    z = 0.02 + k*0.028
    r = 0.27 - (z/0.26)*0.24
    p.cyl(r + 0.004, 0.006, 'WoodLight', z0=z, segments=16)
p.cyl(0.05, 0.03, 'Light', z0=0.04, segments=8)

# a beam hung with grapevine: leaves along it, bunches of grapes; 1.6 long
p = piece('Chiantis')
p.box(1.6, 0.08, 0.08, 'WoodLight', 0, 0, 0.52, bevel=0.01)
for x in (-0.7, 0.7): p.cyl(0.006, 0.08, 'Iron', x, 0, 0.6, segments=4)
vine = [(-0.78 + k*0.13, 0.05*math.sin(k*1.7), 0.5 - 0.04*abs(math.sin(k*0.9))) for k in range(13)]
for a, b in zip(vine, vine[1:]): p.bar(a, b, 0.02, 'Bark')
for k, (x, y, z) in enumerate(vine):
    for s in (1, -1):
        if (k + (s > 0)) % 2: continue
        lx, ly, lz = x + 0.04, y + s*0.06, z - 0.06
        p.hull([(x, y, z), (lx - 0.07, ly, lz), (lx, ly + s*0.04, lz - 0.1), (lx + 0.07, ly, lz), (lx, ly - s*0.02, lz + 0.03)], 'VineLeaf')
for x in (-0.55, -0.1, 0.3, 0.62):                                                  # bunches of grapes
    top = 0.44 - random.uniform(0, 0.08)
    p.bar((x, 0, 0.5), (x, 0, top), 0.008, 'Bark')
    for row in range(5):
        for k in range(5 - row):
            a = k*2*math.pi/(5 - row) + row
            rr = 0.012*(5 - row)
            p.ball(0.02, 'Grape', (x + rr*math.cos(a), rr*math.sin(a), top - 0.03 - row*0.03), detail=1)

# a great mass of greenery to hang from the ceiling (its top at z 0.6 as the rest, so put its top to the ceiling): leaves
# in clumps, pink and red roses, gilded branches reaching out of each end, strands trailing down; 3 long, 1.4 wide
p = piece('Greenery')
GL, GW, TOP = 3.0, 1.4, 0.6
random.seed(21)
p.box(GL*0.8, GW*0.5, 0.04, 'FernDark', 0, 0, TOP - 0.04, bevel=0.01)              # the frame it's all wired to
for k in range(70):                                                                 # clumps of leaves, deeper in the middle
    u, v = random.uniform(-1, 1), random.uniform(-1, 1)
    if u*u + v*v*1.2 > 1.1: continue
    depth = 0.15 + 0.3*(1 - abs(u))*(1 - abs(v)*0.6)
    at = (u*GL/2, v*GW/2, TOP - random.uniform(0.05, depth))
    p.ball(random.uniform(0.12, 0.22), random.choice(('Fern', 'Fern', 'FernLight', 'FernDark')), at, scale=(1.5, 1.2, 0.7), rot=(0, 0, random.uniform(0, 3)), detail=1)
for k in range(26):                                                                 # strands trailing down
    x, y, z = random.uniform(-0.95, 0.95)*GL/2, random.uniform(-0.8, 0.8)*GW/2, TOP - 0.15
    for j in range(int(random.uniform(0.25, 0.7)/0.09)):
        x2, y2, z2 = x + random.uniform(-0.03, 0.03), y + random.uniform(-0.03, 0.03), z - 0.09
        p.bar((x, y, z), (x2, y2, z2), 0.01, 'FernDark', bevel=0)
        p.ball(0.035, random.choice(('Fern', 'FernLight')), (x2, y2, z2), scale=(1.4, 0.5, 0.8), rot=(0, 0, random.uniform(0, 3)), detail=0)
        x, y, z = x2, y2, z2
for k in range(34):                                                                 # roses
    u, v = random.uniform(-0.95, 0.95), random.uniform(-0.9, 0.9)
    p.ball(random.uniform(0.035, 0.05), random.choice(('Rose', 'RosePink', 'RosePink')), (u*GL/2, v*GW/2, TOP - random.uniform(0.12, 0.42)*(1 - abs(u)*0.5)), detail=1)
for s in (1, -1):                                                                   # gilded branches
    for k in range(4):
        x, y, z, a = s*GL*0.3, random.uniform(-0.4, 0.4), TOP - 0.12, random.uniform(-0.5, 0.5)
        for j in range(5):
            x2, y2, z2 = x + s*0.14*math.cos(a), y + 0.14*math.sin(a), z + random.uniform(-0.04, 0.03)
            p.bar((x, y, z), (x2, y2, z2), 0.022 - j*0.003, 'Twig', bevel=0)
            if j > 1:
                t = a + random.choice((-1, 1))*0.8
                p.bar((x2, y2, z2), (x2 + s*0.1*math.cos(t), y2 + 0.1*math.sin(t), z2 - 0.02), 0.01, 'Twig', bevel=0)
            x, y, z, a = x2, y2, z2, a + random.uniform(-0.4, 0.4)

# ------------------------------------------------------------------ to carry (as Restaurant.glb's Spaghetti and PizzaSlice)
p = piece('Moussaka')                                                               # a slab of it, with tomato
p.cyl(0.12, 0.014, 'Plate', r2=0.14, segments=14)
z = 0.014
for mat, h in (('Aubergine', 0.01), ('Mince', 0.014), ('Aubergine', 0.008), ('Mince', 0.01), ('Bechamel', 0.018)):
    p.box(0.11, 0.085, h, mat, -0.01, 0, z, bevel=0.003)
    z += h
for k in range(6):
    p.ball(0.012, 'Browned', (-0.05 + k*0.018, random.uniform(-0.03, 0.03), z), scale=(1, 1, 0.3), detail=0)
for k in range(3):
    p.ball(0.018, 'Tomato', (0.075, -0.03 + k*0.03, 0.024), scale=(1, 0.7, 0.6), detail=1)
p.box(0.03, 0.02, 0.004, 'Leaf', -0.01, 0, z + 0.002, bevel=0, rot=(0, 0, 0.5))

# a souvlaki skewer, laid flat: point at the middle, handle along +y (eight make a platter)
p = piece('Souvlaki')
p.bar((0, 0.005, 0.012), (0, 0.17, 0.012), 0.006, 'Skewer', bevel=0)
for k in range(5):
    y = 0.03 + k*0.022
    if k % 2:
        p.box(0.03, 0.008, 0.026, random.choice(('Pepper', 'Onion')), 0, y, 0.0, bevel=0.002)
    else:
        p.box(0.026, 0.02, 0.024, 'Grilled', 0, y, 0.0, bevel=0.005)
        p.box(0.02, 0.014, 0.004, 'Charred', 0, y, 0.024, bevel=0)

# ------------------------------------------------------------------ out
export(OUT)
