// ============================================== people types ==============================================
// The shapes the people modules pass around. This file is deliberately NOT a module — it has no imports or
// exports — so these typedefs are global and every file in the folder can name them in JSDoc without
// importing anything. Nothing here runs; it exists for the editor and for anyone reading the code.
// (three.js types are named as import('three').X: a script file has no THREE namespace in scope.)

/**
 * One walkway: a sidewalk ring running down the middle of a block's sidewalks, or a path walked across its own width.
 * @typedef {object} NavLine
 * @property {Array<{x: number, z: number}>} pts - the walkway's points, resampled to at least PEOPLE_NAV_SPACING
 * @property {number[]} cum - distance along the line to each point
 * @property {number} total - the line's whole length
 * @property {boolean} loop - its last point is its first (a ring, or a path drawn back onto its first node)
 * @property {boolean} ring - a sidewalk ring (as opposed to a path)
 * @property {boolean} path - a path
 * @property {number} y - the height people walk along it at
 * @property {number} lateral - how far either side of its line people walk
 * @property {boolean} [raised] - up on a raised walkway: a deck, or a ramp down from one
 * @property {boolean} [ramp] - a raised walkway's ramp, whose height at each point is in ys
 * @property {number[]} [ys] - a ramp's height at each point
 * @property {number} [walk] - on a raised walkway, how far either side of its line someone possessed can go before the ledge
 * @property {boolean} [cutStart] - a raised walkway deck whose first point is an end of it, cut square where its ramp starts
 * @property {boolean} [cutEnd] - likewise its last point
 * @property {Array<{x: number, z: number}>} [mitres] - how a point is set off square to the line there (see navVertexMitre);
 *   assigned once the line is built
 * @property {?boolean[]} blocked - per point, whether it's out over a road (null on a ring)
 * @property {?boolean[]} overWater - per point, whether it's over water (null on a ring)
 * @property {NavVertex[]} vertices - one per point
 * @property {number} [roadSide] - on a ring, which side (relative to the mitres) the road is on
 */

/**
 * A walkway point's joinings and opportunities.
 * @typedef {object} NavVertex
 * @property {Array<{li: number, vi: number, cross?: object}>} links - other walkway points joined here
 * @property {Array<{area: number, side: number, x: number, z: number}>} entrances - hangouts reachable from here
 * @property {object} [building] - the door onto this point (see buildingDoors)
 */

/**
 * A hangout: a plaza, park or beach people gather in.
 * @typedef {object} Hangout
 * @property {string} kind - 'plaza', 'park' or 'beach'
 * @property {function(number, number): boolean} inside - the zone with its cutouts (water, a fountain) taken out
 * @property {?{x: number, z: number, r: number}} fountain
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minZ
 * @property {number} maxZ
 * @property {number} size - its area
 * @property {number} y
 * @property {Array<{li: number, vi: number, x: number, z: number}>} exits - walkway points it can be left by
 * @property {Array<{x: number, z: number, nx: number, nz: number, y: number, by: ?Person}>} seats - a plaza's benches
 * @property {Array<{x: number, z: number, r: number}>} trees - a park's trunks
 */

/**
 * A person, cuboid or model-drawn.
 * @typedef {object} Person
 * @property {number} id - who they permanently are, separate from their place in the crowd: what their name, age,
 *   traits and looks are seeded from (see profileOf in profiles.js and assignAppearance in peopleModel.js), so it
 *   survives someone else later taking their old slot. See peopleIdSeq in people.js.
 * @property {number} x - where they are
 * @property {number} y
 * @property {number} z
 * @property {number} heading - which way they face, in radians
 * @property {'none'|'line'|'wander'|'leaving'|'train'|'indoors'|'possessed'|'dead'} mode - what they're doing
 * @property {number} li - the walkway they're on, in peopleNav.lines
 * @property {number} u - how far along that walkway they are
 * @property {number} dir - which way along it
 * @property {number} seg - the segment they're on
 * @property {number} lat - how far across the walkway they walk
 * @property {number} area - the hangout they're in, in peopleNav.areas, or -1
 * @property {number} tx - where in the hangout they're heading
 * @property {number} tz
 * @property {number} wait - seconds until they pick somewhere else to go
 * @property {boolean} moving - whether they moved this frame
 * @property {number} stepped
 * @property {number} height - their height in world units, from baseHeight and their size trait
 * @property {number} baseHeight
 * @property {number} stride
 * @property {number} phase - how far through the cuboid walk bob they are
 * @property {?object} exit - the walkway point they're leaving a hangout by
 * @property {object} traits - their traits from people/*.txt (see profiles.js)
 * @property {string} [name] - the name their profile gave them
 * @property {string} traitsKey - the profiles version and sex their traits were picked for
 * @property {?object} [defaultHair] - the hair color they started with, before any greying
 * @property {boolean} [onRoad] - possessed, and walking over a road
 * @property {?object} [footing] - possessed, and up on something: a raised walkway, a station, its lift or a carriage (see peopleFooting.js)
 *

 * the model's animation
 * @property {number} walkCycle - how far through the walk animation, in whole cycles
 * @property {number} idleTime
 * @property {?object} pose - the animation name they stand in (see PERSON_CLIPS)
 * @property {?object} clipA - the animation they're in
 * @property {?object} clipB - the animation they're blending out of
 * @property {number} rowB - the row clipB is held at
 * @property {number} fade - how far they've blended from clipB into clipA
 * @property {number} fadeTime - how long that blend takes
 * @property {?object} oneShot - an animation playing through once
 * @property {number} shotTime - how long that has been playing
 * @property {number} heightScale - how tall their current pose leaves them
 * @property {number} blinkIn - seconds until their next blink
 * @property {number} blinkAge - seconds since this blink began
 * @property {number} lookTurn - how far their head is turned, side to side
 * @property {number} lookTilt - how far it is tilted, up and down
 * @property {number} lookTurnTo - the turn it's easing toward
 * @property {number} lookTiltTo - the tilt it's easing toward
 * @property {number} lookIn - seconds until they glance somewhere else
 * @property {number} stillFor - how long they've stood about
 * @property {number} fidgetAfter - how long until they fidget
 *

 * what they're doing besides walking about
 * @property {?string} act - 'chat', 'bench', 'circle' or 'lie'
 * @property {string} stage
 * @property {number} timer
 * @property {?{x: number, z: number, heading?: number}} spot - where they're sitting or lying
 * @property {?object} seat
 * @property {?object} sitClip
 * @property {?object} lieClip
 * @property {number} circleAngle - where round a circle on the grass they're sat
 * @property {?object} group - the conversation they're in (see groups)
 * @property {?number} faceTo - which way they should face
 * @property {?Person} lookAt - who they're looking at
 * @property {number} seatLift - how far up onto a bench seat they sit
 * @property {number} chatCheckIn - seconds until they consider talking to someone
 * @property {number} chatCooldown
 * @property {number} talk - how open their mouth is
 * @property {number} talkTo - how open it's heading
 * @property {number} talkIn - seconds until that changes again
 * @property {number} emotion - how their expression reads, -1 to 1
 * @property {number} emotionTo
 * @property {number} emotionIn
 * @property {number[]} eyes - how shocked, happy, angry and sad they look
 *

 * crossing a road
 * @property {?object} jc - the way over a road they're crossing (see maybeCrossRoad)
 * @property {?string} crossStage
 * @property {number} crossCheckIn - seconds until they consider crossing mid-block
 * @property {number} linkCooldown - keeps them from turning off again straight after a turn
 *

 * riding the trains, going indoors, fighting
 * @property {?object} train - where they are in riding the trains
 * @property {number} trainCooldown
 * @property {?object} indoors - where they are in going into a building
 * @property {?{visit: number, goal: ?object, wait: number}} inRoom - where they are in the room, while the camera's inside
 *   the building with them (see aboutTheRoom in peopleActivities.js)
 * @property {number} indoorsCooldown
 * @property {?object} attack - who they're punching, and how far along they are
 * @property {?object} punched - who's punching them, and how far along they are
 * @property {number} punchCooldown
 *

 * reactions to someone blowing up nearby
 * @property {?object} fright - how they're taking it (see updateFright)
 * @property {?object} stun
 * @property {?object} please
 * @property {number} [age]
 */

/**
 * The loaded people model: the meshes and textures the shader poses people with.
 * @typedef {object} PersonModel
 * @property {import('three').InstancedMesh} mesh - the body
 * @property {import('three').InstancedBufferAttribute} anim - per person, their animation (see instanceAnim in the shader)
 * @property {import('three').InstancedBufferAttribute} look
 * @property {import('three').InstancedBufferAttribute} eyes
 * @property {object[]} hair - the hairstyle, facial-hair, glasses and skirt meshes that have someone wearing them
 * @property {object[]} wornLayers - the hairstyle, facial-hair, glasses and skirt layers
 * @property {Uint8Array} isMan - per person, whether they're a man
 * @property {Float32Array} boneData - the baked bone poses
 * @property {number} boneWidth
 * @property {Float32Array} traitData - the traits texture's data
 * @property {import('three').Color[]} palette - the model's own colors by slot
 * @property {function(number, number): void} assignAppearance - write one person's body shape, face, colors and
 *   clothing into the traits texture, from their id (see people.js)
 * @property {number} headBone
 * @property {import('three').Vector3} headPivot
 * @property {number} height - the model's height, in its own units
 * @property {number} minY
 * @property {Object<string, object>} clips - the baked animations by name (see PERSON_CLIPS)
 * @property {number} stride - how far a person walks for each cycle of the walk animation
 */

/**
 * A segment to search against.
 * @typedef {object} Segment
 * @property {{x: number, z: number}} a - where it starts
 * @property {{x: number, z: number}} b - where it ends
 */

/**
 * The nearest segment to a point.
 * @typedef {object} SegmentHit
 * @property {Segment} seg - the segment found
 * @property {{x: number, z: number}} q - the nearest point on it
 * @property {number} t - how far along the segment that is, from 0 to 1
 * @property {number} d - how far the point is from it
 */
