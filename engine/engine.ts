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
import { PlayerAvatar } from "./render/playerAvatar";
import { VehiclePools } from "./render/vehiclePools";
import { PedPools } from "./render/pedPools";
import { KITS } from "./render/vehicleKits";
import { RoadDebugOverlay } from "./render/roadDebugOverlay";
import { extractRoadTile, RoadTile } from "./roads";
import type { CameraClamp } from "./render/cameraRig";
import { useHud } from "./store";

export interface MoveInput {
  dirX: number;
  dirZ: number;
  moving: boolean;
  sprint: boolean;
  jump: boolean;
  enter: boolean;
  /** Raw -1..1 axes for vehicles (throttle / steering). */
  forward: number;
  strafe: number;
  toggleRoadDebug: boolean;
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
  /** Visible player body (third person only). */
  readonly avatar = new PlayerAvatar();
  readonly vehiclePools = new VehiclePools();
  readonly pedPools = new PedPools();
  readonly roadDebug = new RoadDebugOverlay();
  /** Per-tile road polylines (minimap + sim upload share this). */
  readonly roadTiles = new Map<string, RoadTile>();
  /** Renderer-reported camera state, for HUD/tests. */
  camMode: "fp" | "tp" = "fp";
  camPos = { x: 0, y: 0, z: 0 };
  /** Per-frame driving snapshot for the chase cam + HUD. */
  driveState: { yaw: number; speed: number } | null = null;

  private queue: FetchQueue;
  private heights: HeightFieldRegistry;
  private collision = new CollisionWorld();
  private chunks: ChunkManager;
  private buildings: BuildingManager;

  /** Tile data that arrived before the wasm module finished booting. */
  private pendingTiles = new Map<string, PendingTile>();
  private pendingBuildings = new Map<string, { tx: number; ty: number; flat: FlatFootprints }>();
  private pendingRoads = new Map<string, { tx: number; ty: number; roads: RoadTile }>();
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
    this.group.add(
      this.chunks.group,
      this.buildings.group,
      this.avatar.group,
      this.vehiclePools.group,
      this.pedPools.group,
    );

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

    // Roads ride in the same MVT bytes: extract, keep for the minimap,
    // and feed the sim's directed graph.
    this.buildings.onTileData = (tx, ty, buf) => {
      const roads = extractRoadTile(buf, tx, ty, CONFIG.buildingZoom, this.anchor);
      if (!roads) return;
      this.roadTiles.set(`${tx}/${ty}`, roads);
      if (this.sim) {
        this.sim.loadTileRoads(tx, ty, roads.coords, roads.lineOffsets, roads.lineAttrs);
      } else {
        this.pendingRoads.set(`${tx}/${ty}`, { tx, ty, roads });
      }
    };
    this.buildings.onTileDataRemoved = (tx, ty) => {
      if (!this.roadTiles.delete(`${tx}/${ty}`)) return;
      if (this.sim) {
        this.sim.unloadTileRoads(tx, ty);
      } else {
        this.pendingRoads.delete(`${tx}/${ty}`);
      }
    };

    this.group.add(this.roadDebug.group);
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
      for (const r of this.pendingRoads.values()) {
        sim.loadTileRoads(r.tx, r.ty, r.roads.coords, r.roads.lineOffsets, r.roads.lineAttrs);
      }
      this.pendingRoads.clear();
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
      const buttons =
        (input.sprint ? BTN.sprint : 0) |
        (input.jump ? BTN.jump : 0) |
        (input.enter ? BTN.enter : 0);
      this.sim.setInput(
        buttons,
        input.moving ? input.dirX : 0,
        input.moving ? input.dirZ : 0,
        input.forward,
        input.strafe,
      );
      this.sim.step(dt);
      this.playerCache = this.sim.playerPos();
      this.driveState = this.sim.driving()
        ? { yaw: this.sim.drivingYaw(), speed: this.sim.drivingSpeed() }
        : null;
      this.avatar.update(this.sim.entityView(), this.sim.entityViewU32(), this.elapsed);
      this.vehiclePools.update(this.sim.entityView(), this.sim.entityViewU32());
      this.pedPools.update(this.sim.entityView(), this.sim.entityViewU32());

      if (input.toggleRoadDebug) this.roadDebug.toggle();
      this.roadDebug.update(
        dt,
        () => this.sim!.debugRoadGraph(),
        (x, z) => this.heights.sample(x, z),
      );

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
      const nearCar =
        this.sim && !this.driveState ? this.sim.nearestVehicleDist() : -1;
      useHud.setState({
        lat,
        lon,
        elev: this.playerY - CONFIG.eyeHeight,
        chunks: this.chunks.liveCount,
        buildingsNote: this.buildings.failed ? "building data unavailable" : "",
        simTick: this.sim ? this.sim.tick : 0,
        simMs: this.sim ? this.sim.lastStepMs : 0,
        vehicle:
          this.driveState && this.sim
            ? {
                speedKmh: Math.abs(this.driveState.speed) * 3.6,
                name: KITS[Math.min(this.sim.drivingKind(), KITS.length - 1)].name,
              }
            : null,
        toast: nearCar > 0 && nearCar <= 3 ? "Press E to enter the vehicle" : "",
      });
    }
  }

  /**
   * Occlusion oracle for the third-person boom: exact building prisms
   * (footprint walls + height span over sampled ground) and terrain floor.
   */
  readonly cameraClamp: CameraClamp = {
    clampBoom: (tx, ty, tz, dx, dy, dz, len) => {
      const ex = tx + dx * len;
      const ez = tz + dz * len;
      let allowed = len;
      for (const hit of this.collision.segmentHits(tx, tz, ex, ez)) {
        const yAt = ty + dy * len * hit.t;
        const ground = this.heights.sample(hit.x, hit.z);
        if (ground === null) continue;
        if (yAt >= ground + hit.minHeight && yAt <= ground + hit.height) {
          allowed = Math.min(allowed, hit.t * len - 0.3);
          break; // hits are sorted; nearest blocking wall wins
        }
      }
      return allowed;
    },
    sampleGround: (x, z) => this.heights.sample(x, z),
  };

  dispose(): void {
    this.disposed = true;
    this.chunks.disposeAll();
    this.buildings.disposeAll();
    this.avatar.dispose();
    this.vehiclePools.dispose();
    this.pedPools.dispose();
    this.roadDebug.dispose();
    this.sim?.dispose();
    this.sim = null;
  }
}
