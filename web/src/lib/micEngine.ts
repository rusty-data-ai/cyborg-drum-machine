import type { OnsetEvent } from './types';

/**
 * Mic capture + onset-worklet wiring. Emits onset events (immediate) and
 * PCM segments (~250 ms after each onset) for classification.
 */

export interface SegmentEvent extends OnsetEvent {
  pcm: Float32Array;
  sampleRate: number;
  /** Peak 20 ms RMS in the segment — velocity proxy, more stable than flux strength. */
  rmsPeak: number;
}

export interface MicEngineEvents {
  onOnset?: (e: OnsetEvent) => void;
  onSegment?: (e: SegmentEvent) => void;
  onLevel?: (rms: number) => void;
}

/** Tunables forwarded to the onset worklet via its {type:'config'} message. */
export interface WorkletConfig {
  sensitivity?: number;
  /** Minimum gap between onsets, seconds. */
  minGap?: number;
  /** Linear RMS noise gate. */
  noiseGateRms?: number;
}

export class MicEngine {
  readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private workletLoaded = false;
  events: MicEngineEvents = {};
  /** True if the browser refused to disable voice processing (degrades quality). */
  processingWarning = false;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
  }

  get running(): boolean {
    return this.worklet !== null;
  }

  async start(config: WorkletConfig = {}): Promise<void> {
    if (this.worklet) return;
    await this.ctx.resume();
    if (!this.workletLoaded) {
      await this.ctx.audioWorklet.addModule('/onset-processor.js');
      this.workletLoaded = true;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const settings = this.stream.getAudioTracks()[0]?.getSettings() ?? {};
    this.processingWarning = Boolean(
      settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl,
    );

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, 'onset-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.worklet.port.postMessage({ type: 'config', ...config });
    this.worklet.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'onset') {
        this.events.onOnset?.({ time: d.time, strength: d.strength });
      } else if (d.type === 'segment') {
        this.events.onSegment?.({
          time: d.time,
          strength: d.strength,
          rmsPeak: d.rmsPeak,
          pcm: d.pcm,
          sampleRate: d.sampleRate,
        });
      } else if (d.type === 'level') {
        this.events.onLevel?.(d.rms);
      }
    };
    // Keep the graph alive without hearing yourself: route through zero gain.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.worklet).connect(mute).connect(this.ctx.destination);
  }

  configure(config: WorkletConfig): void {
    this.worklet?.port.postMessage({ type: 'config', ...config });
  }

  stop(): void {
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worklet = null;
    this.source = null;
    this.stream = null;
  }
}
