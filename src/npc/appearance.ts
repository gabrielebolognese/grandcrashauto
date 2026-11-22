import type { Rng } from '../core/rng';
import { PART, STYLE } from './model';

/** Per-instance look: packed sRGB colours (0xRRGGBB as float), flag bits and body shape. */
export interface Appearance {
  skin: number;
  top: number;
  bottom: number;
  shoes: number;
  hair: number;
  acc: number;
  inner: number;
  flags: number;
  /** Packed shoulder width / hip width / girth (8 bits each over [0.8, 1.3]). */
  shape: number;
  scale: number;
  /** Walking speed multiplier personality (0.85..1.15). */
  pace: number;
  /** 0..1: how jumpy / quick to react this person is. */
  reflex: number;
}

const hex = (s: string) => parseInt(s.slice(1), 16);
const SKIN = ['#f6d7c3', '#f1cfb4', '#efc4a4', '#e3ac85', '#d29b74', '#c08158', '#a86b47', '#8d5537', '#6e3f28', '#56301f'].map(hex);
const HAIR = ['#1f1a17', '#2b211b', '#3b2a20', '#5e3f2a', '#7a3b22', '#a8562b', '#c9a46a', '#e0c48d', '#9a958f', '#d6d2cc'].map(hex);
const HAIR_W = [16, 12, 16, 14, 6, 4, 8, 6, 5, 3];
const TOPS = ['#ff7a6b', '#ffb38a', '#9ee0c8', '#5cc8d6', '#b8a6e8', '#ffe39a', '#fff4e0', '#8fd0ec', '#f4f2ee', '#2f3e66', '#d9534f', '#2a9d8f', '#8a9a5b', '#f4a6c0', '#e0a83a', '#3d3f45', '#ffffff', '#7fb7d9'].map(hex);
const JACKETS = ['#2f3e66', '#46628f', '#6b7350', '#c8b48a', '#2a2a2e', '#8a5a3c', '#b8a6e8', '#d9534f'].map(hex);
const BOTTOMS = ['#46628f', '#2e3f5c', '#7d9cc4', '#c8b48a', '#e6d5b8', '#2a2a2e', '#efeee9', '#6b7350', '#8b8d93', '#2b3550'].map(hex);
const SHORTS = ['#46628f', '#7d9cc4', '#c8b48a', '#e6d5b8', '#f08a7a', '#5cc8d6', '#2b3550', '#efeee9', '#9ee0c8'].map(hex);
const SKIRTS = ['#46628f', '#2a2a2e', '#ff7a6b', '#b8a6e8', '#ffe39a', '#9ee0c8', '#c8b48a', '#f4a6c0', '#2b3550'].map(hex);
const DRESSES = ['#ff7a6b', '#ffb38a', '#9ee0c8', '#5cc8d6', '#b8a6e8', '#ffe39a', '#f4a6c0', '#fff4e0', '#2a9d8f', '#d9534f'].map(hex);
const SHOES = ['#f2f0ea', '#f2f0ea', '#2a2a2e', '#c94a3a', '#2f3e66', '#b98a5a', '#9a9ca2', '#9ee0c8', '#ffb38a'].map(hex);
const ACC = ['#e8cf8f', '#d9534f', '#2f3e66', '#f4f2ee', '#2a2a2e', '#ff7a6b', '#5cc8d6', '#a8714a', '#ffe39a', '#9ee0c8'].map(hex);

const bit = (b: number) => 2 ** b;
const q8 = (v: number) => Math.max(0, Math.min(255, Math.round(((v - 0.8) / 0.5) * 255)));

export function randomAppearance(rng: Rng): Appearance {
  const fem = rng.chance(0.5);
  let flags = 0;
  // hair
  let hairStyle: string;
  if (fem) hairStyle = rng.weighted(['long', 'bun', 'pony', 'short'], [45, 15, 22, 18]);
  else hairStyle = rng.weighted(['short', 'bald', 'long', 'pony'], [74, 12, 8, 6]);
  if (hairStyle === 'short') flags |= bit(PART.hairShort);
  else if (hairStyle === 'long') flags |= bit(PART.hairLong);
  else if (hairStyle === 'bun') flags |= bit(PART.hairShort) | bit(PART.hairBun);
  else if (hairStyle === 'pony') flags |= bit(PART.hairShort) | bit(PART.hairPony);
  const older = rng.chance(0.15);
  let hair = rng.weighted(HAIR, HAIR_W);
  if (older) hair = rng.pick([HAIR[8], HAIR[9], HAIR[8]]);
  if (!fem && rng.chance(0.24)) flags |= bit(PART.beard);
  // headwear / accessories
  const hat = rng.weighted(['none', 'cap', 'sun'], [76, 14, 10]);
  if (hat === 'cap') flags |= bit(PART.cap);
  else if (hat === 'sun') flags |= bit(PART.sunHat);
  if (rng.chance(0.22)) flags |= bit(PART.glasses);
  const carry = rng.weighted(['none', 'bag', 'backpack'], [72, 15, 13]);
  if (carry === 'bag') flags |= bit(PART.bag);
  else if (carry === 'backpack') flags |= bit(PART.backpack);
  // clothes
  let top = rng.pick(TOPS);
  let inner = rng.pick(TOPS);
  const topStyle = rng.weighted(['tee', 'tank', 'long', 'jacket'], [58, 15, 15, 12]);
  if (topStyle === 'tee') flags |= bit(STYLE.sleeves);
  else if (topStyle === 'long') flags |= bit(STYLE.sleeves) | bit(STYLE.longSleeves);
  else if (topStyle === 'jacket') {
    flags |= bit(STYLE.sleeves) | bit(STYLE.longSleeves) | bit(PART.jacket);
    inner = top;
    top = rng.pick(JACKETS);
  }
  let bottom: number;
  const bottomStyle = fem
    ? rng.weighted(['skirt', 'dress', 'shorts', 'trousers'], [24, 16, 24, 36])
    : rng.weighted(['shorts', 'trousers'], [42, 58]);
  if (bottomStyle === 'shorts') bottom = rng.pick(SHORTS);
  else if (bottomStyle === 'trousers') {
    bottom = rng.pick(BOTTOMS);
    flags |= bit(STYLE.trousers);
  } else if (bottomStyle === 'skirt') {
    bottom = rng.pick(SKIRTS);
    flags |= bit(STYLE.skirtLegs) | bit(rng.chance(0.6) ? PART.skirt : PART.longSkirt);
  } else {
    // dress: one colour top + skirt
    top = rng.pick(DRESSES);
    bottom = top;
    flags &= ~(bit(STYLE.longSleeves) | bit(PART.jacket));
    flags = rng.chance(0.5) ? flags | bit(STYLE.sleeves) : flags & ~bit(STYLE.sleeves);
    flags |= bit(STYLE.skirtLegs) | bit(STYLE.dress) | bit(rng.chance(0.5) ? PART.skirt : PART.longSkirt);
  }
  const scale = fem ? rng.range(0.9, 1.0) : rng.range(0.96, 1.1);
  const shoulder = fem ? rng.range(0.9, 0.98) : rng.range(1.0, 1.1);
  const hip = fem ? rng.range(1.0, 1.1) : rng.range(0.95, 1.02);
  const girth = rng.chance(0.25) ? rng.range(1.08, 1.22) : rng.range(0.92, 1.06);
  return {
    skin: rng.pick(SKIN),
    top,
    bottom,
    shoes: rng.pick(SHOES),
    hair,
    acc: rng.pick(ACC),
    inner,
    flags,
    shape: q8(shoulder) * 65536 + q8(hip) * 256 + q8(girth),
    scale,
    pace: (older ? rng.range(0.78, 0.92) : rng.range(0.9, 1.15)) * (fem ? 0.98 : 1.02),
    reflex: older ? rng.range(0.1, 0.5) : rng.range(0.3, 1),
  };
}

export const PHONE_BIT = bit(PART.phone);
