# Builds assets/models/OfficeWall.glb: what hangs on any office's walls, corporate or startup (furnishOffice in
# buildings/interior.js adds these to either set). Same low-poly, flat-coloured style.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/office-wall-models.py
#
# Whiteboard: an aluminium-framed board scrawled with boxes, arrows and a graph, markers and a wiper on its tray.
# Clock: a round wall clock, ten to two. Noticeboard: a framed corkboard of pinned-up notices, a flyer and a rota.
# Faces -y, its back on y 0, standing on its own bottom edge.
import math, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from set_pieces import material, piece, export

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'OfficeWall.glb')

material('Board', 0xf8f8f6, 0.25)
material('Alu', 0xb8bcc0, 0.35, 0.6)
material('Grey', 0x6a6d72, 0.6)
material('Felt', 0x2a2c30, 0.9)
material('Black', 0x1c1c1e, 0.6)
material('Blue', 0x2a5ac8, 0.5)
material('Red', 0xd8352c, 0.5)
material('Green', 0x2a9a4a, 0.5)
material('Face', 0xf6f4ee, 0.4)
material('Cork', 0xb88a5a, 0.95)
material('Wood', 0x8a6a4a, 0.7)
material('Paper', 0xf6f4ee, 0.9)
material('Yellow', 0xf6e36a, 0.8)
material('Pink', 0xf6a6c0, 0.8)
material('Sky', 0x8cc8f0, 0.8)
material('Ink', 0x8a8a8a, 0.8)

# ------------------------------------------------------------------ the whiteboard
W, H, T = 1.5, 0.95, 0.02
p = piece('Whiteboard')
p.box(W, T, H, 'Board', 0, -T/2, 0, bevel=0.002)
for z in (0, H - 0.02):                                             # the frame
    p.box(W + 0.02, T + 0.012, 0.025, 'Alu', 0, -T/2 - 0.004, z - 0.002, bevel=0.004)
for x in (-W/2, W/2):
    p.box(0.025, T + 0.012, H, 'Alu', x, -T/2 - 0.004, 0, bevel=0.004)
p.box(W*0.6, 0.06, 0.02, 'Alu', 0, -0.045, -0.01, bevel=0.004)     # the tray
p.box(W*0.6, 0.012, 0.03, 'Alu', 0, -0.075, -0.01, bevel=0.003)
for k, c in enumerate(('Black', 'Blue', 'Red', 'Green')):           # markers in it
    p.cyl(0.009, 0.12, c, -0.3 + k*0.05, -0.045, 0.019, segments=6, rot=(0, math.pi/2, 0))
p.box(0.12, 0.045, 0.03, 'Felt', 0.25, -0.045, 0.01, bevel=0.006)  # the wiper
p.box(0.12, 0.045, 0.015, 'Grey', 0.25, -0.045, 0.04, bevel=0.004)

# scrawls, just proud of the board
Y = -T - 0.001
def line(x0, z0, x1, z1, c, w=0.008):
    dx, dz = x1 - x0, z1 - z0
    p.box(math.hypot(dx, dz), 0.002, w, c, (x0 + x1)/2, Y, (z0 + z1)/2 - w/2, bevel=0, rot=(0, -math.atan2(dz, dx), 0))
def rect(x0, z0, x1, z1, c):
    line(x0, z0, x1, z0, c); line(x0, z1, x1, z1, c); line(x0, z0, x0, z1, c); line(x1, z0, x1, z1, c)
def arrow(x0, z0, x1, z1, c):
    line(x0, z0, x1, z1, c)
    a = math.atan2(z1 - z0, x1 - x0)
    for s in (-1, 1):
        b = a + math.pi + s*0.5
        line(x1, z1, x1 + math.cos(b)*0.04, z1 + math.sin(b)*0.04, c)
# a flow of boxes on the left
rect(-0.66, 0.66, -0.46, 0.8, 'Blue'); rect(-0.36, 0.66, -0.16, 0.8, 'Blue'); rect(-0.36, 0.38, -0.16, 0.52, 'Red')
arrow(-0.46, 0.73, -0.36, 0.73, 'Black'); arrow(-0.26, 0.66, -0.26, 0.52, 'Black')
for k in range(3):                                                  # words in them
    line(-0.63, 0.76 - k*0.03, -0.49 - k*0.02, 0.76 - k*0.03, 'Blue', 0.004)
    line(-0.33, 0.76 - k*0.03, -0.2 - k*0.02, 0.76 - k*0.03, 'Blue', 0.004)
    line(-0.33, 0.48 - k*0.03, -0.21 - k*0.02, 0.48 - k*0.03, 'Red', 0.004)
# a graph going up on the right
line(0.1, 0.35, 0.1, 0.8, 'Black'); line(0.1, 0.35, 0.65, 0.35, 'Black')
pts = [(0.12, 0.4), (0.24, 0.45), (0.34, 0.42), (0.46, 0.56), (0.56, 0.62), (0.64, 0.78)]
for a, b in zip(pts, pts[1:]): line(*a, *b, 'Green')
arrow(0.56, 0.62, 0.64, 0.78, 'Green')
# a list, bottom left
for k in range(4):
    line(-0.66, 0.26 - k*0.05, -0.64, 0.26 - k*0.05, 'Black', 0.012)
    line(-0.6, 0.26 - k*0.05, -0.3 - (k % 3)*0.06, 0.26 - k*0.05, 'Black', 0.005)
line(-0.62, 0.11, -0.28, 0.16, 'Red')                               # one crossed out

# ------------------------------------------------------------------ the clock
R = 0.16
p = piece('Clock')
p.cyl(R, 0.04, 'Black', 0, 0, R, segments=24, rot=(math.pi/2, 0, 0))            # the rim (its back on y 0)
p.cyl(R - 0.015, 0.002, 'Face', 0, -0.04, R, segments=24, rot=(math.pi/2, 0, 0))
for k in range(12):                                                               # the hours
    a = k*math.pi/6
    long = k % 3 == 0
    r = R - 0.035
    h = 0.03 if long else 0.018
    p.box(0.008 if long else 0.005, 0.002, h, 'Black', math.sin(a)*r, -0.043, R + math.cos(a)*r - h/2, bevel=0, rot=(0, a, 0))
def hand(a, length, w):
    p.box(w, 0.003, length, 'Black', math.sin(a)*length/2, -0.046, R + math.cos(a)*length/2 - length/2, bevel=0, rot=(0, a, 0))
hand(math.pi/3 - 0.08, 0.08, 0.012)                                               # ten to two
hand(-math.pi/3, 0.11, 0.008)
p.box(0.003, 0.003, 0.14, 'Red', 0, -0.049, R - 0.07, bevel=0, rot=(0, 2.5, 0))     # the second hand, through the middle
p.cyl(0.01, 0.01, 'Red', 0, -0.045, R, segments=8, rot=(math.pi/2, 0, 0))

# ------------------------------------------------------------------ the noticeboard
W, H = 0.9, 0.6
p = piece('Noticeboard')
p.box(W, 0.02, H, 'Cork', 0, -0.01, 0, bevel=0.002)
for z in (0, H - 0.03):
    p.box(W + 0.03, 0.03, 0.03, 'Wood', 0, -0.015, z - 0.0, bevel=0.004)
for x in (-W/2, W/2):
    p.box(0.03, 0.03, H, 'Wood', x, -0.015, 0, bevel=0.004)
# (x, z of its middle, w, h, colour, tilt, lines on it)
NOTES = ((-0.28, 0.38, 0.21, 0.297, 'Paper', 0.04, 7), (-0.02, 0.4, 0.15, 0.2, 'Pink', -0.08, 3),
         (0.24, 0.36, 0.25, 0.18, 'Paper', 0.02, 4), (0.05, 0.16, 0.2, 0.14, 'Sky', 0.1, 2),
         (0.3, 0.13, 0.12, 0.12, 'Yellow', -0.12, 2), (-0.25, 0.1, 0.18, 0.12, 'Yellow', 0.06, 2))
for x, z, w, h, c, tilt, lines in NOTES:
    p.box(w, 0.003, h, c, x, -0.021, z - h/2, bevel=0, rot=(0, tilt, 0))
    for k in range(lines):
        lw = w*(0.75 - 0.2*((k*7) % 3)/2)
        lz = h/2 - 0.03 - k*(h - 0.05)/max(lines, 1)
        p.box(lw, 0.002, 0.006, 'Ink', x + math.sin(tilt)*lz - (w - lw)/2*math.cos(tilt)*0.6, -0.024,
              z + math.cos(tilt)*lz - 0.003, bevel=0, rot=(0, tilt, 0))
    p.ball(0.01, any_pin := ('Red', 'Blue', 'Green', 'Yellow')[int(abs(x)*10) % 4], (x + math.sin(tilt)*(h/2 - 0.015), -0.026, z + h/2 - 0.015))

export(OUT)
