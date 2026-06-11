import * as THREE from "three";
import { ENTITY_STRIDE, ENTITY_TYPE, LANE } from "../sim/entityLayout";
import { KITS, PAINT_PALETTE, WHEEL_RADIUS } from "./vehicleKits";

/**
 * Instanced vehicle rendering: one InstancedMesh per kind for bodies and
 * cabins, one shared wheel pool, one shared topper pool (taxi signs /
 * police lightbars). Draw calls stay constant no matter how many vehicles
 * the sim spawns — this is the renderer kit traffic (PR9) plugs into.
 */

const CAPACITY = 256;
const WHEEL_CAPACITY = CAPACITY * 4;

class Pool {
  readonly mesh: THREE.InstancedMesh;
  cursor = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Instances scatter across the streamed world; per-pool sphere culling
    // would be wrong and the sim already bounds them to the local bubble.
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.cursor = 0;
  }

  push(matrix: THREE.Matrix4, color?: THREE.Color): void {
    if (this.cursor >= CAPACITY * 4) return;
    this.mesh.setMatrixAt(this.cursor, matrix);
    if (color) this.mesh.setColorAt(this.cursor, color);
    this.cursor++;
  }

  end(): void {
    this.mesh.count = this.cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

export class VehiclePools {
  readonly group = new THREE.Group();

  private bodies: Pool[] = [];
  private cabins: Pool[] = [];
  private wheels: Pool;
  private toppers: Pool;

  private white = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private glass = new THREE.MeshLambertMaterial({ color: 0x20242c });
  private tire = new THREE.MeshLambertMaterial({ color: 0x16181c });

  private m = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private wheelQuat = new THREE.Quaternion();
  private spinQuat = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private wheelPos = new THREE.Vector3();
  private color = new THREE.Color();
  private xAxis = new THREE.Vector3(1, 0, 0);
  private yAxis = new THREE.Vector3(0, 1, 0);

  constructor() {
    for (const kit of KITS) {
      const bodyGeo = new THREE.BoxGeometry(kit.width, kit.bodyH, kit.length);
      bodyGeo.translate(0, WHEEL_RADIUS + kit.bodyH / 2 - 0.05, 0);
      const body = new Pool(bodyGeo, this.white, CAPACITY);
      this.bodies.push(body);

      const cabinGeo = new THREE.BoxGeometry(kit.cabinW, kit.cabinH, kit.cabinLen);
      cabinGeo.translate(0, WHEEL_RADIUS + kit.bodyH - 0.05 + kit.cabinH / 2, kit.cabinZ);
      const cabin = new Pool(cabinGeo, this.glass, CAPACITY);
      this.cabins.push(cabin);

      this.group.add(body.mesh, cabin.mesh);
    }

    const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.22, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    this.wheels = new Pool(wheelGeo, this.tire, WHEEL_CAPACITY);

    const topperGeo = new THREE.BoxGeometry(0.65, 0.16, 0.32);
    this.toppers = new Pool(topperGeo, this.white, CAPACITY);

    this.group.add(this.wheels.mesh, this.toppers.mesh);
  }

  update(f32: Float32Array, u32: Uint32Array): void {
    for (const p of this.bodies) p.begin();
    for (const p of this.cabins) p.begin();
    this.wheels.begin();
    this.toppers.begin();

    const count = f32.length / ENTITY_STRIDE;
    for (let i = 0; i < count; i++) {
      const base = i * ENTITY_STRIDE;
      const tv = u32[base + LANE.typeVariant];
      if (tv >>> 16 !== ENTITY_TYPE.vehicle) continue;
      const kind = (tv >>> 8) & 0xff;
      const paintIdx = tv & 0xff;
      const kit = KITS[Math.min(kind, KITS.length - 1)];

      this.pos.set(f32[base + LANE.posX], f32[base + LANE.posY], f32[base + LANE.posZ]);
      this.quat.set(
        f32[base + LANE.quatX],
        f32[base + LANE.quatY],
        f32[base + LANE.quatZ],
        f32[base + LANE.quatW],
      );
      this.m.compose(this.pos, this.quat, this.one);

      this.color.setHex(kit.paint ?? PAINT_PALETTE[paintIdx % PAINT_PALETTE.length]);
      this.bodies[kind].push(this.m, this.color);
      this.cabins[kind].push(this.m);

      const spin = f32[base + LANE.animPhase];
      const steer = f32[base + LANE.aux0];
      for (const [sx, sz, front] of [
        [kit.track / 2, -kit.wheelbase / 2, true],
        [-kit.track / 2, -kit.wheelbase / 2, true],
        [kit.track / 2, kit.wheelbase / 2, false],
        [-kit.track / 2, kit.wheelbase / 2, false],
      ] as [number, number, boolean][]) {
        this.wheelPos.set(sx, WHEEL_RADIUS, sz);
        this.wheelQuat.setFromAxisAngle(this.yAxis, front ? -steer : 0);
        this.spinQuat.setFromAxisAngle(this.xAxis, -spin);
        this.wheelQuat.multiply(this.spinQuat);
        this.local.compose(this.wheelPos, this.wheelQuat, this.one);
        this.local.premultiply(this.m);
        this.wheels.push(this.local);
      }

      if (kit.topper !== null) {
        this.wheelPos.set(0, WHEEL_RADIUS + kit.bodyH + kit.cabinH + 0.03, kit.cabinZ);
        this.wheelQuat.identity();
        this.local.compose(this.wheelPos, this.wheelQuat, this.one);
        this.local.premultiply(this.m);
        this.color.setHex(kit.topper);
        this.toppers.push(this.local, this.color);
      }
    }

    for (const p of this.bodies) p.end();
    for (const p of this.cabins) p.end();
    this.wheels.end();
    this.toppers.end();
  }

  dispose(): void {
    for (const p of [...this.bodies, ...this.cabins, this.wheels, this.toppers]) p.dispose();
    this.white.dispose();
    this.glass.dispose();
    this.tire.dispose();
  }
}
