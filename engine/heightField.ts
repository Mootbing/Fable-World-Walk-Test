import { CONFIG } from "./config";
import { WorldAnchor } from "./geo";

/** Heightfields are normalized to this grid regardless of source tile size. */
export const FIELD_SIZE = 256;

/**
 * Decode a terrarium-encoded elevation tile (PNG or WebP bytes) into meters:
 * h = R*256 + G + B/256 - 32768. Color management must be disabled or the
 * browser would silently corrupt the encoded values.
 */
export async function decodeTerrarium(buf: ArrayBuffer): Promise<Float32Array> {
  const bitmap = await createImageBitmap(new Blob([buf]), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(FIELD_SIZE, FIELD_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  // Nearest-neighbor only: interpolating terrarium tiles in 8-bit RGB space
  // quantizes each channel independently and corrupts elevations by up to
  // ±128 m wherever neighbors straddle an R-channel (256 m) boundary.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, FIELD_SIZE, FIELD_SIZE);
  bitmap.close();
  const data = ctx.getImageData(0, 0, FIELD_SIZE, FIELD_SIZE).data;
  const out = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  for (let i = 0; i < FIELD_SIZE * FIELD_SIZE; i++) {
    out[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** Bilinear sample at fractional UV (0..1) over a FIELD_SIZE grid. */
export function sampleBilinear(field: Float32Array, u: number, v: number): number {
  const px = Math.min(Math.max(u * FIELD_SIZE - 0.5, 0), FIELD_SIZE - 1);
  const py = Math.min(Math.max(v * FIELD_SIZE - 0.5, 0), FIELD_SIZE - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, FIELD_SIZE - 1);
  const y1 = Math.min(y0 + 1, FIELD_SIZE - 1);
  const fx = px - x0;
  const fy = py - y0;
  const h00 = field[y0 * FIELD_SIZE + x0];
  const h10 = field[y0 * FIELD_SIZE + x1];
  const h01 = field[y1 * FIELD_SIZE + x0];
  const h11 = field[y1 * FIELD_SIZE + x1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

/**
 * Decoded heightfields for all live terrain chunks — the single source of
 * truth for collision grounding and building bases, available the moment a
 * tile decodes (independent of mesh build).
 */
export class HeightFieldRegistry {
  private fields = new Map<string, Float32Array>();

  /**
   * Mirror hooks: the engine wires these to the wasm sim so every decoded
   * tile is uploaded (with its world frame) the moment it lands, and
   * removed when the chunk unloads. Set after construction to avoid a
   * dependency cycle with the bridge.
   */
  onSet: ((tx: number, ty: number, originX: number, originZ: number, size: number, field: Float32Array) => void) | null = null;
  onDelete: ((tx: number, ty: number) => void) | null = null;

  constructor(private anchor: WorldAnchor) {}

  private key(tx: number, ty: number): string {
    return `${tx}/${ty}`;
  }

  set(tx: number, ty: number, field: Float32Array): void {
    this.fields.set(this.key(tx, ty), field);
    if (this.onSet) {
      const zoom = CONFIG.terrainZoom;
      const nw = this.anchor.tileNWWorld(tx, ty, zoom);
      this.onSet(tx, ty, nw.x, nw.z, this.anchor.tileWorldSize(zoom), field);
    }
  }

  delete(tx: number, ty: number): void {
    this.fields.delete(this.key(tx, ty));
    this.onDelete?.(tx, ty);
  }

  has(tx: number, ty: number): boolean {
    return this.fields.has(this.key(tx, ty));
  }

  get(tx: number, ty: number): Float32Array | undefined {
    return this.fields.get(this.key(tx, ty));
  }

  /** Ground elevation in meters at a world position, or null if not loaded. */
  sample(x: number, z: number): number | null {
    const zoom = CONFIG.terrainZoom;
    const { tx, ty } = this.anchor.worldToTile(x, z, zoom);
    const field = this.fields.get(this.key(tx, ty));
    if (!field) return null;
    const nw = this.anchor.tileNWWorld(tx, ty, zoom);
    const size = this.anchor.tileWorldSize(zoom);
    return sampleBilinear(field, (x - nw.x) / size, (z - nw.z) / size);
  }
}
