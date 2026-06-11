import * as THREE from "three";
import { CONFIG } from "./config";
import { WorldAnchor } from "./geo";
import { FetchQueue } from "./fetchQueue";
import { HeightFieldRegistry, FIELD_SIZE, decodeTerrarium } from "./heightField";
import { buildTerrainGeometry, compositeImagery } from "./terrainTile";
import { imagerySource, terrainSource, TileSource } from "./sources";

interface Chunk {
  tx: number;
  ty: number;
  abort: AbortController;
  mesh: THREE.Mesh | null;
  disposed: boolean;
}

/**
 * Streams terrain+imagery chunks (one z15 tile each) in a ring around the
 * player: diff desired set vs live set, load by distance, unload with
 * hysteresis, dispose GPU resources on every removal.
 */
export class ChunkManager {
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private imagery: TileSource = imagerySource();
  private terrain: TileSource = terrainSource();
  private playerTx = 0;
  private playerTy = 0;

  constructor(
    private anchor: WorldAnchor,
    private queue: FetchQueue,
    private heights: HeightFieldRegistry,
  ) {}

  get liveCount(): number {
    return this.chunks.size;
  }

  /**
   * Effective imagery zoom: 512px sources (Mapbox @2x) carry one zoom level
   * of extra detail per tile, so step down one level to keep quality and GPU
   * memory equivalent.
   */
  private imageryZoom(): number {
    const iz = this.imagery.tileSize === 512 ? CONFIG.imageryZoom - 1 : CONFIG.imageryZoom;
    return Math.max(CONFIG.terrainZoom, Math.min(this.imagery.maxZoom, iz));
  }

  update(px: number, pz: number): void {
    const zoom = CONFIG.terrainZoom;
    const center = this.anchor.worldToTile(px, pz, zoom);
    this.playerTx = center.tx;
    this.playerTy = center.ty;

    const r = CONFIG.loadRadius;
    const desired = new Set<string>();
    const missing: { tx: number; ty: number; d: number }[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = center.tx + dx;
        const ty = center.ty + dy;
        const key = `${tx}/${ty}`;
        desired.add(key);
        if (!this.chunks.has(key)) missing.push({ tx, ty, d: dx * dx + dy * dy });
      }
    }
    missing.sort((a, b) => a.d - b.d);
    for (const m of missing) void this.load(m.tx, m.ty);

    const unloadBeyond = r + 1.5;
    for (const [key, chunk] of this.chunks) {
      if (desired.has(key)) continue;
      const dist = Math.max(Math.abs(chunk.tx - center.tx), Math.abs(chunk.ty - center.ty));
      if (dist > unloadBeyond) this.unload(key, chunk);
    }
  }

  private async load(tx: number, ty: number): Promise<void> {
    const key = `${tx}/${ty}`;
    const chunk: Chunk = { tx, ty, abort: new AbortController(), mesh: null, disposed: false };
    this.chunks.set(key, chunk);

    const zoom = CONFIG.terrainZoom;
    const priority = () =>
      Math.abs(tx - this.playerTx) + Math.abs(ty - this.playerTy);

    // 1. Heightfield — needed first (collision, building bases).
    const terrainBuf = await this.queue.request(this.terrain.url(zoom, tx, ty), {
      priority,
      signal: chunk.abort.signal,
    });
    if (chunk.disposed) return;
    let field: Float32Array;
    if (terrainBuf) {
      try {
        field = await decodeTerrarium(terrainBuf);
      } catch {
        field = new Float32Array(FIELD_SIZE * FIELD_SIZE);
      }
    } else {
      // Missing tile (ocean / fetch failure): flat at sea level.
      field = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    }
    if (chunk.disposed) return;
    this.heights.set(tx, ty, field);

    // 2. Imagery subgrid composite.
    const iz = this.imageryZoom();
    const factor = 2 ** (iz - zoom);
    const fetches: Promise<ImageBitmap | null>[] = [];
    for (let j = 0; j < factor; j++) {
      for (let i = 0; i < factor; i++) {
        const url = this.imagery.url(iz, tx * factor + i, ty * factor + j);
        fetches.push(
          this.queue
            .request(url, { priority: () => priority() + 2, signal: chunk.abort.signal })
            .then(async (buf) => {
              if (!buf) return null;
              if (this.imagery.blankBytes && buf.byteLength === this.imagery.blankBytes) {
                this.queue.markNegative(url);
                return null;
              }
              try {
                return await createImageBitmap(new Blob([buf]));
              } catch {
                return null;
              }
            }),
        );
      }
    }
    const bitmaps = await Promise.all(fetches);
    if (chunk.disposed) {
      for (const bm of bitmaps) bm?.close();
      return;
    }

    // 3. Mesh.
    const size = this.anchor.tileWorldSize(zoom);
    const geometry = buildTerrainGeometry(field, size);
    const texture = compositeImagery(bitmaps, factor, this.imagery.tileSize);
    const material = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    const nw = this.anchor.tileNWWorld(tx, ty, zoom);
    mesh.position.set(nw.x, 0, nw.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    chunk.mesh = mesh;
  }

  private unload(key: string, chunk: Chunk): void {
    chunk.disposed = true;
    chunk.abort.abort();
    this.chunks.delete(key);
    this.heights.delete(chunk.tx, chunk.ty);
    if (chunk.mesh) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      const material = chunk.mesh.material as THREE.MeshLambertMaterial;
      material.map?.dispose();
      material.dispose();
      chunk.mesh = null;
    }
  }

  disposeAll(): void {
    for (const [key, chunk] of [...this.chunks]) this.unload(key, chunk);
  }
}
