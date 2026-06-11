//! Player weapon slots. v1: fists + pistol. The arsenal (bat/SMG/shotgun)
//! and weapon wheel land in PR19.

pub const WEAPON_FIST: u32 = 0;
pub const WEAPON_PISTOL: u32 = 1;

pub const PISTOL_CLIP: u32 = 12;
pub const PISTOL_DAMAGE: f64 = 15.0;
pub const PISTOL_RANGE: f64 = 120.0;
pub const PISTOL_COOLDOWN: f64 = 0.35;
pub const PISTOL_RELOAD: f64 = 1.4;

pub struct Weapons {
    pub equipped: u32,
    pub has_pistol: bool,
    pub clip: u32,
    pub reserve: u32,
    pub fire_cooldown: f64,
    pub reload_timer: f64,
}

impl Weapons {
    pub fn new() -> Self {
        Weapons {
            equipped: WEAPON_FIST,
            has_pistol: false,
            clip: 0,
            reserve: 0,
            fire_cooldown: 0.0,
            reload_timer: 0.0,
        }
    }

    pub fn tick(&mut self, dt: f64) {
        self.fire_cooldown = (self.fire_cooldown - dt).max(0.0);
        if self.reload_timer > 0.0 {
            self.reload_timer -= dt;
            if self.reload_timer <= 0.0 {
                let take = (PISTOL_CLIP - self.clip).min(self.reserve);
                self.clip += take;
                self.reserve -= take;
            }
        }
    }

    pub fn reloading(&self) -> bool {
        self.reload_timer > 0.0
    }

    /// True when a round actually leaves the barrel this call.
    pub fn try_fire(&mut self) -> bool {
        if self.equipped != WEAPON_PISTOL
            || self.fire_cooldown > 0.0
            || self.reloading()
            || self.clip == 0
        {
            return false;
        }
        self.clip -= 1;
        self.fire_cooldown = PISTOL_COOLDOWN;
        true
    }

    pub fn start_reload(&mut self) -> bool {
        if self.equipped != WEAPON_PISTOL
            || self.reloading()
            || self.clip >= PISTOL_CLIP
            || self.reserve == 0
        {
            return false;
        }
        self.reload_timer = PISTOL_RELOAD;
        true
    }

    pub fn give_pistol(&mut self, ammo: u32) {
        if !self.has_pistol {
            self.has_pistol = true;
            self.clip = PISTOL_CLIP.min(ammo);
            self.reserve = ammo.saturating_sub(self.clip);
            self.equipped = WEAPON_PISTOL; // fresh iron goes straight to hand
        } else {
            self.reserve += ammo;
        }
    }

    pub fn cycle(&mut self) {
        self.equipped = match self.equipped {
            WEAPON_FIST if self.has_pistol => WEAPON_PISTOL,
            _ => WEAPON_FIST,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fire_reload_cycle() {
        let mut w = Weapons::new();
        assert!(!w.try_fire()); // no pistol
        w.give_pistol(36);
        assert_eq!(w.equipped, WEAPON_PISTOL);
        assert_eq!((w.clip, w.reserve), (12, 24));

        assert!(w.try_fire());
        assert!(!w.try_fire(), "cooldown");
        w.tick(0.4);
        assert!(w.try_fire());
        assert_eq!(w.clip, 10);

        // Burn the clip dry.
        loop {
            w.tick(0.4);
            if !w.try_fire() && w.clip == 0 {
                break;
            }
        }
        assert!(w.start_reload());
        assert!(!w.try_fire(), "can't fire mid-reload");
        w.tick(PISTOL_RELOAD + 0.01);
        assert_eq!((w.clip, w.reserve), (12, 12));

        w.cycle();
        assert_eq!(w.equipped, WEAPON_FIST);
        w.cycle();
        assert_eq!(w.equipped, WEAPON_PISTOL);
    }
}
