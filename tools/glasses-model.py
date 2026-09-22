# Builds assets/models/Glasses.glb: a pair of glasses and a pair of sunglasses, low-poly and flat-faced, worn over the eyes the way Hair.glb's
# styles are worn over the head (see "hairstyles and facial hair" in src/life/people/peopleModel.js).
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/glasses-model.py
#
# One top-level mesh per style, placed in Person.glb's own space at rest (y up, facing +z, about 7.6 tall): the eyes are
# flat panels at z 0.63, from x 0.04 to 0.53 either side of the middle and y 7.63 to 7.9, and the head is 1.2 wide at
# y 7.55 narrowing to 1 at the top of the eyes. Coordinates here are the model's, turned into Blender's (z up) by at().
import bpy, bmesh, os
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Glasses.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)

def at(x, y, z):
    return Vector((x, -z, y))

def linear(hex_colour):
    c = [((hex_colour >> s) & 255)/255 for s in (16, 8, 0)]
    return [x/12.92 if x <= 0.04045 else ((x + 0.055)/1.055)**2.4 for x in c]

frame = bpy.data.materials.new('Frame')
frame.use_nodes = True
frame.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*linear(0x1e1e20), 1)
# (the frame takes each wearer's own colour in the app; the lenses keep this one)
tint = bpy.data.materials.new('Lens')
tint.use_nodes = True
tint.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*linear(0x14181f), 1)

LENS_X, LENS_Y = 0.3, 7.77          # the middle of each lens (the left; the right's mirrored)
HOLE_W, HOLE_H = 0.23, 0.155        # half the opening, across and up
RIM, CHAMFER = 0.045, 0.06          # how thick the rim is, and how much its corners are cut
FRONT, DEPTH = 0.71, 0.035          # the rim's front face, and how far back it goes
HINGE_Y = 7.9

def chamfered(a, b, c):
    return [(a, b - c), (a - c, b), (-(a - c), b), (-a, b - c), (-a, -(b - c)), (-(a - c), -b), (a - c, -b), (a, -(b - c))]

def rim(bm, cx):
    inner = chamfered(HOLE_W, HOLE_H, CHAMFER)
    outer = chamfered(HOLE_W + RIM, HOLE_H + RIM, CHAMFER + RIM*0.414)
    loop = lambda pts, z: [bm.verts.new(at(cx + x, LENS_Y + y, z)) for x, y in pts]
    inf, outf, inb, outb = loop(inner, FRONT), loop(outer, FRONT), loop(inner, FRONT - DEPTH), loop(outer, FRONT - DEPTH)
    for k in range(8):
        n = (k + 1) % 8
        bm.faces.new((inf[k], outf[k], outf[n], inf[n]))
        bm.faces.new((inb[n], outb[n], outb[k], inb[k]))
        bm.faces.new((outf[k], outb[k], outb[n], outf[n]))
        bm.faces.new((inf[n], inb[n], inb[k], inf[k]))

def lens(bm, cx):
    # a flat plate filling the rim, set back into it a little (one face: the app draws people double-sided)
    pts = chamfered(HOLE_W + 0.005, HOLE_H + 0.005, CHAMFER)
    z = FRONT - DEPTH*0.4
    ring = [bm.verts.new(at(cx + x, LENS_Y + y, z)) for x, y in pts]
    bm.faces.new(ring[::-1]).material_index = 1

def bar(bm, points, w, h, d):
    # a bar through the points, w by h by d thick: the hull of a box at each end of every stretch of it
    for (x0, y0, z0), (x1, y1, z1) in zip(points, points[1:]):
        part = bmesh.new()
        for x, y, z in ((x0, y0, z0), (x1, y1, z1)):
            for dx in (-w/2, w/2):
                for dy in (-h/2, h/2):
                    for dz in (-d/2, d/2):
                        part.verts.new(at(x + dx, y + dy, z + dz))
        bmesh.ops.convex_hull(part, input=part.verts[:])
        mesh = bpy.data.meshes.new('part')
        part.to_mesh(mesh)
        bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)
        part.free()

def style(name, lenses):
    bm = bmesh.new()
    edge = LENS_X + HOLE_W + RIM    # the rims' outside edge
    for side in (1, -1):
        rim(bm, side*LENS_X)
        # the arm, from a hinge on the rim's outside edge back along the side of the head, dipping at the end behind
        # where an ear would be
        bar(bm, [(side*(edge - 0.01), HINGE_Y, FRONT - DEPTH/2), (side*(edge + 0.02), HINGE_Y, FRONT - DEPTH),
                 (side*(edge + 0.01), HINGE_Y - 0.02, -0.2), (side*(edge - 0.01), HINGE_Y - 0.13, -0.38)], 0.035, 0.045, 0.01)
    # the bridge, across the nose
    inside = LENS_X - HOLE_W - RIM
    bar(bm, [(-inside - 0.02, 7.86, FRONT - DEPTH/2), (inside + 0.02, 7.86, FRONT - DEPTH/2)], 0.01, 0.04, DEPTH*0.9)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.00001)
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.material_index == 0])
    if lenses:
        for side in (1, -1): lens(bm, side*LENS_X)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(frame)
    if lenses: mesh.materials.append(tint)
    for p in mesh.polygons: p.use_smooth = False
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)

style('Glasses', False)
style('Sunglasses', True)

bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format='GLB', export_apply=True, export_yup=True)
print('wrote', os.path.abspath(OUT))
