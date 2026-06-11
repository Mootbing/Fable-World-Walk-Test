import * as THREE from "three";

/**
 * Transient combat FX. v1: fading gunshot tracers in a single LineSegments
 * buffer (one draw call). Explosions/smoke arrive with PR20.
 */

const MAX_TRACERS = 32;
const TRACER_TTL = 0.18;
const MAX_PARTICLES = 384;

export class FxPools {
  readonly group = new THREE.Group();

  private lines: THREE.LineSegments;
  private positions = new Float32Array(MAX_TRACERS * 6);
  private colors = new Float32Array(MAX_TRACERS * 6);
  private ttl = new Float32Array(MAX_TRACERS);
  private cursor = 0;

  private points: THREE.Points;
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pCol = new Float32Array(MAX_PARTICLES * 3);
  private pVel = new Float32Array(MAX_PARTICLES * 3);
  private pTtl = new Float32Array(MAX_PARTICLES);
  private pMax = new Float32Array(MAX_PARTICLES);
  private pCursor = 0;

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

    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    pGeo.setAttribute("color", new THREE.BufferAttribute(this.pCol, 3));
    const pMat = new THREE.PointsMaterial({
      size: 0.55,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(pGeo, pMat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  /** One rising fire/smoke mote. */
  spawnParticle(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    vy: number,
    ttl: number,
    jitter = 0.5,
  ): void {
    const i = this.pCursor % MAX_PARTICLES;
    this.pCursor++;
    this.pPos.set(
      [
        x + (Math.random() - 0.5) * jitter,
        y,
        z + (Math.random() - 0.5) * jitter,
      ],
      i * 3,
    );
    this.pVel.set(
      [(Math.random() - 0.5) * 0.6, vy + Math.random() * 0.8, (Math.random() - 0.5) * 0.6],
      i * 3,
    );
    this.pCol.set([r, g, b], i * 3);
    this.pTtl[i] = ttl;
    this.pMax[i] = ttl;
  }

  flame(x: number, y: number, z: number): void {
    this.spawnParticle(x, y + 0.7, z, 1.0, 0.45, 0.08, 1.6, 0.6, 1.2);
  }

  smokePuff(x: number, y: number, z: number): void {
    this.spawnParticle(x, y + 0.8, z, 0.32, 0.32, 0.34, 0.9, 1.1, 1.0);
  }

  explosion(x: number, y: number, z: number): void {
    for (let i = 0; i < 48; i++) {
      this.spawnParticle(
        x,
        y + 0.4 + Math.random() * 1.2,
        z,
        1.0,
        0.5 + Math.random() * 0.4,
        0.1,
        2.5 + Math.random() * 3,
        0.8 + Math.random() * 0.5,
        3.2,
      );
    }
  }

  addTracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const i = this.cursor % MAX_TRACERS;
    this.cursor++;
    this.positions.set([x0, y0, z0, x1, y1, z1], i * 6);
    this.ttl[i] = TRACER_TTL;
  }

  update(dt: number): void {
    let anyP = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pTtl[i] <= 0) continue;
      this.pTtl[i] -= dt;
      const a = Math.max(0, this.pTtl[i] / this.pMax[i]);
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      this.pCol[i * 3] *= 0.92 + a * 0.08;
      this.pCol[i * 3 + 1] *= 0.9 + a * 0.08;
      this.pCol[i * 3 + 2] *= 0.9 + a * 0.08;
      if (this.pTtl[i] <= 0) this.pPos.fill(0, i * 3, i * 3 + 3);
      anyP = true;
    }
    if (anyP) {
      (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

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
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
