//! Ambient traffic: kinematic path-followers on the directed road graph.
//! IDM longitudinal control against the leader on the same edge chain (and
//! the player's vehicle), right-hand lane offset from the centerline,
//! seeded turn choices at nodes. Cars share the vehicle entity record
//! format, so the instanced pools render them with zero extra work.

use crate::rng::Pcg32;
use crate::roads::RoadGraph;
use crate::terrain::HeightGrid;
use crate::vehicle::{Vehicle, KIND_COUNT};

/// Right-hand-traffic lane offset from the OSM centerline (m).
const LANE_OFFSET: f64 = 1.7;
/// IDM parameters.
const IDM_ACCEL: f64 = 2.5;
const IDM_BRAKE: f64 = 3.5;
const IDM_MIN_GAP: f64 = 2.5;
const IDM_HEADWAY: f64 = 1.3;
const CAR_LEN: f64 = 4.4;
/// Spawn annulus around the player (m).
const SPAWN_NEAR: f64 = 120.0;
const SPAWN_FAR: f64 = 350.0;
const DESPAWN_BEYOND: f64 = 450.0;
/// How far ahead (m) a car looks for leaders across edge transitions.
const LOOKAHEAD: f64 = 60.0;
const WHEEL_RADIUS: f64 = 0.33;

pub struct TrafficCar {
    pub id: u32,
    pub kind: u32,
    pub paint: u32,
    pub edge: u32,
    /// Arc length along the edge centerline.
    pub s: f64,
    pub speed: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub steer: f64,
    pub wheel_spin: f64,
    next_edge: Option<u32>,
    smooth_ground: Option<f64>,
    prev_yaw: f64,
}

pub struct Traffic {
    pub cars: Vec<TrafficCar>,
    pub target: u32,
    next_id: u32,
    spawn_timer: f64,
}

impl Traffic {
    pub fn new() -> Self {
        Traffic {
            cars: Vec::new(),
            target: 30,
            next_id: 1_000_000, // distinct id space from owned vehicles
            spawn_timer: 0.0,
        }
    }

    pub fn count(&self) -> u32 {
        self.cars.len() as u32
    }

    /// Drop cars whose edges were just removed (tile unload).
    pub fn despawn_edges(&mut self, removed: &[u32]) {
        let set: std::collections::HashSet<u32> = removed.iter().copied().collect();
        self.cars.retain(|c| {
            !set.contains(&c.edge) && c.next_edge.is_none_or(|e| !set.contains(&e))
        });
    }

    pub fn substep(
        &mut self,
        graph: &RoadGraph,
        heights: &HeightGrid,
        player: (f64, f64),
        player_vehicle: Option<&Vehicle>,
        rng: &mut Pcg32,
        dt: f64,
    ) {
        self.spawn_timer += dt;
        if self.spawn_timer >= 0.25 {
            self.spawn_timer = 0.0;
            self.try_spawn(graph, player, rng);
        }

        // Longitudinal control + advance, car by car. O(n^2) leader scan is
        // fine at ambient scale (~40 cars).
        for i in 0..self.cars.len() {
            let (gap, leader_speed) = self.leader_gap(graph, i, player_vehicle);
            let car = &self.cars[i];
            let Some(edge) = graph.edges.get(car.edge as usize).and_then(|e| e.as_ref()) else {
                continue; // despawned below
            };
            let v0 = edge.speed;
            let v = self.cars[i].speed;
            // IDM acceleration.
            let accel = if let Some(gap) = gap {
                let dv = v - leader_speed;
                let s_star = IDM_MIN_GAP
                    + v * IDM_HEADWAY
                    + (v * dv) / (2.0 * (IDM_ACCEL * IDM_BRAKE).sqrt());
                IDM_ACCEL * (1.0 - (v / v0).powi(4) - (s_star / gap.max(0.1)).powi(2))
            } else {
                IDM_ACCEL * (1.0 - (v / v0).powi(4))
            };
            let car = &mut self.cars[i];
            car.speed = (car.speed + accel * dt).clamp(0.0, v0 * 1.05);
            car.s += car.speed * dt;
        }

        // Edge transitions, placement, ground, despawn.
        let mut i = 0;
        while i < self.cars.len() {
            let mut alive = true;
            loop {
                let car = &self.cars[i];
                let Some(edge) = graph.edges.get(car.edge as usize).and_then(|e| e.as_ref())
                else {
                    alive = false;
                    break;
                };
                if car.s < edge.len {
                    break;
                }
                // Transition to the chosen next edge.
                let overflow = car.s - edge.len;
                let next = car
                    .next_edge
                    .filter(|e| graph.edges.get(*e as usize).is_some_and(|x| x.is_some()))
                    .or_else(|| pick_next_edge(graph, car.edge, rng));
                match next {
                    Some(next_id) => {
                        let car = &mut self.cars[i];
                        car.edge = next_id;
                        car.s = overflow;
                        car.next_edge = pick_next_edge(graph, next_id, rng);
                    }
                    None => {
                        alive = false; // dead end: recycle
                        break;
                    }
                }
            }

            if alive {
                let car = &mut self.cars[i];
                let edge = graph.edges[car.edge as usize].as_ref().unwrap();
                let (px, pz, tx, tz) = sample_edge(&edge.points, car.s);
                // Right-hand lane offset.
                let (rx, rz) = (-tz, tx);
                car.x = px + rx * LANE_OFFSET;
                car.z = pz + rz * LANE_OFFSET;
                car.prev_yaw = car.yaw;
                let target_yaw = (-tx).atan2(-tz);
                // Wrap-aware smoothing keeps corners from snapping.
                let mut diff = target_yaw - car.yaw;
                diff = diff.sin().atan2(diff.cos());
                car.yaw += diff * (dt * 10.0).min(1.0);
                let yaw_rate = {
                    let d = car.yaw - car.prev_yaw;
                    d.sin().atan2(d.cos()) / dt.max(1e-9)
                };
                car.steer = if car.speed > 0.5 {
                    (2.7 * yaw_rate / car.speed).atan().clamp(-0.6, 0.6) * -1.0
                } else {
                    0.0
                };
                car.wheel_spin = (car.wheel_spin + car.speed * dt / WHEEL_RADIUS)
                    % std::f64::consts::TAU;
                if let Some(g) = heights.sample(car.x, car.z) {
                    let smooth = match car.smooth_ground {
                        Some(s) => s + (g - s) * (dt * 8.0).min(1.0),
                        None => g,
                    };
                    car.smooth_ground = Some(smooth);
                    car.y = smooth;
                }
                let dx = car.x - player.0;
                let dz = car.z - player.1;
                if (dx * dx + dz * dz).sqrt() > DESPAWN_BEYOND {
                    alive = false;
                }
            }

            if alive {
                i += 1;
            } else {
                self.cars.swap_remove(i);
            }
        }
    }

    /// Gap (bumper to bumper) and speed of the nearest leader ahead within
    /// LOOKAHEAD, considering same-edge cars, cars on the next edge, and
    /// the player's vehicle if it sits in the lane corridor ahead.
    fn leader_gap(
        &self,
        graph: &RoadGraph,
        i: usize,
        player_vehicle: Option<&Vehicle>,
    ) -> (Option<f64>, f64) {
        let car = &self.cars[i];
        let mut best: Option<(f64, f64)> = None; // (gap, leader speed)
        let edge_len = graph.edges[car.edge as usize]
            .as_ref()
            .map(|e| e.len)
            .unwrap_or(0.0);

        for (j, other) in self.cars.iter().enumerate() {
            if j == i {
                continue;
            }
            let dist_along = if other.edge == car.edge && other.s > car.s {
                Some(other.s - car.s)
            } else if Some(other.edge) == car.next_edge {
                Some(edge_len - car.s + other.s)
            } else {
                None
            };
            if let Some(d) = dist_along {
                let gap = d - CAR_LEN;
                if gap < LOOKAHEAD && best.is_none_or(|(g, _)| gap < g) {
                    best = Some((gap, other.speed));
                }
            }
        }

        if let Some(pv) = player_vehicle {
            let (fx, fz) = (-(car.yaw.sin()), -(car.yaw.cos()));
            let dx = pv.x - car.x;
            let dz = pv.z - car.z;
            let ahead = dx * fx + dz * fz;
            let lateral = (dx * -fz + dz * fx).abs();
            if ahead > 0.0 && ahead < LOOKAHEAD && lateral < 2.6 {
                let gap = ahead - CAR_LEN;
                if best.is_none_or(|(g, _)| gap < g) {
                    best = Some((gap, pv.v_long.max(0.0)));
                }
            }
        }

        match best {
            Some((gap, speed)) => (Some(gap), speed),
            None => (None, 0.0),
        }
    }

    fn try_spawn(&mut self, graph: &RoadGraph, player: (f64, f64), rng: &mut Pcg32) {
        if self.cars.len() as u32 >= self.target {
            return;
        }
        let total = graph.edges.len();
        if total == 0 {
            return;
        }
        let mut spawned = 0;
        for _ in 0..24 {
            if spawned >= 4 || self.cars.len() as u32 >= self.target {
                break;
            }
            let id = rng.next_below(total as u32) as usize;
            let Some(edge) = graph.edges[id].as_ref() else {
                continue;
            };
            if edge.class == 6 || edge.len < 25.0 {
                continue; // no service alleys, no stubs
            }
            // Class weighting by rejection.
            let weight = match edge.class {
                0 => 8,
                1 => 6,
                2 => 5,
                3 => 4,
                4 => 3,
                _ => 2,
            };
            if rng.next_below(8) >= weight {
                continue;
            }
            let mid = sample_edge(&edge.points, edge.len * 0.5);
            let d = ((mid.0 - player.0).powi(2) + (mid.1 - player.1).powi(2)).sqrt();
            if !(SPAWN_NEAR..=SPAWN_FAR).contains(&d) {
                continue;
            }
            let s = edge.len * (0.15 + 0.7 * rng.next_f32() as f64);
            // Keep spacing on the edge.
            if self
                .cars
                .iter()
                .any(|c| c.edge == id as u32 && (c.s - s).abs() < 12.0)
            {
                continue;
            }
            let kind = match rng.next_below(100) {
                0..=29 => 0,  // sedan
                30..=49 => 1, // hatch
                50..=69 => 3, // taxi
                70..=84 => 2, // van
                85..=94 => 5, // sport
                _ => 4,       // police
            }
            .min(KIND_COUNT - 1);
            let (px, pz, tx, tz) = sample_edge(&edge.points, s);
            let (rx, rz) = (-tz, tx);
            let car = TrafficCar {
                id: self.next_id,
                kind,
                paint: rng.next_below(8),
                edge: id as u32,
                s,
                speed: edge.speed * 0.6,
                x: px + rx * LANE_OFFSET,
                y: 0.0,
                z: pz + rz * LANE_OFFSET,
                yaw: (-tx).atan2(-tz),
                steer: 0.0,
                wheel_spin: 0.0,
                next_edge: pick_next_edge(graph, id as u32, rng),
                smooth_ground: None,
                prev_yaw: 0.0,
            };
            self.next_id += 1;
            self.cars.push(car);
            spawned += 1;
        }
    }
}

/// Choose the next directed edge at the end of `edge_id`: prefer straight,
/// never the reversal twin unless it's the only way out.
fn pick_next_edge(graph: &RoadGraph, edge_id: u32, rng: &mut Pcg32) -> Option<u32> {
    let edge = graph.edges.get(edge_id as usize)?.as_ref()?;
    let node = graph.nodes.get(edge.to as usize)?;
    let n = edge.points.len();
    let (ax, az) = if n >= 2 {
        (
            edge.points[n - 1].0 - edge.points[n - 2].0,
            edge.points[n - 1].1 - edge.points[n - 2].1,
        )
    } else {
        (0.0, -1.0)
    };
    let alen = (ax * ax + az * az).sqrt().max(1e-9);

    let mut candidates: Vec<(u32, f64)> = Vec::new();
    let mut twin: Option<u32> = None;
    for out in &node.out {
        let Some(next) = graph.edges.get(*out as usize).and_then(|e| e.as_ref()) else {
            continue;
        };
        if next.to == edge.from && next.from == edge.to {
            twin = Some(*out);
            continue;
        }
        let (bx, bz) = if next.points.len() >= 2 {
            (
                next.points[1].0 - next.points[0].0,
                next.points[1].1 - next.points[0].1,
            )
        } else {
            (0.0, -1.0)
        };
        let blen = (bx * bx + bz * bz).sqrt().max(1e-9);
        let cos = (ax * bx + az * bz) / (alen * blen);
        let weight = 1.0 + (cos.max(0.0)) * 3.0; // straight preferred
        candidates.push((*out, weight));
    }

    if candidates.is_empty() {
        return twin; // dead end: U-turn allowed
    }
    let total: f64 = candidates.iter().map(|(_, w)| w).sum();
    let mut pick = rng.next_f32() as f64 * total;
    for (id, w) in &candidates {
        pick -= w;
        if pick <= 0.0 {
            return Some(*id);
        }
    }
    candidates.last().map(|(id, _)| *id)
}

/// Point + unit tangent at arc length s along a polyline.
fn sample_edge(points: &[(f64, f64)], s: f64) -> (f64, f64, f64, f64) {
    let mut remaining = s.max(0.0);
    for w in points.windows(2) {
        let dx = w[1].0 - w[0].0;
        let dz = w[1].1 - w[0].1;
        let len = (dx * dx + dz * dz).sqrt();
        if len < 1e-9 {
            continue;
        }
        if remaining <= len {
            let t = remaining / len;
            return (w[0].0 + dx * t, w[0].1 + dz * t, dx / len, dz / len);
        }
        remaining -= len;
    }
    // Past the end: last point, last tangent.
    let n = points.len();
    let (dx, dz) = if n >= 2 {
        (points[n - 1].0 - points[n - 2].0, points[n - 1].1 - points[n - 2].1)
    } else {
        (0.0, -1.0)
    };
    let len = (dx * dx + dz * dz).sqrt().max(1e-9);
    (points[n - 1].0, points[n - 1].1, dx / len, dz / len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roads::{unpack_attr, RoadAttr};
    use crate::terrain::FIELD_SIZE;

    const DT: f64 = 1.0 / 60.0;

    fn attr() -> RoadAttr {
        unpack_attr(5 | (8 << 16)) // class minor, layer 0
    }

    fn grid_graph() -> RoadGraph {
        // 5x5 Manhattan-ish grid, 100m blocks centered on the origin.
        let mut g = RoadGraph::new();
        let mut lines = Vec::new();
        for i in -2i32..=2 {
            let c = i as f64 * 100.0;
            lines.push((
                (-2..=1)
                    .flat_map(|j| {
                        let a = j as f64 * 100.0;
                        vec![(c, a), (c, a + 100.0)]
                    })
                    .collect::<Vec<_>>(),
                attr(),
            ));
            lines.push((
                (-2..=1)
                    .flat_map(|j| {
                        let a = j as f64 * 100.0;
                        vec![(a, c), (a + 100.0, c)]
                    })
                    .collect::<Vec<_>>(),
                attr(),
            ));
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
    fn spawns_toward_target_and_despawns_when_player_leaves() {
        let g = grid_graph();
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 12;
        let mut rng = Pcg32::new(7);
        for _ in 0..600 {
            t.substep(&g, &hg, (0.0, 0.0), None, &mut rng, DT);
        }
        assert!(t.count() >= 8, "spawned {} of 12", t.count());

        // Player teleports far away: everything despawns.
        for _ in 0..600 {
            t.substep(&g, &hg, (10_000.0, 0.0), None, &mut rng, DT);
        }
        assert_eq!(t.count(), 0);
    }

    #[test]
    fn idm_follower_never_rear_ends_leader() {
        let g = grid_graph();
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 0; // no auto spawns
        let mut rng = Pcg32::new(7);
        // Find a long edge and place leader + follower on it.
        let edge_id = g
            .edges
            .iter()
            .position(|e| e.as_ref().is_some_and(|e| e.len > 90.0))
            .unwrap() as u32;
        for (s, speed) in [(40.0, 2.0), (5.0, 9.0)] {
            let (px, pz, tx, tz) = sample_edge(&g.edges[edge_id as usize].as_ref().unwrap().points, s);
            t.cars.push(TrafficCar {
                id: t.next_id,
                kind: 0,
                paint: 0,
                edge: edge_id,
                s,
                speed,
                x: px + -tz * LANE_OFFSET,
                y: 0.0,
                z: pz + tx * LANE_OFFSET,
                yaw: (-tx).atan2(-tz),
                steer: 0.0,
                wheel_spin: 0.0,
                next_edge: None,
                smooth_ground: None,
                prev_yaw: 0.0,
            });
            t.next_id += 1;
        }
        // Leader crawls at ~2 m/s; follower starts fast 35m behind.
        for _ in 0..1800 {
            // keep the leader slow
            t.cars[0].speed = t.cars[0].speed.min(2.0);
            t.substep(&g, &hg, (0.0, 0.0), None, &mut rng, DT);
            if t.cars.len() < 2 {
                break; // leader exited the edge; chase is over
            }
            if t.cars[1].edge == t.cars[0].edge {
                let gap = t.cars[0].s - t.cars[1].s - CAR_LEN;
                assert!(gap > 0.0, "follower rear-ended leader (gap {gap})");
            }
        }
    }

    #[test]
    fn cars_keep_moving_through_nodes() {
        let g = grid_graph();
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 10;
        let mut rng = Pcg32::new(99);
        for _ in 0..600 {
            t.substep(&g, &hg, (0.0, 0.0), None, &mut rng, DT);
        }
        let before: Vec<(f64, f64)> = t.cars.iter().map(|c| (c.x, c.z)).collect();
        for _ in 0..600 {
            t.substep(&g, &hg, (0.0, 0.0), None, &mut rng, DT);
        }
        // 10 seconds at >=several m/s: every surviving car moved, none NaN.
        for (i, car) in t.cars.iter().enumerate() {
            assert!(car.x.is_finite() && car.z.is_finite());
            if i < before.len() {
                let d = ((car.x - before[i].0).powi(2) + (car.z - before[i].1).powi(2)).sqrt();
                assert!(d > 5.0, "car {i} stuck (moved {d:.1}m)");
            }
        }
    }

    #[test]
    fn traffic_brakes_for_player_vehicle_ahead() {
        let g = grid_graph();
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 0;
        let mut rng = Pcg32::new(7);
        let edge_id = g
            .edges
            .iter()
            .position(|e| e.as_ref().is_some_and(|e| e.len > 90.0))
            .unwrap() as u32;
        let (px, pz, tx, tz) = sample_edge(&g.edges[edge_id as usize].as_ref().unwrap().points, 10.0);
        t.cars.push(TrafficCar {
            id: 1,
            kind: 0,
            paint: 0,
            edge: edge_id,
            s: 10.0,
            speed: 9.0,
            x: px + -tz * LANE_OFFSET,
            y: 0.0,
            z: pz + tx * LANE_OFFSET,
            yaw: (-tx).atan2(-tz),
            steer: 0.0,
            wheel_spin: 0.0,
            next_edge: None,
            smooth_ground: None,
            prev_yaw: 0.0,
        });
        // Park the player's car 25m ahead in the same lane.
        let (qx, qz, _, _) = sample_edge(&g.edges[edge_id as usize].as_ref().unwrap().points, 35.0);
        let mut pv = Vehicle::new(9, 0, 0, qx + -tz * LANE_OFFSET, qz + tx * LANE_OFFSET, 0.0);
        pv.yaw = t.cars[0].yaw;
        for _ in 0..300 {
            t.substep(&g, &hg, (0.0, 0.0), Some(&pv), &mut rng, DT);
        }
        assert!(
            t.cars[0].speed < 1.5,
            "should have braked behind the parked player car: {}",
            t.cars[0].speed
        );
        let dx = pv.x - t.cars[0].x;
        let dz = pv.z - t.cars[0].z;
        assert!((dx * dx + dz * dz).sqrt() > 3.0, "stopped short of contact");
    }
}
