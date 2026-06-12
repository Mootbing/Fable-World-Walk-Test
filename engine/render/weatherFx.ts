import * as THREE from "three";

/**
 * Camera-following rain: one Points cloud recycled in a box around the
 * camera; intensity (0..1) gates how much of the buffer draws. Cheap —
 * a single draw call wet or dry.
 */

const DROPS = 1500;
const BOX = 30;
const TOP = 18;
const FALL = 36;

export class WeatherFx {
  readonly group = new THREE.Group();
  /** 0 = dry, 0.6 = rain, 1 = storm (engine sets from weather state). */
  intensity = 0;
  /** Drops drawn last frame (test observability). */
  activeDrops = 0;

  private points: THREE.Points;
  private positions: Float32Array;

  constructor() {
    this.positions = new Float32Array(DROPS * 3);
    for (let i = 0; i < DROPS; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * BOX * 2;
      this.positions[i * 3 + 1] = Math.random() * TOP;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * BOX * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0x9fb6cc,
        size: 0.07,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.group.add(this.points);
  }

  update(dt: number, camX: number, camY: number, camZ: number): void {
    const target = Math.floor(DROPS * this.intensity);
    this.activeDrops = target;
    if (target === 0) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    this.points.geometry.setDrawRange(0, target);
    // Drops live in world space but the box re-centers on the camera.
    this.points.position.set(camX, camY, camZ);
    const p = this.positions;
    const fall = FALL * dt;
    for (let i = 0; i < target; i++) {
      p[i * 3 + 1] -= fall;
      if (p[i * 3 + 1] < -8) {
        p[i * 3] = (Math.random() - 0.5) * BOX * 2;
        p[i * 3 + 1] = TOP * (0.6 + Math.random() * 0.4);
        p[i * 3 + 2] = (Math.random() - 0.5) * BOX * 2;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
