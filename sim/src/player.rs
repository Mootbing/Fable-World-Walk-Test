//! On-foot player controller — the Rust port of the deleted
//! engine/player.ts kinematics (step clamp, low-passed ground follow), plus
//! what TS never had: gravity, jumping, and ledge falls.

use crate::collision::CollisionWorld;
use crate::events::{Events, EV_JUMP, EV_LAND};
use crate::input::{Input, BTN_JUMP, BTN_SPRINT};
use crate::terrain::HeightGrid;

pub const WALK_SPEED: f64 = 1.6;
pub const SPRINT_SPEED: f64 = 5.5;
pub const EYE_HEIGHT: f64 = 1.7;
pub const RADIUS: f64 = 0.35;
const GRAVITY: f64 = 25.0;
const JUMP_SPEED: f64 = 7.1; // apex ~= v^2/2g ~= 1.0 m
/// Grounded ground-follow detaches into a fall when the smoothed ground
/// drops this far below the feet in one substep window (walking off a ledge).
const LEDGE_DROP: f64 = 1.2;

pub struct Player {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vel_y: f64,
    pub yaw: f64,
    pub enabled: bool,
    pub grounded: bool,
    /// Distance walked, drives the render-side gait phase.
    pub gait: f64,
    last_ground: Option<f64>,
    smooth_ground: Option<f64>,
}

impl Player {
    pub fn new(spawn_x: f64, spawn_z: f64) -> Self {
        Player {
            x: spawn_x,
            y: 40.0,
            z: spawn_z,
            vel_y: 0.0,
            yaw: 0.0,
            enabled: false,
            grounded: true,
            gait: 0.0,
            last_ground: None,
            smooth_ground: None,
        }
    }

    pub fn substep(
        &mut self,
        input: &Input,
        heights: &HeightGrid,
        collision: &CollisionWorld,
        events: &mut Events,
        dt: f64,
    ) {
        let moving = input.move_len() > 1e-6;
        if self.enabled && moving {
            let speed = if input.is_down(BTN_SPRINT) {
                SPRINT_SPEED
            } else {
                WALK_SPEED
            };
            // Same wall-tunneling guard as the TS controller had.
            let step = (speed * dt).min(RADIUS * 0.9);
            let (rx, rz) = collision.resolve(
                self.x + input.move_x as f64 * step,
                self.z + input.move_z as f64 * step,
                RADIUS,
            );
            self.x = rx;
            self.z = rz;
            self.gait += step;
            self.yaw = (-(input.move_x as f64)).atan2(-(input.move_z as f64));
        }
        self.update_vertical(input, events, heights, dt);
    }

    fn update_vertical(&mut self, input: &Input, events: &mut Events, heights: &HeightGrid, dt: f64) {
        if let Some(g) = heights.sample(self.x, self.z) {
            self.last_ground = Some(g);
        }
        let Some(last) = self.last_ground else {
            return; // nothing decoded under us yet: hold position in the air
        };
        let smooth = match self.smooth_ground {
            // Low-pass softens DEM stair-steps while walking; while airborne
            // track raw ground so the landing floor is accurate.
            Some(s) if self.grounded => s + (last - s) * (dt * 8.0).min(1.0),
            _ => last,
        };
        self.smooth_ground = Some(smooth);
        let floor = smooth + EYE_HEIGHT;

        if self.grounded {
            if self.enabled && input.pressed(BTN_JUMP) {
                self.vel_y = JUMP_SPEED;
                self.grounded = false;
                self.y += self.vel_y * dt;
                events.push(EV_JUMP, 0, 0, 0);
            } else if last + EYE_HEIGHT < self.y - LEDGE_DROP {
                // Raw ground (not the laggy smoothed one) fell away under
                // our feet — start falling.
                self.grounded = false;
                self.vel_y = 0.0;
            } else {
                self.y = floor;
            }
        } else {
            self.vel_y -= GRAVITY * dt;
            self.y += self.vel_y * dt;
            if self.vel_y <= 0.0 && self.y <= floor {
                let impact = -self.vel_y;
                self.y = floor;
                self.vel_y = 0.0;
                self.grounded = true;
                events.push(EV_LAND, (impact as f32).to_bits(), 0, 0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EVENT_WORDS, EV_LAND};
    use crate::terrain::FIELD_SIZE;

    const DT: f64 = 1.0 / 60.0;

    fn flat_world(h: f32) -> HeightGrid {
        let mut hg = HeightGrid::new();
        hg.load(0, 0, -500.0, -500.0, 1000.0, vec![h; FIELD_SIZE * FIELD_SIZE]);
        hg
    }

    fn settled_player(hg: &HeightGrid) -> (Player, Events) {
        let mut p = Player::new(0.0, 0.0);
        p.enabled = true;
        let mut ev = Events::new();
        let cw = CollisionWorld::new();
        let idle = Input::default();
        for _ in 0..120 {
            p.substep(&idle, hg, &cw, &mut ev, DT);
        }
        ev.clear();
        (p, ev)
    }

    #[test]
    fn settles_to_ground_plus_eye_height() {
        let hg = flat_world(10.0);
        let (p, _) = settled_player(&hg);
        assert!((p.y - (10.0 + EYE_HEIGHT)).abs() < 1e-6, "y {}", p.y);
        assert!(p.grounded);
    }

    #[test]
    fn jump_arc_apex_and_landing() {
        let hg = flat_world(0.0);
        let (mut p, mut ev) = settled_player(&hg);
        let start_y = p.y;

        let cw = CollisionWorld::new();
        let mut input = Input::default();
        input.buttons = BTN_JUMP;
        p.substep(&input, &hg, &cw, &mut ev, DT); // rising edge -> jump
        input.tick(); // latch prev_buttons

        let mut apex: f64 = p.y;
        let mut landed_at = 0;
        for i in 0..240 {
            p.substep(&input, &hg, &cw, &mut ev, DT);
            apex = apex.max(p.y);
            if p.grounded {
                landed_at = i;
                break;
            }
        }
        assert!((apex - start_y - 1.0).abs() < 0.15, "apex rise {}", apex - start_y);
        assert!(p.grounded && (p.y - start_y).abs() < 1e-6);
        assert!(landed_at > 20, "air time too short: {landed_at} substeps");
        // no double jump from holding the button (edge-triggered)
        let events: Vec<u32> = (0..ev.count() as usize * EVENT_WORDS)
            .map(|i| unsafe { *ev.as_ptr().add(i) })
            .collect();
        let jumps = events.chunks(EVENT_WORDS).filter(|e| e[0] == EV_JUMP).count();
        let lands = events.chunks(EVENT_WORDS).filter(|e| e[0] == EV_LAND).count();
        assert_eq!(jumps, 1);
        assert_eq!(lands, 1);
    }

    #[test]
    fn walking_off_a_cliff_falls() {
        let mut hg = HeightGrid::new();
        // 1000m tile: west half at 50m, east half at 0m — a sharp cliff.
        let mut g = vec![0.0f32; FIELD_SIZE * FIELD_SIZE];
        for row in 0..FIELD_SIZE {
            for col in 0..FIELD_SIZE / 2 {
                g[row * FIELD_SIZE + col] = 50.0;
            }
        }
        hg.load(0, 0, -500.0, -500.0, 1000.0, g);

        let mut p = Player::new(-50.0, 0.0);
        p.enabled = true;
        let mut ev = Events::new();
        let cw = CollisionWorld::new();
        let idle = Input::default();
        for _ in 0..240 {
            p.substep(&idle, &hg, &cw, &mut ev, DT);
        }
        assert!((p.y - (50.0 + EYE_HEIGHT)).abs() < 0.1);

        // sprint east over the edge
        let mut input = Input::default();
        input.buttons = BTN_SPRINT;
        input.move_x = 1.0;
        let mut fell = false;
        for _ in 0..2400 {
            p.substep(&input, &hg, &cw, &mut ev, DT);
            input.tick();
            if !p.grounded {
                fell = true;
            }
            if fell && p.grounded {
                break;
            }
        }
        assert!(fell, "never detached from the high ground");
        assert!(p.grounded, "never landed");
        assert!((p.y - EYE_HEIGHT).abs() < 0.5, "landed at {}", p.y);
    }

    #[test]
    fn wall_blocks_walking() {
        let hg = flat_world(0.0);
        let (mut p, mut ev) = settled_player(&hg);
        let mut cw = CollisionWorld::new();
        // Wall face at x = 5, extending east.
        cw.add_tile(
            (0, 0),
            vec![crate::collision::Footprint {
                rings: vec![vec![
                    [5.0, -50.0],
                    [60.0, -50.0],
                    [60.0, 50.0],
                    [5.0, 50.0],
                    [5.0, -50.0],
                ]],
            }],
        );
        let mut input = Input::default();
        input.buttons = BTN_SPRINT;
        input.move_x = 1.0; // sprint east into the wall
        for _ in 0..600 {
            p.substep(&input, &hg, &cw, &mut ev, DT);
            input.tick();
        }
        assert!(p.x <= 5.0 - RADIUS + 0.02, "penetrated to x={}", p.x);
        assert!(p.x > 4.0, "should have reached the wall, x={}", p.x);
    }
}
