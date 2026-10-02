// Multiplayer. File > Host Server makes a code; a guest's File > Join Server (or the link, index.html?join=CODE) reloads
// into the host's city. Peer to peer over WebRTC (PeerJS and its free broker); the host's game is the server. The guest
// thinks nothing for itself: the crowd and traffic are drawn as the host last sent them (peopleMirror.js, trafficMirror.js),
// DELAY behind, blended between snapshots. A ?join page is never autosaved (project/autosave.js), so leaving — a reload
// without it — puts the guest's own city back.
import { S, App } from '../core/shared.js';
import { controls } from '../core/camera-controls.js';
import { serializeProject, loadProjectFromData } from '../project/save-load.js';
import { modelsLoaded } from '../ui/loading.js';
import { packCrowd } from '../life/people/peopleMirror.js';
import { packTraffic } from '../life/traffic/trafficMirror.js';

const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm';
const PREFIX = 'kallipolis-', LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICK = 100, REACH = 300, DELAY = 0.15, KEEP = 8; // ms between snapshots; sent this far round a guest's view; drawn this far behind (s); snapshots held
const JOIN = new URLSearchParams(location.search).get('join');
let peer = null, role = null, timer = null;
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
// (a typed array as BinaryPack hands it back: an ArrayBuffer, or a view that may not sit on a 4-byte boundary)
const floats = x => x instanceof ArrayBuffer ? new Float32Array(x) : new Float32Array(new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice().buffer);

// ---- host
async function hostServer() {
  if (role) return;
  const code = Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random()*LETTERS.length)]).join('');
  try { peer = await openPeer(PREFIX + code); }
  catch (err) { return say('Host Server', `<p>Couldn't start the server (${err.type ?? err.message}).</p>`); }
  role = 'host';
  peer.on('connection', conn => {
    conn.on('open', () => conn.send({ t: 'project', project: serializeProject(), at: controls.goalTarget.toArray() }));
    conn.on('data', m => { if (m?.t === 'ready') links.add(conn); else if (m?.t === 'cam') conn.cam = m; });
    conn.on('close', () => links.delete(conn));
    conn.on('error', () => links.delete(conn));
  });
  timer = setInterval(sendSnapshots, TICK);
  const link = `${location.origin}${location.pathname}?join=${code}`;
  say('Host Server', `<p>Server running. Code: <b>${code}</b></p><p>Link: <input readonly value="${link}" style="width:100%" onclick="this.select()"></p>`);
}
function sendSnapshots() {
  for (const conn of links) {
    const x = conn.cam?.x ?? 0, z = conn.cam?.z ?? 0;
    conn.send({ t: 's', time: S.timeOfDay, count: App.people?.length ?? 0, people: packCrowd(x, z, REACH).buffer, cars: packTraffic(x, z, REACH).buffer });
  }
}

// ---- guest
async function joinDialog() {
  const asked = App.messageBox?.('Join Server', '<p>Code or link:</p><p><input id="net-code" style="width:100%"></p>', ['OK', 'Cancel']);
  const input = document.getElementById('net-code');
  let typed = '';
  input?.addEventListener('input', () => { typed = input.value; });
  input?.focus();
  if (await asked !== 'OK') return;
  const code = (typed.match(/join=([A-Za-z0-9]+)/)?.[1] ?? typed).trim().toUpperCase();
  if (code) location.href = `${location.pathname}?join=${code}`;
}
async function join(code) {
  S.netGuest = true; // (from the first frame: people.js and traffic.js draw only what's sent)
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
      if (Array.isArray(m.at)) controls.goalTarget.fromArray(m.at);
      conn.send({ t: 'ready' });
      timer = setInterval(() => conn.send({ t: 'cam', x: controls.target.x, z: controls.target.z }), 200);
    } else if (m?.t === 's') {
      snaps.push({ at: performance.now()/1000, count: m.count, people: floats(m.people), cars: floats(m.cars) });
      if (snaps.length > KEEP) snaps.shift();
      S.timeOfDay = m.time;
    }
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
  links.clear();
  peer?.destroy();
  peer = role = null;
}

Object.assign(App, { hostServer, joinServer: joinDialog, leaveServer, netRole: () => role ?? (JOIN ? 'guest' : null), netPair });
if (JOIN) join(JOIN);
