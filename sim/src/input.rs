//! Per-frame input state pushed from JS. Button constants are mirrored in
//! engine/sim/entityLayout.ts — keep both in sync.

pub const BTN_SPRINT: u32 = 1 << 4;
pub const BTN_JUMP: u32 = 1 << 5;

#[derive(Default)]
pub struct Input {
    pub buttons: u32,
    pub prev_buttons: u32,
    /// World-space movement direction (camera-relative, normalized by JS;
    /// zero when not moving).
    pub move_x: f32,
    pub move_z: f32,
    pub aim_yaw: f32,
    pub aim_pitch: f32,
}

impl Input {
    pub fn is_down(&self, btn: u32) -> bool {
        self.buttons & btn != 0
    }

    /// Rising edge since the previous substep.
    pub fn pressed(&self, btn: u32) -> bool {
        self.buttons & btn != 0 && self.prev_buttons & btn == 0
    }

    pub fn move_len(&self) -> f32 {
        (self.move_x * self.move_x + self.move_z * self.move_z).sqrt()
    }

    /// Latch edges; called after each substep.
    pub fn tick(&mut self) {
        self.prev_buttons = self.buttons;
    }
}
