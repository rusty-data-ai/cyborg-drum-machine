import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Drives the real AudioWorklet onset detector (public/onset-processor.js) in Node
 * by stubbing the worklet global scope, then feeds synthetic percussive audio
 * and checks detections.
 */

const SR = 48000;
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../public/onset-processor.js'),
  'utf8',
);

interface Msg {
  type: string;
  time?: number;
  strength?: number;
  pcm?: Float32Array;
  rmsPeak?: number;
  sampleRate?: number;
}

interface ProcessorInstance {
  process: (inputs: Float32Array[][]) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null };
}

function createProcessor() {
  let frame = 0;
  const messages: Msg[] = [];
  // Assigned from inside the evaluated worklet source; TS can't see that.
  let ProcessorClass: (new () => ProcessorInstance) | null = null;

  const scope = {
    get currentFrame() {
      return frame;
    },
    sampleRate: SR,
    AudioWorkletProcessor: class {
      port = {
        postMessage: (m: Msg) => messages.push(m),
        onmessage: null as ((e: { data: unknown }) => void) | null,
        close: () => {},
      };
    },
    registerProcessor: (_name: string, cls: never) => {
      ProcessorClass = cls;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('scope', `with (scope) { ${src} }`)(scope);
  const Cls = ProcessorClass as (new () => ProcessorInstance) | null;
  if (!Cls) throw new Error('processor did not register');
  const proc = new Cls();

  const feed = (samples: Float32Array) => {
    for (let i = 0; i + 128 <= samples.length; i += 128) {
      proc.process([[samples.subarray(i, i + 128)]]);
      frame += 128;
    }
  };
  return { proc, feed, messages };
}

/** Synthesize a drum-ish hit: noise burst + low sine, exponential decay. */
function synthHit(out: Float32Array, at: number, gain = 0.5, decayS = 0.05) {
  const start = Math.round(at * SR);
  const len = Math.round(decayS * 4 * SR);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / SR;
    const env = Math.exp(-t / decayS);
    const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1; // deterministic pseudo-noise
    out[start + i] += gain * env * (0.6 * noise + 0.4 * Math.sin(2 * Math.PI * 90 * t));
  }
}

describe('onset-processor worklet', () => {
  let audio: Float32Array;

  beforeEach(() => {
    audio = new Float32Array(SR * 2); // 2 s
    // Gentle noise floor (~-60 dB) so the detector has realistic stats.
    for (let i = 0; i < audio.length; i++) audio[i] = (((i * 16807) % 2147483647) / 2147483647 - 0.5) * 0.002;
  });

  it('detects three well-separated hits at the right times', () => {
    const times = [0.5, 1.0, 1.5];
    for (const t of times) synthHit(audio, t);
    const { feed, messages } = createProcessor();
    feed(audio);

    const onsets = messages.filter((m) => m.type === 'onset');
    expect(onsets.length).toBe(3);
    onsets.forEach((o, i) => {
      expect(Math.abs((o.time as number) - times[i])).toBeLessThan(0.02);
    });

    const segments = messages.filter((m) => m.type === 'segment');
    expect(segments.length).toBe(3);
    for (const s of segments) {
      expect(s.pcm!.length).toBe(Math.round(0.35 * SR));
      expect(s.rmsPeak!).toBeGreaterThan(0.01);
      // Segment PCM should contain the hit: energy well above the noise floor.
      let e = 0;
      for (let i = 0; i < s.pcm!.length; i++) e += s.pcm![i] * s.pcm![i];
      expect(Math.sqrt(e / s.pcm!.length)).toBeGreaterThan(0.01);
    }
  });

  it('respects the refractory period (no double triggers)', () => {
    synthHit(audio, 0.5);
    synthHit(audio, 0.52); // 20 ms later — inside MIN_GAP
    const { feed, messages } = createProcessor();
    feed(audio);
    expect(messages.filter((m) => m.type === 'onset').length).toBe(1);
  });

  it('stays silent on noise floor alone', () => {
    const { feed, messages } = createProcessor();
    feed(audio);
    expect(messages.filter((m) => m.type === 'onset').length).toBe(0);
  });

  it('resolves 16th notes at 120 bpm (125 ms apart)', () => {
    const times = [0.5, 0.625, 0.75, 0.875];
    for (const t of times) synthHit(audio, t, 0.5, 0.03);
    const { feed, messages } = createProcessor();
    feed(audio);
    expect(messages.filter((m) => m.type === 'onset').length).toBe(4);
  });
});
