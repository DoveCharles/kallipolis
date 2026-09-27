// Builds ZzFX sounds' samples away from the page (see prewarm in sfx.js): a message { id, layer } comes back as
// { id, samples }, the samples' buffer handed over rather than copied. ZzFX makes itself an AudioContext as it loads, which
// a worker hasn't got; all it wants of it here is the sample rate.
self.AudioContext ??= class { constructor() { this.sampleRate = 44100; } };
// (listening straight away, as anything sent before there's a listener is lost: what comes in while ZzFX loads waits)
const queued = [];
let ZZFX = null;
const build = ({ id, layer }) => {
  const samples = Float32Array.from(ZZFX.buildSamples(...layer));
  self.postMessage({ id, samples }, [samples.buffer]);
};
self.onmessage = ({ data }) => { if (ZZFX) build(data); else queued.push(data); };
import('https://cdn.jsdelivr.net/npm/zzfx@1.3.2/ZzFX.js').then(module => {
  ZZFX = module.ZZFX;
  ZZFX.volume = 1; // (as sfx.js has it: the listener's gain sets the level)
  queued.splice(0).forEach(build);
});
