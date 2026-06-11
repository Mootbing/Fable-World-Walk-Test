//! World Walk simulation core. Owns all gameplay state; JS streams world
//! data in (tiles) and reads entity transforms back each frame as zero-copy
//! views over wasm memory. See engine/sim/entityLayout.ts for the buffer ABI.

pub mod events;
pub mod input;
pub mod player;
pub mod rng;
pub mod terrain;

use events::Events;
use input::Input;
use player::Player;
use terrain::HeightGrid;
use wasm_bindgen::prelude::*;

/// f32 lanes per entity record. Layout (lanes 12..15 are u32 via to_bits):
/// [posX, posY, posZ, quatX, quatY, quatZ, quatW, speed, animPhase,
///  aux0, aux1, health, id, type<<16|variant, stateFlags, reserved]
pub const ENTITY_STRIDE: usize = 16;
pub const MAX_ENTITIES: usize = 1024;

pub const TYPE_PLAYER: u32 = 0;

pub const FLAG_GROUNDED: u32 = 1;

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
    player: Player,
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
            player: Player::new(spawn_x, spawn_z),
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

    // ---- player control ----

    pub fn set_player_enabled(&mut self, enabled: bool) {
        self.player.enabled = enabled;
    }

    /// Horizontal correction writeback (JS-side building collision until the
    /// spatial hash ports to Rust in PR4 — see ROADMAP.md).
    pub fn set_player_pos(&mut self, x: f64, z: f64) {
        self.player.x = x;
        self.player.z = z;
        self.write_player_record();
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

    // ---- per-frame ----

    /// move_x/move_z: world-space movement direction (normalized or zero).
    pub fn set_input(&mut self, buttons: u32, move_x: f32, move_z: f32, aim_yaw: f32, aim_pitch: f32) {
        self.input.buttons = buttons;
        self.input.move_x = move_x;
        self.input.move_z = move_z;
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
        self.write_player_record();
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

    /// Spawn n synthetic entities (after the player at index 0) that move
    /// every substep, for measuring JS readback cost at scale.
    pub fn bench_spawn(&mut self, n: u32) {
        let n = (n as usize).min(MAX_ENTITIES - 1);
        self.bench_count = n as u32;
        self.entity_count = 1 + n as u32;
        for i in 0..n {
            let base = (1 + i) * ENTITY_STRIDE;
            self.entities[base + 6] = 1.0; // identity quat w
            self.entities[base + 11] = 1.0; // health
            self.entities[base + 12] = f32::from_bits(i as u32 + 1); // id
            self.entities[base + 13] = f32::from_bits(1 << 16); // type 1, variant 0
        }
    }
}

impl Sim {
    fn substep(&mut self) {
        self.tick += 1;
        self.time += SUBSTEP;
        self.player
            .substep(&self.input, &self.heights, &mut self.events, SUBSTEP);
        self.input.tick();

        let t = self.time as f32;
        for i in 0..self.bench_count as usize {
            let base = (1 + i) * ENTITY_STRIDE;
            let angle = t * 0.5 + i as f32 * 0.618;
            let radius = 10.0 + (i % 100) as f32;
            self.entities[base] = radius * angle.cos();
            self.entities[base + 2] = radius * angle.sin();
            self.entities[base + 7] = radius * 0.5;
            self.entities[base + 8] = (t * 1.4 + i as f32 * 0.31).fract();
        }
    }

    fn write_player_record(&mut self) {
        let p = &self.player;
        let speed = if self.input.move_len() > 1e-6 && p.enabled {
            if self.input.is_down(input::BTN_SPRINT) {
                player::SPRINT_SPEED
            } else {
                player::WALK_SPEED
            }
        } else {
            0.0
        };
        let half_yaw = (p.yaw / 2.0) as f32;
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
        e[14] = f32::from_bits(if p.grounded { FLAG_GROUNDED } else { 0 });
    }
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

        sim.set_input(0, 0.0, -1.0, 0.0, 0.0); // walk north
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
        sim.set_input(input::BTN_JUMP, 0.0, 0.0, 0.0, 0.0);
        sim.step(SUBSTEP);
        let evs: Vec<u32> = (0..sim.events_count() as usize * events::EVENT_WORDS)
            .map(|i| unsafe { *sim.events_ptr().add(i) })
            .collect();
        assert_eq!(evs[0], events::EV_JUMP);
        // release, fall, land
        sim.set_input(0, 0.0, 0.0, 0.0, 0.0);
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
