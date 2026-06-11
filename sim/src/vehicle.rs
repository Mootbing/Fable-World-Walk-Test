//! Arcade vehicle physics: kinematic bicycle model with a lateral-slip
//! channel for handbrake drifts. Deliberately not a constraint solver —
//! GTA-feel handling is tuned directly (speed-sensitive steering, grip
//! decay, velocity killed along walls on impact).

use crate::collision::CollisionWorld;
use crate::events::{Events, EV_CRASH};
use crate::terrain::HeightGrid;

pub const KIND_SEDAN: u32 = 0;

const WHEELBASE: f64 = 2.7;
/// Half-extents of the sedan body (for collision sample circles).
pub const HALF_LENGTH: f64 = 2.2;
const BODY_RADIUS: f64 = 0.95;

const ACCEL: f64 = 7.0;
const BRAKE: f64 = 14.0;
const MAX_SPEED: f64 = 38.0;
const MAX_REVERSE: f64 = 9.0;
/// Linear drag (1/s) + rolling resistance (m/s^2).
const DRAG: f64 = 0.06;
const ROLL_RESIST: f64 = 0.6;
const STEER_MAX: f64 = 0.55;
const STEER_RATE: f64 = 3.5;
/// Lateral grip decay (1/s): high = sticks, low = slides.
const GRIP: f64 = 8.0;
const GRIP_HANDBRAKE: f64 = 1.4;
const HANDBRAKE_DECEL: f64 = 7.0;
/// Crash event fires above this impact speed (m/s).
const CRASH_SPEED: f64 = 3.0;
/// Wheel radius for spin animation (m).
const WHEEL_RADIUS: f64 = 0.33;

pub struct Vehicle {
    pub id: u32,
    pub kind: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub v_long: f64,
    pub v_lat: f64,
    pub steer: f64,
    /// Accumulated wheel rotation (radians) for the renderer.
    pub wheel_spin: f64,
    smooth_ground: Option<f64>,
}

pub struct DriveInput {
    /// -1..1 throttle (+forward / -brake/reverse).
    pub throttle: f64,
    /// -1..1 steering (+right).
    pub steer: f64,
    pub handbrake: bool,
}

impl Vehicle {
    pub fn new(id: u32, kind: u32, x: f64, z: f64, yaw: f64) -> Self {
        Vehicle {
            id,
            kind,
            x,
            y: 0.0,
            z,
            yaw,
            pitch: 0.0,
            roll: 0.0,
            v_long: 0.0,
            v_lat: 0.0,
            steer: 0.0,
            wheel_spin: 0.0,
            smooth_ground: None,
        }
    }

    pub fn speed(&self) -> f64 {
        (self.v_long * self.v_long + self.v_lat * self.v_lat).sqrt()
    }

    /// Forward unit vector in world XZ (matches the player yaw convention:
    /// yaw 0 faces -Z/north).
    pub fn forward(&self) -> (f64, f64) {
        (-self.yaw.sin(), -self.yaw.cos())
    }

    pub fn substep(
        &mut self,
        input: Option<&DriveInput>,
        heights: &HeightGrid,
        collision: &CollisionWorld,
        events: &mut Events,
        dt: f64,
    ) {
        let (throttle, steer_in, handbrake) = match input {
            Some(i) => (i.throttle, i.steer, i.handbrake),
            None => (0.0, 0.0, false),
        };

        // --- longitudinal ---
        if throttle > 0.0 {
            if self.v_long < 0.0 {
                self.v_long += BRAKE * throttle * dt; // braking out of reverse
            } else {
                self.v_long += ACCEL * throttle * dt;
            }
        } else if throttle < 0.0 {
            if self.v_long > 0.5 {
                self.v_long += BRAKE * throttle * dt; // braking
            } else {
                self.v_long += ACCEL * 0.6 * throttle * dt; // reversing
            }
        }
        if handbrake {
            let drop = HANDBRAKE_DECEL * dt;
            self.v_long -= self.v_long.signum() * drop.min(self.v_long.abs());
        }
        // drag + rolling resistance
        self.v_long -= self.v_long * DRAG * dt;
        if throttle == 0.0 {
            self.v_long -= self.v_long.signum() * (ROLL_RESIST * dt).min(self.v_long.abs());
        }
        self.v_long = self.v_long.clamp(-MAX_REVERSE, MAX_SPEED);

        // --- steering (speed-sensitive, rate-limited) ---
        let steer_limit = STEER_MAX / (1.0 + self.v_long.abs() / 18.0);
        let target = steer_in.clamp(-1.0, 1.0) * steer_limit;
        let d = (target - self.steer).clamp(-STEER_RATE * dt, STEER_RATE * dt);
        self.steer += d;

        // --- yaw from bicycle kinematics (+ a drift kick under handbrake) ---
        let mut yaw_rate = -(self.v_long / WHEELBASE) * self.steer.tan();
        if handbrake {
            yaw_rate *= 1.6;
        }
        self.yaw += yaw_rate * dt;

        // --- lateral slip decays with grip; handbrake lets it live ---
        // Yawing transfers some longitudinal velocity into the lateral
        // channel (the rear stepping out).
        self.v_lat += yaw_rate * self.v_long * 0.25 * dt;
        let grip = if handbrake { GRIP_HANDBRAKE } else { GRIP };
        self.v_lat *= (-grip * dt).exp();

        // --- integrate ---
        let (fx, fz) = self.forward();
        let (rx, rz) = (-fz, fx); // right vector
        let old_x = self.x;
        let old_z = self.z;
        self.x += (fx * self.v_long + rx * self.v_lat) * dt;
        self.z += (fz * self.v_long + rz * self.v_lat) * dt;

        // --- collision: three sample circles along the body axis ---
        let speed_before = self.speed();
        let mut hit = false;
        for s in [-HALF_LENGTH + BODY_RADIUS, 0.0, HALF_LENGTH - BODY_RADIUS] {
            let cx = self.x + fx * s;
            let cz = self.z + fz * s;
            let (px, pz) = collision.resolve(cx, cz, BODY_RADIUS);
            if px != cx || pz != cz {
                self.x += px - cx;
                self.z += pz - cz;
                hit = true;
            }
        }
        if hit {
            // Kill velocity along the rejected direction: project velocity
            // onto the actual displacement we achieved this step.
            let mvx = self.x - old_x;
            let mvz = self.z - old_z;
            let intended = (fx * self.v_long + rx * self.v_lat, fz * self.v_long + rz * self.v_lat);
            let dot = mvx * intended.0 + mvz * intended.1;
            if dot <= 1e-9 || dt <= 0.0 {
                self.v_long = 0.0;
                self.v_lat = 0.0;
            } else {
                let scale = (mvx * mvx + mvz * mvz).sqrt() / (speed_before * dt).max(1e-9);
                self.v_long *= scale.min(1.0);
                self.v_lat *= scale.min(1.0);
            }
            let impact = speed_before - self.speed();
            if impact > CRASH_SPEED {
                events.push(EV_CRASH, (impact as f32).to_bits(), self.id, 0);
            }
        }

        self.wheel_spin += self.v_long * dt / WHEEL_RADIUS;

        // --- ground follow + visual slope pitch/roll ---
        if let Some(g) = heights.sample(self.x, self.z) {
            let smooth = match self.smooth_ground {
                Some(s) => s + (g - s) * (dt * 8.0).min(1.0),
                None => g,
            };
            self.smooth_ground = Some(smooth);
            self.y = smooth;

            let ahead = heights.sample(self.x + fx * HALF_LENGTH, self.z + fz * HALF_LENGTH);
            let behind = heights.sample(self.x - fx * HALF_LENGTH, self.z - fz * HALF_LENGTH);
            let right_h = heights.sample(self.x + rx * 0.9, self.z + rz * 0.9);
            let left_h = heights.sample(self.x - rx * 0.9, self.z - rz * 0.9);
            let target_pitch = match (ahead, behind) {
                (Some(a), Some(b)) => ((a - b) / (2.0 * HALF_LENGTH)).atan(),
                _ => 0.0,
            };
            let target_roll = match (right_h, left_h) {
                (Some(r), Some(l)) => ((r - l) / 1.8).atan(),
                _ => 0.0,
            };
            let k = (dt * 6.0).min(1.0);
            self.pitch += (target_pitch - self.pitch) * k;
            self.roll += (target_roll - self.roll) * k;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collision::Footprint;
    use crate::terrain::FIELD_SIZE;

    const DT: f64 = 1.0 / 60.0;

    fn flat() -> HeightGrid {
        let mut hg = HeightGrid::new();
        hg.load(0, 0, -500.0, -500.0, 1000.0, vec![0.0; FIELD_SIZE * FIELD_SIZE]);
        hg
    }

    fn drive(v: &mut Vehicle, hg: &HeightGrid, cw: &CollisionWorld, input: DriveInput, seconds: f64) {
        let mut ev = Events::new();
        let steps = (seconds / DT) as usize;
        for _ in 0..steps {
            v.substep(Some(&input), hg, cw, &mut ev, DT);
        }
    }

    #[test]
    fn accelerates_brakes_and_reverses() {
        let hg = flat();
        let cw = CollisionWorld::new();
        let mut v = Vehicle::new(1, KIND_SEDAN, 0.0, 0.0, 0.0);

        drive(&mut v, &hg, &cw, DriveInput { throttle: 1.0, steer: 0.0, handbrake: false }, 4.0);
        assert!(v.v_long > 18.0, "after 4s throttle: {}", v.v_long);
        assert!(v.z < -30.0, "moved north: {}", v.z); // yaw 0 faces -Z

        drive(&mut v, &hg, &cw, DriveInput { throttle: -1.0, steer: 0.0, handbrake: false }, 3.0);
        assert!(v.v_long <= 0.01, "braked: {}", v.v_long);

        drive(&mut v, &hg, &cw, DriveInput { throttle: -1.0, steer: 0.0, handbrake: false }, 2.0);
        assert!(v.v_long < -2.0, "reversing: {}", v.v_long);
        assert!(v.v_long >= -MAX_REVERSE - 0.01);
    }

    #[test]
    fn steering_curves_the_path() {
        let hg = flat();
        let cw = CollisionWorld::new();
        let mut v = Vehicle::new(1, KIND_SEDAN, 0.0, 0.0, 0.0);
        // Build speed straight, then a short right turn (a long full-lock
        // pull at speed completes whole circles and the end position is
        // phase-dependent — assert on the partial arc instead).
        drive(&mut v, &hg, &cw, DriveInput { throttle: 1.0, steer: 0.0, handbrake: false }, 2.0);
        drive(&mut v, &hg, &cw, DriveInput { throttle: 1.0, steer: 1.0, handbrake: false }, 0.6);
        // Right turn from north: yaw decreases, path bends east (+x).
        assert!(v.yaw < -0.25, "yaw {}", v.yaw);
        assert!(v.x > 0.5, "curved east: {}", v.x);
        assert!(v.z < -10.0, "still mostly northbound: {}", v.z);
    }

    #[test]
    fn handbrake_slides_and_sheds_speed() {
        let hg = flat();
        let cw = CollisionWorld::new();
        let mut a = Vehicle::new(1, KIND_SEDAN, 0.0, 0.0, 0.0);
        drive(&mut a, &hg, &cw, DriveInput { throttle: 1.0, steer: 0.0, handbrake: false }, 4.0);
        let entry = a.v_long;

        let mut b = Vehicle::new(2, KIND_SEDAN, a.x, a.z, a.yaw);
        b.v_long = a.v_long;
        // Same entry state: one keeps steering, one adds handbrake.
        let mut plain = Vehicle::new(3, KIND_SEDAN, a.x, a.z, a.yaw);
        plain.v_long = a.v_long;
        drive(&mut b, &hg, &cw, DriveInput { throttle: 0.0, steer: 1.0, handbrake: true }, 1.0);
        drive(&mut plain, &hg, &cw, DriveInput { throttle: 0.0, steer: 1.0, handbrake: false }, 1.0);

        assert!(b.v_long < entry * 0.75, "handbrake sheds speed: {}", b.v_long);
        assert!(
            b.v_lat.abs() > plain.v_lat.abs() + 0.3,
            "slides more: hb {} vs plain {}",
            b.v_lat,
            plain.v_lat
        );
    }

    #[test]
    fn wall_stops_the_car_and_fires_crash() {
        let hg = flat();
        let mut cw = CollisionWorld::new();
        // Wall across the road at z = -40.
        cw.add_tile(
            (0, 0),
            vec![Footprint {
                rings: vec![vec![
                    [-50.0, -60.0],
                    [50.0, -60.0],
                    [50.0, -40.0],
                    [-50.0, -40.0],
                    [-50.0, -60.0],
                ]],
            }],
        );
        let mut v = Vehicle::new(1, KIND_SEDAN, 0.0, 0.0, 0.0);
        let mut ev = Events::new();
        let input = DriveInput { throttle: 1.0, steer: 0.0, handbrake: false };
        let mut crashed = false;
        for _ in 0..600 {
            v.substep(Some(&input), &hg, &cw, &mut ev, DT);
            for e in 0..ev.count() as usize {
                if unsafe { *ev.as_ptr().add(e * 4) } == EV_CRASH {
                    crashed = true;
                }
            }
        }
        assert!(crashed, "no crash event");
        // Front of car never penetrates the wall plane.
        assert!(v.z > -40.0 + HALF_LENGTH - BODY_RADIUS - 0.1, "z {}", v.z);
        assert!(v.v_long.abs() < 1.0, "stopped: {}", v.v_long);
    }
}
