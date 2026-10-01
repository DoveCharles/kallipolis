// =========================================== PRESETS ===========================================
// One-off people: whoever's in `slot` is always them — that sex, `hair` (a style in Hair.glb no one else is given, its
// parts in their own colors) and `skirt` (in Skirt.glb, or none), never glasses, jeans or facial hair, the outfit whose
// `hat` is their hair (see outfits.js), and named `name` (see registerPreset in profiles.js). Salons and clothes shops
// leave them as they are.
export const PRESETS = [
  { name: 'Hatsune Miku', shortName: 'Miku', slot: 3, man: false, hair: 'Hair_Miku', skirt: 'Skirt_Mini', height: 0.97,
    body: { Breast: 0.18, Waist: 0.38, Hips: -0.33, Weight: 0.06, Butt: 0.61, Shoulders: -0.11 },
    face: { 'Key 1': -0.04, 'Key 2': -0.17, Shape1: 0.13, Shape2: 0.21, Shape3: 0.98 },
    bands: [4, 3, 1], lashes: [2], lipstick: false, age: 18, mood: '🙂',
    voice: { pitch: 360, formant: 1.3, sharpness: 11, melody: 'sung' }, // (high, bright and nasal, sung: audio/melodies.js SUNG)
    // her own loves and hates, [card, spoken]
    loves: [['Hiding in your wifi', 'hiding in your wifi'], ['Popipopipopipo', 'popipopipopipo']],
    hates: [['Low sample rates', 'low sample rates'], ['Copyright strikes', 'copyright strikes']] },
];
/** The preset whose slot is `i`, if any. */
export const presetAt = i => PRESETS.find(preset => preset.slot === i) ?? null;
/** Whether a hairstyle is a preset's own. */
export const isPresetHair = name => PRESETS.some(preset => preset.hair === name);
