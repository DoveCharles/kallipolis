# Builds assets/models/OfficeStartup.glb: a startup's open-plan office, its pieces named as Office.glb's so furnishOffice
# (buildings/interior.js) lays either out the same way; same low-poly, flat-coloured style.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/startup-office-models.py
#
# Desk: an open bench desk on coloured trestles, felt screens clipped on behind and to the left (faces where Office.glb's
# panels are: interior.js's DESK), a thin monitor on an arm, a white keyboard. Panel: the trestle and felt screen closing
# a row. OfficeChair: a mesh-backed task chair. WaterCooler: kombucha on tap. Printer: a 3D printer on a trolley.
# Cabinet: tall open shelving with plants and books; LowCabinet: a credenza with coloured doors. SnakePlant: a monstera
# in a woven basket; Ficus: a fiddle-leaf fig; Bush: a pothos trailing off a plinth. On desks: Sticky, Calendar (a vision
# board), Mug (a keep cup), Frame (a salt lamp), Pens, Cactus (a succulent in a faceted pot), Papers (a laptop), Duck (an
# amethyst). Its own: Beanbag, Rug (round, rainbow), PingPong (a table tennis table). Faces -y, placed by origin.
import math, os, random, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'OfficeStartup.glb')
random.seed(21)

# (recoloured per office, as Office.glb's: Fabric, Upholstery, Laminate, Steel, Pot; Sticky and Mug per desk; and Beanbag)
material('Fabric', 0xe8735a, 1.0)       # felt
material('Upholstery', 0x2a9a8a, 0.95)
material('Laminate', 0xf4f1ea, 0.5)
material('Steel', 0xf2c230, 0.5)        # powder-coated legs and frames
material('Pot', 0xe8a0a0, 0.8)
material('Beanbag', 0x7a5ac8, 0.9)
material('Birch', 0xd8bc8a, 0.6)
material('White', 0xf6f6f2, 0.5)
material('Dark', 0x26282c, 0.5)
material('Mesh', 0x3a3c42, 0.9)
material('Screen', 0xcccccc, 0.5)
material('Keys', 0xe4e4e0, 0.6)
material('Glass', 0xd8e8e0, 0.1)
material('Kombucha', 0xd89a3a, 0.2)
material('Copper', 0xc07a4a, 0.35, 0.7)
material('Chalk', 0x2a3a34, 0.9)
material('Filament', 0x3ad0c0, 0.4)
material('Wicker', 0xc8a068, 1.0)
material('Leaf', 0x2e8a3e, 0.55)
material('Leaf2', 0x1e6a34, 0.55)
material('Pothos', 0x6ab83a, 0.55)
material('Bark', 0x6b4a2e, 1.0)
material('Dirt', 0x3a2414, 1.0)
material('Terracotta', 0xd07a52, 0.9)
material('Succulent', 0x7ab8a0, 0.7)
material('Sticky', 0xf6a6c0, 0.8)
material('Mug', 0x3ad0c0, 0.4)
material('Cork', 0xb88a5a, 0.9)
material('Salt', 0xf0906a, 0.6, glow=0xc8603a)
material('Amethyst', 0x9a5ad8, 0.2)
material('Paper', 0xf6f4ee, 0.9)
material('Pink', 0xf4a0c0, 0.8)
material('Sun', 0xf8c840, 0.8)
material('Sky', 0x6ac0e8, 0.8)
material('Mint', 0x8ae0b0, 0.8)
material('Coral', 0xf0785a, 0.8)
material('Lilac', 0xb89ae8, 0.8)
material('Pen', 0xe8508a, 0.5)
material('Book', 0x3a6ac8, 0.8)
material('Book2', 0xe8b030, 0.8)
material('Table', 0x1e7a5a, 0.6)
material('Line', 0xf6f6f2, 0.7)
material('Net', 0x26282c, 0.9)
RAINBOW = ['Coral', 'Sun', 'Mint', 'Sky', 'Lilac', 'Pink']

# ------------------------------------------------------------------ the desk (as Office.glb's: see DESK in interior.js)
# Top 1.4 by 0.75, 0.74 up, x -0.7..0.7, y -0.375 (front)..0.375; back screen's front face at y 0.375, left one's at
# x -0.7, up to 1.25; monitor centred, face at y 0.13, 0.84..1.18 up.
DESK_W, DESK_D, DESK_H, SCREEN_H, SCREEN_T = 1.4, 0.75, 0.74, 1.25, 0.03

def trestle(p, x):
    # an A-ish leg frame at x: two uprights, a foot and a top rail, across the desk's depth
    for y in (-0.3, 0.3):
        p.box(0.04, 0.04, DESK_H - 0.04, 'Steel', x, y, 0, bevel=0.01)
    p.box(0.05, 0.7, 0.04, 'Steel', x, 0, 0, bevel=0.01)
    p.box(0.05, 0.66, 0.03, 'Steel', x, 0, DESK_H - 0.06, bevel=0.008)

def felt(p, w, d, x, y, z0, h):
    p.box(w, d, h, 'Fabric', x, y, z0, bevel=0.012, segments=2)

p = piece('Desk')
p.box(DESK_W, DESK_D, 0.025, 'Laminate', z0=DESK_H - 0.025, bevel=0.006)
p.box(DESK_W + 0.004, DESK_D + 0.004, 0.012, 'Birch', z0=DESK_H - 0.03, bevel=0.002)   # the ply edge
trestle(p, -0.62)
p.box(1.2, 0.03, 0.06, 'Steel', 0, 0.3, 0.1, bevel=0.008)                              # the stretcher
# the felt screens, clipped to the top
felt(p, DESK_W, SCREEN_T, 0, DESK_D/2 + SCREEN_T/2, DESK_H + 0.01, SCREEN_H - DESK_H - 0.01)
felt(p, SCREEN_T, DESK_D*0.7, -DESK_W/2 - SCREEN_T/2, 0.375 - DESK_D*0.35, DESK_H + 0.01, 0.4)
for x in (-0.5, 0.5):
    p.box(0.04, 0.05, 0.05, 'Dark', x, DESK_D/2 + 0.01, DESK_H - 0.02, bevel=0.006)   # clamps
# a cable tray and a slim monitor on an arm
p.box(1.0, 0.12, 0.08, 'Dark', 0, 0.26, DESK_H - 0.14, bevel=0.006)
p.box(0.08, 0.06, 0.03, 'Dark', 0, 0.33, DESK_H, bevel=0.01)
p.box(0.03, 0.03, 0.24, 'White', 0, 0.33, DESK_H + 0.03, bevel=0.008)
p.box(0.03, 0.18, 0.03, 'White', 0, 0.24, DESK_H + 0.24, bevel=0.008)
p.box(0.6, 0.018, 0.35, 'Dark', 0, 0.14, 0.835, bevel=0.006)
p.box(0.58, 0.004, 0.32, 'Screen', 0, 0.129, 0.85, bevel=0.001)
# keyboard, mouse
p.box(0.42, 0.13, 0.012, 'White', -0.04, -0.17, DESK_H, bevel=0.004)
p.box(0.4, 0.11, 0.006, 'Keys', -0.04, -0.17, DESK_H + 0.012, bevel=0.002)
p.ball(0.03, 'White', (0.32, -0.16, DESK_H + 0.012), scale=(1, 1.7, 0.55))

# the end of a row: a trestle with the felt screen's end on it
p = piece('Panel')
trestle(p, 0)
felt(p, SCREEN_T, DESK_D*0.7, 0, 0.375 - DESK_D*0.35 - 0.025, DESK_H + 0.01, 0.4)

# ------------------------------------------------------------------ the chair: mesh back, coloured seat
p = piece('OfficeChair')
for k in range(5):
    a = k*2*math.pi/5 + math.pi/2
    p.box(0.3, 0.05, 0.03, 'White', math.cos(a)*0.15, math.sin(a)*0.15, 0.05, bevel=0.01, rot=(0, 0, a))
    p.ball(0.028, 'Dark', (math.cos(a)*0.3, math.sin(a)*0.3, 0.028))
p.cyl(0.05, 0.05, 'White', z0=0.04, segments=10)
p.cyl(0.022, 0.34, 'White', z0=0.08, segments=10)
p.box(0.2, 0.2, 0.04, 'Dark', 0, 0, 0.4, bevel=0.01)
p.box(0.48, 0.46, 0.07, 'Upholstery', 0, -0.01, 0.43, bevel=0.03, segments=2)
p.box(0.06, 0.03, 0.34, 'White', 0, 0.23, 0.44, bevel=0.008)
p.box(0.46, 0.06, 0.54, 'White', 0, 0.25, 0.56, bevel=0.03, segments=2, rot=(-0.12, 0, 0))     # the frame
p.box(0.4, 0.07, 0.46, 'Mesh', 0, 0.245, 0.6, bevel=0.02, rot=(-0.12, 0, 0))                   # its mesh
for x in (-0.25, 0.25):
    p.box(0.03, 0.04, 0.2, 'White', x, 0.04, 0.46, bevel=0.008)
    p.box(0.06, 0.24, 0.03, 'Upholstery', x, 0.01, 0.66, bevel=0.012)

# ------------------------------------------------------------------ kombucha on tap (for the water cooler)
p = piece('WaterCooler')
p.box(0.5, 0.5, 0.9, 'Birch', bevel=0.015)                                     # a little ply fridge
p.box(0.44, 0.01, 0.6, 'Chalk', 0, -0.255, 0.1, bevel=0.004)                    # a chalkboard door
for i, c in enumerate(('Coral', 'Sun', 'Mint')):                                # scrawled flavours
    p.box(0.26, 0.004, 0.025, c, -0.04, -0.262, 0.55 - i*0.12, bevel=0)
p.box(0.5, 0.5, 0.03, 'White', z0=0.9, bevel=0.01)
p.box(0.3, 0.06, 0.28, 'Copper', 0, 0.12, 0.93, bevel=0.01)                    # the tap tower
for x in (-0.09, 0, 0.09):
    p.cyl(0.012, 0.08, 'Copper', x, 0.06, 1.12, segments=8, rot=(math.pi/2, 0, 0))
    p.box(0.02, 0.02, 0.08, 'Dark', x, -0.02, 1.05, bevel=0.005)
p.box(0.3, 0.1, 0.01, 'Dark', 0, -0.05, 0.93, bevel=0.003)                     # drip tray
for x in (-0.16, 0.16):                                                         # jars of it
    p.cyl(0.05, 0.14, 'Glass', x, -0.15, 0.93, segments=10)
    p.cyl(0.046, 0.1, 'Kombucha', x, -0.15, 0.935, segments=10)

# ------------------------------------------------------------------ a 3D printer on a trolley
p = piece('Printer')
for x in (-0.25, 0.25):
    for y in (-0.22, 0.22):
        p.box(0.03, 0.03, 0.7, 'Steel', x, y, 0.04, bevel=0.008)
        p.ball(0.03, 'Dark', (x, y, 0.03))
for z in (0.12, 0.7):
    p.box(0.56, 0.5, 0.025, 'Birch', z0=z, bevel=0.006)
for k in range(4):                                                              # spools below
    p.cyl(0.09, 0.06, RAINBOW[k], -0.18 + k*0.12, 0, 0.145, segments=12, rot=(0, math.pi/2, 0))
p.box(0.46, 0.44, 0.06, 'Dark', 0, 0, 0.725, bevel=0.01)                       # the printer's base
for x in (-0.21, 0.21):
    p.box(0.03, 0.03, 0.44, 'Dark', x, 0.18, 0.785, bevel=0.006)
p.box(0.45, 0.04, 0.04, 'Dark', 0, 0.18, 1.22, bevel=0.008)
p.box(0.08, 0.06, 0.08, 'Filament', 0.05, 0.13, 1.0, bevel=0.01)               # the head
p.box(0.34, 0.3, 0.012, 'White', 0, -0.02, 0.8, bevel=0.003)                   # the bed
p.cyl(0.05, 0.1, 'Filament', 0, -0.02, 0.81, r2=0.02, segments=6)              # a half-printed thing
p.cyl(0.09, 0.05, 'Pink', 0, 0.26, 1.02, segments=12, rot=(0, math.pi/2, 0))   # its spool

# ------------------------------------------------------------------ open shelving, tall (Cabinet), and a credenza (LowCabinet)
p = piece('Cabinet')
W, D, H = 0.47, 0.4, 1.32
for x in (-W/2 + 0.015, W/2 - 0.015):
    p.box(0.03, D, H, 'Steel', x, 0, 0, bevel=0.006)
for i in range(5):
    p.box(W, D, 0.025, 'Birch', z0=0.02 + i*0.32, bevel=0.005)
for i, shelf in enumerate(range(4)):
    z = 0.045 + shelf*0.32
    kind = (i + random.randint(0, 3)) % 3
    if kind == 0:
        for k in range(random.randint(4, 8)):
            h = random.uniform(0.18, 0.26)
            p.box(0.035, 0.24, h, random.choice(('Book', 'Book2', 'Coral', 'Mint', 'White')), -0.17 + k*0.04, 0.02, z,
                  bevel=0.003, rot=(0, 0.1 if k == 7 else 0, 0))
    elif kind == 1:
        p.cyl(0.07, 0.11, 'Pot', 0, 0, z, segments=10)
        for k in range(6):
            a = k*1.05
            p.ball(0.05, 'Pothos', (math.cos(a)*0.07, math.sin(a)*0.07 - 0.03, z + 0.1 - (k % 2)*0.08), scale=(1, 1, 0.5))
    else:
        p.box(0.2, 0.28, 0.2, 'Wicker', -0.08, 0, z, bevel=0.01)
        p.ball(0.06, 'Amethyst', (0.12, 0, z + 0.04), scale=(1, 1, 0.7))
p = piece('LowCabinet')
W, D, H = 0.47, 0.45, 0.66
p.box(W, D, 0.03, 'Birch', z0=H - 0.03, bevel=0.006)
p.box(W, D - 0.02, H - 0.13, 'White', 0, 0, 0.1, bevel=0.006)
p.box(W - 0.04, 0.012, H - 0.17, 'Pot', 0, -D/2 + 0.005, 0.12, bevel=0.004)    # a coloured door
p.cyl(0.03, 0.012, 'Birch', 0.13, -D/2 - 0.002, 0.48, segments=10, rot=(math.pi/2, 0, 0))
for x in (-W/2 + 0.04, W/2 - 0.04):
    for y in (-D/2 + 0.04, D/2 - 0.04):
        p.cyl(0.012, 0.1, 'Steel', x, y, 0, r2=0.018, segments=6)

# ------------------------------------------------------------------ plants
p = piece('SnakePlant')                                                         # a monstera in a basket
p.cyl(0.19, 0.34, 'Wicker', segments=14, r2=0.21)
p.cyl(0.205, 0.03, 'Pot', z0=0.25, segments=14)
p.cyl(0.19, 0.01, 'Dirt', z0=0.33, segments=14)
for k in range(9):
    a, tilt = k*2.4, random.uniform(0.25, 0.8)
    length = random.uniform(0.4, 0.75)
    p.cyl(0.008, length, 'Leaf2', 0, 0, 0.33, segments=5, rot=(0, tilt, a))
    tip = (math.cos(a)*math.sin(tilt)*length, math.sin(a)*math.sin(tilt)*length, 0.33 + math.cos(tilt)*length)
    p.ball(0.14, 'Leaf' if k % 3 else 'Leaf2', tip, scale=(1.1, 0.9, 0.08), rot=(0, tilt + 0.5, a))
p = piece('Ficus')                                                              # a fiddle-leaf fig
p.cyl(0.2, 0.38, 'Pot', segments=16, r2=0.19)
p.cyl(0.18, 0.01, 'Dirt', z0=0.36, segments=16)
p.cyl(0.025, 1.3, 'Bark', z0=0.3, r2=0.015, segments=7, rot=(0.03, -0.04, 0))
for k in range(18):
    a = k*2.2
    z = 0.8 + k*0.045
    r = 0.12 + 0.1*random.random()
    p.ball(0.1, 'Leaf' if k % 2 else 'Leaf2', (math.cos(a)*r, math.sin(a)*r, z), scale=(0.7, 1.1, 0.12),
           rot=(random.uniform(-0.6, 0.6), random.uniform(-0.6, 0.6), a))
p = piece('Bush')                                                               # a pothos off a plinth
p.box(0.34, 0.34, 0.5, 'White', bevel=0.01)
p.cyl(0.14, 0.18, 'Pot', z0=0.5, segments=12, r2=0.16)
p.cyl(0.15, 0.01, 'Dirt', z0=0.66, segments=12)
for k in range(7):
    a = k*0.9
    for j in range(6):                                                          # trailing vines down the plinth
        r, z = 0.15 + min(j, 1)*0.04, 0.68 - j*0.09
        p.ball(0.045, 'Pothos' if (j + k) % 2 else 'Leaf', (math.cos(a)*r, math.sin(a)*r, z), scale=(1, 0.8, 0.35),
               rot=(0, 0.6, a))
p.ball(0.15, 'Pothos', (0, 0, 0.72), scale=(1, 1, 0.5))

# ------------------------------------------------------------------ what's left about a desk
p = piece('Sticky')
p.box(0.076, 0.002, 0.076, 'Sticky', z0=0, bevel=0)
p = piece('Calendar')                                                           # a vision board, pinned up facing -y
p.box(0.3, 0.004, 0.42, 'Cork', bevel=0.001)
for k, (x, z, w, h) in enumerate(((-0.07, 0.25, 0.12, 0.13), (0.07, 0.27, 0.13, 0.1), (-0.06, 0.06, 0.13, 0.16),
                                  (0.08, 0.12, 0.1, 0.12), (0.08, 0.02, 0.1, 0.07))):
    p.box(w, 0.006, h, RAINBOW[k], x, -0.002, z, bevel=0.001, rot=(0, random.uniform(-0.1, 0.1), 0))
p.box(0.22, 0.006, 0.04, 'White', 0, -0.004, 0.36, bevel=0.001)                 # MANIFEST
p.cyl(0.008, 0.01, 'Pink', 0, -0.004, 0.395, segments=8, rot=(math.pi/2, 0, 0))
p = piece('Mug')                                                                # a keep cup
p.cyl(0.035, 0.1, 'Mug', segments=14, r2=0.042)
p.cyl(0.044, 0.025, 'Cork', z0=0.045, segments=14)
p.cyl(0.043, 0.015, 'Dark', z0=0.1, segments=14, r2=0.036)
p = piece('Frame')                                                              # a salt lamp
p.box(0.1, 0.1, 0.03, 'Birch', bevel=0.006)
p.hull([(random.uniform(-0.05, 0.05), random.uniform(-0.05, 0.05), random.uniform(0.03, 0.18)) for _ in range(14)]
       + [(-0.04, -0.04, 0.03), (0.04, -0.04, 0.03), (-0.04, 0.04, 0.03), (0.04, 0.04, 0.03)], 'Salt')
p = piece('Pens')
p.cyl(0.035, 0.08, 'Terracotta', segments=6)
for k, c in enumerate(('Pen', 'Sky', 'Sun')):
    a = k*2.1
    p.cyl(0.006, 0.15, c, math.cos(a)*0.015, math.sin(a)*0.015, 0.01, segments=6, rot=(math.sin(a)*0.25, math.cos(a)*0.25, 0))
p = piece('Cactus')                                                             # a succulent in a faceted pot
p.cyl(0.05, 0.06, 'Pot', segments=5, r2=0.04)
for k in range(8):
    a = k*2.4
    p.ball(0.025, 'Succulent', (math.cos(a)*0.02, math.sin(a)*0.02, 0.075), scale=(0.5, 1.2, 0.3), rot=(0.6, 0, a))
p.ball(0.02, 'Succulent', (0, 0, 0.08))
p = piece('Papers')                                                             # a laptop, open
p.box(0.32, 0.22, 0.012, 'White', bevel=0.004)
p.box(0.28, 0.13, 0.004, 'Keys', 0, 0.02, 0.012, bevel=0.001)
p.box(0.32, 0.008, 0.21, 'White', 0, 0.12, 0.0, bevel=0.003, rot=(-0.3, 0, 0))
p.box(0.29, 0.004, 0.18, 'Screen', 0, 0.113, 0.02, bevel=0.001, rot=(-0.3, 0, 0))
for k, c in enumerate(('Coral', 'Sun', 'Mint')):                                # stickers
    p.cyl(0.018, 0.004, c, -0.08 + k*0.07, 0.126, 0.1 - k*0.02, segments=8, rot=(math.pi/2 - 0.3, 0, 0))
p = piece('Duck')                                                               # an amethyst cluster
p.cyl(0.05, 0.02, 'Chalk', segments=7)
for k in range(7):
    a = k*0.9
    h = random.uniform(0.05, 0.11)
    p.cyl(0.012, h, 'Amethyst', math.cos(a)*0.02, math.sin(a)*0.02, 0.015, r2=0.002, segments=6,
          rot=(math.sin(a)*0.4, math.cos(a)*0.4, 0))

# ------------------------------------------------------------------ its own: beanbags, a rug, table tennis
p = piece('Beanbag')
p.ball(0.42, 'Beanbag', (0, 0, 0.22), scale=(1, 1, 0.55), detail=2)
p.ball(0.34, 'Beanbag', (0, 0.18, 0.42), scale=(1, 0.55, 0.9), detail=2)
p = piece('Rug')                                                                # round, in rainbow rings
for k, c in enumerate(RAINBOW):
    p.cyl(1.1 - k*0.17, 0.006 + k*0.001, c, segments=32)
p = piece('PingPong')
p.box(2.74, 1.525, 0.03, 'Table', z0=0.73, bevel=0.004)
p.box(2.74, 0.02, 0.002, 'Line', 0, 0, 0.76, bevel=0)
for x in (-1.36, 1.36):
    p.box(0.02, 1.525, 0.002, 'Line', x, 0, 0.76, bevel=0)
for y in (-0.752, 0.752):
    p.box(2.74, 0.02, 0.002, 'Line', 0, y, 0.76, bevel=0)
p.box(0.01, 1.7, 0.15, 'Net', 0, 0, 0.76, bevel=0)
for x in (-1.0, 1.0):
    for y in (-0.6, 0.6):
        p.box(0.05, 0.05, 0.73, 'Dark', x, y, 0, bevel=0.01)
p.ball(0.02, 'White', (0.5, 0.3, 0.78))
p.box(0.15, 0.15, 0.015, 'Coral', -0.9, -0.3, 0.76, bevel=0.005)                # bats left on it
p.box(0.15, 0.15, 0.015, 'Sky', 0.8, 0.45, 0.76, bevel=0.005, rot=(0, 0, 0.7))

export(OUT)
