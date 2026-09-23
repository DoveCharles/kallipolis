# Builds assets/models/Industrial.glb: the pieces warehouses and factories are fitted out from (see "a warehouse or a
# factory" in src/buildings/interior.js), in the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/industrial-models.py
#
# A warehouse's: pallet racking (Racking and Racking2, loaded differently), pallets of boxes (PalletBoxes), shrink-wrapped
# (PalletWrapped), of drums (Drums) and empty and stacked (PalletStack), a Crate, a Forklift, a PalletJack, a rolling
# Ladder, and a PackingBench. A factory's: a CNC Mill, a Lathe, a DrillPress, a hydraulic Press, a Conveyor, a Workbench
# with a vice, a ToolChest, Lockers and an electrical ControlPanel. Either's: a Stool, an Extinguisher, a traffic Cone,
# and a HighBay lamp to hang from the ceiling.
# Like Interior.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported). Built in metres, life size, and scaled up at the end.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Industrial.glb')
random.seed(31)

# (the ones interior.js recolours for each building are Machine, Upright, Beam, Forklift, Toolbox, Locker, Bench and Drum;
# Light glows as it is)
material('Machine', 0x5a7a6a, 0.6, 0.2)
material('Upright', 0x2a5aa8, 0.5, 0.3)
material('Beam', 0xe07a2a, 0.5, 0.2)
material('Forklift', 0xe8b020, 0.5, 0.1)
material('Toolbox', 0xc8352c, 0.35, 0.3)
material('Locker', 0x6a7a8a, 0.5, 0.3)
material('Bench', 0x3a5a8a, 0.5, 0.3)
material('Drum', 0x2a5aa8, 0.45, 0.3)
material('Steel', 0x9a9ea3, 0.4, 0.5)
material('Chrome', 0xc8ccd0, 0.25, 0.8)
material('Dark', 0x2a2c30, 0.6)
material('Rubber', 0x1a1a1c, 0.9)
material('Pallet', 0xb89868, 0.95)
material('Crate', 0xa88450, 0.95)
material('Card', 0xb8905a, 0.95)
material('Card2', 0xa8804c, 0.95)
material('Card3', 0xc8a470, 0.95)
material('Tape', 0xd8c49a, 0.6)
material('Label', 0xf2f0ea, 0.8)
material('Wrap', 0xdce4e8, 0.3)
material('Butcher', 0xc89a62, 0.7)
material('Hazard', 0xf0c020, 0.6)
material('Stripe', 0x1a1a1c, 0.6)
material('Red', 0xc8352c, 0.5)
material('Amber', 0xe89a20, 0.4, glow=0x6a4a10)
material('Green', 0x3a9a4a, 0.4, glow=0x1a4a20)
material('Screen', 0x1a2a3a, 0.3, glow=0x2a5a7a)
material('Window', 0x3a4a52, 0.15, 0.3)
material('Cone', 0xe8621e, 0.6)
material('White', 0xf0f0ec, 0.6)
material('Light', 0xfff8e8, 0.5, glow=0xfff4e0)

CARDS = ('Card', 'Card2', 'Card3')

# ------------------------------------------------------------------ building blocks
# a pallet, 1.2 by 1.0 and 0.144 high, centred on (x, y) and standing on z0: top boards across three stringers of blocks
PALLET_W, PALLET_D, PALLET_H = 1.2, 1.0, 0.144
def pallet(p, x=0, y=0, z0=0):
    for k in range(3):
        yy = y + (k - 1)*(PALLET_D/2 - 0.05)
        p.box(PALLET_W, 0.1, 0.022, 'Pallet', x, yy, z0, bevel=0.003)
        for i in range(3):
            p.box(0.1, 0.1, 0.078, 'Pallet', x + (i - 1)*(PALLET_W/2 - 0.05), yy, z0 + 0.022, bevel=0.004)
    for i in range(3):
        p.box(0.1, PALLET_D, 0.022, 'Pallet', x + (i - 1)*(PALLET_W/2 - 0.05), y, z0 + 0.1, bevel=0.003)
    for k in range(7):
        p.box(PALLET_W, 0.11, 0.022, 'Pallet', x, y - PALLET_D/2 + 0.055 + k*(PALLET_D - 0.11)/6, z0 + 0.122, bevel=0.003)

# a cardboard box w by d by h, taped across its top, with a label on its front now and then
def carton(p, w, d, h, x, y, z0, turn=0.0):
    mat = random.choice(CARDS)
    p.box(w, d, h, mat, x, y, z0, bevel=0.008, rot=(0, 0, turn))
    c, s = math.cos(turn), math.sin(turn)
    p.box(0.05*abs(c) + d*abs(s) + 0.004, d*abs(c) + 0.05*abs(s) + 0.004, 0.004, 'Tape', x, y, z0 + h - 0.002, bevel=0)
    if random.random() < 0.5:
        p.box(0.12, 0.004, 0.08, 'Label', x + s*d/2 - c*w*0.2, y - c*d/2 - s*w*0.2 - 0.001, z0 + h*0.5, bevel=0, rot=(0, 0, turn))

# a load of boxes on a pallet's top (z0), up to `h` high: layers of them, the top layer maybe short a few
def boxes(p, x, y, z0, h):
    kinds = [(0.4, 0.5, 0.3), (0.6, 0.5, 0.35), (0.3, 0.25, 0.25), (0.6, 1.0, 0.4)]
    w, d, bh = random.choice(kinds[:3])
    across, deep = max(1, round(PALLET_W/w)), max(1, round(PALLET_D/d))
    w, d = PALLET_W/across - 0.01, PALLET_D/deep - 0.01
    layers = max(1, int(h/bh))
    for layer in range(layers):
        for i in range(across):
            for j in range(deep):
                if layer == layers - 1 and layers > 1 and random.random() < 0.3: continue
                carton(p, w - 0.01, d - 0.01, bh - 0.004, x - PALLET_W/2 + (i + 0.5)*PALLET_W/across,
                       y - PALLET_D/2 + (j + 0.5)*PALLET_D/deep, z0 + layer*bh)

# a load wrapped in film, h high, a label on its front
def wrapped(p, x, y, z0, h):
    p.box(PALLET_W - 0.04, PALLET_D - 0.04, h, 'Wrap', x, y, z0, bevel=0.04, segments=2)
    for k in range(1, int(h/0.3) + 1):
        p.box(PALLET_W - 0.02, PALLET_D - 0.02, 0.012, 'Wrap', x, y, z0 + min(h - 0.05, k*0.28), bevel=0.005)
    p.box(0.2, 0.004, 0.14, 'Label', x + 0.2, y - PALLET_D/2 + 0.01, z0 + h*0.6, bevel=0)

# a steel drum, 0.58 across and 0.88 high, ribbed, with its bung on top
def drum(p, x, y, z0, mat='Drum'):
    p.cyl(0.29, 0.88, mat, x, y, z0, segments=16)
    for z in (0.02, 0.3, 0.58, 0.86):
        p.cyl(0.298, 0.025, mat, x, y, z0 + z, segments=16)
    p.cyl(0.035, 0.012, 'Dark', x + 0.16, y, z0 + 0.88, segments=8)

# a wheel of radius r and width w, its axle along x, at (x, y) with its bottom on z0
def wheel(p, r, w, x, y, z0=0, hub='Steel'):
    p.cyl(r, w, 'Rubber', x - w/2, y, z0 + r, segments=14, rot=(0, math.pi/2, 0))
    p.cyl(r*0.55, w + 0.01, hub, x - w/2 - 0.005, y, z0 + r, segments=10, rot=(0, math.pi/2, 0))

# a caster, its top at z
def caster(p, x, y, z=0.1):
    p.box(0.05, 0.05, 0.02, 'Steel', x, y, z - 0.02, bevel=0.004)
    p.cyl(0.035, 0.03, 'Rubber', x - 0.015, y, z - 0.09 + 0.035, segments=10, rot=(0, math.pi/2, 0))

# black and yellow chevrons along a strip w wide and h high on a face at y (facing -y), from z0
def hazard(p, w, h, x, y, z0):
    p.box(w, 0.006, h, 'Hazard', x, y, z0, bevel=0)
    n = max(2, int(w/0.12))
    for k in range(n):
        p.box(0.04, 0.008, h*1.3, 'Stripe', x - w/2 + (k + 0.5)*w/n, y - 0.001, z0 - h*0.15, bevel=0, rot=(0, 0.7, 0))

# ------------------------------------------------------------------ pallet racking
# One bay: 2.7 wide, 1.1 deep and 3.0 high, two pallets to a level on the floor and on beams at 1.05 and 2.05 — its
# uprights either end (a frame of two posts, braced zigzag between), each pallet loaded one way or another or not there.
RACK_W, RACK_D, RACK_H, LEVELS = 2.7, 1.1, 3.0, (0.0, 1.05, 2.05)
def racking(name, loads):
    p = piece(name)
    for x in (-RACK_W/2, RACK_W/2):
        for y in (-RACK_D/2 + 0.04, RACK_D/2 - 0.04):
            p.box(0.08, 0.07, RACK_H, 'Upright', x, y, 0, bevel=0.006)
            p.box(0.14, 0.12, 0.01, 'Steel', x, y, 0, bevel=0.002)             # its foot plate
            for k in range(1, 30):                                             # the holes up its face
                p.box(0.02, 0.004, 0.03, 'Dark', x, y - 0.037, k*0.1, bevel=0)
        for k in range(6):
            z0, z1 = 0.15 + k*0.47, 0.15 + (k + 1)*0.47
            a, b = (-1, 1) if k % 2 else (1, -1)
            p.bar((x, a*(RACK_D/2 - 0.06), z0), (x, b*(RACK_D/2 - 0.06), z1), 0.03, 'Upright')
        p.bar((x, -RACK_D/2 + 0.06, 0.15), (x, RACK_D/2 - 0.06, 0.15), 0.03, 'Upright')
    for z in LEVELS[1:]:
        for y in (-RACK_D/2 + 0.04, RACK_D/2 - 0.04):
            p.box(RACK_W - 0.08, 0.05, 0.11, 'Beam', 0, y, z - 0.11, bevel=0.006)
        for x in (-0.9, -0.3, 0.3, 0.9):                                       # the decking bars across
            p.box(0.04, RACK_D - 0.1, 0.03, 'Steel', x, 0, z - 0.03, bevel=0.004)
    # the pallets, a little in from the front, and their loads, keeping under the next level's beams (and the top's
    # under the ceiling)
    for level, z in enumerate(LEVELS):
        room = (LEVELS[level + 1] - 0.13 if level + 1 < len(LEVELS) else 3.0) - z - PALLET_H
        for side, load in zip((-1, 1), loads[level]):
            if load is None: continue
            x = side*(RACK_W/4 + 0.02)
            pallet(p, x, 0, z)
            if load == 'boxes': boxes(p, x, 0, z + PALLET_H, room*random.uniform(0.6, 0.95))
            elif load == 'wrapped': wrapped(p, x, 0, z + PALLET_H, room*random.uniform(0.7, 0.92))
            elif load == 'drums':
                for dx in (-0.3, 0.3):
                    for dy in (-0.21, 0.21):
                        if random.random() < 0.85: drum(p, x + dx, dy, z + PALLET_H)
    # and a load sign on the end upright's front
    p.box(0.22, 0.004, 0.16, 'Hazard', RACK_W/2 - 0.16, -RACK_D/2 + 0.002, 1.6, bevel=0)
    p.box(0.18, 0.006, 0.02, 'Stripe', RACK_W/2 - 0.16, -RACK_D/2 + 0.001, 1.7, bevel=0)
racking('Racking', [('boxes', 'wrapped'), ('boxes', None), ('wrapped', 'boxes')])
racking('Racking2', [('drums', 'boxes'), ('wrapped', 'wrapped'), (None, 'boxes')])

# ------------------------------------------------------------------ pallets on the floor
p = piece('PalletBoxes')
pallet(p)
boxes(p, 0, 0, PALLET_H, 1.1)
p = piece('PalletWrapped')
pallet(p)
wrapped(p, 0, 0, PALLET_H, 1.25)
p = piece('Drums')
pallet(p)
for dx in (-0.3, 0.3):
    for dy in (-0.21, 0.21):
        drum(p, dx, dy, PALLET_H)
p = piece('PalletStack')
for k in range(7):
    pallet(p, random.uniform(-0.03, 0.03), random.uniform(-0.03, 0.03), k*PALLET_H)

# ------------------------------------------------------------------ a crate
p = piece('Crate')
CW, CD, CH = 1.0, 0.8, 0.75
p.box(CW - 0.04, CD - 0.04, CH - 0.02, 'Crate', z0=0.01, bevel=0.004)
for z in (0.0, CH - 0.1):                                                      # the battens round it
    p.box(CW, CD, 0.1, 'Pallet', z0=z, bevel=0.006)
for x in (-CW/2 + 0.05, CW/2 - 0.05):
    for y in (-CD/2 + 0.01, CD/2 - 0.01):
        p.box(0.1, 0.02, CH, 'Pallet', x, y, 0, bevel=0.004)
p.bar((-CW/2 + 0.1, -CD/2 - 0.005, 0.1), (CW/2 - 0.1, -CD/2 - 0.005, CH - 0.1), 0.06, 'Pallet')
p.box(0.3, 0.004, 0.16, 'Label', 0.2, -CD/2 - 0.012, 0.35, bevel=0)
p.box(0.26, 0.006, 0.02, 'Red', 0.2, -CD/2 - 0.013, 0.46, bevel=0)

# ------------------------------------------------------------------ a forklift
# Its forks out front (to -y), lowered, its mast up in front of the driver's seat under the overhead guard, the
# counterweight at the back. 1.1 wide, 2.1 high, about 3 long with its forks.
p = piece('Forklift')
p.box(1.0, 1.5, 0.5, 'Forklift', 0, 0.25, 0.18, bevel=0.04, segments=2)       # the body
p.box(1.02, 0.5, 0.62, 'Dark', 0, 0.85, 0.18, bevel=0.08, segments=2)         # the counterweight
p.box(0.96, 0.4, 0.3, 'Forklift', 0, 0.8, 0.8, bevel=0.06, segments=2)        # the engine cover behind the seat
p.box(0.9, 0.3, 0.06, 'Dark', 0, -0.35, 0.68, bevel=0.02)                     # the floor plate
p.box(0.8, 0.3, 0.25, 'Forklift', 0, -0.4, 0.68, bevel=0.03)                  # the dash
p.cyl(0.02, 0.3, 'Dark', 0, -0.3, 0.9, segments=8, rot=(-0.5, 0, 0))          # the steering column
p.cyl(0.14, 0.03, 'Dark', 0, -0.17, 1.15, segments=16, rot=(-0.5, 0, 0))      # and wheel
p.box(0.5, 0.45, 0.1, 'Dark', 0, 0.25, 0.72, bevel=0.03)                      # the seat
p.box(0.5, 0.1, 0.45, 'Dark', 0, 0.48, 0.78, bevel=0.03, rot=(0.15, 0, 0))
for x in (-0.5, 0.5):
    wheel(p, 0.3, 0.22, x*1.02, -0.3, 0)                                        # front wheels
    wheel(p, 0.24, 0.18, x*1.0, 0.85, 0)                                        # back ones
    # the overhead guard's posts, the front ones raked
    p.bar((x*0.92, -0.45, 0.68), (x*0.92, -0.35, 2.05), 0.05, 'Dark')
    p.bar((x*0.92, 0.95, 1.05), (x*0.92, 0.95, 2.05), 0.05, 'Dark')
p.box(0.95, 1.45, 0.05, 'Dark', 0, 0.25, 2.03, bevel=0.01)                    # its roof, open slats
for k in range(6):
    p.box(0.85, 0.12, 0.052, 'Forklift', 0, -0.35 + k*0.24, 2.03, bevel=0.004)
p.box(0.08, 0.08, 0.06, 'Amber', 0, 0.9, 2.08, bevel=0.01)                    # a beacon on top
# the mast, the carriage on it, and the forks
for x in (-0.3, 0.3):
    p.box(0.08, 0.12, 2.1, 'Dark', x, -0.66, 0.05, bevel=0.01)
    p.box(0.04, 0.08, 1.9, 'Chrome', x*0.8, -0.66, 0.2, bevel=0.004)          # the lift cylinders
p.box(0.72, 0.06, 0.08, 'Dark', 0, -0.66, 2.05, bevel=0.01)
p.box(0.9, 0.08, 0.45, 'Dark', 0, -0.76, 0.08, bevel=0.01)                    # the carriage
for k in range(5):
    p.box(0.9, 0.02, 0.03, 'Dark', 0, -0.8, 0.6 + k*0.1, bevel=0.004)         # its backrest
for x in (-0.25, 0.25):
    p.box(0.1, 0.05, 0.5, 'Dark', x, -0.83, 0.03, bevel=0.006)
    p.box(0.1, 1.1, 0.045, 'Dark', x, -1.35, 0.03, bevel=0.006)
p.box(1.0, 0.02, 0.08, 'Hazard', 0, 1.1, 0.25, bevel=0)                       # stripes across its back
for k in range(5):
    p.box(0.06, 0.024, 0.1, 'Stripe', -0.4 + k*0.2, 1.1, 0.24, bevel=0, rot=(0, 0.7, 0))
for x in (-0.3, 0.3):
    p.box(0.1, 0.02, 0.06, 'Red', x, 1.105, 0.45, bevel=0.005)                # its tail lights

# ------------------------------------------------------------------ a pallet jack
p = piece('PalletJack')
for x in (-0.28, 0.28):
    p.box(0.16, 1.15, 0.07, 'Red', x, -0.58, 0.02, bevel=0.01)                # the forks, out front
    p.cyl(0.035, 0.07, 'Rubber', x - 0.035, -1.1, 0.0, segments=10, rot=(0, math.pi/2, 0))
p.box(0.72, 0.25, 0.14, 'Red', 0, 0.08, 0.02, bevel=0.02)
p.cyl(0.08, 0.4, 'Red', 0, 0.12, 0.1, segments=12)                            # the pump
wheel(p, 0.09, 0.06, 0.09, 0.18, 0, 'Red')
wheel(p, 0.09, 0.06, -0.09, 0.18, 0, 'Red')
p.bar((0, 0.14, 0.45), (0, 0.4, 1.15), 0.04, 'Red')                           # the handle, raked back
p.bar((-0.15, 0.4, 1.15), (0.15, 0.4, 1.15), 0.035, 'Rubber')
p.bar((-0.15, 0.36, 1.05), (-0.15, 0.4, 1.15), 0.03, 'Red')
p.bar((0.15, 0.36, 1.05), (0.15, 0.4, 1.15), 0.03, 'Red')
p.bar((-0.15, 0.36, 1.05), (0.15, 0.36, 1.05), 0.03, 'Red')

# ------------------------------------------------------------------ a rolling ladder
# Steps up (to +y) to a platform 1.5 up with a handrail round it, on casters.
p = piece('Ladder')
STEPS, TOP = 6, 1.5
for x in (-0.3, 0.3):
    p.bar((x, -0.55, 0.08), (x, 0.25, TOP), 0.04, 'Steel')                    # the stringers
    p.bar((x, 0.55, 0.08), (x, 0.55, TOP), 0.04, 'Steel')                     # the back legs
    p.bar((x, -0.55, 0.12), (x, 0.55, 0.12), 0.035, 'Steel')
    p.bar((x, -0.55, 0.9), (x, 0.25, TOP + 0.95), 0.03, 'Hazard')             # the handrails
    p.bar((x, 0.25, TOP + 0.95), (x, 0.55, TOP + 0.95), 0.03, 'Hazard')
    p.bar((x, 0.55, TOP), (x, 0.55, TOP + 0.95), 0.03, 'Hazard')
    for y in (-0.55, 0.55): caster(p, x, y, 0.1)
for k in range(STEPS):
    t = (k + 1)/(STEPS + 1)
    p.box(0.6, 0.18, 0.03, 'Steel', 0, -0.55 + t*0.8, 0.08 + t*(TOP - 0.08), bevel=0.004)
p.box(0.64, 0.34, 0.04, 'Steel', 0, 0.4, TOP - 0.04, bevel=0.006)
p.bar((-0.3, 0.55, TOP + 0.95), (0.3, 0.55, TOP + 0.95), 0.03, 'Hazard')

# ------------------------------------------------------------------ a packing bench
# 1.8 by 0.8, its top 0.9 up, a shelf of flattened boxes under it, a roll of paper at one end, tape and scales on it.
p = piece('PackingBench')
BW, BD, BH = 1.8, 0.8, 0.9
p.box(BW, BD, 0.04, 'Butcher', 0, 0, BH - 0.04, bevel=0.006)
for x in (-BW/2 + 0.04, BW/2 - 0.04):
    for y in (-BD/2 + 0.04, BD/2 - 0.04):
        p.box(0.05, 0.05, BH - 0.04, 'Bench', x, y, 0, bevel=0.006)
p.box(BW - 0.04, BD - 0.06, 0.025, 'Bench', 0, 0, 0.18, bevel=0.004)          # the shelf
for k in range(5):
    p.box(0.8, 0.6, 0.012, random.choice(CARDS), -0.4 + random.uniform(-0.03, 0.03), 0.02, 0.205 + k*0.012, bevel=0.002)
carton(p, 0.4, 0.35, 0.3, 0.45, 0.05, 0.205)
p.box(BW, 0.04, 0.35, 'Bench', 0, BD/2 - 0.02, BH, bevel=0.006)               # an upstand along its back
for x in (-BW/2 + 0.06, BW/2 - 0.06):                                          # a roll of paper on brackets
    p.box(0.02, 0.1, 0.26, 'Bench', x, BD/2 + 0.05, BH + 0.05, bevel=0.004)
p.cyl(0.1, BW - 0.16, 'Label', -BW/2 + 0.08, BD/2 + 0.08, BH + 0.2, segments=14, rot=(0, math.pi/2, 0))
p.box(0.32, 0.3, 0.05, 'Dark', -0.55, 0.05, BH, bevel=0.01)                   # the scales
p.box(0.3, 0.28, 0.01, 'Chrome', -0.55, 0.05, BH + 0.05, bevel=0.002)
p.box(0.12, 0.004, 0.03, 'Green', -0.55, -0.101, BH + 0.01, bevel=0)
p.box(0.1, 0.24, 0.1, 'Red', 0.1, -0.05, BH, bevel=0.01)                      # a tape gun
p.cyl(0.05, 0.05, 'Tape', 0.075, -0.02, BH + 0.1, segments=12, rot=(0, math.pi/2, 0))
carton(p, 0.45, 0.35, 0.28, 0.55, 0.0, BH, turn=0.15)                          # and a box being packed, open
p.box(0.44, 0.05, 0.14, random.choice(CARDS), 0.55, -0.22, BH + 0.26, bevel=0.004, rot=(-0.9, 0, 0.15))

# ------------------------------------------------------------------ a stool
p = piece('Stool')
p.cyl(0.18, 0.06, 'Dark', z0=0.62, segments=16)                               # the seat
p.cyl(0.05, 0.1, 'Steel', z0=0.52, segments=10)
for k in range(4):
    a = k*math.pi/2 + math.pi/4
    p.bar((math.cos(a)*0.06, math.sin(a)*0.06, 0.6), (math.cos(a)*0.22, math.sin(a)*0.22, 0), 0.025, 'Steel')
    p.ball(0.02, 'Rubber', (math.cos(a)*0.22, math.sin(a)*0.22, 0.01))
for k in range(4):                                                             # a footrest ring
    a0, a1 = k*math.pi/2 + math.pi/4, (k + 1)*math.pi/2 + math.pi/4
    p.bar((math.cos(a0)*0.17, math.sin(a0)*0.17, 0.22), (math.cos(a1)*0.17, math.sin(a1)*0.17, 0.22), 0.018, 'Steel')

# ------------------------------------------------------------------ a CNC mill
# An enclosure 1.8 wide, 1.4 deep and 2.1 high, its sliding door in front with a window, a control pendant on an arm at
# its right, a stack light on top and a bin for the swarf beside it.
p = piece('Mill')
MW, MD, MH = 1.8, 1.4, 2.1
p.box(MW, MD, 0.15, 'Dark', 0, 0, 0, bevel=0.01)                              # the plinth
p.box(MW, MD, 1.95, 'Machine', 0, 0, 0.15, bevel=0.04, segments=2)
p.box(MW - 0.1, MD - 0.1, 0.3, 'White', 0, 0, 1.2, bevel=0.03)                # a band round it
p.box(1.1, 0.04, 1.1, 'Machine', -0.15, -MD/2 - 0.01, 0.55, bevel=0.02)       # the door
p.box(0.8, 0.02, 0.55, 'Window', -0.15, -MD/2 - 0.035, 0.9, bevel=0.01)       # its window
p.box(0.04, 0.05, 0.4, 'Chrome', 0.34, -MD/2 - 0.05, 0.85, bevel=0.01)        # its handle
p.box(1.3, 0.12, 0.03, 'Dark', -0.15, -MD/2 - 0.06, 0.52, bevel=0.01)         # a sill for the door to run on
hazard(p, MW, 0.1, 0, -MD/2 - 0.003, 0.18)
p.box(0.08, 0.08, 0.5, 'Dark', MW/2 + 0.06, -MD/2 + 0.2, 1.3, bevel=0.01)      # the pendant's arm
p.box(0.45, 0.14, 0.55, 'Dark', MW/2 + 0.12, -MD/2 - 0.02, 1.0, bevel=0.02, rot=(0, 0, 0.35))  # and the pendant
p.box(0.3, 0.02, 0.22, 'Screen', MW/2 + 0.12 - 0.035, -MD/2 - 0.09, 1.28, bevel=0.004, rot=(0, 0, 0.35))
for k in range(8):
    p.box(0.035, 0.02, 0.035, random.choice(('White', 'Green', 'Amber')), MW/2 + 0.04 + (k % 4)*0.055, -MD/2 - 0.12 + (k % 4)*0.02,
          1.08 + (k//4)*0.06, bevel=0.005, rot=(0, 0, 0.35))
p.cyl(0.04, 0.04, 'Red', MW/2 + 0.28, -MD/2 - 0.04, 1.14, segments=10, rot=(math.pi/2, 0, 0.35))   # the stop button
p.cyl(0.025, 0.25, 'Steel', MW/2 - 0.15, MD/2 - 0.15, MH, segments=8)          # the stack light
for k, mat in enumerate(('Green', 'Amber', 'Red')):
    p.cyl(0.04, 0.07, mat, MW/2 - 0.15, MD/2 - 0.15, MH + 0.25 + k*0.075, segments=12)
p.box(0.5, 0.5, 0.45, 'Dark', -MW/2 - 0.3, -MD/2 + 0.35, 0, bevel=0.02)       # the swarf bin
for x in (-0.2, 0.2):
    for y in (-0.2, 0.2): caster(p, -MW/2 - 0.3 + x, -MD/2 + 0.35 + y, 0.07)

# ------------------------------------------------------------------ a lathe
# 2.4 long: its bed on two pedestals, the headstock (and chuck) at the left, the carriage, the tailstock at the right,
# a chip guard behind.
p = piece('Lathe')
LL = 2.4
for x in (-LL/2 + 0.3, LL/2 - 0.25):
    p.box(0.5, 0.55, 0.85, 'Machine', x, 0.05, 0, bevel=0.02)
p.box(LL - 0.2, 0.7, 0.06, 'Machine', 0, 0, 0.55, bevel=0.01)                  # the chip tray
p.box(LL - 0.3, 0.35, 0.18, 'Steel', 0.05, 0.05, 0.85, bevel=0.01)             # the bed
p.box(LL - 0.3, 0.04, 0.03, 'Chrome', 0.05, -0.14, 0.99, bevel=0.004)          # its ways
p.box(LL - 0.3, 0.04, 0.03, 'Chrome', 0.05, 0.24, 0.99, bevel=0.004)
p.box(0.6, 0.5, 0.55, 'Machine', -LL/2 + 0.3, 0.05, 0.85, bevel=0.03)          # the headstock
for k in range(4):
    p.cyl(0.02, 0.03, random.choice(('Dark', 'Red', 'Chrome')), -LL/2 + 0.12 + k*0.12, -0.2, 1.2, segments=8, rot=(math.pi/2, 0, 0))
p.cyl(0.14, 0.14, 'Chrome', -LL/2 + 0.6, 0.05, 1.2, segments=14, rot=(0, math.pi/2, 0))    # the chuck
for k in range(3):
    a = k*2*math.pi/3
    p.box(0.08, 0.04, 0.04, 'Steel', -LL/2 + 0.7, 0.05 + math.cos(a)*0.1, 1.2 + math.sin(a)*0.1, bevel=0.004)
p.cyl(0.025, 0.4, 'Steel', -LL/2 + 0.7, 0.05, 1.2, segments=8, rot=(0, math.pi/2, 0))   # a bar in it
p.box(0.35, 0.5, 0.12, 'Machine', 0.1, 0.0, 1.02, bevel=0.015)                 # the carriage
p.box(0.3, 0.1, 0.28, 'Machine', 0.1, -0.28, 0.8, bevel=0.015)                 # its apron
p.cyl(0.07, 0.03, 'Chrome', 0.05, -0.33, 0.95, segments=12, rot=(math.pi/2, 0, 0))
p.box(0.12, 0.12, 0.1, 'Dark', 0.1, 0.02, 1.14, bevel=0.01)                   # the tool post
p.box(0.3, 0.3, 0.3, 'Machine', LL/2 - 0.35, 0.05, 1.02, bevel=0.02)           # the tailstock
p.cyl(0.04, 0.2, 'Chrome', LL/2 - 0.5, 0.05, 1.2, segments=10, rot=(0, -math.pi/2, 0))
p.cyl(0.08, 0.02, 'Chrome', LL/2 - 0.18, 0.05, 1.2, segments=12, rot=(0, math.pi/2, 0))
p.box(LL - 0.4, 0.02, 0.5, 'Window', 0.0, 0.35, 1.0, bevel=0.004)             # the guard behind
p.box(LL - 0.4, 0.03, 0.04, 'Machine', 0.0, 0.35, 1.5, bevel=0.006)
p.box(0.35, 0.08, 0.3, 'Dark', -LL/2 + 0.3, -0.22, 0.4, bevel=0.01)            # the switch box
p.cyl(0.035, 0.03, 'Red', -LL/2 + 0.3, -0.26, 0.5, segments=10, rot=(math.pi/2, 0, 0))

# ------------------------------------------------------------------ a pillar drill
p = piece('DrillPress')
p.box(0.5, 0.6, 0.08, 'Machine', 0, 0.02, 0, bevel=0.01)
p.cyl(0.045, 1.7, 'Chrome', 0, 0.2, 0.08, segments=12)                         # the column
p.box(0.36, 0.36, 0.04, 'Machine', 0, -0.05, 0.85, bevel=0.01)                 # the table
p.box(0.12, 0.3, 0.08, 'Machine', 0, 0.1, 0.8, bevel=0.01)
p.box(0.3, 0.55, 0.3, 'Machine', 0, 0.07, 1.4, bevel=0.03)                     # the head
p.cyl(0.13, 0.28, 'Machine', 0, 0.28, 1.45, segments=14, rot=(math.pi/2, 0, 0))    # the motor behind
p.box(0.3, 0.3, 0.15, 'Machine', 0, 0.07, 1.7, bevel=0.03)                     # the belt guard
p.cyl(0.035, 0.18, 'Chrome', 0, -0.12, 1.22, segments=10)                      # the quill
p.cyl(0.006, 0.1, 'Dark', 0, -0.12, 1.12, segments=6)                          # and bit
for k in range(3):
    a = k*2*math.pi/3
    p.bar((0.16, 0.0, 1.5), (0.16 + 0.03, math.cos(a)*0.2, 1.5 + math.sin(a)*0.2), 0.015, 'Chrome')
    p.ball(0.022, 'Dark', (0.19, math.cos(a)*0.2, 1.5 + math.sin(a)*0.2))
p.box(0.08, 0.02, 0.1, 'Red', -0.1, -0.21, 1.5, bevel=0.01)

# ------------------------------------------------------------------ a hydraulic press
# A frame 1.3 wide, 0.9 deep and 2.6 high, two columns carrying the crown with the cylinder, the ram down between them to
# the bed, a light curtain either side of the opening.
p = piece('Press')
PW, PD, PH = 1.3, 0.9, 2.6
p.box(PW, PD, 0.7, 'Machine', 0, 0, 0, bevel=0.03)                             # the base
p.box(PW - 0.2, PD - 0.2, 0.08, 'Steel', 0, 0, 0.7, bevel=0.01)                # the bed
for x in (-PW/2 + 0.12, PW/2 - 0.12):
    p.box(0.24, PD - 0.1, PH - 0.7, 'Machine', x, 0.03, 0.7, bevel=0.02)       # the columns
    p.box(0.04, 0.04, 0.9, 'Hazard', x*0.72, -PD/2 + 0.05, 0.85, bevel=0.004)   # light curtain
p.box(PW, PD, 0.5, 'Machine', 0, 0, PH - 0.5, bevel=0.03)                      # the crown
p.cyl(0.18, 0.35, 'Machine', 0, 0, PH, segments=14)                            # the cylinder on top
p.cyl(0.08, 0.5, 'Chrome', 0, 0, PH - 1.0, segments=12)                        # the ram
p.box(PW - 0.55, PD - 0.3, 0.14, 'Steel', 0, 0, PH - 1.15, bevel=0.01)         # the platen
p.box(PW - 0.55, PD - 0.3, 0.12, 'Dark', 0, 0, 0.78, bevel=0.01)               # the die on the bed
hazard(p, PW, 0.12, 0, -PD/2 - 0.003, 0.5)
hazard(p, PW, 0.12, 0, -PD/2 - 0.003, PH - 0.35)
p.box(0.3, 0.2, 0.35, 'Dark', PW/2 + 0.2, -0.2, 1.0, bevel=0.02)               # the two-hand control
for x in (-0.08, 0.08):
    p.cyl(0.035, 0.03, 'Green', PW/2 + 0.2 + x, -0.3, 1.26, segments=10, rot=(math.pi/2, 0, 0))
p.cyl(0.045, 0.03, 'Red', PW/2 + 0.2, -0.3, 1.12, segments=10, rot=(math.pi/2, 0, 0))
p.box(0.06, 0.06, 1.0, 'Steel', PW/2 + 0.2, -0.2, 0, bevel=0.01)

# ------------------------------------------------------------------ a conveyor
# 3.0 long (along x) and 0.6 wide, its belt 0.85 up, on legs, with its motor under one end and boxes riding it.
p = piece('Conveyor')
CL, CWD, CBH = 3.0, 0.6, 0.85
p.box(CL, 0.05, 0.16, 'Machine', 0, -CWD/2, CBH - 0.12, bevel=0.01)            # its side rails
p.box(CL, 0.05, 0.16, 'Machine', 0, CWD/2, CBH - 0.12, bevel=0.01)
p.box(CL - 0.1, CWD - 0.06, 0.03, 'Rubber', 0, 0, CBH - 0.03, bevel=0.004)     # the belt
for x in (-CL/2, CL/2):                                                        # the drums at its ends
    p.cyl(0.06, CWD - 0.04, 'Chrome', x, -CWD/2 + 0.02, CBH - 0.07, segments=12, rot=(-math.pi/2, 0, 0))
for x in (-CL/2 + 0.2, 0, CL/2 - 0.2):                                         # the legs, braced
    for y in (-CWD/2, CWD/2):
        p.box(0.06, 0.06, CBH - 0.12, 'Steel', x, y, 0, bevel=0.006)
        p.box(0.12, 0.12, 0.01, 'Steel', x, y, 0, bevel=0.002)
    p.box(0.04, CWD, 0.04, 'Steel', x, 0, 0.25, bevel=0.004)
p.box(CL - 0.4, 0.04, 0.04, 'Steel', 0, -CWD/2, 0.25, bevel=0.004)
p.box(0.3, 0.3, 0.25, 'Machine', CL/2 - 0.35, 0, 0.35, bevel=0.02)             # the motor
p.cyl(0.1, 0.18, 'Dark', CL/2 - 0.35, -0.08, 0.47, segments=12, rot=(math.pi/2, 0, 0))
for y in (-CWD/2 + 0.03, CWD/2 - 0.03):                                        # guide rails along it
    p.box(CL, 0.02, 0.02, 'Chrome', 0, y, CBH + 0.1, bevel=0.004)
    for x in (-CL/2 + 0.2, 0, CL/2 - 0.2):
        p.box(0.02, 0.02, 0.1, 'Chrome', x, y, CBH, bevel=0.003)
p.box(0.3, 0.08, 0.1, 'Dark', -CL/2 + 0.3, -CWD/2 - 0.06, CBH - 0.08, bevel=0.01)   # its stop button
p.cyl(0.035, 0.03, 'Red', -CL/2 + 0.3, -CWD/2 - 0.1, CBH - 0.03, segments=10, rot=(math.pi/2, 0, 0))
for x in (-0.95, -0.2, 0.75):
    s = random.uniform(0.28, 0.4)
    carton(p, s, s*random.uniform(0.8, 1.1), s*random.uniform(0.6, 0.9), x, random.uniform(-0.05, 0.05), CBH, turn=random.uniform(-0.1, 0.1))

# ------------------------------------------------------------------ a workbench
# 2.0 by 0.75, a thick wooden top 0.9 up on a steel frame, a drawer unit under one end, a vice at the front right, and a
# few tools lying on it.
p = piece('Workbench')
WW, WD, WH = 2.0, 0.75, 0.9
p.box(WW, WD, 0.06, 'Butcher', 0, 0, WH - 0.06, bevel=0.008)
for x in (-WW/2 + 0.05, WW/2 - 0.05):
    for y in (-WD/2 + 0.05, WD/2 - 0.05):
        p.box(0.06, 0.06, WH - 0.06, 'Bench', x, y, 0, bevel=0.006)
    p.box(0.05, WD - 0.1, 0.05, 'Bench', x, 0, 0.12, bevel=0.004)
p.box(WW - 0.1, WD - 0.1, 0.03, 'Bench', 0, 0, 0.12, bevel=0.004)             # the shelf under
p.box(0.55, WD - 0.1, WH - 0.24, 'Bench', WW/2 - 0.35, 0, 0.16, bevel=0.01)   # the drawers
for k in range(4):
    z = 0.19 + k*0.16
    p.box(0.5, 0.012, 0.14, 'Bench', WW/2 - 0.35, -WD/2 + 0.045, z, bevel=0.004)
    p.box(0.3, 0.02, 0.02, 'Chrome', WW/2 - 0.35, -WD/2 + 0.035, z + 0.1, bevel=0.004)
p.box(0.14, 0.2, 0.08, 'Machine', WW/2 - 0.25, -WD/2 + 0.08, WH, bevel=0.01)   # the vice
p.box(0.18, 0.05, 0.1, 'Machine', WW/2 - 0.25, -WD/2 - 0.02, WH, bevel=0.01)
p.box(0.18, 0.04, 0.1, 'Machine', WW/2 - 0.25, -WD/2 + 0.12, WH, bevel=0.01)
p.cyl(0.012, 0.3, 'Chrome', WW/2 - 0.4, -WD/2 - 0.07, WH + 0.05, segments=6, rot=(0, math.pi/2, 0))
p.cyl(0.015, 0.25, 'Chrome', WW/2 - 0.25, -WD/2 - 0.02, WH + 0.05, segments=6, rot=(math.pi/2, 0, 0))
# a hammer, a spanner, a tape measure, a mug and a can of oil
p.box(0.3, 0.03, 0.025, 'Butcher', -0.4, -0.1, WH, bevel=0.006, rot=(0, 0, 0.4))
p.box(0.04, 0.12, 0.035, 'Steel', -0.27, -0.03, WH, bevel=0.006, rot=(0, 0, 0.4))
p.box(0.22, 0.03, 0.008, 'Chrome', 0.1, -0.15, WH, bevel=0.003, rot=(0, 0, -0.3))
p.box(0.07, 0.07, 0.04, 'Hazard', 0.3, 0.1, WH, bevel=0.012)
p.cyl(0.04, 0.09, 'White', -0.7, 0.2, WH, segments=12)
p.cyl(0.035, 0.15, 'Red', -0.1, 0.25, WH, segments=10)
p.cyl(0.006, 0.12, 'Chrome', -0.1, 0.25, WH + 0.15, segments=6, rot=(0.5, 0, 0))
carton(p, 0.35, 0.25, 0.2, -0.65, -0.05, 0.15)                                 # and a box on the shelf

# ------------------------------------------------------------------ a tool chest
p = piece('ToolChest')
TW, TD = 0.7, 0.48
p.box(TW, TD, 0.8, 'Toolbox', 0, 0, 0.1, bevel=0.015)                          # the roller cabinet
for k, h in enumerate((0.2, 0.15, 0.12, 0.1, 0.1, 0.08)):
    z = 0.12 + sum((0.2, 0.15, 0.12, 0.1, 0.1, 0.08)[:k]) + 0.005
    p.box(TW - 0.04, 0.01, h - 0.012, 'Toolbox', 0, -TD/2 - 0.002, z, bevel=0.003)
    p.box(TW - 0.12, 0.025, 0.018, 'Chrome', 0, -TD/2 - 0.01, z + h - 0.035, bevel=0.004)
p.box(TW + 0.02, TD + 0.02, 0.02, 'Dark', 0, 0, 0.9, bevel=0.006)
p.box(TW, TD - 0.05, 0.3, 'Toolbox', 0, 0.02, 0.92, bevel=0.015)               # the top box
for k in range(3):
    p.box(TW - 0.04, 0.01, 0.07, 'Toolbox', 0, -TD/2 + 0.02, 0.95 + k*0.085, bevel=0.003)
    p.box(TW - 0.2, 0.02, 0.014, 'Chrome', 0, -TD/2 + 0.012, 0.99 + k*0.085, bevel=0.003)
p.box(TW, TD - 0.05, 0.05, 'Toolbox', 0, 0.02, 1.22, bevel=0.02)               # its lid
for x in (-TW/2 + 0.05, TW/2 - 0.05):
    for y in (-TD/2 + 0.05, TD/2 - 0.05): caster(p, x, y, 0.1)
p.bar((TW/2 + 0.03, -TD/2 + 0.05, 0.75), (TW/2 + 0.03, TD/2 - 0.05, 0.75), 0.025, 'Chrome')  # a handle down its side
p.box(0.15, 0.004, 0.06, 'Label', -0.2, -TD/2 - 0.008, 0.7, bevel=0)

# ------------------------------------------------------------------ lockers
p = piece('Lockers')
LW, LD, LH = 0.32, 0.45, 1.85
for k in range(3):
    x = (k - 1)*LW
    p.box(LW - 0.01, LD, LH, 'Locker', x, 0, 0.05, bevel=0.008)
    p.box(LW - 0.04, 0.01, LH - 0.08, 'Locker', x, -LD/2 - 0.002, 0.09, bevel=0.004)   # its door
    for v in range(4):
        p.box(0.16, 0.012, 0.012, 'Dark', x, -LD/2 - 0.006, LH - 0.2 + v*0.03, bevel=0)     # vents
        p.box(0.16, 0.012, 0.012, 'Dark', x, -LD/2 - 0.006, 0.25 + v*0.03, bevel=0)
    p.box(0.025, 0.03, 0.14, 'Chrome', x + LW/2 - 0.06, -LD/2 - 0.012, 1.0, bevel=0.005)
    p.box(0.06, 0.004, 0.03, 'Label', x, -LD/2 - 0.009, LH - 0.4, bevel=0)
p.box(LW*3, LD, 0.05, 'Dark', 0, 0, 0, bevel=0.005)
if True:
    carton(p, 0.4, 0.35, 0.2, -0.2, 0.0, LH + 0.05)                            # a box left on top

# ------------------------------------------------------------------ an electrical cabinet
p = piece('ControlPanel')
EW, ED, EH = 0.9, 0.4, 1.9
p.box(EW, ED, 0.1, 'Dark', 0, 0, 0, bevel=0.01)
p.box(EW, ED, EH - 0.1, 'Steel', 0, 0, 0.1, bevel=0.012)
for x in (-EW/4, EW/4):
    p.box(EW/2 - 0.02, 0.012, EH - 0.16, 'Steel', x, -ED/2 - 0.003, 0.13, bevel=0.004)
    p.box(0.03, 0.03, 0.18, 'Dark', x + (0.18 if x < 0 else -0.18), -ED/2 - 0.015, 0.95, bevel=0.006)
p.box(0.3, 0.012, 0.2, 'Hazard', -EW/4, -ED/2 - 0.01, 1.45, bevel=0)           # a warning sign
p.hull([(-EW/4 - 0.06, -ED/2 - 0.017, 1.49), (-EW/4 + 0.06, -ED/2 - 0.017, 1.49), (-EW/4, -ED/2 - 0.017, 1.6),
        (-EW/4 - 0.06, -ED/2 - 0.019, 1.49), (-EW/4 + 0.06, -ED/2 - 0.019, 1.49), (-EW/4, -ED/2 - 0.019, 1.6)], 'Stripe')
for k, mat in enumerate(('Green', 'Amber', 'Red')):                            # indicator lamps
    p.cyl(0.025, 0.02, mat, EW/4 - 0.1 + k*0.1, -ED/2 - 0.01, 1.5, segments=10, rot=(math.pi/2, 0, 0))
p.cyl(0.05, 0.03, 'Red', EW/4, -ED/2 - 0.01, 1.3, segments=12, rot=(math.pi/2, 0, 0))   # the isolator
p.box(0.14, 0.012, 0.14, 'Hazard', EW/4, -ED/2 - 0.009, 1.23, bevel=0)
p.box(0.06, 0.06, 0.6, 'Dark', EW/2 - 0.1, 0, EH, bevel=0.006)                # conduit up to the ceiling

# ------------------------------------------------------------------ small things
p = piece('Extinguisher')
p.box(0.3, 0.2, 0.03, 'Red', 0, 0.02, 0, bevel=0.006)                          # a stand
p.cyl(0.08, 0.5, 'Red', 0, 0, 0.03, segments=14)
p.cyl(0.08, 0.05, 'Red', 0, 0, 0.53, r2=0.03, segments=14)
p.box(0.04, 0.12, 0.05, 'Dark', 0, -0.02, 0.58, bevel=0.008)
p.cyl(0.012, 0.3, 'Rubber', 0.07, -0.04, 0.25, segments=6, rot=(0.1, 0.3, 0))
p.box(0.1, 0.004, 0.12, 'Label', 0, -0.08, 0.25, bevel=0)
p = piece('Cone')
p.box(0.36, 0.36, 0.03, 'Cone', bevel=0.01)
p.cyl(0.13, 0.5, 'Cone', z0=0.03, r2=0.025, segments=12)
p.cyl(0.108, 0.07, 'White', z0=0.22, r2=0.087, segments=12)
p = piece('HighBay')                                                           # a lamp to hang, its cord up to z 0.45
p.cyl(0.006, 0.25, 'Dark', z0=0.2, segments=6)
p.cyl(0.06, 0.08, 'Dark', z0=0.14, segments=12)
p.cyl(0.26, 0.14, 'Steel', z0=0.0, r2=0.08, segments=18)
p.cyl(0.22, 0.01, 'Light', z0=-0.005, segments=18)

# ------------------------------------------------------------------ out
export(OUT)
