# Puts a whole head into assets/models/Hair.glb, right where the hairstyles sit on it, to model new ones against in
# Blender. The game never shows it (peopleModel.js skips any style named ReferenceHead), and hair-models.py keeps it.
#
#   "/Applications/Blender 2.app/Contents/MacOS/Blender" -b --python tools/reference-head.py
#
# It's Person.glb's Head at rest (no face shape), with the Eyes and Mouth as its children, all in the model's own space
# like the styles and mirrored whole (Person.glb has only half; the game mirrors it). Run it again after a new Person.glb.
import bpy, os

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models')
OUT = os.path.abspath(os.path.join(MODELS, 'Hair.glb'))
PERSON = os.path.abspath(os.path.join(MODELS, 'Person.glb'))
NAME = 'ReferenceHead'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=OUT)
for o in [o for o in bpy.data.objects if o.name.startswith(NAME)]:
    bpy.data.objects.remove(o, do_unlink=True)
keep = set(bpy.data.objects)

bpy.ops.import_scene.gltf(filepath=PERSON)
person = [o for o in bpy.data.objects if o not in keep]

def rest_copy(name, new_name):
    """A plain copy of one of the person's meshes where it sits at rest: no shape keys, bones or parent."""
    source = next(o for o in person if o.name.split('.')[0] == name)
    copy = bpy.data.objects.new(new_name, source.data.copy())
    bpy.context.scene.collection.objects.link(copy)
    copy.shape_key_clear()
    copy.data.transform(source.matrix_world)    # in the model's space, so it's mirrored across x = 0 like the body
    mirror = copy.modifiers.new('Mirror', 'MIRROR')
    mirror.use_clip = mirror.use_mirror_merge = True
    return copy

head = rest_copy('Head', NAME)
for part in ('Eyes', 'Mouth'):
    rest_copy(part, NAME + part).parent = head

for o in person:
    bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True)
