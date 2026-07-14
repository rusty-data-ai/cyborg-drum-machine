import type { DrumClass } from './types';

/**
 * Drum voice playback. Prefers one-shot samples (loaded from /drums/*.wav);
 * falls back to synthesized voices so the app works with zero assets.
 *
 * All scheduling is sample-accurate via AudioContext time.
 */
export class DrumKit {
  private ctx: AudioContext;
  private out: GainNode;
  private samples: Partial<Record<DrumClass, AudioBuffer>> = {};
  /** Open-hat choke: a closed hat cuts a ringing open hat. */
  private openHatGains: GainNode[] = [];

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(destination ?? ctx.destination);
  }

  /** Attempt to load sampled sounds; missing files silently fall back to synthesis. */
  async loadSamples(baseUrl = '/drums'): Promise<void> {
    const names: DrumClass[] = ['kick', 'snare', 'hihat_closed', 'hihat_open'];
    await Promise.all(
      names.map(async (name) => {
        try {
          const res = await fetch(`${baseUrl}/${name}.wav`);
          if (!res.ok) return;
          const buf = await res.arrayBuffer();
          this.samples[name] = await this.ctx.decodeAudioData(buf);
        } catch {
          /* fall back to synth */
        }
      }),
    );
  }

  /** Trigger a drum at an exact AudioContext time. velocity 0..1. */
  trigger(drum: DrumClass, time: number, velocity = 1): void {
    const v = Math.max(0.05, Math.min(1, velocity));
    if (drum === 'hihat_closed') this.chokeOpenHats(time);

    const sample = this.samples[drum];
    if (sample) {
      const src = this.ctx.createBufferSource();
      src.buffer = sample;
      const g = this.ctx.createGain();
      g.gain.value = v;
      src.connect(g).connect(this.out);
      if (drum === 'hihat_open') this.openHatGains.push(g);
      src.start(time);
      return;
    }

    switch (drum) {
      case 'kick':
        this.synthKick(time, v);
        break;
      case 'snare':
        this.synthSnare(time, v);
        break;
      case 'hihat_closed':
        this.synthHat(time, v, 0.05);
        break;
      case 'hihat_open':
        this.synthHat(time, v, 0.4, true);
        break;
    }
  }

  private chokeOpenHats(time: number): void {
    for (const g of this.openHatGains) {
      g.gain.cancelScheduledValues(time);
      g.gain.setTargetAtTime(0, time, 0.008);
    }
    this.openHatGains = [];
  }

  /** Sine with fast pitch sweep + click transient. */
  private synthKick(t: number, v: number): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.3);

    // click transient
    const click = this.ctx.createBufferSource();
    click.buffer = this.noiseBuffer(0.01);
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.4 * v, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.01);
    click.connect(cg).connect(this.out);
    click.start(t);
  }

  /** Tuned body + bandpassed noise rattle. */
  private synthSnare(t: number, v: number): void {
    const body = this.ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(190, t);
    const bg = this.ctx.createGain();
    bg.gain.setValueAtTime(0.5 * v, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    body.connect(bg).connect(this.out);
    body.start(t);
    body.stop(t + 0.15);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(0.25);
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 3200;
    filt.Q.value = 0.7;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.8 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    noise.connect(filt).connect(ng).connect(this.out);
    noise.start(t);
  }

  private synthHat(t: number, v: number, decay: number, open = false): void {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(decay + 0.05);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    noise.connect(hp).connect(g).connect(this.out);
    if (open) this.openHatGains.push(g);
    noise.start(t);
  }

  private _noiseCache: AudioBuffer | null = null;
  private noiseBuffer(seconds: number): AudioBuffer {
    const len = Math.ceil(this.ctx.sampleRate * Math.max(seconds, 0.3));
    if (!this._noiseCache || this._noiseCache.length < len) {
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noiseCache = buf;
    }
    return this._noiseCache;
  }
}
