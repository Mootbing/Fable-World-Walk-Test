import * as THREE from "three";
import { ENTITY_STRIDE, ENTITY_TYPE, LANE } from "../sim/entityLayout";

/**
 * Instanced pedestrian rendering: torso (tinted shirt), head (skin),
 * arms (tinted, 2/ped), legs (dark, 2/ped). Rigid-limb gait swung from the
 * sim's animPhase lane — same scheme as the PlayerAvatar, but four draw
 * calls for the whole crowd.
 */

const CAPACITY = 128;
const LEG = 0.8;
const TORSO = 0.62;
const ARM = 0.62;

export const SHIRT_PALETTE = [
  0x3b6ea5, 0xa53b3b, 0x3ba56e, 0xa5973b, 0x7b3fa0, 0x47b7c4, 0xc46f2a, 0x2f3640,
];

class Pool {
  readonly mesh: THREE.InstancedMesh;
  cursor = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  push(matrix: THREE.Matrix4, color?: THREE.Color): void {
    if (this.cursor >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.cursor, matrix);
    if (color) this.mesh.setColorAt(this.cursor, color);
    this.cursor++;
  }

  finish(): void {
    this.mesh.count = this.cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.cursor = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

export class PedPools {
  readonly group = new THREE.Group();

  private torso: Pool;
  private head: Pool;
  private arm: Pool;
  private leg: Pool;

  private white = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private skin = new THREE.MeshLambertMaterial({ color: 0xc9a07a });
  private pants = new THREE.MeshLambertMaterial({ color: 0x2d3138 });

  private root = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private limbQuat = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private limbPos = new THREE.Vector3();
  private color = new THREE.Color();
  private xAxis = new THREE.Vector3(1, 0, 0);

  constructor() {
    const torsoGeo = new THREE.BoxGeometry(0.42, TORSO, 0.24);
    torsoGeo.translate(0, LEG + TORSO / 2, 0);
    this.torso = new Pool(torsoGeo, this.white, CAPACITY);

    const headGeo = new THREE.BoxGeometry(0.24, 0.26, 0.26);
    headGeo.translate(0, LEG + TORSO + 0.16, 0);
    this.head = new Pool(headGeo, this.skin, CAPACITY);

    // Limbs pivot at the joint: geometry hangs down from origin.
    const armGeo = new THREE.BoxGeometry(0.12, ARM, 0.12);
    armGeo.translate(0, -ARM / 2, 0);
    this.arm = new Pool(armGeo, this.white, CAPACITY * 2);

    const legGeo = new THREE.BoxGeometry(0.16, LEG, 0.16);
    legGeo.translate(0, -LEG / 2, 0);
    this.leg = new Pool(legGeo, this.pants, CAPACITY * 2);

    this.group.add(this.torso.mesh, this.head.mesh, this.arm.mesh, this.leg.mesh);
  }

  update(f32: Float32Array, u32: Uint32Array): void {
    const count = f32.length / ENTITY_STRIDE;
    const shoulder = LEG + TORSO - 0.04;

    for (let i = 0; i < count; i++) {
      const base = i * ENTITY_STRIDE;
      const tv = u32[base + LANE.typeVariant];
      if (tv >>> 16 !== ENTITY_TYPE.ped) continue;
      const variant = tv & 0xffff;

      // Feet sit at posY (sim peds report ground level, not eye height).
      this.pos.set(f32[base + LANE.posX], f32[base + LANE.posY], f32[base + LANE.posZ]);
      this.quat.set(
        f32[base + LANE.quatX],
        f32[base + LANE.quatY],
        f32[base + LANE.quatZ],
        f32[base + LANE.quatW],
      );
      const down = (u32[base + LANE.stateFlags] & 16) !== 0;
      if (down) {
        // Knocked flat: tip the whole body back around the feet.
        this.limbQuat.setFromAxisAngle(this.xAxis, -1.45);
        this.quat.multiply(this.limbQuat);
      }
      this.root.compose(this.pos, this.quat, this.one);

      this.color.setHex(SHIRT_PALETTE[variant % SHIRT_PALETTE.length]);
      this.torso.push(this.root, this.color);
      this.head.push(this.root);

      const speed = f32[base + LANE.speed];
      const phase = f32[base + LANE.animPhase];
      const amp = 0.45 + 0.4 * Math.min(1, speed / 2.5);
      const swing = !down && speed > 0.05 ? Math.sin(phase * Math.PI * 2) * amp : 0;

      this.pushLimb(this.arm, 0.28, shoulder, -swing * 0.7, this.color);
      this.pushLimb(this.arm, -0.28, shoulder, swing * 0.7, this.color);
      this.pushLimb(this.leg, 0.11, LEG, swing);
      this.pushLimb(this.leg, -0.11, LEG, -swing);
    }

    this.torso.finish();
    this.head.finish();
    this.arm.finish();
    this.leg.finish();
  }

  private pushLimb(pool: Pool, x: number, y: number, swing: number, color?: THREE.Color): void {
    this.limbPos.set(x, y, 0);
    this.limbQuat.setFromAxisAngle(this.xAxis, swing);
    this.local.compose(this.limbPos, this.limbQuat, this.one);
    this.local.premultiply(this.root);
    pool.push(this.local, color);
  }

  dispose(): void {
    for (const p of [this.torso, this.head, this.arm, this.leg]) p.dispose();
    this.white.dispose();
    this.skin.dispose();
    this.pants.dispose();
  }
}
