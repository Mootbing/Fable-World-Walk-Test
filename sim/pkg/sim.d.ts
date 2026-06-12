/* tslint:disable */
/* eslint-disable */

export class Sim {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Debug/test/missions: pour on heat directly.
     */
    add_heat(amount: number): void;
    /**
     * Spawn n synthetic entities (slotted after the player and vehicles)
     * that move every substep, for measuring JS readback cost at scale.
     */
    bench_spawn(n: number): void;
    bridge_edge_count(): number;
    /**
     * Midpoint [x, z] of the nearest deck-computable bridge edge.
     */
    bridge_probe(): Float64Array;
    /**
     * Pay'n'spray / mission scripting: drop all heat instantly.
     */
    clear_wanted(): void;
    /**
     * Apply damage to the player (debug/tests; combat uses it internally).
     */
    damage_player(amount: number): void;
    /**
     * Debug overlay: flat [x0,z0,x1,z1,...] segment soup of all edges.
     */
    debug_road_graph(): Float32Array;
    /**
     * Debug/test: a stationary ped at (x,z).
     */
    debug_spawn_ped(x: number, z: number): number;
    /**
     * Spawn a parked traffic car at an exact spot (debug/tests/setups).
     */
    debug_spawn_traffic(x: number, z: number, yaw: number, kind: number): number;
    /**
     * [deck] if a bridge deck spans (x,z), else empty.
     */
    deck_probe(x: number, z: number): Float64Array;
    driving(): boolean;
    driving_kind(): number;
    /**
     * Signed forward speed while driving, 0 on foot (for HUD/camera).
     */
    driving_speed(): number;
    /**
     * Id of the vehicle being driven, or 0.
     */
    driving_vehicle_id(): number;
    driving_yaw(): number;
    entities_ptr(): number;
    entity_count(): number;
    equip_weapon(id: number): void;
    events_count(): number;
    events_ptr(): number;
    give_armor(amount: number): void;
    /**
     * Mission rewards / fees / shops.
     */
    give_money(amount: number): void;
    /**
     * Grant a weapon + ammo (shops, missions, debug).
     */
    give_weapon(id: number, ammo: number): void;
    is_busted(): boolean;
    is_swimming(): boolean;
    /**
     * 256x256 row-major f32 grid; origin = tile NW corner in world meters.
     */
    load_heightfield(tx: number, ty: number, origin_x: number, origin_z: number, size: number, grid: Float32Array): void;
    /**
     * POIs for one tile: flat kinds + xz pairs.
     */
    load_pois(tx: number, ty: number, kinds: Uint32Array, coords: Float32Array): void;
    /**
     * Building footprints for one z14 tile, pre-filtered by JS to those
     * that block walking (min_height <= 2.5m). Flat format:
     *   coords:       x0,z0,x1,z1,...  absolute world meters (f32)
     *   ring_offsets: start VERTEX index of each ring, plus end sentinel
     *   feat_offsets: start RING index of each footprint, plus end sentinel
     */
    load_tile_buildings(tx: number, ty: number, coords: Float32Array, ring_offsets: Uint32Array, feat_offsets: Uint32Array, tops: Float32Array): void;
    /**
     * Road polylines for one z14 tile (see engine/roads.ts for the flat
     * format). Builds/extends the directed road graph.
     */
    load_tile_roads(tx: number, ty: number, coords: Float32Array, line_offsets: Uint32Array, line_attrs: Uint32Array): void;
    /**
     * Water polygons for one tile: flat coords + ring sizes + rings/poly.
     */
    load_water(tx: number, ty: number, coords: Float32Array, ring_sizes: Uint32Array, poly_ring_counts: Uint32Array): void;
    /**
     * Distance to the nearest enterable vehicle (owned or traffic), or -1.
     */
    nearest_vehicle_dist(): number;
    constructor(seed: bigint, spawn_x: number, spawn_z: number);
    /**
     * Nearest uncollected package [x, z], or empty if none spawned.
     */
    package_nearest(x: number, z: number): Float64Array;
    packages_found(): number;
    packages_spawned(): number;
    ped_count(): number;
    pickup_count(): number;
    player_armor(): number;
    player_dead(): boolean;
    player_health(): number;
    player_money(): number;
    player_x(): number;
    player_y(): number;
    player_z(): number;
    poi_count(): number;
    police_heli_active(): boolean;
    /**
     * Remove a ped by id (fares boarding, scripted cleanup).
     */
    remove_ped(id: number): boolean;
    /**
     * Debug/test probe: resolve a circle against the collision world and
     * return [resolved_x, resolved_z].
     */
    resolve_probe(x: number, z: number, r: number): Float64Array;
    /**
     * Restore a snapshot; the player snaps to ground at the saved spot.
     */
    restore(data: Float64Array): boolean;
    /**
     * Component edge-length totals, sorted descending (debug).
     */
    road_components(): Float64Array;
    road_connectivity(): number;
    road_edge_count(): number;
    road_node_count(): number;
    /**
     * Shortest drivable route from the player to (x,z) as flat [x,z,...]
     * pairs; empty when no route exists in the loaded graph.
     */
    route_to(x: number, z: number): Float32Array;
    /**
     * move_x/move_z: world-space movement direction (normalized or zero).
     * axis_forward/axis_strafe: raw -1..1 input axes (throttle/steer).
     */
    set_input(buttons: number, move_x: number, move_z: number, axis_forward: number, axis_strafe: number, aim_yaw: number, aim_pitch: number): void;
    set_ped_target(n: number): void;
    set_player_enabled(enabled: boolean): void;
    /**
     * Horizontal correction writeback (JS-side building collision until the
     * spatial hash ports to Rust in PR4 — see ROADMAP.md).
     */
    set_player_pos(x: number, z: number): void;
    set_traffic_target(n: number): void;
    /**
     * Debug/test/scripting: force a weather state now.
     */
    set_weather(w: number): void;
    /**
     * Flat save snapshot (versioned): position, survival stats, arsenal,
     * heat. Small and manual — no serde in the crate.
     */
    snapshot(): Float64Array;
    /**
     * Drop a boat on the water at (x,z); 0 if that spot is dry.
     */
    spawn_boat(x: number, z: number): number;
    /**
     * Vigilante target: a marked roaming car near the player; 0 if no
     * suitable edge.
     */
    spawn_marked_car(): number;
    /**
     * Spawn a pickup at ground level near (x,z). kind: 0 health, 1 armor,
     * 2 money.
     */
    spawn_pickup_at(x: number, z: number, kind: number, value: number): number;
    /**
     * Spawn a vehicle; returns its id. Used by the starter car, debug
     * tooling, and (later) traffic/missions.
     */
    spawn_vehicle(x: number, z: number, yaw: number, kind: number): number;
    /**
     * Pay'n'spray: $100 repaints + repairs the ride and clears wanted.
     * 0 = done, 1 = on foot, 2 = too hot (3 stars and up), 3 = broke.
     */
    spray_vehicle(): number;
    /**
     * [m walked, m driven, peds killed, cars jacked, shots fired].
     */
    stats_counters(): Float64Array;
    /**
     * Advance the sim. Runs fixed 60 Hz substeps from an accumulator; dt is
     * clamped (matches the renderer's clamp) and substeps are capped so a
     * long pause can't trigger a death spiral. Events accumulate across the
     * substeps of one call and are valid until the next call.
     */
    step(dt: number): void;
    tick(): number;
    time(): number;
    traffic_count(): number;
    /**
     * Deduct if affordable (shop purchases); true on success.
     */
    try_charge(amount: number): boolean;
    unload_heightfield(tx: number, ty: number): void;
    unload_pois(tx: number, ty: number): void;
    unload_tile_buildings(tx: number, ty: number): void;
    unload_tile_roads(tx: number, ty: number): void;
    unload_water(tx: number, ty: number): void;
    static version(): string;
    wanted_evading(): boolean;
    /**
     * Bitmask of owned weapon slots (wheel UI).
     */
    wanted_level(): number;
    water_count(): number;
    /**
     * [x, z] of the nearest swimmable point to the player, or empty.
     */
    water_probe(): Float64Array;
    weapon_clip(): number;
    weapon_equipped(): number;
    weapon_reloading(): boolean;
    weapon_reserve(): number;
    weapons_owned(): number;
    weather(): number;
    /**
     * Grip multiplier for the current sky (1 = dry).
     */
    weather_grip(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_sim_free: (a: number, b: number) => void;
    readonly sim_add_heat: (a: number, b: number) => void;
    readonly sim_bench_spawn: (a: number, b: number) => void;
    readonly sim_bridge_edge_count: (a: number) => number;
    readonly sim_bridge_probe: (a: number) => [number, number];
    readonly sim_clear_wanted: (a: number) => void;
    readonly sim_damage_player: (a: number, b: number) => void;
    readonly sim_debug_road_graph: (a: number) => [number, number];
    readonly sim_debug_spawn_ped: (a: number, b: number, c: number) => number;
    readonly sim_debug_spawn_traffic: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly sim_deck_probe: (a: number, b: number, c: number) => [number, number];
    readonly sim_driving: (a: number) => number;
    readonly sim_driving_kind: (a: number) => number;
    readonly sim_driving_speed: (a: number) => number;
    readonly sim_driving_vehicle_id: (a: number) => number;
    readonly sim_driving_yaw: (a: number) => number;
    readonly sim_entities_ptr: (a: number) => number;
    readonly sim_entity_count: (a: number) => number;
    readonly sim_equip_weapon: (a: number, b: number) => void;
    readonly sim_events_count: (a: number) => number;
    readonly sim_events_ptr: (a: number) => number;
    readonly sim_give_armor: (a: number, b: number) => void;
    readonly sim_give_money: (a: number, b: number) => void;
    readonly sim_give_weapon: (a: number, b: number, c: number) => void;
    readonly sim_is_busted: (a: number) => number;
    readonly sim_is_swimming: (a: number) => number;
    readonly sim_load_heightfield: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly sim_load_pois: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly sim_load_tile_buildings: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly sim_load_tile_roads: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly sim_load_water: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly sim_nearest_vehicle_dist: (a: number) => number;
    readonly sim_new: (a: bigint, b: number, c: number) => number;
    readonly sim_package_nearest: (a: number, b: number, c: number) => [number, number];
    readonly sim_packages_found: (a: number) => number;
    readonly sim_packages_spawned: (a: number) => number;
    readonly sim_ped_count: (a: number) => number;
    readonly sim_pickup_count: (a: number) => number;
    readonly sim_player_armor: (a: number) => number;
    readonly sim_player_dead: (a: number) => number;
    readonly sim_player_health: (a: number) => number;
    readonly sim_player_money: (a: number) => number;
    readonly sim_player_x: (a: number) => number;
    readonly sim_player_y: (a: number) => number;
    readonly sim_player_z: (a: number) => number;
    readonly sim_poi_count: (a: number) => number;
    readonly sim_police_heli_active: (a: number) => number;
    readonly sim_remove_ped: (a: number, b: number) => number;
    readonly sim_resolve_probe: (a: number, b: number, c: number, d: number) => [number, number];
    readonly sim_restore: (a: number, b: number, c: number) => number;
    readonly sim_road_components: (a: number) => [number, number];
    readonly sim_road_connectivity: (a: number) => number;
    readonly sim_road_edge_count: (a: number) => number;
    readonly sim_road_node_count: (a: number) => number;
    readonly sim_route_to: (a: number, b: number, c: number) => [number, number];
    readonly sim_set_input: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly sim_set_ped_target: (a: number, b: number) => void;
    readonly sim_set_player_enabled: (a: number, b: number) => void;
    readonly sim_set_player_pos: (a: number, b: number, c: number) => void;
    readonly sim_set_traffic_target: (a: number, b: number) => void;
    readonly sim_set_weather: (a: number, b: number) => void;
    readonly sim_snapshot: (a: number) => [number, number];
    readonly sim_spawn_boat: (a: number, b: number, c: number) => number;
    readonly sim_spawn_marked_car: (a: number) => number;
    readonly sim_spawn_pickup_at: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly sim_spawn_vehicle: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly sim_spray_vehicle: (a: number) => number;
    readonly sim_stats_counters: (a: number) => [number, number];
    readonly sim_step: (a: number, b: number) => void;
    readonly sim_tick: (a: number) => number;
    readonly sim_time: (a: number) => number;
    readonly sim_traffic_count: (a: number) => number;
    readonly sim_try_charge: (a: number, b: number) => number;
    readonly sim_unload_heightfield: (a: number, b: number, c: number) => void;
    readonly sim_unload_pois: (a: number, b: number, c: number) => void;
    readonly sim_unload_tile_buildings: (a: number, b: number, c: number) => void;
    readonly sim_unload_tile_roads: (a: number, b: number, c: number) => void;
    readonly sim_unload_water: (a: number, b: number, c: number) => void;
    readonly sim_version: () => [number, number];
    readonly sim_wanted_evading: (a: number) => number;
    readonly sim_wanted_level: (a: number) => number;
    readonly sim_water_count: (a: number) => number;
    readonly sim_water_probe: (a: number) => [number, number];
    readonly sim_weapon_clip: (a: number) => number;
    readonly sim_weapon_equipped: (a: number) => number;
    readonly sim_weapon_reloading: (a: number) => number;
    readonly sim_weapon_reserve: (a: number) => number;
    readonly sim_weapons_owned: (a: number) => number;
    readonly sim_weather: (a: number) => number;
    readonly sim_weather_grip: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
