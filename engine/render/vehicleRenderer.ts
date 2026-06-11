import * as THREE from "three";
import { ENTITY_STRIDE, ENTITY_TYPE, LANE } from "../sim/entityLayout";

/**
 * Renders vehicle entities from the sim buffer. PR6 scale (a handful of
 * cars) uses one Group per vehicle; PR7 swaps this for InstancedMesh pools
 * behind the same update() contract.
 */

interface VehicleParts {
  root: THREE.Group;
  /** Wheel steer pivots (front) and spin meshes (all four). */
  frontPivots: THREE.Group[];
  spinners: THREE.Mesh[];
}

const WHEEL_RADIUS = 0.33;

function buildSedan(materials: SedanMaterials): VehicleParts {
  const root = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.55, 4.4), materials.paint);
  body.position.y = WHEEL_RADIUS + 0.28;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.5, 2.1), materials.glass);
  cabin.position.set(0, WHEEL_RADIUS + 0.28 + 0.5, 0.25);
  root.add(body, cabin);

  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.22, 12);
  wheelGeo.rotateZ(Math.PI / 2);

  const frontPivots: THREE.Group[] = [];
  const spinners: THREE.Mesh[] = [];
  // Forward is -Z: front axle at z = -1.45.
  for (const [x, z, front] of [
    [0.78, -1.45, true],
    [-0.78, -1.45, true],
    [0.78, 1.45, false],
    [-0.78, 1.45, false],
  ] as [number, number, boolean][]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_RADIUS, z);
    const wheel = new THREE.Mesh(wheelGeo, materials.tire);
    pivot.add(wheel);
    root.add(pivot);
    spinners.push(wheel);
    if (front) frontPivots.push(pivot);
  }

  return { root, frontPivots, spinners };
}

interface SedanMaterials {
  paint: THREE.Material;
  glass: THREE.Material;
  tire: THREE.Material;
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private vehicles = new Map<number, VehicleParts>();
  private quat = new THREE.Quaternion();
  private materials: SedanMaterials = {
    paint: new THREE.MeshLambertMaterial({ color: 0xb33a2f }),
    glass: new THREE.MeshLambertMaterial({ color: 0x20242c }),
    tire: new THREE.MeshLambertMaterial({ color: 0x16181c }),
  };

  update(f32: Float32Array, u32: Uint32Array): void {
    const count = f32.length / ENTITY_STRIDE;
    const live = new Set<number>();
    for (let i = 0; i < count; i++) {
      const base = i * ENTITY_STRIDE;
      const type = u32[base + LANE.typeVariant] >>> 16;
      if (type !== ENTITY_TYPE.vehicle) continue;
      const id = u32[base + LANE.id];
      live.add(id);

      let parts = this.vehicles.get(id);
      if (!parts) {
        parts = buildSedan(this.materials);
        this.vehicles.set(id, parts);
        this.group.add(parts.root);
      }

      parts.root.position.set(f32[base + LANE.posX], f32[base + LANE.posY], f32[base + LANE.posZ]);
      this.quat.set(
        f32[base + LANE.quatX],
        f32[base + LANE.quatY],
        f32[base + LANE.quatZ],
        f32[base + LANE.quatW],
      );
      parts.root.quaternion.copy(this.quat);

      const spin = f32[base + LANE.animPhase];
      const steer = f32[base + LANE.aux0];
      for (const wheel of parts.spinners) wheel.rotation.x = -spin;
      for (const pivot of parts.frontPivots) pivot.rotation.y = -steer;
    }

    for (const [id, parts] of this.vehicles) {
      if (!live.has(id)) {
        this.group.remove(parts.root);
        disposeTree(parts.root);
        this.vehicles.delete(id);
      }
    }
  }

  dispose(): void {
    for (const parts of this.vehicles.values()) disposeTree(parts.root);
    this.vehicles.clear();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}
