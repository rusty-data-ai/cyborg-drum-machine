import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { planStrike } from '../lib/drummerTiming';
import type { DrumClass } from '../lib/types';
import { DRUM_CLASSES } from '../lib/types';

/**
 * The cyborg: she's a stick-figure robot drummer with six servo arms, one per
 * pad, each ending in a gripper claw holding a drumstick that visibly strikes
 * its drum exactly when the drum sounds. She sits on a drum throne behind a
 * schematic kit (shells for kick/snare/clap/tom, cymbals on stands for the
 * hats), and her head is a friendly dustbin — an affectionate nod to a certain
 * bin-headed satirical candidate, likeness not included.
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
/** y where every stick tip lands — the drums' top surface. */
const HIT_Y = PAD_Y - 13;
/**
 * Shoulder mounts, one per drum, in DRUM_CLASSES order. Both sides fan out
 * the same way: the top shoulder reaches the farthest pad and the bottom
 * shoulder the closest, so no arm ever crosses another.
 */
const SHOULDERS: [number, number][] = [
  [214, 78], // kick — farthest left, top shoulder
  [211, 92], // snare
  [214, 106], // closed hat — closest left, bottom shoulder
  [246, 106], // open hat — closest right, bottom shoulder
  [249, 92], // clap
  [246, 78], // tom — farthest right, top shoulder
];
const PAD_SHORT: Record<DrumClass, string> = {
  kick: 'KICK',
  snare: 'SNARE',
  hihat_closed: 'CL HAT',
  hihat_open: 'OP HAT',
  clap: 'CLAP',
  tom: 'TOM',
};

/** Schematic kit shapes: cylindrical shells for drums, cymbals for the hats. */
type PadShape =
  | { kind: 'drum'; rx: number; shellH: number }
  | { kind: 'cymbal'; rx: number; topY: number; botY: number };

const PAD_SHAPES: Record<DrumClass, PadShape> = {
  kick: { kind: 'drum', rx: 27, shellH: 16 },
  snare: { kind: 'drum', rx: 24, shellH: 11 },
  hihat_closed: { kind: 'cymbal', rx: 24, topY: 146, botY: 149 },
  hihat_open: { kind: 'cymbal', rx: 24, topY: 143.5, botY: 151 },
  clap: { kind: 'drum', rx: 24, shellH: 11 },
  tom: { kind: 'drum', rx: 25, shellH: 13 },
};

const DRUM_HEAD_Y = HIT_Y + 2;
const DRUM_HEAD_RY = 7.5;

interface LimbGeom {
  drum: DrumClass;
  sx: number;
  sy: number;
  angle: number;
  len: number;
  /** Rotation sign that lifts the stick *away* from the pad. */
  sign: number;
  padX: number;
}

const LIMBS: LimbGeom[] = DRUM_CLASSES.map((drum, i) => {
  const [sx, sy] = SHOULDERS[i];
  const padX = PAD_XS[i];
  const tipX = padX;
  const tipY = HIT_Y;
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
      aria-label="cyborg drummer at her kit"
      style={{ ['--beat-s' as string]: `${60 / bpm}s` }}
    >
      {/* riser the kit stands on */}
      <rect x={28} y={PAD_Y - 4} width={404} height={20} rx={6} className="drummer-console" />

      {/* her body, behind the kit (head bobs with the beat while playing) */}
      <g className="drummer-figure">
        {/* drum throne: center column, splayed feet, padded round seat */}
        <line x1={230} y1={126} x2={230} y2={158} className="drummer-stand" />
        <path d={`M 218 165 L 230 156 L 242 165`} className="drummer-stand" />
        <path d={`M 206 121 v 4 q 24 7 48 0 v -4`} className="drummer-seat" />
        <ellipse cx={230} cy={121} rx={24} ry={6.5} className="drummer-seat" />
        {/* legs bent naturally from the seat, feet tucked in by the throne column */}
        <path d={`M 221 116 L 211 133 L 220 151`} className="drummer-line" />
        <path d={`M 239 116 L 249 133 L 240 151`} className="drummer-line" />
        {/* torso */}
        <rect x={213} y={64} width={34} height={52} rx={10} className="drummer-shell" />
        {/* chest LED */}
        <circle cx={230} cy={84} r={3.5} className="drummer-led" />
        {/* dustbin head: wide flat lid with a handle, tapered bin body, visor slit */}
        <g className="drummer-head">
          <line x1={230} y1={25} x2={230} y2={18} className="drummer-line" />
          <circle cx={230} cy={15} r={3} className="drummer-antenna" />
          <rect x={224.5} y={24.5} width={11} height={4} rx={2} className="drummer-lid-handle" />
          <rect x={212} y={28} width={36} height={7} rx={3} className="drummer-shell" />
          <path d={`M 216 35 L 244 35 L 242 61 Q 230 64.5 218 61 Z`} className="drummer-shell" />
          <line x1={218.6} y1={54} x2={241.4} y2={54} className="drummer-lug" />
          <rect x={221} y={41} width={18} height={5.5} rx={2.75} className="drummer-visor" />
        </g>
      </g>

      {/* the kit: drum shells / cymbals, impact flashes, labels */}
      {LIMBS.map(({ drum, padX }) => {
        const shape = PAD_SHAPES[drum];
        return (
          <g key={drum} data-target={drum}>
            {shape.kind === 'drum' ? (
              <>
                {/* cylindrical shell: straight sides, curved bottom, tension lugs */}
                <path
                  d={`M ${padX - shape.rx} ${DRUM_HEAD_Y} v ${shape.shellH} q ${shape.rx} 7 ${shape.rx * 2} 0 v ${-shape.shellH}`}
                  className="drummer-drum-shell"
                />
                <line
                  x1={padX - shape.rx * 0.55}
                  y1={DRUM_HEAD_Y + 3}
                  x2={padX - shape.rx * 0.55}
                  y2={DRUM_HEAD_Y + shape.shellH + 2}
                  className="drummer-lug"
                />
                <line
                  x1={padX + shape.rx * 0.55}
                  y1={DRUM_HEAD_Y + 3}
                  x2={padX + shape.rx * 0.55}
                  y2={DRUM_HEAD_Y + shape.shellH + 2}
                  className="drummer-lug"
                />
                <ellipse
                  cx={padX}
                  cy={DRUM_HEAD_Y}
                  rx={shape.rx}
                  ry={DRUM_HEAD_RY}
                  className="drummer-pad"
                />
              </>
            ) : (
              <>
                {/* cymbal pair on a thin stand with splayed feet */}
                <line x1={padX} y1={shape.botY} x2={padX} y2={169} className="drummer-stand" />
                <path
                  d={`M ${padX - 9} 173 L ${padX} 165 L ${padX + 9} 173`}
                  className="drummer-stand"
                />
                <ellipse cx={padX} cy={shape.botY} rx={shape.rx - 2} ry={3.5} className="drummer-cymbal" />
                <ellipse cx={padX} cy={shape.topY} rx={shape.rx} ry={4} className="drummer-cymbal" />
              </>
            )}
            <ellipse
              cx={padX}
              cy={shape.kind === 'drum' ? DRUM_HEAD_Y : shape.topY}
              rx={shape.rx}
              ry={shape.kind === 'drum' ? DRUM_HEAD_RY : 4.5}
              className="drummer-pad-flash"
              ref={(el) => {
                flashRefs.current[drum] = el;
              }}
            />
            <text x={padX} y={PAD_Y + 26} textAnchor="middle" className="drummer-pad-label">
              {PAD_SHORT[drum]}
            </text>
          </g>
        );
      })}

      {/* six servo arms, one per pad, each gripping a drumstick */}
      {LIMBS.map(({ drum, sx, sy, angle, len }) => {
        const armEnd = len - 28;
        const tip = len - 6;
        return (
          <g key={drum} transform={`translate(${sx} ${sy}) rotate(${angle})`}>
            <g
              data-limb={drum}
              className="drummer-limb"
              style={{ transformOrigin: '0px 0px' }}
              ref={(el) => {
                limbRefs.current[drum] = el;
              }}
            >
              <line x1={0} y1={0} x2={armEnd} y2={0} className="drummer-arm" />
              <circle cx={armEnd * 0.5} cy={0} r={2.5} className="drummer-joint" />
              {/* drumstick: tapered shaft with a rounded tip at the impact point */}
              <path
                d={`M ${tip - 26} -1.8 L ${tip - 2} -1.1 L ${tip - 2} 1.1 L ${tip - 26} 1.8 Z`}
                className="drummer-stick"
              />
              <circle cx={tip} cy={0} r={1.6} className="drummer-stick-tip" />
              {/* two-finger gripper claw holding the stick near its butt */}
              <path
                d={`M ${armEnd - 2} -1.2 L ${armEnd + 4} -3.6 L ${armEnd + 9} -1.7`}
                className="drummer-gripper"
              />
              <path
                d={`M ${armEnd - 2} 1.2 L ${armEnd + 4} 3.6 L ${armEnd + 9} 1.7`}
                className="drummer-gripper"
              />
              <circle cx={armEnd} cy={0} r={3} className="drummer-joint" />
            </g>
            <circle cx={0} cy={0} r={3.5} className="drummer-joint" />
          </g>
        );
      })}
    </svg>
  );
}
