/** Simple scheduled click track: 4-beat count-in, then continuing quarter-note
 * clicks with a bar accent. Returns a handle exposing the downbeat time (the
 * quantization grid origin) and a stop function. */

export interface MetronomeHandle {
  /** AudioContext time of beat 1 after the count-in — the grid origin. */
  downbeat: number;
  stop: () => void;
}

export function startMetronome(ctx: AudioContext, bpm: number, countInBeats = 4): MetronomeHandle {
  const beat = 60 / bpm;
  const start = ctx.currentTime + 0.15;
  const downbeat = start + countInBeats * beat;
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(ctx.destination);

  let stopped = false;
  let nextBeat = 0;
  let timer = 0;

  const scheduleClick = (time: number, accent: boolean) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(accent ? 0.9 : 0.5, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.connect(g).connect(out);
    osc.start(time);
    osc.stop(time + 0.05);
  };

  const pump = () => {
    if (stopped) return;
    while (start + nextBeat * beat < ctx.currentTime + 0.3) {
      const t = start + nextBeat * beat;
      const inCountIn = nextBeat < countInBeats;
      const beatInBar = (nextBeat - countInBeats) % 4;
      scheduleClick(t, inCountIn ? nextBeat === 0 : beatInBar === 0);
      nextBeat++;
    }
    timer = window.setTimeout(pump, 60);
  };
  pump();

  return {
    downbeat,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      window.setTimeout(() => out.disconnect(), 100);
    },
  };
}
