# Builds assets/models/Office.glb: the pieces an office is furnished from (see "an office's furniture" in
# src/buildings/interior.js), in the same low-poly, flat-coloured, softened style as Interior.glb's.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/office-models.py
#
# Like Interior.glb, it's one top-level mesh per piece, at five times life size, each facing -y (the room's +z, once
# exported). Everything's built here in metres, life size, and scaled up at the end. The desk's layout (where its top,
# panels and monitor are) is relied on by interior.js's DESK: change one, change the other.
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix, Euler

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Office.glb')
SCALE = 5
random.seed(7)

bpy.ops.wm.read_factory_settings(use_empty=True)

def linear(hex_colour):
    c = [((hex_colour >> s) & 255)/255 for s in (16, 8, 0)]
    return [x/12.92 if x <= 0.04045 else ((x + 0.055)/1.055)**2.4 for x in c]

MATERIALS = {}
def material(name, colour, rough=0.8, metal=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*linear(colour), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    MATERIALS[name] = m

# (the ones interior.js recolours for each office are Fabric, Upholstery, Laminate, Steel and Pot; Sticky and Mug for
# each one of them)
material('Plastic', 0xe4e4df, 0.6)
material('Dark', 0x2a2c30, 0.5)
material('Trim', 0x6a6d72, 0.5)
material('Steel', 0x9a9ea3, 0.45, 0.3)
material('Frame', 0x55585d, 0.5, 0.4)
material('Fabric', 0x6d7a8c, 1.0)
material('Upholstery', 0x2f3f5a, 0.95)
material('Laminate', 0xe2ddd2, 0.55)
material('Screen', 0xcccccc, 0.5)
material('Keys', 0x8a8d92, 0.6)
material('Water', 0x8cc4ee, 0.1, 0.0, 0.6)
material('Hot', 0xc8352c, 0.5)
material('Cold', 0x2c6ec8, 0.5)
material('Paper', 0xf6f4ee, 0.9)
material('Leaf', 0x3f8a3a, 0.55)
material('Leaf2', 0x2e6b30, 0.55)
material('Bark', 0x6b4a2e, 1.0)
material('Dirt', 0x3a2414, 1.0)
material('Pot', 0xece8e0, 0.7)
material('Terracotta', 0xb8603e, 0.95)
material('Sticky', 0xf6e36a, 0.8)
material('Mug', 0xd84a3a, 0.4)
material('Coffee', 0x3a2212, 0.3)
material('Photo', 0x6aa2c0, 0.6)
material('Photo2', 0x8ab070, 0.6)
material('Ink', 0x8a8a8a, 0.8)
material('Red', 0xc8352c, 0.7)
material('Pen', 0x2c4ec8, 0.5)
material('Duck', 0xf2c81e, 0.4)
material('Beak', 0xe8781e, 0.5)
material('Cactus', 0x4a8a4a, 0.8)

# ------------------------------------------------------------------ building blocks
# Each piece is put together from parts (bmesh solids, each with a material), then made one mesh.
class Piece:
    def __init__(self, name):
        self.name, self.parts = name, []

    def add(self, bm, mat, at=(0, 0, 0), rot=(0, 0, 0)):
        m = Euler(rot).to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector(at), verts=bm.verts)
        self.parts.append((bm, mat))

    # a box w (x) by d (y) by h (z), standing on z = z0 at (x, y), its edges softened by `bevel`
    def box(self, w, d, h, mat, x=0, y=0, z0=0, bevel=0.006, rot=(0, 0, 0), segments=1):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=(w, d, h), verts=bm.verts)
        bevel = min(bevel, w*0.3, d*0.3, h*0.3)
        if bevel > 0.0005:
            bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.verts[:], offset=bevel, segments=segments, affect='EDGES', profile=0.5)
        if rot != (0, 0, 0):
            # (turned about its own middle)
            bmesh.ops.transform(bm, matrix=Euler(rot).to_matrix().to_4x4(), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector((x, y, z0 + h/2)), verts=bm.verts)
        self.parts.append((bm, mat))

    # a cylinder of radius r (or r to r2 at the top) and height h, standing on z = z0 at (x, y), or turned by rot about
    # its base
    def cyl(self, r, h, mat, x=0, y=0, z0=0, r2=None, segments=12, rot=(0, 0, 0)):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r, radius2=r if r2 is None else r2, depth=h)
        bmesh.ops.translate(bm, vec=Vector((0, 0, h/2)), verts=bm.verts)
        self.add(bm, mat, (x, y, z0), rot)

    def ball(self, r, mat, at, scale=(1, 1, 1), rot=(0, 0, 0), detail=1):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=r)
        bmesh.ops.scale(bm, vec=scale, verts=bm.verts)
        self.add(bm, mat, at, rot)

    # the convex hull of some points
    def hull(self, points, mat, at=(0, 0, 0), rot=(0, 0, 0)):
        bm = bmesh.new()
        for p in points: bm.verts.new(p)
        bmesh.ops.convex_hull(bm, input=bm.verts[:])
        self.add(bm, mat, at, rot)

    def build(self, x):
        mats, meshes = [], []
        mesh = bpy.data.meshes.new(self.name)
        whole = bmesh.new()
        for bm, mat in self.parts:
            if mat not in mats: mats.append(mat)
            index = mats.index(mat)
            for f in bm.faces: f.material_index = index
            temp = bpy.data.meshes.new('part')
            bm.to_mesh(temp)
            whole.from_mesh(temp)
            bpy.data.meshes.remove(temp)
            bm.free()
        bmesh.ops.remove_doubles(whole, verts=whole.verts, dist=0.00001)
        bmesh.ops.scale(whole, vec=(SCALE, SCALE, SCALE), verts=whole.verts)
        whole.to_mesh(mesh)
        whole.free()
        for mat in mats: mesh.materials.append(MATERIALS[mat])
        for p in mesh.polygons: p.use_smooth = False
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = (x*SCALE, 0, 0)

pieces = []
def piece(name):
    p = Piece(name)
    pieces.append(p)
    return p

# ------------------------------------------------------------------ the water cooler
p = piece('WaterCooler')
p.box(0.32, 0.32, 0.95, 'Plastic', bevel=0.02)
p.box(0.24, 0.02, 0.22, 'Trim', 0, -0.155, 0.62, bevel=0.01)      # the recess the taps are in
p.box(0.2, 0.08, 0.025, 'Dark', 0, -0.18, 0.62, bevel=0.008)       # the drip tray
for x, tap in ((-0.055, 'Hot'), (0.055, 'Cold')):
    p.box(0.035, 0.05, 0.04, tap, x, -0.18, 0.76, bevel=0.008)
p.box(0.2, 0.01, 0.08, 'Trim', 0, -0.163, 0.25, bevel=0.004)       # a vent low down
p.cyl(0.11, 0.03, 'Trim', z0=0.95, segments=16)                    # the collar the bottle stands in
p.cyl(0.04, 0.06, 'Water', z0=0.95, segments=10)                   # its neck
p.cyl(0.05, 0.06, 'Water', z0=1.0, r2=0.13, segments=16)           # its shoulder
p.cyl(0.13, 0.3, 'Water', z0=1.06, segments=16)
p.cyl(0.133, 0.02, 'Water', z0=1.14, segments=16)                  # ribs round it
p.cyl(0.133, 0.02, 'Water', z0=1.26, segments=16)
p.cyl(0.13, 0.03, 'Water', z0=1.36, r2=0.1, segments=16)
p.cyl(0.035, 0.24, 'Plastic', 0.195, 0.05, 0.45, segments=10)      # cups, on its side
p.cyl(0.036, 0.02, 'Trim', 0.195, 0.05, 0.43, segments=10)

# ------------------------------------------------------------------ the printer (a floor-standing copier)
p = piece('Printer')
p.box(0.6, 0.56, 0.52, 'Plastic', z0=0.04, bevel=0.012)
for i in range(3):                                                  # paper drawers
    z = 0.07 + i*0.155
    p.box(0.56, 0.015, 0.14, 'Plastic', 0, -0.285, z, bevel=0.006)
    p.box(0.18, 0.012, 0.022, 'Dark', 0, -0.295, z + 0.1, bevel=0.004)
for x in (-0.25, 0.25):
    for y in (-0.22, 0.22):
        p.box(0.05, 0.05, 0.04, 'Dark', x, y, 0, bevel=0.01)
p.box(0.62, 0.58, 0.3, 'Plastic', z0=0.56, bevel=0.012)            # the printer itself
p.box(0.34, 0.02, 0.08, 'Dark', -0.08, -0.29, 0.72, bevel=0.006)   # its output slot
p.box(0.3, 0.24, 0.015, 'Paper', -0.1, -0.08, 0.86, bevel=0.002)   # and what it's printed, on top
p.box(0.29, 0.23, 0.012, 'Paper', -0.11, -0.07, 0.875, bevel=0.002, rot=(0, 0, 0.06))
p.box(0.14, 0.5, 0.12, 'Plastic', 0.24, 0.02, 0.86, bevel=0.01)    # the column the scanner's on
p.box(0.62, 0.52, 0.1, 'Plastic', 0, 0.02, 0.98, bevel=0.012)      # the scanner
p.box(0.6, 0.5, 0.02, 'Trim', 0, 0.02, 1.08, bevel=0.006)          # its lid
p.box(0.22, 0.12, 0.04, 'Dark', 0.17, -0.3, 1.0, bevel=0.008, rot=(0.35, 0, 0))   # the control panel
p.box(0.1, 0.01, 0.05, 'Screen', 0.14, -0.365, 1.02, bevel=0.002, rot=(0.35, 0, 0))

# ------------------------------------------------------------------ filing cabinets: four drawers and two
def cabinet(name, drawers):
    p = piece(name)
    h = 0.04 + drawers*0.32
    p.box(0.47, 0.62, h, 'Steel', bevel=0.01)
    for i in range(drawers):
        z = 0.05 + i*0.32
        p.box(0.43, 0.015, 0.3, 'Steel', 0, -0.315, z, bevel=0.006)
        p.box(0.16, 0.03, 0.025, 'Trim', 0, -0.33, z + 0.2, bevel=0.006)   # its handle
        p.box(0.08, 0.008, 0.04, 'Paper', 0, -0.325, z + 0.24, bevel=0.002)  # and label
    p.box(0.47, 0.62, 0.015, 'Trim', z0=h, bevel=0.005)
cabinet('Cabinet', 4)
cabinet('LowCabinet', 2)

# ------------------------------------------------------------------ a cubicle's desk
# The top's 1.4 by 0.75 and 0.74 up, from x -0.7 to 0.7 and y -0.375 (its front) to 0.375; its back panel's front face
# is at y 0.375, its side panel's (on the left) at x -0.7, both 1.25 high; the monitor's centred at x 0, its face at
# y 0.13, from 0.84 to 1.18 up. (Those are interior.js's DESK.)
DESK_W, DESK_D, DESK_H, PANEL_H, PANEL_T = 1.4, 0.75, 0.74, 1.25, 0.05
p = piece('Desk')
p.box(DESK_W, DESK_D, 0.03, 'Laminate', z0=DESK_H - 0.03, bevel=0.006)
p.box(DESK_W - 0.1, 0.02, 0.4, 'Frame', 0, DESK_D/2 - 0.02, DESK_H - 0.43, bevel=0.004)   # modesty panel
# the pedestal of drawers under the right-hand end, holding it up
p.box(0.4, 0.58, 0.66, 'Steel', 0.45, -0.05, 0.02, bevel=0.01)
for z, h in ((0.03, 0.34), (0.39, 0.13), (0.54, 0.13)):
    p.box(0.37, 0.012, h - 0.01, 'Steel', 0.45, -0.345, z, bevel=0.004)
    p.box(0.12, 0.02, 0.018, 'Trim', 0.45, -0.355, z + h - 0.05, bevel=0.004)
for x in (0.3, 0.6):
    p.box(0.04, 0.04, 0.02, 'Dark', x, -0.05, 0, bevel=0.008)
# the panels, back and left, fabric in a frame
def panel(p, w, d, x, y):
    p.box(w, d, PANEL_H - 0.06, 'Fabric', x, y, 0.03, bevel=0.006)
    p.box(w + 0.01, d + 0.01, 0.035, 'Frame', x, y, PANEL_H - 0.035, bevel=0.01)
    p.box(w + 0.01, d + 0.01, 0.04, 'Frame', x, y, 0, bevel=0.006)
    if w > d:
        for ex in (x - w/2, x + w/2): p.box(0.03, d + 0.012, PANEL_H, 'Frame', ex, y, 0, bevel=0.006)
    else:
        for ey in (y - d/2, y + d/2): p.box(w + 0.012, 0.03, PANEL_H, 'Frame', x, ey, 0, bevel=0.006)
panel(p, DESK_W + PANEL_T, PANEL_T, -PANEL_T/2, DESK_D/2 + PANEL_T/2)
panel(p, PANEL_T, DESK_D + 0.05, -DESK_W/2 - PANEL_T/2, -0.025)
# the monitor, on its stand
p.box(0.22, 0.17, 0.015, 'Dark', 0, 0.2, DESK_H, bevel=0.006)
p.box(0.05, 0.03, 0.26, 'Dark', 0, 0.21, DESK_H, bevel=0.006)
p.box(0.58, 0.035, 0.36, 'Dark', 0, 0.1475, 0.83, bevel=0.008)
p.box(0.54, 0.006, 0.31, 'Screen', 0, 0.128, 0.855, bevel=0.001)
# the keyboard, mouse mat and mouse
p.box(0.44, 0.15, 0.02, 'Dark', -0.04, -0.17, DESK_H, bevel=0.006)
p.box(0.41, 0.12, 0.008, 'Keys', -0.04, -0.17, DESK_H + 0.018, bevel=0.002)
p.box(0.22, 0.19, 0.004, 'Dark', 0.32, -0.16, DESK_H, bevel=0.002)
p.ball(0.03, 'Keys', (0.32, -0.16, DESK_H + 0.012), scale=(1, 1.7, 0.6))

# a panel on its own, to close off the end of a row of desks (the Desk's left one, stood at its right-hand end)
p = piece('Panel')
panel(p, PANEL_T, DESK_D + 0.05, 0, -0.025)

# ------------------------------------------------------------------ the office chair
p = piece('OfficeChair')
for k in range(5):                                                  # the five-star base, on casters
    a = k*2*math.pi/5 + math.pi/2
    p.box(0.3, 0.05, 0.03, 'Dark', math.cos(a)*0.15, math.sin(a)*0.15, 0.05, bevel=0.01, rot=(0, 0, a))
    p.ball(0.028, 'Dark', (math.cos(a)*0.3, math.sin(a)*0.3, 0.028))
p.cyl(0.05, 0.05, 'Dark', z0=0.04, segments=10)
p.cyl(0.022, 0.34, 'Steel', z0=0.08, segments=10)                  # the gas lift
p.box(0.2, 0.2, 0.04, 'Dark', 0, 0, 0.4, bevel=0.01)
p.box(0.48, 0.46, 0.07, 'Upholstery', 0, -0.01, 0.43, bevel=0.025, segments=2)   # the seat
p.box(0.06, 0.03, 0.34, 'Dark', 0, 0.23, 0.44, bevel=0.008)        # the back's spine
p.box(0.44, 0.07, 0.5, 'Upholstery', 0, 0.25, 0.58, bevel=0.03, segments=2, rot=(-0.12, 0, 0))
for x in (-0.25, 0.25):                                             # arms
    p.box(0.03, 0.04, 0.2, 'Dark', x, 0.04, 0.46, bevel=0.008)
    p.box(0.06, 0.24, 0.03, 'Dark', x, 0.01, 0.66, bevel=0.012)

# ------------------------------------------------------------------ plants
# a snake plant, in a tall square pot
p = piece('SnakePlant')
p.box(0.3, 0.3, 0.38, 'Pot', bevel=0.02)
p.box(0.27, 0.27, 0.01, 'Dirt', z0=0.36, bevel=0.002)
for k in range(11):
    a = k*2.4 + random.uniform(-0.3, 0.3)
    r = 0.02 + 0.07*random.random()
    h, w = random.uniform(0.45, 0.8), random.uniform(0.05, 0.075)
    blade = [(-w/2, -0.01, 0), (w/2, -0.01, 0), (-w/2, 0.01, 0), (w/2, 0.01, 0),
             (-w*0.55, -0.008, h*0.55), (w*0.55, -0.008, h*0.55), (-w*0.55, 0.008, h*0.55), (w*0.55, 0.008, h*0.55),
             (0, 0, h)]
    p.hull(blade, 'Leaf2' if k % 2 else 'Leaf', (math.cos(a)*r, math.sin(a)*r, 0.33),
           (random.uniform(-0.15, 0.15), random.uniform(-0.15, 0.15), a))
# a little tree, in a round pot
p = piece('Ficus')
p.cyl(0.19, 0.36, 'Pot', segments=16, r2=0.21)
p.cyl(0.2, 0.01, 'Dirt', z0=0.34, segments=16)
p.cyl(0.025, 1.0, 'Bark', z0=0.3, r2=0.015, segments=7, rot=(0.05, 0.04, 0))
p.cyl(0.015, 0.45, 'Bark', 0.02, 0, 0.8, r2=0.008, segments=6, rot=(0, 0.6, 0))
p.cyl(0.015, 0.4, 'Bark', -0.02, 0, 0.9, r2=0.008, segments=6, rot=(0.2, -0.6, 0))
for at in ((0.05, 0.02, 1.35), (0.25, 0.0, 1.15), (-0.22, 0.05, 1.22), (0.0, 0.2, 1.1), (0.02, -0.18, 1.18),
           (-0.08, -0.05, 1.5), (0.15, 0.12, 1.45), (-0.15, 0.15, 1.0)):
    p.ball(random.uniform(0.13, 0.19), 'Leaf2' if at[2] < 1.2 else 'Leaf', at,
           scale=(1, 1, 0.8), rot=(random.random(), random.random(), random.random()))
# a leafy one, arching out of a low round pot
p = piece('Bush')
p.cyl(0.2, 0.3, 'Pot', segments=16, r2=0.17)
p.cyl(0.175, 0.01, 'Dirt', z0=0.28, segments=16)
for k in range(16):
    a = k*2.4
    tilt = random.uniform(0.35, 1.0)
    length = random.uniform(0.3, 0.45)
    # a stem up and out, and a leaf at its end
    d = Vector((math.cos(a)*math.sin(tilt), math.sin(a)*math.sin(tilt), math.cos(tilt)))
    base = Vector((math.cos(a)*0.03, math.sin(a)*0.03, 0.28))
    end = base + d*length
    p.cyl(0.007, length, 'Leaf2', *base, segments=5, rot=(0, tilt, a))
    p.ball(0.11, "Leaf" if k % 3 else 'Leaf2', end + d*0.07, scale=(0.5, 1.4, 0.08), rot=(0, tilt + 0.4, a + math.pi/2))

# ------------------------------------------------------------------ what's left about a desk
p = piece('Sticky')                                                 # a sticky note, facing -y
p.box(0.076, 0.002, 0.076, 'Sticky', z0=0, bevel=0)
p = piece('Calendar')                                               # a calendar, pinned up facing -y
p.box(0.3, 0.004, 0.42, 'Paper', bevel=0.001)
p.box(0.28, 0.006, 0.17, 'Photo', 0, -0.001, 0.23, bevel=0.001)
p.box(0.28, 0.006, 0.03, 'Red', 0, -0.001, 0.185, bevel=0.001)
for i in range(6):
    p.box(0.26, 0.006, 0.004, 'Ink', 0, -0.001, 0.02 + i*0.032, bevel=0)
for i in range(8):
    p.box(0.003, 0.006, 0.16, 'Ink', -0.13 + i*0.26/7, -0.001, 0.02, bevel=0)
p.cyl(0.008, 0.01, 'Red', 0, -0.004, 0.395, segments=8, rot=(math.pi/2, 0, 0))   # the pin
p = piece('Mug')
p.cyl(0.04, 0.095, 'Mug', segments=14)
p.cyl(0.035, 0.005, 'Coffee', z0=0.08, segments=14)
# (its handle: a few boxes round a loop read as a ring at this size)
for k in range(7):
    a = -math.pi/2 + k*math.pi/6
    p.box(0.012, 0.014, 0.018, 'Mug', 0.04 + math.cos(a)*0.028, 0, 0.038 + math.sin(a)*0.028, bevel=0.003, rot=(0, -a, 0))
p = piece('Frame')                                                  # a photo, stood up leaning back a little
p.box(0.14, 0.015, 0.18, 'Dark', 0, 0, 0, bevel=0.004, rot=(-0.2, 0, 0))
p.box(0.11, 0.004, 0.14, 'Photo2', 0, -0.012, 0.02, bevel=0.001, rot=(-0.2, 0, 0))
p.box(0.02, 0.08, 0.005, 'Dark', 0, 0.04, 0, bevel=0.002)
p = piece('Pens')
p.cyl(0.035, 0.1, 'Dark', segments=12)
for k, colour in enumerate(('Pen', 'Red', 'Dark', 'Pen')):
    a = k*1.7
    p.cyl(0.006, 0.15, colour, math.cos(a)*0.015, math.sin(a)*0.015, 0.01, segments=6, rot=(math.sin(a)*0.25, math.cos(a)*0.25, 0))
p = piece('Cactus')
p.cyl(0.045, 0.06, 'Terracotta', segments=10, r2=0.05)
p.cyl(0.042, 0.005, 'Dirt', z0=0.055, segments=10)
p.ball(0.03, 'Cactus', (0, 0, 0.11), scale=(1, 1, 1.9))
p.ball(0.015, 'Cactus', (0.03, 0, 0.13), scale=(1, 1, 1.8), rot=(0, 0.4, 0))
p = piece('Papers')
p.box(0.24, 0.32, 0.012, 'Pen', bevel=0.002)                        # a folder
for k in range(4):
    p.box(0.21, 0.297, 0.006, 'Paper', random.uniform(-0.01, 0.01), random.uniform(-0.01, 0.01), 0.012 + k*0.006,
          bevel=0, rot=(0, 0, random.uniform(-0.12, 0.12)))
p = piece('Duck')                                                   # a rubber duck
p.ball(0.04, 'Duck', (0, 0.01, 0.035), scale=(1, 1.3, 0.85), detail=2)
p.ball(0.026, 'Duck', (0, -0.03, 0.08), detail=2)
p.hull([(-0.012, -0.05, 0.075), (0.012, -0.05, 0.075), (0, -0.075, 0.072), (-0.01, -0.05, 0.068), (0.01, -0.05, 0.068)], 'Beak')
p.ball(0.005, 'Dark', (0.012, -0.05, 0.088))
p.ball(0.005, 'Dark', (-0.012, -0.05, 0.088))

# ------------------------------------------------------------------ out
x = 0
for p in pieces:
    p.build(x)
    x += 2
bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format='GLB', export_apply=True, export_yup=True)
print('wrote', os.path.abspath(OUT))
