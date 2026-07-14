import { describe, expect, it } from 'vitest';
import { fitLength, resample } from './resample';

describe('resample', () => {
  it('preserves a mid-band sine through 48k→16k', () => {
    const from = 48000;
    const to = 16000;
    const freq = 440;
    const n = 4800;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * freq * i) / from);
    const out = resample(input, from, to);
    expect(out.length).toBe(1600);
    // Compare against the ideal sine, ignoring filter edges.
    let maxErr = 0;
    for (let i = 32; i < out.length - 32; i++) {
      const ideal = Math.sin((2 * Math.PI * freq * i) / to);
      maxErr = Math.max(maxErr, Math.abs(out[i] - ideal));
    }
    expect(maxErr).toBeLessThan(0.05);
  });

  it('attenuates content above the target Nyquist', () => {
    const from = 48000;
    const to = 16000;
    const freq = 11000; // above 8 kHz target Nyquist — must not alias through
    const n = 4800;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * freq * i) / from);
    const out = resample(input, from, to);
    let rms = 0;
    for (let i = 32; i < out.length - 32; i++) rms += out[i] * out[i];
    rms = Math.sqrt(rms / (out.length - 64));
    expect(rms).toBeLessThan(0.12); // >15 dB down from 0.707
  });

  it('is identity at equal rates', () => {
    const x = new Float32Array([0.1, -0.2, 0.3]);
    expect(resample(x, 16000, 16000)).toBe(x);
  });
});

describe('fitLength', () => {
  it('pads and truncates', () => {
    const x = new Float32Array([1, 2, 3]);
    expect(Array.from(fitLength(x, 5))).toEqual([1, 2, 3, 0, 0]);
    expect(Array.from(fitLength(x, 2))).toEqual([1, 2]);
    expect(fitLength(x, 3)).toBe(x);
  });
});
