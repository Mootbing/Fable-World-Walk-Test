//! Ambient traffic: kinematic path-followers on the directed road graph.
//! IDM longitudinal control against the leader on the same edge chain (and
//! the player's vehicle), right-hand lane offset from the centerline,
//! seeded turn choices at nodes. Cars share the vehicle entity record
//! format, so the instanced pools render them with zero extra work.

use crate::rng::Pcg32;
use crate::roads::{sample_polyline, RoadGraph};
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
/// Intersection arbitration.
const APPROACH_DIST: f64 = 14.0;
const STOP_LINE: f64 = 3.5;
const OCCUPY_CLEAR: f64 = 9.0;
const OCCUPY_TIMEOUT: f64 = 4.0;
const SIGNAL_CYCLE: f64 = 8.0;
/// Stopped this long at a line → creep through (deadlock breaker).
const DEADLOCK_T: f64 = 5.0;
const CREEP_SPEED: f64 = 2.5;

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
    /// Sim time when this car came to a stop (intersection waits).
    stopped_since: Option<f64>,
    /// Deadlock breaker engaged: ignore the line, crawl through.
    creeping: bool,
    pub braking: bool,
    pub hp: f64,
    pub husk: bool,
    /// Sim time when a husk should despawn.
    pub husk_until: f64,
    /// Police pursuit: greedy routing toward the player, sirens on.
    pub pursuit: bool,
}

pub struct Traffic {
    pub cars: Vec<TrafficCar>,
    pub target: u32,
    next_id: u32,
    spawn_timer: f64,
    /// node id → (car id, signal group, since). One crossing-group car
    /// holds an unsignaled intersection at a time.
    occupants: std::collections::HashMap<u32, (u32, u8, f64)>,
}

impl Traffic {
    pub fn new() -> Self {
        Traffic {
            cars: Vec::new(),
            target: 30,
            next_id: 1_000_000, // distinct id space from owned vehicles
            spawn_timer: 0.0,
            occupants: std::collections::HashMap::new(),
        }
    }

    pub fn count(&self) -> u32 {
        self.cars.len() as u32
    }

    /// Nearest car to a point: (index, squared distance).
    pub fn nearest_car(&self, x: f64, z: f64) -> Option<(usize, f64)> {
        let mut best: Option<(usize, f64)> = None;
        for (i, c) in self.cars.iter().enumerate() {
            let d2 = (c.x - x).powi(2) + (c.z - z).powi(2);
            if best.is_none_or(|(_, b)| d2 < b) {
                best = Some((i, d2));
            }
        }
        best
    }

    /// Remove and return a car (carjacking converts it to an owned vehicle).
    pub fn take_car(&mut self, index: usize) -> TrafficCar {
        self.cars.swap_remove(index)
    }

    pub fn pursuit_count(&self) -> u32 {
        self.cars.iter().filter(|c| c.pursuit && !c.husk).count() as u32
    }

    /// Convert pursuit cars back to civilians... they just leave.
    pub fn end_pursuits(&mut self) {
        self.cars.retain(|c| !c.pursuit || c.husk);
    }

    /// Spawn a pursuit cruiser on a road edge near the player.
    pub fn spawn_pursuit(&mut self, graph: &RoadGraph, player: (f64, f64), rng: &mut Pcg32) -> bool {
        let total = graph.edges.len();
        if total == 0 {
            return false;
        }
        for _ in 0..40 {
            let id = rng.next_below(total as u32) as usize;
            let Some(edge) = graph.edges[id].as_ref() else { continue };
            if edge.class == 6 || edge.len < 20.0 {
                continue;
            }
            let mid = sample_polyline(&edge.points, edge.len * 0.5);
            let d = ((mid.0 - player.0).powi(2) + (mid.1 - player.1).powi(2)).sqrt();
            if !(60.0..=220.0).contains(&d) {
                continue;
            }
            let s = edge.len * 0.5;
            let (px, pz, tx, tz) = sample_polyline(&edge.points, s);
            let (rx, rz) = (-tz, tx);
            self.cars.push(TrafficCar {
                id: self.next_id,
                kind: 4, // police cruiser
                paint: 0,
                edge: id as u32,
                s,
                speed: edge.speed,
                x: px + rx * LANE_OFFSET,
                y: 0.0,
                z: pz + rz * LANE_OFFSET,
                yaw: (-tx).atan2(-tz),
                steer: 0.0,
                wheel_spin: 0.0,
                next_edge: None,
                smooth_ground: None,
                prev_yaw: 0.0,
                stopped_since: None,
                creeping: false,
                braking: false,
                hp: 100.0,
                husk: false,
                husk_until: 0.0,
                pursuit: true,
            });
            self.next_id += 1;
            return true;
        }
        false
    }

    /// Spawn a parked car off the graph at an exact spot (tests, setups).
    pub fn debug_spawn_at(&mut self, x: f64, z: f64, yaw: f64, kind: u32, paint: u32) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.cars.push(TrafficCar {
            id,
            kind,
            paint,
            edge: u32::MAX,
            s: 0.0,
            speed: 0.0,
            x,
            y: 0.0,
            z,
            yaw,
            steer: 0.0,
            wheel_spin: 0.0,
            next_edge: None,
            smooth_ground: None,
            prev_yaw: yaw,
            stopped_since: None,
            creeping: false,
            braking: false,
            hp: 100.0,
            husk: false,
            husk_until: 0.0,
            pursuit: false,
        });
        id
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
        crossing_peds: &[(f64, f64)],
        rng: &mut Pcg32,
        time: f64,
        dt: f64,
    ) {
        self.spawn_timer += dt;
        if self.spawn_timer >= 0.25 {
            self.spawn_timer = 0.0;
            self.try_spawn(graph, player, rng);
        }

        self.release_occupants(graph, time);
        let stop_gaps: Vec<Option<f64>> =
            (0..self.cars.len()).map(|i| self.stop_gap(graph, time, i)).collect();

        // Longitudinal control + advance, car by car. O(n^2) leader scan is
        // fine at ambient scale (~40 cars).
        for i in 0..self.cars.len() {
            if self.cars[i].husk {
                self.cars[i].speed = 0.0;
                continue;
            }
            let (mut gap, mut leader_speed) = self.leader_gap(graph, i, player_vehicle, crossing_peds);
            // The intersection stop line is a virtual stationary leader.
            if let Some(sg) = stop_gaps[i] {
                if gap.is_none_or(|g| sg < g) {
                    gap = Some(sg.max(0.05));
                    leader_speed = 0.0;
                }
            }
            let car = &self.cars[i];
            let Some(edge) = graph.edges.get(car.edge as usize).and_then(|e| e.as_ref()) else {
                continue; // despawned below
            };
            let v0 = if self.cars[i].creeping {
                CREEP_SPEED
            } else if self.cars[i].pursuit {
                edge.speed * 1.5
            } else {
                edge.speed
            };
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
            car.braking = accel < -0.8;
            car.speed = (car.speed + accel * dt).clamp(0.0, v0 * 1.05);
            car.s += car.speed * dt;

            // Wait bookkeeping (drives the deadlock creep).
            if car.speed < 0.15 && stop_gaps[i].is_some() {
                let since = *car.stopped_since.get_or_insert(time);
                if time - since > DEADLOCK_T {
                    car.creeping = true;
                }
            } else if car.speed > 1.0 {
                car.stopped_since = None;
            }
        }

        // Register occupancy as cars cross their stop line.
        for i in 0..self.cars.len() {
            let car = &self.cars[i];
            let Some(edge) = graph.edges.get(car.edge as usize).and_then(|e| e.as_ref()) else {
                continue;
            };
            if car.s > edge.len - STOP_LINE && car.speed > 0.3 {
                let group = signal_group(edge_end_heading(&edge.points));
                self.occupants
                    .entry(edge.to)
                    .or_insert((car.id, group, time));
            }
        }

        // Edge transitions, placement, ground, despawn.
        let mut i = 0;
        while i < self.cars.len() {
            let mut alive = true;
            if self.cars[i].husk && time >= self.cars[i].husk_until {
                self.cars.swap_remove(i);
                continue;
            }
            let off_grid = self.cars[i].edge == u32::MAX || self.cars[i].husk;
            loop {
                if off_grid {
                    break; // parked off-graph (debug spawns); no rail logic
                }
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
                let next = if car.pursuit {
                    pick_pursuit_edge(graph, car.edge, player)
                } else {
                    car.next_edge
                        .filter(|e| graph.edges.get(*e as usize).is_some_and(|x| x.is_some()))
                        .or_else(|| pick_next_edge(graph, car.edge, rng))
                };
                match next {
                    Some(next_id) => {
                        let car = &mut self.cars[i];
                        car.edge = next_id;
                        car.s = overflow;
                        car.next_edge = pick_next_edge(graph, next_id, rng);
                        car.creeping = false;
                        car.stopped_since = None;
                    }
                    None => {
                        alive = false; // dead end: recycle
                        break;
                    }
                }
            }

            if alive && off_grid {
                let car = &mut self.cars[i];
                car.speed = 0.0;
                if let Some(g) = heights.sample(car.x, car.z) {
                    car.y = g;
                }
                let dx = car.x - player.0;
                let dz = car.z - player.1;
                if (dx * dx + dz * dz).sqrt() > DESPAWN_BEYOND {
                    alive = false;
                }
            } else if alive {
                let car = &mut self.cars[i];
                let edge = graph.edges[car.edge as usize].as_ref().unwrap();
                let (px, pz, tx, tz) = sample_polyline(&edge.points, car.s);
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

    /// Release stale intersection holds: car gone, far past, or timed out.
    fn release_occupants(&mut self, graph: &RoadGraph, time: f64) {
        let cars = &self.cars;
        self.occupants.retain(|node_id, (car_id, _, since)| {
            if time - *since > OCCUPY_TIMEOUT {
                return false;
            }
            let Some(car) = cars.iter().find(|c| c.id == *car_id) else {
                return false;
            };
            let Some(node) = graph.nodes.get(*node_id as usize) else {
                return false;
            };
            let d = ((car.x - node.x).powi(2) + (car.z - node.z).powi(2)).sqrt();
            d < OCCUPY_CLEAR
        });
    }

    /// Distance to a stop line this car must respect, or None for "go".
    fn stop_gap(&self, graph: &RoadGraph, time: f64, i: usize) -> Option<f64> {
        let car = &self.cars[i];
        if car.creeping {
            return None; // deadlock breaker: crawl through
        }
        let edge = graph.edges.get(car.edge as usize)?.as_ref()?;
        let remaining = edge.len - car.s;
        if remaining > APPROACH_DIST {
            return None;
        }
        let node_id = edge.to;
        let node = graph.nodes.get(node_id as usize)?;
        if node.in_edges.len() < 2 {
            return None; // plain continuation
        }
        let my_group = signal_group(edge_end_heading(&edge.points));
        let line_gap = (remaining - STOP_LINE).max(0.0);

        // Someone from a crossing flow holds the box.
        if let Some((occ_id, occ_group, _)) = self.occupants.get(&node_id) {
            if *occ_id != car.id && *occ_group != my_group {
                return Some(line_gap);
            }
        }

        // Virtual signals where two major flows cross.
        if is_signaled(graph, node) {
            let phase = signal_phase(node.x, node.z, time);
            if my_group != phase {
                return Some(line_gap);
            }
            return None; // green
        }

        // Unsignaled: yield by class priority, then arrival order, then id.
        for (j, other) in self.cars.iter().enumerate() {
            if j == i {
                continue;
            }
            let Some(oedge) = graph.edges.get(other.edge as usize).and_then(|e| e.as_ref())
            else {
                continue;
            };
            if oedge.to != node_id || oedge.len - other.s > APPROACH_DIST {
                continue;
            }
            // Same-direction followers are handled by IDM, not the line.
            if other.edge == car.edge {
                continue;
            }
            let other_remaining = oedge.len - other.s;
            let yield_to = if oedge.class != edge.class {
                oedge.class < edge.class // smaller class = bigger road
            } else if (other_remaining - remaining).abs() > 0.5 {
                other_remaining < remaining // closer goes first
            } else {
                other.id < car.id // deterministic tie-break
            };
            if yield_to {
                return Some(line_gap);
            }
        }
        None
    }

    /// Gap (bumper to bumper) and speed of the nearest leader ahead within
    /// LOOKAHEAD, considering same-edge cars, cars on the next edge, and
    /// the player's vehicle if it sits in the lane corridor ahead.
    fn leader_gap(
        &self,
        graph: &RoadGraph,
        i: usize,
        player_vehicle: Option<&Vehicle>,
        crossing_peds: &[(f64, f64)],
    ) -> (Option<f64>, f64) {
        let car = &self.cars[i];
        let mut best: Option<(f64, f64)> = None; // (gap, leader speed)
        let edge_len = graph
            .edges
            .get(car.edge as usize)
            .and_then(|e| e.as_ref())
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

        // Crossing pedestrians in the lane corridor are hard stops.
        {
            let car = &self.cars[i];
            let (fx, fz) = (-(car.yaw.sin()), -(car.yaw.cos()));
            for (px, pz) in crossing_peds {
                let dx = px - car.x;
                let dz = pz - car.z;
                let ahead = dx * fx + dz * fz;
                let lateral = (dx * -fz + dz * fx).abs();
                if ahead > 0.0 && ahead < 18.0 && lateral < 2.2 {
                    let gap = ahead - 3.0;
                    if best.is_none_or(|(g, _)| gap < g) {
                        best = Some((gap, 0.0));
                    }
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
            let mid = sample_polyline(&edge.points, edge.len * 0.5);
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
            let (px, pz, tx, tz) = sample_polyline(&edge.points, s);
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
                stopped_since: None,
                creeping: false,
                braking: false,
                hp: 100.0,
                husk: false,
                husk_until: 0.0,
                pursuit: false,
            };
            self.next_id += 1;
            self.cars.push(car);
            spawned += 1;
        }
    }
}

/// Heading group for signal phases: 0 = mostly east-west, 1 = north-south.
fn signal_group(heading: (f64, f64)) -> u8 {
    if heading.0.abs() > heading.1.abs() { 0 } else { 1 }
}

fn edge_end_heading(points: &[(f64, f64)]) -> (f64, f64) {
    let n = points.len();
    if n < 2 {
        return (0.0, -1.0);
    }
    (points[n - 1].0 - points[n - 2].0, points[n - 1].1 - points[n - 2].1)
}

/// Signaled = two major flows (class ≤ tertiary) cross here from distinct
/// heading groups, with at least 3 approaches.
fn is_signaled(graph: &RoadGraph, node: &crate::roads::Node) -> bool {
    if node.in_edges.len() < 3 {
        return false;
    }
    let mut groups = [false, false];
    for id in &node.in_edges {
        let Some(edge) = graph.edges.get(*id as usize).and_then(|e| e.as_ref()) else {
            continue;
        };
        if edge.class <= 4 {
            groups[signal_group(edge_end_heading(&edge.points)) as usize] = true;
        }
    }
    groups[0] && groups[1]
}

/// Stateless phase: position-hashed offset + sim clock. No storage, fully
/// deterministic, survives tile reloads.
fn signal_phase(x: f64, z: f64, time: f64) -> u8 {
    let h = ((x * 73.856093).abs() + (z * 19.349663).abs()).fract();
    (((time / SIGNAL_CYCLE) + h * 2.0) as u64 % 2) as u8
}

/// Pursuit routing: at each node, take the out-edge whose far end is
/// closest to the player (greedy beats A* at chase cadence and needs no
/// stored route).
fn pick_pursuit_edge(graph: &RoadGraph, edge_id: u32, player: (f64, f64)) -> Option<u32> {
    let edge = graph.edges.get(edge_id as usize)?.as_ref()?;
    let node = graph.nodes.get(edge.to as usize)?;
    let mut best: Option<(u32, f64)> = None;
    for out in &node.out {
        let Some(next) = graph.edges.get(*out as usize).and_then(|e| e.as_ref()) else {
            continue;
        };
        let end = &graph.nodes[next.to as usize];
        let d2 = (end.x - player.0).powi(2) + (end.z - player.1).powi(2);
        if best.is_none_or(|(_, b)| d2 < b) {
            best = Some((*out, d2));
        }
    }
    best.map(|(id, _)| id)
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
        for step in 0..600 {
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
        }
        assert!(t.count() >= 8, "spawned {} of 12", t.count());

        // Player teleports far away: everything despawns.
        for step in 0..600 {
            t.substep(&g, &hg, (10_000.0, 0.0), None, &[], &mut rng, 10.0 + step as f64 * DT, DT);
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
            let (px, pz, tx, tz) = sample_polyline(&g.edges[edge_id as usize].as_ref().unwrap().points, s);
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
                stopped_since: None,
                creeping: false,
                braking: false,
                hp: 100.0,
                husk: false,
                husk_until: 0.0,
                pursuit: false,
            });
            t.next_id += 1;
        }
        // Leader crawls at ~2 m/s; follower starts fast 35m behind.
        for step in 0..1800 {
            // keep the leader slow
            t.cars[0].speed = t.cars[0].speed.min(2.0);
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
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
        for step in 0..600 {
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
        }
        let before: Vec<(f64, f64)> = t.cars.iter().map(|c| (c.x, c.z)).collect();
        for step in 0..600 {
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
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

    fn place_car(t: &mut Traffic, g: &RoadGraph, edge_id: u32, s: f64, speed: f64) -> usize {
        let (px, pz, tx, tz) = sample_polyline(&g.edges[edge_id as usize].as_ref().unwrap().points, s);
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
            stopped_since: None,
            creeping: false,
            braking: false,
            hp: 100.0,
            husk: false,
            husk_until: 0.0,
            pursuit: false,
        });
        t.next_id += 1;
        t.cars.len() - 1
    }

    /// Directed edge of given class ending at the given position.
    fn edge_into(g: &RoadGraph, class: u8, to: (f64, f64)) -> u32 {
        g.edges
            .iter()
            .position(|e| {
                e.as_ref().is_some_and(|e| {
                    e.class == class && {
                        let p = e.points.last().unwrap();
                        (p.0 - to.0).abs() < 1.0 && (p.1 - to.1).abs() < 1.0
                    }
                })
            })
            .unwrap() as u32
    }

    #[test]
    fn minor_yields_to_primary() {
        // Primary EW street crossing a minor NS street at the origin.
        let mut g = RoadGraph::new();
        g.load_tile(
            (0, 0),
            &[
                (
                    vec![(-200.0, 0.0), (0.0, 0.0), (200.0, 0.0)],
                    unpack_attr(2 | (8 << 16)), // primary
                ),
                (
                    vec![(0.0, -200.0), (0.0, 0.0), (0.0, 200.0)],
                    unpack_attr(5 | (8 << 16)), // minor
                ),
            ],
        );
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 0;
        let mut rng = Pcg32::new(7);
        let primary_edge = edge_into(&g, 2, (0.0, 0.0));
        let minor_edge = edge_into(&g, 5, (0.0, 0.0));
        let plen = g.edges[primary_edge as usize].as_ref().unwrap().len;
        let mlen = g.edges[minor_edge as usize].as_ref().unwrap().len;
        // Timed so both are inside their approach windows simultaneously.
        let pi = place_car(&mut t, &g, primary_edge, plen - 45.0, 14.0);
        let mi = place_car(&mut t, &g, minor_edge, mlen - 30.0, 5.0);
        let primary_id = t.cars[pi].id;
        let minor_id = t.cars[mi].id;

        let mut primary_min_speed = f64::INFINITY;
        let mut minor_yielded = false;
        for step in 0..900 {
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
            for c in &t.cars {
                if c.id == primary_id {
                    primary_min_speed = primary_min_speed.min(c.speed);
                }
                if c.id == minor_id && c.speed < 4.0 {
                    minor_yielded = true; // braked hard from ~8-9 m/s cruise
                }
            }
        }
        assert!(minor_yielded, "minor street car never yielded");
        assert!(
            primary_min_speed > 6.0,
            "primary car should keep rolling, dipped to {primary_min_speed}"
        );
    }

    #[test]
    fn four_way_contention_never_deadlocks() {
        // All-minor grid; cars circulating; 10k ticks.
        let g = grid_graph();
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 14;
        let mut rng = Pcg32::new(5);
        let mut last_positions: Vec<(u32, f64, f64)> = Vec::new();
        let mut checks = 0;
        for step in 0..10_000 {
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
            // Every ~12s of sim time, every surviving car must have moved.
            if step % 720 == 719 {
                checks += 1;
                for (id, x, z) in &last_positions {
                    if let Some(c) = t.cars.iter().find(|c| c.id == *id) {
                        let d = ((c.x - x).powi(2) + (c.z - z).powi(2)).sqrt();
                        assert!(d > 1.0, "car {id} gridlocked at step {step} (moved {d:.2}m)");
                    }
                }
                last_positions = t.cars.iter().map(|c| (c.id, c.x, c.z)).collect();
            }
        }
        assert!(checks >= 13);
        assert!(t.count() >= 8, "traffic collapsed to {}", t.count());
    }

    #[test]
    fn signaled_crossing_alternates_both_flows() {
        // Two secondary streets crossing: signaled. Feed both flows and
        // assert each clears the box within a few cycles.
        let mut g = RoadGraph::new();
        g.load_tile(
            (0, 0),
            &[
                (
                    vec![(-200.0, 0.0), (0.0, 0.0), (200.0, 0.0)],
                    unpack_attr(3 | (8 << 16)),
                ),
                (
                    vec![(0.0, -200.0), (0.0, 0.0), (0.0, 200.0)],
                    unpack_attr(3 | (8 << 16)),
                ),
            ],
        );
        let hg = flat();
        let mut t = Traffic::new();
        t.target = 0;
        let mut rng = Pcg32::new(11);
        let ew = edge_into(&g, 3, (0.0, 0.0));
        // The other inbound secondary at the same node.
        let ns = (0..g.edges.len() as u32)
            .find(|e| {
                *e != ew
                    && g.edges[*e as usize].as_ref().is_some_and(|edge| {
                        let p = edge.points.last().unwrap();
                        p.0.abs() < 1.0 && p.1.abs() < 1.0
                    })
            })
            .unwrap();
        let ewlen = g.edges[ew as usize].as_ref().unwrap().len;
        let nslen = g.edges[ns as usize].as_ref().unwrap().len;
        let a = place_car(&mut t, &g, ew, ewlen - 30.0, 10.0);
        let b = place_car(&mut t, &g, ns, nslen - 30.0, 10.0);
        let (ida, idb) = (t.cars[a].id, t.cars[b].id);
        let mut a_through = false;
        let mut b_through = false;
        for step in 0..3600 {
            // one signal super-cycle is 16s = 960 steps; allow 60s
            t.substep(&g, &hg, (0.0, 0.0), None, &[], &mut rng, step as f64 * DT, DT);
            for c in &t.cars {
                if c.id == ida && c.edge != ew {
                    a_through = true;
                }
                if c.id == idb && c.edge != ns {
                    b_through = true;
                }
            }
            if a_through && b_through {
                break;
            }
        }
        assert!(
            a_through && b_through,
            "both flows must clear the signal (a {a_through}, b {b_through})"
        );
    }

    #[test]
    fn traffic_brakes_for_crossing_ped() {
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
        let ci = place_car(&mut t, &g, edge_id, 10.0, 9.0);
        let car_id = t.cars[ci].id;
        // A pedestrian crossing the lane 30m ahead of the car.
        let (px, pz, tx, tz) =
            sample_polyline(&g.edges[edge_id as usize].as_ref().unwrap().points, 40.0);
        let ped = (px + -tz * LANE_OFFSET, pz + tx * LANE_OFFSET);
        let mut min_speed = f64::INFINITY;
        for step in 0..240 {
            t.substep(&g, &hg, (0.0, 0.0), None, &[ped], &mut rng, step as f64 * DT, DT);
            if let Some(c) = t.cars.iter().find(|c| c.id == car_id) {
                min_speed = min_speed.min(c.speed);
                let d = ((c.x - ped.0).powi(2) + (c.z - ped.1).powi(2)).sqrt();
                assert!(d > 1.5, "ran the pedestrian over (d={d:.2})");
            }
        }
        assert!(min_speed < 2.0, "never braked for the ped: {min_speed}");
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
        let (px, pz, tx, tz) = sample_polyline(&g.edges[edge_id as usize].as_ref().unwrap().points, 10.0);
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
            stopped_since: None,
            creeping: false,
            braking: false,
            hp: 100.0,
            husk: false,
            husk_until: 0.0,
            pursuit: false,
        });
        // Park the player's car 25m ahead in the same lane.
        let (qx, qz, _, _) = sample_polyline(&g.edges[edge_id as usize].as_ref().unwrap().points, 35.0);
        let mut pv = Vehicle::new(9, 0, 0, qx + -tz * LANE_OFFSET, qz + tx * LANE_OFFSET, 0.0);
        pv.yaw = t.cars[0].yaw;
        for step in 0..300 {
            t.substep(&g, &hg, (0.0, 0.0), Some(&pv), &[], &mut rng, step as f64 * DT, DT);
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
