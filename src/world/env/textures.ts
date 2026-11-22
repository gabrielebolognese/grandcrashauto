import * as THREE from 'three';

/** Small deterministic PRNG (textures only; not city layout). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value-noise fBm in [0,1] on an N×N grid. */
function tileNoise(N: number, base: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(N * N);
  const rnd = mulberry32(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const g = base << o;
    const lattice = new Float32Array(g * g);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    for (let y = 0; y < N; y++) {
      const fy = (y / N) * g;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % g) * g;
      const yb = ((y0 + 1) % g) * g;
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * g;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % g;
        const xb = (x0 + 1) % g;
        const v0 = lattice[ya + xa] + (lattice[ya + xb] - lattice[ya + xa]) * sx;
        const v1 = lattice[yb + xa] + (lattice[yb + xb] - lattice[yb + xa]) * sx;
        out[y * N + x] += (v0 + (v1 - v0) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Water detail texture (tileable, linear data):
 *  RG = ripple normal XY (0.5 = flat), B = foam / breakup noise, A = large blotch noise.
 */
export function makeWaterTexture(N = 256): THREE.DataTexture {
  const rnd = mulberry32(90210);
  const h = new Float32Array(N * N);
  // Sum of integer-frequency sines → perfectly tileable, ocean-ish anisotropic ripples (mostly travelling along ±Z).
  const waves: { kx: number; ky: number; a: number; p: number }[] = [];
  for (let i = 0; i < 34; i++) {
    const kmag = 3 + Math.pow(rnd(), 1.6) * 26;
    const ang = Math.PI / 2 + (rnd() - 0.5) * 2.4;
    const kx = Math.round(Math.cos(ang) * kmag);
    const ky = Math.round(Math.sin(ang) * kmag);
    if (kx === 0 && ky === 0) continue;
    waves.push({ kx, ky, a: 1 / Math.pow(Math.hypot(kx, ky), 1.25), p: rnd() * Math.PI * 2 });
  }
  const TAU = Math.PI * 2;
  const sinRow = new Float32Array(N);
  for (const w of waves) {
    for (let y = 0; y < N; y++) {
      const vy = (w.ky * y) / N;
      for (let x = 0; x < N; x++) sinRow[x] = Math.sin(TAU * ((w.kx * x) / N + vy) + w.p);
      // s + 0.35 s² → sharper crests, flatter troughs (smooth, so normals stay continuous).
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const s = sinRow[x];
        h[row + x] += w.a * (s + 0.35 * s * s);
      }
    }
  }
  const foam = tileNoise(N, 8, 5, 4242);
  const blotch = tileNoise(N, 4, 3, 777);

  // Normals from central differences, normalised so the steepest slope maps to ~±0.95.
  const gx = new Float32Array(N * N);
  const gy = new Float32Array(N * N);
  let maxG = 1e-6;
  for (let y = 0; y < N; y++) {
    const yu = ((y + 1) % N) * N;
    const yd = ((y - 1 + N) % N) * N;
    for (let x = 0; x < N; x++) {
      const xr = (x + 1) % N;
      const xl = (x - 1 + N) % N;
      const i = y * N + x;
      gx[i] = h[y * N + xr] - h[y * N + xl];
      gy[i] = h[yu + x] - h[yd + x];
      maxG = Math.max(maxG, Math.abs(gx[i]), Math.abs(gy[i]));
    }
  }
  const data = new Uint8Array(N * N * 4);
  const s = 0.95 / maxG;
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round((gx[i] * s * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((gy[i] * s * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, (foam[i] - 0.2) / 0.6)) * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, (blotch[i] - 0.25) / 0.5)) * 255);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'env.waterDetail';
  return tex;
}
