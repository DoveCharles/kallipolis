// Makes real lines' samples away from the page (see dictionary.js): { id, voice, options } comes back as
// { id, sound } (speech.js lineSound; null if nothing to say), its buffers handed over rather than copied.
import { lineSound } from './speech.js';
self.onmessage = ({ data: { id, voice, options } }) => {
  const sound = lineSound(voice, options);
  self.postMessage({ id, sound }, sound ? [sound.samples.buffer, sound.mouth.buffer] : []);
};
