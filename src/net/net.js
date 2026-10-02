// Multiplayer. File > Host Server makes a code; a guest's File > Join Server (or the link, index.html?join=CODE) reloads
// into the host's city. Peer to peer over WebRTC (PeerJS and its free broker); the host's game is the server. The guest
// thinks nothing for itself: the crowd and traffic are drawn as the host last sent them (peopleMirror.js, trafficMirror.js),
// DELAY behind, blended between snapshots. A guest possessing someone sends its keys and view (INPUT_TICK); the host walks
// them (possessRemote in peopleTracking.js). Everyone's Name shows over whoever they're possessing (nametags.js). A ?join page is never autosaved (project/autosave.js), so leaving — a reload
// without it — puts the guest's own city back.
import { S, App } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { serializeProject, loadProjectFromData } from '../project/save-load.js';
import { modelsLoaded } from '../ui/loading.js';
import { packCrowd } from '../life/people/peopleMirror.js';
import { packTraffic } from '../life/traffic/trafficMirror.js';
import { people } from '../life/people/people.js';
import { possessRemote, releaseRemote } from '../life/people/peopleTracking.js';
import { possession, controlInput } from '../life/possession.js';
import { showTags } from './nametags.js';

const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm';
const PREFIX = 'kallipolis-', LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INPUT_TICK = 50, NAME_KEY = 'splinetopia-net-name', NAME_MAX = 24;
const TICK = 100, REACH = 300, DELAY = 0.15, KEEP = 8; // ms between snapshots; sent this far round a guest's view; drawn this far behind (s); snapshots held
const JOIN = new URLSearchParams(location.search).get('join');
let peer = null, role = null, timer = null, myName = '', tags = []; // (tags: [slot, name] — guest: as the host last sent)
const links = new Set(); // (host: guests that have loaded the city)
const snaps = [];        // (guest: { at, count, people, cars }, oldest first)

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
    conn.slot = -1;
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
function letGo(conn) {
  const p = people[conn.slot];
  if (p?.remote === conn.ctl) releaseRemote(p);
  conn.slot = -1;
}
// a guest's keys and view, for whoever they're possessing (m.i: -1 when they let go)
function steer(conn, m) {
  const ctl = { forward: +m.forward || 0, right: +m.right || 0, run: !!m.run, brake: !!m.brake, yaw: +m.yaw || 0, pitch: +m.pitch || 0 };
  if (m.i === conn.slot && conn.slot >= 0 && people[conn.slot]?.remote === conn.ctl) { Object.assign(conn.ctl, ctl); return; }
  letGo(conn);
  if (!(m.i >= 0)) return;
  conn.ctl = ctl;
  if (people[m.i]?.id === m.id && possessRemote(m.i, ctl)) conn.slot = m.i;
  else conn.send({ t: 'out' });
}
// who's possessing whom: [slot, name]
function hostTags() {
  const list = [...links].filter(c => c.slot >= 0 && people[c.slot]?.remote === c.ctl && people[c.slot].mode === 'possessed').map(c => [c.slot, c.name, c]);
  if (possession.index >= 0 && people[possession.index]?.mode === 'possessed') list.push([possession.index, myName]);
  return list;
}
function sendSnapshots() {
  const all = hostTags();
  tags = all.filter(t => t[2]);
  for (const conn of links) {
    const q = people[conn.slot];
    if (conn.slot >= 0 && (q?.remote !== conn.ctl || q.mode !== 'possessed')) { letGo(conn); conn.send({ t: 'out' }); } // (let go of on the host: dead, gone…)
    const x = conn.cam?.x ?? 0, z = conn.cam?.z ?? 0;
    conn.send({ t: 's', time: S.timeOfDay, count: App.people?.length ?? 0, people: packCrowd(x, z, REACH).buffer, cars: packTraffic(x, z, REACH).buffer,
      tags: all.filter(t => t[2] !== conn).map(([i, name]) => [i, name]) });
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
      await modelsLoaded;
      await loadProjectFromData(m.project);
      App.resetHistory?.();
      document.querySelector('#mode-toolbar .tool-btn[data-mode="move"]')?.click();
      if (Array.isArray(m.at)) controls.goalTarget.fromArray(m.at);
      conn.send({ t: 'ready', name: myName });
      timer = setInterval(() => conn.send({ t: 'cam', x: controls.target.x, z: controls.target.z }), 200);
      let was = -1;
      setInterval(() => {
        const i = possession.index;
        if (i >= 0) conn.send({ t: 'in', i, id: people[i]?.id, ...controlInput(), yaw: possession.yaw, pitch: possession.pitch });
        else if (was >= 0) conn.send({ t: 'in', i: -1 });
        was = i;
      }, INPUT_TICK);
    } else if (m?.t === 's') {
      snaps.push({ at: performance.now()/1000, count: m.count, people: floats(m.people), cars: floats(m.cars) });
      if (snaps.length > KEEP) snaps.shift();
      S.timeOfDay = m.time;
      tags = Array.isArray(m.tags) ? m.tags : [];
    } else if (m?.t === 'out') App.unpossessPerson?.(); // (the host wouldn't, or no longer does)
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
Object.assign(App, { hostServer, joinServer: joinDialog, leaveServer, netRole: () => role ?? (JOIN ? 'guest' : null), netPair });
if (JOIN) join(JOIN);
