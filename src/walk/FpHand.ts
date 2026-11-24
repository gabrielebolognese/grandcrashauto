import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(0.7, 0.7, 0.7); // view-model scale

/**
 * First-person hand (user request, "like in Minecraft"): a blocky forearm in the coral sleeve of the player's top with
 * a skin-coloured hand, low on the right of the view. It swings with every step (same phase as the head bob), rides up
 * when you run, sways when floating, and is always drawn on top (never clips into walls or seats).
 */
export class FpHand {
  readonly root = new THREE.Group();
  private sleeveMat: THREE.MeshLambertMaterial;
  private skinMat: THREE.MeshLambertMaterial;
  private t = 0;

  constructor() {
    this.root.name = 'fp-hand';
    this.root.matrixAutoUpdate = false;
    this.root.userData.noOriginShift = true; // written from the camera every frame
    this.root.visible = false;
    const mk = (color: number) =>
      new THREE.MeshLambertMaterial({ color, depthTest: false, depthWrite: false, fog: false });
    this.sleeveMat = mk(0xff7a6b);
    this.skinMat = mk(0xe8b48f);
    // forearm along -Z (pointing into the view), hand block at its far end
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.42), this.sleeveMat);
    sleeve.position.set(0, 0, -0.1);
    sleeve.renderOrder = 998;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.13), this.skinMat);
    hand.position.set(0, 0.005, -0.375);
    hand.renderOrder = 999;
    for (const m of [sleeve, hand]) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.root.add(m);
    }
  }

  /**
   * phase = walk cycle (radians, one cycle = two steps), k = how much you are walking (0..1), run = 0..1,
   * float = 0..1 (thrown around / falling), fill = emissive fill (cabin lights at night).
   */
  update(cam: THREE.Camera, dt: number, phase: number, k: number, run: number, float: number, fill: number): void {
    this.t += dt;
    const breathe = Math.sin(this.t * 1.7) * 0.006;
    const sw = Math.sin(phase);
    const up = Math.abs(Math.cos(phase));
    const fl = Math.sin(this.t * 7.3) * float;
    // camera space: right, down, forward (camera looks down -Z)
    _p.set(
      0.31 + sw * 0.03 * k + fl * 0.03,
      -0.29 + breathe - up * 0.03 * k + run * 0.03 + float * 0.08,
      -0.42 - run * 0.03,
    );
    _e.set(0.32 + sw * 0.16 * k - run * 0.12 - float * 0.5, 0.18 - sw * 0.06 * k, -0.1 + fl * 0.3);
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);
    this.root.matrix.multiplyMatrices(cam.matrixWorld, _m);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    const f = Math.max(0, fill);
    this.sleeveMat.emissive.setRGB(1, 0.48, 0.42).multiplyScalar(f * 0.6);
    this.skinMat.emissive.setRGB(0.91, 0.7, 0.56).multiplyScalar(f * 0.6);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const c of this.root.children) (c as THREE.Mesh).geometry.dispose();
    this.sleeveMat.dispose();
    this.skinMat.dispose();
  }
}
