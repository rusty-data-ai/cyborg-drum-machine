/**
 * Windowed-sinc resampler for arbitrary ratios (e.g. 48000→16000, 44100→16000).
 * Quality is plenty for feeding a mel-frontend classifier; not meant for hi-fi.
 */

const TAPS_PER_SIDE = 16;

export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  // Low-pass cutoff at the smaller Nyquist, slightly under to reduce aliasing.
  const cutoff = 0.9 * Math.min(1, 1 / ratio); // normalized to input Nyquist
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const lo = Math.max(0, Math.ceil(center - TAPS_PER_SIDE));
    const hi = Math.min(input.length - 1, Math.floor(center + TAPS_PER_SIDE));
    let acc = 0;
    let wsum = 0;
    for (let j = lo; j <= hi; j++) {
      const x = j - center;
      const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
      // Hann window over the tap span.
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS_PER_SIDE + 1));
      const coef = sinc * w;
      acc += input[j] * coef;
      wsum += coef;
    }
    out[i] = wsum > 1e-9 ? acc / (wsum / cutoff) / cutoff : acc;
  }
  return out;
}

/** Fix output length exactly (pad with zeros / truncate) — model inputs are fixed-shape. */
export function fitLength(x: Float32Array, n: number): Float32Array {
  if (x.length === n) return x;
  const out = new Float32Array(n);
  out.set(x.subarray(0, Math.min(n, x.length)));
  return out;
}
