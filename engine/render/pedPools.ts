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
export const SKIN_PALETTE = [0xc9a07a, 0x8d5a3b, 0xe8c39a, 0x6e4428, 0xb37e54, 0xf0d0ae];
export const PANTS_PALETTE = [0x2d3138, 0x3a3f63, 0x5b4632, 0x474747, 0x2e4a33, 0x67563f];
export const HAIR_PALETTE = [0x191512, 0x3a2a18, 0x6b4a2a, 0x999077, 0x23283a, 0x501f16];

/** Cheap integer hash so each variant dresses the same every frame. */
function hashVariant(v: number, salt: number): number {
  let h = (v + 1) * 2654435761 + salt * 40503;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

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
  private pelvis: Pool;
  private head: Pool;
  private hair: Pool;
  private arm: Pool;
  private leg: Pool;
  /** Peds drawn last frame (test observability). */
  lastCount = 0;

  private white = new THREE.MeshLambertMaterial({ color: 0xffffff });

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
    const torsoGeo = new THREE.BoxGeometry(0.42, TORSO - 0.16, 0.24);
    torsoGeo.translate(0, LEG + 0.16 + (TORSO - 0.16) / 2, 0);
    this.torso = new Pool(torsoGeo, this.white, CAPACITY);

    // Hips in pants color split the slab silhouette at the waist.
    const pelvisGeo = new THREE.BoxGeometry(0.4, 0.18, 0.23);
    pelvisGeo.translate(0, LEG + 0.08, 0);
    this.pelvis = new Pool(pelvisGeo, this.white, CAPACITY);

    const headGeo = new THREE.BoxGeometry(0.24, 0.26, 0.26);
    headGeo.translate(0, LEG + TORSO + 0.16, 0);
    this.head = new Pool(headGeo, this.white, CAPACITY);

    // Hair cap (or a uniform cap for cops) sits on the head box.
    const hairGeo = new THREE.BoxGeometry(0.26, 0.09, 0.28);
    hairGeo.translate(0, LEG + TORSO + 0.32, 0.01);
    this.hair = new Pool(hairGeo, this.white, CAPACITY);

    // Limbs pivot at the joint: geometry hangs down from origin.
    const armGeo = new THREE.BoxGeometry(0.12, ARM, 0.12);
    armGeo.translate(0, -ARM / 2, 0);
    this.arm = new Pool(armGeo, this.white, CAPACITY * 2);

    const legGeo = new THREE.BoxGeometry(0.16, LEG, 0.16);
    legGeo.translate(0, -LEG / 2, 0);
    this.leg = new Pool(legGeo, this.white, CAPACITY * 2);

    this.group.add(
      this.torso.mesh,
      this.pelvis.mesh,
      this.head.mesh,
      this.hair.mesh,
      this.arm.mesh,
      this.leg.mesh,
    );
  }

  update(f32: Float32Array, u32: Uint32Array): void {
    const count = f32.length / ENTITY_STRIDE;
    const shoulder = LEG + TORSO - 0.04;
    let drawn = 0;

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

      const speed = f32[base + LANE.speed];
      const phase = f32[base + LANE.animPhase];
      const walking = !down && speed > 0.05;
      // Gait bob keeps the whole figure breathing with the step.
      if (walking) this.pos.y += Math.abs(Math.sin(phase * Math.PI * 2)) * 0.035;
      this.root.compose(this.pos, this.quat, this.one);

      const cop = variant === 100;
      const shirt = cop ? 0x1c2f52 : SHIRT_PALETTE[hashVariant(variant, 1) % SHIRT_PALETTE.length];
      const pants = cop ? 0x16233d : PANTS_PALETTE[hashVariant(variant, 2) % PANTS_PALETTE.length];
      const skin = SKIN_PALETTE[hashVariant(variant, 3) % SKIN_PALETTE.length];
      const hair = cop ? 0x16233d : HAIR_PALETTE[hashVariant(variant, 4) % HAIR_PALETTE.length];

      this.color.setHex(shirt);
      this.torso.push(this.root, this.color);
      this.head.push(this.root, this.color.setHex(skin));
      this.hair.push(this.root, this.color.setHex(hair));
      this.pelvis.push(this.root, this.color.setHex(pants));

      const amp = 0.45 + 0.4 * Math.min(1, speed / 2.5);
      const swing = walking ? Math.sin(phase * Math.PI * 2) * amp : 0;

      this.color.setHex(shirt);
      this.pushLimb(this.arm, 0.28, shoulder, -swing * 0.7, 0.1, this.color);
      this.pushLimb(this.arm, -0.28, shoulder, swing * 0.7, -0.1, this.color);
      this.color.setHex(pants);
      this.pushLimb(this.leg, 0.11, LEG, swing, 0, this.color);
      this.pushLimb(this.leg, -0.11, LEG, -swing, 0, this.color);
      drawn++;
    }

    this.lastCount = drawn;
    this.torso.finish();
    this.pelvis.finish();
    this.head.finish();
    this.hair.finish();
    this.arm.finish();
    this.leg.finish();
  }

  private zAxis = new THREE.Vector3(0, 0, 1);
  private tiltQuat = new THREE.Quaternion();

  private pushLimb(
    pool: Pool,
    x: number,
    y: number,
    swing: number,
    splay: number,
    color?: THREE.Color,
  ): void {
    this.limbPos.set(x, y, 0);
    this.limbQuat.setFromAxisAngle(this.xAxis, swing);
    if (splay !== 0) {
      this.tiltQuat.setFromAxisAngle(this.zAxis, splay);
      this.limbQuat.multiply(this.tiltQuat);
    }
    this.local.compose(this.limbPos, this.limbQuat, this.one);
    this.local.premultiply(this.root);
    pool.push(this.local, color);
  }

  dispose(): void {
    for (const p of [this.torso, this.pelvis, this.head, this.hair, this.arm, this.leg]) {
      p.dispose();
    }
    this.white.dispose();
  }
}
