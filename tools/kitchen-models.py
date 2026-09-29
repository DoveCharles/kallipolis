# Builds assets/models/Kitchen.glb: a home's kitchen (see "the kitchen" in src/buildings/interior.js), in the same
# low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/kitchen-models.py
#
# One piece, Kitchen: an L of fitted units to stand in a corner. Its long leg runs along the back wall (+y here, the
# room's -z once exported) with the fridge at its far (-x) end, then a unit of drawers with the microwave on it, the oven
# with the hob over it and the extractor over that, tiles up the wall and wall cupboards either side of the hood; its
# short leg comes out along the side wall (+x) — low all along, as it's meant to go under a window — with the sink and
# its tap, the toaster at its end and the kettle in the corner. Facing -y (the room's +z) like Interior.glb's pieces, at
# five times life size. Built in metres, life size, and scaled up at the end.
import math, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Kitchen.glb')

# (the ones interior.js recolours for each home are Cabinet, Worktop, Tiles, Appliance, Kettle and Toaster)
material('Cabinet', 0xece8de, 0.5)
material('Worktop', 0x3a3632, 0.4)
material('Tiles', 0xf2f0ea, 0.3)
material('Grout', 0xb8b4aa, 0.9)
material('Plinth', 0x2a2826, 0.8)
material('Handle', 0xb8bcc0, 0.3, 0.8)
material('Appliance', 0xf2f2f0, 0.35)
material('Steel', 0xa8acb0, 0.3, 0.7)
material('Black', 0x141416, 0.2)
material('Ring', 0x3a3a3e, 0.6)
material('OvenGlass', 0x2a2e34, 0.1)
material('Sink', 0xc8ccd0, 0.25, 0.8)
material('Basin', 0x8a8e94, 0.3, 0.8)
material('Kettle', 0xd83a2a, 0.3)
material('Toaster', 0xe8e4dc, 0.35)
material('Rubber', 0x202022, 0.9)
material('GlowDisplay', 0x000000, 1.0, glow=0x3ad86a)

# the L: its back wall at y = 0, its side wall at x = 0
DEPTH = 0.6                  # the units, front to back (doors on)
TOP = 0.86                   # the worktop's top: just under a window's sill
SLAB = 0.035                 # the worktop's thickness
PLINTH = 0.1
LONG, SHORT = 2.0, 2.0       # the units along the back wall (from the side wall) and along the side (from the back)
FRIDGE_W, FRIDGE_D, FRIDGE_H = 0.68, 0.66, 1.85
DOOR = 0.018                 # a door's thickness
FRONT = -(DEPTH - DOOR)      # the carcasses' fronts (the long leg's, along y; the short leg's is at x = FRONT)
LOW, HIGH = PLINTH + 0.02, TOP - SLAB - 0.015   # a base unit's door, bottom to top
WALL_LOW, WALL_HIGH, WALL_DEPTH = 1.42, 2.12, 0.33

p = piece('Kitchen')

# ------------------------------------------------------------------ the carcasses, plinths and worktops
p.box(LONG, DEPTH - 0.06, PLINTH, 'Plinth', -LONG/2, -(DEPTH - 0.06)/2, bevel=0.002)
p.box(DEPTH - 0.06, SHORT - DEPTH, PLINTH, 'Plinth', -(DEPTH - 0.06)/2, -(SHORT + DEPTH)/2, bevel=0.002)
body = TOP - SLAB - PLINTH
p.box(LONG, -FRONT, body, 'Cabinet', -LONG/2, FRONT/2, PLINTH, bevel=0.002)
p.box(-FRONT, SHORT + FRONT, body, 'Cabinet', FRONT/2, (FRONT - SHORT)/2, PLINTH, bevel=0.002)
over = 0.02
p.box(LONG, DEPTH + over, SLAB, 'Worktop', -LONG/2, -(DEPTH + over)/2, TOP - SLAB, bevel=0.004)
p.box(DEPTH + over, SHORT - DEPTH - over, SLAB, 'Worktop', -(DEPTH + over)/2, -(SHORT + DEPTH + over)/2, TOP - SLAB, bevel=0.004)

# a door (or drawer front) on the long leg, from x0 to x1 and z0 to z1, its handle at `handle`: 'top' (a bar along its
# top), 'left' or 'right' (a bar up that side, near the top), or 'bottom' (a wall cupboard's, along its bottom)
def door_a(x0, x1, z0, z1, handle, y=FRONT):
    g = 0.004
    p.box(x1 - x0 - g, DOOR, z1 - z0 - g, 'Cabinet', (x0 + x1)/2, y - DOOR/2, z0 + g/2, bevel=0.003)
    hy = y - DOOR - 0.012
    if handle in ('top', 'bottom'):
        z = z1 - 0.05 if handle == 'top' else z0 + 0.04
        span = min(0.3, (x1 - x0)*0.6)
        p.bar(((x0 + x1)/2 - span/2, hy, z), ((x0 + x1)/2 + span/2, hy, z), 0.012, 'Handle')
        for sx in (-1, 1): p.bar(((x0 + x1)/2 + sx*span/2*0.9, hy, z), ((x0 + x1)/2 + sx*span/2*0.9, y - DOOR, z), 0.008, 'Handle')
    else:
        x = x0 + 0.04 if handle == 'left' else x1 - 0.04
        p.bar((x, hy, z1 - 0.26), (x, hy, z1 - 0.06), 0.012, 'Handle')
        for z in (z1 - 0.24, z1 - 0.08): p.bar((x, hy, z), (x, y - DOOR, z), 0.008, 'Handle')

# and one on the short leg, from y0 to y1 (y0 the nearer the back), facing -x
def door_b(y0, y1, z0, z1, handle):
    g = 0.004
    p.box(DOOR, y0 - y1 - g, z1 - z0 - g, 'Cabinet', FRONT - DOOR/2, (y0 + y1)/2, z0 + g/2, bevel=0.003)
    hx = FRONT - DOOR - 0.012
    y = y1 + 0.04 if handle == 'far' else y0 - 0.04
    p.bar((hx, y, z1 - 0.26), (hx, y, z1 - 0.06), 0.012, 'Handle')
    for z in (z1 - 0.24, z1 - 0.08): p.bar((hx, y, z), (FRONT - DOOR, y, z), 0.008, 'Handle')

# ------------------------------------------------------------------ the long leg's units: drawers, the oven, a narrow door
DRAWERS = (-LONG, -1.45)
OVEN = (-1.45, -0.85)
rows = [LOW, LOW + 0.26, LOW + 0.5, HIGH]
for z0, z1 in zip(rows, rows[1:]): door_a(*DRAWERS, z0, z1, 'top')
door_a(OVEN[1], -DEPTH - 0.002, LOW, HIGH, 'left')

# the oven: a steel front with its glass door, handle and a strip of knobs along the top
ox = (OVEN[0] + OVEN[1])/2
p.box(OVEN[1] - OVEN[0] - 0.006, DOOR, HIGH - LOW, 'Steel', ox, FRONT - DOOR/2, LOW, bevel=0.002)
p.box(0.54, 0.006, 0.44, 'Black', ox, FRONT - DOOR - 0.003, LOW + 0.04, bevel=0.001)
p.box(0.4, 0.004, 0.24, 'OvenGlass', ox, FRONT - DOOR - 0.007, LOW + 0.12, bevel=0)
p.bar((ox - 0.22, FRONT - DOOR - 0.035, LOW + 0.43), (ox + 0.22, FRONT - DOOR - 0.035, LOW + 0.43), 0.016, 'Handle')
for sx in (-1, 1): p.bar((ox + sx*0.2, FRONT - DOOR - 0.035, LOW + 0.43), (ox + sx*0.2, FRONT - DOOR, LOW + 0.43), 0.01, 'Handle')
p.box(0.54, 0.004, 0.06, 'Black', ox, FRONT - DOOR - 0.002, HIGH - 0.075, bevel=0)
for k in range(5):
    kx = ox - 0.2 + k*0.1
    if k == 2:
        p.box(0.07, 0.004, 0.03, 'OvenGlass', kx, FRONT - DOOR - 0.005, HIGH - 0.06, bevel=0)   # (the clock)
    else:
        p.cyl(0.017, 0.02, 'Steel', kx, FRONT - DOOR - 0.004, HIGH - 0.045, segments=10, rot=(math.pi/2, 0, 0))

# the hob, set into the worktop over the oven: black glass with four rings
hy = -0.3
p.box(0.58, 0.5, 0.006, 'Black', ox, hy, TOP, bevel=0.002)
for dx, dy, r in ((-0.14, 0.11, 0.09), (0.14, 0.11, 0.07), (-0.14, -0.12, 0.07), (0.14, -0.12, 0.09)):
    p.cyl(r, 0.002, 'Ring', ox + dx, hy + dy, TOP + 0.006, segments=20)
    p.cyl(r*0.55, 0.0025, 'Black', ox + dx, hy + dy, TOP + 0.006, segments=16)

# ------------------------------------------------------------------ the short leg's units, the sink's under double doors
SINK = (-1.0, -1.6)
door_b(-DEPTH - 0.002, SINK[0], LOW, HIGH, 'far')
door_b(SINK[0], (SINK[0] + SINK[1])/2, LOW, HIGH, 'far')
door_b((SINK[0] + SINK[1])/2, SINK[1], LOW, HIGH, 'near')
door_b(SINK[1], -SHORT, LOW, HIGH, 'near')

# the sink: a steel inset with a bowl and a draining board, and a swan-neck tap by the wall
sy = -1.2
sx = -0.3
p.box(0.48, 0.76, 0.004, 'Sink', sx, sy, TOP, bevel=0.002)
p.box(0.38, 0.38, 0.003, 'Basin', sx - 0.01, sy - 0.15, TOP + 0.002, bevel=0.001)
p.cyl(0.02, 0.003, 'Black', sx - 0.01, sy - 0.15, TOP + 0.004, segments=10)     # (the plughole)
for k in range(5):
    p.box(0.3, 0.012, 0.002, 'Basin', sx - 0.01, sy + 0.09 + k*0.045, TOP + 0.003, bevel=0)   # (the draining board's grooves)
tx, ty = -0.06, sy - 0.15
p.cyl(0.025, 0.03, 'Steel', tx, ty, TOP, segments=12)
p.bar((tx, ty, TOP + 0.02), (tx, ty, TOP + 0.28), 0.022, 'Steel', bevel=0.005)
neck = [(tx - 0.09*(1 - math.cos(a)), ty, TOP + 0.28 + 0.07*math.sin(a)) for a in [k*math.pi/6 for k in range(7)]]
for a, b in zip(neck, neck[1:]): p.bar(a, b, 0.02, 'Steel', bevel=0.004)
p.cyl(0.013, 0.03, 'Steel', neck[-1][0], ty, neck[-1][2] - 0.03, segments=8)
p.bar((tx + 0.005, ty, TOP + 0.2), (tx + 0.005, ty + 0.07, TOP + 0.24), 0.012, 'Steel')              # (its lever)

# ------------------------------------------------------------------ the fridge freezer, at the long leg's far end
fx = -LONG - 0.02 - FRIDGE_W/2
p.box(FRIDGE_W, FRIDGE_D - 0.03, FRIDGE_H, 'Appliance', fx, -(FRIDGE_D - 0.03)/2, 0, bevel=0.02, segments=2)
split = 0.72                                             # (the freezer below, the fridge above)
for z0, z1 in ((0.03, split - 0.006), (split + 0.006, FRIDGE_H - 0.02)):
    p.box(FRIDGE_W - 0.01, 0.03, z1 - z0, 'Appliance', fx, -FRIDGE_D + 0.015, z0, bevel=0.012, segments=2)
p.box(FRIDGE_W - 0.02, 0.02, 0.012, 'Rubber', fx, -FRIDGE_D + 0.02, split - 0.006, bevel=0)
hx = fx + FRIDGE_W/2 - 0.06
for z0, z1 in ((split - 0.3, split - 0.06), (split + 0.08, split + 0.62)):
    p.bar((hx, -FRIDGE_D - 0.03, z0), (hx, -FRIDGE_D - 0.03, z1), 0.02, 'Handle', bevel=0.004)
    for z in (z0 + 0.02, z1 - 0.02): p.bar((hx, -FRIDGE_D - 0.03, z), (hx, -FRIDGE_D, z), 0.012, 'Handle')

# ------------------------------------------------------------------ up the wall: tiles, wall cupboards, the extractor
tile_h = 0.075
p.box(LONG, 0.01, WALL_LOW - TOP, 'Tiles', -LONG/2, -0.005, TOP, bevel=0)
for k in range(1, round((WALL_LOW - TOP)/tile_h)):
    p.box(LONG - 0.004, 0.004, 0.005, 'Grout', -LONG/2, -0.011, TOP + k*tile_h, bevel=0)
# (and a low upstand along the short leg, where there may be a window)
p.box(0.012, SHORT - 0.01, 0.08, 'Worktop', -0.006, -(SHORT + 0.01)/2, TOP, bevel=0.002)
# the cupboards either side of the hood
for x0, x1, doors in ((DRAWERS[0], OVEN[0], 1), (OVEN[1], 0, 2)):
    p.box(x1 - x0, WALL_DEPTH - DOOR, WALL_HIGH - WALL_LOW, 'Cabinet', (x0 + x1)/2, -(WALL_DEPTH - DOOR)/2, WALL_LOW, bevel=0.002)
    step = (x1 - x0)/doors
    for k in range(doors): door_a(x0 + k*step, x0 + (k + 1)*step, WALL_LOW + 0.005, WALL_HIGH, 'bottom', y=-(WALL_DEPTH - DOOR))
# the hood: a steel canopy over the hob and its chimney up to the cupboards' tops
hood_w = OVEN[1] - OVEN[0] - 0.02
p.hull([(ox + sx*hood_w/2, y, z) for sx in (-1, 1) for y, z in ((0, 1.6), (-0.5, 1.6), (-0.5, 1.64), (0, 1.64))], 'Steel')
p.hull([(ox + sx*hood_w/2, y, 1.64) for sx in (-1, 1) for y in (0, -0.5)] + [(ox + sx*0.14, y, 1.8) for sx in (-1, 1) for y in (0, -0.26)], 'Steel')
p.box(0.28, 0.26, WALL_HIGH - 1.8, 'Steel', ox, -0.13, 1.8, bevel=0.003)
p.box(hood_w - 0.08, 0.4, 0.004, 'Black', ox, -0.26, 1.598, bevel=0)                # (its filter, underneath)

# ------------------------------------------------------------------ on the worktops: the microwave, the kettle, the toaster
mx, my = (DRAWERS[0] + DRAWERS[1])/2 - 0.02, -0.3
mw, md, mh = 0.46, 0.36, 0.27
p.box(mw, md, mh, 'Appliance', mx, my, TOP + 0.01, bevel=0.012, segments=2)
for sx in (-1, 1):
    for sy in (-1, 1): p.cyl(0.012, 0.01, 'Rubber', mx + sx*(mw/2 - 0.04), my + sy*(md/2 - 0.04), TOP, segments=6)
p.box(0.31, 0.006, 0.2, 'Black', mx - 0.06, my - md/2 - 0.002, TOP + 0.045, bevel=0.002)
p.box(0.25, 0.004, 0.15, 'OvenGlass', mx - 0.06, my - md/2 - 0.005, TOP + 0.07, bevel=0)
p.box(0.09, 0.006, 0.22, 'Black', mx + 0.16, my - md/2 - 0.002, TOP + 0.035, bevel=0.002)
p.box(0.06, 0.004, 0.025, 'GlowDisplay', mx + 0.16, my - md/2 - 0.005, TOP + 0.21, bevel=0)  # (its clock, lit)
for k in range(3):
    p.box(0.05, 0.004, 0.018, 'Steel', mx + 0.16, my - md/2 - 0.005, TOP + 0.08 + k*0.035, bevel=0)
p.bar((mx + 0.1, my - md/2 - 0.02, TOP + 0.06), (mx + 0.1, my - md/2 - 0.02, TOP + 0.23), 0.014, 'Handle')

# the kettle, in the corner: a jug on its base, a handle at the back, a spout at the front
kx, ky = -0.3, -0.26
p.cyl(0.09, 0.018, 'Black', kx, ky, TOP, segments=16)
p.lathe([(0.082, 0), (0.085, 0.03), (0.08, 0.15), (0.066, 0.2), (0.05, 0.215), (0, 0.215)], 'Kettle', kx, ky, TOP + 0.018, segments=16)
p.cyl(0.018, 0.02, 'Black', kx, ky, TOP + 0.23, segments=8)                          # (the lid's knob)
hand = [(kx + 0.07, ky, TOP + 0.06), (kx + 0.13, ky, TOP + 0.09), (kx + 0.13, ky, TOP + 0.17), (kx + 0.06, ky, TOP + 0.2)]
for a, b in zip(hand, hand[1:]): p.bar(a, b, 0.022, 'Black', bevel=0.005)
p.hull([(kx - 0.07, ky + dy, z) for dy in (-0.02, 0.02) for z in (TOP + 0.13, TOP + 0.2)]
       + [(kx - 0.12, ky + dy, TOP + 0.21) for dy in (-0.012, 0.012)], 'Kettle')

# the toaster, at the short leg's end: two slots along it, its lever at the front
tx, ty = -0.3, -SHORT + 0.2
tw, td, th = 0.17, 0.28, 0.19
p.box(tw, td, th, 'Toaster', tx, ty, TOP, bevel=0.03, segments=3)
for dx in (-0.035, 0.035): p.box(0.028, 0.2, 0.004, 'Black', tx + dx, ty, TOP + th - 0.002, bevel=0)
p.box(0.02, 0.03, 0.08, 'Black', tx - tw/2 - 0.005, ty + 0.05, TOP + 0.03, bevel=0.002)
p.box(0.03, 0.022, 0.014, 'Black', tx - tw/2 - 0.018, ty + 0.05, TOP + 0.12, bevel=0.003)   # (the lever)
p.cyl(0.012, 0.012, 'Black', tx - tw/2 - 0.006, ty - 0.06, TOP + 0.07, segments=8, rot=(0, -math.pi/2, 0))  # (the dial)

# ------------------------------------------------------------------ out
export(OUT)
