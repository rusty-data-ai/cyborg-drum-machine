/**
 * OnsetProcessor — AudioWorklet that detects percussive onsets in the mic
 * stream and ships a short PCM segment around each onset to the main thread
 * for classification.
 *
 * Algorithm: log-compressed spectral flux (half-wave rectified frame-to-frame
 * magnitude increase), adaptive threshold = local mean + k·local std, local-max
 * peak picking with a small lookahead, minimum inter-onset gap, and an RMS
 * noise gate.
 *
 * Messages OUT (port.postMessage):
 *   { type: 'onset', time, strength }                       — immediate, for UI flash
 *   { type: 'segment', time, strength, sampleRate, pcm }    — ~SEGMENT_POST s later
 *   { type: 'level', rms }                                  — ~every 50 ms
 * Messages IN:
 *   { type: 'config', sensitivity }                          — 0..1, default 0.5
 */

const FFT_SIZE = 512;
const HOP = 256;
const SEGMENT_PRE = 0.04; // s of audio kept before the onset
const SEGMENT_POST = 0.31; // s of audio after the onset (matches ml/ patch window)
const MIN_GAP = 0.06; // s minimum between onsets
const FLUX_WINDOW = 40; // frames (~0.21 s @ 48k/256) for adaptive stats
const LOOKAHEAD = 3; // frames each side for local-max test
const NOISE_GATE_RMS = 0.004; // ~-48 dBFS

class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let j = 0; j < this.levels; j++) r = (r << 1) | ((i >>> j) & 1);
      this.rev[i] = r;
    }
  }
  /** In-place complex FFT over (re, im). */
  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new FFT(FFT_SIZE);
    this.window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }
    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    this.prevMag = new Float32Array(FFT_SIZE / 2);

    // Rolling PCM ring buffer (2 s) for segment extraction.
    this.ringSize = Math.ceil(sampleRate * 2);
    this.ring = new Float32Array(this.ringSize);
    // Absolute sample position on the AudioContext clock (so onset times are
    // directly comparable with ctx.currentTime — needed for metronome mode).
    this.absPos = -1;

    // Frame assembly for STFT.
    this.frameBuf = new Float32Array(FFT_SIZE);
    this.frameFill = 0;

    // Flux history: recent values for stats + small lookahead for peak picking.
    this.flux = [];
    this.fluxAbsFrame = []; // absolute sample position of each flux frame's hop start
    this.lastOnsetTime = -1;
    this.pendingSegments = []; // { onsetSample, strength }
    this.sensitivity = 0.5;

    this.levelAccum = 0;
    this.levelCount = 0;
    this.levelEvery = Math.round(sampleRate * 0.05);
    this.levelNext = this.levelEvery;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'config' && typeof e.data.sensitivity === 'number') {
        this.sensitivity = Math.max(0, Math.min(1, e.data.sensitivity));
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    // Re-anchor to the context clock each block (robust to suspend/resume gaps).
    this.absPos = currentFrame;
    if (this.levelNext < this.absPos) this.levelNext = this.absPos + this.levelEvery;

    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.ring[this.absPos % this.ringSize] = s;
      this.absPos++;
      this.levelAccum += s * s;
      this.levelCount++;

      this.frameBuf[this.frameFill++] = s;
      if (this.frameFill === FFT_SIZE) {
        this.processFrame();
        // Slide by HOP.
        this.frameBuf.copyWithin(0, HOP);
        this.frameFill = FFT_SIZE - HOP;
      }
    }

    if (this.absPos >= this.levelNext) {
      const rms = Math.sqrt(this.levelAccum / Math.max(1, this.levelCount));
      this.port.postMessage({ type: 'level', rms });
      this.levelAccum = 0;
      this.levelCount = 0;
      this.levelNext = this.absPos + this.levelEvery;
    }

    this.flushSegments();
    return true;
  }

  processFrame() {
    const { re, im, window: win, fft } = this;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = this.frameBuf[i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);

    let flux = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const mag = Math.log1p(10 * Math.hypot(re[k], im[k]));
      const d = mag - this.prevMag[k];
      if (d > 0) flux += d;
      this.prevMag[k] = mag;
    }

    // The frame we just analysed started FFT_SIZE samples ago; treat its
    // onset-relevant energy as centred near the start of the newest hop.
    const frameStart = this.absPos - FFT_SIZE;
    this.flux.push(flux);
    this.fluxAbsFrame.push(frameStart);
    if (this.flux.length > FLUX_WINDOW + 2 * LOOKAHEAD + 2) {
      this.flux.shift();
      this.fluxAbsFrame.shift();
    }
    this.detect();
  }

  detect() {
    const n = this.flux.length;
    const c = n - 1 - LOOKAHEAD; // candidate index (needs LOOKAHEAD future frames)
    if (c < LOOKAHEAD) return;

    const cand = this.flux[c];
    // Local max test.
    for (let i = c - LOOKAHEAD; i <= c + LOOKAHEAD; i++) {
      if (i !== c && this.flux[i] > cand) return;
    }
    // Adaptive threshold over the window before the candidate.
    const start = Math.max(0, c - FLUX_WINDOW);
    let mean = 0;
    let count = 0;
    for (let i = start; i < c; i++) {
      mean += this.flux[i];
      count++;
    }
    if (count < 4) return;
    mean /= count;
    let vari = 0;
    for (let i = start; i < c; i++) {
      const d = this.flux[i] - mean;
      vari += d * d;
    }
    const std = Math.sqrt(vari / count);
    // sensitivity 0 → very strict, 1 → very permissive.
    const k = 3.2 - 2.4 * this.sensitivity;
    const delta = 0.9 - 0.7 * this.sensitivity;
    if (cand < mean + k * std + delta) return;

    const onsetSample = this.fluxAbsFrame[c];
    const time = onsetSample / sampleRate;
    if (this.lastOnsetTime >= 0 && time - this.lastOnsetTime < MIN_GAP) return;

    // Noise gate: quick RMS check on the 30 ms after the onset.
    const gateLen = Math.min(Math.round(sampleRate * 0.03), this.absPos - onsetSample);
    let e = 0;
    for (let i = 0; i < gateLen; i++) {
      const v = this.ring[(onsetSample + i) % this.ringSize];
      e += v * v;
    }
    if (Math.sqrt(e / Math.max(1, gateLen)) < NOISE_GATE_RMS) return;

    this.lastOnsetTime = time;
    const strength = cand / (mean + std + 1e-6);
    this.port.postMessage({ type: 'onset', time, strength });
    this.pendingSegments.push({ onsetSample, strength });
  }

  flushSegments() {
    const postLen = Math.round(sampleRate * SEGMENT_POST);
    const preLen = Math.round(sampleRate * SEGMENT_PRE);
    while (
      this.pendingSegments.length > 0 &&
      this.absPos >= this.pendingSegments[0].onsetSample + postLen
    ) {
      const { onsetSample, strength } = this.pendingSegments.shift();
      const startSample = Math.max(0, onsetSample - preLen);
      const len = onsetSample + postLen - startSample;
      // Guard against ring overwrite (can't happen with 2 s ring, but be safe).
      if (this.absPos - startSample > this.ringSize) continue;
      const pcm = new Float32Array(preLen + postLen);
      const offset = pcm.length - len; // zero-pad at the front if near stream start
      for (let i = 0; i < len; i++) {
        pcm[offset + i] = this.ring[(startSample + i) % this.ringSize];
      }
      // Peak 20 ms RMS within the segment → velocity proxy.
      const w = Math.round(sampleRate * 0.02);
      let peak = 0;
      for (let s = 0; s + w <= pcm.length; s += w >> 1) {
        let e = 0;
        for (let i = s; i < s + w; i++) e += pcm[i] * pcm[i];
        peak = Math.max(peak, Math.sqrt(e / w));
      }
      this.port.postMessage(
        {
          type: 'segment',
          time: onsetSample / sampleRate,
          strength,
          rmsPeak: peak,
          sampleRate,
          pcm,
        },
        [pcm.buffer],
      );
    }
  }
}

registerProcessor('onset-processor', OnsetProcessor);
