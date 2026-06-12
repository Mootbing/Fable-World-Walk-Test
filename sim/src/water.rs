//! Water bodies from the MVT `water` layer: per-tile polygon sets with a
//! lazily sampled surface level (the DEM reads the water surface itself —
//! there is no bathymetry, so "in the polygon" is the whole story and the
//! sample gives the level).

use crate::terrain::HeightGrid;

pub struct WaterPoly {
    /// Exterior + holes, all tested even-odd together.
    rings: Vec<Vec<(f64, f64)>>,
    min_x: f64,
    max_x: f64,
    min_z: f64,
    max_z: f64,
    /// Surface height, sampled from the DEM on first successful query.
    level: Option<f64>,
    /// Coarse inclusion mask over the bbox: 0 out, 1 in, 2 test-the-rings.
    /// Ocean rings run to thousands of vertices; this keeps the per-substep
    /// query O(1) away from shorelines.
    mask: Vec<u8>,
}

const MASK_N: usize = 24;

impl WaterPoly {
    fn cell_of(&self, x: f64, z: f64) -> u8 {
        let w = (self.max_x - self.min_x).max(1e-9);
        let h = (self.max_z - self.min_z).max(1e-9);
        let i = (((x - self.min_x) / w) * MASK_N as f64) as usize;
        let j = (((z - self.min_z) / h) * MASK_N as f64) as usize;
        self.mask[j.min(MASK_N - 1) * MASK_N + i.min(MASK_N - 1)]
    }
}

fn build_mask(
    rings: &[Vec<(f64, f64)>],
    min_x: f64,
    max_x: f64,
    min_z: f64,
    max_z: f64,
) -> Vec<u8> {
    let mut mask = vec![0u8; MASK_N * MASK_N];
    let w = (max_x - min_x).max(1e-9);
    let h = (max_z - min_z).max(1e-9);
    // Any cell touched by a ring vertex is a boundary cell.
    for ring in rings {
        for &(x, z) in ring {
            let i = (((x - min_x) / w) * MASK_N as f64) as usize;
            let j = (((z - min_z) / h) * MASK_N as f64) as usize;
            mask[j.min(MASK_N - 1) * MASK_N + i.min(MASK_N - 1)] = 2;
        }
    }
    // Remaining cells classify by their corners (mixed = boundary).
    for j in 0..MASK_N {
        for i in 0..MASK_N {
            if mask[j * MASK_N + i] == 2 {
                continue;
            }
            let x0 = min_x + w * (i as f64 / MASK_N as f64);
            let x1 = min_x + w * ((i + 1) as f64 / MASK_N as f64);
            let z0 = min_z + h * (j as f64 / MASK_N as f64);
            let z1 = min_z + h * ((j + 1) as f64 / MASK_N as f64);
            let hits = [(x0, z0), (x1, z0), (x0, z1), (x1, z1)]
                .iter()
                .filter(|&&(x, z)| point_in_rings(rings, x, z))
                .count();
            mask[j * MASK_N + i] = match hits {
                0 => 0,
                4 => 1,
                _ => 2,
            };
        }
    }
    mask
}

pub struct Water {
    tiles: std::collections::HashMap<(i32, i32), Vec<WaterPoly>>,
}

impl Water {
    pub fn new() -> Self {
        Water { tiles: std::collections::HashMap::new() }
    }

    pub fn load_tile(&mut self, key: (i32, i32), polys: Vec<Vec<Vec<(f64, f64)>>>) {
        let list = polys
            .into_iter()
            .filter(|rings| !rings.is_empty() && rings[0].len() >= 3)
            .map(|rings| {
                let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
                let (mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY);
                for &(x, z) in &rings[0] {
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                    min_z = min_z.min(z);
                    max_z = max_z.max(z);
                }
                let mask = build_mask(&rings, min_x, max_x, min_z, max_z);
                WaterPoly { rings, min_x, max_x, min_z, max_z, level: None, mask }
            })
            .collect();
        self.tiles.insert(key, list);
    }

    pub fn unload_tile(&mut self, key: (i32, i32)) {
        self.tiles.remove(&key);
    }

    pub fn poly_count(&self) -> u32 {
        self.tiles.values().map(|v| v.len() as u32).sum()
    }

    /// Surface level if (x,z) lies in any water polygon.
    pub fn level_at(&mut self, x: f64, z: f64, heights: &HeightGrid) -> Option<f64> {
        for polys in self.tiles.values_mut() {
            for p in polys.iter_mut() {
                if x < p.min_x || x > p.max_x || z < p.min_z || z > p.max_z {
                    continue;
                }
                match p.cell_of(x, z) {
                    0 => continue,
                    1 => {}
                    _ => {
                        if !point_in_rings(&p.rings, x, z) {
                            continue;
                        }
                    }
                }
                if p.level.is_none() {
                    p.level = heights.sample(x, z);
                }
                if let Some(l) = p.level {
                    return Some(l);
                }
            }
        }
        None
    }

    /// Swimmable point near (nx, nz), preferring the biggest water body
    /// in reach: inside a polygon AND over decoded heights. Bigger bbox
    /// area wins (boats want room); distance breaks ties within a poly.
    pub fn probe_near(
        &self,
        nx: f64,
        nz: f64,
        heights: &HeightGrid,
    ) -> Option<(f64, f64)> {
        let mut best: Option<(f64, f64, f64, f64)> = None; // x, z, area, d2
        for polys in self.tiles.values() {
            for p in polys {
                let area = (p.max_x - p.min_x) * (p.max_z - p.min_z);
                for i in 1..24 {
                    for j in 1..24 {
                        let x = p.min_x + (p.max_x - p.min_x) * (i as f64 / 24.0);
                        let z = p.min_z + (p.max_z - p.min_z) * (j as f64 / 24.0);
                        if !point_in_rings(&p.rings, x, z) || heights.sample(x, z).is_none() {
                            continue;
                        }
                        let d2 = (x - nx).powi(2) + (z - nz).powi(2);
                        let better = match best {
                            None => true,
                            Some((_, _, ba, bd)) => area > ba * 1.5 || (area > ba * 0.66 && d2 < bd),
                        };
                        if better {
                            best = Some((x, z, area, d2));
                        }
                    }
                }
            }
        }
        best.map(|(x, z, _, _)| (x, z))
    }
}

/// Even-odd over every ring (exterior + holes).
fn point_in_rings(rings: &[Vec<(f64, f64)>], x: f64, z: f64) -> bool {
    let mut inside = false;
    for ring in rings {
        let n = ring.len();
        let mut j = n - 1;
        for i in 0..n {
            let (xi, zi) = ring[i];
            let (xj, zj) = ring[j];
            if (zi > z) != (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi {
                inside = !inside;
            }
            j = i;
        }
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terrain::FIELD_SIZE;

    fn flat(h: f32) -> HeightGrid {
        let mut hg = HeightGrid::new();
        hg.load(0, 0, -500.0, -500.0, 1000.0, vec![h; FIELD_SIZE * FIELD_SIZE]);
        hg
    }

    #[test]
    fn point_in_poly_with_hole() {
        let mut w = Water::new();
        let outer = vec![(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)];
        let hole = vec![(40.0, 40.0), (60.0, 40.0), (60.0, 60.0), (40.0, 60.0)];
        w.load_tile((0, 0), vec![vec![outer, hole]]);
        let hg = flat(2.0);
        assert_eq!(w.level_at(20.0, 20.0, &hg), Some(2.0));
        assert_eq!(w.level_at(50.0, 50.0, &hg), None, "island hole is dry");
        assert_eq!(w.level_at(150.0, 50.0, &hg), None, "outside bbox");
        assert!(w.probe_near(0.0, 0.0, &hg).is_some());
        w.unload_tile((0, 0));
        assert_eq!(w.level_at(20.0, 20.0, &hg), None);
    }
}
