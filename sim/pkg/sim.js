/* @ts-self-types="./sim.d.ts" */

export class Sim {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SimFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sim_free(ptr, 0);
    }
    /**
     * Debug/test/missions: pour on heat directly.
     * @param {number} amount
     */
    add_heat(amount) {
        wasm.sim_add_heat(this.__wbg_ptr, amount);
    }
    /**
     * Spawn n synthetic entities (slotted after the player and vehicles)
     * that move every substep, for measuring JS readback cost at scale.
     * @param {number} n
     */
    bench_spawn(n) {
        wasm.sim_bench_spawn(this.__wbg_ptr, n);
    }
    /**
     * @returns {number}
     */
    bridge_edge_count() {
        const ret = wasm.sim_bridge_edge_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Midpoint [x, z] of the nearest deck-computable bridge edge.
     * @returns {Float64Array}
     */
    bridge_probe() {
        const ret = wasm.sim_bridge_probe(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Pay'n'spray / mission scripting: drop all heat instantly.
     */
    clear_wanted() {
        wasm.sim_clear_wanted(this.__wbg_ptr);
    }
    /**
     * Apply damage to the player (debug/tests; combat uses it internally).
     * @param {number} amount
     */
    damage_player(amount) {
        wasm.sim_damage_player(this.__wbg_ptr, amount);
    }
    /**
     * Debug overlay: flat [x0,z0,x1,z1,...] segment soup of all edges.
     * @returns {Float32Array}
     */
    debug_road_graph() {
        const ret = wasm.sim_debug_road_graph(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Debug/test: a stationary ped at (x,z).
     * @param {number} x
     * @param {number} z
     * @returns {number}
     */
    debug_spawn_ped(x, z) {
        const ret = wasm.sim_debug_spawn_ped(this.__wbg_ptr, x, z);
        return ret >>> 0;
    }
    /**
     * Spawn a parked traffic car at an exact spot (debug/tests/setups).
     * @param {number} x
     * @param {number} z
     * @param {number} yaw
     * @param {number} kind
     * @returns {number}
     */
    debug_spawn_traffic(x, z, yaw, kind) {
        const ret = wasm.sim_debug_spawn_traffic(this.__wbg_ptr, x, z, yaw, kind);
        return ret >>> 0;
    }
    /**
     * [deck] if a bridge deck spans (x,z), else empty.
     * @param {number} x
     * @param {number} z
     * @returns {Float64Array}
     */
    deck_probe(x, z) {
        const ret = wasm.sim_deck_probe(this.__wbg_ptr, x, z);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    driving() {
        const ret = wasm.sim_driving(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    driving_kind() {
        const ret = wasm.sim_driving_kind(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Signed forward speed while driving, 0 on foot (for HUD/camera).
     * @returns {number}
     */
    driving_speed() {
        const ret = wasm.sim_driving_speed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Id of the vehicle being driven, or 0.
     * @returns {number}
     */
    driving_vehicle_id() {
        const ret = wasm.sim_driving_vehicle_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    driving_yaw() {
        const ret = wasm.sim_driving_yaw(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    entities_ptr() {
        const ret = wasm.sim_entities_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    entity_count() {
        const ret = wasm.sim_entity_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} id
     */
    equip_weapon(id) {
        wasm.sim_equip_weapon(this.__wbg_ptr, id);
    }
    /**
     * @returns {number}
     */
    events_count() {
        const ret = wasm.sim_events_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    events_ptr() {
        const ret = wasm.sim_events_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} amount
     */
    give_armor(amount) {
        wasm.sim_give_armor(this.__wbg_ptr, amount);
    }
    /**
     * Mission rewards / fees / shops.
     * @param {number} amount
     */
    give_money(amount) {
        wasm.sim_give_money(this.__wbg_ptr, amount);
    }
    /**
     * Grant a weapon + ammo (shops, missions, debug).
     * @param {number} id
     * @param {number} ammo
     */
    give_weapon(id, ammo) {
        wasm.sim_give_weapon(this.__wbg_ptr, id, ammo);
    }
    /**
     * @returns {boolean}
     */
    is_busted() {
        const ret = wasm.sim_is_busted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    is_swimming() {
        const ret = wasm.sim_is_swimming(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 256x256 row-major f32 grid; origin = tile NW corner in world meters.
     * @param {number} tx
     * @param {number} ty
     * @param {number} origin_x
     * @param {number} origin_z
     * @param {number} size
     * @param {Float32Array} grid
     */
    load_heightfield(tx, ty, origin_x, origin_z, size, grid) {
        const ptr0 = passArrayF32ToWasm0(grid, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.sim_load_heightfield(this.__wbg_ptr, tx, ty, origin_x, origin_z, size, ptr0, len0);
    }
    /**
     * POIs for one tile: flat kinds + xz pairs.
     * @param {number} tx
     * @param {number} ty
     * @param {Uint32Array} kinds
     * @param {Float32Array} coords
     */
    load_pois(tx, ty, kinds, coords) {
        const ptr0 = passArray32ToWasm0(kinds, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(coords, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.sim_load_pois(this.__wbg_ptr, tx, ty, ptr0, len0, ptr1, len1);
    }
    /**
     * Building footprints for one z14 tile, pre-filtered by JS to those
     * that block walking (min_height <= 2.5m). Flat format:
     *   coords:       x0,z0,x1,z1,...  absolute world meters (f32)
     *   ring_offsets: start VERTEX index of each ring, plus end sentinel
     *   feat_offsets: start RING index of each footprint, plus end sentinel
     * @param {number} tx
     * @param {number} ty
     * @param {Float32Array} coords
     * @param {Uint32Array} ring_offsets
     * @param {Uint32Array} feat_offsets
     * @param {Float32Array} tops
     */
    load_tile_buildings(tx, ty, coords, ring_offsets, feat_offsets, tops) {
        const ptr0 = passArrayF32ToWasm0(coords, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(ring_offsets, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(feat_offsets, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF32ToWasm0(tops, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        wasm.sim_load_tile_buildings(this.__wbg_ptr, tx, ty, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    }
    /**
     * Road polylines for one z14 tile (see engine/roads.ts for the flat
     * format). Builds/extends the directed road graph.
     * @param {number} tx
     * @param {number} ty
     * @param {Float32Array} coords
     * @param {Uint32Array} line_offsets
     * @param {Uint32Array} line_attrs
     */
    load_tile_roads(tx, ty, coords, line_offsets, line_attrs) {
        const ptr0 = passArrayF32ToWasm0(coords, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(line_offsets, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(line_attrs, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.sim_load_tile_roads(this.__wbg_ptr, tx, ty, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * Water polygons for one tile: flat coords + ring sizes + rings/poly.
     * @param {number} tx
     * @param {number} ty
     * @param {Float32Array} coords
     * @param {Uint32Array} ring_sizes
     * @param {Uint32Array} poly_ring_counts
     */
    load_water(tx, ty, coords, ring_sizes, poly_ring_counts) {
        const ptr0 = passArrayF32ToWasm0(coords, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(ring_sizes, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(poly_ring_counts, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.sim_load_water(this.__wbg_ptr, tx, ty, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * Distance to the nearest enterable vehicle (owned or traffic), or -1.
     * @returns {number}
     */
    nearest_vehicle_dist() {
        const ret = wasm.sim_nearest_vehicle_dist(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {bigint} seed
     * @param {number} spawn_x
     * @param {number} spawn_z
     */
    constructor(seed, spawn_x, spawn_z) {
        const ret = wasm.sim_new(seed, spawn_x, spawn_z);
        this.__wbg_ptr = ret;
        SimFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Nearest uncollected package [x, z], or empty if none spawned.
     * @param {number} x
     * @param {number} z
     * @returns {Float64Array}
     */
    package_nearest(x, z) {
        const ret = wasm.sim_package_nearest(this.__wbg_ptr, x, z);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    packages_found() {
        const ret = wasm.sim_packages_found(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    packages_spawned() {
        const ret = wasm.sim_packages_spawned(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    ped_count() {
        const ret = wasm.sim_ped_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    pickup_count() {
        const ret = wasm.sim_pickup_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    player_armor() {
        const ret = wasm.sim_player_armor(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    player_dead() {
        const ret = wasm.sim_player_dead(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    player_health() {
        const ret = wasm.sim_player_health(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    player_money() {
        const ret = wasm.sim_player_money(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    player_x() {
        const ret = wasm.sim_player_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    player_y() {
        const ret = wasm.sim_player_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    player_z() {
        const ret = wasm.sim_player_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    poi_count() {
        const ret = wasm.sim_poi_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    police_heli_active() {
        const ret = wasm.sim_police_heli_active(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Remove a ped by id (fares boarding, scripted cleanup).
     * @param {number} id
     * @returns {boolean}
     */
    remove_ped(id) {
        const ret = wasm.sim_remove_ped(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Debug/test probe: resolve a circle against the collision world and
     * return [resolved_x, resolved_z].
     * @param {number} x
     * @param {number} z
     * @param {number} r
     * @returns {Float64Array}
     */
    resolve_probe(x, z, r) {
        const ret = wasm.sim_resolve_probe(this.__wbg_ptr, x, z, r);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Restore a snapshot; the player snaps to ground at the saved spot.
     * @param {Float64Array} data
     * @returns {boolean}
     */
    restore(data) {
        const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sim_restore(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Component edge-length totals, sorted descending (debug).
     * @returns {Float64Array}
     */
    road_components() {
        const ret = wasm.sim_road_components(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    road_connectivity() {
        const ret = wasm.sim_road_connectivity(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    road_edge_count() {
        const ret = wasm.sim_road_edge_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    road_node_count() {
        const ret = wasm.sim_road_node_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Shortest drivable route from the player to (x,z) as flat [x,z,...]
     * pairs; empty when no route exists in the loaded graph.
     * @param {number} x
     * @param {number} z
     * @returns {Float32Array}
     */
    route_to(x, z) {
        const ret = wasm.sim_route_to(this.__wbg_ptr, x, z);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * move_x/move_z: world-space movement direction (normalized or zero).
     * axis_forward/axis_strafe: raw -1..1 input axes (throttle/steer).
     * @param {number} buttons
     * @param {number} move_x
     * @param {number} move_z
     * @param {number} axis_forward
     * @param {number} axis_strafe
     * @param {number} aim_yaw
     * @param {number} aim_pitch
     */
    set_input(buttons, move_x, move_z, axis_forward, axis_strafe, aim_yaw, aim_pitch) {
        wasm.sim_set_input(this.__wbg_ptr, buttons, move_x, move_z, axis_forward, axis_strafe, aim_yaw, aim_pitch);
    }
    /**
     * @param {number} n
     */
    set_ped_target(n) {
        wasm.sim_set_ped_target(this.__wbg_ptr, n);
    }
    /**
     * @param {boolean} enabled
     */
    set_player_enabled(enabled) {
        wasm.sim_set_player_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Horizontal correction writeback (JS-side building collision until the
     * spatial hash ports to Rust in PR4 — see ROADMAP.md).
     * @param {number} x
     * @param {number} z
     */
    set_player_pos(x, z) {
        wasm.sim_set_player_pos(this.__wbg_ptr, x, z);
    }
    /**
     * @param {number} n
     */
    set_traffic_target(n) {
        wasm.sim_set_traffic_target(this.__wbg_ptr, n);
    }
    /**
     * Debug/test/scripting: force a weather state now.
     * @param {number} w
     */
    set_weather(w) {
        wasm.sim_set_weather(this.__wbg_ptr, w);
    }
    /**
     * Flat save snapshot (versioned): position, survival stats, arsenal,
     * heat. Small and manual — no serde in the crate.
     * @returns {Float64Array}
     */
    snapshot() {
        const ret = wasm.sim_snapshot(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Drop a boat on the water at (x,z); 0 if that spot is dry.
     * @param {number} x
     * @param {number} z
     * @returns {number}
     */
    spawn_boat(x, z) {
        const ret = wasm.sim_spawn_boat(this.__wbg_ptr, x, z);
        return ret >>> 0;
    }
    /**
     * Vigilante target: a marked roaming car near the player; 0 if no
     * suitable edge.
     * @returns {number}
     */
    spawn_marked_car() {
        const ret = wasm.sim_spawn_marked_car(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Spawn a pickup at ground level near (x,z). kind: 0 health, 1 armor,
     * 2 money.
     * @param {number} x
     * @param {number} z
     * @param {number} kind
     * @param {number} value
     * @returns {number}
     */
    spawn_pickup_at(x, z, kind, value) {
        const ret = wasm.sim_spawn_pickup_at(this.__wbg_ptr, x, z, kind, value);
        return ret >>> 0;
    }
    /**
     * Spawn a vehicle; returns its id. Used by the starter car, debug
     * tooling, and (later) traffic/missions.
     * @param {number} x
     * @param {number} z
     * @param {number} yaw
     * @param {number} kind
     * @returns {number}
     */
    spawn_vehicle(x, z, yaw, kind) {
        const ret = wasm.sim_spawn_vehicle(this.__wbg_ptr, x, z, yaw, kind);
        return ret >>> 0;
    }
    /**
     * Pay'n'spray: $100 repaints + repairs the ride and clears wanted.
     * 0 = done, 1 = on foot, 2 = too hot (3 stars and up), 3 = broke.
     * @returns {number}
     */
    spray_vehicle() {
        const ret = wasm.sim_spray_vehicle(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * [m walked, m driven, peds killed, cars jacked, shots fired].
     * @returns {Float64Array}
     */
    stats_counters() {
        const ret = wasm.sim_stats_counters(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Advance the sim. Runs fixed 60 Hz substeps from an accumulator; dt is
     * clamped (matches the renderer's clamp) and substeps are capped so a
     * long pause can't trigger a death spiral. Events accumulate across the
     * substeps of one call and are valid until the next call.
     * @param {number} dt
     */
    step(dt) {
        wasm.sim_step(this.__wbg_ptr, dt);
    }
    /**
     * @returns {number}
     */
    tick() {
        const ret = wasm.sim_tick(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    time() {
        const ret = wasm.sim_time(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    traffic_count() {
        const ret = wasm.sim_traffic_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Deduct if affordable (shop purchases); true on success.
     * @param {number} amount
     * @returns {boolean}
     */
    try_charge(amount) {
        const ret = wasm.sim_try_charge(this.__wbg_ptr, amount);
        return ret !== 0;
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    unload_heightfield(tx, ty) {
        wasm.sim_unload_heightfield(this.__wbg_ptr, tx, ty);
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    unload_pois(tx, ty) {
        wasm.sim_unload_pois(this.__wbg_ptr, tx, ty);
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    unload_tile_buildings(tx, ty) {
        wasm.sim_unload_tile_buildings(this.__wbg_ptr, tx, ty);
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    unload_tile_roads(tx, ty) {
        wasm.sim_unload_tile_roads(this.__wbg_ptr, tx, ty);
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    unload_water(tx, ty) {
        wasm.sim_unload_water(this.__wbg_ptr, tx, ty);
    }
    /**
     * @returns {string}
     */
    static version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sim_version();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    wanted_evading() {
        const ret = wasm.sim_wanted_evading(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Bitmask of owned weapon slots (wheel UI).
     * @returns {number}
     */
    wanted_level() {
        const ret = wasm.sim_wanted_level(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    water_count() {
        const ret = wasm.sim_water_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * [x, z] of the nearest swimmable point to the player, or empty.
     * @returns {Float64Array}
     */
    water_probe() {
        const ret = wasm.sim_water_probe(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    weapon_clip() {
        const ret = wasm.sim_weapon_clip(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    weapon_equipped() {
        const ret = wasm.sim_weapon_equipped(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    weapon_reloading() {
        const ret = wasm.sim_weapon_reloading(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    weapon_reserve() {
        const ret = wasm.sim_weapon_reserve(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    weapons_owned() {
        const ret = wasm.sim_weapons_owned(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    weather() {
        const ret = wasm.sim_weather(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Grip multiplier for the current sky (1 = dry).
     * @returns {number}
     */
    weather_grip() {
        const ret = wasm.sim_weather_grip(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Sim.prototype[Symbol.dispose] = Sim.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_bbadd78c1bac3a77: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./sim_bg.js": import0,
    };
}

const SimFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sim_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('sim_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
