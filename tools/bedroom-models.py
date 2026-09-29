# Builds assets/models/Bedroom.glb: a home's bedroom and its ensuite (see "the bedroom" in src/buildings/interior.js), in
# the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/bedroom-models.py
#
# The bedroom's: a double Bed (headboard at the back), a Bedside table with a lamp on it, a Wardrobe, and a Dresser (a
# chest of drawers with a mirror stood on it). The ensuite's: a Toilet, a pedestal Basin with a mirror over it, and a
# Shower (a tray, glass on its open sides, its head on a riser at the back). Each backs onto +y (the wall), facing -y
# (the room's +z) like Interior.glb's pieces, at five times life size. Built in metres, life size, and scaled up at the
# end.
import math, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Bedroom.glb')

# (the ones interior.js recolours for each home are Wood, Duvet, Sheet, Headboard and Shade)
material('Wood', 0xb08a62, 0.6)
material('Duvet', 0x5a7ab0, 0.95)
material('Sheet', 0xf2f0ea, 0.95)
material('Headboard', 0x8a8c8e, 0.95)
material('Shade', 0xece8e0, 0.9)
material('Light', 0xfff0c8, 1.0, glow=0xffd890)
material('Knob', 0xb8a070, 0.35, 0.6)
material('Mirror', 0xd4e2ea, 0.15, 0.3)
material('Ceramic', 0xf6f6f2, 0.2)
material('Chrome', 0xc8ccd0, 0.2, 0.9)
material('Frosted', 0xdce8ec, 0.15, 0.1)
material('Black', 0x1c1c1e, 0.6)

# ------------------------------------------------------------------ the bed
# a double bed, 1.5 by 2.0 inside its frame, its headboard against the wall at y = 0 and its foot out at -y
p = piece('Bed')
BW, BL = 1.5, 2.0
FRAME = 0.05
p.box(BW + FRAME*2, 0.06, 1.1, 'Headboard', 0, -0.03, 0, bevel=0.02, segments=2)      # (the headboard, padded)
p.box(BW + FRAME*2, 0.04, 0.35, 'Wood', 0, -BL - 0.08, 0, bevel=0.01)                 # (the footboard)
for sx in (-1, 1):
    p.box(FRAME, BL, 0.2, 'Wood', sx*(BW + FRAME)/2, -0.06 - BL/2, 0.12, bevel=0.008) # (the side rails)
    p.box(0.06, 0.06, 0.14, 'Wood', sx*(BW/2 - 0.02), -BL - 0.04, 0, bevel=0.005)   # (the feet)
p.box(BW, BL, 0.24, 'Sheet', 0, -0.06 - BL/2, 0.24, bevel=0.04, segments=2)           # the mattress
# the duvet over its lower three quarters, hanging over the sides, turned back at the top
dl = BL*0.74
p.box(BW + 0.08, dl, 0.07, 'Duvet', 0, -0.06 - BL + dl/2 - 0.03, 0.44, bevel=0.03, segments=2)
for sx in (-1, 1): p.box(0.03, dl, 0.22, 'Duvet', sx*(BW/2 + 0.03), -0.06 - BL + dl/2 - 0.03, 0.28, bevel=0.01)
p.box(BW + 0.08, 0.03, 0.22, 'Duvet', 0, -0.06 - BL - 0.035, 0.28, bevel=0.01)
p.box(BW + 0.06, 0.2, 0.08, 'Sheet', 0, -0.06 - BL + dl - 0.1, 0.46, bevel=0.03, segments=2)   # (the turned-back top)
# and two pillows up against the headboard
for sx in (-1, 1): p.box(0.62, 0.38, 0.13, 'Sheet', sx*0.36, -0.3, 0.47, bevel=0.05, segments=2, rot=(-0.25, 0, 0))

# ------------------------------------------------------------------ the bedside table, with a lamp on it
p = piece('Bedside')
TW, TD, TH = 0.46, 0.4, 0.55
p.box(TW, TD, TH - 0.12, 'Wood', 0, -TD/2, 0.12, bevel=0.008)
for sx in (-1, 1):
    for sy in (-1, 1): p.box(0.04, 0.04, 0.12, 'Wood', sx*(TW/2 - 0.03), -TD/2 + sy*(TD/2 - 0.03), 0, bevel=0.004)
p.box(TW - 0.06, 0.015, 0.14, 'Wood', 0, -TD - 0.005, TH - 0.19, bevel=0.004)          # (the drawer's front)
p.box(0.03, 0.02, 0.03, 'Knob', 0, -TD - 0.02, TH - 0.13, bevel=0.006)
lx, ly = -0.06, -TD/2 + 0.04
p.cyl(0.07, 0.02, 'Knob', lx, ly, TH, segments=12)
p.cyl(0.012, 0.22, 'Knob', lx, ly, TH + 0.02, segments=6)
p.ball(0.035, 'Light', (lx, ly, TH + 0.25), detail=1)
p.cyl(0.12, 0.17, 'Shade', lx, ly, TH + 0.19, r2=0.08, segments=14)

# ------------------------------------------------------------------ the wardrobe
p = piece('Wardrobe')
WW, WD, WH = 1.0, 0.6, 2.05
p.box(WW, WD - 0.02, WH - 0.08, 'Wood', 0, -(WD - 0.02)/2, 0.08, bevel=0.008)
p.box(WW - 0.04, WD - 0.06, 0.08, 'Black', 0, -(WD - 0.06)/2, 0, bevel=0.004)          # (the plinth, set back)
p.box(WW + 0.03, WD + 0.01, 0.04, 'Wood', 0, -(WD + 0.01)/2 + 0.005, WH, bevel=0.008) # (the cornice)
for sx in (-1, 1):
    p.box(WW/2 - 0.015, 0.02, WH - 0.14, 'Wood', sx*WW/4, -WD - 0.0, 0.11, bevel=0.006)   # a door
    p.box(WW/2 - 0.12, 0.006, WH - 0.5, 'Wood', sx*WW/4, -WD - 0.012, 0.3, bevel=0.003)   # (its panel, proud of it)
    p.bar((sx*0.05, -WD - 0.035, 1.0), (sx*0.05, -WD - 0.035, 1.25), 0.016, 'Knob')
    for z in (1.02, 1.23): p.bar((sx*0.05, -WD - 0.035, z), (sx*0.05, -WD - 0.01, z), 0.01, 'Knob')

# ------------------------------------------------------------------ the dresser, with a mirror on it
p = piece('Dresser')
DW, DD, DH = 1.0, 0.46, 0.8
p.box(DW, DD, DH - 0.1, 'Wood', 0, -DD/2, 0.1, bevel=0.008)
p.box(DW + 0.03, DD + 0.02, 0.03, 'Wood', 0, -DD/2 - 0.01, DH - 0.03, bevel=0.008)     # (the top, a little over)
for sx in (-1, 1):
    for sy in (-1, 1): p.box(0.05, 0.05, 0.1, 'Wood', sx*(DW/2 - 0.04), -DD/2 + sy*(DD/2 - 0.04), 0, bevel=0.005)
rows = [0.13, 0.33, 0.52, DH - 0.05]
for a, b in zip(rows, rows[1:]):
    for sx in (-1, 1):
        p.box(DW/2 - 0.03, 0.015, b - a - 0.02, 'Wood', sx*DW/4, -DD - 0.005, a + 0.01, bevel=0.004)
        p.box(0.03, 0.02, 0.03, 'Knob', sx*DW/4, -DD - 0.02, (a + b)/2 - 0.015, bevel=0.006)
# the mirror, stood on the top on two uprights, tipped back a touch
my = -0.12
for sx in (-1, 1): p.box(0.03, 0.04, 0.55, 'Wood', sx*0.3, my, DH, bevel=0.004)
p.box(0.56, 0.03, 0.66, 'Wood', 0, my + 0.005, DH + 0.1, bevel=0.01, rot=(0.08, 0, 0))
p.box(0.5, 0.01, 0.6, 'Mirror', 0, my - 0.012, DH + 0.13, bevel=0.002, rot=(0.08, 0, 0))

# ------------------------------------------------------------------ the toilet
p = piece('Toilet')
# the cistern against the wall, the pan out in front of it, the seat and lid (up) on the pan
p.box(0.42, 0.18, 0.4, 'Ceramic', 0, -0.09, 0.42, bevel=0.03, segments=2)
p.box(0.44, 0.2, 0.03, 'Ceramic', 0, -0.1, 0.82, bevel=0.01)
p.box(0.06, 0.02, 0.03, 'Chrome', 0.12, -0.2, 0.74, bevel=0.005)                      # (the flush)
p.hull([(sx*0.1, -0.16 - dy, 0) for sx in (-1, 1) for dy in (0, 0.28)]
       + [(sx*0.17, -0.18 - dy, 0.38) for sx in (-1, 1) for dy in (0, 0.4)]
       + [(sx*0.1, -0.64, 0.38) for sx in (-1, 1)], 'Ceramic')
p.lathe([(0.17, 0), (0.2, 0.02), (0.2, 0.03), (0, 0.03)], 'Ceramic', 0, -0.44, 0.38, segments=16)     # (the seat)
p.box(0.36, 0.03, 0.42, 'Ceramic', 0, -0.2, 0.41, bevel=0.012, rot=(-0.12, 0, 0))                     # (the lid, up)

# ------------------------------------------------------------------ the basin, with a mirror over it
p = piece('Basin')
p.cyl(0.1, 0.7, 'Ceramic', 0, -0.2, 0, r2=0.075, segments=12)                        # (the pedestal)
p.box(0.56, 0.44, 0.14, 'Ceramic', 0, -0.22, 0.72, bevel=0.05, segments=2)
p.box(0.42, 0.28, 0.02, 'Chrome', 0, -0.26, 0.85, bevel=0.01)                         # (the bowl, seen from above)
p.cyl(0.018, 0.12, 'Chrome', 0, -0.06, 0.86, segments=8)                             # (the tap)
p.bar((0, -0.06, 0.97), (0, -0.16, 0.95), 0.022, 'Chrome')
for sx in (-1, 1): p.cyl(0.02, 0.03, 'Chrome', sx*0.1, -0.06, 0.86, segments=8)
p.box(0.54, 0.03, 0.7, 'Chrome', 0, -0.015, 1.15, bevel=0.01)
p.box(0.5, 0.01, 0.66, 'Mirror', 0, -0.035, 1.17, bevel=0.002)

# ------------------------------------------------------------------ the shower
p = piece('Shower')
S = 0.9
p.box(S, S, 0.06, 'Ceramic', 0, -S/2, 0, bevel=0.015)
p.cyl(0.04, 0.005, 'Chrome', 0, -S/2, 0.06, segments=10)                              # (the drain)
# glass along its front and one side (the other against a wall), in thin frames
p.box(S, 0.012, 1.9, 'Frosted', 0, -S + 0.01, 0.06, bevel=0)
p.box(0.012, S, 1.9, 'Frosted', S/2 - 0.01, -S/2, 0.06, bevel=0)
for a, b in [((-S/2, -S + 0.01), (S/2, -S + 0.01)), ((S/2 - 0.01, 0), (S/2 - 0.01, -S + 0.01))]:
    p.bar((*a, 1.96), (*b, 1.96), 0.022, 'Chrome')
p.bar((S/2 - 0.01, -S + 0.01, 0.06), (S/2 - 0.01, -S + 0.01, 1.96), 0.024, 'Chrome')
# the riser up the back wall, the head at its top, the mixer below
p.bar((0, -0.03, 1.0), (0, -0.03, 2.05), 0.022, 'Chrome')
p.bar((0, -0.03, 2.05), (0, -0.2, 2.05), 0.022, 'Chrome')
p.cyl(0.09, 0.02, 'Chrome', 0, -0.22, 2.0, segments=14)
p.box(0.14, 0.05, 0.08, 'Chrome', 0, -0.025, 1.05, bevel=0.01)

# ------------------------------------------------------------------ out
export(OUT)
