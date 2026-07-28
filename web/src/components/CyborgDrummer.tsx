import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { planStrike } from '../lib/drummerTiming';
import type { DrumClass } from '../lib/types';
import { DRUM_CLASSES } from '../lib/types';

/**
 * The cyborg: a stick-figure robot with six servo arms, one per pad, that
 * visibly strikes its drum exactly when the drum sounds.
 *
 * Strikes are driven imperatively (WAAPI with explicit startTime on the
 * document timeline) from the sequencer's schedule-time onTrigger hook — no
 * React state per hit, transform/opacity only. The wind-up starts before the
 * beat (the sequencer's ~120 ms lookahead makes anticipation possible) and
 * the impact keyframe lands on the converted audio-clock timestamp.
 *
 * prefers-reduced-motion: no sweeps, no idle sway — just a discrete pad
 * highlight on the beat.
 */

export interface DrummerHandle {
  /** Animate a hit whose impact lands at `perfTime` (performance-timeline ms). */
  strike(drum: DrumClass, velocity: number, perfTime: number, stepMs: number): void;
}

interface Props {
  playing: boolean;
  bpm: number;
  ref?: Ref<DrummerHandle>;
}

// ---- rig geometry (SVG user units) ----

const PAD_XS = [60, 128, 196, 264, 332, 400];
const PAD_Y = 158;
const SHOULDERS: [number, number][] = [
  [214, 78],
  [211, 92],
  [214, 106],
  [246, 78],
  [249, 92],
  [246, 106],
];
const PAD_SHORT: Record<DrumClass, string> = {
  kick: 'KICK',
  snare: 'SNARE',
  hihat_closed: 'CL HAT',
  hihat_open: 'OP HAT',
  clap: 'CLAP',
  tom: 'TOM',
};

interface LimbGeom {
  drum: DrumClass;
  sx: number;
  sy: number;
  angle: number;
  len: number;
  /** Rotation sign that lifts the mallet *away* from the pad. */
  sign: number;
  padX: number;
}

const LIMBS: LimbGeom[] = DRUM_CLASSES.map((drum, i) => {
  const [sx, sy] = SHOULDERS[i];
  const padX = PAD_XS[i];
  const tipX = padX;
  const tipY = PAD_Y - 13;
  const dx = tipX - sx;
  const dy = tipY - sy;
  return {
    drum,
    sx,
    sy,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    len: Math.hypot(dx, dy),
    sign: padX < 230 ? 1 : -1,
    padX,
  };
});

export function CyborgDrummer({ playing, bpm, ref }: Props) {
  const limbRefs = useRef<Partial<Record<DrumClass, SVGGElement | null>>>({});
  const flashRefs = useRef<Partial<Record<DrumClass, SVGEllipseElement | null>>>({});
  const reducedRef = useRef<MediaQueryList | null>(null);

  useEffect(() => {
    reducedRef.current = window.matchMedia('(prefers-reduced-motion: reduce)');
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      strike(drum, velocity, perfTime, stepMs) {
        const limb = limbRefs.current[drum];
        const flash = flashRefs.current[drum];
        const vel = Math.max(0, Math.min(1, velocity));

        if (reducedRef.current?.matches) {
          // Reduced motion: a discrete, non-animated highlight on the beat.
          const delay = Math.max(0, perfTime - performance.now());
          window.setTimeout(() => {
            if (!flash) return;
            flash.style.opacity = String(0.3 + 0.5 * vel);
            window.setTimeout(() => {
              flash.style.opacity = '0';
            }, 120);
          }, delay);
          return;
        }

        if (limb) {
          // A retrigger mid-recoil snaps straight into the new wind-up.
          for (const a of limb.getAnimations()) a.cancel();
          const geom = LIMBS.find((l) => l.drum === drum)!;
          const plan = planStrike(perfTime, stepMs);
          const lift = (9 + 9 * vel) * geom.sign;
          const anim = limb.animate(
            [
              { transform: 'rotate(0deg)', easing: 'ease-out' },
              { transform: `rotate(${lift}deg)`, offset: plan.impactOffset * 0.7, easing: 'ease-in' },
              { transform: `rotate(${-5 * geom.sign}deg)`, offset: plan.impactOffset, easing: 'ease-out' },
              { transform: 'rotate(0deg)' },
            ],
            { duration: plan.duration },
          );
          anim.startTime = plan.startTime;
        }
        if (flash) {
          for (const a of flash.getAnimations()) a.cancel();
          const f = flash.animate([{ opacity: 0.25 + 0.6 * vel }, { opacity: 0 }], {
            duration: 150,
            easing: 'ease-out',
          });
          f.startTime = perfTime;
        }
      },
    }),
    [],
  );

  return (
    <svg
      className={`drummer ${playing ? 'playing' : ''}`}
      viewBox="0 0 460 196"
      role="img"
      aria-label="cyborg drummer"
      style={{ ['--beat-s' as string]: `${60 / bpm}s` }}
    >
      {/* console the pads sit on */}
      <rect x={28} y={PAD_Y - 4} width={404} height={20} rx={6} className="drummer-console" />

      {/* pads + impact flashes */}
      {LIMBS.map(({ drum, padX }) => (
        <g key={drum} data-target={drum}>
          <ellipse cx={padX} cy={PAD_Y} rx={27} ry={9} className="drummer-pad" />
          <ellipse
            cx={padX}
            cy={PAD_Y}
            rx={27}
            ry={9}
            className="drummer-pad-flash"
            ref={(el) => {
              flashRefs.current[drum] = el;
            }}
          />
          <text x={padX} y={PAD_Y + 26} textAnchor="middle" className="drummer-pad-label">
            {PAD_SHORT[drum]}
          </text>
        </g>
      ))}

      {/* body (head bobs with the beat while playing) */}
      <g className="drummer-figure">
        <g className="drummer-head">
          <line x1={230} y1={33} x2={230} y2={21} className="drummer-line" />
          <circle cx={230} cy={18} r={3} className="drummer-antenna" />
          <circle cx={230} cy={47} r={15} className="drummer-shell" />
          <rect x={219} y={42} width={22} height={7} rx={3.5} className="drummer-visor" />
        </g>
        <rect x={213} y={64} width={34} height={52} rx={10} className="drummer-shell" />
        {/* chest LED */}
        <circle cx={230} cy={84} r={3.5} className="drummer-led" />
        {/* legs + stool */}
        <line x1={222} y1={114} x2={212} y2={140} className="drummer-line" />
        <line x1={238} y1={114} x2={248} y2={140} className="drummer-line" />
        <line x1={204} y1={142} x2={256} y2={142} className="drummer-line" />
      </g>

      {/* six servo arms, one per pad */}
      {LIMBS.map(({ drum, sx, sy, angle, len }) => (
        <g key={drum} transform={`translate(${sx} ${sy}) rotate(${angle})`}>
          <g
            data-limb={drum}
            className="drummer-limb"
            style={{ transformOrigin: '0px 0px' }}
            ref={(el) => {
              limbRefs.current[drum] = el;
            }}
          >
            <line x1={0} y1={0} x2={len - 8} y2={0} className="drummer-arm" />
            <circle cx={(len - 8) * 0.55} cy={0} r={2.5} className="drummer-joint" />
            <circle cx={len - 6} cy={0} r={4.5} className="drummer-mallet" />
          </g>
          <circle cx={0} cy={0} r={3.5} className="drummer-joint" />
        </g>
      ))}
    </svg>
  );
}
