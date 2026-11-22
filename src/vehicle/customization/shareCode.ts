import {
  CAR_MODEL_IDS,
  PAINT_FINISHES,
  RIM_COUNT,
  SPOILER_STYLES,
  STRIPE_STYLES,
  TYRE_PROFILES,
  normalizeBuild,
  sanitizePlate,
  type CarBuild,
} from '../CarBuild';
import { SHARE_PALETTE_V1 } from './palette';

/**
 * Share codes (spec §7): the whole CarBuild packed into a short URL-safe string (owner: garage).
 *
 * Format v2 — a big-endian bit stream, zero-padded to a byte boundary, followed by one checksum byte, then base64url
 * (no padding). Typical codes are 22–28 characters (≈ 45 worst case with every colour custom and an 8-char plate).
 *
 *   version 4 · model 2 · finish 3 · colour · shiftColour · twoTone 1 · roofColour · stripes 2 · stripeColour ·
 *   rim 3 · rimColour · tyre 2 · size 2 · splitter 1 · skirts 1 · spoiler 2 · scoop 1 ·
 *   rideHeight 5 (21 steps) · camber 5 (21 steps) · tint 5 (21 steps) · headlightColour ·
 *   underglow 1 [+ colour] · plateLen 4 + base-38 plate integer (⌈log2 38^len⌉ bits) · perf 4×2 · turbo 2 (v2+)
 *
 *   colour = 1 bit flag: 1 → 6-bit index into SHARE_PALETTE_V1, 0 → 24-bit RGB.
 *
 * Every field is encoded (also currently-invisible ones such as the shift colour of a non-shift finish), so
 * decode(encode(b)) deep-equals quantizeBuild(b). The garage stores builds already quantized, so the stored build
 * and the decoded build are identical. v1 codes (no turbo field) still decode, with perf.turbo = 0.
 */

export const SHARE_VERSION = 2;
/** Oldest version the decoder still accepts. */
const MIN_SHARE_VERSION = 1;

// ── slider quantization (shared by the garage UI so stored builds roundtrip exactly) ──
export const RIDE_STEPS = 10; // per unit: -1..1 → 21 values
export const CAMBER_STEPS = 20; // 0..1 → 21 values
export const TINT_STEPS = 20; // 0..1 → 21 values

const nz = (v: number) => (v === 0 ? 0 : v); // kill -0
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const num = (v: number, d: number) => (Number.isFinite(v) ? v : d);

export const quantizeRide = (v: number) => nz(Math.round(clamp(num(v, 0), -1, 1) * RIDE_STEPS) / RIDE_STEPS);
export const quantizeCamber = (v: number) => nz(Math.round(clamp(num(v, 0), 0, 1) * CAMBER_STEPS) / CAMBER_STEPS);
export const quantizeTint = (v: number) => nz(Math.round(clamp(num(v, 0), 0, 1) * TINT_STEPS) / TINT_STEPS);

/** normalizeBuild + slider quantization. Always returns a fresh object. */
export function quantizeBuild(input: unknown): CarBuild {
  const b = normalizeBuild(input);
  b.stance.rideHeight = quantizeRide(b.stance.rideHeight);
  b.stance.camber = quantizeCamber(b.stance.camber);
  b.extras.tint = quantizeTint(b.extras.tint);
  return b;
}

// ── plate alphabet (matches sanitizePlate: A-Z 0-9 space -) ──
const PLATE_ALPHABET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
const PLATE_BASE = PLATE_ALPHABET.length; // 38
const plateBits = (len: number) => {
  let n = 0;
  while (2 ** n < PLATE_BASE ** len) n++;
  return n;
};

// ── bit stream helpers (arithmetic, safe for values up to 2^53) ──
class BitWriter {
  private bits: number[] = [];
  write(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
  }
  bool(v: boolean): void {
    this.write(v ? 1 : 0, 1);
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

class BitReader {
  pos = 0;
  constructor(private bytes: Uint8Array, readonly length = bytes.length * 8) {}
  read(n: number): number {
    if (this.pos + n > this.length) throw new RangeError('eof');
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) v = v * 2 + ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    return v;
  }
  bool(): boolean {
    return this.read(1) === 1;
  }
}

const PALETTE_INDEX = new Map<string, number>(SHARE_PALETTE_V1.map((c, i) => [c, i]));

function writeColor(w: BitWriter, hex: string): void {
  const idx = PALETTE_INDEX.get(hex);
  if (idx !== undefined && idx < 64) {
    w.write(1, 1);
    w.write(idx, 6);
  } else {
    w.write(0, 1);
    w.write(parseInt(hex.slice(1), 16), 24);
  }
}

function readColor(r: BitReader): string {
  if (r.bool()) {
    const idx = r.read(6);
    const c = SHARE_PALETTE_V1[idx];
    if (!c) throw new RangeError('palette');
    return c;
  }
  return '#' + r.read(24).toString(16).padStart(6, '0');
}

function enumIndex<T extends string>(list: readonly T[], v: T): number {
  const i = list.indexOf(v);
  return i < 0 ? 0 : i;
}

function readEnum<T>(r: BitReader, list: readonly T[], bits: number): T {
  const i = r.read(bits);
  if (i >= list.length) throw new RangeError('enum');
  return list[i];
}

function readRange(r: BitReader, bits: number, max: number): number {
  const v = r.read(bits);
  if (v > max) throw new RangeError('range');
  return v;
}

function checksum(bytes: Uint8Array, len: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h ^ (h >>> 8) ^ (h >>> 16) ^ (h >>> 24)) & 0xff;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(code)) return null;
  if (code.length % 4 === 1) return null;
  try {
    const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((code.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Encode a build (it is normalized + quantized first) into a short URL-safe share code. */
export function encodeShareCode(input: CarBuild): string {
  return encodeVersion(input, SHARE_VERSION);
}

function encodeVersion(input: CarBuild, version: number): string {
  const b = quantizeBuild(input);
  const w = new BitWriter();
  w.write(version, 4);
  w.write(enumIndex(CAR_MODEL_IDS, b.model), 2);
  w.write(enumIndex(PAINT_FINISHES, b.paint.finish), 3);
  writeColor(w, b.paint.color);
  writeColor(w, b.paint.shiftColor);
  w.bool(b.paint.twoTone);
  writeColor(w, b.paint.roofColor);
  w.write(enumIndex(STRIPE_STYLES, b.paint.stripes), 2);
  writeColor(w, b.paint.stripeColor);
  w.write(b.wheels.rim, 3);
  writeColor(w, b.wheels.rimColor);
  w.write(enumIndex(TYRE_PROFILES, b.wheels.tyre), 2);
  w.write(b.wheels.size, 2);
  w.bool(b.kit.splitter);
  w.bool(b.kit.skirts);
  w.write(enumIndex(SPOILER_STYLES, b.kit.spoiler), 2);
  w.bool(b.kit.scoop);
  w.write(Math.round(b.stance.rideHeight * RIDE_STEPS) + RIDE_STEPS, 5);
  w.write(Math.round(b.stance.camber * CAMBER_STEPS), 5);
  w.write(Math.round(b.extras.tint * TINT_STEPS), 5);
  writeColor(w, b.extras.headlightColor);
  w.bool(b.extras.underglow !== null);
  if (b.extras.underglow !== null) writeColor(w, b.extras.underglow);
  const plate = b.extras.plate;
  w.write(plate.length, 4);
  let pv = 0;
  for (let i = plate.length - 1; i >= 0; i--) pv = pv * PLATE_BASE + Math.max(0, PLATE_ALPHABET.indexOf(plate[i]));
  w.write(pv, plateBits(plate.length));
  w.write(b.perf.engine, 2);
  w.write(b.perf.tyres, 2);
  w.write(b.perf.brakes, 2);
  w.write(b.perf.suspension, 2);
  if (version >= 2) w.write(b.perf.turbo, 2);
  const payload = w.toBytes();
  const out = new Uint8Array(payload.length + 1);
  out.set(payload);
  out[payload.length] = checksum(payload, payload.length);
  return toBase64Url(out);
}

/**
 * Pull a share code out of user input: a bare code, a full link containing `?car=`, or text around either.
 * Returns '' when nothing code-like is found.
 */
export function extractShareCode(text: string): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const m = /(?:^|[?&#\s])car=([A-Za-z0-9_-]+)/.exec(t);
  if (m) return m[1];
  const bare = /^[A-Za-z0-9_-]+$/.exec(t);
  return bare ? t : '';
}

/** Decode a share code. Never throws; returns null for anything that is not a valid v1 code. */
export function decodeShareCode(code: string): CarBuild | null {
  try {
    const bytes = fromBase64Url(extractShareCode(code));
    if (!bytes || bytes.length < 6) return null;
    const n = bytes.length - 1;
    if (checksum(bytes, n) !== bytes[n]) return null;
    const r = new BitReader(bytes, n * 8);
    const version = r.read(4);
    if (version < MIN_SHARE_VERSION || version > SHARE_VERSION) return null;
    const model = readEnum(r, CAR_MODEL_IDS, 2);
    const finish = readEnum(r, PAINT_FINISHES, 3);
    const color = readColor(r);
    const shiftColor = readColor(r);
    const twoTone = r.bool();
    const roofColor = readColor(r);
    const stripes = readEnum(r, STRIPE_STYLES, 2);
    const stripeColor = readColor(r);
    const rim = readRange(r, 3, RIM_COUNT - 1);
    const rimColor = readColor(r);
    const tyre = readEnum(r, TYRE_PROFILES, 2);
    const size = readRange(r, 2, 2);
    const splitter = r.bool();
    const skirts = r.bool();
    const spoiler = readEnum(r, SPOILER_STYLES, 2);
    const scoop = r.bool();
    const ride = readRange(r, 5, RIDE_STEPS * 2);
    const camber = readRange(r, 5, CAMBER_STEPS);
    const tint = readRange(r, 5, TINT_STEPS);
    const headlightColor = readColor(r);
    const underglow = r.bool() ? readColor(r) : null;
    const plateLen = readRange(r, 4, 8);
    let pv = r.read(plateBits(plateLen));
    if (pv >= PLATE_BASE ** plateLen) return null;
    let plate = '';
    for (let i = 0; i < plateLen; i++) {
      plate += PLATE_ALPHABET[pv % PLATE_BASE];
      pv = Math.floor(pv / PLATE_BASE);
    }
    const perf = { engine: readRange(r, 2, 2), tyres: readRange(r, 2, 2), brakes: readRange(r, 2, 2), suspension: readRange(r, 2, 2), turbo: 0 };
    if (version >= 2) perf.turbo = readRange(r, 2, 2);
    // Only zero padding may remain.
    const rest = r.length - r.pos;
    if (rest >= 8 || (rest > 0 && r.read(rest) !== 0)) return null;
    if (sanitizePlate(plate) !== plate) return null;
    return quantizeBuild({
      model,
      paint: { color, finish, shiftColor, twoTone, roofColor, stripes, stripeColor },
      wheels: { rim, rimColor, tyre, size },
      kit: { splitter, skirts, spoiler, scoop },
      stance: { rideHeight: (ride - RIDE_STEPS) / RIDE_STEPS, camber: camber / CAMBER_STEPS },
      extras: { tint: tint / TINT_STEPS, headlightColor, underglow, plate },
      perf,
    });
  } catch {
    return null;
  }
}

/** Full shareable link for a build (current page without other params). */
export function shareLink(build: CarBuild): string {
  return `${location.origin}${location.pathname}?car=${encodeShareCode(build)}`;
}

/** Deep equality of two builds (stable key order comes from normalizeBuild). */
export function sameBuild(a: CarBuild, b: CarBuild): boolean {
  return JSON.stringify(quantizeBuild(a)) === JSON.stringify(quantizeBuild(b));
}

// ───────────────────────────── self-test (debug: window.__shareTest()) ─────────────────────────────
function randomBuildForTest(rnd: () => number): CarBuild {
  const pick = <T>(l: readonly T[]) => l[Math.floor(rnd() * l.length)];
  const hex = () => (rnd() < 0.5 ? pick(SHARE_PALETTE_V1) : '#' + Math.floor(rnd() * 0x1000000).toString(16).padStart(6, '0'));
  const plateLen = Math.floor(rnd() * 9);
  let plate = '';
  for (let i = 0; i < plateLen; i++) plate += PLATE_ALPHABET[Math.floor(rnd() * PLATE_BASE)];
  return quantizeBuild({
    model: pick(CAR_MODEL_IDS),
    paint: { color: hex(), finish: pick(PAINT_FINISHES), shiftColor: hex(), twoTone: rnd() < 0.5, roofColor: hex(), stripes: pick(STRIPE_STYLES), stripeColor: hex() },
    wheels: { rim: Math.floor(rnd() * RIM_COUNT), rimColor: hex(), tyre: pick(TYRE_PROFILES), size: Math.floor(rnd() * 3) },
    kit: { splitter: rnd() < 0.5, skirts: rnd() < 0.5, spoiler: pick(SPOILER_STYLES), scoop: rnd() < 0.5 },
    stance: { rideHeight: rnd() * 2 - 1, camber: rnd() },
    extras: { tint: rnd(), headlightColor: hex(), underglow: rnd() < 0.5 ? null : hex(), plate },
    perf: { engine: Math.floor(rnd() * 3), tyres: Math.floor(rnd() * 3), brakes: Math.floor(rnd() * 3), suspension: Math.floor(rnd() * 3), turbo: Math.floor(rnd() * 3) },
  });
}

export interface ShareSelfTestResult {
  ok: boolean;
  roundtrips: number;
  failures: string[];
  minLen: number;
  avgLen: number;
  maxLen: number;
  garbageAccepted: number;
  garbageTried: number;
  sample: string;
}

/** Roundtrips `n` random builds and feeds garbage to the decoder. Used by the smoke test via `window.__shareTest`. */
export function runShareSelfTest(n = 200): ShareSelfTestResult {
  const rnd = Math.random;
  const failures: string[] = [];
  let minLen = Infinity, maxLen = 0, total = 0, sample = '';
  for (let i = 0; i < n; i++) {
    const b = randomBuildForTest(rnd);
    const code = encodeShareCode(b);
    if (i === 0) sample = code;
    minLen = Math.min(minLen, code.length);
    maxLen = Math.max(maxLen, code.length);
    total += code.length;
    const d = decodeShareCode(code);
    if (!d || JSON.stringify(d) !== JSON.stringify(b)) failures.push(`roundtrip ${code}`);
    // A link containing the code must decode too.
    if (i < 10 && !decodeShareCode(`https://example.test/game/?debug&car=${code}`)) failures.push(`link ${code}`);
    // Legacy v1 codes (no turbo) must still decode: same car with turbo 0.
    if (i < 50) {
      const legacy = decodeShareCode(encodeVersion(b, 1));
      const expect = quantizeBuild({ ...b, perf: { ...b.perf, turbo: 0 } });
      if (!legacy || JSON.stringify(legacy) !== JSON.stringify(expect)) failures.push(`legacy v1 ${code}`);
    }
    // Truncated codes must be rejected.
    if (decodeShareCode(code.slice(0, -2))) failures.push(`truncated accepted ${code}`);
  }
  // Garbage: random strings and single-character mutations of valid codes must never throw; most are rejected.
  let garbageAccepted = 0, garbageTried = 0;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let i = 0; i < 300; i++) {
    let s = '';
    const len = 1 + Math.floor(rnd() * 40);
    for (let j = 0; j < len; j++) s += chars[Math.floor(rnd() * chars.length)];
    garbageTried++;
    if (decodeShareCode(s)) garbageAccepted++;
  }
  for (const s of ['', ' ', 'null', '{}', '%%%', '=====', 'car=', '?car=!!', 'A'.repeat(500)]) {
    garbageTried++;
    if (decodeShareCode(s)) garbageAccepted++;
  }
  return {
    ok: failures.length === 0 && garbageAccepted <= 3,
    roundtrips: n,
    failures: failures.slice(0, 10),
    minLen,
    avgLen: +(total / n).toFixed(1),
    maxLen,
    garbageAccepted,
    garbageTried,
    sample,
  };
}
