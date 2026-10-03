import { listener, heardFrom, loopPanning, placePanner, makePanner } from './sfx.js';
import { hashNameToNumber, mulberry32 } from '../core/math.js';

// ============================================================ pub music
// While the view's in a pub with anyone in it (see buildings/interior.js), there's music on: the MIDI files in
// assets/music/ (listed in its index.txt, which serve.py keeps up to date: drop a .mid in and it's on), played by
// SpessaSynth (spessasynth_lib, a SoundFont synth in an AudioWorklet) with TimGM6mb.sf2 — a small General MIDI sound bank,
// every instrument and the drums in 6MB, by Tim Brechbill, GPL v2. The only sound in the game that isn't synthesized
// from scratch. None of it's fetched until the first time a pub's music is wanted.
//
// Every pub has the songs in its own order, round and round with SONG_GAP between, and is always somewhere in them by
// the clock, playing or not: walk in, and it's partway through a song; walk out and back, and it's gone on without you.
// Each frame the pub's place in its songs is worked out afresh and the sequencer kept to it (the right song loaded,
// paused through the gaps, set back on time if it's wandered DRIFT off it, as it does when the tab's been away). The
// music comes from up by the ceiling at the middle of the room, a bit dulled (TONE_HZ) like a speaker in a pub, and
// fades out over FADE when you leave or the last person does.
const MUSIC_DIR = 'assets/music/';
const SOUND_BANK = MUSIC_DIR + 'TimGM6mb.sf2';
const PROCESSOR = 'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.3.14/dist/spessasynth_processor.min.js'; // (as in index.html's import map)
const SONG_GAP = 6;             // seconds between songs
const VOLUME = { pub: 0.11, restaurant: 0.04, greek: 0.04, sushi: 0.04, convenience: 0.07 }; // (restaurants: quiet, in the background)
const SET_OF = path => path.startsWith('restaurant/') ? 'restaurant' : path.startsWith('restaurant-greek/') ? 'greek' : path.startsWith('restaurant-sushi/') ? 'sushi' : path.startsWith('convenience/') ? 'convenience' : 'pub'; // (assets/music/restaurant/, restaurant-greek/, restaurant-sushi/, convenience/: theirs only)
const TONE_HZ = 6500;           // the speaker's top end
const TINNY = { convenience: [700, 3800] }; // sets through a cheap ceiling speaker: [low cut, top end] Hz
const REF_DISTANCE = 4, MAX_DISTANCE = 30;
const DRIFT = 1;                // seconds off the clock before it's set back
const FADE = 0.8;
const context = listener.context;

// ---------------------------------------------------------- the players
// Loaded once: the songs (each file's bytes, and how long it lasts), the sound bank, and one player — synth with the
// bank in it, sequencer, and mix (out → two high-passes → the tone → a panner, to the ear) — shared by the room's music
// and the headphones', the room's first.
let loading = null, shared = null, player = null, roomLoading = null;
function loadShared() {
  loading ??= (async () => {
    const [{ WorkletSynthesizer, Sequencer }, { BasicMIDI }] = await Promise.all([import('spessasynth_lib'), import('spessasynth_core')]);
    const index = await fetch(MUSIC_DIR + 'index.txt').then(r => r.ok ? r.text() : '').catch(() => '');
    const songs = (await Promise.all(index.split('\n').map(line => line.trim()).filter(Boolean).map(async path => {
      try {
        const binary = await fetch(MUSIC_DIR + encodeURI(path)).then(r => r.arrayBuffer());
        const { duration } = BasicMIDI.fromArrayBuffer(binary.slice(0), path);
        return duration > 0 ? { name: path.replace(/\.midi?$/i, ''), set: SET_OF(path), binary, duration } : null;
      } catch (err) { console.warn(`pub music: couldn't read ${path}`, err); return null; }
    }))).filter(Boolean);
    if (!songs.length) return;
    const [bank] = await Promise.all([fetch(SOUND_BANK).then(r => r.arrayBuffer()), context.audioWorklet.addModule(PROCESSOR)]);
    shared = { songs, bank, WorkletSynthesizer, Sequencer };
  })().catch(err => console.warn('pub music: no music', err));
  return shared;
}
async function makePlayer({ bank, WorkletSynthesizer, Sequencer }) {
  const synth = new WorkletSynthesizer(context);
  await synth.soundBankManager.addSoundBank(bank, 'main');
  await synth.isReady;
  const sequencer = new Sequencer(synth, { skipToFirstNoteOn: false, initialPlaybackRate: 1 });
  sequencer.loopCount = 0;
  const out = context.createGain(), tone = context.createBiquadFilter(), low = context.createBiquadFilter(), low2 = context.createBiquadFilter(), panner = makePanner(context, loopPanning());
  out.gain.value = 0;
  tone.type = 'lowpass'; tone.frequency.value = TONE_HZ; tone.Q.value = 0.5;
  low.type = low2.type = 'highpass'; low.frequency.value = low2.frequency.value = 20; low.Q.value = low2.Q.value = 0.9;
  panner.distanceModel = 'linear';
  panner.refDistance = REF_DISTANCE; panner.maxDistance = MAX_DISTANCE;
  synth.connect(out);
  out.connect(low).connect(low2).connect(tone).connect(panner);
  return { synth, sequencer, out, tone, low, low2, panner, pub: null, song: null, quiet: null };
}
function load() {
  if (!loadShared()) return null;
  roomLoading ??= makePlayer(shared).then(p => { player = p; }).catch(err => console.warn('pub music: no player', err));
  return player;
}

/** Every song (of the set), in this pub's order, and how long it takes to go round them all. */
function orderOf(key, set) {
  const rng = mulberry32(hashNameToNumber(key + ' jukebox'));
  const order = shared.songs.filter(song => song.set === set).map(song => ({ song, sort: rng() })).sort((a, b) => a.sort - b.sort).map(({ song }) => song);
  return { order, round: order.reduce((sum, song) => sum + song.duration + SONG_GAP, 0) };
}

// how far on each pub's been put by its jukebox (skipPubSong), in seconds, by key
const skipped = new Map();

/** Where the pub is in its songs now, by the clock: the song, and how far into it (negative: the gap before it). */
function nowPlaying(key, set = 'pub') {
  const { order, round } = orderOf(key, set);
  if (!order.length) return { song: null, into: 0 };
  let into = (Date.now()/1000 + hashNameToNumber(key + ' jukebox start') + (skipped.get(key) ?? 0)) % round;
  for (const song of order) {
    if (into < SONG_GAP) return { song, into: into - SONG_GAP };
    into -= SONG_GAP;
    if (into < song.duration) return { song, into };
    into -= song.duration;
  }
  return { song: order[0], into: 0 };
}

/** The sequencer stopped, and every note let go. */
function hush(pl = player) {
  if (!pl.sequencer.paused) pl.sequencer.pause();
  pl.synth.stopAll(true);
}

/**
 * The pub's music for a frame, while the view's in an occupied pub: faded in if it isn't on, and kept to where the
 * pub is in its songs.
 * @param {string} key - the pub's building key (see buildingKey)
 * @param {{x: number, y: number, z: number}} at - where it's heard from
 * @param {'pub'|'restaurant'|'greek'|'sushi'|'convenience'} [set] - which songs
 * @returns {void}
 */
export function pubMusic(key, at, set = 'pub') {
  if (!load() || context.state !== 'running') return;
  keepTo(player, key, at, set, { band: TINNY[set] ?? [20, TONE_HZ], volume: VOLUME[set], ref: REF_DISTANCE, max: MAX_DISTANCE });
}

const isPhones = key => !!key?.startsWith('phones ');

/** The music faded out (the view's left the pub, or the last person has); nothing if none's on. */
export function stopPubMusic() { if (player?.pub && !isPhones(player.pub)) fadeOut(player); }

/** A player for a frame: faded in on `key`'s songs (from `at`, through [low cut, top end] — the cut twice if `steep` —
 * at `volume`, fading out from `ref` to `max` metres) if it isn't on them, and kept to where they are by the clock. */
function keepTo(pl, key, at, set, { band: [cut, top], steep = false, volume, ref, max }) {
  const { sequencer, out, panner } = pl;
  if (pl.pub !== key) {
    clearTimeout(pl.quiet);
    pl.pub = key;
    panner.disconnect();
    panner.connect(heardFrom(at, 'music'));
    pl.low.frequency.value = cut; pl.low2.frequency.value = steep ? cut : 20; pl.tone.frequency.value = top;
    panner.refDistance = ref; panner.maxDistance = max;
    const now = context.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(volume, now + FADE);
  }
  placePanner(panner, at.x, at.y, at.z);

  const { song, into } = nowPlaying(key, set);
  if (!song) return;
  if (pl.song !== song) {
    hush(pl);
    pl.song = song;
    sequencer.loadNewSongList([{ binary: song.binary, fileName: song.name }]);
    return;
  }
  if (sequencer.isLoading) return;
  if (into < 0) { if (!sequencer.paused) hush(pl); return; }
  if (sequencer.paused || Math.abs(sequencer.currentTime - into) > DRIFT) {
    sequencer.currentTime = into;
    if (sequencer.paused) sequencer.play();
  }
}

function fadeOut(pl) {
  if (!pl?.pub) return;
  const { out } = pl, now = context.currentTime;
  out.gain.cancelScheduledValues(now);
  out.gain.setValueAtTime(out.gain.value, now);
  out.gain.linearRampToValueAtTime(0, now + FADE);
  pl.pub = null;
  pl.quiet = setTimeout(() => { hush(pl); pl.song = null; }, FADE*1000);
}

// ---------------------------------------------------------- headphones
// Someone in the 🎵 mood wears headphones (see people.js): the nearest within HEADPHONE_REACH is heard leaking out of
// them, the pub's songs (each wearer their own order, by the clock) through a steep high-pass (PHONES_HZ, twice) — all
// tinny treble, no body — from their head, gone by HEADPHONE_REACH. Only while no room's music is on (one player for both).
export const HEADPHONE_REACH = 5;
const PHONES_HZ = [2400, 9000], PHONES_VOLUME = 0.08, PHONES_REF = 0.5;

/**
 * The headphones' music for a frame, while someone wearing them is the nearest in reach.
 * @param {number} id - their person id
 * @param {{x: number, y: number, z: number}} at - their head
 * @returns {void}
 */
export function headphoneMusic(id, at) {
  if (!load() || context.state !== 'running' || (player.pub && !isPhones(player.pub))) return;
  keepTo(player, 'phones ' + id, at, 'pub', { band: PHONES_HZ, steep: true, volume: PHONES_VOLUME, ref: PHONES_REF, max: HEADPHONE_REACH });
}

/** The headphones' music faded out (no one wearing them in reach). */
export function stopHeadphoneMusic() { if (isPhones(player?.pub)) fadeOut(player); }

/** The name of the song the pub's playing (its file's), or null if there's no music on. */
export const pubSong = () => player?.pub && !isPhones(player.pub) && !player.sequencer.paused ? player.song?.name ?? null : null;

/** The song this pub's on (or about to be, between songs), by its title — its file's name, without any folder — or null
 * before the songs are loaded. */
export const pubSongTitle = key => player ? nowPlaying(key).song?.name.replace(/^.*\//, '') : null;

/**
 * The pub's jukebox played: straight on to the start of its next song, the one it's on cut off.
 * @param {string} key - the pub's building key
 * @returns {void}
 */
export function skipPubSong(key) {
  if (!player) return;
  const { song, into } = nowPlaying(key);
  if (!song) return;
  // (from where it is — in it, or in the gap before it — to its end, then over the gap before the next, just into it)
  skipped.set(key, (skipped.get(key) ?? 0) + song.duration - into + SONG_GAP + 0.01);
  if (player.pub === key) hush();
}
