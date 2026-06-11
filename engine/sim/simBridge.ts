import init, { Sim } from "@/sim/pkg/sim";
import { ENTITY_STRIDE, EVENT_WORDS } from "./entityLayout";
import type { BuildingFeature } from "../buildings";

/** Flat footprint upload format (see sim/src/lib.rs load_tile_buildings). */
export interface FlatFootprints {
  coords: Float32Array;
  ringOffsets: Uint32Array;
  featOffsets: Uint32Array;
}

/**
 * Flatten parsed building features for upload, keeping only footprints that
 * block walking (elevated structures like skybridges don't).
 */
export function flattenFootprints(buildings: BuildingFeature[]): FlatFootprints {
  const walkBlocking = buildings.filter((b) => b.minHeight <= 2.5);
  const coords: number[] = [];
  const ringOffsets: number[] = [];
  const featOffsets: number[] = [];
  let vertex = 0;
  for (const b of walkBlocking) {
    featOffsets.push(ringOffsets.length);
    for (const ring of b.rings) {
      ringOffsets.push(vertex);
      for (const [x, z] of ring) {
        coords.push(x, z);
        vertex++;
      }
    }
  }
  featOffsets.push(ringOffsets.length);
  ringOffsets.push(vertex);
  return {
    coords: new Float32Array(coords),
    ringOffsets: new Uint32Array(ringOffsets),
    featOffsets: new Uint32Array(featOffsets),
  };
}

/**
 * Owns the wasm sim instance and all views into its linear memory. Views are
 * recreated on every access: wasm memory growth detaches ArrayBuffers, so a
 * cached view can silently go stale. Pointers from Rust are byte offsets;
 * typed-array lengths are in elements — keep that math in here only.
 */
export class SimBridge {
  lastStepMs = 0;

  private constructor(
    private readonly sim: Sim,
    private readonly memory: WebAssembly.Memory,
  ) {}

  static async boot(seed: number, spawnX = 0, spawnZ = 0): Promise<SimBridge> {
    const out = await init({ module_or_path: "/sim_bg.wasm" });
    const sim = new Sim(BigInt(seed), spawnX, spawnZ);
    return new SimBridge(sim, out.memory);
  }

  // ---- streamed world data ----

  loadHeightfield(
    tx: number,
    ty: number,
    originX: number,
    originZ: number,
    size: number,
    field: Float32Array,
  ): void {
    this.sim.load_heightfield(tx, ty, originX, originZ, size, field);
  }

  unloadHeightfield(tx: number, ty: number): void {
    this.sim.unload_heightfield(tx, ty);
  }

  loadTileBuildings(tx: number, ty: number, flat: FlatFootprints): void {
    this.sim.load_tile_buildings(tx, ty, flat.coords, flat.ringOffsets, flat.featOffsets);
  }

  unloadTileBuildings(tx: number, ty: number): void {
    this.sim.unload_tile_buildings(tx, ty);
  }

  /** Debug/test: circle pushed out of the wasm collision world. */
  resolveProbe(x: number, z: number, r: number): { x: number; z: number } {
    const out = this.sim.resolve_probe(x, z, r);
    return { x: out[0], z: out[1] };
  }

  // ---- player ----

  setPlayerEnabled(enabled: boolean): void {
    this.sim.set_player_enabled(enabled);
  }

  /** Collision-corrected position writeback (TS collision until PR4). */
  setPlayerPos(x: number, z: number): void {
    this.sim.set_player_pos(x, z);
  }

  playerPos(): { x: number; y: number; z: number } {
    return { x: this.sim.player_x(), y: this.sim.player_y(), z: this.sim.player_z() };
  }

  // ---- per-frame ----

  setInput(buttons: number, moveX: number, moveZ: number, aimYaw = 0, aimPitch = 0): void {
    this.sim.set_input(buttons, moveX, moveZ, aimYaw, aimPitch);
  }

  step(dt: number): void {
    const t0 = performance.now();
    this.sim.step(dt);
    this.lastStepMs = performance.now() - t0;
  }

  /**
   * Events from the last step() as 4-word records [type, a, b, c].
   * Returns a copy (the wasm-side buffer is reused next step).
   */
  drainEvents(): Uint32Array {
    const count = this.sim.events_count();
    if (count === 0) return new Uint32Array(0);
    return new Uint32Array(
      this.memory.buffer.slice(
        this.sim.events_ptr(),
        this.sim.events_ptr() + count * EVENT_WORDS * 4,
      ),
    );
  }

  get tick(): number {
    return this.sim.tick();
  }

  static get version(): string {
    return Sim.version();
  }

  entityView(): Float32Array {
    return this.f32(this.sim.entities_ptr(), this.sim.entity_count() * ENTITY_STRIDE);
  }

  entityCount(): number {
    return this.sim.entity_count();
  }

  /**
   * Readback benchmark: time a full pass (fresh view + touch every lane)
   * over `n` live entities. Returns average ms per pass.
   */
  benchmark(n: number, passes = 100): number {
    this.sim.bench_spawn(n);
    this.sim.step(1 / 60);
    let sink = 0;
    const t0 = performance.now();
    for (let p = 0; p < passes; p++) {
      const view = this.entityView();
      for (let i = 0; i < view.length; i++) sink += view[i];
    }
    const avg = (performance.now() - t0) / passes;
    // Keep `sink` observable so the loop can't be optimized away.
    if (!Number.isFinite(sink)) console.warn("benchmark sink overflow");
    this.sim.bench_spawn(0);
    return avg;
  }

  dispose(): void {
    this.sim.free();
  }

  private f32(bytePtr: number, len: number): Float32Array {
    return new Float32Array(this.memory.buffer, bytePtr, len);
  }
}
