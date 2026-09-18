import * as THREE from 'three';
// What the modules share. S holds the variables more than one module reassigns. App holds the functions and values a module
// needs from one that loads after it — each module adds its own at the end — so the modules still load, and run their setup,
// in the order the sections always ran in.
export const S = {};
export const App = {};
// The sand tint, as one uniform object every sand material shares — the beach floors, the slopes running
// down into the water, the sand a park fades into at the shore and the sand under the shallows all point
// at this same object, so picking a color reaches all of them at once with nothing rebuilt (the same trick
// as WATER_TIME). It used to be read into each material as it was built, which quietly left the water's
// own sand on the old color: the water body is only rebuilt when its shape changes, not when a color does.
export const SAND_TINT = { value: new THREE.Color(0xffffff) };
export function setSandTint(hex) { S.globalSandTint = hex; SAND_TINT.value.set(hex); }
