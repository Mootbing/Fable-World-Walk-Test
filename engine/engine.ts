import * as THREE from "three";
import { CONFIG } from "./config";
import { WorldAnchor } from "./geo";
import { FetchQueue } from "./fetchQueue";
import { HeightFieldRegistry } from "./heightField";
import { CollisionWorld } from "./collision";
import { ChunkManager } from "./chunkManager";
import { BuildingManager } from "./buildingManager";
import { SimBridge, flattenFootprints, FlatFootprints } from "./sim/simBridge";
import { BTN } from "./sim/entityLayout";
import { useHud } from "./store";

export interface MoveInput {
  dirX: number;
  dirZ: number;
  moving: boolean;
  sprint: boolean;
  jump: boolean;
}

const DIFF_INTERVAL = 0.25;
const HUD_INTERVAL = 0.25;
/** Open the world even if buildings haven't finished after this long. */
const READY_TIMEOUT = 15;
/** Test/debug event log capacity (4-word records, newest last). */
const EVENT_LOG_CAP = 64;

interface PendingTile {
  tx: number;
  ty: number;
  originX: number;
  originZ: number;
  size: number;
  field: Float32Array;
}

/**
 * Root of the imperative world: owns the streaming managers and the wasm
 * sim that owns all gameplay state (the player lives in Rust as entity 0);
 * ticked once per rendered frame from useFrame. React only ever sees
 * `group` (mounted via <primitive>) and the zustand HUD store.
 */
export class WorldEngine {
  readonly group = new THREE.Group();
  readonly anchor: WorldAnchor;
  disposed = false;
  /** Wasm sim core; null until async boot resolves (or if it fails). */
  sim: SimBridge | null = null;
  /** Recent sim events for tests/debug (flat 4-word records, newest last). */
  readonly eventLog: number[] = [];

  private queue: FetchQueue;
  private heights: HeightFieldRegistry;
  private collision = new CollisionWorld();
  private chunks: ChunkManager;
  private buildings: BuildingManager;

  /** Tile data that arrived before the wasm module finished booting. */
  private pendingTiles = new Map<string, PendingTile>();
  private pendingBuildings = new Map<string, { tx: number; ty: number; flat: FlatFootprints }>();
  private playerCache = { x: 0, y: 40, z: 0 };

  private diffTimer = DIFF_INTERVAL; // run the first diff immediately
  private hudTimer = 0;
  private fpsTimer = 0;
  private frames = 0;
  private elapsed = 0;
  private ready = false;

  constructor() {
    this.anchor = new WorldAnchor(CONFIG.spawnLat, CONFIG.spawnLon);
    this.queue = new FetchQueue(CONFIG.fetchConcurrency, (n) => {
      useHud.setState({ tilesInFlight: n });
    });
    this.heights = new HeightFieldRegistry(this.anchor);
    this.chunks = new ChunkManager(this.anchor, this.queue, this.heights);
    this.buildings = new BuildingManager(this.anchor, this.queue, this.heights, this.collision);
    this.group.add(this.chunks.group, this.buildings.group);

    // Every decoded heightfield mirrors into the sim (queued until boot).
    this.heights.onSet = (tx, ty, originX, originZ, size, field) => {
      if (this.sim) {
        this.sim.loadHeightfield(tx, ty, originX, originZ, size, field);
      } else {
        this.pendingTiles.set(`${tx}/${ty}`, { tx, ty, originX, originZ, size, field });
      }
    };
    this.heights.onDelete = (tx, ty) => {
      if (this.sim) {
        this.sim.unloadHeightfield(tx, ty);
      } else {
        this.pendingTiles.delete(`${tx}/${ty}`);
      }
    };

    // ...and so does every live building tile's walkable footprint set.
    this.buildings.onTileBuildings = (tx, ty, features) => {
      const flat = flattenFootprints(features);
      if (this.sim) {
        this.sim.loadTileBuildings(tx, ty, flat);
      } else {
        this.pendingBuildings.set(`${tx}/${ty}`, { tx, ty, flat });
      }
    };
    this.buildings.onTileBuildingsRemoved = (tx, ty) => {
      if (this.sim) {
        this.sim.unloadTileBuildings(tx, ty);
      } else {
        this.pendingBuildings.delete(`${tx}/${ty}`);
      }
    };

    void this.bootSim();
  }

  /** Player position (sim-owned; cached per frame). Spawn pose pre-boot. */
  get playerX(): number {
    return this.playerCache.x;
  }
  get playerY(): number {
    return this.playerCache.y;
  }
  get playerZ(): number {
    return this.playerCache.z;
  }

  private async bootSim(): Promise<void> {
    try {
      const sim = await SimBridge.boot(CONFIG.seed);
      if (this.disposed) {
        sim.dispose();
        return;
      }
      this.sim = sim;
      for (const t of this.pendingTiles.values()) {
        sim.loadHeightfield(t.tx, t.ty, t.originX, t.originZ, t.size, t.field);
      }
      this.pendingTiles.clear();
      for (const b of this.pendingBuildings.values()) {
        sim.loadTileBuildings(b.tx, b.ty, b.flat);
      }
      this.pendingBuildings.clear();
      const avgMs = sim.benchmark(1000);
      console.info(
        `[sim] v${SimBridge.version} booted · 1k-entity readback ${avgMs.toFixed(3)} ms/pass`,
      );
    } catch (err) {
      console.error("[sim] wasm boot failed", err);
      useHud.setState({ buildingsNote: "sim failed to load" });
    }
  }

  update(input: MoveInput, dt: number): void {
    if (this.disposed) return;
    this.elapsed += dt;

    if (this.sim) {
      const buttons = (input.sprint ? BTN.sprint : 0) | (input.jump ? BTN.jump : 0);
      this.sim.setInput(buttons, input.moving ? input.dirX : 0, input.moving ? input.dirZ : 0);
      this.sim.step(dt);
      this.playerCache = this.sim.playerPos();

      const events = this.sim.drainEvents();
      if (events.length > 0) {
        for (const word of events) this.eventLog.push(word);
        const excess = this.eventLog.length - EVENT_LOG_CAP * 4;
        if (excess > 0) this.eventLog.splice(0, excess);
      }
    }

    this.diffTimer += dt;
    if (this.diffTimer >= DIFF_INTERVAL) {
      this.diffTimer = 0;
      this.chunks.update(this.playerX, this.playerZ);
      this.buildings.update(this.playerX, this.playerZ);
    }
    this.buildings.processBuildQueue();

    if (!this.ready && this.sim) {
      const groundLoaded = this.heights.sample(this.playerX, this.playerZ) !== null;
      const buildingsSettled =
        this.buildings.isLiveAt(this.playerX, this.playerZ) ||
        this.buildings.failed ||
        this.elapsed > READY_TIMEOUT;
      if (groundLoaded && buildingsSettled) {
        this.ready = true;
        this.sim.setPlayerEnabled(true);
        useHud.setState({ ready: true });
      }
    }

    this.frames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      useHud.setState({ fps: Math.round(this.frames / this.fpsTimer) });
      this.fpsTimer = 0;
      this.frames = 0;
    }

    this.hudTimer += dt;
    if (this.hudTimer >= HUD_INTERVAL) {
      this.hudTimer = 0;
      const { lon, lat } = this.anchor.worldToLonLat(this.playerX, this.playerZ);
      useHud.setState({
        lat,
        lon,
        elev: this.playerY - CONFIG.eyeHeight,
        chunks: this.chunks.liveCount,
        buildingsNote: this.buildings.failed ? "building data unavailable" : "",
        simTick: this.sim ? this.sim.tick : 0,
        simMs: this.sim ? this.sim.lastStepMs : 0,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.chunks.disposeAll();
    this.buildings.disposeAll();
    this.sim?.dispose();
    this.sim = null;
  }
}
