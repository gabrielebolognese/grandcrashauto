import { newInfo, sampleTerrain } from './height';
import { sstep } from './noise';

/**
 * Distant mountain ring (runs in a worker): a polar low-poly band around (cx, cz) from rIn to rOut, heights from the
 * natural terrain, back-to-front index order. Colours: hazy rock / forest / snow caps (sRGB bytes).
 */
export interface RingMesh {
  cx: number;
  cz: number;
  rIn: number;
  rOut: number;
  positions: Float32Array; // relative to (cx, cz)
  colors: Uint8Array;
  index: Uint32Array;
  indexCount: number;
}

const INFO = newInfo();

export function buildRing(cx: number, cz: number, rIn: number, rOut: number, segments: number, rings: number, seed: number): RingMesh {
  const nV = segments * (rings + 1);
  const positions = new Float32Array(nV * 3);
  const colors = new Uint8Array(nV * 3);
  const hs = new Float32Array(nV);
  for (let r = 0; r <= rings; r++) {
    // geometric radial spacing (finer near the inner edge)
    const t = r / rings;
    const rad = rIn * Math.pow(rOut / rIn, t);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      let h = sampleTerrain(cx + x, cz + z, INFO, seed);
      if (INFO.flat < 0) h = 0;
      const v = r * segments + s;
      // inner edge tucks under the loaded terrain
      const y = r === 0 ? h - 40 : h;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      hs[v] = h;
      const snow = sstep(560, 700, h);
      const rock = sstep(250, 520, h);
      const low = h < 2 ? 1 : 0;
      // pastel atmospheric palette (the shader adds the haze)
      let cr = 122, cg = 160, cb = 104; // forest/hill green
      cr += (150 - cr) * rock;
      cg += (146 - cg) * rock;
      cb += (152 - cb) * rock;
      cr += (238 - cr) * snow;
      cg += (243 - cg) * snow;
      cb += (250 - cb) * snow;
      if (low) {
        cr = 225;
        cg = 205;
        cb = 165;
      }
      colors[v * 3] = cr;
      colors[v * 3 + 1] = cg;
      colors[v * 3 + 2] = cb;
    }
  }
  // back to front: outer bands first (painter's order with the camera near the centre)
  const index = new Uint32Array(segments * rings * 6);
  let ic = 0;
  for (let r = rings - 1; r >= 0; r--) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + s1;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + s1;
      // skip open sea
      if (hs[a] < -1 && hs[b] < -1 && hs[c] < -1 && hs[d] < -1) continue;
      // CCW seen from above
      index[ic++] = a;
      index[ic++] = b;
      index[ic++] = c;
      index[ic++] = b;
      index[ic++] = d;
      index[ic++] = c;
    }
  }
  return { cx, cz, rIn, rOut, positions, colors, index: index.slice(0, ic), indexCount: ic };
}
