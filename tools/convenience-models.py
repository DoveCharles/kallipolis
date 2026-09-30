# Builds assets/models/Convenience.glb: a 24-hour convenience store's fittings (a 7-Eleven sort of place, with a
# pharmacy corner and umbrellas by the door), in the same low-poly, flat-coloured style as Salon.glb's.
#
#   blender -b --python tools/convenience-models.py      (or, with the bpy module installed: python3 tools/convenience-models.py)
#
# Shelving: an Aisle (a double-sided gondola, reached from -y and +y), a WallShelf, a DrinksFridge (glass doors, lit
# inside), a FridgeAisle (double-sided glass-door fridges), a Chiller (open, sandwiches and milk), a FreezerChest of ice creams, a SnackRack of crisps. The Counter (till, card reader, scratchcards, hot dog
# roller) with a Gantry of cigarettes behind it; a Pharmacy (medicine shelves under a green cross); a CoffeeStation and
# a SlushieMachine; an UmbrellaStand, a NewsRack, an ATM, a BasketStack, a DoorMat, a Poster and a Tube light.
# Shelving is empty: its Slots are stocked by interior.js from the Item_ pieces (cans, cereal, milk...).
# To carry: Umbrella (shut), UmbrellaOpen, Slushie, Coffee, Bag, Pills.
# One top-level mesh per piece, at five times life size, each facing -y (the room's +z, once exported); wall pieces'
# backs at +y. Poster stands on its own bottom edge; interior.js lifts it up the wall.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import MATERIALS, material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Convenience.glb')
random.seed(711)

# (Fixture, Stripe and Stripe2 are the ones to recolour per store: its shelving, and its two brand colours)
material('Fixture', 0xe8e8e4, 0.4)
material('Stripe', 0x1a8a4a, 0.5)
material('Stripe2', 0xe86a1a, 0.5)
material('Stripe3', 0xd02030, 0.5)
material('Steel', 0xb8bcc0, 0.3, 0.7)
material('Chrome', 0xd0d4d8, 0.2, 0.85)
material('Black', 0x141416, 0.5)
material('Grey', 0x505458, 0.6)
material('White', 0xf2f0ea, 0.6)
material('Glass', 0xd0e4e4, 0.08)
material('Laminate', 0xd8d0c0, 0.4)
material('Rubber', 0x2a2a2c, 0.95)
material('Paper', 0xf4f0e4, 0.9)
material('Tag', 0xf2d22a, 0.7)
material('Newsprint', 0xd8d4c8, 0.9)
material('Cardboard', 0xb08a58, 0.9)
material('Sausage', 0xb0502a, 0.4)
material('Bun', 0xe0b070, 0.8)
material('Coffee', 0x3a2214, 0.3)
material('Cup', 0xf2ece0, 0.6)
material('Lid', 0x2a2a2c, 0.4)
material('SlushRed', 0xe02040, 0.2)
material('SlushBlue', 0x2080e8, 0.2)
material('Pill', 0xf4f4f0, 0.3)
material('Light', 0x000000, 1.0, glow=0xf4f8ff)
material('GlowFridge', 0x303a40, 0.3, glow=0xdcecf4)
material('GlowScreen', 0x1a2a3a, 0.3, glow=0x5ab0e8)
material('GlowTill', 0x1a2a1a, 0.3, glow=0x7ac87a)
material('GlowCross', 0x10401a, 0.4, glow=0x30e060)
for i, colour in enumerate((0xe8407a, 0x40a8e0, 0xf0d040, 0x60c060, 0xe8e8e8, 0x9a40c0, 0xf08030, 0x202020,
                            0xc82020, 0x2040a0)):
    material('Pack%d' % i, colour, 0.35)
PACKS = ['Pack%d' % i for i in range(10)]
material('CigRed', 0xc8102e, 0.45)
material('CigGold', 0xc8a040, 0.35, 0.4)
material('CigBlue', 0x1a3a8a, 0.45)
material('CigNavy', 0x14204a, 0.45)
material('CigGreen', 0x1a6a3a, 0.45)
material('CigPurple', 0x5a2a7a, 0.45)
material('CigDrab', 0x4a4232, 0.8)
material('CigFoil', 0xd8dcdc, 0.25, 0.7)
material('CigWarn', 0x18181a, 0.6)
CIG_BRANDS = [('White', 'CigRed'), ('White', 'CigGold'), ('White', 'CigBlue'), ('Black', 'CigGold'), ('CigNavy', 'Steel'),
              ('CigGreen', 'White'), ('CigPurple', 'Steel'), ('CigRed', 'White'), ('CigDrab', 'CigDrab'), ('CigDrab', 'CigDrab')]
for i, colour in enumerate((0x1a4a8a, 0x8a1a2a, 0x2a6a3a, 0xe8c030, 0x6a2a8a)):
    material('Canopy%d' % i, colour, 0.8)
CANOPIES = ['Canopy%d' % i for i in range(5)]

# ------------------------------------------------------------------ stock
# Shelving comes empty: each shelf carries a Slot, an invisible box over it that interior.js stocks from the Item_
# pieces below (stockShelf). Its material says what goes there and which way it faces the shop:
# Slot_<kind>_<f: front at -y | b: front at +y>_<n>, kind dry, drink, chill, frozen or hang.
def slot(p, kind, face, x0, x1, y0, y1, z0, h):
    p.slots = getattr(p, 'slots', 0) + 1
    name = 'Slot_%s_%s_%d' % (kind, face, p.slots)
    if name not in MATERIALS: material(name, 0xff00ff)
    p.box(x1 - x0, y1 - y0, h, name, (x0 + x1)/2, (y0 + y1)/2, z0 + 0.003, bevel=0)

# a glass door's chrome frame: w wide, h tall, standing on z0, open in the middle
def frame(p, w, h, x, y, z0, t=0.035, d=0.03):
    p.box(w, d, t, 'Chrome', x, y, z0, bevel=0)
    p.box(w, d, t, 'Chrome', x, y, z0 + h - t, bevel=0)
    for s in (-1, 1):
        p.box(t, d, h, 'Chrome', x + s*(w/2 - t/2), y, z0, bevel=0)

# a price strip along a shelf's front edge
def ticket_strip(p, w, y, z, x=0):
    p.box(w, 0.012, 0.035, 'White', x, y, z - 0.02, bevel=0)
    # (and yellow price tags along it)
    out = y + (0.007 if y > 0 else -0.007)
    t = x - w/2 + random.uniform(0.06, 0.14)
    while t < x + w/2 - 0.05:
        p.box(0.075, 0.004, 0.05, 'Tag', t, out, z - 0.035, bevel=0)
        p.box(0.04, 0.005, 0.012, 'Black', t + 0.01, out, z - 0.026, bevel=0)
        t += random.uniform(0.18, 0.34)

# ------------------------------------------------------------------ shelving
# an aisle gondola: a pegboard spine with four shelves each side, a kick plate and a brand-stripe header
AW, AD, AH = 1.2, 0.9, 1.5
p = piece('Aisle')
p.box(AW, 0.06, AH, 'Fixture', 0, 0, 0, bevel=0.004)                       # spine
for side in (-1, 1):
    p.box(AW, AD/2 - 0.03, 0.12, 'Fixture', 0, side*AD/4, 0, bevel=0.004)  # base
    p.box(AW, 0.01, 0.1, 'Grey', 0, side*(AD/2 - 0.005), 0.01, bevel=0)     # kick plate
    for z in (0.12, 0.47, 0.82, 1.17):
        if z > 0.12:
            p.box(AW, AD/2 - 0.05, 0.025, 'Fixture', 0, side*(AD/4 + 0.01), z, bevel=0.003)
        ticket_strip(p, AW, side*(AD/2 - 0.02), z + 0.025)
        y0, y1 = sorted((side*0.04, side*(AD/2 - 0.03)))
        slot(p, 'dry', 'f' if side < 0 else 'b', -AW/2 + 0.03, AW/2 - 0.03, y0, y1, z + 0.025, 0.31)
for x in (-AW/2, AW/2):
    p.box(0.03, AD, AH, 'Fixture', x, 0, 0, bevel=0.004)                   # ends
p.box(AW + 0.04, 0.08, 0.14, 'Stripe', 0, 0, AH, bevel=0.01)               # header

# a wall shelf: the same, one-sided and taller, its back at +y
WW, WD, WH = 1.2, 0.45, 2.0
p = piece('WallShelf')
p.box(WW, 0.04, WH, 'Fixture', 0, WD/2 - 0.02, 0, bevel=0.004)
p.box(WW, WD - 0.04, 0.12, 'Fixture', 0, -0.02, 0, bevel=0.004)
p.box(WW, 0.01, 0.1, 'Grey', 0, -WD/2 + 0.005, 0.01, bevel=0)
for x in (-WW/2, WW/2):
    p.box(0.03, WD, WH, 'Fixture', x, 0, 0, bevel=0.004)
for z in (0.12, 0.48, 0.84, 1.2, 1.56):
    if z > 0.12:
        p.box(WW, WD - 0.06, 0.025, 'Fixture', 0, -0.01, z, bevel=0.003)
    ticket_strip(p, WW, -WD/2 + 0.02, z + 0.025)
    slot(p, 'dry', 'f', -WW/2 + 0.03, WW/2 - 0.03, -WD/2 + 0.03, WD/2 - 0.05, z + 0.025, 0.28)
p.box(WW + 0.04, 0.06, 0.14, 'Stripe', 0, -WD/2 + 0.03, WH - 0.14, bevel=0.01)

# a drinks fridge: two glass doors on a lit case of glass shelves, a chrome handle each
FW, FD, FH = 1.4, 0.75, 2.1
p = piece('DrinksFridge')
p.box(FW, 0.1, FH, 'Fixture', 0, FD/2 - 0.05, 0, bevel=0.01)                 # back
p.box(FW, FD, 0.14, 'Fixture', 0, 0, 0, bevel=0.01)                         # base
p.box(FW, FD, 0.2, 'Fixture', 0, 0, FH - 0.2, bevel=0.01)                   # top
for x in (-FW/2 + 0.03, FW/2 - 0.03):
    p.box(0.06, FD, FH, 'Fixture', x, 0, 0, bevel=0.004)                    # sides
p.box(FW - 0.12, 0.02, FH - 0.36, 'GlowFridge', 0, FD/2 - 0.11, 0.14, bevel=0)  # lit inside
for z in (0.14, 0.52, 0.9, 1.28, 1.66):
    if z > 0.14: p.box(FW - 0.12, FD - 0.2, 0.02, 'Glass', 0, 0.03, z, bevel=0)
    slot(p, 'drink', 'f', -FW/2 + 0.08, FW/2 - 0.08, -FD/2 + 0.08, FD/2 - 0.13, z + 0.02, min(0.34, FH - 0.2 - z - 0.03))
for k in (-1, 1):
    frame(p, FW/2 - 0.03, FH - 0.24, k*FW/4, -FD/2 - 0.01, 0.1)
    p.box(FW/2 - 0.1, 0.035, FH - 0.32, 'Glass', k*FW/4, -FD/2 - 0.012, 0.14, bevel=0)
    p.bar((k*0.05, -FD/2 - 0.05, 0.8), (k*0.05, -FD/2 - 0.05, 1.4), 0.025, 'Chrome')
p.box(FW, 0.02, 0.18, 'Stripe2', 0, -FD/2 - 0.01, FH - 0.2, bevel=0)

# a fridge aisle: a free-standing island of glass-door fridges, back to back, reached from -y and +y; chilled food
# low down, drinks above
IW, ID, IH = 1.4, 1.3, 1.9
p = piece('FridgeAisle')
p.box(IW, 0.1, IH, 'Fixture', 0, 0, 0, bevel=0.01)                          # spine
p.box(IW, ID, 0.14, 'Fixture', 0, 0, 0, bevel=0.01)
p.box(IW, ID, 0.2, 'Fixture', 0, 0, IH - 0.2, bevel=0.01)
for x in (-IW/2 + 0.03, IW/2 - 0.03):
    p.box(0.06, ID, IH, 'Fixture', x, 0, 0, bevel=0.004)
for side in (-1, 1):
    y = side*ID/2
    p.box(IW - 0.12, 0.02, IH - 0.36, 'GlowFridge', 0, side*0.06, 0.14, bevel=0)
    for k, z in enumerate((0.14, 0.5, 0.86, 1.22)):
        if z > 0.14: p.box(IW - 0.12, ID/2 - 0.12, 0.02, 'Glass', 0, side*(ID/4 + 0.02), z, bevel=0)
        y0, y1 = sorted((side*0.08, y - side*0.06))
        slot(p, 'chill' if k < 2 else 'drink', 'f' if side < 0 else 'b', -IW/2 + 0.08, IW/2 - 0.08, y0, y1, z + 0.02,
             min(0.33, IH - 0.2 - z - 0.03))
    for k in (-1, 1):
        frame(p, IW/2 - 0.03, IH - 0.24, k*IW/4, y + side*0.01, 0.1)
        p.box(IW/2 - 0.1, 0.035, IH - 0.32, 'Glass', k*IW/4, y + side*0.012, 0.14, bevel=0)
        p.bar((k*0.05, y + side*0.05, 0.7), (k*0.05, y + side*0.05, 1.3), 0.025, 'Chrome')
    p.box(IW, 0.02, 0.16, 'Stripe2', 0, y + side*0.01, IH - 0.18, bevel=0)

# an open chiller against a wall: lit, stepped shelves with no doors, a lip on each
HW, HD, HH = 1.2, 0.8, 2.0
p = piece('Chiller')
p.box(HW, HD, 0.4, 'Fixture', 0, 0, 0, bevel=0.01)
p.box(HW, 0.1, HH, 'Fixture', 0, HD/2 - 0.05, 0, bevel=0.01)
p.box(HW, HD*0.6, 0.12, 'Fixture', 0, HD*0.2, HH - 0.12, bevel=0.01)
for x in (-HW/2, HW/2):
    p.box(0.04, HD, HH, 'Fixture', x, 0, 0, bevel=0.004)
p.box(HW - 0.1, 0.02, HH - 0.6, 'GlowFridge', 0, HD/2 - 0.11, 0.42, bevel=0)
for k, z in enumerate((0.4, 0.75, 1.1, 1.45)):
    depth = HD - 0.15 - k*0.08
    y = HD/2 - 0.1 - depth/2
    p.box(HW - 0.08, depth, 0.02, 'Steel', 0, y, z, bevel=0)
    p.box(HW - 0.08, 0.01, 0.05, 'Stripe' if k % 2 else 'White', 0, y - depth/2, z, bevel=0)
    slot(p, 'chill', 'f', -HW/2 + 0.06, HW/2 - 0.06, y - depth/2 + 0.02, y + depth/2 - 0.01, z + 0.02, 0.3 if k < 3 else 0.28)
p.box(HW, 0.02, 0.1, 'Stripe2', 0, -HD*0.1, HH - 0.12, bevel=0)

# ------------------------------------------------------------------ what's for sale
# Each thing on the shelves on its own, facing -y, named Item_<kinds>_<name> (kinds by '-': which Slots it goes on).
# Pack is recoloured per item by interior.js (white here); the rest keep their colours.
material('Pack', 0xffffff, 0.35)
material('Water', 0xa8d4ec, 0.1)
material('Cheese', 0xf0c040, 0.5)
def item(kinds, name):
    return piece('Item_%s_%s' % (kinds, name))

p = item('dry', 'Cereal')
p.box(0.19, 0.07, 0.27, 'Pack', bevel=0.003)
p.box(0.12, 0.072, 0.09, 'White', 0, 0, 0.12, bevel=0)
p = item('dry-hang', 'Crisps')
p.hull([(-0.08, -0.01, 0), (0.08, -0.01, 0), (-0.08, 0.01, 0), (0.08, 0.01, 0),
        (-0.085, -0.04, 0.13), (0.085, -0.04, 0.13), (-0.085, 0.04, 0.13), (0.085, 0.04, 0.13),
        (-0.08, -0.01, 0.25), (0.08, -0.01, 0.25), (-0.08, 0.01, 0.25), (0.08, 0.01, 0.25)], 'Pack')
p.box(0.1, 0.082, 0.05, 'White', 0, 0, 0.1, bevel=0)
p = item('dry', 'Tin')
p.cyl(0.036, 0.11, 'Chrome', segments=10)
p.cyl(0.0375, 0.075, 'Pack', 0, 0, 0.017, segments=10)
p = item('dry', 'Jar')
p.cyl(0.04, 0.1, 'Pack', segments=10)
p.cyl(0.042, 0.02, 'Chrome', 0, 0, 0.1, segments=10)
p = item('dry', 'Sauce')
p.lathe([(0.03, 0), (0.03, 0.12), (0.012, 0.17), (0.011, 0.19)], 'Pack', segments=8)
p.cyl(0.014, 0.025, 'White', 0, 0, 0.19, segments=8)
p = item('dry', 'Noodles')
p.cyl(0.042, 0.1, 'White', r2=0.052, segments=10)
p.cyl(0.049, 0.045, 'Pack', 0, 0, 0.045, r2=0.052, segments=10)
p.cyl(0.054, 0.006, 'Pack', 0, 0, 0.1, segments=10)
p = item('dry', 'Biscuits')
p.box(0.2, 0.06, 0.07, 'Pack', bevel=0.008)
p.box(0.04, 0.062, 0.072, 'White', 0.06, 0, 0, bevel=0)
p = item('dry', 'Loo')
p.box(0.22, 0.11, 0.12, 'White', bevel=0.02)
p.box(0.222, 0.112, 0.03, 'Pack', 0, 0, 0.045, bevel=0)
p = item('dry', 'Chocolate')
for k in range(4):
    p.box(0.045, 0.1, 0.02, 'Pack', -0.075 + k*0.05, 0, k % 2*0.02, bevel=0.002)
    p.box(0.045, 0.1, 0.02, 'Pack', -0.075 + k*0.05, 0, (1 - k % 2)*0.02, bevel=0.002)
p.box(0.2, 0.1, 0.012, 'Cardboard', 0, 0, 0, bevel=0)

p = item('hang', 'Sweets')
p.hull([(-0.06, -0.01, 0), (0.06, -0.01, 0), (-0.06, 0.01, 0), (0.06, 0.01, 0),
        (-0.065, -0.03, 0.09), (0.065, -0.03, 0.09), (-0.065, 0.03, 0.09), (0.065, 0.03, 0.09),
        (-0.06, -0.005, 0.18), (0.06, -0.005, 0.18), (-0.06, 0.005, 0.18), (0.06, 0.005, 0.18)], 'Pack')
p.box(0.05, 0.062, 0.04, 'White', 0, 0, 0.07, bevel=0)

p = item('frozen', 'IceCream')
p.cyl(0.07, 0.09, 'Pack', segments=12)
p.cyl(0.072, 0.015, 'White', 0, 0, 0.09, segments=12)
p = item('frozen', 'Lollies')
p.box(0.16, 0.1, 0.05, 'Pack', bevel=0.004)
p.box(0.06, 0.102, 0.052, 'White', -0.04, 0, 0, bevel=0)
p = item('frozen', 'Pizza')
p.box(0.26, 0.26, 0.04, 'Pack', bevel=0.004)
p.box(0.14, 0.14, 0.042, 'White', 0.03, 0.03, 0, bevel=0)
p = item('frozen', 'Peas')
p.hull([(-0.09, -0.06, 0), (0.09, -0.06, 0), (-0.09, 0.06, 0), (0.09, 0.06, 0),
        (-0.08, -0.05, 0.05), (0.08, -0.05, 0.05), (-0.08, 0.05, 0.05), (0.08, 0.05, 0.05)], 'Pack')
p = item('frozen', 'Cones')
p.box(0.14, 0.1, 0.07, 'Pack', bevel=0.004)
p.box(0.141, 0.101, 0.02, 'White', 0, 0, 0.04, bevel=0)

p = item('drink', 'Can')
p.cyl(0.033, 0.115, 'Pack', segments=10)
p.cyl(0.029, 0.008, 'Chrome', 0, 0, 0.115, segments=10)
p = item('drink', 'TallCan')
p.cyl(0.03, 0.16, 'Pack', segments=10)
p.cyl(0.026, 0.008, 'Chrome', 0, 0, 0.16, segments=10)
p = item('drink', 'Soda')
p.lathe([(0.033, 0), (0.033, 0.13), (0.013, 0.19), (0.012, 0.21)], 'Pack', segments=8)
p.cyl(0.014, 0.02, 'White', 0, 0, 0.21, segments=8)
p = item('drink', 'Water')
p.lathe([(0.034, 0), (0.034, 0.15), (0.013, 0.21), (0.012, 0.23)], 'Water', segments=8)
p.cyl(0.0355, 0.06, 'Pack', 0, 0, 0.06, segments=8)
p.cyl(0.014, 0.02, 'White', 0, 0, 0.23, segments=8)
p = item('drink', 'BigBottle')
p.lathe([(0.05, 0), (0.05, 0.2), (0.016, 0.28), (0.015, 0.3)], 'Pack', segments=10)
p.cyl(0.0515, 0.07, 'White', 0, 0, 0.08, segments=10)
p.cyl(0.017, 0.02, 'White', 0, 0, 0.3, segments=8)
p = item('drink-chill', 'Carton')
p.box(0.07, 0.07, 0.18, 'Pack', bevel=0.003)
p.hull([(-0.035, -0.035, 0), (0.035, -0.035, 0), (-0.035, 0.035, 0), (0.035, 0.035, 0),
        (-0.035, 0, 0.035), (0.035, 0, 0.035)], 'Pack', at=(0, 0, 0.18))
p.box(0.05, 0.072, 0.07, 'White', 0, 0, 0.05, bevel=0)

p = item('chill', 'Milk')
p.box(0.1, 0.1, 0.19, 'White', bevel=0.015)
p.box(0.101, 0.101, 0.05, 'Pack', 0, 0, 0.07, bevel=0)
p.cyl(0.02, 0.03, 'Pack', 0.02, 0, 0.19, segments=8)
p = item('chill', 'Sandwich')
p.hull([(-0.06, -0.035, 0), (0.06, -0.035, 0), (-0.06, 0.035, 0), (0.06, 0.035, 0),
        (-0.06, -0.035, 0.12), (-0.06, 0.035, 0.12)], 'Bun')
p.box(0.07, 0.072, 0.03, 'Pack', -0.02, 0, 0.02, bevel=0)
p = item('chill', 'Yoghurt')
p.cyl(0.038, 0.08, 'White', r2=0.045, segments=10)
p.cyl(0.046, 0.008, 'Pack', 0, 0, 0.08, segments=10)
p = item('chill', 'Meal')
p.box(0.18, 0.13, 0.05, 'Pack', bevel=0.004)
p.box(0.06, 0.132, 0.052, 'White', 0.03, 0, 0, bevel=0)
p = item('chill', 'Cheese')
p.box(0.11, 0.06, 0.045, 'Cheese', bevel=0.004)
p.box(0.04, 0.062, 0.047, 'Pack', 0.02, 0, 0, bevel=0)
p = item('chill', 'Salad')
p.cyl(0.07, 0.06, 'Water', r2=0.075, segments=12)
p.cyl(0.066, 0.03, 'Pack', 0, 0, 0.005, segments=12)

# a freezer chest: a white tub, lit inside, under a chrome-rimmed sliding glass lid; stocked from above
CW, CD, CH = 1.4, 0.7, 0.85
p = piece('FreezerChest')
p.box(CW, CD, CH - 0.45, 'White', 0, 0, 0, bevel=0.02)
for y in (-CD/2 + 0.02, CD/2 - 0.02):
    p.box(CW, 0.04, 0.45, 'White', 0, y, CH - 0.5, bevel=0.01)
for x in (-CW/2 + 0.02, CW/2 - 0.02):
    p.box(0.04, CD, 0.45, 'White', x, 0, CH - 0.5, bevel=0.01)
p.box(CW - 0.08, CD - 0.08, 0.01, 'GlowFridge', 0, 0, CH - 0.45, bevel=0)
slot(p, 'frozen', 'f', -CW/2 + 0.06, CW/2 - 0.06, -CD/2 + 0.06, CD/2 - 0.06, CH - 0.44, 0.3)
for y in (-CD/2 + 0.02, CD/2 - 0.02):
    p.box(CW, 0.04, 0.02, 'Chrome', 0, y, CH - 0.05, bevel=0)
for x in (-CW/2 + 0.02, 0, CW/2 - 0.02):
    p.box(0.04, CD, 0.02, 'Chrome', x, 0, CH - 0.05, bevel=0)
p.box(CW/2 - 0.04, CD - 0.08, 0.015, 'Glass', -CW/4, 0, CH - 0.04, bevel=0)
p.box(CW/2 - 0.04, CD - 0.08, 0.015, 'Glass', CW/4, 0, CH - 0.025, bevel=0)
p.box(CW, 0.01, 0.2, 'Stripe3', 0, -CD/2 - 0.005, 0.3, bevel=0)

# a wire rack of crisps: rails on a chrome frame, bags hung along each (Slots, 'hang')
p = piece('SnackRack')
for x in (-0.3, 0.3):
    p.bar((x, 0.1, 0), (x, 0.1, 1.6), 0.025, 'Chrome')
    p.bar((x, -0.2, 0.01), (x, 0.2, 0.01), 0.03, 'Chrome')
for z in (0.25, 0.6, 0.95, 1.3):
    p.bar((-0.3, 0.1, z), (0.3, 0.1, z), 0.015, 'Chrome')
    p.bar((-0.3, -0.12, z - 0.05), (0.3, -0.12, z - 0.05), 0.012, 'Chrome')
    slot(p, 'hang', 'f', -0.28, 0.28, -0.12, 0.08, z - 0.03, 0.28)
p.box(0.64, 0.03, 0.14, 'Stripe2', 0, 0.1, 1.6, bevel=0.01)

# ------------------------------------------------------------------ the counter
# the counter, served from +y: a laminate top on a striped front, a till with its screen, a card reader, a scratchcard
# dispenser, a charity tin, gum on the front, and a hot dog roller at one end
KW, KD, KH = 2.0, 0.7, 1.0
p = piece('Counter')
p.box(KW, KD - 0.05, KH - 0.04, 'Fixture', 0, 0.02, 0, bevel=0.01)
p.box(KW + 0.04, KD, 0.04, 'Laminate', 0, 0, KH - 0.04, bevel=0.008)
p.box(KW, 0.01, 0.16, 'Stripe', 0, -KD/2 + 0.02, 0.6, bevel=0)
p.box(KW, 0.01, 0.06, 'Stripe2', 0, -KD/2 + 0.02, 0.52, bevel=0)
for k in range(5):                                                      # gum and sweets on the front
    p.box(0.3, 0.12, 0.03, 'Fixture', -0.7 + k*0.35, -KD/2 - 0.05, 0.3, bevel=0.004)
    for j in range(4):
        p.box(0.06, 0.08, 0.12, random.choice(PACKS), -0.8 + k*0.35 + j*0.07, -KD/2 - 0.05, 0.33, bevel=0.004)
p.box(0.38, 0.4, 0.1, 'Black', 0.2, 0.1, KH, bevel=0.01)                  # till
p.box(0.3, 0.04, 0.22, 'Black', 0.2, 0.2, KH + 0.1, bevel=0.01, rot=(-0.3, 0, 0))
p.box(0.26, 0.01, 0.17, 'GlowTill', 0.2, 0.18, KH + 0.125, bevel=0, rot=(-0.3, 0, 0))
p.box(0.08, 0.14, 0.04, 'Black', -0.1, -0.15, KH, bevel=0.01, rot=(0.3, 0, 0))  # card reader
p.box(0.06, 0.01, 0.04, 'GlowScreen', -0.1, -0.2, KH + 0.035, bevel=0, rot=(0.3, 0, 0))
p.box(0.5, 0.2, 0.3, 'Glass', -0.5, 0.0, KH, bevel=0.004)                 # scratchcards
for k in range(5):
    p.box(0.08, 0.005, 0.12, random.choice(PACKS), -0.7 + k*0.1, -0.1, KH + 0.12, bevel=0)
p.cyl(0.05, 0.14, 'Stripe3', -0.1, 0.15, KH, segments=10)                  # charity tin
p.box(0.5, 0.3, 0.12, 'Steel', 0.72, -0.05, KH, bevel=0.01)               # hot dog roller
for k in range(6):
    p.cyl(0.018, 0.44, 'Chrome', 0.72, -0.17 + k*0.048, KH + 0.14, segments=6, rot=(0, math.pi/2, 0))
    p.cyl(0.02, 0.3, 'Sausage', 0.72 - 0.15, -0.17 + k*0.048, KH + 0.16, segments=6, rot=(0, math.pi/2, 0))
p.box(0.52, 0.32, 0.02, 'Glass', 0.72, -0.05, KH + 0.26, bevel=0)

# the gantry of cigarettes behind the counter, against the wall: cubbies of packs behind a shutter's frame
GW, GD, GH = 2.0, 0.3, 1.1
GB = 1.15  # (on a cupboard, so it shows over the counter)
p = piece('Gantry')
p.box(GW, GD + 0.1, GB, 'Fixture', 0, 0.05, 0, bevel=0.008)
p.box(GW, 0.04, GH, 'Black', 0, GD/2 - 0.02, GB, bevel=0.004)             # back
for x in (-GW/2 + 0.015, GW/2 - 0.015):
    p.box(0.03, GD, GH, 'Black', x, 0, GB, bevel=0.004)                    # ends
p.box(GW, GD, 0.03, 'Black', 0, 0, GB + GH - 0.03, bevel=0.004)            # top
# flip-top packs, upright on six shelves, a brand's facings side by side: body, lid band, foil line, health warning
PW_, PD_, PH_ = 0.077, 0.03, 0.123  # (1.4 times life, to read from the camera)
for r in range(6):
    z = GB + 0.02 + r*0.18
    p.box(GW - 0.03, GD - 0.04, 0.015, 'Black', 0, -0.02, z, bevel=0)      # shelf
    p.box(GW - 0.03, 0.006, 0.03, 'Paper', 0, -GD/2 + 0.02, z - 0.008, bevel=0)  # price strip
    x = -GW/2 + 0.035
    while x < GW/2 - 0.035 - PW_:
        body, lid = random.choice(CIG_BRANDS)
        for _ in range(random.randint(2, 4)):
            if x > GW/2 - 0.035 - PW_: break
            cx, y, b = x + PW_/2, -GD/2 + 0.03 + PD_/2, z + 0.015
            p.box(PW_, PD_, PH_, body, cx, y, b, bevel=0)
            p.box(PW_ + 0.001, PD_ + 0.001, 0.042, lid, cx, y, b + PH_ - 0.042, bevel=0)
            p.box(PW_ + 0.002, PD_ + 0.002, 0.004, 'CigFoil', cx, y, b + PH_ - 0.047, bevel=0)
            p.box(PW_ - 0.014, 0.001, 0.04, 'CigWarn', cx, y - PD_/2 - 0.0005, b + 0.011, bevel=0)
            x += PW_ + 0.008
        x += 0.004
p.box(GW + 0.04, 0.04, 0.12, 'Stripe', 0, -GD/2, GB + GH, bevel=0.008)

# the pharmacy corner: a tall shelf of medicines, first aid and plasters under a glowing green cross, a small
# prescription counter in front
PW, PD, PH = 1.4, 0.4, 2.1
p = piece('Pharmacy')
p.box(PW, 0.04, PH, 'White', 0, PD/2 - 0.02, 0, bevel=0.004)
for x in (-PW/2, PW/2):
    p.box(0.03, PD, PH - 0.3, 'White', x, 0, 0, bevel=0.004)
for z in (0.9, 1.2, 1.5):
    p.box(PW, PD - 0.06, 0.02, 'White', 0, 0.0, z, bevel=0.003)
    x = -PW/2 + 0.08
    while x < PW/2 - 0.1:
        mat = random.choice(('White', 'White', 'Pack1', 'Pack3', 'Pack0', 'Pack8'))
        h = random.uniform(0.1, 0.18)
        p.box(0.09, 0.06, h, mat, x, 0.02, z + 0.02, bevel=0.003)
        p.box(0.07, 0.061, 0.02, 'Stripe', x, 0.02, z + 0.02 + h*0.6, bevel=0)
        x += 0.11
p.box(PW, PD + 0.2, 0.9, 'White', 0, -0.1, 0, bevel=0.01)                  # its counter
p.box(PW + 0.04, PD + 0.24, 0.03, 'Laminate', 0, -0.1, 0.9, bevel=0.006)
p.box(0.36, 0.06, 0.36, 'White', 0, PD/2 - 0.04, PH - 0.3, bevel=0.01)     # the cross
p.box(0.3, 0.02, 0.1, 'GlowCross', 0, PD/2 - 0.08, PH - 0.17, bevel=0)
p.box(0.1, 0.02, 0.3, 'GlowCross', 0, PD/2 - 0.08, PH - 0.27, bevel=0)

# ------------------------------------------------------------------ machines
# a coffee station: a bean-to-cup machine on a cabinet, cup stacks, lids, sugar and a bin
p = piece('CoffeeStation')
p.box(1.0, 0.55, 0.9, 'Fixture', 0, 0, 0, bevel=0.01)
p.box(1.02, 0.57, 0.03, 'Laminate', 0, 0, 0.9, bevel=0.006)
p.box(0.4, 0.4, 0.62, 'Black', -0.2, 0.05, 0.93, bevel=0.02)
p.box(0.18, 0.01, 0.12, 'GlowScreen', -0.2, -0.155, 1.35, bevel=0)
p.box(0.3, 0.12, 0.04, 'Chrome', -0.2, -0.12, 1.12, bevel=0.01)
p.box(0.3, 0.12, 0.02, 'Chrome', -0.2, -0.12, 0.93, bevel=0.004)
p.box(0.4, 0.4, 0.06, 'Stripe2', -0.2, 0.05, 1.55, bevel=0.01)
for k, r in enumerate((0.04, 0.045, 0.05)):                               # cup stacks
    p.cyl(r, 0.35, 'Cup', 0.12 + k*0.11, 0.1, 0.93, r2=r*1.05, segments=10)
p.box(0.14, 0.1, 0.1, 'Black', 0.36, -0.1, 0.93, bevel=0.01)             # lids
p.box(0.1, 0.1, 0.12, 'White', 0.2, -0.12, 0.93, bevel=0.01)             # sugar

# a slushie machine: two turning drums of red and blue on a steel base, drip trays and taps
p = piece('SlushieMachine')
p.box(0.8, 0.5, 0.9, 'Fixture', 0, 0, 0, bevel=0.01)
p.box(0.6, 0.45, 0.2, 'Steel', 0, 0, 0.9, bevel=0.01)
for k, mat in ((-1, 'SlushRed'), (1, 'SlushBlue')):
    x = k*0.15
    p.box(0.26, 0.38, 0.4, 'Glass', x, 0.02, 1.1, bevel=0.03)
    p.box(0.22, 0.34, 0.28, mat, x, 0.02, 1.1, bevel=0.03)
    p.box(0.27, 0.39, 0.08, 'Black', x, 0.02, 1.5, bevel=0.02)
    p.box(0.06, 0.06, 0.1, 'Black', x, -0.2, 1.0, bevel=0.01)
    p.box(0.2, 0.12, 0.02, 'Grey', x, -0.18, 0.9, bevel=0.004)
p.box(0.62, 0.02, 0.14, 'Stripe3', 0, -0.23, 0.92, bevel=0)

# an ATM: a grey tower with a screen and keypad, stood against a wall
p = piece('ATM')
p.box(0.6, 0.5, 1.6, 'Grey', 0, 0, 0, bevel=0.02)
p.box(0.62, 0.3, 0.3, 'Stripe', 0, 0.1, 1.6, bevel=0.02)
p.box(0.3, 0.02, 0.22, 'GlowScreen', 0, -0.25, 1.2, bevel=0, rot=(0.2, 0, 0))
p.box(0.5, 0.2, 0.05, 'Black', 0, -0.3, 1.0, bevel=0.01, rot=(0.3, 0, 0))
for r in range(4):
    for c in range(3):
        p.box(0.04, 0.03, 0.015, 'Steel', -0.06 + c*0.06, -0.33 - r*0.03, 1.03 + r*0.009, bevel=0.003, rot=(0.3, 0, 0))
p.box(0.14, 0.02, 0.02, 'Black', 0.16, -0.25, 1.12, bevel=0)             # card slot
p.box(0.26, 0.02, 0.04, 'Black', 0, -0.25, 0.85, bevel=0)                # cash slot

# ------------------------------------------------------------------ by the door
# an umbrella stand: a round tub of shut umbrellas, a price flag
p = piece('UmbrellaStand')
p.cyl(0.25, 0.5, 'Chrome', 0, 0, 0, segments=14)
p.cyl(0.23, 0.02, 'Black', 0, 0, 0.48, segments=14)
for k in range(9):
    a = k*2.4
    r = 0.06 + 0.1*(k % 3)/2
    x, y = math.cos(a)*r, math.sin(a)*r
    lean = (math.cos(a)*0.12, math.sin(a)*0.12)
    p.bar((x, y, 0.05), (x + lean[0], y + lean[1], 0.95), 0.012, 'Black')
    p.cyl(0.035, 0.6, random.choice(CANOPIES), x + lean[0]*0.5, y + lean[1]*0.5, 0.3, r2=0.012, segments=8,
          rot=(-lean[1]*1.1, lean[0]*1.1, 0))
    p.cyl(0.015, 0.1, 'Black', x + lean[0], y + lean[1], 0.95, segments=6)
p.bar((0.2, 0, 0.5), (0.2, 0, 1.1), 0.01, 'Chrome')
p.box(0.02, 0.18, 0.12, 'Stripe2', 0.2, 0.09, 1.0, bevel=0)

# a news rack: three sloped tiers of papers and magazines, a stripe along its head
p = piece('NewsRack')
for k in range(3):
    z = 0.3 + k*0.38
    p.box(0.9, 0.3, 0.02, 'Fixture', 0, 0.05 - k*0.02, z, bevel=0.003, rot=(0.35, 0, 0))
    for j in range(4):
        mat = 'Newsprint' if k < 2 else random.choice(PACKS)
        p.box(0.2, 0.26, 0.012, mat, -0.33 + j*0.22, 0.05 - k*0.02, z + 0.03, bevel=0, rot=(0.35, 0, 0))
        p.box(0.16, 0.06, 0.013, 'Black' if k < 2 else 'White', -0.33 + j*0.22, 0.12 - k*0.02, z + 0.056, bevel=0, rot=(0.35, 0, 0))
for x in (-0.46, 0.46):
    p.box(0.03, 0.4, 1.3, 'Fixture', x, 0.05, 0, bevel=0.004)
p.box(0.95, 0.04, 0.1, 'Stripe', 0, 0.22, 1.3, bevel=0.008)

# a stack of red shopping baskets
p = piece('BasketStack')
for k in range(6):
    z = k*0.06
    p.box(0.42, 0.3, 0.02, 'Stripe3', 0, 0, z, bevel=0.004)
    for s in (-1, 1):
        p.box(0.44, 0.015, 0.2, 'Stripe3', 0, s*0.15, z, bevel=0.003)
        p.box(0.015, 0.3, 0.2, 'Stripe3', s*0.215, 0, z, bevel=0.003)
p.bar((-0.12, 0, 0.5), (0.12, 0, 0.5), 0.015, 'Black')

p = piece('DoorMat')
p.box(1.2, 0.8, 0.015, 'Rubber', 0, 0, 0, bevel=0.004)
p.box(1.0, 0.1, 0.016, 'Stripe', 0, 0, 0, bevel=0)

# a promo poster: a meal deal
p = piece('Poster')
p.box(0.6, 0.02, 0.85, 'Stripe2', 0, 0, 0, bevel=0.004)
p.box(0.5, 0.021, 0.2, 'White', 0, 0, 0.58, bevel=0)
p.cyl(0.12, 0.022, 'Stripe3', 0.12, 0.0, 0.3, segments=12, rot=(math.pi/2, 0, 0))
p.box(0.18, 0.021, 0.2, random.choice(PACKS), -0.14, 0, 0.18, bevel=0)

p = piece('Tube')
p.box(1.2, 0.14, 0.05, 'White', 0, 0, 0, bevel=0.01)
p.box(1.14, 0.1, 0.02, 'Light', 0, 0, -0.02, bevel=0.004)

# ------------------------------------------------------------------ to carry
# a shut umbrella (hand at the crook, tip down) and an open one (hand at the shaft's middle, canopy overhead)
p = piece('Umbrella')
p.bar((0, 0, -0.75), (0, 0, 0.05), 0.012, 'Black')
p.cyl(0.04, 0.6, 'Canopy0', 0, 0, -0.7, r2=0.014, segments=8)
for k in range(6):
    a = k*math.pi/6
    p.bar((0.04*math.cos(a), 0.04*math.sin(a), 0.05), (0.04*math.cos(a + 0.5), 0.04*math.sin(a + 0.5), 0.09), 0.015, 'Black')

p = piece('UmbrellaOpen')
p.bar((0, 0, -0.1), (0, 0, 0.8), 0.012, 'Black')
p.lathe([(0.5, 0.52), (0.42, 0.66), (0.24, 0.76), (0.02, 0.8)], 'Canopy0', segments=8)
p.cyl(0.015, 0.06, 'Black', 0, 0, 0.8, segments=6)
p.cyl(0.018, 0.12, 'Black', 0, 0, -0.12, segments=6)

p = piece('Slushie')
p.cyl(0.04, 0.16, 'SlushRed', 0, 0, 0, r2=0.05, segments=10)
p.cyl(0.052, 0.015, 'Glass', 0, 0, 0.16, segments=10)
p.bar((0.01, 0, 0.15), (0.02, 0, 0.26), 0.008, 'Stripe2')

p = piece('Coffee')
p.cyl(0.03, 0.11, 'Cup', 0, 0, 0, r2=0.04, segments=10)
p.cyl(0.033, 0.035, 'Cardboard', 0, 0, 0.035, r2=0.037, segments=10)
p.cyl(0.042, 0.014, 'Lid', 0, 0, 0.11, segments=10)

p = piece('Bag')
p.box(0.28, 0.14, 0.3, 'White', 0, 0, 0, bevel=0.02)
p.box(0.2, 0.141, 0.08, 'Stripe', 0, 0, 0.12, bevel=0)
for s in (-1, 1):
    p.bar((s*0.1, 0, 0.3), (0, 0, 0.42), 0.012, 'White')

p = piece('Pills')
p.box(0.08, 0.03, 0.06, 'White', 0, 0, 0, bevel=0.003)
p.box(0.06, 0.031, 0.015, 'Stripe', 0, 0, 0.035, bevel=0)

export(OUT)
