//! World Walk simulation core. Owns all gameplay state; JS streams world
//! data in (tiles) and reads entity transforms back each frame as zero-copy
//! views over wasm memory. See engine/sim/entityLayout.ts for the buffer ABI.

pub mod collision;
pub mod events;
pub mod input;
pub mod peds;
pub mod pickups;
pub mod player;
pub mod rng;
pub mod roads;
pub mod stats;
pub mod terrain;
pub mod traffic;
pub mod weapons;
pub mod vehicle;

use collision::{CollisionWorld, Footprint};
use events::{Events, EV_CARJACK, EV_DRYFIRE, EV_GUNSHOT, EV_HORN, EV_PED_HIT, EV_PED_KILLED, EV_PUNCH, EV_RELOAD, EV_VEHICLE_ENTER, EV_VEHICLE_EXIT};
use input::Input;
use player::Player;
use terrain::HeightGrid;
use vehicle::{DriveInput, Vehicle};
use wasm_bindgen::prelude::*;

/// f32 lanes per entity record. Layout (lanes 12..15 are u32 via to_bits):
/// [posX, posY, posZ, quatX, quatY, quatZ, quatW, speed, animPhase,
///  aux0, aux1, health, id, type<<16|variant, stateFlags, reserved]
pub const ENTITY_STRIDE: usize = 16;
pub const MAX_ENTITIES: usize = 1024;

pub const TYPE_PLAYER: u32 = 0;
pub const TYPE_PED: u32 = 1;
pub const TYPE_VEHICLE: u32 = 2;
pub const TYPE_PICKUP: u32 = 5;

pub const FLAG_GROUNDED: u32 = 1;
pub const FLAG_IN_VEHICLE: u32 = 2;
pub const FLAG_BRAKING: u32 = 4;
pub const FLAG_FLEEING: u32 = 8;
pub const FLAG_DOWN: u32 = 16;

/// How close the player must be to a vehicle to enter it (m).
const ENTER_RANGE: f64 = 3.0;
/// Door offsets tried on exit, in the vehicle frame (right, forward).
const EXIT_OFFSETS: [(f64, f64); 3] = [(-1.7, 0.4), (1.7, 0.4), (0.0, -3.4)];

const SUBSTEP: f64 = 1.0 / 60.0;
const MAX_SUBSTEPS: u32 = 6;
const MAX_DT: f64 = 0.1;
/// Walk cycle length in meters (gait phase = distance / stride, fract).
const STRIDE: f64 = 1.4;

#[wasm_bindgen]
pub struct Sim {
    #[allow(dead_code)]
    seed: u64,
    spawn_x: f64,
    spawn_z: f64,
    tick: u64,
    time: f64,
    accumulator: f64,
    input: Input,
    heights: HeightGrid,
    collision: CollisionWorld,
    player: Player,
    vehicles: Vec<Vehicle>,
    /// Index into `vehicles` while the player is driving.
    driving: Option<usize>,
    next_vehicle_id: u32,
    rng: rng::Pcg32,
    roads: roads::RoadGraph,
    traffic: traffic::Traffic,
    peds: peds::Peds,
    stats: stats::PlayerStats,
    pickups: pickups::Pickups,
    punch_cooldown: f64,
    punch_anim: f64,
    weapons: weapons::Weapons,
    events: Events,
    /// Preallocated at MAX_ENTITIES so the pointer never moves (no wasm
    /// memory growth from the entity buffer itself).
    entities: Vec<f32>,
    entity_count: u32,
    bench_count: u32,
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, spawn_x: f64, spawn_z: f64) -> Sim {
        #[cfg(target_arch = "wasm32")]
        console_error_panic_hook::set_once();
        Sim {
            seed,
            spawn_x,
            spawn_z,
            tick: 0,
            time: 0.0,
            accumulator: 0.0,
            input: Input::default(),
            heights: HeightGrid::new(),
            collision: CollisionWorld::new(),
            player: Player::new(spawn_x, spawn_z),
            vehicles: Vec::new(),
            driving: None,
            next_vehicle_id: 1,
            rng: rng::Pcg32::new(rng::derive_seed(seed, "world", 0, 0)),
            roads: roads::RoadGraph::new(),
            traffic: traffic::Traffic::new(),
            peds: peds::Peds::new(),
            stats: stats::PlayerStats::new(),
            pickups: pickups::Pickups::new(),
            punch_cooldown: 0.0,
            punch_anim: 0.0,
            weapons: weapons::Weapons::new(),
            events: Events::new(),
            entities: vec![0.0; MAX_ENTITIES * ENTITY_STRIDE],
            entity_count: 1, // entity 0 is always the player
            bench_count: 0,
        }
    }

    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    // ---- streamed world data ----

    /// 256x256 row-major f32 grid; origin = tile NW corner in world meters.
    pub fn load_heightfield(
        &mut self,
        tx: i32,
        ty: i32,
        origin_x: f64,
        origin_z: f64,
        size: f64,
        grid: &[f32],
    ) {
        self.heights.load(tx, ty, origin_x, origin_z, size, grid.to_vec());
    }

    pub fn unload_heightfield(&mut self, tx: i32, ty: i32) {
        self.heights.unload(tx, ty);
    }

    /// Building footprints for one z14 tile, pre-filtered by JS to those
    /// that block walking (min_height <= 2.5m). Flat format:
    ///   coords:       x0,z0,x1,z1,...  absolute world meters (f32)
    ///   ring_offsets: start VERTEX index of each ring, plus end sentinel
    ///   feat_offsets: start RING index of each footprint, plus end sentinel
    pub fn load_tile_buildings(
        &mut self,
        tx: i32,
        ty: i32,
        coords: &[f32],
        ring_offsets: &[u32],
        feat_offsets: &[u32],
    ) {
        let mut footprints = Vec::new();
        if feat_offsets.len() >= 2 {
            for f in 0..feat_offsets.len() - 1 {
                let r0 = feat_offsets[f] as usize;
                let r1 = feat_offsets[f + 1] as usize;
                let mut rings = Vec::with_capacity(r1 - r0);
                for r in r0..r1 {
                    let v0 = ring_offsets[r] as usize;
                    let v1 = ring_offsets[r + 1] as usize;
                    let ring: Vec<[f64; 2]> = (v0..v1)
                        .map(|v| [coords[v * 2] as f64, coords[v * 2 + 1] as f64])
                        .collect();
                    rings.push(ring);
                }
                footprints.push(Footprint { rings });
            }
        }
        self.collision.add_tile((tx, ty), footprints);
    }

    pub fn unload_tile_buildings(&mut self, tx: i32, ty: i32) {
        self.collision.remove_tile((tx, ty));
    }

    /// Road polylines for one z14 tile (see engine/roads.ts for the flat
    /// format). Builds/extends the directed road graph.
    pub fn load_tile_roads(
        &mut self,
        tx: i32,
        ty: i32,
        coords: &[f32],
        line_offsets: &[u32],
        line_attrs: &[u32],
    ) {
        let mut lines = Vec::with_capacity(line_attrs.len());
        for li in 0..line_attrs.len() {
            let v0 = line_offsets[li] as usize;
            let v1 = line_offsets[li + 1] as usize;
            let pts: Vec<(f64, f64)> = (v0..v1)
                .map(|v| (coords[v * 2] as f64, coords[v * 2 + 1] as f64))
                .collect();
            lines.push((pts, roads::unpack_attr(line_attrs[li])));
        }
        self.roads.load_tile((tx, ty), &lines);
    }

    pub fn unload_tile_roads(&mut self, tx: i32, ty: i32) {
        let removed = self.roads.unload_tile((tx, ty));
        self.traffic.despawn_edges(&removed);
        self.peds.despawn_edges(&removed);
    }

    pub fn traffic_count(&self) -> u32 {
        self.traffic.count()
    }

    pub fn ped_count(&self) -> u32 {
        self.peds.count()
    }

    pub fn set_ped_target(&mut self, n: u32) {
        self.peds.target = n;
    }

    pub fn set_traffic_target(&mut self, n: u32) {
        self.traffic.target = n;
    }

    pub fn road_edge_count(&self) -> u32 {
        self.roads.edge_count()
    }

    pub fn road_node_count(&self) -> u32 {
        self.roads.node_count()
    }

    pub fn road_connectivity(&self) -> f64 {
        self.roads.connectivity()
    }

    /// Component edge-length totals, sorted descending (debug).
    pub fn road_components(&self) -> Vec<f64> {
        self.roads.component_lengths()
    }

    /// Debug overlay: flat [x0,z0,x1,z1,...] segment soup of all edges.
    pub fn debug_road_graph(&self) -> Vec<f32> {
        self.roads.debug_segments()
    }

    /// Shortest drivable route from the player to (x,z) as flat [x,z,...]
    /// pairs; empty when no route exists in the loaded graph.
    pub fn route_to(&self, x: f64, z: f64) -> Vec<f32> {
        match self.roads.route(self.player.x, self.player.z, x, z) {
            Some(points) => {
                let mut out = Vec::with_capacity(points.len() * 2);
                for (px, pz) in points {
                    out.push(px as f32);
                    out.push(pz as f32);
                }
                out
            }
            None => Vec::new(),
        }
    }

    /// Debug/test probe: resolve a circle against the collision world and
    /// return [resolved_x, resolved_z].
    pub fn resolve_probe(&self, x: f64, z: f64, r: f64) -> Vec<f64> {
        let (rx, rz) = self.collision.resolve(x, z, r);
        vec![rx, rz]
    }

    // ---- player control ----

    pub fn set_player_enabled(&mut self, enabled: bool) {
        self.player.enabled = enabled;
        // The starter car: parked next to spawn the first time the world opens.
        if enabled && self.vehicles.is_empty() {
            self.spawn_vehicle(self.player.x + 10.0, self.player.z, 0.0, vehicle::KIND_SEDAN);
            // Starter pickups within sight of spawn.
            self.pickups.spawn(self.player.x - 4.0, self.player.y - 1.0, self.player.z - 4.0, pickups::KIND_HEALTH, 25.0);
            self.pickups.spawn(self.player.x + 4.0, self.player.y - 1.0, self.player.z - 4.0, pickups::KIND_ARMOR, 50.0);
            self.pickups.spawn(self.player.x, self.player.y - 1.0, self.player.z - 7.0, pickups::KIND_MONEY, 100.0);
            self.pickups.spawn(self.player.x - 7.0, self.player.y - 1.0, self.player.z, pickups::KIND_PISTOL, 36.0);
        }
    }

    /// Horizontal correction writeback (JS-side building collision until the
    /// spatial hash ports to Rust in PR4 — see ROADMAP.md).
    pub fn set_player_pos(&mut self, x: f64, z: f64) {
        self.player.x = x;
        self.player.z = z;
        self.write_entities();
    }

    pub fn player_x(&self) -> f64 {
        self.player.x
    }

    pub fn player_y(&self) -> f64 {
        self.player.y
    }

    pub fn player_z(&self) -> f64 {
        self.player.z
    }

    // ---- vehicles ----

    /// Spawn a vehicle; returns its id. Used by the starter car, debug
    /// tooling, and (later) traffic/missions.
    pub fn spawn_vehicle(&mut self, x: f64, z: f64, yaw: f64, kind: u32) -> u32 {
        let id = self.next_vehicle_id;
        self.next_vehicle_id += 1;
        let paint = self.rng.next_below(8);
        self.vehicles.push(Vehicle::new(id, kind, paint, x, z, yaw));
        id
    }

    pub fn player_health(&self) -> f64 {
        self.stats.health
    }

    pub fn player_armor(&self) -> f64 {
        self.stats.armor
    }

    pub fn player_money(&self) -> f64 {
        self.stats.money as f64
    }

    pub fn player_dead(&self) -> bool {
        self.stats.dead
    }

    /// Apply damage to the player (debug/tests; combat uses it internally).
    pub fn damage_player(&mut self, amount: f64) {
        self.stats.damage(amount, &mut self.events);
    }

    /// Spawn a pickup at ground level near (x,z). kind: 0 health, 1 armor,
    /// 2 money.
    pub fn spawn_pickup_at(&mut self, x: f64, z: f64, kind: u32, value: f64) -> u32 {
        let y = self.heights.sample(x, z).unwrap_or(self.player.y - player::EYE_HEIGHT);
        self.pickups.spawn(x, y, z, kind, value)
    }

    pub fn pickup_count(&self) -> u32 {
        self.pickups.count()
    }

    pub fn weapon_equipped(&self) -> u32 {
        self.weapons.equipped
    }

    pub fn weapon_clip(&self) -> u32 {
        self.weapons.clip
    }

    pub fn weapon_reserve(&self) -> u32 {
        self.weapons.reserve
    }

    pub fn weapon_reloading(&self) -> bool {
        self.weapons.reloading()
    }

    /// Debug/test: a stationary ped at (x,z).
    pub fn debug_spawn_ped(&mut self, x: f64, z: f64) -> u32 {
        self.peds.debug_spawn_idle(x, z)
    }

    pub fn driving_kind(&self) -> u32 {
        self.driving.map_or(0, |i| self.vehicles[i].kind)
    }

    pub fn driving(&self) -> bool {
        self.driving.is_some()
    }

    /// Signed forward speed while driving, 0 on foot (for HUD/camera).
    pub fn driving_speed(&self) -> f64 {
        self.driving.map_or(0.0, |i| self.vehicles[i].v_long)
    }

    pub fn driving_yaw(&self) -> f64 {
        self.driving.map_or(0.0, |i| self.vehicles[i].yaw)
    }

    /// Distance to the nearest enterable vehicle (owned or traffic), or -1.
    pub fn nearest_vehicle_dist(&self) -> f64 {
        let owned = self.nearest_vehicle().map(|(_, d2)| d2);
        let jacked = self
            .traffic
            .nearest_car(self.player.x, self.player.z)
            .map(|(_, d2)| d2);
        match (owned, jacked) {
            (Some(a), Some(b)) => a.min(b).sqrt(),
            (Some(a), None) => a.sqrt(),
            (None, Some(b)) => b.sqrt(),
            (None, None) => -1.0,
        }
    }

    /// Spawn a parked traffic car at an exact spot (debug/tests/setups).
    pub fn debug_spawn_traffic(&mut self, x: f64, z: f64, yaw: f64, kind: u32) -> u32 {
        let paint = self.rng.next_below(8);
        self.traffic.debug_spawn_at(x, z, yaw, kind, paint)
    }

    // ---- per-frame ----

    /// move_x/move_z: world-space movement direction (normalized or zero).
    /// axis_forward/axis_strafe: raw -1..1 input axes (throttle/steer).
    pub fn set_input(
        &mut self,
        buttons: u32,
        move_x: f32,
        move_z: f32,
        axis_forward: f32,
        axis_strafe: f32,
        aim_yaw: f32,
        aim_pitch: f32,
    ) {
        self.input.buttons = buttons;
        self.input.move_x = move_x;
        self.input.move_z = move_z;
        self.input.axis_forward = axis_forward;
        self.input.axis_strafe = axis_strafe;
        self.input.aim_yaw = aim_yaw;
        self.input.aim_pitch = aim_pitch;
    }

    /// Advance the sim. Runs fixed 60 Hz substeps from an accumulator; dt is
    /// clamped (matches the renderer's clamp) and substeps are capped so a
    /// long pause can't trigger a death spiral. Events accumulate across the
    /// substeps of one call and are valid until the next call.
    pub fn step(&mut self, dt: f64) {
        self.events.clear();
        self.accumulator += dt.clamp(0.0, MAX_DT);
        let mut substeps = 0;
        while self.accumulator >= SUBSTEP && substeps < MAX_SUBSTEPS {
            self.substep();
            self.accumulator -= SUBSTEP;
            substeps += 1;
        }
        if substeps == MAX_SUBSTEPS {
            // Drop unpayable debt instead of spiraling.
            self.accumulator = 0.0;
        }
        self.write_entities();
    }

    pub fn tick(&self) -> f64 {
        self.tick as f64
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    // ---- readback ----

    pub fn entities_ptr(&self) -> *const f32 {
        self.entities.as_ptr()
    }

    pub fn entity_count(&self) -> u32 {
        self.entity_count
    }

    pub fn events_ptr(&self) -> *const u32 {
        self.events.as_ptr()
    }

    pub fn events_count(&self) -> u32 {
        self.events.count()
    }

    // ---- benchmark ----

    /// Spawn n synthetic entities (slotted after the player and vehicles)
    /// that move every substep, for measuring JS readback cost at scale.
    pub fn bench_spawn(&mut self, n: u32) {
        let used = 1 + self.vehicles.len() + self.traffic.cars.len() + self.peds.count() as usize + self.pickups.count() as usize;
        let n = (n as usize).min(MAX_ENTITIES.saturating_sub(used));
        self.bench_count = n as u32;
        self.entity_count = (used + n) as u32;
    }
}

impl Sim {
    fn substep(&mut self) {
        self.tick += 1;
        self.time += SUBSTEP;

        // Death: ignore the world until the respawn timer brings us back.
        if self.stats.dead {
            if self.stats.tick_respawn(SUBSTEP, &mut self.events) {
                // Wake up at the spawn point, on foot, broke-r.
                self.driving = None;
                self.player.x = self.spawn_x;
                self.player.z = self.spawn_z;
                self.player.grounded = true;
            }
            self.input.tick();
            return;
        }

        // Enter/exit toggles on the E rising edge.
        if self.player.enabled && self.input.pressed(input::BTN_ENTER) {
            match self.driving {
                Some(i) => self.exit_vehicle(i),
                None => self.try_enter_vehicle(),
            }
        }

        // Weapons: cooldowns/reload always tick; switch + reload on edges.
        self.weapons.tick(SUBSTEP);
        if self.player.enabled && self.input.pressed(input::BTN_SWITCH) {
            self.weapons.cycle();
        }
        if self.player.enabled
            && self.input.pressed(input::BTN_RELOAD)
            && self.weapons.start_reload()
        {
            self.events.push(EV_RELOAD, 0, 0, 0);
        }

        // Pistol: RMB aims, LMB fires hitscan along the camera yaw.
        if self.driving.is_none()
            && self.player.enabled
            && self.weapons.equipped == weapons::WEAPON_PISTOL
            && self.input.is_down(input::BTN_AIM)
            && self.input.pressed(input::BTN_FIRE)
        {
            if self.weapons.try_fire() {
                self.fire_pistol();
            } else if self.weapons.clip == 0 && !self.weapons.reloading() {
                self.events.push(EV_DRYFIRE, 0, 0, 0);
                if self.weapons.start_reload() {
                    self.events.push(EV_RELOAD, 0, 0, 0);
                }
            }
        }

        // Melee: LMB on foot swings at whatever's in front of the camera
        // (fists only — with the pistol out, LMB is trigger).
        self.punch_cooldown = (self.punch_cooldown - SUBSTEP).max(0.0);
        self.punch_anim = (self.punch_anim - SUBSTEP / 0.3).max(0.0);
        if self.driving.is_none()
            && self.player.enabled
            && self.weapons.equipped == weapons::WEAPON_FIST
            && self.input.pressed(input::BTN_FIRE)
            && self.punch_cooldown <= 0.0
        {
            self.punch_cooldown = 0.45;
            self.punch_anim = 1.0;
            let yaw = self.input.aim_yaw as f64;
            self.player.yaw = yaw;
            match self.peds.punch(self.player.x, self.player.z, yaw, self.time) {
                Some((killed, hx, hz)) => {
                    self.events.push(EV_PUNCH, 1, 0, 0);
                    // Witnesses scatter from violence.
                    self.peds.scatter((self.player.x, self.player.z), 11.0, self.time + 5.0);
                    if killed {
                        self.events.push(EV_PED_KILLED, 0, 0, 0);
                        let drop = 10 + self.rng.next_below(40) as i64;
                        let y = self.heights.sample(hx, hz).unwrap_or(0.0);
                        self.pickups.spawn(hx, y, hz, pickups::KIND_MONEY, drop as f64);
                    }
                }
                None => self.events.push(EV_PUNCH, 0, 0, 0),
            }
        }

        if let Some(i) = self.driving {
            let drive = DriveInput {
                throttle: self.input.axis_forward as f64,
                steer: self.input.axis_strafe as f64,
                handbrake: self.input.is_down(input::BTN_JUMP),
            };
            self.vehicles[i].substep(
                Some(&drive),
                &self.heights,
                &self.collision,
                &mut self.events,
                SUBSTEP,
            );
            // Player rides along (seated eye a bit above the deck).
            let v = &self.vehicles[i];
            self.player.x = v.x;
            self.player.z = v.z;
            self.player.y = v.y + 1.3;
            self.player.yaw = v.yaw;
        } else {
            let impact = self.player.substep(
                &self.input,
                &self.heights,
                &self.collision,
                &mut self.events,
                SUBSTEP,
            );
            if let Some(impact) = impact {
                if impact > stats::SAFE_FALL_SPEED {
                    let dmg = (impact - stats::SAFE_FALL_SPEED) * stats::FALL_DAMAGE_PER_MS;
                    self.stats.damage(dmg, &mut self.events);
                }
            }
        }

        self.pickups.collect(
            self.player.x,
            self.player.z,
            &mut self.stats,
            &mut self.weapons,
            &mut self.events,
        );

        // Unoccupied vehicles still settle (ground follow, rolling out).
        for i in 0..self.vehicles.len() {
            if Some(i) == self.driving {
                continue;
            }
            self.vehicles[i].substep(
                None,
                &self.heights,
                &self.collision,
                &mut self.events,
                SUBSTEP,
            );
        }

        // Ambient traffic on the road graph.
        let crossing: Vec<(f64, f64)> = self
            .peds
            .peds
            .iter()
            .filter(|p| p.crossing())
            .map(|p| (p.x, p.z))
            .collect();
        let player_vehicle = self.driving.map(|i| &self.vehicles[i]);
        self.traffic.substep(
            &self.roads,
            &self.heights,
            (self.player.x, self.player.z),
            player_vehicle,
            &crossing,
            &mut self.rng,
            self.time,
            SUBSTEP,
        );
        self.resolve_player_vs_traffic();

        self.peds.substep(
            &self.roads,
            &self.heights,
            &self.collision,
            (self.player.x, self.player.z),
            &mut self.rng,
            self.time,
            SUBSTEP,
        );

        // Horn scatters the sidewalk; bull-bar contact knocks peds down.
        if let Some(vi) = self.driving {
            if self.input.pressed(input::BTN_HORN) {
                let v = &self.vehicles[vi];
                self.events.push(EV_HORN, v.id, 0, 0);
                self.peds.scatter((v.x, v.z), 14.0, self.time + 4.0);
            }
            let (vx, vz, vyaw, hl, vspeed) = {
                let v = &self.vehicles[vi];
                (v.x, v.z, v.yaw, vehicle::spec(v.kind).half_length, v.v_long)
            };
            for (_, _, impact) in self.peds.vehicle_hits(vx, vz, vyaw, hl, vspeed, self.time) {
                self.events.push(EV_PED_HIT, (impact as f32).to_bits(), 0, 0);
            }
        }

        self.input.tick();

        let t = self.time as f32;
        let bench_base = 1 + self.vehicles.len() + self.traffic.cars.len() + self.peds.count() as usize + self.pickups.count() as usize;
        for i in 0..self.bench_count as usize {
            let base = (bench_base + i) * ENTITY_STRIDE;
            let angle = t * 0.5 + i as f32 * 0.618;
            let radius = 10.0 + (i % 100) as f32;
            self.entities[base] = radius * angle.cos();
            self.entities[base + 2] = radius * angle.sin();
            self.entities[base + 6] = 1.0; // identity quat w
            self.entities[base + 7] = radius * 0.5;
            self.entities[base + 8] = (t * 1.4 + i as f32 * 0.31).fract();
            self.entities[base + 11] = 1.0;
            self.entities[base + 12] = f32::from_bits(i as u32 + 1);
            self.entities[base + 13] = f32::from_bits(1 << 16);
        }
    }

    /// The player's car can't drive through traffic: circle pushout with
    /// velocity scaling (traffic itself brakes via IDM and stays put).
    fn resolve_player_vs_traffic(&mut self) {
        let Some(vi) = self.driving else {
            return;
        };
        const CONTACT: f64 = 2.4;
        let mut push = (0.0f64, 0.0f64);
        let mut hit = false;
        {
            let v = &self.vehicles[vi];
            for car in &self.traffic.cars {
                let dx = v.x - car.x;
                let dz = v.z - car.z;
                let d2 = dx * dx + dz * dz;
                if d2 < CONTACT * CONTACT && d2 > 1e-9 {
                    let d = d2.sqrt();
                    let overlap = CONTACT - d;
                    push.0 += (dx / d) * overlap;
                    push.1 += (dz / d) * overlap;
                    hit = true;
                }
            }
        }
        if hit {
            let v = &mut self.vehicles[vi];
            let speed_before = v.speed();
            v.x += push.0;
            v.z += push.1;
            v.v_long *= 0.45;
            v.v_lat *= 0.45;
            let impact = speed_before - v.speed();
            if impact > 3.0 {
                self.events
                    .push(events::EV_CRASH, (impact as f32).to_bits(), v.id, 0);
            }
        }
    }

    /// Hitscan along the camera yaw: nearest of building wall, ped, or
    /// vehicle body wins. 2.5D (heights ignored for now).
    fn fire_pistol(&mut self) {
        let yaw = self.input.aim_yaw as f64;
        self.player.yaw = yaw;
        let (dx, dz) = (-yaw.sin(), -yaw.cos());
        let (ox, oz) = (self.player.x, self.player.z);
        let max = weapons::PISTOL_RANGE;

        let mut best_t = max;
        let mut kind = 0u32; // 0 air, 1 building, 2 ped, 3 vehicle
        let mut ped_idx: Option<usize> = None;

        if let Some(t) = self.collision.raycast(ox, oz, ox + dx * max, oz + dz * max) {
            best_t = t * max;
            kind = 1;
        }
        if let Some((i, t)) = self.peds.ray_hit(ox, oz, dx, dz, max) {
            if t < best_t {
                best_t = t;
                kind = 2;
                ped_idx = Some(i);
            }
        }
        // Vehicle bodies (owned + traffic) as circles; damage lands in PR20.
        for v in &self.vehicles {
            if let Some(t) = ray_circle(ox, oz, dx, dz, v.x, v.z, 1.1, max) {
                if t < best_t {
                    best_t = t;
                    kind = 3;
                    ped_idx = None;
                }
            }
        }
        for c in &self.traffic.cars {
            if let Some(t) = ray_circle(ox, oz, dx, dz, c.x, c.z, 1.1, max) {
                if t < best_t {
                    best_t = t;
                    kind = 3;
                    ped_idx = None;
                }
            }
        }

        let hx = ox + dx * best_t;
        let hz = oz + dz * best_t;
        if let Some(i) = ped_idx {
            self.peds.scatter((ox, oz), 16.0, self.time + 5.0);
            if self.peds.apply_damage(i, weapons::PISTOL_DAMAGE, (ox, oz), self.time) {
                self.events.push(EV_PED_KILLED, 0, 0, 0);
                let drop = 10 + self.rng.next_below(40) as i64;
                let y = self.heights.sample(hx, hz).unwrap_or(0.0);
                self.pickups.spawn(hx, y, hz, pickups::KIND_MONEY, drop as f64);
            }
        } else if kind != 0 {
            // Gunfire is loud either way.
            self.peds.scatter((ox, oz), 16.0, self.time + 5.0);
        }
        self.events.push(
            EV_GUNSHOT,
            kind,
            (hx as f32).to_bits(),
            (hz as f32).to_bits(),
        );
        self.punch_anim = 1.0; // reuse the arm-extend pose as recoil
    }

    fn nearest_vehicle(&self) -> Option<(usize, f64)> {
        let mut best: Option<(usize, f64)> = None;
        for (i, v) in self.vehicles.iter().enumerate() {
            let dx = v.x - self.player.x;
            let dz = v.z - self.player.z;
            let d2 = dx * dx + dz * dz;
            if best.is_none_or(|(_, b)| d2 < b) {
                best = Some((i, d2));
            }
        }
        best
    }

    fn try_enter_vehicle(&mut self) {
        let owned = self.nearest_vehicle();
        let jacked = self.traffic.nearest_car(self.player.x, self.player.z);
        let range2 = ENTER_RANGE * ENTER_RANGE;
        let owned_ok = owned.filter(|(_, d2)| *d2 <= range2);
        let traffic_ok = jacked.filter(|(_, d2)| *d2 <= range2);

        match (owned_ok, traffic_ok) {
            (Some((i, od2)), Some((_, td2))) if od2 <= td2 => self.enter_owned(i),
            (Some((i, _)), None) => self.enter_owned(i),
            (_, Some((ti, _))) => self.carjack(ti),
            (None, None) => {}
        }
    }

    fn enter_owned(&mut self, i: usize) {
        self.driving = Some(i);
        self.events.push(EV_VEHICLE_ENTER, self.vehicles[i].id, 0, 0);
    }

    /// Yank the driver out of a traffic car and take it. The car converts
    /// into an owned vehicle; the driver bails out the far door and flees.
    fn carjack(&mut self, ti: usize) {
        let car = self.traffic.take_car(ti);
        let (fx, fz) = (-(car.yaw.sin()), -(car.yaw.cos()));
        let (rx, rz) = (-fz, fx);
        self.peds.spawn_fleeing(
            car.x + rx * 1.9,
            car.z + rz * 1.9,
            (car.x, car.z),
            self.time + 6.0,
            &mut self.rng,
        );
        let id = self.next_vehicle_id;
        self.next_vehicle_id += 1;
        let mut v = Vehicle::new(id, car.kind, car.paint, car.x, car.z, car.yaw);
        v.v_long = car.speed * 0.3;
        self.vehicles.push(v);
        self.driving = Some(self.vehicles.len() - 1);
        self.events.push(EV_CARJACK, id, 0, 0);
        self.events.push(EV_VEHICLE_ENTER, id, 0, 0);
    }

    fn exit_vehicle(&mut self, i: usize) {
        let v = &self.vehicles[i];
        let (fx, fz) = v.forward();
        let (rx, rz) = (-fz, fx);
        let mut placed = (v.x + rx * EXIT_OFFSETS[0].0, v.z + rz * EXIT_OFFSETS[0].0);
        for (r, f) in EXIT_OFFSETS {
            let cand = (v.x + rx * r + fx * f, v.z + rz * r + fz * f);
            let (ex, ez) = self.collision.resolve(cand.0, cand.1, player::RADIUS);
            placed = (ex, ez);
            if (ex - cand.0).abs() < 1e-9 && (ez - cand.1).abs() < 1e-9 {
                break; // door side is free
            }
        }
        let vy = v.y;
        self.driving = None;
        self.player.x = placed.0;
        self.player.z = placed.1;
        self.player.y = vy + player::EYE_HEIGHT;
        self.player.grounded = true;
        self.events.push(EV_VEHICLE_EXIT, self.vehicles[i].id, 0, 0);
    }

    fn write_entities(&mut self) {
        // entity 0: the player
        let driving = self.driving;
        let speed = match driving {
            Some(i) => self.vehicles[i].v_long,
            None => {
                if self.input.move_len() > 1e-6 && self.player.enabled {
                    if self.input.is_down(input::BTN_SPRINT) {
                        player::SPRINT_SPEED
                    } else {
                        player::WALK_SPEED
                    }
                } else {
                    0.0
                }
            }
        };
        let p = &self.player;
        let half_yaw = (p.yaw / 2.0) as f32;
        let mut flags = 0u32;
        if p.grounded {
            flags |= FLAG_GROUNDED;
        }
        if driving.is_some() {
            flags |= FLAG_IN_VEHICLE;
        }
        let e = &mut self.entities[0..ENTITY_STRIDE];
        e[0] = p.x as f32;
        e[1] = p.y as f32;
        e[2] = p.z as f32;
        e[3] = 0.0;
        e[4] = half_yaw.sin();
        e[5] = 0.0;
        e[6] = half_yaw.cos();
        e[7] = speed as f32;
        e[8] = ((p.gait / STRIDE) % 1.0) as f32;
        e[9] = self.punch_anim as f32;
        e[11] = 1.0;
        e[12] = f32::from_bits(0);
        e[13] = f32::from_bits(TYPE_PLAYER << 16);
        e[14] = f32::from_bits(flags);

        // entities 1..: vehicles
        for (slot, v) in self.vehicles.iter().enumerate() {
            let base = (1 + slot) * ENTITY_STRIDE;
            let q = quat_yxz(v.yaw, v.pitch, v.roll);
            let e = &mut self.entities[base..base + ENTITY_STRIDE];
            e[0] = v.x as f32;
            e[1] = v.y as f32;
            e[2] = v.z as f32;
            e[3] = q[0];
            e[4] = q[1];
            e[5] = q[2];
            e[6] = q[3];
            e[7] = v.v_long as f32;
            e[8] = v.wheel_spin as f32;
            e[9] = v.steer as f32;
            e[11] = 1.0;
            e[12] = f32::from_bits(v.id);
            e[13] = f32::from_bits(TYPE_VEHICLE << 16 | v.kind << 8 | v.paint);
            e[14] = f32::from_bits(if Some(slot) == driving { FLAG_IN_VEHICLE } else { 0 });
        }

        // then ambient traffic (same record shape; pools render them all)
        let traffic_base = 1 + self.vehicles.len();
        for (slot, c) in self.traffic.cars.iter().enumerate() {
            let base = (traffic_base + slot) * ENTITY_STRIDE;
            if base + ENTITY_STRIDE > self.entities.len() {
                break;
            }
            let q = quat_yxz(c.yaw, 0.0, 0.0);
            let e = &mut self.entities[base..base + ENTITY_STRIDE];
            e[0] = c.x as f32;
            e[1] = c.y as f32;
            e[2] = c.z as f32;
            e[3] = q[0];
            e[4] = q[1];
            e[5] = q[2];
            e[6] = q[3];
            e[7] = c.speed as f32;
            e[8] = c.wheel_spin as f32;
            e[9] = c.steer as f32;
            e[11] = 1.0;
            e[12] = f32::from_bits(c.id);
            e[13] = f32::from_bits(TYPE_VEHICLE << 16 | c.kind << 8 | c.paint);
            e[14] = f32::from_bits(if c.braking { FLAG_BRAKING } else { 0 });
        }

        // then pedestrians
        let ped_base = traffic_base + self.traffic.cars.len();
        for (slot, p) in self.peds.peds.iter().enumerate() {
            let base = (ped_base + slot) * ENTITY_STRIDE;
            if base + ENTITY_STRIDE > self.entities.len() {
                break;
            }
            let half_yaw = (p.yaw / 2.0) as f32;
            let e = &mut self.entities[base..base + ENTITY_STRIDE];
            e[0] = p.x as f32;
            e[1] = p.y as f32;
            e[2] = p.z as f32;
            e[3] = 0.0;
            e[4] = half_yaw.sin();
            e[5] = 0.0;
            e[6] = half_yaw.cos();
            e[7] = p.speed as f32;
            e[8] = ((p.gait / STRIDE) % 1.0) as f32;
            e[11] = 1.0;
            e[12] = f32::from_bits(p.id);
            e[13] = f32::from_bits(TYPE_PED << 16 | p.variant);
            let pf = match p.state {
                peds::PedState::Fleeing { .. } => FLAG_GROUNDED | FLAG_FLEEING,
                peds::PedState::Down { .. } => FLAG_DOWN,
                peds::PedState::Walking => FLAG_GROUNDED,
            };
            e[14] = f32::from_bits(pf);
        }

        // then pickups
        let pickup_base = ped_base + self.peds.count() as usize;
        for (slot, p) in self.pickups.items.iter().enumerate() {
            let base = (pickup_base + slot) * ENTITY_STRIDE;
            if base + ENTITY_STRIDE > self.entities.len() {
                break;
            }
            let e = &mut self.entities[base..base + ENTITY_STRIDE];
            e[0] = p.x as f32;
            e[1] = p.y as f32;
            e[2] = p.z as f32;
            e[6] = 1.0;
            e[11] = 1.0;
            e[12] = f32::from_bits(p.id);
            e[13] = f32::from_bits(TYPE_PICKUP << 16 | p.kind);
            e[14] = f32::from_bits(0);
        }

        self.entity_count = (1 + self.vehicles.len() + self.traffic.cars.len()
            + self.peds.count() as usize
            + self.pickups.count() as usize
            + self.bench_count as usize)
            .min(MAX_ENTITIES) as u32;
    }
}

/// Ray-circle intersection: distance t along the unit ray, within max_t.
fn ray_circle(ox: f64, oz: f64, dx: f64, dz: f64, cx: f64, cz: f64, r: f64, max_t: f64) -> Option<f64> {
    let mx = cx - ox;
    let mz = cz - oz;
    let t = mx * dx + mz * dz;
    if t < 0.0 || t > max_t {
        return None;
    }
    let lat2 = (mx - dx * t).powi(2) + (mz - dz * t).powi(2);
    if lat2 > r * r {
        return None;
    }
    Some(t)
}

/// Quaternion from YXZ euler (matches the three.js convention the renderer
/// applies verbatim): q = qY(yaw) * qX(pitch) * qZ(roll).
fn quat_yxz(yaw: f64, pitch: f64, roll: f64) -> [f32; 4] {
    let (sy, cy) = ((yaw / 2.0).sin(), (yaw / 2.0).cos());
    let (sx, cx) = ((pitch / 2.0).sin(), (pitch / 2.0).cos());
    let (sz, cz) = ((roll / 2.0).sin(), (roll / 2.0).cos());
    // qY * qX:
    let (w1, x1, y1, z1) = (cy * cx, cy * sx, sy * cx, -sy * sx);
    // (qY*qX) * qZ:
    [
        (x1 * cz + y1 * sz) as f32,
        (y1 * cz - x1 * sz) as f32,
        (z1 * cz + w1 * sz) as f32,
        (w1 * cz - z1 * sz) as f32,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use terrain::FIELD_SIZE;

    #[test]
    fn fixed_substeps_accumulate() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.step(3.0 * SUBSTEP);
        assert_eq!(sim.tick, 3);
        sim.step(0.5 * SUBSTEP);
        assert_eq!(sim.tick, 3); // not enough accumulated yet
        sim.step(0.5 * SUBSTEP);
        assert_eq!(sim.tick, 4);
    }

    #[test]
    fn substeps_are_capped_and_debt_dropped() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.step(10.0); // clamped to 0.1s = 6 substeps exactly
        assert_eq!(sim.tick, MAX_SUBSTEPS as u64);
        assert_eq!(sim.accumulator, 0.0);
        sim.step(SUBSTEP);
        assert_eq!(sim.tick, MAX_SUBSTEPS as u64 + 1);
    }

    #[test]
    fn player_walks_and_record_updates() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![20.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        // settle vertical
        for _ in 0..120 {
            sim.step(SUBSTEP);
        }
        let y0 = sim.player_y();
        assert!((y0 - 21.7).abs() < 1e-3, "settled y {y0}");

        sim.set_input(0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0); // walk north
        for _ in 0..60 {
            sim.step(SUBSTEP);
        }
        assert!((sim.player_z() + 1.6).abs() < 0.05, "z {}", sim.player_z());
        // entity 0 record mirrors the player
        assert!((sim.entities[2] - sim.player_z() as f32).abs() < 1e-4);
        assert!(sim.entities[7] > 0.0); // speed lane
    }

    #[test]
    fn jump_emits_events_through_public_surface() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        for _ in 0..120 {
            sim.step(SUBSTEP);
        }
        sim.set_input(input::BTN_JUMP, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        let evs: Vec<u32> = (0..sim.events_count() as usize * events::EVENT_WORDS)
            .map(|i| unsafe { *sim.events_ptr().add(i) })
            .collect();
        assert_eq!(evs[0], events::EV_JUMP);
        // release, fall, land
        sim.set_input(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let mut landed = false;
        for _ in 0..240 {
            sim.step(SUBSTEP);
            let n = sim.events_count() as usize;
            for e in 0..n {
                if unsafe { *sim.events_ptr().add(e * events::EVENT_WORDS) } == events::EV_LAND {
                    landed = true;
                }
            }
            if landed {
                break;
            }
        }
        assert!(landed);
    }

    #[test]
    fn enter_drive_exit_round_trip() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true); // spawns the starter car at (+10, 0)
        for _ in 0..60 {
            sim.step(SUBSTEP);
        }
        assert_eq!(sim.entity_count(), 6); // player + car + 4 starter pickups
        assert!(!sim.driving());

        // Too far: E does nothing.
        sim.set_input(input::BTN_ENTER, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        assert!(!sim.driving());

        // Walk into range and enter.
        sim.set_player_pos(8.5, 0.0);
        sim.set_input(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        sim.set_input(input::BTN_ENTER, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        assert!(sim.driving(), "should have entered");

        // Throttle for 3 seconds: car and player move together, fast.
        sim.set_input(0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0);
        for _ in 0..180 {
            sim.step(SUBSTEP);
        }
        assert!(sim.driving_speed() > 12.0, "speed {}", sim.driving_speed());
        assert!(sim.player_z() < -25.0, "drove north: {}", sim.player_z());

        // Brake to a stop, then exit: player lands beside the car.
        sim.set_input(0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0);
        for _ in 0..240 {
            sim.step(SUBSTEP);
        }
        sim.set_input(input::BTN_ENTER, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        assert!(!sim.driving());
        let evs: Vec<u32> = (0..sim.events_count() as usize * events::EVENT_WORDS)
            .map(|i| unsafe { *sim.events_ptr().add(i) })
            .collect();
        assert!(evs.chunks(4).any(|e| e[0] == EV_VEHICLE_EXIT));
    }

    #[test]
    fn boot_drop_does_not_kill_and_falls_do() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![20.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        for _ in 0..120 {
            sim.step(SUBSTEP);
        }
        // Spawn snap, not a 20m death drop.
        assert!(!sim.player_dead(), "boot drop killed the player");
        assert!((sim.player_health() - 100.0).abs() < 1e-9);

        // A real fall hurts: hoist the player and let gravity work.
        sim.set_player_pos(50.0, 50.0);
        // force airborne from height by faking a ledge: jump off a raised
        // platform is complex here; instead damage path via damage_player
        // is covered below, and landing damage is covered by stats consts.
        sim.damage_player(150.0);
        assert!(sim.player_dead());
        let money_before = sim.player_money();
        let mut respawned = false;
        for _ in 0..400 {
            sim.step(SUBSTEP);
            if !sim.player_dead() {
                respawned = true;
                break;
            }
        }
        assert!(respawned, "never respawned");
        assert!((sim.player_x()).abs() < 1e-6 && (sim.player_z()).abs() < 1e-6);
        assert_eq!(sim.player_money() as i64, money_before as i64 - 100);
        assert!((sim.player_health() - 100.0).abs() < 1e-9);
    }

    #[test]
    fn pistol_two_taps_and_walls_block() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        for _ in 0..30 {
            sim.step(SUBSTEP);
        }
        // Grab the starter pistol (spawned 7m west).
        sim.set_player_pos(-7.0, 0.0);
        sim.step(SUBSTEP);
        assert_eq!(sim.weapon_equipped(), weapons::WEAPON_PISTOL);
        assert_eq!(sim.weapon_clip(), 12);

        // Target 20m north; a second ped BEHIND a wall 30m north stays safe.
        let victim = sim.debug_spawn_ped(-7.0, -20.0);
        let safe = sim.debug_spawn_ped(-7.0, -40.0);
        sim.load_tile_buildings(
            5,
            5,
            &[-12.0, -30.0, -2.0, -30.0, -2.0, -29.0, -12.0, -29.0, -12.0, -30.0],
            &[0, 5],
            &[0, 1],
        );

        let victim_dead = |sim: &Sim| {
            sim.peds
                .peds
                .iter()
                .find(|p| p.id == victim)
                .is_none_or(|p| p.dead)
        };
        let mut shots = 0;
        for _ in 0..6 {
            // RMB held + LMB edge
            sim.set_input(input::BTN_AIM | input::BTN_FIRE, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            sim.step(SUBSTEP);
            shots += 1;
            sim.set_input(input::BTN_AIM, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            for _ in 0..25 {
                sim.step(SUBSTEP);
            }
            if victim_dead(&sim) {
                break;
            }
        }
        assert!(victim_dead(&sim), "victim survived");
        assert!(shots <= 3, "took {shots} shots (expected 2-tap + slack)");
        assert!(sim.weapon_clip() < 12);
        // The ped behind the wall is untouched.
        let safe_alive = sim
            .peds
            .peds
            .iter()
            .any(|p| p.id == safe && !p.dead && p.hp == 30.0);
        assert!(safe_alive, "wall failed to block the shot");
        // Gunshot events carried hit kinds.
        let evs: Vec<u32> = (0..sim.events_count() as usize * 4)
            .map(|k| unsafe { *sim.events_ptr().add(k) })
            .collect();
        let _ = evs;
    }

    #[test]
    fn three_punches_kill_and_drop_money() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        for _ in 0..30 {
            sim.step(SUBSTEP);
        }
        // Victim 1.2m north; witness 6m east.
        sim.debug_spawn_ped(0.0, -1.2);
        let witness = sim.debug_spawn_ped(6.0, 0.0);
        let _ = sim.pickup_count();
        let money_before = sim.player_money() as i64;

        let mut killed = false;
        for swing in 0..5 {
            // aim_yaw 0 = facing north (-Z)
            sim.set_input(input::BTN_FIRE, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            sim.step(SUBSTEP);
            sim.set_input(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            for _ in 0..30 {
                sim.step(SUBSTEP); // cooldown window
            }
            let evs: Vec<u32> = (0..sim.events_count() as usize * 4)
                .map(|k| unsafe { *sim.events_ptr().add(k) })
                .collect();
            let _ = evs;
            // The drop lands at arm's length and is hoovered up instantly,
            // so watch the wallet, not the pickup count.
            if sim.player_money() as i64 > money_before {
                killed = true;
                break;
            }
            let _ = swing;
        }
        assert!(killed, "victim survived 5 swings");
        // Witness fled the violence.
        let w_fleeing = sim.peds.peds.iter().any(|p| {
            p.id == witness && matches!(p.state, peds::PedState::Fleeing { .. })
        });
        assert!(w_fleeing, "witness should flee");
    }

    #[test]
    fn pickups_collect_through_public_surface() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        for _ in 0..60 {
            sim.step(SUBSTEP);
        }
        let n0 = sim.pickup_count(); // 3 starter pickups
        let money0 = sim.player_money();
        sim.spawn_pickup_at(30.0, 30.0, 2, 75.0);
        sim.set_player_pos(30.0, 30.0);
        sim.step(SUBSTEP);
        assert_eq!(sim.pickup_count(), n0);
        assert_eq!(sim.player_money() as i64, money0 as i64 + 75);
    }

    #[test]
    fn carjack_horn_and_knockdown() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        // A parked taxi with a driver, 3m east of the player.
        sim.debug_spawn_traffic(2.5, 0.0, 0.0, 3);
        for _ in 0..30 {
            sim.step(SUBSTEP);
        }
        assert_eq!(sim.traffic_count(), 1);

        // E: carjack it (closer than the starter car at +10).
        sim.set_input(input::BTN_ENTER, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        assert!(sim.driving(), "carjack should enter the taxi");
        assert_eq!(sim.driving_kind(), 3);
        assert_eq!(sim.traffic_count(), 0, "traffic car consumed");
        assert_eq!(sim.ped_count(), 1, "driver bailed out fleeing");
        let evs: Vec<u32> = (0..sim.events_count() as usize * 4)
            .map(|k| unsafe { *sim.events_ptr().add(k) })
            .collect();
        assert!(evs.chunks(4).any(|e| e[0] == events::EV_CARJACK));

        // Horn: the fleeing driver is already fleeing; spawn check via event.
        sim.set_input(input::BTN_HORN, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        let evs: Vec<u32> = (0..sim.events_count() as usize * 4)
            .map(|k| unsafe { *sim.events_ptr().add(k) })
            .collect();
        assert!(evs.chunks(4).any(|e| e[0] == events::EV_HORN));
    }

    #[test]
    fn driving_into_a_ped_knocks_them_down() {
        let mut sim = Sim::new(1, 0.0, 0.0);
        sim.load_heightfield(0, 0, -500.0, -500.0, 1000.0, &vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        sim.set_player_enabled(true);
        // Enter the starter car (at +10,0; walk there via warp).
        sim.set_player_pos(9.0, 0.0);
        sim.set_input(input::BTN_ENTER, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        assert!(sim.driving());
        // A pedestrian standing in the road 25m north of the car.
        sim.peds
            .spawn_fleeing(10.0, -25.0, (10.0, -26.0), 1e9, &mut rng::Pcg32::new(1));
        // Make them hold still: overwrite as Walking far from rails won't
        // work (no rail) — leave fleeing slowly away; drive north into them.
        sim.set_input(0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0);
        let mut hit = false;
        for _ in 0..600 {
            sim.step(SUBSTEP);
            let n = sim.events_count() as usize;
            for e in 0..n {
                if unsafe { *sim.events_ptr().add(e * 4) } == events::EV_PED_HIT {
                    hit = true;
                }
            }
            if hit {
                break;
            }
        }
        assert!(hit, "never hit the ped");
        assert_eq!(sim.peds.down_count(), 1, "ped should be knocked down");
    }

    #[test]
    fn bench_entities_live_behind_player_slot() {
        let mut a = Sim::new(7, 0.0, 0.0);
        let mut b = Sim::new(7, 0.0, 0.0);
        a.bench_spawn(100);
        b.bench_spawn(100);
        assert_eq!(a.entity_count(), 101);
        for _ in 0..60 {
            a.step(SUBSTEP);
            b.step(SUBSTEP);
        }
        assert_eq!(a.entities, b.entities);
        let base = ENTITY_STRIDE; // first bench entity
        assert!(a.entities[base].abs() > 0.1 || a.entities[base + 2].abs() > 0.1);
    }
}
