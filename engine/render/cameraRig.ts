import * as THREE from "three";
import type { InputFrame } from "../input";

export type CamMode = "fp" | "tp";

const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** Third-person boom: desired length and frame offsets. */
const BOOM = 3.4;
const SHOULDER = 0.45;
const TP_PITCH_MIN = -1.2;
const TP_PITCH_MAX = 1.35;
/** Boom relaxes back out at this rate; snaps in instantly (never clip). */
const BOOM_OUT_SPEED = 4;
const WALL_MARGIN = 0.3;

export interface CameraClamp {
  /** Clamp the boom from target toward desired; returns allowed length. */
  clampBoom(tx: number, ty: number, tz: number, dx: number, dy: number, dz: number, len: number): number;
  /** Ground elevation or null. */
  sampleGround(x: number, z: number): number | null;
}

/**
 * First/third-person camera rig. Owns yaw/pitch (fed by mouse deltas) and
 * the third-person boom, clamped analytically against building prisms and
 * terrain via the engine's occlusion oracle.
 */
export class CameraRig {
  mode: CamMode = "fp";
  yaw = 0;
  pitch = 0;

  private boomCur = BOOM;
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private dir = new THREE.Vector3();
  private target = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private up = new THREE.Vector3(0, 1, 0);

  integrate(frame: InputFrame): void {
    this.yaw += frame.yawDelta;
    this.pitch = THREE.MathUtils.clamp(this.pitch + frame.pitchDelta, -PITCH_LIMIT, PITCH_LIMIT);
    if (frame.toggleCamera) {
      this.mode = this.mode === "fp" ? "tp" : "fp";
      this.boomCur = 0.5; // grow out from the body, never snap through walls
    }
  }

  /** World-space movement direction for the sim from forward/strafe axes. */
  moveDir(frame: InputFrame): { dirX: number; dirZ: number; moving: boolean } {
    const f = frame.forward;
    const s = frame.strafe;
    if (f === 0 && s === 0) return { dirX: 0, dirZ: 0, moving: false };
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward(yaw) = (-sin, -cos); right = (cos, -sin)
    let dirX = -sin * f + cos * s;
    let dirZ = -cos * f - sin * s;
    const len = Math.hypot(dirX, dirZ);
    dirX /= len;
    dirZ /= len;
    return { dirX, dirZ, moving: true };
  }

  /** Position + orient the camera around the player (eye-height position). */
  apply(
    camera: THREE.PerspectiveCamera,
    px: number,
    py: number,
    pz: number,
    clamp: CameraClamp,
    dt: number,
  ): void {
    if (this.mode === "fp") {
      camera.position.set(px, py, pz);
      this.euler.set(this.pitch, this.yaw, 0);
      camera.quaternion.setFromEuler(this.euler);
      return;
    }

    // Third person: orbit behind the head with a shoulder offset.
    const pitch = THREE.MathUtils.clamp(this.pitch, TP_PITCH_MIN, TP_PITCH_MAX);
    this.target.set(px, py + 0.25, pz);
    this.dir.set(
      Math.sin(this.yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(this.yaw) * Math.cos(pitch),
    );
    // Camera sits along +dir behind the view direction (-dir is forward).
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    this.target.x += rightX * SHOULDER;
    this.target.z += rightZ * SHOULDER;

    let boom = clamp.clampBoom(
      this.target.x,
      this.target.y,
      this.target.z,
      this.dir.x,
      this.dir.y,
      this.dir.z,
      BOOM,
    );
    boom = Math.max(0.4, boom - 0); // hard floor so we never sit in the head
    // Snap in instantly, relax out smoothly.
    this.boomCur = boom < this.boomCur ? boom : Math.min(boom, this.boomCur + BOOM_OUT_SPEED * dt);

    this.desired
      .copy(this.target)
      .addScaledVector(this.dir, this.boomCur);

    // Terrain floor: keep the camera above the ground.
    const ground = clamp.sampleGround(this.desired.x, this.desired.z);
    if (ground !== null && this.desired.y < ground + 0.4) {
      this.desired.y = ground + 0.4;
    }

    camera.position.copy(this.desired);
    this.lookAt.set(
      this.target.x - this.dir.x * 2,
      this.target.y - this.dir.y * 2,
      this.target.z - this.dir.z * 2,
    );
    this.m.lookAt(camera.position, this.lookAt, this.up);
    camera.quaternion.setFromRotationMatrix(this.m);
  }
}

export { BOOM, WALL_MARGIN };
