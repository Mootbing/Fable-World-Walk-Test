//! Player arsenal: spec-driven weapon slots. Fists/bat are melee; pistol,
//! SMG (auto), and shotgun (pellet cone) are hitscan.

pub const WEAPON_FIST: u32 = 0;
pub const WEAPON_BAT: u32 = 1;
pub const WEAPON_PISTOL: u32 = 2;
pub const WEAPON_SMG: u32 = 3;
pub const WEAPON_SHOTGUN: u32 = 4;
pub const WEAPON_COUNT: usize = 5;

pub struct WeaponSpec {
    pub name: &'static str,
    pub melee: bool,
    pub damage: f64,
    pub cooldown: f64,
    pub clip: u32,
    pub reload: f64,
    pub range: f64,
    pub pellets: u32,
    /// Half-angle of the spread cone (radians).
    pub spread: f64,
    /// Fires while held (vs edge-triggered).
    pub auto: bool,
}

pub const SPECS: [WeaponSpec; WEAPON_COUNT] = [
    WeaponSpec { name: "Fists", melee: true, damage: 12.0, cooldown: 0.45, clip: 0, reload: 0.0, range: 1.8, pellets: 1, spread: 0.0, auto: false },
    WeaponSpec { name: "Bat", melee: true, damage: 25.0, cooldown: 0.7, clip: 0, reload: 0.0, range: 2.3, pellets: 1, spread: 0.0, auto: false },
    WeaponSpec { name: "Pistol", melee: false, damage: 15.0, cooldown: 0.35, clip: 12, reload: 1.4, range: 120.0, pellets: 1, spread: 0.008, auto: false },
    WeaponSpec { name: "SMG", melee: false, damage: 9.0, cooldown: 0.09, clip: 30, reload: 1.8, range: 90.0, pellets: 1, spread: 0.035, auto: true },
    WeaponSpec { name: "Shotgun", melee: false, damage: 9.0, cooldown: 0.9, clip: 6, reload: 2.2, range: 35.0, pellets: 8, spread: 0.07, auto: false },
];

pub fn spec(id: u32) -> &'static WeaponSpec {
    &SPECS[(id as usize).min(WEAPON_COUNT - 1)]
}

pub struct Weapons {
    pub equipped: u32,
    pub owned: [bool; WEAPON_COUNT],
    pub clip: [u32; WEAPON_COUNT],
    pub reserve: [u32; WEAPON_COUNT],
    pub fire_cooldown: f64,
    pub reload_timer: f64,
}

impl Weapons {
    pub fn new() -> Self {
        let mut owned = [false; WEAPON_COUNT];
        owned[WEAPON_FIST as usize] = true;
        Weapons {
            equipped: WEAPON_FIST,
            owned,
            clip: [0; WEAPON_COUNT],
            reserve: [0; WEAPON_COUNT],
            fire_cooldown: 0.0,
            reload_timer: 0.0,
        }
    }

    pub fn tick(&mut self, dt: f64) {
        self.fire_cooldown = (self.fire_cooldown - dt).max(0.0);
        if self.reload_timer > 0.0 {
            self.reload_timer -= dt;
            if self.reload_timer <= 0.0 {
                let w = self.equipped as usize;
                let take = (spec(self.equipped).clip - self.clip[w]).min(self.reserve[w]);
                self.clip[w] += take;
                self.reserve[w] -= take;
            }
        }
    }

    pub fn reloading(&self) -> bool {
        self.reload_timer > 0.0
    }

    /// True when this call discharges the equipped ranged weapon.
    pub fn try_fire(&mut self) -> bool {
        let s = spec(self.equipped);
        let w = self.equipped as usize;
        if s.melee || self.fire_cooldown > 0.0 || self.reloading() || self.clip[w] == 0 {
            return false;
        }
        self.clip[w] -= 1;
        self.fire_cooldown = s.cooldown;
        true
    }

    /// Melee swings share the cooldown plumbing.
    pub fn try_swing(&mut self) -> bool {
        let s = spec(self.equipped);
        if !s.melee || self.fire_cooldown > 0.0 {
            return false;
        }
        self.fire_cooldown = s.cooldown;
        true
    }

    pub fn start_reload(&mut self) -> bool {
        let s = spec(self.equipped);
        let w = self.equipped as usize;
        if s.melee || self.reloading() || self.clip[w] >= s.clip || self.reserve[w] == 0 {
            return false;
        }
        self.reload_timer = s.reload;
        true
    }

    /// Grant a weapon (+ammo); newly acquired iron goes straight to hand.
    pub fn give(&mut self, id: u32, ammo: u32) {
        let w = (id as usize).min(WEAPON_COUNT - 1);
        let s = spec(id);
        if !self.owned[w] {
            self.owned[w] = true;
            if !s.melee {
                self.clip[w] = s.clip.min(ammo);
                self.reserve[w] = ammo.saturating_sub(self.clip[w]);
            }
            self.equipped = w as u32;
            self.reload_timer = 0.0;
        } else if !s.melee {
            self.reserve[w] += ammo;
            // Rack a fresh mag if the gun was sitting empty.
            if self.clip[w] == 0 && self.reload_timer <= 0.0 {
                let take = s.clip.min(self.reserve[w]);
                self.clip[w] += take;
                self.reserve[w] -= take;
            }
        }
    }

    /// Ammo for the equipped ranged weapon (generic ammo pickups).
    pub fn give_ammo(&mut self, amount: u32) {
        let w = self.equipped as usize;
        if !spec(self.equipped).melee {
            self.reserve[w] += amount;
        } else if self.owned[WEAPON_PISTOL as usize] {
            self.reserve[WEAPON_PISTOL as usize] += amount;
        }
    }

    pub fn equip(&mut self, id: u32) -> bool {
        let w = (id as usize).min(WEAPON_COUNT - 1);
        if !self.owned[w] || self.equipped == w as u32 {
            return false;
        }
        self.equipped = w as u32;
        self.reload_timer = 0.0;
        self.fire_cooldown = self.fire_cooldown.max(0.15); // draw time
        true
    }

    pub fn cycle(&mut self) {
        for step in 1..=WEAPON_COUNT {
            let next = ((self.equipped as usize + step) % WEAPON_COUNT) as u32;
            if self.owned[next as usize] {
                self.equip(next);
                return;
            }
        }
    }

    pub fn owned_mask(&self) -> u32 {
        let mut mask = 0;
        for (i, o) in self.owned.iter().enumerate() {
            if *o {
                mask |= 1 << i;
            }
        }
        mask
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn give_equip_cycle_through_owned_only() {
        let mut w = Weapons::new();
        w.give(WEAPON_SHOTGUN, 18);
        assert_eq!(w.equipped, WEAPON_SHOTGUN);
        assert_eq!((w.clip[4], w.reserve[4]), (6, 12));
        w.give(WEAPON_BAT, 0);
        assert_eq!(w.equipped, WEAPON_BAT);
        // Cycle: bat -> shotgun -> fists -> bat (pistol/smg unowned).
        w.cycle();
        assert_eq!(w.equipped, WEAPON_SHOTGUN);
        w.cycle();
        assert_eq!(w.equipped, WEAPON_FIST);
        w.cycle();
        assert_eq!(w.equipped, WEAPON_BAT);
        assert!(!w.equip(WEAPON_SMG), "can't equip unowned");
    }

    #[test]
    fn auto_flag_and_fire_cadence() {
        let mut w = Weapons::new();
        w.give(WEAPON_SMG, 60);
        assert!(spec(w.equipped).auto);
        let mut shots = 0;
        for _ in 0..60 {
            // simulate holding the trigger for 1s of substeps
            if w.try_fire() {
                shots += 1;
            }
            w.tick(1.0 / 60.0);
        }
        assert!((9..=13).contains(&shots), "smg fired {shots} in 1s");
    }

    #[test]
    fn generic_ammo_feeds_equipped_gun() {
        let mut w = Weapons::new();
        w.give(WEAPON_PISTOL, 12);
        w.give_ammo(24);
        assert_eq!(w.reserve[WEAPON_PISTOL as usize], 24);
    }
}
