import * as THREE from "three";
import { CONFIG } from "./config";
import { WorldAnchor } from "./geo";
import { FetchQueue } from "./fetchQueue";
import { HeightFieldRegistry } from "./heightField";
import { CollisionWorld } from "./collision";
import { ChunkManager } from "./chunkManager";
import { BuildingManager } from "./buildingManager";
import { Player, MoveInput } from "./player";
import { SimBridge } from "./sim/simBridge";
import { useHud } from "./store";

const DIFF_INTERVAL = 0.25;
const HUD_INTERVAL = 0.25;
/** Open the world even if buildings haven't finished after this long. */
const READY_TIMEOUT = 15;

/**
 * Root of the imperative world: owns the streaming managers, collision,
 * and the player; ticked once per rendered frame from useFrame. React only
 * ever sees `group` (mounted via <primitive>) and the zustand HUD store.
 */
export class WorldEngine {
  readonly group = new THREE.Group();
  readonly anchor: WorldAnchor;
  readonly player: Player;
  disposed = false;
  /** Wasm sim core; null until async boot resolves (or if it fails). */
  sim: SimBridge | null = null;

  private queue: FetchQueue;
  private heights: HeightFieldRegistry;
  private collision = new CollisionWorld();
  private chunks: ChunkManager;
  private buildings: BuildingManager;

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
    // Spawn point is the anchor origin by construction.
    this.player = new Player(this.heights, this.collision, 0, 0);
    void this.bootSim();
  }

  /**
   * Boots the wasm sim alongside the streaming world. PR1: the sim only
   * ticks and proves the readback path; gameplay still lives in TS. Failure
   * is non-fatal here — that changes once player physics moves in (PR3).
   */
  private async bootSim(): Promise<void> {
    try {
      const sim = await SimBridge.boot(CONFIG.seed);
      if (this.disposed) {
        sim.dispose();
        return;
      }
      this.sim = sim;
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

    this.player.update(input, dt);
    this.sim?.step(dt);

    this.diffTimer += dt;
    if (this.diffTimer >= DIFF_INTERVAL) {
      this.diffTimer = 0;
      this.chunks.update(this.player.x, this.player.z);
      this.buildings.update(this.player.x, this.player.z);
    }
    this.buildings.processBuildQueue();

    if (!this.ready) {
      const groundLoaded = this.heights.sample(this.player.x, this.player.z) !== null;
      const buildingsSettled =
        this.buildings.isLiveAt(this.player.x, this.player.z) ||
        this.buildings.failed ||
        this.elapsed > READY_TIMEOUT;
      if (groundLoaded && buildingsSettled) {
        this.ready = true;
        this.player.enabled = true;
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
      const { lon, lat } = this.anchor.worldToLonLat(this.player.x, this.player.z);
      useHud.setState({
        lat,
        lon,
        elev: this.player.y - CONFIG.eyeHeight,
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
