import { BuildingFeature } from "./buildings";

const CELL = 16;
/** Insertion bbox padding; must exceed player radius + max per-step travel. */
const PAD = 2;

interface Footprint {
  rings: [number, number][][];
  /** Extrusion span for the camera-occlusion height test. */
  height: number;
  minHeight: number;
}

export interface BoomHit {
  /** Parameter along the queried segment (0..1). */
  t: number;
  x: number;
  z: number;
  height: number;
  minHeight: number;
}

/**
 * Building prisms in a uniform spatial hash. Player physics moved into the
 * wasm sim (sim/src/collision.rs); this TS copy is the renderer's analytic
 * occlusion oracle — the third-person camera boom clamps against exact
 * footprint walls instead of raycasting merged meshes. Padded insertion
 * means a single-cell lookup suffices for point queries.
 */
export class CollisionWorld {
  private cells = new Map<string, Footprint[]>();
  private tiles = new Map<string, Footprint[]>();

  addTile(tileKey: string, buildings: BuildingFeature[]): void {
    if (this.tiles.has(tileKey)) return;
    const footprints: Footprint[] = [];
    for (const b of buildings) {
      const fp: Footprint = { rings: b.rings, height: b.height, minHeight: b.minHeight };
      footprints.push(fp);
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const ring of b.rings) {
        for (const [x, z] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
      const cx0 = Math.floor((minX - PAD) / CELL);
      const cx1 = Math.floor((maxX + PAD) / CELL);
      const cz0 = Math.floor((minZ - PAD) / CELL);
      const cz1 = Math.floor((maxZ + PAD) / CELL);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = `${cx}/${cz}`;
          let list = this.cells.get(key);
          if (!list) {
            list = [];
            this.cells.set(key, list);
          }
          list.push(fp);
        }
      }
    }
    this.tiles.set(tileKey, footprints);
  }

  removeTile(tileKey: string): void {
    const footprints = this.tiles.get(tileKey);
    if (!footprints) return;
    this.tiles.delete(tileKey);
    const removing = new Set(footprints);
    for (const [key, list] of this.cells) {
      const kept = list.filter((fp) => !removing.has(fp));
      if (kept.length === 0) this.cells.delete(key);
      else if (kept.length !== list.length) this.cells.set(key, kept);
    }
  }

  /**
   * All footprint-wall crossings of the 2D segment (x0,z0)→(x1,z1), sorted
   * near-to-far. The camera boom is short (≤ ~6 m) so the cells it touches
   * are gathered along the way (PAD-ded insertion keeps this exact).
   */
  segmentHits(x0: number, z0: number, x1: number, z1: number): BoomHit[] {
    const seen = new Set<Footprint>();
    const cx0 = Math.floor(Math.min(x0, x1) / CELL);
    const cx1 = Math.floor(Math.max(x0, x1) / CELL);
    const cz0 = Math.floor(Math.min(z0, z1) / CELL);
    const cz1 = Math.floor(Math.max(z0, z1) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(`${cx}/${cz}`);
        if (list) for (const fp of list) seen.add(fp);
      }
    }
    if (seen.size === 0) return [];

    const hits: BoomHit[] = [];
    for (const fp of seen) {
      for (const ring of fp.rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const t = segmentIntersectT(x0, z0, x1, z1, ring[i], ring[i + 1]);
          if (t !== null) {
            hits.push({
              t,
              x: x0 + (x1 - x0) * t,
              z: z0 + (z1 - z0) * t,
              height: fp.height,
              minHeight: fp.minHeight,
            });
          }
        }
      }
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }
}

/** Parameter t on a→b where it crosses segment c→d, or null. */
function segmentIntersectT(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  c: [number, number],
  d: [number, number],
): number | null {
  const rX = bx - ax;
  const rZ = bz - az;
  const sX = d[0] - c[0];
  const sZ = d[1] - c[1];
  const denom = rX * sZ - rZ * sX;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = ((c[0] - ax) * sZ - (c[1] - az) * sX) / denom;
  const u = ((c[0] - ax) * rZ - (c[1] - az) * rX) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}
