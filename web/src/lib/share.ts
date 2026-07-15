import type { DrumClass, Pattern } from './types';
import { DRUM_CLASSES, emptyPattern } from './types';

/**
 * Pattern ⇄ URL-fragment codec for zero-backend beat sharing.
 *
 * The whole pattern travels in the link itself (e.g. https://…/#p=AXgBEAY…),
 * so sharing needs no server and the fragment never even reaches one.
 *
 * Binary layout, version 1 (then base64url, no padding):
 *   byte 0     format version (1)
 *   bytes 1–2  bpm × 2, uint16 LE (half-BPM resolution, matches quantizer)
 *   byte 3     steps (16 per bar, ≤ 64)
 *   byte 4     drum row count (decoders ignore rows they don't know —
 *              new pads can be added without a version bump)
 *   byte 5…    velocities in DRUM_CLASSES order, one 4-bit level per step,
 *              packed two per byte (0 = off, 1–15 ≈ velocity/15)
 *
 * Worst case (6 drums × 64 steps) is 197 bytes → a ~263-char fragment.
 * Any change to the meaning of existing fields requires bumping the version
 * byte; decodePattern returns null for versions it doesn't know.
 */

export const SHARE_VERSION = 1;
const MAX_STEPS = 64;
const MAX_DRUMS = 32;
const HEADER_BYTES = 5;
const HASH_PREFIX = '#p=';

export function encodePattern(p: Pattern): string {
  const steps = Math.min(p.steps, MAX_STEPS);
  const drums = DRUM_CLASSES.length;
  const bytes = new Uint8Array(HEADER_BYTES + Math.ceil((drums * steps) / 2));
  const bpm2 = Math.round(Math.min(Math.max(p.bpm, 20), 300) * 2);
  bytes[0] = SHARE_VERSION;
  bytes[1] = bpm2 & 0xff;
  bytes[2] = bpm2 >> 8;
  bytes[3] = steps;
  bytes[4] = drums;
  DRUM_CLASSES.forEach((drum, d) => {
    for (let s = 0; s < steps; s++) {
      const v = p.grid[drum][s] ?? 0;
      const nib = v <= 0 ? 0 : Math.max(1, Math.round(Math.min(v, 1) * 15));
      const idx = d * steps + s;
      bytes[HEADER_BYTES + (idx >> 1)] |= idx % 2 === 0 ? nib << 4 : nib;
    }
  });
  return toBase64Url(bytes);
}

/** Strict decode; returns null on anything malformed rather than throwing. */
export function decodePattern(encoded: string): Pattern | null {
  const bytes = fromBase64Url(encoded);
  if (!bytes || bytes.length < HEADER_BYTES) return null;
  if (bytes[0] !== SHARE_VERSION) return null;
  const bpm = (bytes[1] | (bytes[2] << 8)) / 2;
  const steps = bytes[3];
  const drums = bytes[4];
  if (bpm < 20 || bpm > 300) return null;
  if (steps < 1 || steps > MAX_STEPS) return null;
  if (drums < 1 || drums > MAX_DRUMS) return null;
  if (bytes.length !== HEADER_BYTES + Math.ceil((drums * steps) / 2)) return null;
  const p = emptyPattern(bpm, steps);
  const known = Math.min(drums, DRUM_CLASSES.length);
  for (let d = 0; d < known; d++) {
    const row = p.grid[DRUM_CLASSES[d] as DrumClass];
    for (let s = 0; s < steps; s++) {
      const idx = d * steps + s;
      const byte = bytes[HEADER_BYTES + (idx >> 1)];
      const nib = idx % 2 === 0 ? byte >> 4 : byte & 0x0f;
      row[s] = nib / 15;
    }
  }
  return p;
}

/** Full shareable URL for the current page. */
export function patternToShareUrl(p: Pattern, base: string): string {
  return `${base}${HASH_PREFIX}${encodePattern(p)}`;
}

/** Parse a location.hash; null unless it carries a valid shared pattern. */
export function patternFromHash(hash: string): Pattern | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  return decodePattern(hash.slice(HASH_PREFIX.length));
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
