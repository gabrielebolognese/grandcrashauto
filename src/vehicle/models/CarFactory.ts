import * as THREE from 'three';
import type { CarBuild } from '../CarBuild';
import type { CarModelInfo, CarVisual, GameContext, ICarFactory, WheelVisual } from '../../game/contracts';

/** STUB — replaced by the car models module (4 procedural car bodies, wheels, kits, paint). */
export class CarFactory implements ICarFactory {
  readonly name = 'cars';
  readonly models: CarModelInfo[] = [
    { id: 'coupe', name: 'Coupe', description: 'Sports coupe' },
    { id: 'muscle', name: 'Muscle', description: 'Muscle car' },
    { id: 'hatch', name: 'Hatch', description: 'Compact hatchback' },
    { id: 'suv', name: 'SUV', description: 'SUV' },
  ];
  constructor(private ctx: GameContext) {}
  init(): void {}

  create(build: CarBuild): CarVisual {
    const root = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: build.paint.color, metalness: 0.4, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 4.2), paint);
    body.position.y = 0.55;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 2), new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1 }));
    cabin.position.set(0, 1.05, -0.2);
    body.castShadow = cabin.castShadow = true;
    root.add(body, cabin);
    const r = 0.36;
    const wheelPositions = [
      new THREE.Vector3(0.82, r, 1.35),
      new THREE.Vector3(-0.82, r, 1.35),
      new THREE.Vector3(0.82, r, -1.3),
      new THREE.Vector3(-0.82, r, -1.3),
    ];
    const tyreGeo = new THREE.CylinderGeometry(r, r, 0.26, 16).rotateZ(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const hubGeo = new THREE.BoxGeometry(0.27, 0.12, 0.5);
    const wheels: WheelVisual[] = wheelPositions.map((p) => {
      const pivot = new THREE.Object3D();
      pivot.position.copy(p);
      const spin = new THREE.Object3D();
      spin.add(new THREE.Mesh(tyreGeo, tyreMat), new THREE.Mesh(hubGeo, tyreMat));
      pivot.add(spin);
      root.add(pivot);
      return { pivot, spin };
    });
    return {
      root,
      dims: {
        wheelPositions,
        wheelRadius: r,
        wheelWidth: 0.26,
        halfExtents: new THREE.Vector3(0.9, 0.45, 2.1),
        colliderOffset: new THREE.Vector3(0, 0.75, 0),
        mass: 1200,
      },
      wheels,
      parts: {},
      applyBuild: (b) => paint.color.set(b.paint.color),
      setLights: () => {},
      dent: () => {},
      setGlassDamage: () => {},
      setCharred: (a) => paint.color.set(build.paint.color).lerp(new THREE.Color(0x111111), a),
      detachPart: () => null,
      repair: () => paint.color.set(build.paint.color),
      update: () => {},
      dispose: () => root.traverse((o) => (o as THREE.Mesh).geometry?.dispose()),
    };
  }
}
