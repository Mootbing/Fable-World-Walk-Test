import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VectorTileLayer } from "@mapbox/vector-tile";
import { CONFIG } from "./config";
import { WorldAnchor } from "./geo";
import { FetchQueue } from "./fetchQueue";
import { HeightFieldRegistry } from "./heightField";
import { CollisionWorld } from "./collision";
import { resolveBuildingTemplate, buildingTileUrl } from "./sources";
import { BuildingFeature, parseBuildingLayer, featureToBuildings, extrudeBuilding } from "./buildings";

/** Footprints extruded per frame; spreads a ~1500-building tile over ~10 frames. */
const BATCH = 150;
/** Keep built tiles until this far away (z14 Chebyshev). */
const UNLOAD_DISTANCE = 2;

interface BuildingTile {
  tx: number;
  ty: number;
  abort: AbortController;
  state: "fetching" | "building" | "live" | "disposed";
  layer: VectorTileLayer | null;
  cursor: number;
  geometries: THREE.BufferGeometry[];
  buildings: BuildingFeature[];
  mesh: THREE.Mesh | null;
  windows: THREE.Points | null;
}

/**
 * Streams z14 building tiles. A tile becomes desired once all four of its
 * z15 terrain heightfields are decoded (needed to ground the extrusions);
 * extrusion is frame-sliced to avoid hitches, then merged into a single
 * mesh (one draw call per tile) and registered for collision.
 */
export class BuildingManager {
  readonly group = new THREE.Group();
  /**
   * Sim mirror hooks (wired by the engine): fired when a tile's parsed
   * footprints go live / are unloaded, so the wasm collision world tracks
   * the same data the renderer shows.
   */
  onTileBuildings: ((tx: number, ty: number, buildings: BuildingFeature[]) => void) | null = null;
  onTileBuildingsRemoved: ((tx: number, ty: number) => void) | null = null;
  /** Raw fetched MVT bytes (roads + future layers live in the same tile). */
  onTileData: ((tx: number, ty: number, buf: ArrayBuffer) => void) | null = null;
  onTileDataRemoved: ((tx: number, ty: number) => void) | null = null;

  private tiles = new Map<string, BuildingTile>();
  private template: string | null = null;
  private templateFailed = false;
  private resolving: Promise<void> | null = null;
  private lastTemplateAttempt = 0;
  private material = new THREE.MeshLambertMaterial({ color: 0xd6d3cb, vertexColors: true });
  /** Shared by every tile's window points; engine drives opacity at night. */
  readonly windowMaterial = new THREE.PointsMaterial({
    color: 0xffcf7e,
    size: 1.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });

  constructor(
    private anchor: WorldAnchor,
    private queue: FetchQueue,
    private heights: HeightFieldRegistry,
    private collision: CollisionWorld,
  ) {
    void this.resolveTemplate();
  }

  /** Never rejects; dedupes concurrent calls so N failing tiles share one fetch. */
  private resolveTemplate(force = false): Promise<void> {
    if (this.resolving) return this.resolving;
    this.lastTemplateAttempt = Date.now();
    this.resolving = resolveBuildingTemplate(force)
      .then((template) => {
        this.template = template;
        this.templateFailed = false;
      })
      .catch((err) => {
        this.templateFailed = true;
        console.warn("Building tiles unavailable (OpenFreeMap TileJSON failed):", err);
      })
      .finally(() => {
        this.resolving = null;
      });
    return this.resolving;
  }

  get failed(): boolean {
    return this.templateFailed;
  }

  /** True once the tile containing the given position has finished building. */
  isLiveAt(x: number, z: number): boolean {
    const { tx, ty } = this.anchor.worldToTile(x, z, CONFIG.buildingZoom);
    return this.tiles.get(`${tx}/${ty}`)?.state === "live";
  }

  update(px: number, pz: number): void {
    if (!this.template) {
      // TileJSON failed (possibly at construction): retry with backoff.
      if (!this.resolving && Date.now() - this.lastTemplateAttempt > 10_000) {
        void this.resolveTemplate();
      }
      return;
    }
    const z14 = CONFIG.buildingZoom;
    const center = this.anchor.worldToTile(px, pz, z14);

    // Candidates within the terrain ring; gated on decoded heightfields.
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tx = center.tx + dx;
        const ty = center.ty + dy;
        const key = `${tx}/${ty}`;
        if (this.tiles.has(key)) continue;
        if (!this.childrenReady(tx, ty)) continue;
        void this.load(key, tx, ty);
      }
    }

    for (const [key, tile] of this.tiles) {
      const dist = Math.max(Math.abs(tile.tx - center.tx), Math.abs(tile.ty - center.ty));
      if (dist > UNLOAD_DISTANCE) this.unload(key, tile);
    }
  }

  /** All four z15 children of a z14 tile have decoded heightfields. */
  private childrenReady(tx: number, ty: number): boolean {
    return (
      this.heights.has(tx * 2, ty * 2) &&
      this.heights.has(tx * 2 + 1, ty * 2) &&
      this.heights.has(tx * 2, ty * 2 + 1) &&
      this.heights.has(tx * 2 + 1, ty * 2 + 1)
    );
  }

  private async load(key: string, tx: number, ty: number): Promise<void> {
    const tile: BuildingTile = {
      tx,
      ty,
      abort: new AbortController(),
      state: "fetching",
      layer: null,
      cursor: 0,
      geometries: [],
      buildings: [],
      windows: null,
      mesh: null,
    };
    this.tiles.set(key, tile);

    const url = buildingTileUrl(this.template!, CONFIG.buildingZoom, tx, ty);
    const buf = await this.queue.request(url, {
      priority: () => 1,
      signal: tile.abort.signal,
    });
    if (tile.state === "disposed") return;
    if (!buf) {
      // Possibly a rotated snapshot: re-resolve, and retry this tile only if
      // the template actually changed (a new URL escapes the negative cache).
      // Otherwise finalize the tile as empty so the load loop terminates; it
      // gets retried naturally if it leaves and re-enters the ring.
      const previous = this.template;
      void this.resolveTemplate(true).then(() => {
        if (tile.state === "disposed") return;
        if (this.template && this.template !== previous) {
          this.tiles.delete(key);
        } else {
          tile.layer = null;
          tile.state = "building";
        }
      });
      return;
    }
    this.onTileData?.(tx, ty, buf);
    try {
      tile.layer = parseBuildingLayer(buf);
    } catch (err) {
      console.warn("Bad building tile", key, err);
      tile.layer = null;
    }
    tile.state = "building";
  }

  /** Called every frame; advances at most one tile by one batch. */
  processBuildQueue(): void {
    for (const [key, tile] of this.tiles) {
      if (tile.state !== "building") continue;
      const layer = tile.layer;
      if (!layer) {
        this.finalize(key, tile);
        return;
      }
      const origin = this.anchor.tileNWWorld(tile.tx, tile.ty, CONFIG.buildingZoom);
      const end = Math.min(tile.cursor + BATCH, layer.length);
      for (; tile.cursor < end; tile.cursor++) {
        const buildings = featureToBuildings(
          layer,
          tile.cursor,
          tile.tx,
          tile.ty,
          CONFIG.buildingZoom,
          this.anchor,
        );
        for (const b of buildings) {
          const geometry = extrudeBuilding(b, origin, this.heights);
          if (geometry) {
            tile.geometries.push(geometry);
            tile.buildings.push(b);
          }
        }
      }
      if (tile.cursor >= layer.length) this.finalize(key, tile);
      return; // one tile per frame
    }
  }

  /**
   * Sparse warm dots along facade edges at floor heights — at night they
   * read as lit windows. One Points object per tile, world-anchored at
   * the tile NW like the merged mesh.
   */
  private buildWindowPoints(tile: BuildingTile): THREE.Points | null {
    const nw = this.anchor.tileNWWorld(tile.tx, tile.ty, CONFIG.buildingZoom);
    const verts: number[] = [];
    let lcg = ((tile.tx * 73856093) ^ (tile.ty * 19349663)) >>> 0 || 1;
    const rand = () => ((lcg = (lcg * 1664525 + 1013904223) >>> 0) / 0xffffffff);
    outer: for (const b of tile.buildings) {
      const ring = b.rings[0];
      if (!ring || b.height < 5) continue;
      const baseY = this.heights.sample(ring[0][0], ring[0][1]) ?? 0;
      let placed = 0;
      for (let i = 0; i < ring.length - 1 && placed < 24; i++) {
        const [ax, az] = ring[i];
        const [bx, bz] = ring[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 5) continue;
        const steps = Math.min(6, Math.floor(len / 3.2));
        for (let s = 1; s <= steps; s++) {
          const t = s / (steps + 1);
          for (let y = baseY + 4; y < baseY + b.height - 1; y += 3.4) {
            if (rand() > 0.3) continue;
            verts.push(
              ax + (bx - ax) * t - nw.x,
              y,
              az + (bz - az) * t - nw.z,
            );
            placed++;
            if (verts.length >= 9000) break outer;
          }
        }
      }
    }
    if (verts.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const points = new THREE.Points(geo, this.windowMaterial);
    points.frustumCulled = false;
    return points;
  }

  private finalize(key: string, tile: BuildingTile): void {
    if (tile.geometries.length > 0) {
      const merged = mergeGeometries(tile.geometries, false);
      for (const g of tile.geometries) g.dispose();
      tile.geometries = [];
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.material);
        const nw = this.anchor.tileNWWorld(tile.tx, tile.ty, CONFIG.buildingZoom);
        mesh.position.set(nw.x, 0, nw.z);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.group.add(mesh);
        tile.mesh = mesh;
        const windows = this.buildWindowPoints(tile);
        if (windows) {
          windows.position.copy(mesh.position);
          windows.matrixAutoUpdate = false;
          windows.updateMatrix();
          this.group.add(windows);
          tile.windows = windows;
        }
      }
    }
    this.collision.addTile(key, tile.buildings);
    this.onTileBuildings?.(tile.tx, tile.ty, tile.buildings);
    tile.layer = null;
    tile.state = "live";
  }

  private unload(key: string, tile: BuildingTile): void {
    tile.abort.abort();
    this.tiles.delete(key);
    this.collision.removeTile(key);
    if (tile.state === "live") this.onTileBuildingsRemoved?.(tile.tx, tile.ty);
    this.onTileDataRemoved?.(tile.tx, tile.ty);
    for (const g of tile.geometries) g.dispose();
    tile.geometries = [];
    if (tile.mesh) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh = null;
    }
    if (tile.windows) {
      this.group.remove(tile.windows);
      tile.windows.geometry.dispose();
      tile.windows = null;
    }
    tile.state = "disposed";
  }

  disposeAll(): void {
    for (const [key, tile] of [...this.tiles]) this.unload(key, tile);
    this.material.dispose();
  }
}
