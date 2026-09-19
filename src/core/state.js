import * as THREE from 'three';
import { S, App } from './shared.js';
import { scene } from './scene.js';
import { BUILDING_GROUND_COLORS, PARK_TINT_COLORS, TREE_TINT_COLORS, DEFAULT_GRASS_NOISE_STRENGTH } from './splines.js';

// ============================================================ state
S.interactionMode = 'node'; // 'node' | 'move'
S.currentTool = 'road';     // what Edit mode edits: 'road' or 'train' (both in the Paths tab), 'zone' or 'objects'
S.lastPathTool = 'road';    // which of the two the Paths tab was last on
S.newRoadType = 'sidewalk'; // the type a new path gets ('sidewalk' | 'walkway' | 'river'), unless it's a train line
S.DEFAULT_ROAD_WIDTH = 8;

export const roadNodes = {};        // id -> {x,z}
S.roadLines = [];          // {id, nodeIds:[...], drawing}
S.activeRoadLine = null;
S.roadNodeSeq=1, S.roadLineSeq=1, S.roadNetworkSeq=1;

S.zones = [];              // {id, name, points:[{x,z}], closed, drawing, settings, outlineGroup, buildingsGroup}
S.activeZone = null;
S.zoneSeq=1;

export let mapImages = [];          // {id, name, mesh}
S.mapImageSeq = 1;
S.selectedMapId = null;
S.hoveredMapId = null;
S.mapTransform = null;     // null | {mode:'translate'|'rotate'|'scale', id, startGround:{x,z}, startPos:{x,z}, startRotY, startScale}
S.lastMouseX = window.innerWidth/2, S.lastMouseY = window.innerHeight/2;

S.selection = { type:null, id:null };
S.lastSelectedRoadNetworkId = null, S.lastSelectedZoneId = null, S.lastSelectedTrainNetworkId = null;
// shared "add/edit a custom palette color" row state: null (closed) | {mode:'add'} | {mode:'edit', index}
S.colorPickerState = null;
export const DEFAULT_ZONE_SETTINGS = { density:0.8, heightMin:4, heightMax:40, landmarkChance:0.08, lotCount:24, setback:1.5, windowsEnabled:true,
  groundColor:BUILDING_GROUND_COLORS[0], borderSetback:0, treeDensity:0.5, treeSizeMin:1, treeSizeMax:2.2, treeSetback:3, colorVariationMin:0.25, colorVariationMax:0.25, windowScale:1, litWindowChance:0.8, specularWindows:true, parkTint:PARK_TINT_COLORS[0], treeTint:TREE_TINT_COLORS[0], customTint:false, grassNoiseStrength:DEFAULT_GRASS_NOISE_STRENGTH,
  fence:true,                                                                       // park
  pavingColor:0xb7b0a4, pavingPattern:'tiles', pavingScale:1, mortarWidth:0.08, fountain:true, plazaTrees:0.35, // plaza
  fieldCount:14, hedgerows:true, farmsteads:true,                                   // farmland
  industrialLots:10, industrialDensity:0.85, industrialHeightMin:5, industrialHeightMax:14, lotFences:true, // industrial
  suburbPlots:40, suburbDensity:0.9, suburbHedges:true,                              // suburbs
  airportTerminal:true, airportTower:true, airportAircraft:true, airportFence:true }; // airport
export const MAX_TARGET_LOTS = 150; // slider max = this many lots; slider min (1) = "whole zone"
export const MIN_ZONE_TREES = 1, MAX_ZONE_TREES = 100; // tree count is a flat target regardless of zone size, not an area-scaled density

S.roadMeshGroup = new THREE.Group(); scene.add(S.roadMeshGroup);
S.trainMeshGroup = new THREE.Group(); scene.add(S.trainMeshGroup);
S.roadMarkerGroup = new THREE.Group(); S.roadMarkerGroup.visible=true; scene.add(S.roadMarkerGroup);
S.roadHandleGroup = new THREE.Group(); S.roadHandleGroup.visible=false; scene.add(S.roadHandleGroup);
export const mapGroup = new THREE.Group(); mapGroup.name='Maps'; scene.add(mapGroup);

Object.assign(App, { roadNodes });
