import * as THREE from "three";
import { ENTITY_STRIDE, ENTITY_TYPE, LANE } from "../sim/entityLayout";

/**
 * Pickup rendering: one instanced pool of spinning, bobbing octahedra,
 * tinted by kind (health green-red cross vibes: red; armor blue; money
 * green). Spin/bob are renderer-side time functions — the sim only owns
 * position and kind.
 */

const CAPACITY = 64;
const KIND_COLORS = [0xd8453c, 0x4f8dff, 0x59c96a];

export class PickupPools {
  readonly group = new THREE.Group();

  private pool: THREE.InstancedMesh;
  private material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x222222,
  });
  private m = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private scale = new THREE.Vector3(1, 1, 1);
  private yAxis = new THREE.Vector3(0, 1, 0);
  private color = new THREE.Color();

  constructor() {
    const geo = new THREE.OctahedronGeometry(0.42);
    this.pool = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    this.pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pool.count = 0;
    this.pool.frustumCulled = false;
    this.group.add(this.pool);
  }

  update(f32: Float32Array, u32: Uint32Array, time: number): void {
    const count = f32.length / ENTITY_STRIDE;
    let cursor = 0;
    for (let i = 0; i < count && cursor < CAPACITY; i++) {
      const base = i * ENTITY_STRIDE;
      const tv = u32[base + LANE.typeVariant];
      if (tv >>> 16 !== ENTITY_TYPE.pickup) continue;
      const kind = tv & 0xffff;
      this.pos.set(
        f32[base + LANE.posX],
        f32[base + LANE.posY] + 0.9 + Math.sin(time * 2.2 + i) * 0.12,
        f32[base + LANE.posZ],
      );
      this.quat.setFromAxisAngle(this.yAxis, time * 1.6 + i);
      this.m.compose(this.pos, this.quat, this.scale);
      this.pool.setMatrixAt(cursor, this.m);
      this.color.setHex(KIND_COLORS[Math.min(kind, KIND_COLORS.length - 1)]);
      this.pool.setColorAt(cursor, this.color);
      cursor++;
    }
    this.pool.count = cursor;
    this.pool.instanceMatrix.needsUpdate = true;
    if (this.pool.instanceColor) this.pool.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.pool.geometry.dispose();
    this.pool.dispose();
    this.material.dispose();
  }
}
