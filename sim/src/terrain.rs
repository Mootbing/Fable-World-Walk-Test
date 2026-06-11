//! Heightfield registry + bilinear sampling — the Rust twin of the TS
//! sampling in engine/heightField.ts (the decode stays in TS; both sides
//! sample the same 256x256 grids with identical math).

use std::collections::HashMap;

pub const FIELD_SIZE: usize = 256;

struct Tile {
    grid: Vec<f32>,
}

/// Tiles form a regular world-space grid (tileNWWorld is linear in tx/ty
/// with constant tileWorldSize — see engine/geo.ts), so the grid frame is
/// inferred from the first upload: origin_x = tx*size + base_x.
pub struct HeightGrid {
    tiles: HashMap<(i32, i32), Tile>,
    base_x: f64,
    base_z: f64,
    size: f64,
}

impl HeightGrid {
    pub fn new() -> Self {
        HeightGrid {
            tiles: HashMap::new(),
            base_x: 0.0,
            base_z: 0.0,
            size: 0.0,
        }
    }

    pub fn load(
        &mut self,
        tx: i32,
        ty: i32,
        origin_x: f64,
        origin_z: f64,
        size: f64,
        grid: Vec<f32>,
    ) {
        debug_assert_eq!(grid.len(), FIELD_SIZE * FIELD_SIZE);
        if self.size == 0.0 {
            self.size = size;
            self.base_x = origin_x - tx as f64 * size;
            self.base_z = origin_z - ty as f64 * size;
        }
        self.tiles.insert((tx, ty), Tile { grid });
    }

    pub fn unload(&mut self, tx: i32, ty: i32) {
        self.tiles.remove(&(tx, ty));
    }

    /// Ground elevation at a world position, or None if that tile isn't
    /// loaded. Ports sampleBilinear() exactly (half-texel inset, edge clamp).
    pub fn sample(&self, x: f64, z: f64) -> Option<f64> {
        if self.size == 0.0 {
            return None;
        }
        let tx = ((x - self.base_x) / self.size).floor();
        let tz = ((z - self.base_z) / self.size).floor();
        let tile = self.tiles.get(&(tx as i32, tz as i32))?;
        let u = (x - self.base_x - tx * self.size) / self.size;
        let v = (z - self.base_z - tz * self.size) / self.size;

        let n = FIELD_SIZE as f64;
        let px = (u * n - 0.5).clamp(0.0, n - 1.0);
        let py = (v * n - 0.5).clamp(0.0, n - 1.0);
        let x0 = px.floor() as usize;
        let y0 = py.floor() as usize;
        let x1 = (x0 + 1).min(FIELD_SIZE - 1);
        let y1 = (y0 + 1).min(FIELD_SIZE - 1);
        let fx = px - x0 as f64;
        let fy = py - y0 as f64;
        let g = &tile.grid;
        let h00 = g[y0 * FIELD_SIZE + x0] as f64;
        let h10 = g[y0 * FIELD_SIZE + x1] as f64;
        let h01 = g[y1 * FIELD_SIZE + x0] as f64;
        let h11 = g[y1 * FIELD_SIZE + x1] as f64;
        Some((h00 * (1.0 - fx) + h10 * fx) * (1.0 - fy) + (h01 * (1.0 - fx) + h11 * fx) * fy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(h: f32) -> Vec<f32> {
        vec![h; FIELD_SIZE * FIELD_SIZE]
    }

    #[test]
    fn samples_flat_tile() {
        let mut hg = HeightGrid::new();
        hg.load(10, 20, 1000.0, 2000.0, 100.0, flat(42.0));
        assert_eq!(hg.sample(1050.0, 2050.0), Some(42.0));
        assert_eq!(hg.sample(999.0, 2050.0), None); // neighbor not loaded
    }

    #[test]
    fn grid_lookup_handles_negative_world_coords() {
        let mut hg = HeightGrid::new();
        // base derived from tile (10,20); tile (9,19) sits at negative offset
        hg.load(10, 20, 0.0, 0.0, 100.0, flat(1.0));
        hg.load(9, 19, -100.0, -100.0, 100.0, flat(2.0));
        assert_eq!(hg.sample(-50.0, -50.0), Some(2.0));
        assert_eq!(hg.sample(50.0, 50.0), Some(1.0));
    }

    #[test]
    fn bilinear_interpolates_between_texels() {
        let mut hg = HeightGrid::new();
        // Left half 0, right half 100 — a step at the middle column pair.
        let mut g = vec![0.0f32; FIELD_SIZE * FIELD_SIZE];
        for row in 0..FIELD_SIZE {
            for col in FIELD_SIZE / 2..FIELD_SIZE {
                g[row * FIELD_SIZE + col] = 100.0;
            }
        }
        hg.load(0, 0, 0.0, 0.0, 256.0, g);
        // 1 world unit per texel; texel centers at x+0.5. Between the last 0
        // texel (idx 127) and first 100 texel (idx 128) the value ramps.
        let mid = hg.sample(128.0, 50.0).unwrap();
        assert!((mid - 50.0).abs() < 1.0, "mid {mid}");
        assert_eq!(hg.sample(64.0, 50.0), Some(0.0));
        assert_eq!(hg.sample(192.0, 50.0), Some(100.0));
    }

    #[test]
    fn unload_removes_tile() {
        let mut hg = HeightGrid::new();
        hg.load(0, 0, 0.0, 0.0, 100.0, flat(5.0));
        hg.unload(0, 0);
        assert_eq!(hg.sample(50.0, 50.0), None);
    }
}
