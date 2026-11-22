import * as THREE from 'three';

/**
 * A fixed set of PointLights created ONCE at init and kept in the scene at intensity 0 (never added/removed at
 * runtime: that would recompile every lit shader). Each frame, effects submit light requests (explosion flashes,
 * fire glows); the strongest N get a real light, the rest stay emissive-only.
 */

const MAX_REQ = 24;

export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  private n = 0;
  private reqX = new Float32Array(MAX_REQ);
  private reqY = new Float32Array(MAX_REQ);
  private reqZ = new Float32Array(MAX_REQ);
  private reqI = new Float32Array(MAX_REQ);
  private reqR = new Float32Array(MAX_REQ);
  private reqG = new Float32Array(MAX_REQ);
  private reqB = new Float32Array(MAX_REQ);
  private reqD = new Float32Array(MAX_REQ);
  private order = new Int32Array(MAX_REQ);

  constructor(scene: THREE.Scene, count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffc080, 0, 60, 2);
      l.name = 'fx-light-' + i;
      l.castShadow = false;
      l.position.set(0, -1000, 0);
      scene.add(l);
      this.lights.push(l);
    }
  }

  begin(): void {
    this.n = 0;
  }

  request(x: number, y: number, z: number, intensity: number, r: number, g: number, b: number, distance: number): void {
    if (intensity <= 0.01) return;
    let i = this.n;
    if (i >= MAX_REQ) {
      // replace the weakest request if this one is stronger
      let w = 0;
      for (let k = 1; k < MAX_REQ; k++) if (this.reqI[k] < this.reqI[w]) w = k;
      if (this.reqI[w] >= intensity) return;
      i = w;
    } else this.n++;
    this.reqX[i] = x;
    this.reqY[i] = y;
    this.reqZ[i] = z;
    this.reqI[i] = intensity;
    this.reqR[i] = r;
    this.reqG[i] = g;
    this.reqB[i] = b;
    this.reqD[i] = distance;
  }

  end(): void {
    const n = this.n;
    for (let i = 0; i < n; i++) this.order[i] = i;
    // partial selection sort: strongest first (n is tiny)
    const m = Math.min(n, this.lights.length);
    for (let a = 0; a < m; a++) {
      let best = a;
      for (let b = a + 1; b < n; b++) if (this.reqI[this.order[b]] > this.reqI[this.order[best]]) best = b;
      const t = this.order[a];
      this.order[a] = this.order[best];
      this.order[best] = t;
    }
    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k];
      if (k < m) {
        const i = this.order[k];
        l.position.set(this.reqX[i], this.reqY[i], this.reqZ[i]);
        l.intensity = this.reqI[i];
        l.color.setRGB(this.reqR[i], this.reqG[i], this.reqB[i]);
        l.distance = this.reqD[i];
      } else {
        l.intensity = 0;
      }
    }
  }

  off(): void {
    for (const l of this.lights) l.intensity = 0;
  }

  dispose(): void {
    for (const l of this.lights) {
      l.removeFromParent();
      l.dispose();
    }
    this.lights.length = 0;
  }
}
