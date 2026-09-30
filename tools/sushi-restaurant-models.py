# Builds assets/models/RestaurantSushi.glb: a kaiten sushi bar's pieces (see furnishSushi in buildings/interior.js), in
# the same low-poly, flat-coloured style as Restaurant.glb.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/sushi-restaurant-models.py
#
# The chef's SushiBar (a hinoki counter, a glass neta case of fish on it) and the BackCounter behind him (rice tub,
# knives, a maneki-neko); low Stools with a little back; Booths (benches) and a BoothTable. Condiments for the belt's
# island (the belt itself is built in JS). A Noren to hang over the belt's hatch; a paper Lantern and a bamboo Pendant to
# hang; for the walls a WavePrint and MenuTags; a bamboo Plant. Dish0..5, plates of sushi, the plate's colour its price
# (green, blue, red, yellow, black, pink), and Empty0..5, the same plates eaten off. A Headband for the chef.
# One top-level mesh per piece, at five times life size, each facing -y. Wall pieces stand on their own bottom edge;
# hung ones hang from z 0.6.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'RestaurantSushi.glb')
random.seed(21)

# (the ones to recolour per restaurant: Wood, Upholstery, Noren)
material('Wood', 0x3a2a1e, 0.6)
material('Hinoki', 0xe8cc98, 0.6)
material('Upholstery', 0x2a3a6a, 0.9)
material('Noren', 0x22305a, 0.9)
material('NorenInk', 0xf4f0e6, 0.9)
material('Chrome', 0xc8ccd0, 0.25, 0.8)
material('Black', 0x141416, 0.6)
material('Glass', 0xd0e4e4, 0.08)
material('White', 0xf4f2ec, 0.5)
material('Red', 0xb81e1e, 0.6)
material('Gold', 0xd8a830, 0.35, 0.6)
material('Paper', 0xf4ecd8, 0.9)
material('Bamboo', 0x9aa850, 0.6)
material('BambooDark', 0x6a7a30, 0.6)
material('Leaf', 0x4a8a3a, 0.8)
material('Pot', 0x2a2a2e, 0.7)
material('Soil', 0x4a2a18, 0.9)
material('Stone', 0x8a8a84, 0.9)
material('Soy', 0x2a140a, 0.2)
material('Ginger', 0xf0c0b0, 0.7)
material('Matcha', 0x8aa83a, 0.8)
material('Ceramic', 0xe8e0cc, 0.4)
material('Indigo', 0x2a3a6a, 0.8)
material('Wave', 0x2a4a8a, 0.9)
material('Foam', 0xf2f2ea, 0.9)
material('Sky', 0xe8dcc0, 0.9)
material('Rice', 0xf6f4ec, 0.8)
material('Salmon', 0xf08a5a, 0.5)
material('SalmonFat', 0xf8c8a8, 0.5)
material('Tuna', 0xb8283a, 0.5)
material('Egg', 0xf0cc40, 0.7)
material('Nori', 0x1a2418, 0.8)
material('Cucumber', 0x5aa03a, 0.6)
material('Shrimp', 0xf07a4a, 0.5)
material('ShrimpWhite', 0xf8e8e0, 0.5)
material('Roe', 0xe8481e, 0.2)
material('Wasabi', 0x9ac04a, 0.8)
material('Light', 0x000000, 1.0, glow=0xffe0b0)
material('GlowLantern', 0xc81e1e, 0.8, glow=0xe84830)
PLATES = [('PlateGreen', 0x3a9a4a), ('PlateBlue', 0x2a5ab8), ('PlateRed', 0xc8282a), ('PlateYellow', 0xe8c030),
          ('PlateBlack', 0x1c1c20), ('PlatePink', 0xe87aa8)]
for name, colour in PLATES: material(name, colour, 0.3)

# ------------------------------------------------------------------ plates of sushi
PR = 0.075   # a plate's radius
def plate(p, mat):
    p.cyl(PR*0.6, 0.008, mat, r2=PR*0.62, segments=16)
    p.cyl(PR*0.62, 0.012, mat, z0=0.008, r2=PR, segments=16)
Z = 0.02     # the plate's top

# a nigiri at (x, y), long along x: rice, its topping draped over
def nigiri(p, x, y, top, stripe=None):
    p.box(0.05, 0.022, 0.018, 'Rice', x, y, Z, bevel=0.007, segments=2)
    p.box(0.062, 0.028, 0.008, top, x, y, Z + 0.016, bevel=0.003, rot=(0, 0.06, 0))
    if stripe: p.box(0.012, 0.03, 0.022, stripe, x, y, Z + 0.004, bevel=0.002)

# a maki at (x, y): nori round rice, a filling
def maki(p, x, y, filling):
    p.cyl(0.016, 0.022, 'Nori', x, y, Z, segments=10)
    p.cyl(0.013, 0.0225, 'Rice', x, y, Z, segments=10)
    p.cyl(0.005, 0.023, filling, x, y, Z, segments=6)

def dish(n, empty=False):
    mat = PLATES[n][0]
    p = piece(('Empty%d' if empty else 'Dish%d') % n)
    plate(p, mat)
    if empty: return
    if n == 0:
        for y in (-0.018, 0.018):
            nigiri(p, 0, y, 'Salmon')
            for k in (-1, 0, 1): p.box(0.003, 0.03, 0.001, 'SalmonFat', k*0.016, y, Z + 0.025, bevel=0, rot=(0, 0, 0.5))
    elif n == 1:
        for y in (-0.018, 0.018): nigiri(p, 0, y, 'Tuna')
    elif n == 2:
        for x, y in ((-0.02, -0.018), (0.02, -0.018), (0, 0.018)): maki(p, x, y, 'Cucumber')
    elif n == 3:
        for y in (-0.018, 0.018): nigiri(p, 0, y, 'Egg', stripe='Nori')
    elif n == 4:
        for y in (-0.018, 0.018):
            nigiri(p, 0, y, 'Shrimp')
            for k in (-1, 0, 1): p.box(0.004, 0.03, 0.001, 'ShrimpWhite', k*0.018, y, Z + 0.025, bevel=0)
    elif n == 5:
        for y in (-0.02, 0.02):                                                    # gunkan: nori round rice, roe on top
            p.box(0.045, 0.026, 0.026, 'Nori', 0, y, Z, bevel=0.009, segments=2)
            for k in range(7): p.ball(0.005, 'Roe', (random.uniform(-0.014, 0.014), y + random.uniform(-0.006, 0.006), Z + 0.026), detail=1)
    p.ball(0.008, 'Wasabi', (0.045, 0, Z + 0.002), scale=(1, 1, 0.6))
    for k in range(3): p.box(0.018, 0.012, 0.002, 'Ginger', -0.048, (k - 1)*0.008, Z + 0.001 + k*0.002, bevel=0.001, rot=(0, 0, k*0.6))

for n in range(len(PLATES)):
    dish(n)
    dish(n, empty=True)

# ------------------------------------------------------------------ the chef's bar
# SushiBar: BL long; the customers' hinoki top at CH (towards -y), a step up at the back with the glass neta case on it,
# the chef's work top behind (towards +y) at 0.9.
BL, BD, CH = 3.6, 0.72, 0.74
p = piece('SushiBar')
p.box(BL, 0.5, CH - 0.04, 'Wood', 0, 0.08, 0, bevel=0.01)
p.box(BL - 0.04, 0.04, 0.12, 'Black', 0, -0.17, 0, bevel=0)                          # a kick
p.box(BL + 0.04, 0.5, 0.05, 'Hinoki', 0, -0.27, CH - 0.05, bevel=0.012)            # the customers' worktop, overhung for knees
p.box(BL + 0.04, 0.03, 0.08, 'Black', 0, -0.505, CH - 0.1, bevel=0.005)            # its front lip
p.box(BL, 0.36, 0.2, 'Hinoki', 0, 0.16, CH - 0.05, bevel=0.01)                      # the step, up to the case
# the chef's side: a prep counter, cupboards under, a board with a knife and a block of fish, rice, bowls
WY = BD/2 + 0.2
p.box(BL, 0.44, 0.86, 'Wood', 0, WY, 0, bevel=0.01)
for k in range(6): p.box(BL/6 - 0.03, 0.01, 0.6, 'Hinoki', (k - 2.5)*BL/6, WY + 0.22, 0.14, bevel=0.004)  # cupboard doors
p.box(BL + 0.02, 0.48, 0.04, 'Hinoki', 0, WY, 0.86, bevel=0.008)                    # the work top
for bx in (-0.9, 0.7):
    p.box(0.5, 0.3, 0.025, 'Ceramic', bx, WY + 0.02, 0.9, bevel=0.006)              # a cutting board
    p.box(0.26, 0.025, 0.004, 'Chrome', bx + 0.02, WY + 0.08, 0.925, bevel=0)        # a knife: blade, handle
    p.box(0.12, 0.02, 0.018, 'Black', bx + 0.21, WY + 0.08, 0.925, bevel=0.004)
p.box(0.22, 0.09, 0.05, 'Salmon', -0.95, WY - 0.04, 0.925, bevel=0.015)
p.box(0.18, 0.08, 0.05, 'Tuna', 0.65, WY - 0.03, 0.925, bevel=0.015)
p.cyl(0.2, 0.12, 'Hinoki', -0.1, WY + 0.02, 0.9, segments=16)                      # a rice tub
p.cyl(0.18, 0.02, 'Rice', -0.1, WY + 0.02, 1.0, segments=16)
p.box(0.05, 0.01, 0.2, 'Hinoki', -0.02, WY + 0.02, 1.0, bevel=0.003, rot=(0.4, 0, 0))   # its paddle
for k in range(3): p.cyl(0.07, 0.05, 'Ceramic', 1.35 + (k - 1)*0.16, WY + 0.05, 0.9, r2=0.09, segments=10)
p.cyl(0.06, 0.06, 'Black', -1.45, WY + 0.05, 0.9, segments=10)                     # a pot of chopsticks
for k in range(5): p.cyl(0.004, 0.2, 'Hinoki', -1.45 + (k - 2)*0.015, WY + 0.05, 0.94, segments=4)
# the neta case: glass front sloped towards the customer, a chrome frame, fish laid out on ice
CZ, CD = CH + 0.15, 0.3
p.box(BL - 0.1, CD, 0.02, 'Chrome', 0, 0.12, CZ, bevel=0.004)
p.box(BL - 0.14, CD - 0.04, 0.02, 'White', 0, 0.12, CZ + 0.02, bevel=0.004)          # ice
for sx in range(-4, 5):
    x = sx*BL/9.5
    top = ['Salmon', 'Tuna', 'Salmon', 'Shrimp', 'Tuna', 'Egg', 'Salmon', 'Tuna', 'Roe'][sx + 4]
    p.box(0.28, 0.12, 0.05, top, x, 0.12, CZ + 0.04, bevel=0.015, rot=(0, 0, 0.05*(sx % 3 - 1)))
    p.box(0.04, 0.04, 0.02, 'Leaf', x + 0.15, 0.06, CZ + 0.04, bevel=0.01)
p.hull([(-BL/2 + 0.05, -0.04, CZ), (BL/2 - 0.05, -0.04, CZ), (-BL/2 + 0.05, 0.02, CZ + 0.2), (BL/2 - 0.05, 0.02, CZ + 0.2),
        (-BL/2 + 0.05, -0.035, CZ), (BL/2 - 0.05, -0.035, CZ), (-BL/2 + 0.05, 0.025, CZ + 0.2), (BL/2 - 0.05, 0.025, CZ + 0.2)], 'Glass')
p.box(BL - 0.1, CD - 0.05, 0.012, 'Glass', 0, 0.14, CZ + 0.2, bevel=0)
for sx in (-1, 1): p.box(0.02, CD, 0.2, 'Chrome', sx*(BL/2 - 0.05), 0.12, CZ, bevel=0)
p.box(BL - 0.1, 0.01, 0.015, 'Light', 0, 0.26, CZ + 0.18, bevel=0)                  # a strip light at the back of the case

# BackCounter: against the wall behind the chef, BL long, 0.6 deep, 0.9 high; a rice tub, a knife rack, a maneki-neko
BK = 0.6
p = piece('BackCounter')
p.box(BL, BK, 0.86, 'Chrome', 0, 0, 0, bevel=0.01)
p.box(BL + 0.02, BK + 0.02, 0.04, 'Chrome', 0, 0, 0.86, bevel=0.006)
for k in range(4): p.box(BL/4 - 0.04, 0.01, 0.7, 'White', (k - 1.5)*BL/4, -BK/2 - 0.004, 0.08, bevel=0.004)   # fridge doors
for k in range(4): p.box(0.3, 0.02, 0.03, 'Chrome', (k - 1.5)*BL/4, -BK/2 - 0.015, 0.7, bevel=0.005)
p.cyl(0.22, 0.14, 'Hinoki', -1.1, 0.02, 0.9, r2=0.23, segments=16)                  # the hangiri, rice in it
p.cyl(0.2, 0.12, 'Rice', -1.1, 0.02, 0.91, segments=16)
for k in range(3): p.box(0.4, 0.3, 0.03, 'Hinoki', -0.3 + k*0.02, 0.05, 0.9 + k*0.03, bevel=0.006)   # cutting boards
p.box(0.36, 0.04, 0.3, 'Wood', 0.5, BK/2 - 0.04, 0.9, bevel=0.006)                  # the knife rack
for k in range(4):
    p.box(0.02, 0.012, 0.2, 'Chrome', 0.38 + k*0.08, BK/2 - 0.07, 1.12, bevel=0.002)
    p.box(0.022, 0.02, 0.1, 'Black', 0.38 + k*0.08, BK/2 - 0.07, 1.22, bevel=0.004)
# the maneki-neko, waving
MX = 1.3
p.ball(0.07, 'White', (MX, 0, 0.97), scale=(1, 0.85, 1.1), detail=2)
p.ball(0.06, 'White', (MX, -0.01, 1.1), scale=(1.1, 0.95, 1), detail=2)
for sx in (-1, 1): p.hull([(MX + sx*0.05, -0.02, 1.13), (MX + sx*0.03, -0.02, 1.13), (MX + sx*0.045, -0.02, 1.19), (MX + sx*0.045, 0, 1.13)], 'White')
p.ball(0.022, 'White', (MX + 0.08, -0.02, 1.1), scale=(0.8, 0.8, 1.4))             # the paw, up
p.box(0.1, 0.01, 0.014, 'Red', MX, -0.055, 1.03, bevel=0)                           # its collar
p.ball(0.012, 'Gold', (MX, -0.06, 1.02))
p.box(0.06, 0.012, 0.04, 'Gold', MX - 0.02, -0.06, 0.96, bevel=0.003)               # its koban
for sx in (-1, 1): p.ball(0.006, 'Black', (MX + sx*0.022, -0.065, 1.11))

# ------------------------------------------------------------------ seats
# a low stool, its seat at 0.48, a little back to it
SH = 0.48
p = piece('Stool')
p.cyl(0.03, SH - 0.05, 'Chrome', z0=0, segments=8)
p.cyl(0.18, 0.02, 'Chrome', segments=14)
p.cyl(0.19, 0.03, 'Wood', z0=SH - 0.07, segments=14)
p.cyl(0.19, 0.05, 'Upholstery', z0=SH - 0.05, r2=0.17, segments=14)
p.bar((0, 0.16, SH - 0.05), (0, 0.19, SH + 0.2), 0.03, 'Chrome')
p.box(0.3, 0.05, 0.1, 'Wood', 0, 0.19, SH + 0.14, bevel=0.015)

# a booth's bench: a wooden box, a cushion, a slatted back; BoothTable a plain dark table set with soy and chopsticks
p = piece('Booth')
BW = 1.3
p.box(BW, 0.5, 0.4, 'Wood', 0, 0, 0, bevel=0.01)
p.box(BW - 0.04, 0.48, 0.06, 'Upholstery', 0, -0.01, 0.4, bevel=0.02)
p.box(BW, 0.08, 0.7, 'Wood', 0, 0.24, 0.4, bevel=0.01)
for k in range(9): p.box(0.08, 0.02, 0.5, 'Hinoki', (k - 4)*BW/9.5, 0.19, 0.5, bevel=0.004)
p.box(BW, 0.1, 0.04, 'Wood', 0, 0.24, 1.1, bevel=0.01)

TH = 0.72
def chopsticks(p, x, y, z):
    p.box(0.03, 0.02, 0.01, 'Ceramic', x, y, z, bevel=0.003)                          # a rest
    for k in (-1, 1): p.bar((x - 0.08, y + k*0.006, z + 0.012), (x + 0.13, y + k*0.004, z + 0.012), 0.006, 'Hinoki', bevel=0)
def soy(p, x, y, z):
    p.lathe([(0.025, 0), (0.028, 0.05), (0.012, 0.08), (0.01, 0.1)], 'Glass', x, y, z, segments=8)
    p.cyl(0.024, 0.04, 'Soy', x, y, z + 0.004, segments=8)
    p.cyl(0.016, 0.02, 'Red', x, y, z + 0.1, segments=8)
def cup(p, x, y, z):
    p.cyl(0.03, 0.07, 'Ceramic', x, y, z, r2=0.034, segments=10)
    p.cyl(0.028, 0.06, 'Matcha', x, y, z + 0.005, r2=0.03, segments=10)
p = piece('BoothTable')
p.box(1.1, 0.7, 0.04, 'Wood', 0, 0, TH - 0.04, bevel=0.008)
p.box(0.12, 0.5, TH - 0.04, 'Wood', 0, 0, 0, bevel=0.01)
p.box(0.6, 0.5, 0.03, 'Wood', 0, 0, 0, bevel=0.01)
for x in (-0.28, 0.28):
    for s in (1, -1): chopsticks(p, x, s*0.22, TH)
soy(p, 0, 0.05, TH); cup(p, 0.1, -0.05, TH)
p.box(0.08, 0.06, 0.1, 'Wood', -0.1, 0, TH, bevel=0.01)                              # a chopstick box

# ------------------------------------------------------------------ on the belt's island
# Condiments: soy, a ginger pot, powdered tea, a hot-water tap, cups and chopsticks, down the middle of the island
p = piece('Condiments')
soy(p, -0.18, 0, 0)
p.cyl(0.045, 0.08, 'Ceramic', -0.06, 0, 0, r2=0.04, segments=10)                    # the ginger pot
p.cyl(0.043, 0.02, 'Wood', -0.06, 0, 0.08, segments=10)
p.cyl(0.035, 0.08, 'Hinoki', 0.05, 0, 0, segments=10)                                # the tea tin
p.box(0.14, 0.05, 0.16, 'Chrome', 0.2, 0, 0, bevel=0.01)                             # the tap
p.box(0.02, 0.08, 0.02, 'Chrome', 0.2, -0.05, 0.12, bevel=0.004)
p.box(0.03, 0.03, 0.03, 'Black', 0.2, -0.08, 0.1, bevel=0.005)
cup(p, 0.32, 0, 0)
p.box(0.08, 0.1, 0.12, 'Wood', 0.42, 0, 0, bevel=0.01)                               # chopsticks
for k in range(6): p.box(0.006, 0.006, 0.05, 'Hinoki', 0.4 + (k % 3)*0.02, -0.02 + (k//3)*0.03, 0.12, bevel=0)

# ------------------------------------------------------------------ hung
# a noren to hang over the belt's hatch: a short curtain of four panels on a pole, a white wave on it
p = piece('Noren')
NW = 1.5
p.bar((-NW/2 - 0.05, 0, 0.6), (NW/2 + 0.05, 0, 0.6), 0.03, 'Wood')
for k in range(4):
    x = (k - 1.5)*NW/4
    p.box(NW/4 - 0.03, 0.01, 0.42, 'Noren', x, 0, 0.17, bevel=0)
    p.box(NW/4 - 0.12, 0.012, 0.03, 'NorenInk', x, 0, 0.38, bevel=0)
p.ball(0.07, 'NorenInk', (0, -0.006, 0.38), scale=(1, 0.1, 1))

# a red paper lantern on a cord
p = piece('Lantern')
p.bar((0, 0, 0.35), (0, 0, 0.6), 0.008, 'Black')
p.cyl(0.07, 0.03, 'Black', z0=0.32, segments=10)
p.ball(0.2, 'GlowLantern', (0, 0, 0.18), scale=(1, 1, 0.8), detail=2)
for z in (0.06, 0.12, 0.18, 0.24, 0.3): p.cyl(0.2*math.sqrt(max(0, 1 - ((z - 0.18)/0.16)**2)) + 0.004, 0.006, 'Black', z0=z, segments=16)
p.cyl(0.07, 0.03, 'Black', z0=0.02, segments=10)
p.box(0.04, 0.01, 0.08, 'Light', 0, 0, 0.14, bevel=0)

# a bamboo pendant: a woven cone over a bulb
p = piece('Pendant')
p.bar((0, 0, 0.2), (0, 0, 0.6), 0.008, 'Black')
p.cyl(0.22, 0.2, 'Bamboo', z0=0, r2=0.04, segments=14)
p.cyl(0.2, 0.004, 'Light', z0=0.002, segments=12)

# ------------------------------------------------------------------ on the walls
# a print of a great wave: a frame, a sky, a curling blue wave with white foam, a small mountain
p = piece('WavePrint')
W, H = 1.1, 0.75
p.box(W, 0.04, H, 'Wood', 0, 0, 0, bevel=0.006)
p.box(W - 0.08, 0.01, H - 0.08, 'Sky', 0, -0.02, 0.04, bevel=0)
p.hull([(-0.1, -0.03, 0.1), (0.05, -0.03, 0.1), (-0.02, -0.03, 0.2)], 'Stone')
for k in range(7):
    t = k/6
    x, z = -0.45 + t*0.5, 0.05 + math.sin(t*math.pi*0.9)*0.52
    p.ball(0.09 - t*0.02, 'Wave', (x, -0.03, z), scale=(1.2, 0.2, 1))
    p.ball(0.03, 'Foam', (x + 0.06, -0.045, z + 0.06), scale=(1, 0.2, 1))
for k in range(4): p.ball(0.06, 'Wave', (0.1 + k*0.08, -0.03, 0.08 + 0.04*(k % 2)), scale=(1.3, 0.2, 0.8))
p.ball(0.05, 'Red', (0.34, -0.03, 0.55), scale=(1, 0.2, 1))                          # a seal
p.box(0.03, 0.01, 0.3, 'Paper', 0.4, -0.03, 0.2, bevel=0)

# a row of wooden menu tags, hung from a rail, each lettered in black, a red price tag or two
p = piece('MenuTags')
MW = 1.8
p.box(MW, 0.03, 0.04, 'Wood', 0, 0, 0.42, bevel=0.005)
for k in range(12):
    x = (k - 5.5)*MW/12.5
    p.box(0.12, 0.012, 0.4, 'Red' if k % 5 == 2 else 'Hinoki', x, -0.02, 0.0, bevel=0.004)
    for j in range(3): p.box(0.05, 0.004, 0.05, 'Black', x, -0.028, 0.28 - j*0.09, bevel=0)

# ------------------------------------------------------------------ a plant
# bamboo in a square black pot, white stones round it
p = piece('Plant')
p.box(0.4, 0.4, 0.45, 'Pot', 0, 0, 0, bevel=0.02)
p.box(0.36, 0.36, 0.02, 'Stone', 0, 0, 0.44, bevel=0.01)
for k in range(6):
    a, r = k*2.3, 0.06 + (k % 3)*0.03
    x, y, h = r*math.cos(a), r*math.sin(a), 1.2 + random.random()*0.6
    for j in range(int(h/0.3)):
        p.cyl(0.018, 0.29, 'Bamboo' if k % 2 else 'BambooDark', x + j*0.004*math.cos(a), y + j*0.004*math.sin(a), 0.45 + j*0.3, segments=6)
        p.cyl(0.021, 0.015, 'BambooDark', x + j*0.004*math.cos(a), y + j*0.004*math.sin(a), 0.45 + j*0.3 + 0.28, segments=6)
    for j in range(5):
        t = a + j*1.3
        z = 0.45 + h*(0.55 + j*0.08)
        p.hull([(x, y, z), (x + 0.28*math.cos(t), y + 0.28*math.sin(t), z - 0.08), (x + 0.12*math.cos(t) + 0.03*math.sin(t), y + 0.12*math.sin(t) - 0.03*math.cos(t), z - 0.02)], 'Leaf')

# ------------------------------------------------------------------ the chef's headband (worn: see waiterbot.js)
# a white hachimaki, a red sun on its front, knotted at the back
p = piece('Headband')
for k in range(16):
    a0, a1 = k*2*math.pi/16, (k + 1)*2*math.pi/16
    p.hull([(0.1*math.cos(a), 0.1*math.sin(a), z) for a in (a0, a1) for z in (0, 0.035)] +
           [(0.108*math.cos(a), 0.108*math.sin(a), z) for a in (a0, a1) for z in (0, 0.035)], 'White')
p.ball(0.014, 'Red', (0, -0.109, 0.0175), scale=(1, 0.2, 1))
p.ball(0.02, 'White', (0, 0.11, 0.02))
for sx in (-1, 1): p.box(0.025, 0.01, 0.07, 'White', sx*0.015, 0.115, -0.05, bevel=0.003, rot=(0, sx*0.3, 0))

export(OUT)
