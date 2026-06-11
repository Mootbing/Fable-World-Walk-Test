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
}

/**
 * Streams z14 building tiles. A tile becomes desired once all four of its
 * z15 terrain heightfields are decoded (needed to ground the extrusions);
 * extrusion is frame-sliced to avoid hitches, then merged into a single
 * mesh (one draw call per tile) and registered for collision.
 */
export class BuildingManager {
  readonly group = new THREE.Group();
  private tiles = new Map<string, BuildingTile>();
  private template: string | null = null;
  private templateFailed = false;
  private resolving: Promise<void> | null = null;
  private lastTemplateAttempt = 0;
  private material = new THREE.MeshLambertMaterial({ color: 0xd6d3cb });

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
      }
    }
    this.collision.addTile(key, tile.buildings);
    tile.layer = null;
    tile.state = "live";
  }

  private unload(key: string, tile: BuildingTile): void {
    tile.abort.abort();
    this.tiles.delete(key);
    this.collision.removeTile(key);
    for (const g of tile.geometries) g.dispose();
    tile.geometries = [];
    if (tile.mesh) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh = null;
    }
    tile.state = "disposed";
  }

  disposeAll(): void {
    for (const [key, tile] of [...this.tiles]) this.unload(key, tile);
    this.material.dispose();
  }
}
