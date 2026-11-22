import * as THREE from 'three';
import { GeoBuilder, PAINT, METAL, RUBBER, DARK, type RGB, v3, frameAlong } from './builder';

/** Landing gear: oleo struts, torque links, twin wheels or 4-wheel bogies, doors, and the prop plane's spring legs + wheel pants. */

export interface GearDef {
  name: string;
  mount: string; // part it hangs from (joint)
  top: THREE.Vector3; // strut top = retraction hinge (design space)
  wheel: THREE.Vector3; // wheel / bogie centre with gear down (design space)
  wheelR: number;
  wheelW: number;
  layout: 'single' | 'twin' | 'bogie';
  track?: number; // twin/bogie lateral wheel spacing (centre to centre)
  axleSpacing?: number; // bogie
  strutR: number;
  steerable: boolean;
  retractAxis?: THREE.Vector3; // hinge axis (positive angle = retract), null = fixed gear
  retractAngle?: number;
  door?: RGB; // gear door colour (jets)
  pant?: RGB; // wheel pant colour (prop)
  spring?: boolean; // prop spring-steel leg (from top, out and down to the wheel)
}

const TYRE: RGB = [0.05, 0.05, 0.055];
const HUB: RGB = [0.62, 0.63, 0.66];
const STRUT: RGB = [0.55, 0.56, 0.58];
const CHROME: RGB = [0.8, 0.81, 0.83];

export function wheel(b: GeoBuilder, c: THREE.Vector3, R: number, W: number, seg: number): void {
  const m = frameAlong(c.clone().add(v3(-W / 2, 0, 0)), c.clone().add(v3(W / 2, 0, 0)));
  b.push(m);
  b.set({ color: TYRE, mat: RUBBER });
  const rh = R * 0.6;
  b.lathe([[rh, 0.0], [R * 0.86, 0.0], [R * 0.97, W * 0.08], [R, W * 0.3], [R, W * 0.7], [R * 0.97, W * 0.92], [R * 0.86, W], [rh, W]], seg);
  b.set({ color: HUB, mat: METAL });
  b.disc(rh, W * 0.12, seg, -1, rh * 0.25);
  b.disc(rh, W * 0.88, seg, 1, rh * 0.25);
  b.set({ color: [0.25, 0.25, 0.27], mat: METAL });
  b.lathe([[rh, W * 0.0], [rh, W * 0.12]], seg, { flip: true });
  b.lathe([[rh, W * 0.88], [rh, W]], seg, { flip: true });
  b.disc(rh * 0.25, W * 0.2, Math.max(6, seg >> 1), -1);
  b.disc(rh * 0.25, W * 0.8, Math.max(6, seg >> 1), 1);
  b.pop();
}

export function buildGear(b: GeoBuilder, g: GearDef, detail: 0 | 1 | 2): void {
  const seg = detail === 0 ? 20 : detail === 1 ? 10 : 6;
  const sseg = detail === 0 ? 10 : 6;
  const R = g.wheelR;
  if (g.spring) {
    // flat spring-steel leg from the fuselage out to the axle
    b.set({ color: g.pant ?? STRUT, mat: PAINT });
    const axle = g.wheel.clone().add(v3(-Math.sign(g.wheel.x || 1) * g.wheelW * 0.7, 0, 0));
    const mid = g.top.clone().lerp(axle, 0.5).add(v3(0, -0.06, 0));
    b.tube([g.top, mid, axle.clone().add(v3(0, R * 0.25, 0))], g.strutR, 6);
  } else if (detail < 2) {
    const strutBottom = g.wheel.clone().add(v3(0, g.layout === 'bogie' ? R * 0.2 : R * 0.15, 0));
    if (g.layout === 'single' && !g.pant) strutBottom.x += Math.sign(g.wheel.x || 1) * -(g.wheelW * 0.75);
    const oleoTop = g.top.clone().lerp(strutBottom, 0.55);
    b.set({ color: STRUT, mat: METAL });
    b.cylinder(g.top, oleoTop, g.strutR, g.strutR, sseg);
    b.set({ color: CHROME, mat: METAL });
    b.cylinder(oleoTop, strutBottom, g.strutR * 0.72, g.strutR * 0.72, sseg);
    if (detail === 0) {
      // torque links
      b.set({ color: STRUT, mat: METAL });
      const lz = g.strutR * 1.6;
      const a = oleoTop.clone().add(v3(0, -g.strutR * 0.5, lz * 0.5));
      const m = oleoTop.clone().lerp(strutBottom, 0.5).add(v3(0, 0, lz));
      const c = strutBottom.clone().add(v3(0, g.strutR, lz * 0.5));
      b.cylinder(a, m, g.strutR * 0.22, g.strutR * 0.22, 4, false);
      b.cylinder(m, c, g.strutR * 0.22, g.strutR * 0.22, 4, false);
      // drag brace
      const braceTop = g.top.clone().add(v3(0, -g.strutR, -Math.max(0.4, (g.top.y - g.wheel.y) * 0.35)));
      b.cylinder(braceTop, oleoTop.clone().lerp(g.top, 0.3), g.strutR * 0.35, g.strutR * 0.35, 5, false);
    }
  } else {
    b.set({ color: STRUT, mat: METAL });
    b.box((g.top.x + g.wheel.x) / 2, (g.top.y + g.wheel.y) / 2, (g.top.z + g.wheel.z) / 2, g.strutR, (g.top.y - g.wheel.y) / 2, g.strutR);
  }
  // wheels
  const t = g.track ?? g.wheelW * 1.3;
  const wheelsAt: THREE.Vector3[] = [];
  if (g.layout === 'single') wheelsAt.push(g.wheel.clone());
  else if (g.layout === 'twin') wheelsAt.push(g.wheel.clone().add(v3(t / 2, 0, 0)), g.wheel.clone().add(v3(-t / 2, 0, 0)));
  else {
    const a = (g.axleSpacing ?? R * 2.4) / 2;
    for (const dz of [a, -a]) for (const dx of [t / 2, -t / 2]) wheelsAt.push(g.wheel.clone().add(v3(dx, 0, dz)));
    // bogie beam
    b.set({ color: STRUT, mat: METAL });
    b.box(g.wheel.x, g.wheel.y + R * 0.05, g.wheel.z, g.strutR * 0.7, g.strutR * 0.6, a + R * 0.3);
  }
  if (g.layout !== 'single' && detail < 2) {
    b.set({ color: STRUT, mat: METAL });
    for (const dz of g.layout === 'bogie' ? [(g.axleSpacing ?? R * 2.4) / 2, -(g.axleSpacing ?? R * 2.4) / 2] : [0]) {
      b.cylinder(g.wheel.clone().add(v3(t / 2, 0, dz)), g.wheel.clone().add(v3(-t / 2, 0, dz)), R * 0.12, R * 0.12, 6, false);
    }
  }
  for (const w of wheelsAt) wheel(b, w, R, g.wheelW, seg);
  if (g.pant) {
    // teardrop wheel pant around the upper wheel
    const c = g.wheel.clone().add(v3(0, R * 0.25, 0));
    b.push(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(g.wheelW * 1.25, R * 1.0, 1)));
    b.set({ color: g.pant, mat: PAINT });
    const L = R * 2.9;
    b.lathe([[0.02, -L * 0.62], [0.45, -L * 0.45], [0.85, -L * 0.2], [1.0, 0], [0.92, L * 0.2], [0.6, L * 0.34], [0.02, L * 0.4]], seg);
    b.pop();
  }
  if (g.door && detail < 2) {
    // gear leg door (outboard face of the strut)
    b.set({ color: g.door, mat: PAINT });
    const side = Math.sign(g.wheel.x) || 1;
    const x = g.top.x + side * (g.strutR * 1.8 + 0.02);
    const y0 = g.top.y - 0.05;
    const y1 = g.wheel.y + R * 1.25;
    const hz = Math.max(R * 0.9, g.strutR * 3);
    const zc = g.top.z;
    const P = [v3(x, y0, zc + hz), v3(x, y0, zc - hz), v3(x, y1, zc - hz * 0.9), v3(x, y1, zc + hz * 0.9)];
    if (g.wheel.x !== 0) {
      b.fquadF(P[0], P[1], P[2], P[3], v3(side, 0, 0));
      b.fquadF(P[0], P[1], P[2], P[3], v3(-side, 0, 0));
    } else {
      // nose gear: two doors beside the strut
      for (const sx of [1, -1]) {
        const xx = sx * (g.strutR * 2.2 + 0.03);
        const Q = [v3(xx, y0, zc + hz), v3(xx, y0, zc - hz), v3(xx, y1, zc - hz * 0.9), v3(xx, y1, zc + hz * 0.9)];
        b.fquadF(Q[0], Q[1], Q[2], Q[3], v3(sx, 0, 0));
        b.fquadF(Q[0], Q[1], Q[2], Q[3], v3(-sx, 0, 0));
      }
    }
  }
  b.set({ color: [1, 1, 1], mat: DARK });
}
