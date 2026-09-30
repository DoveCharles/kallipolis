import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { S, App } from '../core/shared.js';
import { TOON_RAMP } from '../core/toon.js';
import { scene, camera } from '../core/scene.js';
import { controls, CAMERA_MIN_RADIUS } from '../core/camera-controls.js';
import { heal, healthFraction } from '../core/health.js';
import { setMedBoothModel } from '../objects/object-types.js';
import { people, peopleNav, isGone, feel, witness } from './people/people.js';
import { personHeight } from './people/peopleTracking.js';
import { healFx } from './giblets.js';
import { updateMedBotSounds } from '../audio/medbot.js';
import { makeCard } from '../ui/entity-card.js';
import { makeThumbnailDrawer } from './thumbnail.js';

// ============================================================ MedBots
// Every med booth put down in the Objects tab (see 'medbooth' in objects/object-types.js) is home to a MedBot
// (assets/models/MedBot.glb, a rigged model made in Blender with the booth itself in the same file). Placed, the booth's
// door slides open (its Open shape key), she rolls out on her conveyor-belt boots and the door shuts behind her. From
// then she patrols round the booth, and anyone she sees about who's badly hurt she rushes over to at three times the
// speed and heals: HealStand for someone on their feet, HealLayDown for someone knocked flat. They hold still for it (the
// same hold as being pleased: see updatePlease in people/people.js, or kept down if they're lying), in a cloud with
// hearts coming off it (healFx in giblets.js), and come out of it at full health.
// She runs on a charge, shown on her card: rolling about wears it down slowly and every heal takes a good bite out of
// it. Low, she goes home — door open, in, door shut — and charges up in the booth before coming out again.
// Her Move and Idle clips are single frames (she doesn't walk, she's carried), so what life she has between heals is in
// her head, which swivels to look about and at people, as the bar bot's does (see buildings/barbot.js).
const MODEL_URL = 'assets/models/MedBot.glb';
const BOT_HEIGHT = 1.75;           // m she stands, the booth sized along with her
const SPEED = 6;                   // m/s rolling about (people walk at PERSON_WALK_SPEED, 1.4)
const RUSH = 3;                    // × SPEED, rushing to someone hurt
const SIREN = 'Material.009';      // her body light's material
const FLASH = 4;                   // flashes a second, rushing
const TURN_RATE = 16;              // rad/s she turns toward where she's going
const PATROL_RADIUS = 140;          // m round the booth she picks places to roll to
const SIGHT = 50;                  // m she sees someone hurt from
const LEASH = 50;                  // m from the booth she'll go after someone, and gives up past
const HEAL_BELOW = 1;            // the share of their health someone has to be under for her to go to them
const HEAL_LOOPS = 2;              // times the heal clip plays through for one heal
const PAUSE = [1, 4];              // s she stops for between places on her patrol
const LOOK_EVERY = [1.2, 3.5];     // s between glances about
const LOOK_NEAR = 9;               // m within which someone might catch her eye
const HEAD_REACH = 1.1;            // rad, the most her head swivels either way
const HEAD_EASE = 4;               // the head's swivel, eased per second
const DOOR_TIME = 0.7;             // s the door takes to open or shut
const DRAIN = 1/300;               // charge a second she's out (five minutes' rolling about from full)
const HEAL_COST = 0.12;            // charge a heal takes
const LOW = 0.2;                   // charge she heads home at
const CHARGE_TIME = 12;            // s in the booth from empty to full
const FADE = 6;                    // how fast (per second) she changes between poses
const STEP_OUT = 0.9;              // m in front of the door she comes out to, and goes back in from

let model = null;   // { template, clips, height, inside, front, reach } once loaded
let thumbView = null;
const group = new THREE.Group();
group.name = 'MedBots';
scene.add(group);
const bots = new Map(); // booth object id → bot
let botNumbers = 0;

/** Load the MedBot and her booth, hand the booth to the Objects tab, and keep her to clone for every booth put down. */
export async function loadMedBot() {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  } catch (err) {
    console.warn('Kallipolis: the MedBot model failed to load; med booths stand empty', err);
    return;
  }
  const root = gltf.scene, toon = new Map();
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const m = o.material;
    if (!toon.has(m)) toon.set(m, new THREE.MeshToonMaterial({ name: m.name, color: m.color, gradientMap: TOON_RAMP, flatShading: true,
      emissive: m.emissive, emissiveIntensity: m.emissiveIntensity ?? 1, side: THREE.DoubleSide }));
    o.material = toon.get(m);
  });
  const boothMesh = root.getObjectByName('MedBooth'), rig = root.getObjectByName('MedBot');
  if (!boothMesh || !rig) { console.warn('Kallipolis: MedBot.glb has no MedBooth or no MedBot'); return; }
  const clips = {};
  gltf.animations.forEach(clip => { if (clip.duration < 0.1) clip.duration = 1; clips[clip.name] = clip; }); // (Idle, Move and Speed are single frames)

  // measured standing (Idle), in the file's own units: her, precisely (she's skinned), and the booth
  const mixer = new THREE.AnimationMixer(root);
  if (clips.Idle) mixer.clipAction(clips.Idle).play();
  mixer.setTime(0);
  root.updateMatrixWorld(true);
  const body = new THREE.Box3();
  rig.traverse(o => { if (o.isSkinnedMesh) body.expandByObject(o, true); });
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  const booth = new THREE.Box3().setFromObject(boothMesh);
  const k = BOT_HEIGHT/(body.max.y - body.min.y);
  const middle = booth.getCenter(new THREE.Vector3()), bodyMiddle = body.getCenter(new THREE.Vector3());

  // the booth, scaled along with her, for the Objects tab (which rests it on the ground and centres it)
  const boothRoot = new THREE.Group();
  boothMesh.removeFromParent();
  boothMesh.traverse(o => { if (o.isMesh) o.frustumCulled = true; });
  boothRoot.add(boothMesh);
  boothRoot.scale.setScalar(k);
  setMedBoothModel(boothRoot);

  // her, standing on her own origin, at full size
  const template = new THREE.Group();
  rig.removeFromParent();
  rig.position.x -= bodyMiddle.x; rig.position.y -= body.min.y; rig.position.z -= bodyMiddle.z;
  template.add(rig);
  template.scale.setScalar(k);
  template.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); // (skinned: its bounds are the rest pose's)

  model = {
    template, clips, height: BOT_HEIGHT,
    // where she stands in the booth, in its own terms as the Objects tab places it (centred, floor at 0), and the middle
    // of its doorway at the front (+z)
    inside: new THREE.Vector3((bodyMiddle.x - middle.x)*k, (body.min.y - booth.min.y)*k, (bodyMiddle.z - middle.z)*k),
    front: (booth.max.z - middle.z)*k,
    reach: measureReach(template, clips),
  };
  thumbView = thumbnailScene();
}

// How far in front of her the middle of her hands is, halfway through HealStand: how close she stands to someone to heal them.
function measureReach(template, clips) {
  const probe = cloneSkinned(template), hands = [];
  probe.traverse(o => { if (o.isBone && /^Hand\.[LR]/.test(o.name)) hands.push(o); });
  if (!clips.HealStand || !hands.length) return 0.45;
  const mixer = new THREE.AnimationMixer(probe);
  mixer.clipAction(clips.HealStand).play();
  mixer.setTime(clips.HealStand.duration/2);
  probe.updateMatrixWorld(true);
  const at = new THREE.Vector3();
  const z = hands.reduce((sum, h) => sum + h.getWorldPosition(at).z, 0)/hands.length;
  return THREE.MathUtils.clamp(z, 0.2, 1);
}

// ---------------------------------------------------------- one bot a booth
function makeBot(obj) {
  const root = cloneSkinned(model.template);
  let head = null;
  root.traverse(o => { if (o.isBone && o.name === 'Head') head = o; });
  // her own body light (Material.009), black but for flashing red while she rushes
  let siren = null;
  root.traverse(o => {
    if (!o.isMesh || !o.material.name?.startsWith(SIREN)) return;
    siren ??= o.material.clone();
    o.material = siren;
  });
  siren?.emissive.setRGB(0, 0, 0);
  const mixer = new THREE.AnimationMixer(root), actions = {};
  for (const name of ['Idle', 'Move', 'Speed', 'HealStand', 'HealLayDown']) {
    const clip = model.clips[name];
    if (!clip) continue;
    const action = actions[name] = mixer.clipAction(clip);
    if (name.startsWith('Heal')) { action.setLoop(THREE.LoopRepeat, HEAL_LOOPS); action.clampWhenFinished = true; }
    action.play();
    action.setEffectiveWeight(name === 'Idle' ? 1 : 0);
  }
  group.add(root);
  const bot = {
    obj, root, head, mixer, actions, number: ++botNumbers,
    x: 0, y: 0, z: 0, heading: 0, state: 'opening', timer: 0, door: 0, doorGoal: 1, doorMeshes: [], doorOf: null,
    charge: 1, healTime: 0, goal: null, target: null, lying: false, pose: 'Idle', weights: { Idle: 1, Move: 0, Speed: 0, HealStand: 0, HealLayDown: 0 },
    siren,
    look: 0, lookGoal: 0, lookNext: 0, lookAt: null, turn: new THREE.Quaternion(), scan: 0,
  };
  placeInside(bot);
  return bot;
}
function removeBot(id) {
  const bot = bots.get(id);
  if (!bot) return;
  letGo(bot);
  bot.mixer.stopAllAction();
  bot.mixer.uncacheRoot(bot.root);
  bot.root.removeFromParent();
  bots.delete(id);
  if (followed === bot) stopFollowingMedBot();
}

// the booth's own terms → the world's, as it stands now
const local = new THREE.Vector3();
function boothPoint(bot, x, y, z) {
  const g = bot.obj.group;
  g.updateMatrixWorld();
  return local.set(x, y, z).applyMatrix4(g.matrixWorld);
}
const boothHeading = bot => bot.obj.rotY;
function placeInside(bot) {
  const at = boothPoint(bot, model.inside.x, model.inside.y, model.inside.z);
  bot.x = at.x; bot.y = at.y; bot.z = at.z;
  bot.heading = boothHeading(bot);
}
const doorstep = bot => boothPoint(bot, model.inside.x, 0, model.front + STEP_OUT).clone();

// ---------------------------------------------------------- the booth's door
// Every mesh of the booth with an Open shape key (it's a few, one a material), found again whenever the booth's rebuilt.
function doorMeshes(bot) {
  if (bot.doorOf === bot.obj.group) return bot.doorMeshes;
  bot.doorOf = bot.obj.group;
  bot.doorMeshes = [];
  bot.obj.group?.traverse(o => { if (o.morphTargetDictionary?.Open != null) bot.doorMeshes.push(o); });
  return bot.doorMeshes;
}
function moveDoor(bot, dt) {
  const step = dt/DOOR_TIME;
  bot.door = bot.doorGoal > bot.door ? Math.min(bot.doorGoal, bot.door + step) : Math.max(bot.doorGoal, bot.door - step);
  const eased = bot.door*bot.door*(3 - 2*bot.door);
  for (const mesh of doorMeshes(bot)) mesh.morphTargetInfluences[mesh.morphTargetDictionary.Open] = eased;
}

// ---------------------------------------------------------- getting about
// Somewhere people could walk (see "people" in people/peoplePathing.js): a pavement, a path, or a plaza or park. With no
// nav yet (nobody out), anywhere goes.
function walkable(x, z) {
  const nav = peopleNav;
  if (!nav) return true;
  if (nav.onPavement(x, z) || nav.onPath(x, z)) return true;
  return nav.areas.some(a => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ && a.inside(x, z));
}
function clearLine(from, x, z) {
  const len = Math.hypot(x - from.x, z - from.z), steps = Math.max(1, Math.ceil(len));
  for (let i = 1; i <= steps; i++) if (!walkable(from.x + (x - from.x)*i/steps, from.z + (z - from.z)*i/steps)) return false;
  return true;
}
// somewhere round the booth to roll to next: walkable, and walkable all the way, if anywhere near is
function patrolPoint(bot) {
  const home = bot.obj;
  for (let tries = 0; tries < 16; tries++) {
    const angle = Math.random()*Math.PI*2, r = (0.25 + 0.75*Math.sqrt(Math.random()))*PATROL_RADIUS;
    const x = home.x + Math.sin(angle)*r, z = home.z + Math.cos(angle)*r;
    if (walkable(x, z) && clearLine(bot, x, z)) return { x, z };
  }
  // (nowhere found: just in front of the booth, somewhere)
  const step = doorstep(bot), angle = Math.random()*Math.PI*2, r = Math.random()*3;
  return { x: step.x + Math.sin(angle)*r, z: step.z + Math.cos(angle)*r };
}
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
function turnTo(bot, heading, dt) {
  const d = wrap(heading - bot.heading);
  bot.heading += Math.sign(d)*Math.min(Math.abs(d), TURN_RATE*dt);
}
// Rolls toward (x, z), `speed` m/s, turning as she goes; true once she's within `within` of it.
function rollTo(bot, x, z, speed, dt, within = 0.15) {
  const dx = x - bot.x, dz = z - bot.z, d = Math.hypot(dx, dz);
  if (d <= within) return true;
  turnTo(bot, Math.atan2(dx, dz), dt);
  // (slowed while she's still turning to face it, so she doesn't swing wide)
  const facing = Math.max(0, Math.cos(wrap(Math.atan2(dx, dz) - bot.heading)));
  const step = Math.min(d - within*0.5, speed*S.peopleSpeed*(0.25 + 0.75*facing)*dt);
  bot.x += dx/d*step; bot.z += dz/d*step;
  return d - step <= within;
}

// ---------------------------------------------------------- who needs her
const lyingDown = p => !!p.punched && (p.punched.stage === 'down' || p.punched.stage === 'crawl');
function needsHealing(p) {
  if (isGone(p) || p.mode === 'indoors' || p.mode === 'possessed' || p.mode === 'drowning' || p.mode === 'leaving') return false;
  if (!p.health || healthFraction(p) >= HEAL_BELOW || p.punched?.revive) return false;
  return !p.medbot;
}
function spot(bot) {
  let best = null, bestD = SIGHT;
  for (const p of people) {
    if (!needsHealing(p)) continue;
    const d = Math.hypot(p.x - bot.x, p.z - bot.z);
    if (d < bestD && Math.hypot(p.x - bot.obj.x, p.z - bot.obj.z) < LEASH && Math.abs(p.y - bot.y) < 1.5) { best = p; bestD = d; }
  }
  return best;
}
function letGo(bot) {
  const p = bot.target;
  bot.target = null;
  if (!p || p.medbot !== bot) return;
  p.medbot = null;
  if (p.please?.medbot) { if (p.please.stage === 'held') p.please.timer = Math.min(p.please.timer, 0.4); else p.please = null; } // (off they go)
  if (p.punched && p.punched.stage === 'down') p.punched.timer = Math.min(p.punched.timer, 0.4); // (and up they get)
}
// where she stands to heal someone: facing them, a hand's reach off — beside them if they're lying down
function healSpot(bot, p, lying) {
  if (!lying) {
    const d = Math.hypot(bot.x - p.x, bot.z - p.z) || 1, off = model.reach + 0.15*S.peopleSize;
    return { x: p.x + (bot.x - p.x)/d*off, z: p.z + (bot.z - p.z)/d*off };
  }
  // (knocked flat on their back: along their side, from whichever side she's coming)
  const side = p.heading + Math.PI/2, sx = Math.sin(side), sz = Math.cos(side);
  const which = (bot.x - p.x)*sx + (bot.z - p.z)*sz >= 0 ? 1 : -1, off = model.reach + 0.1*S.peopleSize;
  return { x: p.x + sx*off*which, z: p.z + sz*off*which };
}
// Keeps someone still to be healed, each frame: on their feet, the hold of being pleased (they look at her and beam); lying
// down, kept down.
function hold(bot, p, lying) {
  if (lying) { if (p.punched?.stage === 'down') p.punched.timer = Math.max(p.punched.timer, 0.5); return; }
  if (!p.please) p.please = { stage: 'held', timer: 0.5, from: { x: bot.x, z: bot.z }, medbot: true }; // (straight to still)
  p.please.stage = 'held';
  p.please.timer = Math.max(p.please.timer, 0.5);
  p.please.medbot = true;
}

// ---------------------------------------------------------- poses
function setPose(bot, pose) {
  if (bot.pose === pose) return;
  bot.pose = pose;
  const action = bot.actions[pose];
  if (action && pose.startsWith('Heal')) { action.reset(); action.play(); }
}
function blendPoses(bot, dt) {
  for (const name in bot.weights) {
    const goal = name === bot.pose ? 1 : 0, w = bot.weights[name];
    bot.weights[name] = goal > w ? Math.min(goal, w + FADE*dt) : Math.max(goal, w - FADE*dt);
    bot.actions[name]?.setEffectiveWeight(bot.weights[name]);
  }
}
const healDone = bot => { const a = bot.actions[bot.pose]; return !a || !a.isRunning(); };

// ---------------------------------------------------------- her head
// looking about, as people do: at someone near now and then, else anywhere, else straight ahead; at whoever she's
// going to heal while she's at it
const UP = new THREE.Vector3(0, 1, 0), undo = new THREE.Quaternion();
function lookAbout(bot, dt, t) {
  let at = bot.target;
  if (!at) {
    if (t >= bot.lookNext) {
      bot.lookNext = t + LOOK_EVERY[0] + Math.random()*(LOOK_EVERY[1] - LOOK_EVERY[0]);
      const near = people.filter(p => !isGone(p) && p.mode !== 'indoors' && Math.hypot(p.x - bot.x, p.z - bot.z) < LOOK_NEAR);
      bot.lookAt = near.length && Math.random() < 0.6 ? near[Math.floor(Math.random()*near.length)] : null;
      bot.lookGoal = bot.lookAt ? 0 : Math.random() < 0.3 ? 0 : (Math.random()*2 - 1)*HEAD_REACH;
    }
    if (bot.lookAt && isGone(bot.lookAt)) bot.lookAt = null;
    at = bot.lookAt;
  }
  if (at) bot.lookGoal = THREE.MathUtils.clamp(wrap(Math.atan2(at.x - bot.x, at.z - bot.z) - bot.heading), -HEAD_REACH, HEAD_REACH);
  bot.look += (bot.lookGoal - bot.look)*Math.min(1, HEAD_EASE*dt);
}

// ---------------------------------------------------------- each frame
function updateBot(bot, dt, t) {
  const p = bot.target;
  const out = bot.state !== 'charging' && bot.state !== 'opening';
  if (out) bot.charge = Math.max(0, bot.charge - DRAIN*dt);
  let pose = 'Idle';
  switch (bot.state) {
    case 'opening': // in the booth, the door opening to let her out
      placeInside(bot);
      bot.doorGoal = 1;
      if (bot.door >= 1) bot.state = 'exiting';
      break;
    case 'exiting': { // rolling out, and down off the booth's floor
      const step = doorstep(bot);
      pose = 'Move';
      bot.heading = boothHeading(bot);
      const inside = boothPoint(bot, model.inside.x, model.inside.y, model.inside.z).clone(), all = Math.hypot(step.x - inside.x, step.z - inside.z) || 1;
      if (rollTo(bot, step.x, step.z, SPEED, dt)) { bot.state = 'patrol'; bot.doorGoal = 0; bot.goal = patrolPoint(bot); }
      bot.y = step.y + (inside.y - step.y)*Math.min(1, Math.hypot(step.x - bot.x, step.z - bot.z)/all);
      break;
    }
    case 'patrol':
      if (bot.charge < LOW) { bot.state = 'home'; break; }
      if ((bot.scan -= dt) <= 0) {
        bot.scan = 0.3;
        const hurt = bot.charge > HEAL_COST ? spot(bot) : null;
        if (hurt) { bot.target = hurt; hurt.medbot = bot; bot.state = 'rush'; break; }
      }
      if (bot.timer > 0) { bot.timer -= dt; break; } // (stopped a moment)
      pose = 'Move';
      if (rollTo(bot, bot.goal.x, bot.goal.z, SPEED, dt)) { bot.goal = patrolPoint(bot); bot.timer = PAUSE[0] + Math.random()*(PAUSE[1] - PAUSE[0]); }
      break;
    case 'rush': {
      if (!p || p.medbot !== bot || isGone(p) || p.mode === 'indoors' || healthFraction(p) >= 1 || Math.hypot(p.x - bot.obj.x, p.z - bot.obj.z) > LEASH*1.2) {
        letGo(bot); bot.state = 'patrol'; bot.goal = patrolPoint(bot); break;
      }
      const lying = lyingDown(p), to = healSpot(bot, p, lying);
      pose = bot.actions.Speed ? 'Speed' : 'Move';
      const still = lying || p.please?.stage === 'held'; // (on their feet: not till they've stopped walking)
      if (rollTo(bot, to.x, to.z, SPEED*RUSH, dt, 0.12) && still) {
        bot.state = 'heal';
        bot.healTime = 0;
        bot.lying = lying;
        setPose(bot, lying ? 'HealLayDown' : 'HealStand');
      }
      if (Math.hypot(p.x - bot.x, p.z - bot.z) < 3) hold(bot, p, lying); // (close now: they stop and wait for her)
      break;
    }
    case 'heal': {
      pose = bot.lying ? 'HealLayDown' : 'HealStand';
      if (!p || isGone(p)) { letGo(bot); bot.state = 'patrol'; bot.goal = patrolPoint(bot); pose = 'Idle'; break; }
      hold(bot, p, bot.lying);
      if (!bot.lying && Math.hypot(p.x - bot.x, p.z - bot.z) > model.reach + 0.6*S.peopleSize) { bot.state = 'rush'; break; } // (drifted off: after them)
      bot.healTime += dt;
      turnTo(bot, Math.atan2(p.x - bot.x, p.z - bot.z), dt);
      const h = personHeight(p);
      if (bot.lying) { // (from their feet to their head, which is behind them: they fell on their back)
        const back = p.heading + Math.PI;
        healFx({ x: p.x - Math.sin(back)*0.45*h, y: p.y, z: p.z - Math.cos(back)*0.45*h }, h, true, back, dt);
      } else healFx({ x: p.x, y: p.y, z: p.z }, h, false, 0, dt);
      if (healDone(bot)) {
        heal(p, p.health.max);
        feel(p, 'healed');
        witness(p, 'healed');
        bot.charge = Math.max(0, bot.charge - HEAL_COST);
        letGo(bot);
        bot.state = 'patrol'; bot.goal = patrolPoint(bot); bot.timer = 0.6;
        pose = 'Idle';
      }
      break;
    }
    case 'home': { // back to the door
      const step = doorstep(bot);
      pose = 'Move';
      if (rollTo(bot, step.x, step.z, SPEED, dt)) { bot.state = 'entering'; bot.doorGoal = 1; }
      break;
    }
    case 'entering': { // door open, in she goes, backwards onto the booth's floor so she faces out
      const step = doorstep(bot), inside = boothPoint(bot, model.inside.x, model.inside.y, model.inside.z).clone();
      bot.doorGoal = 1;
      if (bot.door < 1) { turnTo(bot, boothHeading(bot), dt); break; }
      pose = 'Move';
      const all = Math.hypot(step.x - inside.x, step.z - inside.z) || 1, d = Math.hypot(inside.x - bot.x, inside.z - bot.z);
      const dx = inside.x - bot.x, dz = inside.z - bot.z, move = Math.min(d, SPEED*S.peopleSpeed*dt);
      if (d > 0.01) { bot.x += dx/d*move; bot.z += dz/d*move; }
      turnTo(bot, boothHeading(bot), dt);
      bot.y = step.y + (inside.y - step.y)*(1 - Math.min(1, Math.hypot(inside.x - bot.x, inside.z - bot.z)/all));
      if (d - move <= 0.01) { bot.state = 'charging'; bot.doorGoal = 0; }
      break;
    }
    case 'charging':
      placeInside(bot);
      bot.charge = Math.min(1, bot.charge + dt/CHARGE_TIME);
      if (bot.charge >= 1 && bot.door <= 0) bot.state = 'opening';
      break;
  }
  if (bot.state !== 'heal') setPose(bot, pose);
  bot.siren?.emissive.setRGB(bot.state === 'rush' && (t*FLASH) % 1 < 0.5 ? 1 : 0, 0, 0);
  if (bot.state === 'patrol' || bot.state === 'rush' || bot.state === 'home') bot.y = bot.obj.group.position.y;
  lookAbout(bot, dt, t);
  moveDoor(bot, dt);

  // posed: last frame's head swivel off before the mixer (which only writes a bone when its value changes), and on again after
  if (bot.head) bot.head.quaternion.premultiply(undo.copy(bot.turn).invert());
  blendPoses(bot, dt);
  bot.mixer.update(dt);
  if (bot.head) bot.head.quaternion.premultiply(bot.turn.setFromAxisAngle(UP, bot.look));
  bot.root.position.set(bot.x, bot.y, bot.z);
  bot.root.rotation.y = bot.heading;
}

let lastTime = null;
/**
 * Every med booth's MedBot, each frame: one made for each booth that's been put down, gone with it, and each doing her rounds.
 * @param {number} t - seconds
 * @returns {void}
 */
export function updateMedBots(t) {
  const dt = lastTime == null ? 0 : Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;
  if (!model) return;
  const seen = new Set();
  for (const obj of S.objects) {
    if (obj.type !== 'medbooth' || !obj.group) continue;
    seen.add(obj.id);
    let bot = bots.get(obj.id);
    if (!bot) bots.set(obj.id, bot = makeBot(obj));
    bot.obj = obj; // (an undo brings back the same booth as a new record)
  }
  for (const id of [...bots.keys()]) if (!seen.has(id)) removeBot(id);
  if (!dt) { updateMedBotSounds([]); return; }
  const heard = [];
  bots.forEach(bot => {
    const x = bot.x, z = bot.z;
    updateBot(bot, dt, t);
    if (bot.state === 'charging' || bot.state === 'opening') return; // (shut in her booth)
    heard.push({ bot, x: bot.x, y: bot.y, z: bot.z, speed: Math.hypot(bot.x - x, bot.z - z)/dt/(SPEED*S.peopleSpeed || 1),
      rushing: bot.state === 'rush', healing: bot.state === 'heal',
      healed: bot.state === 'heal' ? bot.healTime/((model.clips[bot.pose]?.duration ?? 1)*HEAL_LOOPS) : 0 });
  });
  updateMedBotSounds(heard);
  followMedBot();
}

// ---------------------------------------------------------- her card, and following her
// As for a pigeon (see pigeons.js): a click on her in World mode puts the camera on her and her card up (see input.js),
// with what she's doing and how much charge she has left.
const card = makeCard({ id: 'medbot-card', title: 'MedBot', onClose: () => App.stopFollowingMedBot() });
const drawThumbnail = makeThumbnailDrawer(card.canvas);
let followed = null, doingShown = null, chargeShown = null;
const FOLLOW_MIN_RADIUS = 1.2, FOLLOW_RADIUS = 7, PICK_PIXELS = 26;

function thumbnailScene() {
  const mesh = cloneSkinned(model.template);
  const mixer = new THREE.AnimationMixer(mesh);
  if (model.clips.Idle) { mixer.clipAction(model.clips.Idle).play(); mixer.setTime(0); }
  mesh.rotation.y = -Math.PI/6;
  const radius = BOT_HEIGHT*0.55, elevation = 0.25, distance = 6;
  const view = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, 20);
  view.position.set(0, BOT_HEIGHT*0.5 + distance*Math.sin(elevation), distance*Math.cos(elevation));
  view.lookAt(0, BOT_HEIGHT*0.5, 0);
  return { mesh, camera: view };
}
const screen = new THREE.Vector3();
function pickMedBot(clientX, clientY, out) {
  const width = window.innerWidth, height = window.innerHeight;
  let best = null, bestDepth = Infinity;
  bots.forEach(bot => {
    if (bot.state === 'charging' || bot.state === 'opening') return; // (shut in the booth)
    screen.set(bot.x, bot.y + BOT_HEIGHT*0.5, bot.z).project(camera);
    if (Math.abs(screen.z) > 1) return;
    const off = Math.hypot((screen.x + 1)/2*width - clientX, (1 - screen.y)/2*height - clientY);
    if (off <= PICK_PIXELS && screen.z < bestDepth) { best = bot; bestDepth = screen.z; }
  });
  if (out && best) out.distance = camera.position.distanceTo(screen.set(best.x, best.y, best.z));
  return best;
}
function followMedBotNow(bot) {
  followed = bot;
  doingShown = chargeShown = null;
  controls.minRadius = FOLLOW_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.minRadius, Math.min(controls.goalRadius, FOLLOW_RADIUS));
  card.show({ name: 'MedBot #' + bot.number, mood: '🩺' });
  if (thumbView) drawThumbnail(thumbView);
  const id = bot.obj.id;
  card.setFavorite({ key: 'medbot:' + id, kind: 'MedBot', follow: () => { const b = bots.get(id); if (b) followMedBotNow(b); return !!b; } });
}
function followMedBotAt(clientX, clientY) {
  const bot = pickMedBot(clientX, clientY);
  if (!bot) { stopFollowingMedBot(); return; }
  followMedBotNow(bot);
}
function stopFollowingMedBot() {
  if (!followed) return;
  followed = null;
  controls.minRadius = CAMERA_MIN_RADIUS;
  controls.goalRadius = Math.max(controls.goalRadius, CAMERA_MIN_RADIUS);
  card.hide();
}
const DOING = { opening: 'Coming out', exiting: 'Coming out', patrol: 'On patrol', rush: 'Rushing to help', heal: 'Healing',
  home: 'Going home to charge', entering: 'Going home to charge', charging: 'Charging' };
function followMedBot() {
  if (!followed) return;
  if (S.interactionMode !== 'move') { stopFollowingMedBot(); return; }
  const bot = followed;
  const doing = bot.state === 'patrol' && bot.timer > 0 ? 'Looking about' : DOING[bot.state];
  if (doing !== doingShown) { doingShown = doing; card.set('status', doing); }
  const charge = Math.round(bot.charge*100) + '%';
  if (charge !== chargeShown) { chargeShown = charge; card.set('charge', charge); }
  controls.goalTarget.set(bot.x, bot.y + BOT_HEIGHT*0.6, bot.z);
}

Object.assign(App, { pickMedBot, followMedBotAt, stopFollowingMedBot, medBots: bots });
