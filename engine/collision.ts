import { BuildingFeature } from "./buildings";

const CELL = 16;
/** Insertion bbox padding; must exceed player radius + max per-step travel. */
const PAD = 2;
const EPSILON = 0.01;

interface Footprint {
  rings: [number, number][][];
}

/**
 * 2D building collision: footprints live in a uniform spatial hash; the
 * player is a circle pushed out of footprint edges. Padded insertion means a
 * single-cell lookup suffices at query time.
 */
export class CollisionWorld {
  private cells = new Map<string, Footprint[]>();
  private tiles = new Map<string, Footprint[]>();

  addTile(tileKey: string, buildings: BuildingFeature[]): void {
    if (this.tiles.has(tileKey)) return;
    const footprints: Footprint[] = [];
    for (const b of buildings) {
      // Elevated structures (skybridges, raised wings) don't block walking.
      if (b.minHeight > 2.5) continue;
      const fp: Footprint = { rings: b.rings };
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

  /** Resolve a circle at (x,z) with radius r out of all nearby footprints. */
  resolve(x: number, z: number, r: number): { x: number; z: number } {
    const candidates = this.cells.get(`${Math.floor(x / CELL)}/${Math.floor(z / CELL)}`);
    if (!candidates || candidates.length === 0) return { x, z };

    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const fp of candidates) {
        for (const ring of fp.rings) {
          for (let i = 0; i < ring.length - 1; i++) {
            const pushed = pushOutOfSegment(x, z, r, ring[i], ring[i + 1]);
            if (pushed) {
              x = pushed.x;
              z = pushed.z;
              moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }

    // Deep-penetration rescue (e.g. spawning inside a building, or a tile
    // going live around the player). Ejecting past the nearest wall of ONE
    // footprint can land inside an abutting neighbor (rowhouses share
    // walls), so candidate exits are tried nearest-first and accepted only
    // if they're outside the union of all nearby footprints.
    const insideAny = (px: number, pz: number) =>
      candidates.some((fp) => pointInFootprint(px, pz, fp));
    if (insideAny(x, z)) {
      const exits: { d2: number; x: number; z: number }[] = [];
      for (const fp of candidates) {
        for (const ring of fp.rings) {
          for (let i = 0; i < ring.length - 1; i++) {
            const c = closestOnSegment(x, z, ring[i], ring[i + 1]);
            exits.push({ d2: (c.x - x) ** 2 + (c.z - z) ** 2, x: c.x, z: c.z });
          }
        }
      }
      exits.sort((a, b) => a.d2 - b.d2);
      for (const exit of exits) {
        const d = Math.sqrt(exit.d2);
        if (d < 1e-9) continue;
        const ex = exit.x + ((exit.x - x) / d) * (r + EPSILON);
        const ez = exit.z + ((exit.z - z) / d) * (r + EPSILON);
        if (!insideAny(ex, ez)) {
          x = ex;
          z = ez;
          break;
        }
      }
      // No valid exit found: keep the position; a later frame (with more
      // candidates or after movement) will try again.
    }

    return { x, z };
  }
}

function closestOnSegment(
  px: number,
  pz: number,
  a: [number, number],
  b: [number, number],
): { x: number; z: number } {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-12) return { x: a[0], z: a[1] };
  let t = ((px - a[0]) * abx + (pz - a[1]) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a[0] + abx * t, z: a[1] + abz * t };
}

function pushOutOfSegment(
  px: number,
  pz: number,
  r: number,
  a: [number, number],
  b: [number, number],
): { x: number; z: number } | null {
  const c = closestOnSegment(px, pz, a, b);
  const dx = px - c.x;
  const dz = pz - c.z;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-9) {
    // Center exactly on the wall: push along the edge normal.
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const len = Math.hypot(abx, abz) || 1;
    return { x: px + (-abz / len) * (r + EPSILON), z: pz + (abx / len) * (r + EPSILON) };
  }
  const push = (r - d + EPSILON) / d;
  return { x: px + dx * push, z: pz + dz * push };
}

/** Even-odd test over all rings (holes/courtyards count as outside). */
function pointInFootprint(px: number, pz: number, fp: Footprint): boolean {
  let inside = false;
  for (const ring of fp.rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}
