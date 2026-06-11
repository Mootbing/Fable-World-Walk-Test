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
import { PickupPools } from "./render/pickupPools";
import { FxPools } from "./render/fx";
import { KITS } from "./render/vehicleKits";
import { RoadDebugOverlay } from "./render/roadDebugOverlay";
import { extractRoadTile, RoadTile } from "./roads";
import { extractPlaces, resolveArea, Place } from "./places";
import type { CameraClamp } from "./render/cameraRig";
import { useHud } from "./store";

export const WEAPON_NAMES = ["Fists", "Bat", "Pistol", "SMG", "Shotgun"];

export interface MoveInput {
  dirX: number;
  dirZ: number;
  moving: boolean;
  sprint: boolean;
  jump: boolean;
  enter: boolean;
  horn: boolean;
  fire: boolean;
  aim: boolean;
  reload: boolean;
  switchWeapon: boolean;
  /** Camera yaw — melee/aim direction. */
  aimYaw: number;
  /** Raw -1..1 axes for vehicles (throttle / steering). */
  forward: number;
  strafe: number;
  toggleRoadDebug: boolean;
  equipSlot: number | null;
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
  readonly pickupPools = new PickupPools();
  readonly fx = new FxPools();
  readonly roadDebug = new RoadDebugOverlay();
  /** Per-tile road polylines (minimap + sim upload share this). */
  readonly roadTiles = new Map<string, RoadTile>();
  /** Per-tile place points for area-name toasts. */
  readonly placeTiles = new Map<string, Place[]>();
  private currentArea = "";
  /** Game clock in minutes since midnight (1 real second = 1 game minute). */
  clockMinutes = 12 * 60;
  /** Renderer-reported camera state, for HUD/tests/minimap. */
  camMode: "fp" | "tp" = "fp";
  camPos = { x: 0, y: 0, z: 0 };
  camYaw = 0;
  /** Generic minimap blips (mission markers, waypoints — future systems). */
  readonly blips: { id: string; x: number; z: number; color: string }[] = [];
  /** Active GPS route polyline (flat world [x,z,...]), or null. */
  gpsRoute: Float32Array | null = null;
  waypoint: { x: number; z: number } | null = null;
  private gpsTimer = 0;
  private fxTimer = 0;
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
      this.pickupPools.group,
      this.fx.group,
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
      const places = extractPlaces(buf, tx, ty, CONFIG.buildingZoom, this.anchor);
      if (places.length > 0) this.placeTiles.set(`${tx}/${ty}`, places);
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
      this.placeTiles.delete(`${tx}/${ty}`);
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
    this.clockMinutes = (this.clockMinutes + dt) % 1440;

    if (this.sim) {
      const buttons =
        (input.sprint ? BTN.sprint : 0) |
        (input.jump ? BTN.jump : 0) |
        (input.enter ? BTN.enter : 0) |
        (input.horn ? BTN.horn : 0) |
        (input.fire ? BTN.fire : 0) |
        (input.aim ? BTN.aim : 0) |
        (input.reload ? BTN.reload : 0) |
        (input.switchWeapon ? BTN.switchWeapon : 0);
      if (input.equipSlot !== null) this.sim.equipWeapon(input.equipSlot);
      this.sim.setInput(
        buttons,
        input.moving ? input.dirX : 0,
        input.moving ? input.dirZ : 0,
        input.forward,
        input.strafe,
        input.aimYaw,
      );
      this.sim.step(dt);
      this.playerCache = this.sim.playerPos();
      this.driveState = this.sim.driving()
        ? { yaw: this.sim.drivingYaw(), speed: this.sim.drivingSpeed() }
        : null;
      this.avatar.update(this.sim.entityView(), this.sim.entityViewU32(), this.elapsed);
      this.vehiclePools.update(this.sim.entityView(), this.sim.entityViewU32());
      this.pedPools.update(this.sim.entityView(), this.sim.entityViewU32());
      this.pickupPools.update(this.sim.entityView(), this.sim.entityViewU32(), this.elapsed);

      if (input.toggleRoadDebug) this.roadDebug.toggle();
      this.roadDebug.update(
        dt,
        () => this.sim!.debugRoadGraph(),
        (x, z) => this.heights.sample(x, z),
      );

      const events = this.sim.drainEvents();
      if (events.length > 0) {
        for (let i = 0; i < events.length; i += 4) {
          if (events[i] === 17) {
            const f32 = new Float32Array(
              new Uint32Array([events[i + 1], events[i + 2], events[i + 3]]).buffer,
            );
            this.fx.explosion(f32[0], f32[1], f32[2]);
          }
          // Gunshots draw a tracer from the muzzle to the hit point.
          if (events[i] === 14) {
            const f32 = new Float32Array(
              new Uint32Array([events[i + 2], events[i + 3]]).buffer,
            );
            this.fx.addTracer(
              this.playerX,
              this.playerY - 0.15,
              this.playerZ,
              f32[0],
              this.playerY - 0.15,
              f32[1],
            );
          }
        }
        for (const word of events) this.eventLog.push(word);
        const excess = this.eventLog.length - EVENT_LOG_CAP * 4;
        if (excess > 0) this.eventLog.splice(0, excess);
      }
      // Burning/smoking vehicles emit at a steady trickle.
      this.fxTimer += dt;
      if (this.fxTimer >= 0.12) {
        this.fxTimer = 0;
        const f32 = this.sim.entityView();
        const u32 = this.sim.entityViewU32();
        for (let base = 0; base < f32.length; base += 16) {
          const flags = u32[base + 14];
          if (flags & 64) this.fx.flame(f32[base], f32[base + 1], f32[base + 2]);
          else if (flags & 32) this.fx.smokePuff(f32[base], f32[base + 1], f32[base + 2]);
        }
      }
      this.fx.update(dt);
    }

    this.diffTimer += dt;
    if (this.diffTimer >= DIFF_INTERVAL) {
      this.diffTimer = 0;
      this.chunks.update(this.playerX, this.playerZ);
      this.buildings.update(this.playerX, this.playerZ);
    }
    this.buildings.processBuildQueue();
    this.updateGps(dt);

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
        clock: `${String(Math.floor(this.clockMinutes / 60)).padStart(2, "0")}:${String(
          Math.floor(this.clockMinutes % 60),
        ).padStart(2, "0")}`,
        ...(this.sim ? this.sim.playerStats() : {}),
        weapon: (() => {
          if (!this.sim) return null;
          const w = this.sim.weaponState();
          if (w.equipped === 0) return null; // bare fists: no HUD line
          return {
            name: WEAPON_NAMES[w.equipped] ?? "?",
            clip: w.clip,
            reserve: w.reserve,
            reloading: w.reloading,
          };
        })(),
        weaponsOwned: this.sim ? this.sim.weaponsOwned() : 1,
        weaponEquipped: this.sim ? this.sim.weaponState().equipped : 0,
      });
      const area = resolveArea(this.placeTiles.values(), this.playerX, this.playerZ);
      if (area && area !== this.currentArea) {
        this.currentArea = area;
        useHud.setState({ areaToast: area });
      }
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

  /** Set the GPS waypoint: magenta blip + routed line on radar and map. */
  setWaypoint(x: number, z: number): void {
    this.waypoint = { x, z };
    const idx = this.blips.findIndex((b) => b.id === "waypoint");
    const blip = { id: "waypoint", x, z, color: "#d24bd2" };
    if (idx >= 0) this.blips[idx] = blip;
    else this.blips.push(blip);
    this.recomputeRoute();
  }

  clearWaypoint(): void {
    this.waypoint = null;
    this.gpsRoute = null;
    const idx = this.blips.findIndex((b) => b.id === "waypoint");
    if (idx >= 0) this.blips.splice(idx, 1);
  }

  private recomputeRoute(): void {
    if (!this.sim || !this.waypoint) return;
    const route = this.sim.routeTo(this.waypoint.x, this.waypoint.z);
    this.gpsRoute = route.length >= 4 ? route : null;
  }

  /** Arrival + deviation checks at a gentle cadence. */
  private updateGps(dt: number): void {
    if (!this.waypoint) return;
    this.gpsTimer += dt;
    if (this.gpsTimer < 2) return;
    this.gpsTimer = 0;
    const dx = this.playerX - this.waypoint.x;
    const dz = this.playerZ - this.waypoint.z;
    if (Math.hypot(dx, dz) < 18) {
      this.clearWaypoint();
      return;
    }
    if (this.gpsRoute) {
      // Deviated >35m from the routed line? Re-route.
      let best = Infinity;
      for (let i = 0; i < this.gpsRoute.length; i += 8) {
        const d = Math.hypot(this.playerX - this.gpsRoute[i], this.playerZ - this.gpsRoute[i + 1]);
        if (d < best) best = d;
      }
      if (best > 35) this.recomputeRoute();
    } else {
      this.recomputeRoute(); // graph may have streamed in since
    }
  }

  dispose(): void {
    this.disposed = true;
    this.chunks.disposeAll();
    this.buildings.disposeAll();
    this.avatar.dispose();
    this.vehiclePools.dispose();
    this.pedPools.dispose();
    this.pickupPools.dispose();
    this.fx.dispose();
    this.roadDebug.dispose();
    this.sim?.dispose();
    this.sim = null;
  }
}
