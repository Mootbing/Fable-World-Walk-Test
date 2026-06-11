//! World Walk simulation core. Owns all gameplay state; JS streams world
//! data in (tiles) and reads entity transforms back each frame as zero-copy
//! views over wasm memory. See engine/sim/entityLayout.ts for the buffer ABI.

pub mod rng;

use wasm_bindgen::prelude::*;

/// f32 lanes per entity record. Layout (lanes 12..15 are u32 via to_bits):
/// [posX, posY, posZ, quatX, quatY, quatZ, quatW, speed, animPhase,
///  aux0, aux1, health, id, type<<16|variant, stateFlags, reserved]
pub const ENTITY_STRIDE: usize = 16;
pub const MAX_ENTITIES: usize = 1024;

const SUBSTEP: f64 = 1.0 / 60.0;
const MAX_SUBSTEPS: u32 = 6;
const MAX_DT: f64 = 0.1;

#[wasm_bindgen]
pub struct Sim {
    #[allow(dead_code)]
    seed: u64,
    tick: u64,
    time: f64,
    accumulator: f64,
    /// Preallocated at MAX_ENTITIES so the pointer never moves (no wasm
    /// memory growth from the entity buffer itself).
    entities: Vec<f32>,
    entity_count: u32,
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, _spawn_x: f64, _spawn_z: f64) -> Sim {
        #[cfg(target_arch = "wasm32")]
        console_error_panic_hook::set_once();
        Sim {
            seed,
            tick: 0,
            time: 0.0,
            accumulator: 0.0,
            entities: vec![0.0; MAX_ENTITIES * ENTITY_STRIDE],
            entity_count: 0,
        }
    }

    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// Advance the sim. Runs fixed 60 Hz substeps from an accumulator; dt is
    /// clamped (matches the renderer's clamp) and substeps are capped so a
    /// long pause can't trigger a death spiral.
    pub fn step(&mut self, dt: f64) {
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
    }

    pub fn tick(&self) -> f64 {
        self.tick as f64
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    // ---- entity buffer readback ----

    pub fn entities_ptr(&self) -> *const f32 {
        self.entities.as_ptr()
    }

    pub fn entity_count(&self) -> u32 {
        self.entity_count
    }

    // ---- benchmark (PR1: proves the readback path at scale) ----

    /// Spawn n synthetic entities that move every substep, for measuring the
    /// JS-side readback cost before any real gameplay depends on it.
    pub fn bench_spawn(&mut self, n: u32) {
        let n = (n as usize).min(MAX_ENTITIES);
        self.entity_count = n as u32;
        for i in 0..n {
            let base = i * ENTITY_STRIDE;
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
        let t = self.time as f32;
        for i in 0..self.entity_count as usize {
            let base = i * ENTITY_STRIDE;
            let angle = t * 0.5 + i as f32 * 0.618;
            let radius = 10.0 + (i % 100) as f32;
            self.entities[base] = radius * angle.cos();
            self.entities[base + 2] = radius * angle.sin();
            self.entities[base + 7] = radius * 0.5;
            self.entities[base + 8] = (t * 1.4 + i as f32 * 0.31).fract();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn bench_entities_move_deterministically() {
        let mut a = Sim::new(7, 0.0, 0.0);
        let mut b = Sim::new(7, 0.0, 0.0);
        a.bench_spawn(100);
        b.bench_spawn(100);
        for _ in 0..60 {
            a.step(SUBSTEP);
            b.step(SUBSTEP);
        }
        assert_eq!(a.entities, b.entities);
        // entity 0 actually moved off the origin
        assert!(a.entities[0].abs() > 0.1 || a.entities[2].abs() > 0.1);
    }
}
