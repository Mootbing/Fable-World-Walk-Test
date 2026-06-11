//! Pedestrians: rail-walkers on sidewalk offsets of the road graph. Peds
//! stroll edge-to-edge, round corners by crossing at nodes (a straight
//! "crossing" segment that traffic brakes for), keep personal space by
//! speed-matching, and get pushed out of building footprints.

use crate::collision::CollisionWorld;
use crate::rng::Pcg32;
use crate::roads::{sample_polyline, RoadGraph};
use crate::terrain::HeightGrid;

/// Sidewalk distance from the road centerline, by class index.
/// motorway/trunk have no sidewalks (never walkable).
const SIDEWALK: [f64; 7] = [0.0, 0.0, 7.0, 6.5, 5.5, 5.0, 3.5];
const PED_RADIUS: f64 = 0.3;
const SPAWN_NEAR: f64 = 60.0;
const SPAWN_FAR: f64 = 200.0;
const DESPAWN_BEYOND: f64 = 250.0;
/// Personal space: slow down behind someone closer than this on the rail.
const FOLLOW_GAP: f64 = 1.5;
pub const PED_VARIANTS: u32 = 8;

fn walkable(class: u8) -> bool {
    (2..=6).contains(&class)
}

pub enum PedState {
    Walking,
    /// Running away from a point until the deadline, then despawn.
    Fleeing { from: (f64, f64), until: f64 },
    /// Knocked down; gets up into Fleeing.
    Down { until: f64 },
}

enum Mode {
    /// Walking the sidewalk of `edge` at arc `s`, direction `dir`.
    Rail,
    /// Crossing in a straight line between two rail anchor points.
    Crossing {
        from: (f64, f64),
        to: (f64, f64),
        progress: f64,
        length: f64,
    },
}

pub struct Ped {
    pub id: u32,
    pub variant: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub speed: f64,
    pub gait: f64,
    edge: u32,
    s: f64,
    dir: f64,
    /// +1 right sidewalk, -1 left (relative to edge direction).
    side: f64,
    /// Personal lateral jitter so peds don't single-file.
    jitter: f64,
    walk_speed: f64,
    mode: Mode,
    pub state: PedState,
    pub hp: f64,
    /// Down + dead: despawn when the timer runs out (corpse linger).
    pub dead: bool,
    smooth_ground: Option<f64>,
}

impl Ped {
    pub fn crossing(&self) -> bool {
        matches!(self.mode, Mode::Crossing { .. })
    }
}

pub struct Peds {
    pub peds: Vec<Ped>,
    pub target: u32,
    next_id: u32,
    spawn_timer: f64,
}

impl Peds {
    pub fn new() -> Self {
        Peds {
            peds: Vec::new(),
            target: 25,
            next_id: 2_000_000,
            spawn_timer: 0.0,
        }
    }

    pub fn count(&self) -> u32 {
        self.peds.len() as u32
    }

    /// Scare every ped within `radius` of `from` into fleeing.
    pub fn scatter(&mut self, from: (f64, f64), radius: f64, until: f64) {
        for p in &mut self.peds {
            if matches!(p.state, PedState::Down { .. }) {
                continue;
            }
            let d = ((p.x - from.0).powi(2) + (p.z - from.1).powi(2)).sqrt();
            if d < radius {
                p.state = PedState::Fleeing { from, until };
            }
        }
    }

    /// Spawn an already-fleeing ped (carjacked drivers bail out here).
    pub fn spawn_fleeing(
        &mut self,
        x: f64,
        z: f64,
        from: (f64, f64),
        until: f64,
        rng: &mut Pcg32,
    ) {
        self.peds.push(Ped {
            id: self.next_id,
            variant: rng.next_below(PED_VARIANTS),
            x,
            y: 0.0,
            z,
            yaw: 0.0,
            speed: 0.0,
            gait: 0.0,
            edge: u32::MAX, // off-rail; despawned only by distance/timer
            s: 0.0,
            dir: 1.0,
            side: 1.0,
            jitter: 0.0,
            walk_speed: 1.4,
            mode: Mode::Rail,
            state: PedState::Fleeing { from, until },
            hp: 30.0,
            dead: false,
            smooth_ground: None,
        });
        self.next_id += 1;
    }

    /// Debug/test: an off-rail ped that just stands there (and can be hit).
    pub fn debug_spawn_idle(&mut self, x: f64, z: f64) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.peds.push(Ped {
            id,
            variant: 0,
            x,
            y: 0.0,
            z,
            yaw: 0.0,
            speed: 0.0,
            gait: 0.0,
            edge: u32::MAX,
            s: 0.0,
            dir: 1.0,
            side: 1.0,
            jitter: 0.0,
            walk_speed: 0.0,
            mode: Mode::Rail,
            state: PedState::Walking,
            hp: 30.0,
            dead: false,
            smooth_ground: None,
        });
        id
    }

    /// Swing at the nearest ped within reach and a forward arc. Returns
    /// (killed, x, z) on contact.
    pub fn punch(&mut self, px: f64, pz: f64, yaw: f64, time: f64) -> Option<(bool, f64, f64)> {
        const REACH: f64 = 1.8;
        let (fx, fz) = (-(yaw.sin()), -(yaw.cos()));
        let mut best: Option<(usize, f64)> = None;
        for (i, p) in self.peds.iter().enumerate() {
            if p.dead {
                continue; // corpses don't take more
            }
            let dx = p.x - px;
            let dz = p.z - pz;
            let d = (dx * dx + dz * dz).sqrt();
            if d > REACH {
                continue;
            }
            let cos = (dx * fx + dz * fz) / d.max(0.01);
            if cos < 0.5 {
                continue; // outside the ~60 deg arc
            }
            if best.is_none_or(|(_, bd)| d < bd) {
                best = Some((i, d));
            }
        }
        let (i, _) = best?;
        let p = &mut self.peds[i];
        p.hp -= 12.0;
        if p.hp <= 0.0 {
            p.dead = true;
            p.state = PedState::Down { until: time + 4.0 };
            Some((true, p.x, p.z))
        } else {
            // Knockdown stagger — they get up and flee (Down → Fleeing),
            // and stay punchable on the ground (finishers).
            p.state = PedState::Down { until: time + 1.2 };
            Some((false, p.x, p.z))
        }
    }

    /// Knock down peds the vehicle body touches at speed; returns hits as
    /// (x, z, impact_speed) for event emission.
    pub fn vehicle_hits(
        &mut self,
        vx: f64,
        vz: f64,
        yaw: f64,
        half_length: f64,
        speed: f64,
        time: f64,
    ) -> Vec<(f64, f64, f64)> {
        let mut hits = Vec::new();
        if speed.abs() < 1.5 {
            return hits;
        }
        let (fx, fz) = (-(yaw.sin()), -(yaw.cos()));
        for p in &mut self.peds {
            if matches!(p.state, PedState::Down { .. }) {
                continue;
            }
            // Distance to the car's spine segment.
            let mut best = f64::INFINITY;
            for off in [-half_length, 0.0, half_length] {
                let cx = vx + fx * off;
                let cz = vz + fz * off;
                let d = ((p.x - cx).powi(2) + (p.z - cz).powi(2)).sqrt();
                best = best.min(d);
            }
            if best < 1.35 {
                p.state = PedState::Down { until: time + 2.5 };
                // Shove the ped away from the car.
                let dx = p.x - vx;
                let dz = p.z - vz;
                let d = (dx * dx + dz * dz).sqrt().max(0.1);
                p.x += dx / d * 1.4;
                p.z += dz / d * 1.4;
                hits.push((p.x, p.z, speed.abs()));
            }
        }
        hits
    }

    pub fn fleeing_count(&self) -> u32 {
        self.peds
            .iter()
            .filter(|p| matches!(p.state, PedState::Fleeing { .. }))
            .count() as u32
    }

    pub fn down_count(&self) -> u32 {
        self.peds
            .iter()
            .filter(|p| matches!(p.state, PedState::Down { .. }))
            .count() as u32
    }

    pub fn despawn_edges(&mut self, removed: &[u32]) {
        let set: std::collections::HashSet<u32> = removed.iter().copied().collect();
        self.peds.retain(|p| !set.contains(&p.edge));
    }

    pub fn substep(
        &mut self,
        graph: &RoadGraph,
        heights: &HeightGrid,
        collision: &CollisionWorld,
        player: (f64, f64),
        rng: &mut Pcg32,
        time: f64,
        dt: f64,
    ) {
        self.spawn_timer += dt;
        if self.spawn_timer >= 0.4 {
            self.spawn_timer = 0.0;
            self.try_spawn(graph, player, rng);
        }

        // Personal space: match speed behind same-rail peds (O(n^2), ~25).
        let snapshot: Vec<(u32, f64, f64, f64, bool)> = self
            .peds
            .iter()
            .map(|p| (p.edge, p.s, p.dir, p.side, p.crossing()))
            .collect();

        let mut i = 0;
        while i < self.peds.len() {
            let mut alive = true;

            // --- reaction states bypass the rails entirely ---
            match self.peds[i].state {
                PedState::Down { until } => {
                    let p = &mut self.peds[i];
                    p.speed = 0.0;
                    if time >= until {
                        if p.dead {
                            self.peds.swap_remove(i);
                            continue;
                        }
                        p.state = PedState::Fleeing {
                            from: (p.x - p.yaw.sin(), p.z - p.yaw.cos()),
                            until: time + 5.0,
                        };
                    }
                    if let Some(g) = heights.sample(p.x, p.z) {
                        p.y = g;
                    }
                    let dx = p.x - player.0;
                    let dz = p.z - player.1;
                    if (dx * dx + dz * dz).sqrt() > DESPAWN_BEYOND || time >= until + 30.0 {
                        self.peds.swap_remove(i);
                    } else {
                        i += 1;
                    }
                    continue;
                }
                PedState::Fleeing { from, until } => {
                    let p = &mut self.peds[i];
                    if time >= until {
                        self.peds.swap_remove(i);
                        continue;
                    }
                    let dx = p.x - from.0;
                    let dz = p.z - from.1;
                    let d = (dx * dx + dz * dz).sqrt().max(0.3);
                    let run = 3.0;
                    p.speed += (run - p.speed) * (dt * 5.0).min(1.0);
                    let nx = p.x + dx / d * p.speed * dt;
                    let nz = p.z + dz / d * p.speed * dt;
                    let (rx, rz) = collision.resolve(nx, nz, PED_RADIUS);
                    p.x = rx;
                    p.z = rz;
                    p.gait += p.speed * dt;
                    let target_yaw = (-(dx / d)).atan2(-(dz / d));
                    let mut dy = target_yaw - p.yaw;
                    dy = dy.sin().atan2(dy.cos());
                    p.yaw += dy * (dt * 10.0).min(1.0);
                    if let Some(g) = heights.sample(p.x, p.z) {
                        let smooth = match p.smooth_ground {
                            Some(sg) => sg + (g - sg) * (dt * 8.0).min(1.0),
                            None => g,
                        };
                        p.smooth_ground = Some(smooth);
                        p.y = smooth;
                    }
                    let pdx = p.x - player.0;
                    let pdz = p.z - player.1;
                    if (pdx * pdx + pdz * pdz).sqrt() > DESPAWN_BEYOND {
                        self.peds.swap_remove(i);
                    } else {
                        i += 1;
                    }
                    continue;
                }
                PedState::Walking => {}
            }

            // --- speed control ---
            let mut target_speed = self.peds[i].walk_speed;
            if !self.peds[i].crossing() {
                let me = (
                    self.peds[i].edge,
                    self.peds[i].s,
                    self.peds[i].dir,
                    self.peds[i].side,
                );
                for (j, other) in snapshot.iter().enumerate() {
                    if j == i || other.4 {
                        continue;
                    }
                    if other.0 == me.0 && other.3 == me.3 && other.2 == me.2 {
                        let ahead = (other.1 - me.1) * me.2;
                        if ahead > 0.0 && ahead < FOLLOW_GAP {
                            target_speed = target_speed.min(self.peds[i].walk_speed * 0.5);
                        }
                    }
                }
            }
            {
                let p = &mut self.peds[i];
                p.speed += (target_speed - p.speed) * (dt * 4.0).min(1.0);
            }

            // --- advance along mode ---
            let step = self.peds[i].speed * dt;
            match &mut self.peds[i].mode {
                Mode::Crossing { progress, length, .. } => {
                    *progress += step;
                    if *progress >= *length {
                        self.peds[i].mode = Mode::Rail;
                    }
                }
                Mode::Rail => {
                    let p = &mut self.peds[i];
                    p.s += p.dir * step;
                }
            }
            self.peds[i].gait += step;

            // --- rail end: pick a continuation (possibly crossing) ---
            let off_rail = self.peds[i].edge == u32::MAX;
            if !self.peds[i].crossing() && !off_rail {
                let p = &self.peds[i];
                let Some(edge) = graph.edges.get(p.edge as usize).and_then(|e| e.as_ref())
                else {
                    self.peds.swap_remove(i);
                    continue;
                };
                if p.s < 0.0 || p.s > edge.len {
                    alive = self.continue_from_node(graph, i, rng);
                }
            }

            if alive && off_rail {
                let p = &mut self.peds[i];
                if let Some(g) = heights.sample(p.x, p.z) {
                    p.y = g;
                }
                let dx = p.x - player.0;
                let dz = p.z - player.1;
                if (dx * dx + dz * dz).sqrt() > DESPAWN_BEYOND {
                    alive = false;
                }
            } else if alive {
                // --- placement ---
                let p = &mut self.peds[i];
                let (px, pz, yaw) = match &p.mode {
                    Mode::Crossing { from, to, progress, length } => {
                        let t = (*progress / *length).clamp(0.0, 1.0);
                        let x = from.0 + (to.0 - from.0) * t;
                        let z = from.1 + (to.1 - from.1) * t;
                        let yaw = (-(to.0 - from.0)).atan2(-(to.1 - from.1));
                        (x, z, yaw)
                    }
                    Mode::Rail => {
                        let edge = graph.edges[p.edge as usize].as_ref().unwrap();
                        let (cx, cz, tx, tz) = sample_polyline(&edge.points, p.s);
                        let (rx, rz) = (-tz, tx);
                        let off = sidewalk_offset(edge.class) * p.side + p.jitter;
                        let x = cx + rx * off;
                        let z = cz + rz * off;
                        let yaw = (-(tx * p.dir)).atan2(-(tz * p.dir));
                        (x, z, yaw)
                    }
                };
                let (rx2, rz2) = collision.resolve(px, pz, PED_RADIUS);
                p.x = rx2;
                p.z = rz2;
                let mut dy = yaw - p.yaw;
                dy = dy.sin().atan2(dy.cos());
                p.yaw += dy * (dt * 8.0).min(1.0);
                if let Some(g) = heights.sample(p.x, p.z) {
                    let smooth = match p.smooth_ground {
                        Some(sg) => sg + (g - sg) * (dt * 8.0).min(1.0),
                        None => g,
                    };
                    p.smooth_ground = Some(smooth);
                    p.y = smooth;
                }
                let dx = p.x - player.0;
                let dz = p.z - player.1;
                if (dx * dx + dz * dz).sqrt() > DESPAWN_BEYOND {
                    alive = false;
                }
            }

            if alive {
                i += 1;
            } else if i < self.peds.len() {
                self.peds.swap_remove(i);
            }
        }
    }

    /// At a rail end, walk onto another sidewalk via a crossing segment.
    /// Returns false when the ped should despawn (nowhere to go).
    fn continue_from_node(&mut self, graph: &RoadGraph, i: usize, rng: &mut Pcg32) -> bool {
        let p = &self.peds[i];
        let edge = graph.edges[p.edge as usize].as_ref().unwrap();
        let node_id = if p.dir > 0.0 { edge.to } else { edge.from };
        let Some(node) = graph.nodes.get(node_id as usize) else {
            return false;
        };

        // Anchor: where we are now (end of current rail).
        let end_s = if p.dir > 0.0 { edge.len } else { 0.0 };
        let (cx, cz, tx, tz) = sample_polyline(&edge.points, end_s);
        let off = sidewalk_offset(edge.class) * p.side + p.jitter;
        let from = (cx + -tz * off, cz + tx * off);

        // Candidate continuations: walkable edges incident to this node.
        let mut candidates: Vec<(u32, f64)> = Vec::new(); // (edge id, start s dir)
        for out in node.out.iter().chain(node.in_edges.iter()) {
            let Some(next) = graph.edges.get(*out as usize).and_then(|e| e.as_ref()) else {
                continue;
            };
            if !walkable(next.class) || *out == p.edge {
                continue;
            }
            candidates.push((*out, 0.0));
        }
        if candidates.is_empty() {
            // Dead end: turn around on the same rail.
            let p = &mut self.peds[i];
            p.dir = -p.dir;
            p.s = p.s.clamp(0.0, edge.len);
            return true;
        }
        let pick = candidates[rng.next_below(candidates.len() as u32) as usize].0;
        let next = graph.edges[pick as usize].as_ref().unwrap();
        // Walk the new edge away from this node.
        let (new_dir, start_s) = if next.from == node_id { (1.0, 0.0) } else { (-1.0, next.len) };
        let new_side = if rng.next_below(2) == 0 { 1.0 } else { -1.0 };
        let (nx, nz, ntx, ntz) = sample_polyline(&next.points, start_s);
        let noff = sidewalk_offset(next.class) * new_side + self.peds[i].jitter;
        let to = (nx + -ntz * noff, nz + ntx * noff);

        let length = ((to.0 - from.0).powi(2) + (to.1 - from.1).powi(2)).sqrt();
        let p = &mut self.peds[i];
        p.edge = pick;
        p.s = start_s;
        p.dir = new_dir;
        p.side = new_side;
        if length > 1.0 {
            p.mode = Mode::Crossing { from, to, progress: 0.0, length };
        }
        true
    }

    fn try_spawn(&mut self, graph: &RoadGraph, player: (f64, f64), rng: &mut Pcg32) {
        if self.peds.len() as u32 >= self.target {
            return;
        }
        let total = graph.edges.len();
        if total == 0 {
            return;
        }
        for _ in 0..16 {
            if self.peds.len() as u32 >= self.target {
                break;
            }
            let id = rng.next_below(total as u32) as usize;
            let Some(edge) = graph.edges[id].as_ref() else {
                continue;
            };
            if !walkable(edge.class) || edge.len < 15.0 {
                continue;
            }
            let mid = sample_polyline(&edge.points, edge.len * 0.5);
            let d = ((mid.0 - player.0).powi(2) + (mid.1 - player.1).powi(2)).sqrt();
            if !(SPAWN_NEAR..=SPAWN_FAR).contains(&d) {
                continue;
            }
            let s = edge.len * (0.1 + 0.8 * rng.next_f32() as f64);
            let side = if rng.next_below(2) == 0 { 1.0 } else { -1.0 };
            self.peds.push(Ped {
                id: self.next_id,
                variant: rng.next_below(PED_VARIANTS),
                x: 0.0,
                y: 0.0,
                z: 0.0,
                yaw: 0.0,
                speed: 0.0,
                gait: rng.next_f32() as f64 * 1.4,
                edge: id as u32,
                s,
                dir: if rng.next_below(2) == 0 { 1.0 } else { -1.0 },
                side,
                jitter: (rng.next_f32() as f64 - 0.5) * 1.6,
                walk_speed: 1.0 + rng.next_f32() as f64 * 0.7,
                mode: Mode::Rail,
                state: PedState::Walking,
                hp: 30.0,
                dead: false,
                smooth_ground: None,
            });
            self.next_id += 1;
            break; // one per attempt window
        }
    }
}

fn sidewalk_offset(class: u8) -> f64 {
    SIDEWALK[(class as usize).min(SIDEWALK.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roads::unpack_attr;
    use crate::terrain::FIELD_SIZE;

    const DT: f64 = 1.0 / 60.0;

    fn grid() -> RoadGraph {
        let mut g = RoadGraph::new();
        let mut lines = Vec::new();
        for i in -2i32..=2 {
            let c = i as f64 * 100.0;
            let mut h = Vec::new();
            let mut v = Vec::new();
            for j in -2i32..=2 {
                h.push((j as f64 * 100.0, c));
                v.push((c, j as f64 * 100.0));
            }
            lines.push((h, unpack_attr(5 | (8 << 16))));
            lines.push((v, unpack_attr(5 | (8 << 16))));
        }
        g.load_tile((0, 0), &lines);
        g
    }

    fn flat() -> HeightGrid {
        let mut hg = HeightGrid::new();
        hg.load(0, 0, -500.0, -500.0, 1000.0, vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        hg
    }

    #[test]
    fn spawn_walk_despawn_lifecycle() {
        let g = grid();
        let hg = flat();
        let cw = CollisionWorld::new();
        let mut peds = Peds::new();
        peds.target = 12;
        let mut rng = Pcg32::new(3);
        for step in 0..1200 {
            peds.substep(&g, &hg, &cw, (0.0, 0.0), &mut rng, step as f64 * DT, DT);
        }
        assert!(peds.count() >= 8, "spawned {}", peds.count());
        for p in &peds.peds {
            assert!(p.x.is_finite() && p.z.is_finite());
        }
        // Walk away: everyone despawns.
        for step in 0..600 {
            peds.substep(&g, &hg, &cw, (5_000.0, 0.0), &mut rng, step as f64 * DT, DT);
        }
        assert_eq!(peds.count(), 0);
    }

    #[test]
    fn peds_stay_on_sidewalks_and_keep_moving() {
        let g = grid();
        let hg = flat();
        let cw = CollisionWorld::new();
        let mut peds = Peds::new();
        peds.target = 10;
        let mut rng = Pcg32::new(9);
        for step in 0..900 {
            peds.substep(&g, &hg, &cw, (0.0, 0.0), &mut rng, step as f64 * DT, DT);
        }
        let before: Vec<(u32, f64, f64)> = peds.peds.iter().map(|p| (p.id, p.x, p.z)).collect();
        for step in 0..900 {
            peds.substep(&g, &hg, &cw, (0.0, 0.0), &mut rng, step as f64 * DT, DT);
        }
        let mut moved = 0;
        for (id, x, z) in &before {
            if let Some(p) = peds.peds.iter().find(|p| p.id == *id) {
                if ((p.x - x).powi(2) + (p.z - z).powi(2)).sqrt() > 3.0 {
                    moved += 1;
                }
                if !p.crossing() {
                    // On-rail peds sit at a plausible sidewalk offset from
                    // SOME grid line (lines at multiples of 100 in x or z).
                    let dx = nearest_line_dist(p.x);
                    let dz = nearest_line_dist(p.z);
                    let lateral = dx.min(dz);
                    assert!(
                        lateral > 2.0 && lateral < 9.0,
                        "ped {id} off sidewalk band: {lateral:.1}m"
                    );
                }
            }
        }
        assert!(moved >= 4, "only {moved} peds moved");
    }

    fn nearest_line_dist(v: f64) -> f64 {
        let m = (v / 100.0).round() * 100.0;
        (v - m).abs()
    }

    #[test]
    fn building_pushes_ped_out() {
        let g = grid();
        let hg = flat();
        let mut cw = CollisionWorld::new();
        // Building hugging the sidewalk band of the x=0 street, east side.
        cw.add_tile(
            (0, 0),
            vec![crate::collision::Footprint {
                rings: vec![vec![
                    [3.0, 20.0],
                    [12.0, 20.0],
                    [12.0, 60.0],
                    [3.0, 60.0],
                    [3.0, 20.0],
                ]],
            }],
        );
        let mut peds = Peds::new();
        peds.target = 0;
        let mut rng = Pcg32::new(1);
        // Hand-place a ped walking north on the east sidewalk of x=0 street.
        let edge = (0..g.edges.len() as u32)
            .find(|e| {
                g.edges[*e as usize].as_ref().is_some_and(|edge| {
                    edge.points.iter().all(|p| p.0.abs() < 0.1)
                        && edge.points.first().unwrap().1 < edge.points.last().unwrap().1
                })
            })
            .unwrap();
        peds.peds.push(Ped {
            id: 1,
            variant: 0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            yaw: 0.0,
            speed: 1.4,
            gait: 0.0,
            edge,
            s: 110.0, // on the segment passing z in [100..200]? grid edges are 100 long
            dir: 1.0,
            side: 1.0,
            jitter: 0.0,
            walk_speed: 1.4,
            mode: Mode::Rail,
            state: PedState::Walking,
            hp: 30.0,
            dead: false,
            smooth_ground: None,
        });
        // Clamp s into the edge actually picked (length 100): start at 5.
        peds.peds[0].s = 5.0;
        for step in 0..600 {
            peds.substep(&g, &hg, &cw, (0.0, 0.0), &mut rng, step as f64 * DT, DT);
        }
        // Never inside the footprint interior.
        let p = &peds.peds[0];
        let inside = p.x > 3.0 + PED_RADIUS - 0.05
            && p.x < 12.0
            && p.z > 20.0
            && p.z < 60.0;
        assert!(!inside, "ped ended inside the building at ({:.1},{:.1})", p.x, p.z);
    }
}
