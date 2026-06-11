//! World Walk simulation core. Owns all gameplay state; JS streams world
//! data in (tiles) and reads entity transforms back each frame as zero-copy
//! views over wasm memory. See engine/sim/entityLayout.ts for the buffer ABI.

pub mod collision;
pub mod events;
pub mod input;
pub mod player;
pub mod rng;
pub mod terrain;
pub mod vehicle;

use collision::{CollisionWorld, Footprint};
use events::{Events, EV_VEHICLE_ENTER, EV_VEHICLE_EXIT};
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
pub const TYPE_VEHICLE: u32 = 2;

pub const FLAG_GROUNDED: u32 = 1;
pub const FLAG_IN_VEHICLE: u32 = 2;

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

    /// Distance to the nearest enterable vehicle, or -1 (for the HUD toast).
    pub fn nearest_vehicle_dist(&self) -> f64 {
        self.nearest_vehicle()
            .map_or(-1.0, |(_, d2)| d2.sqrt())
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
        let n = (n as usize).min(MAX_ENTITIES - 1 - self.vehicles.len());
        self.bench_count = n as u32;
        self.entity_count = (1 + self.vehicles.len() + n) as u32;
    }
}

impl Sim {
    fn substep(&mut self) {
        self.tick += 1;
        self.time += SUBSTEP;

        // Enter/exit toggles on the E rising edge.
        if self.player.enabled && self.input.pressed(input::BTN_ENTER) {
            match self.driving {
                Some(i) => self.exit_vehicle(i),
                None => self.try_enter_vehicle(),
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
            self.player.substep(
                &self.input,
                &self.heights,
                &self.collision,
                &mut self.events,
                SUBSTEP,
            );
        }

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

        self.input.tick();

        let t = self.time as f32;
        let bench_base = 1 + self.vehicles.len();
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
        let Some((i, d2)) = self.nearest_vehicle() else {
            return;
        };
        if d2.sqrt() > ENTER_RANGE {
            return;
        }
        self.driving = Some(i);
        self.events.push(EV_VEHICLE_ENTER, self.vehicles[i].id, 0, 0);
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

        self.entity_count = (1 + self.vehicles.len() + self.bench_count as usize) as u32;
    }
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
        assert_eq!(sim.entity_count(), 2); // player + car
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
