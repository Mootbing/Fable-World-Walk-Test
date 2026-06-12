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

  loadTileRoads(
    tx: number,
    ty: number,
    coords: Float32Array,
    lineOffsets: Uint32Array,
    lineAttrs: Uint32Array,
  ): void {
    this.sim.load_tile_roads(tx, ty, coords, lineOffsets, lineAttrs);
  }

  unloadTileRoads(tx: number, ty: number): void {
    this.sim.unload_tile_roads(tx, ty);
  }

  loadPois(tx: number, ty: number, kinds: Uint32Array, coords: Float32Array): void {
    this.sim.load_pois(tx, ty, kinds, coords);
  }

  unloadPois(tx: number, ty: number): void {
    this.sim.unload_pois(tx, ty);
  }

  poiCount(): number {
    return this.sim.poi_count();
  }

  snapshot(): Float64Array {
    return this.sim.snapshot();
  }

  restore(data: Float64Array): boolean {
    return this.sim.restore(data);
  }

  roadStats(): { edges: number; nodes: number; connectivity: number } {
    return {
      edges: this.sim.road_edge_count(),
      nodes: this.sim.road_node_count(),
      connectivity: this.sim.road_connectivity(),
    };
  }

  /** Copy of the debug segment soup [x0,z0,x1,z1,...]. */
  debugRoadGraph(): Float32Array {
    return this.sim.debug_road_graph();
  }

  /** Route polyline from the player to (x,z); empty when unreachable. */
  routeTo(x: number, z: number): Float32Array {
    return this.sim.route_to(x, z);
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

  setInput(
    buttons: number,
    moveX: number,
    moveZ: number,
    axisForward = 0,
    axisStrafe = 0,
    aimYaw = 0,
    aimPitch = 0,
  ): void {
    this.sim.set_input(buttons, moveX, moveZ, axisForward, axisStrafe, aimYaw, aimPitch);
  }

  // ---- vehicles ----

  spawnVehicle(x: number, z: number, yaw: number, kind = 0): number {
    return this.sim.spawn_vehicle(x, z, yaw, kind);
  }

  driving(): boolean {
    return this.sim.driving();
  }

  drivingSpeed(): number {
    return this.sim.driving_speed();
  }

  drivingYaw(): number {
    return this.sim.driving_yaw();
  }

  drivingKind(): number {
    return this.sim.driving_kind();
  }

  trafficCount(): number {
    return this.sim.traffic_count();
  }

  setTrafficTarget(n: number): void {
    this.sim.set_traffic_target(n);
  }

  pedCount(): number {
    return this.sim.ped_count();
  }

  setPedTarget(n: number): void {
    this.sim.set_ped_target(n);
  }

  playerStats(): { health: number; armor: number; money: number; dead: boolean } {
    return {
      health: this.sim.player_health(),
      armor: this.sim.player_armor(),
      money: this.sim.player_money(),
      dead: this.sim.player_dead(),
    };
  }

  damagePlayer(amount: number): void {
    this.sim.damage_player(amount);
  }

  spawnPickupAt(x: number, z: number, kind: number, value: number): number {
    return this.sim.spawn_pickup_at(x, z, kind, value);
  }

  /** Spawn a parked traffic car at an exact spot (debug/tests). */
  debugSpawnTraffic(x: number, z: number, yaw: number, kind: number): number {
    return this.sim.debug_spawn_traffic(x, z, yaw, kind);
  }

  wantedLevel(): number {
    return this.sim.wanted_level();
  }

  wantedEvading(): boolean {
    return this.sim.wanted_evading();
  }

  isBusted(): boolean {
    return this.sim.is_busted();
  }

  addHeat(amount: number): void {
    this.sim.add_heat(amount);
  }

  weaponsOwned(): number {
    return this.sim.weapons_owned();
  }

  equipWeapon(id: number): void {
    this.sim.equip_weapon(id);
  }

  giveWeapon(id: number, ammo: number): void {
    this.sim.give_weapon(id, ammo);
  }

  weaponState(): { equipped: number; clip: number; reserve: number; reloading: boolean } {
    return {
      equipped: this.sim.weapon_equipped(),
      clip: this.sim.weapon_clip(),
      reserve: this.sim.weapon_reserve(),
      reloading: this.sim.weapon_reloading(),
    };
  }

  /** Spawn a stationary ped (debug/tests). */
  debugSpawnPed(x: number, z: number): number {
    return this.sim.debug_spawn_ped(x, z);
  }

  nearestVehicleDist(): number {
    return this.sim.nearest_vehicle_dist();
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

  /** Same bytes as entityView — for the u32 lanes (id/type/flags). */
  entityViewU32(): Uint32Array {
    return new Uint32Array(
      this.memory.buffer,
      this.sim.entities_ptr(),
      this.sim.entity_count() * ENTITY_STRIDE,
    );
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
