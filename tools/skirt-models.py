# Builds assets/models/Skirt.glb: skirts some women wear, as low-poly as the body and flat-faced. Each is a single sheet (the app draws
# people double-sided) of rings stacked from the waist to the hem.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/skirt-models.py
#
# One top-level mesh per style, placed in Person.glb's own space at rest (y up, facing +z, about 7.6 tall), and carrying
# no weights or shape keys of its own: the app fits each vertex to the body under it when it loads (see skirtFit.js), so
# a skirt only has to sit clear of the body at rest. The body there is about 0.77 wide at the waist (y 5.45), 1.34 at
# the top of the pelvis (5.24) and 1.6 where the legs start (4.53), 0.5 in front and -0.6 behind; the hands hang with
# their inside edge at x 0.86 from y 4.2 down, and the arms don't swing out of the way, so a skirt can't be any wider
# than 1.7 across below that: it flares forwards and back instead.
import bpy, bmesh, os, math
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Skirt.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)

def at(x, y, z):
    return Vector((x, -z, y))

def linear(hex_colour):
    c = [((hex_colour >> s) & 255)/255 for s in (16, 8, 0)]
    return [x/12.92 if x <= 0.04045 else ((x + 0.055)/1.055)**2.4 for x in c]

cloth = bpy.data.materials.new('Skirt')    # (each wearer's own colour in the app)
cloth.use_nodes = True
cloth.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*linear(0x3a4a78), 1)

SQUARE = 4    # how square each ring is: a superellipse, to clear the corners of the hips

def ring(y, front, side, back, n, pleat=0):
    # n points round from the front middle, a vertex always on the middle front and back;
    # pleated rings push every other point out by pleat
    mid, depth = (front + back)/2, (front - back)/2
    pts = []
    for k in range(n):
        a = 2*math.pi*k/n
        s, c = math.sin(a), math.cos(a)
        r = 1 + (pleat if k % 2 else 0)
        x = math.copysign(abs(s)**(2/SQUARE), s)*side*(1 + (r - 1)*c*c)    # (not out at the sides, into the hands)
        z = mid + math.copysign(abs(c)**(2/SQUARE), c)*depth*r
        pts.append((x, y, z))
    return pts

def skirt(name, rings, n=8, pleat_from=None, pleat=0):
    bm = bmesh.new()
    loops = [[bm.verts.new(at(*p)) for p in ring(y, f, s, b, n, pleat if pleat_from is not None and y <= pleat_from else 0)]
             for y, f, s, b in rings]
    for top, low in zip(loops, loops[1:]):
        for k in range(n):
            j = (k + 1) % n
            bm.faces.new((top[k], low[k], low[j], top[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(cloth)
    for p in mesh.polygons: p.use_smooth = False
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)

# (y, front, side, back): hugging the waist and hips, then hanging clear of the legs — in front more than behind, where
# the hem goes under the thighs when they sit
HIPS = [(5.45, 0.44, 0.59, -0.50), (5.24, 0.58, 0.78, -0.68), (4.45, 0.73, 0.84, -0.74)]

skirt('Skirt_ALine', HIPS + [(3.35, 0.84, 0.85, -0.66)])
skirt('Skirt_Pleated', HIPS + [(2.95, 0.86, 0.85, -0.6)], n=16, pleat_from=4.4, pleat=0.06)
skirt('Skirt_Mini', HIPS + [(3.95, 0.8, 0.85, -0.72)])

bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format='GLB', export_apply=True, export_yup=True)
print('wrote', os.path.abspath(OUT))
