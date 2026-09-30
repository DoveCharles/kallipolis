// The last thing before the speakers (see sfx.js): a lookahead brick-wall limiter. The input's held back LOOKAHEAD; the gain
// each sample needs to stay under the ceiling is held at its lowest while that sample's held back, and averaged over the
// same span, so it's already down when a peak comes out, eased in rather than stepped (no fuzz), and eases back up over `release`.
const LOOKAHEAD = 0.005;
class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ceiling', defaultValue: 0.9, minValue: 0.01, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.2, minValue: 0.01, maxValue: 5, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    const n = this.n = Math.max(1, Math.round(LOOKAHEAD*sampleRate)), m = n + 1;
    this.delayL = new Float32Array(n); this.delayR = new Float32Array(n); // (the held-back input)
    this.avg = new Float64Array(n).fill(1); this.sum = n;                // (the last n gains, and their sum)
    this.need = new Float32Array(m);  // (the gain each of the last m samples needs, by position % m)
    this.dq = new Float64Array(m + 1); // (positions whose needs rise from head to tail: the head's the lowest held)
    this.head = 0; this.tail = 0; this.count = 0;
    this.env = 1; this.pos = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0], outL = outputs[0][0], outR = outputs[0][1];
    const ceiling = parameters.ceiling[0], release = parameters.release[0];
    const { n, need, dq, avg, delayL, delayR } = this, m = n + 1, size = dq.length;
    const rel = 1 - Math.exp(-1/(release*sampleRate)), frames = outL.length;
    const inL = input && input[0], inR = input && (input[1] || input[0]);
    for (let i = 0; i < frames; i++) {
      const l = inL ? inL[i] : 0, r = inR ? inR[i] : 0, peak = Math.max(Math.abs(l), Math.abs(r));
      const pos = this.pos++, g = peak > ceiling ? ceiling/peak : 1;
      need[pos % m] = g;
      while (this.count && dq[this.head] <= pos - m) { this.head = (this.head + 1) % size; this.count--; }
      while (this.count && need[dq[(this.tail - 1 + size) % size] % m] >= g) { this.tail = (this.tail - 1 + size) % size; this.count--; }
      dq[this.tail] = pos; this.tail = (this.tail + 1) % size; this.count++;
      const lowest = need[dq[this.head] % m];
      this.env = lowest < this.env ? lowest : this.env + (lowest - this.env)*rel;
      const k = pos % n;
      this.sum += this.env - avg[k];
      avg[k] = this.env;
      const gain = Math.min(1, this.sum/n);
      outL[i] = delayL[k]*gain;
      if (outR) outR[i] = delayR[k]*gain;
      delayL[k] = l; delayR[k] = r;
    }
    return true;
  }
}
registerProcessor('limiter', Limiter);
