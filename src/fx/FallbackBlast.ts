import * as THREE from 'three';

/**
 * Last-resort explosion visual, used only if the GPU particle path is unavailable (init error, shader failure on
 * an exotic mobile driver): an animated fireball sphere (white → yellow → orange → red → smoke) and a rising smoke
 * ball. Plain MeshBasicMaterials, created once at init, so there is ALWAYS a visible big blast.
 */

interface Slot {
  fire: THREE.Mesh;
  smoke: THREE.Mesh;
  fireMat: THREE.MeshBasicMaterial;
  smokeMat: THREE.MeshBasicMaterial;
  t: number;
  r: number;
  x: number;
  y: number;
  z: number;
}

const C0 = new THREE.Color(1, 0.97, 0.85);
const C1 = new THREE.Color(1, 0.75, 0.25);
const C2 = new THREE.Color(1, 0.38, 0.08);
const C3 = new THREE.Color(0.45, 0.1, 0.03);

export class FallbackBlast {
  private slots: Slot[] = [];
  private geo = new THREE.IcosahedronGeometry(1, 2);
  private next = 0;

  constructor(private root: THREE.Object3D) {
    for (let i = 0; i < 3; i++) {
      const fireMat = new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, depthWrite: false, fog: true });
      const smokeMat = new THREE.MeshBasicMaterial({ color: 0x2a2626, transparent: true, depthWrite: false, fog: true });
      const fire = new THREE.Mesh(this.geo, fireMat);
      const smoke = new THREE.Mesh(this.geo, smokeMat);
      fire.visible = smoke.visible = false;
      fire.frustumCulled = smoke.frustumCulled = false;
      fire.renderOrder = 12;
      smoke.renderOrder = 9;
      root.add(fire, smoke);
      this.slots.push({ fire, smoke, fireMat, smokeMat, t: -1, r: 1, x: 0, y: 0, z: 0 });
    }
  }

  trigger(pos: THREE.Vector3, radius: number): void {
    const s = this.slots[this.next];
    this.next = (this.next + 1) % this.slots.length;
    s.t = 0;
    s.r = Math.max(1, radius);
    // root space (the root is shifted by the floating origin)
    s.x = pos.x - this.root.position.x;
    s.y = pos.y - this.root.position.y;
    s.z = pos.z - this.root.position.z;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.t < 0) continue;
      s.t += dt;
      const t = s.t;
      const fireT = Math.min(1, t / 1.4);
      const smokeT = Math.min(1, t / 4.5);
      if (smokeT >= 1) {
        s.t = -1;
        s.fire.visible = s.smoke.visible = false;
        continue;
      }
      const ease = 1 - (1 - fireT) * (1 - fireT);
      s.fire.visible = fireT < 1;
      s.fire.position.set(s.x, s.y + s.r * 0.5 * fireT, s.z);
      s.fire.scale.setScalar(s.r * (0.3 + 0.9 * ease));
      const c = s.fireMat.color;
      if (fireT < 0.15) c.copy(C0).lerp(C1, fireT / 0.15);
      else if (fireT < 0.45) c.copy(C1).lerp(C2, (fireT - 0.15) / 0.3);
      else c.copy(C2).lerp(C3, (fireT - 0.45) / 0.55);
      s.fireMat.opacity = 1 - fireT * fireT;
      s.smoke.visible = t > 0.25;
      s.smoke.position.set(s.x, s.y + s.r * (0.3 + 2.2 * smokeT), s.z);
      s.smoke.scale.setScalar(s.r * (0.7 + 1.1 * Math.sqrt(smokeT)));
      s.smokeMat.opacity = 0.75 * Math.min(1, (t - 0.25) / 0.4) * (1 - smokeT);
    }
  }

  clear(): void {
    for (const s of this.slots) {
      s.t = -1;
      s.fire.visible = s.smoke.visible = false;
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.fire.removeFromParent();
      s.smoke.removeFromParent();
      s.fireMat.dispose();
      s.smokeMat.dispose();
    }
    this.geo.dispose();
  }
}
