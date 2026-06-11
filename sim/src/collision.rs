//! 2D building collision — the Rust port of engine/collision.ts (which now
//! only feeds the camera-occlusion oracle on the TS side): footprints in a
//! uniform spatial hash, circles pushed out of footprint edges, with the
//! abutting-rowhouse deep-penetration rescue ported verbatim.

use std::collections::HashMap;

const CELL: f64 = 16.0;
/// Insertion bbox padding; must exceed player radius + max per-step travel.
const PAD: f64 = 2.0;
const EPSILON: f64 = 0.01;

/// Closed rings (first vertex == last), absolute world XZ meters.
pub struct Footprint {
    pub rings: Vec<Vec<[f64; 2]>>,
}

pub struct CollisionWorld {
    cells: HashMap<(i32, i32), Vec<u64>>,
    tiles: HashMap<(i32, i32), Vec<u64>>,
    arena: HashMap<u64, Footprint>,
    next_id: u64,
}

impl CollisionWorld {
    pub fn new() -> Self {
        CollisionWorld {
            cells: HashMap::new(),
            tiles: HashMap::new(),
            arena: HashMap::new(),
            next_id: 0,
        }
    }

    fn cell_of(x: f64, z: f64) -> (i32, i32) {
        ((x / CELL).floor() as i32, (z / CELL).floor() as i32)
    }

    pub fn add_tile(&mut self, tile: (i32, i32), footprints: Vec<Footprint>) {
        if self.tiles.contains_key(&tile) {
            return;
        }
        let mut ids = Vec::with_capacity(footprints.len());
        for fp in footprints {
            let id = self.next_id;
            self.next_id += 1;
            let (mut min_x, mut min_z) = (f64::INFINITY, f64::INFINITY);
            let (mut max_x, mut max_z) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
            for ring in &fp.rings {
                for p in ring {
                    min_x = min_x.min(p[0]);
                    max_x = max_x.max(p[0]);
                    min_z = min_z.min(p[1]);
                    max_z = max_z.max(p[1]);
                }
            }
            if !min_x.is_finite() {
                continue; // empty footprint
            }
            let (cx0, cz0) = Self::cell_of(min_x - PAD, min_z - PAD);
            let (cx1, cz1) = Self::cell_of(max_x + PAD, max_z + PAD);
            for cz in cz0..=cz1 {
                for cx in cx0..=cx1 {
                    self.cells.entry((cx, cz)).or_default().push(id);
                }
            }
            self.arena.insert(id, fp);
            ids.push(id);
        }
        self.tiles.insert(tile, ids);
    }

    pub fn remove_tile(&mut self, tile: (i32, i32)) {
        let Some(ids) = self.tiles.remove(&tile) else {
            return;
        };
        for id in &ids {
            self.arena.remove(id);
        }
        let removing: std::collections::HashSet<u64> = ids.into_iter().collect();
        self.cells.retain(|_, list| {
            list.retain(|id| !removing.contains(id));
            !list.is_empty()
        });
    }

    /// Resolve a circle at (x,z) with radius r out of all nearby footprints.
    /// Padded insertion means the single containing cell suffices.
    pub fn resolve(&self, mut x: f64, mut z: f64, r: f64) -> (f64, f64) {
        let Some(candidates) = self.cells.get(&Self::cell_of(x, z)) else {
            return (x, z);
        };
        if candidates.is_empty() {
            return (x, z);
        }

        for _ in 0..3 {
            let mut moved = false;
            for id in candidates {
                let fp = &self.arena[id];
                for ring in &fp.rings {
                    for i in 0..ring.len().saturating_sub(1) {
                        if let Some((px, pz)) = push_out_of_segment(x, z, r, ring[i], ring[i + 1]) {
                            x = px;
                            z = pz;
                            moved = true;
                        }
                    }
                }
            }
            if !moved {
                break;
            }
        }

        // Deep-penetration rescue (spawning inside a building, or a tile
        // going live around the player). Ejecting past the nearest wall of
        // ONE footprint can land inside an abutting neighbor (rowhouses
        // share walls), so candidate exits are tried nearest-first and
        // accepted only if outside the union of all nearby footprints.
        let inside_any =
            |px: f64, pz: f64| candidates.iter().any(|id| point_in_footprint(px, pz, &self.arena[id]));
        if inside_any(x, z) {
            let mut exits: Vec<(f64, f64, f64)> = Vec::new(); // (d2, x, z)
            for id in candidates {
                let fp = &self.arena[id];
                for ring in &fp.rings {
                    for i in 0..ring.len().saturating_sub(1) {
                        let (cx, cz) = closest_on_segment(x, z, ring[i], ring[i + 1]);
                        let d2 = (cx - x) * (cx - x) + (cz - z) * (cz - z);
                        exits.push((d2, cx, cz));
                    }
                }
            }
            exits.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (d2, ex0, ez0) in exits {
                let d = d2.sqrt();
                if d < 1e-9 {
                    continue;
                }
                let ex = ex0 + ((ex0 - x) / d) * (r + EPSILON);
                let ez = ez0 + ((ez0 - z) / d) * (r + EPSILON);
                if !inside_any(ex, ez) {
                    x = ex;
                    z = ez;
                    break;
                }
            }
            // No valid exit: keep position; a later substep tries again.
        }

        (x, z)
    }
}

impl CollisionWorld {
    /// First wall crossing of the 2D segment (x0,z0)→(x1,z1): returns the
    /// parameter t in [0,1], or None. 2.5D note: bullets treat footprints
    /// as full-height walls for now (heights upload lands with PR20+).
    pub fn raycast(&self, x0: f64, z0: f64, x1: f64, z1: f64) -> Option<f64> {
        let (cx0, cz0) = Self::cell_of(x0.min(x1), z0.min(z1));
        let (cx1, cz1) = Self::cell_of(x0.max(x1), z0.max(z1));
        let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut best: Option<f64> = None;
        for cz in cz0..=cz1 {
            for cx in cx0..=cx1 {
                let Some(list) = self.cells.get(&(cx, cz)) else { continue };
                for id in list {
                    if !seen.insert(*id) {
                        continue;
                    }
                    let fp = &self.arena[id];
                    for ring in &fp.rings {
                        for i in 0..ring.len().saturating_sub(1) {
                            if let Some(t) =
                                seg_intersect_t(x0, z0, x1, z1, ring[i], ring[i + 1])
                            {
                                if best.is_none_or(|b| t < b) {
                                    best = Some(t);
                                }
                            }
                        }
                    }
                }
            }
        }
        best
    }
}

/// Parameter t on a→b where it crosses c→d, or None.
fn seg_intersect_t(
    ax: f64,
    az: f64,
    bx: f64,
    bz: f64,
    c: [f64; 2],
    d: [f64; 2],
) -> Option<f64> {
    let rx = bx - ax;
    let rz = bz - az;
    let sx = d[0] - c[0];
    let sz = d[1] - c[1];
    let denom = rx * sz - rz * sx;
    if denom.abs() < 1e-12 {
        return None;
    }
    let t = ((c[0] - ax) * sz - (c[1] - az) * sx) / denom;
    let u = ((c[0] - ax) * rz - (c[1] - az) * rx) / denom;
    if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&u) {
        return None;
    }
    Some(t)
}

fn closest_on_segment(px: f64, pz: f64, a: [f64; 2], b: [f64; 2]) -> (f64, f64) {
    let abx = b[0] - a[0];
    let abz = b[1] - a[1];
    let len2 = abx * abx + abz * abz;
    if len2 < 1e-12 {
        return (a[0], a[1]);
    }
    let t = (((px - a[0]) * abx + (pz - a[1]) * abz) / len2).clamp(0.0, 1.0);
    (a[0] + abx * t, a[1] + abz * t)
}

fn push_out_of_segment(px: f64, pz: f64, r: f64, a: [f64; 2], b: [f64; 2]) -> Option<(f64, f64)> {
    let (cx, cz) = closest_on_segment(px, pz, a, b);
    let dx = px - cx;
    let dz = pz - cz;
    let d2 = dx * dx + dz * dz;
    if d2 >= r * r {
        return None;
    }
    let d = d2.sqrt();
    if d < 1e-9 {
        // Center exactly on the wall: push along the edge normal.
        let abx = b[0] - a[0];
        let abz = b[1] - a[1];
        let len = (abx * abx + abz * abz).sqrt().max(1e-12);
        return Some((
            px + (-abz / len) * (r + EPSILON),
            pz + (abx / len) * (r + EPSILON),
        ));
    }
    let push = (r - d + EPSILON) / d;
    Some((px + dx * push, pz + dz * push))
}

/// Even-odd test over all rings (holes/courtyards count as outside).
fn point_in_footprint(px: f64, pz: f64, fp: &Footprint) -> bool {
    let mut inside = false;
    for ring in &fp.rings {
        if ring.len() < 2 {
            continue;
        }
        let n = ring.len() - 1; // closed: skip duplicated last vertex
        let mut j = n - 1;
        for i in 0..n {
            let (xi, zi) = (ring[i][0], ring[i][1]);
            let (xj, zj) = (ring[j][0], ring[j][1]);
            if (zi > pz) != (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi {
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

    fn rect(x0: f64, z0: f64, x1: f64, z1: f64) -> Footprint {
        Footprint {
            rings: vec![vec![[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]],
        }
    }

    #[test]
    fn outside_point_is_untouched() {
        let mut w = CollisionWorld::new();
        w.add_tile((0, 0), vec![rect(10.0, 10.0, 20.0, 20.0)]);
        let (x, z) = w.resolve(5.0, 5.0, 0.35);
        assert_eq!((x, z), (5.0, 5.0));
    }

    #[test]
    fn circle_overlapping_wall_is_pushed_out() {
        let mut w = CollisionWorld::new();
        w.add_tile((0, 0), vec![rect(10.0, -50.0, 20.0, 50.0)]);
        // Approaching the west wall (x=10) from the west, slightly inside r.
        let (x, z) = w.resolve(9.8, 0.0, 0.35);
        assert!(x <= 10.0 - 0.35 + 0.02, "pushed to {x}");
        assert!((z - 0.0).abs() < 1e-9);
    }

    #[test]
    fn rowhouse_rescue_exits_the_shared_wall_union() {
        let mut w = CollisionWorld::new();
        // Two abutting rowhouses sharing the wall x=20.
        w.add_tile(
            (0, 0),
            vec![rect(10.0, 0.0, 20.0, 30.0), rect(20.0, 0.0, 30.0, 30.0)],
        );
        // Deep inside the west house, nearest wall is the SHARED one — a
        // naive eject through it lands inside the east house.
        let (x, z) = w.resolve(19.0, 15.0, 0.35);
        let inside_west = x > 10.0 && x < 20.0 && z > 0.0 && z < 30.0;
        let inside_east = x > 20.0 && x < 30.0 && z > 0.0 && z < 30.0;
        assert!(!inside_west && !inside_east, "still inside at ({x}, {z})");
    }

    #[test]
    fn courtyard_hole_counts_as_outside() {
        let mut w = CollisionWorld::new();
        let donut = Footprint {
            rings: vec![
                vec![[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0], [0.0, 0.0]],
                vec![[15.0, 15.0], [25.0, 15.0], [25.0, 25.0], [15.0, 25.0], [15.0, 15.0]],
            ],
        };
        w.add_tile((0, 0), vec![donut]);
        // Center of the courtyard: not "inside", and far enough from the
        // hole's walls not to be pushed.
        let (x, z) = w.resolve(20.0, 20.0, 0.35);
        assert_eq!((x, z), (20.0, 20.0));
    }

    #[test]
    fn remove_tile_clears_everything() {
        let mut w = CollisionWorld::new();
        w.add_tile((3, 4), vec![rect(10.0, 10.0, 20.0, 20.0)]);
        w.remove_tile((3, 4));
        let (x, z) = w.resolve(15.0, 15.0, 0.35);
        assert_eq!((x, z), (15.0, 15.0));
    }
}
