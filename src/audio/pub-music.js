import { listener, heardFrom } from './sfx.js';
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
const VOLUME = 0.5;
const TONE_HZ = 6500;           // the speaker's top end
const REF_DISTANCE = 4, MAX_DISTANCE = 30;
const DRIFT = 1;                // seconds off the clock before it's set back
const FADE = 0.8;
const context = listener.context;

// ---------------------------------------------------------- the player
// Loaded once: the songs (each file's bytes, and how long it lasts), the synth with the sound bank in it, the
// sequencer that plays a song through it, and where it's mixed (out → the speaker's tone → a panner, to the ear).
let loading = null, player = null;
function load() {
  loading ??= (async () => {
    const [{ WorkletSynthesizer, Sequencer }, { BasicMIDI }] = await Promise.all([import('spessasynth_lib'), import('spessasynth_core')]);
    const index = await fetch(MUSIC_DIR + 'index.txt').then(r => r.ok ? r.text() : '').catch(() => '');
    const songs = (await Promise.all(index.split('\n').map(line => line.trim()).filter(Boolean).map(async path => {
      try {
        const binary = await fetch(MUSIC_DIR + encodeURI(path)).then(r => r.arrayBuffer());
        const { duration } = BasicMIDI.fromArrayBuffer(binary.slice(0), path);
        return duration > 0 ? { name: path.replace(/\.midi?$/i, ''), binary, duration } : null;
      } catch (err) { console.warn(`pub music: couldn't read ${path}`, err); return null; }
    }))).filter(Boolean);
    if (!songs.length) return;
    const [bank] = await Promise.all([fetch(SOUND_BANK).then(r => r.arrayBuffer()), context.audioWorklet.addModule(PROCESSOR)]);
    const synth = new WorkletSynthesizer(context);
    await synth.soundBankManager.addSoundBank(bank, 'main');
    await synth.isReady;
    const sequencer = new Sequencer(synth, { skipToFirstNoteOn: false, initialPlaybackRate: 1 });
    sequencer.loopCount = 0;
    const out = context.createGain(), tone = context.createBiquadFilter(), panner = context.createPanner();
    out.gain.value = 0;
    tone.type = 'lowpass'; tone.frequency.value = TONE_HZ; tone.Q.value = 0.5;
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'linear';
    panner.refDistance = REF_DISTANCE; panner.maxDistance = MAX_DISTANCE;
    synth.connect(out);
    out.connect(tone).connect(panner);
    player = { songs, synth, sequencer, out, panner, pub: null, song: null, quiet: null };
  })().catch(err => console.warn('pub music: no music', err));
  return player;
}

/** Every song, in this pub's order, and how long it takes to go round them all. */
function orderOf(key) {
  const rng = mulberry32(hashNameToNumber(key + ' jukebox'));
  const order = player.songs.map(song => ({ song, sort: rng() })).sort((a, b) => a.sort - b.sort).map(({ song }) => song);
  return { order, round: order.reduce((sum, song) => sum + song.duration + SONG_GAP, 0) };
}

/** Where the pub is in its songs now, by the clock: the song, and how far into it (negative: the gap before it). */
function nowPlaying(key) {
  const { order, round } = orderOf(key);
  let into = (Date.now()/1000 + hashNameToNumber(key + ' jukebox start')) % round;
  for (const song of order) {
    if (into < SONG_GAP) return { song, into: into - SONG_GAP };
    into -= SONG_GAP;
    if (into < song.duration) return { song, into };
    into -= song.duration;
  }
  return { song: order[0], into: 0 };
}

/** The sequencer stopped, and every note let go. */
function hush() {
  if (!player.sequencer.paused) player.sequencer.pause();
  player.synth.stopAll(true);
}

/**
 * The pub's music for a frame, while the view's in an occupied pub: faded in if it isn't on, and kept to where the
 * pub is in its songs.
 * @param {string} key - the pub's building key (see buildingKey)
 * @param {{x: number, y: number, z: number}} at - where it's heard from
 * @returns {void}
 */
export function pubMusic(key, at) {
  if (!load() || context.state !== 'running') return;
  const { sequencer, out, panner } = player;
  if (player.pub !== key) {
    clearTimeout(player.quiet);
    player.pub = key;
    panner.disconnect();
    panner.connect(heardFrom(at, 'music'));
    const now = context.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(VOLUME, now + FADE);
  }
  panner.positionX.value = at.x; panner.positionY.value = at.y; panner.positionZ.value = at.z;

  const { song, into } = nowPlaying(key);
  if (player.song !== song) {
    hush();
    player.song = song;
    sequencer.loadNewSongList([{ binary: song.binary, fileName: song.name }]);
    return;
  }
  if (sequencer.isLoading) return;
  if (into < 0) { if (!sequencer.paused) hush(); return; }
  if (sequencer.paused || Math.abs(sequencer.currentTime - into) > DRIFT) {
    sequencer.currentTime = into;
    if (sequencer.paused) sequencer.play();
  }
}

/** The music faded out (the view's left the pub, or the last person has); nothing if none's on. */
export function stopPubMusic() {
  if (!player?.pub) return;
  const { out } = player, now = context.currentTime;
  out.gain.cancelScheduledValues(now);
  out.gain.setValueAtTime(out.gain.value, now);
  out.gain.linearRampToValueAtTime(0, now + FADE);
  player.pub = null;
  player.quiet = setTimeout(() => { hush(); player.song = null; }, FADE*1000);
}

/** The name of the song the pub's playing (its file's), or null if there's no music on. */
export const pubSong = () => player?.pub && !player.sequencer.paused ? player.song?.name ?? null : null;
