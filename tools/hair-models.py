# Adds hairstyles and hats to assets/models/Hair.glb, low-poly and flat-faced like the ones already there (see
# "hairstyles and facial hair" in src/life/people/peopleModel.js for how they're worn and who wears which).
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/hair-models.py
#
# It reads Hair.glb, throws away any style it made before (Hair29 on), builds them again and writes the file back, so it
# can be run again after changing one. One top-level mesh per style, in Person.glb's own space at rest (y up, facing +z):
# the head is a box narrowing upwards, 1.2 wide and from z -0.54 to 0.6 at y 7.55 (the eyes' bottom, and the widest it
# gets), 0.74 wide and from z -0.33 to 0.27 on top at y 8.34, and narrowing again below to the jaw at y 7.14. The eyes
# (and brows) are at the front from y 7.5 to 7.95, so hair stays above 7.95 there or keeps to the sides; the neck and
# shoulders are below y 7, out to x 0.8 and back to z -0.31, so long hair falls behind them.
# Coordinates here are the model's, turned into Blender's (z up) by at().
import bpy, bmesh, os, math
from mathutils import Matrix, Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models', 'Hair.glb')
FIRST = 29                              # the first style this makes; those before came from elsewhere
ORIGIN = (0, 7.548481, 0.037602)        # where the other styles have theirs

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(OUT))
for o in [o for o in bpy.data.objects if o.parent is None and not o.name.startswith('ReferenceHead')]:    # see reference-head.py
    number = ''.join(c for c in o.name.split('_')[0] if c.isdigit()) or ''.join(c for c in o.name.split('_')[1] if c.isdigit())
    if int(number) >= FIRST:
        for child in [o] + list(o.children_recursive): bpy.data.objects.remove(child, do_unlink=True)

def at(x, y, z):
    return Vector((x, -z, y))

def linear(hex_colour):
    c = [((hex_colour >> s) & 255)/255 for s in (16, 8, 0)]
    return [x/12.92 if x <= 0.04045 else ((x + 0.055)/1.055)**2.4 for x in c]

def material(name, hex_colour):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = False
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*linear(hex_colour), 1)
    return m

# the hair takes each wearer's own hair color and a hat their hat color, whatever these are; a hat band keeps its own
MATERIALS = {'Hair': material('Hair', 0x4a3223), 'Hat': bpy.data.materials.get('Hat') or material('Hat', 0xcc5a5f),
             'HatBand': material('HatBand', 0x1e1a18)}
MATERIAL_ORDER = list(MATERIALS)

def lerp(a, b, t):
    return a + (b - a)*t

def head(y):
    """The head's half-width, front and back at height y (it's a box, narrowing up from 7.55 and down from it)."""
    if y >= 7.55:
        t = min(1, (y - 7.55)/0.79)
        return lerp(0.6, 0.36, t), lerp(0.6, 0.27, t), lerp(-0.54, -0.33, t)
    t = min(1, (7.55 - y)/0.41)
    return lerp(0.6, 0.15, t), lerp(0.6, 0.3, t), lerp(-0.54, -0.33, t)

def rect(w, front, back, c):
    """A rectangle's eight corners with each corner cut off by c, going round from the right of the front."""
    return [(w, front - c), (w - c, front), (-(w - c), front), (-w, front - c),
            (-w, back + c), (-(w - c), back), (w - c, back), (w, back + c)]

def ring(y, m, c=0.12):
    """Round the head at height y, m out from it, corners cut by c (as points in the model's space)."""
    w, f, b = head(y)
    return [(x, y, z) for x, z in rect(w + m, f + m, b - m, c)]

class Style:
    """One style: its parts, each a closed solid of one material, built up in the model's own space."""
    def __init__(self, name):
        self.name, self.bm = name, bmesh.new()

    def add(self, part, mat):
        mesh = bpy.data.meshes.new('part')
        part.to_mesh(mesh)
        for poly in mesh.polygons: poly.material_index = MATERIAL_ORDER.index(mat)
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)
        part.free()

    def hull(self, points, mat='Hair'):
        """The convex hull of the points: what almost every piece of hair here is."""
        part = bmesh.new()
        for p in points: part.verts.new(at(*p))
        bmesh.ops.convex_hull(part, input=part.verts[:])
        bmesh.ops.remove_doubles(part, verts=part.verts[:], dist=1e-4)
        self.add(part, mat)

    def box(self, centre, half, mat='Hair', turn=0, tip=0):
        """A box about centre, half-sizes half, turned about y by turn and then tipped forward about x by tip."""
        cx, cy, cz = centre
        pts = []
        for dx in (-half[0], half[0]):
            for dy in (-half[1], half[1]):
                for dz in (-half[2], half[2]):
                    y, z = dy*math.cos(tip) - dz*math.sin(tip), dy*math.sin(tip) + dz*math.cos(tip)
                    x, z = dx*math.cos(turn) + z*math.sin(turn), -dx*math.sin(turn) + z*math.cos(turn)
                    pts.append((cx + x, cy + y, cz + z))
        self.hull(pts, mat)

    def strand(self, points, w, d, mat='Hair'):
        """A strand through the points, w wide and d deep: the hull of a box at each end of every stretch of it."""
        for (x0, y0, z0), (x1, y1, z1) in zip(points, points[1:]):
            self.hull([(x + dx, y + dy, z + dz) for x, y, z in ((x0, y0, z0), (x1, y1, z1))
                       for dx in (-w/2, w/2) for dy in (-0.02, 0.02) for dz in (-d/2, d/2)], mat)

    def loft(self, rings, mat='Hat'):
        """A solid through rings of points (each the same number, going the same way round), closed at both ends."""
        part = bmesh.new()
        loops = [[part.verts.new(at(*p)) for p in r] for r in rings]
        n = len(rings[0])
        for a, b in zip(loops, loops[1:]):
            for k in range(n):
                part.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
        part.faces.new(loops[0])
        part.faces.new(loops[-1][::-1])
        bmesh.ops.recalc_face_normals(part, faces=part.faces[:])
        self.add(part, mat)

    def finish(self):
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in MATERIAL_ORDER: mesh.materials.append(MATERIALS[m])
        # drop the materials this style doesn't use, so each part left is one of them
        used = {p.material_index for p in mesh.polygons}
        for k in reversed(range(len(MATERIAL_ORDER))):
            if k not in used: mesh.materials.pop(index=k)
        o = bpy.data.objects.new(self.name, mesh)
        origin = at(*ORIGIN)
        mesh.transform(Matrix.Translation(-origin))
        o.location = origin
        bpy.context.scene.collection.objects.link(o)
        return o

#============== pieces ==============

TOP = 8.34

def crown(s, m=0.07, front=8.0, side=7.55, back=7.35, sideburn=0.25, dome=0.1, mat='Hair'):
    """Hair close over the head: down to `front` over the forehead, `side` in front of where ears would be (reaching
    forward to z `sideburn`) and `back` at the nape, m thick and rising `dome` over the top."""
    pts = [(x, TOP + dome, z) for x, _, z in ring(TOP, m*0.5, 0.18)]
    pts += ring(TOP - 0.1, m, 0.14) + ring(front, m, 0.12)
    for sx in (1, -1):
        w, f, b = head(side)
        c = min(0.12, 1.8*m)
        pts += [(sx*(w + m), side, sideburn), (sx*(w + m), side, b - m + c)]
        w, f, b = head(7.55)                        # (the widest of the head, whose back corners stand out)
        pts += [(sx*(w + m - c), 7.55, b - m), (sx*(w + m), 7.55, b - m + c)]
        w, f, b = head(back)
        pts += [(sx*(w + m - 0.1), back, b - m), (sx*(w + m), back, b - m + 0.1)]
    s.hull(pts, mat)

def fringe_line(s, y=7.98, m=0.1, depth=0.14, parts=((-0.45, 0.45),), drop=0.0):
    """A straight fringe across the forehead, its bottom at y, in pieces between the x of each pair."""
    w, f, b = head(y)
    for x0, x1 in parts:
        s.box(((x0 + x1)/2, y + 0.12 - drop/2, f + m - depth/2), ((x1 - x0)/2, 0.12 + drop/2, depth/2))

#============== hairstyles ==============

def buzz(s):
    # a close crop: barely more than a shadow over the head, with a square hairline
    crown(s, m=0.035, front=8.12, side=7.6, back=7.45, sideburn=0.2, dome=0.03)

def mohawk(s):
    # the sides shaved to stubble and a crest of blocky spikes down the middle, front to back
    crown(s, m=0.025, front=8.15, side=7.75, back=7.5, sideburn=0.12, dome=0.02)
    for k, (z, h, lean) in enumerate([(0.28, 0.42, 0.35), (0.12, 0.55, 0.2), (-0.05, 0.6, 0.05), (-0.22, 0.52, -0.15), (-0.38, 0.35, -0.35)]):
        y0 = TOP - 0.05 if z > -0.3 else 8.0
        zb = z if z > -0.3 else -0.5
        s.hull([(dx, y0, zb + dz) for dx in (-0.11, 0.11) for dz in (-0.13, 0.13)] +
               [(dx, y0 + h, zb + lean*h + dz) for dx in (-0.05, 0.05) for dz in (-0.05, 0.05)])

def long_straight(s, parted=True):
    # parted in the middle and hanging straight to below the shoulders, behind them
    crown(s, m=0.07, front=8.05, side=7.4, back=7.2, sideburn=0.22)
    for sx in (1, -1):
        # the two halves of the part, falling a little apart at the front
        if parted: s.hull([(sx*0.02, TOP + 0.1, 0.25), (sx*0.02, TOP + 0.1, -0.2), (sx*0.42, TOP + 0.02, 0.33), (sx*0.42, TOP + 0.02, -0.2),
                (sx*0.7, 7.9, 0.4), (sx*0.72, 7.9, -0.1), (sx*0.66, 8.12, 0.4)])
        # the side curtains, down past the jaw and then back behind the shoulders
        s.hull([(sx*0.62, 8.0, 0.42), (sx*0.72, 8.0, 0.38), (sx*0.62, 8.0, -0.2), (sx*0.74, 8.0, -0.2),
                (sx*0.64, 7.05, 0.2), (sx*0.76, 7.05, 0.18), (sx*0.64, 7.05, -0.4), (sx*0.78, 7.05, -0.4)])
        s.hull([(sx*0.64, 7.1, 0.15), (sx*0.78, 7.1, 0.15), (sx*0.64, 7.1, -0.4), (sx*0.78, 7.1, -0.4),
                (sx*0.6, 6.45, -0.36), (sx*0.74, 6.45, -0.36), (sx*0.58, 6.45, -0.5), (sx*0.72, 6.5, -0.52)])
    # the back, a sheet down to the shoulder blades
    s.hull([(x, y, z) for x in (-0.7, 0.7) for y, z in ((7.9, -0.62), (7.9, -0.5))] +
           [(x, 6.4, z) for x in (-0.66, 0.66) for z in (-0.42, -0.56)] + [(x, 6.32, -0.5) for x in (-0.3, 0.3)])

def afro(s):
    # a big round cloud, cut away in front of the face and flat-faceted like the rest
    n, r = 7, 0.98
    pts = []
    for i in range(n + 1):
        el = math.pi*(-0.28 + 0.78*i/n)
        for k in range(10):
            az = 2*math.pi*(k + 0.5*(i % 2))/10
            pts.append((r*1.02*math.cos(el)*math.sin(az), 8.12 + r*0.9*math.sin(el), -0.08 + r*math.cos(el)*math.cos(az)))
    # the top, down to the hairline, and behind the face down to the jaw
    s.hull([p for p in pts if p[1] >= 8.02] + [(x, 8.02, z) for x, _, z in ring(8.02, 0.12, 0.15)])
    s.hull([p for p in pts if p[2] <= 0.2] + [(x, 8.02, z) for x, _, z in ring(8.02, 0.08, 0.15) if z <= 0.2])
    for sx in (1, -1):   # and down each side in front of where ears would be, the cloud's sides
        s.hull([p for p in pts if sx*p[0] >= 0.6 and p[2] <= 0.45] + [(sx*0.6, 8.0, 0.4), (sx*0.62, 7.45, 0.32), (sx*0.62, 7.45, -0.3)])

def top_knot(s):
    # pulled up tight into a bun on the crown, with a band round its base
    crown(s, m=0.05, front=8.08, side=7.6, back=7.4, sideburn=0.18, dome=0.06)
    y = TOP + 0.06
    s.hull([(x, y, z) for x, z in rect(0.2, 0.12, -0.26, 0.07)] + [(x, y + 0.16, z) for x, z in rect(0.3, 0.22, -0.36, 0.12)] +
           [(x, y + 0.4, z) for x, z in rect(0.3, 0.22, -0.36, 0.12)] + [(x, y + 0.56, z) for x, z in rect(0.18, 0.1, -0.24, 0.07)])

def braid(s):
    # swept straight back into one thick braid down the back, a stack of plaits tapering to a tuft
    crown(s, m=0.065, front=8.1, side=7.55, back=7.35, sideburn=0.2, dome=0.08)
    # gathered at the back of the head, then plaits leaning left and right in turn, narrowing as they go
    s.hull([(x, y, z) for x in (-0.24, 0.24) for y in (7.45, 7.9) for z in (-0.5, -0.7)] + [(x, 7.3, z) for x in (-0.16, 0.16) for z in (-0.55, -0.7)])
    y, z = 7.3, -0.66
    for k in range(6):
        w, h, d = 0.2 - k*0.012, 0.15, 0.13 - k*0.006
        side = 1 if k % 2 else -1
        yk, zk = y - k*0.19, z - 0.015*k
        s.hull([(side*0.1 + dx, yk, zk + dz) for dx in (-w*0.4, w*0.4) for dz in (-d*0.6, d*0.6)] +
               [(dx - side*0.03, yk - h, zk + dz) for dx in (-w, w) for dz in (-d, d)] +
               [(-side*0.1 + dx, yk - 2*h, zk + dz) for dx in (-w*0.4, w*0.4) for dz in (-d*0.6, d*0.6)])
    s.hull([(dx, 6.2, -0.76 + dz) for dx in (-0.08, 0.08) for dz in (-0.06, 0.06)] +
           [(dx, 6.02, -0.77 + dz) for dx in (-0.15, 0.15) for dz in (-0.09, 0.09)] + [(0, 5.9, -0.77)])

def quiff(s):
    # short back and sides, the top swept up and forward into a blocky quiff over the forehead
    crown(s, m=0.05, front=8.08, side=7.6, back=7.38, sideburn=0.2, dome=0.05)
    s.hull([(x, TOP + 0.04, z) for x, z in rect(0.42, 0.3, -0.35, 0.12)] +
           [(x, TOP + 0.14, z) for x, z in rect(0.38, 0.2, -0.2, 0.12)] +
           [(x, TOP + 0.42, z) for x, z in rect(0.3, 0.66, 0.36, 0.1)] +
           [(x, 8.14, 0.5) for x in (-0.38, 0.38)] + [(x, 8.3, 0.66) for x in (-0.32, 0.32)])

def curtains(s):
    # parted in the middle, the fringe falling to either side of the brow in two wings, over short back and sides
    crown(s, m=0.08, front=8.05, side=7.5, back=7.3, sideburn=0.25, dome=0.12)
    for sx in (1, -1):
        s.hull([(sx*0.04, TOP + 0.13, 0.2), (sx*0.04, TOP + 0.1, 0.34), (sx*0.04, 8.25, 0.52),
                (sx*0.6, 8.25, 0.44), (sx*0.66, 8.25, 0.1), (sx*0.68, 7.75, 0.3), (sx*0.68, 7.72, 0.05),
                (sx*0.26, 8.08, 0.58), (sx*0.48, 7.96, 0.6), (sx*0.64, 7.8, 0.5)])

def bob(s):
    # a square bob to the jaw with a blunt fringe straight across the brow
    crown(s, m=0.1, front=8.0, side=7.5, back=7.25, sideburn=0.3, dome=0.1)
    fringe_line(s, y=7.95, m=0.1, depth=0.12, parts=((-0.52, 0.52),))
    for sx in (1, -1):
        s.hull([(sx*0.62, 8.2, 0.48), (sx*0.72, 8.2, 0.48), (sx*0.62, 8.2, -0.5), (sx*0.74, 8.2, -0.6),
                (sx*0.66, 7.08, 0.5), (sx*0.8, 7.08, 0.5), (sx*0.66, 7.08, -0.5), (sx*0.8, 7.08, -0.6)])
    # the back, full over the crown and tapering in to a blunt edge turned under at the nape
    s.hull([(x, 8.15, z) for x, z in rect(0.8, 0.0, -0.7, 0.3)] + [(x, 7.5, z) for x, z in rect(0.8, 0.0, -0.72, 0.32)] +
           [(x, 7.12, z) for x, z in rect(0.72, 0.0, -0.62, 0.28)] + [(x, 7.04, z) for x, z in rect(0.64, 0.0, -0.52, 0.24)])

def dreads(s):
    # locs, square in section, falling all round from a tied-back crown to the shoulders behind
    crown(s, m=0.08, front=8.02, side=7.6, back=7.4, sideburn=0.28, dome=0.08)
    n = 13
    for k in range(n):
        a = math.pi*(0.18 + 0.64*k/(n - 1))          # from one side round the back to the other
        x0, z0 = 0.72*math.cos(a)*1.02, -0.7*math.sin(a) + 0.06
        x1, z1 = x0*1.12, z0 - 0.12
        y0 = 8.05 if abs(x0) > 0.5 else 7.95
        low = 6.55 + 0.25*abs(math.cos(a)) + 0.08*(k % 3)
        if abs(x0) > 0.5: x1, z1 = x0*1.05, min(z0 - 0.2, -0.38)   # the sides fall behind the shoulders
        s.strand([(x0, y0, z0), (x0*1.05, 7.35, z0 - 0.05), (x1, low, z1)], 0.13, 0.13)

#============== hats ==============

def crown_rings(y0, y1, w0, w1, front0, back0, front1, back1, c0=0.14, c1=0.2):
    return [[(x, y0, z) for x, z in rect(w0, front0, back0, c0)], [(x, y1, z) for x, z in rect(w1, front1, back1, c1)]]

def brim(y, inner, outer, t=0.05, c=0.3, curl=None):
    """A brim's rings, from inside the crown (half-width, front, back `inner`) out to its edge (`outer`) and back again
    underneath, t thick; curl(x, z) lifts it (or drops it) by where it is."""
    def ring_(yy, size, cc):
        return [(x, yy + (curl(x, z) if curl else 0), z) for x, z in rect(*size, cc)]
    w, f, b = inner
    inside = (w - 0.02, f - 0.02, b + 0.02)
    return [ring_(y + t/2, inside, 0.14), ring_(y + t/2, outer, c), ring_(y - t/2, outer, c), ring_(y - t/2, inside, 0.14)]

def hat_hair(s, front=8.05, side=7.55, back=7.35, m=0.06, sideburn=0.22):
    """Short hair showing below a hat's rim."""
    crown(s, m=m, front=front, side=side, back=back, sideburn=sideburn, dome=0)

def fit(y, m):
    """A hat's half-width, front and back at height y, fitting round the head with room m."""
    w, f, b = head(y)
    return w + m, f + m, b - m

def beanie(s):
    # a knitted beanie pulled down to the brow, the cuff turned up, and a bobble on top
    hat_hair(s, front=7.9, side=7.55, back=7.3)
    w, f, b = fit(7.98, 0.1)
    s.loft([[(x, 7.93, z) for x, z in rect(w, f, b, 0.15)], [(x, 8.16, z) for x, z in rect(w + 0.02, f + 0.02, b - 0.02, 0.16)]])
    w, f, b = fit(8.1, 0.07)
    s.loft([[(x, 8.14, z) for x, z in rect(w, f, b, 0.14)], [(x, TOP + 0.12, z) for x, z in rect(0.42, 0.33, -0.4, 0.18)],
            [(x, TOP + 0.26, z) for x, z in rect(0.22, 0.14, -0.22, 0.1)]])
    s.hull([(x, TOP + 0.24 + y, z) for x, z in rect(0.13, 0.09, -0.17, 0.05) for y in (0, 0.22)] +
           [(x, TOP + 0.35, z) for x, z in rect(0.17, 0.13, -0.21, 0.07)], 'Hat')

def bucket(s):
    # a bucket hat: a squat crown and a brim sloping down all round
    hat_hair(s, front=7.95, side=7.5, back=7.3)
    w, f, b = fit(8.0, 0.08)
    s.loft([[(x, 7.98, z) for x, z in rect(w, f, b, 0.16)], [(x, TOP + 0.08, z) for x, z in rect(0.47, 0.38, -0.44, 0.18)],
            [(x, TOP + 0.12, z) for x, z in rect(0.4, 0.31, -0.37, 0.16)]])
    s.loft([[(x, 7.98, z) for x, z in rect(w - 0.02, f - 0.02, b + 0.02, 0.16)], [(x, 7.97, z) for x, z in rect(w, f, b, 0.16)],
            [(x, 7.74, z) for x, z in rect(w + 0.3, f + 0.28, b - 0.28, 0.3)], [(x, 7.8, z) for x, z in rect(w + 0.3, f + 0.28, b - 0.28, 0.3)],
            [(x, 8.03, z) for x, z in rect(w + 0.02, f + 0.02, b - 0.02, 0.16)]])

def fedora(s):
    # a fedora: a tall crown pinched at the front and dented along the top, a band, and a brim snapped down in front
    hat_hair(s, front=8.0, side=7.55, back=7.32)
    w, f, b = fit(8.05, 0.06)
    top = TOP + 0.36
    s.loft([[(x, 8.03, z) for x, z in rect(w, f, b, 0.14)], [(x, top - 0.06, z) for x, z in rect(0.44, 0.34, -0.44, 0.2)],
            [(x, top, z) for x, z in [(0.34, 0.14), (0.22, 0.28), (-0.22, 0.28), (-0.34, 0.14), (-0.36, -0.3), (-0.2, -0.4), (0.2, -0.4), (0.36, -0.3)]]])
    s.hull([(0, top, 0.22), (0, top, -0.36), (0, top - 0.1, 0.25), (0, top - 0.1, -0.38)], 'Hat')   # (fills the dent's middle line)
    s.loft([[(x, 8.03, z) for x, z in rect(w + 0.012, f + 0.012, b - 0.012, 0.14)], [(x, 8.2, z) for x, z in rect(w - 0.012, f - 0.02, b + 0.02, 0.15)]], 'HatBand')
    snap = lambda x, z: 0.08*max(0, -z)/(0.3 - b) - 0.1*max(0, z - f)/0.36 + 0.06*max(0, abs(x) - w)/0.36
    s.loft(brim(8.04, (w, f, b), (w + 0.36, f + 0.36, b - 0.3), 0.04, 0.3, snap))

def top_hat(s):
    # a stovepipe top hat: tall, a little wider at the top, on a narrow brim curled up at the sides
    hat_hair(s, front=7.98, side=7.5, back=7.3)
    w, f, b = fit(8.05, 0.06)
    s.loft([[(x, 8.02, z) for x, z in rect(w, f, b, 0.14)], [(x, TOP + 0.85, z) for x, z in rect(w + 0.04, f + 0.04, b - 0.04, 0.14)]])
    s.loft([[(x, 8.03, z) for x, z in rect(w + 0.012, f + 0.012, b - 0.012, 0.14)], [(x, 8.18, z) for x, z in rect(w + 0.014, f + 0.014, b - 0.014, 0.14)]], 'HatBand')
    curl = lambda x, z: 0.1*(abs(x)/(w + 0.2))**2
    s.loft(brim(8.0, (w, f, b), (w + 0.2, f + 0.18, b - 0.18), 0.05, 0.22, curl))

def cowboy(s):
    # a cowboy hat: a creased crown and a wide brim with its sides rolled up high
    hat_hair(s, front=7.98, side=7.5, back=7.3)
    w, f, b = fit(8.05, 0.07)
    top = TOP + 0.3
    s.loft([[(x, 8.02, z) for x, z in rect(w, f, b, 0.15)], [(x, top - 0.08, z) for x, z in rect(0.46, 0.36, -0.44, 0.2)],
            [(x, top, z) for x, z in [(0.3, 0.1), (0.18, 0.3), (-0.18, 0.3), (-0.3, 0.1), (-0.34, -0.32), (-0.2, -0.42), (0.2, -0.42), (0.34, -0.32)]]])
    s.loft([[(x, 8.08, z) for x, z in rect(w + 0.01, f + 0.01, b - 0.01, 0.15)], [(x, 8.2, z) for x, z in rect(w, f, b, 0.15)]], 'HatBand')
    reach = w + 0.5
    curl = lambda x, z: 0.5*max(0, (abs(x) - w + 0.05)/(reach - w))**1.5 - 0.07*max(0, abs(z) - 0.3)
    s.loft(brim(8.04, (w, f, b), (reach, f + 0.36, b - 0.34), 0.06, 0.42, curl))

def beret(s):
    # a beret slouched over to one side, over a jaw-length bob
    crown(s, m=0.09, front=8.0, side=7.45, back=7.25, sideburn=0.28, dome=0.05)
    for sx in (1, -1):
        s.hull([(sx*0.62, 8.1, 0.42), (sx*0.72, 8.1, 0.42), (sx*0.62, 8.1, -0.5), (sx*0.74, 8.1, -0.58),
                (sx*0.64, 7.15, 0.38), (sx*0.78, 7.15, 0.4), (sx*0.64, 7.15, -0.48), (sx*0.78, 7.15, -0.56)])
    s.hull([(x, 8.1, z) for x, z in rect(0.78, 0.0, -0.68, 0.3)] + [(x, 7.5, z) for x, z in rect(0.78, 0.0, -0.7, 0.32)] +
           [(x, 7.18, z) for x, z in rect(0.7, 0.0, -0.6, 0.28)] + [(x, 7.1, z) for x, z in rect(0.62, 0.0, -0.5, 0.24)])
    tilt = lambda x, z, y: (x, y - 0.22*x + 0.04*z, z)       # (dips to the right)
    w, f, b = fit(8.2, 0.07)
    s.loft([[tilt(x, z, 8.14) for x, z in rect(w, f, b, 0.14)], [tilt(x + 0.16, z, 8.3) for x, z in rect(w + 0.26, f + 0.14, b - 0.14, 0.32)],
            [tilt(x + 0.2, z, TOP + 0.12) for x, z in rect(w + 0.24, f + 0.12, b - 0.12, 0.32)], [tilt(x + 0.12, z, TOP + 0.2) for x, z in rect(w, f - 0.05, b + 0.05, 0.25)]])
    s.hull([tilt(x, y, z) for x in (-0.03, 0.03) for z in (-0.03, 0.03) for y in (TOP + 0.18, TOP + 0.3)], 'Hat')

def flat_cap(s):
    # a flat cap: a low crown swept forward and down onto a short stiff peak
    hat_hair(s, front=7.98, side=7.5, back=7.3)
    w, f, b = fit(8.05, 0.07)
    slope = lambda z: 0.12*(z - b)/(f - b)        # (the crown lower at the front than the back)
    s.loft([[(x, 8.02, z) for x, z in rect(w, f, b, 0.14)],
            [(x, 8.22, z) for x, z in rect(w + 0.06, f + 0.14, b - 0.03, 0.18)],
            [(x, TOP + 0.1 - slope(z), z) for x, z in rect(w + 0.02, f + 0.16, b + 0.02, 0.2)],
            [(x, TOP + 0.14 - slope(z), z) for x, z in rect(w - 0.1, f - 0.02, b + 0.12, 0.18)]])
    s.loft([[(x, 8.04 + y, z) for x, z in [(w, f - 0.12), (w - 0.1, f + 0.04), (-(w - 0.1), f + 0.04), (-w, f - 0.12), (-w, f - 0.2), (w, f - 0.2)]]
            for y in (-0.02, 0.04)][:1] +
           [[(x, 8.0, z) for x, z in [(w - 0.06, f + 0.14), (w - 0.2, f + 0.34), (-(w - 0.2), f + 0.34), (-(w - 0.06), f + 0.14), (-w, f - 0.2), (w, f - 0.2)]]])

def hard_hat(s):
    # a hard hat: a domed shell with a ridge over the top and a short peak all round, longer at the front
    hat_hair(s, front=7.95, side=7.5, back=7.3)
    w, f, b = fit(8.05, 0.12)
    s.loft([[(x, 8.02, z) for x, z in rect(w, f, b, 0.2)], [(x, 8.3, z) for x, z in rect(w, f, b, 0.2)],
            [(x, TOP + 0.2, z) for x, z in rect(w - 0.1, f - 0.1, b + 0.1, 0.2)], [(x, TOP + 0.3, z) for x, z in rect(w - 0.26, f - 0.26, b + 0.26, 0.16)]])
    s.hull([(x, y, z) for x in (-0.08, 0.08) for y, z in ((TOP + 0.35, 0.28), (TOP + 0.35, -0.4), (8.28, 0.58), (8.2, -0.68), (8.0, 0.58))], 'Hat')
    s.loft(brim(8.02, (w, f, b), (w + 0.12, f + 0.36, b - 0.12), 0.05, 0.22, lambda x, z: -0.08*max(0, z - f)/0.36))

def sun_hat(s):
    # a wide floppy sun hat, the brim drooping at the back and sides, over long hair falling behind
    long_straight(s, parted=False)
    w, f, b = fit(8.2, 0.07)
    s.loft([[(x, 8.15, z) for x, z in rect(w, f, b, 0.14)], [(x, TOP + 0.24, z) for x, z in rect(0.45, 0.35, -0.44, 0.2)],
            [(x, TOP + 0.3, z) for x, z in rect(0.36, 0.26, -0.35, 0.16)]])
    s.loft([[(x, 8.15, z) for x, z in rect(w + 0.012, f + 0.012, b - 0.012, 0.14)], [(x, 8.27, z) for x, z in rect(w + 0.012, f + 0.012, b - 0.012, 0.15)]], 'HatBand')
    reach = w + 0.78
    s.loft(brim(8.17, (w, f, b), (reach, f + 0.72, b - 0.78), 0.05, 0.5, lambda x, z: -0.22*max(0, (abs(x) - w)/(reach - w)) - 0.18*max(0, (-z + b)/0.78) + 0.03*max(0, z - f)/0.72))

def bandana(s):
    # a bandana tied tight over the head, knotted at the back with its ends hanging, over short hair at the sides
    hat_hair(s, front=7.92, side=7.5, back=7.3, m=0.07)
    w, f, b = fit(8.05, 0.09)
    s.loft([[(x, 7.98, z) for x, z in rect(w, f, b, 0.15)], [(x, TOP - 0.05, z) for x, z in rect(0.47, 0.37, -0.46, 0.16)],
            [(x, TOP + 0.08, z) for x, z in rect(0.36, 0.25, -0.36, 0.16)]])
    s.hull([(x, y, z) for x in (-0.12, 0.12) for y in (7.93, 8.13) for z in (b - 0.02, b - 0.16)], 'Hat')    # the knot
    for sx in (1, -1):
        s.strand([(sx*0.06, 8.02, b - 0.1), (sx*0.2, 7.72, b - 0.16), (sx*0.26, 7.48, b - 0.12)], 0.13, 0.04, 'Hat')

#============== the lot ==============

STYLES = [
    ('Hair29_GB', buzz), ('Hair30_GB', mohawk), ('Hair31_G', long_straight), ('Hair32_GB', afro), ('Hair33_G', top_knot),
    ('Hair34_G', braid), ('Hair35_GB', quiff), ('Hair36_GB', curtains), ('Hair37_G', bob), ('Hair38_GB', dreads),
    ('Hair39_GB', beanie), ('Hair40_GB', bucket), ('Hair41_GB', fedora), ('Hair42_GB', top_hat), ('Hair43_GB', cowboy),
    ('Hair44_G', beret), ('Hair45_GB', flat_cap), ('Hair46_GB', hard_hat), ('Hair47_G', sun_hat), ('Hair48_GB', bandana),
]

for name, build in STYLES:
    s = Style(name)
    build(s)
    s.finish()

bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format='GLB', export_apply=True, export_yup=True)
