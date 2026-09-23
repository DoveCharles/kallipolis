# The building blocks tools/posh-models.py, tools/student-models.py and the rest make their furniture sets from: materials by name,
# and pieces put together from simple solids, each made one mesh at five times life size (as Interior.glb's are).
# Everything's given in metres, life size. Imported by those scripts (run by Blender), not run itself.
import bpy, bmesh, math, os
from mathutils import Vector, Euler

SCALE = 5

bpy.ops.wm.read_factory_settings(use_empty=True)

def linear(hex_colour):
    c = [((hex_colour >> s) & 255)/255 for s in (16, 8, 0)]
    return [x/12.92 if x <= 0.04045 else ((x + 0.055)/1.055)**2.4 for x in c]

MATERIALS = {}
def material(name, colour, rough=0.8, metal=0.0, glow=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*linear(colour), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if glow is not None:
        b.inputs['Emission Color'].default_value = (*linear(glow), 1)
        b.inputs['Emission Strength'].default_value = 1.0
    MATERIALS[name] = m

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

    # a turned profile: [(radius, height)...] from the bottom up, spun round z at (x, y)
    def lathe(self, profile, mat, x=0, y=0, z0=0, segments=14):
        for (r0, h0), (r1, h1) in zip(profile, profile[1:]):
            if h1 > h0: self.cyl(r0, h1 - h0, mat, x, y, z0 + h0, r2=r1, segments=segments)

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

    # an outline (x, y points, anticlockwise, not necessarily convex) stood up from z0 to z0 + h
    def prism(self, outline, h, mat, z0=0, transform=None):
        bm = bmesh.new()
        verts = [bm.verts.new((x, y, z0)) for x, y in outline]
        face = bm.faces.new(verts)
        face.normal_update()
        if face.normal.z > 0: face.normal_flip()
        top = bmesh.ops.extrude_face_region(bm, geom=[face])['geom']
        bmesh.ops.translate(bm, vec=Vector((0, 0, h)), verts=[v for v in top if isinstance(v, bmesh.types.BMVert)])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if transform: transform(bm)
        self.parts.append((bm, mat))

    # a bar of section s by s from a to b
    def bar(self, a, b, s, mat, bevel=0.003):
        a, b = Vector(a), Vector(b)
        d = b - a
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=(s, s, d.length), verts=bm.verts)
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        bmesh.ops.transform(bm, matrix=q.to_matrix().to_4x4(), verts=bm.verts)
        bmesh.ops.translate(bm, vec=(a + b)/2, verts=bm.verts)
        self.parts.append((bm, mat))

    def build(self, x):
        mats = []
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


# every piece made, out to a GLB at `path`, side by side along x
def export(path):
    for i, p in enumerate(pieces):
        p.build(i*3)
    bpy.ops.export_scene.gltf(filepath=os.path.abspath(path), export_format='GLB', export_apply=True, export_yup=True)
    print('wrote', os.path.abspath(path))
