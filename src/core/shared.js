import * as THREE from 'three';
// What the modules share. S holds the variables more than one module reassigns. App holds the functions and values a module
// needs from one that loads after it — each module adds its own at the end — so the modules still load, and run their setup,
// in the order the sections always ran in.
// (the settings in the menu's Show settings block, with their defaults here so they're there whichever module loads first, split
// into the two things life/giblets.js draws:
// Gibs — the chunks and blood (or, a car, soot and scorch) a kill or explosion actually leaves behind: whether they're shown,
// how far from the camera they're made and drawn, how many a kill throws and how long they last (each as a fraction of the base
// amount and lifetime in giblets.js);
// Particles — every fire, smoke, spark or spray effect that isn't a gib (an explosion's fireball, a burning car, tyre and engine
// smoke, a legendary car's sparkle, a car's splash going into water, and so on): how far from the camera they're made and drawn
// (particleRange), and the most of them alive at once before the oldest make way (maxParticles) — 0 either way switches them off;
// plus a couple of settings unrelated to either: whether a kill's blood soaks whoever's near, how far from the camera a car has to
// spawn (unless there is nowhere else), and whether the head and hair of whoever is controlled in first person are hidden)
export const S = {
  showGibs: true, gibRange: 2000, gibAmount: 0.5, gibLifetime: 0.5,
  particleRange: 2000, maxParticles: 320,
  hideOwnHead: true, carSpawnDistance: 2000, bloodSoak: true,
};
export const App = {};
// The sand tint, as one uniform object every sand material shares — the beach floors, the slopes running
// down into the water, the sand a park fades into at the shore and the sand under the shallows all point
// at this same object, so picking a color reaches all of them at once with nothing rebuilt (the same trick
// as WATER_TIME). It used to be read into each material as it was built, which quietly left the water's
// own sand on the old color: the water body is only rebuilt when its shape changes, not when a color does.
export const SAND_TINT = { value: new THREE.Color(0xffffff) };
export function setSandTint(hex) { S.globalSandTint = hex; SAND_TINT.value.set(hex); }
