import * as THREE from "three";

/**
 * F3-style debug view of the sim's road graph: a LineSegments soup draped
 * ~0.6m above the terrain. Rebuilt lazily (toggle or every 2s while
 * visible) — tiles stream slowly, the graph doesn't change per frame.
 */
export class RoadDebugOverlay {
  readonly group = new THREE.Group();
  visible = false;

  private line: THREE.LineSegments | null = null;
  private material = new THREE.LineBasicMaterial({ color: 0x18e0ff });
  private sinceRefresh = Infinity;
  /** Debug introspection (test hook). */
  vertexCount = 0;

  constructor() {
    this.group.visible = false;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.group.visible = this.visible;
    this.sinceRefresh = Infinity; // rebuild on next update
  }

  update(
    dt: number,
    segments: () => Float32Array,
    ground: (x: number, z: number) => number | null,
  ): void {
    if (!this.visible) return;
    this.sinceRefresh += dt;
    if (this.sinceRefresh < 2) return;
    this.sinceRefresh = 0;

    const segs = segments();
    const positions = new Float32Array((segs.length / 2) * 3);
    for (let i = 0; i < segs.length / 2; i++) {
      const x = segs[i * 2];
      const z = segs[i * 2 + 1];
      positions[i * 3] = x;
      positions[i * 3 + 1] = (ground(x, z) ?? 0) + 0.6;
      positions[i * 3 + 2] = z;
    }

    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.line = new THREE.LineSegments(geometry, this.material);
    this.line.frustumCulled = false;
    this.group.add(this.line);
    this.vertexCount = positions.length / 3;
  }

  dispose(): void {
    if (this.line) {
      this.line.geometry.dispose();
      this.line = null;
    }
    this.material.dispose();
  }
}
