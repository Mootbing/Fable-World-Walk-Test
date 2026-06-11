import * as THREE from "three";

/**
 * Transient combat FX. v1: fading gunshot tracers in a single LineSegments
 * buffer (one draw call). Explosions/smoke arrive with PR20.
 */

const MAX_TRACERS = 32;
const TRACER_TTL = 0.18;

export class FxPools {
  readonly group = new THREE.Group();

  private lines: THREE.LineSegments;
  private positions = new Float32Array(MAX_TRACERS * 6);
  private colors = new Float32Array(MAX_TRACERS * 6);
  private ttl = new Float32Array(MAX_TRACERS);
  private cursor = 0;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geometry, material);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
  }

  addTracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const i = this.cursor % MAX_TRACERS;
    this.cursor++;
    this.positions.set([x0, y0, z0, x1, y1, z1], i * 6);
    this.ttl[i] = TRACER_TTL;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.ttl[i] <= 0) continue;
      this.ttl[i] -= dt;
      const a = Math.max(0, this.ttl[i] / TRACER_TTL);
      const v = 0.95 * a;
      this.colors.set([v, v * 0.92, v * 0.6, v, v * 0.92, v * 0.6], i * 6);
      if (this.ttl[i] <= 0) this.positions.fill(0, i * 6, i * 6 + 6);
      any = true;
    }
    if (any) {
      (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.lines.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
