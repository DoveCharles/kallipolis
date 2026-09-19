import { loadTypeText } from '../core/type-text.js';
import { TEXT_ROWS } from '../ui/entity-card.js';

// ============================================================ what vehicles are like
// Each type of vehicle's name, mood, and what it loves and hates, for its card (car-card.js) — from assets/cars.txt, to
// be edited freely: a [section] per type, named as its model is in Cars.glb. The file is read by the shared reader in
// core/type-text.js, which the buildings and the trains use too; see there for the format.
const cars = loadTypeText('assets/cars.txt', {
  attributes: TEXT_ROWS,
  counted: ['loves', 'hates'], // can have several per vehicle: see `counts` in core/type-text.js
  // this stands in until cars.txt has loaded, or if it can't be
  placeholder: {
    default: { name: ['Car'], mood: ['🚗'], loves: ['Beep beep'], hates: ['Honkkkk'] },
    ambulance: { mood: ['🚑'] }, bus: { mood: ['🚌'] }, canyonero: { mood: ['🚙'] }, taxi: { mood: ['🚕'] }, policecar: { mood: ['🚓'] },
    pickuptruck: { mood: ['🛻'] }, sportscar: { mood: ['🏎️'] }, truck: { mood: ['🚚'] }, van: { mood: ['🚐'] },
  },
});

// A vehicle's card details: `design` is its model's name in Cars.glb (null for the plain box car) and `number` its own
// number among others like it (see designNumbers in traffic.js).
export const carTypeOf = (design, number = 1) => cars.of(design, number);
