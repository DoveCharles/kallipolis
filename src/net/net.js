// Multiplayer. File > Host Server makes a code; a guest's File > Join Server (or the link, index.html?join=CODE) reloads
// into the host's city. Peer to peer over WebRTC (PeerJS and its free broker); the host's game is the server. The guest
// thinks nothing for itself: the crowd and traffic are drawn as the host last sent them (peopleMirror.js, trafficMirror.js),
// DELAY behind, blended between snapshots. A guest possessing someone sends its keys and view (INPUT_TICK); the host walks
// them (possessRemote in peopleTracking.js). The host's edits go to guests as undo snapshots (history.js), put in as undo
// does (only the zones that changed rebuilt). Everyone's Name shows over whoever they're possessing (nametags.js). A ?join page is never autosaved (project/autosave.js), so leaving — a reload
// without it — puts the guest's own city back.
import { S, App } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { serializeProject, loadProjectFromData } from '../project/save-load.js';
import { modelsLoaded } from '../ui/loading.js';
import { packCrowd } from '../life/people/peopleMirror.js';
import { packTraffic } from '../life/traffic/trafficMirror.js';
import { people } from '../life/people/people.js';
import { possessRemote, releaseRemote, guestRoomAt } from '../life/people/peopleTracking.js';
import { possession, controlInput } from '../life/possession.js';
import { cars } from '../life/traffic/state.js';
import { drivenCar, driveRemote, releaseRemoteCar, stopDriving } from '../life/traffic/driving.js';
import { notePlates } from '../life/traffic/trafficMirror.js';
import { packBees, flyRemote, releaseRemoteBee, beeFlown, stopFlyingBee } from '../life/bees.js';
import { showTags } from './nametags.js';

const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm';
const PREFIX = 'kallipolis-', LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INPUT_TICK = 50, NAME_KEY = 'splinetopia-net-name', NAME_MAX = 24;
const TICK = 100, REACH = 300, DELAY = 0.15, KEEP = 8; // ms between snapshots; sent this far round a guest's view; drawn this far behind (s); snapshots held
const JOIN = new URLSearchParams(location.search).get('join');
let peer = null, role = null, timer = null, myName = '', tags = []; // (tags: [kind, which, name] — guest: as the host last sent)
const links = new Set(); // (host: guests that have loaded the city)
const snaps = [];        // (guest: { at, count, people, cars, bees }, oldest first)
let loaded = null, shown = null, pending = null, applying = false; // (guest: the city's first load; the host's snapshot it's showing; the next to show)

const home = () => { location.href = location.pathname; };
const say = (title, html) => App.messageBox?.(title, html) ?? Promise.resolve(alert(html.replace(/<[^>]+>/g, '')));
async function openPeer(id) {
  const { Peer } = await import(PEERJS);
  return new Promise((resolve, reject) => {
    const p = id ? new Peer(id) : new Peer();
    p.once('open', () => resolve(p));
    p.once('error', reject);
  });
}
const escape = t => t.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
/**
 * A dialog of text fields, asked again till Name isn't blank.
 * @param {string} title
 * @param {string[]} [extra] - other fields' labels, after Name
 * @returns {Promise<?string[]>} the values (Name first, trimmed), or null if cancelled
 */
async function ask(title, extra = []) {
  let values = [localStorage.getItem(NAME_KEY) ?? '', ...extra.map(() => '')], note = '';
  for (;;) {
    const html = ['Name', ...extra].map((label, k) => `<p>${label}:</p><p><input class="net-field" maxlength="${k ? 200 : NAME_MAX}" value="${escape(values[k])}" style="width:100%"></p>`).join('');
    const asked = App.messageBox(title, html + note, ['OK', 'Cancel']);
    const inputs = [...document.querySelectorAll('.w3-dialog .net-field')];
    inputs[values[0] ? 1 : 0]?.focus();
    if (await asked !== 'OK') return null;
    values = inputs.map(input => input.value.trim());
    if (values[0]) { try { localStorage.setItem(NAME_KEY, values[0]); } catch {} return values; }
    note = '<p><b>Name can\'t be blank.</b></p>';
  }
}
// (a typed array as BinaryPack hands it back: an ArrayBuffer, or a view that may not sit on a 4-byte boundary)
const floats = x => x instanceof ArrayBuffer ? new Float32Array(x) : new Float32Array(new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice().buffer);

// ---- host
async function hostServer() {
  if (role) return;
  const named = await ask('Host Server');
  if (!named) return;
  myName = named[0];
  const code = Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random()*LETTERS.length)]).join('');
  try { peer = await openPeer(PREFIX + code); }
  catch (err) { return say('Host Server', `<p>Couldn't start the server (${err.type ?? err.message}).</p>`); }
  role = 'host';
  peer.on('connection', conn => {
    conn.on('open', () => conn.send({ t: 'project', project: serializeProject(), at: controls.goalTarget.toArray() }));
    conn.what = null; conn.plates = new Set();
    conn.on('data', m => {
      if (m?.t === 'ready') { conn.name = String(m.name ?? '').trim().slice(0, NAME_MAX) || 'Guest'; links.add(conn); }
      else if (m?.t === 'cam') conn.cam = m;
      else if (m?.t === 'in') steer(conn, m);
    });
    const drop = () => { links.delete(conn); letGo(conn); };
    conn.on('close', drop);
    conn.on('error', drop);
  });
  timer = setInterval(sendSnapshots, TICK);
  const link = `${location.origin}${location.pathname}?join=${code}`;
  say('Host Server', `<p>Server running. Code: <b>${code}</b></p><p>Link: <input readonly value="${link}" style="width:100%" onclick="this.select()"></p>`);
}
// what a guest has hold of (conn.what, of conn.kind 'person', 'car' or 'bee'), if they still do
function holding(conn) {
  const w = conn.what;
  if (!w || w.remote !== conn.ctl) return false;
  if (conn.kind === 'car') return cars.includes(w) && w.fuse == null && !w.reviving;
  if (conn.kind === 'bee') return !!w.hand && w.state !== 'hive';
  return w.mode === 'possessed' && people.includes(w);
}
function letGo(conn) {
  const w = conn.what;
  conn.what = null;
  if (w?.remote !== conn.ctl) return;
  if (conn.kind === 'car') { if (cars.includes(w)) releaseRemoteCar(w); else w.remote = null; }
  else if (conn.kind === 'bee') releaseRemoteBee(w);
  else releaseRemote(w);
}
// an edit: every guest's sent the city as it is now (see commitHistory in history.js)
function netEdit(snap) {
  if (role === 'host') for (const conn of links) conn.send({ t: 'edit', snap });
}
async function applyEdits() {
  applying = true;
  await loaded;
  while (pending) {
    const data = JSON.parse(pending);
    pending = null;
    await loadProjectFromData(data, { keepMaps: true, prev: shown });
    shown = data;
  }
  App.resetHistory?.();
  applying = false;
}
// a guest's keys and view, for whatever they've hold of (m.kind: 'person' (m.i its slot), 'car' or 'bee'; m.i -1 when they let go)
function steer(conn, m) {
  const ctl = { forward: +m.forward || 0, right: +m.right || 0, run: !!m.run, brake: !!m.brake, yaw: +m.yaw || 0, pitch: +m.pitch || 0, room: null };
  const kind = m.kind ?? 'person', room = m.room, put = m.put, ok = v => v && [v.x, v.y, v.z].every(Number.isFinite);
  if (kind === 'person' && ok(room)) ctl.room = { x: room.x, y: room.y, z: room.z, speed: +room.speed || 0 }; // (in a room of their own: see stepGuestRoom)
  if (conn.what && conn.kind === kind && conn.what[kind === 'bee' ? 'netId' : 'id'] === m.id && holding(conn)) {
    Object.assign(conn.ctl, ctl);
    if (kind === 'person' && ok(put)) { const p = conn.what; p.x = put.x; p.y = put.y; p.z = put.z; p.footing = put.y > 1 ? { kind: 'raised', y: put.y } : null; } // (out of it again, at its door)
    return;
  }
  letGo(conn);
  if (!(m.i >= 0)) return;
  conn.ctl = ctl; conn.kind = kind;
  if (kind === 'car') { const car = cars.find(c => c.id === m.id); conn.what = driveRemote(car, ctl) ? car : null; }
  else if (kind === 'bee') conn.what = flyRemote(m.id, ctl);
  else conn.what = people[m.i]?.id === m.id && possessRemote(m.i, ctl) ? people[m.i] : null;
  if (!conn.what) conn.send({ t: 'out' });
}
// who's holding what: [kind, which (a person's slot, a car's id, a bee's netId), name, conn]
const tagOf = (kind, w) => [kind, kind === 'car' ? w.id : kind === 'bee' ? w.netId : people.indexOf(w)];
function hostTags() {
  const list = [...links].filter(holding).map(c => [...tagOf(c.kind, c.what), c.name, c]);
  if (possession.index >= 0 && people[possession.index]?.mode === 'possessed') list.push(['person', possession.index, myName]);
  if (drivenCar) list.push(['car', drivenCar.id, myName]);
  if (beeFlown()) list.push(['bee', beeFlown().netId, myName]);
  return list;
}
function sendSnapshots() {
  const all = hostTags();
  tags = all.filter(t => t[3]);
  for (const conn of links) {
    if (conn.what && !holding(conn)) { letGo(conn); conn.send({ t: 'out' }); } // (let go of on the host: dead, gone…)
    const x = conn.cam?.x ?? 0, z = conn.cam?.z ?? 0, traffic = packTraffic(x, z, REACH), plates = [];
    for (let r = 27; r < traffic.length; r += 29) { // (each car's plate, the first time this guest sees it: see trafficMirror.js)
      const id = traffic[r];
      if (conn.plates.has(id)) continue;
      conn.plates.add(id);
      const car = cars.find(c => c.id === id);
      if (car?.plate) plates.push([id, car.plate.text]);
    }
    conn.send({ t: 's', time: S.timeOfDay, count: App.people?.length ?? 0, people: packCrowd(x, z, REACH).buffer, cars: traffic.buffer,
      bees: packBees(x, z, REACH).buffer, plates, tags: all.filter(t => t[3] !== conn).map(t => t.slice(0, 3)) });
  }
}

// ---- guest
async function joinDialog() {
  const named = await ask('Join Server', ['Code or link']);
  if (!named) return;
  const code = (named[1].match(/join=([A-Za-z0-9]+)/)?.[1] ?? named[1]).trim().toUpperCase();
  if (!code) return;
  try { sessionStorage.setItem(NAME_KEY, named[0]); } catch {}
  location.href = `${location.pathname}?join=${code}`;
}
async function join(code) {
  S.netGuest = true; // (from the first frame: people.js and traffic.js draw only what's sent; and no editing — see setMode in editor/tools.js)
  document.body.classList.add('net-guest');
  let name = ''; try { name = sessionStorage.getItem(NAME_KEY) ?? ''; } catch {}
  if (!name) { await modelsLoaded; name = (await ask('Join Server'))?.[0]; if (!name) return home(); } // (came by the link)
  try { sessionStorage.setItem(NAME_KEY, name); } catch {}
  myName = name;
  try { peer = await openPeer(); }
  catch (err) { await say('Join Server', `<p>Couldn't connect (${err.type ?? err.message}).</p>`); return home(); }
  role = 'guest';
  peer.on('error', async err => { await say('Join Server', `<p>${err.type === 'peer-unavailable' ? `No server with the code ${code}.` : `Connection lost (${err.type}).`}</p>`); home(); });
  const conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: true });
  conn.on('data', async m => {
    if (m?.t === 'project') {
      let done; loaded = new Promise(r => { done = r; });
      await modelsLoaded;
      await loadProjectFromData(m.project);
      App.resetHistory?.();
      shown = JSON.parse(App.historyNow());
      done();
      document.querySelector('#mode-toolbar .tool-btn[data-mode="move"]')?.click();
      if (Array.isArray(m.at)) controls.goalTarget.fromArray(m.at);
      conn.send({ t: 'ready', name: myName });
      timer = setInterval(() => conn.send({ t: 'cam', x: controls.target.x, z: controls.target.z }), 200);
      let was = false, roomed = false;
      setInterval(() => {
        const i = possession.index, bee = beeFlown(), keys = controlInput(), p = people[i], room = i >= 0 ? guestRoomAt(p) : null;
        const put = roomed && !room && p ? { x: p.x, y: p.y, z: p.z } : undefined; // (just walked out: where)
        roomed = !!room;
        if (i >= 0) conn.send({ t: 'in', kind: 'person', i, id: p?.id, ...keys, yaw: possession.yaw, pitch: possession.pitch, room, put });
        else if (drivenCar) conn.send({ t: 'in', kind: 'car', i: 0, id: drivenCar.id, ...keys });
        else if (bee) conn.send({ t: 'in', kind: 'bee', i: 0, id: bee.netId, ...keys });
        else if (was) conn.send({ t: 'in', i: -1 });
        was = i >= 0 || !!drivenCar || !!bee;
      }, INPUT_TICK);
    } else if (m?.t === 's') {
      snaps.push({ at: performance.now()/1000, count: m.count, people: floats(m.people), cars: floats(m.cars), bees: floats(m.bees ?? new ArrayBuffer(0)) });
      notePlates(m.plates);
      if (snaps.length > KEEP) snaps.shift();
      S.timeOfDay = m.time;
      tags = Array.isArray(m.tags) ? m.tags : [];
    } else if (m?.t === 'edit') { pending = m.snap; if (!applying) applyEdits(); }
    else if (m?.t === 'out') { App.unpossessPerson?.(); stopDriving(); stopFlyingBee(); } // (the host wouldn't, or no longer does)
  });
  conn.on('close', async () => { await say('Join Server', '<p>The host has closed the server.</p>'); home(); });
}
/**
 * The two snapshots either side of now less DELAY, and how far between them (0–1); null before any's come.
 * @returns {?{a: object, b: object, f: number}}
 */
function netPair() {
  if (!snaps.length) return null;
  const at = performance.now()/1000 - DELAY, i = snaps.findIndex(s => s.at >= at);
  if (i < 0) { const s = snaps[snaps.length - 1]; return { a: s, b: s, f: 1 }; }
  if (i === 0) return { a: snaps[0], b: snaps[0], f: 1 };
  const a = snaps[i - 1], b = snaps[i];
  return { a, b, f: (at - a.at)/Math.max(1e-3, b.at - a.at) };
}

function leaveServer() {
  if (role === 'guest') return home();
  clearInterval(timer);
  links.forEach(letGo);
  links.clear();
  tags = [];
  peer?.destroy();
  peer = role = null;
}

showTags(() => tags);
Object.assign(App, { netEdit, hostServer, joinServer: joinDialog, leaveServer, netRole: () => role ?? (JOIN ? 'guest' : null), netPair });
if (JOIN) join(JOIN);
